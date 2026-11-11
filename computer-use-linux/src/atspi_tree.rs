use crate::diagnostics::hydrate_session_bus_env;
use anyhow::{anyhow, Context, Result};
use atspi::{
    proxy::{
        accessible::{AccessibleProxy, ObjectRefExt},
        action::ActionProxy,
        editable_text::EditableTextProxy,
        proxy_ext::{Proxies, ProxyExt},
        text::TextProxy,
    },
    CoordType, ObjectRef, ObjectRefOwned, StateSet,
};
// Direct dependency (p2p feature off) — see Cargo.toml for why we bypass
// atspi's "connection" re-export.
use atspi_connection::AccessibilityConnection;
use futures_util::{stream, StreamExt};
use schemars::JsonSchema;
use serde::Serialize;
use std::{collections::VecDeque, future::Future, time::Duration};
use tokio::time::{sleep_until, timeout, timeout_at, Instant};
use zbus::{
    fdo::DBusProxy,
    names::{BusName, UniqueName},
    zvariant::{ObjectPath, OwnedObjectPath},
};

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct AccessibleAppSummary {
    pub object_ref: String,
    pub name: Option<String>,
    pub pid: Option<u32>,
    pub role: String,
    pub child_count: i32,
    pub bounds: Option<Bounds>,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct AccessibilityNode {
    pub index: u32,
    pub parent_index: Option<u32>,
    pub depth: u32,
    pub object_ref: String,
    pub role: String,
    pub name: Option<String>,
    pub description: Option<String>,
    pub child_count: i32,
    pub bounds: Option<Bounds>,
    pub states: Vec<String>,
    pub actions: Vec<AccessibilityAction>,
    pub value: Option<AccessibilityValue>,
    pub text: Option<AccessibilityText>,
    pub supports_editable_text: bool,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct Bounds {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct AccessibilityAction {
    pub index: i32,
    pub name: String,
    pub description: String,
    pub keybinding: String,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct AccessibilityValue {
    pub current: f64,
    pub minimum: f64,
    pub maximum: f64,
    pub minimum_increment: f64,
    pub text: Option<String>,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct AccessibilityText {
    pub character_count: i32,
    pub caret_offset: Option<i32>,
    pub content: Option<String>,
    pub truncated: bool,
    pub selections: Vec<AccessibilityTextSelection>,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct AccessibilityTextSelection {
    pub start_offset: i32,
    pub end_offset: i32,
}

#[derive(Debug, Clone)]
pub struct ActionInvocation {
    pub action_index: i32,
    pub action_name: Option<String>,
    pub ok: bool,
}

#[derive(Debug, Clone)]
pub enum ValueSetInvocation {
    Numeric { value: f64 },
    EditableText { outcome: EditableTextSetOutcome },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EditableTextSetOutcome {
    Verified,
    MismatchAfterDeadline,
    ReadbackFailed,
    ReadbackTimedOut,
    PasswordUnverifiable,
}

const MAX_TEXT_READBACK_CHARS: i32 = 4096;
const EDITABLE_TEXT_READ_CHUNK_UNITS: usize = 4096;
const EDITABLE_TEXT_VERIFY_TIMEOUT: Duration = Duration::from_secs(1);
const EDITABLE_TEXT_VERIFY_INTERVAL: Duration = Duration::from_millis(50);
const MAX_TEXT_SELECTIONS: i32 = 8;
const DEFAULT_SNAPSHOT_MAX_NODES: usize = 1_000;
// Larger trees are opt-in; the default and the 10-second deadline stay unchanged.
const HARD_SNAPSHOT_MAX_NODES: usize = 10_000;
const DEFAULT_SNAPSHOT_MAX_DEPTH: u32 = 32;
const HARD_SNAPSHOT_MAX_DEPTH: u32 = 64;
const CHILD_READ_CONCURRENCY: usize = 16;
const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(10);
/// Time past `SNAPSHOT_TIMEOUT` for the node being read to finish; a node still
/// reading after it is dropped and the tree is returned truncated.
const SNAPSHOT_HARD_GRACE: Duration = Duration::from_secs(2);
const MAX_ACTIONS_PER_OBJECT: i32 = 64;
const ACTION_QUERY_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_DISCOVERY_ROOTS: usize = 256;
const ROOT_MATCH_CHILD_LIMIT: usize = 8;
const MAX_DISCOVERY_CHILD_READS: usize = MAX_DISCOVERY_ROOTS * ROOT_MATCH_CHILD_LIMIT;

fn snapshot_child_read_budgets(max_nodes: usize) -> (usize, usize, usize) {
    (MAX_DISCOVERY_ROOTS, MAX_DISCOVERY_CHILD_READS, max_nodes)
}

pub(crate) fn snapshot_limits(
    requested_max_nodes: Option<usize>,
    requested_max_depth: Option<u32>,
) -> (usize, u32) {
    (
        requested_max_nodes
            .unwrap_or(DEFAULT_SNAPSHOT_MAX_NODES)
            .clamp(1, HARD_SNAPSHOT_MAX_NODES),
        requested_max_depth
            .unwrap_or(DEFAULT_SNAPSHOT_MAX_DEPTH)
            .min(HARD_SNAPSHOT_MAX_DEPTH),
    )
}

struct BoundedTraversal<T> {
    queue: VecDeque<T>,
    attempted: usize,
    max_items: usize,
    /// Set once an enqueue had to drop offered items for lack of capacity.
    dropped: bool,
}

impl<T> BoundedTraversal<T> {
    fn new(max_items: usize) -> Self {
        Self {
            queue: VecDeque::new(),
            attempted: 0,
            max_items,
            dropped: false,
        }
    }

    fn enqueue(&mut self, items: impl IntoIterator<Item = T>) {
        let capacity = self.remaining_capacity();
        let mut items = items.into_iter();
        self.queue.extend(items.by_ref().take(capacity));
        if items.next().is_some() {
            self.dropped = true;
        }
    }

    fn pop(&mut self) -> Option<T> {
        if self.attempted >= self.max_items {
            return None;
        }
        let item = self.queue.pop_front()?;
        self.attempted += 1;
        Some(item)
    }

    fn remaining_capacity(&self) -> usize {
        self.max_items
            .saturating_sub(self.attempted.saturating_add(self.queue.len()))
    }

    /// Drop pending and earlier dropped work, keeping the spent budget, so the
    /// rest of the budget goes to the subtree enqueued next.
    fn narrow(&mut self) {
        self.queue.clear();
        self.dropped = false;
    }

    /// True when the budget stopped work that was actually offered. `enqueue`
    /// is the only gate: it never exceeds `remaining_capacity`, so
    /// `attempted + queue.len() <= max_items` always holds and the queue can
    /// never be non-empty at the attempt cap. Dropped items are the whole story.
    fn truncated(&self) -> bool {
        self.dropped
    }
}

fn bounded_child_count(reported: i32, limit: usize) -> usize {
    usize::try_from(reported).unwrap_or_default().min(limit)
}

struct IndexedReadBatch<T> {
    items: Vec<T>,
    attempted: usize,
    /// True when fewer children were attempted than the parent reported, because
    /// the caller's limit or the shared read budget ran out. Failed reads do not
    /// count; they were attempted.
    incomplete: bool,
}

impl<T> IndexedReadBatch<T> {
    fn all_failed(&self) -> bool {
        self.attempted > 0 && self.items.is_empty()
    }
}

async fn fetch_indexed_up_to<T, E, F, Fut>(
    reported: i32,
    limit: usize,
    remaining_attempts: &mut usize,
    fetch: F,
) -> IndexedReadBatch<T>
where
    F: Fn(i32) -> Fut,
    Fut: Future<Output = std::result::Result<T, E>>,
{
    let attempt_count = bounded_child_count(reported, limit).min(*remaining_attempts);
    *remaining_attempts = (*remaining_attempts).saturating_sub(attempt_count);
    let end_index = i32::try_from(attempt_count).unwrap_or(i32::MAX);

    let items = stream::iter(0..end_index)
        .map(fetch)
        .buffered(CHILD_READ_CONCURRENCY)
        .filter_map(|result| async move { result.ok() })
        .collect()
        .await;

    IndexedReadBatch {
        items,
        attempted: attempt_count,
        incomplete: attempt_count < usize::try_from(reported).unwrap_or_default(),
    }
}

async fn children_up_to(
    proxy: &AccessibleProxy<'_>,
    limit: usize,
    remaining_attempts: &mut usize,
) -> zbus::Result<IndexedReadBatch<ObjectRefOwned>> {
    if limit == 0 || *remaining_attempts == 0 {
        // Budget already spent: stay I/O-free. `incomplete` is false here because
        // nothing was asked of the parent; callers that already hold the node's
        // child_count (snapshot_tree_inner) derive truncation from that instead.
        return Ok(IndexedReadBatch {
            items: Vec::new(),
            attempted: 0,
            incomplete: false,
        });
    }

    let child_count = proxy.child_count().await?;
    Ok(
        fetch_indexed_up_to(child_count, limit, remaining_attempts, |index| {
            child_at_index(proxy, index)
        })
        .await,
    )
}

async fn child_at_index(proxy: &AccessibleProxy<'_>, index: i32) -> zbus::Result<ObjectRefOwned> {
    // WebKit sockets return a well-known bus name. atspi's ObjectRef decoder
    // only accepts unique names, so resolve the wire reference before using it.
    let (name, path): (String, OwnedObjectPath) =
        proxy.inner().call("GetChildAtIndex", &(index,)).await?;
    if path.as_str() == "/org/a11y/atspi/null" {
        return Ok(ObjectRef::Null.into());
    }
    match BusName::try_from(name)? {
        BusName::Unique(name) => Ok(ObjectRef::new_owned(name, path)),
        name => {
            let owner = DBusProxy::new(proxy.inner().connection())
                .await?
                .get_name_owner(name)
                .await?;
            Ok(ObjectRef::new_owned(owner, path))
        }
    }
}

pub async fn list_accessible_apps(limit: usize) -> Result<Vec<AccessibleAppSummary>> {
    let conn = connect().await?;
    let mut remaining_child_reads = limit;
    let roots = registry_children(&conn, limit, &mut remaining_child_reads).await?;
    let dbus = DBusProxy::new(conn.connection()).await.ok();
    let mut apps = Vec::new();

    for object_ref in roots.into_iter().take(limit) {
        if let Ok(proxy) = open_accessible(&conn, &object_ref).await {
            apps.push(read_app_summary(&proxy, &object_ref, dbus.as_ref()).await);
        }
    }

    Ok(apps)
}

#[derive(Debug, Clone)]
pub(crate) struct AccessibilitySnapshot {
    pub nodes: Vec<AccessibilityNode>,
    /// True when registry roots were filtered to an app name and/or pid.
    pub scoped: bool,
    /// The pid every root belongs to, when roots were matched by pid. None
    /// when they were matched by app name alone or not filtered at all: those
    /// roots can belong to any app, so no single pid describes the tree.
    pub root_pid: Option<u32>,
    /// True when selected roots satisfy the supplied app/name filter, or no
    /// filter was supplied. Normal snapshots retain their PID-only fallback;
    /// action recovery requires this evidence before invoking a fresh node.
    pub app_filter_matched: bool,
    /// True when max_nodes, max_depth, the child read budget, or the deadline stopped
    /// traversal with unread elements left. Failed element reads do not count.
    pub truncated: bool,
    /// Name of the AT-SPI window the tree was narrowed to, when an app root
    /// exposed several windows and exactly one matched the window title.
    pub window_scope: Option<String>,
}

pub async fn snapshot_tree(
    app_name_or_bundle_identifier: Option<&str>,
    target_pid: Option<u32>,
    max_nodes: usize,
    max_depth: u32,
) -> Result<Vec<AccessibilityNode>> {
    Ok(snapshot_accessibility_tree(
        app_name_or_bundle_identifier,
        target_pid,
        None,
        None,
        max_nodes,
        max_depth,
    )
    .await?
    .nodes)
}

/// Read the accessibility tree of the matching app roots. With
/// `window_title`, an app root that exposes several windows (Chromium puts
/// every browser window under one application) is read only through the
/// window whose name matches it; its other children stay.
/// `pid_fallback_name` finds the roots by name when `target_pid` owns none;
/// pass it only for a pid read from a window the compositor listed.
pub(crate) async fn snapshot_accessibility_tree(
    app_name_or_bundle_identifier: Option<&str>,
    target_pid: Option<u32>,
    window_title: Option<&str>,
    pid_fallback_name: Option<&str>,
    max_nodes: usize,
    max_depth: u32,
) -> Result<AccessibilitySnapshot> {
    let (max_nodes, max_depth) = snapshot_limits(Some(max_nodes), Some(max_depth));
    // Traversal stops at the deadline and returns what it read, marked truncated.
    // The outer timeout only bounds app discovery, which runs before any node
    // is read; the traversal itself ends by `stop_reading` plus the grace.
    let stop_reading = Instant::now() + SNAPSHOT_TIMEOUT;
    timeout(
        SNAPSHOT_TIMEOUT + SNAPSHOT_HARD_GRACE + SNAPSHOT_HARD_GRACE,
        snapshot_tree_inner(
            app_name_or_bundle_identifier,
            target_pid,
            window_title
                .map(str::trim)
                .filter(|title| !title.is_empty()),
            pid_fallback_name,
            max_nodes,
            max_depth,
            stop_reading,
        ),
    )
    .await
    .context("AT-SPI snapshot could not find its target before the deadline")?
}

async fn snapshot_tree_inner(
    app_name_or_bundle_identifier: Option<&str>,
    target_pid: Option<u32>,
    window_title: Option<&str>,
    pid_fallback_name: Option<&str>,
    max_nodes: usize,
    max_depth: u32,
    stop_reading: Instant,
) -> Result<AccessibilitySnapshot> {
    let conn = connect().await?;
    // App discovery is bounded independently so a tiny requested tree still
    // finds a target registered after the first accessibility root.
    let (mut remaining_registry_reads, mut remaining_filter_reads, mut remaining_traversal_reads) =
        snapshot_child_read_budgets(max_nodes);
    let roots =
        registry_children(&conn, MAX_DISCOVERY_ROOTS, &mut remaining_registry_reads).await?;
    let selected_roots = select_roots(
        &conn,
        roots,
        app_name_or_bundle_identifier,
        target_pid,
        pid_fallback_name,
        &mut remaining_filter_reads,
    )
    .await;
    let scoped = selected_roots.scoped;
    let root_pid = selected_roots.pid;
    let app_filter_matched = selected_roots.app_filter_matched;
    let mut nodes = Vec::new();
    let mut truncated = false;
    let mut window_scope = None;
    let mut traversal = BoundedTraversal::new(max_nodes);

    traversal.enqueue(
        selected_roots
            .roots
            .into_iter()
            .map(|object_ref| (object_ref, 0_u32, None)),
    );

    // Each node's reads may run past `stop_reading` by the grace, never more: a
    // slow action query (up to ACTION_QUERY_TIMEOUT) near the deadline cuts the
    // tree there instead of losing it to the outer timeout.
    let node_cutoff = stop_reading + SNAPSHOT_HARD_GRACE;
    while let Some((object_ref, depth, parent_index)) = traversal.pop() {
        if Instant::now() >= stop_reading {
            truncated = true;
            break;
        }
        let index = nodes.len() as u32;
        let remaining = traversal.remaining_capacity();
        let read = timeout_at(node_cutoff, async {
            let Ok(proxy) = open_accessible(&conn, &object_ref).await else {
                return None;
            };
            let node = read_node(&proxy, &object_ref, index, parent_index, depth).await;
            let mut cut = false;
            let mut scope = None;
            let child_refs = if depth < max_depth && remaining > 0 {
                match children_up_to(&proxy, remaining, &mut remaining_traversal_reads).await {
                    Ok(batch) => {
                        // A read-budget cut inside the fetch reports `incomplete`; an
                        // already-exhausted budget returns the I/O-free empty batch, so
                        // fall back to the child_count read_node already fetched.
                        cut = batch.incomplete || (batch.attempted == 0 && node.child_count > 0);
                        match window_title.filter(|_| depth == 0) {
                            Some(title) => {
                                let (children, matched) =
                                    scope_to_window(&conn, batch.items, title).await;
                                scope = matched;
                                children
                            }
                            None => batch.items,
                        }
                    }
                    Err(_) => Vec::new(),
                }
            } else {
                // Depth or node cap reached: any child this node reports is unread.
                cut = node.child_count > 0;
                Vec::new()
            };
            Some((node, child_refs, cut, scope))
        })
        .await;
        let Ok(read) = read else {
            truncated = true;
            break;
        };
        let Some((node, child_refs, cut, scope)) = read else {
            continue;
        };
        truncated |= cut;
        if scope.is_some() {
            window_scope = scope;
        }
        nodes.push(node);

        traversal.enqueue(
            child_refs
                .into_iter()
                .map(|child| (child, depth + 1, Some(index))),
        );
    }
    truncated |= traversal.truncated();

    Ok(AccessibilitySnapshot {
        nodes,
        scoped,
        root_pid,
        app_filter_matched,
        truncated,
        window_scope,
    })
}

/// Children of an app root, narrowed to the window named `title` when the root
/// holds several windows. Returns the children to read and the matched window
/// name. Only the other named frames are dropped: popups, menus, dialogs and
/// unnamed windows are kept, since Chromium puts a window's popups and dialogs
/// beside it under the app root.
async fn scope_to_window(
    conn: &AccessibilityConnection,
    children: Vec<ObjectRefOwned>,
    title: &str,
) -> (Vec<ObjectRefOwned>, Option<String>) {
    // An app root has a handful of windows; read them in order.
    let mut labels = Vec::with_capacity(children.len());
    for child in &children {
        labels.push(match open_accessible(conn, child).await {
            Ok(proxy) => (
                role_name(&proxy).await,
                optional_string(proxy.name().await.ok()),
            ),
            Err(_) => (String::new(), None),
        });
    }
    let Some(chosen) = matching_window(&labels, title) else {
        return (children, None);
    };
    let name = labels[chosen].1.clone();
    let keep = kept_beside_window(&labels, chosen);
    let kept = children
        .into_iter()
        .zip(keep)
        .filter_map(|(child, keep)| keep.then_some(child))
        .collect();
    (kept, name)
}

/// Which app root children (`(role, name)`) stay when `chosen` is the targeted
/// window: it, and every child that is not another named frame.
fn kept_beside_window(children: &[(String, Option<String>)], chosen: usize) -> Vec<bool> {
    children
        .iter()
        .enumerate()
        .map(|(index, (role, name))| {
            index == chosen
                || role != "frame"
                || name.as_deref().is_none_or(|name| name.trim().is_empty())
        })
        .collect()
}

pub(crate) fn is_window_role(role: &str) -> bool {
    matches!(role, "frame" | "window" | "dialog" | "file chooser")
}

/// Index of the one window among an app root's children (`(role, name)`)
/// that `title` names, when the root has at least two windows. An exact name
/// wins, then a case-insensitive one, then the one name that contains
/// `title`, ignoring case. A tie at the first rule that matches returns
/// `None`, which keeps every window. With no match at all, the longest name
/// that `title` starts with, followed by a decoration (` (...)` or
/// ` - ...`), wins: a compositor title such as Chromium's
/// "PlanetScale - Chromium (Profile 1)" decorates the AT-SPI frame name
/// "PlanetScale - Chromium".
fn matching_window(children: &[(String, Option<String>)], title: &str) -> Option<usize> {
    let windows: Vec<(usize, &str)> = children
        .iter()
        .enumerate()
        .filter(|(_, (role, _))| is_window_role(role))
        .map(|(index, (_, name))| (index, name.as_deref().unwrap_or_default().trim()))
        .collect();
    if windows.len() < 2 {
        return None;
    }
    let title = title.trim();
    let lowered = title.to_lowercase();
    let rules: [&dyn Fn(&str) -> bool; 3] = [
        &|name| name == title,
        &|name| name.to_lowercase() == lowered,
        &|name| name.to_lowercase().contains(&lowered),
    ];
    for rule in rules {
        let mut matches = windows.iter().filter(|(_, name)| rule(name));
        if let Some((index, _)) = matches.next() {
            return matches.next().is_none().then_some(*index);
        }
    }
    let decorated = |name: &str| {
        let name = name.to_lowercase();
        !name.is_empty()
            && lowered.strip_prefix(&name).is_some_and(|rest| {
                rest.starts_with(" (") || rest.starts_with(" - ") || rest.starts_with(" \u{2014} ")
            })
    };
    let decorated_matches = windows.iter().filter(|(_, name)| decorated(name));
    let longest = decorated_matches
        .clone()
        .map(|(_, name)| name.len())
        .max()?;
    let mut longest_matches = decorated_matches.filter(|(_, name)| name.len() == longest);
    let (index, _) = longest_matches.next()?;
    longest_matches.next().is_none().then_some(*index)
}

/// Compact description of the AT-SPI element that currently holds keyboard
/// focus, used as post-input feedback for type_text/press_key.
#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct FocusedElementSummary {
    pub role: String,
    pub name: Option<String>,
    pub editable: bool,
    pub states: Vec<String>,
    /// AT-SPI `Role::Terminal`, read from the role enum rather than the
    /// localized role name. Internal routing only; not part of the output.
    #[serde(skip)]
    #[schemars(skip)]
    pub is_terminal: bool,
}

impl FocusedElementSummary {
    /// A field that takes typed text: editable, or a text-entry role.
    pub(crate) fn accepts_text(&self) -> bool {
        self.editable
            || self.states.iter().any(|state| state == "editable")
            || matches!(
                self.role.as_str(),
                "text" | "entry" | "password text" | "combo box"
            )
    }
}

const FOCUS_PROBE_MAX_NODES: usize = 400;
const FOCUS_PROBE_MAX_DEPTH: u32 = 16;

/// Find the element with the `focused` state inside the target app (by pid) or
/// across all apps. Best-effort and bounded: returns Ok(None) when no focused
/// element is reachable through AT-SPI (common for apps without accessibility
/// support, e.g. Electron without --force-renderer-accessibility).
/// Outcome of the bounded focused-element search.
#[derive(Debug, Clone)]
pub(crate) enum FocusProbe {
    Found(FocusedElementSummary),
    /// The search covered the target's whole tree and nothing holds focus.
    NoneFocused,
    /// A complete scoped search saw only window/menu chrome, no content.
    ShellOnly,
    /// A node, depth, or read limit stopped the search before it finished, so
    /// the focused element may exist past the limit.
    Incomplete,
    /// A pid was given but no AT-SPI app belongs to it (xterm, or Electron
    /// without --force-renderer-accessibility), so focus cannot be read.
    NoAccessibleApp,
}

/// Focused element in the app owning `target_pid`, or across all apps when no
/// pid is given. With a pid, only that app's tree is searched: falling back to
/// every other app would report some unrelated widget as the focus.
pub(crate) async fn probe_focused_element(target_pid: Option<u32>) -> Result<FocusProbe> {
    focused_element_probe(target_pid, target_pid.is_some()).await
}

/// The focused element in the app that owns `target_pid`, for callers that
/// only need an answer when one exists. Every non-`Found` probe result maps to
/// `None`; see [`probe_focused_element`] for the distinctions.
pub(crate) async fn focused_element_summary_in_app(
    target_pid: u32,
) -> Result<Option<FocusedElementSummary>> {
    Ok(match focused_element_probe(Some(target_pid), true).await? {
        FocusProbe::Found(summary) => Some(summary),
        _ => None,
    })
}

async fn focused_element_probe(
    target_pid: Option<u32>,
    require_scoped: bool,
) -> Result<FocusProbe> {
    let conn = connect().await?;
    Ok(focused_element_search(&conn, target_pid, require_scoped)
        .await?
        .0)
}

/// The bounded focus search. A `Found` result for a non-container element
/// also returns that element's reference.
async fn focused_element_search(
    conn: &AccessibilityConnection,
    target_pid: Option<u32>,
    require_scoped: bool,
) -> Result<(FocusProbe, Option<ObjectRefOwned>)> {
    let mut remaining_registry_reads = MAX_DISCOVERY_ROOTS;
    let roots = registry_children(conn, MAX_DISCOVERY_ROOTS, &mut remaining_registry_reads).await?;
    let mut remaining_filter_reads = MAX_DISCOVERY_CHILD_READS;
    let selected_roots = select_roots(
        conn,
        roots,
        None,
        target_pid,
        None,
        &mut remaining_filter_reads,
    )
    .await;
    if require_scoped && selected_roots.pid != target_pid {
        return Ok((FocusProbe::NoAccessibleApp, None));
    }
    focused_element_search_from(conn, selected_roots.roots, require_scoped).await
}

/// The focus search below `roots`.
async fn focused_element_search_from(
    conn: &AccessibilityConnection,
    roots: Vec<ObjectRefOwned>,
    require_scoped: bool,
) -> Result<(FocusProbe, Option<ObjectRefOwned>)> {
    let mut traversal = BoundedTraversal::new(FOCUS_PROBE_MAX_NODES);
    let mut remaining_traversal_reads = FOCUS_PROBE_MAX_NODES;
    let mut incomplete = false;
    let mut shell_only = true;
    let mut observed_nodes = 0;
    let mut focused_container = None;
    let mut depth_base = 0_u32;

    traversal.enqueue(
        roots
            .into_iter()
            .map(|object_ref| (object_ref, 0_u32, false)),
    );

    while let Some((object_ref, depth, in_menu)) = traversal.pop() {
        let Ok(proxy) = open_accessible(conn, &object_ref).await else {
            incomplete = true;
            continue;
        };
        let Ok(state) = proxy.get_state().await else {
            incomplete = true;
            continue;
        };
        observed_nodes += 1;
        let mut child_menu = false;
        if shell_only {
            match accessibility_chrome_context(&role_name(&proxy).await, in_menu) {
                Some(menu) => child_menu = menu,
                None => shell_only = false,
            }
        }
        if state.contains(atspi::State::Focused) {
            let proxies = proxy.proxies().await.ok();
            let is_terminal = matches!(proxy.get_role().await, Ok(atspi::Role::Terminal));
            let summary = FocusedElementSummary {
                role: role_name(&proxy).await,
                name: optional_string(proxy.name().await.ok()),
                editable: supports_editable_text(proxies.as_ref()).await,
                states: state_labels(state),
                is_terminal,
            };
            // Chromium can mark both a document and its contenteditable entry
            // focused. Do not stop at the ancestor before visiting the editor:
            // the focus is inside it, so the rest of the budget searches only
            // its subtree, and nodes left unread elsewhere no longer matter.
            if focus_is_container(&summary) {
                focused_container = Some(summary);
                // Only within one app: across apps a stale focused document in
                // another app must not hide the real focus.
                if require_scoped {
                    traversal.narrow();
                    // The discarded queue had spent its child reads; the subtree
                    // gets the rest of the node budget, and its depth counts from
                    // the container.
                    remaining_traversal_reads = traversal.remaining_capacity();
                    depth_base = depth;
                    incomplete = false;
                }
            } else {
                return Ok((FocusProbe::Found(summary), Some(object_ref.clone())));
            }
        }
        let remaining = traversal.remaining_capacity();
        if depth - depth_base < FOCUS_PROBE_MAX_DEPTH && remaining > 0 {
            if let Ok(batch) =
                children_up_to(&proxy, remaining, &mut remaining_traversal_reads).await
            {
                incomplete |= batch.incomplete;
                // An exhausted shared read budget takes children_up_to's
                // I/O-free path (attempted 0, incomplete false), so the node's
                // own child count has to say whether children went unread.
                // With budget left, attempted 0 just means a leaf: no read.
                if batch.attempted == 0 && remaining_traversal_reads == 0 && !incomplete {
                    incomplete = proxy.child_count().await.map_or(true, |count| count > 0);
                }
                traversal.enqueue(
                    batch
                        .items
                        .into_iter()
                        .map(|child| (child, depth + 1, child_menu)),
                );
            } else {
                incomplete = true;
            }
        } else if !incomplete {
            // Depth or node cap: any child this node reports goes unread. One
            // child-count read settles it, and only until the first cut is seen.
            incomplete = proxy.child_count().await.map_or(true, |count| count > 0);
        }
    }
    Ok((
        finish_focus_probe(
            incomplete || traversal.truncated(),
            require_scoped && shell_only && observed_nodes > 0,
            focused_container,
        ),
        None,
    ))
}

pub(crate) fn focus_is_container(element: &FocusedElementSummary) -> bool {
    !element.editable
        && !element.states.iter().any(|state| state == "editable")
        && !element.is_terminal
        && matches!(
            element.role.as_str(),
            "application"
                | "frame"
                | "window"
                | "panel"
                | "filler"
                | "section"
                | "document web"
                | "document frame"
                | "document text"
        )
}

fn finish_focus_probe(
    incomplete: bool,
    shell_only: bool,
    focused_container: Option<FocusedElementSummary>,
) -> FocusProbe {
    // A focused container is not a definitive recipient if descendants were
    // unread. Preserve uncertainty rather than reporting a non-editable field.
    if incomplete {
        FocusProbe::Incomplete
    } else if let Some(container) = focused_container {
        FocusProbe::Found(container)
    } else if shell_only {
        FocusProbe::ShellOnly
    } else {
        FocusProbe::NoneFocused
    }
}

/// Window and native menu chrome can exist without Electron renderer content.
/// This is evidence about tree coverage, not positive Electron detection.
pub(crate) fn accessibility_chrome_context(role: &str, in_menu: bool) -> Option<bool> {
    match role {
        "application" | "frame" | "window" | "panel" | "filler" | "separator" => Some(in_menu),
        "menu bar" | "menu" | "menu item" | "check menu item" | "radio menu item"
        | "tearoff menu item" => Some(true),
        // Electron's native menu buttons are exposed as buttons, not menu items.
        "button" | "push button" | "label" | "static" | "image" | "icon" if in_menu => Some(true),
        _ => None,
    }
}

pub async fn perform_action(
    object_ref_id: &str,
    requested_action: Option<&str>,
) -> Result<ActionInvocation> {
    perform_action_inner(object_ref_id, requested_action, false).await
}

pub(crate) async fn perform_named_action(
    object_ref_id: &str,
    name: &str,
) -> Result<ActionInvocation> {
    perform_action_inner(object_ref_id, Some(name), true).await
}

async fn perform_action_inner(
    object_ref_id: &str,
    requested_action: Option<&str>,
    name_only: bool,
) -> Result<ActionInvocation> {
    let object_ref = object_ref_from_id(object_ref_id)?;
    let (action, action_index, action_name) = timeout(ACTION_QUERY_TIMEOUT, async {
        let conn = connect().await?;
        let proxy = open_accessible(&conn, &object_ref)
            .await
            .with_context(|| format!("failed to open AT-SPI object {object_ref_id}"))?;
        let action = proxy
            .proxies()
            .await?
            .action()
            .await
            .context("element does not expose the AT-SPI Action interface")?;
        let actions = read_actions(&action).await?;
        let action_index = if name_only {
            select_named_action_index(&actions, requested_action.unwrap_or_default())?
        } else {
            select_action_index(&actions, requested_action)?
        };
        let action_name = actions
            .get(action_index as usize)
            .map(|action| action.name.clone());
        Ok::<_, anyhow::Error>((action, action_index, action_name))
    })
    .await
    .context("AT-SPI action revalidation exceeded its 5-second deadline")??;
    // Only time out the reads: once DoAction is sent, it may already have acted.
    let ok = action
        .do_action(action_index)
        .await
        .with_context(|| format!("failed to invoke AT-SPI action {action_index}"))?;

    Ok(ActionInvocation {
        action_index,
        action_name,
        ok,
    })
}

pub async fn set_element_value(object_ref_id: &str, value: &str) -> Result<ValueSetInvocation> {
    let conn = connect().await?;
    let object_ref = object_ref_from_id(object_ref_id)?;
    let proxy = open_accessible(&conn, &object_ref)
        .await
        .with_context(|| format!("failed to open AT-SPI object {object_ref_id}"))?;
    let proxies = proxy.proxies().await?;
    set_element_value_with_proxies(&proxy, &proxies, value).await
}

async fn set_element_value_with_proxies(
    proxy: &AccessibleProxy<'_>,
    proxies: &Proxies<'_>,
    value: &str,
) -> Result<ValueSetInvocation> {
    if let Ok(numeric_value) = value.parse::<f64>() {
        if let Ok(value_proxy) = proxies.value().await {
            value_proxy
                .set_current_value(numeric_value)
                .await
                .with_context(|| {
                    format!("failed to set AT-SPI numeric value to {numeric_value}")
                })?;
            return Ok(ValueSetInvocation::Numeric {
                value: numeric_value,
            });
        }
    }

    if let Ok(editable_text) = proxies.editable_text().await {
        return set_editable_text_contents(proxy, proxies, &editable_text, value).await;
    }

    if value.parse::<f64>().is_err() && proxies.value().await.is_ok() {
        return Err(anyhow!(
            "element exposes the AT-SPI Value interface, but the requested value is not numeric"
        ));
    }

    Err(anyhow!(
        "element does not expose AT-SPI Value or EditableText interfaces"
    ))
}

async fn set_editable_text_contents(
    proxy: &AccessibleProxy<'_>,
    proxies: &Proxies<'_>,
    editable_text: &EditableTextProxy<'_>,
    value: &str,
) -> Result<ValueSetInvocation> {
    let ok = editable_text
        .set_text_contents(value)
        .await
        .context("failed to set AT-SPI editable text contents")?;
    if !ok {
        return Err(anyhow!("AT-SPI EditableText rejected the new contents"));
    }

    let outcome = verify_editable_text_contents(proxy, proxies, value).await;
    Ok(ValueSetInvocation::EditableText { outcome })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EditableTextReadbackError {
    Failed,
    TimedOut,
}

async fn readback_within<T, E>(
    deadline: Instant,
    read: impl Future<Output = std::result::Result<T, E>>,
) -> std::result::Result<T, EditableTextReadbackError> {
    timeout_at(deadline, read)
        .await
        .map_err(|_| EditableTextReadbackError::TimedOut)?
        .map_err(|_| EditableTextReadbackError::Failed)
}

async fn text_readback_matches(
    text: &TextProxy<'_>,
    requested: &str,
    deadline: Instant,
) -> std::result::Result<bool, EditableTextReadbackError> {
    let character_count = readback_within(deadline, text.character_count()).await?;
    if character_count < 0 {
        return Err(EditableTextReadbackError::Failed);
    }
    if character_count as usize == requested.chars().count() {
        return unicode_scalar_text_readback_matches(text, 0, requested, deadline).await;
    }

    let requested_utf16 = requested.encode_utf16().collect::<Vec<_>>();
    if character_count as usize != requested_utf16.len() {
        return Ok(false);
    }
    utf16_text_readback_matches(text, 0, &requested_utf16, deadline).await
}

/// Whether the text from offset `base` on starts with `requested`, with
/// offsets counted in Unicode scalars.
async fn unicode_scalar_text_readback_matches(
    text: &TextProxy<'_>,
    base: usize,
    requested: &str,
    deadline: Instant,
) -> std::result::Result<bool, EditableTextReadbackError> {
    let requested_chars = requested.chars().collect::<Vec<_>>();
    let mut offset = 0;
    while offset < requested_chars.len() {
        let end = offset
            .saturating_add(EDITABLE_TEXT_READ_CHUNK_UNITS)
            .min(requested_chars.len());
        let chunk = readback_within(
            deadline,
            text.get_text((base + offset) as i32, (base + end) as i32),
        )
        .await?;
        if !chunk
            .chars()
            .eq(requested_chars[offset..end].iter().copied())
        {
            return Ok(false);
        }
        offset = end;
    }

    Ok(true)
}

/// The same check with offsets counted in UTF-16 code units.
async fn utf16_text_readback_matches(
    text: &TextProxy<'_>,
    base: usize,
    requested: &[u16],
    deadline: Instant,
) -> std::result::Result<bool, EditableTextReadbackError> {
    let mut offset = 0;
    while offset < requested.len() {
        let mut end = offset
            .saturating_add(EDITABLE_TEXT_READ_CHUNK_UNITS)
            .min(requested.len());
        if end < requested.len() && (0xD800..=0xDBFF).contains(&requested[end - 1]) {
            end -= 1;
        }
        let chunk = readback_within(
            deadline,
            text.get_text((base + offset) as i32, (base + end) as i32),
        )
        .await?;
        if !chunk
            .encode_utf16()
            .eq(requested[offset..end].iter().copied())
        {
            return Ok(false);
        }
        offset = end;
    }

    Ok(true)
}

async fn verify_editable_text_contents(
    proxy: &AccessibleProxy<'_>,
    proxies: &Proxies<'_>,
    requested: &str,
) -> EditableTextSetOutcome {
    let deadline = Instant::now() + EDITABLE_TEXT_VERIFY_TIMEOUT;
    match readback_within(deadline, proxy.get_role()).await {
        Ok(atspi::Role::PasswordText) => return EditableTextSetOutcome::PasswordUnverifiable,
        Ok(_) => {}
        Err(EditableTextReadbackError::Failed) => {
            return EditableTextSetOutcome::ReadbackFailed;
        }
        Err(EditableTextReadbackError::TimedOut) => {
            return EditableTextSetOutcome::ReadbackTimedOut;
        }
    }
    let text = match readback_within(deadline, proxies.text()).await {
        Ok(text) => text,
        Err(EditableTextReadbackError::Failed) => {
            return EditableTextSetOutcome::ReadbackFailed;
        }
        Err(EditableTextReadbackError::TimedOut) => {
            return EditableTextSetOutcome::ReadbackTimedOut;
        }
    };

    loop {
        match text_readback_matches(&text, requested, deadline).await {
            Ok(true) => return EditableTextSetOutcome::Verified,
            Ok(false) => {}
            Err(EditableTextReadbackError::Failed) => {
                return EditableTextSetOutcome::ReadbackFailed;
            }
            Err(EditableTextReadbackError::TimedOut) => {
                return EditableTextSetOutcome::ReadbackTimedOut;
            }
        }

        let now = Instant::now();
        if now >= deadline {
            return EditableTextSetOutcome::MismatchAfterDeadline;
        }
        sleep_until((now + EDITABLE_TEXT_VERIFY_INTERVAL).min(deadline)).await;
        if Instant::now() >= deadline {
            return EditableTextSetOutcome::MismatchAfterDeadline;
        }
    }
}

/// Characters of a mismatched readback that a failure report quotes.
const MAX_REPORTED_READBACK_CHARS: usize = 256;

/// Outcome of [`insert_text_at_focus`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum FocusedTextInsert {
    /// The field reads the text at the insertion point and has the expected
    /// length.
    Verified {
        role: String,
        replaced_selection: bool,
        /// The caret is after the inserted text, where typing leaves it.
        caret_after_text: bool,
    },
    /// No text was changed. The focus is not a field this route can fill; the
    /// string says why.
    NotEditable(String),
    /// No text was changed. The focused element is a password field.
    PasswordField,
    /// The app took the edit, but the field does not read back the text at
    /// the insertion point.
    Mismatch {
        expected_count: i32,
        read_count: i32,
        /// The text read from the insertion point.
        read_text: String,
        read_truncated: bool,
    },
    ReadbackFailed,
    ReadbackTimedOut,
    /// The app refused or failed an edit call.
    EditFailed {
        reason: String,
        may_have_changed: bool,
    },
}

/// Insert `text` at the caret of the focused element in the target window,
/// through AT-SPI EditableText, and read it back. The window is the app
/// root's window named `window_title` (any title works when the app has one
/// window), and it must be active. A selection is replaced, as typing would.
/// An empty or fully selected field gets its contents set, the same call
/// set_value makes. `Err` means nothing was changed.
pub(crate) async fn insert_text_at_focus(
    target_pid: u32,
    window_title: Option<&str>,
    text: &str,
) -> Result<FocusedTextInsert> {
    let conn = connect().await?;
    insert_text_at_focus_on(&conn, target_pid, window_title, text).await
}

pub(crate) async fn insert_text_at_focus_on(
    conn: &AccessibilityConnection,
    target_pid: u32,
    window_title: Option<&str>,
    text: &str,
) -> Result<FocusedTextInsert> {
    let window = timeout(
        ACTION_QUERY_TIMEOUT,
        target_window_root(conn, target_pid, window_title),
    )
    .await
    .context("finding the target window in AT-SPI exceeded its 5-second deadline")??;
    let window = match window {
        Ok(window) => window,
        Err(reason) => return Ok(FocusedTextInsert::NotEditable(reason)),
    };
    let (probe, object_ref) = timeout(
        ACTION_QUERY_TIMEOUT,
        focused_element_search_from(conn, vec![window], true),
    )
    .await
    .context("the AT-SPI focus search exceeded its 5-second deadline")??;
    let (summary, object_ref) = match (probe, object_ref) {
        (FocusProbe::Found(summary), Some(object_ref)) => (summary, object_ref),
        (FocusProbe::Found(summary), None) => {
            return Ok(FocusedTextInsert::NotEditable(format!(
                "keyboard focus is on a {} container, not on a text field",
                summary.role
            )))
        }
        (FocusProbe::NoneFocused | FocusProbe::ShellOnly, _) => {
            return Ok(FocusedTextInsert::NotEditable(
                "no element in the target window has keyboard focus".to_string(),
            ))
        }
        (FocusProbe::Incomplete, _) => {
            return Ok(FocusedTextInsert::NotEditable(
                "the focused element was not found within the AT-SPI search limits".to_string(),
            ))
        }
        (FocusProbe::NoAccessibleApp, _) => {
            return Ok(FocusedTextInsert::NotEditable(
                "the target app exposes no AT-SPI tree".to_string(),
            ))
        }
    };
    let proxy = open_accessible(conn, &object_ref)
        .await
        .context("failed to open the focused AT-SPI element")?;
    let proxies = proxy
        .proxies()
        .await
        .context("failed to read the focused element's interfaces")?;
    insert_text_with_proxies(&proxy, &proxies, &summary, text).await
}

/// The AT-SPI window of the app owning `target_pid` that matches the verified
/// compositor window, or why none can be proven to. One app root can hold
/// several windows (Chromium holds them all), and its AT-SPI focus can lag
/// behind the compositor's, so a focused field elsewhere in the app is not
/// the target. The window must be active.
async fn target_window_root(
    conn: &AccessibilityConnection,
    target_pid: u32,
    window_title: Option<&str>,
) -> Result<std::result::Result<ObjectRefOwned, String>> {
    let mut remaining_registry_reads = MAX_DISCOVERY_ROOTS;
    let roots = registry_children(conn, MAX_DISCOVERY_ROOTS, &mut remaining_registry_reads).await?;
    let mut remaining_filter_reads = MAX_DISCOVERY_CHILD_READS;
    let selected = select_roots(
        conn,
        roots,
        None,
        Some(target_pid),
        None,
        &mut remaining_filter_reads,
    )
    .await;
    if selected.pid != Some(target_pid) {
        return Ok(Err("the target app exposes no AT-SPI tree".to_string()));
    }
    let mut windows = Vec::new();
    let mut labels = Vec::new();
    let mut remaining_child_reads = MAX_DISCOVERY_CHILD_READS;
    for root in &selected.roots {
        let Ok(root) = open_accessible(conn, root).await else {
            continue;
        };
        let Ok(batch) =
            children_up_to(&root, MAX_DISCOVERY_ROOTS, &mut remaining_child_reads).await
        else {
            continue;
        };
        for child in batch.items {
            let Ok(proxy) = open_accessible(conn, &child).await else {
                continue;
            };
            let role = role_name(&proxy).await;
            if !is_window_role(&role) {
                continue;
            }
            let name = optional_string(proxy.name().await.ok());
            let active = proxy
                .get_state()
                .await
                .is_ok_and(|state| state.contains(atspi::State::Active));
            labels.push((role, name));
            windows.push((child, active));
        }
    }
    let chosen = match windows.len() {
        0 => return Ok(Err("the target app exposes no AT-SPI window".to_string())),
        1 => 0,
        count => {
            let Some(chosen) = window_title.and_then(|title| matching_window(&labels, title))
            else {
                return Ok(Err(format!(
                    "the target window could not be matched to one of the app's {count} AT-SPI windows"
                )));
            };
            chosen
        }
    };
    let (window, active) = windows.swap_remove(chosen);
    if !active {
        return Ok(Err(format!(
            "the target window's AT-SPI {} is not active, so its focus may be stale",
            labels[chosen].0
        )));
    }
    Ok(Ok(window))
}

async fn read_before_edit<T, E: std::fmt::Display>(
    deadline: Instant,
    read: impl Future<Output = std::result::Result<T, E>>,
    what: &str,
) -> Result<T> {
    match timeout_at(deadline, read).await {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(error)) => Err(anyhow!("failed to read the field's {what}: {error}")),
        Err(_) => Err(anyhow!("reading the field's {what} timed out")),
    }
}

/// InsertText's length argument for `requested`. GTK and the other ATK
/// bridges count it in bytes, as the AT-SPI documentation does. Qt's bridge
/// resizes the text to that many UTF-16 code units, padding a longer text.
/// ASCII text has one length in every unit; other text needs the app's
/// toolkit, and the error explains a toolkit that cannot be read.
async fn insert_text_length(
    proxy: &AccessibleProxy<'_>,
    requested: &str,
    deadline: Instant,
) -> std::result::Result<i32, String> {
    let too_long = |_| "the text is too long for AT-SPI InsertText".to_string();
    if requested.is_ascii() {
        return i32::try_from(requested.len()).map_err(too_long);
    }
    let Some(toolkit) = toolkit_name(proxy, deadline).await else {
        return Err("the app's toolkit could not be read, and InsertText counts the length of non-ASCII text differently per toolkit".to_string());
    };
    if toolkit.trim().to_ascii_lowercase().starts_with("qt") {
        i32::try_from(requested.encode_utf16().count()).map_err(too_long)
    } else {
        i32::try_from(requested.len()).map_err(too_long)
    }
}

/// `ToolkitName` of the element's application: its `GetApplication` root, or
/// else the root on the element's own connection.
async fn toolkit_name(proxy: &AccessibleProxy<'_>, deadline: Instant) -> Option<String> {
    let connection = proxy.inner().connection();
    let application = timeout_at(deadline, proxy.get_application())
        .await
        .ok()
        .and_then(|reply| reply.ok())
        .filter(|application| !application.is_null());
    let (name, path) = match &application {
        Some(application) => (
            application.name_as_str()?.to_string(),
            application.path_as_str().to_string(),
        ),
        None => (
            proxy.inner().destination().to_string(),
            "/org/a11y/atspi/accessible/root".to_string(),
        ),
    };
    let app = atspi::proxy::application::ApplicationProxy::builder(connection)
        .destination(name)
        .ok()?
        .path(path)
        .ok()?
        .cache_properties(zbus::proxy::CacheProperties::No)
        .build()
        .await
        .ok()?;
    timeout_at(deadline, app.toolkit_name()).await.ok()?.ok()
}

async fn insert_text_with_proxies(
    proxy: &AccessibleProxy<'_>,
    proxies: &Proxies<'_>,
    summary: &FocusedElementSummary,
    requested: &str,
) -> Result<FocusedTextInsert> {
    let deadline = Instant::now() + ACTION_QUERY_TIMEOUT;
    let role = read_before_edit(deadline, proxy.get_role(), "role").await?;
    if role == atspi::Role::PasswordText || summary.role.to_ascii_lowercase().contains("password") {
        return Ok(FocusedTextInsert::PasswordField);
    }
    if summary.is_terminal || role == atspi::Role::Terminal {
        return Ok(FocusedTextInsert::NotEditable(
            "the focused element is a terminal".to_string(),
        ));
    }
    if matches!(role, atspi::Role::Invalid | atspi::Role::Unknown) {
        return Ok(FocusedTextInsert::NotEditable(
            "the focused element's role does not show whether it hides input".to_string(),
        ));
    }
    if !summary.states.iter().any(|state| state == "editable") {
        return Ok(FocusedTextInsert::NotEditable(format!(
            "the focused {} is not editable",
            summary.role
        )));
    }
    let Ok(editable) = proxies.editable_text().await else {
        return Ok(FocusedTextInsert::NotEditable(format!(
            "the focused {} does not expose AT-SPI EditableText",
            summary.role
        )));
    };
    let Ok(text) = proxies.text().await else {
        return Ok(FocusedTextInsert::NotEditable(format!(
            "the focused {} does not expose AT-SPI Text, so the result could not be read back",
            summary.role
        )));
    };
    let count = read_before_edit(deadline, text.character_count(), "character count").await?;
    let caret = read_before_edit(deadline, text.caret_offset(), "caret offset").await?;
    let selections =
        read_before_edit(deadline, text_selection_count(&text), "selection count").await?;
    let (start, end) = match selections {
        ..=0 => (caret, caret),
        1 => {
            let (a, b) = read_before_edit(deadline, text.get_selection(0), "selection").await?;
            (a.min(b), a.max(b))
        }
        n => {
            return Ok(FocusedTextInsert::NotEditable(format!(
                "the field has {n} selections, so the insertion point is ambiguous"
            )))
        }
    };
    if count < 0 || start < 0 || end > count {
        return Err(anyhow!(
            "the field reported an insertion point ({start}..{end}) outside its {count} characters"
        ));
    }

    let replaced_selection = start < end;
    let whole_field = start == 0 && end == count;
    // Rewriting the whole field for a partial edit would flatten embedded
    // objects and formatting, so a partial edit always uses InsertText.
    let insert_length = if whole_field {
        None
    } else {
        match insert_text_length(proxy, requested, deadline).await {
            Ok(length) => Some(length),
            Err(reason) => return Ok(FocusedTextInsert::NotEditable(reason)),
        }
    };
    let untouched = read_untouched_text(&text, start, end, count, deadline).await?;

    if let Some(length) = insert_length {
        if replaced_selection {
            match edit_call(editable.delete_text(start, end), "DeleteText").await {
                Ok(()) => {}
                Err(EditCallError::Refused) => {
                    return Ok(FocusedTextInsert::EditFailed {
                        reason: "the app refused to delete the selection".to_string(),
                        may_have_changed: false,
                    })
                }
                Err(EditCallError::Failed(reason)) => {
                    return Ok(FocusedTextInsert::EditFailed {
                        reason,
                        may_have_changed: true,
                    })
                }
            }
        }
        match edit_call(editable.insert_text(start, requested, length), "InsertText").await {
            Ok(()) => {}
            Err(EditCallError::Refused) => {
                return Ok(FocusedTextInsert::EditFailed {
                    reason: if replaced_selection {
                        "the app deleted the selection but refused InsertText".to_string()
                    } else {
                        "the app refused InsertText".to_string()
                    },
                    may_have_changed: replaced_selection,
                })
            }
            Err(EditCallError::Failed(reason)) => {
                return Ok(FocusedTextInsert::EditFailed {
                    reason,
                    may_have_changed: true,
                })
            }
        }
    } else {
        match edit_call(editable.set_text_contents(requested), "SetTextContents").await {
            Ok(()) => {}
            Err(EditCallError::Refused) => {
                return Ok(FocusedTextInsert::EditFailed {
                    reason: "the app refused SetTextContents".to_string(),
                    may_have_changed: false,
                })
            }
            Err(EditCallError::Failed(reason)) => {
                return Ok(FocusedTextInsert::EditFailed {
                    reason,
                    may_have_changed: true,
                })
            }
        }
    }

    verify_inserted_text(&text, start, count - (end - start), requested, &untouched)
        .await
        .map(|outcome| match outcome {
            InsertReadback::Verified { caret_after_text } => FocusedTextInsert::Verified {
                role: summary.role.clone(),
                replaced_selection,
                caret_after_text,
            },
            InsertReadback::Other(outcome) => outcome,
        })
}

enum EditCallError {
    /// The app answered false: it did not make the edit.
    Refused,
    /// The call failed or timed out, so the edit may have happened.
    Failed(String),
}

/// One EditableText call, bounded like the other AT-SPI calls.
async fn edit_call(
    call: impl Future<Output = zbus::Result<bool>>,
    name: &str,
) -> std::result::Result<(), EditCallError> {
    match timeout(ACTION_QUERY_TIMEOUT, call).await {
        Ok(Ok(true)) => Ok(()),
        Ok(Ok(false)) => Err(EditCallError::Refused),
        Ok(Err(error)) => Err(EditCallError::Failed(format!("{name} failed: {error}"))),
        Err(_) => Err(EditCallError::Failed(format!(
            "{name} did not answer within 5 seconds"
        ))),
    }
}

/// Characters on each side of the edit that a large field's readback checks.
const UNTOUCHED_SPAN_UNITS: i32 = 32;

/// The text an edit of `start..end` must leave alone, read before the edit.
enum UntouchedText {
    /// A field of at most `MAX_TEXT_READBACK_CHARS`: everything before and
    /// after the edit.
    Whole { before: String, after: String },
    /// A larger field: the spans just before and after the edit.
    Spans {
        before: String,
        before_units: i32,
        after: String,
        after_units: i32,
    },
}

async fn read_untouched_text(
    text: &TextProxy<'_>,
    start: i32,
    end: i32,
    count: i32,
    deadline: Instant,
) -> Result<UntouchedText> {
    if count <= MAX_TEXT_READBACK_CHARS {
        return Ok(UntouchedText::Whole {
            before: read_before_edit(deadline, text.get_text(0, start), "text").await?,
            after: read_before_edit(deadline, text.get_text(end, count), "text").await?,
        });
    }
    let before_units = start.min(UNTOUCHED_SPAN_UNITS);
    let after_units = (count - end).min(UNTOUCHED_SPAN_UNITS);
    Ok(UntouchedText::Spans {
        before: read_before_edit(deadline, text.get_text(start - before_units, start), "text")
            .await?,
        before_units,
        after: read_before_edit(deadline, text.get_text(end, end + after_units), "text").await?,
        after_units,
    })
}

enum InsertReadback {
    Verified { caret_after_text: bool },
    Other(FocusedTextInsert),
}

/// Whether the field holds `requested` at `start`, `units` long in the app's
/// offsets, with the untouched text unchanged around it.
async fn edit_reads_back(
    text: &TextProxy<'_>,
    start: i32,
    units: i32,
    read_count: i32,
    requested: &str,
    untouched: &UntouchedText,
    deadline: Instant,
) -> std::result::Result<bool, EditableTextReadbackError> {
    match untouched {
        UntouchedText::Whole { before, after } => {
            let contents = readback_within(deadline, text.get_text(0, read_count)).await?;
            Ok(
                contents.len() == before.len() + requested.len() + after.len()
                    && contents.starts_with(before.as_str())
                    && contents[before.len()..].starts_with(requested)
                    && contents.ends_with(after.as_str()),
            )
        }
        UntouchedText::Spans {
            before,
            before_units,
            after,
            after_units,
        } => {
            let inserted = readback_within(deadline, text.get_text(start, start + units)).await?;
            if inserted != requested {
                return Ok(false);
            }
            let read_before =
                readback_within(deadline, text.get_text(start - before_units, start)).await?;
            let after_start = start + units;
            let read_after = readback_within(
                deadline,
                text.get_text(after_start, after_start + after_units),
            )
            .await?;
            Ok(&read_before == before && &read_after == after)
        }
    }
}

/// Poll until the edit reads back: `requested` at `start`, `kept` other
/// characters in Unicode scalars or UTF-16 code units (whichever the app
/// counts in), and the untouched text unchanged. Then put the caret after the
/// text.
async fn verify_inserted_text(
    text: &TextProxy<'_>,
    start: i32,
    kept: i32,
    requested: &str,
    untouched: &UntouchedText,
) -> Result<InsertReadback> {
    let deadline = Instant::now() + EDITABLE_TEXT_VERIFY_TIMEOUT;
    let scalars = requested.chars().count() as i64;
    let utf16 = requested.encode_utf16().count() as i64;
    let mut read_count = 0;
    // A read cut by the deadline after the field already read back wrong is
    // a mismatch, not a readback timeout.
    let mut mismatched = false;
    loop {
        let count = match readback_within(deadline, text.character_count()).await {
            Ok(count) => count,
            Err(EditableTextReadbackError::Failed) => {
                return Ok(InsertReadback::Other(FocusedTextInsert::ReadbackFailed))
            }
            Err(EditableTextReadbackError::TimedOut) => {
                if mismatched {
                    break;
                }
                return Ok(InsertReadback::Other(FocusedTextInsert::ReadbackTimedOut));
            }
        };
        read_count = count;
        let units = i64::from(read_count) - i64::from(kept);
        let matched = if units == scalars || units == utf16 {
            edit_reads_back(
                text,
                start,
                units as i32,
                read_count,
                requested,
                untouched,
                deadline,
            )
            .await
            .map(|matched| matched.then_some(units))
        } else {
            Ok(None)
        };
        match matched {
            Ok(Some(units)) => {
                let after = (i64::from(start) + units) as i32;
                let caret_deadline = Instant::now() + EDITABLE_TEXT_VERIFY_TIMEOUT;
                let caret_after_text =
                    match readback_within(caret_deadline, text.caret_offset()).await {
                        Ok(caret) if caret == after => true,
                        _ => matches!(
                            readback_within(caret_deadline, text.set_caret_offset(after)).await,
                            Ok(true)
                        ),
                    };
                return Ok(InsertReadback::Verified { caret_after_text });
            }
            Ok(None) => mismatched = true,
            Err(EditableTextReadbackError::Failed) => {
                return Ok(InsertReadback::Other(FocusedTextInsert::ReadbackFailed))
            }
            Err(EditableTextReadbackError::TimedOut) => {
                if mismatched {
                    break;
                }
                return Ok(InsertReadback::Other(FocusedTextInsert::ReadbackTimedOut));
            }
        }
        let now = Instant::now();
        if now >= deadline {
            break;
        }
        sleep_until((now + EDITABLE_TEXT_VERIFY_INTERVAL).min(deadline)).await;
        if Instant::now() >= deadline {
            break;
        }
    }

    // Quote what the field holds where the text should be.
    let wanted = scalars.max(utf16);
    let shown = wanted.min(MAX_REPORTED_READBACK_CHARS as i64);
    let read_end = (i64::from(start) + shown).min(i64::from(read_count.max(0)));
    let read_text = if read_end > i64::from(start) {
        let quote_deadline = Instant::now() + EDITABLE_TEXT_VERIFY_TIMEOUT;
        readback_within(quote_deadline, text.get_text(start, read_end as i32))
            .await
            .unwrap_or_default()
    } else {
        String::new()
    };
    let read_truncated = wanted > shown;
    Ok(InsertReadback::Other(FocusedTextInsert::Mismatch {
        expected_count: (i64::from(kept) + scalars) as i32,
        read_count,
        read_text,
        read_truncated,
    }))
}

async fn connect() -> Result<AccessibilityConnection> {
    hydrate_session_bus_env();
    AccessibilityConnection::new()
        .await
        .context("failed to connect to AT-SPI bus")
}

/// Open an `AccessibleProxy` for an object on the a11y bus.
///
/// We deliberately avoid `AccessibilityConnection::object_as_accessible` (the
/// `P2P` trait). For apps that advertise a peer-to-peer bus address it routes
/// reads over that socket, but for apps that don't (notably GTK4 apps such as
/// Nautilus / Text Editor / baobab, which don't implement the legacy
/// `GetApplicationBusAddress`) it falls back to a proxy built with only a path
/// and *no destination*. On the shared a11y bus that proxy can't address the
/// app and every call fails with `ServiceUnknown`, which surfaces as an empty
/// tree (`role: "unknown"`, `child_count: 0`). `as_accessible_proxy` always
/// pins the destination to the object's bus name, so it works for every app
/// regardless of P2P support. See issue #31.
async fn open_accessible<'r>(
    conn: &AccessibilityConnection,
    object_ref: &'r ObjectRefOwned,
) -> Result<AccessibleProxy<'r>, atspi::AtspiError> {
    object_ref.as_accessible_proxy(conn.connection()).await
}

async fn registry_children(
    conn: &AccessibilityConnection,
    limit: usize,
    remaining_child_reads: &mut usize,
) -> Result<Vec<ObjectRefOwned>> {
    let root = conn
        .root_accessible_on_registry()
        .await
        .context("failed to open AT-SPI registry root")?;
    let batch = children_up_to(&root, limit, remaining_child_reads)
        .await
        .context("failed to read AT-SPI registry children")?;
    if batch.all_failed() {
        return Err(anyhow!(
            "AT-SPI registry reported children, but every indexed child read failed"
        ));
    }
    Ok(batch.items)
}

struct SelectedRoots {
    roots: Vec<ObjectRefOwned>,
    scoped: bool,
    /// Set only when the roots were chosen because they belong to this pid.
    pid: Option<u32>,
    app_filter_matched: bool,
}

/// Normalized app-name filter, or `None` when the caller passed nothing usable.
/// A `None` needle without a PID target means the snapshot covers the whole desktop.
fn app_name_needle(app_name_or_bundle_identifier: Option<&str>) -> Option<String> {
    app_name_or_bundle_identifier
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_ascii_lowercase())
}

async fn select_roots(
    conn: &AccessibilityConnection,
    roots: Vec<ObjectRefOwned>,
    app_name_or_bundle_identifier: Option<&str>,
    target_pid: Option<u32>,
    pid_fallback_name: Option<&str>,
    remaining_child_reads: &mut usize,
) -> SelectedRoots {
    let needle = app_name_needle(app_name_or_bundle_identifier);
    let dbus = DBusProxy::new(conn.connection()).await.ok();
    let mut remaining = roots;

    if let Some(target_pid) = target_pid {
        let mut pid_and_filter_matches = Vec::new();
        let mut pid_matches = Vec::new();
        let mut non_pid_matches = Vec::new();

        for object_ref in remaining {
            if object_ref_pid(dbus.as_ref(), &object_ref).await == Some(target_pid) {
                if let Some(needle) = needle.as_deref() {
                    if root_matches(conn, &object_ref, needle, remaining_child_reads).await {
                        pid_and_filter_matches.push(object_ref);
                    } else {
                        pid_matches.push(object_ref);
                    }
                } else {
                    pid_matches.push(object_ref);
                }
            } else {
                non_pid_matches.push(object_ref);
            }
        }

        if !pid_and_filter_matches.is_empty() {
            return SelectedRoots {
                roots: pid_and_filter_matches,
                scoped: true,
                pid: Some(target_pid),
                app_filter_matched: true,
            };
        }
        if !pid_matches.is_empty() {
            return SelectedRoots {
                roots: pid_matches,
                scoped: true,
                pid: Some(target_pid),
                app_filter_matched: needle.is_none(),
            };
        }

        if needle.is_none() {
            // A listed window's pid can own no root: a Flatpak app registers
            // through xdg-dbus-proxy. Its name then finds the root, and the
            // tree records no pid, so element calls check each node's owner.
            if let Some(fallback) = app_name_needle(pid_fallback_name) {
                let mut selected = Vec::new();
                for object_ref in non_pid_matches {
                    if root_matches(conn, &object_ref, &fallback, remaining_child_reads).await {
                        selected.push(object_ref);
                    }
                }
                if !selected.is_empty() {
                    return SelectedRoots {
                        roots: selected,
                        scoped: true,
                        pid: None,
                        app_filter_matched: true,
                    };
                }
            }
            // A PID-only target that disappeared must not widen to the desktop.
            return SelectedRoots {
                roots: Vec::new(),
                scoped: true,
                pid: None,
                app_filter_matched: false,
            };
        }

        remaining = non_pid_matches;
    }

    let Some(needle) = needle.as_deref() else {
        return SelectedRoots {
            roots: remaining,
            scoped: false,
            pid: None,
            app_filter_matched: true,
        };
    };

    let mut selected = Vec::new();
    for object_ref in remaining {
        if root_matches(conn, &object_ref, needle, remaining_child_reads).await {
            selected.push(object_ref);
        }
    }

    let app_filter_matched = !selected.is_empty();
    SelectedRoots {
        roots: selected,
        scoped: true,
        pid: None,
        app_filter_matched,
    }
}

async fn root_matches(
    conn: &AccessibilityConnection,
    object_ref: &ObjectRefOwned,
    needle: &str,
    remaining_child_reads: &mut usize,
) -> bool {
    let Ok(proxy) = open_accessible(conn, object_ref).await else {
        return object_ref_id(object_ref)
            .to_ascii_lowercase()
            .contains(needle);
    };

    if proxy_matches(&proxy, object_ref, needle).await {
        return true;
    }

    for child_ref in children_up_to(&proxy, ROOT_MATCH_CHILD_LIMIT, remaining_child_reads)
        .await
        .map(|batch| batch.items)
        .unwrap_or_default()
    {
        let Ok(child_proxy) = open_accessible(conn, &child_ref).await else {
            continue;
        };
        if proxy_matches(&child_proxy, &child_ref, needle).await {
            return true;
        }
    }

    false
}

async fn proxy_matches(
    proxy: &AccessibleProxy<'_>,
    object_ref: &ObjectRefOwned,
    needle: &str,
) -> bool {
    let name = proxy.name().await.unwrap_or_default();
    let role = proxy.get_role_name().await.unwrap_or_default();
    format!("{} {} {}", object_ref_id(object_ref), name, role)
        .to_ascii_lowercase()
        .contains(needle)
}

async fn read_app_summary(
    proxy: &AccessibleProxy<'_>,
    object_ref: &ObjectRefOwned,
    dbus: Option<&DBusProxy<'_>>,
) -> AccessibleAppSummary {
    AccessibleAppSummary {
        object_ref: object_ref_id(object_ref),
        name: optional_string(proxy.name().await.ok()),
        pid: object_ref_pid(dbus, object_ref).await,
        role: role_name(proxy).await,
        child_count: proxy.child_count().await.unwrap_or_default(),
        bounds: bounds(proxy).await,
    }
}

async fn read_node(
    proxy: &AccessibleProxy<'_>,
    object_ref: &ObjectRefOwned,
    index: u32,
    parent_index: Option<u32>,
    depth: u32,
) -> AccessibilityNode {
    let proxies = proxy.proxies().await.ok();

    AccessibilityNode {
        index,
        parent_index,
        depth,
        object_ref: object_ref_id(object_ref),
        role: role_name(proxy).await,
        name: optional_string(proxy.name().await.ok()),
        description: optional_string(proxy.description().await.ok()),
        child_count: proxy.child_count().await.unwrap_or_default(),
        bounds: bounds_from_proxies(proxies.as_ref(), proxy).await,
        states: states_from_proxy(proxy).await,
        actions: actions_from_proxies(proxies.as_ref()).await,
        value: value_from_proxies(proxies.as_ref()).await,
        text: text_from_proxies(proxies.as_ref()).await,
        supports_editable_text: supports_editable_text(proxies.as_ref()).await,
    }
}

/// Role reported when neither AT-SPI role read succeeds.
pub(crate) const UNKNOWN_ROLE: &str = "unknown";

async fn role_name(proxy: &AccessibleProxy<'_>) -> String {
    if let Ok(role) = proxy.get_role_name().await {
        if !role.trim().is_empty() {
            return role;
        }
    }
    proxy
        .get_role()
        .await
        .map(|role| format!("{role:?}"))
        .unwrap_or_else(|_| UNKNOWN_ROLE.to_string())
}

async fn bounds(proxy: &AccessibleProxy<'_>) -> Option<Bounds> {
    bounds_from_proxies(proxy.proxies().await.ok().as_ref(), proxy).await
}

/// Pid of the process that owns an AT-SPI object ref (`:bus/path`), from the
/// accessibility bus. `None` when the owner is gone or the bus cannot say.
pub(crate) async fn object_ref_owner_pid(object_ref_id: &str) -> Result<Option<u32>> {
    let object_ref = object_ref_from_id(object_ref_id)?;
    let conn = connect().await?;
    let dbus = DBusProxy::new(conn.connection()).await.ok();
    Ok(object_ref_pid(dbus.as_ref(), &object_ref).await)
}

/// PID of the application root, which may differ from an embedded element's process.
pub(crate) async fn object_ref_application_pid(object_ref_id: &str) -> Result<Option<u32>> {
    let object_ref = object_ref_from_id(object_ref_id)?;
    let conn = connect().await?;
    let application = timeout(ACTION_QUERY_TIMEOUT, async {
        let proxy = open_accessible(&conn, &object_ref).await.ok()?;
        proxy.get_application().await.ok()
    })
    .await
    .ok()
    .flatten()
    .filter(|application| !application.is_null());
    let dbus = DBusProxy::new(conn.connection()).await.ok();
    Ok(object_ref_pid(dbus.as_ref(), application.as_ref().unwrap_or(&object_ref)).await)
}

async fn object_ref_pid(dbus: Option<&DBusProxy<'_>>, object_ref: &ObjectRefOwned) -> Option<u32> {
    let dbus = dbus?;
    let bus_name = BusName::try_from(object_ref.name_as_str()?.to_string()).ok()?;
    dbus.get_connection_unix_process_id(bus_name).await.ok()
}

async fn bounds_from_proxies(
    proxies: Option<&atspi::proxy::proxy_ext::Proxies<'_>>,
    proxy: &AccessibleProxy<'_>,
) -> Option<Bounds> {
    let owned_proxies;
    let proxies = if let Some(proxies) = proxies {
        proxies
    } else {
        owned_proxies = proxy.proxies().await.ok()?;
        &owned_proxies
    };
    let component = proxies.component().await.ok()?;
    let (x, y, width, height) = component.get_extents(CoordType::Screen).await.ok()?;
    normalize_bounds(Bounds {
        x,
        y,
        width,
        height,
    })
}

fn normalize_bounds(bounds: Bounds) -> Option<Bounds> {
    if bounds.width <= 0 || bounds.height <= 0 {
        return None;
    }
    if bounds.x <= i32::MIN / 2 || bounds.y <= i32::MIN / 2 {
        return None;
    }
    Some(bounds)
}

async fn actions_from_proxies(
    proxies: Option<&atspi::proxy::proxy_ext::Proxies<'_>>,
) -> Vec<AccessibilityAction> {
    let Some(proxies) = proxies else {
        return Vec::new();
    };
    let Ok(action_proxy) = proxies.action().await else {
        return Vec::new();
    };

    read_actions(&action_proxy)
        .await
        .unwrap_or_default()
        .into_iter()
        .enumerate()
        .map(|(index, action)| AccessibilityAction {
            index: index as i32,
            name: action.name,
            description: action.description,
            keybinding: action.keybinding,
        })
        .collect()
}

async fn read_actions(proxy: &ActionProxy<'_>) -> Result<Vec<atspi::Action>> {
    // WebKit can advertise GetActions without replying to it. The indexed
    // methods work, and must also be used when revalidating a cached action.
    // Keep the wire spelling: the current atspi binding asks for "Nactions".
    timeout(ACTION_QUERY_TIMEOUT, async {
        let count = proxy
            .inner()
            .get_property::<i32>("NActions")
            .await
            .context("failed to read AT-SPI action count")?;
        if count > MAX_ACTIONS_PER_OBJECT {
            return Err(anyhow!(
                "AT-SPI action count {count} exceeds the {MAX_ACTIONS_PER_OBJECT}-action read budget"
            ));
        }
        if count < 0 {
            return Err(anyhow!("invalid negative AT-SPI action count {count}"));
        }
        Ok(stream::iter(0..count)
            .map(|index| async move {
                let (name, description, keybinding) = tokio::join!(
                    proxy.get_name(index),
                    proxy.get_description(index),
                    proxy.get_key_binding(index),
                );
                atspi::Action {
                    name: name.unwrap_or_default(),
                    description: description.unwrap_or_default(),
                    keybinding: keybinding.unwrap_or_default(),
                }
            })
            .buffered(CHILD_READ_CONCURRENCY)
            .collect()
            .await)
    })
    .await
    .context("AT-SPI action reads exceeded their 5-second deadline")?
}

async fn states_from_proxy(proxy: &AccessibleProxy<'_>) -> Vec<String> {
    proxy
        .get_state()
        .await
        .map(state_labels)
        .unwrap_or_default()
}

async fn value_from_proxies(
    proxies: Option<&atspi::proxy::proxy_ext::Proxies<'_>>,
) -> Option<AccessibilityValue> {
    let value = proxies?.value().await.ok()?;
    Some(AccessibilityValue {
        current: value.current_value().await.ok()?,
        minimum: value.minimum_value().await.ok()?,
        maximum: value.maximum_value().await.ok()?,
        minimum_increment: value.minimum_increment().await.ok()?,
        text: optional_string(value.text().await.ok()),
    })
}

/// `GetNSelections`. The generated proxy method calls `GetNselections`,
/// which no toolkit implements, so call the method by its real name.
async fn text_selection_count(text: &TextProxy<'_>) -> zbus::Result<i32> {
    text.inner()
        .call_method("GetNSelections", &())
        .await?
        .body()
        .deserialize()
}

async fn text_from_proxies(
    proxies: Option<&atspi::proxy::proxy_ext::Proxies<'_>>,
) -> Option<AccessibilityText> {
    let text = proxies?.text().await.ok()?;
    let character_count = text.character_count().await.ok()?.max(0);
    let caret_offset = text.caret_offset().await.ok();
    let capped_count = character_count.min(MAX_TEXT_READBACK_CHARS);
    let content = if capped_count > 0 {
        optional_string(text.get_text(0, capped_count).await.ok())
    } else {
        None
    };
    let selection_count = text_selection_count(&text)
        .await
        .unwrap_or_default()
        .clamp(0, MAX_TEXT_SELECTIONS);
    let mut selections = Vec::new();
    for index in 0..selection_count {
        if let Ok((start_offset, end_offset)) = text.get_selection(index).await {
            selections.push(AccessibilityTextSelection {
                start_offset,
                end_offset,
            });
        }
    }

    Some(AccessibilityText {
        character_count,
        caret_offset,
        content,
        truncated: character_count > MAX_TEXT_READBACK_CHARS,
        selections,
    })
}

async fn supports_editable_text(proxies: Option<&atspi::proxy::proxy_ext::Proxies<'_>>) -> bool {
    let Some(proxies) = proxies else {
        return false;
    };
    proxies.editable_text().await.is_ok()
}

fn state_labels(state_set: StateSet) -> Vec<String> {
    state_set.iter().map(|state| state.to_string()).collect()
}

fn select_action_index(actions: &[atspi::Action], requested_action: Option<&str>) -> Result<i32> {
    if actions.is_empty() {
        return Err(anyhow!("element exposes no AT-SPI actions"));
    }

    if let Some(requested_action) = requested_action
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let requested_action = requested_action.to_ascii_lowercase();
        if let Some((index, _)) = actions.iter().enumerate().find(|(_, action)| {
            action.name.to_ascii_lowercase() == requested_action
                || action.description.to_ascii_lowercase() == requested_action
        }) {
            return Ok(index as i32);
        }

        if let Ok(index) = requested_action.parse::<usize>() {
            if index < actions.len() {
                return Ok(index as i32);
            }
        }

        return Err(anyhow!(
            "requested AT-SPI action was not found; available actions: {}",
            actions
                .iter()
                .map(|action| action.name.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }

    Ok(if actions.len() > 1 { 1 } else { 0 })
}

fn select_named_action_index(actions: &[atspi::Action], name: &str) -> Result<i32> {
    actions
        .iter()
        .position(|action| action.name.eq_ignore_ascii_case(name))
        .map(|index| index as i32)
        .ok_or_else(|| {
            anyhow!("cached AT-SPI action name is no longer available; refresh get_app_state")
        })
}

fn optional_string(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn object_ref_from_id(object_ref_id: &str) -> Result<ObjectRefOwned> {
    let (name, path) = split_object_ref_id(object_ref_id)?;
    let name = UniqueName::try_from(name.to_string())
        .with_context(|| format!("invalid AT-SPI bus name in object ref {object_ref_id}"))?;
    let path = ObjectPath::try_from(path.to_string())
        .with_context(|| format!("invalid AT-SPI object path in object ref {object_ref_id}"))?;
    Ok(ObjectRef::new_owned(name, path))
}

fn split_object_ref_id(object_ref_id: &str) -> Result<(&str, &str)> {
    let Some(path_start) = object_ref_id.find('/') else {
        return Err(anyhow!(
            "invalid AT-SPI object ref '{object_ref_id}'; expected ':bus/path'"
        ));
    };
    let (name, path) = object_ref_id.split_at(path_start);
    if name.is_empty() || path.is_empty() {
        return Err(anyhow!(
            "invalid AT-SPI object ref '{object_ref_id}'; expected ':bus/path'"
        ));
    }
    Ok((name, path))
}

fn object_ref_id(object_ref: &ObjectRefOwned) -> String {
    format!(
        "{}{}",
        object_ref.name_as_str().unwrap_or(""),
        object_ref.path_as_str()
    )
}

#[cfg(test)]
mod tests {
    use super::insert_fixture::*;
    use super::*;
    use crate::test_sockets::PrivateBus;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    };

    const EDITABLE_FIXTURE_PATH: &str = "/editable";

    #[derive(Default)]
    struct FakeEditableState {
        contents: String,
        mutations: usize,
        character_count_reads: usize,
        get_text_reads: usize,
        numeric_value: f64,
        numeric_writes: usize,
    }

    #[derive(Clone, Copy)]
    enum FakeMutation {
        Apply,
        NoOp,
        Delayed,
        Normalize,
        Mask,
        Reject,
        Fail,
    }

    #[derive(Clone, Copy, Debug)]
    enum FakeTextOffsetModel {
        UnicodeScalars,
        Utf16CodeUnits,
    }

    #[derive(Clone, Copy)]
    enum FakeTextBehavior {
        Normal,
        CharacterCountError,
        GetTextError,
        NegativeCount,
        StallCharacterCount,
    }

    #[derive(Clone, Copy)]
    struct FakeEditableConfig {
        mutation: FakeMutation,
        text: FakeTextBehavior,
        text_offset_model: FakeTextOffsetModel,
        role: atspi::Role,
        has_text: bool,
        has_value: bool,
    }

    impl Default for FakeEditableConfig {
        fn default() -> Self {
            Self {
                mutation: FakeMutation::Apply,
                text: FakeTextBehavior::Normal,
                text_offset_model: FakeTextOffsetModel::Utf16CodeUnits,
                role: atspi::Role::Text,
                has_text: true,
                has_value: false,
            }
        }
    }

    struct FakeEditableAccessible(FakeEditableConfig);

    #[zbus::interface(name = "org.a11y.atspi.Accessible")]
    impl FakeEditableAccessible {
        #[zbus(property)]
        fn child_count(&self) -> i32 {
            0
        }

        fn get_interfaces(&self) -> Vec<&str> {
            let mut interfaces = vec!["org.a11y.atspi.Accessible", "org.a11y.atspi.EditableText"];
            if self.0.has_text {
                interfaces.push("org.a11y.atspi.Text");
            }
            if self.0.has_value {
                interfaces.push("org.a11y.atspi.Value");
            }
            interfaces
        }

        fn get_role(&self) -> atspi::Role {
            self.0.role
        }
    }

    struct FakeEditableText {
        state: Arc<Mutex<FakeEditableState>>,
        mutation: FakeMutation,
    }

    #[zbus::interface(name = "org.a11y.atspi.EditableText")]
    impl FakeEditableText {
        fn set_text_contents(&self, new_contents: &str) -> zbus::fdo::Result<bool> {
            self.state.lock().unwrap().mutations += 1;
            match self.mutation {
                FakeMutation::Apply => {
                    self.state.lock().unwrap().contents = new_contents.to_string();
                }
                FakeMutation::NoOp => {}
                FakeMutation::Delayed => {
                    let state = Arc::clone(&self.state);
                    let new_contents = new_contents.to_string();
                    tokio::spawn(async move {
                        tokio::time::sleep(Duration::from_millis(150)).await;
                        state.lock().unwrap().contents = new_contents;
                    });
                }
                FakeMutation::Normalize => {
                    self.state.lock().unwrap().contents = new_contents.replace("\r\n", "\n");
                }
                FakeMutation::Mask => {
                    self.state.lock().unwrap().contents = "•".repeat(new_contents.chars().count());
                }
                FakeMutation::Reject => return Ok(false),
                FakeMutation::Fail => {
                    return Err(zbus::fdo::Error::Failed(
                        "injected SetTextContents failure".into(),
                    ));
                }
            }
            Ok(true)
        }
    }

    fn unicode_scalar_offset_to_byte_index(contents: &str, offset: usize) -> Option<usize> {
        contents
            .char_indices()
            .map(|(byte_index, _)| byte_index)
            .chain(std::iter::once(contents.len()))
            .nth(offset)
    }

    fn utf16_offset_to_byte_index(contents: &str, offset: usize) -> Option<usize> {
        let mut utf16_offset = 0;
        for (byte_index, character) in contents.char_indices() {
            if utf16_offset == offset {
                return Some(byte_index);
            }
            utf16_offset += character.len_utf16();
        }
        (utf16_offset == offset).then_some(contents.len())
    }

    struct FakeText {
        state: Arc<Mutex<FakeEditableState>>,
        behavior: FakeTextBehavior,
        text_offset_model: FakeTextOffsetModel,
    }

    #[zbus::interface(name = "org.a11y.atspi.Text")]
    impl FakeText {
        #[zbus(property)]
        async fn character_count(&self) -> zbus::fdo::Result<i32> {
            self.state.lock().unwrap().character_count_reads += 1;
            match self.behavior {
                FakeTextBehavior::CharacterCountError => Err(zbus::fdo::Error::Failed(
                    "injected CharacterCount failure".into(),
                )),
                FakeTextBehavior::NegativeCount => Ok(-1),
                FakeTextBehavior::StallCharacterCount => std::future::pending().await,
                _ => {
                    let state = self.state.lock().unwrap();
                    let count = match self.text_offset_model {
                        FakeTextOffsetModel::UnicodeScalars => state.contents.chars().count(),
                        FakeTextOffsetModel::Utf16CodeUnits => {
                            state.contents.encode_utf16().count()
                        }
                    };
                    Ok(count as i32)
                }
            }
        }

        fn get_text(&self, start_offset: i32, end_offset: i32) -> zbus::fdo::Result<String> {
            let mut state = self.state.lock().unwrap();
            state.get_text_reads += 1;
            if matches!(self.behavior, FakeTextBehavior::GetTextError) {
                return Err(zbus::fdo::Error::Failed("injected GetText failure".into()));
            }
            if start_offset < 0 || end_offset < start_offset {
                return Err(zbus::fdo::Error::InvalidArgs("invalid text offsets".into()));
            }
            let offset_to_byte_index = match self.text_offset_model {
                FakeTextOffsetModel::UnicodeScalars => unicode_scalar_offset_to_byte_index,
                FakeTextOffsetModel::Utf16CodeUnits => utf16_offset_to_byte_index,
            };
            let start = offset_to_byte_index(&state.contents, start_offset as usize)
                .ok_or_else(|| zbus::fdo::Error::InvalidArgs("invalid text offsets".into()))?;
            let end = offset_to_byte_index(&state.contents, end_offset as usize)
                .ok_or_else(|| zbus::fdo::Error::InvalidArgs("invalid text offsets".into()))?;
            Ok(state.contents[start..end].to_string())
        }
    }

    struct FakeValue(Arc<Mutex<FakeEditableState>>);

    #[zbus::interface(name = "org.a11y.atspi.Value")]
    impl FakeValue {
        #[zbus(property)]
        fn current_value(&self) -> f64 {
            self.0.lock().unwrap().numeric_value
        }

        #[zbus(property)]
        fn set_current_value(&self, value: f64) {
            let mut state = self.0.lock().unwrap();
            state.numeric_value = value;
            state.numeric_writes += 1;
        }
    }

    async fn start_editable_fixture(
        initial_contents: &str,
        config: FakeEditableConfig,
    ) -> (
        PrivateBus,
        zbus::Connection,
        zbus::Connection,
        Arc<Mutex<FakeEditableState>>,
    ) {
        let bus = PrivateBus::start("cul-atspi-bus");
        let address = bus.address();
        let state = Arc::new(Mutex::new(FakeEditableState {
            contents: initial_contents.to_string(),
            ..Default::default()
        }));
        let mut builder = zbus::connection::Builder::address(address)
            .unwrap()
            .serve_at(EDITABLE_FIXTURE_PATH, FakeEditableAccessible(config))
            .unwrap()
            .serve_at(
                EDITABLE_FIXTURE_PATH,
                FakeEditableText {
                    state: Arc::clone(&state),
                    mutation: config.mutation,
                },
            )
            .unwrap();
        if config.has_text {
            builder = builder
                .serve_at(
                    EDITABLE_FIXTURE_PATH,
                    FakeText {
                        state: Arc::clone(&state),
                        behavior: config.text,
                        text_offset_model: config.text_offset_model,
                    },
                )
                .unwrap();
        }
        if config.has_value {
            builder = builder
                .serve_at(EDITABLE_FIXTURE_PATH, FakeValue(Arc::clone(&state)))
                .unwrap();
        }
        let peer = builder.build().await.unwrap();
        let client = zbus::connection::Builder::address(address)
            .unwrap()
            .build()
            .await
            .unwrap();
        (bus, peer, client, state)
    }

    async fn dispatch_editable_fixture(
        client: &zbus::Connection,
        peer: &zbus::Connection,
        value: &str,
    ) -> Result<ValueSetInvocation> {
        let proxy = AccessibleProxy::builder(client)
            .destination(peer.unique_name().unwrap().clone())
            .unwrap()
            .path(EDITABLE_FIXTURE_PATH)
            .unwrap()
            .cache_properties(zbus::proxy::CacheProperties::No)
            .build()
            .await
            .unwrap();
        let proxies = proxy.proxies().await.unwrap();
        set_element_value_with_proxies(&proxy, &proxies, value).await
    }

    fn editable_outcome(invocation: ValueSetInvocation) -> EditableTextSetOutcome {
        match invocation {
            ValueSetInvocation::EditableText { outcome } => outcome,
            ValueSetInvocation::Numeric { .. } => panic!("expected editable-text dispatch"),
        }
    }

    struct FakeAccessible {
        name: String,
        children: Vec<(String, OwnedObjectPath)>,
        has_action: bool,
    }

    #[zbus::interface(name = "org.a11y.atspi.Accessible")]
    impl FakeAccessible {
        #[zbus(property)]
        fn child_count(&self) -> i32 {
            self.children.len() as i32
        }

        #[zbus(property)]
        fn name(&self) -> &str {
            &self.name
        }

        fn get_interfaces(&self) -> Vec<&str> {
            let mut interfaces = vec!["org.a11y.atspi.Accessible"];
            if self.has_action {
                interfaces.push("org.a11y.atspi.Action");
            }
            interfaces
        }

        fn get_child_at_index(
            &self,
            index: i32,
        ) -> zbus::fdo::Result<((String, OwnedObjectPath),)> {
            self.children
                .get(index as usize)
                .cloned()
                .map(|child| (child,))
                .ok_or_else(|| zbus::fdo::Error::InvalidArgs("invalid child index".into()))
        }
    }

    struct FakeWebKitAction {
        count: i32,
        stall_indexed_reads: bool,
        name_reads: Arc<AtomicUsize>,
    }

    impl Default for FakeWebKitAction {
        fn default() -> Self {
            Self {
                count: 1,
                stall_indexed_reads: false,
                name_reads: Arc::default(),
            }
        }
    }

    #[zbus::interface(name = "org.a11y.atspi.Action")]
    impl FakeWebKitAction {
        async fn get_actions(&self) -> Vec<atspi::Action> {
            std::future::pending().await
        }

        #[zbus(property, name = "NActions")]
        fn nactions(&self) -> i32 {
            self.count
        }

        async fn get_name(&self, index: i32) -> &str {
            assert!((0..self.count).contains(&index));
            self.name_reads.fetch_add(1, Ordering::SeqCst);
            if self.stall_indexed_reads {
                std::future::pending::<()>().await;
            }
            "click"
        }

        async fn get_localized_name(&self, index: i32) -> &str {
            assert!((0..self.count).contains(&index));
            "Activate"
        }

        fn get_description(&self, index: i32) -> &str {
            assert!((0..self.count).contains(&index));
            "Activate the control"
        }

        fn get_key_binding(&self, index: i32) -> &str {
            assert!((0..self.count).contains(&index));
            "Return"
        }

        fn do_action(&self, index: i32) -> bool {
            index == 0
        }
    }

    struct FakeQtAction;

    #[zbus::interface(name = "org.a11y.atspi.Action")]
    impl FakeQtAction {
        #[zbus(property, name = "NActions")]
        fn nactions(&self) -> i32 {
            2
        }

        fn get_name(&self, index: i32) -> &str {
            match index {
                0 => "Press",
                1 => "Set Focus",
                _ => panic!("invalid action index"),
            }
        }

        fn get_description(&self, index: i32) -> &str {
            match index {
                0 => "Eylemi tetikler",
                1 => "Odağı ayarlar",
                _ => panic!("invalid action index"),
            }
        }

        fn get_key_binding(&self, _index: i32) -> &str {
            ""
        }
    }

    #[tokio::test]
    async fn editable_text_true_without_publication_is_mismatch_and_mutates_once() {
        let (_bus, peer, client, state) = start_editable_fixture(
            "original",
            FakeEditableConfig {
                mutation: FakeMutation::NoOp,
                ..Default::default()
            },
        )
        .await;

        let outcome = editable_outcome(
            dispatch_editable_fixture(&client, &peer, "modified")
                .await
                .unwrap(),
        );

        // A last poll can cross the same fixed deadline. Both outcomes mean
        // an unverified write; neither permits verification or replay.
        assert!(
            matches!(
                outcome,
                EditableTextSetOutcome::MismatchAfterDeadline
                    | EditableTextSetOutcome::ReadbackTimedOut
            ),
            "{outcome:?}"
        );
        let state = state.lock().unwrap();
        assert_eq!(state.mutations, 1);
        assert!(state.character_count_reads > 1);
        assert!(state.get_text_reads > 1);
        assert_eq!(state.contents, "original");
    }

    #[tokio::test]
    async fn editable_text_exact_readback_accepts_empty_whitespace_and_trailing_newline() {
        let (_bus, peer, client, state) =
            start_editable_fixture("initial", FakeEditableConfig::default()).await;
        let values = [
            "",
            " \t\n",
            "  leading and trailing\t \n",
            "trailing newline\n",
            "Case and unicode € 内容 😀🦀𐐷",
        ];

        for value in values {
            let outcome = editable_outcome(
                dispatch_editable_fixture(&client, &peer, value)
                    .await
                    .unwrap(),
            );
            assert_eq!(outcome, EditableTextSetOutcome::Verified);
            assert_eq!(state.lock().unwrap().contents, value);
        }
        assert_eq!(state.lock().unwrap().mutations, values.len());
    }

    #[tokio::test]
    async fn editable_text_non_bmp_readback_supports_scalar_and_utf16_peers() {
        let requested = "🦀 GTK verified ";
        for text_offset_model in [
            FakeTextOffsetModel::UnicodeScalars,
            FakeTextOffsetModel::Utf16CodeUnits,
        ] {
            let (_bus, peer, client, state) = start_editable_fixture(
                "",
                FakeEditableConfig {
                    text_offset_model,
                    ..Default::default()
                },
            )
            .await;

            let outcome = editable_outcome(
                dispatch_editable_fixture(&client, &peer, requested)
                    .await
                    .unwrap(),
            );

            assert_eq!(
                outcome,
                EditableTextSetOutcome::Verified,
                "{text_offset_model:?}"
            );
            let state = state.lock().unwrap();
            assert_eq!(state.mutations, 1);
            assert_eq!(state.contents, requested);
        }
    }

    #[tokio::test]
    async fn editable_text_non_bmp_matching_count_does_not_accept_different_content() {
        let requested = "🦀 GTK verified ";
        let published = "🦀 GTK verified!";
        assert_eq!(requested.chars().count(), published.chars().count());
        assert_eq!(
            requested.encode_utf16().count(),
            published.encode_utf16().count()
        );
        for text_offset_model in [
            FakeTextOffsetModel::UnicodeScalars,
            FakeTextOffsetModel::Utf16CodeUnits,
        ] {
            let (_bus, peer, client, state) = start_editable_fixture(
                published,
                FakeEditableConfig {
                    mutation: FakeMutation::NoOp,
                    text_offset_model,
                    ..Default::default()
                },
            )
            .await;

            let outcome = editable_outcome(
                dispatch_editable_fixture(&client, &peer, requested)
                    .await
                    .unwrap(),
            );

            // A last poll can cross the same fixed deadline. Both outcomes
            // leave the write unverified without extending its deadline.
            assert!(
                matches!(
                    outcome,
                    EditableTextSetOutcome::MismatchAfterDeadline
                        | EditableTextSetOutcome::ReadbackTimedOut
                ),
                "{text_offset_model:?}: {outcome:?}"
            );
            let state = state.lock().unwrap();
            assert_eq!(state.mutations, 1);
            assert!(state.get_text_reads > 0, "{text_offset_model:?}");
            assert_eq!(state.contents, published);
        }
    }

    #[tokio::test]
    async fn editable_text_readback_chunks_utf16_without_splitting_non_bmp() {
        let (_bus, peer, client, state) = start_editable_fixture(
            "",
            FakeEditableConfig {
                text_offset_model: FakeTextOffsetModel::Utf16CodeUnits,
                ..Default::default()
            },
        )
        .await;
        let mut expected = "a".repeat(EDITABLE_TEXT_READ_CHUNK_UNITS - 1);
        // The crab's surrogate pair straddles the first 4096-unit read boundary.
        expected.push_str("🦀é");
        expected.push_str(&"内容\n".repeat(1_200));
        assert!(expected.encode_utf16().count() > MAX_TEXT_READBACK_CHARS as usize);

        let outcome = editable_outcome(
            dispatch_editable_fixture(&client, &peer, &expected)
                .await
                .unwrap(),
        );

        assert_eq!(outcome, EditableTextSetOutcome::Verified);
        let state = state.lock().unwrap();
        assert_eq!(state.mutations, 1);
        assert!(state.get_text_reads >= 2);
        assert_eq!(state.contents, expected);
    }

    #[tokio::test]
    async fn editable_text_readback_waits_for_async_publication() {
        let (_bus, peer, client, state) = start_editable_fixture(
            "pending",
            FakeEditableConfig {
                mutation: FakeMutation::Delayed,
                ..Default::default()
            },
        )
        .await;

        let outcome = editable_outcome(
            dispatch_editable_fixture(&client, &peer, "published asynchronously")
                .await
                .unwrap(),
        );

        assert_eq!(outcome, EditableTextSetOutcome::Verified);
        let state = state.lock().unwrap();
        assert_eq!(state.mutations, 1);
        assert!(state.character_count_reads > 1);
        assert_eq!(state.contents, "published asynchronously");
    }

    #[tokio::test]
    async fn editable_text_normalization_mismatch_is_not_verified() {
        let (_bus, peer, client, state) = start_editable_fixture(
            "",
            FakeEditableConfig {
                mutation: FakeMutation::Normalize,
                ..Default::default()
            },
        )
        .await;

        let outcome = editable_outcome(
            dispatch_editable_fixture(&client, &peer, "first\r\nsecond\n")
                .await
                .unwrap(),
        );

        // A last poll can cross the same fixed deadline. Both outcomes mean
        // an unverified write; neither permits verification or replay.
        assert!(
            matches!(
                outcome,
                EditableTextSetOutcome::MismatchAfterDeadline
                    | EditableTextSetOutcome::ReadbackTimedOut
            ),
            "{outcome:?}"
        );
        let state = state.lock().unwrap();
        assert_eq!(state.mutations, 1);
        assert!(state.character_count_reads > 1);
        assert_eq!(state.contents, "first\nsecond\n");
    }

    #[tokio::test]
    async fn password_text_is_unverifiable_even_when_requested_text_is_bullets() {
        let (_bus, peer, client, state) = start_editable_fixture(
            "",
            FakeEditableConfig {
                mutation: FakeMutation::Mask,
                role: atspi::Role::PasswordText,
                ..Default::default()
            },
        )
        .await;

        let outcome = editable_outcome(
            dispatch_editable_fixture(&client, &peer, "••••••••")
                .await
                .unwrap(),
        );

        assert_eq!(outcome, EditableTextSetOutcome::PasswordUnverifiable);
        let state = state.lock().unwrap();
        assert_eq!(state.mutations, 1);
        assert_eq!(state.character_count_reads, 0);
        assert_eq!(state.contents, "••••••••");
    }

    #[tokio::test]
    async fn editable_text_missing_text_and_read_errors_are_structured_outcomes() {
        let configs = [
            FakeEditableConfig {
                has_text: false,
                ..Default::default()
            },
            FakeEditableConfig {
                text: FakeTextBehavior::CharacterCountError,
                ..Default::default()
            },
            FakeEditableConfig {
                text: FakeTextBehavior::GetTextError,
                ..Default::default()
            },
        ];

        for config in configs {
            let (_bus, peer, client, state) = start_editable_fixture("before", config).await;
            let outcome = editable_outcome(
                dispatch_editable_fixture(&client, &peer, "readback may have changed")
                    .await
                    .unwrap(),
            );
            assert_eq!(outcome, EditableTextSetOutcome::ReadbackFailed);
            assert_eq!(state.lock().unwrap().mutations, 1);
        }
    }

    #[tokio::test]
    async fn editable_text_negative_counts_and_stalled_readback_are_structured_outcomes() {
        let cases = [
            (
                FakeTextBehavior::NegativeCount,
                EditableTextSetOutcome::ReadbackFailed,
            ),
            (
                FakeTextBehavior::StallCharacterCount,
                EditableTextSetOutcome::ReadbackTimedOut,
            ),
        ];

        for (text, expected) in cases {
            let (_bus, peer, client, state) = start_editable_fixture(
                "before",
                FakeEditableConfig {
                    text,
                    ..Default::default()
                },
            )
            .await;
            let outcome = editable_outcome(
                dispatch_editable_fixture(&client, &peer, "after")
                    .await
                    .unwrap(),
            );
            assert_eq!(outcome, expected);
            let state = state.lock().unwrap();
            assert_eq!(state.mutations, 1);
            assert_eq!(state.get_text_reads, 0);
        }
    }

    #[tokio::test]
    async fn editable_text_rejection_and_mutation_errors_remain_errors() {
        let cases = [
            (FakeMutation::Reject, "rejected"),
            (FakeMutation::Fail, "failed to set"),
        ];

        for (mutation, expected_error) in cases {
            let (_bus, peer, client, state) = start_editable_fixture(
                "before",
                FakeEditableConfig {
                    mutation,
                    ..Default::default()
                },
            )
            .await;
            let error = dispatch_editable_fixture(&client, &peer, "after")
                .await
                .unwrap_err();
            assert!(error.to_string().contains(expected_error));
            let state = state.lock().unwrap();
            assert_eq!(state.mutations, 1);
            assert_eq!(state.character_count_reads, 0);
        }
    }

    #[tokio::test]
    async fn numeric_value_dispatch_remains_isolated_from_editable_text() {
        let (_bus, peer, client, state) = start_editable_fixture(
            "unchanged",
            FakeEditableConfig {
                has_value: true,
                ..Default::default()
            },
        )
        .await;

        let invocation = dispatch_editable_fixture(&client, &peer, "42.5")
            .await
            .unwrap();

        match invocation {
            ValueSetInvocation::Numeric { value } => assert_eq!(value, 42.5),
            ValueSetInvocation::EditableText { .. } => panic!("expected numeric dispatch"),
        }
        let state = state.lock().unwrap();
        assert_eq!(state.numeric_value, 42.5);
        assert_eq!(state.numeric_writes, 1);
        assert_eq!(state.mutations, 0);
        assert_eq!(state.character_count_reads, 0);
        assert_eq!(state.contents, "unchanged");
    }

    #[tokio::test]
    async fn qt_action_names_do_not_depend_on_localized_names() {
        let bus = PrivateBus::start("cul-atspi-bus");
        let address = bus.address();
        let peer = zbus::connection::Builder::address(address)
            .unwrap()
            .serve_at("/actions/qt", FakeQtAction)
            .unwrap()
            .build()
            .await
            .unwrap();
        let client = zbus::connection::Builder::address(address)
            .unwrap()
            .build()
            .await
            .unwrap();
        let action = ActionProxy::builder(&client)
            .destination(peer.unique_name().unwrap().clone())
            .unwrap()
            .path("/actions/qt")
            .unwrap()
            .cache_properties(zbus::proxy::CacheProperties::No)
            .build()
            .await
            .unwrap();

        let actions = timeout(Duration::from_secs(1), read_actions(&action))
            .await
            .expect("Qt action reads must not require GetLocalizedName")
            .unwrap();

        assert_eq!(actions.len(), 2);
        assert_eq!(actions[0].name, "Press");
        assert_eq!(actions[0].description, "Eylemi tetikler");
        assert_eq!(actions[1].name, "Set Focus");
        assert_eq!(actions[1].description, "Odağı ayarlar");
        assert_eq!(select_named_action_index(&actions, "press").unwrap(), 0);
    }

    #[tokio::test]
    async fn pid_roots_keep_all_toolkits_and_a_missing_pid_stays_empty() {
        let bus = PrivateBus::start("cul-atspi-roots");
        let root_path = "/org/a11y/atspi/accessible/root";
        let mut peers = Vec::new();
        for child_count in [0, 1] {
            let children = (0..child_count)
                .map(|_| (String::new(), "/child".try_into().unwrap()))
                .collect();
            peers.push(
                zbus::connection::Builder::address(bus.address())
                    .unwrap()
                    .serve_at(
                        root_path,
                        FakeAccessible {
                            name: "qt-app".into(),
                            children,
                            has_action: false,
                        },
                    )
                    .unwrap()
                    .build()
                    .await
                    .unwrap(),
            );
        }
        let conn = AccessibilityConnection::from_address(bus.address().parse().unwrap())
            .await
            .unwrap();
        let roots = peers
            .iter()
            .map(|peer| {
                object_ref_from_id(&format!("{}{root_path}", peer.unique_name().unwrap())).unwrap()
            })
            .collect::<Vec<_>>();
        let pid = std::process::id();
        let mut budget = MAX_DISCOVERY_CHILD_READS;
        let selected = select_roots(&conn, roots.clone(), None, Some(pid), None, &mut budget).await;
        assert_eq!(selected.roots, roots);
        assert_eq!(selected.pid, Some(pid));
        assert!(selected.scoped);
        assert!(selected.app_filter_matched);

        let explicit = object_ref_id(&roots[1]);
        let selected = select_roots(
            &conn,
            roots.clone(),
            Some(&explicit),
            Some(pid),
            None,
            &mut budget,
        )
        .await;
        assert_eq!(selected.roots, vec![roots[1].clone()]);
        assert_eq!(selected.pid, Some(pid));
        assert!(selected.app_filter_matched);

        let selected = select_roots(
            &conn,
            roots.clone(),
            None,
            Some(u32::MAX),
            None,
            &mut budget,
        )
        .await;
        assert!(selected.roots.is_empty());
        assert_eq!(selected.pid, None);
        assert!(selected.scoped);
        assert!(!selected.app_filter_matched);

        // A listed window whose pid owns no root (a Flatpak app behind
        // xdg-dbus-proxy) finds the root by name. No pid is recorded.
        let selected = select_roots(
            &conn,
            roots.clone(),
            None,
            Some(u32::MAX),
            Some("qt-app"),
            &mut budget,
        )
        .await;
        assert_eq!(selected.roots, roots);
        assert_eq!(selected.pid, None);
        assert!(selected.scoped);
        assert!(selected.app_filter_matched);

        // The name is a fallback only: the pid's own roots win.
        let selected = select_roots(
            &conn,
            roots.clone(),
            None,
            Some(pid),
            Some("no such window"),
            &mut budget,
        )
        .await;
        assert_eq!(selected.roots, roots);
        assert_eq!(selected.pid, Some(pid));

        let selected = select_roots(
            &conn,
            roots,
            None,
            Some(u32::MAX),
            Some("no such window"),
            &mut budget,
        )
        .await;
        assert!(selected.roots.is_empty());
        assert!(!selected.app_filter_matched);
    }

    #[tokio::test]
    async fn indexed_children_resolve_webkit_names_on_the_accessibility_bus() {
        let bus = PrivateBus::start("cul-atspi-bus");
        let address = bus.address();

        let webkit_name = "org.webkit.MockWebProcess";
        let child_path = "/org/a11y/webkit/accessible/child";
        let webkit = zbus::connection::Builder::address(address)
            .unwrap()
            .name(webkit_name)
            .unwrap()
            .serve_at(
                child_path,
                FakeAccessible {
                    name: "WebKit page".into(),
                    children: Vec::new(),
                    has_action: true,
                },
            )
            .unwrap()
            .serve_at(child_path, FakeWebKitAction::default())
            .unwrap()
            .build()
            .await
            .unwrap();
        let owner = webkit.unique_name().unwrap().to_string();
        let gtk = zbus::connection::Builder::address(address)
            .unwrap()
            .serve_at(
                "/org/a11y/atspi/accessible/root",
                FakeAccessible {
                    name: "GTK socket".into(),
                    has_action: false,
                    children: vec![
                        (webkit_name.into(), child_path.try_into().unwrap()),
                        (owner.clone(), child_path.try_into().unwrap()),
                        (String::new(), "/org/a11y/atspi/null".try_into().unwrap()),
                        (
                            "org.webkit.UnownedWebProcess".into(),
                            child_path.try_into().unwrap(),
                        ),
                    ],
                },
            )
            .unwrap()
            .build()
            .await
            .unwrap();
        let client = zbus::connection::Builder::address(address)
            .unwrap()
            .build()
            .await
            .unwrap();
        let proxy = AccessibleProxy::builder(&client)
            .destination(gtk.unique_name().unwrap().clone())
            .unwrap()
            .path("/org/a11y/atspi/accessible/root")
            .unwrap()
            .build()
            .await
            .unwrap();
        let mut remaining = 4;
        let reply = proxy
            .inner()
            .call_method("GetChildAtIndex", &(0_i32,))
            .await
            .unwrap();
        assert_eq!(reply.body().signature().to_string(), "(so)");
        let batch = children_up_to(&proxy, 4, &mut remaining).await.unwrap();

        assert_eq!(batch.attempted, 4);
        assert_eq!(remaining, 0);
        assert!(!batch.incomplete);
        assert_eq!(batch.items.len(), 3, "only the unowned name should fail");
        assert_eq!(batch.items[0].name_as_str(), Some(owner.as_str()));
        assert_eq!(batch.items[0].path_as_str(), child_path);
        assert_eq!(batch.items[0], batch.items[1]);
        assert!(batch.items[2].is_null());

        // The canonical reference remains usable by the normal read/action path.
        let child = batch.items[0].as_accessible_proxy(&client).await.unwrap();
        assert_eq!(child.name().await.unwrap(), "WebKit page");
        assert_eq!(
            object_ref_from_id(&object_ref_id(&batch.items[0])).unwrap(),
            batch.items[0]
        );
        let action = child.proxies().await.unwrap().action().await.unwrap();
        let actions = timeout(Duration::from_secs(1), read_actions(&action))
            .await
            .expect("indexed action reads must not wait for GetActions")
            .unwrap();
        assert_eq!(actions.len(), 1);
        assert_eq!(actions[0].name, "click");
        assert_eq!(actions[0].description, "Activate the control");
        assert_eq!(actions[0].keybinding, "Return");
        assert_eq!(select_named_action_index(&actions, "click").unwrap(), 0);
        assert!(action.do_action(0).await.unwrap());
    }

    #[tokio::test]
    async fn indexed_actions_bound_untrusted_counts_before_reading_indices() {
        let bus = PrivateBus::start("cul-atspi-bus");
        let address = bus.address();
        let name_reads = Arc::new(AtomicUsize::new(0));
        let counts = [
            -1,
            MAX_ACTIONS_PER_OBJECT + 1,
            i32::MAX,
            0,
            MAX_ACTIONS_PER_OBJECT,
        ];
        let mut builder = zbus::connection::Builder::address(address).unwrap();
        for (index, count) in counts.iter().enumerate() {
            builder = builder
                .serve_at(
                    format!("/actions/{index}"),
                    FakeWebKitAction {
                        count: *count,
                        name_reads: Arc::clone(&name_reads),
                        ..Default::default()
                    },
                )
                .unwrap();
        }
        let peer = builder.build().await.unwrap();
        let client = zbus::connection::Builder::address(address)
            .unwrap()
            .build()
            .await
            .unwrap();

        for (index, count) in counts.iter().enumerate() {
            let action = ActionProxy::builder(&client)
                .destination(peer.unique_name().unwrap().clone())
                .unwrap()
                .path(format!("/actions/{index}"))
                .unwrap()
                .cache_properties(zbus::proxy::CacheProperties::No)
                .build()
                .await
                .unwrap();
            let result = timeout(Duration::from_secs(1), read_actions(&action))
                .await
                .expect("untrusted counts must not cause unbounded work");
            if (0..=MAX_ACTIONS_PER_OBJECT).contains(count) {
                assert_eq!(result.unwrap().len(), *count as usize);
            } else {
                let error = result.unwrap_err().to_string();
                assert!(error.contains("action count"), "{error}");
                assert_eq!(name_reads.load(Ordering::SeqCst), 0);
            }
        }
        assert_eq!(
            name_reads.load(Ordering::SeqCst),
            MAX_ACTIONS_PER_OBJECT as usize
        );
    }

    #[tokio::test]
    async fn indexed_actions_time_out_the_entire_read() {
        let bus = PrivateBus::start("cul-atspi-bus");
        let address = bus.address();
        let name_reads = Arc::new(AtomicUsize::new(0));
        let peer = zbus::connection::Builder::address(address)
            .unwrap()
            .serve_at(
                "/actions/stalled",
                FakeWebKitAction {
                    stall_indexed_reads: true,
                    name_reads: Arc::clone(&name_reads),
                    ..Default::default()
                },
            )
            .unwrap()
            .build()
            .await
            .unwrap();
        let client = zbus::connection::Builder::address(address)
            .unwrap()
            .build()
            .await
            .unwrap();
        let action = ActionProxy::builder(&client)
            .destination(peer.unique_name().unwrap().clone())
            .unwrap()
            .path("/actions/stalled")
            .unwrap()
            .cache_properties(zbus::proxy::CacheProperties::No)
            .build()
            .await
            .unwrap();

        let error = timeout(
            ACTION_QUERY_TIMEOUT + Duration::from_secs(1),
            read_actions(&action),
        )
        .await
        .expect("indexed reads must have an overall deadline")
        .unwrap_err();
        assert!(error.to_string().contains("5-second deadline"));
        assert_eq!(name_reads.load(Ordering::SeqCst), 1);
    }

    fn app_children(children: &[(&str, &str)]) -> Vec<(String, Option<String>)> {
        children
            .iter()
            .map(|(role, name)| (role.to_string(), Some(name.to_string())))
            .collect()
    }

    #[test]
    fn a_window_title_picks_one_of_several_app_windows() {
        let chromium = app_children(&[
            ("frame", "GitHub - Chromium"),
            ("frame", "PlanetScale - Chromium"),
            ("menu", ""),
        ]);
        assert_eq!(
            matching_window(&chromium, "PlanetScale - Chromium"),
            Some(1)
        );
        assert_eq!(
            matching_window(&chromium, "planetscale - chromium"),
            Some(1)
        );
        // A title substring, as a caller passes it.
        assert_eq!(matching_window(&chromium, "PlanetScale"), Some(1));
        // Matches every window: keep them all.
        assert_eq!(matching_window(&chromium, "Chromium"), None);
        assert_eq!(matching_window(&chromium, "Gmail"), None);
    }

    #[test]
    fn a_decorated_compositor_title_picks_the_frame_it_decorates() {
        let chromium = app_children(&[
            ("frame", "GitHub - Chromium"),
            ("frame", "PlanetScale - Chromium"),
        ]);
        assert_eq!(
            matching_window(&chromium, "PlanetScale - Chromium (Profile 1)"),
            Some(1)
        );
        // Both names are decorated prefixes: the longest wins.
        let nested = app_children(&[("frame", "Docs"), ("frame", "Docs - Settings")]);
        assert_eq!(
            matching_window(&nested, "Docs - Settings (Profile 1)"),
            Some(1)
        );
        // A name inside the title but not its prefix is not a decoration.
        let generic = app_children(&[("frame", "Settings"), ("frame", "Mail")]);
        assert_eq!(
            matching_window(&generic, "Docs - Settings (Profile 1)"),
            None
        );
        assert_eq!(matching_window(&generic, "Mailbox"), None);
    }

    #[test]
    fn an_exact_window_name_wins_over_a_substring_match() {
        let windows = app_children(&[("frame", "Docs"), ("frame", "Docs - Settings")]);
        assert_eq!(matching_window(&windows, "Docs"), Some(0));
    }

    #[test]
    fn narrowing_keeps_popups_and_dialogs_beside_the_window() {
        let chromium = app_children(&[
            ("frame", "GitHub - Chromium"),
            ("frame", "PlanetScale - Chromium"),
            ("window", ""),
            ("dialog", "Open File"),
            ("menu", ""),
        ]);
        let chosen = matching_window(&chromium, "PlanetScale").unwrap();
        assert_eq!(
            kept_beside_window(&chromium, chosen),
            [false, true, true, true, true]
        );
    }

    #[test]
    fn one_window_is_never_narrowed() {
        let single = app_children(&[("frame", "PlanetScale - Chromium"), ("menu", "")]);
        assert_eq!(matching_window(&single, "PlanetScale"), None);
    }

    #[test]
    fn split_object_ref_id_separates_bus_name_and_path() {
        let (name, path) = split_object_ref_id(":1.42/org/a11y/atspi/accessible/7").unwrap();

        assert_eq!(name, ":1.42");
        assert_eq!(path, "/org/a11y/atspi/accessible/7");
    }

    #[test]
    fn select_action_index_uses_named_action() {
        let actions = vec![
            atspi::Action {
                name: "click".to_string(),
                description: "Clicks".to_string(),
                keybinding: String::new(),
            },
            atspi::Action {
                name: "show-menu".to_string(),
                description: "Shows menu".to_string(),
                keybinding: String::new(),
            },
        ];

        assert_eq!(select_action_index(&actions, Some("show-menu")).unwrap(), 1);
    }

    #[test]
    fn cached_action_name_is_revalidated_against_current_actions() {
        let mut actions = vec![atspi::Action {
            name: "show-menu".into(),
            description: "Click".into(),
            keybinding: String::new(),
        }];
        // Neither a stale index nor a matching description may invoke another action.
        assert!(select_named_action_index(&actions, "Click").is_err());
        actions.push(atspi::Action {
            name: "click".into(),
            description: String::new(),
            keybinding: String::new(),
        });
        assert_eq!(select_named_action_index(&actions, "Click").unwrap(), 1);
    }

    #[test]
    fn select_action_index_defaults_to_secondary_when_available() {
        let actions = vec![
            atspi::Action {
                name: "click".to_string(),
                description: String::new(),
                keybinding: String::new(),
            },
            atspi::Action {
                name: "show-menu".to_string(),
                description: String::new(),
                keybinding: String::new(),
            },
        ];

        assert_eq!(select_action_index(&actions, None).unwrap(), 1);
    }

    #[test]
    fn state_labels_serialize_in_bit_order() {
        let labels = state_labels(StateSet::new(atspi::State::Focused | atspi::State::Checked));

        assert_eq!(labels, vec!["checked".to_string(), "focused".to_string()]);
    }

    #[test]
    fn default_snapshot_limits_cover_deep_gtk4_trees() {
        // Nautilus 50 places file-list cells below depth 20 and can expose
        // more than 850 raw nodes. Keep the defaults above that known shape.
        assert_eq!(snapshot_limits(None, None), (1_000, 32));
    }

    #[test]
    fn app_name_needle_ignores_blank_values_and_normalizes_the_rest() {
        assert_eq!(app_name_needle(None), None);
        assert_eq!(app_name_needle(Some("")), None);
        assert_eq!(app_name_needle(Some("   ")), None);
        assert_eq!(
            app_name_needle(Some("Calculator")).as_deref(),
            Some("calculator")
        );
        assert_eq!(
            app_name_needle(Some(" :1.64/org/a11y/atspi/accessible/root ")).as_deref(),
            Some(":1.64/org/a11y/atspi/accessible/root")
        );
    }

    #[test]
    fn requested_snapshot_limits_remain_bounded() {
        assert_eq!(snapshot_limits(Some(0), Some(0)), (1, 0));
        assert_eq!(snapshot_limits(Some(100_000), Some(128)), (10_000, 64));
    }

    #[test]
    fn app_discovery_budget_is_independent_of_requested_tree_size() {
        assert_eq!(snapshot_child_read_budgets(1), (256, 2_048, 1));
    }

    #[test]
    fn traversal_attempts_and_queue_share_one_work_budget() {
        let mut traversal = BoundedTraversal::new(4);
        traversal.enqueue([1]);

        assert_eq!(traversal.pop(), Some(1));
        traversal.enqueue(2..=10_000);
        assert_eq!(traversal.queue, VecDeque::from([2, 3, 4]));

        assert_eq!(traversal.pop(), Some(2));
        traversal.enqueue(5..=10_000);
        assert_eq!(traversal.queue, VecDeque::from([3, 4]));
        assert_eq!(traversal.pop(), Some(3));
        assert_eq!(traversal.pop(), Some(4));
        assert_eq!(traversal.pop(), None);
        assert_eq!(traversal.attempted, 4);
        assert!(
            traversal.truncated(),
            "dropped enqueue items must be reported"
        );
    }

    #[test]
    fn traversal_that_drains_within_budget_is_not_truncated() {
        let mut traversal = BoundedTraversal::new(3);
        traversal.enqueue([1, 2, 3]);
        assert_eq!(traversal.pop(), Some(1));
        assert_eq!(traversal.pop(), Some(2));
        assert_eq!(traversal.pop(), Some(3));
        assert_eq!(traversal.pop(), None);
        assert!(
            !traversal.truncated(),
            "exactly max_items real nodes is complete"
        );
    }

    #[test]
    fn enqueue_at_zero_capacity_marks_the_traversal_truncated() {
        let mut traversal = BoundedTraversal::new(2);
        traversal.enqueue([1, 2]);
        assert_eq!(traversal.pop(), Some(1));
        assert_eq!(traversal.pop(), Some(2));
        assert!(!traversal.truncated(), "nothing dropped yet");
        // Capacity is zero; the offered item is dropped, which is the only
        // path that can mark truncation.
        traversal.enqueue([3]);
        assert!(traversal.queue.is_empty());
        assert_eq!(traversal.pop(), None);
        assert!(traversal.truncated());
    }

    #[test]
    fn child_count_is_clamped_before_indexed_reads() {
        assert_eq!(bounded_child_count(-1, 4), 0);
        assert_eq!(bounded_child_count(3, 4), 3);
        assert_eq!(bounded_child_count(i32::MAX, 4), 4);
    }

    #[tokio::test]
    async fn indexed_child_reads_consume_attempts_even_when_one_fails() {
        let calls = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let mut remaining_attempts = 3;
        let batch = fetch_indexed_up_to(100, 10, &mut remaining_attempts, {
            let calls = calls.clone();
            move |index| {
                let calls = calls.clone();
                async move {
                    calls.lock().unwrap().push(index);
                    if index == 1 {
                        Err(())
                    } else {
                        Ok(index)
                    }
                }
            }
        })
        .await;

        assert_eq!(batch.items, vec![0, 2]);
        assert_eq!(batch.attempted, 3);
        assert!(
            batch.incomplete,
            "100 reported children, 3 attempted: budget cut must be reported"
        );
        assert!(!batch.all_failed());
        assert_eq!(*calls.lock().unwrap(), vec![0, 1, 2]);
        assert_eq!(remaining_attempts, 0);

        let no_children = fetch_indexed_up_to(100, 10, &mut remaining_attempts, |_| async {
            Ok::<_, ()>(99)
        })
        .await;
        assert!(no_children.items.is_empty());
        assert_eq!(no_children.attempted, 0);
        assert!(!no_children.all_failed());

        let mut failed_attempts = 2;
        let all_failed =
            fetch_indexed_up_to(2, 2, &mut failed_attempts, |_| async { Err::<i32, _>(()) }).await;
        assert!(all_failed.all_failed());
    }

    fn document() -> FocusedElementSummary {
        FocusedElementSummary {
            role: "document web".into(),
            name: Some("Synthetic editor host".into()),
            editable: false,
            states: vec!["focused".into()],
            is_terminal: false,
        }
    }

    #[test]
    fn focused_document_does_not_end_the_search_before_contenteditable() {
        assert!(focus_is_container(&document()));
        let mut entry = document();
        entry.role = "entry".into();
        entry.states.push("editable".into());
        // Chromium need not implement EditableText for keyboard input.
        assert!(!entry.editable);
        assert!(!focus_is_container(&entry));
    }

    #[test]
    fn incomplete_descendants_do_not_make_the_document_a_definitive_recipient() {
        assert!(matches!(
            finish_focus_probe(true, false, Some(document())),
            FocusProbe::Incomplete
        ));
        assert!(matches!(
            finish_focus_probe(false, false, Some(document())),
            FocusProbe::Found(_)
        ));
    }

    #[test]
    fn opt_in_snapshot_budget_reaches_controls_after_embedded_browser_content() {
        let (limit, _) = snapshot_limits(Some(4_000), None);
        assert_eq!(limit, 4_000);
        let mut traversal = BoundedTraversal::new(limit);
        traversal.enqueue(0..3_000);
        let mut reached_editor = false;
        while let Some(node) = traversal.pop() {
            reached_editor |= node == 2_500;
        }
        assert!(reached_editor);
        assert!(!traversal.truncated());
        let (default, _) = snapshot_limits(None, None);
        assert_eq!(default, 1_000);
    }

    #[test]
    fn narrowing_keeps_the_spent_budget_and_forgets_dropped_work() {
        let mut traversal = BoundedTraversal::new(4);
        traversal.enqueue(0..6);
        assert!(traversal.truncated());
        assert_eq!(traversal.pop(), Some(0));
        traversal.narrow();
        assert!(
            !traversal.truncated(),
            "work dropped outside the subtree no longer counts"
        );
        assert_eq!(traversal.pop(), None);
        traversal.enqueue([10, 11, 12, 13]);
        assert_eq!(traversal.pop(), Some(10));
        assert_eq!(traversal.pop(), Some(11));
        assert_eq!(traversal.pop(), Some(12));
        assert_eq!(
            traversal.pop(),
            None,
            "the budget spent before narrowing still counts"
        );
        assert!(traversal.truncated());
    }

    #[tokio::test]
    async fn text_snapshot_reads_selections_through_get_n_selections() {
        let running = start_field_fixture(FieldFixture {
            contents: "/tmp/old",
            caret: 8,
            selection: Some((5, 8)),
            ..Default::default()
        })
        .await;
        let proxy = open_accessible(&running.conn, &running.fields[0].0)
            .await
            .unwrap();
        let proxies = proxy.proxies().await.unwrap();
        let text = text_from_proxies(Some(&proxies)).await.unwrap();
        assert_eq!(text.content.as_deref(), Some("/tmp/old"));
        assert_eq!(text.selections.len(), 1);
        assert_eq!(
            (
                text.selections[0].start_offset,
                text.selections[0].end_offset
            ),
            (5, 8)
        );
    }

    fn verified(replaced_selection: bool) -> FocusedTextInsert {
        FocusedTextInsert::Verified {
            role: "text".to_string(),
            replaced_selection,
            caret_after_text: true,
        }
    }

    #[tokio::test]
    async fn focused_field_insert_lands_at_the_caret_and_reads_back() {
        let (outcome, state) = insert_into_fixture(
            FieldFixture {
                contents: "/home/",
                caret: 6,
                ..Default::default()
            },
            "x/doc",
        )
        .await;
        assert_eq!(outcome.unwrap(), verified(false));
        assert_eq!(state.contents, "/home/x/doc");
        assert_eq!(state.calls, ["insert", "caret"]);
        assert_eq!(state.caret, 11, "the caret ends after the text");

        let (outcome, state) = insert_into_fixture(
            FieldFixture {
                contents: "ab",
                caret: 1,
                ..Default::default()
            },
            "שלום",
        )
        .await;
        assert_eq!(outcome.unwrap(), verified(false));
        assert_eq!(state.contents, "aשלוםb");
        assert_eq!(state.caret, 5);
        assert_eq!(state.calls, ["insert", "caret"]);

        // A partial edit never rewrites the field, so embedded objects stay.
        let (outcome, state) = insert_into_fixture(
            FieldFixture {
                contents: "\u{fffc}\u{fffc}",
                caret: 1,
                ..Default::default()
            },
            "שלום",
        )
        .await;
        assert_eq!(outcome.unwrap(), verified(false));
        assert_eq!(state.contents, "\u{fffc}שלום\u{fffc}");
        assert_eq!(state.calls, ["insert", "caret"]);
    }

    #[tokio::test]
    async fn focused_field_insert_is_exact_under_qt_length_rules() {
        for (text, selection, expected) in [
            ("x/doc", None, "/home/x/doc"),
            ("שלום", None, "/home/שלום"),
            ("שלום", Some((1, 5)), "/שלום/"),
        ] {
            let (outcome, state) = insert_into_fixture(
                FieldFixture {
                    contents: "/home/",
                    caret: 6,
                    selection,
                    edit: FieldEdit::QtLength,
                    toolkit: Some("Qt"),
                    ..Default::default()
                },
                text,
            )
            .await;
            assert_eq!(outcome.unwrap(), verified(selection.is_some()), "{text}");
            assert_eq!(state.contents, expected);
        }
    }

    #[tokio::test]
    async fn focused_field_insert_needs_the_toolkit_for_non_ascii_text() {
        let (outcome, state) = insert_into_fixture(
            FieldFixture {
                contents: "/home/",
                caret: 6,
                toolkit: None,
                ..Default::default()
            },
            "שלום",
        )
        .await;
        assert!(
            matches!(&outcome, Ok(FocusedTextInsert::NotEditable(reason)) if reason.contains("toolkit")),
            "{outcome:?}"
        );
        assert_eq!(state.contents, "/home/");
        assert!(state.calls.is_empty(), "{:?}", state.calls);

        // ASCII text has one length in every unit.
        let (outcome, state) = insert_into_fixture(
            FieldFixture {
                contents: "/home/",
                caret: 6,
                toolkit: None,
                ..Default::default()
            },
            "x",
        )
        .await;
        assert_eq!(outcome.unwrap(), verified(false));
        assert_eq!(state.contents, "/home/x");
    }

    #[tokio::test]
    async fn focused_field_insert_replaces_the_selection() {
        let (outcome, state) = insert_into_fixture(
            FieldFixture {
                contents: "/tmp/old/x",
                caret: 8,
                selection: Some((8, 5)),
                ..Default::default()
            },
            "new",
        )
        .await;
        assert_eq!(outcome.unwrap(), verified(true));
        assert_eq!(state.contents, "/tmp/new/x");
        assert_eq!(state.calls, ["delete", "insert", "caret"]);

        // An empty or fully selected field gets its contents set, as set_value does.
        for (contents, selection) in [("", None), ("/old/path", Some((0, 9)))] {
            let (outcome, state) = insert_into_fixture(
                FieldFixture {
                    contents,
                    caret: contents.chars().count() as i32,
                    selection,
                    ..Default::default()
                },
                "/home/x",
            )
            .await;
            assert_eq!(outcome.unwrap(), verified(selection.is_some()));
            assert_eq!(state.contents, "/home/x");
            assert_eq!(state.calls, ["set", "caret"]);
            assert_eq!(state.caret, 7);
        }
    }

    #[tokio::test]
    async fn focused_field_insert_needs_a_focused_editable_field() {
        let unfocused = StateSet::new(atspi::State::Editable | atspi::State::Showing);
        let read_only = StateSet::new(atspi::State::Focused | atspi::State::Showing);
        for states in [unfocused, read_only] {
            let (outcome, state) = insert_into_fixture(
                FieldFixture {
                    contents: "keep",
                    caret: 4,
                    states,
                    ..Default::default()
                },
                "x",
            )
            .await;
            assert!(
                matches!(outcome.unwrap(), FocusedTextInsert::NotEditable(_)),
                "{states:?}"
            );
            assert_eq!(state.contents, "keep");
            assert!(state.calls.is_empty(), "{:?}", state.calls);
        }
    }

    fn entry(contents: &'static str, focused: bool) -> FieldFixture {
        let mut states = StateSet::new(atspi::State::Editable | atspi::State::Showing);
        if focused {
            states.insert(atspi::State::Focused);
        }
        FieldFixture {
            contents,
            caret: contents.chars().count() as i32,
            states,
            ..Default::default()
        }
    }

    /// Chromium puts every window under one app root, and AT-SPI focus can
    /// lag behind the compositor: a field still marked focused in another
    /// window is not the target.
    #[tokio::test]
    async fn focused_field_insert_stays_in_the_target_window() {
        let stale_and_target = |target_focused, target_active| {
            vec![
                FixtureWindow {
                    name: "Inbox",
                    active: false,
                    field: entry("stale", true),
                },
                FixtureWindow {
                    name: "Compose",
                    active: target_active,
                    field: entry("to: ", target_focused),
                },
            ]
        };
        let running = start_windows_fixture(stale_and_target(true, true)).await;
        let outcome =
            insert_text_at_focus_on(&running.conn, std::process::id(), Some("Compose"), "x").await;
        assert_eq!(outcome.unwrap(), verified(false));
        assert_eq!(running.take_state(0).contents, "stale");
        assert_eq!(running.take_state(1).contents, "to: x");

        for (target_focused, target_active, title, why) in [
            (false, true, Some("Compose"), "has keyboard focus"),
            (true, false, Some("Compose"), "not active"),
            (true, true, Some("Drafts"), "could not be matched"),
            (true, true, None, "could not be matched"),
        ] {
            let running =
                start_windows_fixture(stale_and_target(target_focused, target_active)).await;
            let outcome =
                insert_text_at_focus_on(&running.conn, std::process::id(), title, "x").await;
            assert!(
                matches!(&outcome, Ok(FocusedTextInsert::NotEditable(reason)) if reason.contains(why)),
                "{title:?} focused={target_focused} active={target_active}: {outcome:?}"
            );
            for index in 0..2 {
                let state = running.take_state(index);
                assert!(state.calls.is_empty(), "{:?}", state.calls);
            }
        }
    }

    #[tokio::test]
    async fn focused_field_insert_checks_the_untouched_text() {
        // Inserting "y" at 1 gives "xyyx"; appending gives "xyxy", which has
        // "y" at 1 and the right length too.
        let (outcome, state) = insert_into_fixture(
            FieldFixture {
                contents: "xyx",
                caret: 1,
                edit: FieldEdit::AppendAtEnd,
                ..Default::default()
            },
            "y",
        )
        .await;
        assert!(
            matches!(outcome, Ok(FocusedTextInsert::Mismatch { .. })),
            "{outcome:?}"
        );
        assert_eq!(state.contents, "xyxy");
    }

    #[tokio::test]
    async fn focused_field_insert_bounds_each_edit_call() {
        let (outcome, state) = timeout(
            ACTION_QUERY_TIMEOUT + Duration::from_secs(3),
            insert_into_fixture(
                FieldFixture {
                    contents: "/home/",
                    caret: 6,
                    edit: FieldEdit::StallInsert,
                    ..Default::default()
                },
                "x",
            ),
        )
        .await
        .expect("a stalled InsertText must not hold the call");
        assert!(
            matches!(
                &outcome,
                Ok(FocusedTextInsert::EditFailed { reason, may_have_changed: true })
                    if reason.contains("did not answer")
            ),
            "{outcome:?}"
        );
        assert_eq!(state.contents, "/home/");
    }

    #[tokio::test]
    async fn focused_field_insert_skips_password_fields() {
        let (outcome, state) = insert_into_fixture(
            FieldFixture {
                role: atspi::Role::PasswordText,
                role_name: "password text",
                ..Default::default()
            },
            "hunter2",
        )
        .await;
        assert_eq!(outcome.unwrap(), FocusedTextInsert::PasswordField);
        assert_eq!(state.contents, "");
        assert!(state.calls.is_empty(), "{:?}", state.calls);
    }

    #[tokio::test]
    async fn focused_field_insert_reports_a_readback_mismatch() {
        let (outcome, state) = insert_into_fixture(
            FieldFixture {
                contents: "/home/",
                caret: 6,
                edit: FieldEdit::DropLastChar,
                ..Default::default()
            },
            "xyz",
        )
        .await;
        assert_eq!(
            outcome.unwrap(),
            FocusedTextInsert::Mismatch {
                expected_count: 9,
                read_count: 8,
                read_text: "xy".to_string(),
                read_truncated: false,
            }
        );
        assert_eq!(state.contents, "/home/xy");
        assert!(!state.calls.contains(&"caret"), "{:?}", state.calls);
    }
}

/// Private-bus AT-SPI fixture for the type_text insert route: a registry, one
/// app owned by this process, its windows, and one text field in each.
#[cfg(test)]
pub(crate) mod insert_fixture {
    use super::*;
    use crate::test_sockets::PrivateBus;
    use std::sync::{Arc, Mutex};

    const FOCUS_ROOT_PATH: &str = "/org/a11y/atspi/accessible/root";

    #[derive(Default)]
    pub(crate) struct FieldState {
        pub(crate) contents: String,
        pub(crate) caret: i32,
        pub(crate) selection: Option<(i32, i32)>,
        pub(crate) calls: Vec<&'static str>,
    }

    #[derive(Clone, Copy, PartialEq)]
    pub(crate) enum FieldEdit {
        Apply,
        /// Qt's bridge: InsertText resizes the text to `length` UTF-16 code
        /// units, padding with NUL.
        QtLength,
        /// The app keeps all but the last inserted character.
        DropLastChar,
        /// The app appends inserted text at the end, ignoring the position.
        AppendAtEnd,
        /// InsertText never answers.
        StallInsert,
    }

    struct FocusNode {
        name: &'static str,
        role: atspi::Role,
        role_name: &'static str,
        states: StateSet,
        children: Vec<(String, OwnedObjectPath)>,
        text_field: bool,
    }

    #[zbus::interface(name = "org.a11y.atspi.Accessible")]
    impl FocusNode {
        #[zbus(property)]
        fn child_count(&self) -> i32 {
            self.children.len() as i32
        }

        #[zbus(property)]
        fn name(&self) -> &str {
            self.name
        }

        fn get_role(&self) -> atspi::Role {
            self.role
        }

        fn get_role_name(&self) -> &str {
            self.role_name
        }

        fn get_state(&self) -> StateSet {
            self.states
        }

        fn get_interfaces(&self) -> Vec<&str> {
            let mut interfaces = vec!["org.a11y.atspi.Accessible"];
            if self.text_field {
                interfaces.extend(["org.a11y.atspi.EditableText", "org.a11y.atspi.Text"]);
            }
            interfaces
        }

        fn get_child_at_index(
            &self,
            index: i32,
        ) -> zbus::fdo::Result<((String, OwnedObjectPath),)> {
            self.children
                .get(index as usize)
                .cloned()
                .map(|child| (child,))
                .ok_or_else(|| zbus::fdo::Error::InvalidArgs("invalid child index".into()))
        }
    }

    fn char_byte(contents: &str, offset: i32) -> zbus::fdo::Result<usize> {
        if offset < 0 {
            return Err(zbus::fdo::Error::InvalidArgs("invalid text offset".into()));
        }
        contents
            .char_indices()
            .map(|(byte_index, _)| byte_index)
            .chain(std::iter::once(contents.len()))
            .nth(offset as usize)
            .ok_or_else(|| zbus::fdo::Error::InvalidArgs("invalid text offset".into()))
    }

    struct FieldText(Arc<Mutex<FieldState>>);

    #[zbus::interface(name = "org.a11y.atspi.Text")]
    impl FieldText {
        #[zbus(property)]
        fn character_count(&self) -> i32 {
            self.0.lock().unwrap().contents.chars().count() as i32
        }

        #[zbus(property)]
        fn caret_offset(&self) -> i32 {
            self.0.lock().unwrap().caret
        }

        #[zbus(name = "GetNSelections")]
        fn get_n_selections(&self) -> i32 {
            i32::from(self.0.lock().unwrap().selection.is_some())
        }

        fn get_selection(&self, index: i32) -> zbus::fdo::Result<(i32, i32)> {
            let state = self.0.lock().unwrap();
            state
                .selection
                .filter(|_| index == 0)
                .ok_or_else(|| zbus::fdo::Error::InvalidArgs("no such selection".into()))
        }

        fn get_text(&self, start_offset: i32, end_offset: i32) -> zbus::fdo::Result<String> {
            let state = self.0.lock().unwrap();
            let start = char_byte(&state.contents, start_offset)?;
            let end = char_byte(&state.contents, end_offset)?;
            if end < start {
                return Err(zbus::fdo::Error::InvalidArgs("invalid text offsets".into()));
            }
            Ok(state.contents[start..end].to_string())
        }

        fn set_caret_offset(&self, offset: i32) -> bool {
            let mut state = self.0.lock().unwrap();
            state.calls.push("caret");
            state.caret = offset;
            true
        }
    }

    struct FixtureApplication(&'static str);

    #[zbus::interface(name = "org.a11y.atspi.Application")]
    impl FixtureApplication {
        #[zbus(property)]
        fn toolkit_name(&self) -> &str {
            self.0
        }
    }

    struct FieldEditable {
        state: Arc<Mutex<FieldState>>,
        edit: FieldEdit,
    }

    impl FieldEditable {
        fn apply(&self, text: &str) -> String {
            let mut text = text.to_string();
            if self.edit == FieldEdit::DropLastChar {
                text.pop();
            }
            text
        }
    }

    #[zbus::interface(name = "org.a11y.atspi.EditableText")]
    impl FieldEditable {
        async fn insert_text(
            &self,
            position: i32,
            text: &str,
            length: i32,
        ) -> zbus::fdo::Result<bool> {
            if self.edit == FieldEdit::StallInsert {
                std::future::pending::<()>().await;
            }
            let text = if self.edit == FieldEdit::QtLength {
                let mut units = text.encode_utf16().collect::<Vec<_>>();
                units.resize(length.max(0) as usize, 0);
                String::from_utf16_lossy(&units)
            } else {
                // Bytes, as the AT-SPI documentation and GTK count them.
                let take = (length.max(0) as usize).min(text.len());
                self.apply(text.get(..take).unwrap_or(text))
            };
            let mut state = self.state.lock().unwrap();
            state.calls.push("insert");
            let at = if self.edit == FieldEdit::AppendAtEnd {
                state.contents.len()
            } else {
                char_byte(&state.contents, position)?
            };
            state.contents.insert_str(at, &text);
            // Like a GTK entry, an insert does not move the caret.
            state.selection = None;
            Ok(true)
        }

        fn delete_text(&self, start_pos: i32, end_pos: i32) -> zbus::fdo::Result<bool> {
            let mut state = self.state.lock().unwrap();
            state.calls.push("delete");
            let start = char_byte(&state.contents, start_pos)?;
            let end = char_byte(&state.contents, end_pos)?;
            state.contents.replace_range(start..end, "");
            state.caret = start_pos;
            state.selection = None;
            Ok(true)
        }

        fn set_text_contents(&self, new_contents: &str) -> bool {
            let text = self.apply(new_contents);
            let mut state = self.state.lock().unwrap();
            state.calls.push("set");
            state.contents = text;
            state.caret = 0;
            state.selection = None;
            true
        }
    }

    pub(crate) struct FieldFixture {
        pub(crate) role: atspi::Role,
        pub(crate) role_name: &'static str,
        pub(crate) states: StateSet,
        pub(crate) contents: &'static str,
        pub(crate) caret: i32,
        pub(crate) selection: Option<(i32, i32)>,
        pub(crate) edit: FieldEdit,
        /// The app root's ToolkitName; `None` serves no Application interface.
        /// The first window's field sets it.
        pub(crate) toolkit: Option<&'static str>,
    }

    impl Default for FieldFixture {
        fn default() -> Self {
            Self {
                role: atspi::Role::Text,
                role_name: "text",
                states: StateSet::new(
                    atspi::State::Focused
                        | atspi::State::Focusable
                        | atspi::State::Editable
                        | atspi::State::Showing,
                ),
                contents: "",
                caret: 0,
                selection: None,
                edit: FieldEdit::Apply,
                toolkit: Some("GTK"),
            }
        }
    }

    pub(crate) struct FixtureWindow {
        pub(crate) name: &'static str,
        pub(crate) active: bool,
        pub(crate) field: FieldFixture,
    }

    pub(crate) struct RunningFields {
        // Dropped last: the bus outlives the peers.
        _peers: [zbus::Connection; 2],
        pub(crate) conn: AccessibilityConnection,
        pub(crate) fields: Vec<(ObjectRefOwned, Arc<Mutex<FieldState>>)>,
        _bus: PrivateBus,
    }

    impl RunningFields {
        pub(crate) fn take_state(&self, index: usize) -> FieldState {
            std::mem::take(&mut *self.fields[index].1.lock().unwrap())
        }
    }

    pub(crate) const FIXTURE_WINDOW: &str = "Files";

    pub(crate) async fn start_windows_fixture(windows: Vec<FixtureWindow>) -> RunningFields {
        let bus = PrivateBus::start("cul-atspi-insert");
        let app = zbus::connection::Builder::address(bus.address())
            .unwrap()
            .build()
            .await
            .unwrap();
        let app_name = app.unique_name().unwrap().to_string();
        let toolkit = windows.first().and_then(|window| window.field.toolkit);
        let path = |kind: &str, index: usize| -> OwnedObjectPath {
            format!("/{kind}{index}").try_into().unwrap()
        };
        app.object_server()
            .at(
                FOCUS_ROOT_PATH,
                FocusNode {
                    name: "fixture-app",
                    role: atspi::Role::Application,
                    role_name: "application",
                    states: StateSet::empty(),
                    children: (0..windows.len())
                        .map(|index| (app_name.clone(), path("frame", index)))
                        .collect(),
                    text_field: false,
                },
            )
            .await
            .unwrap();
        if let Some(toolkit) = toolkit {
            app.object_server()
                .at(FOCUS_ROOT_PATH, FixtureApplication(toolkit))
                .await
                .unwrap();
        }
        let mut fields = Vec::new();
        for (index, window) in windows.into_iter().enumerate() {
            let mut frame_states = StateSet::new(atspi::State::Showing);
            if window.active {
                frame_states.insert(atspi::State::Active);
            }
            app.object_server()
                .at(
                    path("frame", index),
                    FocusNode {
                        name: window.name,
                        role: atspi::Role::Frame,
                        role_name: "frame",
                        states: frame_states,
                        children: vec![(app_name.clone(), path("field", index))],
                        text_field: false,
                    },
                )
                .await
                .unwrap();
            let fixture = window.field;
            let state = Arc::new(Mutex::new(FieldState {
                contents: fixture.contents.to_string(),
                caret: fixture.caret,
                selection: fixture.selection,
                calls: Vec::new(),
            }));
            let field_path = path("field", index);
            app.object_server()
                .at(
                    field_path.clone(),
                    FocusNode {
                        name: "Location",
                        role: fixture.role,
                        role_name: fixture.role_name,
                        states: fixture.states,
                        children: Vec::new(),
                        text_field: true,
                    },
                )
                .await
                .unwrap();
            app.object_server()
                .at(field_path.clone(), FieldText(Arc::clone(&state)))
                .await
                .unwrap();
            app.object_server()
                .at(
                    field_path.clone(),
                    FieldEditable {
                        state: Arc::clone(&state),
                        edit: fixture.edit,
                    },
                )
                .await
                .unwrap();
            let field = object_ref_from_id(&format!("{app_name}{}", field_path.as_str())).unwrap();
            fields.push((field, state));
        }
        let registry = zbus::connection::Builder::address(bus.address())
            .unwrap()
            .name("org.a11y.atspi.Registry")
            .unwrap()
            .serve_at(
                FOCUS_ROOT_PATH,
                FocusNode {
                    name: "main",
                    role: atspi::Role::DesktopFrame,
                    role_name: "desktop frame",
                    states: StateSet::empty(),
                    children: vec![(app_name, FOCUS_ROOT_PATH.try_into().unwrap())],
                    text_field: false,
                },
            )
            .unwrap()
            .build()
            .await
            .unwrap();
        let conn = AccessibilityConnection::from_address(bus.address().parse().unwrap())
            .await
            .unwrap();
        RunningFields {
            _peers: [app, registry],
            conn,
            fields,
            _bus: bus,
        }
    }

    /// One active window, [`FIXTURE_WINDOW`], holding `field`.
    pub(crate) async fn start_field_fixture(field: FieldFixture) -> RunningFields {
        start_windows_fixture(vec![FixtureWindow {
            name: FIXTURE_WINDOW,
            active: true,
            field,
        }])
        .await
    }

    /// Insert into a fresh one-window fixture. Returns the outcome and the
    /// field's state afterwards.
    pub(crate) async fn insert_into_fixture(
        field: FieldFixture,
        text: &str,
    ) -> (Result<FocusedTextInsert>, FieldState) {
        let running = start_field_fixture(field).await;
        let outcome = insert_text_at_focus_on(
            &running.conn,
            std::process::id(),
            Some(FIXTURE_WINDOW),
            text,
        )
        .await;
        (outcome, running.take_state(0))
    }
}
