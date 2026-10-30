use crate::atspi_tree::{
    accessibility_chrome_context, focused_element_summary_in_app, list_accessible_apps,
    object_ref_owner_pid, perform_action as invoke_accessibility_action, perform_named_action,
    probe_focused_element, set_element_value, snapshot_accessibility_tree, AccessibilityAction,
    AccessibilityNode, AccessibleAppSummary, Bounds, EditableTextSetOutcome, FocusProbe,
    FocusedElementSummary, ValueSetInvocation,
};
use crate::diagnostics::{
    doctor_report, setup_accessibility_report, DoctorReport, ReadinessReport, SetupReport,
    WindowingReport,
};
use crate::diagnostics_cache::DiagnosticsCache;
use crate::gnome_extension::{setup_window_targeting_report, WindowTargetingSetupReport};
use crate::remote_desktop::{
    click as portal_click, drag as portal_drag, keysyms_for_text, press_key_chord,
    press_keycode_chord, scroll as portal_scroll, start_portal_keyboard_session,
    start_portal_pointer_session, type_text_with_keysyms, InputOperationGuard, PointerButton,
    PortalKey, PortalKeyboardSession, PortalPointerSession, ScrollDirection,
};
use crate::screenshot::{
    capture_screenshot_raw, prepare_screenshot_payload, RawScreenshotCapture, ScreenshotCapture,
    ScreenshotOutputFormat, ScreenshotPayloadOptions,
};
use crate::terminal::{terminal_paste_shortcut, TerminalPasteShortcut};
use crate::windowing::backends::kwin::{
    KwinElementClickPoint, KwinElementClickTarget, KwinElementFrame,
};
use crate::windowing::registry;
use crate::windows::{
    focus_window_target, focused_window, focused_window_with_backend, list_windows,
    resolve_window_target, window_permission_hint, WindowFocusResult, WindowInfo, WindowTarget,
    GNOME_SHELL_EXTENSION_BACKEND, GNOME_SHELL_INTROSPECT_BACKEND, KWIN_BACKEND,
    UNAVAILABLE_BACKEND,
};
use crate::ydotool;
use anyhow::{Context, Result};
use rmcp::{
    handler::server::wrapper::{Json, Parameters},
    model::{CallToolResult, ContentBlock},
    schemars::JsonSchema,
    tool, tool_handler, tool_router, ErrorData, ServerHandler, ServiceExt,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    env,
    ffi::OsString,
    fs,
    future::Future,
    os::unix::{
        ffi::OsStrExt,
        fs::{FileTypeExt, MetadataExt, PermissionsExt},
    },
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::AsyncWriteExt,
    net::UnixStream as TokioUnixStream,
    process::Command as TokioCommand,
    time::{sleep, timeout},
};
use xkeysym::key as xkey;
use zbus::{Connection as ZbusConnection, Proxy as ZbusProxy};

const INPUT_COMMAND_TIMEOUT: Duration = Duration::from_secs(10);
// Linux limits each exec argument (including its NUL) to 32 pages, at least
// 128 KiB on supported platforms. Reject oversized text before sending input.
const WTYPE_MAX_TEXT_BYTES: usize = 128 * 1024 - 1;
const WTYPE_STDIN_MAX_CHARS: usize = 100;
const WTYPE_FOCUS_TIMEOUT: Duration = Duration::from_millis(1500);
const MAX_SCROLL_PAGES: f64 = 100.0;
const YDOTOOL_TYPE_CHARS_PER_SECOND: u64 = 20;
const KDE_CLIPBOARD_DBUS_TIMEOUT: Duration = Duration::from_secs(3);
const KDE_KLIPPER_SERVICE: &str = "org.kde.klipper";
const KDE_KLIPPER_PATH: &str = "/klipper";
const KDE_KLIPPER_INTERFACE: &str = "org.kde.klipper.klipper";
const AVATAR_CURSOR_SOCKET_NAME: &str = "computer-use-cursor.sock";
const AVATAR_CURSOR_SOCKET_MAX_BYTES: usize = 100;
const AVATAR_CURSOR_NOTIFY_TIMEOUT: Duration = Duration::from_millis(100);
const SHELL_ENABLE_ENV: &str = "CODEX_COMPUTER_USE_ENABLE_SHELL";
const SHELL_ENABLE_ENV_STANDALONE: &str = "COMPUTER_USE_LINUX_ENABLE_SHELL";
const COMPLETION_ENABLE_ENV: &str = "CODEX_COMPUTER_USE_NOTIFY_ON_COMPLETE";
const COMPLETION_ENABLE_ENV_STANDALONE: &str = "COMPUTER_USE_LINUX_NOTIFY_ON_COMPLETE";
const SHELL_DEFAULT_TIMEOUT_SECS: u64 = 30;
const SHELL_MAX_TIMEOUT_SECS: u64 = 120;
const SHELL_MAX_COMMAND_BYTES: usize = 64 * 1024;
const SHELL_MAX_CWD_BYTES: usize = 4096;
const SHELL_MAX_ENV_ENTRIES: usize = 64;
const SHELL_MAX_ENV_BYTES: usize = 64 * 1024;
const SHELL_RESPONSE_STREAM_BYTES: usize = 512 * 1024;
const UNMATCHABLE_ACCESSIBILITY_APP_FILTER: &str = "\0";

/// Nodes, their app/window ownership, and their recovery scope must come from
/// the same snapshot.
#[derive(Default)]
struct CachedAccessibilitySnapshot {
    nodes: Vec<AccessibilityNode>,
    pid: Option<u32>,
    window_id: Option<u64>,
    window_backend: Option<String>,
    recovery_scope: Option<AccessibilityRecoveryScope>,
}

#[derive(Clone)]
struct AccessibilityRecoveryScope {
    params: GetAppStateParams,
    target_pid: Option<u32>,
}

struct RefreshedAccessibilitySnapshot {
    snapshot: crate::atspi_tree::AccessibilitySnapshot,
    target_pid: Option<u32>,
    window: Option<WindowInfo>,
}

#[derive(Clone, Default)]
pub struct ComputerUseLinux {
    last_snapshot: Arc<Mutex<CachedAccessibilitySnapshot>>,
    portal_pointer_session: Arc<Mutex<Option<PortalPointerSession>>>,
    portal_keyboard_session: Arc<Mutex<Option<PortalKeyboardSession>>>,
    /// Lazily-created uinput absolute pointer (preferred coordinate backend).
    abs_pointer: Arc<Mutex<Option<crate::abs_pointer::AbsPointer>>>,
    portal_session_init_lock: Arc<tokio::sync::Mutex<()>>,
    input_operation_lock: Arc<tokio::sync::Mutex<()>>,
    kde_clipboard_lock: Arc<tokio::sync::Mutex<()>>,
    /// Cached physical desktop size from the most recent full-frame capture;
    /// used for off-screen warnings and portal logical-coordinate mapping.
    desktop_size: Arc<Mutex<Option<(u32, u32)>>>,
    /// On-screen activity overlay (opt-out via `COMPUTER_USE_LINUX_INDICATOR=0`).
    indicator: Arc<crate::indicator::Indicator>,
    /// Private files for trees too large to return inline; removed on exit.
    tree_spiller: Arc<crate::tree_spill::TreeSpiller>,
    /// Diagnostics behind get_app_state's readiness block. Failed observations,
    /// failed actions, and setup tools invalidate it; the doctor tool bypasses
    /// it.
    diagnostics: Arc<DiagnosticsCache<DoctorReport>>,
    accessibility_check: AccessibilityCheck,
}

/// The live check get_app_state compares a cached report's
/// `can_build_accessibility_tree` against. Tests swap it to agree with their
/// fixture report instead of reading the desktop running them.
#[derive(Clone, Copy)]
struct AccessibilityCheck(fn() -> bool);

impl Default for AccessibilityCheck {
    fn default() -> Self {
        Self(crate::diagnostics::can_build_accessibility_tree_now)
    }
}

fn sanitize_unsigned_integer_formats(value: &mut serde_json::Value) {
    let serde_json::Value::Object(object) = value else {
        return;
    };

    let has_unsigned_format = matches!(
        object.get("format").and_then(serde_json::Value::as_str),
        Some("uint" | "uint8" | "uint16" | "uint32" | "uint64" | "usize")
    );
    if has_unsigned_format {
        object.remove("format");
    }

    for nested in object.values_mut() {
        match nested {
            serde_json::Value::Object(_) => sanitize_unsigned_integer_formats(nested),
            serde_json::Value::Array(items) => {
                for item in items {
                    sanitize_unsigned_integer_formats(item);
                }
            }
            _ => {}
        }
    }
}

impl ComputerUseLinux {
    fn mcp_tool_router(&self) -> rmcp::handler::server::router::tool::ToolRouter<Self> {
        self.router_with_completion(completion_notifications_enabled())
    }

    fn router_with_completion(
        &self,
        enabled: bool,
    ) -> rmcp::handler::server::router::tool::ToolRouter<Self> {
        let mut router = Self::tool_router();
        if !enabled {
            router.map.remove("complete_interaction");
        }
        if !shell_execution_enabled() {
            router.map.remove("run_shell");
        }
        for route in router.map.values_mut() {
            let input_schema = Arc::make_mut(&mut route.attr.input_schema);
            for value in input_schema.values_mut() {
                sanitize_unsigned_integer_formats(value);
            }
            if let Some(output_schema) = route.attr.output_schema.as_mut() {
                for value in Arc::make_mut(output_schema).values_mut() {
                    sanitize_unsigned_integer_formats(value);
                }
            }
        }
        router
    }
}

#[tool_router]
impl ComputerUseLinux {
    #[tool(
        name = "complete_interaction",
        description = "Send a desktop notification that this agent has finished its interaction. Available only with CODEX_COMPUTER_USE_NOTIFY_ON_COMPLETE=1 (or its standalone alias). This cue does not acquire or release an exclusive desktop lock. Delivery is best effort and bounded; it may be suppressed by desktop notification settings.",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = false,
            open_world_hint = true
        )
    )]
    async fn complete_interaction(&self) -> Json<CompletionOutput> {
        if !completion_notifications_enabled() {
            return Json(CompletionOutput {
                ok: true,
                cue: "skipped".into(),
                note: "Completion notifications are disabled.".into(),
            });
        }
        Json(send_completion_notification(Path::new("notify-send"), Duration::from_secs(2)).await)
    }
    #[tool(
        name = "doctor",
        description = "Report Linux Computer Use desktop integration readiness.",
        annotations(
            read_only_hint = true,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = false
        )
    )]
    async fn doctor(&self) -> Json<DoctorReport> {
        Json(
            tokio::task::spawn_blocking(doctor_report)
                .await
                .expect("diagnostics task panicked"),
        )
    }

    #[tool(
        name = "setup_accessibility",
        description = "Enable GNOME accessibility through gsettings so Linux Computer Use can read AT-SPI trees.",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = false
        )
    )]
    async fn setup_accessibility(&self) -> Json<SetupReport> {
        let report = tokio::task::spawn_blocking(setup_accessibility_report)
            .await
            .expect("accessibility setup task panicked");
        self.diagnostics.invalidate();
        Json(report)
    }

    #[tool(
        name = "setup_window_targeting",
        description = "Install and enable the optional GNOME Shell extension used for exact window list/focus targeting when GNOME blocks native introspection.",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = false
        )
    )]
    async fn setup_window_targeting(&self) -> Json<WindowTargetingSetupReport> {
        let report = setup_window_targeting_report().await;
        self.diagnostics.invalidate();
        Json(report)
    }

    #[tool(
        name = "list_apps",
        description = "List running Linux desktop app candidates visible to the Computer Use backend.",
        annotations(
            read_only_hint = true,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = true
        )
    )]
    async fn list_apps(&self) -> Json<ListAppsOutput> {
        let (accessible_apps, accessibility_error) = match list_accessible_apps(50).await {
            Ok(apps) => (apps, None),
            Err(error) => {
                self.diagnostics.invalidate();
                (Vec::new(), Some(format!("{error:#}")))
            }
        };

        Json(ListAppsOutput {
            apps: list_process_apps(),
            accessible_apps,
            accessibility_error,
            note: "Linux Computer Use lists process candidates plus AT-SPI application roots when accessibility is enabled.".to_string(),
        })
    }

    #[tool(
        name = "get_tree_page",
        description = "Return a page of the accessibility tree from the latest get_app_state or include_tree snapshot, starting at node offset (default 0). Use it when a tree was too large to return inline (accessibility_tree_spill is set) and the host cannot read the spill file; page with next_offset until it is null. Element indices match the snapshot, so element_index actions work on these nodes. It does not read the desktop again.",
        annotations(
            read_only_hint = true,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = true
        )
    )]
    async fn get_tree_page(
        &self,
        Parameters(params): Parameters<GetTreePageParams>,
    ) -> Json<GetTreePageOutput> {
        let nodes = self
            .last_snapshot
            .lock()
            .map(|snapshot| snapshot.nodes.clone())
            .unwrap_or_default();
        Json(tree_page(&nodes, params.offset.unwrap_or(0)))
    }

    #[tool(
        name = "list_windows",
        description = "List compositor windows with title, app id, class, focus state, client type, and known bounds.",
        annotations(
            read_only_hint = true,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = true
        )
    )]
    async fn list_windows(&self) -> Json<ListWindowsOutput> {
        let output = window_list_output().await;
        if output.error.is_some() {
            self.diagnostics.invalidate();
        }
        Json(output)
    }

    #[tool(
        name = "focused_window",
        description = "Return the compositor window that currently has keyboard focus.",
        annotations(
            read_only_hint = true,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = true
        )
    )]
    async fn focused_window(&self) -> Json<FocusedWindowOutput> {
        match focused_window_with_backend().await {
            Ok((backend, window)) => {
                Json(FocusedWindowOutput {
                    backend,
                    focused_window: window,
                    error: None,
                    permissions_hint: None,
                    message:
                        "Focused window query completed through the available compositor window backend."
                            .to_string(),
                })
            }
            Err(error) => {
                self.diagnostics.invalidate();
                let error = format!("{error:#}");
                Json(FocusedWindowOutput {
                    backend: UNAVAILABLE_BACKEND.to_string(),
                    focused_window: None,
                    permissions_hint: window_permission_hint(&error),
                    error: Some(error),
                    message: "Focused window query failed; targeted keyboard input is unavailable until window introspection works.".to_string(),
                })
            }
        }
    }

    #[tool(
        name = "activate_window",
        output_schema = rmcp::handler::server::tool::schema_for_output::<ActivateWindowToolOutput>(),
        description = "Focus a Linux desktop window by window_id, pid, app_id, wm_class, title, or terminal selectors when the compositor permits it. Pass screenshot_after (true, \"screen\", or \"window\") or include_tree=true to return post-action observation in the same result.",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = true
        )
    )]
    async fn activate_window(
        &self,
        Parameters(params): Parameters<ActivateWindowParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let capture = params.capture.clone();
        let target = params.clone().into_target();
        let Json(output) = self.dispatch_activate_window(params).await;
        self.finish_activate_window_output(output, &capture, &target)
            .await
    }

    async fn dispatch_activate_window(
        &self,
        params: ActivateWindowParams,
    ) -> Json<ActivateWindowOutput> {
        let received = Some(serde_json::json!(params.clone()));
        let target = params.into_target();
        self.indicator.action("activate_window").await;
        match focus_window_target(&target).await {
            Ok(focus) => {
                let ok = focus_satisfies_target(&focus, &target);
                Json(ActivateWindowOutput {
                    ok,
                    implemented: true,
                    backend: focus.backend.clone(),
                    focus: Some(focus),
                    error: None,
                    permissions_hint: None,
                    received,
                })
            }
            Err(error) => {
                let error = format!("{error:#}");
                Json(ActivateWindowOutput {
                    ok: false,
                    implemented: true,
                    backend: UNAVAILABLE_BACKEND.to_string(),
                    focus: None,
                    permissions_hint: window_permission_hint(&error),
                    error: Some(error),
                    received,
                })
            }
        }
    }

    #[tool(
        name = "get_app_state",
        output_schema = rmcp::handler::server::tool::schema_for_output::<GetAppStateOutput>(),
        description = "Start an app use session if needed, then get a size-bounded screenshot and accessibility state for a Linux app. Scope the accessibility tree with app_name_or_bundle_identifier or a window_id/pid/app_id/wm_class/title target; omitting a target returns the whole desktop tree and can flood context. A tree too large to return inline is written whole to the private file in accessibility_tree_spill. Screenshot results include coordinate_width, coordinate_height, scale, format, and quality when the returned image is downscaled or compressed; callers can request jpeg/quality for compression before resizing.",
        annotations(
            read_only_hint = true,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = true
        )
    )]
    async fn get_app_state(
        &self,
        Parameters(params): Parameters<GetAppStateParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let captures = params.include_screenshot.unwrap_or(true);
        let result = self.app_state(params).await;
        if captures {
            self.indicator.action("get_app_state").await;
        }
        result
    }

    async fn app_state(&self, params: GetAppStateParams) -> Result<CallToolResult, ErrorData> {
        let verbose = params.verbose.unwrap_or(false);
        // A clone: this call's screenshot result is recorded on it, not on the
        // cached report.
        let (mut diagnostics, mut probed) = self.diagnostics.report_and_probed(verbose).await;
        // The tree gate below must see accessibility switched on or off within
        // the TTL.
        if !probed {
            let can_build_now = tokio::task::spawn_blocking(self.accessibility_check.0)
                .await
                .unwrap_or(false);
            if can_build_now != diagnostics.readiness.can_build_accessibility_tree {
                diagnostics = self.diagnostics.report(true).await;
                probed = true;
            }
        }
        let (
            window_context,
            window_error,
            window_permissions_hint,
            window_enumerated,
            failed_window_backends,
        ) = self.resolve_window_context(&params).await;
        let (max_nodes, max_depth) =
            crate::atspi_tree::snapshot_limits(params.max_nodes, params.max_depth);
        let include_screenshot = params.include_screenshot.unwrap_or(true);
        let screenshot_options = params.screenshot_options();
        let screenshot_target_requested = params.window_target().has_target();
        // Whether the caller asked for any scope at all. `tree_scoped` can still
        // come back false when a target matched no AT-SPI root, and that case
        // needs different advice than "pass a target".
        let accessibility_target_requested = screenshot_target_requested
            || params
                .app_name_or_bundle_identifier
                .as_deref()
                .is_some_and(|name| !name.trim().is_empty());
        let app_filter = self
            .resolve_accessibility_app_filter(&params, window_context.as_ref(), window_enumerated)
            .await;
        let mut screenshot_captured = None;
        let (screenshot, screenshot_error) = if include_screenshot {
            let result: Result<ScreenshotCapture> = async {
                let _pipeline = crate::screenshot::screenshot_pipeline_permit().await?;
                let raw = {
                    let _hold = self.indicator.hold_for_capture().await?;
                    capture_screenshot_raw().await
                };
                screenshot_captured = Some(raw.is_ok());
                let raw = raw?;
                self.cache_desktop_size(raw.width, raw.height);
                let crop = if let Some(window) = window_context.as_ref() {
                    ensure_readonly_screenshot_target_is_visible(window)?;
                    Some(self.window_crop_rect_for_capture(window, &raw).await?)
                } else {
                    None
                };
                crate::screenshot::run_image_task(move || {
                    prepare_app_state_screenshot(
                        raw,
                        crop,
                        screenshot_target_requested,
                        screenshot_options,
                    )
                })
                .await
            }
            .await;
            match result {
                Ok(capture) => (Some(capture), None),
                Err(error) => (None, Some(format!("{error:#}"))),
            }
        } else {
            (None, None)
        };
        let mut tree_scoped = false;
        let mut tree_root_pid = None;
        let mut accessibility_tree_truncated = false;
        let mut shell_only_note = None;
        let (accessibility_tree, accessibility_tree_raw_count, accessibility_error, tree_read) =
            if diagnostics.readiness.can_build_accessibility_tree {
                let target_pid = accessibility_snapshot_target_pid(
                    app_filter.as_deref(),
                    window_context.as_ref().and_then(|window| window.pid),
                );
                match snapshot_accessibility_tree(
                    app_filter.as_deref(),
                    target_pid,
                    max_nodes,
                    max_depth,
                )
                .await
                {
                    Ok(snapshot) => {
                        tree_scoped = snapshot.scoped;
                        tree_root_pid = snapshot.root_pid;
                        accessibility_tree_truncated = snapshot.truncated;
                        let raw_count = snapshot.nodes.len();
                        let (nodes, note) = compact_accessibility_tree_with_note(
                            snapshot.nodes,
                            tree_scoped,
                            accessibility_tree_truncated,
                        );
                        shell_only_note = note;
                        let read = if raw_count == 0 {
                            TreeRead::Failed
                        } else {
                            TreeRead::Nodes
                        };
                        (nodes, raw_count, None, read)
                    }
                    Err(error) => (Vec::new(), 0, Some(format!("{error:#}")), TreeRead::Failed),
                }
            } else {
                (
                    Vec::new(),
                    0,
                    Some(
                        "GNOME accessibility is disabled; call setup_accessibility first."
                            .to_string(),
                    ),
                    TreeRead::AccessibilityOff,
                )
            };
        let observed = AppStateObservation {
            screenshot_failed: screenshot_error.is_some(),
            window: match (&window_context, &window_error) {
                (_, Some(_)) => WindowLookup::Failed,
                (Some(_), None) => WindowLookup::Resolved,
                (None, None) => WindowLookup::NotRequested,
            },
            failed_window_backends: &failed_window_backends,
            tree: tree_read,
        };
        if let Some(contradiction) =
            readiness_contradiction(&diagnostics.readiness, &diagnostics.windowing, observed)
        {
            // Readiness is what explains this observation, so it must describe
            // the desktop as this call found it, not a cached report from
            // before.
            if !probed {
                diagnostics = self.diagnostics.report(true).await;
            }
            if contradiction == Contradiction::Failure {
                // After the refresh, so the next call probes again.
                self.diagnostics.invalidate();
            }
        }
        if let Some(captured) = screenshot_captured {
            diagnostics.readiness.record_screenshot_result(captured);
        }
        if accessibility_error.is_none() {
            // Record a pid only when the tree's roots were matched by it. A pid
            // with no AT-SPI root falls back to every app, or to an app-name
            // match that can be another app entirely; recording the pid then
            // would let that app's index pass the target check instead of
            // taking the per-node owner lookup.
            self.commit_app_state_snapshot(
                &accessibility_tree,
                tree_root_pid,
                window_context.as_ref(),
                &params,
                tree_scoped,
            )
            .await;
        } else {
            self.commit_snapshot(&[], None).await;
        }
        let compacted_count = accessibility_tree.len();
        let mut message = if let Some(error) = &accessibility_error {
            format!("MCP registration is working, but AT-SPI tree extraction failed: {error}")
        } else if let Some(capture) = &screenshot {
            format!(
                "MCP registration, screenshot capture, and AT-SPI tree extraction are working. Captured {} accessibility nodes (compacted from {}) and a screenshot through {}.",
                compacted_count,
                accessibility_tree_raw_count,
                capture.source
            )
        } else if let Some(error) = &screenshot_error {
            format!(
                "MCP registration and AT-SPI tree extraction are working. Captured {} accessibility nodes (compacted from {}). Screenshot capture failed: {error}",
                compacted_count,
                accessibility_tree_raw_count,
            )
        } else {
            format!(
                "MCP registration and AT-SPI tree extraction are working. Captured {} accessibility nodes (compacted from {}). Screenshot capture was not requested.",
                compacted_count,
                accessibility_tree_raw_count,
            )
        };
        if let Some(window) = &window_context {
            message.push_str(&format!(
                " Window target resolved to window_id {}.",
                window.window_id
            ));
        } else if let Some(error) = &window_error {
            message.push_str(&format!(" Window target resolution failed: {error}"));
        }
        if let Some(warning) = unscoped_accessibility_tree_warning(
            tree_scoped,
            accessibility_error.is_none(),
            accessibility_target_requested,
        ) {
            message.push(' ');
            message.push_str(warning);
        }
        if let Some(note) = truncated_accessibility_tree_note(accessibility_tree_truncated) {
            message.push(' ');
            message.push_str(note);
        }
        if let Some(note) = shell_only_note {
            message.push(' ');
            message.push_str(note);
        }

        // Full diagnostics are huge (portal/process dumps); emit them only on
        // request. The compact readiness block always travels, and failures get
        // a pointer to verbose=true instead of an automatic dump.
        let readiness = diagnostics.readiness.clone();
        let include_full = verbose;
        if !include_full
            && (accessibility_error.is_some()
                || screenshot_error.is_some()
                || window_error.is_some())
        {
            message.push_str(" Pass verbose=true for full diagnostics.");
        }
        let mut output = GetAppStateOutput {
            app_name_or_bundle_identifier: params.app_name_or_bundle_identifier,
            window_context,
            window_error,
            window_permissions_hint,
            backend: "linux-atspi".to_string(),
            screenshot: screenshot.as_ref().map(ScreenshotSummary::from),
            screenshot_error,
            accessibility_tree: Vec::new(),
            accessibility_tree_raw_count,
            accessibility_tree_spill: None,
            tree_scoped,
            accessibility_tree_truncated,
            accessibility_error,
            readiness,
            diagnostics: include_full.then_some(diagnostics),
            message,
        };
        // The tree gets whatever the rest of the result leaves of the budget.
        let rest = serde_json::to_string(&output).map_or(0, |json| json.len());
        let mut accessibility_tree = accessibility_tree;
        let (spill, note) = fit_tree(
            &self.tree_spiller,
            &mut accessibility_tree,
            tree_budget(rest),
        );
        output.accessibility_tree = accessibility_tree;
        output.accessibility_tree_spill = spill;
        if let Some(note) = note {
            output.message.push(' ');
            output.message.push_str(&note);
        }
        app_state_result(output, screenshot)
    }

    #[tool(
        name = "screenshot",
        description = "Capture the screen and return it as a viewable, size-bounded image. Optionally target a window (window_id/pid/wm_class/title/app_id): the window is raised to the front and the image is cropped before any resize. Returns the image plus a short caption with returned dimensions, coordinate dimensions, scale, format, quality, source, and crop bounds; callers can request jpeg/quality for compression before resizing.",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = false,
            open_world_hint = true
        )
    )]
    async fn screenshot(&self, Parameters(params): Parameters<ScreenshotParams>) -> CallToolResult {
        let result = match self.capture_screenshot(params).await {
            Ok(result) => result,
            Err(error) => {
                self.diagnostics.invalidate();
                CallToolResult::error(vec![ContentBlock::text(format!("{error:#}"))])
            }
        };
        self.indicator.action("screenshot").await;
        result
    }

    async fn capture_screenshot(&self, params: ScreenshotParams) -> Result<CallToolResult> {
        let _pipeline = crate::screenshot::screenshot_pipeline_permit().await?;
        let target = params.window_target();
        let target_window = match target.as_ref() {
            Some(target) => Some(
                self.resolve_screenshot_window(target, params.raise_window.unwrap_or(true))
                    .await
                    .context("targeted screenshot failed")?,
            ),
            None => None,
        };
        let crop_window = (!params.full_screen.unwrap_or(false))
            .then_some(target_window.as_ref())
            .flatten();
        let window_label = target_window
            .as_ref()
            .and_then(|window| window.title.clone());

        let raw_capture = {
            let _hold = self.indicator.hold_for_capture().await?;
            capture_screenshot_raw()
                .await
                .context("screenshot failed")?
        };
        self.cache_desktop_size(raw_capture.width, raw_capture.height);

        // Warn when the target window extends past the visible desktop: the
        // portal only captures on-screen pixels, so the crop silently loses the
        // off-screen region while coordinate metadata still claims full size.
        let off_screen_note = match crop_window.and_then(|window| window.bounds.as_ref()) {
            Some(bounds) => self.off_screen_note_for_bounds(bounds).await,
            None => None,
        };

        let (capture, cropped) = match crop_window {
            Some(window) => {
                let (x, y, width, height) = self
                    .window_crop_rect_for_capture(window, &raw_capture)
                    .await
                    .context("targeted screenshot crop failed")?;
                let (raw_capture, bytes, width, height) =
                    crate::screenshot::run_image_task(move || {
                        let (bytes, width, height) =
                            crop_png(&raw_capture.bytes, x, y, width, height).map_err(|error| {
                                anyhow::anyhow!("targeted screenshot crop failed: {error}")
                            })?;
                        Ok((raw_capture, bytes, width, height))
                    })
                    .await?;
                (
                    RawScreenshotCapture {
                        mime_type: raw_capture.mime_type,
                        bytes,
                        source: raw_capture.source,
                        width,
                        height,
                    },
                    true,
                )
            }
            None => (raw_capture, false),
        };
        let options = params.screenshot_options();
        let capture =
            crate::screenshot::run_image_task(move || prepare_screenshot_payload(capture, options))
                .await
                .context("screenshot resize failed")?;

        let mut caption = serde_json::json!({
            "width": capture.width,
            "height": capture.height,
            "coordinate_width": capture.coordinate_width,
            "coordinate_height": capture.coordinate_height,
            "scale": capture.scale,
            "resized": capture.resized,
            "bytes": capture.bytes,
            "original_bytes": capture.original_bytes,
            "max_bytes": capture.max_bytes,
            "format": capture.format,
            "quality": capture.quality,
            "source": capture.source,
            "cropped_to_window": cropped,
            "window_title": window_label,
        });
        if let Some(note) = off_screen_note {
            caption["window_off_screen"] = serde_json::json!(true);
            caption["off_screen_note"] = serde_json::json!(note);
        }
        Ok(CallToolResult::success(vec![
            ContentBlock::image(data_url_payload(&capture.data_url), capture.mime_type),
            ContentBlock::text(caption.to_string()),
        ]))
    }

    /// Lazily create the uinput absolute pointer, sizing its ABS range to the
    /// full capture's pixel dimensions. This preserves the coordinate space
    /// used by click/scroll/drag, independently of logical monitor scaling.
    /// Explicit backend overrides skip this device, including a cached one.
    async fn ensure_abs_pointer(&self) -> bool {
        if self.is_cosmic_wayland_session()
            || (native_x11_xdotool_pointer_session(
                env::var("XDG_SESSION_TYPE").ok().as_deref(),
                env::var("WAYLAND_DISPLAY").ok().as_deref(),
            ) && env_var_non_empty("DISPLAY"))
            || env_flag_enabled_any(&[
                "CU_DISABLE_ABS_POINTER",
                "CODEX_COMPUTER_USE_DISABLE_ABS_POINTER",
            ])
            || env_flag_enabled_any(&[
                "COMPUTER_USE_LINUX_FORCE_YDOTOOL_POINTER",
                "CODEX_COMPUTER_USE_FORCE_YDOTOOL_POINTER",
            ])
            || (env_flag_enabled_any(&[
                "COMPUTER_USE_LINUX_FORCE_PORTAL_POINTER",
                "CODEX_COMPUTER_USE_FORCE_PORTAL_POINTER",
            ]) && self.is_wayland_session())
        {
            return false;
        }
        if self
            .abs_pointer
            .lock()
            .map(|g| g.is_some())
            .unwrap_or(false)
        {
            return true;
        }
        let Ok(cap) = capture_screenshot_raw().await else {
            return false;
        };
        self.cache_desktop_size(cap.width, cap.height);
        match tokio::task::spawn_blocking(move || {
            crate::abs_pointer::AbsPointer::create(cap.width as i32, cap.height as i32)
        })
        .await
        {
            Ok(Ok(pointer)) => {
                if let Ok(mut guard) = self.abs_pointer.lock() {
                    *guard = Some(pointer);
                    return true;
                }
                false
            }
            _ => false,
        }
    }

    async fn ensure_abs_pointer_for_kwin_capture(
        &self,
        width: u32,
        height: u32,
    ) -> std::result::Result<bool, String> {
        if self.is_cosmic_wayland_session()
            || (native_x11_xdotool_pointer_session(
                env::var("XDG_SESSION_TYPE").ok().as_deref(),
                env::var("WAYLAND_DISPLAY").ok().as_deref(),
            ) && env_var_non_empty("DISPLAY"))
            || env_flag_enabled_any(&[
                "CU_DISABLE_ABS_POINTER",
                "CODEX_COMPUTER_USE_DISABLE_ABS_POINTER",
            ])
            || env_flag_enabled_any(&[
                "COMPUTER_USE_LINUX_FORCE_YDOTOOL_POINTER",
                "CODEX_COMPUTER_USE_FORCE_YDOTOOL_POINTER",
            ])
            || (env_flag_enabled_any(&[
                "COMPUTER_USE_LINUX_FORCE_PORTAL_POINTER",
                "CODEX_COMPUTER_USE_FORCE_PORTAL_POINTER",
            ]) && self.is_wayland_session())
        {
            return Ok(false);
        }
        let stale = {
            let mut guard = self
                .abs_pointer
                .lock()
                .map_err(|_| "absolute pointer lock was poisoned".to_string())?;
            match guard.as_ref() {
                Some(pointer) if pointer.matches_dimensions(width as i32, height as i32) => {
                    return Ok(true)
                }
                Some(_) => {
                    *guard = None;
                    true
                }
                None => false,
            }
        };
        self.create_abs_pointer_for_kwin_capture_with(
            width,
            height,
            stale,
            crate::abs_pointer::AbsPointer::create,
        )
        .await
    }

    async fn create_abs_pointer_for_kwin_capture_with<F>(
        &self,
        width: u32,
        height: u32,
        stale: bool,
        create: F,
    ) -> std::result::Result<bool, String>
    where
        F: FnOnce(i32, i32) -> Result<crate::abs_pointer::AbsPointer> + Send + 'static,
    {
        let created =
            tokio::task::spawn_blocking(move || create(width as i32, height as i32)).await;
        match created {
            Ok(Ok(pointer)) => {
                let mut guard = self
                    .abs_pointer
                    .lock()
                    .map_err(|_| "absolute pointer lock was poisoned".to_string())?;
                *guard = Some(pointer);
                Ok(true)
            }
            Ok(Err(error)) if stale => Err(format!(
                "cached absolute-pointer geometry was stale for the current raw capture and the device could not be recreated: {error:#}"
            )),
            Err(error) if stale => Err(format!(
                "cached absolute-pointer geometry was stale for the current raw capture and the device recreation task failed: {error}"
            )),
            _ => Ok(false),
        }
    }

    #[tool(
        name = "click",
        output_schema = rmcp::handler::server::tool::schema_for_output::<ActionToolOutput>(),
        description = "Click an element by index, semantic selector, or desktop coordinate pixels from screenshot metadata. Plain left activation prefers a native AT-SPI click/press/toggle action, avoiding toolkit coordinate scaling. Entry activate and slider jump actions are not substituted for pointer clicks. Explicit coordinates, right clicks, and multi-clicks retain pointer semantics. Explicit x/y default to raw screenshot capture pixels; coordinate_space=\"atspi\" with element_index or a semantic selector maps a global AT-SPI screen point through the element's KWin window and output geometry on KDE Wayland. Pass screenshot_after (true, \"screen\", or \"window\") or include_tree=true to return post-action observation in the same result.",
        annotations(
            read_only_hint = false,
            destructive_hint = true,
            idempotent_hint = false,
            open_world_hint = true
        )
    )]
    async fn click(
        &self,
        Parameters(params): Parameters<ClickParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let capture = params.capture.clone();
        let target = params.window_target();
        let Json(output) = self.dispatch_click(params).await;
        self.finish_action_output(output, &capture, target.as_ref())
            .await
    }

    async fn dispatch_click(&self, mut params: ClickParams) -> Json<ActionOutput> {
        let received = Some(serde_json::json!(params.clone()));
        let input_guard = Arc::clone(&self.input_operation_lock).lock_owned().await;
        let mut portal_target_point = None;
        let mut input_focus = None;
        let mut target_pid = params.pid;
        if let Err(message) = validate_click_coordinate_space(&params) {
            return Json(ActionOutput {
                ok: false,
                implemented: true,
                action: "click".to_string(),
                message,
                received,
            });
        }
        if params.coordinate_space == ClickCoordinateSpace::Atspi
            && !self.should_map_kwin_element_click(None)
        {
            return Json(ActionOutput {
                ok: false,
                implemented: true,
                action: "click".to_string(),
                message: "AT-SPI coordinate clicks require a KWin Wayland window backend. Use screenshot capture coordinates on this session.".to_string(),
                received,
            });
        }
        // Raise the target window first (if specified) so the click lands on the
        // intended app rather than whatever is stacked on top at that pixel.
        let mut window_target = params.window_target();
        if params.relative == Some(true) && window_target.is_none() {
            return Json(ActionOutput {
                ok: false,
                implemented: true,
                action: "click".to_string(),
                message: "Relative coordinate clicks require a window target.".to_string(),
                received,
            });
        }
        if let Some(target) = window_target.as_ref() {
            let focus = match self.focus_target_for_input(target).await {
                Ok(focus) => focus,
                Err(message) => {
                    return Json(ActionOutput {
                        ok: false,
                        implemented: true,
                        action: "click".to_string(),
                        message,
                        received,
                    });
                }
            };
            target_pid = focus_target_pid(focus.as_ref()).or(target_pid);
            tokio::time::sleep(Duration::from_millis(120)).await;
            // Window-relative coordinates: translate by the window's top-left so
            // the agent can click the pixel it saw in a window-cropped screenshot.
            if params.relative == Some(true) {
                let Some(focus) = focus.as_ref() else {
                    return Json(ActionOutput {
                        ok: false,
                        implemented: true,
                        action: "click".to_string(),
                        message: "Relative coordinate clicks require verified target-window focus."
                            .to_string(),
                        received,
                    });
                };
                let coordinate_map = match self.focused_window_coordinate_map(focus).await {
                    Ok(mapping) => mapping,
                    Err(message) => {
                        return Json(ActionOutput {
                            ok: false,
                            implemented: true,
                            action: "click".to_string(),
                            message,
                            received,
                        });
                    }
                };
                if let Err(message) = apply_window_relative_click_coordinates(
                    &mut params,
                    coordinate_map.capture_rect,
                ) {
                    return Json(ActionOutput {
                        ok: false,
                        implemented: true,
                        action: "click".to_string(),
                        message,
                        received,
                    });
                }
                portal_target_point = params
                    .x
                    .zip(params.y)
                    .and_then(|(x, y)| coordinate_map.portal_point(x, y));
            }
            if let Some(focus) = focus.as_ref() {
                window_target = Some(portal_focus_target(target, &focus.requested_window));
            }
            input_focus = focus;
        }
        if params.x.zip(params.y).is_none()
            || params.coordinate_space == ClickCoordinateSpace::Atspi
        {
            if let Some(node) = self.cached_node_for(
                params.element_index,
                &params.selector(),
                ElementResolvePurpose::Click,
            ) {
                if let Err(message) = self.check_node_target(&node, target_pid).await {
                    return Json(ActionOutput {
                        ok: false,
                        implemented: true,
                        action: "click".to_string(),
                        message,
                        received,
                    });
                }
            }
        }
        let target = match self.resolve_click_target(&params) {
            Ok(target) => target,
            Err(message) => {
                return Json(ActionOutput {
                    ok: false,
                    implemented: true,
                    action: "click".to_string(),
                    message,
                    received,
                });
            }
        };
        if let ClickTarget::PrimaryAction {
            object_ref,
            action_name,
            action_index,
        } = target
        {
            self.indicator.action("click").await;
            let invocation = if let Some(name) = action_name
                .as_deref()
                .filter(|name| !name.trim().is_empty())
            {
                perform_named_action(&object_ref, name).await
            } else {
                invoke_accessibility_action(&object_ref, Some(&action_index.to_string())).await
            };
            return match invocation {
                Ok(invocation) => Json(ActionOutput {
                    ok: invocation.ok,
                    implemented: true,
                    action: "click".to_string(),
                    message: if invocation.ok {
                        format!(
                            "Invoked the primary AT-SPI action{} without pointer-coordinate conversion.",
                            action_name
                                .as_deref()
                                .filter(|name| !name.is_empty())
                                .map(|name| format!(" ({name})"))
                                .unwrap_or_default()
                        )
                    } else {
                        format!(
                            "The primary AT-SPI action{} returned false.",
                            action_name
                                .as_deref()
                                .filter(|name| !name.is_empty())
                                .map(|name| format!(" ({name})"))
                                .unwrap_or_default()
                        )
                    },
                    received,
                }),
                Err(error) => Json(ActionOutput {
                    ok: false,
                    implemented: true,
                    action: "click".to_string(),
                    message: error.to_string(),
                    received,
                }),
            };
        }
        let element_bounds = match &target {
            ClickTarget::ElementBounds { node, .. } | ClickTarget::ElementPoint { node, .. } => {
                node.bounds.clone()
            }
            _ => None,
        };
        let element_click = element_bounds.is_some();
        let global_point = matches!(&target, ClickTarget::ElementPoint { .. });
        let (x, y, kwin_click) = match target {
            ClickTarget::Coordinates(x, y) => (x, y, None),
            ClickTarget::ElementBounds { node, center }
            | ClickTarget::ElementPoint {
                node,
                point: center,
            } => {
                if self.should_map_kwin_element_click(input_focus.as_ref()) {
                    match self
                        .prepare_kwin_element_click(
                            &node,
                            center,
                            global_point,
                            input_focus.as_ref(),
                        )
                        .await
                    {
                        Ok(prepared) => {
                            portal_target_point = Some(prepared.portal_point());
                            let (x, y) = prepared.uinput_point();
                            (x, y, Some(prepared))
                        }
                        Err(message) => {
                            return self.kwin_element_click_failure(node.index, &message, received);
                        }
                    }
                } else if global_point {
                    return self.kwin_element_click_failure(
                        node.index,
                        "AT-SPI coordinate clicks require a KWin Wayland window backend; the focused window uses a different backend",
                        received,
                    );
                } else {
                    (center.0, center.1, None)
                }
            }
            ClickTarget::PrimaryAction { .. } => unreachable!(),
        };
        self.indicator
            .pointer("click", (x, y), self.indicator_space())
            .await;
        let button = mouse_button_code(params.button.as_deref());
        let click_count = params.click_count.unwrap_or(1).clamp(1, 10).to_string();
        let input_guard = Arc::new(input_guard);
        if let Some(output) = self
            .try_pixelflux_click(
                x,
                y,
                // KWin already mapped the element into capture pixels.
                element_click && kwin_click.is_none(),
                element_bounds.as_ref(),
                params.button.as_deref(),
                params.click_count.unwrap_or(1),
                received.clone(),
                Arc::clone(&input_guard),
            )
            .await
        {
            return Json(output);
        }
        let mut input_guard = Arc::try_unwrap(input_guard)
            .unwrap_or_else(|_| panic!("pixelflux fallback must not retain dispatched input"));
        if self.should_prefer_xdotool_pointer() {
            let off_screen_note = self.off_screen_note_for_point(x, y).await;
            if let Some(xdotool_args) = xdotool_pointer_click_args(
                x,
                y,
                params.click_count.unwrap_or(1).clamp(1, 10),
                params.button.as_deref(),
            ) {
                let (input_guard, result) = run_cancellation_safe_input(input_guard, async move {
                    run_xdotool_pointer_or_fallback(Path::new("xdotool"), &xdotool_args, || async {
                        Err("Native X11 pointer input requires xdotool; no system-wide input fallback was used.".to_string())
                    })
                    .await
                })
                .await;
                let _input_guard = input_guard;
                let used_xdotool = result
                    .as_ref()
                    .is_ok_and(|result| result.backend == KeyboardCommandBackend::Xdotool);
                let mut output = pointer_action_result(action_result(
                    "click",
                    result.map(|result| result.outputs),
                    received,
                ));
                if output.ok && used_xdotool {
                    output.message = "Action sent through xdotool (X11 XTEST).".to_string();
                }
                return Json(with_notes(output, off_screen_note));
            }
            return Json(ActionOutput {
                ok: false,
                implemented: true,
                action: "click".to_string(),
                message: "X11 click supports left, middle and right buttons.".to_string(),
                received,
            });
        }
        // Preferred backend: the uinput absolute pointer. Unlike ydotool's
        // relative-only device (faked `--absolute` via pin-to-corner + relative
        // move, which acceleration + fractional scaling distort) and unlike the
        // portal (per-monitor coordinate scaling + an approval dialog), the
        // absolute pointer uses screenshot-pixel coordinates directly and
        // reports the point it emitted after desktop-edge clamping. Keep the
        // operation guard through cancellation so a partial click is never
        // replayed through a fallback backend.
        let off_screen_note = self.off_screen_note_for_point(x, y).await;
        let abs_pointer_ready = if let Some(kwin_click) = kwin_click {
            match self
                .ensure_abs_pointer_for_kwin_capture(
                    kwin_click.capture_size.0,
                    kwin_click.capture_size.1,
                )
                .await
            {
                Ok(ready) => ready,
                Err(message) => {
                    return self.kwin_element_click_failure(
                        kwin_click.element_index,
                        &message,
                        received,
                    );
                }
            }
        } else {
            self.ensure_abs_pointer().await
        };
        if let (true, Some(btn)) = (
            abs_pointer_ready,
            crate::abs_pointer::PointerButton::from_name(params.button.as_deref()),
        ) {
            let count = params.click_count.unwrap_or(1).clamp(1, 10);
            let abs_pointer = Arc::clone(&self.abs_pointer);
            let (returned_guard, clicked) =
                run_cancellation_safe_guarded(input_guard, async move {
                    tokio::task::spawn_blocking(move || {
                        let mut guard = abs_pointer.lock().ok()?;
                        let result = guard
                            .as_mut()?
                            .click(x, y, btn, count)
                            .map_err(|error| format!("{error:#}"));
                        if result.is_err() {
                            guard.take();
                        }
                        Some(result)
                    })
                    .await
                    .ok()
                    .flatten()
                })
                .await;
            let Some(returned_guard) = returned_guard else {
                return Json(with_notes(
                    action_result("click", Err(clicked.unwrap_err()), received),
                    off_screen_note,
                ));
            };
            input_guard = returned_guard;
            match clicked {
                Ok(Some(Ok(landing))) => {
                    return Json(kwin_element_click_dispatch_output(
                        with_notes(
                            pointer_action_result(ActionOutput {
                                ok: true,
                                implemented: true,
                                action: "click".to_string(),
                                message: "Action sent through the uinput absolute pointer."
                                    .to_string(),
                                received,
                            }),
                            abs_pointer_clamp_note(landing).or(off_screen_note.clone()),
                        ),
                        kwin_click,
                        "the uinput absolute pointer",
                    ));
                }
                Ok(Some(Err(error))) => {
                    return Json(with_notes(
                        action_result(
                            "click",
                            Err(format!(
                                "uinput click may have started before it failed; the device was invalidated and input was not replayed through another backend: {error}"
                            )),
                            received,
                        ),
                        off_screen_note,
                    ));
                }
                Ok(None) => {}
                Err(_) => unreachable!("missing guard already handled the guarded task failure"),
            }
        }
        let off_screen_note = self.off_screen_note_for_point(x, y).await;
        if let Some(session) = self.cached_portal_pointer_session() {
            let Some((portal_x, portal_y)) =
                portal_target_point.or_else(|| self.logical_portal_point(&session, x, y))
            else {
                self.clear_portal_pointer_session(&session);
                return Json(with_notes(
                    pointer_action_result(portal_coordinate_error("click", received)),
                    off_screen_note.clone(),
                ));
            };
            match portal_click(
                &session,
                portal_x,
                portal_y,
                PointerButton::from_name(params.button.as_deref()),
                params.click_count.unwrap_or(1).clamp(1, 10),
                InputOperationGuard::new(input_guard),
            )
            .await
            {
                Ok(()) => {
                    return Json(kwin_element_click_dispatch_output(
                        with_notes(
                            pointer_action_result(ActionOutput {
                                ok: true,
                                implemented: true,
                                action: "click".to_string(),
                                message: "Action sent through the remote desktop portal."
                                    .to_string(),
                                received,
                            }),
                            off_screen_note.clone(),
                        ),
                        kwin_click,
                        "the remote desktop portal",
                    ));
                }
                Err(error) => {
                    self.clear_portal_pointer_session(&session);
                    return Json(with_notes(
                        pointer_action_result(portal_action_error("click", error, received)),
                        off_screen_note.clone(),
                    ));
                }
            }
        } else if self.should_prefer_portal_pointer_backend().await {
            match self.ensure_portal_pointer_session().await {
                Ok(Some(session)) => {
                    if let Some(target) = window_target.as_ref() {
                        if let Err(message) = self.focus_target_for_input(target).await {
                            return Json(action_result("click", Err(message), received));
                        }
                    }
                    let Some((portal_x, portal_y)) =
                        portal_target_point.or_else(|| self.logical_portal_point(&session, x, y))
                    else {
                        self.clear_portal_pointer_session(&session);
                        return Json(with_notes(
                            pointer_action_result(portal_coordinate_error("click", received)),
                            off_screen_note.clone(),
                        ));
                    };
                    match portal_click(
                        &session,
                        portal_x,
                        portal_y,
                        PointerButton::from_name(params.button.as_deref()),
                        params.click_count.unwrap_or(1).clamp(1, 10),
                        InputOperationGuard::new(input_guard),
                    )
                    .await
                    {
                        Ok(()) => {
                            return Json(kwin_element_click_dispatch_output(
                                with_notes(
                                    pointer_action_result(ActionOutput {
                                        ok: true,
                                        implemented: true,
                                        action: "click".to_string(),
                                        message: "Action sent through the remote desktop portal."
                                            .to_string(),
                                        received,
                                    }),
                                    off_screen_note.clone(),
                                ),
                                kwin_click,
                                "the remote desktop portal",
                            ));
                        }
                        Err(error) => {
                            self.clear_portal_pointer_session(&session);
                            return Json(with_notes(
                                pointer_action_result(portal_action_error(
                                    "click", error, received,
                                )),
                                off_screen_note.clone(),
                            ));
                        }
                    }
                }
                Ok(None) => {
                    return Json(with_notes(
                        pointer_action_result(portal_action_error(
                            "click",
                            anyhow::anyhow!("the selected portal pointer backend was unavailable"),
                            received,
                        )),
                        off_screen_note,
                    ));
                }
                Err(error) => {
                    return Json(with_notes(
                        pointer_action_result(portal_start_error("click", error, received)),
                        off_screen_note,
                    ));
                }
            }
        }
        if self.is_wayland_session() {
            return Json(unsafe_pointer_fallback("click", received));
        }
        let commands = vec![
            absolute_mousemove_args(x, y),
            vec![
                "click".to_string(),
                "--repeat".to_string(),
                click_count,
                button,
            ],
        ];
        let (input_guard, result) = run_cancellation_safe_input(input_guard, async move {
            run_ydotool_sequence(&commands).await
        })
        .await;
        let _input_guard = input_guard;
        Json(with_notes(
            pointer_action_result(action_result("click", result, received)),
            off_screen_note,
        ))
    }

    #[tool(
        name = "perform_action",
        output_schema = rmcp::handler::server::tool::schema_for_output::<ActionToolOutput>(),
        description = "Invoke an accessibility action exposed by an element selected by index, identifier, or semantic selector. Defaults to the primary action unless action is provided. A stale semantic target can recover once with verified process/window ownership. Recovery invalidates cached indices; call get_app_state before further element_index actions. Pass screenshot_after (true, \"screen\", or \"window\") or include_tree=true to return post-action observation in the same result.",
        annotations(
            read_only_hint = false,
            destructive_hint = true,
            idempotent_hint = false,
            open_world_hint = true
        )
    )]
    async fn perform_action(
        &self,
        Parameters(params): Parameters<ActionParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let capture = params.capture.clone();
        let requested_action = requested_or_primary_action(params.action.as_deref());
        let Json(output) = self
            .perform_element_action(&params, Some(requested_action))
            .await;
        self.finish_action_output(output, &capture, None).await
    }

    #[tool(
        name = "set_value",
        output_schema = rmcp::handler::server::tool::schema_for_output::<SetValueToolOutput>(),
        description = "Set the value of a settable accessibility element selected by index, identifier, or semantic selector. Editable-text writes are verified by exact readback; password fields are explicitly unverifiable. Pass screenshot_after (true, \"screen\", or \"window\") or include_tree=true to return post-action observation in the same result.",
        annotations(
            read_only_hint = false,
            destructive_hint = true,
            idempotent_hint = false,
            open_world_hint = true
        )
    )]
    async fn set_value(
        &self,
        Parameters(params): Parameters<SetValueParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let capture = params.capture.clone();
        let (output, verified) = self.dispatch_set_value(params).await;
        self.finish_set_value_output(output, verified, &capture)
            .await
    }

    async fn dispatch_set_value(&self, params: SetValueParams) -> (ActionOutput, Option<bool>) {
        let _input_guard = Arc::clone(&self.input_operation_lock).lock_owned().await;
        let received = Some(serde_json::json!(params.clone()));
        let object_ref = match self.resolve_object_ref(
            params.element_index,
            params.element_identifier.as_deref(),
            &params.selector(),
            ElementResolvePurpose::SetValue,
        ) {
            Ok(object_ref) => object_ref,
            Err(message) => {
                return (
                    ActionOutput {
                        ok: false,
                        implemented: true,
                        action: "set_value".to_string(),
                        message,
                        received,
                    },
                    None,
                );
            }
        };

        self.indicator.text("set_value", &params.value, false).await;
        match set_element_value(&object_ref, &params.value).await {
            Ok(ValueSetInvocation::Numeric { value }) => (
                ActionOutput {
                    ok: true,
                    implemented: true,
                    action: "set_value".to_string(),
                    message: format!("AT-SPI numeric value set to {value}."),
                    received,
                },
                None,
            ),
            Ok(ValueSetInvocation::EditableText { outcome }) => {
                editable_text_action_result(outcome, received)
            }
            Err(error) => (
                ActionOutput {
                    ok: false,
                    implemented: true,
                    action: "set_value".to_string(),
                    message: error.to_string(),
                    received,
                },
                None,
            ),
        }
    }

    #[tool(
        name = "scroll",
        output_schema = rmcp::handler::server::tool::schema_for_output::<ActionToolOutput>(),
        description = "Scroll an element in a direction by a number of pages. With a window target and no x/y/element_index, scrolls at the centre of the targeted window. Pass screenshot_after (true, \"screen\", or \"window\") or include_tree=true to return post-action observation in the same result.",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = false,
            open_world_hint = true
        )
    )]
    async fn scroll(
        &self,
        Parameters(params): Parameters<ScrollParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let capture = params.capture.clone();
        let target = params.window_target();
        let Json(output) = self.dispatch_scroll(params).await;
        self.finish_action_output(output, &capture, target.as_ref())
            .await
    }

    async fn dispatch_scroll(&self, mut params: ScrollParams) -> Json<ActionOutput> {
        let received = Some(serde_json::json!(params.clone()));
        let units = match scroll_units(params.pages) {
            Ok(units) => units,
            Err(message) => {
                return Json(ActionOutput {
                    ok: false,
                    implemented: true,
                    action: "scroll".to_string(),
                    message,
                    received,
                });
            }
        };
        let input_guard = Arc::clone(&self.input_operation_lock).lock_owned().await;
        let mut portal_target_point = None;
        let mut target_pid = params.pid;
        // Raise/focus the target window first (parity with click) so wheel
        // events land on the intended app.
        let mut window_target = params.window_target();
        if params.relative == Some(true) && window_target.is_none() {
            return Json(ActionOutput {
                ok: false,
                implemented: true,
                action: "scroll".to_string(),
                message: "Relative scroll coordinates require a window target.".to_string(),
                received,
            });
        }
        if let Some(target) = window_target.as_ref() {
            let focus = match self.focus_target_for_input(target).await {
                Ok(focus) => focus,
                Err(message) => {
                    return Json(ActionOutput {
                        ok: false,
                        implemented: true,
                        action: "scroll".to_string(),
                        message,
                        received,
                    });
                }
            };
            target_pid = focus_target_pid(focus.as_ref()).or(target_pid);
            tokio::time::sleep(Duration::from_millis(120)).await;
            if params.relative == Some(true) {
                let Some(focus) = focus.as_ref() else {
                    return Json(ActionOutput {
                        ok: false,
                        implemented: true,
                        action: "scroll".to_string(),
                        message:
                            "Relative scroll coordinates require verified target-window focus."
                                .to_string(),
                        received,
                    });
                };
                let coordinate_map = match self.focused_window_coordinate_map(focus).await {
                    Ok(mapping) => mapping,
                    Err(message) => {
                        return Json(ActionOutput {
                            ok: false,
                            implemented: true,
                            action: "scroll".to_string(),
                            message,
                            received,
                        });
                    }
                };
                if let Err(message) = apply_window_relative_scroll_coordinates(
                    &mut params,
                    coordinate_map.capture_rect,
                ) {
                    return Json(ActionOutput {
                        ok: false,
                        implemented: true,
                        action: "scroll".to_string(),
                        message,
                        received,
                    });
                }
                portal_target_point = params
                    .x
                    .zip(params.y)
                    .and_then(|(x, y)| coordinate_map.portal_point(x, y));
            } else if params.x.is_none() && params.y.is_none() && params.element_index.is_none() {
                // A window target without a point would otherwise scroll
                // whatever happens to sit under the pointer: focusing does not
                // move the cursor, and the wheel path never repositions it.
                // Default to the centre of the resolved target window.
                let Some(focus) = focus.as_ref() else {
                    return Json(ActionOutput {
                        ok: false,
                        implemented: true,
                        action: "scroll".to_string(),
                        message: "Window-targeted scroll requires verified target-window focus."
                            .to_string(),
                        received,
                    });
                };
                let coordinate_map = match self.focused_window_coordinate_map(focus).await {
                    Ok(mapping) => mapping,
                    Err(message) => {
                        return Json(ActionOutput {
                            ok: false,
                            implemented: true,
                            action: "scroll".to_string(),
                            message,
                            received,
                        });
                    }
                };
                if let Err(message) =
                    apply_window_center_scroll_point(&mut params, coordinate_map.capture_rect)
                {
                    return Json(ActionOutput {
                        ok: false,
                        implemented: true,
                        action: "scroll".to_string(),
                        message,
                        received,
                    });
                }
                portal_target_point = params
                    .x
                    .zip(params.y)
                    .and_then(|(x, y)| coordinate_map.portal_point(x, y));
            }
            if let Some(focus) = focus.as_ref() {
                window_target = Some(portal_focus_target(target, &focus.requested_window));
            }
        }
        if params.x.is_none() && params.y.is_none() {
            if let Some(node) = self.cached_node_for(
                params.element_index,
                &ElementSelector::default(),
                ElementResolvePurpose::Click,
            ) {
                if let Err(message) = self.check_node_target(&node, target_pid).await {
                    return Json(ActionOutput {
                        ok: false,
                        implemented: true,
                        action: "scroll".to_string(),
                        message,
                        received,
                    });
                }
            }
        }
        let target_point =
            match self.resolve_optional_target_point(params.x, params.y, params.element_index) {
                Ok(point) => point,
                Err(message) => {
                    return Json(ActionOutput {
                        ok: false,
                        implemented: true,
                        action: "scroll".to_string(),
                        message,
                        received,
                    });
                }
            };
        let direction = match params.direction.to_ascii_lowercase().as_str() {
            "up" => ScrollDirection::Up,
            "down" => ScrollDirection::Down,
            "left" => ScrollDirection::Left,
            "right" => ScrollDirection::Right,
            _ => {
                return Json(ActionOutput {
                    ok: false,
                    implemented: true,
                    action: "scroll".to_string(),
                    message: "Unsupported scroll direction; expected up, down, left, or right."
                        .to_string(),
                    received,
                });
            }
        };
        match target_point {
            Some(point) => {
                self.indicator
                    .pointer("scroll", point, self.indicator_space())
                    .await
            }
            None => self.indicator.action("scroll").await,
        }
        let (dx, dy) = match direction {
            ScrollDirection::Up => (0, units),
            ScrollDirection::Down => (0, -units),
            ScrollDirection::Left => (units, 0),
            ScrollDirection::Right => (-units, 0),
        };
        // Element centres are AT-SPI logical points; pixelflux wants capture pixels.
        let pixelflux_point = match (params.x.zip(params.y), params.element_index) {
            (None, Some(index)) if crate::pixelflux::PixelfluxConfig::from_env().is_some() => {
                let bounds = self.cached_node_bounds(index);
                match self.pixelflux_element_point(bounds.as_ref()).await {
                    Some(point) => Some(point),
                    None => {
                        if let Some(output) =
                            self.pixelflux_unmapped("scroll", received.clone()).await
                        {
                            return Json(output);
                        }
                        None
                    }
                }
            }
            _ => target_point,
        };
        let input_guard = Arc::new(input_guard);
        if let Some(output) = self
            .pixelflux_send(
                "scroll",
                crate::pixelflux::PixelfluxAction::Scroll {
                    point: pixelflux_point,
                    direction,
                    amount: u32::try_from(units.max(1)).unwrap_or(1),
                },
                received.clone(),
                Arc::clone(&input_guard),
            )
            .await
        {
            return Json(output);
        }
        let input_guard = Arc::try_unwrap(input_guard)
            .unwrap_or_else(|_| panic!("pixelflux fallback must not retain dispatched input"));

        let off_screen_note = match target_point {
            Some((x, y)) => self.off_screen_note_for_point(x, y).await,
            None => None,
        };
        if self.should_prefer_xdotool_pointer() {
            let repeat = u32::try_from(units.max(1)).unwrap_or(1);
            let xdotool_args = xdotool_pointer_scroll_args(target_point, repeat, direction);
            let command_timeout = xdotool_scroll_timeout(repeat, XDOTOOL_SCROLL_CLICK_DELAY_MS);
            let (input_guard, result) = run_cancellation_safe_input(input_guard, async move {
                run_xdotool_pointer_or_fallback_with_timeout(
                    Path::new("xdotool"),
                    &xdotool_args,
                    command_timeout,
                    || async { Err("Native X11 pointer input requires xdotool; no system-wide input fallback was used.".to_string()) },
                )
                .await
            })
            .await;
            let _input_guard = input_guard;
            let used_xdotool = result
                .as_ref()
                .is_ok_and(|result| result.backend == KeyboardCommandBackend::Xdotool);
            let mut output = pointer_action_result(action_result(
                "scroll",
                result.map(|result| result.outputs),
                received,
            ));
            if output.ok && used_xdotool {
                output.message = "Action sent through xdotool (X11 XTEST).".to_string();
            }
            return Json(with_notes(output, off_screen_note));
        }
        // Coordinate scroll needs the same accurate positioning as click. Keep
        // the move and wheel event under one cancellation-safe input guard.
        if let Some((x, y)) = target_point {
            if self.is_wayland_session()
                && ydotool_backend_available().await
                && self.ensure_abs_pointer().await
            {
                let pointer = Arc::clone(&self.abs_pointer);
                let (input_guard, result) = run_cancellation_safe_input(input_guard, async move {
                    let landing =
                        run_abs_pointer(pointer, move |pointer| pointer.move_to(x, y)).await?;
                    sleep(Duration::from_millis(35)).await;
                    run_ydotool(&wheel_mousemove_args(dx, dy)).await?;
                    Ok(landing)
                })
                .await;
                let _input_guard = input_guard;
                return Json(abs_pointer_result("scroll", result, received));
            }
        }
        if let Some(session) = self.cached_portal_pointer_session() {
            let mapped_target = match (portal_target_point, target_point) {
                (Some(point), _) => Some(Some(point)),
                (None, Some((x, y))) => self.logical_portal_point(&session, x, y).map(Some),
                (None, None) => Some(None),
            };
            let Some(portal_target_point) = mapped_target else {
                self.clear_portal_pointer_session(&session);
                return Json(with_notes(
                    pointer_action_result(portal_coordinate_error("scroll", received)),
                    off_screen_note.clone(),
                ));
            };
            let session_for_input = session.clone();
            let (input_guard, result) = run_cancellation_safe_input(input_guard, async move {
                portal_scroll(&session_for_input, portal_target_point, direction, units)
                    .await
                    .map_err(|error| format!("{error:#}"))
            })
            .await;
            let _input_guard = input_guard;
            match result {
                Ok(()) => {
                    return Json(with_notes(
                        pointer_action_result(ActionOutput {
                            ok: true,
                            implemented: true,
                            action: "scroll".to_string(),
                            message: "Action sent through the remote desktop portal.".to_string(),
                            received,
                        }),
                        off_screen_note.clone(),
                    ));
                }
                Err(error) => {
                    self.clear_portal_pointer_session(&session);
                    return Json(with_notes(
                        pointer_action_result(portal_action_error(
                            "scroll",
                            anyhow::anyhow!(error),
                            received,
                        )),
                        off_screen_note.clone(),
                    ));
                }
            }
        } else if self.should_prefer_portal_pointer_backend().await {
            match self.ensure_portal_pointer_session().await {
                Ok(Some(session)) => {
                    if let Some(target) = window_target.as_ref() {
                        if let Err(message) = self.focus_target_for_input(target).await {
                            return Json(action_result("scroll", Err(message), received));
                        }
                    }
                    let mapped_target = match (portal_target_point, target_point) {
                        (Some(point), _) => Some(Some(point)),
                        (None, Some((x, y))) => self.logical_portal_point(&session, x, y).map(Some),
                        (None, None) => Some(None),
                    };
                    let Some(portal_target_point) = mapped_target else {
                        self.clear_portal_pointer_session(&session);
                        return Json(with_notes(
                            pointer_action_result(portal_coordinate_error("scroll", received)),
                            off_screen_note.clone(),
                        ));
                    };
                    let session_for_input = session.clone();
                    let (input_guard, result) =
                        run_cancellation_safe_input(input_guard, async move {
                            portal_scroll(&session_for_input, portal_target_point, direction, units)
                                .await
                                .map_err(|error| format!("{error:#}"))
                        })
                        .await;
                    let _input_guard = input_guard;
                    match result {
                        Ok(()) => {
                            return Json(with_notes(
                                pointer_action_result(ActionOutput {
                                    ok: true,
                                    implemented: true,
                                    action: "scroll".to_string(),
                                    message: "Action sent through the remote desktop portal."
                                        .to_string(),
                                    received,
                                }),
                                off_screen_note.clone(),
                            ));
                        }
                        Err(error) => {
                            self.clear_portal_pointer_session(&session);
                            return Json(with_notes(
                                pointer_action_result(portal_action_error(
                                    "scroll",
                                    anyhow::anyhow!(error),
                                    received,
                                )),
                                off_screen_note.clone(),
                            ));
                        }
                    }
                }
                Ok(None) => {
                    return Json(with_notes(
                        pointer_action_result(portal_action_error(
                            "scroll",
                            anyhow::anyhow!("the selected portal pointer backend was unavailable"),
                            received,
                        )),
                        off_screen_note,
                    ));
                }
                Err(error) => {
                    return Json(with_notes(
                        pointer_action_result(portal_start_error("scroll", error, received)),
                        off_screen_note,
                    ));
                }
            }
        }
        if target_point.is_some() && self.is_wayland_session() {
            return Json(unsafe_pointer_fallback("scroll", received));
        }
        let mut sequence = Vec::new();
        if let Some((x, y)) = target_point {
            sequence.push(absolute_mousemove_args(x, y));
        }
        sequence.push(wheel_mousemove_args(dx, dy));
        // X11: ydotool's absolute move warps through (0, 0), so the pointer
        // re-enters the window. GTK 3 resets its XI2 scroll valuators on that
        // enter, and the one wheel event only re-baselines them (delta 0).
        // The call reported success while the window did not move (#184).
        // XTEST wheel buttons have no valuators, so GTK takes the button path.
        let (input_guard, result) = run_cancellation_safe_input(input_guard, async move {
            run_ydotool_sequence(&sequence).await
        })
        .await;
        let _input_guard = input_guard;
        Json(with_notes(
            pointer_action_result(action_result("scroll", result, received)),
            off_screen_note,
        ))
    }

    #[tool(
        name = "drag",
        output_schema = rmcp::handler::server::tool::schema_for_output::<ActionToolOutput>(),
        description = "Drag from one point to another using pixel coordinates. Pass screenshot_after (true, \"screen\", or \"window\") or include_tree=true to return post-action observation in the same result.",
        annotations(
            read_only_hint = false,
            destructive_hint = true,
            idempotent_hint = false,
            open_world_hint = true
        )
    )]
    async fn drag(
        &self,
        Parameters(params): Parameters<DragParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let capture = params.capture.clone();
        let Json(output) = self.dispatch_drag(params).await;
        self.finish_action_output(output, &capture, None).await
    }

    async fn dispatch_drag(&self, params: DragParams) -> Json<ActionOutput> {
        let received = Some(serde_json::json!(params));
        let input_guard = Arc::clone(&self.input_operation_lock).lock_owned().await;
        let space = self.indicator_space();
        self.indicator
            .pointer("drag", (params.start_x, params.start_y), space)
            .await;
        // Lead the overlay cursor to the drop point while the drag runs.
        self.indicator
            .follow("drag", (params.end_x, params.end_y), space)
            .await;
        let input_guard = Arc::new(input_guard);
        if let Some(output) = self
            .pixelflux_send(
                "drag",
                crate::pixelflux::PixelfluxAction::Drag {
                    from: (params.start_x, params.start_y),
                    to: (params.end_x, params.end_y),
                },
                received.clone(),
                Arc::clone(&input_guard),
            )
            .await
        {
            return Json(output);
        }
        let mut input_guard = Arc::try_unwrap(input_guard)
            .unwrap_or_else(|_| panic!("pixelflux fallback must not retain dispatched input"));

        if self.should_prefer_xdotool_pointer() {
            let (input_guard, result) = run_cancellation_safe_input(input_guard, async move {
                run_xdotool_drag(
                    Path::new("xdotool"),
                    (params.start_x, params.start_y),
                    (params.end_x, params.end_y),
                )
                .await
            })
            .await;
            let _input_guard = input_guard;
            let mut output = pointer_action_result(action_result("drag", result, received));
            if output.ok {
                output.message =
                    "Drag dispatched through xdotool (X11 XTEST); verify the drop target."
                        .to_string();
            }
            return Json(output);
        }
        // Preferred backend: the uinput absolute pointer (accurate landing).
        if self.ensure_abs_pointer().await {
            let abs_pointer = Arc::clone(&self.abs_pointer);
            let start = (params.start_x, params.start_y);
            let end = (params.end_x, params.end_y);
            let (returned_guard, dragged) =
                run_cancellation_safe_guarded(input_guard, async move {
                    tokio::task::spawn_blocking(move || {
                        if let Ok(mut guard) = abs_pointer.lock() {
                            let result = guard.as_mut().map(|pointer| {
                                pointer
                                    .drag(start, end, crate::abs_pointer::PointerButton::Left)
                                    .map_err(|error| format!("{error:#}"))
                            });
                            if result.as_ref().is_some_and(Result::is_err) {
                                guard.take();
                            }
                            result
                        } else {
                            None
                        }
                    })
                    .await
                    .ok()
                    .flatten()
                })
                .await;
            let Some(returned_guard) = returned_guard else {
                return Json(action_result("drag", Err(dragged.unwrap_err()), received));
            };
            input_guard = returned_guard;
            match dragged {
                Ok(Some(Ok(()))) => {
                    return Json(pointer_action_result(ActionOutput {
                        ok: true,
                        implemented: true,
                        action: "drag".to_string(),
                        message: "Action sent through the uinput absolute pointer.".to_string(),
                        received,
                    }));
                }
                Ok(Some(Err(error))) => {
                    return Json(action_result(
                        "drag",
                        Err(format!(
                            "uinput drag may have started before it failed; the device was invalidated and input was not replayed through another backend: {error}"
                        )),
                        received,
                    ));
                }
                Ok(None) => {}
                Err(_) => unreachable!("missing guard already handled the guarded task failure"),
            }
        }
        if let Some(session) = self.cached_portal_pointer_session() {
            let _ = self.capture_space_rect().await;
            let Some((start_x, start_y)) =
                self.logical_portal_point(&session, params.start_x, params.start_y)
            else {
                self.clear_portal_pointer_session(&session);
                return Json(pointer_action_result(portal_coordinate_error(
                    "drag", received,
                )));
            };
            let Some((end_x, end_y)) =
                self.logical_portal_point(&session, params.end_x, params.end_y)
            else {
                self.clear_portal_pointer_session(&session);
                return Json(pointer_action_result(portal_coordinate_error(
                    "drag", received,
                )));
            };
            match portal_drag(
                &session,
                start_x,
                start_y,
                end_x,
                end_y,
                InputOperationGuard::new(input_guard),
            )
            .await
            {
                Ok(()) => {
                    return Json(pointer_action_result(ActionOutput {
                        ok: true,
                        implemented: true,
                        action: "drag".to_string(),
                        message: "Action sent through the remote desktop portal.".to_string(),
                        received,
                    }));
                }
                Err(error) => {
                    self.clear_portal_pointer_session(&session);
                    return Json(pointer_action_result(portal_action_error(
                        "drag", error, received,
                    )));
                }
            }
        } else if self.should_prefer_portal_pointer_backend().await {
            let _ = self.capture_space_rect().await;
            match self.ensure_portal_pointer_session().await {
                Ok(Some(session)) => {
                    let Some((start_x, start_y)) =
                        self.logical_portal_point(&session, params.start_x, params.start_y)
                    else {
                        self.clear_portal_pointer_session(&session);
                        return Json(pointer_action_result(portal_coordinate_error(
                            "drag", received,
                        )));
                    };
                    let Some((end_x, end_y)) =
                        self.logical_portal_point(&session, params.end_x, params.end_y)
                    else {
                        self.clear_portal_pointer_session(&session);
                        return Json(pointer_action_result(portal_coordinate_error(
                            "drag", received,
                        )));
                    };
                    match portal_drag(
                        &session,
                        start_x,
                        start_y,
                        end_x,
                        end_y,
                        InputOperationGuard::new(input_guard),
                    )
                    .await
                    {
                        Ok(()) => {
                            return Json(pointer_action_result(ActionOutput {
                                ok: true,
                                implemented: true,
                                action: "drag".to_string(),
                                message: "Action sent through the remote desktop portal."
                                    .to_string(),
                                received,
                            }));
                        }
                        Err(error) => {
                            self.clear_portal_pointer_session(&session);
                            return Json(pointer_action_result(portal_action_error(
                                "drag", error, received,
                            )));
                        }
                    }
                }
                Ok(None) => {
                    return Json(pointer_action_result(portal_action_error(
                        "drag",
                        anyhow::anyhow!("the selected portal pointer backend was unavailable"),
                        received,
                    )));
                }
                Err(error) => {
                    return Json(pointer_action_result(portal_start_error(
                        "drag", error, received,
                    )));
                }
            }
        }
        if self.is_wayland_session() {
            return Json(unsafe_pointer_fallback("drag", received));
        }
        let (input_guard, result) = run_cancellation_safe_input(input_guard, async move {
            run_ydotool_drag(params.start_x, params.start_y, params.end_x, params.end_y).await
        })
        .await;
        let _input_guard = input_guard;
        Json(pointer_action_result(action_result(
            "drag", result, received,
        )))
    }

    #[tool(
        name = "press_key",
        output_schema = rmcp::handler::server::tool::schema_for_output::<ActionToolOutput>(),
        description = "Press a key or key-combination on the keyboard, optionally after focusing a target window or terminal selector. Key grammar (case-insensitive; hyphens/spaces ignored): combos join with '+', e.g. Ctrl+L or Ctrl+Shift+T. Modifiers: ctrl/control, alt/option, shift, meta/super/cmd/command. Named keys: enter/return, escape/esc, tab, backspace, delete/del, space, home, end, pageup, pagedown, arrowleft/left, arrowright/right, arrowup/up, arrowdown/down, f1-f12. Plus single US letters a-z and digits 0-9. Anything else returns an error (never silently dropped). On Wayland, chords are sent through an active remote desktop portal keyboard session when one is available (or when ydotool is absent), falling back to ydotool otherwise. Portal chords send modifiers and named keys as keysyms so remapped keys (e.g. Caps Lock swapped with Control) follow the active keymap; letters and digits are physical US positions. Note: compositor-level shortcuts (e.g. Super+Up) may be consumed by GNOME before reaching the app. Pass screenshot_after (true, \"screen\", or \"window\") or include_tree=true to return post-action observation in the same result.",
        annotations(
            read_only_hint = false,
            destructive_hint = true,
            idempotent_hint = false,
            open_world_hint = true
        )
    )]
    async fn press_key(
        &self,
        Parameters(params): Parameters<PressKeyParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let capture = params.capture.clone();
        let target = params.window_target();
        let Json(output) = self.dispatch_press_key(params).await;
        self.finish_action_output(output, &capture, Some(&target))
            .await
    }

    async fn dispatch_press_key(&self, params: PressKeyParams) -> Json<ActionOutput> {
        let received = Some(serde_json::json!(params.clone()));
        let input_guard =
            InputOperationGuard::new(Arc::clone(&self.input_operation_lock).lock_owned().await);
        let window_target = params.window_target();
        let focus = match self.focus_target_for_input(&window_target).await {
            Ok(focus) => focus,
            Err(message) => {
                return Json(ActionOutput {
                    ok: false,
                    implemented: true,
                    action: "press_key".to_string(),
                    message,
                    received,
                });
            }
        };
        let Some((chord_modifiers, chord_key)) = key_chord(&params.key) else {
            return Json(ActionOutput {
                ok: false,
                implemented: true,
                action: "press_key".to_string(),
                message: "Unsupported key. Use names like Enter, Escape, Tab, ArrowLeft, Super, Ctrl+L, or a single US keyboard letter/digit.".to_string(),
                received,
            });
        };
        let secret = self.typing_into_secret(focus.as_ref()).await;
        self.indicator.keys(&params.key, secret).await;
        let input_guard = Arc::new(input_guard);
        if let Some(chord) = xdotool_key_spec(&params.key) {
            if let Some(output) = self
                .pixelflux_send(
                    "press_key",
                    crate::pixelflux::PixelfluxAction::Key { chord },
                    received.clone(),
                    Arc::clone(&input_guard),
                )
                .await
            {
                return Json(output);
            }
        }
        let input_guard = Arc::try_unwrap(input_guard)
            .unwrap_or_else(|_| panic!("pixelflux fallback must not retain dispatched input"));

        if self.should_prefer_portal_keyboard_for_chords().await {
            let portal_target = match self
                .portal_keyboard_target(&params.window_target(), focus.as_ref())
                .await
            {
                Ok(target) => target,
                Err(error) => {
                    return Json(action_result_with_focus(
                        "press_key",
                        Err(format!("{error:#}")),
                        received,
                        focus,
                    ))
                }
            };
            match self.ensure_portal_keyboard_session().await {
                Ok(Some(session)) => {
                    let focus = match self.focus_target_for_input(&portal_target).await {
                        Ok(focus) => focus,
                        Err(message) => {
                            return Json(action_result("press_key", Err(message), received))
                        }
                    };
                    // KDE keeps physical keycodes: its keysym path is untested
                    // here, and #191 was reported against mutter.
                    let (modifiers, key) = portal_key_chord(&params.key)
                        .filter(|_| !self.is_kde_wayland_session())
                        .unwrap_or_else(|| {
                            let modifiers = chord_modifiers
                                .iter()
                                .map(|m| PortalKey::Keycode(i32::from(*m)))
                                .collect();
                            (modifiers, PortalKey::Keycode(i32::from(chord_key)))
                        });
                    match press_key_chord(&session, &modifiers, key, Some(input_guard)).await {
                        Ok(()) => {
                            let notes = self.input_landing_notes(focus.as_ref(), false).await;
                            return Json(with_notes(
                                successful_action_with_focus(
                                    "press_key",
                                    "Action sent through the remote desktop portal.",
                                    received,
                                    focus,
                                ),
                                notes,
                            ));
                        }
                        Err(error) => {
                            self.clear_portal_keyboard_session(&session);
                            return Json(action_result_with_focus(
                                "press_key",
                                Err(format!("{error:#}")),
                                received,
                                focus,
                            ));
                        }
                    }
                }
                Ok(None) => {
                    return Json(action_result_with_focus(
                        "press_key",
                        Err("the selected portal keyboard backend was unavailable; input was not replayed through another backend".to_string()),
                        received,
                        focus,
                    ));
                }
                Err(error) => {
                    return Json(action_result_with_focus(
                        "press_key",
                        Err(format!("remote desktop portal keyboard initialization failed; input was not replayed through another backend: {error:#}")),
                        received,
                        focus,
                    ));
                }
            }
        }
        let Some(key_events) = key_sequence(&params.key) else {
            return Json(ActionOutput {
                ok: false,
                implemented: true,
                action: "press_key".to_string(),
                message: "Unsupported key. Use names like Enter, Escape, Tab, ArrowLeft, Super, Ctrl+L, or a single US keyboard letter/digit.".to_string(),
                received,
            });
        };
        if self.should_prefer_xdotool_keyboard() {
            if let Some(spec) = xdotool_key_spec(&params.key) {
                let xdotool_args = vec!["key".to_string(), "--clearmodifiers".to_string(), spec];
                let ydotool_args =
                    ydotool_key_args(key_events.clone(), !chord_modifiers.is_empty());
                let (input_guard, result) = run_cancellation_safe_input(input_guard, async move {
                    run_xdotool_or_fallback(Path::new("xdotool"), &xdotool_args, || {
                        run_ydotool(&ydotool_args)
                    })
                    .await
                })
                .await;
                let _input_guard = input_guard;
                let used_xdotool = result
                    .as_ref()
                    .is_ok_and(|result| result.backend == KeyboardCommandBackend::Xdotool);
                let mut output = action_result_with_focus(
                    "press_key",
                    result.map(|result| vec![result.output]),
                    received,
                    focus.clone(),
                );
                if used_xdotool {
                    output.message = "Action sent through xdotool (X11 XTEST).".to_string();
                }
                if output.ok && focus.is_some() {
                    let notes = self.input_landing_notes(focus.as_ref(), false).await;
                    output = with_notes(output, notes);
                }
                return Json(output);
            }
        }
        let args = ydotool_key_args(key_events, !chord_modifiers.is_empty());
        let (input_guard, result) = run_cancellation_safe_input(input_guard, async move {
            run_ydotool(&args).await.map(|output| vec![output])
        })
        .await;
        let _input_guard = input_guard;
        let mut output = action_result_with_focus("press_key", result, received, focus.clone());
        if output.ok && focus.is_some() {
            let notes = self.input_landing_notes(focus.as_ref(), false).await;
            output = with_notes(output, notes);
        }
        Json(output)
    }

    #[tool(
        name = "run_shell",
        description = "Execute one explicitly approved /bin/sh command with same-user host authority. This tool is absent unless the Codex operator starts the embedded server with CODEX_COMPUTER_USE_ENABLE_SHELL=1 (or the standalone COMPUTER_USE_LINUX_ENABLE_SHELL=1 compatibility alias). It is not sandboxed: the command can read or modify files and use the network with the server user's permissions. The inherited environment is cleared to a small desktop/runtime allowlist; pass any additional variables explicitly. Execution time and output are bounded: returned streams are truncated to 512 KiB, while a stream exceeding the 8 MiB collection ceiling fails the call without returning partial output. An audit digest is written to server stderr.",
        annotations(
            read_only_hint = false,
            destructive_hint = true,
            idempotent_hint = false,
            open_world_hint = true
        )
    )]
    async fn run_shell(
        &self,
        Parameters(params): Parameters<RunShellParams>,
    ) -> Json<RunShellOutput> {
        Json(execute_shell(params).await)
    }

    #[tool(
        name = "type_text",
        output_schema = rmcp::handler::server::tool::schema_for_output::<ActionToolOutput>(),
        description = "Type literal text using keyboard input, optionally after focusing a target window or terminal selector. Success confirms dispatch, not field-content verification; re-observe the target before retrying. X11 xdotool can silently substitute symbols under non-US or changing XKB layouts; inspect the text before pressing Enter or submitting it. The wtype backend rejects NUL and text over 131071 UTF-8 bytes before focus or indicators; Hyprland rejects confirmed password fields; ambiguous fields and terminals use private stdin for at most 100 Unicode characters per call. Pass screenshot_after (true, \"screen\", or \"window\") or include_tree=true to return post-action observation in the same result.",
        annotations(
            read_only_hint = false,
            destructive_hint = true,
            idempotent_hint = false,
            open_world_hint = true
        )
    )]
    async fn type_text(
        &self,
        Parameters(params): Parameters<TypeTextParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let capture = params.capture.clone();
        let target = params.window_target();
        let Json(mut output) = self.dispatch_type_text(params).await;
        if output.ok {
            output.message.push_str(
                " Field contents were not verified; re-observe the target before retrying.",
            );
        }
        self.finish_action_output(output, &capture, Some(&target))
            .await
    }

    async fn dispatch_type_text(&self, params: TypeTextParams) -> Json<ActionOutput> {
        let received = Some(serde_json::json!(params.clone()));
        // Reject before focus changes or any indicator can display the text.
        let wtype_mode = self.wtype_text_mode();
        if let Err(message) = preflight_type_text(&params.text, wtype_mode) {
            return Json(action_result("type_text", Err(message), received));
        }
        let input_guard =
            InputOperationGuard::new(Arc::clone(&self.input_operation_lock).lock_owned().await);
        let window_target = params.window_target();
        let focus = match self.focus_target_for_input(&window_target).await {
            Ok(focus) => focus,
            Err(message) => {
                return Json(ActionOutput {
                    ok: false,
                    implemented: true,
                    action: "type_text".to_string(),
                    message,
                    received,
                });
            }
        };
        let hyprland_argument_mode = wtype_mode == Some(WtypeTextMode::Argument);
        let (wtype_mode, secret) = if hyprland_argument_mode {
            match hyprland_wtype_delivery(&params.text, self.input_focus_probe(focus.as_ref()))
                .await
            {
                Ok(mode) => (Some(mode), mode == WtypeTextMode::Stdin),
                Err(message) => {
                    return Json(action_result_with_focus(
                        "type_text",
                        Err(message),
                        received,
                        focus,
                    ))
                }
            }
        } else {
            (wtype_mode, self.typing_into_secret(focus.as_ref()).await)
        };
        if let Some(mode) = wtype_mode {
            if let Err(message) = validate_wtype_privacy(mode, secret) {
                return Json(action_result_with_focus(
                    "type_text",
                    Err(message),
                    received,
                    focus,
                ));
            }
        }
        self.indicator.text("type_text", &params.text, secret).await;
        let input_guard = Arc::new(input_guard);
        if let Some(output) = self
            .pixelflux_send(
                "type_text",
                crate::pixelflux::PixelfluxAction::Type {
                    text: params.text.clone(),
                },
                received.clone(),
                Arc::clone(&input_guard),
            )
            .await
        {
            return Json(output);
        }
        let mut input_guard = Arc::try_unwrap(input_guard)
            .unwrap_or_else(|_| panic!("pixelflux fallback must not retain dispatched input"));

        if self.should_prefer_kde_clipboard_text_backend() {
            let portal_target = match self
                .portal_keyboard_target(&window_target, focus.as_ref())
                .await
            {
                Ok(target) => target,
                Err(error) => {
                    return Json(action_result_with_focus(
                        "type_text",
                        Err(format!("{error:#}")),
                        received,
                        focus,
                    ))
                }
            };
            match self.ensure_portal_keyboard_session().await {
                Ok(Some(session)) => {
                    let kde_focus = match self.focus_target_for_input(&portal_target).await {
                        Ok(focus) => focus,
                        Err(message) => {
                            return Json(action_result("type_text", Err(message), received))
                        }
                    };
                    let paste_shortcut =
                        kde_clipboard_paste_shortcut(&window_target, kde_focus.as_ref()).await;
                    let clipboard_guard = Arc::clone(&self.kde_clipboard_lock).lock_owned().await;
                    let session_for_input = session.clone();
                    let text = params.text.clone();
                    let portal_operation_guard = input_guard.clone();
                    let (guards, guarded_result) =
                        run_cancellation_safe_guarded((input_guard, clipboard_guard), async move {
                            run_kde_clipboard_paste_text(
                                &session_for_input,
                                &text,
                                paste_shortcut,
                                portal_operation_guard,
                            )
                            .await
                        })
                        .await;
                    let (returned_input_guard, clipboard_guard) = match guards {
                        Some(guards) => guards,
                        None => {
                            return Json(action_result_with_focus(
                                "type_text",
                                Err(guarded_result.unwrap_err()),
                                received,
                                kde_focus,
                            ));
                        }
                    };
                    input_guard = returned_input_guard;
                    drop(clipboard_guard);
                    let result = guarded_result.expect("guarded task returned its guards");
                    match result {
                        Ok(message) => {
                            let notes = self.input_landing_notes(kde_focus.as_ref(), true).await;
                            return Json(with_notes(
                                successful_action_with_focus(
                                    "type_text",
                                    &message,
                                    received,
                                    kde_focus,
                                ),
                                notes,
                            ));
                        }
                        Err(error) => {
                            if error.clear_portal_keyboard_session {
                                self.clear_portal_keyboard_session(&session);
                            }
                            if !error.can_fallback_to_ydotool {
                                return Json(action_result_with_focus(
                                    "type_text",
                                    Err(error.message),
                                    received,
                                    kde_focus,
                                ));
                            }
                        }
                    }
                }
                Ok(None) => {
                    return Json(action_result_with_focus(
                        "type_text",
                        Err("the selected KDE portal keyboard backend was unavailable; input was not replayed through another backend".to_string()),
                        received,
                        focus,
                    ));
                }
                Err(error) => {
                    return Json(action_result_with_focus(
                        "type_text",
                        Err(format!("KDE portal keyboard initialization failed; input was not replayed through another backend: {error:#}")),
                        received,
                        focus,
                    ));
                }
            }
        }
        if self.should_prefer_portal_text_backend() {
            let mut focus = focus;
            let result = async {
                let portal_target = self
                    .portal_keyboard_target(&window_target, focus.as_ref())
                    .await
                    .map_err(|error| format!("{error:#}"))?;
                let keysyms = keysyms_for_text(&params.text)
                    .map_err(|error| format!("Literal text was not sent: {error:#}"))?;
                if self.is_gnome_wayland_session() {
                    crate::keyboard_keymap::validate_gnome_text(&params.text, &keysyms)
                        .await
                        .map_err(|error| format!("Literal text was not sent: {error:#}"))?;
                }
                let session = self
                    .ensure_portal_keyboard_session()
                    .await
                    .map_err(|error| format!("Portal text input could not start: {error:#}"))?
                    .ok_or_else(|| {
                        "Portal keyboard input is unavailable; no text was sent.".to_string()
                    })?;
                focus = self.focus_target_for_input(&portal_target).await?;
                type_text_with_keysyms(&session, &keysyms, Some(input_guard))
                    .await
                    .map_err(|error| {
                        self.clear_portal_keyboard_session(&session);
                        format!("{error:#}")
                    })
            }
            .await;
            return Json(match result {
                Ok(()) => {
                    let notes = self.input_landing_notes(focus.as_ref(), true).await;
                    with_notes(
                        successful_action_with_focus(
                            "type_text",
                            "Action sent through the remote desktop portal.",
                            received,
                            focus,
                        ),
                        notes,
                    )
                }
                Err(error) => action_result_with_focus("type_text", Err(error), received, focus),
            });
        }
        if self.should_prefer_xdotool_keyboard() {
            let delay_ms = xdotool_type_delay_ms();
            let args = xdotool_type_args_with_delay(&params.text, delay_ms);
            let command_timeout = xdotool_type_timeout(&params.text, delay_ms);
            let text = params.text.clone();
            let (input_guard, result) = run_cancellation_safe_input(input_guard, async move {
                run_xdotool_type_with_input_check(
                    Path::new("xdotool"),
                    &args,
                    command_timeout,
                    || run_ydotool_type_text(&text),
                )
                .await
            })
            .await;
            let _input_guard = input_guard;
            let used_xdotool = result
                .as_ref()
                .is_ok_and(|(result, _)| result.backend == KeyboardCommandBackend::Xdotool);
            let layout_warning = result
                .as_ref()
                .ok()
                .and_then(|(_, warning)| warning.clone());
            let mut output = action_result_with_focus(
                "type_text",
                result.map(|(result, _)| vec![result.output]),
                received,
                focus.clone(),
            );
            if used_xdotool {
                output.message = "Action sent through xdotool (X11 XTEST). WARNING: X11 keyboard layout fidelity is unverified. xdotool can silently substitute symbols under non-US XKB layouts (reported with br/ABNT2) or changing keymap state. Re-observe the text before pressing Enter, submitting it, or treating it as delivered; do not retry blindly.".to_string();
            }
            if let Some(warning) = layout_warning {
                output = with_notes(output, vec![warning]);
            }
            if output.ok && focus.is_some() {
                let notes = self.input_landing_notes(focus.as_ref(), true).await;
                output = with_notes(output, notes);
            }
            return Json(output);
        }
        if let Some(mode) = wtype_mode {
            let text = params.text.clone();
            let (input_guard, result) = run_cancellation_safe_input(input_guard, async move {
                run_wtype_type_text_or_fallback(Path::new("wtype"), &text, mode, secret, || {
                    run_ydotool_type_text(&text)
                })
                .await
            })
            .await;
            let _input_guard = input_guard;
            let used_wtype = result
                .as_ref()
                .is_ok_and(|result| result.backend == KeyboardCommandBackend::Wtype);
            let mut output = action_result_with_focus(
                "type_text",
                result.map(|result| vec![result.output]),
                received,
                focus.clone(),
            );
            if used_wtype {
                output.message =
                    "Action sent through wtype (Wayland virtual-keyboard protocol).".to_string();
                if hyprland_argument_mode && mode == WtypeTextMode::Stdin {
                    output.message.push_str(" AT-SPI could not classify the field; text was sent through stdin, limited to 100 Unicode characters per call.");
                }
            }
            if output.ok && focus.is_some() {
                let notes = self.input_landing_notes(focus.as_ref(), true).await;
                output = with_notes(output, notes);
            }
            return Json(output);
        }
        let text = params.text.clone();
        let (input_guard, result) = run_cancellation_safe_input(input_guard, async move {
            run_ydotool_type_text(&text)
                .await
                .map(|output| vec![output])
        })
        .await;
        let _input_guard = input_guard;
        let mut output = action_result_with_focus("type_text", result, received, focus.clone());
        if output.ok && focus.is_some() {
            let notes = self.input_landing_notes(focus.as_ref(), true).await;
            output = with_notes(output, notes);
        }
        Json(output)
    }

    #[tool(
        name = "move_window",
        output_schema = rmcp::handler::server::tool::schema_for_output::<WindowGeometryToolOutput>(),
        description = "Move a window to a new desktop position (frame top-left in desktop coordinates). Useful to recover windows that are partially off-screen. Works through the Codex GNOME Shell extension or a generic X11/EWMH window manager (wmctrl). Pass screenshot_after (true, \"screen\", or \"window\") or include_tree=true to return post-action observation in the same result.",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = true
        )
    )]
    async fn move_window(
        &self,
        Parameters(params): Parameters<MoveWindowParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let capture = params.target.capture.clone();
        let received = Some(serde_json::json!(params.clone()));
        let target = params.target.into_target();
        self.indicator.action("move_window").await;
        let Json(output) = self
            .window_geometry_op(received, &target, |window| async move {
                registry::move_window(&window, params.x, params.y).await
            })
            .await;
        self.finish_window_geometry_output(output, &capture, &target)
            .await
    }

    #[tool(
        name = "resize_window",
        output_schema = rmcp::handler::server::tool::schema_for_output::<WindowGeometryToolOutput>(),
        description = "Resize a window to a new frame width/height in desktop pixels, unmaximizing it first if needed. Useful to fit a window fully on-screen. Works through the Codex GNOME Shell extension or a generic X11/EWMH window manager (wmctrl). Pass screenshot_after (true, \"screen\", or \"window\") or include_tree=true to return post-action observation in the same result.",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = true
        )
    )]
    async fn resize_window(
        &self,
        Parameters(params): Parameters<ResizeWindowParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let capture = params.target.capture.clone();
        let received = Some(serde_json::json!(params.clone()));
        let target = params.target.into_target();
        self.indicator.action("resize_window").await;
        let Json(output) = self
            .window_geometry_op(received, &target, |window| async move {
                registry::resize_window(&window, params.width, params.height).await
            })
            .await;
        self.finish_window_geometry_output(output, &capture, &target)
            .await
    }
}

#[tool_handler(
    router = self.mcp_tool_router(),
    name = "codex-computer-use-linux",
    // NOTE: keep in lockstep with Cargo.toml + package.json on every release.
    // The rmcp tool_handler macro only accepts a string literal here, so this
    // can't be env!("CARGO_PKG_VERSION"); the MCP safety check (CI) fails the
    // build if it drifts from the Cargo version.
    version = "0.7.33",
    instructions = "Begin every turn that uses Computer Use by calling get_app_state. If diagnostics report disabled GNOME accessibility, call setup_accessibility before asking the user to retry. Use list_windows/focused_window before targeted keyboard input. If diagnostics report windowing.can_list_windows=false on GNOME, call setup_window_targeting to install the optional GNOME Shell extension backend, then ask the user to log out and back in if the setup report says a shell reload is required. This Linux backend can capture size-bounded screenshots through GNOME Shell or XDG Desktop Portal, read AT-SPI trees with action/value metadata, invoke native AT-SPI actions, set AT-SPI values or editable text, list/focus compositor windows through registered Linux window backends when the session permits it, attach best-effort terminal tty/process metadata to terminal windows, send coordinate or element-targeted click/scroll/drag input through the Wayland remote desktop portal when available, and send literal type_text through KDE clipboard integration on Plasma Wayland, wtype on compatible Wayland compositors, or portal keysyms on other Wayland sessions. Portal text startup or conversion failures return an error without replaying through ydotool. GNOME preflights the complete text against every configured keyboard layout group because the background reader cannot establish the active group; rejected text can use set_value on an editable field. Raw ydotool text is limited to printable ASCII, tab and newline, uses US physical key positions, and requires checking the resulting field contents under the active layout. Screenshot results include width/height for the returned image plus coordinate_width/coordinate_height and scale for desktop coordinate conversion; request more detail with max_width, max_height, max_bytes, format=jpeg, quality, or a smaller target/crop instead of relying on unbounded screenshots. Mutating tools (click, type_text, press_key, scroll, drag, perform_action, set_value, activate_window, move_window, resize_window) accept optional screenshot_after (true, \"screen\", or \"window\") with format/quality/scale/max_width/max_height/max_bytes and optional include_tree=true to return post-action observation in the same tool call. Tools with readOnlyHint=false may mutate local desktop or application state; hosts should require approval for actions that can submit, delete, send, purchase, or overwrite data. For element-targeted actions, prefer element_index from the latest get_app_state result; click, perform_action, and set_value can also use semantic role/name/text/states selectors when the target is unique. type_text and press_key accept optional window_id, pid, app_id, wm_class, title, tty, terminal_pid, terminal_command, or terminal_cwd selectors and refuse targeted input if focus cannot be verified. After targeted keyboard input, results append focused-element feedback from AT-SPI (role, name, editable) and warn when a concrete non-terminal focus is not editable. Exact window focus alone does not suppress a missing-focus warning; only a complete scoped tree containing window/menu chrome without content makes it informational. Terminals accept keyboard input without an EditableText interface. On Hyprland, wtype uses a single literal argument after -- to avoid stdin keymap-refresh corruption; text is visible in process arguments, so confirmed password fields are rejected (use set_value). Terminals and ambiguous fields, with or without AT-SPI, use private stdin for at most 100 Unicode characters per call; split larger input into smaller calls or expose accessibility. Input classification has its own 1500 ms budget, independent of the 250 ms cosmetic indicator timeout. Other compatible compositors retain stdin. The wtype path rejects NUL and more than 131071 UTF-8 bytes before focus or indicators. X11 xdotool can silently substitute symbols under non-US XKB layouts (reported with br/ABNT2) or changing keymap state; inspect the text before pressing Enter or submitting it. A successful type_text result confirms dispatch only; every text backend leaves field contents unverified. Re-observe the target before retrying. Screenshot, click, and input results warn when the target window or coordinate is partially or fully off-screen; use move_window/resize_window (GNOME Shell extension backend) to bring a window fully on-screen before retrying. scroll accepts the same window targeting and relative coordinates as click. get_app_state returns a compact readiness block by default; pass verbose=true for the full diagnostics dump. Scope get_app_state with app_name_or_bundle_identifier or a window target (window_id, pid, app_id, wm_class, title); without one it returns the whole desktop AT-SPI tree, reports tree_scoped=false, and warns in message, which can flood context. accessibility_tree_truncated=true means the node, depth, read, or time budget stopped traversal with unread elements left; recover by scoping to a narrower app or window target and raising max_nodes or max_depth (hard caps 10000 and 64), not by lowering max_nodes. A compacted tree too large to return inline comes back as its leading nodes plus accessibility_tree_spill.path, a private JSON file with the whole tree and the same element_index values; search that file instead of requesting the tree again, or page through it with get_tree_page when files are not readable. Electron apps with only window/menu chrome may need --force-renderer-accessibility to expose renderer content. run_shell is absent unless CODEX_COMPUTER_USE_ENABLE_SHELL=1 or the standalone COMPUTER_USE_LINUX_ENABLE_SHELL=1 compatibility alias; when enabled it is same-user arbitrary host execution, not a sandbox, and hosts should require explicit approval."
)]
impl ServerHandler for ComputerUseLinux {}

fn shell_execution_enabled() -> bool {
    let value = env::var(SHELL_ENABLE_ENV)
        .ok()
        .or_else(|| env::var(SHELL_ENABLE_ENV_STANDALONE).ok());
    shell_execution_enabled_value(value.as_deref())
}

fn shell_execution_enabled_value(value: Option<&str>) -> bool {
    value == Some("1")
}

fn completion_notifications_enabled() -> bool {
    completion_notifications_enabled_value(
        env::var(COMPLETION_ENABLE_ENV).ok().as_deref(),
        env::var(COMPLETION_ENABLE_ENV_STANDALONE).ok().as_deref(),
    )
}

fn completion_notifications_enabled_value(primary: Option<&str>, standalone: Option<&str>) -> bool {
    primary.or(standalone) == Some("1")
}

#[derive(Debug, Serialize, JsonSchema)]
struct CompletionOutput {
    ok: bool,
    cue: String,
    note: String,
}

async fn send_completion_notification(program: &Path, limit: Duration) -> CompletionOutput {
    let mut command = TokioCommand::new(program);
    command.args([
        "--app-name=codex-computer-use-linux",
        "--expire-time=3000",
        "Desktop interaction finished",
        "The agent has finished its desktop interaction.",
    ]);
    let sent =
        crate::command_runner::output_with_timeout(command, "send completion notification", limit)
            .await;
    match sent {
        Ok(output) if output.status.success() => CompletionOutput {
            ok: true,
            cue: "notification".into(),
            note: "Notification submitted; desktop settings control whether it is displayed."
                .into(),
        },
        _ => CompletionOutput {
            ok: true,
            cue: "skipped".into(),
            note:
                "Notification unavailable, failed, or timed out. The interaction is still complete."
                    .into(),
        },
    }
}

fn valid_environment_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|first| first == '_' || first.is_ascii_alphabetic())
        && chars.all(|character| character == '_' || character.is_ascii_alphanumeric())
}

fn inherited_shell_environment_allowed(name: &str) -> bool {
    matches!(
        name,
        "PATH"
            | "HOME"
            | "USER"
            | "LOGNAME"
            | "LANG"
            | "TERM"
            | "XDG_RUNTIME_DIR"
            | "DISPLAY"
            | "WAYLAND_DISPLAY"
            | "DBUS_SESSION_BUS_ADDRESS"
    ) || name.starts_with("LC_")
}

fn inherited_shell_environment(
    variables: impl IntoIterator<Item = (OsString, OsString)>,
) -> Vec<(String, String)> {
    variables
        .into_iter()
        .filter_map(|(name, value)| {
            let (Ok(name), Ok(value)) = (name.into_string(), value.into_string()) else {
                return None;
            };
            inherited_shell_environment_allowed(&name).then_some((name, value))
        })
        .collect()
}

fn shell_command_sha256(command: &str) -> String {
    Sha256::digest(command.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn bounded_shell_stream(bytes: &[u8]) -> (String, bool) {
    let truncated = bytes.len() > SHELL_RESPONSE_STREAM_BYTES;
    let visible = if truncated {
        &bytes[..SHELL_RESPONSE_STREAM_BYTES]
    } else {
        bytes
    };
    (String::from_utf8_lossy(visible).into_owned(), truncated)
}

fn shell_error_output(
    command_sha256: String,
    cwd: String,
    timeout_seconds: u64,
    error: impl Into<String>,
) -> RunShellOutput {
    RunShellOutput {
        ok: false,
        command_sha256,
        cwd,
        timeout_seconds,
        exit_code: None,
        stdout: String::new(),
        stderr: String::new(),
        stdout_truncated: false,
        stderr_truncated: false,
        error: Some(error.into()),
    }
}

async fn execute_shell(params: RunShellParams) -> RunShellOutput {
    let command_sha256 = shell_command_sha256(&params.command);
    let timeout_seconds = params.timeout_seconds.unwrap_or(SHELL_DEFAULT_TIMEOUT_SECS);
    let requested_cwd = params.cwd.as_deref().unwrap_or(".").to_string();

    if !shell_execution_enabled() {
        return shell_error_output(
            command_sha256,
            requested_cwd,
            timeout_seconds,
            format!(
                "shell execution is disabled; restart the MCP server with {SHELL_ENABLE_ENV}=1 to opt in"
            ),
        );
    }
    if params.command.trim().is_empty() {
        return shell_error_output(
            command_sha256,
            requested_cwd,
            timeout_seconds,
            "command must not be empty",
        );
    }
    if params.command.len() > SHELL_MAX_COMMAND_BYTES {
        return shell_error_output(
            command_sha256,
            requested_cwd,
            timeout_seconds,
            format!("command exceeds the {SHELL_MAX_COMMAND_BYTES}-byte limit"),
        );
    }
    if requested_cwd.len() > SHELL_MAX_CWD_BYTES {
        return shell_error_output(
            command_sha256,
            "<rejected: cwd too long>".to_string(),
            timeout_seconds,
            format!("cwd exceeds the {SHELL_MAX_CWD_BYTES}-byte limit"),
        );
    }
    if !(1..=SHELL_MAX_TIMEOUT_SECS).contains(&timeout_seconds) {
        return shell_error_output(
            command_sha256,
            requested_cwd,
            timeout_seconds,
            format!("timeout_seconds must be between 1 and {SHELL_MAX_TIMEOUT_SECS}"),
        );
    }
    if params.env.len() > SHELL_MAX_ENV_ENTRIES {
        return shell_error_output(
            command_sha256,
            requested_cwd,
            timeout_seconds,
            format!("env contains more than {SHELL_MAX_ENV_ENTRIES} entries"),
        );
    }
    let env_bytes = params
        .env
        .iter()
        .map(|(name, value)| name.len().saturating_add(value.len()))
        .sum::<usize>();
    if env_bytes > SHELL_MAX_ENV_BYTES {
        return shell_error_output(
            command_sha256,
            requested_cwd,
            timeout_seconds,
            format!("env exceeds the {SHELL_MAX_ENV_BYTES}-byte limit"),
        );
    }
    if let Some(invalid) = params.env.keys().find(|name| !valid_environment_name(name)) {
        return shell_error_output(
            command_sha256,
            requested_cwd,
            timeout_seconds,
            format!("invalid environment variable name: {invalid}"),
        );
    }

    let cwd = match fs::canonicalize(&requested_cwd) {
        Ok(path) if path.is_dir() => path,
        Ok(_) => {
            return shell_error_output(
                command_sha256,
                requested_cwd,
                timeout_seconds,
                "cwd is not a directory",
            )
        }
        Err(error) => {
            return shell_error_output(
                command_sha256,
                requested_cwd,
                timeout_seconds,
                format!("failed to resolve cwd: {error}"),
            )
        }
    };
    let cwd_display = cwd.display().to_string();

    let mut child = TokioCommand::new("/bin/sh");
    // Do not use a login shell: profile scripts could reintroduce credentials
    // after env_clear() and contaminate or prevent the requested command.
    child.args(["-c", &params.command]);
    child.current_dir(&cwd);
    child.env_clear();
    let mut inherited_path = false;
    for (name, value) in inherited_shell_environment(env::vars_os()) {
        inherited_path |= name == "PATH";
        child.env(name, value);
    }
    if !inherited_path {
        child.env("PATH", "/usr/local/bin:/usr/bin:/bin");
    }
    child.envs(&params.env);

    eprintln!(
        "[codex-computer-use-linux] run_shell start sha256={command_sha256} cwd={cwd_display:?} timeout_seconds={timeout_seconds}"
    );
    match crate::command_runner::output_with_timeout(
        child,
        "run approved shell command",
        Duration::from_secs(timeout_seconds),
    )
    .await
    {
        Ok(output) => {
            let exit_code = output.status.code();
            let (stdout, stdout_truncated) = bounded_shell_stream(&output.stdout);
            let (stderr, stderr_truncated) = bounded_shell_stream(&output.stderr);
            eprintln!(
                "[codex-computer-use-linux] run_shell finish sha256={command_sha256} exit_code={exit_code:?} stdout_bytes={} stderr_bytes={} stdout_truncated={stdout_truncated} stderr_truncated={stderr_truncated}",
                output.stdout.len(),
                output.stderr.len()
            );
            RunShellOutput {
                ok: output.status.success(),
                command_sha256,
                cwd: cwd_display,
                timeout_seconds,
                exit_code,
                stdout,
                stderr,
                stdout_truncated,
                stderr_truncated,
                error: None,
            }
        }
        Err(error) => {
            let error = format!("{error:#}");
            eprintln!(
                "[codex-computer-use-linux] run_shell error sha256={command_sha256} error={error:?}"
            );
            shell_error_output(command_sha256, cwd_display, timeout_seconds, error)
        }
    }
}

pub async fn serve_mcp() -> Result<()> {
    let server = ComputerUseLinux::default();
    let indicator = Arc::clone(&server.indicator);
    let tree_spiller = Arc::clone(&server.tree_spiller);
    tree_spiller.sweep();
    let running = server.serve(rmcp::transport::stdio()).await?;
    // Legacy initialization supplies the client name through the peer.
    // Discovery-only hosts use the indicator's configured name or Agent fallback.
    indicator.attach(running.peer().clone());
    // Hosts stop servers by closing stdin or with SIGTERM/SIGINT; a spilled
    // tree is removed either way.
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    let mut interrupt = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())?;
    let signal = tokio::select! {
        result = running.waiting() => {
            tree_spiller.remove_current();
            result?;
            return Ok(());
        }
        _ = terminate.recv() => libc::SIGTERM,
        _ = interrupt.recv() => libc::SIGINT,
    };
    tree_spiller.remove_current();
    // Exit now: returning would wait forever for the stdin reader thread.
    std::process::exit(128 + signal);
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
struct ListAppsOutput {
    apps: Vec<AppCandidate>,
    accessible_apps: Vec<AccessibleAppSummary>,
    accessibility_error: Option<String>,
    note: String,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
struct ListWindowsOutput {
    backend: String,
    windows: Vec<WindowInfo>,
    error: Option<String>,
    permissions_hint: Option<String>,
    note: String,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
struct FocusedWindowOutput {
    backend: String,
    focused_window: Option<WindowInfo>,
    error: Option<String>,
    permissions_hint: Option<String>,
    message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
enum ScreenshotAfterScope {
    Window,
    Screen,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(untagged)]
enum ScreenshotAfter {
    Enabled(bool),
    Scope(ScreenshotAfterScope),
}

impl ScreenshotAfter {
    fn resolve(self) -> Option<ScreenshotAfterScope> {
        match self {
            Self::Enabled(false) => None,
            Self::Enabled(true) => Some(ScreenshotAfterScope::Screen),
            Self::Scope(scope) => Some(scope),
        }
    }
}

fn optional_screenshot_after_schema(_gen: &mut schemars::SchemaGenerator) -> schemars::Schema {
    schemars::json_schema!({
        "description": "Capture and return a post-action screenshot in the same result: true or \"screen\" captures the full desktop; \"window\" crops to the action's target window (or the focused window when untargeted); false or null disables capture.",
        "anyOf": [
            { "type": "boolean" },
            { "type": "string", "enum": ["window", "screen"] },
            { "type": "null" }
        ]
    })
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, JsonSchema)]
struct PostActionCaptureParams {
    /// Capture and return a post-action screenshot in the same result: `true` or
    /// `"screen"` captures the full desktop; `"window"` crops to the action's
    /// target window (or the focused window when untargeted); `false` disables capture.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "optional_screenshot_after_schema")]
    screenshot_after: Option<ScreenshotAfter>,
    /// Maximum returned post-action screenshot width in pixels (default 1920, hard-capped).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    max_width: Option<u32>,
    /// Maximum returned post-action screenshot height in pixels (default 1920, hard-capped).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    max_height: Option<u32>,
    /// Maximum returned post-action screenshot image bytes before base64 (default 2 MiB, hard-capped).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    max_bytes: Option<usize>,
    /// Additional downscale factor from 0.0 to 1.0, applied before max dimensions.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    scale: Option<f32>,
    /// Post-action screenshot image format (default png). Use jpeg with quality to trade exact pixels for smaller payloads.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    format: Option<ScreenshotOutputFormat>,
    /// JPEG quality from 1 to 95 (default 80) for post-action screenshots. Ignored for png.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 1, max = 95))]
    quality: Option<u8>,
    /// Include a fresh compacted AT-SPI accessibility tree snapshot after the action (default false). Also refreshes cached element_index values.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    include_tree: Option<bool>,
}

impl PostActionCaptureParams {
    fn screenshot_scope(&self) -> Option<ScreenshotAfterScope> {
        self.screenshot_after.and_then(ScreenshotAfter::resolve)
    }

    fn screenshot_options(&self) -> ScreenshotPayloadOptions {
        ScreenshotPayloadOptions {
            max_width: self.max_width,
            max_height: self.max_height,
            max_bytes: self.max_bytes,
            scale: self.scale,
            format: self.format,
            quality: self.quality,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, JsonSchema)]
struct PostActionObservation {
    /// Post-action screenshot metadata when `screenshot_after` was requested; the image itself is the first `image` content block.
    #[serde(skip_serializing_if = "Option::is_none")]
    screenshot: Option<ScreenshotSummary>,
    /// Post-action screenshot capture error when a requested `screenshot_after` capture failed.
    #[serde(skip_serializing_if = "Option::is_none")]
    screenshot_error: Option<String>,
    /// Post-action compacted AT-SPI accessibility tree when `include_tree=true` was requested.
    #[serde(skip_serializing_if = "Option::is_none")]
    accessibility_tree: Option<Vec<AccessibilityNode>>,
    /// Raw AT-SPI node count before compaction when `include_tree=true` was requested.
    #[serde(skip_serializing_if = "Option::is_none")]
    accessibility_tree_raw_count: Option<usize>,
    /// Set when the post-action tree was too large to return inline: the whole
    /// tree is in this private file, with the same element_index values.
    #[serde(skip_serializing_if = "Option::is_none")]
    accessibility_tree_spill: Option<crate::tree_spill::TreeSpill>,
    /// True when the post-action accessibility tree was scoped to the target app/window.
    #[serde(skip_serializing_if = "Option::is_none")]
    tree_scoped: Option<bool>,
    /// True when the post-action accessibility tree hit traversal limits.
    #[serde(skip_serializing_if = "Option::is_none")]
    accessibility_tree_truncated: Option<bool>,
    /// Post-action AT-SPI error when a requested `include_tree=true` capture failed.
    #[serde(skip_serializing_if = "Option::is_none")]
    accessibility_error: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, JsonSchema)]
struct ActivateWindowParams {
    #[serde(default)]
    window_id: Option<u64>,
    #[serde(default)]
    pid: Option<u32>,
    #[serde(default)]
    tty: Option<String>,
    #[serde(default)]
    terminal_pid: Option<u32>,
    #[serde(default)]
    terminal_command: Option<String>,
    #[serde(default)]
    terminal_cwd: Option<String>,
    #[serde(default)]
    app_id: Option<String>,
    #[serde(default)]
    wm_class: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(flatten)]
    capture: PostActionCaptureParams,
}

impl ActivateWindowParams {
    fn into_target(self) -> WindowTarget {
        WindowTarget {
            window_id: self.window_id,
            pid: self.pid,
            tty: self.tty,
            terminal_pid: self.terminal_pid,
            terminal_command: self.terminal_command,
            terminal_cwd: self.terminal_cwd,
            app_id: self.app_id,
            wm_class: self.wm_class,
            title: self.title,
        }
    }
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
struct ActivateWindowOutput {
    ok: bool,
    implemented: bool,
    backend: String,
    focus: Option<WindowFocusResult>,
    error: Option<String>,
    permissions_hint: Option<String>,
    // Echo of the request for debugging. `serde_json::Value` has no fixed JSON
    // schema, which strict MCP clients (Claude Code) reject in `outputSchema` —
    // and one invalid tool fails the whole tool list. Keep it in the runtime
    // response (serde) but omit it from the generated schema.
    #[schemars(skip)]
    received: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
struct ActivateWindowToolOutput {
    #[serde(flatten)]
    output: ActivateWindowOutput,
    /// Post-action observation notes (off-screen warnings, tree warnings, or capture errors) when present.
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
    #[serde(flatten)]
    observation: PostActionObservation,
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
struct MoveWindowParams {
    #[serde(flatten)]
    target: ActivateWindowParams,
    /// New frame-left in desktop coordinates.
    x: i32,
    /// New frame-top in desktop coordinates.
    y: i32,
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
struct ResizeWindowParams {
    #[serde(flatten)]
    target: ActivateWindowParams,
    /// New frame width in desktop pixels.
    width: i32,
    /// New frame height in desktop pixels.
    height: i32,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
struct WindowGeometryOutput {
    ok: bool,
    implemented: bool,
    backend: String,
    /// Post-operation window info (compositor-final geometry).
    window: Option<WindowInfo>,
    message: String,
    permissions_hint: Option<String>,
    #[schemars(skip)]
    received: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
struct WindowGeometryToolOutput {
    #[serde(flatten)]
    output: WindowGeometryOutput,
    #[serde(flatten)]
    observation: PostActionObservation,
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
struct RunShellParams {
    /// Shell program text passed to `/bin/sh -c` without loading login profiles.
    command: String,
    /// Existing directory in which to start the shell. Symlinks are resolved.
    #[serde(default)]
    cwd: Option<String>,
    /// Additional environment entries. The ambient process environment is not inherited wholesale.
    #[serde(default)]
    env: BTreeMap<String, String>,
    /// Wall-clock timeout in seconds (default 30, maximum 120).
    #[serde(default)]
    timeout_seconds: Option<u64>,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
struct RunShellOutput {
    ok: bool,
    command_sha256: String,
    cwd: String,
    timeout_seconds: u64,
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
    stdout_truncated: bool,
    stderr_truncated: bool,
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
struct AppCandidate {
    name: String,
    pid: u32,
    command: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
struct GetAppStateParams {
    /// App name or AT-SPI id that limits the accessibility tree. Omit only when
    /// you need the whole desktop tree; unscoped results can flood context.
    #[serde(default)]
    app_name_or_bundle_identifier: Option<String>,
    /// Compositor window id. Also scopes the accessibility tree to that window's
    /// application when possible.
    #[serde(default)]
    window_id: Option<u64>,
    /// Process id. Also scopes the accessibility tree to that process when it
    /// exposes AT-SPI.
    #[serde(default)]
    pid: Option<u32>,
    /// Terminal tty device (for example /dev/pts/3). Resolves a window target
    /// and scopes the tree when possible.
    #[serde(default)]
    tty: Option<String>,
    /// Terminal emulator pid. Resolves a window target and scopes the tree when
    /// possible.
    #[serde(default)]
    terminal_pid: Option<u32>,
    /// Terminal command substring. Resolves a window target and scopes the tree
    /// when possible.
    #[serde(default)]
    terminal_command: Option<String>,
    /// Terminal working directory. Resolves a window target and scopes the tree
    /// when possible.
    #[serde(default)]
    terminal_cwd: Option<String>,
    /// Application id. Also scopes the accessibility tree when it matches an
    /// AT-SPI root.
    #[serde(default)]
    app_id: Option<String>,
    /// Window manager class. Also scopes the accessibility tree when it matches
    /// an AT-SPI root.
    #[serde(default)]
    wm_class: Option<String>,
    /// Window title substring. Also scopes the accessibility tree when it
    /// matches an AT-SPI root.
    #[serde(default)]
    title: Option<String>,
    /// Maximum raw AT-SPI nodes to inspect before compaction (default 1000, hard max 10000).
    #[serde(default)]
    max_nodes: Option<usize>,
    /// Maximum AT-SPI traversal depth (default 32, hard max 64).
    #[serde(default)]
    max_depth: Option<u32>,
    /// Include a size-bounded screenshot (default true). Set false when the
    /// accessibility tree is enough.
    #[serde(default)]
    include_screenshot: Option<bool>,
    /// Maximum returned screenshot width in pixels (default 1920, hard-capped).
    #[serde(default)]
    max_width: Option<u32>,
    /// Maximum returned screenshot height in pixels (default 1920, hard-capped).
    #[serde(default)]
    max_height: Option<u32>,
    /// Maximum returned screenshot image bytes before base64 (default 2 MiB, hard-capped).
    #[serde(default)]
    max_bytes: Option<usize>,
    /// Additional downscale factor from 0.0 to 1.0, applied before max dimensions.
    #[serde(default)]
    scale: Option<f32>,
    /// Output image format (default png). Use jpeg with quality to trade exact pixels for smaller payloads.
    #[serde(default)]
    format: Option<ScreenshotOutputFormat>,
    /// JPEG quality from 1 to 95 (default 80). Ignored for png.
    #[serde(default)]
    #[schemars(range(min = 1, max = 95))]
    quality: Option<u8>,
    /// Include the full diagnostics report (large). Default false: only the
    /// compact readiness block is returned.
    #[serde(default)]
    verbose: Option<bool>,
}

impl GetAppStateParams {
    fn window_target(&self) -> WindowTarget {
        WindowTarget {
            window_id: self.window_id,
            pid: self.pid,
            tty: self.tty.clone(),
            terminal_pid: self.terminal_pid,
            terminal_command: self.terminal_command.clone(),
            terminal_cwd: self.terminal_cwd.clone(),
            app_id: self.app_id.clone(),
            wm_class: self.wm_class.clone(),
            title: self.title.clone(),
        }
    }

    fn screenshot_options(&self) -> ScreenshotPayloadOptions {
        ScreenshotPayloadOptions {
            max_width: self.max_width,
            max_height: self.max_height,
            max_bytes: self.max_bytes,
            scale: self.scale,
            format: self.format,
            quality: self.quality,
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, JsonSchema)]
struct ScreenshotParams {
    #[serde(default)]
    window_id: Option<u64>,
    #[serde(default)]
    pid: Option<u32>,
    #[serde(default)]
    app_id: Option<String>,
    #[serde(default)]
    wm_class: Option<String>,
    #[serde(default)]
    title: Option<String>,
    /// Raise the targeted window before capture (default true). Ignored without
    /// a window target.
    #[serde(default)]
    raise_window: Option<bool>,
    /// Capture the whole desktop even when a window is targeted (default false).
    #[serde(default)]
    full_screen: Option<bool>,
    /// Maximum returned screenshot width in pixels (default 1920, hard-capped).
    #[serde(default)]
    max_width: Option<u32>,
    /// Maximum returned screenshot height in pixels (default 1920, hard-capped).
    #[serde(default)]
    max_height: Option<u32>,
    /// Maximum returned screenshot image bytes before base64 (default 2 MiB, hard-capped).
    #[serde(default)]
    max_bytes: Option<usize>,
    /// Additional downscale factor from 0.0 to 1.0, applied before max dimensions.
    #[serde(default)]
    scale: Option<f32>,
    /// Output image format (default png). Use jpeg with quality to trade exact pixels for smaller payloads.
    #[serde(default)]
    format: Option<ScreenshotOutputFormat>,
    /// JPEG quality from 1 to 95 (default 80). Ignored for png.
    #[serde(default)]
    #[schemars(range(min = 1, max = 95))]
    quality: Option<u8>,
}

impl ScreenshotParams {
    fn window_target(&self) -> Option<WindowTarget> {
        if self.window_id.is_none()
            && self.pid.is_none()
            && self.app_id.is_none()
            && self.wm_class.is_none()
            && self.title.is_none()
        {
            return None;
        }
        Some(WindowTarget {
            window_id: self.window_id,
            pid: self.pid,
            tty: None,
            terminal_pid: None,
            terminal_command: None,
            terminal_cwd: None,
            app_id: self.app_id.clone(),
            wm_class: self.wm_class.clone(),
            title: self.title.clone(),
        })
    }

    fn screenshot_options(&self) -> ScreenshotPayloadOptions {
        ScreenshotPayloadOptions {
            max_width: self.max_width,
            max_height: self.max_height,
            max_bytes: self.max_bytes,
            scale: self.scale,
            format: self.format,
            quality: self.quality,
        }
    }
}

/// Screenshot metadata for `get_app_state` and post-action captures. The image
/// bytes travel as a separate `image` content block, not inside this JSON.
#[derive(Debug, Clone, Serialize, JsonSchema)]
struct ScreenshotSummary {
    mime_type: String,
    source: String,
    /// Width of the returned image payload.
    width: u32,
    /// Height of the returned image payload.
    height: u32,
    /// Coordinate-space width before payload downscaling.
    coordinate_width: u32,
    /// Coordinate-space height before payload downscaling.
    coordinate_height: u32,
    /// Returned pixels per coordinate-space pixel.
    scale: f32,
    resized: bool,
    bytes: usize,
    original_bytes: usize,
    max_bytes: usize,
    format: ScreenshotOutputFormat,
    quality: Option<u8>,
    /// True when a post-action screenshot was cropped to a target or focused window.
    #[serde(skip_serializing_if = "Option::is_none")]
    cropped_to_window: Option<bool>,
    /// Title of the window when cropped to a window.
    #[serde(skip_serializing_if = "Option::is_none")]
    window_title: Option<String>,
}

impl From<&ScreenshotCapture> for ScreenshotSummary {
    fn from(capture: &ScreenshotCapture) -> Self {
        Self {
            mime_type: capture.mime_type.clone(),
            source: capture.source.clone(),
            width: capture.width,
            height: capture.height,
            coordinate_width: capture.coordinate_width,
            coordinate_height: capture.coordinate_height,
            scale: capture.scale,
            resized: capture.resized,
            bytes: capture.bytes,
            original_bytes: capture.original_bytes,
            max_bytes: capture.max_bytes,
            format: capture.format,
            quality: capture.quality,
            cropped_to_window: None,
            window_title: None,
        }
    }
}

/// Assemble a structured tool result: the screenshot (when present) as a
/// structured image block first, then the JSON report as text and as
/// `structured_content`. Inlining base64 made hosts treat the image as text.
fn structured_tool_result<T: Serialize>(
    output: T,
    screenshot: Option<ScreenshotCapture>,
) -> Result<CallToolResult, ErrorData> {
    let value = serde_json::to_value(&output).map_err(|error| {
        ErrorData::internal_error(format!("failed to serialize tool output: {error}"), None)
    })?;
    let is_error = value.get("ok").and_then(serde_json::Value::as_bool) == Some(false);
    let mut result = CallToolResult::structured(value);
    result.is_error = Some(is_error);
    if let Some(capture) = screenshot {
        result.content.insert(
            0,
            ContentBlock::image(data_url_payload(&capture.data_url), capture.mime_type),
        );
    }
    Ok(result)
}

fn app_state_result(
    output: GetAppStateOutput,
    screenshot: Option<ScreenshotCapture>,
) -> Result<CallToolResult, ErrorData> {
    structured_tool_result(output, screenshot)
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, JsonSchema)]
struct GetTreePageParams {
    /// First node to return, counted from the start of the cached tree (default 0).
    #[serde(default)]
    offset: Option<usize>,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
struct GetTreePageOutput {
    /// Nodes from `offset`, as many as fit in one result.
    nodes: Vec<AccessibilityNode>,
    offset: usize,
    /// Offset of the next page, or null when this page ends the tree.
    next_offset: Option<usize>,
    /// Nodes in the cached tree.
    node_count: usize,
    message: String,
}

/// A page of `nodes` from `offset` that fits the inline budget. Always at least
/// one node, so paging advances even past a node larger than the budget.
fn tree_page(nodes: &[AccessibilityNode], offset: usize) -> GetTreePageOutput {
    let node_count = nodes.len();
    if node_count == 0 {
        return GetTreePageOutput {
            nodes: Vec::new(),
            offset,
            next_offset: None,
            node_count,
            message: "No accessibility tree is cached; call get_app_state first.".to_string(),
        };
    }
    let start = offset.min(node_count);
    let rest = &nodes[start..];
    let fit = crate::tree_spill::inline_prefix_len(rest, tree_budget(TREE_PAGE_RESERVE))
        .max(usize::from(!rest.is_empty()));
    let end = start + fit;
    let next_offset = (end < node_count).then_some(end);
    let message = match next_offset {
        Some(next) => format!(
            "Nodes {start}-{} of {node_count}; continue with offset {next}.",
            end - 1
        ),
        None if start < end => format!(
            "Nodes {start}-{} of {node_count}; this is the end of the tree.",
            end - 1
        ),
        None => format!("Offset {offset} is past the end of the {node_count}-node tree."),
    };
    GetTreePageOutput {
        nodes: rest[..fit].to_vec(),
        offset: start,
        next_offset,
        node_count,
        message,
    }
}

/// Bytes kept for a tree page's other fields.
const TREE_PAGE_RESERVE: usize = 500;

/// What one get_app_state call found, in the terms its readiness block makes
/// claims about.
#[derive(Debug, Clone, Copy)]
struct AppStateObservation<'a> {
    screenshot_failed: bool,
    window: WindowLookup,
    /// Window backends that failed in a lookup another backend answered.
    failed_window_backends: &'a [&'static str],
    tree: TreeRead,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WindowLookup {
    NotRequested,
    Resolved,
    /// The window list failed, or listed no window matching the target.
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TreeRead {
    Nodes,
    /// The read failed or returned no nodes, as the post-action observation
    /// also counts it.
    Failed,
    /// Not read, because this call found accessibility off, either in a probe
    /// it ran or in the live check that agreed with the cached report.
    AccessibilityOff,
}

/// How an observation disagrees with the readiness the call would report.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Contradiction {
    /// Something failed. The desktop may still be changing, so the next call
    /// probes again as well, to see a recovery.
    Failure,
    /// Something worked that the readiness says cannot. The refreshed report
    /// postdates that success, so the next call can reuse it. If the
    /// contradiction persists, that call refreshes again.
    Success,
}

/// Why a get_app_state call must refresh `readiness` before it reports it, or
/// `None` when the readiness stands. `windowing` comes from the same report.
fn readiness_contradiction(
    readiness: &ReadinessReport,
    windowing: &WindowingReport,
    observed: AppStateObservation,
) -> Option<Contradiction> {
    // A backend the report already calls unhealthy fails as predicted. On KDE
    // both GNOME backends fail before KWin answers, on every call.
    let healthy_backend_failed = observed.failed_window_backends.iter().any(|backend| {
        windowing
            .backends
            .get(*backend)
            .is_some_and(|check| check.ok)
    });
    if observed.screenshot_failed
        || observed.window == WindowLookup::Failed
        || healthy_backend_failed
        || observed.tree == TreeRead::Failed
    {
        Some(Contradiction::Failure)
    } else if observed.window == WindowLookup::Resolved && !readiness.can_query_windows {
        Some(Contradiction::Success)
    } else {
        None
    }
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
struct GetAppStateOutput {
    app_name_or_bundle_identifier: Option<String>,
    window_context: Option<WindowInfo>,
    window_error: Option<String>,
    window_permissions_hint: Option<String>,
    backend: String,
    /// Screenshot metadata; the image itself is the first `image` content block.
    screenshot: Option<ScreenshotSummary>,
    screenshot_error: Option<String>,
    /// Compacted tree, or its leading nodes when the whole tree is in
    /// `accessibility_tree_spill`.
    accessibility_tree: Vec<AccessibilityNode>,
    accessibility_tree_raw_count: usize,
    /// Set when the compacted tree was too large to return inline: the whole
    /// tree is in this private file, with the same element_index values.
    #[serde(skip_serializing_if = "Option::is_none")]
    accessibility_tree_spill: Option<crate::tree_spill::TreeSpill>,
    /// True when the snapshot was limited to selected app roots rather than the
    /// full desktop AT-SPI registry.
    tree_scoped: bool,
    /// True when max_nodes, max_depth, the child read budget, or the 10-second
    /// deadline stopped traversal with unread elements left, so the tree is
    /// incomplete. Recover by scoping to a narrower app or window target and
    /// raising max_nodes or max_depth (hard caps 10000 and 64). Failed element
    /// reads do not count.
    accessibility_tree_truncated: bool,
    accessibility_error: Option<String>,
    /// Compact readiness summary (always present).
    readiness: crate::diagnostics::ReadinessReport,
    /// Full diagnostics; populated only when verbose=true.
    #[serde(skip_serializing_if = "Option::is_none")]
    diagnostics: Option<DoctorReport>,
    message: String,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum ClickCoordinateSpace {
    #[default]
    Capture,
    Atspi,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, JsonSchema)]
struct ClickParams {
    #[serde(default)]
    element_index: Option<u32>,
    #[serde(default)]
    role: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    states: Vec<String>,
    #[serde(default)]
    x: Option<i32>,
    #[serde(default)]
    y: Option<i32>,
    /// Pixel space for explicit x/y: raw screenshot capture pixels (default),
    /// or global AT-SPI screen coordinates mapped through the element's KWin window.
    #[serde(default)]
    coordinate_space: ClickCoordinateSpace,
    #[serde(default)]
    button: Option<String>,
    #[serde(default)]
    click_count: Option<u32>,
    // Optional window target: when set, the window is raised/focused before the
    // click so a coordinate click reliably lands on the intended app rather than
    // whatever window happens to be stacked on top at that pixel.
    #[serde(default)]
    window_id: Option<u64>,
    #[serde(default)]
    pid: Option<u32>,
    #[serde(default)]
    app_id: Option<String>,
    #[serde(default)]
    wm_class: Option<String>,
    #[serde(default)]
    window_title: Option<String>,
    /// Interpret `x`/`y` from the clipped window screenshot crop origin, in
    /// coordinate pixels before preview resizing. Divide preview pixels by its
    /// scale first. This is not a toolkit widget or raw GDK surface origin.
    /// Requires a window target; missing targets are rejected.
    #[serde(default)]
    relative: Option<bool>,
    #[serde(flatten)]
    capture: PostActionCaptureParams,
}

impl ClickParams {
    /// A window target if any window-identifying field was supplied.
    fn window_target(&self) -> Option<WindowTarget> {
        if self.window_id.is_none()
            && self.pid.is_none()
            && self.app_id.is_none()
            && self.wm_class.is_none()
            && self.window_title.is_none()
        {
            return None;
        }
        Some(WindowTarget {
            window_id: self.window_id,
            pid: self.pid,
            tty: None,
            terminal_pid: None,
            terminal_command: None,
            terminal_cwd: None,
            app_id: self.app_id.clone(),
            wm_class: self.wm_class.clone(),
            title: self.window_title.clone(),
        })
    }

    fn selector(&self) -> ElementSelector<'_> {
        ElementSelector {
            role: self.role.as_deref(),
            name: self.name.as_deref(),
            text: self.text.as_deref(),
            states: &self.states,
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, JsonSchema)]
struct ActionParams {
    #[serde(default)]
    element_index: Option<u32>,
    #[serde(default)]
    element_identifier: Option<String>,
    #[serde(default)]
    role: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    states: Vec<String>,
    #[serde(default)]
    action: Option<String>,
    #[serde(flatten)]
    capture: PostActionCaptureParams,
}

impl ActionParams {
    fn selector(&self) -> ElementSelector<'_> {
        ElementSelector {
            role: self.role.as_deref(),
            name: self.name.as_deref(),
            text: self.text.as_deref(),
            states: &self.states,
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, JsonSchema)]
struct SetValueParams {
    #[serde(default)]
    element_index: Option<u32>,
    #[serde(default)]
    element_identifier: Option<String>,
    #[serde(default)]
    role: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    states: Vec<String>,
    value: String,
    #[serde(flatten)]
    capture: PostActionCaptureParams,
}

impl SetValueParams {
    fn selector(&self) -> ElementSelector<'_> {
        ElementSelector {
            role: self.role.as_deref(),
            name: self.name.as_deref(),
            text: self.text.as_deref(),
            states: &self.states,
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, JsonSchema)]
struct ScrollParams {
    #[serde(default)]
    element_index: Option<u32>,
    #[serde(default)]
    x: Option<i32>,
    #[serde(default)]
    y: Option<i32>,
    direction: String,
    #[serde(default)]
    #[schemars(range(min = -100, max = 100))]
    pages: Option<f64>,
    // Optional window target (parity with click): the window is raised/focused
    // before scrolling so the wheel events land on the intended app.
    #[serde(default)]
    window_id: Option<u64>,
    #[serde(default)]
    pid: Option<u32>,
    #[serde(default)]
    app_id: Option<String>,
    #[serde(default)]
    wm_class: Option<String>,
    #[serde(default)]
    window_title: Option<String>,
    /// Interpret `x`/`y` from the clipped window screenshot crop origin, in
    /// coordinate pixels before preview resizing. Divide preview pixels by its
    /// scale first. This is not a toolkit widget or raw GDK surface origin.
    /// Requires a window target; missing targets are rejected.
    #[serde(default)]
    relative: Option<bool>,
    #[serde(flatten)]
    capture: PostActionCaptureParams,
}

fn scroll_units(pages: Option<f64>) -> std::result::Result<i32, String> {
    let pages = pages.unwrap_or(1.0);
    if !pages.is_finite() || pages.abs() > MAX_SCROLL_PAGES {
        return Err(format!(
            "pages must be finite and have an absolute value no greater than {MAX_SCROLL_PAGES}"
        ));
    }
    Ok(((pages.abs().max(0.1) * 5.0).round() as i32).max(1))
}

impl ScrollParams {
    /// A window target if any window-identifying field was supplied.
    fn window_target(&self) -> Option<WindowTarget> {
        if self.window_id.is_none()
            && self.pid.is_none()
            && self.app_id.is_none()
            && self.wm_class.is_none()
            && self.window_title.is_none()
        {
            return None;
        }
        Some(WindowTarget {
            window_id: self.window_id,
            pid: self.pid,
            tty: None,
            terminal_pid: None,
            terminal_command: None,
            terminal_cwd: None,
            app_id: self.app_id.clone(),
            wm_class: self.wm_class.clone(),
            title: self.window_title.clone(),
        })
    }
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, JsonSchema)]
struct DragParams {
    start_x: i32,
    start_y: i32,
    end_x: i32,
    end_y: i32,
    #[serde(flatten)]
    capture: PostActionCaptureParams,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, JsonSchema)]
struct PressKeyParams {
    key: String,
    #[serde(default)]
    window_id: Option<u64>,
    #[serde(default)]
    pid: Option<u32>,
    #[serde(default)]
    tty: Option<String>,
    #[serde(default)]
    terminal_pid: Option<u32>,
    #[serde(default)]
    terminal_command: Option<String>,
    #[serde(default)]
    terminal_cwd: Option<String>,
    #[serde(default)]
    app_id: Option<String>,
    #[serde(default)]
    wm_class: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(flatten)]
    capture: PostActionCaptureParams,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, JsonSchema)]
struct TypeTextParams {
    text: String,
    #[serde(default)]
    window_id: Option<u64>,
    #[serde(default)]
    pid: Option<u32>,
    #[serde(default)]
    tty: Option<String>,
    #[serde(default)]
    terminal_pid: Option<u32>,
    #[serde(default)]
    terminal_command: Option<String>,
    #[serde(default)]
    terminal_cwd: Option<String>,
    #[serde(default)]
    app_id: Option<String>,
    #[serde(default)]
    wm_class: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(flatten)]
    capture: PostActionCaptureParams,
}

impl PressKeyParams {
    fn window_target(&self) -> WindowTarget {
        WindowTarget {
            window_id: self.window_id,
            pid: self.pid,
            tty: self.tty.clone(),
            terminal_pid: self.terminal_pid,
            terminal_command: self.terminal_command.clone(),
            terminal_cwd: self.terminal_cwd.clone(),
            app_id: self.app_id.clone(),
            wm_class: self.wm_class.clone(),
            title: self.title.clone(),
        }
    }
}

impl TypeTextParams {
    fn window_target(&self) -> WindowTarget {
        WindowTarget {
            window_id: self.window_id,
            pid: self.pid,
            tty: self.tty.clone(),
            terminal_pid: self.terminal_pid,
            terminal_command: self.terminal_command.clone(),
            terminal_cwd: self.terminal_cwd.clone(),
            app_id: self.app_id.clone(),
            wm_class: self.wm_class.clone(),
            title: self.title.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
struct ActionOutput {
    ok: bool,
    implemented: bool,
    action: String,
    message: String,
    // See ActivateWindowOutput: kept in the response, omitted from the schema
    // because `serde_json::Value` produces a non-object schema strict MCP
    // clients reject.
    #[schemars(skip)]
    received: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
struct ActionToolOutput {
    #[serde(flatten)]
    action: ActionOutput,
    #[serde(flatten)]
    observation: PostActionObservation,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
struct SetValueToolOutput {
    #[serde(flatten)]
    action: ActionOutput,
    /// Exact editable-text readback result; omitted for numeric values and early failures.
    #[serde(skip_serializing_if = "Option::is_none")]
    verified: Option<bool>,
    #[serde(flatten)]
    observation: PostActionObservation,
}

fn editable_text_action_result(
    outcome: EditableTextSetOutcome,
    received: Option<serde_json::Value>,
) -> (ActionOutput, Option<bool>) {
    let (ok, verified, message) = match outcome {
        EditableTextSetOutcome::Verified => (
            true,
            Some(true),
            "AT-SPI editable text contents set and verified.",
        ),
        EditableTextSetOutcome::MismatchAfterDeadline => (
            false,
            Some(false),
            "AT-SPI EditableText returned success, but the resulting contents did not match the requested value. The contents may be unchanged, normalized, or partially changed; re-observe the element before retrying.",
        ),
        EditableTextSetOutcome::ReadbackFailed => (
            false,
            Some(false),
            "AT-SPI EditableText returned success, but content verification failed. The value may have changed; re-observe the element before retrying.",
        ),
        EditableTextSetOutcome::ReadbackTimedOut => (
            false,
            Some(false),
            "AT-SPI EditableText returned success, but content verification timed out. The value may have changed; re-observe the element before retrying.",
        ),
        EditableTextSetOutcome::PasswordUnverifiable => (
            true,
            Some(false),
            "AT-SPI editable text contents dispatched to a password field; exact contents cannot be verified.",
        ),
    };
    (
        ActionOutput {
            ok,
            implemented: true,
            action: "set_value".to_string(),
            message: message.to_string(),
            received,
        },
        verified,
    )
}

impl ComputerUseLinux {
    fn is_wayland_session(&self) -> bool {
        crate::diagnostics::hydrate_session_bus_env();
        let session_type = env::var("XDG_SESSION_TYPE").ok();
        let wayland_display = env::var("WAYLAND_DISPLAY").ok();
        session_is_wayland(session_type.as_deref(), wayland_display.as_deref())
    }

    // The Wayland remote-desktop portal is a fallback for input: when a
    // compatible ydotool CLI and working `ydotoold` socket are present we
    // prefer ydotool, because it injects input without a permission prompt.
    // Without `COMPUTER_USE_LINUX_PERSIST_REMOTE_DESKTOP=1` (or
    // `CODEX_COMPUTER_USE_PERSIST_REMOTE_DESKTOP=1`) the portal asks
    // again on every new process. That opt-in sends `persist_mode=2` on
    // RemoteDesktop SelectDevices and reuses the single-use restore token.
    // `COMPUTER_USE_LINUX_FORCE_YDOTOOL_*=1` always uses ydotool;
    // `COMPUTER_USE_LINUX_FORCE_PORTAL_*=1` always uses the portal. The
    // `CODEX_COMPUTER_USE_*` names are accepted for the embedded Codex app
    // bundle so downstream can share this source without local string patches.
    async fn should_prefer_portal_pointer_backend(&self) -> bool {
        if env_flag_enabled_any(&[
            "COMPUTER_USE_LINUX_FORCE_YDOTOOL_POINTER",
            "CODEX_COMPUTER_USE_FORCE_YDOTOOL_POINTER",
        ]) {
            return false;
        }
        if env_flag_enabled_any(&[
            "COMPUTER_USE_LINUX_FORCE_PORTAL_POINTER",
            "CODEX_COMPUTER_USE_FORCE_PORTAL_POINTER",
        ]) {
            return self.is_wayland_session();
        }
        // COSMIC maps uinput absolute axes to the active output, not the
        // desktop bounding box. Portal streams address each output directly.
        if self.is_cosmic_wayland_session() {
            return true;
        }
        should_prefer_portal_backend_by_default(
            self.is_wayland_session(),
            ydotool_backend_available().await,
        )
    }

    fn should_prefer_portal_text_backend(&self) -> bool {
        prefer_portal_text_backend(
            env_flag_enabled_any(&[
                "COMPUTER_USE_LINUX_FORCE_YDOTOOL_KEYBOARD",
                "CODEX_COMPUTER_USE_FORCE_YDOTOOL_KEYBOARD",
            ]),
            self.should_prefer_xdotool_keyboard(),
            self.is_wayland_session(),
            self.is_kde_wayland_session(),
            env_flag_enabled_any(&[
                "COMPUTER_USE_LINUX_FORCE_PORTAL_KEYBOARD",
                "CODEX_COMPUTER_USE_FORCE_PORTAL_KEYBOARD",
            ]),
            self.should_prefer_wtype_keyboard(),
        )
    }

    async fn should_prefer_portal_keyboard_for_chords(&self) -> bool {
        if env_flag_enabled_any(&[
            "COMPUTER_USE_LINUX_FORCE_YDOTOOL_KEYBOARD",
            "CODEX_COMPUTER_USE_FORCE_YDOTOOL_KEYBOARD",
        ]) {
            return false;
        }
        if self.should_prefer_xdotool_keyboard() {
            return false;
        }
        if !self.is_wayland_session() {
            return false;
        }
        if self.cached_portal_keyboard_session().is_some()
            || env_flag_enabled_any(&[
                "COMPUTER_USE_LINUX_FORCE_PORTAL_KEYBOARD",
                "CODEX_COMPUTER_USE_FORCE_PORTAL_KEYBOARD",
            ])
        {
            return true;
        }
        !ydotool_backend_available().await
    }

    fn should_prefer_kde_clipboard_text_backend(&self) -> bool {
        !env_flag_enabled_any(&[
            "COMPUTER_USE_LINUX_FORCE_YDOTOOL_KEYBOARD",
            "CODEX_COMPUTER_USE_FORCE_YDOTOOL_KEYBOARD",
        ]) && !self.should_prefer_xdotool_keyboard()
            && self.is_kde_wayland_session()
    }

    fn should_prefer_xdotool_pointer(&self) -> bool {
        crate::diagnostics::hydrate_session_bus_env();
        prefer_xdotool_pointer(
            env_flag_enabled_any(&[
                "COMPUTER_USE_LINUX_FORCE_YDOTOOL_POINTER",
                "CODEX_COMPUTER_USE_FORCE_YDOTOOL_POINTER",
            ]),
            env::var("XDG_SESSION_TYPE").ok().as_deref(),
            env_var_non_empty("DISPLAY"),
            env::var("WAYLAND_DISPLAY").ok().as_deref(),
        )
    }

    fn should_prefer_xdotool_keyboard(&self) -> bool {
        prefer_xdotool_keyboard(
            env_flag_enabled_any(&[
                "COMPUTER_USE_LINUX_FORCE_YDOTOOL_KEYBOARD",
                "CODEX_COMPUTER_USE_FORCE_YDOTOOL_KEYBOARD",
            ]),
            env_flag_enabled_any(&[
                "COMPUTER_USE_LINUX_FORCE_XDOTOOL_KEYBOARD",
                "CODEX_COMPUTER_USE_FORCE_XDOTOOL_KEYBOARD",
            ]),
            self.is_wayland_session(),
            env_var_non_empty("DISPLAY"),
            xdotool_available(),
        )
    }

    fn should_prefer_wtype_keyboard(&self) -> bool {
        prefer_wtype_keyboard(
            env_flag_enabled_any(&[
                "COMPUTER_USE_LINUX_FORCE_YDOTOOL_KEYBOARD",
                "CODEX_COMPUTER_USE_FORCE_YDOTOOL_KEYBOARD",
            ]),
            env_flag_enabled_any(&[
                "COMPUTER_USE_LINUX_FORCE_XDOTOOL_KEYBOARD",
                "CODEX_COMPUTER_USE_FORCE_XDOTOOL_KEYBOARD",
            ]),
            env_flag_enabled_any(&[
                "COMPUTER_USE_LINUX_FORCE_PORTAL_KEYBOARD",
                "CODEX_COMPUTER_USE_FORCE_PORTAL_KEYBOARD",
            ]),
            self.is_wayland_session(),
            crate::diagnostics::wtype_compatible_wayland_desktop(
                env::var("XDG_CURRENT_DESKTOP").ok().as_deref(),
            ),
            wtype_available(),
        )
    }

    fn wtype_text_mode(&self) -> Option<WtypeTextMode> {
        if self.should_prefer_xdotool_keyboard()
            || self.should_prefer_kde_clipboard_text_backend()
            || self.should_prefer_portal_text_backend()
            || !self.should_prefer_wtype_keyboard()
        {
            return None;
        }
        Some(wtype_text_mode_for_desktop(
            env::var("XDG_CURRENT_DESKTOP").ok().as_deref(),
        ))
    }

    fn is_cosmic_wayland_session(&self) -> bool {
        self.is_wayland_session()
            && (env_contains("XDG_CURRENT_DESKTOP", "cosmic")
                || env_contains("XDG_SESSION_DESKTOP", "cosmic")
                || env_contains("DESKTOP_SESSION", "cosmic"))
    }

    fn is_gnome_wayland_session(&self) -> bool {
        self.is_wayland_session()
            && (env_contains("XDG_CURRENT_DESKTOP", "gnome")
                || env_contains("DESKTOP_SESSION", "gnome")
                || env_contains("XDG_SESSION_DESKTOP", "gnome"))
    }

    fn is_kde_wayland_session(&self) -> bool {
        self.is_wayland_session()
            && (env_contains("XDG_CURRENT_DESKTOP", "kde")
                || env_contains("DESKTOP_SESSION", "plasma"))
    }

    fn cached_portal_pointer_session(&self) -> Option<PortalPointerSession> {
        if env_flag_enabled_any(&[
            "COMPUTER_USE_LINUX_FORCE_YDOTOOL_POINTER",
            "CODEX_COMPUTER_USE_FORCE_YDOTOOL_POINTER",
        ]) {
            return None;
        }
        let mut cached = self.portal_pointer_session.lock().ok()?;
        if cached.as_ref().is_some_and(|session| !session.is_valid()) {
            *cached = None;
        }
        cached.clone()
    }

    fn clear_portal_pointer_session(&self, failed: &PortalPointerSession) {
        failed.invalidate_and_close();
        if let Ok(mut cached) = self.portal_pointer_session.lock() {
            if cached
                .as_ref()
                .is_some_and(|session| session.same_session(failed))
            {
                *cached = None;
            }
        }
    }

    fn cached_portal_keyboard_session(&self) -> Option<PortalKeyboardSession> {
        let mut cached = self.portal_keyboard_session.lock().ok()?;
        if cached.as_ref().is_some_and(|session| !session.is_valid()) {
            *cached = None;
        }
        cached.clone()
    }

    fn clear_portal_keyboard_session(&self, failed: &PortalKeyboardSession) {
        failed.invalidate_and_close();
        if let Ok(mut cached) = self.portal_keyboard_session.lock() {
            if cached
                .as_ref()
                .is_some_and(|session| session.same_session(failed))
            {
                *cached = None;
            }
        }
    }

    async fn ensure_portal_pointer_session(&self) -> Result<Option<PortalPointerSession>> {
        if !self.should_prefer_portal_pointer_backend().await {
            return Ok(None);
        }
        if let Some(session) = self.cached_portal_pointer_session() {
            return Ok(Some(session));
        }

        let _guard = self.portal_session_init_lock.lock().await;
        if let Some(session) = self.cached_portal_pointer_session() {
            return Ok(Some(session));
        }

        let session = start_portal_pointer_session().await?;
        self.capture_space_rect().await;
        if let Ok(mut cached) = self.portal_pointer_session.lock() {
            *cached = Some(session.clone());
        }
        Ok(Some(session))
    }

    async fn portal_keyboard_target(
        &self,
        target: &WindowTarget,
        focus: Option<&WindowFocusResult>,
    ) -> Result<WindowTarget> {
        // Preserve the receiving target across consent. Pin the selected
        // window when its backend supports exact focus; otherwise keep app focus.
        if let Some(focus) = focus {
            return Ok(portal_focus_target(target, &focus.requested_window));
        }
        if target.has_target() {
            anyhow::bail!(
                "Portal keyboard input requires verified target-window focus. No input was sent."
            );
        }
        let window = focused_window().await?
            .context("Portal keyboard input requires a focused window before consent; pass a window target. No input was sent.")?;
        let target = portal_focus_target(target, &window);
        if !target.has_target() {
            anyhow::bail!(
                "Portal keyboard input could not preserve the receiving app. No input was sent."
            );
        }
        Ok(target)
    }

    async fn ensure_portal_keyboard_session(&self) -> Result<Option<PortalKeyboardSession>> {
        if env_flag_enabled_any(&[
            "COMPUTER_USE_LINUX_FORCE_YDOTOOL_KEYBOARD",
            "CODEX_COMPUTER_USE_FORCE_YDOTOOL_KEYBOARD",
        ]) || !self.is_wayland_session()
        {
            return Ok(None);
        }
        if let Some(session) = self.cached_portal_keyboard_session() {
            return Ok(Some(session));
        }

        let _guard = self.portal_session_init_lock.lock().await;
        if let Some(session) = self.cached_portal_keyboard_session() {
            return Ok(Some(session));
        }

        let session = start_portal_keyboard_session().await?;
        if let Ok(mut cached) = self.portal_keyboard_session.lock() {
            *cached = Some(session.clone());
        }
        Ok(Some(session))
    }

    async fn resolve_window_context(
        &self,
        params: &GetAppStateParams,
    ) -> (
        Option<WindowInfo>,
        Option<String>,
        Option<String>,
        bool,
        Vec<&'static str>,
    ) {
        let target = params.window_target();
        if !target.has_target() {
            return (None, None, None, false, Vec::new());
        }

        match registry::list_windows_with_failures().await {
            Ok(listing) => {
                let (window, error) = match resolve_window_target(&listing.windows, &target) {
                    Ok(window) => (Some(window.clone()), None),
                    Err(error) => (None, Some(format!("{error:#}"))),
                };
                (window, error, None, true, listing.failed_backends)
            }
            Err(error) => {
                let error = format!("{error:#}");
                let hint = window_permission_hint(&error);
                (None, Some(error), hint, false, Vec::new())
            }
        }
    }

    async fn resolve_screenshot_window(
        &self,
        target: &WindowTarget,
        raise_window: bool,
    ) -> Result<WindowInfo> {
        let window = if raise_window {
            let focus = focus_window_target(target).await?;
            if !focus.exact_window_focused {
                anyhow::bail!(
                    "the requested window could not be focused exactly; refusing to capture unrelated desktop pixels"
                );
            }
            sleep(Duration::from_millis(250)).await;
            focus
                .focused_window
                .filter(|window| window.window_id == focus.requested_window.window_id)
                .ok_or_else(|| anyhow::anyhow!("focused-window verification returned no window"))?
        } else {
            let windows = list_windows().await?;
            let window = resolve_window_target(&windows, target)?.clone();
            if !window.focused {
                anyhow::bail!(
                    "raise_window=false requires the requested window to already be focused"
                );
            }
            window
        };
        if window.hidden {
            anyhow::bail!("the requested window is hidden or minimized");
        }
        Ok(window)
    }

    async fn resolve_post_action_window(
        &self,
        target: Option<&WindowTarget>,
        fallback_window: Option<&WindowInfo>,
    ) -> Result<WindowInfo> {
        let window = if let Some(target) = target.filter(|target| target.has_target()) {
            match list_windows().await {
                Ok(windows) => resolve_window_target(&windows, target)?.clone(),
                Err(error) => {
                    self.diagnostics.invalidate();
                    if let Some(window) = fallback_window {
                        window.clone()
                    } else {
                        return Err(error);
                    }
                }
            }
        } else if let Some(window) = fallback_window {
            window.clone()
        } else {
            focused_window().await?.ok_or_else(|| {
                anyhow::anyhow!("no focused window is available for screenshot_after=\"window\"")
            })?
        };
        if window.hidden {
            anyhow::bail!("the target window is hidden or minimized");
        }
        Ok(window)
    }

    async fn capture_post_action_observation(
        &self,
        capture: &PostActionCaptureParams,
        target: Option<&WindowTarget>,
        fallback_window: Option<&WindowInfo>,
    ) -> (
        PostActionObservation,
        Option<ScreenshotCapture>,
        Vec<String>,
    ) {
        let screenshot_scope = capture.screenshot_scope();
        let include_tree = capture.include_tree.unwrap_or(false);
        if screenshot_scope.is_none() && !include_tree {
            return (PostActionObservation::default(), None, Vec::new());
        }

        let mut observation = PostActionObservation::default();
        let mut screenshot_capture = None;
        let mut notes = Vec::new();
        let mut resolved_window: Option<WindowInfo> = None;

        if let Some(scope) = screenshot_scope {
            let options = capture.screenshot_options();
            let result: Result<(ScreenshotCapture, bool, Option<String>, Option<String>)> = async {
                let _pipeline = crate::screenshot::screenshot_pipeline_permit().await?;
                let crop_window = match scope {
                    ScreenshotAfterScope::Screen => None,
                    ScreenshotAfterScope::Window => {
                        let window = self
                            .resolve_post_action_window(target, fallback_window)
                            .await
                            .context("targeted post-action screenshot failed")?;
                        resolved_window = Some(window.clone());
                        Some(window)
                    }
                };
                let window_label = crop_window.as_ref().and_then(|window| window.title.clone());
                let raw_capture = {
                    let hold_started = std::time::Instant::now();
                    let _hold = self.indicator.hold_for_capture().await?;
                    if !cfg!(test) {
                        let remaining =
                            Duration::from_millis(120).saturating_sub(hold_started.elapsed());
                        if !remaining.is_zero() {
                            sleep(remaining).await;
                        }
                    }
                    capture_screenshot_raw()
                        .await
                        .context("post-action screenshot failed")?
                };
                self.cache_desktop_size(raw_capture.width, raw_capture.height);
                let off_screen_note = match crop_window
                    .as_ref()
                    .and_then(|window| window.bounds.as_ref())
                {
                    Some(bounds) => self.off_screen_note_for_bounds(bounds).await,
                    None => None,
                };
                let (raw_for_payload, cropped) = match crop_window.as_ref() {
                    Some(window) => {
                        let (x, y, width, height) = self
                            .window_crop_rect_for_capture(window, &raw_capture)
                            .await
                            .context("targeted post-action screenshot crop failed")?;
                        let (raw_capture, bytes, width, height) =
                            crate::screenshot::run_image_task(move || {
                                let (bytes, width, height) =
                                    crop_png(&raw_capture.bytes, x, y, width, height)
                                        .map_err(anyhow::Error::msg)
                                        .context("targeted post-action screenshot crop failed")?;
                                Ok((raw_capture, bytes, width, height))
                            })
                            .await?;
                        (
                            RawScreenshotCapture {
                                mime_type: raw_capture.mime_type,
                                bytes,
                                source: raw_capture.source,
                                width,
                                height,
                            },
                            true,
                        )
                    }
                    None => (raw_capture, false),
                };
                let prepared = crate::screenshot::run_image_task(move || {
                    prepare_screenshot_payload(raw_for_payload, options)
                })
                .await
                .context("post-action screenshot resize failed")?;
                Ok((prepared, cropped, window_label, off_screen_note))
            }
            .await;

            match result {
                Ok((prepared, cropped, window_title, off_screen_note)) => {
                    let mut summary = ScreenshotSummary::from(&prepared);
                    summary.cropped_to_window = Some(cropped);
                    summary.window_title = window_title;
                    observation.screenshot = Some(summary);
                    screenshot_capture = Some(prepared);
                    if let Some(note) = off_screen_note {
                        notes.push(note);
                    }
                }
                Err(error) => {
                    let error = format!("{error:#}");
                    notes.push(format!("Post-action screenshot failed: {error}"));
                    observation.screenshot_error = Some(error);
                }
            }
        } else if !cfg!(test) {
            sleep(Duration::from_millis(120)).await;
        }

        if include_tree {
            if resolved_window.is_none() {
                resolved_window = if let Some(target) = target.filter(|target| target.has_target())
                {
                    list_windows()
                        .await
                        .inspect_err(|_| self.diagnostics.invalidate())
                        .ok()
                        .and_then(|windows| {
                            resolve_window_target(&windows, target)
                                .inspect_err(|_| self.diagnostics.invalidate())
                                .ok()
                                .cloned()
                        })
                        .or_else(|| fallback_window.cloned())
                } else if let Some(window) = fallback_window {
                    Some(window.clone())
                } else {
                    focused_window()
                        .await
                        .inspect_err(|_| self.diagnostics.invalidate())
                        .ok()
                        .flatten()
                };
            }
            let target_pid = resolved_window
                .as_ref()
                .and_then(|window| window.pid)
                .or_else(|| target.and_then(|target| target.pid))
                .or_else(|| {
                    self.last_snapshot
                        .lock()
                        .ok()
                        .and_then(|snapshot| snapshot.pid)
                });
            let candidates = accessibility_filter_candidates(resolved_window.as_ref());
            let mut app_filter = None;
            if let Some(pid) = target_pid {
                if let Ok(apps) = list_accessible_apps(200).await {
                    app_filter = select_accessibility_object_ref(&apps, pid, &candidates);
                }
            }
            if app_filter.is_none() {
                app_filter = candidates.into_iter().next();
            }
            let accessibility_target_requested = target.is_some_and(WindowTarget::has_target)
                || target_pid.is_some()
                || app_filter.is_some();
            let (max_nodes, max_depth) = crate::atspi_tree::snapshot_limits(None, None);
            match snapshot_accessibility_tree(
                app_filter.as_deref(),
                target_pid,
                max_nodes,
                max_depth,
            )
            .await
            {
                Ok(snapshot)
                    if snapshot.nodes.is_empty()
                        && !tokio::task::spawn_blocking(
                            crate::diagnostics::can_build_accessibility_tree_now,
                        )
                        .await
                        .unwrap_or(false) =>
                {
                    self.commit_snapshot(&[], None).await;
                    let error = "GNOME accessibility is disabled; call setup_accessibility first."
                        .to_string();
                    notes.push(format!("Post-action accessibility tree failed: {error}"));
                    observation.accessibility_tree = Some(Vec::new());
                    observation.accessibility_tree_raw_count = Some(0);
                    observation.tree_scoped = Some(false);
                    observation.accessibility_tree_truncated = Some(false);
                    observation.accessibility_error = Some(error);
                }
                Ok(snapshot) => {
                    let raw_count = snapshot.nodes.len();
                    let (nodes, shell_only_note) = compact_accessibility_tree_with_note(
                        snapshot.nodes,
                        snapshot.scoped,
                        snapshot.truncated,
                    );
                    self.commit_snapshot(&nodes, snapshot.root_pid).await;
                    if let Some(warning) = unscoped_accessibility_tree_warning(
                        snapshot.scoped,
                        true,
                        accessibility_target_requested,
                    ) {
                        notes.push(warning.to_string());
                    }
                    if let Some(note) = truncated_accessibility_tree_note(snapshot.truncated) {
                        notes.push(note.to_string());
                    }
                    if let Some(note) = shell_only_note {
                        notes.push(note.to_string());
                    }
                    let mut nodes = nodes;
                    let (spill, spill_note) = fit_tree(
                        &self.tree_spiller,
                        &mut nodes,
                        tree_budget(POST_ACTION_RESULT_RESERVE),
                    );
                    notes.extend(spill_note);
                    observation.accessibility_tree_spill = spill;
                    observation.accessibility_tree = Some(nodes);
                    observation.accessibility_tree_raw_count = Some(raw_count);
                    observation.tree_scoped = Some(snapshot.scoped);
                    observation.accessibility_tree_truncated = Some(snapshot.truncated);
                }
                Err(error) => {
                    self.commit_snapshot(&[], None).await;
                    let error = format!("{error:#}");
                    notes.push(format!("Post-action accessibility tree failed: {error}"));
                    observation.accessibility_tree = Some(Vec::new());
                    observation.accessibility_tree_raw_count = Some(0);
                    observation.tree_scoped = Some(false);
                    observation.accessibility_tree_truncated = Some(false);
                    observation.accessibility_error = Some(error);
                }
            }
        }

        if observation.screenshot_error.is_some()
            || observation.accessibility_error.is_some()
            || observation.accessibility_tree_raw_count == Some(0)
        {
            self.diagnostics.invalidate();
        }
        (observation, screenshot_capture, notes)
    }

    /// `structured_tool_result` for an action. A failed action can mean the
    /// desktop changed under the cached diagnostics, such as a dropped portal
    /// session or a window backend that stopped answering, so any failure marks
    /// them stale without classifying its reason.
    fn action_tool_result<T: Serialize>(
        &self,
        output: T,
        screenshot: Option<ScreenshotCapture>,
    ) -> Result<CallToolResult, ErrorData> {
        let result = structured_tool_result(output, screenshot)?;
        if result.is_error == Some(true) {
            self.diagnostics.invalidate();
        }
        Ok(result)
    }

    async fn finish_action_output(
        &self,
        mut output: ActionOutput,
        capture: &PostActionCaptureParams,
        target: Option<&WindowTarget>,
    ) -> Result<CallToolResult, ErrorData> {
        if !output.ok {
            return self.action_tool_result(
                ActionToolOutput {
                    action: output,
                    observation: PostActionObservation::default(),
                },
                None,
            );
        }
        let (observation, screenshot, notes) = self
            .capture_post_action_observation(capture, target, None)
            .await;
        output = with_notes(output, notes);
        self.action_tool_result(
            ActionToolOutput {
                action: output,
                observation,
            },
            screenshot,
        )
    }

    async fn finish_set_value_output(
        &self,
        mut output: ActionOutput,
        verified: Option<bool>,
        capture: &PostActionCaptureParams,
    ) -> Result<CallToolResult, ErrorData> {
        if !output.ok && verified != Some(false) {
            return self.action_tool_result(
                SetValueToolOutput {
                    action: output,
                    verified,
                    observation: PostActionObservation::default(),
                },
                None,
            );
        }
        let (observation, screenshot, notes) = self
            .capture_post_action_observation(capture, None, None)
            .await;
        output = with_notes(output, notes);
        self.action_tool_result(
            SetValueToolOutput {
                action: output,
                verified,
                observation,
            },
            screenshot,
        )
    }

    async fn finish_activate_window_output(
        &self,
        output: ActivateWindowOutput,
        capture: &PostActionCaptureParams,
        target: &WindowTarget,
    ) -> Result<CallToolResult, ErrorData> {
        if !output.ok {
            return self.action_tool_result(
                ActivateWindowToolOutput {
                    output,
                    message: None,
                    observation: PostActionObservation::default(),
                },
                None,
            );
        }
        let fallback_window = output
            .focus
            .as_ref()
            .and_then(|focus| focus.focused_window.as_ref())
            .or_else(|| output.focus.as_ref().map(|focus| &focus.requested_window));
        let (observation, screenshot, notes) = self
            .capture_post_action_observation(capture, Some(target), fallback_window)
            .await;
        let message = (!notes.is_empty()).then(|| notes.join(" "));
        self.action_tool_result(
            ActivateWindowToolOutput {
                output,
                message,
                observation,
            },
            screenshot,
        )
    }

    async fn finish_window_geometry_output(
        &self,
        mut output: WindowGeometryOutput,
        capture: &PostActionCaptureParams,
        target: &WindowTarget,
    ) -> Result<CallToolResult, ErrorData> {
        if !output.ok {
            return self.action_tool_result(
                WindowGeometryToolOutput {
                    output,
                    observation: PostActionObservation::default(),
                },
                None,
            );
        }
        let fallback_window = output.window.as_ref();
        let (observation, screenshot, notes) = self
            .capture_post_action_observation(capture, Some(target), fallback_window)
            .await;
        for note in notes {
            if !output.message.is_empty() {
                output.message.push(' ');
            }
            output.message.push_str(&note);
        }
        self.action_tool_result(
            WindowGeometryToolOutput {
                output,
                observation,
            },
            screenshot,
        )
    }

    async fn window_crop_rect_for_capture(
        &self,
        window: &WindowInfo,
        raw: &RawScreenshotCapture,
    ) -> Result<(i32, i32, u32, u32)> {
        self.window_crop_rect_for_dimensions(window, raw.width, raw.height)
            .await
    }

    async fn window_crop_rect_for_dimensions(
        &self,
        window: &WindowInfo,
        capture_width: u32,
        capture_height: u32,
    ) -> Result<(i32, i32, u32, u32)> {
        Ok(self
            .window_coordinate_map_for_dimensions(window, capture_width, capture_height)
            .await?
            .capture_rect)
    }

    async fn window_coordinate_map_for_dimensions(
        &self,
        window: &WindowInfo,
        capture_width: u32,
        capture_height: u32,
    ) -> Result<WindowCoordinateMap> {
        let bounds = window.bounds.as_ref().ok_or_else(|| {
            anyhow::anyhow!(
                "targeted screenshot requires window bounds; refusing to return the full desktop"
            )
        })?;
        let logical_rect = window_crop_rect(bounds).ok_or_else(|| {
            anyhow::anyhow!(
                "targeted screenshot has unusable window bounds; refusing to return the full desktop"
            )
        })?;
        let monitors = if window.backend == GNOME_SHELL_EXTENSION_BACKEND {
            Some(
                crate::windowing::backends::gnome::extension_monitor_layout()
                    .await
                    .map_err(|error| {
                        anyhow::anyhow!(
                            "GNOME targeted screenshot requires logical monitor geometry: {error:#}"
                        )
                    })?
                    .into_iter()
                    .map(|monitor| (monitor.x, monitor.y, monitor.width, monitor.height))
                    .collect(),
            )
        } else if window.backend == GNOME_SHELL_INTROSPECT_BACKEND {
            crate::windowing::backends::gnome::extension_monitor_layout()
                .await
                .ok()
                .map(|monitors| {
                    monitors
                        .into_iter()
                        .map(|monitor| (monitor.x, monitor.y, monitor.width, monitor.height))
                        .collect()
                })
        } else if window.backend == crate::windowing::backends::cosmic::COSMIC_WAYLAND_BACKEND {
            Some(
                crate::cosmic_helper::monitor_layout()
                    .await?
                    .into_iter()
                    .map(|monitor| (monitor.x, monitor.y, monitor.width, monitor.height))
                    .collect(),
            )
        } else if window.backend == KWIN_BACKEND {
            Some(vec![
                crate::windowing::backends::kwin::logical_desktop_rect()
                    .await
                    .map_err(|error| {
                        anyhow::anyhow!(
                            "KWin targeted screenshot requires logical workspace geometry: {error:#}"
                        )
                    })?,
            ])
        } else {
            None
        };
        let (full_capture_rect, portal_rect) = match monitors {
            Some(monitors) => (
                logical_window_crop_rect(bounds, &monitors, capture_width, capture_height)?,
                Some(logical_rect),
            ),
            None => (logical_rect, None),
        };
        Ok(WindowCoordinateMap {
            capture_rect: clip_capture_rect(full_capture_rect, capture_width, capture_height)?,
            full_capture_rect,
            portal_rect,
        })
    }

    async fn focused_window_coordinate_map(
        &self,
        focus: &WindowFocusResult,
    ) -> std::result::Result<WindowCoordinateMap, String> {
        let window = focus
            .focused_window
            .as_ref()
            .unwrap_or(&focus.requested_window);
        if !matches!(
            window.backend.as_str(),
            GNOME_SHELL_EXTENSION_BACKEND
                | GNOME_SHELL_INTROSPECT_BACKEND
                | KWIN_BACKEND
                | crate::windowing::backends::cosmic::COSMIC_WAYLAND_BACKEND
        ) {
            let full_capture_rect = window
                .bounds
                .as_ref()
                .and_then(window_crop_rect)
                .ok_or_else(|| {
                    "Window-relative coordinates require usable target-window bounds.".to_string()
                })?;
            let capture_rect = self
                .desktop_size
                .lock()
                .ok()
                .and_then(|guard| *guard)
                .map(|(width, height)| {
                    clip_capture_rect(full_capture_rect, width, height).map_err(|error| {
                        format!("Could not map target-window coordinates: {error:#}")
                    })
                })
                .transpose()?
                .unwrap_or(full_capture_rect);
            return Ok(WindowCoordinateMap {
                capture_rect,
                full_capture_rect,
                portal_rect: None,
            });
        }
        let (_, _, width, height) = self.capture_space_rect().await.ok_or_else(|| {
            "Could not determine screenshot dimensions for window-relative coordinates.".to_string()
        })?;
        self.window_coordinate_map_for_dimensions(window, width as u32, height as u32)
            .await
            .map_err(|error| format!("Could not map target-window coordinates: {error:#}"))
    }

    async fn resolve_accessibility_app_filter(
        &self,
        params: &GetAppStateParams,
        window_context: Option<&WindowInfo>,
        window_enumerated: bool,
    ) -> Option<String> {
        self.resolve_accessibility_app_filter_with(
            params,
            window_context,
            window_enumerated,
            || list_accessible_apps(200),
        )
        .await
    }

    async fn resolve_accessibility_app_filter_with<F, Fut>(
        &self,
        params: &GetAppStateParams,
        window_context: Option<&WindowInfo>,
        window_enumerated: bool,
        list_apps: F,
    ) -> Option<String>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<Vec<AccessibleAppSummary>>>,
    {
        if let Some(app_id) = trimmed_nonempty(params.app_id.as_deref()) {
            // A failed lookup against a successfully enumerated desktop is
            // authoritative. Only an unavailable backend permits an AT-SPI-only
            // fallback. Higher-priority window selectors must not contradict
            // the explicit app identity either.
            let rejected = window_enumerated && window_context.is_none();
            let contradictory = window_context.is_some_and(|window| {
                !window.app_id.as_deref().is_some_and(|actual| {
                    actual.eq_ignore_ascii_case(app_id)
                        || (!app_id.contains('.')
                            && crate::windows::app_id_leaf(actual).eq_ignore_ascii_case(app_id))
                })
            });
            if rejected || contradictory {
                return Some(UNMATCHABLE_ACCESSIBILITY_APP_FILTER.to_string());
            }
        }

        if let Some(explicit) = trimmed_nonempty(params.app_name_or_bundle_identifier.as_deref()) {
            return Some(explicit.to_string());
        }

        let target_pid = window_context.and_then(|window| window.pid).or(params.pid);
        let candidates = accessibility_filter_candidates(window_context);
        let app_id = trimmed_nonempty(params.app_id.as_deref()).map(|requested| {
            window_context
                .and_then(|window| trimmed_nonempty(window.app_id.as_deref()))
                .unwrap_or(requested)
        });
        let needs_app_id_evidence = app_id.is_some_and(|app_id| {
            !app_id.starts_with("window:") && !crate::windows::app_id_leaf(app_id).is_empty()
        });
        let apps = if target_pid.is_some() || needs_app_id_evidence {
            list_apps().await.ok()
        } else {
            None
        };

        if let Some(target_pid) = target_pid {
            if let Some(object_ref) = apps
                .as_deref()
                .and_then(|apps| select_accessibility_object_ref(apps, target_pid, &candidates))
            {
                return Some(object_ref);
            }
        }

        if let Some(app_id) = app_id {
            if !app_id.starts_with("window:") {
                return Some(select_accessibility_app_id_filter(apps.as_deref(), app_id));
            }
        }

        if candidates.is_empty() && trimmed_nonempty(params.app_id.as_deref()).is_some() {
            return Some(UNMATCHABLE_ACCESSIBILITY_APP_FILTER.to_string());
        }
        candidates.into_iter().next()
    }

    async fn focus_target_for_input(
        &self,
        target: &WindowTarget,
    ) -> std::result::Result<Option<WindowFocusResult>, String> {
        if !target.has_target() {
            return Ok(None);
        }

        let focus = focus_window_target(target).await.map_err(|error| {
            let error = format!("{error:#}");
            if let Some(hint) = window_permission_hint(&error) {
                format!("Did not send input because the target window could not be focused: {error}. {hint}")
            } else {
                format!("Did not send input because the target window could not be focused: {error}")
            }
        })?;

        if focus_satisfies_target(&focus, target) {
            Ok(Some(focus))
        } else {
            let required = if target.requires_exact_focus() {
                "exact target-window focus"
            } else {
                "app-level focus"
            };
            Err(format!(
                "Did not send input because {required} verification failed after activating the target window. Focus result: requested window_id {}, focused window_id {:?}.",
                focus.requested_window.window_id,
                focus.focused_window.as_ref().map(|window| window.window_id)
            ))
        }
    }

    fn cache_desktop_size(&self, width: u32, height: u32) {
        if width == 0 || height == 0 {
            return;
        }
        if let Ok(mut guard) = self.desktop_size.lock() {
            *guard = Some((width, height));
        }
    }

    async fn pixelflux_element_point(
        &self,
        bounds: Option<&crate::atspi_tree::Bounds>,
    ) -> Option<(i32, i32)> {
        let bounds = bounds?;
        let capture = self.desktop_size.lock().ok().and_then(|guard| *guard)?;
        // kscreen-doctor misreports nested KWin scale (2864x1536 at scale 1); KWin does not.
        let layout = match crate::remote_desktop::kwin_desktop_layout().await {
            Some(layout) => layout,
            None => crate::remote_desktop::logical_desktop_layout().await?,
        };
        pixelflux_point_for_element(
            (bounds.x, bounds.y, bounds.width, bounds.height),
            capture,
            &layout,
        )
    }

    #[allow(clippy::too_many_arguments)]
    async fn try_pixelflux_click(
        &self,
        x: i32,
        y: i32,
        element_click: bool,
        element_bounds: Option<&crate::atspi_tree::Bounds>,
        button: Option<&str>,
        count: u32,
        received: Option<serde_json::Value>,
        input_guard: Arc<tokio::sync::OwnedMutexGuard<()>>,
    ) -> Option<ActionOutput> {
        if crate::pixelflux::PixelfluxConfig::from_env().is_none() || count.clamp(1, 10) > 3 {
            return None;
        }
        let button = pixelflux_pointer_button(button)?;
        if count.clamp(1, 10) > 1 && !matches!(button, PointerButton::Left) {
            return None;
        }
        let point = if element_click {
            self.pixelflux_element_point(element_bounds).await
        } else {
            Some((x, y))
        };
        let Some((px, py)) = point else {
            return self.pixelflux_unmapped("click", received).await;
        };
        self.pixelflux_send(
            "click",
            crate::pixelflux::PixelfluxAction::Click {
                x: px,
                y: py,
                button,
                count: count.clamp(1, 3) as u8,
            },
            received,
            input_guard,
        )
        .await
    }

    /// An element pixelflux cannot map. Falls through only when pixelflux is absent or down.
    async fn pixelflux_unmapped(
        &self,
        action: &str,
        received: Option<serde_json::Value>,
    ) -> Option<ActionOutput> {
        let config = crate::pixelflux::PixelfluxConfig::from_env()?;
        match crate::pixelflux::probe(&config).await {
            Ok(()) => Some(ActionOutput {
                ok: false,
                implemented: true,
                action: action.to_string(),
                message: "pixelflux could not map the element onto the capture".to_string(),
                received,
            }),
            Err(error) if crate::pixelflux::is_unreachable(&error) => None,
            Err(error) => Some(pixelflux_action_output(action, Err(error), received)),
        }
    }

    async fn pixelflux_send<G: Send + 'static>(
        &self,
        action: &str,
        request: crate::pixelflux::PixelfluxAction,
        received: Option<serde_json::Value>,
        input_guard: G,
    ) -> Option<ActionOutput> {
        let config = crate::pixelflux::PixelfluxConfig::from_env()?;
        if let Err(error) = crate::pixelflux::probe(&config).await {
            if crate::pixelflux::is_unreachable(&error) {
                return None;
            }
            return Some(pixelflux_action_output(action, Err(error), received));
        }
        let (_retained, dispatched) = run_cancellation_safe_input(input_guard, async move {
            Ok::<_, String>(crate::pixelflux::send(&config, &request).await.map(|_| ()))
        })
        .await;
        let result = match dispatched {
            Ok(result) => result,
            Err(error) => return Some(ActionOutput {
                ok: false, implemented: true, action: action.to_string(), received,
                message: format!("pixelflux input task stopped ({error}); it may have run, so check the screen before retrying"),
            }),
        };
        if let Err(error) = &result {
            if crate::pixelflux::outcome_unknown(error) {
                return Some(ActionOutput {
                    ok: false,
                    implemented: true,
                    action: action.to_string(),
                    message: format!(
                        "pixelflux took {action} but did not answer ({error:#}); it may have run, so check the screen before retrying"
                    ),
                    received,
                });
            }
        }
        Some(pixelflux_action_output(action, result, received))
    }

    fn logical_portal_point(
        &self,
        session: &PortalPointerSession,
        x: i32,
        y: i32,
    ) -> Option<(i32, i32)> {
        let capture_size = self.desktop_size.lock().ok().and_then(|guard| *guard);
        session.logical_point_from_capture(x, y, capture_size)
    }

    /// Capture size for overlay points, which are in screenshot pixels like
    /// the click tools. Only a cached size is used: capturing the screen just
    /// for the overlay could prompt the user.
    fn indicator_space(&self) -> Option<(u32, u32)> {
        *self.desktop_size.lock().ok()?
    }

    /// Cosmetic secrecy probe: timeout only masks the indicator, never gates input.
    async fn typing_into_secret(&self, focus: Option<&WindowFocusResult>) -> bool {
        if !self.indicator.enabled() {
            return true;
        }
        timeout(Duration::from_millis(250), self.input_focus_probe(focus))
            .await
            .ok()
            .flatten()
            .as_ref()
            .is_none_or(focus_requires_secret_protection)
    }

    /// Probe only the receiving app; the caller chooses its own time budget.
    async fn input_focus_probe(&self, focus: Option<&WindowFocusResult>) -> Option<FocusProbe> {
        let pid = match focus {
            Some(focus) => focus
                .focused_window
                .as_ref()
                .and_then(|window| window.pid)
                .or(focus.requested_window.pid),
            None => focused_window().await.ok().flatten()?.pid,
        }?;
        probe_focused_element(Some(pid)).await.ok()
    }

    /// COORDINATE SPACES: window bounds (list_windows / extension frame rects)
    /// and the extension monitor layout are in LOGICAL pixels, while click/
    /// scroll coordinates and screenshot captures are in PHYSICAL capture
    /// pixels. On fractionally-scaled displays the two differ, so each check
    /// below only ever compares values from the same space.
    ///
    /// Logical monitor rectangles from the GNOME Shell extension, for checks
    /// against logical window bounds. None when the extension is unavailable.
    async fn logical_monitor_rects(&self) -> Option<Vec<(i32, i32, i32, i32)>> {
        let monitors = crate::windowing::backends::gnome::extension_monitor_layout()
            .await
            .ok()?;
        (!monitors.is_empty()).then(|| {
            monitors
                .iter()
                .map(|m| (m.x, m.y, m.width, m.height))
                .collect()
        })
    }

    /// Physical capture-space desktop rectangle (union of monitors as captured
    /// by the screenshot pipeline), for checks against click coordinates.
    /// Best-effort; None disables the check.
    async fn capture_space_rect(&self) -> Option<(i32, i32, i32, i32)> {
        let cached = self.desktop_size.lock().ok().and_then(|guard| *guard);
        if let Some((w, h)) = cached {
            return Some((0, 0, w as i32, h as i32));
        }
        // One-time prime: a full-frame capture reveals the desktop size when
        // no prior capture is available.
        let raw = capture_screenshot_raw().await.ok()?;
        self.cache_desktop_size(raw.width, raw.height);
        (raw.width > 0 && raw.height > 0).then_some((0, 0, raw.width as i32, raw.height as i32))
    }

    /// Warn when a targeted window pokes outside every monitor: clicks and
    /// screenshots silently truncate to visible pixels there, which reads as
    /// "success" while landing nowhere.
    async fn off_screen_note_for_bounds(
        &self,
        bounds: &crate::windowing::WindowBounds,
    ) -> Option<String> {
        let (x, y) = bounds.x.zip(bounds.y)?;
        if bounds.width == 0 || bounds.height == 0 {
            return None;
        }
        // Window bounds are logical pixels: prefer the extension's logical
        // monitor layout (same space). The physical capture rect is a safe
        // fallback — on scaled displays it is at least as large as the logical
        // union, so it can only under-warn, never false-positive.
        let rects = match self.logical_monitor_rects().await {
            Some(rects) => rects,
            None => vec![self.capture_space_rect().await?],
        };
        let (w, h) = (bounds.width as i64, bounds.height as i64);
        let window_area = w * h;
        let mut visible_area = 0_i64;
        for (mx, my, mw, mh) in &rects {
            let ix = (x as i64).max(*mx as i64);
            let iy = (y as i64).max(*my as i64);
            let ix2 = (x as i64 + w).min(*mx as i64 + *mw as i64);
            let iy2 = (y as i64 + h).min(*my as i64 + *mh as i64);
            if ix2 > ix && iy2 > iy {
                // Overlapping monitors are rare; treating them as additive keeps
                // this a cheap best-effort heuristic.
                visible_area += (ix2 - ix) * (iy2 - iy);
            }
        }
        let visible_pct = (visible_area.min(window_area) * 100) / window_area.max(1);
        if visible_pct >= 100 {
            return None;
        }
        Some(format!(
            "WARNING: the target window (bounds {x},{y} {w}x{h}) is only ~{visible_pct}% on-screen; off-screen regions are missing from screenshots and unreachable by coordinate input. Use move_window/resize_window to bring it fully on-screen."
        ))
    }

    /// Warn when a click/scroll coordinate is outside the captured desktop.
    /// Click coordinates are physical capture-space pixels, so compare ONLY
    /// against the capture rect — the extension's logical layout is a
    /// different space on scaled displays and would false-positive. This is a
    /// best-effort warning: never request a new capture (and possibly consent)
    /// merely to decide whether to append a note to an input result.
    async fn off_screen_note_for_point(&self, x: i32, y: i32) -> Option<String> {
        let (mw, mh) = self.desktop_size.lock().ok().and_then(|guard| *guard)?;
        let visible = x >= 0 && y >= 0 && (x as u32) < mw && (y as u32) < mh;
        if visible {
            return None;
        }
        Some(format!(
            "WARNING: coordinate {x},{y} is outside the captured desktop ({mw}x{mh}); the input landed on no visible pixel."
        ))
    }

    /// Post-input feedback: which AT-SPI element holds keyboard focus in the
    /// target app, and whether it is editable. Guards against the blind-typing
    /// trap where verified *window* focus still sends keystrokes nowhere.
    async fn focused_element_feedback(
        &self,
        focus: Option<&WindowFocusResult>,
        expects_editable: bool,
    ) -> Option<String> {
        let focus = focus?;
        let pid = focus
            .focused_window
            .as_ref()
            .and_then(|window| window.pid)
            .or(focus.requested_window.pid);
        match timeout(Duration::from_millis(1500), probe_focused_element(pid)).await {
            Ok(Ok(probe)) => Some(focus_probe_feedback(
                &probe,
                expects_editable,
                focus.exact_window_focused,
            )),
            Ok(Err(error)) => Some(format!(
                "Focused-element feedback unavailable ({}).",
                first_line(&format!("{error:#}"))
            )),
            Err(_) => {
                Some("Focused-element feedback unavailable (AT-SPI probe timed out).".to_string())
            }
        }
    }

    /// Shared move/resize plumbing: resolve the window target, run the GNOME
    /// Shell extension operation, then re-query bounds to report the result.
    async fn window_geometry_op<F, Fut>(
        &self,
        received: Option<serde_json::Value>,
        target: &WindowTarget,
        op: F,
    ) -> Json<WindowGeometryOutput>
    where
        F: FnOnce(crate::windowing::WindowInfo) -> Fut,
        Fut: Future<Output = Result<String>>,
    {
        let windows = match list_windows().await {
            Ok(windows) => windows,
            Err(error) => {
                let error = format!("{error:#}");
                return Json(WindowGeometryOutput {
                    ok: false,
                    implemented: true,
                    backend: "unknown".to_string(),
                    window: None,
                    message: format!("Window listing failed: {error}"),
                    permissions_hint: window_permission_hint(&error),
                    received,
                });
            }
        };
        let window = match resolve_window_target(&windows, target) {
            Ok(window) => window.clone(),
            Err(error) => {
                return Json(WindowGeometryOutput {
                    ok: false,
                    implemented: true,
                    backend: "unknown".to_string(),
                    window: None,
                    message: format!("{error:#}"),
                    permissions_hint: None,
                    received,
                });
            }
        };
        let backend = window.backend.clone();
        let window_id = window.window_id;
        match op(window).await {
            Ok(message) => {
                // Re-query so the caller sees the compositor-final geometry
                // (tiling constraints, minimum sizes, etc. may adjust it).
                let window = list_windows()
                    .await
                    .inspect_err(|_| self.diagnostics.invalidate())
                    .ok()
                    .and_then(|windows| {
                        windows
                            .into_iter()
                            .find(|window| window.window_id == window_id)
                    });
                let mut message = message;
                if let Some(bounds) = window.as_ref().and_then(|window| window.bounds.as_ref()) {
                    if let Some(note) = self.off_screen_note_for_bounds(bounds).await {
                        message = format!("{message} {note}");
                    }
                }
                Json(WindowGeometryOutput {
                    ok: true,
                    implemented: true,
                    backend,
                    window,
                    message,
                    permissions_hint: None,
                    received,
                })
            }
            Err(error) => {
                let error = format!("{error:#}");
                Json(WindowGeometryOutput {
                    ok: false,
                    implemented: true,
                    backend,
                    window: None,
                    permissions_hint: window_permission_hint(&error),
                    message: error,
                    received,
                })
            }
        }
    }

    /// Notes appended after targeted keyboard input: off-screen window warning
    /// plus focused-element feedback.
    async fn input_landing_notes(
        &self,
        focus: Option<&WindowFocusResult>,
        expects_editable: bool,
    ) -> Vec<String> {
        let mut notes = Vec::new();
        if let Some(focus) = focus {
            let bounds = focus
                .focused_window
                .as_ref()
                .and_then(|window| window.bounds.as_ref())
                .or(focus.requested_window.bounds.as_ref());
            if let Some(bounds) = bounds {
                if let Some(note) = self.off_screen_note_for_bounds(bounds).await {
                    notes.push(note);
                }
            }
        }
        if let Some(note) = self.focused_element_feedback(focus, expects_editable).await {
            notes.push(note);
        }
        notes
    }

    #[cfg(test)]
    fn cache_nodes(&self, nodes: &[AccessibilityNode]) {
        self.cache_snapshot(nodes, None);
    }

    /// Readers may perform slow AT-SPI owner checks before resolving a click
    /// or scroll again. Keep the snapshot stable for the whole input operation;
    /// otherwise a checked index could resolve to a different app's node.
    async fn commit_snapshot(&self, nodes: &[AccessibilityNode], target_pid: Option<u32>) {
        let _input_guard = Arc::clone(&self.input_operation_lock).lock_owned().await;
        self.cache_snapshot(nodes, target_pid);
    }

    async fn commit_app_state_snapshot(
        &self,
        nodes: &[AccessibilityNode],
        target_pid: Option<u32>,
        window: Option<&WindowInfo>,
        params: &GetAppStateParams,
        scoped: bool,
    ) {
        let _input_guard = Arc::clone(&self.input_operation_lock).lock_owned().await;
        let recovery_scope = scoped.then(|| AccessibilityRecoveryScope {
            params: params.clone(),
            target_pid,
        });
        self.cache_snapshot_with_window(nodes, target_pid, recovery_scope, window);
    }

    fn cache_snapshot(&self, nodes: &[AccessibilityNode], target_pid: Option<u32>) {
        self.cache_snapshot_with_scope(nodes, target_pid, None);
    }

    fn cache_snapshot_with_scope(
        &self,
        nodes: &[AccessibilityNode],
        target_pid: Option<u32>,
        recovery_scope: Option<AccessibilityRecoveryScope>,
    ) {
        self.cache_snapshot_with_window(nodes, target_pid, recovery_scope, None);
    }

    fn cache_snapshot_with_window(
        &self,
        nodes: &[AccessibilityNode],
        target_pid: Option<u32>,
        recovery_scope: Option<AccessibilityRecoveryScope>,
        window: Option<&WindowInfo>,
    ) {
        // A spilled file matches only the snapshot it was written from.
        self.tree_spiller.remove_current();
        if let Ok(mut cached) = self.last_snapshot.lock() {
            *cached = CachedAccessibilitySnapshot {
                nodes: nodes.to_vec(),
                pid: target_pid,
                window_id: window.map(|window| window.window_id),
                window_backend: window.map(|window| window.backend.clone()),
                recovery_scope,
            };
        }
    }

    #[cfg(test)]
    fn clear_cached_nodes(&self) {
        self.cache_snapshot(&[], None);
    }

    /// Reject an element-targeted action whose cached node belongs to a
    /// different app than the action's target. A snapshot taken for a pid is
    /// judged by that pid; an untargeted snapshot mixes apps, so its node is
    /// judged by the pid that owns it on the accessibility bus. When neither is
    /// known the action proceeds, since a mismatch cannot be shown.
    async fn check_node_target(
        &self,
        node: &AccessibilityNode,
        target_pid: Option<u32>,
    ) -> std::result::Result<(), String> {
        let Some(target_pid) = target_pid else {
            return Ok(());
        };
        let snapshot_pid = self
            .last_snapshot
            .lock()
            .ok()
            .and_then(|snapshot| snapshot.pid);
        let owner_pid = match snapshot_pid {
            Some(pid) => Some(pid),
            None => object_ref_owner_pid(&node.object_ref).await.ok().flatten(),
        };
        match owner_pid {
            Some(owner_pid) if owner_pid != target_pid => Err(node_target_mismatch_message(
                node.index, owner_pid, target_pid,
            )),
            _ => Ok(()),
        }
    }

    /// The cached node an element-targeted click or scroll would act on, when
    /// the call names one. Resolution errors are left to the tool's own path.
    fn cached_node_for(
        &self,
        element_index: Option<u32>,
        selector: &ElementSelector<'_>,
        purpose: ElementResolvePurpose,
    ) -> Option<AccessibilityNode> {
        if element_index.is_none() && selector.is_empty() {
            return None;
        }
        self.resolve_cached_node(element_index, selector, purpose)
            .ok()
    }

    fn resolve_optional_target_point(
        &self,
        x: Option<i32>,
        y: Option<i32>,
        element_index: Option<u32>,
    ) -> std::result::Result<Option<(i32, i32)>, String> {
        match (x.zip(y), element_index) {
            (Some(point), _) => Ok(Some(point)),
            (None, Some(index)) => self
                .center_for_cached_node(index)
                .map(Some)
                .ok_or_else(|| {
                    format!(
                        "No clickable bounds cached for element_index {index}. Call get_app_state first and choose a node with positive width and height."
                    )
                }),
            (None, None) => Ok(None),
        }
    }

    fn should_map_kwin_element_click(&self, focus: Option<&WindowFocusResult>) -> bool {
        let cached_backend = self
            .last_snapshot
            .lock()
            .ok()
            .and_then(|snapshot| snapshot.window_backend.clone());
        kwin_element_adapter_required(
            self.is_wayland_session(),
            self.is_kde_wayland_session(),
            cached_backend.as_deref(),
            focus.map(|focus| focus.requested_window.backend.as_str()),
        )
    }

    async fn prepare_kwin_element_click(
        &self,
        node: &AccessibilityNode,
        center: (i32, i32),
        global_point: bool,
        focus: Option<&WindowFocusResult>,
    ) -> std::result::Result<PreparedKwinElementClick, String> {
        let mut target = self.cached_kwin_element_target(node, center, global_point, focus)?;
        if target.pid.is_none() {
            target.pid = Some(
                object_ref_owner_pid(&node.object_ref)
                    .await
                    .map_err(|error| format!("could not identify the cached element's root PID: {error:#}"))?
                    .ok_or_else(|| {
                        "cached element's AT-SPI root PID is unavailable, so its KWin window identity cannot be verified; retry get_app_state with window_id".to_string()
                    })?,
            );
        }
        let snapshot = crate::windowing::backends::kwin::element_click_snapshot()
            .await
            .map_err(|error| format!("could not obtain a coherent KWin snapshot: {error:#}"))?;
        let raw = capture_screenshot_raw().await.map_err(|error| {
            format!("could not obtain a current raw desktop capture: {error:#}")
        })?;
        if raw.width == 0
            || raw.height == 0
            || raw.width > i32::MAX as u32
            || raw.height > i32::MAX as u32
        {
            return Err(format!(
                "current raw desktop capture has unusable dimensions {}x{}",
                raw.width, raw.height
            ));
        }
        let point = snapshot
            .map_element_click(&target, raw.width, raw.height)
            .map_err(|error| format!("{error:#}"))?;
        self.cache_desktop_size(raw.width, raw.height);
        Ok(PreparedKwinElementClick {
            element_index: node.index,
            point,
            capture_size: (raw.width, raw.height),
        })
    }

    fn cached_kwin_element_target(
        &self,
        node: &AccessibilityNode,
        center: (i32, i32),
        global_point: bool,
        focus: Option<&WindowFocusResult>,
    ) -> std::result::Result<KwinElementClickTarget, String> {
        let cached = self
            .last_snapshot
            .lock()
            .map_err(|_| "cached accessibility snapshot is unavailable".to_string())?;
        let window_id = if let Some(focus) = focus {
            let requested_id = focus.requested_window.window_id;
            let exact = focus.exact_window_focused
                && focus
                    .focused_window
                    .as_ref()
                    .is_some_and(|window| window.window_id == requested_id);
            if !exact {
                return Err(
                    "explicit window targeting requires exact KWin window focus, not app-only focus"
                        .to_string(),
                );
            }
            if let Some(cached_window_id) = cached.window_id {
                if cached_window_id != requested_id {
                    return Err(format!(
                        "cached element belongs to window_id {cached_window_id}, not the explicitly targeted window_id {requested_id}"
                    ));
                }
            }
            Some(requested_id)
        } else {
            cached.window_id
        };
        let frame = depth_one_kwin_element_frame(&cached.nodes, node, center, global_point)?;
        Ok(KwinElementClickTarget {
            window_id,
            pid: cached.pid,
            frame,
            center,
            global_point,
            require_exact_focus: focus.is_some(),
        })
    }

    fn kwin_element_click_failure(
        &self,
        element_index: u32,
        detail: &str,
        received: Option<serde_json::Value>,
    ) -> Json<ActionOutput> {
        let cached_window_id = self
            .last_snapshot
            .lock()
            .ok()
            .and_then(|snapshot| snapshot.window_id);
        let window = cached_window_id
            .map(|window_id| format!("window_id {window_id}"))
            .unwrap_or_else(|| "window_id unavailable".to_string());
        Json(ActionOutput {
            ok: false,
            implemented: true,
            action: "click".to_string(),
            message: format!(
                "click was not sent: KWin element coordinate mapping failed for element_index {element_index} ({window}): {detail}. No pointer event was emitted. Call get_app_state with the intended window_id and a full-desktop screenshot, then retry with the refreshed element_index, or pass explicit screenshot x/y coordinates."
            ),
            received,
        })
    }

    fn resolve_click_target(
        &self,
        params: &ClickParams,
    ) -> std::result::Result<ClickTarget, String> {
        if params.coordinate_space == ClickCoordinateSpace::Capture {
            if let Some((x, y)) = params.x.zip(params.y) {
                return Ok(ClickTarget::Coordinates(x, y));
            }
        }

        let selector = params.selector();
        let node = self.resolve_cached_node(
            params.element_index,
            &selector,
            ElementResolvePurpose::Click,
        )?;

        if params.coordinate_space == ClickCoordinateSpace::Atspi {
            let point = params
                .x
                .zip(params.y)
                .ok_or_else(|| "AT-SPI coordinate clicks require both x and y.".to_string())?;
            return Ok(ClickTarget::ElementPoint {
                node: Box::new(node),
                point,
            });
        }

        // Toolkit extents are not necessarily in the pointer backend's space
        // (GTK3 X11 HiDPI, GTK4 zero-origin bounds). Ordinary activation does
        // not need a guessed scale when the target exposes its native action.
        if is_plain_left_click(params.button.as_deref(), params.click_count) {
            if let Some(action) =
                primary_action(&node.actions).filter(|action| click_equivalent_action(action))
            {
                return Ok(ClickTarget::PrimaryAction {
                    object_ref: node.object_ref.clone(),
                    action_name: Some(action.name.clone()),
                    action_index: action.index,
                });
            }
        }

        if let Some(center) = node.bounds.as_ref().and_then(bounds_center) {
            return Ok(ClickTarget::ElementBounds {
                node: Box::new(node),
                center,
            });
        }

        if !is_plain_left_click(params.button.as_deref(), params.click_count) {
            return Err(format!(
                "No clickable bounds cached for element_index {}. Call get_app_state first and choose a node with positive width and height.",
                node.index
            ));
        }

        Err(format!(
            "No clickable bounds or click-equivalent AT-SPI action for element_index {}. Use perform_action explicitly for other actions.",
            node.index
        ))
    }

    fn center_for_cached_node(&self, element_index: u32) -> Option<(i32, i32)> {
        bounds_center(&self.cached_node_bounds(element_index)?)
    }

    fn cached_node_bounds(&self, element_index: u32) -> Option<crate::atspi_tree::Bounds> {
        let cached = self.last_snapshot.lock().ok()?;
        cached
            .nodes
            .iter()
            .find(|node| node.index == element_index)?
            .bounds
            .clone()
    }

    fn resolve_object_ref(
        &self,
        element_index: Option<u32>,
        element_identifier: Option<&str>,
        selector: &ElementSelector<'_>,
        purpose: ElementResolvePurpose,
    ) -> std::result::Result<String, String> {
        if let Some(element_identifier) = element_identifier
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            return Ok(element_identifier.to_string());
        }

        self.resolve_cached_node(element_index, selector, purpose)
            .map(|node| node.object_ref)
    }

    fn resolve_cached_node(
        &self,
        element_index: Option<u32>,
        selector: &ElementSelector<'_>,
        purpose: ElementResolvePurpose,
    ) -> std::result::Result<AccessibilityNode, String> {
        let cached = self.last_snapshot.lock().map_err(|_| {
            "Could not read cached accessibility nodes. Call get_app_state and retry.".to_string()
        })?;

        if let Some(element_index) = element_index {
            return cached.nodes
                .iter()
                .find(|node| node.index == element_index)
                .cloned()
                .ok_or_else(|| {
                    format!(
                        "No cached accessibility node for element_index {element_index}. Call get_app_state first."
                    )
                });
        }

        if selector.is_empty() {
            return Err(
                "Pass element_index, element_identifier, or a semantic selector such as role/name/text/states from the latest get_app_state result."
                    .to_string(),
            );
        }

        resolve_semantic_node(cached.nodes.as_slice(), selector, purpose)
    }

    async fn refresh_action_snapshot(
        &self,
        scope: &AccessibilityRecoveryScope,
    ) -> Result<RefreshedAccessibilitySnapshot> {
        let params = &scope.params;
        let (window_context, _, _, window_enumerated, _) =
            self.resolve_window_context(params).await;
        let app_filter = self
            .resolve_accessibility_app_filter(params, window_context.as_ref(), window_enumerated)
            .await;
        let target_pid = action_recovery_target_pid(
            scope,
            window_context.as_ref().and_then(|window| window.pid),
        );
        let (max_nodes, max_depth) =
            crate::atspi_tree::snapshot_limits(params.max_nodes, params.max_depth);
        let snapshot = snapshot_accessibility_tree(
            app_filter.as_deref(),
            accessibility_snapshot_target_pid(app_filter.as_deref(), target_pid),
            max_nodes,
            max_depth,
        )
        .await?;
        Ok(RefreshedAccessibilitySnapshot {
            snapshot,
            target_pid,
            window: window_context,
        })
    }

    async fn perform_element_action(
        &self,
        params: &ActionParams,
        requested_action: Option<&str>,
    ) -> Json<ActionOutput> {
        self.perform_element_action_with(
            params,
            requested_action,
            |object_ref, requested_action| async move {
                invoke_accessibility_action(&object_ref, requested_action.as_deref()).await
            },
            |scope| async move { self.refresh_action_snapshot(&scope).await },
        )
        .await
    }

    async fn perform_element_action_with<I, R, IFut, RFut>(
        &self,
        params: &ActionParams,
        requested_action: Option<&str>,
        mut invoke: I,
        refresh: R,
    ) -> Json<ActionOutput>
    where
        I: FnMut(String, Option<String>) -> IFut,
        IFut: Future<Output = Result<crate::atspi_tree::ActionInvocation>>,
        R: FnOnce(AccessibilityRecoveryScope) -> RFut,
        RFut: Future<Output = Result<RefreshedAccessibilitySnapshot>>,
    {
        let _input_guard = Arc::clone(&self.input_operation_lock).lock_owned().await;
        let received = Some(serde_json::json!(params.clone()));
        let object_ref = match self.resolve_object_ref(
            params.element_index,
            params.element_identifier.as_deref(),
            &params.selector(),
            ElementResolvePurpose::Action,
        ) {
            Ok(object_ref) => object_ref,
            Err(message) => return action_error_output(message, &received),
        };

        self.indicator.action("perform_action").await;
        let error = match invoke(object_ref.clone(), requested_action.map(str::to_string)).await {
            Ok(invocation) => return action_invocation_output(invocation, &received),
            Err(error) => error,
        };

        let semantic_recovery = params.element_index.is_none()
            && trimmed_nonempty(params.element_identifier.as_deref()).is_none()
            && !params.selector().is_empty();
        if !semantic_recovery || !is_recoverable_action_query_error(&error) {
            return action_error_output(error.to_string(), &received);
        }

        let original_error = format!("{error:#}");
        let (recovery_scope, original_window) = self
            .last_snapshot
            .lock()
            .ok()
            .map(|snapshot| {
                (
                    snapshot.recovery_scope.clone(),
                    snapshot.window_id.zip(snapshot.window_backend.clone()),
                )
            })
            .unwrap_or((None, None));
        let Some(recovery_scope) = recovery_scope else {
            return action_error_output(
                format!(
                    "{original_error}. The cached snapshot has no stable scoped recovery target. Call get_app_state for the target app, then retry perform_action."
                ),
                &received,
            );
        };
        let original_pid = recovery_scope.params.pid.or(recovery_scope.target_pid);
        let observed_window_scope =
            recovery_scope.params.window_id.is_some() && original_window.is_some();
        if original_pid.is_none() && !observed_window_scope {
            return action_error_output(
                format!(
                    "{original_error}. Automatic AT-SPI target recovery requires an observed PID or exact window-scoped snapshot. An app name, app_id, title, or an unobserved window_id cannot establish the original app identity. Call get_app_state with pid or window_id before retrying."
                ),
                &received,
            );
        }

        let refreshed = match refresh(recovery_scope.clone()).await {
            Ok(refreshed) => refreshed,
            Err(refresh_error) => {
                return action_error_output(
                    format!(
                        "{original_error}. Automatic AT-SPI target recovery could not refresh the original scoped snapshot: {refresh_error:#}. Call get_app_state for the target app, then retry perform_action."
                    ),
                    &received,
                );
            }
        };
        let snapshot = refreshed.snapshot;
        // Fresh window discovery must not replace the identity originally
        // observed by get_app_state. A process change needs a new observation.
        // A window match alone cannot identify its accessibility root.
        let pid_scope_matches = original_pid
            .or(refreshed.target_pid)
            .is_some_and(|pid| snapshot.root_pid == Some(pid));
        let window_scope_matches = if recovery_scope.params.window_id.is_some() {
            // The resolver accepts JSON-rounded IDs. Compare the actual
            // observed identity, not the raw requested number.
            original_window
                .as_ref()
                .zip(refreshed.window.as_ref())
                .is_some_and(|((window_id, backend), window)| {
                    window.window_id == *window_id && window.backend == *backend
                })
        } else {
            true
        };
        if !snapshot.scoped
            || !snapshot.app_filter_matched
            || !pid_scope_matches
            || !window_scope_matches
        {
            return action_error_output(
                format!(
                    "{original_error}. Automatic AT-SPI target recovery could not prove that the refreshed tree has the original app scope and any explicit window_id target. Call get_app_state for the target app, then retry perform_action."
                ),
                &received,
            );
        }

        let (nodes, _) = compact_accessibility_tree_with_note(
            snapshot.nodes,
            snapshot.scoped,
            snapshot.truncated,
        );
        // A recovery tree has not been shown to the caller. Its compacted
        // indices must never silently replace indices from get_app_state.
        self.cache_snapshot(&[], None);
        let recovered = match resolve_semantic_node(
            &nodes,
            &params.selector(),
            ElementResolvePurpose::Action,
        ) {
            Ok(node) => node,
            Err(message) => {
                return action_error_output(
                    format!(
                        "{original_error}. AT-SPI target recovery refreshed the scoped snapshot but could not re-resolve the semantic selector: {message}. Call get_app_state for the target app and choose the element again."
                    ),
                    &received,
                );
            }
        };
        if recovered.object_ref == object_ref {
            return action_error_output(
                format!(
                    "{original_error}. AT-SPI target recovery resolved the same dead object identity. Call get_app_state for the target app, then retry perform_action."
                ),
                &received,
            );
        }

        let Json(output) =
            match invoke(recovered.object_ref, requested_action.map(str::to_string)).await {
                Ok(invocation) => action_invocation_output(invocation, &received),
                Err(error) => action_error_output(error.to_string(), &received),
            };
        Json(with_notes(output, [
            "Recovery invalidated the cached element indices. Call get_app_state before any further element-indexed action.".to_string(),
        ]))
    }
}

fn action_recovery_target_pid(
    scope: &AccessibilityRecoveryScope,
    resolved_window_pid: Option<u32>,
) -> Option<u32> {
    scope
        .params
        .pid
        .or(scope.target_pid)
        .or(resolved_window_pid)
}

fn is_recoverable_action_query_error(error: &anyhow::Error) -> bool {
    if error.chain().any(|cause| {
        cause
            .to_string()
            .starts_with("failed to invoke AT-SPI action ")
    }) {
        return false;
    }

    error.chain().any(|cause| {
        if let Some(zbus::Error::MethodError(name, _, _)) = cause.downcast_ref::<zbus::Error>() {
            if matches!(
                name.as_str(),
                "org.freedesktop.DBus.Error.ServiceUnknown"
                    | "org.freedesktop.DBus.Error.NameHasNoOwner"
            ) {
                return true;
            }
        }
        if matches!(
            cause.downcast_ref::<zbus::fdo::Error>(),
            Some(zbus::fdo::Error::ServiceUnknown(_) | zbus::fdo::Error::NameHasNoOwner(_))
        ) {
            return true;
        }
        let message = cause.to_string();
        message.contains("ServiceUnknown") || message.contains("NameHasNoOwner")
    })
}

fn action_error_output(
    message: String,
    received: &Option<serde_json::Value>,
) -> Json<ActionOutput> {
    Json(ActionOutput {
        ok: false,
        implemented: true,
        action: "perform_action".to_string(),
        message,
        received: received.clone(),
    })
}

fn action_invocation_output(
    invocation: crate::atspi_tree::ActionInvocation,
    received: &Option<serde_json::Value>,
) -> Json<ActionOutput> {
    Json(ActionOutput {
        ok: invocation.ok,
        implemented: true,
        action: "perform_action".to_string(),
        message: if invocation.ok {
            format!(
                "AT-SPI action {} ({}) invoked.",
                invocation.action_index,
                invocation
                    .action_name
                    .as_deref()
                    .filter(|name| !name.is_empty())
                    .unwrap_or("unnamed")
            )
        } else {
            format!(
                "AT-SPI action {} ({}) returned false.",
                invocation.action_index,
                invocation
                    .action_name
                    .as_deref()
                    .filter(|name| !name.is_empty())
                    .unwrap_or("unnamed")
            )
        },
        received: received.clone(),
    })
}

#[derive(Debug, Clone, Copy)]
struct PreparedKwinElementClick {
    element_index: u32,
    point: KwinElementClickPoint,
    capture_size: (u32, u32),
}

impl PreparedKwinElementClick {
    fn uinput_point(self) -> (i32, i32) {
        self.point.capture
    }

    fn portal_point(self) -> (i32, i32) {
        self.point.logical
    }
}

fn kwin_element_adapter_required(
    is_wayland: bool,
    is_kde_wayland: bool,
    cached_backend: Option<&str>,
    explicit_backend: Option<&str>,
) -> bool {
    if !is_wayland {
        return false;
    }
    if let Some(backend) = explicit_backend {
        return backend == KWIN_BACKEND;
    }
    cached_backend.map_or(is_kde_wayland, |backend| backend == KWIN_BACKEND)
}

fn depth_one_kwin_element_frame(
    nodes: &[AccessibilityNode],
    node: &AccessibilityNode,
    center: (i32, i32),
    global_point: bool,
) -> std::result::Result<KwinElementFrame, String> {
    let mut parent_index = node.parent_index;
    let mut visited = Vec::new();
    while let Some(index) = parent_index {
        if visited.contains(&index) {
            return Err("cached element ancestry contains a cycle".to_string());
        }
        visited.push(index);
        let parent = nodes
            .iter()
            .find(|candidate| candidate.index == index)
            .ok_or_else(|| {
                "cached element is missing its depth-1 frame/window ancestry".to_string()
            })?;
        if parent.depth == 1 {
            if !matches!(
                parent.role.trim().to_ascii_lowercase().as_str(),
                "frame" | "window" | "dialog" | "alert"
            ) {
                return Err(
                    "cached element's depth-1 ancestor is not a frame/window/dialog/alert"
                        .to_string(),
                );
            }
            let bounds = parent
                .bounds
                .as_ref()
                .ok_or_else(|| "cached element's depth-1 frame/window has no bounds".to_string())?;
            bounds_center(bounds).ok_or_else(|| {
                "cached element's depth-1 frame/window bounds are unusable".to_string()
            })?;
            let right = i64::from(bounds.x) + i64::from(bounds.width);
            let bottom = i64::from(bounds.y) + i64::from(bounds.height);
            if !global_point
                && (i64::from(center.0) < i64::from(bounds.x)
                    || i64::from(center.0) >= right
                    || i64::from(center.1) < i64::from(bounds.y)
                    || i64::from(center.1) >= bottom)
            {
                return Err("element center is outside its depth-1 AT-SPI frame/window".to_string());
            }
            return Ok(KwinElementFrame {
                x: bounds.x,
                y: bounds.y,
                width: bounds.width,
                height: bounds.height,
            });
        }
        if parent.depth == 0 {
            break;
        }
        parent_index = parent.parent_index;
    }
    Err("cached element has no depth-1 frame/window ancestor".to_string())
}

pub(crate) fn pixelflux_point_for_element(
    bounds: (i32, i32, i32, i32),
    capture: (u32, u32),
    layout: &[crate::remote_desktop::LogicalMonitor],
) -> Option<(i32, i32)> {
    if layout.is_empty() || capture.0 == 0 || capture.1 == 0 {
        return None;
    }
    let logical_w = layout
        .iter()
        .map(|monitor| monitor.x.saturating_add(monitor.width))
        .max()?;
    let logical_h = layout
        .iter()
        .map(|monitor| monitor.y.saturating_add(monitor.height))
        .max()?;
    if logical_w <= 0 || logical_h <= 0 {
        return None;
    }
    let scale_x = f64::from(capture.0) / f64::from(logical_w);
    let scale_y = f64::from(capture.1) / f64::from(logical_h);
    if (scale_x - scale_y).abs() > 0.02 {
        return None;
    }
    let (x, y, width, height) = bounds;
    let centre_x = f64::from(x) + f64::from(width) / 2.0;
    let centre_y = f64::from(y) + f64::from(height) / 2.0;
    Some((
        (centre_x * scale_x).round() as i32,
        (centre_y * scale_y).round() as i32,
    ))
}

fn pixelflux_pointer_button(button: Option<&str>) -> Option<crate::remote_desktop::PointerButton> {
    match button.unwrap_or("left").to_ascii_lowercase().as_str() {
        "left" => Some(crate::remote_desktop::PointerButton::Left),
        "right" => Some(crate::remote_desktop::PointerButton::Right),
        "middle" => Some(crate::remote_desktop::PointerButton::Middle),
        _ => None,
    }
}

fn pixelflux_action_output(
    action: &str,
    result: anyhow::Result<()>,
    received: Option<serde_json::Value>,
) -> ActionOutput {
    match result {
        Ok(()) => ActionOutput {
            ok: true,
            implemented: true,
            action: action.to_string(),
            message: "Action sent through pixelflux.".to_string(),
            received,
        },
        Err(error) => ActionOutput {
            ok: false,
            implemented: true,
            action: action.to_string(),
            message: format!("pixelflux did not accept {action}: {error:#}"),
            received,
        },
    }
}

#[derive(Debug)]
enum ClickTarget {
    Coordinates(i32, i32),
    ElementBounds {
        node: Box<AccessibilityNode>,
        center: (i32, i32),
    },
    ElementPoint {
        node: Box<AccessibilityNode>,
        point: (i32, i32),
    },
    PrimaryAction {
        object_ref: String,
        action_name: Option<String>,
        action_index: i32,
    },
}

#[derive(Debug, Clone, Copy)]
enum ElementResolvePurpose {
    Click,
    Action,
    SetValue,
}

#[derive(Debug, Clone, Copy, Default)]
struct ElementSelector<'a> {
    role: Option<&'a str>,
    name: Option<&'a str>,
    text: Option<&'a str>,
    states: &'a [String],
}

impl ElementSelector<'_> {
    fn is_empty(&self) -> bool {
        [self.role, self.name, self.text]
            .into_iter()
            .all(|value| value.map(str::trim).is_none_or(str::is_empty))
            && self.states.iter().all(|value| value.trim().is_empty())
    }
}

fn resolve_semantic_node(
    nodes: &[AccessibilityNode],
    selector: &ElementSelector<'_>,
    purpose: ElementResolvePurpose,
) -> std::result::Result<AccessibilityNode, String> {
    let mut matches = nodes
        .iter()
        .filter(|node| node_matches_selector(node, selector))
        .collect::<Vec<_>>();

    if matches.is_empty() {
        return Err(format!(
            "No cached accessibility node matched semantic selector {}. Call get_app_state first or pass element_index.",
            describe_selector(selector)
        ));
    }

    if let Some(node) =
        unique_preferred_node(&matches, |node| node_matches_resolve_purpose(node, purpose))
    {
        return Ok(node.clone());
    }

    let useful_matches = matches
        .iter()
        .copied()
        .filter(|node| node_matches_resolve_purpose(node, purpose))
        .collect::<Vec<_>>();
    if !useful_matches.is_empty() {
        matches = useful_matches;
    }

    if let Some(node) = unique_preferred_node(&matches, node_is_showing) {
        return Ok(node.clone());
    }

    let visible_matches = matches
        .iter()
        .copied()
        .filter(|node| node_is_showing(node))
        .collect::<Vec<_>>();
    if !visible_matches.is_empty() {
        matches = visible_matches;
    }

    if matches.len() == 1 {
        return Ok(matches[0].clone());
    }

    Err(format!(
        "Semantic selector {} matched multiple cached nodes: {}. Pass element_index or add more selector fields.",
        describe_selector(selector),
        describe_matching_nodes(&matches),
    ))
}

fn unique_preferred_node<'a>(
    nodes: &[&'a AccessibilityNode],
    predicate: impl Fn(&AccessibilityNode) -> bool,
) -> Option<&'a AccessibilityNode> {
    let mut matches = nodes.iter().copied().filter(|node| predicate(node));
    let first = matches.next()?;
    matches.next().is_none().then_some(first)
}

fn node_matches_selector(node: &AccessibilityNode, selector: &ElementSelector<'_>) -> bool {
    selector
        .role
        .is_none_or(|role| normalized_contains(Some(node.role.as_str()), role))
        && selector
            .name
            .is_none_or(|name| normalized_contains(node.name.as_deref(), name))
        && selector.text.is_none_or(|text| {
            normalized_contains(
                node.text
                    .as_ref()
                    .and_then(|value| value.content.as_deref()),
                text,
            ) || normalized_contains(node.name.as_deref(), text)
                || normalized_contains(node.description.as_deref(), text)
        })
        && selector
            .states
            .iter()
            .filter(|state| !state.trim().is_empty())
            .all(|state| {
                node.states
                    .iter()
                    .any(|node_state| normalized_equals(node_state, state))
            })
}

fn node_matches_resolve_purpose(node: &AccessibilityNode, purpose: ElementResolvePurpose) -> bool {
    match purpose {
        ElementResolvePurpose::Click => {
            node.bounds.as_ref().and_then(bounds_center).is_some()
                || primary_action_name(&node.actions).is_some()
        }
        ElementResolvePurpose::Action => !node.actions.is_empty(),
        ElementResolvePurpose::SetValue => node.supports_editable_text || node.value.is_some(),
    }
}

fn node_is_showing(node: &AccessibilityNode) -> bool {
    node.states
        .iter()
        .any(|state| normalized_equals(state, "showing"))
        && node
            .states
            .iter()
            .any(|state| normalized_equals(state, "visible"))
}

fn normalized_equals(actual: &str, expected: &str) -> bool {
    normalize_text(actual) == normalize_text(expected)
}

fn normalized_contains(actual: Option<&str>, expected: &str) -> bool {
    let expected = normalize_text(expected);
    !expected.is_empty()
        && actual
            .map(normalize_text)
            .is_some_and(|actual| actual.contains(&expected))
}

fn normalize_text(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn describe_selector(selector: &ElementSelector<'_>) -> String {
    let mut parts = Vec::new();
    if let Some(role) = selector.role.map(str::trim).filter(|role| !role.is_empty()) {
        parts.push(format!("role={role:?}"));
    }
    if let Some(name) = selector.name.map(str::trim).filter(|name| !name.is_empty()) {
        parts.push(format!("name={name:?}"));
    }
    if let Some(text) = selector.text.map(str::trim).filter(|text| !text.is_empty()) {
        parts.push(format!("text={text:?}"));
    }
    let states = selector
        .states
        .iter()
        .map(|state| state.trim())
        .filter(|state| !state.is_empty())
        .collect::<Vec<_>>();
    if !states.is_empty() {
        parts.push(format!("states={states:?}"));
    }
    if parts.is_empty() {
        "<empty>".to_string()
    } else {
        parts.join(", ")
    }
}

fn describe_matching_nodes(nodes: &[&AccessibilityNode]) -> String {
    nodes
        .iter()
        .take(8)
        .map(|node| {
            format!(
                "element_index {} role={:?} name={:?}",
                node.index, node.role, node.name
            )
        })
        .collect::<Vec<_>>()
        .join("; ")
}

fn is_plain_left_click(button: Option<&str>, click_count: Option<u32>) -> bool {
    let button = button.unwrap_or("left");
    let click_count = click_count.unwrap_or(1);
    matches!(button.to_ascii_lowercase().as_str(), "left" | "primary") && click_count == 1
}

fn click_equivalent_action(action: &AccessibilityAction) -> bool {
    matches!(
        action.name.to_ascii_lowercase().as_str(),
        "click" | "press" | "toggle"
    )
}

fn requested_or_primary_action(action: Option<&str>) -> &str {
    match action.map(str::trim).filter(|value| !value.is_empty()) {
        Some(action) => action,
        None => "0",
    }
}

fn primary_action(actions: &[AccessibilityAction]) -> Option<&AccessibilityAction> {
    actions.first()
}

fn primary_action_name(actions: &[AccessibilityAction]) -> Option<String> {
    primary_action(actions).map(|action| action.name.clone())
}

fn bounds_center(bounds: &Bounds) -> Option<(i32, i32)> {
    if bounds.width <= 0 || bounds.height <= 0 {
        return None;
    }
    if bounds.x <= i32::MIN / 2 || bounds.y <= i32::MIN / 2 {
        return None;
    }
    Some((
        bounds.x.checked_add(bounds.width / 2)?,
        bounds.y.checked_add(bounds.height / 2)?,
    ))
}

/// Context-cost warning for an AT-SPI snapshot that no app target narrowed.
/// Silent when the tree failed (the failure message already explains) or when
/// any filter or pid match scoped the roots. When the caller did pass a target
/// and it still matched no AT-SPI root, telling them to pass a target would
/// only replay the same desktop-wide snapshot, so that case points at the
/// app's accessibility support instead.
fn unscoped_accessibility_tree_warning(
    tree_scoped: bool,
    tree_ok: bool,
    target_requested: bool,
) -> Option<&'static str> {
    if !tree_ok || tree_scoped {
        return None;
    }
    Some(if target_requested {
        "WARNING: the requested target matched no AT-SPI application root, so the accessibility tree covers the whole desktop and can flood context. The target app may expose no accessibility tree (Electron apps need --force-renderer-accessibility); check list_apps for its AT-SPI name and pass that as app_name_or_bundle_identifier, or lower max_nodes to bound the cost."
    } else {
        "WARNING: no app target scoped the accessibility tree, so it covers the whole desktop and can flood context. Pass app_name_or_bundle_identifier or a window target (window_id, pid, app_id, wm_class, title) to limit it."
    })
}

/// Note appended when raw traversal hit max_nodes; the tree is incomplete.
fn truncated_accessibility_tree_note(truncated: bool) -> Option<&'static str> {
    truncated.then_some(
        "The node, depth, read, or time budget stopped traversal with unread elements left. To recover missing elements, scope to a narrower app or window target and raise max_nodes or max_depth (hard caps 10000 and 64). Embedded browser content can exhaust an app-scoped budget before its editor; temporarily hide that pane if a larger request still truncates. Lowering max_nodes would drop more.",
    )
}

fn shell_only_accessibility_tree_note(
    nodes: &[AccessibilityNode],
    scoped: bool,
    truncated: bool,
) -> Option<&'static str> {
    if !scoped || truncated || nodes.is_empty() {
        return None;
    }
    let mut menu_nodes = std::collections::HashSet::new();
    nodes.iter().all(|node| {
        let in_menu = node.parent_index.is_some_and(|parent| menu_nodes.contains(&parent));
        let Some(menu) = accessibility_chrome_context(&node.role, in_menu) else {
            return false;
        };
        if menu {
            menu_nodes.insert(node.index);
        }
        let has_content_text = !menu && node.text.as_ref().and_then(|text| text.content.as_deref())
            .is_some_and(|text| text.chars().any(|ch| ch != '\u{fffc}' && !ch.is_whitespace()));
        !node.supports_editable_text && node.value.is_none() && !has_content_text
    })
        .then_some(
            "AT-SPI exposes only window/menu chrome; no content controls were observed. If this is an Electron/Chromium app, relaunch it with --force-renderer-accessibility to expose renderer content. Screenshots can still be used for observation; this tree does not establish that the UI is empty.",
        )
}

/// Bytes kept for an action result's other fields when it carries a tree.
const POST_ACTION_RESULT_RESERVE: usize = 4_000;
/// Bytes kept for the spill field and its note.
const SPILL_NOTE_RESERVE: usize = 1_000;

/// Inline tree budget once `rest` bytes of the result are spoken for.
fn tree_budget(rest: usize) -> usize {
    crate::tree_spill::INLINE_RESULT_BYTES.saturating_sub(rest + SPILL_NOTE_RESERVE)
}

/// Keep `nodes` within the inline budget, spilling the whole tree to a private
/// file when it does not fit. Returns the spill and a note for the message.
fn fit_tree(
    spiller: &crate::tree_spill::TreeSpiller,
    nodes: &mut Vec<AccessibilityNode>,
    budget: usize,
) -> (Option<crate::tree_spill::TreeSpill>, Option<String>) {
    let total = nodes.len();
    match spiller.fit(nodes, budget) {
        Ok(None) => (None, None),
        Ok(Some(spill)) => {
            let note = format!(
                "The compacted tree has {total} nodes ({} KB), too large to return inline: the first {} are here and the whole tree is in {} (a JSON array with the same element_index values), or page through it with get_tree_page. Search that file for a role, name, or text instead of requesting the tree again; it lasts until the next snapshot or until this server exits.",
                spill.bytes.div_ceil(1024),
                spill.inline_node_count,
                spill.path,
            );
            (Some(spill), Some(note))
        }
        Err((inline, error)) => (
            None,
            Some(format!(
                "The compacted tree has {total} nodes, too large to return inline, and writing it to a file failed ({error}); only the first {inline} are here. Scope to a narrower target to see the rest."
            )),
        ),
    }
}

fn compact_accessibility_tree_with_note(
    nodes: Vec<AccessibilityNode>,
    scoped: bool,
    truncated: bool,
) -> (Vec<AccessibilityNode>, Option<&'static str>) {
    // Menu ancestry is observation metadata; compaction can remove its nodes.
    let note = shell_only_accessibility_tree_note(&nodes, scoped, truncated);
    (compact_accessibility_tree(nodes), note)
}

fn compact_accessibility_tree(nodes: Vec<AccessibilityNode>) -> Vec<AccessibilityNode> {
    if nodes.is_empty() {
        return nodes;
    }

    let keep = nodes
        .iter()
        .map(should_keep_accessibility_node)
        .collect::<Vec<_>>();
    let mut old_to_new = vec![None; nodes.len()];
    let mut compacted = Vec::new();

    for (old_index, node) in nodes.iter().enumerate() {
        if !keep[old_index] {
            continue;
        }

        let mut compacted_node = node.clone();
        compacted_node.index = compacted.len() as u32;
        compacted_node.parent_index = nearest_kept_parent(&keep, &nodes, old_index);
        old_to_new[old_index] = Some(compacted_node.index);
        compacted.push(compacted_node);
    }

    for node in &mut compacted {
        node.parent_index = node
            .parent_index
            .and_then(|old_parent| old_to_new.get(old_parent as usize).copied().flatten());
    }

    let child_counts = compacted.iter().filter_map(|node| node.parent_index).fold(
        vec![0_i32; compacted.len()],
        |mut counts, parent_index| {
            counts[parent_index as usize] += 1;
            counts
        },
    );

    for (index, node) in compacted.iter_mut().enumerate() {
        node.child_count = child_counts[index];
    }

    compacted
}

fn nearest_kept_parent(
    keep: &[bool],
    nodes: &[AccessibilityNode],
    old_index: usize,
) -> Option<u32> {
    let mut parent = nodes[old_index].parent_index;
    while let Some(parent_index) = parent {
        let parent_usize = parent_index as usize;
        if keep.get(parent_usize).copied().unwrap_or(false) {
            return Some(parent_index);
        }
        parent = nodes.get(parent_usize).and_then(|node| node.parent_index);
    }
    None
}

fn should_keep_accessibility_node(node: &AccessibilityNode) -> bool {
    if node.depth <= 1 {
        return true;
    }

    if is_actionable_accessibility_node(node) || has_meaningful_node_copy(node) {
        return true;
    }

    matches!(
        node.role.as_str(),
        "page tab" | "menu item" | "menu" | "list item" | "tree item"
    ) && !is_sentinel_or_missing_bounds(node.bounds.as_ref())
}

fn is_actionable_accessibility_node(node: &AccessibilityNode) -> bool {
    !node.actions.is_empty() || node.supports_editable_text || node.value.is_some()
}

fn has_meaningful_node_copy(node: &AccessibilityNode) -> bool {
    has_non_empty_text(node.name.as_deref())
        || has_non_empty_text(node.description.as_deref())
        || has_non_empty_text(node.text.as_ref().and_then(|text| text.content.as_deref()))
}

fn has_non_empty_text(value: Option<&str>) -> bool {
    value.map(str::trim).is_some_and(|value| !value.is_empty())
}

fn is_sentinel_or_missing_bounds(bounds: Option<&Bounds>) -> bool {
    bounds.is_none()
}

fn select_accessibility_app_id_filter(
    apps: Option<&[AccessibleAppSummary]>,
    app_id: &str,
) -> String {
    let leaf = crate::windows::app_id_leaf(app_id);
    let Some(apps) = apps.filter(|_| !leaf.is_empty()) else {
        return UNMATCHABLE_ACCESSIBILITY_APP_FILTER.to_string();
    };
    let mut matches = apps.iter().filter(|app| {
        app.name
            .as_deref()
            .is_some_and(|name| crate::windows::app_id_leaf(name).eq_ignore_ascii_case(leaf))
    });
    let Some(first) = matches.next() else {
        return UNMATCHABLE_ACCESSIBILITY_APP_FILTER.to_string();
    };
    if matches.next().is_some() {
        return UNMATCHABLE_ACCESSIBILITY_APP_FILTER.to_string();
    }
    first.object_ref.clone()
}

fn accessibility_snapshot_target_pid(
    app_filter: Option<&str>,
    target_pid: Option<u32>,
) -> Option<u32> {
    // select_roots normally falls back to PID-only matches. A rejected app ID
    // must not regain that window's tree through this fallback.
    if app_filter == Some(UNMATCHABLE_ACCESSIBILITY_APP_FILTER) {
        None
    } else {
        target_pid
    }
}

fn select_accessibility_object_ref(
    apps: &[AccessibleAppSummary],
    target_pid: u32,
    candidates: &[String],
) -> Option<String> {
    let mut pid_matches = apps.iter().filter(|app| app.pid == Some(target_pid));
    let first = pid_matches.next()?;
    let second = pid_matches.next();

    if second.is_none() {
        return Some(first.object_ref.clone());
    }

    let lowered_candidates = candidates
        .iter()
        .map(|candidate| candidate.to_ascii_lowercase())
        .collect::<Vec<_>>();

    apps.iter()
        .filter(|app| app.pid == Some(target_pid))
        .find(|app| {
            let name = app.name.as_deref().unwrap_or_default().to_ascii_lowercase();
            lowered_candidates
                .iter()
                .any(|candidate| !candidate.is_empty() && name.contains(candidate))
        })
        .map(|app| app.object_ref.clone())
        .or_else(|| Some(first.object_ref.clone()))
}

fn accessibility_filter_candidates(window_context: Option<&WindowInfo>) -> Vec<String> {
    let Some(window) = window_context else {
        return Vec::new();
    };

    let mut candidates = Vec::new();
    push_candidate(&mut candidates, window.title.as_deref());
    push_candidate(&mut candidates, window.wm_class.as_deref());

    if let Some(app_id) = trimmed_nonempty(window.app_id.as_deref()) {
        if !app_id.starts_with("window:") {
            push_candidate(&mut candidates, Some(app_id));
            if let Some(stripped) = app_id.strip_suffix(".desktop") {
                push_candidate(&mut candidates, Some(stripped));
                let normalized = stripped.replace(['-', '_', '.'], " ");
                push_candidate(&mut candidates, Some(normalized.as_str()));
            } else {
                let normalized = app_id.replace(['-', '_', '.'], " ");
                push_candidate(&mut candidates, Some(normalized.as_str()));
            }
            push_candidate(&mut candidates, Some(crate::windows::app_id_leaf(app_id)));
        }
    }

    candidates
}

fn push_candidate(candidates: &mut Vec<String>, value: Option<&str>) {
    let Some(value) = trimmed_nonempty(value) else {
        return;
    };

    if !candidates.iter().any(|candidate| candidate == value) {
        candidates.push(value.to_string());
    }
}

fn trimmed_nonempty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

fn env_contains(key: &str, needle: &str) -> bool {
    env::var(key)
        .ok()
        .is_some_and(|value| value.to_ascii_lowercase().contains(needle))
}

/// True when an environment variable is set to `"1"` (an explicit on switch).
fn env_flag_enabled(key: &str) -> bool {
    env::var(key).ok().as_deref() == Some("1")
}

fn env_flag_enabled_any(keys: &[&str]) -> bool {
    keys.iter().any(|key| env_flag_enabled(key))
}

fn env_var_non_empty(key: &str) -> bool {
    env::var(key)
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
}

/// Return the base64 payload of a `data:` URL (or the original string if bare).
fn data_url_payload(data_url: &str) -> String {
    data_url
        .split_once(',')
        .map(|(_, payload)| payload)
        .unwrap_or(data_url)
        .to_string()
}

fn session_is_wayland(session_type: Option<&str>, wayland_display: Option<&str>) -> bool {
    match session_type
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(value) => value.eq_ignore_ascii_case("wayland"),
        None => wayland_display.is_some_and(|value| !value.trim().is_empty()),
    }
}

fn native_x11_xdotool_pointer_session(
    session_type: Option<&str>,
    wayland_display: Option<&str>,
) -> bool {
    session_type.is_some_and(|value| value.trim().eq_ignore_ascii_case("x11"))
        && wayland_display.is_none_or(|value| value.trim().is_empty())
}

fn prefer_xdotool_pointer(
    force_ydotool: bool,
    session_type: Option<&str>,
    display_available: bool,
    wayland_display: Option<&str>,
) -> bool {
    !force_ydotool
        && native_x11_xdotool_pointer_session(session_type, wayland_display)
        && display_available
}

fn prefer_xdotool_keyboard(
    force_ydotool: bool,
    force_xdotool: bool,
    is_wayland: bool,
    display_available: bool,
    xdotool_available: bool,
) -> bool {
    !force_ydotool && display_available && xdotool_available && (force_xdotool || !is_wayland)
}

fn prepare_app_state_screenshot(
    mut raw: RawScreenshotCapture,
    crop: Option<(i32, i32, u32, u32)>,
    target_requested: bool,
    options: ScreenshotPayloadOptions,
) -> Result<ScreenshotCapture> {
    if target_requested && crop.is_none() {
        anyhow::bail!(
            "targeted screenshot requires a resolved window; refusing to return the full desktop"
        );
    }
    if let Some(rect) = crop {
        let (x, y, width, height) = clip_capture_rect(rect, raw.width, raw.height)?;
        let (bytes, width, height) = crop_png(&raw.bytes, x, y, width, height)
            .map_err(|error| anyhow::anyhow!("targeted screenshot crop failed: {error}"))?;
        raw = RawScreenshotCapture {
            mime_type: raw.mime_type,
            bytes,
            source: raw.source,
            width,
            height,
        };
    }
    prepare_screenshot_payload(raw, options)
}

fn ensure_readonly_screenshot_target_is_visible(window: &WindowInfo) -> Result<()> {
    if window.hidden {
        anyhow::bail!("targeted get_app_state screenshot requires a visible, unminimized window");
    }
    if !window.focused {
        anyhow::bail!(
            "targeted get_app_state screenshot requires the window to already be focused; use the screenshot tool to raise it before capture"
        );
    }
    Ok(())
}

#[derive(Debug, Clone, Copy)]
struct WindowCoordinateMap {
    capture_rect: (i32, i32, u32, u32),
    full_capture_rect: (i32, i32, u32, u32),
    portal_rect: Option<(i32, i32, u32, u32)>,
}

impl WindowCoordinateMap {
    fn portal_point(&self, capture_x: i32, capture_y: i32) -> Option<(i32, i32)> {
        let (portal_x, portal_y, portal_width, portal_height) = self.portal_rect?;
        let (full_x, full_y, full_width, full_height) = self.full_capture_rect;
        Some((
            map_coordinate_between_rects(capture_x, full_x, full_width, portal_x, portal_width),
            map_coordinate_between_rects(capture_y, full_y, full_height, portal_y, portal_height),
        ))
    }
}

fn map_coordinate_between_rects(
    value: i32,
    source_origin: i32,
    source_size: u32,
    target_origin: i32,
    target_size: u32,
) -> i32 {
    let offset = i64::from(value) - i64::from(source_origin);
    let scaled = offset.saturating_mul(i64::from(target_size)) / i64::from(source_size.max(1));
    (i64::from(target_origin) + scaled).clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32
}

fn logical_window_crop_rect(
    bounds: &crate::windowing::WindowBounds,
    monitors: &[(i32, i32, i32, i32)],
    capture_width: u32,
    capture_height: u32,
) -> Result<(i32, i32, u32, u32)> {
    let mut monitors = monitors
        .iter()
        .filter(|(_, _, width, height)| *width > 0 && *height > 0);
    let first = monitors
        .next()
        .ok_or_else(|| anyhow::anyhow!("desktop returned no usable monitor geometry"))?;
    let (mut min_x, mut min_y) = (i64::from(first.0), i64::from(first.1));
    let (mut max_x, mut max_y) = (
        i64::from(first.0) + i64::from(first.2),
        i64::from(first.1) + i64::from(first.3),
    );
    for (x, y, width, height) in monitors {
        min_x = min_x.min(i64::from(*x));
        min_y = min_y.min(i64::from(*y));
        max_x = max_x.max(i64::from(*x) + i64::from(*width));
        max_y = max_y.max(i64::from(*y) + i64::from(*height));
    }
    let logical_width = max_x - min_x;
    let logical_height = max_y - min_y;
    if logical_width <= 0 || logical_height <= 0 || capture_width == 0 || capture_height == 0 {
        anyhow::bail!("screenshot or monitor geometry is empty");
    }
    let scale_x = f64::from(capture_width) / logical_width as f64;
    let scale_y = f64::from(capture_height) / logical_height as f64;
    if !scale_x.is_finite() || !scale_y.is_finite() || (scale_x - scale_y).abs() > 0.01 {
        anyhow::bail!(
            "captured desktop {}x{} does not have a uniform scale relative to the logical monitor layout {}x{}",
            capture_width,
            capture_height,
            logical_width,
            logical_height
        );
    }

    let x = i64::from(
        bounds
            .x
            .ok_or_else(|| anyhow::anyhow!("window x is unavailable"))?,
    );
    let y = i64::from(
        bounds
            .y
            .ok_or_else(|| anyhow::anyhow!("window y is unavailable"))?,
    );
    if bounds.width == 0 || bounds.height == 0 {
        anyhow::bail!("window bounds are empty");
    }
    let left = (((x - min_x) as f64) * scale_x).floor() as i64;
    let top = (((y - min_y) as f64) * scale_y).floor() as i64;
    let right = (((x + i64::from(bounds.width) - min_x) as f64) * scale_x).ceil() as i64;
    let bottom = (((y + i64::from(bounds.height) - min_y) as f64) * scale_y).ceil() as i64;
    let width = u32::try_from(right - left)
        .map_err(|_| anyhow::anyhow!("scaled window width is invalid"))?;
    let height = u32::try_from(bottom - top)
        .map_err(|_| anyhow::anyhow!("scaled window height is invalid"))?;
    let left = i32::try_from(left).map_err(|_| anyhow::anyhow!("scaled window x is invalid"))?;
    let top = i32::try_from(top).map_err(|_| anyhow::anyhow!("scaled window y is invalid"))?;
    Ok((left, top, width, height))
}

fn clip_capture_rect(
    (x, y, width, height): (i32, i32, u32, u32),
    capture_width: u32,
    capture_height: u32,
) -> Result<(i32, i32, u32, u32)> {
    let left = i64::from(x).max(0);
    let top = i64::from(y).max(0);
    let right = (i64::from(x) + i64::from(width)).min(i64::from(capture_width));
    let bottom = (i64::from(y) + i64::from(height)).min(i64::from(capture_height));
    if right <= left || bottom <= top {
        anyhow::bail!(
            "targeted screenshot window is outside the captured desktop; refusing to return the full desktop"
        );
    }
    Ok((
        i32::try_from(left).map_err(|_| anyhow::anyhow!("capture crop x is invalid"))?,
        i32::try_from(top).map_err(|_| anyhow::anyhow!("capture crop y is invalid"))?,
        u32::try_from(right - left)
            .map_err(|_| anyhow::anyhow!("capture crop width is invalid"))?,
        u32::try_from(bottom - top)
            .map_err(|_| anyhow::anyhow!("capture crop height is invalid"))?,
    ))
}

/// Convert a window's bounds into a crop rectangle, if it has a usable origin
/// and non-zero size.
fn window_crop_rect(bounds: &crate::windowing::WindowBounds) -> Option<(i32, i32, u32, u32)> {
    let x = bounds.x?;
    let y = bounds.y?;
    if bounds.width == 0 || bounds.height == 0 {
        return None;
    }
    Some((x, y, bounds.width, bounds.height))
}

fn validate_click_coordinate_space(params: &ClickParams) -> std::result::Result<(), String> {
    if params.coordinate_space == ClickCoordinateSpace::Capture {
        return Ok(());
    }
    if params.relative == Some(true) {
        return Err(
            "AT-SPI coordinate clicks cannot use relative screenshot coordinates.".to_string(),
        );
    }
    if params.x.zip(params.y).is_none() {
        return Err("AT-SPI coordinate clicks require both x and y.".to_string());
    }
    if params.element_index.is_none() && params.selector().is_empty() {
        return Err(
            "AT-SPI coordinate clicks require element_index or a semantic selector to identify the window geometry."
                .to_string(),
        );
    }
    Ok(())
}

fn apply_window_relative_click_coordinates(
    params: &mut ClickParams,
    capture_rect: (i32, i32, u32, u32),
) -> std::result::Result<(), String> {
    let (relative_x, relative_y) = params
        .x
        .zip(params.y)
        .ok_or_else(|| "Relative coordinate clicks require both x and y.".to_string())?;
    let (origin_x, origin_y, width, height) = capture_rect;
    if width == 0 || height == 0 {
        return Err(
            "Relative coordinate clicks require non-empty target-window bounds.".to_string(),
        );
    }
    if relative_x < 0 || relative_y < 0 {
        return Err("Relative click coordinates must be inside target-window bounds.".to_string());
    }
    if relative_x as u32 >= width || relative_y as u32 >= height {
        return Err("Relative click coordinates must be inside target-window bounds.".to_string());
    }
    let x = origin_x
        .checked_add(relative_x)
        .ok_or_else(|| "Relative click x coordinate overflowed.".to_string())?;
    let y = origin_y
        .checked_add(relative_y)
        .ok_or_else(|| "Relative click y coordinate overflowed.".to_string())?;
    params.x = Some(x);
    params.y = Some(y);
    Ok(())
}

/// Point a window-targeted scroll at the centre of the resolved window when
/// the caller supplied no coordinates. Without this the wheel events land on
/// whatever is under the current pointer position.
fn apply_window_center_scroll_point(
    params: &mut ScrollParams,
    capture_rect: (i32, i32, u32, u32),
) -> std::result::Result<(), String> {
    let (origin_x, origin_y, width, height) = capture_rect;
    if width == 0 || height == 0 {
        return Err(
            "Window-targeted scroll requires non-empty target-window bounds; pass x/y explicitly."
                .to_string(),
        );
    }
    params.x = Some(origin_x.saturating_add((width / 2) as i32));
    params.y = Some(origin_y.saturating_add((height / 2) as i32));
    Ok(())
}

fn apply_window_relative_scroll_coordinates(
    params: &mut ScrollParams,
    capture_rect: (i32, i32, u32, u32),
) -> std::result::Result<(), String> {
    let (relative_x, relative_y) = params
        .x
        .zip(params.y)
        .ok_or_else(|| "Relative scroll coordinates require both x and y.".to_string())?;
    let (origin_x, origin_y, width, height) = capture_rect;
    if width == 0 || height == 0 {
        return Err(
            "Relative scroll coordinates require non-empty target-window bounds.".to_string(),
        );
    }
    if relative_x < 0 || relative_y < 0 || relative_x as u32 >= width || relative_y as u32 >= height
    {
        return Err("Relative scroll coordinates must be inside target-window bounds.".to_string());
    }
    params.x = Some(origin_x.saturating_add(relative_x));
    params.y = Some(origin_y.saturating_add(relative_y));
    Ok(())
}

/// Crop a PNG image to `(x, y, w, h)` (clamped to the image), returning the
/// re-encoded PNG and the actual cropped dimensions.
fn crop_png(
    raw: &[u8],
    x: i32,
    y: i32,
    w: u32,
    h: u32,
) -> std::result::Result<(Vec<u8>, u32, u32), String> {
    use std::io::Cursor;
    let img = image::load_from_memory_with_format(raw, image::ImageFormat::Png)
        .map_err(|e| format!("decode png: {e}"))?;
    let (iw, ih) = (img.width(), img.height());
    let x = x.max(0) as u32;
    let y = y.max(0) as u32;
    if x >= iw || y >= ih {
        return Err("crop origin outside image".into());
    }
    let w = w.min(iw - x);
    let h = h.min(ih - y);
    let sub = img.crop_imm(x, y, w, h);
    let mut out = Vec::new();
    sub.write_to(&mut Cursor::new(&mut out), image::ImageFormat::Png)
        .map_err(|e| format!("encode png: {e}"))?;
    Ok((out, w, h))
}

fn action_result(
    action: &str,
    result: std::result::Result<Vec<Output>, String>,
    received: Option<serde_json::Value>,
) -> ActionOutput {
    match result {
        Ok(_) => ActionOutput {
            ok: true,
            implemented: true,
            action: action.to_string(),
            message: if action == "type_text" {
                "Action sent through ydotool using US physical key positions. The active keyboard layout can change the resulting text; verify the field contents."
            } else {
                "Action sent through ydotool."
            }
            .to_string(),
            received,
        },
        Err(message) => ActionOutput {
            ok: false,
            implemented: true,
            action: action.to_string(),
            message,
            received,
        },
    }
}

fn unsafe_pointer_fallback(action: &str, received: Option<serde_json::Value>) -> ActionOutput {
    ActionOutput {
        ok: false,
        implemented: true,
        action: action.to_string(),
        message: "Coordinate input was not sent: ydotool cannot position the pointer accurately on Wayland. Enable the uinput absolute pointer with working screenshot capture, or use COMPUTER_USE_LINUX_FORCE_PORTAL_POINTER=1 with an approved desktop portal session. Remove COMPUTER_USE_LINUX_FORCE_YDOTOOL_POINTER if set.".to_string(),
        received,
    }
}

fn abs_pointer_error(
    action: &str,
    error: String,
    received: Option<serde_json::Value>,
) -> ActionOutput {
    ActionOutput {
        ok: false,
        implemented: true,
        action: action.to_string(),
        message: format!("Absolute pointer {action} may have started before it failed; input was not replayed through another backend: {error}"),
        received,
    }
}

fn abs_pointer_result(
    action: &str,
    result: std::result::Result<crate::abs_pointer::PointerLanding, String>,
    received: Option<serde_json::Value>,
) -> ActionOutput {
    match result {
        Ok(landing) => with_notes(
            ActionOutput {
                ok: true,
                implemented: true,
                action: action.to_string(),
                message: if action == "scroll" {
                    "Pointer positioned through uinput; wheel input sent through ydotool."
                        .to_string()
                } else {
                    "Action sent through the uinput absolute pointer.".to_string()
                },
                received,
            },
            abs_pointer_clamp_note(landing),
        ),
        Err(error) => abs_pointer_error(action, error, received),
    }
}

fn kwin_element_click_dispatch_output(
    mut output: ActionOutput,
    kwin_click: Option<PreparedKwinElementClick>,
    backend: &str,
) -> ActionOutput {
    if output.ok {
        if let Some(kwin_click) = kwin_click {
            output.message = format!(
                "Click dispatched through {backend} using KWin element coordinate mapping: capture {},{}; portal logical {},{}. Dispatch only: UI activation was not verified.",
                kwin_click.point.capture.0,
                kwin_click.point.capture.1,
                kwin_click.point.logical.0,
                kwin_click.point.logical.1
            );
        }
    }
    output
}

fn portal_action_error(
    action: &str,
    error: anyhow::Error,
    received: Option<serde_json::Value>,
) -> ActionOutput {
    ActionOutput {
        ok: false,
        implemented: true,
        action: action.to_string(),
        message: format!(
            "Remote desktop portal {action} may have started before it failed; input was not replayed through another backend: {error:#}"
        ),
        received,
    }
}

fn portal_start_error(
    action: &str,
    error: anyhow::Error,
    received: Option<serde_json::Value>,
) -> ActionOutput {
    ActionOutput {
        ok: false,
        implemented: true,
        action: action.to_string(),
        message: format!("Input was not sent because the remote desktop portal could not start; input was not replayed through ydotool: {error:#}"),
        received,
    }
}

fn portal_coordinate_error(action: &str, received: Option<serde_json::Value>) -> ActionOutput {
    ActionOutput {
        ok: false,
        implemented: true,
        action: action.to_string(),
        message: format!(
            "Remote desktop portal {action} was not sent because the coordinate could not be mapped safely to the complete shared desktop; input was not replayed through another backend."
        ),
        received,
    }
}

fn valid_runtime_component(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn avatar_cursor_identity_from_cmdline(cmdline: &[u8]) -> (Option<String>, Option<String>) {
    let executable = cmdline.split(|byte| *byte == 0).next().unwrap_or_default();
    if Path::new(std::ffi::OsStr::from_bytes(executable)).file_name()
        != Some(std::ffi::OsStr::new("electron"))
    {
        return (None, None);
    }
    let mut app_id = None;
    let mut instance_id = None;
    for argument in cmdline.split(|byte| *byte == 0) {
        let Ok(argument) = std::str::from_utf8(argument) else {
            continue;
        };
        if let Some(value) = argument.strip_prefix("--app-id=") {
            if valid_runtime_component(value) {
                app_id = Some(value.to_string());
            }
        }
        let Some(value) = argument.strip_prefix("--user-data-dir=") else {
            continue;
        };
        let components = Path::new(value)
            .components()
            .filter_map(|component| component.as_os_str().to_str())
            .collect::<Vec<_>>();
        for window in components.windows(3) {
            if window[0] == "instances"
                && valid_runtime_component(window[1])
                && window[2] == "electron-user-data"
            {
                instance_id = Some(window[1].to_string());
            }
        }
    }
    (app_id, instance_id)
}

fn proc_parent_pid(pid: &str) -> Option<u32> {
    let status = fs::read_to_string(format!("/proc/{pid}/status")).ok()?;
    status
        .lines()
        .find_map(|line| line.strip_prefix("PPid:")?.trim().parse::<u32>().ok())
}

fn avatar_cursor_parent_identity() -> (Option<String>, Option<String>) {
    let mut pid = proc_parent_pid("self");
    for _ in 0..8 {
        let Some(current_pid) = pid.filter(|pid| *pid > 1) else {
            break;
        };
        if let Ok(cmdline) = fs::read(format!("/proc/{current_pid}/cmdline")) {
            let identity = avatar_cursor_identity_from_cmdline(&cmdline);
            if identity.0.is_some() {
                return identity;
            }
        }
        pid = proc_parent_pid(&current_pid.to_string());
    }
    (None, None)
}

fn avatar_cursor_socket_path_from(
    runtime_dir: Option<&str>,
    app_id: Option<&str>,
    legacy_app_id: Option<&str>,
    instance_id: Option<&str>,
) -> Option<PathBuf> {
    let runtime_dir = runtime_dir?.trim();
    let runtime_dir = Path::new(runtime_dir);
    if !runtime_dir.is_absolute() {
        return None;
    }

    let app_id = app_id
        .or(legacy_app_id)
        .map(str::trim)
        .filter(|value| valid_runtime_component(value))
        .unwrap_or("codex-desktop");
    let instance_id = instance_id.map(str::trim).filter(|value| !value.is_empty());
    if instance_id.is_some_and(|value| !valid_runtime_component(value)) {
        return None;
    }

    let mut path = runtime_dir.join(app_id);
    if let Some(instance_id) = instance_id {
        path.push("instances");
        path.push(instance_id);
    }
    path.push(AVATAR_CURSOR_SOCKET_NAME);
    (path.as_os_str().as_bytes().len() <= AVATAR_CURSOR_SOCKET_MAX_BYTES).then_some(path)
}

fn avatar_cursor_socket_path() -> Option<PathBuf> {
    let runtime_dir = env::var("XDG_RUNTIME_DIR").ok();
    let app_id = env::var("CODEX_LINUX_APP_ID").ok();
    let legacy_app_id = env::var("CODEX_APP_ID").ok();
    let instance_id = env::var("CODEX_LINUX_INSTANCE_ID").ok();
    let parent_identity = (app_id.is_none() && legacy_app_id.is_none() || instance_id.is_none())
        .then(avatar_cursor_parent_identity)
        .unwrap_or_default();
    avatar_cursor_socket_path_from(
        runtime_dir.as_deref(),
        app_id.as_deref().or(parent_identity.0.as_deref()),
        legacy_app_id.as_deref(),
        instance_id.as_deref().or(parent_identity.1.as_deref()),
    )
}

async fn send_avatar_cursor_signal(path: &Path) -> bool {
    let Ok(socket_metadata) = fs::symlink_metadata(path) else {
        return false;
    };
    let Some(current_uid) = fs::metadata("/proc/self")
        .ok()
        .map(|metadata| metadata.uid())
    else {
        return false;
    };
    if !socket_metadata.file_type().is_socket()
        || socket_metadata.uid() != current_uid
        || socket_metadata.mode() & 0o077 != 0
    {
        return false;
    }
    let Ok(Ok(mut stream)) =
        timeout(AVATAR_CURSOR_NOTIFY_TIMEOUT, TokioUnixStream::connect(path)).await
    else {
        return false;
    };
    matches!(
        timeout(AVATAR_CURSOR_NOTIFY_TIMEOUT, stream.write_all(b"pointer\n"),).await,
        Ok(Ok(()))
    )
}

fn notify_avatar_cursor() {
    let Some(path) = avatar_cursor_socket_path() else {
        return;
    };
    tokio::spawn(async move {
        let _ = send_avatar_cursor_signal(&path).await;
    });
}

fn pointer_action_result(output: ActionOutput) -> ActionOutput {
    if output.ok {
        notify_avatar_cursor();
    }
    output
}

fn action_result_with_focus(
    action: &str,
    result: std::result::Result<Vec<Output>, String>,
    received: Option<serde_json::Value>,
    focus: Option<WindowFocusResult>,
) -> ActionOutput {
    with_focus_context(action_result(action, result, received), focus)
}

fn successful_action_with_focus(
    action: &str,
    message: &str,
    received: Option<serde_json::Value>,
    focus: Option<WindowFocusResult>,
) -> ActionOutput {
    with_focus_context(
        ActionOutput {
            ok: true,
            implemented: true,
            action: action.to_string(),
            message: message.to_string(),
            received,
        },
        focus,
    )
}

fn with_focus_context(mut output: ActionOutput, focus: Option<WindowFocusResult>) -> ActionOutput {
    if output.ok {
        if let Some(focus) = focus {
            let verification = if focus.exact_window_focused {
                "exact window-focus"
            } else {
                "app-level focus"
            };
            output.message = format!(
                "{} Target window_id {} was focused with {verification} verification before input.",
                output.message, focus.requested_window.window_id,
            );
        }
    }
    output
}

/// Exact window focus alone cannot rule out lost input. Only a complete,
/// scoped shell-only tree explains the missing focus as unavailable content.
fn focus_probe_feedback(
    probe: &FocusProbe,
    expects_editable: bool,
    exact_window_focused: bool,
) -> String {
    match probe {
        FocusProbe::Found(element) => describe_focused_element(element, expects_editable),
        FocusProbe::ShellOnly if exact_window_focused => "Focused-element feedback unavailable: window focus was verified before input, but AT-SPI exposes only window/menu chrome in the target app. Field contents were not verified. Electron/Chromium apps may need --force-renderer-accessibility.".to_string(),
        FocusProbe::ShellOnly => "WARNING: AT-SPI exposes only window/menu chrome and no focused element in the target app; the input may have landed nowhere.".to_string(),
        FocusProbe::NoneFocused => "WARNING: AT-SPI reports no focused element in the target app; the input may have landed nowhere.".to_string(),
        FocusProbe::Incomplete => "Focused-element feedback unavailable: the focused element was not reached within the AT-SPI search limits, so the input could not be verified. Its absence here does not mean the input was lost.".to_string(),
        FocusProbe::NoAccessibleApp => "Focused-element feedback unavailable: the target app exposes no AT-SPI tree, so the input could not be verified. Electron apps need --force-renderer-accessibility.".to_string(),
    }
}

fn node_target_mismatch_message(element_index: u32, owner_pid: u32, target_pid: u32) -> String {
    format!(
        "element_index {element_index} comes from the latest get_app_state snapshot of pid {owner_pid}, not the target pid {target_pid}. Call get_app_state for the target app and use an index from that result."
    )
}

fn focus_target_pid(focus: Option<&WindowFocusResult>) -> Option<u32> {
    let focus = focus?;
    focus
        .focused_window
        .as_ref()
        .and_then(|window| window.pid)
        .or(focus.requested_window.pid)
}

fn describe_focused_element(element: &FocusedElementSummary, expects_editable: bool) -> String {
    let name = element
        .name
        .as_deref()
        .filter(|name| !name.is_empty())
        .map(|name| format!(" \"{name}\""))
        .unwrap_or_default();
    if focused_element_is_editable(element) {
        format!("Focused element: {}{name} (editable).", element.role)
    } else if element.is_terminal {
        format!(
            "Focused element: {}{name} (terminal keyboard input).",
            element.role
        )
    } else if expects_editable {
        format!(
            "WARNING: focused element is {}{name}, which is not editable, so the text may not have reached a field. Click the intended input or use set_value on an editable one, and re-observe before retrying.",
            element.role
        )
    } else {
        format!("Focused element: {}{name} (not editable).", element.role)
    }
}

fn first_line(text: &str) -> &str {
    text.lines().next().unwrap_or(text)
}

/// Append supplemental notes (off-screen or focused-element feedback) to an
/// action result message without changing ok/implemented semantics.
fn with_notes(mut output: ActionOutput, notes: impl IntoIterator<Item = String>) -> ActionOutput {
    for note in notes {
        output.message = format!("{} {note}", output.message);
    }
    output
}

fn abs_pointer_clamp_note(landing: crate::abs_pointer::PointerLanding) -> Option<String> {
    (landing.requested != landing.emitted).then(|| {
        format!(
            "Requested coordinate {},{} was clamped to {},{} by the uinput absolute pointer.",
            landing.requested.0, landing.requested.1, landing.emitted.0, landing.emitted.1
        )
    })
}

fn portal_focus_target(target: &WindowTarget, window: &WindowInfo) -> WindowTarget {
    if registry::backend_can_exact_focus(&window.backend) {
        WindowTarget {
            window_id: Some(window.window_id),
            ..Default::default()
        }
    } else if target.has_target() {
        // GNOME Introspect can activate an app, but cannot activate a specific
        // window. Preserve the caller's app-level focus contract there.
        target.clone()
    } else {
        WindowTarget {
            app_id: window.app_id.clone(),
            ..Default::default()
        }
    }
}

fn focus_satisfies_target(focus: &WindowFocusResult, target: &WindowTarget) -> bool {
    if target.requires_exact_focus() {
        focus.exact_window_focused
    } else {
        focus.exact_window_focused || focus.app_focused
    }
}

async fn window_list_output() -> ListWindowsOutput {
    match list_windows().await {
        Ok(windows) => {
            let backend = window_backend(windows.iter());
            let note = registry::list_note(&backend);
            ListWindowsOutput {
                backend,
                windows,
                error: None,
                permissions_hint: None,
                note: note.to_string(),
            }
        }
        Err(error) => {
            let error = format!("{error:#}");
            ListWindowsOutput {
                backend: UNAVAILABLE_BACKEND.to_string(),
                windows: Vec::new(),
                permissions_hint: window_permission_hint(&error),
                error: Some(error),
                note: "Window listing failed, so targeted keyboard input cannot safely focus or verify a target window."
                    .to_string(),
            }
        }
    }
}

fn window_backend<'a>(windows: impl Iterator<Item = &'a WindowInfo>) -> String {
    windows
        .map(|window| window.backend.clone())
        .next()
        .unwrap_or_else(|| UNAVAILABLE_BACKEND.to_string())
}

fn absolute_mousemove_args(x: i32, y: i32) -> Vec<String> {
    vec![
        "mousemove".to_string(),
        "--absolute".to_string(),
        "--".to_string(),
        x.to_string(),
        y.to_string(),
    ]
}

fn xdotool_pointer_click_args(
    x: i32,
    y: i32,
    count: u32,
    button: Option<&str>,
) -> Option<Vec<String>> {
    let button = xdotool_pointer_button_code(button)?;
    Some(vec![
        "mousemove".to_string(),
        "--".to_string(),
        x.to_string(),
        y.to_string(),
        "click".to_string(),
        "--repeat".to_string(),
        count.to_string(),
        button.to_string(),
    ])
}

fn xdotool_pointer_button_code(button: Option<&str>) -> Option<&'static str> {
    match button.unwrap_or("left").to_ascii_lowercase().as_str() {
        "left" => Some("1"),
        "middle" => Some("2"),
        "right" => Some("3"),
        _ => None,
    }
}

/// Gap between XTEST wheel-button clicks, in milliseconds.
///
/// xdotool's own default is 100ms. One page is five clicks and valid requests
/// can ask for up to 100 pages, so 12ms keeps the bounded operation responsive
/// while matching the pacing used by `xdotool type`.
const XDOTOOL_SCROLL_CLICK_DELAY_MS: u64 = 12;

/// X11 wheel buttons: 4 up, 5 down, 6 left, 7 right. `repeat` is the notch
/// count, the same number ydotool would pass to `mousemove --wheel`.
fn xdotool_pointer_scroll_args(
    point: Option<(i32, i32)>,
    repeat: u32,
    direction: ScrollDirection,
) -> Vec<String> {
    let button = match direction {
        ScrollDirection::Up => "4",
        ScrollDirection::Down => "5",
        ScrollDirection::Left => "6",
        ScrollDirection::Right => "7",
    };
    let mut args = Vec::new();
    if let Some((x, y)) = point {
        args.extend([
            "mousemove".to_string(),
            "--".to_string(),
            x.to_string(),
            y.to_string(),
        ]);
    }
    args.extend([
        "click".to_string(),
        "--delay".to_string(),
        XDOTOOL_SCROLL_CLICK_DELAY_MS.to_string(),
        "--repeat".to_string(),
        repeat.max(1).to_string(),
        button.to_string(),
    ]);
    args
}

/// `xdotool click --repeat` sleeps `--delay` after every click, including
/// the last, so the command timeout has to cover that gap.
fn xdotool_scroll_timeout(repeat: u32, delay_ms: u64) -> Duration {
    INPUT_COMMAND_TIMEOUT.saturating_add(Duration::from_millis(
        u64::from(repeat.max(1)).saturating_mul(delay_ms),
    ))
}

#[derive(Debug)]
struct PointerCommandResult {
    outputs: Vec<Output>,
    backend: KeyboardCommandBackend,
}

async fn run_xdotool_pointer_or_fallback<F, Fut>(
    program: &Path,
    args: &[String],
    fallback: F,
) -> std::result::Result<PointerCommandResult, String>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = std::result::Result<Vec<Output>, String>>,
{
    match run_xdotool(program, args).await {
        XdotoolAttempt::Unavailable => fallback().await.map(|outputs| PointerCommandResult {
            outputs,
            backend: KeyboardCommandBackend::Ydotool,
        }),
        XdotoolAttempt::Finished(result) => result.map(|output| PointerCommandResult {
            outputs: vec![output],
            backend: KeyboardCommandBackend::Xdotool,
        }),
    }
}

async fn run_xdotool_pointer_or_fallback_with_timeout<F, Fut>(
    program: &Path,
    args: &[String],
    command_timeout: Duration,
    fallback: F,
) -> std::result::Result<PointerCommandResult, String>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = std::result::Result<Vec<Output>, String>>,
{
    match run_xdotool_with_timeout(program, args, command_timeout).await {
        XdotoolAttempt::Unavailable => fallback().await.map(|outputs| PointerCommandResult {
            outputs,
            backend: KeyboardCommandBackend::Ydotool,
        }),
        XdotoolAttempt::Finished(result) => result.map(|output| PointerCommandResult {
            outputs: vec![output],
            backend: KeyboardCommandBackend::Xdotool,
        }),
    }
}

fn wheel_mousemove_args(dx: i32, dy: i32) -> Vec<String> {
    vec![
        "mousemove".to_string(),
        "--wheel".to_string(),
        "--".to_string(),
        dx.to_string(),
        dy.to_string(),
    ]
}

async fn run_cancellation_safe_guarded<G, T, F>(
    guard: G,
    operation: F,
) -> (Option<G>, std::result::Result<T, String>)
where
    G: Send + 'static,
    T: Send + 'static,
    F: Future<Output = T> + Send + 'static,
{
    // Dropping a JoinHandle detaches its task, retaining the guard until the
    // stateful input operation has completed even if the caller is cancelled.
    match tokio::spawn(async move { (guard, operation.await) }).await {
        Ok((guard, result)) => (Some(guard), Ok(result)),
        Err(error) => (None, Err(format!("stateful input task failed: {error}"))),
    }
}

async fn run_cancellation_safe_input<G, T, F>(
    input_guard: G,
    operation: F,
) -> (Option<G>, std::result::Result<T, String>)
where
    G: Send + 'static,
    T: Send + 'static,
    F: Future<Output = std::result::Result<T, String>> + Send + 'static,
{
    let (input_guard, result) = run_cancellation_safe_guarded(input_guard, operation).await;
    (input_guard, result.and_then(|result| result))
}

async fn run_ydotool_sequence(
    commands: &[Vec<String>],
) -> std::result::Result<Vec<Output>, String> {
    let mut outputs = Vec::new();
    for (index, args) in commands.iter().enumerate() {
        outputs.push(run_ydotool(args).await?);
        if index + 1 < commands.len() {
            sleep(Duration::from_millis(35)).await;
        }
    }
    Ok(outputs)
}

async fn xdotool_pointer_output(
    program: &Path,
    args: &[String],
) -> std::result::Result<Output, String> {
    match run_xdotool(program, args).await {
        XdotoolAttempt::Finished(result) => result,
        XdotoolAttempt::Unavailable => Err(
            "Native X11 pointer input requires xdotool; no system-wide input fallback was used."
                .to_string(),
        ),
    }
}

async fn run_xdotool_drag(
    program: &Path,
    start: (i32, i32),
    end: (i32, i32),
) -> std::result::Result<Vec<Output>, String> {
    let mut outputs = vec![
        xdotool_pointer_output(
            program,
            &[
                "mousemove".into(),
                "--".into(),
                start.0.to_string(),
                start.1.to_string(),
            ],
        )
        .await?,
    ];
    let mut first_error =
        match xdotool_pointer_output(program, &["mousedown".into(), "1".into()]).await {
            Ok(output) => {
                outputs.push(output);
                None
            }
            Err(error) => Some(error),
        };
    if first_error.is_none() {
        for (x, y) in crate::pointer_path::drag_points(start, end) {
            sleep(crate::pointer_path::DRAG_STEP_DELAY).await;
            match xdotool_pointer_output(
                program,
                &[
                    "mousemove".into(),
                    "--".into(),
                    x.to_string(),
                    y.to_string(),
                ],
            )
            .await
            {
                Ok(output) => outputs.push(output),
                Err(error) => {
                    first_error = Some(error);
                    break;
                }
            }
        }
    }
    // A failed command may have sent the press before failing. Always release,
    // and do not replay this partially dispatched gesture through another route.
    let release = xdotool_pointer_output(program, &["mouseup".into(), "1".into()]).await;
    match (first_error, release) {
        (None, Ok(output)) => {
            outputs.push(output);
            Ok(outputs)
        }
        (Some(error), Ok(_)) => Err(error),
        (None, Err(error)) => Err(error),
        (Some(error), Err(release)) => Err(format!(
            "{error}; X11 button release also failed: {release}"
        )),
    }
}

async fn run_ydotool_drag(
    start_x: i32,
    start_y: i32,
    end_x: i32,
    end_y: i32,
) -> std::result::Result<Vec<Output>, String> {
    let mut outputs = vec![run_ydotool(&absolute_mousemove_args(start_x, start_y)).await?];
    sleep(Duration::from_millis(35)).await;

    let mut first_error = match run_ydotool(&["click".to_string(), "0x40".to_string()]).await {
        Ok(output) => {
            outputs.push(output);
            None
        }
        Err(error) => Some(error),
    };
    sleep(Duration::from_millis(35)).await;

    if first_error.is_none() {
        match run_ydotool(&absolute_mousemove_args(end_x, end_y)).await {
            Ok(output) => outputs.push(output),
            Err(error) => first_error = Some(error),
        }
        sleep(Duration::from_millis(35)).await;
    }

    let release = run_ydotool(&["click".to_string(), "0x80".to_string()]).await;
    match (first_error, release) {
        (None, Ok(output)) => {
            outputs.push(output);
            Ok(outputs)
        }
        (Some(error), Ok(_)) => Err(error),
        (None, Err(error)) => Err(error),
        (Some(error), Err(release_error)) => Err(format!(
            "{error}; ydotool button release also failed: {release_error}"
        )),
    }
}

async fn run_abs_pointer<T, F>(
    pointer: Arc<Mutex<Option<crate::abs_pointer::AbsPointer>>>,
    operation: F,
) -> std::result::Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&mut crate::abs_pointer::AbsPointer) -> Result<T> + Send + 'static,
{
    tokio::task::spawn_blocking(move || {
        let mut guard = pointer
            .lock()
            .map_err(|_| "absolute pointer lock was poisoned".to_string())?;
        let pointer = guard
            .as_mut()
            .ok_or_else(|| "absolute pointer is unavailable".to_string())?;
        operation(pointer).map_err(|error| format!("{error:#}"))
    })
    .await
    .map_err(|error| format!("absolute pointer task failed: {error}"))?
}

async fn run_ydotool(args: &[String]) -> std::result::Result<Output, String> {
    let support = ydotool::ensure_supported_async().await?;
    let socket = ydotool::socket_path_for_command()?;
    let mut command = TokioCommand::new(&support.executable);
    command.args(args);
    command.env("YDOTOOL_SOCKET", socket);
    let output =
        crate::command_runner::output_with_timeout(command, "run ydotool", INPUT_COMMAND_TIMEOUT)
            .await
            .map_err(|error| format!("{error:#}"))?;
    if output.status.success() {
        if let Some(error) = ydotool::cli_error(&output.stderr) {
            Err(error)
        } else {
            Ok(output)
        }
    } else {
        Err(ydotool_output_error(output))
    }
}

async fn run_ydotool_type_text(text: &str) -> std::result::Result<Output, String> {
    validate_ydotool_text(text)?;
    let support = ydotool::ensure_supported_async().await?;
    let socket = ydotool::socket_path_for_command()?;
    let mut command = TokioCommand::new(&support.executable);
    command.args(["type", "--file", "-"]);
    command.env("YDOTOOL_SOCKET", socket);
    let output = crate::command_runner::output_with_stdin(
        command,
        "run ydotool type",
        ydotool_type_timeout(text),
        text.as_bytes().to_vec(),
    )
    .await
    .map_err(|error| format!("{error:#}"))?;
    if output.status.success() {
        if let Some(error) = ydotool::cli_error(&output.stderr) {
            Err(error)
        } else {
            Ok(output)
        }
    } else {
        Err(ydotool_output_error(output))
    }
}

fn validate_ydotool_text(text: &str) -> std::result::Result<(), String> {
    if let Some(ch) = text
        .chars()
        .find(|ch| !matches!(ch, '\t' | '\n' | ' '..='~'))
    {
        return Err(format!(
            "ydotool cannot type U+{:04X}; no text was sent. Use a layout-aware text backend or set_value on an editable field.",
            ch as u32
        ));
    }
    Ok(())
}

fn ydotool_type_timeout(text: &str) -> Duration {
    let text_seconds = (text.chars().count() as u64).div_ceil(YDOTOOL_TYPE_CHARS_PER_SECOND);
    Duration::from_secs(INPUT_COMMAND_TIMEOUT.as_secs().saturating_add(text_seconds))
}

const EVDEV_KEY_LEFTCTRL: i32 = 29;
const EVDEV_KEY_LEFTSHIFT: i32 = 42;
const EVDEV_KEY_V: i32 = 47;
const EVDEV_KEY_INSERT: i32 = 110;
const KDE_CLIPBOARD_RESTORE_MIN_DELAY_MS: u64 = 1_500;
const KDE_CLIPBOARD_RESTORE_MAX_DELAY_MS: u64 = 5_000;
const KDE_CLIPBOARD_RESTORE_CHARS_PER_SECOND: u64 = 250;

fn kde_clipboard_restore_delay(text: &str) -> Duration {
    let text_delay_ms = (text.chars().count() as u64)
        .saturating_mul(1_000)
        .div_ceil(KDE_CLIPBOARD_RESTORE_CHARS_PER_SECOND);
    Duration::from_millis(text_delay_ms.clamp(
        KDE_CLIPBOARD_RESTORE_MIN_DELAY_MS,
        KDE_CLIPBOARD_RESTORE_MAX_DELAY_MS,
    ))
}

#[derive(Debug)]
struct KdeClipboardPasteError {
    message: String,
    can_fallback_to_ydotool: bool,
    clear_portal_keyboard_session: bool,
}

impl KdeClipboardPasteError {
    fn before_text_input(message: String) -> Self {
        Self {
            message,
            can_fallback_to_ydotool: true,
            clear_portal_keyboard_session: false,
        }
    }

    fn after_portal_input(message: String) -> Self {
        Self {
            message,
            can_fallback_to_ydotool: false,
            clear_portal_keyboard_session: true,
        }
    }

    fn ambiguous_clipboard_set(message: String) -> Self {
        Self {
            message,
            can_fallback_to_ydotool: false,
            clear_portal_keyboard_session: false,
        }
    }
}

async fn run_kde_clipboard_paste_text(
    session: &PortalKeyboardSession,
    text: &str,
    paste_shortcut: KdeClipboardPasteShortcut,
    operation_guard: InputOperationGuard,
) -> std::result::Result<String, KdeClipboardPasteError> {
    let previous = kde_clipboard_contents()
        .await
        .map_err(KdeClipboardPasteError::before_text_input)?;
    if let Err(set_error) = kde_set_clipboard_contents(text).await {
        let restore_result = kde_set_clipboard_contents(&previous).await;
        let message = match restore_result {
            Ok(()) => format!(
                "KDE clipboard replacement failed ambiguously and the previous contents were restored; text was not replayed through another backend: {set_error}"
            ),
            Err(restore_error) => format!(
                "KDE clipboard replacement failed ambiguously; restoring the previous contents also failed, and text was not replayed through another backend: {set_error}; restore failed: {restore_error}"
            ),
        };
        return Err(KdeClipboardPasteError::ambiguous_clipboard_set(message));
    }

    let (modifiers, keycode) = kde_clipboard_paste_chord(paste_shortcut);
    let paste_result = press_keycode_chord(session, modifiers, keycode, Some(operation_guard))
        .await
        .map_err(|error| format!("{error:#}"));

    sleep(kde_clipboard_restore_delay(text)).await;
    let restore_result = kde_set_clipboard_contents(&previous).await;

    match (paste_result, restore_result) {
        (Ok(_), Ok(_)) => Ok("Action pasted through KDE clipboard integration.".to_string()),
        (Err(error), Ok(_)) => Err(KdeClipboardPasteError::after_portal_input(error)),
        (Ok(_), Err(restore_error)) => Ok(format!(
            "Action pasted through KDE clipboard integration. Warning: previous KDE clipboard contents could not be restored: {restore_error}"
        )),
        (Err(error), Err(restore_error)) => Err(KdeClipboardPasteError::after_portal_input(
            format!("{error}; previous KDE clipboard contents could not be restored: {restore_error}"),
        )),
    }
}

/// Paste chord for KDE clipboard text input.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum KdeClipboardPasteShortcut {
    /// Ctrl+V, for ordinary widgets.
    Standard,
    /// Ctrl+Shift+V, for most terminal emulators.
    CtrlShiftV,
    /// Shift+Insert, for the xterm and rxvt families.
    ShiftInsert,
}

async fn kde_clipboard_paste_shortcut(
    target: &WindowTarget,
    focus: Option<&WindowFocusResult>,
) -> KdeClipboardPasteShortcut {
    let current = match focus {
        Some(_) => None,
        None => focused_window().await.ok().flatten(),
    };
    let window = focus
        .map(|focus| {
            focus
                .focused_window
                .as_ref()
                .unwrap_or(&focus.requested_window)
        })
        .or(current.as_ref());
    let terminal = kde_clipboard_terminal_shortcut(target, window);
    if terminal.is_none() {
        return KdeClipboardPasteShortcut::Standard;
    }
    // A terminal window can hold focus on a non-terminal widget (a search
    // field, a tab rename box) that pastes with plain Ctrl+V. Only an answer
    // from the terminal's own AT-SPI app may override the chord: without a pid,
    // or when the terminal exposes no AT-SPI root, keep the terminal chord.
    let Some(pid) = window.and_then(|window| window.pid) else {
        return kde_clipboard_shortcut_for_focus(terminal, None);
    };
    let focused_element = timeout(
        Duration::from_millis(1_500),
        focused_element_summary_in_app(pid),
    )
    .await
    .ok()
    .and_then(Result::ok)
    .flatten();
    kde_clipboard_shortcut_for_focus(terminal, focused_element.as_ref())
}

/// The terminal chord for the resolved window, or for an explicit terminal
/// selector when no window resolved. A resolved window always wins over a
/// possibly stale selector.
fn kde_clipboard_terminal_shortcut(
    target: &WindowTarget,
    window: Option<&WindowInfo>,
) -> Option<TerminalPasteShortcut> {
    match window {
        Some(window) => terminal_paste_shortcut(window),
        None => target
            .has_terminal_target()
            .then_some(TerminalPasteShortcut::CtrlShiftV),
    }
}

fn kde_clipboard_shortcut_for_focus(
    terminal: Option<TerminalPasteShortcut>,
    focused_element: Option<&FocusedElementSummary>,
) -> KdeClipboardPasteShortcut {
    // No AT-SPI answer (xterm exposes none) keeps the terminal chord; only a
    // focused non-terminal text field switches back to Ctrl+V. A remaining
    // container focus (filler, panel) keeps the terminal chord too.
    if focused_element.is_some_and(|element| !element.is_terminal && element.accepts_text()) {
        return KdeClipboardPasteShortcut::Standard;
    }
    match terminal {
        Some(TerminalPasteShortcut::CtrlShiftV) => KdeClipboardPasteShortcut::CtrlShiftV,
        Some(TerminalPasteShortcut::ShiftInsert) => KdeClipboardPasteShortcut::ShiftInsert,
        None => KdeClipboardPasteShortcut::Standard,
    }
}

fn kde_clipboard_paste_chord(shortcut: KdeClipboardPasteShortcut) -> (&'static [i32], i32) {
    match shortcut {
        KdeClipboardPasteShortcut::Standard => (&[EVDEV_KEY_LEFTCTRL], EVDEV_KEY_V),
        KdeClipboardPasteShortcut::CtrlShiftV => {
            (&[EVDEV_KEY_LEFTCTRL, EVDEV_KEY_LEFTSHIFT], EVDEV_KEY_V)
        }
        KdeClipboardPasteShortcut::ShiftInsert => (&[EVDEV_KEY_LEFTSHIFT], EVDEV_KEY_INSERT),
    }
}

async fn kde_clipboard_contents() -> std::result::Result<String, String> {
    let connection = kde_clipboard_connection().await?;
    let proxy = kde_clipboard_proxy(&connection).await?;
    let output: String = kde_clipboard_dbus_operation(
        "getClipboardContents",
        proxy.call("getClipboardContents", &()),
    )
    .await?;
    Ok(output)
}

async fn kde_set_clipboard_contents(text: &str) -> std::result::Result<(), String> {
    let connection = kde_clipboard_connection().await?;
    let proxy = kde_clipboard_proxy(&connection).await?;
    let _: () = kde_clipboard_dbus_operation(
        "setClipboardContents",
        proxy.call("setClipboardContents", &(text)),
    )
    .await?;
    Ok(())
}

async fn kde_clipboard_connection() -> std::result::Result<ZbusConnection, String> {
    ZbusConnection::session()
        .await
        .map_err(|error| format!("failed to connect to session bus for KDE clipboard: {error}"))
}

async fn kde_clipboard_proxy(
    connection: &ZbusConnection,
) -> std::result::Result<ZbusProxy<'_>, String> {
    kde_clipboard_dbus_operation(
        "proxy creation",
        ZbusProxy::new(
            connection,
            KDE_KLIPPER_SERVICE,
            KDE_KLIPPER_PATH,
            KDE_KLIPPER_INTERFACE,
        ),
    )
    .await
}

async fn kde_clipboard_dbus_operation<T, F>(
    operation: &'static str,
    future: F,
) -> std::result::Result<T, String>
where
    F: Future<Output = zbus::Result<T>>,
{
    kde_clipboard_dbus_operation_with_timeout(operation, future, KDE_CLIPBOARD_DBUS_TIMEOUT).await
}

async fn kde_clipboard_dbus_operation_with_timeout<T, F>(
    operation: &'static str,
    future: F,
    timeout_duration: Duration,
) -> std::result::Result<T, String>
where
    F: Future<Output = zbus::Result<T>>,
{
    timeout(timeout_duration, future)
        .await
        .map_err(|_| format!("KDE clipboard {operation} timed out"))?
        .map_err(|error| format!("KDE clipboard {operation} failed: {error}"))
}

fn ydotool_output_error(output: Output) -> String {
    command_output_error("ydotool", output)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum KeyboardCommandBackend {
    Wtype,
    Xdotool,
    Ydotool,
}

struct KeyboardCommandResult {
    output: Output,
    backend: KeyboardCommandBackend,
}

enum XdotoolAttempt {
    Unavailable,
    Finished(std::result::Result<Output, String>),
}

async fn run_xdotool(program: &Path, args: &[String]) -> XdotoolAttempt {
    run_xdotool_with_timeout(program, args, INPUT_COMMAND_TIMEOUT).await
}

async fn run_xdotool_with_timeout(
    program: &Path,
    args: &[String],
    command_timeout: Duration,
) -> XdotoolAttempt {
    let mut command = TokioCommand::new(program);
    command.args(args);
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());
    command.kill_on_drop(true);
    command.process_group(0);

    // A busy-file spawn error is transient, not "xdotool is unavailable"; do
    // not let it route input to the ydotool fallback.
    match crate::command_runner::spawn_retrying_busy(&mut command).await {
        Ok(child) => XdotoolAttempt::Finished(
            match crate::command_runner::output_child(child, "run xdotool", command_timeout)
                .await
                .map_err(|error| format!("{error:#}"))
            {
                Ok(output) if output.status.success() => Ok(output),
                Ok(output) => Err(command_output_error("xdotool", output)),
                Err(error) => Err(error),
            },
        ),
        Err(_) => XdotoolAttempt::Unavailable,
    }
}

async fn run_xdotool_or_fallback<F, Fut>(
    program: &Path,
    args: &[String],
    fallback: F,
) -> std::result::Result<KeyboardCommandResult, String>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = std::result::Result<Output, String>>,
{
    run_xdotool_or_fallback_with_timeout(program, args, INPUT_COMMAND_TIMEOUT, fallback).await
}

async fn run_xdotool_or_fallback_with_timeout<F, Fut>(
    program: &Path,
    args: &[String],
    command_timeout: Duration,
    fallback: F,
) -> std::result::Result<KeyboardCommandResult, String>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = std::result::Result<Output, String>>,
{
    match run_xdotool_with_timeout(program, args, command_timeout).await {
        XdotoolAttempt::Unavailable => fallback().await.map(|output| KeyboardCommandResult {
            output,
            backend: KeyboardCommandBackend::Ydotool,
        }),
        XdotoolAttempt::Finished(result) => result.map(|output| KeyboardCommandResult {
            output,
            backend: KeyboardCommandBackend::Xdotool,
        }),
    }
}

async fn run_xdotool_type_with_input_check<F, Fut>(
    program: &Path,
    args: &[String],
    command_timeout: Duration,
    fallback: F,
) -> std::result::Result<(KeyboardCommandResult, Option<String>), String>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = std::result::Result<Output, String>>,
{
    let guard = tokio::task::spawn_blocking(crate::x11_display::X11TypingGuard::start)
        .await
        .map_err(|error| format!("{error}"))
        .and_then(|result| result.map_err(|error| format!("{error:#}")));
    let result =
        run_xdotool_or_fallback_with_timeout(program, args, command_timeout, fallback).await?;
    if result.backend == KeyboardCommandBackend::Xdotool {
        let guard = match guard {
            Ok(guard) => guard,
            Err(error) => return Ok((result, Some(format!(
                "WARNING: X11 layout-change detection was unavailable: {error}. Keyboard focus and grab detection was also unavailable. Field contents remain unverified; inspect the target before submitting or retrying."
            )))),
        };
        // Never replay a dispatched command, even if verification fails.
        tokio::task::spawn_blocking(move || guard.verify())
            .await
            .map_err(|error| format!("X11 input monitor failed after typing; inspect the target before retrying: {error}"))?
            .map_err(|error| format!("X11 input verification failed after typing; text may have been sent. Inspect the target before submitting or retrying: {error:#}"))?;
    }
    Ok((result, None))
}

async fn run_wtype_type_text_or_fallback<F, Fut>(
    program: &Path,
    text: &str,
    mode: WtypeTextMode,
    secret: bool,
    fallback: F,
) -> std::result::Result<KeyboardCommandResult, String>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = std::result::Result<Output, String>>,
{
    // Defense in depth: no helper caller may put a secret in argv or bypass
    // validation through the missing-program fallback.
    validate_wtype_text(text)?;
    validate_wtype_privacy(mode, secret)?;
    let available = if program.components().count() > 1 {
        wtype_file_available(program)
    } else {
        program.to_str().is_some_and(wtype_in_path)
    };
    if !available {
        return fallback().await.map(|output| KeyboardCommandResult {
            output,
            backend: KeyboardCommandBackend::Ydotool,
        });
    }

    let mut command = TokioCommand::new(program);
    // wtype's stdin mode uploads a new keymap every 100 characters. On
    // Hyprland/Electron those changes can turn literal text into modifier
    // keys and shortcuts while wtype still exits successfully. Passing one
    // literal argument builds the complete keymap before the first key event.
    // `--` prevents option-looking text from becoming wtype commands.
    let result = match mode {
        WtypeTextMode::Argument => {
            command.args(["--", text]);
            crate::command_runner::output_with_timeout(
                command,
                "run wtype",
                ydotool_type_timeout(text),
            )
            .await
        }
        WtypeTextMode::Stdin => {
            command.arg("-");
            crate::command_runner::output_with_stdin(
                command,
                "run wtype",
                ydotool_type_timeout(text),
                text.as_bytes().to_vec(),
            )
            .await
        }
    };
    let output = match result {
        Ok(output) => output,
        Err(error) if wtype_spawn_unavailable(&error) => {
            return fallback().await.map(|output| KeyboardCommandResult {
                output,
                backend: KeyboardCommandBackend::Ydotool,
            });
        }
        Err(error) => return Err(format!("{error:#}")),
    };
    if output.status.success() {
        Ok(KeyboardCommandResult {
            output,
            backend: KeyboardCommandBackend::Wtype,
        })
    } else {
        Err(command_output_error("wtype", output))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum WtypeTextMode {
    Argument,
    Stdin,
}

enum WtypeFieldKind {
    Password,
    NonSecretText,
    Ambiguous,
}

fn classify_wtype_field(element: &FocusedElementSummary) -> WtypeFieldKind {
    // The overlay's mask predicate includes uncertainty. Only an explicit
    // password role confirms a password; terminals can be password prompts.
    if element.role.to_ascii_lowercase().contains("password") {
        WtypeFieldKind::Password
    } else if !element.is_terminal
        && !crate::indicator::is_secret_role(&element.role)
        && focused_element_is_editable(element)
    {
        WtypeFieldKind::NonSecretText
    } else {
        WtypeFieldKind::Ambiguous
    }
}

fn wtype_text_mode_for_desktop(desktop: Option<&str>) -> WtypeTextMode {
    if desktop.is_some_and(|value| {
        value
            .split(':')
            .any(|part| part.eq_ignore_ascii_case("hyprland"))
    }) {
        WtypeTextMode::Argument
    } else {
        WtypeTextMode::Stdin
    }
}

fn preflight_type_text(text: &str, mode: Option<WtypeTextMode>) -> std::result::Result<(), String> {
    if mode.is_some() {
        validate_wtype_text(text)?;
    } else if text.contains('\0') {
        return Err("Literal text was not sent: NUL characters are unsupported.".to_string());
    }
    Ok(())
}

async fn hyprland_wtype_delivery(
    text: &str,
    probe: impl Future<Output = Option<FocusProbe>>,
) -> std::result::Result<WtypeTextMode, String> {
    let probe = timeout(WTYPE_FOCUS_TIMEOUT, probe).await.ok().flatten();
    if let Some(FocusProbe::Found(element)) = probe.as_ref() {
        match classify_wtype_field(element) {
            WtypeFieldKind::Password => return Err("Literal text was not sent: wtype argument mode is disabled for password fields. Use set_value on an editable field.".to_string()),
            WtypeFieldKind::NonSecretText => return Ok(WtypeTextMode::Argument),
            WtypeFieldKind::Ambiguous => {}
        }
    }
    // Terminals and generic text roles remain ambiguous even with AT-SPI.
    // Keep their stdin route, bounded to a single wtype batch so no mid-text
    // keymap refresh is needed. Ambiguous text must never be exposed in argv.
    if text.chars().count() <= WTYPE_STDIN_MAX_CHARS {
        Ok(WtypeTextMode::Stdin)
    } else {
        Err(format!("Literal text was not sent: the focused field could not be classified. Hyprland's private stdin fallback accepts at most {WTYPE_STDIN_MAX_CHARS} Unicode characters per call to avoid keymap-refresh corruption. Send smaller calls and verify each one, or enable the target's accessibility support."))
    }
}

fn validate_wtype_privacy(mode: WtypeTextMode, secret: bool) -> std::result::Result<(), String> {
    if mode == WtypeTextMode::Argument && secret {
        return Err("Literal text was not sent: wtype argument mode is disabled for password fields and fields whose secrecy could not be determined. Enable the target application's accessibility support or use set_value on an editable field.".to_string());
    }
    Ok(())
}

fn focus_requires_secret_protection(probe: &FocusProbe) -> bool {
    match probe {
        FocusProbe::Found(element) => {
            // Electron exposes the Editable state on normal entries without
            // implementing EditableText. The interface is not a secrecy test.
            let accepts_text = focused_element_is_editable(element) || element.is_terminal;
            crate::indicator::is_secret_role(&element.role) || !accepts_text
        }
        _ => true,
    }
}

fn focused_element_is_editable(element: &FocusedElementSummary) -> bool {
    element.editable || element.states.iter().any(|state| state == "editable")
}

fn validate_wtype_text(text: &str) -> std::result::Result<(), String> {
    if text.contains('\0') {
        return Err(
            "Literal text was not sent: wtype cannot represent NUL characters.".to_string(),
        );
    }
    if text.len() > WTYPE_MAX_TEXT_BYTES {
        return Err(format!(
            "Literal text was not sent: wtype accepts at most {WTYPE_MAX_TEXT_BYTES} UTF-8 bytes per call. Use set_value on an editable field or send smaller text segments."
        ));
    }
    Ok(())
}
fn xdotool_available() -> bool {
    which_in_path("xdotool")
}

fn wtype_available() -> bool {
    wtype_in_path("wtype")
}

fn wtype_file_available(path: &Path) -> bool {
    std::fs::metadata(path)
        .map(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

fn wtype_in_path(binary: &str) -> bool {
    let Ok(path) = env::var("PATH") else {
        return false;
    };
    env::split_paths(&path).any(|directory| wtype_file_available(&directory.join(binary)))
}

fn wtype_spawn_unavailable(error: &anyhow::Error) -> bool {
    let message = format!("{error:#}");
    [
        "No such file or directory",
        "Permission denied",
        "Exec format error",
        "Text file busy",
    ]
    .iter()
    .any(|needle| message.contains(needle))
}

fn prefer_wtype_keyboard(
    force_ydotool: bool,
    force_xdotool: bool,
    force_portal: bool,
    is_wayland: bool,
    compatible_desktop: bool,
    available: bool,
) -> bool {
    !force_ydotool
        && !force_xdotool
        && !force_portal
        && is_wayland
        && compatible_desktop
        && available
}

const XDOTOOL_TYPE_DELAY_MS: u64 = 12;
const XDOTOOL_TYPE_DELAY_ENV: &str = "CODEX_COMPUTER_USE_XDOTOOL_TYPE_DELAY_MS";
const XDOTOOL_TYPE_DELAY_ENV_STANDALONE: &str = "COMPUTER_USE_LINUX_XDOTOOL_TYPE_DELAY_MS";

fn xdotool_type_delay_ms() -> u64 {
    xdotool_type_delay_ms_value(
        env::var(XDOTOOL_TYPE_DELAY_ENV).ok().as_deref(),
        env::var(XDOTOOL_TYPE_DELAY_ENV_STANDALONE).ok().as_deref(),
    )
}

fn xdotool_type_delay_ms_value(primary: Option<&str>, standalone: Option<&str>) -> u64 {
    primary
        .or(standalone)
        .and_then(|value| value.trim().parse::<u64>().ok())
        .unwrap_or(XDOTOOL_TYPE_DELAY_MS)
}

fn xdotool_type_args_with_delay(text: &str, delay_ms: u64) -> Vec<String> {
    // XTEST maps LF to Linefeed, which editors ignore. CR maps to Return.
    // Fold CRLF first so a Windows line ending still inserts one newline.
    let text = text.replace("\r\n", "\n").replace('\n', "\r");
    vec![
        "type".to_string(),
        "--clearmodifiers".to_string(),
        "--delay".to_string(),
        delay_ms.to_string(),
        "--".to_string(),
        text,
    ]
}

fn xdotool_type_timeout(text: &str, delay_ms: u64) -> Duration {
    let chars = text.chars().count() as u64;
    INPUT_COMMAND_TIMEOUT.saturating_add(Duration::from_millis(chars.saturating_mul(delay_ms)))
}

fn which_in_path(binary: &str) -> bool {
    let Ok(path) = env::var("PATH") else {
        return false;
    };
    env::split_paths(&path).any(|directory| {
        std::fs::metadata(directory.join(binary))
            .map(|metadata| metadata.is_file())
            .unwrap_or(false)
    })
}

fn xdotool_key_spec(key: &str) -> Option<String> {
    let parts = key
        .split('+')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    let (key_part, modifier_parts) = parts.split_last()?;

    key_chord(key)?;

    let mut spec = Vec::new();
    for part in modifier_parts {
        spec.push(xdotool_modifier_name(part)?.to_string());
    }
    if modifier_parts.is_empty() {
        if let Some(bare) = xdotool_modifier_keysym(key_part) {
            return Some(bare.to_string());
        }
    }
    spec.push(xdotool_keysym_name(key_part)?);
    Some(spec.join("+"))
}

fn xdotool_modifier_name(key: &str) -> Option<&'static str> {
    match normalize_key(key).as_str() {
        "ctrl" | "control" => Some("ctrl"),
        "alt" | "option" => Some("alt"),
        "shift" => Some("shift"),
        "meta" | "super" | "cmd" | "command" => Some("super"),
        _ => None,
    }
}

fn xdotool_modifier_keysym(key: &str) -> Option<&'static str> {
    xdotool_modifier_name(key)
}

fn xdotool_keysym_name(key: &str) -> Option<String> {
    let normalized = normalize_key(key);
    let named = match normalized.as_str() {
        "enter" | "return" => "Return",
        "escape" | "esc" => "Escape",
        "tab" => "Tab",
        "backspace" => "BackSpace",
        "delete" | "del" => "Delete",
        "space" => "space",
        "home" => "Home",
        "end" => "End",
        "pageup" | "page_up" => "Page_Up",
        "pagedown" | "page_down" => "Page_Down",
        "arrowleft" | "left" => "Left",
        "arrowright" | "right" => "Right",
        "arrowup" | "up" => "Up",
        "arrowdown" | "down" => "Down",
        "f1" => "F1",
        "f2" => "F2",
        "f3" => "F3",
        "f4" => "F4",
        "f5" => "F5",
        "f6" => "F6",
        "f7" => "F7",
        "f8" => "F8",
        "f9" => "F9",
        "f10" => "F10",
        "f11" => "F11",
        "f12" => "F12",
        value if value.len() == 1 && value.as_bytes()[0].is_ascii_alphanumeric() => {
            return Some(value.to_string());
        }
        _ => return None,
    };
    Some(named.to_string())
}

fn command_output_error(command: &str, output: Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let detail = if stderr.is_empty() { stdout } else { stderr };
    if detail.is_empty() {
        format!("{command} exited with {}", output.status)
    } else {
        detail
    }
}

async fn ydotool_backend_available() -> bool {
    ydotool_backend_available_from(
        ydotool::connectable_socket_path().is_ok(),
        ydotool::ensure_supported_async().await.is_ok(),
    )
}

fn ydotool_backend_available_from(socket_available: bool, cli_supported: bool) -> bool {
    socket_available && cli_supported
}

fn should_prefer_portal_backend_by_default(is_wayland: bool, ydotool_available: bool) -> bool {
    is_wayland && !ydotool_available
}

fn prefer_portal_text_backend(
    force_ydotool: bool,
    prefer_xdotool: bool,
    is_wayland: bool,
    is_kde: bool,
    force_portal: bool,
    prefer_wtype: bool,
) -> bool {
    !force_ydotool && !prefer_xdotool && is_wayland && !is_kde && (force_portal || !prefer_wtype)
}

fn mouse_button_code(button: Option<&str>) -> String {
    match button.unwrap_or("left").to_ascii_lowercase().as_str() {
        "right" => "0xC1",
        "middle" => "0xC2",
        "side" => "0xC3",
        "extra" => "0xC4",
        "forward" => "0xC5",
        "back" => "0xC6",
        _ => "0xC0",
    }
    .to_string()
}

fn key_chord(key: &str) -> Option<(Vec<u16>, u16)> {
    let parts = key
        .split('+')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    let (key_part, modifier_parts) = parts.split_last()?;
    if modifier_parts.is_empty() {
        if let Some(modifier) = modifier_keycode(key_part) {
            return Some((Vec::new(), modifier));
        }
    }
    let mut modifiers = Vec::new();
    for part in modifier_parts {
        modifiers.push(modifier_keycode(part)?);
    }
    let keycode = keycode(key_part)?;
    Some((modifiers, keycode))
}

/// Portal form of [`key_chord`]. Modifiers and named keys go out as keysyms
/// so the compositor resolves them against the active keymap: with Caps Lock
/// and Control swapped, `Ctrl` presses whichever key produces `Control_L`
/// (issue #191). Letters and digits stay physical keycodes: mutter drops a
/// keysym missing from the current layout group, so `Ctrl+A` as a keysym
/// would vanish under a non-Latin layout, while the US keycode is what GTK and
/// Qt match shortcuts against there.
fn portal_key_chord(key: &str) -> Option<(Vec<PortalKey>, PortalKey)> {
    let parts = key
        .split('+')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    let (key_part, modifier_parts) = parts.split_last()?;
    let (_, keycode) = key_chord(key)?;
    let mut modifiers = Vec::new();
    for part in modifier_parts {
        modifiers.push(PortalKey::Keysym(modifier_keysym(part)?));
    }
    let key = modifier_keysym(key_part)
        .filter(|_| modifier_parts.is_empty())
        .or_else(|| named_keysym(key_part))
        .map_or(PortalKey::Keycode(i32::from(keycode)), PortalKey::Keysym);
    Some((modifiers, key))
}

fn modifier_keysym(key: &str) -> Option<i32> {
    let keysym = match normalize_key(key).as_str() {
        "ctrl" | "control" => xkey::Control_L,
        "alt" | "option" => xkey::Alt_L,
        "shift" => xkey::Shift_L,
        "meta" | "super" | "cmd" | "command" => xkey::Super_L,
        _ => return None,
    };
    Some(keysym as i32)
}

fn named_keysym(key: &str) -> Option<i32> {
    let keysym = match normalize_key(key).as_str() {
        "enter" | "return" => xkey::Return,
        "escape" | "esc" => xkey::Escape,
        "tab" => xkey::Tab,
        "backspace" => xkey::BackSpace,
        "delete" | "del" => xkey::Delete,
        "space" => xkey::space,
        "home" => xkey::Home,
        "end" => xkey::End,
        "pageup" | "page_up" => xkey::Page_Up,
        "pagedown" | "page_down" => xkey::Page_Down,
        "arrowleft" | "left" => xkey::Left,
        "arrowright" | "right" => xkey::Right,
        "arrowup" | "up" => xkey::Up,
        "arrowdown" | "down" => xkey::Down,
        "f1" => xkey::F1,
        "f2" => xkey::F2,
        "f3" => xkey::F3,
        "f4" => xkey::F4,
        "f5" => xkey::F5,
        "f6" => xkey::F6,
        "f7" => xkey::F7,
        "f8" => xkey::F8,
        "f9" => xkey::F9,
        "f10" => xkey::F10,
        "f11" => xkey::F11,
        "f12" => xkey::F12,
        _ => return None,
    };
    Some(keysym as i32)
}

fn key_sequence(key: &str) -> Option<Vec<String>> {
    let (modifiers, keycode) = key_chord(key)?;
    let mut events = Vec::new();
    for modifier in &modifiers {
        events.push(format!("{modifier}:1"));
    }
    events.push(format!("{keycode}:1"));
    events.push(format!("{keycode}:0"));
    for modifier in modifiers.iter().rev() {
        events.push(format!("{modifier}:0"));
    }
    Some(events)
}

fn ydotool_key_args(key_events: Vec<String>, has_modifiers: bool) -> Vec<String> {
    let mut args = vec!["key".to_string()];
    if has_modifiers {
        args.extend(["-d".to_string(), "100".to_string()]);
    }
    args.extend(key_events);
    args
}

fn modifier_keycode(key: &str) -> Option<u16> {
    match normalize_key(key).as_str() {
        "ctrl" | "control" => Some(29),
        "alt" | "option" => Some(56),
        "shift" => Some(42),
        "meta" | "super" | "cmd" | "command" => Some(125),
        _ => None,
    }
}

fn keycode(key: &str) -> Option<u16> {
    match normalize_key(key).as_str() {
        "enter" | "return" => Some(28),
        "escape" | "esc" => Some(1),
        "tab" => Some(15),
        "backspace" => Some(14),
        "delete" | "del" => Some(111),
        "space" => Some(57),
        "home" => Some(102),
        "end" => Some(107),
        "pageup" | "page_up" => Some(104),
        "pagedown" | "page_down" => Some(109),
        "arrowleft" | "left" => Some(105),
        "arrowright" | "right" => Some(106),
        "arrowup" | "up" => Some(103),
        "arrowdown" | "down" => Some(108),
        "f1" => Some(59),
        "f2" => Some(60),
        "f3" => Some(61),
        "f4" => Some(62),
        "f5" => Some(63),
        "f6" => Some(64),
        "f7" => Some(65),
        "f8" => Some(66),
        "f9" => Some(67),
        "f10" => Some(68),
        "f11" => Some(87),
        "f12" => Some(88),
        value if value.len() == 1 => keycode_for_ascii(value.as_bytes()[0] as char),
        _ => None,
    }
}

fn normalize_key(key: &str) -> String {
    key.trim().to_ascii_lowercase().replace(['-', ' '], "")
}

fn keycode_for_ascii(value: char) -> Option<u16> {
    match value {
        'a' => Some(30),
        'b' => Some(48),
        'c' => Some(46),
        'd' => Some(32),
        'e' => Some(18),
        'f' => Some(33),
        'g' => Some(34),
        'h' => Some(35),
        'i' => Some(23),
        'j' => Some(36),
        'k' => Some(37),
        'l' => Some(38),
        'm' => Some(50),
        'n' => Some(49),
        'o' => Some(24),
        'p' => Some(25),
        'q' => Some(16),
        'r' => Some(19),
        's' => Some(31),
        't' => Some(20),
        'u' => Some(22),
        'v' => Some(47),
        'w' => Some(17),
        'x' => Some(45),
        'y' => Some(21),
        'z' => Some(44),
        '1' => Some(2),
        '2' => Some(3),
        '3' => Some(4),
        '4' => Some(5),
        '5' => Some(6),
        '6' => Some(7),
        '7' => Some(8),
        '8' => Some(9),
        '9' => Some(10),
        '0' => Some(11),
        _ => None,
    }
}

fn list_process_apps() -> Vec<AppCandidate> {
    let output = Command::new("ps")
        .args(["-eo", "pid=,comm=,args="])
        .output();
    let Ok(output) = output else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }

    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(parse_process_line)
        .filter(|app| looks_like_desktop_app(&app.name, &app.command))
        .take(50)
        .collect()
}

fn parse_process_line(line: &str) -> Option<AppCandidate> {
    let trimmed = line.trim();
    let mut parts = trimmed.splitn(3, char::is_whitespace);
    let pid = parts.next()?.parse().ok()?;
    let name = parts.next()?.to_string();
    let command = parts.next().unwrap_or("").trim().to_string();
    Some(AppCandidate { name, pid, command })
}

fn looks_like_desktop_app(name: &str, command: &str) -> bool {
    let haystack = format!("{name} {command}").to_ascii_lowercase();
    [
        "codex",
        "electron",
        "chrome",
        "chromium",
        "firefox",
        "brave",
        "code",
        "gnome-terminal",
        "ptyxis",
        "kgx",
        "nautilus",
        "slack",
        "discord",
        "spotify",
        "obsidian",
    ]
    .iter()
    .any(|needle| haystack.contains(needle))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn mcp_server_version_matches_cargo() {
        let info = rmcp::ServerHandler::get_info(&ComputerUseLinux::default());
        assert_eq!(info.server_info.version, env!("CARGO_PKG_VERSION"));
    }
    use crate::atspi_tree::{AccessibilityAction, Bounds};
    use crate::windows::{WindowBounds, GNOME_SHELL_EXTENSION_BACKEND, NIRI_BACKEND};
    use std::os::unix::fs::PermissionsExt;

    /// Restores an environment variable when a test ends, including on panic.
    struct EnvVarGuard {
        key: &'static str,
        original: Option<std::ffi::OsString>,
    }

    impl EnvVarGuard {
        fn set(key: &'static str, value: &str) -> Self {
            let original = std::env::var_os(key);
            std::env::set_var(key, value);
            Self { key, original }
        }

        fn unset(key: &'static str) -> Self {
            let original = std::env::var_os(key);
            std::env::remove_var(key);
            Self { key, original }
        }
    }

    impl Drop for EnvVarGuard {
        fn drop(&mut self) {
            match &self.original {
                Some(value) => std::env::set_var(self.key, value),
                None => std::env::remove_var(self.key),
            }
        }
    }

    /// The run_shell tests change the same process-wide variable, so they
    /// take turns instead of racing each other under the parallel test runner.
    static SHELL_ENV_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    /// Exercise the real handlers in a separate process so backend overrides
    /// cannot race other tests. All command programs are harmless stubs; the
    /// private datagram socket and invalid D-Bus address cannot reach a desktop.
    #[test]
    fn pointer_coordinate_backend_dispatch_is_safe() {
        let dir = std::env::temp_dir().join(format!(
            "cp-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        struct Cleanup(std::path::PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let _cleanup = Cleanup(dir.clone());
        let socket_path = dir.join("input.sock");
        let _socket = std::os::unix::net::UnixDatagram::bind(&socket_path).unwrap();
        for program in ["ydotool", "xdotool", "systemctl", "gnome-screenshot"] {
            let path = dir.join(program);
            std::fs::write(
                &path,
                r#"#!/bin/sh
case "${0##*/}" in
  systemctl) exit 0 ;;
  gnome-screenshot) printf 'capture\n' >> "$CUL_POINTER_TEST_CAPTURE_LOG"; exit 1 ;;
  ydotool)
    case "$1" in help|--help) printf '%s\n' click mousemove type key debug; exit 0 ;; esac
    # Capability probes use their own socket. Record only dispatched input.
    [ "$YDOTOOL_SOCKET" = "$CUL_POINTER_TEST_SOCKET" ] || exit 0 ;;
esac
printf '%s %s\n' "${0##*/}" "$*" >> "$CUL_POINTER_TEST_LOG"
"#,
            )
            .unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        for mode in [
            "wayland-default",
            "wayland-uncached",
            "wayland-ydotool",
            "wayland-portal",
            "x11",
        ] {
            let log = dir.join(format!("{mode}.log"));
            let capture_log = dir.join(format!("{mode}-capture.log"));
            let mut command = Command::new(std::env::current_exe().unwrap());
            command
                .args([
                    "--exact",
                    "server::tests::pointer_coordinate_backend_child",
                    "--nocapture",
                ])
                .env_clear()
                .env("PATH", &dir)
                .env("HOME", &dir)
                .env("CUL_POINTER_TEST_MODE", mode)
                .env("CUL_POINTER_TEST_LOG", &log)
                .env("CUL_POINTER_TEST_CAPTURE_LOG", &capture_log)
                .env("COMPUTER_USE_LINUX_SCREENSHOT_BACKEND", "gnome-screenshot")
                .env("CUL_POINTER_TEST_SOCKET", &socket_path)
                .env("YDOTOOL_SOCKET", &socket_path)
                .env("XDG_RUNTIME_DIR", &dir)
                .env(
                    "DBUS_SESSION_BUS_ADDRESS",
                    format!("unix:path={}/no-bus", dir.display()),
                )
                .env("DISPLAY", ":9876")
                .env(
                    "WAYLAND_DISPLAY",
                    if mode == "x11" { "" } else { "no-wayland" },
                )
                .env(
                    "XDG_SESSION_TYPE",
                    if mode == "x11" { "x11" } else { "wayland" },
                )
                .env("CU_DISABLE_ABS_POINTER", "1")
                .env(
                    "COMPUTER_USE_LINUX_FORCE_YDOTOOL_POINTER",
                    if mode == "wayland-ydotool" { "1" } else { "0" },
                )
                .env(
                    "COMPUTER_USE_LINUX_FORCE_PORTAL_POINTER",
                    if mode == "wayland-portal" { "1" } else { "0" },
                );
            for key in [
                "DESKTOP_SESSION",
                "HYPRLAND_INSTANCE_SIGNATURE",
                "XAUTHORITY",
                "XDG_SESSION_DESKTOP",
                "XDG_CURRENT_DESKTOP",
            ] {
                command.env(key, "pointer-test");
            }
            let output = crate::command_runner::output_blocking_with_timeout(
                &mut command,
                "pointer backend regression",
                Duration::from_secs(15),
            )
            .unwrap();
            assert!(
                output.status.success(),
                "{mode}: {}{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            assert!(
                !capture_log.exists(),
                "{mode}: a pointer warning triggered screenshot capture"
            );
            let commands = std::fs::read_to_string(&log).unwrap_or_default();
            match mode {
                "wayland-portal" => assert!(commands.is_empty(), "{commands}"),
                "x11" => {
                    assert!(
                        commands.contains("xdotool mousemove -- 5536 700 click"),
                        "{commands}"
                    );
                    assert!(
                        commands.contains("xdotool mousemove -- 100 100"),
                        "{commands}"
                    );
                    assert!(commands.contains("xdotool mouseup 1"), "{commands}");
                    assert!(!commands.contains("ydotool"), "{commands}");
                }
                _ => assert_eq!(commands, "ydotool mousemove --wheel -- 0 -5\n"),
            }
        }
    }

    /// Send newline-delimited JSON-RPC frames to an in-process server and
    /// collect every response frame until the server closes the stream.
    async fn mcp_exchange(frames: &[serde_json::Value]) -> Vec<serde_json::Value> {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        let (server_transport, client_transport) = tokio::io::duplex(1 << 20);
        let server = tokio::spawn(async move {
            if let Ok(running) = ComputerUseLinux::default().serve(server_transport).await {
                let _ = running.waiting().await;
            }
        });
        let (read, mut write) = tokio::io::split(client_transport);
        let mut input = String::new();
        for frame in frames {
            input.push_str(&frame.to_string());
            input.push('\n');
        }
        write.write_all(input.as_bytes()).await.unwrap();
        let mut reader = BufReader::new(read);
        let mut responses = Vec::new();
        let expected = frames
            .iter()
            .filter(|frame| frame.get("id").is_some())
            .count();
        while responses.len() < expected {
            let mut line = String::new();
            let read = tokio::time::timeout(Duration::from_secs(10), reader.read_line(&mut line))
                .await
                .expect("server should answer in time")
                .unwrap();
            if read == 0 {
                break;
            }
            let frame: serde_json::Value = serde_json::from_str(&line).unwrap();
            if frame.get("id").is_some() {
                responses.push(frame);
            }
        }
        drop(write);
        drop(reader);
        let _ = tokio::time::timeout(Duration::from_secs(10), server).await;
        responses
    }

    #[tokio::test]
    async fn bare_discover_probe_falls_back_to_initialize() {
        // Hosts probe with `server/discover` before `initialize`. rmcp 2 treated
        // any non-initialize first request as fatal and closed the stream.
        let responses = mcp_exchange(&[
            serde_json::json!({"jsonrpc":"2.0","id":1,"method":"server/discover","params":{}}),
            serde_json::json!({"jsonrpc":"2.0","id":2,"method":"initialize","params":{
                "protocolVersion":"2025-06-18","capabilities":{},
                "clientInfo":{"name":"test-client","version":"1"}}}),
            serde_json::json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
            serde_json::json!({"jsonrpc":"2.0","id":3,"method":"tools/list","params":{}}),
        ])
        .await;
        assert_eq!(responses.len(), 3, "{responses:?}");
        assert!(responses[0].get("error").is_some(), "{:?}", responses[0]);
        assert_eq!(responses[1]["result"]["protocolVersion"], "2025-06-18");
        assert!(!responses[2]["result"]["tools"]
            .as_array()
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn modern_discover_lifecycle_lists_tools() {
        let meta = serde_json::json!({
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": {"name": "test-client", "version": "1"},
            "io.modelcontextprotocol/clientCapabilities": {}
        });
        let responses = mcp_exchange(&[
            serde_json::json!({"jsonrpc":"2.0","id":1,"method":"server/discover","params":{"_meta":meta}}),
            serde_json::json!({"jsonrpc":"2.0","id":2,"method":"tools/list","params":{"_meta":meta}}),
        ])
        .await;
        assert_eq!(responses.len(), 2, "{responses:?}");
        assert!(responses[0]["result"]["supportedVersions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|version| version == "2026-07-28"));
        let listed = &responses[1]["result"];
        assert_eq!(listed["resultType"], "complete");
        assert!(listed.get("ttlMs").is_some() && listed.get("cacheScope").is_some());
        assert!(!listed["tools"].as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn pointer_coordinate_backend_child() {
        let Ok(mode) = std::env::var("CUL_POINTER_TEST_MODE") else {
            return;
        };
        let backend = ComputerUseLinux::default();
        if mode != "wayland-uncached" {
            backend.cache_desktop_size(9376, 1600);
            assert!(backend.off_screen_note_for_point(9376, 700).await.is_some());
        }
        assert!(backend.off_screen_note_for_point(5536, 700).await.is_none());
        let click: ClickParams =
            serde_json::from_value(serde_json::json!({"x":5536,"y":700})).unwrap();
        let scroll: ScrollParams =
            serde_json::from_value(serde_json::json!({"x":5536,"y":700,"direction":"down"}))
                .unwrap();
        let drag = DragParams {
            start_x: 100,
            start_y: 100,
            end_x: 200,
            end_y: 200,
            ..Default::default()
        };
        let results = [
            backend.dispatch_click(click).await.0,
            backend.dispatch_scroll(scroll).await.0,
            backend.dispatch_drag(drag).await.0,
        ];
        for result in results {
            if mode == "x11" {
                assert!(result.ok, "{}", result.message);
            } else {
                assert!(!result.ok, "{}", result.message);
                let expected = if mode == "wayland-portal" {
                    "portal could not start"
                } else {
                    "cannot position the pointer accurately on Wayland"
                };
                assert!(result.message.contains(expected), "{}", result.message);
            }
        }
        let scroll: ScrollParams =
            serde_json::from_value(serde_json::json!({"direction":"down"})).unwrap();
        let result = backend.dispatch_scroll(scroll).await.0;
        assert_eq!(result.ok, mode != "wayland-portal", "{}", result.message);
    }

    #[test]
    fn completion_tool_is_explicitly_opt_in_and_has_side_effect_annotations() {
        assert!(completion_notifications_enabled_value(Some("1"), None));
        assert!(completion_notifications_enabled_value(None, Some("1")));
        assert!(!completion_notifications_enabled_value(
            Some("0"),
            Some("1")
        ));
        assert!(!completion_notifications_enabled_value(None, None));
        let server = ComputerUseLinux::default();
        assert!(!server
            .router_with_completion(false)
            .list_all()
            .iter()
            .any(|t| t.name == "complete_interaction"));
        let tools = server.router_with_completion(true).list_all();
        let tool = tools
            .iter()
            .find(|t| t.name == "complete_interaction")
            .unwrap();
        let value = serde_json::to_value(tool).unwrap();
        assert_eq!(value["annotations"]["readOnlyHint"], false);
        assert_eq!(value["annotations"]["destructiveHint"], false);
        assert_eq!(value["annotations"]["idempotentHint"], false);
        assert_eq!(value["annotations"]["openWorldHint"], true);
    }

    #[tokio::test]
    async fn completion_notification_handles_missing_and_failed_backends() {
        for path in ["/nonexistent/computer-use-notify", "/bin/false"] {
            let result =
                send_completion_notification(Path::new(path), Duration::from_secs(2)).await;
            assert!(result.ok);
            assert_eq!(result.cue, "skipped");
        }
        let result =
            send_completion_notification(Path::new("/bin/true"), Duration::from_secs(2)).await;
        assert_eq!(result.cue, "notification");
    }

    #[tokio::test]
    async fn completion_notification_timeout_is_bounded() {
        let dir = std::env::temp_dir().join(format!(
            "computer-use-notify-test-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let program = dir.join("notify");
        std::fs::write(&program, "#!/bin/sh\nexec sleep 30\n").unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
        let started = std::time::Instant::now();
        let output = send_completion_notification(&program, Duration::from_millis(30)).await;
        assert_eq!(output.cue, "skipped");
        assert!(started.elapsed() < Duration::from_secs(3));
        std::fs::remove_dir_all(dir).unwrap();
    }
    use tokio::io::AsyncReadExt;

    #[test]
    fn avatar_cursor_socket_path_is_instance_scoped_and_bounded() {
        assert_eq!(
            avatar_cursor_socket_path_from(
                Some("/run/user/1000"),
                Some("codex-desktop"),
                None,
                Some("secondary"),
            ),
            Some(PathBuf::from(
                "/run/user/1000/codex-desktop/instances/secondary/computer-use-cursor.sock",
            )),
        );
        assert_eq!(
            avatar_cursor_socket_path_from(Some("relative"), Some("codex-desktop"), None, None,),
            None,
        );
        assert_eq!(
            avatar_cursor_socket_path_from(
                Some("/run/user/1000"),
                Some("codex-desktop"),
                None,
                Some("../escape"),
            ),
            None,
        );
        assert_eq!(
            avatar_cursor_socket_path_from(
                Some(&format!("/run/user/1000/{}", "x".repeat(100))),
                Some("codex-desktop"),
                None,
                None,
            ),
            None,
        );
    }

    #[test]
    fn avatar_cursor_identity_uses_electron_app_and_instance_arguments() {
        assert_eq!(
            avatar_cursor_identity_from_cmdline(
                b"/opt/codex/electron\0--app-id=codex-cua-lab\0--user-data-dir=/home/user/.local/state/codex-cua-lab/instances/port-5176/electron-user-data\0",
            ),
            (
                Some("codex-cua-lab".to_string()),
                Some("port-5176".to_string()),
            ),
        );
        assert_eq!(
            avatar_cursor_identity_from_cmdline(
                b"/opt/codex/electron\0--app-id=../escape\0--user-data-dir=/tmp/instances/../electron-user-data\0",
            ),
            (None, None),
        );
        assert_eq!(
            avatar_cursor_identity_from_cmdline(b"/bin/bash\0--app-id=codex-desktop\0"),
            (None, None),
        );
        assert_eq!(
            avatar_cursor_identity_from_cmdline(
                b"/opt/codex/electron\0--app-id=codex-desktop\0--user-data-dir=/home/instances/alice/.local/state/codex-desktop/electron-user-data\0",
            ),
            (Some("codex-desktop".to_string()), None),
        );
    }

    #[tokio::test]
    async fn avatar_cursor_signal_uses_the_private_unix_stream_protocol() {
        let root = std::env::temp_dir().join(format!(
            "cua-cursor-{}-{:x}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        std::fs::create_dir_all(&root).unwrap();
        let socket = root.join("cursor.sock");
        let listener = tokio::net::UnixListener::bind(&socket).unwrap();
        std::fs::set_permissions(&socket, std::os::unix::fs::PermissionsExt::from_mode(0o600))
            .unwrap();

        assert!(send_avatar_cursor_signal(&socket).await);
        let (mut stream, _) = timeout(Duration::from_secs(1), listener.accept())
            .await
            .unwrap()
            .unwrap();
        let mut payload = [0_u8; 8];
        stream.read_exact(&mut payload).await.unwrap();
        assert_eq!(&payload, b"pointer\n");

        drop(listener);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn exported_tool_schemas_omit_unsigned_integer_formats() {
        let tools = ComputerUseLinux::default().mcp_tool_router().list_all();
        let value = serde_json::to_value(tools).unwrap();
        let mut unsupported = Vec::new();
        collect_unsigned_integer_formats(&value, "$", &mut unsupported);

        assert!(
            unsupported.is_empty(),
            "unsupported unsigned integer formats: {unsupported:?}"
        );
    }

    fn collect_unsigned_integer_formats(
        value: &serde_json::Value,
        path: &str,
        unsupported: &mut Vec<String>,
    ) {
        match value {
            serde_json::Value::Object(object) => {
                if matches!(
                    object.get("format").and_then(serde_json::Value::as_str),
                    Some("uint" | "uint8" | "uint16" | "uint32" | "uint64" | "usize")
                ) {
                    unsupported.push(path.to_string());
                }
                for (key, nested) in object {
                    collect_unsigned_integer_formats(nested, &format!("{path}/{key}"), unsupported);
                }
            }
            serde_json::Value::Array(items) => {
                for (index, nested) in items.iter().enumerate() {
                    collect_unsigned_integer_formats(
                        nested,
                        &format!("{path}/{index}"),
                        unsupported,
                    );
                }
            }
            _ => {}
        }
    }

    fn node(index: u32, bounds: Option<Bounds>) -> AccessibilityNode {
        node_with_actions(index, bounds, Vec::new())
    }

    #[test]
    fn shell_only_tree_explains_missing_renderer_content() {
        let mut frame = node(0, None);
        frame.role = "frame".to_string();
        let nodes = [frame];
        let note = shell_only_accessibility_tree_note(&nodes, true, false).unwrap();
        assert!(note.contains("--force-renderer-accessibility"));
        assert!(note.contains("If this is an Electron/Chromium app"));
        assert!(shell_only_accessibility_tree_note(&nodes, false, false).is_none());
        assert!(shell_only_accessibility_tree_note(&nodes, true, true).is_none());
        assert!(shell_only_accessibility_tree_note(&[], true, false).is_none());
    }

    #[test]
    fn content_and_editable_trees_do_not_get_renderer_hint() {
        let mut content = node(0, None);
        assert!(shell_only_accessibility_tree_note(&[content.clone()], true, false).is_none());
        content.role = "frame".to_string();
        content.supports_editable_text = true;
        assert!(shell_only_accessibility_tree_note(&[content], true, false).is_none());
    }

    #[test]
    fn native_menu_chrome_does_not_hide_the_renderer_hint() {
        let mut frame = node(0, None);
        frame.role = "frame".to_string();
        let mut menu = node(1, None);
        menu.role = "menu item".to_string();
        menu.actions.push(AccessibilityAction {
            index: 0,
            name: "click".to_string(),
            description: String::new(),
            keybinding: String::new(),
        });
        assert!(
            shell_only_accessibility_tree_note(&[frame.clone(), menu.clone()], true, false)
                .is_some()
        );
        menu.supports_editable_text = true;
        assert!(shell_only_accessibility_tree_note(&[frame, menu], true, false).is_none());
    }

    #[test]
    fn native_menu_buttons_are_chrome_only_beneath_a_menu() {
        let mut frame = node(0, None);
        frame.role = "frame".to_string();
        let mut panel = node(1, None);
        panel.role = "panel".to_string();
        panel.parent_index = Some(0);
        let mut menu = node(2, None);
        menu.role = "menu bar".to_string();
        menu.parent_index = Some(1);
        let mut button = node(3, None);
        button.role = "button".to_string();
        button.parent_index = Some(2);
        assert!(shell_only_accessibility_tree_note(
            &[frame.clone(), panel.clone(), menu.clone(), button.clone()],
            true,
            false
        )
        .is_some());
        button.parent_index = Some(1);
        assert!(
            shell_only_accessibility_tree_note(&[frame, panel, menu, button], true, false)
                .is_none()
        );
    }

    #[test]
    fn review_hint_keeps_raw_menu_ancestry_after_compaction() {
        let mut frame = node(0, None);
        frame.role = "frame".to_string();
        frame.depth = 1;
        let mut panel = node(1, None);
        panel.role = "panel".to_string();
        panel.name = None;
        panel.depth = 2;
        panel.parent_index = Some(0);
        let mut menu = node(2, None);
        menu.role = "menu bar".to_string();
        menu.name = None;
        menu.depth = 3;
        menu.parent_index = Some(1);
        let mut button = node(3, None);
        button.role = "button".to_string();
        button.depth = 4;
        button.parent_index = Some(2);
        let nodes = vec![frame, panel, menu, button];
        let (compacted, note) = compact_accessibility_tree_with_note(nodes.clone(), true, false);
        assert_eq!(
            compacted.len(),
            2,
            "unnamed panel and menu bar should be compacted away"
        );
        assert_eq!(compacted[1].parent_index, Some(0));
        assert!(
            shell_only_accessibility_tree_note(&compacted, true, false).is_none(),
            "compacted data cannot recover the removed menu context"
        );
        assert!(
            note.is_some(),
            "raw menu ancestry must determine the observation hint"
        );
        assert!(
            compact_accessibility_tree_with_note(nodes.clone(), false, false)
                .1
                .is_none()
        );
        assert!(compact_accessibility_tree_with_note(nodes, true, true)
            .1
            .is_none());
    }

    fn node_with_actions(
        index: u32,
        bounds: Option<Bounds>,
        actions: Vec<AccessibilityAction>,
    ) -> AccessibilityNode {
        AccessibilityNode {
            index,
            parent_index: None,
            depth: 0,
            object_ref: format!(":1.{index}/org/a11y/atspi/accessible/{index}"),
            role: "push button".to_string(),
            name: Some(format!("Button {index}")),
            description: None,
            child_count: 0,
            bounds,
            states: Vec::new(),
            actions,
            value: None,
            text: None,
            supports_editable_text: false,
        }
    }

    fn click_action() -> AccessibilityAction {
        AccessibilityAction {
            index: 0,
            name: "Click".to_string(),
            description: "Clicks the element".to_string(),
            keybinding: String::new(),
        }
    }

    fn solid_png(width: u32, height: u32) -> Vec<u8> {
        let img = image::RgbaImage::from_pixel(width, height, image::Rgba([32, 128, 192, 255]));
        let mut out = Vec::new();
        image::DynamicImage::ImageRgba8(img)
            .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
            .unwrap();
        out
    }

    #[test]
    fn targeted_app_state_crops_before_screenshot_payload_resize() {
        let raw = RawScreenshotCapture {
            mime_type: "image/png".to_string(),
            bytes: solid_png(400, 200),
            source: "test".to_string(),
            width: 400,
            height: 200,
        };
        let capture = prepare_app_state_screenshot(
            raw,
            Some((50, 20, 200, 100)),
            true,
            ScreenshotPayloadOptions {
                max_width: Some(100),
                max_height: Some(100),
                max_bytes: Some(1024 * 1024),
                ..Default::default()
            },
        )
        .unwrap();

        assert_eq!(
            (capture.coordinate_width, capture.coordinate_height),
            (200, 100)
        );
        assert_eq!((capture.width, capture.height), (100, 50));
    }

    #[test]
    fn unresolved_app_state_target_refuses_full_desktop_screenshot() {
        let raw = RawScreenshotCapture {
            mime_type: "image/png".to_string(),
            bytes: solid_png(400, 200),
            source: "test".to_string(),
            width: 400,
            height: 200,
        };

        let error =
            prepare_app_state_screenshot(raw, None, true, ScreenshotPayloadOptions::default())
                .unwrap_err();

        assert!(error.to_string().contains("requires a resolved window"));
    }

    #[test]
    fn targeted_app_state_crops_only_visible_part_of_offscreen_window() {
        let raw = RawScreenshotCapture {
            mime_type: "image/png".to_string(),
            bytes: solid_png(400, 200),
            source: "test".to_string(),
            width: 400,
            height: 200,
        };
        let capture = prepare_app_state_screenshot(
            raw,
            Some((-50, -40, 100, 100)),
            true,
            ScreenshotPayloadOptions::default(),
        )
        .unwrap();

        assert_eq!(
            (capture.coordinate_width, capture.coordinate_height),
            (50, 60)
        );
    }

    fn sample_app_state_output(screenshot: Option<&ScreenshotCapture>) -> GetAppStateOutput {
        GetAppStateOutput {
            app_name_or_bundle_identifier: None,
            window_context: None,
            window_error: None,
            window_permissions_hint: None,
            backend: "linux-atspi".to_string(),
            screenshot: screenshot.map(ScreenshotSummary::from),
            screenshot_error: None,
            accessibility_tree: Vec::new(),
            accessibility_tree_spill: None,
            accessibility_tree_raw_count: 0,
            tree_scoped: true,
            accessibility_tree_truncated: false,
            accessibility_error: None,
            readiness: crate::diagnostics::ReadinessReport {
                can_register_mcp_tools: true,
                can_build_accessibility_tree: true,
                can_query_windows: true,
                can_focus_apps: true,
                can_focus_windows: true,
                can_send_development_input: true,
                can_capture_screenshots: true,
                screenshot_capture_status: crate::diagnostics::ScreenshotCaptureStatus::Verified,
                recommended_next_step: String::new(),
                blockers: Vec::new(),
                warnings: Vec::new(),
            },
            diagnostics: None,
            message: "ok".to_string(),
        }
    }

    #[test]
    fn app_state_result_emits_screenshot_as_image_block_not_inline_base64() {
        let raw = RawScreenshotCapture {
            mime_type: "image/png".to_string(),
            bytes: solid_png(64, 32),
            source: "test".to_string(),
            width: 64,
            height: 32,
        };
        let capture =
            prepare_app_state_screenshot(raw, None, false, ScreenshotPayloadOptions::default())
                .unwrap();
        let payload = data_url_payload(&capture.data_url);
        let output = sample_app_state_output(Some(&capture));

        let result = app_state_result(output, Some(capture)).unwrap();

        assert_eq!(result.content.len(), 2);
        let image = result.content[0]
            .as_image()
            .expect("first block is an image");
        assert_eq!(image.mime_type, "image/png");
        assert_eq!(image.data, payload);
        let text = &result.content[1]
            .as_text()
            .expect("second block is text")
            .text;
        assert!(
            !text.contains(&payload),
            "base64 leaked into the text block"
        );
        assert!(!text.contains("data_url"));
        let structured = result.structured_content.expect("structured content");
        assert_eq!(structured["screenshot"]["width"], 64);
        assert_eq!(structured["screenshot"]["mime_type"], "image/png");
        assert!(structured["screenshot"].get("data_url").is_none());
    }

    #[test]
    fn app_state_result_without_screenshot_is_text_only() {
        let result = app_state_result(sample_app_state_output(None), None).unwrap();
        assert_eq!(result.is_error, Some(false));
        assert_eq!(result.content.len(), 1);
        assert!(result.content[0].as_text().is_some());
        assert_eq!(
            result.structured_content.unwrap()["screenshot"],
            serde_json::Value::Null
        );
    }

    /// A server whose diagnostics probe labels each report with its run number
    /// in `recommended_next_step`, so a result shows which run it came from.
    /// Each run, and the live accessibility check, read `accessibility_enabled`.
    /// Each run reads `windows_available` for whether a window backend answers.
    pub(super) fn server_with_labelled_diagnostics(
        accessibility_enabled: fn() -> bool,
        windows_available: fn() -> bool,
    ) -> (ComputerUseLinux, Arc<std::sync::atomic::AtomicUsize>) {
        server_with_labelled_reports(accessibility_enabled, move || {
            crate::diagnostics::tests::doctor_report_fixture(
                accessibility_enabled(),
                windows_available(),
            )
        })
    }

    /// Like `server_with_labelled_diagnostics`, with each probe's report built
    /// by `report`.
    pub(super) fn server_with_labelled_reports(
        accessibility_enabled: fn() -> bool,
        report: impl Fn() -> DoctorReport + Send + Sync + 'static,
    ) -> (ComputerUseLinux, Arc<std::sync::atomic::AtomicUsize>) {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let runs = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&runs);
        let probe = move || {
            let run = counter.fetch_add(1, Ordering::SeqCst) + 1;
            let mut report = report();
            report.readiness.recommended_next_step = format!("probe run {run}");
            report
        };
        let server = ComputerUseLinux {
            diagnostics: Arc::new(DiagnosticsCache::new(
                Arc::new(probe),
                Duration::from_secs(3600),
            )),
            accessibility_check: AccessibilityCheck(accessibility_enabled),
            ..Default::default()
        };
        (server, runs)
    }

    pub(super) async fn app_state_value(
        server: &ComputerUseLinux,
        params: serde_json::Value,
    ) -> serde_json::Value {
        let params: GetAppStateParams = serde_json::from_value(params).unwrap();
        server
            .app_state(params)
            .await
            .unwrap()
            .structured_content
            .unwrap()
    }

    #[test]
    fn readiness_is_refreshed_only_when_an_observation_contradicts_it() {
        use crate::windowing::registry::{
            GNOME_SHELL_EXTENSION_BACKEND, GNOME_SHELL_INTROSPECT_BACKEND, KWIN_BACKEND,
        };
        use Contradiction::{Failure, Success};
        let cached = |can_build_accessibility_tree: bool, can_query_windows: bool| {
            crate::diagnostics::tests::doctor_report_fixture(
                can_build_accessibility_tree,
                can_query_windows,
            )
        };
        let backends = |health: &[(&str, bool)]| {
            let mut report = cached(true, true);
            for (backend, ok) in health {
                report.windowing.backends.insert(
                    backend.to_string(),
                    crate::diagnostics::Check {
                        ok: *ok,
                        detail: String::new(),
                    },
                );
            }
            report
        };
        let observed = |screenshot_failed, window, tree| AppStateObservation {
            screenshot_failed,
            window,
            failed_window_backends: &[],
            tree,
        };
        let resolved_after_failures = |failed_window_backends| AppStateObservation {
            screenshot_failed: false,
            window: WindowLookup::Resolved,
            failed_window_backends,
            tree: TreeRead::Nodes,
        };
        let cases = [
            (
                "everything worked as the readiness says",
                cached(true, true),
                observed(false, WindowLookup::Resolved, TreeRead::Nodes),
                None,
            ),
            (
                "a screenshot failed",
                cached(true, true),
                observed(true, WindowLookup::NotRequested, TreeRead::Nodes),
                Some(Failure),
            ),
            (
                "a window lookup failed",
                cached(true, true),
                observed(false, WindowLookup::Failed, TreeRead::Nodes),
                Some(Failure),
            ),
            (
                "a window lookup failed where the readiness says it would",
                cached(true, false),
                observed(false, WindowLookup::Failed, TreeRead::Nodes),
                Some(Failure),
            ),
            (
                "the tree read failed or found no nodes",
                cached(true, true),
                observed(false, WindowLookup::NotRequested, TreeRead::Failed),
                Some(Failure),
            ),
            (
                "the tree was skipped because this call found accessibility off",
                cached(false, true),
                observed(
                    false,
                    WindowLookup::NotRequested,
                    TreeRead::AccessibilityOff,
                ),
                None,
            ),
            (
                "a failure alongside the expected skip",
                cached(false, true),
                observed(true, WindowLookup::NotRequested, TreeRead::AccessibilityOff),
                Some(Failure),
            ),
            (
                "a window resolved where the readiness says none can be listed",
                cached(false, false),
                observed(false, WindowLookup::Resolved, TreeRead::AccessibilityOff),
                Some(Success),
            ),
            (
                "no window was requested where the readiness says none can be listed",
                cached(true, false),
                observed(false, WindowLookup::NotRequested, TreeRead::Nodes),
                None,
            ),
            (
                "a backend the cached report calls healthy failed before another answered",
                backends(&[(GNOME_SHELL_EXTENSION_BACKEND, true)]),
                resolved_after_failures(&[GNOME_SHELL_EXTENSION_BACKEND]),
                Some(Failure),
            ),
            (
                "backends the cached report calls unhealthy failed before KWin answered",
                backends(&[
                    (GNOME_SHELL_EXTENSION_BACKEND, false),
                    (GNOME_SHELL_INTROSPECT_BACKEND, false),
                    (KWIN_BACKEND, true),
                ]),
                resolved_after_failures(&[
                    GNOME_SHELL_EXTENSION_BACKEND,
                    GNOME_SHELL_INTROSPECT_BACKEND,
                ]),
                None,
            ),
        ];
        for (case, cached, observed, expected) in cases {
            assert_eq!(
                readiness_contradiction(&cached.readiness, &cached.windowing, observed),
                expected,
                "{case}"
            );
        }
    }

    #[tokio::test]
    async fn app_state_calls_that_find_what_the_cache_predicts_reuse_one_report() {
        use std::sync::atomic::Ordering;
        // Accessibility is off in the fixture and in the live check, so every
        // call skips the tree, as the cached report predicts, without touching
        // the desktop.
        let (server, runs) = server_with_labelled_diagnostics(|| false, || true);
        for call in 1..=3 {
            let state =
                app_state_value(&server, serde_json::json!({"include_screenshot": false})).await;
            assert!(
                state["accessibility_error"]
                    .as_str()
                    .unwrap()
                    .contains("accessibility is disabled"),
                "{state}"
            );
            assert_eq!(
                state["readiness"]["recommended_next_step"], "probe run 1",
                "call {call} reports the first call's report"
            );
        }
        assert_eq!(runs.load(Ordering::SeqCst), 1, "only the first call probed");
    }

    #[tokio::test]
    async fn a_failed_action_makes_the_next_app_state_probe_again() {
        use std::sync::atomic::Ordering;
        // Accessibility is off as the cached report says, so the observation
        // itself never asks for a probe.
        let (server, runs) = server_with_labelled_diagnostics(|| false, || true);
        server.diagnostics.report(false).await;

        // No observation has cached a tree, so the index is stale and the
        // action fails before it reaches the desktop.
        let params = serde_json::from_value(serde_json::json!({"element_index": 3})).unwrap();
        let result = server.perform_action(Parameters(params)).await.unwrap();
        assert_eq!(result.is_error, Some(true));

        let state =
            app_state_value(&server, serde_json::json!({"include_screenshot": false})).await;
        assert_eq!(
            runs.load(Ordering::SeqCst),
            2,
            "the failed action forced a probe"
        );
        assert_eq!(state["readiness"]["recommended_next_step"], "probe run 2");
    }

    #[tokio::test]
    async fn verbose_app_state_always_probes_and_refreshes_the_cache() {
        use std::sync::atomic::Ordering;
        let (server, runs) = server_with_labelled_diagnostics(|| false, || true);
        server.diagnostics.report(false).await;

        let verbose = app_state_value(
            &server,
            serde_json::json!({"include_screenshot": false, "verbose": true}),
        )
        .await;
        assert_eq!(runs.load(Ordering::SeqCst), 2);
        assert_eq!(verbose["readiness"]["recommended_next_step"], "probe run 2");
        assert_eq!(
            verbose["diagnostics"]["readiness"]["recommended_next_step"],
            "probe run 2"
        );

        let next = app_state_value(&server, serde_json::json!({"include_screenshot": false})).await;
        assert_eq!(runs.load(Ordering::SeqCst), 2);
        assert_eq!(
            next["readiness"]["recommended_next_step"], "probe run 2",
            "the next call reuses the verbose call's report"
        );
    }

    /// Runs `child` in a process whose busctl and gsettings answer the
    /// accessibility probes from CUL_A11Y_ENABLED, which starts as true. The
    /// AT-SPI bus they name has no socket, so every tree read fails.
    fn run_accessibility_child(child: &str) {
        let dir = std::env::temp_dir().join(format!(
            "cul-a11y-{child}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        struct Cleanup(std::path::PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let _cleanup = Cleanup(dir.clone());

        // systemctl keeps session discovery off the desktop.
        for program in ["busctl", "gsettings", "systemctl"] {
            let path = dir.join(program);
            std::fs::write(
                &path,
                r#"#!/bin/sh
case "${0##*/} $*" in
  systemctl*) exit 1 ;;
  *GetAddress) echo "s \"unix:path=$HOME/no-a11y-bus\"" ;;
  *IsEnabled|*toolkit-accessibility) echo "$CUL_A11Y_ENABLED" ;;
  *) echo false ;;
esac
"#,
            )
            .unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        }

        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                &format!("server::tests::{child}"),
                "--ignored",
                "--nocapture",
            ])
            .env_clear()
            .env("PATH", &dir)
            .env("HOME", &dir)
            .env("XDG_RUNTIME_DIR", &dir)
            .env("DISPLAY", ":9876")
            .env("WAYLAND_DISPLAY", "")
            .env("XDG_SESSION_TYPE", "x11")
            .env("CUL_A11Y_CHILD", "1")
            .env("CUL_A11Y_ENABLED", "true")
            .env(
                "DBUS_SESSION_BUS_ADDRESS",
                format!("unix:path={}/no-bus", dir.display()),
            );
        for key in [
            "DESKTOP_SESSION",
            "HYPRLAND_INSTANCE_SIGNATURE",
            "XAUTHORITY",
            "XDG_SESSION_DESKTOP",
            "XDG_CURRENT_DESKTOP",
        ] {
            command.env(key, "a11y-child-test");
        }

        let output = crate::command_runner::output_blocking_with_timeout(
            &mut command,
            child,
            Duration::from_secs(15),
        )
        .unwrap();
        assert!(
            String::from_utf8_lossy(&output.stdout).contains("running 1 test"),
            "{child} must execute its assertions"
        );
        assert!(
            output.status.success(),
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn a_failed_app_state_reports_fresh_readiness_and_the_next_call_probes_again() {
        run_accessibility_child("failed_app_state_child");
    }

    #[tokio::test]
    #[ignore = "isolated environment subprocess; invoked by a_failed_app_state_reports_fresh_readiness_and_the_next_call_probes_again"]
    async fn failed_app_state_child() {
        use std::sync::atomic::Ordering;
        assert_eq!(env::var("CUL_A11Y_CHILD").as_deref(), Ok("1"));
        let (server, runs) = server_with_labelled_diagnostics(
            crate::diagnostics::can_build_accessibility_tree_now,
            || true,
        );
        server.diagnostics.report(false).await;

        let state =
            app_state_value(&server, serde_json::json!({"include_screenshot": false})).await;
        let error = state["accessibility_error"].as_str().unwrap();
        assert!(error.contains("failed to connect to AT-SPI bus"), "{error}");
        assert_eq!(
            runs.load(Ordering::SeqCst),
            2,
            "the failed call probed once"
        );
        assert_eq!(state["readiness"]["recommended_next_step"], "probe run 2");
        assert!(state["diagnostics"].is_null());

        // Every tree read fails here, so a second call would probe on its
        // failure either way. Read what its start would read instead.
        let (_, probed) = server.diagnostics.report_and_probed(false).await;
        assert!(probed, "the next call probes again to see a recovery");
    }

    #[test]
    fn app_state_sees_accessibility_switched_off_and_on_within_the_ttl() {
        run_accessibility_child("accessibility_switch_child");
    }

    #[tokio::test]
    #[ignore = "isolated environment subprocess; invoked by app_state_sees_accessibility_switched_off_and_on_within_the_ttl"]
    async fn accessibility_switch_child() {
        use std::sync::atomic::Ordering;
        assert_eq!(env::var("CUL_A11Y_CHILD").as_deref(), Ok("1"));
        let (server, runs) = server_with_labelled_diagnostics(
            crate::diagnostics::can_build_accessibility_tree_now,
            || true,
        );
        let params = serde_json::json!({"include_screenshot": false});
        let cached = server.diagnostics.report(false).await;
        assert!(cached.readiness.can_build_accessibility_tree);

        env::set_var("CUL_A11Y_ENABLED", "false");
        let off = app_state_value(&server, params.clone()).await;
        assert_eq!(
            runs.load(Ordering::SeqCst),
            2,
            "switching off forced a probe"
        );
        assert_eq!(off["readiness"]["recommended_next_step"], "probe run 2");
        assert_eq!(off["readiness"]["can_build_accessibility_tree"], false);
        assert!(
            off["accessibility_error"]
                .as_str()
                .unwrap()
                .contains("accessibility is disabled"),
            "{}",
            off["accessibility_error"]
        );

        let still_off = app_state_value(&server, params.clone()).await;
        assert_eq!(
            runs.load(Ordering::SeqCst),
            2,
            "a call that finds accessibility off, as cached, keeps the cache"
        );
        assert_eq!(
            still_off["readiness"]["recommended_next_step"],
            "probe run 2"
        );

        env::set_var("CUL_A11Y_ENABLED", "true");
        let on = app_state_value(&server, params).await;
        assert_eq!(
            runs.load(Ordering::SeqCst),
            3,
            "switching on forced a probe"
        );
        assert_eq!(on["readiness"]["recommended_next_step"], "probe run 3");
        assert_eq!(on["readiness"]["can_build_accessibility_tree"], true);
        assert!(
            !on["accessibility_error"]
                .as_str()
                .unwrap_or_default()
                .contains("accessibility is disabled"),
            "the tree read must run: {}",
            on["accessibility_error"]
        );
    }

    #[test]
    fn gnome_window_crop_scales_logical_bounds_to_capture_pixels() {
        let bounds = WindowBounds {
            x: Some(6),
            y: Some(36),
            width: 1357,
            height: 1144,
        };
        let monitors = [(0, 0, 1920, 1200)];

        assert_eq!(
            logical_window_crop_rect(&bounds, &monitors, 2560, 1600).unwrap(),
            (8, 48, 1810, 1526)
        );
    }

    #[test]
    fn portal_points_map_capture_pixels_back_to_logical_window_space() {
        let scaled = WindowCoordinateMap {
            capture_rect: (8, 48, 1810, 1526),
            full_capture_rect: (8, 48, 1810, 1526),
            portal_rect: Some((6, 36, 1357, 1144)),
        };
        assert_eq!(scaled.portal_point(913, 811), Some((684, 608)));

        let clipped = WindowCoordinateMap {
            capture_rect: (0, 0, 50, 60),
            full_capture_rect: (-50, -40, 100, 100),
            portal_rect: Some((-50, -40, 100, 100)),
        };
        assert_eq!(clipped.portal_point(0, 0), Some((0, 0)));
    }

    #[test]
    fn scaled_kwin_bounds_keep_capture_and_portal_spaces_distinct() {
        let bounds = WindowBounds {
            x: Some(1000),
            y: Some(100),
            width: 800,
            height: 600,
        };
        let logical_rect = window_crop_rect(&bounds).unwrap();
        let full_capture_rect =
            logical_window_crop_rect(&bounds, &[(0, 0, 1920, 1080)], 3840, 2160).unwrap();
        let mapping = WindowCoordinateMap {
            capture_rect: full_capture_rect,
            full_capture_rect,
            portal_rect: Some(logical_rect),
        };

        assert_eq!(mapping.capture_rect, (2000, 200, 1600, 1200));
        assert_eq!(mapping.portal_point(2400, 500), Some((1200, 250)));
    }

    #[test]
    fn kwin_mapping_uses_the_workspace_geometry_origin() {
        let bounds = WindowBounds {
            x: Some(1100),
            y: Some(50),
            width: 800,
            height: 600,
        };
        let logical_rect = window_crop_rect(&bounds).unwrap();
        let full_capture_rect =
            logical_window_crop_rect(&bounds, &[(100, -50, 1920, 1080)], 3840, 2160).unwrap();
        let mapping = WindowCoordinateMap {
            capture_rect: full_capture_rect,
            full_capture_rect,
            portal_rect: Some(logical_rect),
        };

        assert_eq!(mapping.capture_rect, (2000, 200, 1600, 1200));
        assert_eq!(mapping.portal_point(2400, 500), Some((1300, 200)));
    }

    #[test]
    fn gnome_window_crop_accounts_for_negative_monitor_origins() {
        let bounds = WindowBounds {
            x: Some(-900),
            y: Some(100),
            width: 400,
            height: 300,
        };
        let monitors = [(-1000, 0, 1000, 800), (0, 0, 1200, 800)];

        assert_eq!(
            logical_window_crop_rect(&bounds, &monitors, 2200, 800).unwrap(),
            (100, 100, 400, 300)
        );
    }

    #[test]
    fn readonly_targeted_screenshot_requires_focused_visible_window() {
        let mut window = window_info(1, Some("Target"), None, None, None);
        assert!(ensure_readonly_screenshot_target_is_visible(&window).is_err());
        window.focused = true;
        assert!(ensure_readonly_screenshot_target_is_visible(&window).is_ok());
        window.hidden = true;
        assert!(ensure_readonly_screenshot_target_is_visible(&window).is_err());
    }

    #[test]
    fn wayland_display_is_enough_to_select_portal_fallback() {
        assert!(session_is_wayland(None, Some("wayland-1")));
        assert!(session_is_wayland(Some("  "), Some("wayland-1")));
        assert!(session_is_wayland(Some("wayland"), None));
        assert!(!session_is_wayland(Some("x11"), None));
        assert!(!session_is_wayland(None, Some("  ")));
    }

    #[test]
    fn xdotool_keyboard_override_policy_matches_documented_precedence() {
        assert!(prefer_xdotool_keyboard(false, true, true, true, true));
        assert!(!prefer_xdotool_keyboard(true, true, true, true, true));
        assert!(!prefer_xdotool_keyboard(false, true, true, false, true));
        assert!(!prefer_xdotool_keyboard(false, false, true, true, true));
        assert!(prefer_xdotool_keyboard(false, false, false, true, true));
    }

    #[test]
    fn native_x11_pointer_policy_requires_explicit_x11_without_wayland_display() {
        assert!(native_x11_xdotool_pointer_session(Some("x11"), None));
        assert!(!native_x11_xdotool_pointer_session(
            Some("wayland"),
            Some("wayland-0")
        ));
        assert!(!native_x11_xdotool_pointer_session(
            Some("x11"),
            Some("wayland-0")
        ));
    }

    #[test]
    fn literal_text_portal_policy_preserves_layout_aware_routes_and_overrides() {
        // GNOME has no wtype route. ydotool availability must not suppress
        // literal portal text, unlike pointer and physical chord policies.
        assert!(prefer_portal_text_backend(
            false, false, true, false, false, false
        ));
        // A compatible compositor with wtype needs no portal prompt.
        assert!(!prefer_portal_text_backend(
            false, false, true, false, false, true
        ));
        assert!(prefer_portal_text_backend(
            false, false, true, false, true, true
        ));
        // Explicit raw/XTEST overrides, KDE clipboard, and X11 keep precedence.
        assert!(!prefer_portal_text_backend(
            true, false, true, false, true, false
        ));
        assert!(!prefer_portal_text_backend(
            false, true, true, false, true, false
        ));
        assert!(!prefer_portal_text_backend(
            false, false, true, true, true, false
        ));
        assert!(!prefer_portal_text_backend(
            false, false, false, false, true, false
        ));
    }

    #[tokio::test]
    async fn raw_text_rejects_unsupported_characters_before_backend_access() {
        assert!(validate_ydotool_text("probe-0710_a/b\t\nXYZ").is_ok());
        for text in [
            "prefixä",
            "prefix中",
            "prefix\r",
            "prefix\0",
            "prefix\u{7f}",
        ] {
            // This exits before CLI probing, socket discovery or input, even
            // though a supported prefix appears before the invalid character.
            let error = run_ydotool_type_text(text).await.unwrap_err();
            assert!(error.contains("no text was sent"), "{error}");
        }
    }

    #[test]
    fn raw_text_success_explains_layout_dependence() {
        let result = action_result("type_text", Ok(Vec::new()), None);
        assert!(result.ok);
        assert!(result.message.contains("US physical key positions"));
        assert!(result.message.contains("verify the field contents"));
    }

    #[test]
    fn window_crop_happens_before_screenshot_payload_resize() {
        let (cropped, width, height) = crop_png(&solid_png(400, 200), 50, 20, 200, 100).unwrap();
        let capture = prepare_screenshot_payload(
            RawScreenshotCapture {
                mime_type: "image/png".to_string(),
                bytes: cropped,
                source: "test".to_string(),
                width,
                height,
            },
            ScreenshotPayloadOptions {
                max_width: Some(100),
                max_height: Some(100),
                max_bytes: Some(1024 * 1024),
                ..Default::default()
            },
        )
        .unwrap();

        assert_eq!(
            (capture.coordinate_width, capture.coordinate_height),
            (200, 100)
        );
        assert_eq!((capture.width, capture.height), (100, 50));
        assert!(capture.resized);
    }

    fn window_info(
        window_id: u64,
        title: Option<&str>,
        app_id: Option<&str>,
        wm_class: Option<&str>,
        pid: Option<u32>,
    ) -> WindowInfo {
        WindowInfo {
            window_id,
            title: title.map(str::to_string),
            app_id: app_id.map(str::to_string),
            wm_class: wm_class.map(str::to_string),
            pid,
            bounds: Some(WindowBounds {
                x: Some(10),
                y: Some(20),
                width: 800,
                height: 600,
            }),
            workspace: Some(0),
            focused: false,
            hidden: false,
            client_type: Some("wayland".to_string()),
            backend: GNOME_SHELL_EXTENSION_BACKEND.to_string(),
            terminal: None,
        }
    }

    #[test]
    fn window_backend_names_the_backend_that_answered() {
        let mut window = window_info(1, Some("Editor"), None, None, None);
        window.backend = NIRI_BACKEND.to_string();
        assert_eq!(window_backend(std::iter::once(&window)), NIRI_BACKEND);
        assert_eq!(window_backend(std::iter::empty()), UNAVAILABLE_BACKEND);
    }

    #[test]
    fn relative_click_coordinates_use_capture_space_rect() {
        let mut params = ClickParams {
            x: Some(7),
            y: Some(9),
            relative: Some(true),
            ..Default::default()
        };

        apply_window_relative_click_coordinates(&mut params, (133, 267, 1067, 800)).unwrap();

        assert_eq!((params.x, params.y), (Some(140), Some(276)));
    }

    #[test]
    fn relative_click_origin_is_screenshot_crop_not_raw_surface_buffer() {
        // GNOME Wayland CSD probe: frame [760,406,400,300], buffer
        // [746,394,428,329]. The screenshot's green target is at [850,543].
        // Crop-local [90,137] and desktop [850,543] must denote the same point;
        // substituting the buffer/shadow origin would miss by [14,12].
        let mut params = ClickParams {
            x: Some(90),
            y: Some(137),
            relative: Some(true),
            ..Default::default()
        };
        apply_window_relative_click_coordinates(&mut params, (760, 406, 400, 300)).unwrap();
        assert_eq!((params.x, params.y), (Some(850), Some(543)));
    }

    #[test]
    fn relative_click_coordinates_require_xy() {
        let mut params = ClickParams {
            x: Some(7),
            relative: Some(true),
            ..Default::default()
        };

        let error =
            apply_window_relative_click_coordinates(&mut params, (100, 200, 800, 600)).unwrap_err();

        assert!(error.contains("both x and y"));
        assert_eq!((params.x, params.y), (Some(7), None));
    }

    #[test]
    fn relative_click_coordinates_must_stay_inside_bounds() {
        for (x, y) in [(-1, 9), (7, -1), (800, 9), (7, 600)] {
            let mut params = ClickParams {
                x: Some(x),
                y: Some(y),
                relative: Some(true),
                ..Default::default()
            };

            let error = apply_window_relative_click_coordinates(&mut params, (100, 200, 800, 600))
                .unwrap_err();

            assert!(error.contains("inside target-window bounds"));
            assert_eq!((params.x, params.y), (Some(x), Some(y)));
        }
    }

    #[test]
    fn absolute_pointer_note_reports_the_emitted_coordinate() {
        assert_eq!(
            abs_pointer_clamp_note(crate::abs_pointer::PointerLanding {
                requested: (1920, 1080),
                emitted: (1919, 1079),
            }),
            Some(
                "Requested coordinate 1920,1080 was clamped to 1919,1079 by the uinput absolute pointer."
                    .to_string()
            )
        );
        assert_eq!(
            abs_pointer_clamp_note(crate::abs_pointer::PointerLanding {
                requested: (640, 480),
                emitted: (640, 480),
            }),
            None
        );
    }

    #[test]
    fn accessibility_filter_candidates_prefer_title_and_skip_synthetic_app_id() {
        let window = window_info(
            42,
            Some("CU ATSPI GTK Test"),
            Some("window:46"),
            Some("cu_atspi_gtk_test.py"),
            Some(2914326),
        );

        let candidates = accessibility_filter_candidates(Some(&window));

        assert_eq!(
            candidates,
            vec![
                "CU ATSPI GTK Test".to_string(),
                "cu_atspi_gtk_test.py".to_string(),
            ]
        );
    }

    #[test]
    fn accessibility_filter_candidates_include_reverse_dns_leaf() {
        let window = window_info(
            42,
            Some("Untitled — KWrite"),
            Some("org.kde.kwrite"),
            Some("kwrite"),
            None,
        );

        let candidates = accessibility_filter_candidates(Some(&window));

        assert!(candidates.contains(&"kwrite".to_string()));
        assert!(!candidates.contains(&"desktop".to_string()));
    }

    fn accessible_app(object_ref: &str, name: &str) -> AccessibleAppSummary {
        AccessibleAppSummary {
            object_ref: object_ref.to_string(),
            name: Some(name.to_string()),
            pid: None,
            role: "application".to_string(),
            child_count: 1,
            bounds: None,
        }
    }

    #[test]
    fn explicit_app_id_unique_root_uses_current_object_ref() {
        let apps = vec![
            accessible_app(":1.40/org/a11y/atspi/accessible/root", "KWrite"),
            accessible_app(":1.41/org/a11y/atspi/accessible/root", "Kate"),
        ];

        for app_id in ["kwrite", "org.kde.kwrite"] {
            assert_eq!(
                select_accessibility_app_id_filter(Some(&apps), app_id),
                ":1.40/org/a11y/atspi/accessible/root"
            );
        }
    }

    #[test]
    fn explicit_app_id_missing_root_or_list_failure_is_unmatchable() {
        let apps = vec![accessible_app(
            ":1.41/org/a11y/atspi/accessible/root",
            "Kate",
        )];

        assert_eq!(
            select_accessibility_app_id_filter(Some(&apps), "kwrite"),
            UNMATCHABLE_ACCESSIBILITY_APP_FILTER
        );
        assert_eq!(
            select_accessibility_app_id_filter(None, "kwrite"),
            UNMATCHABLE_ACCESSIBILITY_APP_FILTER
        );
        for app_id in ["window:46", ".desktop"] {
            assert_eq!(
                select_accessibility_app_id_filter(Some(&apps), app_id),
                UNMATCHABLE_ACCESSIBILITY_APP_FILTER
            );
        }
    }

    #[test]
    fn explicit_app_id_ambiguous_leaf_is_unmatchable() {
        let apps = vec![
            accessible_app(":1.40/org/a11y/atspi/accessible/root", "KWrite"),
            accessible_app(":1.42/org/a11y/atspi/accessible/root", "com.example.kwrite"),
        ];

        assert_eq!(
            select_accessibility_app_id_filter(Some(&apps), "kwrite"),
            UNMATCHABLE_ACCESSIBILITY_APP_FILTER
        );
    }

    #[test]
    fn explicit_full_app_id_cannot_prove_ambiguous_root_namespaces() {
        let apps = vec![
            accessible_app(":1.40/org/a11y/atspi/accessible/root", "KWrite"),
            accessible_app(":1.42/org/a11y/atspi/accessible/root", "kwrite"),
        ];

        assert_eq!(
            select_accessibility_app_id_filter(Some(&apps), "org.kde.kwrite"),
            UNMATCHABLE_ACCESSIBILITY_APP_FILTER
        );
    }

    #[tokio::test]
    async fn app_id_authoritative_window_rejection_cannot_use_accessibility_fallback() {
        let backend = ComputerUseLinux::default();
        let windows = vec![
            window_info(1, Some("KWrite"), Some("org.kde.kwrite"), None, None),
            window_info(2, Some("Other"), Some("com.example.kwrite"), None, None),
        ];
        for app_id in ["kwrite", "org.missing.kwrite"] {
            let params: GetAppStateParams =
                serde_json::from_value(serde_json::json!({ "app_id": app_id })).unwrap();
            let target = params.window_target();
            assert!(resolve_window_target(&windows, &target).is_err());
            let filter = backend
                .resolve_accessibility_app_filter_with(&params, None, true, || async {
                    Ok(vec![accessible_app(":1.40/root", "KWrite")])
                })
                .await;
            assert_eq!(
                filter.as_deref(),
                Some(UNMATCHABLE_ACCESSIBILITY_APP_FILTER),
                "{app_id}"
            );
        }
    }

    #[tokio::test]
    async fn app_id_unavailable_window_backend_preserves_exact_accessibility_fallback() {
        let backend = ComputerUseLinux::default();
        for app_id in ["KWRITE", "org.kde.kwrite"] {
            let params: GetAppStateParams =
                serde_json::from_value(serde_json::json!({ "app_id": app_id })).unwrap();
            let filter = backend
                .resolve_accessibility_app_filter_with(&params, None, false, || async {
                    Ok(vec![accessible_app(":1.40/root", "KWrite")])
                })
                .await;
            assert_eq!(filter.as_deref(), Some(":1.40/root"));
        }
    }

    #[tokio::test]
    async fn app_id_conflicting_resolved_window_cannot_use_pid_or_explicit_name() {
        let backend = ComputerUseLinux::default();
        let window = window_info(1, Some("Kate"), Some("org.kde.kate"), None, Some(123));
        for explicit_name in [None, Some("Kate")] {
            let params: GetAppStateParams = serde_json::from_value(serde_json::json!({
                "window_id": 1,
                "app_id": "org.kde.kwrite",
                "app_name_or_bundle_identifier": explicit_name,
            }))
            .unwrap();
            assert!(
                resolve_window_target(std::slice::from_ref(&window), &params.window_target())
                    .is_ok()
            );
            let filter = backend
                .resolve_accessibility_app_filter_with(&params, Some(&window), true, || async {
                    let mut app = accessible_app(":1.41/root", "Kate");
                    app.pid = Some(123);
                    Ok(vec![app])
                })
                .await;
            assert_eq!(
                filter.as_deref(),
                Some(UNMATCHABLE_ACCESSIBILITY_APP_FILTER)
            );
        }
    }

    #[test]
    fn app_id_accessibility_fallback_rejects_arbitrary_name_substrings() {
        let apps = vec![accessible_app(":1.40/root", "KWrite")];
        assert_eq!(
            select_accessibility_app_id_filter(Some(&apps), "write"),
            UNMATCHABLE_ACCESSIBILITY_APP_FILTER
        );
    }

    #[test]
    fn app_id_rejection_cannot_regain_a_pid_only_snapshot() {
        assert_eq!(
            accessibility_snapshot_target_pid(
                Some(UNMATCHABLE_ACCESSIBILITY_APP_FILTER),
                Some(123)
            ),
            None
        );
        assert_eq!(
            accessibility_snapshot_target_pid(Some(":1.40/root"), Some(123)),
            Some(123)
        );
        assert_eq!(
            accessibility_snapshot_target_pid(None, Some(123)),
            Some(123)
        );
    }

    #[test]
    fn select_accessibility_object_ref_prefers_exact_pid_match() {
        let apps = vec![
            AccessibleAppSummary {
                object_ref: ":1.31/org/a11y/atspi/accessible/root".to_string(),
                name: Some("electron".to_string()),
                pid: Some(2774076),
                role: "application".to_string(),
                child_count: 1,
                bounds: None,
            },
            AccessibleAppSummary {
                object_ref: ":1.64/org/a11y/atspi/accessible/root".to_string(),
                name: Some("cu_atspi_gtk_test.py".to_string()),
                pid: Some(2914326),
                role: "application".to_string(),
                child_count: 1,
                bounds: None,
            },
        ];

        let object_ref = select_accessibility_object_ref(
            &apps,
            2914326,
            &[
                "CU ATSPI GTK Test".to_string(),
                "cu_atspi_gtk_test.py".to_string(),
            ],
        )
        .unwrap();

        assert_eq!(object_ref, ":1.64/org/a11y/atspi/accessible/root");
    }

    #[test]
    fn compact_accessibility_tree_reparents_actionable_descendants() {
        let nodes = vec![
            AccessibilityNode {
                index: 0,
                parent_index: None,
                depth: 0,
                object_ref: ":1.0/root".to_string(),
                role: "application".to_string(),
                name: Some("demo-app".to_string()),
                description: None,
                child_count: 1,
                bounds: None,
                states: Vec::new(),
                actions: Vec::new(),
                value: None,
                text: None,
                supports_editable_text: false,
            },
            AccessibilityNode {
                index: 1,
                parent_index: Some(0),
                depth: 1,
                object_ref: ":1.1/frame".to_string(),
                role: "frame".to_string(),
                name: Some("Demo Frame".to_string()),
                description: None,
                child_count: 1,
                bounds: None,
                states: Vec::new(),
                actions: Vec::new(),
                value: None,
                text: None,
                supports_editable_text: false,
            },
            AccessibilityNode {
                index: 2,
                parent_index: Some(1),
                depth: 2,
                object_ref: ":1.2/filler".to_string(),
                role: "filler".to_string(),
                name: None,
                description: None,
                child_count: 1,
                bounds: None,
                states: Vec::new(),
                actions: Vec::new(),
                value: None,
                text: None,
                supports_editable_text: false,
            },
            AccessibilityNode {
                index: 3,
                parent_index: Some(2),
                depth: 3,
                object_ref: ":1.3/button".to_string(),
                role: "button".to_string(),
                name: Some("Run".to_string()),
                description: None,
                child_count: 0,
                bounds: Some(Bounds {
                    x: 10,
                    y: 20,
                    width: 100,
                    height: 40,
                }),
                states: Vec::new(),
                actions: vec![AccessibilityAction {
                    index: 0,
                    name: "Click".to_string(),
                    description: "Clicks the button".to_string(),
                    keybinding: String::new(),
                }],
                value: None,
                text: None,
                supports_editable_text: false,
            },
        ];

        let compacted = compact_accessibility_tree(nodes);

        assert_eq!(compacted.len(), 3);
        assert_eq!(compacted[0].role, "application");
        assert_eq!(compacted[1].role, "frame");
        assert_eq!(compacted[2].role, "button");
        assert_eq!(compacted[2].parent_index, Some(1));
        assert_eq!(compacted[1].child_count, 1);
    }

    #[test]
    fn compact_accessibility_tree_drops_structural_noise() {
        let nodes = vec![
            AccessibilityNode {
                index: 0,
                parent_index: None,
                depth: 0,
                object_ref: ":1.0/root".to_string(),
                role: "application".to_string(),
                name: Some("demo-app".to_string()),
                description: None,
                child_count: 2,
                bounds: None,
                states: Vec::new(),
                actions: Vec::new(),
                value: None,
                text: None,
                supports_editable_text: false,
            },
            AccessibilityNode {
                index: 1,
                parent_index: Some(0),
                depth: 1,
                object_ref: ":1.1/frame".to_string(),
                role: "frame".to_string(),
                name: Some("Demo Frame".to_string()),
                description: None,
                child_count: 2,
                bounds: None,
                states: Vec::new(),
                actions: Vec::new(),
                value: None,
                text: None,
                supports_editable_text: false,
            },
            AccessibilityNode {
                index: 2,
                parent_index: Some(1),
                depth: 2,
                object_ref: ":1.2/tab".to_string(),
                role: "page tab".to_string(),
                name: Some("Hidden".to_string()),
                description: None,
                child_count: 0,
                bounds: None,
                states: Vec::new(),
                actions: Vec::new(),
                value: None,
                text: None,
                supports_editable_text: false,
            },
            AccessibilityNode {
                index: 3,
                parent_index: Some(1),
                depth: 2,
                object_ref: ":1.3/separator".to_string(),
                role: "separator".to_string(),
                name: None,
                description: None,
                child_count: 0,
                bounds: None,
                states: Vec::new(),
                actions: Vec::new(),
                value: None,
                text: None,
                supports_editable_text: false,
            },
        ];

        let compacted = compact_accessibility_tree(nodes);

        assert_eq!(compacted.len(), 3);
        assert_eq!(compacted[2].role, "page tab");
        assert_eq!(compacted[2].name.as_deref(), Some("Hidden"));
    }

    #[test]
    fn kde_clipboard_restore_delay_uses_minimum_for_short_text() {
        assert_eq!(
            kde_clipboard_restore_delay("short"),
            Duration::from_millis(KDE_CLIPBOARD_RESTORE_MIN_DELAY_MS)
        );
    }

    #[test]
    fn kde_clipboard_restore_delay_scales_and_caps_long_text() {
        let scaled_text = "x".repeat(1_000);
        assert_eq!(
            kde_clipboard_restore_delay(&scaled_text),
            Duration::from_millis(4_000)
        );

        let capped_text = "x".repeat(10_000);
        assert_eq!(
            kde_clipboard_restore_delay(&capped_text),
            Duration::from_millis(KDE_CLIPBOARD_RESTORE_MAX_DELAY_MS)
        );
    }

    #[test]
    fn ambiguous_kde_clipboard_set_never_allows_input_replay() {
        let error = KdeClipboardPasteError::ambiguous_clipboard_set("timed out".to_string());

        assert!(!error.can_fallback_to_ydotool);
        assert!(!error.clear_portal_keyboard_session);
    }

    #[test]
    fn kde_clipboard_maps_each_paste_shortcut_to_its_chord() {
        assert_eq!(
            kde_clipboard_paste_chord(KdeClipboardPasteShortcut::Standard),
            (&[EVDEV_KEY_LEFTCTRL][..], EVDEV_KEY_V)
        );
        assert_eq!(
            kde_clipboard_paste_chord(KdeClipboardPasteShortcut::CtrlShiftV),
            (&[EVDEV_KEY_LEFTCTRL, EVDEV_KEY_LEFTSHIFT][..], EVDEV_KEY_V)
        );
        assert_eq!(
            kde_clipboard_paste_chord(KdeClipboardPasteShortcut::ShiftInsert),
            (&[EVDEV_KEY_LEFTSHIFT][..], EVDEV_KEY_INSERT)
        );
    }

    fn focused(role: &str, is_terminal: bool) -> FocusedElementSummary {
        FocusedElementSummary {
            role: role.to_string(),
            name: None,
            editable: false,
            states: vec!["focused".to_string()],
            is_terminal,
        }
    }

    #[test]
    fn kde_clipboard_focus_fallback_uses_the_role_enum_not_the_name() {
        let ctrl_shift_v = Some(TerminalPasteShortcut::CtrlShiftV);
        let shift_insert = Some(TerminalPasteShortcut::ShiftInsert);

        // No AT-SPI answer (xterm exposes none) keeps the terminal chord.
        assert_eq!(
            kde_clipboard_shortcut_for_focus(shift_insert, None),
            KdeClipboardPasteShortcut::ShiftInsert
        );
        // A terminal widget keeps it, whatever its localized role name.
        assert_eq!(
            kde_clipboard_shortcut_for_focus(ctrl_shift_v, Some(&focused("терминал", true))),
            KdeClipboardPasteShortcut::CtrlShiftV
        );
        // A focused search field inside the terminal window pastes with Ctrl+V.
        assert_eq!(
            kde_clipboard_shortcut_for_focus(ctrl_shift_v, Some(&focused("text", false))),
            KdeClipboardPasteShortcut::Standard
        );
        assert_eq!(
            kde_clipboard_shortcut_for_focus(None, None),
            KdeClipboardPasteShortcut::Standard
        );
    }

    #[test]
    fn kde_terminal_keeps_chord_for_non_text_focus() {
        let ctrl_shift_v = Some(TerminalPasteShortcut::CtrlShiftV);
        let shift_insert = Some(TerminalPasteShortcut::ShiftInsert);
        assert_eq!(
            kde_clipboard_shortcut_for_focus(ctrl_shift_v, Some(&focused("filler", false))),
            KdeClipboardPasteShortcut::CtrlShiftV
        );
        assert_eq!(
            kde_clipboard_shortcut_for_focus(ctrl_shift_v, Some(&focused("panel", false))),
            KdeClipboardPasteShortcut::CtrlShiftV
        );
        assert_eq!(
            kde_clipboard_shortcut_for_focus(shift_insert, Some(&focused("filler", false))),
            KdeClipboardPasteShortcut::ShiftInsert
        );
        assert_eq!(
            kde_clipboard_shortcut_for_focus(ctrl_shift_v, Some(&focused("text", false))),
            KdeClipboardPasteShortcut::Standard
        );
        let editable_filler = FocusedElementSummary {
            editable: true,
            ..focused("filler", false)
        };
        assert_eq!(
            kde_clipboard_shortcut_for_focus(ctrl_shift_v, Some(&editable_filler)),
            KdeClipboardPasteShortcut::Standard
        );
    }

    #[test]
    fn kde_clipboard_routes_xterm_family_to_shift_insert() {
        for wm_class in ["xterm", "UXTerm", "urxvt", "rxvt-unicode", "koi8rxterm"] {
            let window = window_info(1, Some("user@host"), None, Some(wm_class), Some(100));
            assert_eq!(
                kde_clipboard_terminal_shortcut(&WindowTarget::default(), Some(&window)),
                Some(TerminalPasteShortcut::ShiftInsert),
                "{wm_class} should paste with Shift+Insert"
            );
        }
    }

    #[test]
    fn kde_clipboard_routes_explicit_tty_targets_to_terminal_paste() {
        let target = WindowTarget {
            tty: Some("/dev/pts/11".to_string()),
            ..Default::default()
        };

        assert_eq!(
            kde_clipboard_terminal_shortcut(&target, None),
            Some(TerminalPasteShortcut::CtrlShiftV)
        );
    }

    #[test]
    fn kde_clipboard_prefers_resolved_window_over_stale_terminal_selector() {
        let target = WindowTarget {
            tty: Some("/dev/pts/11".to_string()),
            ..Default::default()
        };
        let window = window_info(
            1,
            Some("Browser"),
            Some("firefox"),
            Some("firefox"),
            Some(100),
        );

        assert_eq!(
            kde_clipboard_terminal_shortcut(&target, Some(&window)),
            None
        );
    }

    #[tokio::test]
    async fn kde_clipboard_async_routing_prefers_focus_over_stale_terminal_selector() {
        let target = WindowTarget {
            tty: Some("/dev/pts/11".to_string()),
            ..Default::default()
        };
        let window = window_info(
            1,
            Some("Browser"),
            Some("firefox"),
            Some("firefox"),
            Some(100),
        );
        let focus = WindowFocusResult {
            requested_window: window.clone(),
            focused_window: Some(window),
            exact_window_focused: true,
            app_focused: true,
            backend: KWIN_BACKEND.to_string(),
            note: "test".to_string(),
        };

        assert_eq!(
            kde_clipboard_paste_shortcut(&target, Some(&focus)).await,
            KdeClipboardPasteShortcut::Standard
        );
    }

    #[test]
    fn kde_clipboard_routes_konsole_identity_to_terminal_paste() {
        let window = window_info(
            1,
            Some("unflappable-donkey"),
            Some("org.kde.konsole"),
            Some("konsole"),
            Some(100),
        );

        assert_eq!(
            kde_clipboard_terminal_shortcut(&WindowTarget::default(), Some(&window)),
            Some(TerminalPasteShortcut::CtrlShiftV)
        );
    }

    #[test]
    fn kde_clipboard_does_not_classify_terminal_words_in_browser_titles() {
        let window = window_info(
            1,
            Some("xterm documentation"),
            Some("firefox"),
            Some("firefox"),
            Some(100),
        );

        assert_eq!(
            kde_clipboard_terminal_shortcut(&WindowTarget::default(), Some(&window)),
            None
        );
    }

    #[test]
    fn kde_clipboard_pty_metadata_does_not_change_editor_paste() {
        let mut window = window_info(
            1,
            Some("xterm integration test"),
            Some("example-ide"),
            Some("ExampleIde"),
            Some(100),
        );
        window.terminal = Some(crate::terminal::TerminalWindowContext {
            tty: "/dev/pts/11".to_string(),
            root_process: crate::terminal::TerminalProcess {
                pid: 200,
                command_name: "bash".to_string(),
                command_line: "bash".to_string(),
                cwd: None,
            },
            active_process: None,
            process_count: 1,
            confidence: "high".to_string(),
            match_reason: "one child PTY".to_string(),
        });
        let terminal = kde_clipboard_terminal_shortcut(&WindowTarget::default(), Some(&window));
        assert_eq!(terminal, None);
        assert_eq!(
            kde_clipboard_shortcut_for_focus(terminal, None),
            KdeClipboardPasteShortcut::Standard
        );
    }

    #[tokio::test]
    async fn kde_clipboard_dbus_operation_times_out_when_pending() {
        let error = kde_clipboard_dbus_operation_with_timeout(
            "proxy creation",
            std::future::pending::<zbus::Result<()>>(),
            Duration::from_millis(1),
        )
        .await
        .unwrap_err();

        assert_eq!(error, "KDE clipboard proxy creation timed out");
    }

    #[test]
    fn cached_element_index_resolves_to_bounds_center() {
        let backend = ComputerUseLinux::default();
        backend.cache_nodes(&[node(
            7,
            Some(Bounds {
                x: 10,
                y: 20,
                width: 100,
                height: 40,
            }),
        )]);

        let point = backend
            .resolve_optional_target_point(None, None, Some(7))
            .unwrap()
            .unwrap();

        assert_eq!(point, (60, 40));
    }

    #[test]
    fn coordinate_target_overrides_cached_element_index() {
        let backend = ComputerUseLinux::default();
        backend.cache_nodes(&[node(
            7,
            Some(Bounds {
                x: 10,
                y: 20,
                width: 100,
                height: 40,
            }),
        )]);

        let point = backend
            .resolve_optional_target_point(Some(200), Some(300), Some(7))
            .unwrap()
            .unwrap();

        assert_eq!(point, (200, 300));
    }

    #[test]
    fn cached_element_index_requires_positive_bounds() {
        let backend = ComputerUseLinux::default();
        backend.cache_nodes(&[node(
            7,
            Some(Bounds {
                x: 10,
                y: 20,
                width: 0,
                height: 40,
            }),
        )]);

        let error = backend
            .resolve_optional_target_point(None, None, Some(7))
            .unwrap_err();

        assert!(error.contains("No clickable bounds cached for element_index 7"));
    }

    #[test]
    fn cached_element_index_ignores_sentinel_bounds() {
        let backend = ComputerUseLinux::default();
        backend.cache_nodes(&[node(
            7,
            Some(Bounds {
                x: i32::MIN,
                y: i32::MIN,
                width: 1,
                height: 1,
            }),
        )]);

        let error = backend
            .resolve_optional_target_point(None, None, Some(7))
            .unwrap_err();

        assert!(error.contains("No clickable bounds cached for element_index 7"));
    }

    #[test]
    fn empty_node_cache_clears_stale_element_index() {
        let backend = ComputerUseLinux::default();
        backend.cache_nodes(&[node(
            7,
            Some(Bounds {
                x: 10,
                y: 20,
                width: 100,
                height: 40,
            }),
        )]);
        backend.cache_nodes(&[]);

        let error = backend
            .resolve_optional_target_point(None, None, Some(7))
            .unwrap_err();

        assert!(error.contains("No clickable bounds cached for element_index 7"));
    }

    #[test]
    fn click_target_falls_back_to_primary_action_without_bounds() {
        let backend = ComputerUseLinux::default();
        backend.cache_nodes(&[node_with_actions(
            7,
            None,
            vec![AccessibilityAction {
                index: 0,
                name: "Click".to_string(),
                description: "Clicks the button".to_string(),
                keybinding: String::new(),
            }],
        )]);

        let target = backend
            .resolve_click_target(&ClickParams {
                element_index: Some(7),
                ..Default::default()
            })
            .unwrap();

        match target {
            ClickTarget::PrimaryAction {
                object_ref,
                action_name,
                action_index,
            } => {
                assert_eq!(object_ref, ":1.7/org/a11y/atspi/accessible/7");
                assert_eq!(action_name.as_deref(), Some("Click"));
                assert_eq!(action_index, 0);
            }
            ClickTarget::Coordinates(_, _)
            | ClickTarget::ElementBounds { .. }
            | ClickTarget::ElementPoint { .. } => {
                panic!("expected AT-SPI primary-action fallback")
            }
        }
    }

    #[test]
    fn element_activation_ignores_hidpi_and_zero_origin_bounds() {
        for (x, y) in [(75, 144), (0, 0)] {
            let backend = ComputerUseLinux::default();
            backend.cache_nodes(&[node_with_actions(
                7,
                Some(Bounds {
                    x,
                    y,
                    width: 320,
                    height: 120,
                }),
                vec![AccessibilityAction {
                    index: 0,
                    name: "click".into(),
                    description: String::new(),
                    keybinding: String::new(),
                }],
            )]);
            assert!(matches!(
                backend
                    .resolve_click_target(&ClickParams {
                        element_index: Some(7),
                        ..Default::default()
                    })
                    .unwrap(),
                ClickTarget::PrimaryAction {
                    action_index: 0,
                    ..
                }
            ));
            // Explicit coordinates and gestures retain pointer semantics.
            for params in [
                ClickParams {
                    x: Some(470),
                    y: Some(408),
                    element_index: Some(7),
                    ..Default::default()
                },
                ClickParams {
                    button: Some("right".into()),
                    element_index: Some(7),
                    ..Default::default()
                },
                ClickParams {
                    click_count: Some(2),
                    element_index: Some(7),
                    ..Default::default()
                },
            ] {
                let explicit = params.x.is_some();
                match backend.resolve_click_target(&params).unwrap() {
                    ClickTarget::Coordinates(470, 408) if explicit => {}
                    ClickTarget::ElementBounds { center, .. } if !explicit => {
                        assert_eq!(center, (x + 160, y + 60));
                    }
                    _ => panic!("unexpected click target"),
                }
            }
        }
    }

    #[test]
    fn element_click_does_not_replace_pointer_with_non_activation_action() {
        let backend = ComputerUseLinux::default();
        backend.cache_nodes(&[node_with_actions(
            7,
            Some(Bounds {
                x: 10,
                y: 20,
                width: 20,
                height: 20,
            }),
            vec![AccessibilityAction {
                index: 0,
                name: "show-menu".into(),
                description: String::new(),
                keybinding: String::new(),
            }],
        )]);
        assert!(matches!(
            backend
                .resolve_click_target(&ClickParams {
                    element_index: Some(7),
                    ..Default::default()
                })
                .unwrap(),
            ClickTarget::ElementBounds {
                center: (20, 30),
                ..
            }
        ));
    }

    fn kwin_cached_element_nodes() -> Vec<AccessibilityNode> {
        let mut app = node(0, None);
        app.role = "application".to_string();
        let mut frame = node(
            1,
            Some(Bounds {
                x: 0,
                y: 0,
                width: 800,
                height: 600,
            }),
        );
        frame.parent_index = Some(0);
        frame.depth = 1;
        frame.role = "frame".to_string();
        let mut menu = node(
            2,
            Some(Bounds {
                x: 0,
                y: 0,
                width: 64,
                height: 33,
            }),
        );
        menu.parent_index = Some(1);
        menu.depth = 2;
        menu.role = "menu".to_string();
        vec![app, frame, menu]
    }

    fn kwin_window(window_id: u64) -> WindowInfo {
        let mut window = window_info(
            window_id,
            Some("Editor"),
            Some("editor"),
            Some("editor"),
            Some(4242),
        );
        window.backend = KWIN_BACKEND.to_string();
        window
    }

    #[test]
    fn kwin_cached_dialog_and_alert_ancestors_keep_window_identity() {
        for role in ["frame", "window", "dialog", "alert"] {
            let backend = ComputerUseLinux::default();
            let mut nodes = kwin_cached_element_nodes();
            nodes[1].role = role.to_string();
            backend.cache_snapshot_with_window(&nodes, Some(4242), None, Some(&kwin_window(42)));
            let target = backend
                .cached_kwin_element_target(&nodes[2], (32, 16), false, None)
                .unwrap_or_else(|error| panic!("{role}: {error}"));
            assert_eq!(target.window_id, Some(42));
            assert_eq!(target.pid, Some(4242));
            assert_eq!((target.frame.width, target.frame.height), (800, 600));
        }
        let mut nodes = kwin_cached_element_nodes();
        nodes[1].role = "panel".to_string();
        assert!(depth_one_kwin_element_frame(&nodes, &nodes[2], (32, 16), false).is_err());
    }

    #[test]
    fn kwin_cached_element_requires_depth_one_frame_and_exact_window_identity() {
        let backend = ComputerUseLinux::default();
        let nodes = kwin_cached_element_nodes();
        backend.cache_snapshot_with_window(&nodes, Some(4242), None, Some(&kwin_window(42)));

        let target = backend
            .cached_kwin_element_target(&nodes[2], (32, 16), false, None)
            .unwrap();
        assert_eq!(target.window_id, Some(42));
        assert_eq!(target.pid, Some(4242));
        assert_eq!((target.frame.x, target.frame.y), (0, 0));
        assert_eq!((target.frame.width, target.frame.height), (800, 600));

        let global = backend
            .cached_kwin_element_target(&nodes[2], (1148, 487), true, None)
            .unwrap();
        assert!(global.global_point);
        assert_eq!(global.center, (1148, 487));

        let missing = node(7, nodes[2].bounds.clone());
        let error = depth_one_kwin_element_frame(&nodes, &missing, (32, 16), false).unwrap_err();
        assert!(error.contains("depth-1"), "{error}");
        let error = depth_one_kwin_element_frame(&nodes, &nodes[2], (900, 16), false).unwrap_err();
        assert!(error.contains("outside"), "{error}");

        let requested = kwin_window(42);
        let focused = kwin_window(43);
        let app_only_focus = WindowFocusResult {
            requested_window: requested,
            focused_window: Some(focused),
            exact_window_focused: false,
            app_focused: true,
            backend: KWIN_BACKEND.to_string(),
            note: String::new(),
        };
        let error = backend
            .cached_kwin_element_target(&nodes[2], (32, 16), false, Some(&app_only_focus))
            .unwrap_err();
        assert!(error.contains("not app-only focus"), "{error}");
    }

    #[test]
    fn kwin_adapter_bypasses_explicit_relative_native_and_non_kwin_paths() {
        assert!(!kwin_element_adapter_required(
            false,
            true,
            Some(KWIN_BACKEND),
            None
        ));
        assert!(!kwin_element_adapter_required(
            true,
            false,
            Some(GNOME_SHELL_EXTENSION_BACKEND),
            None
        ));
        assert!(!kwin_element_adapter_required(
            true,
            true,
            Some(KWIN_BACKEND),
            Some(GNOME_SHELL_EXTENSION_BACKEND)
        ));
        assert!(kwin_element_adapter_required(
            true,
            false,
            Some(KWIN_BACKEND),
            None
        ));
        assert!(kwin_element_adapter_required(true, true, None, None));

        let backend = ComputerUseLinux::default();
        let mut nodes = kwin_cached_element_nodes();
        nodes[2].actions = vec![click_action()];
        backend.cache_snapshot_with_window(&nodes, Some(4242), None, Some(&kwin_window(42)));
        assert!(matches!(
            backend.resolve_click_target(&ClickParams {
                element_index: Some(2),
                ..Default::default()
            }),
            Ok(ClickTarget::PrimaryAction { .. })
        ));
        assert!(matches!(
            backend.resolve_click_target(&ClickParams {
                element_index: Some(2),
                x: Some(470),
                y: Some(408),
                ..Default::default()
            }),
            Ok(ClickTarget::Coordinates(470, 408))
        ));

        let mut relative = ClickParams {
            element_index: Some(2),
            x: Some(7),
            y: Some(9),
            relative: Some(true),
            window_id: Some(42),
            ..Default::default()
        };
        apply_window_relative_click_coordinates(&mut relative, (133, 267, 1067, 800)).unwrap();
        assert!(matches!(
            backend.resolve_click_target(&relative),
            Ok(ClickTarget::Coordinates(140, 276))
        ));
    }

    #[test]
    fn atspi_coordinate_target_uses_cached_element_and_supplied_point() {
        let backend = ComputerUseLinux::default();
        let mut target = node_with_actions(
            7,
            Some(Bounds {
                x: 0,
                y: 0,
                width: 64,
                height: 33,
            }),
            vec![click_action()],
        );
        target.role = "menu item".to_string();
        target.name = Some("Görünüm".to_string());
        backend.cache_nodes(&[target]);

        for params in [
            ClickParams {
                element_index: Some(7),
                x: Some(32),
                y: Some(16),
                coordinate_space: ClickCoordinateSpace::Atspi,
                ..Default::default()
            },
            ClickParams {
                role: Some("menu item".to_string()),
                name: Some("Görünüm".to_string()),
                x: Some(32),
                y: Some(16),
                coordinate_space: ClickCoordinateSpace::Atspi,
                ..Default::default()
            },
        ] {
            match backend.resolve_click_target(&params).unwrap() {
                ClickTarget::ElementPoint { node, point } => {
                    assert_eq!(node.index, 7);
                    assert_eq!(point, (32, 16));
                }
                _ => panic!("explicit AT-SPI coordinates must retain pointer semantics"),
            }
        }
    }

    #[tokio::test]
    async fn explicit_atspi_coordinates_reject_non_kwin_backend_before_target_resolution() {
        for name in ["gnome", "niri", "x11"] {
            let backend = ComputerUseLinux::default();
            backend.last_snapshot.lock().unwrap().window_backend = Some(name.to_string());
            let output = backend
                .dispatch_click(ClickParams {
                    element_index: Some(7),
                    x: Some(32),
                    y: Some(16),
                    coordinate_space: ClickCoordinateSpace::Atspi,
                    ..Default::default()
                })
                .await
                .0;
            assert!(!output.ok);
            assert!(
                output.message.contains("require a KWin Wayland"),
                "{name}: {}",
                output.message
            );
        }
    }

    #[test]
    fn atspi_coordinate_params_require_unambiguous_geometry() {
        let valid = ClickParams {
            element_index: Some(7),
            x: Some(32),
            y: Some(16),
            coordinate_space: ClickCoordinateSpace::Atspi,
            ..Default::default()
        };
        assert_eq!(validate_click_coordinate_space(&valid), Ok(()));

        let relative = ClickParams {
            relative: Some(true),
            ..valid.clone()
        };
        assert!(validate_click_coordinate_space(&relative)
            .unwrap_err()
            .contains("cannot use relative"));

        let missing_y = ClickParams {
            y: None,
            ..valid.clone()
        };
        assert!(validate_click_coordinate_space(&missing_y)
            .unwrap_err()
            .contains("both x and y"));

        let missing_element = ClickParams {
            element_index: None,
            ..valid
        };
        assert!(validate_click_coordinate_space(&missing_element)
            .unwrap_err()
            .contains("require element_index or a semantic selector"));

        let raw_capture = ClickParams {
            x: Some(1148),
            y: Some(487),
            ..Default::default()
        };
        assert_eq!(validate_click_coordinate_space(&raw_capture), Ok(()));
    }

    #[test]
    fn kwin_prepared_click_routes_capture_to_uinput_and_logical_to_portal() {
        let prepared = PreparedKwinElementClick {
            element_index: 2,
            point: KwinElementClickPoint {
                logical: (278, 352),
                capture: (417, 528),
            },
            capture_size: (3840, 2160),
        };
        assert_eq!(prepared.uinput_point(), (417, 528));
        assert_eq!(prepared.portal_point(), (278, 352));

        let output = kwin_element_click_dispatch_output(
            ActionOutput {
                ok: true,
                implemented: true,
                action: "click".to_string(),
                message: String::new(),
                received: None,
            },
            Some(prepared),
            "the test pointer",
        );
        assert!(output.ok);
        assert!(output.message.contains("capture 417,528"));
        assert!(output.message.contains("portal logical 278,352"));
        assert!(output.message.contains("Dispatch only"));
        assert!(output.message.contains("UI activation was not verified"));
    }

    #[test]
    fn kwin_adapter_failures_are_not_sent_and_include_recovery_guidance() {
        let backend = ComputerUseLinux::default();
        backend.cache_snapshot_with_window(
            &kwin_cached_element_nodes(),
            Some(4242),
            None,
            Some(&kwin_window(42)),
        );
        let output = backend
            .kwin_element_click_failure(2, "stale absolute-pointer geometry", None)
            .0;
        assert!(!output.ok);
        assert!(output.message.contains("click was not sent"));
        assert!(output.message.contains("No pointer event was emitted"));
        assert!(output.message.contains("window_id 42"));
        assert!(output.message.contains("screenshot x/y"));
    }

    #[tokio::test]
    async fn kwin_stale_pointer_recreation_failure_is_fail_closed() {
        let backend = ComputerUseLinux::default();
        let error = backend
            .create_abs_pointer_for_kwin_capture_with(2560, 1440, true, |_, _| {
                anyhow::bail!("uinput unavailable")
            })
            .await
            .unwrap_err();

        assert!(error.contains("geometry was stale"), "{error}");
        assert!(error.contains("could not be recreated"), "{error}");
        assert!(backend.abs_pointer.lock().unwrap().is_none());
    }

    #[test]
    fn entry_submit_and_slider_jump_are_not_pointer_clicks() {
        for (role, action_name) in [
            ("entry", "activate"),
            ("spin button", "activate"),
            ("slider", "jump"),
        ] {
            let backend = ComputerUseLinux::default();
            let mut target = node_with_actions(
                7,
                Some(Bounds {
                    x: 10,
                    y: 20,
                    width: 100,
                    height: 40,
                }),
                vec![AccessibilityAction {
                    index: 0,
                    name: action_name.into(),
                    description: String::new(),
                    keybinding: String::new(),
                }],
            );
            target.role = role.into();
            backend.cache_nodes(&[target]);
            assert!(matches!(
                backend
                    .resolve_click_target(&ClickParams {
                        element_index: Some(7),
                        ..Default::default()
                    })
                    .unwrap(),
                ClickTarget::ElementBounds {
                    center: (60, 40),
                    ..
                }
            ));
            let mut node = backend.last_snapshot.lock().unwrap().nodes[0].clone();
            for bounds in [
                None,
                Some(Bounds {
                    x: i32::MIN,
                    y: i32::MIN,
                    width: 1,
                    height: 1,
                }),
                Some(Bounds {
                    x: 0,
                    y: 0,
                    width: 0,
                    height: 0,
                }),
            ] {
                node.bounds = bounds;
                backend.cache_nodes(&[node.clone()]);
                assert!(backend
                    .resolve_click_target(&ClickParams {
                        element_index: Some(7),
                        ..Default::default()
                    })
                    .is_err());
            }
        }
    }

    #[test]
    fn click_target_falls_back_to_primary_action_with_sentinel_bounds() {
        let backend = ComputerUseLinux::default();
        backend.cache_nodes(&[node_with_actions(
            7,
            Some(Bounds {
                x: i32::MIN,
                y: i32::MIN,
                width: 1,
                height: 1,
            }),
            vec![AccessibilityAction {
                index: 0,
                name: "Click".to_string(),
                description: "Clicks the button".to_string(),
                keybinding: String::new(),
            }],
        )]);

        let target = backend
            .resolve_click_target(&ClickParams {
                element_index: Some(7),
                ..Default::default()
            })
            .unwrap();

        match target {
            ClickTarget::PrimaryAction {
                object_ref,
                action_name,
                action_index,
            } => {
                assert_eq!(object_ref, ":1.7/org/a11y/atspi/accessible/7");
                assert_eq!(action_name.as_deref(), Some("Click"));
                assert_eq!(action_index, 0);
            }
            ClickTarget::Coordinates(_, _)
            | ClickTarget::ElementBounds { .. }
            | ClickTarget::ElementPoint { .. } => {
                panic!("expected AT-SPI primary-action fallback")
            }
        }
    }

    #[test]
    fn click_target_requires_bounds_for_non_plain_clicks() {
        let backend = ComputerUseLinux::default();
        backend.cache_nodes(&[node_with_actions(
            7,
            None,
            vec![AccessibilityAction {
                index: 0,
                name: "Click".to_string(),
                description: "Clicks the button".to_string(),
                keybinding: String::new(),
            }],
        )]);

        let error = backend
            .resolve_click_target(&ClickParams {
                element_index: Some(7),
                button: Some("right".to_string()),
                ..Default::default()
            })
            .unwrap_err();

        assert!(error.contains("No clickable bounds cached for element_index 7"));
    }

    #[test]
    fn absolute_mousemove_uses_coordinate_separator() {
        assert_eq!(
            absolute_mousemove_args(200, 300),
            vec![
                "mousemove".to_string(),
                "--absolute".to_string(),
                "--".to_string(),
                "200".to_string(),
                "300".to_string(),
            ]
        );
    }

    #[test]
    fn xdotool_pointer_command_is_single_no_sync_move_and_click() {
        assert_eq!(
            xdotool_pointer_click_args(1550, 930, 3, Some("right")),
            Some(vec![
                "mousemove".to_string(),
                "--".to_string(),
                "1550".to_string(),
                "930".to_string(),
                "click".to_string(),
                "--repeat".to_string(),
                "3".to_string(),
                "3".to_string(),
            ])
        );
    }

    #[test]
    fn xdotool_pointer_policy_requires_a_native_display_without_global_override() {
        assert!(prefer_xdotool_pointer(false, Some("x11"), true, None));
        assert!(!prefer_xdotool_pointer(true, Some("x11"), true, None));
        assert!(!prefer_xdotool_pointer(false, Some("wayland"), true, None));
        assert!(!prefer_xdotool_pointer(false, Some("x11"), false, None));
        assert!(!prefer_xdotool_pointer(
            false,
            Some("x11"),
            true,
            Some("wayland-0")
        ));
    }

    #[test]
    fn xdotool_pointer_supports_only_standard_buttons() {
        assert!(xdotool_pointer_click_args(10, 20, 1, None).is_some());
        assert!(xdotool_pointer_click_args(10, 20, 1, Some("middle")).is_some());
        assert!(xdotool_pointer_click_args(10, 20, 1, Some("right")).is_some());
    }

    #[test]
    fn extended_pointer_buttons_do_not_construct_xdotool_commands() {
        for button in ["side", "extra", "forward", "back"] {
            assert_eq!(xdotool_pointer_click_args(10, 20, 1, Some(button)), None);
        }
    }

    #[test]
    fn xdotool_scroll_uses_wheel_buttons_instead_of_a_valuator_event() {
        assert_eq!(
            xdotool_pointer_scroll_args(Some((1550, 930)), 5, ScrollDirection::Up),
            vec![
                "mousemove".to_string(),
                "--".to_string(),
                "1550".to_string(),
                "930".to_string(),
                "click".to_string(),
                "--delay".to_string(),
                "12".to_string(),
                "--repeat".to_string(),
                "5".to_string(),
                "4".to_string(),
            ]
        );
        assert_eq!(
            xdotool_pointer_scroll_args(Some((-20, 15)), 1, ScrollDirection::Down),
            vec![
                "mousemove".to_string(),
                "--".to_string(),
                "-20".to_string(),
                "15".to_string(),
                "click".to_string(),
                "--delay".to_string(),
                "12".to_string(),
                "--repeat".to_string(),
                "1".to_string(),
                "5".to_string(),
            ]
        );
        assert_eq!(
            xdotool_pointer_scroll_args(None, 3, ScrollDirection::Left),
            vec![
                "click".to_string(),
                "--delay".to_string(),
                "12".to_string(),
                "--repeat".to_string(),
                "3".to_string(),
                "6".to_string(),
            ]
        );
        assert_eq!(
            xdotool_pointer_scroll_args(None, 0, ScrollDirection::Right),
            vec![
                "click".to_string(),
                "--delay".to_string(),
                "12".to_string(),
                "--repeat".to_string(),
                "1".to_string(),
                "7".to_string(),
            ]
        );
    }

    #[test]
    fn scroll_pages_are_bounded_before_unit_conversion() {
        assert_eq!(scroll_units(None).unwrap(), 5);
        assert_eq!(scroll_units(Some(1.0)).unwrap(), 5);
        assert_eq!(scroll_units(Some(-1.0)).unwrap(), 5);
        assert_eq!(scroll_units(Some(0.0)).unwrap(), 1);
        assert_eq!(scroll_units(Some(0.1)).unwrap(), 1);
        assert_eq!(scroll_units(Some(100.0)).unwrap(), 500);
        assert_eq!(scroll_units(Some(-100.0)).unwrap(), 500);

        for pages in [
            100.000_001,
            -100.000_001,
            f64::NAN,
            f64::INFINITY,
            f64::NEG_INFINITY,
        ] {
            assert!(scroll_units(Some(pages)).is_err(), "accepted {pages}");
        }
    }

    #[test]
    fn maximum_scroll_timeout_is_bounded() {
        let repeat = u32::try_from(scroll_units(Some(MAX_SCROLL_PAGES)).unwrap()).unwrap();

        assert_eq!(repeat, 500);
        assert_eq!(
            xdotool_scroll_timeout(repeat, XDOTOOL_SCROLL_CLICK_DELAY_MS),
            Duration::from_secs(16)
        );
    }

    #[test]
    fn xdotool_scroll_timeout_covers_the_gap_after_every_click() {
        assert_eq!(
            xdotool_scroll_timeout(1, 12),
            INPUT_COMMAND_TIMEOUT + Duration::from_millis(12)
        );
        assert_eq!(
            xdotool_scroll_timeout(5, 100),
            INPUT_COMMAND_TIMEOUT + Duration::from_millis(500)
        );
        assert_eq!(
            xdotool_scroll_timeout(0, 12),
            INPUT_COMMAND_TIMEOUT + Duration::from_millis(12)
        );
    }

    #[test]
    fn wheel_mousemove_uses_coordinate_separator_for_negative_values() {
        assert_eq!(
            wheel_mousemove_args(0, -3),
            vec![
                "mousemove".to_string(),
                "--wheel".to_string(),
                "--".to_string(),
                "0".to_string(),
                "-3".to_string(),
            ]
        );
    }

    #[test]
    fn pointer_actions_keep_pixel_coordinates_for_ydotool_absolute_moves() {
        assert_eq!(
            absolute_mousemove_args(1550, 930),
            vec![
                "mousemove".to_string(),
                "--absolute".to_string(),
                "--".to_string(),
                "1550".to_string(),
                "930".to_string(),
            ]
        );
    }

    #[test]
    fn legacy_ydotool_socket_does_not_suppress_portal_fallback() {
        let legacy_ydotool_available = ydotool_backend_available_from(true, false);
        let current_ydotool_available = ydotool_backend_available_from(true, true);

        assert!(should_prefer_portal_backend_by_default(
            true,
            legacy_ydotool_available
        ));
        assert!(!should_prefer_portal_backend_by_default(
            true,
            current_ydotool_available
        ));
        assert!(!should_prefer_portal_backend_by_default(
            false,
            legacy_ydotool_available
        ));
    }

    #[test]
    fn key_chord_splits_modifiers_and_key() {
        assert_eq!(key_chord("Ctrl+Shift+P"), Some((vec![29, 42], 25)));
        assert_eq!(key_chord("Ctrl+S"), Some((vec![29], 31)));
        assert_eq!(key_chord("Enter"), Some((vec![], 28)));
        assert_eq!(key_chord("Super"), Some((vec![], 125)));
        assert_eq!(key_chord("NotAKey"), None);
    }

    #[test]
    fn portal_key_chord_sends_modifiers_and_named_keys_as_keysyms() {
        use PortalKey::{Keycode, Keysym};
        // Modifiers resolve through the live keymap (#191); letters stay
        // physical so non-Latin layout groups still see Ctrl+A.
        assert_eq!(
            portal_key_chord("Ctrl+A"),
            Some((vec![Keysym(xkey::Control_L as i32)], Keycode(30)))
        );
        assert_eq!(
            portal_key_chord("ctrl+shift+t"),
            Some((
                vec![Keysym(xkey::Control_L as i32), Keysym(xkey::Shift_L as i32)],
                Keycode(20)
            ))
        );
        assert_eq!(
            portal_key_chord("Alt+F4"),
            Some((vec![Keysym(xkey::Alt_L as i32)], Keysym(xkey::F4 as i32)))
        );
        assert_eq!(
            portal_key_chord("Meta+Return"),
            Some((
                vec![Keysym(xkey::Super_L as i32)],
                Keysym(xkey::Return as i32)
            ))
        );
        assert_eq!(
            portal_key_chord("Super"),
            Some((vec![], Keysym(xkey::Super_L as i32)))
        );
        assert_eq!(
            portal_key_chord("page-down"),
            Some((vec![], Keysym(xkey::Page_Down as i32)))
        );
        assert_eq!(
            portal_key_chord("Ctrl+1"),
            Some((vec![Keysym(xkey::Control_L as i32)], Keycode(2)))
        );
        assert_eq!(portal_key_chord("Ctrl+NotAKey"), None);
        assert_eq!(portal_key_chord("Hyper+A"), None);
    }

    #[test]
    fn portal_key_chord_accepts_exactly_the_evdev_grammar() {
        for key in [
            "enter",
            "Escape",
            "tab",
            "backspace",
            "del",
            "space",
            "home",
            "end",
            "pageup",
            "left",
            "right",
            "up",
            "down",
            "f1",
            "f12",
            "a",
            "z",
            "0",
            "9",
            "ctrl",
            "alt",
            "shift",
            "cmd",
            "Ctrl+Alt+Delete",
            "Shift+Tab",
            "ctrl+shift",
            "?",
            "F13",
            "Ctrl+",
            "",
        ] {
            assert_eq!(
                portal_key_chord(key).is_some(),
                key_chord(key).is_some(),
                "{key}"
            );
        }
    }

    #[test]
    fn key_sequence_presses_modifiers_around_key() {
        assert_eq!(
            key_sequence("Ctrl+Shift+P"),
            Some(vec![
                "29:1".to_string(),
                "42:1".to_string(),
                "25:1".to_string(),
                "25:0".to_string(),
                "42:0".to_string(),
                "29:0".to_string(),
            ])
        );
    }

    #[test]
    fn ydotool_modifier_chords_include_an_inter_event_delay() {
        let args = ydotool_key_args(key_sequence("Ctrl+T").unwrap(), true);

        assert_eq!(args, ["key", "-d", "100", "29:1", "20:1", "20:0", "29:0"]);
    }

    #[test]
    fn key_sequence_presses_bare_modifier() {
        assert_eq!(
            key_sequence("Super"),
            Some(vec!["125:1".to_string(), "125:0".to_string()])
        );
    }

    #[test]
    fn xdotool_key_spec_maps_named_keys_to_x11_keysyms() {
        assert_eq!(xdotool_key_spec("Return"), Some("Return".to_string()));
        assert_eq!(xdotool_key_spec("enter"), Some("Return".to_string()));
        assert_eq!(xdotool_key_spec("Escape"), Some("Escape".to_string()));
        assert_eq!(xdotool_key_spec("backspace"), Some("BackSpace".to_string()));
        assert_eq!(xdotool_key_spec("PageUp"), Some("Page_Up".to_string()));
        assert_eq!(xdotool_key_spec("ArrowLeft"), Some("Left".to_string()));
        assert_eq!(xdotool_key_spec("f5"), Some("F5".to_string()));
        assert_eq!(xdotool_key_spec("space"), Some("space".to_string()));
    }

    #[test]
    fn xdotool_key_spec_maps_chords_with_modifier_prefixes() {
        assert_eq!(xdotool_key_spec("ctrl+a"), Some("ctrl+a".to_string()));
        assert_eq!(xdotool_key_spec("Ctrl+S"), Some("ctrl+s".to_string()));
        assert_eq!(
            xdotool_key_spec("Ctrl+Shift+P"),
            Some("ctrl+shift+p".to_string())
        );
        assert_eq!(
            xdotool_key_spec("Meta+Return"),
            Some("super+Return".to_string())
        );
        assert_eq!(xdotool_key_spec("Alt+F4"), Some("alt+F4".to_string()));
    }

    #[test]
    fn xdotool_key_spec_maps_bare_modifier_to_single_keysym() {
        assert_eq!(xdotool_key_spec("Super"), Some("super".to_string()));
        assert_eq!(xdotool_key_spec("ctrl"), Some("ctrl".to_string()));
    }

    #[test]
    fn xdotool_type_keeps_a_per_character_delay_so_xtest_events_stay_ordered() {
        const { assert!(XDOTOOL_TYPE_DELAY_MS > 0) };
        let text = "x".repeat(10_000);
        let args = xdotool_type_args_with_delay(&text, XDOTOOL_TYPE_DELAY_MS);

        assert_eq!(
            &args[..5],
            ["type", "--clearmodifiers", "--delay", "12", "--"]
        );
        assert_eq!(args[3], XDOTOOL_TYPE_DELAY_MS.to_string());
        assert_eq!(args[5], text);
    }

    #[test]
    fn xdotool_type_uses_return_for_lf_and_crlf() {
        let args = xdotool_type_args_with_delay("L1\nL2\r\nL3\r", 12);
        assert_eq!(args[5], "L1\rL2\rL3\r");
        assert_eq!(
            xdotool_type_args_with_delay("quotes '\" and literal \\n: שלום", 12)[5],
            "quotes '\" and literal \\n: שלום"
        );
    }

    #[test]
    fn xdotool_type_timeout_grows_with_text_length() {
        assert_eq!(xdotool_type_timeout("", 12), INPUT_COMMAND_TIMEOUT);
        assert_eq!(
            xdotool_type_timeout(&"x".repeat(1_000), 12),
            INPUT_COMMAND_TIMEOUT + Duration::from_secs(12)
        );
        assert_eq!(
            xdotool_type_timeout(&"x".repeat(1_000), 0),
            INPUT_COMMAND_TIMEOUT
        );
    }

    #[test]
    fn xdotool_delay_prefers_codex_env_and_accepts_standalone_alias() {
        assert_eq!(xdotool_type_delay_ms_value(Some("7"), Some("9")), 7);
        assert_eq!(xdotool_type_delay_ms_value(None, Some("9")), 9);
        assert_eq!(xdotool_type_delay_ms_value(Some("bad"), Some("9")), 12);
        assert_eq!(xdotool_type_delay_ms_value(None, None), 12);
    }

    #[test]
    fn wayland_prefers_wtype_unless_ydotool_is_forced() {
        assert!(prefer_wtype_keyboard(false, false, false, true, true, true));
        assert!(!prefer_wtype_keyboard(true, false, false, true, true, true));
        assert!(!prefer_wtype_keyboard(false, true, false, true, true, true));
        assert!(!prefer_wtype_keyboard(false, false, true, true, true, true));
        assert!(!prefer_wtype_keyboard(
            false, false, false, false, true, true
        ));
        assert!(!prefer_wtype_keyboard(
            false, false, false, true, false, true
        ));
        assert!(!prefer_wtype_keyboard(
            false, false, false, true, true, false
        ));
    }

    #[tokio::test]
    async fn wtype_passes_long_unicode_as_one_literal_argument() {
        let dir = std::env::temp_dir().join(format!(
            "codex-computer-use-linux-wtype-unicode-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
        ));
        std::fs::create_dir_all(&dir).expect("create command test directory");
        let wtype = dir.join("wtype");
        let wtype_source = dir.join("wtype.source");
        let captured = dir.join("captured");
        std::fs::write(
            &wtype_source,
            format!(
                "#!/bin/sh\n[ \"$#\" -eq 2 ] && [ \"$1\" = -- ] || exit 42\nprintf '%s' \"$2\" > '{}'\n",
                captured.display()
            ),
        )
        .expect("write fake wtype");
        std::fs::set_permissions(&wtype_source, std::fs::Permissions::from_mode(0o700))
            .expect("make fake wtype executable");
        std::fs::rename(&wtype_source, &wtype).expect("publish fake wtype atomically");
        let text =
            "--Türkçe PostgreSQL (W, g, m, v, f, ş, ü) / 0123456789 - ; 'İstanbul'\n".repeat(50);

        let result = run_wtype_type_text_or_fallback(
            &wtype,
            &text,
            WtypeTextMode::Argument,
            false,
            || async { panic!("available wtype must not fall back") },
        )
        .await
        .expect("wtype should succeed");

        assert_eq!(result.backend, KeyboardCommandBackend::Wtype);
        assert_eq!(std::fs::read_to_string(&captured).unwrap(), text);
        for text in ["--", "-", ""] {
            run_wtype_type_text_or_fallback(
                &wtype,
                text,
                WtypeTextMode::Argument,
                false,
                || async { panic!("available wtype must not fall back") },
            )
            .await
            .unwrap();
            assert_eq!(std::fs::read_to_string(&captured).unwrap(), text);
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn review_argument_mode_never_starts_wtype_for_protected_text() {
        // Even /bin/false and the fallback must never run. An exit-status
        // error would prove that validation happened too late.
        let error = run_wtype_type_text_or_fallback(
            Path::new("/bin/false"),
            "synthetic-password",
            WtypeTextMode::Argument,
            true,
            || async { panic!("secret input must not fall back") },
        )
        .await
        .err()
        .expect("secret text must be rejected");
        assert!(error.contains("password fields"), "{error}");
        let error = run_wtype_type_text_or_fallback(
            Path::new("/definitely/missing/wtype"),
            "synthetic-password",
            WtypeTextMode::Argument,
            true,
            || async { panic!("secret input must not fall back even if wtype disappears") },
        )
        .await
        .err()
        .expect("secret text must be rejected");
        assert!(error.contains("password fields"), "{error}");
    }

    #[tokio::test]
    async fn review_slow_focus_probe_has_its_own_input_budget() {
        let mode = hyprland_wtype_delivery("long text".repeat(100).as_str(), async {
            tokio::time::sleep(Duration::from_millis(300)).await;
            Some(FocusProbe::Found(FocusedElementSummary {
                role: "entry".to_string(),
                name: None,
                editable: false,
                states: vec!["focused".to_string(), "editable".to_string()],
                is_terminal: false,
            }))
        })
        .await
        .unwrap();
        assert_eq!(
            mode,
            WtypeTextMode::Argument,
            "the indicator's 250 ms budget must not gate text dispatch"
        );
    }

    #[tokio::test]
    async fn review_inaccessible_fields_keep_short_text_on_private_stdin() {
        let text = "ş".repeat(WTYPE_STDIN_MAX_CHARS);
        for probe in [
            None,
            Some(FocusProbe::NoAccessibleApp),
            Some(FocusProbe::Incomplete),
            Some(FocusProbe::NoneFocused),
            Some(FocusProbe::ShellOnly),
        ] {
            let mode = hyprland_wtype_delivery(&text, async { probe })
                .await
                .unwrap();
            assert_eq!(mode, WtypeTextMode::Stdin);
            // cat accepts only '-' here; an argv text argument would instead
            // be opened as a filename and fail. No desktop input is generated.
            let result = run_wtype_type_text_or_fallback(
                Path::new("/bin/cat"),
                &text,
                mode,
                true,
                || async { panic!("available stdin helper must not fall back") },
            )
            .await
            .unwrap();
            assert_eq!(result.output.stdout, text.as_bytes());
        }
    }

    #[tokio::test]
    async fn review_ambiguous_focused_roles_use_stdin_instead_of_password_rejection() {
        let short = "ş".repeat(WTYPE_STDIN_MAX_CHARS);
        let long = "ş".repeat(WTYPE_STDIN_MAX_CHARS + 1);
        for (role, terminal) in [
            ("terminal", true),
            ("Terminal", true),
            ("entry", true),
            ("Entry", false),
            ("Text", false),
            ("text box", false),
            ("TextBox", false),
            ("textbox", false),
            ("Unknown", false),
            ("invalid", false),
            ("", false),
        ] {
            // Editable state/interface must not make an ambiguous role public.
            for editable in [false, true] {
                let element = FocusedElementSummary {
                    role: role.to_string(),
                    name: None,
                    editable,
                    states: vec!["focused".to_string(), "editable".to_string()],
                    is_terminal: terminal,
                };
                let mode = hyprland_wtype_delivery(&short, async {
                    Some(FocusProbe::Found(element.clone()))
                })
                .await;
                assert!(
                    matches!(mode, Ok(WtypeTextMode::Stdin)),
                    "{role:?}, editable={editable}: {mode:?}"
                );
                let delivered = run_wtype_type_text_or_fallback(
                    Path::new("/bin/cat"),
                    &short,
                    mode.unwrap(),
                    true,
                    || async { panic!("stdin helper must not fall back") },
                )
                .await
                .unwrap();
                assert_eq!(delivered.output.stdout, short.as_bytes());
                let error =
                    hyprland_wtype_delivery(&long, async { Some(FocusProbe::Found(element)) })
                        .await
                        .unwrap_err();
                assert!(
                    error.contains("100 Unicode characters"),
                    "{role:?}: {error}"
                );
                assert!(!error.contains("password fields"), "{role:?}: {error}");
            }
        }
    }

    #[tokio::test]
    async fn only_confirmed_password_roles_are_hard_rejected() {
        for role in [
            "password text",
            "PasswordText",
            "PASSWORD TEXT",
            "password entry",
        ] {
            let error = hyprland_wtype_delivery("short", async {
                Some(FocusProbe::Found(FocusedElementSummary {
                    role: role.to_string(),
                    name: None,
                    editable: true,
                    states: vec!["focused".to_string(), "editable".to_string()],
                    is_terminal: false,
                }))
            })
            .await
            .unwrap_err();
            assert!(error.contains("password fields"), "{role}: {error}");
        }
        for role in ["entry", "text"] {
            let mode = hyprland_wtype_delivery(&"x".repeat(3000), async {
                Some(FocusProbe::Found(FocusedElementSummary {
                    role: role.to_string(),
                    name: None,
                    editable: false,
                    states: vec!["focused".to_string(), "editable".to_string()],
                    is_terminal: false,
                }))
            })
            .await
            .unwrap();
            assert_eq!(mode, WtypeTextMode::Argument, "{role}");
        }
    }

    #[tokio::test]
    async fn unknown_stdin_limit_and_password_rejection_remain_explicit() {
        let error = hyprland_wtype_delivery(&"ş".repeat(WTYPE_STDIN_MAX_CHARS + 1), async {
            Some(FocusProbe::NoAccessibleApp)
        })
        .await
        .unwrap_err();
        assert!(error.contains("100 Unicode characters"), "{error}");
        let error = hyprland_wtype_delivery("short", async {
            Some(FocusProbe::Found(FocusedElementSummary {
                role: "password text".to_string(),
                name: None,
                editable: true,
                states: vec!["focused".to_string(), "editable".to_string()],
                is_terminal: false,
            }))
        })
        .await
        .unwrap_err();
        assert!(error.contains("password fields"), "{error}");
        let mode = hyprland_wtype_delivery("short", std::future::pending())
            .await
            .unwrap();
        assert_eq!(
            mode,
            WtypeTextMode::Stdin,
            "timeout must not reject all input"
        );
    }

    #[test]
    fn electron_editable_state_does_not_require_the_editable_text_interface() {
        let mut element = FocusedElementSummary {
            role: "entry".to_string(),
            name: None,
            editable: false,
            states: vec!["focused".to_string(), "editable".to_string()],
            is_terminal: false,
        };
        assert!(!focus_requires_secret_protection(&FocusProbe::Found(
            element.clone()
        )));
        assert!(!describe_focused_element(&element, true).starts_with("WARNING:"));
        element.role = "password text".to_string();
        assert!(focus_requires_secret_protection(&FocusProbe::Found(
            element.clone()
        )));
        element.role = "frame".to_string();
        element.states.clear();
        assert!(focus_requires_secret_protection(&FocusProbe::Found(
            element
        )));
        for probe in [
            FocusProbe::ShellOnly,
            FocusProbe::NoneFocused,
            FocusProbe::Incomplete,
            FocusProbe::NoAccessibleApp,
        ] {
            assert!(focus_requires_secret_protection(&probe));
        }
    }

    #[tokio::test]
    async fn other_compositors_keep_wtype_text_on_stdin() {
        for desktop in [None, Some("sway"), Some("wlroots"), Some("river")] {
            let mode = wtype_text_mode_for_desktop(desktop);
            assert_eq!(mode, WtypeTextMode::Stdin);
            let text = "synthetic secret: şü / -- -";
            let result = run_wtype_type_text_or_fallback(
                Path::new("/bin/cat"),
                text,
                mode,
                true,
                || async { panic!("available stdin helper must not fall back") },
            )
            .await
            .unwrap();
            assert_eq!(result.output.stdout, text.as_bytes());
        }
        assert_eq!(
            wtype_text_mode_for_desktop(Some("Hyprland")),
            WtypeTextMode::Argument
        );
    }

    #[test]
    fn review_invalid_text_is_rejected_before_window_targeting() {
        let dir = std::env::temp_dir().join(format!("cul-text-preflight-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let helper = dir.join("wtype");
        std::fs::write(&helper, "#!/bin/sh\nexit 99\n").unwrap();
        std::fs::set_permissions(&helper, std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "server::tests::invalid_text_preflight_child",
                "--ignored",
                "--nocapture",
            ])
            .env("CUL_PREFLIGHT_CHILD", "1")
            .env("PATH", &dir)
            .env("XDG_SESSION_TYPE", "wayland")
            .env("XDG_CURRENT_DESKTOP", "Hyprland")
            // Set all related environment variables to prevent inherited values.
            .env("DESKTOP_SESSION", "hyprland")
            .env("XDG_SESSION_DESKTOP", "Hyprland")
            .env_remove("DISPLAY");
        for key in [
            "COMPUTER_USE_LINUX_FORCE_YDOTOOL_KEYBOARD",
            "COMPUTER_USE_LINUX_FORCE_XDOTOOL_KEYBOARD",
            "COMPUTER_USE_LINUX_FORCE_PORTAL_KEYBOARD",
        ] {
            command.env_remove(key);
        }
        let result = crate::command_runner::output_blocking_with_timeout(
            &mut command,
            "text preflight child",
            Duration::from_secs(10),
        )
        .unwrap();
        let _ = std::fs::remove_dir_all(dir);
        assert!(
            result.status.success(),
            "{}{}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
    }

    #[tokio::test]
    #[ignore = "isolated environment subprocess; invoked by review_invalid_text_is_rejected_before_window_targeting"]
    async fn invalid_text_preflight_child() {
        assert_eq!(env::var("CUL_PREFLIGHT_CHILD").as_deref(), Ok("1"));
        let server = ComputerUseLinux::default();
        assert_eq!(server.wtype_text_mode(), Some(WtypeTextMode::Argument));
        for text in [
            "prefix\0suffix".to_string(),
            "ş".repeat(WTYPE_MAX_TEXT_BYTES / 2 + 1),
        ] {
            let params: TypeTextParams =
                serde_json::from_value(serde_json::json!({"text": text, "window_id": u64::MAX}))
                    .unwrap();
            let result = server.type_text(Parameters(params)).await.unwrap();
            let structured = result
                .structured_content
                .expect("structured type_text output");
            assert_eq!(structured["ok"], serde_json::json!(false));
            let message = structured["message"].as_str().unwrap();
            assert!(
                message.contains("Literal text was not sent: wtype"),
                "{message}"
            );
        }
    }

    #[tokio::test]
    async fn unavailable_wtype_uses_ydotool_fallback() {
        let result = run_wtype_type_text_or_fallback(
            Path::new("/definitely/missing/wtype"),
            "text",
            WtypeTextMode::Argument,
            false,
            || async {
                TokioCommand::new("sh")
                    .args(["-c", "exit 0"])
                    .output()
                    .await
                    .map_err(|error| error.to_string())
            },
        )
        .await
        .expect("missing wtype should use fallback");

        assert_eq!(result.backend, KeyboardCommandBackend::Ydotool);
    }

    #[test]
    fn wtype_text_validation_counts_bytes_and_rejects_nul() {
        assert!(validate_wtype_text(&"x".repeat(WTYPE_MAX_TEXT_BYTES)).is_ok());
        assert!(validate_wtype_text(&"x".repeat(WTYPE_MAX_TEXT_BYTES + 1))
            .unwrap_err()
            .contains("not sent"));
        // The argument limit counts UTF-8 bytes, not Unicode scalar values.
        assert!(validate_wtype_text(&"ş".repeat(WTYPE_MAX_TEXT_BYTES / 2 + 1)).is_err());
        assert!(validate_wtype_text("valid prefix\0suffix")
            .unwrap_err()
            .contains("not sent"));
        assert!(validate_wtype_text("").is_ok());
    }

    #[tokio::test]
    async fn non_executable_wtype_uses_ydotool_fallback() {
        let dir = std::env::temp_dir().join(format!(
            "codex-computer-use-linux-wtype-nonexec-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
        ));
        std::fs::create_dir_all(&dir).expect("create command test directory");
        let wtype = dir.join("wtype");
        std::fs::write(&wtype, "#!/bin/sh\nexit 0\n").expect("write fake wtype");

        let result = run_wtype_type_text_or_fallback(
            &wtype,
            "text",
            WtypeTextMode::Argument,
            false,
            || async {
                TokioCommand::new("true")
                    .output()
                    .await
                    .map_err(|error| error.to_string())
            },
        )
        .await
        .expect("non-executable wtype should use fallback");

        assert_eq!(result.backend, KeyboardCommandBackend::Ydotool);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn missing_wtype_interpreter_uses_ydotool_fallback() {
        let dir = std::env::temp_dir().join(format!(
            "codex-computer-use-linux-wtype-interpreter-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
        ));
        std::fs::create_dir_all(&dir).expect("create command test directory");
        let wtype = dir.join("wtype");
        std::fs::write(&wtype, "#!/definitely/missing/interpreter\n").expect("write fake wtype");
        std::fs::set_permissions(&wtype, std::fs::Permissions::from_mode(0o700))
            .expect("make fake wtype executable");

        let result = run_wtype_type_text_or_fallback(
            &wtype,
            "text",
            WtypeTextMode::Argument,
            false,
            || async {
                TokioCommand::new("true")
                    .output()
                    .await
                    .map_err(|error| error.to_string())
            },
        )
        .await
        .expect("missing interpreter should use fallback");

        assert_eq!(result.backend, KeyboardCommandBackend::Ydotool);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn launched_wtype_failure_does_not_replay_through_ydotool() {
        let dir = std::env::temp_dir().join(format!(
            "codex-computer-use-linux-wtype-fallback-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
        ));
        std::fs::create_dir_all(&dir).expect("create command test directory");
        let wtype = dir.join("wtype");
        let wtype_source = dir.join("wtype.source");
        let fallback_marker = dir.join("ydotool-ran");
        std::fs::write(&wtype_source, "#!/bin/sh\nexit 9\n").expect("write fake wtype");
        std::fs::set_permissions(&wtype_source, std::fs::Permissions::from_mode(0o700))
            .expect("make fake wtype executable");
        std::fs::rename(&wtype_source, &wtype).expect("publish fake wtype atomically");

        let result = run_wtype_type_text_or_fallback(
            &wtype,
            "text",
            WtypeTextMode::Argument,
            false,
            || async {
                std::fs::write(&fallback_marker, "ran").unwrap();
                TokioCommand::new("true")
                    .output()
                    .await
                    .map_err(|error| error.to_string())
            },
        )
        .await;

        assert!(result.is_err());
        assert!(
            !fallback_marker.exists(),
            "ydotool replayed input after wtype started"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn launched_xdotool_failure_does_not_replay_through_ydotool() {
        let dir = std::env::temp_dir().join(format!(
            "codex-xdotool-fallback-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
        ));
        std::fs::create_dir_all(&dir).expect("create command test directory");
        let ydotool = dir.join("ydotool");
        let xdotool_marker = dir.join("xdotool-ran");
        let ydotool_marker = dir.join("ydotool-ran");
        std::fs::write(
            &ydotool,
            format!("#!/bin/sh\ntouch '{}'\n", ydotool_marker.display()),
        )
        .expect("write fake ydotool");
        std::fs::set_permissions(&ydotool, std::fs::Permissions::from_mode(0o700))
            .expect("make fake ydotool executable");
        let xdotool_args = vec![
            "-c".to_string(),
            format!("touch '{}'; exit 9", xdotool_marker.display()),
        ];

        let result = run_xdotool_or_fallback(Path::new("/bin/sh"), &xdotool_args, || async {
            TokioCommand::new(&ydotool)
                .output()
                .await
                .map_err(|error| error.to_string())
        })
        .await;

        assert!(result.is_err());
        assert!(xdotool_marker.exists(), "fake xdotool did not execute");
        assert!(
            !ydotool_marker.exists(),
            "ydotool replayed input after xdotool started"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn unavailable_xdotool_uses_ydotool_fallback() {
        let result = run_xdotool_or_fallback(
            Path::new("/definitely/missing/xdotool"),
            &xdotool_type_args_with_delay("text", XDOTOOL_TYPE_DELAY_MS),
            || async {
                TokioCommand::new("sh")
                    .args(["-c", "exit 0"])
                    .output()
                    .await
                    .map_err(|error| error.to_string())
            },
        )
        .await
        .expect("spawn failure should use fallback");

        assert_eq!(result.backend, KeyboardCommandBackend::Ydotool);
        assert!(result.output.status.success());
    }

    #[tokio::test]
    async fn pointer_xdotool_spawn_failure_uses_ydotool_fallback() {
        let result = run_xdotool_pointer_or_fallback(
            Path::new("/definitely/missing/xdotool"),
            &[],
            || async { Ok::<_, String>(Vec::new()) },
        )
        .await
        .expect("spawn failure should use fallback");

        assert_eq!(result.backend, KeyboardCommandBackend::Ydotool);
    }

    #[tokio::test]
    async fn pointer_xdotool_nonzero_exit_does_not_use_ydotool_fallback() {
        let result = run_xdotool_pointer_or_fallback(
            Path::new("/bin/sh"),
            &["-c".to_string(), "exit 9".to_string()],
            || async { Err::<Vec<Output>, _>("fallback called".to_string()) },
        )
        .await;

        let error = result.expect_err("launched nonzero xdotool must be terminal");
        assert!(!error.contains("fallback called"));
    }

    #[tokio::test]
    async fn cancelling_xdotool_wait_kills_the_child() {
        let dir = std::env::temp_dir().join(format!(
            "computer-use-linux-xdotool-cancel-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
        ));
        std::fs::create_dir_all(&dir).expect("create command test directory");
        let xdotool = dir.join("xdotool");
        let pid_path = dir.join("pid");
        std::fs::write(
            &xdotool,
            format!(
                "#!/bin/sh\nprintf '%s' $$ > '{}'\nexec sleep 60\n",
                pid_path.display()
            ),
        )
        .expect("write fake xdotool");
        std::fs::set_permissions(&xdotool, std::fs::Permissions::from_mode(0o700))
            .expect("make fake xdotool executable");

        let task = tokio::spawn(async move { run_xdotool(&xdotool, &[]).await });
        let mut pid = None;
        for _ in 0..50 {
            if let Ok(value) = std::fs::read_to_string(&pid_path) {
                pid = value.parse::<u32>().ok();
                if pid.is_some() {
                    break;
                }
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let pid = pid.expect("fake xdotool did not record its pid");
        task.abort();
        let _ = task.await;

        for _ in 0..50 {
            if !Path::new(&format!("/proc/{pid}")).exists() {
                let _ = std::fs::remove_dir_all(dir);
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        unsafe {
            libc::kill(pid as i32, libc::SIGKILL);
        }
        let _ = std::fs::remove_dir_all(dir);
        panic!("cancelled xdotool child {pid} was not killed");
    }

    #[tokio::test]
    async fn cancelling_between_press_and_release_keeps_input_locked() {
        let lock = std::sync::Arc::new(tokio::sync::Mutex::new(()));
        let guard = std::sync::Arc::clone(&lock).lock_owned().await;
        let (pressed_tx, pressed_rx) = tokio::sync::oneshot::channel();
        let (allow_release_tx, allow_release_rx) = tokio::sync::oneshot::channel();
        let (released_tx, released_rx) = tokio::sync::oneshot::channel();

        let waiter = tokio::spawn(async move {
            run_cancellation_safe_input(guard, async move {
                let _ = pressed_tx.send(());
                let _ = allow_release_rx.await;
                let _ = released_tx.send(());
                Ok::<(), String>(())
            })
            .await
        });

        pressed_rx.await.expect("press command did not finish");
        waiter.abort();
        let _ = waiter.await;
        assert!(
            lock.try_lock().is_err(),
            "input lock was released while the paired operation was incomplete"
        );

        allow_release_tx
            .send(())
            .expect("release command stopped on caller cancellation");
        timeout(Duration::from_secs(1), released_rx)
            .await
            .expect("release command did not finish")
            .expect("release command dropped its completion marker");
        timeout(
            Duration::from_secs(1),
            std::sync::Arc::clone(&lock).lock_owned(),
        )
        .await
        .expect("input lock remained held after the operation finished");
    }

    #[tokio::test]
    async fn cancelled_clipboard_restore_keeps_both_operation_locks() {
        let input_lock = std::sync::Arc::new(tokio::sync::Mutex::new(()));
        let clipboard_lock = std::sync::Arc::new(tokio::sync::Mutex::new(()));
        let input_guard = std::sync::Arc::clone(&input_lock).lock_owned().await;
        let clipboard_guard = std::sync::Arc::clone(&clipboard_lock).lock_owned().await;
        let (pasted_tx, pasted_rx) = tokio::sync::oneshot::channel();
        let (allow_restore_tx, allow_restore_rx) = tokio::sync::oneshot::channel();
        let (restored_tx, restored_rx) = tokio::sync::oneshot::channel();

        let waiter = tokio::spawn(async move {
            run_cancellation_safe_guarded((input_guard, clipboard_guard), async move {
                let _ = pasted_tx.send(());
                let _ = allow_restore_rx.await;
                let _ = restored_tx.send(());
            })
            .await
        });

        pasted_rx.await.expect("paste did not finish");
        waiter.abort();
        let _ = waiter.await;
        assert!(input_lock.try_lock().is_err());
        assert!(clipboard_lock.try_lock().is_err());

        allow_restore_tx
            .send(())
            .expect("clipboard restore stopped on caller cancellation");
        timeout(Duration::from_secs(1), restored_rx)
            .await
            .expect("clipboard restore did not finish")
            .expect("clipboard restore dropped its completion marker");
        tokio::task::yield_now().await;
        assert!(input_lock.try_lock().is_ok());
        assert!(clipboard_lock.try_lock().is_ok());
    }

    #[test]
    fn xdotool_key_spec_rejects_everything_key_chord_rejects() {
        for key in ["NotAKey", "", "ctrl+", "ctrl+NotAKey", "f13", "hyper+a"] {
            assert_eq!(
                xdotool_key_spec(key).is_some(),
                key_chord(key).is_some(),
                "backend grammars diverged for {key:?}"
            );
        }
    }

    #[test]
    fn key_sequence_keeps_shortcuts_and_navigation_on_raw_events() {
        assert_eq!(
            key_sequence("Ctrl+L"),
            Some(vec![
                "29:1".to_string(),
                "38:1".to_string(),
                "38:0".to_string(),
                "29:0".to_string(),
            ])
        );
        assert_eq!(
            key_sequence("ArrowLeft"),
            Some(vec!["105:1".to_string(), "105:0".to_string()])
        );
        assert_eq!(
            key_sequence("Escape"),
            Some(vec!["1:1".to_string(), "1:0".to_string()])
        );
        assert_eq!(
            key_sequence("Enter"),
            Some(vec!["28:1".to_string(), "28:0".to_string()])
        );
    }

    #[test]
    fn ydotool_type_timeout_scales_with_text_length() {
        assert_eq!(ydotool_type_timeout("").as_secs(), 10);
        assert_eq!(ydotool_type_timeout("x").as_secs(), 11);
        assert_eq!(ydotool_type_timeout(&"x".repeat(200)).as_secs(), 20);
        assert_eq!(ydotool_type_timeout(&"x".repeat(500)).as_secs(), 35);
    }

    #[tokio::test]
    async fn command_wait_drains_output_before_exit() {
        let mut command = tokio::process::Command::new("sh");
        command.args(["-c", "yes noisy | head -c 200000 >&2; exit 7"]);
        command.stdout(Stdio::piped());
        command.stderr(Stdio::piped());

        let output = crate::command_runner::output_with_timeout(
            command,
            "run test command",
            Duration::from_secs(5),
        )
        .await
        .expect("child should exit before timeout");

        assert_eq!(output.status.code(), Some(7));
        assert!(output.stderr.len() >= 100_000);
    }

    #[test]
    fn perform_action_defaults_to_primary_action_index() {
        assert_eq!(requested_or_primary_action(None), "0");
        assert_eq!(requested_or_primary_action(Some("   ")), "0");
        assert_eq!(
            requested_or_primary_action(Some(" show-menu ")),
            "show-menu"
        );
    }

    #[test]
    fn element_identifier_overrides_cached_object_ref() {
        let backend = ComputerUseLinux::default();
        backend.cache_nodes(&[node(7, None)]);

        let object_ref = backend
            .resolve_object_ref(
                Some(7),
                Some(":1.99/org/a11y/atspi/accessible/3"),
                &ElementSelector::default(),
                ElementResolvePurpose::Action,
            )
            .unwrap();

        assert_eq!(object_ref, ":1.99/org/a11y/atspi/accessible/3");
    }

    #[test]
    fn element_index_resolves_to_cached_object_ref() {
        let backend = ComputerUseLinux::default();
        backend.cache_nodes(&[node(7, None)]);

        let object_ref = backend
            .resolve_object_ref(
                Some(7),
                None,
                &ElementSelector::default(),
                ElementResolvePurpose::Action,
            )
            .unwrap();

        assert_eq!(object_ref, ":1.7/org/a11y/atspi/accessible/7");
    }

    #[test]
    fn semantic_selector_resolves_unique_cached_node_by_role_and_name() {
        let backend = ComputerUseLinux::default();
        let mut search_entry = node(7, None);
        search_entry.role = "entry".to_string();
        search_entry.name = Some("Search files".to_string());
        search_entry.supports_editable_text = true;
        backend.cache_nodes(&[search_entry]);

        let object_ref = backend
            .resolve_object_ref(
                None,
                None,
                &ElementSelector {
                    role: Some("entry"),
                    name: Some("search"),
                    ..Default::default()
                },
                ElementResolvePurpose::SetValue,
            )
            .unwrap();

        assert_eq!(object_ref, ":1.7/org/a11y/atspi/accessible/7");
    }

    #[test]
    fn semantic_selector_prefers_actionable_match() {
        let backend = ComputerUseLinux::default();
        let mut label = node(4, None);
        label.role = "label".to_string();
        label.name = Some("Close".to_string());
        let mut button = node_with_actions(7, None, vec![click_action()]);
        button.role = "push button".to_string();
        button.name = Some("Close".to_string());
        backend.cache_nodes(&[label, button]);

        let object_ref = backend
            .resolve_object_ref(
                None,
                None,
                &ElementSelector {
                    name: Some("close"),
                    ..Default::default()
                },
                ElementResolvePurpose::Action,
            )
            .unwrap();

        assert_eq!(object_ref, ":1.7/org/a11y/atspi/accessible/7");
    }

    #[test]
    fn semantic_selector_prefers_editable_match() {
        let backend = ComputerUseLinux::default();
        let mut label = node(4, None);
        label.role = "label".to_string();
        label.name = Some("Search".to_string());
        let mut entry = node(7, None);
        entry.role = "entry".to_string();
        entry.name = Some("Search".to_string());
        entry.supports_editable_text = true;
        backend.cache_nodes(&[label, entry]);

        let object_ref = backend
            .resolve_object_ref(
                None,
                None,
                &ElementSelector {
                    name: Some("search"),
                    ..Default::default()
                },
                ElementResolvePurpose::SetValue,
            )
            .unwrap();

        assert_eq!(object_ref, ":1.7/org/a11y/atspi/accessible/7");
    }

    #[test]
    fn semantic_selector_reports_ambiguous_matches() {
        let backend = ComputerUseLinux::default();
        let mut first = node_with_actions(7, None, vec![click_action()]);
        first.name = Some("Close".to_string());
        let mut second = node_with_actions(9, None, vec![click_action()]);
        second.name = Some("Close".to_string());
        backend.cache_nodes(&[first, second]);

        let error = backend
            .resolve_object_ref(
                None,
                None,
                &ElementSelector {
                    name: Some("close"),
                    ..Default::default()
                },
                ElementResolvePurpose::Action,
            )
            .unwrap_err();

        assert!(error.contains("matched multiple cached nodes"));
        assert!(error.contains("element_index 7"));
        assert!(error.contains("element_index 9"));
    }

    #[test]
    fn semantic_click_selector_prefers_native_activation() {
        let backend = ComputerUseLinux::default();
        let mut button = node_with_actions(
            7,
            Some(Bounds {
                x: 10,
                y: 20,
                width: 100,
                height: 40,
            }),
            vec![click_action()],
        );
        button.name = Some("Run".to_string());
        backend.cache_nodes(&[button]);

        let target = backend
            .resolve_click_target(&ClickParams {
                role: Some("button".to_string()),
                name: Some("run".to_string()),
                ..Default::default()
            })
            .unwrap();

        assert!(matches!(
            target,
            ClickTarget::PrimaryAction {
                action_index: 0,
                ..
            }
        ));
    }

    #[test]
    fn describe_focused_element_editable() {
        let element = FocusedElementSummary {
            role: "text".to_string(),
            name: Some("Message".to_string()),
            editable: true,
            states: vec!["focused".to_string()],
            is_terminal: false,
        };
        let described = describe_focused_element(&element, true);
        assert!(described.contains("editable"));
        assert!(!described.contains("WARNING"));
    }

    #[test]
    fn describe_focused_terminal_accepts_keyboard_input_without_editable_text() {
        let mut element = focused("terminal", true);
        element.name = Some("Terminal".to_string());
        let text = describe_focused_element(&element, true);
        assert!(!text.contains("WARNING"), "{text}");
        assert!(text.contains("terminal keyboard input"), "{text}");
    }

    #[test]
    fn describe_focused_element_warns_on_non_editable_when_typing() {
        let element = FocusedElementSummary {
            role: "push button".to_string(),
            name: Some("OK".to_string()),
            editable: false,
            states: vec!["focused".to_string()],
            is_terminal: false,
        };
        let described = describe_focused_element(&element, true);
        assert!(described.contains("WARNING"));
        assert!(described.contains("not editable"));
    }

    #[test]
    fn describe_focused_element_no_warning_for_press_key() {
        let element = FocusedElementSummary {
            role: "push button".to_string(),
            name: None,
            editable: false,
            states: vec![],
            is_terminal: false,
        };
        let described = describe_focused_element(&element, false);
        assert!(!described.contains("WARNING"));
    }

    #[test]
    fn relative_scroll_translates_coordinates() {
        let mut params = ScrollParams {
            element_index: None,
            x: Some(10),
            y: Some(20),
            direction: "down".to_string(),
            pages: None,
            window_id: Some(1),
            pid: None,
            app_id: None,
            wm_class: None,
            window_title: None,
            relative: Some(true),
            ..Default::default()
        };
        apply_window_relative_scroll_coordinates(&mut params, (100, 200, 800, 600)).unwrap();
        assert_eq!(params.x, Some(110));
        assert_eq!(params.y, Some(220));
    }

    #[test]
    fn window_targeted_scroll_defaults_to_window_center() {
        let mut params = ScrollParams {
            element_index: None,
            x: None,
            y: None,
            direction: "down".to_string(),
            pages: None,
            window_id: Some(1),
            pid: None,
            app_id: None,
            wm_class: None,
            window_title: None,
            relative: None,
            ..Default::default()
        };
        apply_window_center_scroll_point(&mut params, (100, 200, 800, 600)).unwrap();
        assert_eq!(params.x, Some(500));
        assert_eq!(params.y, Some(500));
    }

    #[test]
    fn window_targeted_scroll_with_empty_capture_rect_errors() {
        let mut params = ScrollParams {
            element_index: None,
            x: None,
            y: None,
            direction: "down".to_string(),
            pages: None,
            window_id: Some(1),
            pid: None,
            app_id: None,
            wm_class: None,
            window_title: None,
            relative: None,
            ..Default::default()
        };
        let error = apply_window_center_scroll_point(&mut params, (0, 0, 0, 0)).unwrap_err();
        assert!(error.contains("pass x/y explicitly"));
        assert_eq!(params.x, None);
        assert_eq!(params.y, None);
    }

    #[test]
    fn relative_scroll_rejects_out_of_bounds() {
        let mut params = ScrollParams {
            element_index: None,
            x: Some(801),
            y: Some(20),
            direction: "down".to_string(),
            pages: None,
            window_id: Some(1),
            pid: None,
            app_id: None,
            wm_class: None,
            window_title: None,
            relative: Some(true),
            ..Default::default()
        };
        assert!(
            apply_window_relative_scroll_coordinates(&mut params, (100, 200, 800, 600)).is_err()
        );
    }

    #[test]
    fn shell_execution_requires_exact_operator_opt_in() {
        assert!(shell_execution_enabled_value(Some("1")));
        for value in [None, Some(""), Some("0"), Some("true"), Some("yes")] {
            assert!(!shell_execution_enabled_value(value));
        }
    }

    #[tokio::test]
    async fn shell_execution_clears_ambient_credentials_and_accepts_explicit_env() {
        let _serial = SHELL_ENV_TEST_LOCK.lock().await;
        let _enabled = EnvVarGuard::set(SHELL_ENABLE_ENV, "1");
        let _credential = EnvVarGuard::set("OPENAI_API_KEY", "test-ambient-credential");
        let output = execute_shell(RunShellParams {
            command: "printf '%s|%s' \"${OPENAI_API_KEY-unset}\" \"$EXPLICIT_VALUE\"".into(),
            cwd: None,
            env: BTreeMap::from([("EXPLICIT_VALUE".into(), "test-explicit-value".into())]),
            timeout_seconds: Some(2),
        })
        .await;
        assert!(output.ok, "{:?}", output.error);
        assert_eq!(output.stdout, "unset|test-explicit-value");
        assert_eq!(output.exit_code, Some(0));
    }

    #[tokio::test]
    async fn shell_execution_disabled_never_runs_requested_command() {
        async fn assert_refused() {
            let output = execute_shell(RunShellParams {
                command: "printf must-not-run".into(),
                cwd: None,
                env: BTreeMap::new(),
                timeout_seconds: None,
            })
            .await;
            assert!(!output.ok);
            assert!(output.stdout.is_empty());
            assert!(output
                .error
                .unwrap()
                .contains("shell execution is disabled"));
        }

        let _serial = SHELL_ENV_TEST_LOCK.lock().await;
        let _alias = EnvVarGuard::unset(SHELL_ENABLE_ENV_STANDALONE);
        {
            let _disabled = EnvVarGuard::set(SHELL_ENABLE_ENV, "0");
            assert_refused().await;
        }
        {
            let _unset = EnvVarGuard::unset(SHELL_ENABLE_ENV);
            assert_refused().await;
        }
    }

    #[tokio::test]
    async fn shell_execution_primary_disable_overrides_standalone_alias() {
        let _serial = SHELL_ENV_TEST_LOCK.lock().await;
        let _disabled = EnvVarGuard::set(SHELL_ENABLE_ENV, "0");
        let _alias = EnvVarGuard::set(SHELL_ENABLE_ENV_STANDALONE, "1");
        let output = execute_shell(RunShellParams {
            command: "printf must-not-run".into(),
            cwd: None,
            env: BTreeMap::new(),
            timeout_seconds: None,
        })
        .await;
        assert!(!output.ok);
        assert!(output.stdout.is_empty());
        assert!(output
            .error
            .unwrap()
            .contains("shell execution is disabled"));
    }

    #[test]
    fn shell_environment_policy_excludes_ambient_credentials() {
        for allowed in [
            "PATH",
            "HOME",
            "LANG",
            "LC_ALL",
            "XDG_RUNTIME_DIR",
            "DISPLAY",
            "WAYLAND_DISPLAY",
            "DBUS_SESSION_BUS_ADDRESS",
        ] {
            assert!(inherited_shell_environment_allowed(allowed));
        }
        for secret in [
            "AWS_SECRET_ACCESS_KEY",
            "GITHUB_TOKEN",
            "OPENAI_API_KEY",
            "SSH_AUTH_SOCK",
            "LD_PRELOAD",
        ] {
            assert!(!inherited_shell_environment_allowed(secret));
        }
    }

    #[test]
    fn shell_environment_skips_non_utf8_entries() {
        use std::os::unix::ffi::OsStringExt;

        let variables = [
            (OsString::from("PATH"), OsString::from("/usr/bin")),
            (OsString::from_vec(vec![0xff]), OsString::from("ignored")),
            (OsString::from("LANG"), OsString::from_vec(vec![0xff])),
            (OsString::from("GITHUB_TOKEN"), OsString::from("secret")),
        ];

        assert_eq!(
            inherited_shell_environment(variables),
            vec![("PATH".to_string(), "/usr/bin".to_string())]
        );
    }

    #[test]
    fn shell_environment_names_follow_exec_rules() {
        for valid in ["A", "_PRIVATE", "NAME_2"] {
            assert!(valid_environment_name(valid));
        }
        for invalid in ["", "2FAST", "BAD-NAME", "A=B", "naïve"] {
            assert!(!valid_environment_name(invalid));
        }
    }

    #[test]
    fn shell_output_is_bounded_before_mcp_serialization() {
        let oversized = vec![b'x'; SHELL_RESPONSE_STREAM_BYTES + 17];
        let (visible, truncated) = bounded_shell_stream(&oversized);
        assert!(truncated);
        assert_eq!(visible.len(), SHELL_RESPONSE_STREAM_BYTES);

        let (visible, truncated) = bounded_shell_stream(b"ok");
        assert!(!truncated);
        assert_eq!(visible, "ok");
    }

    #[test]
    fn shell_audit_digest_is_stable_and_does_not_echo_command_text() {
        let digest = shell_command_sha256("printf secret");
        assert_eq!(digest.len(), 64);
        assert!(digest
            .chars()
            .all(|character| character.is_ascii_hexdigit()));
        assert!(!digest.contains("secret"));
        assert_eq!(digest, shell_command_sha256("printf secret"));
    }
}

#[cfg(test)]
mod accessibility_tree_note_tests {
    use super::{truncated_accessibility_tree_note, unscoped_accessibility_tree_warning};

    #[test]
    fn unscoped_warning_only_when_tree_succeeded_without_a_scope() {
        let warning = unscoped_accessibility_tree_warning(false, true, false).unwrap();
        assert!(warning.starts_with("WARNING:"));
        assert!(warning.contains("no app target scoped"));
        assert!(warning.contains("app_name_or_bundle_identifier"));
        assert!(warning.contains("window_id, pid, app_id, wm_class, title"));

        for target_requested in [false, true] {
            assert!(unscoped_accessibility_tree_warning(true, true, target_requested).is_none());
            assert!(unscoped_accessibility_tree_warning(false, false, target_requested).is_none());
            assert!(unscoped_accessibility_tree_warning(true, false, target_requested).is_none());
        }
    }

    /// A caller that already passed a target must not be told to pass a target;
    /// that advice would replay the same desktop-wide snapshot.
    #[test]
    fn unscoped_warning_with_a_target_points_at_accessibility_support() {
        let warning = unscoped_accessibility_tree_warning(false, true, true).unwrap();
        assert!(warning.starts_with("WARNING:"));
        assert!(warning.contains("matched no AT-SPI application root"));
        assert!(warning.contains("force-renderer-accessibility"));
        assert!(warning.contains("list_apps"));
        assert!(!warning.contains("Pass app_name_or_bundle_identifier or a window target"));
    }

    #[test]
    fn truncated_note_only_when_the_node_cap_was_hit() {
        let note = truncated_accessibility_tree_note(true).unwrap();
        assert!(note.contains("raise max_nodes or max_depth"));
        assert!(
            !note.contains("smaller max_nodes"),
            "shrinking the cap belongs to the unscoped warning, not the truncation note"
        );
        assert!(truncated_accessibility_tree_note(false).is_none());
    }
}

#[cfg(test)]
mod focus_probe_feedback_tests {
    use super::{focus_probe_feedback, FocusProbe, FocusedElementSummary};

    #[test]
    fn only_a_complete_empty_search_warns() {
        let none = focus_probe_feedback(&FocusProbe::NoneFocused, true, false);
        assert!(none.starts_with("WARNING:"), "{none}");

        for probe in [FocusProbe::Incomplete, FocusProbe::NoAccessibleApp] {
            let text = focus_probe_feedback(&probe, true, false);
            assert!(
                !text.contains("WARNING"),
                "{probe:?} must not claim lost input: {text}"
            );
            assert!(text.contains("could not be verified"), "{text}");
        }
        assert!(
            focus_probe_feedback(&FocusProbe::Incomplete, true, false).contains("search limits")
        );
        assert!(
            focus_probe_feedback(&FocusProbe::NoAccessibleApp, true, false)
                .contains("--force-renderer-accessibility")
        );
    }

    #[test]
    fn review_exact_focus_only_softens_shell_only_tree() {
        for expects_editable in [false, true] {
            let text = focus_probe_feedback(&FocusProbe::NoneFocused, expects_editable, true);
            assert!(text.starts_with("WARNING:"), "{text}");
            let text = focus_probe_feedback(&FocusProbe::ShellOnly, expects_editable, false);
            assert!(text.starts_with("WARNING:"), "{text}");
            let text = focus_probe_feedback(&FocusProbe::ShellOnly, expects_editable, true);
            assert!(!text.contains("WARNING"), "{text}");
            assert!(!text.contains("landed nowhere"), "{text}");
            assert!(text.contains("before input"), "{text}");
            assert!(text.contains("Field contents were not verified"), "{text}");
        }
    }

    #[test]
    fn found_element_is_described() {
        let element = FocusedElementSummary {
            role: "text".to_string(),
            name: None,
            editable: true,
            states: vec!["focused".to_string()],
            is_terminal: false,
        };
        let text = focus_probe_feedback(&FocusProbe::Found(element), true, false);
        assert!(text.contains("text"), "{text}");
        assert!(!text.starts_with("WARNING"), "{text}");
    }
}

#[cfg(test)]
mod action_recovery_tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    const OLD_REF: &str = ":1.10/org/a11y/atspi/accessible/7";
    const NEW_REF: &str = ":1.20/org/a11y/atspi/accessible/7";
    const OTHER_REF: &str = ":1.30/org/a11y/atspi/accessible/7";
    const EXPLICIT_REF: &str = ":1.99/org/a11y/atspi/accessible/9";

    fn action_node(index: u32, object_ref: &str) -> AccessibilityNode {
        AccessibilityNode {
            index,
            parent_index: None,
            depth: 1,
            object_ref: object_ref.to_string(),
            role: "push button".to_string(),
            name: Some("Save document".to_string()),
            description: None,
            child_count: 0,
            bounds: None,
            states: vec!["enabled".to_string(), "showing".to_string()],
            actions: vec![AccessibilityAction {
                index: 0,
                name: "click".to_string(),
                description: String::new(),
                keybinding: String::new(),
            }],
            value: None,
            text: None,
            supports_editable_text: false,
        }
    }

    fn semantic_params() -> ActionParams {
        ActionParams {
            role: Some("push button".to_string()),
            name: Some("save".to_string()),
            ..Default::default()
        }
    }

    fn recovery_scope(params: serde_json::Value) -> AccessibilityRecoveryScope {
        AccessibilityRecoveryScope {
            params: serde_json::from_value(params).unwrap(),
            target_pid: None,
        }
    }

    fn named_scope() -> AccessibilityRecoveryScope {
        recovery_scope(serde_json::json!({
            "app_name_or_bundle_identifier": "org.example.Editor"
        }))
    }

    fn recovery_window(window_id: u64, pid: u32) -> WindowInfo {
        WindowInfo {
            window_id,
            title: Some("Editor".to_string()),
            app_id: Some("editor".to_string()),
            wm_class: None,
            pid: Some(pid),
            bounds: None,
            workspace: None,
            focused: false,
            hidden: false,
            client_type: None,
            backend: KWIN_BACKEND.to_string(),
            terminal: None,
        }
    }

    fn refreshed_snapshot(
        nodes: Vec<AccessibilityNode>,
        scoped: bool,
        root_pid: Option<u32>,
        target_pid: Option<u32>,
    ) -> RefreshedAccessibilitySnapshot {
        RefreshedAccessibilitySnapshot {
            snapshot: crate::atspi_tree::AccessibilitySnapshot {
                nodes,
                scoped,
                root_pid,
                app_filter_matched: true,
                truncated: false,
            },
            target_pid,
            window: None,
        }
    }

    fn successful_invocation() -> crate::atspi_tree::ActionInvocation {
        crate::atspi_tree::ActionInvocation {
            action_index: 0,
            action_name: Some("click".to_string()),
            ok: true,
        }
    }

    fn dead_name_error() -> anyhow::Error {
        anyhow::Error::new(zbus::fdo::Error::ServiceUnknown(
            "the cached unique name has no owner".to_string(),
        ))
        .context("failed to open the cached AT-SPI object")
    }

    #[test]
    fn lossy_atspi_dead_name_errors_are_query_phase_recoverable() {
        let error = anyhow::Error::new(atspi::AtspiError::from(zbus::fdo::Error::ServiceUnknown(
            "dead name".to_string(),
        )));
        assert!(is_recoverable_action_query_error(&error));
        assert!(!is_recoverable_action_query_error(&anyhow::anyhow!(
            "org.freedesktop.DBus.Error.UnknownObject"
        )));
        assert!(!is_recoverable_action_query_error(
            &error.context("failed to invoke AT-SPI action 0")
        ));
    }

    #[test]
    fn index_and_semantic_selector_resolve_the_same_object_ref() {
        let backend = ComputerUseLinux::default();
        backend.cache_snapshot_with_scope(&[action_node(7, OLD_REF)], None, Some(named_scope()));
        let params = semantic_params();
        let selector = params.selector();

        let by_index = backend
            .resolve_object_ref(Some(7), None, &selector, ElementResolvePurpose::Action)
            .unwrap();
        let by_selector = backend
            .resolve_object_ref(None, None, &selector, ElementResolvePurpose::Action)
            .unwrap();

        assert_eq!(by_index, OLD_REF);
        assert_eq!(by_selector, by_index);
    }

    #[tokio::test]
    async fn app_state_snapshots_retain_scope_only_when_scoped() {
        let backend = ComputerUseLinux::default();
        let params: GetAppStateParams = serde_json::from_value(serde_json::json!({
            "app_name_or_bundle_identifier": "org.example.Editor",
            "app_id": "org.example.Editor.desktop",
            "window_id": 42,
            "pid": 1234
        }))
        .unwrap();

        backend
            .commit_app_state_snapshot(&[action_node(0, OLD_REF)], Some(1234), None, &params, true)
            .await;
        let scope = backend
            .last_snapshot
            .lock()
            .unwrap()
            .recovery_scope
            .clone()
            .expect("scoped app-state snapshots need recovery scope");
        assert_eq!(
            scope.params.app_name_or_bundle_identifier.as_deref(),
            Some("org.example.Editor")
        );
        assert_eq!(
            scope.params.app_id.as_deref(),
            Some("org.example.Editor.desktop")
        );
        assert_eq!(scope.params.window_id, Some(42));
        assert_eq!(scope.params.pid, Some(1234));
        assert_eq!(scope.target_pid, Some(1234));

        backend
            .commit_app_state_snapshot(&[action_node(0, OLD_REF)], None, None, &params, false)
            .await;
        assert!(backend
            .last_snapshot
            .lock()
            .unwrap()
            .recovery_scope
            .is_none());
    }

    #[tokio::test]
    async fn semantic_recovery_regression_old_index_cannot_dispatch_a_reordered_element() {
        let backend = ComputerUseLinux::default();
        backend.cache_snapshot_with_scope(
            &[action_node(0, OLD_REF)],
            Some(1234),
            Some(recovery_scope(serde_json::json!({"pid": 1234}))),
        );
        let Json(recovered) = backend
            .perform_element_action_with(
                &semantic_params(),
                Some("click"),
                |object_ref, _| async move {
                    if object_ref == OLD_REF {
                        Err(dead_name_error())
                    } else {
                        assert_eq!(object_ref, NEW_REF);
                        Ok(successful_invocation())
                    }
                },
                |_| async {
                    let mut other = action_node(0, OTHER_REF);
                    other.name = Some("Delete document".to_string());
                    Ok(refreshed_snapshot(
                        vec![other, action_node(1, NEW_REF)],
                        true,
                        Some(1234),
                        Some(1234),
                    ))
                },
            )
            .await;
        assert!(recovered.ok, "{}", recovered.message);

        let stale_dispatches = Arc::new(Mutex::new(Vec::new()));
        let Json(indexed) = backend
            .perform_element_action_with(
                &ActionParams {
                    element_index: Some(0),
                    ..Default::default()
                },
                Some("click"),
                {
                    let stale_dispatches = Arc::clone(&stale_dispatches);
                    move |object_ref, _| {
                        stale_dispatches.lock().unwrap().push(object_ref);
                        async { Ok(successful_invocation()) }
                    }
                },
                |_| async { panic!("indexed actions must never refresh") },
            )
            .await;
        assert!(
            stale_dispatches.lock().unwrap().is_empty(),
            "stale index dispatched to {:?}",
            stale_dispatches.lock().unwrap()
        );
        assert!(!indexed.ok);
        assert!(recovered.message.contains("get_app_state"));
        assert!(indexed.message.contains("get_app_state"));
    }

    #[tokio::test]
    async fn semantic_recovery_regression_unstable_scope_cannot_rebind_another_app() {
        for params in [
            serde_json::json!({"app_name_or_bundle_identifier": "Editor"}),
            serde_json::json!({"app_id": "org.example.Editor"}),
            serde_json::json!({"title": "Editor window"}),
        ] {
            let backend = ComputerUseLinux::default();
            backend.cache_snapshot_with_scope(
                &[action_node(0, OLD_REF)],
                None,
                Some(recovery_scope(params)),
            );
            let refreshes = Arc::new(AtomicUsize::new(0));
            let dispatches = Arc::new(AtomicUsize::new(0));
            let Json(output) = backend
                .perform_element_action_with(
                    &semantic_params(),
                    Some("click"),
                    {
                        let dispatches = Arc::clone(&dispatches);
                        move |object_ref, _| {
                            let dispatches = Arc::clone(&dispatches);
                            async move {
                                if object_ref == OLD_REF {
                                    Err(dead_name_error())
                                } else {
                                    dispatches.fetch_add(1, Ordering::SeqCst);
                                    Ok(successful_invocation())
                                }
                            }
                        }
                    },
                    {
                        let refreshes = Arc::clone(&refreshes);
                        move |_| async move {
                            refreshes.fetch_add(1, Ordering::SeqCst);
                            // A different application's matching button can satisfy
                            // a name substring without proving its old identity.
                            Ok(refreshed_snapshot(
                                vec![action_node(0, OTHER_REF)],
                                true,
                                None,
                                None,
                            ))
                        }
                    },
                )
                .await;
            assert_eq!(refreshes.load(Ordering::SeqCst), 0);
            assert_eq!(dispatches.load(Ordering::SeqCst), 0);
            assert!(!output.ok);
            assert!(output.message.contains("get_app_state"));
        }
    }

    #[tokio::test]
    async fn semantic_recovery_identity_regression_observed_pid_cannot_roll_over() {
        for params in [
            serde_json::json!({"title": "Editor"}),
            serde_json::json!({"app_id": "org.example.Editor"}),
        ] {
            let backend = ComputerUseLinux::default();
            backend
                .commit_app_state_snapshot(
                    &[action_node(0, OLD_REF)],
                    Some(1234),
                    Some(&recovery_window(42, 1234)),
                    &serde_json::from_value(params).unwrap(),
                    true,
                )
                .await;
            let dispatches = Arc::new(AtomicUsize::new(0));
            let Json(output) = backend
                .perform_element_action_with(
                    &semantic_params(),
                    Some("click"),
                    {
                        let dispatches = Arc::clone(&dispatches);
                        move |object_ref, _| {
                            let dispatches = Arc::clone(&dispatches);
                            async move {
                                if object_ref == OLD_REF {
                                    Err(dead_name_error())
                                } else {
                                    dispatches.fetch_add(1, Ordering::SeqCst);
                                    Ok(successful_invocation())
                                }
                            }
                        }
                    },
                    |_scope| async move {
                        let mut refreshed = refreshed_snapshot(
                            vec![action_node(0, OTHER_REF)],
                            true,
                            Some(5678),
                            Some(5678),
                        );
                        refreshed.window = Some(recovery_window(43, 5678));
                        Ok(refreshed)
                    },
                )
                .await;
            assert_eq!(dispatches.load(Ordering::SeqCst), 0);
            assert!(!output.ok);
            assert!(output.message.contains("get_app_state"));
            assert_eq!(backend.last_snapshot.lock().unwrap().pid, Some(1234));
        }
    }

    #[tokio::test]
    async fn semantic_recovery_identity_regression_unobserved_window_cannot_admit_refresh() {
        let backend = ComputerUseLinux::default();
        backend
            .commit_app_state_snapshot(
                &[action_node(0, OLD_REF)],
                None,
                None,
                &serde_json::from_value(serde_json::json!({"window_id": 42})).unwrap(),
                true,
            )
            .await;
        let refreshes = Arc::new(AtomicUsize::new(0));
        let Json(output) = backend
            .perform_element_action_with(
                &semantic_params(),
                Some("click"),
                |object_ref, _| async move {
                    if object_ref == OLD_REF {
                        Err(dead_name_error())
                    } else {
                        Ok(successful_invocation())
                    }
                },
                {
                    let refreshes = Arc::clone(&refreshes);
                    move |_| async move {
                        refreshes.fetch_add(1, Ordering::SeqCst);
                        let mut refreshed = refreshed_snapshot(
                            vec![action_node(0, OTHER_REF)],
                            true,
                            Some(5678),
                            Some(5678),
                        );
                        refreshed.window = Some(recovery_window(42, 5678));
                        Ok(refreshed)
                    }
                },
            )
            .await;
        assert_eq!(refreshes.load(Ordering::SeqCst), 0);
        assert!(!output.ok);
        assert!(output.message.contains("get_app_state"));
    }

    #[tokio::test]
    async fn window_only_recovery_requires_exact_window_and_matching_root_pid() {
        for (fresh_window_id, fresh_backend, fresh_pid, expected_ok) in [
            (42, KWIN_BACKEND, Some(5678), true),
            (43, KWIN_BACKEND, Some(5678), false),
            (42, "x11", Some(5678), false),
            (42, KWIN_BACKEND, None, false),
        ] {
            let backend = ComputerUseLinux::default();
            let mut original_window = recovery_window(42, 1234);
            original_window.pid = None;
            backend
                .commit_app_state_snapshot(
                    &[action_node(0, OLD_REF)],
                    None,
                    Some(&original_window),
                    &serde_json::from_value(serde_json::json!({"window_id": 42})).unwrap(),
                    true,
                )
                .await;
            let dispatches = Arc::new(AtomicUsize::new(0));
            let Json(output) = backend
                .perform_element_action_with(
                    &semantic_params(),
                    Some("click"),
                    {
                        let dispatches = Arc::clone(&dispatches);
                        move |object_ref, _| {
                            let dispatches = Arc::clone(&dispatches);
                            async move {
                                if object_ref == OLD_REF {
                                    Err(dead_name_error())
                                } else {
                                    dispatches.fetch_add(1, Ordering::SeqCst);
                                    Ok(successful_invocation())
                                }
                            }
                        }
                    },
                    |scope| async move {
                        let pid = action_recovery_target_pid(&scope, fresh_pid);
                        assert_eq!(pid, fresh_pid);
                        // An unrelated name-matching accessibility root still
                        // looks scoped when neither owner supplies a PID.
                        let object_ref = if fresh_pid.is_none() {
                            OTHER_REF
                        } else {
                            NEW_REF
                        };
                        let mut refreshed = refreshed_snapshot(
                            vec![action_node(0, object_ref)],
                            true,
                            fresh_pid,
                            pid,
                        );
                        refreshed.window = Some(WindowInfo {
                            backend: fresh_backend.to_string(),
                            pid: fresh_pid,
                            ..recovery_window(fresh_window_id, 5678)
                        });
                        Ok(refreshed)
                    },
                )
                .await;
            assert_eq!(dispatches.load(Ordering::SeqCst), usize::from(expected_ok));
            assert_eq!(output.ok, expected_ok, "{}", output.message);
            if fresh_pid.is_none() {
                assert!(output.message.contains("could not prove"));
            }
        }
    }

    #[tokio::test]
    async fn dead_owner_recovers_new_identity_dispatches_once_and_invalidates_snapshot() {
        let backend = ComputerUseLinux::default();
        let scope = recovery_scope(serde_json::json!({
            "app_name_or_bundle_identifier": "org.example.Editor",
            "app_id": "org.example.Editor.desktop",
            "window_id": 42,
            "pid": 1234,
            "max_nodes": 50,
            "max_depth": 8
        }));
        backend.cache_snapshot_with_window(
            &[action_node(0, OLD_REF)],
            Some(1234),
            Some(scope),
            Some(&recovery_window(42, 1234)),
        );
        let queries = Arc::new(AtomicUsize::new(0));
        let dispatches = Arc::new(AtomicUsize::new(0));
        let refreshes = Arc::new(AtomicUsize::new(0));
        let invoked_refs = Arc::new(Mutex::new(Vec::new()));
        let params = semantic_params();

        let Json(output) = backend
            .perform_element_action_with(
                &params,
                Some("0"),
                {
                    let queries = Arc::clone(&queries);
                    let dispatches = Arc::clone(&dispatches);
                    let invoked_refs = Arc::clone(&invoked_refs);
                    move |object_ref, _action| {
                        let queries = Arc::clone(&queries);
                        let dispatches = Arc::clone(&dispatches);
                        let invoked_refs = Arc::clone(&invoked_refs);
                        async move {
                            invoked_refs.lock().unwrap().push(object_ref);
                            if queries.fetch_add(1, Ordering::SeqCst) == 0 {
                                Err(dead_name_error())
                            } else {
                                dispatches.fetch_add(1, Ordering::SeqCst);
                                Ok(successful_invocation())
                            }
                        }
                    }
                },
                {
                    let refreshes = Arc::clone(&refreshes);
                    move |scope| async move {
                        refreshes.fetch_add(1, Ordering::SeqCst);
                        assert_eq!(
                            scope.params.app_name_or_bundle_identifier.as_deref(),
                            Some("org.example.Editor")
                        );
                        assert_eq!(
                            scope.params.app_id.as_deref(),
                            Some("org.example.Editor.desktop")
                        );
                        assert_eq!(scope.params.window_id, Some(42));
                        assert_eq!(scope.params.pid, Some(1234));
                        assert_eq!(scope.params.max_nodes, Some(50));
                        assert_eq!(scope.params.max_depth, Some(8));
                        let mut filler = action_node(0, ":1.20/org/a11y/atspi/accessible/1");
                        filler.depth = 2;
                        filler.role = "filler".to_string();
                        filler.name = None;
                        filler.actions.clear();
                        let mut replacement = action_node(1, NEW_REF);
                        replacement.depth = 2;
                        replacement.parent_index = Some(0);
                        let mut refreshed = refreshed_snapshot(
                            vec![filler, replacement],
                            true,
                            Some(1234),
                            Some(1234),
                        );
                        refreshed.window = Some(recovery_window(42, 1234));
                        Ok(refreshed)
                    }
                },
            )
            .await;

        assert!(output.ok, "{}", output.message);
        assert_eq!(queries.load(Ordering::SeqCst), 2);
        assert_eq!(dispatches.load(Ordering::SeqCst), 1);
        assert_eq!(refreshes.load(Ordering::SeqCst), 1);
        assert_eq!(*invoked_refs.lock().unwrap(), vec![OLD_REF, NEW_REF]);
        let snapshot = backend.last_snapshot.lock().unwrap();
        assert!(snapshot.nodes.is_empty());
        assert!(snapshot.pid.is_none());
        assert!(snapshot.window_id.is_none());
        assert!(snapshot.recovery_scope.is_none());
        assert!(output.message.contains("Call get_app_state"));
    }

    #[tokio::test]
    async fn pid_scoped_recovery_invalidates_window_binding_after_local_resolution() {
        let old_window = WindowInfo {
            window_id: 42,
            title: Some("Editor".to_string()),
            app_id: Some("editor".to_string()),
            wm_class: None,
            pid: Some(1234),
            bounds: None,
            workspace: None,
            focused: false,
            hidden: false,
            client_type: None,
            backend: KWIN_BACKEND.to_string(),
            terminal: None,
        };

        for fresh_window_id in [Some(84), None] {
            let backend = ComputerUseLinux::default();
            backend
                .commit_app_state_snapshot(
                    &[action_node(0, OLD_REF)],
                    Some(1234),
                    Some(&old_window),
                    &serde_json::from_value(serde_json::json!({
                        "app_name_or_bundle_identifier": "Editor"
                    }))
                    .unwrap(),
                    true,
                )
                .await;
            let fresh_window = fresh_window_id.map(|window_id| WindowInfo {
                window_id,
                ..old_window.clone()
            });
            let Json(output) = backend
                .perform_element_action_with(
                    &semantic_params(),
                    Some("click"),
                    |object_ref, _action| async move {
                        if object_ref == OLD_REF {
                            Err(dead_name_error())
                        } else {
                            Ok(successful_invocation())
                        }
                    },
                    |scope| async move {
                        assert_eq!(scope.params.pid, None);
                        assert_eq!(scope.target_pid, Some(1234));
                        let mut refreshed = refreshed_snapshot(
                            vec![action_node(0, NEW_REF)],
                            true,
                            Some(1234),
                            Some(1234),
                        );
                        refreshed.window = fresh_window;
                        Ok(refreshed)
                    },
                )
                .await;

            assert!(output.ok, "{}", output.message);
            let cached = backend.last_snapshot.lock().unwrap();
            assert!(cached.nodes.is_empty());
            assert!(cached.pid.is_none());
            assert!(cached.window_id.is_none());
            assert!(cached.window_backend.is_none());
            assert!(cached.recovery_scope.is_none());
            assert!(output.message.contains("Call get_app_state"));
        }
    }

    #[tokio::test]
    async fn explicit_window_recovery_rejects_missing_or_different_window_without_replacing_cache()
    {
        for fresh_window_id in [None, Some(43)] {
            let backend = ComputerUseLinux::default();
            let scope = recovery_scope(serde_json::json!({
                "app_name_or_bundle_identifier": "Editor",
                "window_id": 42
            }));
            backend.cache_snapshot_with_window(
                &[action_node(0, OLD_REF)],
                Some(1234),
                Some(scope),
                Some(&recovery_window(42, 1234)),
            );
            let queries = Arc::new(AtomicUsize::new(0));
            let Json(output) = backend
                .perform_element_action_with(
                    &semantic_params(),
                    Some("click"),
                    {
                        let queries = Arc::clone(&queries);
                        move |object_ref, _action| {
                            let queries = Arc::clone(&queries);
                            async move {
                                queries.fetch_add(1, Ordering::SeqCst);
                                if object_ref == OLD_REF {
                                    Err(dead_name_error())
                                } else {
                                    Ok(successful_invocation())
                                }
                            }
                        }
                    },
                    |_scope| async move {
                        let mut refreshed = refreshed_snapshot(
                            vec![action_node(0, NEW_REF)],
                            true,
                            Some(1234),
                            Some(1234),
                        );
                        refreshed.window = fresh_window_id.map(|id| recovery_window(id, 1234));
                        Ok(refreshed)
                    },
                )
                .await;
            assert!(!output.ok, "{fresh_window_id:?}: {}", output.message);
            assert_eq!(queries.load(Ordering::SeqCst), 1);
            let cached = backend.last_snapshot.lock().unwrap();
            assert_eq!(cached.nodes[0].object_ref, OLD_REF);
            assert_eq!(cached.window_id, Some(42));
            assert_eq!(cached.window_backend.as_deref(), Some(KWIN_BACKEND));
        }
    }

    #[tokio::test]
    async fn window_derived_pid_scope_rejects_name_only_refresh_after_window_loss() {
        let backend = ComputerUseLinux::default();
        let mut scope = recovery_scope(serde_json::json!({
            "app_name_or_bundle_identifier": "Editor",
            "window_id": 42
        }));
        scope.target_pid = Some(1234);
        assert_eq!(scope.params.pid, None);
        assert_eq!(action_recovery_target_pid(&scope, None), Some(1234));
        assert_eq!(action_recovery_target_pid(&scope, Some(5678)), Some(1234));
        backend.cache_snapshot_with_scope(&[action_node(0, OLD_REF)], Some(1234), Some(scope));
        let queries = Arc::new(AtomicUsize::new(0));
        let dispatches = Arc::new(AtomicUsize::new(0));
        let params = semantic_params();

        let Json(output) = backend
            .perform_element_action_with(
                &params,
                Some("0"),
                {
                    let queries = Arc::clone(&queries);
                    let dispatches = Arc::clone(&dispatches);
                    move |_object_ref, _action| {
                        let queries = Arc::clone(&queries);
                        let dispatches = Arc::clone(&dispatches);
                        async move {
                            if queries.fetch_add(1, Ordering::SeqCst) == 0 {
                                Err(dead_name_error())
                            } else {
                                dispatches.fetch_add(1, Ordering::SeqCst);
                                Ok(successful_invocation())
                            }
                        }
                    }
                },
                |scope| async move {
                    let target_pid = action_recovery_target_pid(&scope, None);
                    Ok(refreshed_snapshot(
                        vec![action_node(0, OTHER_REF)],
                        true,
                        None,
                        target_pid,
                    ))
                },
            )
            .await;

        assert!(!output.ok);
        assert!(output.message.contains("original app scope"));
        assert_eq!(queries.load(Ordering::SeqCst), 1);
        assert_eq!(dispatches.load(Ordering::SeqCst), 0);
        let snapshot = backend.last_snapshot.lock().unwrap();
        assert_eq!(snapshot.pid, Some(1234));
        assert_eq!(snapshot.nodes[0].object_ref, OLD_REF);
    }

    #[tokio::test]
    async fn pid_scope_rejects_identical_selector_from_another_app() {
        let backend = ComputerUseLinux::default();
        backend.cache_snapshot_with_scope(
            &[action_node(0, OLD_REF)],
            Some(1234),
            Some(recovery_scope(serde_json::json!({
                "app_name_or_bundle_identifier": "Editor",
                "pid": 1234
            }))),
        );
        let invoked_refs = Arc::new(Mutex::new(Vec::new()));
        let params = semantic_params();

        let Json(output) = backend
            .perform_element_action_with(
                &params,
                Some("0"),
                {
                    let invoked_refs = Arc::clone(&invoked_refs);
                    move |object_ref, _action| {
                        let invoked_refs = Arc::clone(&invoked_refs);
                        async move {
                            invoked_refs.lock().unwrap().push(object_ref);
                            Err(dead_name_error())
                        }
                    }
                },
                |_scope| async {
                    Ok(refreshed_snapshot(
                        vec![action_node(0, OTHER_REF)],
                        true,
                        Some(5678),
                        Some(1234),
                    ))
                },
            )
            .await;

        assert!(!output.ok);
        assert!(
            output.message.contains("original app scope"),
            "{}",
            output.message
        );
        assert!(output.message.contains("Call get_app_state"));
        assert_eq!(*invoked_refs.lock().unwrap(), vec![OLD_REF]);
        let snapshot = backend.last_snapshot.lock().unwrap();
        assert_eq!(snapshot.pid, Some(1234));
        assert_eq!(snapshot.nodes[0].object_ref, OLD_REF);
    }

    #[tokio::test]
    async fn recovery_rejects_reused_pid_when_original_filter_does_not_match() {
        let backend = ComputerUseLinux::default();
        let mut scope = recovery_scope(serde_json::json!({
            "app_name_or_bundle_identifier": "Editor",
            "pid": 1234
        }));
        scope.target_pid = Some(1234);
        backend.cache_snapshot_with_scope(&[action_node(0, OLD_REF)], Some(1234), Some(scope));
        let invoked_refs = Arc::new(Mutex::new(Vec::new()));
        let params = semantic_params();

        let Json(output) = backend
            .perform_element_action_with(
                &params,
                Some("0"),
                {
                    let invoked_refs = Arc::clone(&invoked_refs);
                    move |object_ref, _action| {
                        let invoked_refs = Arc::clone(&invoked_refs);
                        async move {
                            invoked_refs.lock().unwrap().push(object_ref);
                            Err(dead_name_error())
                        }
                    }
                },
                |_scope| async {
                    let mut refreshed = refreshed_snapshot(
                        vec![action_node(0, OTHER_REF)],
                        true,
                        Some(1234),
                        Some(1234),
                    );
                    refreshed.snapshot.app_filter_matched = false;
                    Ok(refreshed)
                },
            )
            .await;

        assert!(!output.ok);
        assert!(output.message.contains("original app scope"));
        assert_eq!(*invoked_refs.lock().unwrap(), vec![OLD_REF]);
        let snapshot = backend.last_snapshot.lock().unwrap();
        assert_eq!(snapshot.pid, Some(1234));
        assert_eq!(snapshot.nodes[0].object_ref, OLD_REF);
        assert_eq!(
            snapshot.recovery_scope.as_ref().unwrap().target_pid,
            Some(1234)
        );
    }

    #[tokio::test]
    async fn window_scoped_recovery_requires_observation_before_a_second_recovery() {
        let backend = ComputerUseLinux::default();
        let mut scope = recovery_scope(serde_json::json!({
            "app_name_or_bundle_identifier": "Editor",
            "window_id": 42
        }));
        scope.target_pid = Some(1234);
        backend.cache_snapshot_with_window(
            &[action_node(0, OLD_REF)],
            Some(1234),
            Some(scope),
            Some(&recovery_window(42, 1234)),
        );
        let params = semantic_params();
        let first_refs = Arc::new(Mutex::new(Vec::new()));

        let Json(output) = backend
            .perform_element_action_with(
                &params,
                Some("0"),
                {
                    let first_refs = Arc::clone(&first_refs);
                    move |object_ref, _action| {
                        let first_refs = Arc::clone(&first_refs);
                        async move {
                            first_refs.lock().unwrap().push(object_ref.clone());
                            if object_ref == OLD_REF {
                                Err(dead_name_error())
                            } else {
                                Ok(successful_invocation())
                            }
                        }
                    }
                },
                |scope| async move {
                    assert_eq!(action_recovery_target_pid(&scope, None), Some(1234));
                    let mut refreshed = refreshed_snapshot(
                        vec![action_node(0, NEW_REF)],
                        true,
                        Some(1234),
                        Some(1234),
                    );
                    refreshed.window = Some(recovery_window(42, 1234));
                    Ok(refreshed)
                },
            )
            .await;

        assert!(output.ok, "{}", output.message);
        assert_eq!(*first_refs.lock().unwrap(), vec![OLD_REF, NEW_REF]);
        {
            let snapshot = backend.last_snapshot.lock().unwrap();
            assert!(snapshot.nodes.is_empty());
            assert!(snapshot.pid.is_none());
            assert!(snapshot.recovery_scope.is_none());
        }

        let Json(without_observation) = backend
            .perform_element_action_with(
                &params,
                Some("click"),
                |_, _| async { panic!("invalidated indices must not dispatch") },
                |_| async { panic!("invalidated snapshots must not refresh") },
            )
            .await;
        assert!(!without_observation.ok);
        assert!(without_observation.message.contains("get_app_state"));

        // Simulate the next explicit get_app_state. Its observed PID and exact
        // window binding, rather than the hidden recovery tree, own this cache.
        backend
            .commit_app_state_snapshot(
                &[action_node(0, NEW_REF)],
                Some(5678),
                Some(&recovery_window(42, 5678)),
                &serde_json::from_value(serde_json::json!({"window_id": 42})).unwrap(),
                true,
            )
            .await;

        let second_refs = Arc::new(Mutex::new(Vec::new()));
        let Json(output) = backend
            .perform_element_action_with(
                &params,
                Some("0"),
                {
                    let second_refs = Arc::clone(&second_refs);
                    move |object_ref, _action| {
                        let second_refs = Arc::clone(&second_refs);
                        async move {
                            second_refs.lock().unwrap().push(object_ref.clone());
                            if object_ref == NEW_REF {
                                Err(dead_name_error())
                            } else {
                                Ok(successful_invocation())
                            }
                        }
                    }
                },
                |scope| async move {
                    assert_eq!(action_recovery_target_pid(&scope, None), Some(5678));
                    let mut refreshed = refreshed_snapshot(
                        vec![action_node(0, OTHER_REF)],
                        true,
                        Some(5678),
                        Some(5678),
                    );
                    refreshed.window = Some(recovery_window(42, 5678));
                    Ok(refreshed)
                },
            )
            .await;

        assert!(output.ok, "{}", output.message);
        assert_eq!(*second_refs.lock().unwrap(), vec![NEW_REF, OTHER_REF]);
        let snapshot = backend.last_snapshot.lock().unwrap();
        assert!(snapshot.nodes.is_empty());
        assert!(snapshot.pid.is_none());
        assert!(snapshot.recovery_scope.is_none());
    }

    #[tokio::test]
    async fn unscoped_refresh_is_not_cached_or_invoked() {
        let backend = ComputerUseLinux::default();
        backend.cache_snapshot_with_scope(
            &[action_node(0, OLD_REF)],
            Some(1234),
            Some(recovery_scope(serde_json::json!({"pid": 1234}))),
        );
        let queries = Arc::new(AtomicUsize::new(0));
        let params = semantic_params();

        let Json(output) = backend
            .perform_element_action_with(
                &params,
                Some("0"),
                {
                    let queries = Arc::clone(&queries);
                    move |_object_ref, _action| {
                        let queries = Arc::clone(&queries);
                        async move {
                            queries.fetch_add(1, Ordering::SeqCst);
                            Err(dead_name_error())
                        }
                    }
                },
                |_scope| async {
                    Ok(refreshed_snapshot(
                        vec![action_node(0, OTHER_REF)],
                        false,
                        None,
                        None,
                    ))
                },
            )
            .await;

        assert!(!output.ok);
        assert!(output.message.contains("could not prove"));
        assert_eq!(queries.load(Ordering::SeqCst), 1);
        assert_eq!(
            backend.last_snapshot.lock().unwrap().nodes[0].object_ref,
            OLD_REF
        );
    }

    #[tokio::test]
    async fn numeric_and_explicit_identifiers_never_refresh_or_get_rewritten() {
        let numeric = ActionParams {
            element_index: Some(7),
            ..semantic_params()
        };
        let explicit = ActionParams {
            element_identifier: Some(EXPLICIT_REF.to_string()),
            ..semantic_params()
        };

        for (params, expected_ref) in [(numeric, OLD_REF), (explicit, EXPLICIT_REF)] {
            let backend = ComputerUseLinux::default();
            backend.cache_snapshot_with_scope(
                &[action_node(7, OLD_REF)],
                None,
                Some(named_scope()),
            );
            let refreshes = Arc::new(AtomicUsize::new(0));
            let invoked_refs = Arc::new(Mutex::new(Vec::new()));

            let Json(output) = backend
                .perform_element_action_with(
                    &params,
                    Some("0"),
                    {
                        let invoked_refs = Arc::clone(&invoked_refs);
                        move |object_ref, _action| {
                            let invoked_refs = Arc::clone(&invoked_refs);
                            async move {
                                invoked_refs.lock().unwrap().push(object_ref);
                                Err(dead_name_error())
                            }
                        }
                    },
                    {
                        let refreshes = Arc::clone(&refreshes);
                        move |_scope| async move {
                            refreshes.fetch_add(1, Ordering::SeqCst);
                            Ok(refreshed_snapshot(
                                vec![action_node(0, NEW_REF)],
                                true,
                                None,
                                None,
                            ))
                        }
                    },
                )
                .await;

            assert!(!output.ok);
            assert_eq!(*invoked_refs.lock().unwrap(), vec![expected_ref]);
            assert_eq!(refreshes.load(Ordering::SeqCst), 0);
            assert_eq!(
                backend.last_snapshot.lock().unwrap().nodes[0].object_ref,
                OLD_REF
            );
        }
    }

    #[tokio::test]
    async fn invocation_phase_dead_name_error_is_never_retried() {
        let backend = ComputerUseLinux::default();
        backend.cache_snapshot_with_scope(&[action_node(0, OLD_REF)], None, Some(named_scope()));
        let queries = Arc::new(AtomicUsize::new(0));
        let refreshes = Arc::new(AtomicUsize::new(0));
        let params = semantic_params();

        let Json(output) = backend
            .perform_element_action_with(
                &params,
                Some("0"),
                {
                    let queries = Arc::clone(&queries);
                    move |_object_ref, _action| {
                        let queries = Arc::clone(&queries);
                        async move {
                            queries.fetch_add(1, Ordering::SeqCst);
                            Err(dead_name_error().context("failed to invoke AT-SPI action 0"))
                        }
                    }
                },
                {
                    let refreshes = Arc::clone(&refreshes);
                    move |_scope| async move {
                        refreshes.fetch_add(1, Ordering::SeqCst);
                        Ok(refreshed_snapshot(
                            vec![action_node(0, NEW_REF)],
                            true,
                            None,
                            None,
                        ))
                    }
                },
            )
            .await;

        assert!(!output.ok);
        assert!(output.message.contains("failed to invoke AT-SPI action 0"));
        assert_eq!(queries.load(Ordering::SeqCst), 1);
        assert_eq!(refreshes.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn recovered_dispatch_failure_is_not_retried() {
        let backend = ComputerUseLinux::default();
        backend.cache_snapshot_with_scope(
            &[action_node(0, OLD_REF)],
            Some(1234),
            Some(recovery_scope(serde_json::json!({"pid": 1234}))),
        );
        let queries = Arc::new(AtomicUsize::new(0));
        let refreshes = Arc::new(AtomicUsize::new(0));
        let params = semantic_params();

        let Json(output) = backend
            .perform_element_action_with(
                &params,
                Some("0"),
                {
                    let queries = Arc::clone(&queries);
                    move |_object_ref, _action| {
                        let queries = Arc::clone(&queries);
                        async move {
                            if queries.fetch_add(1, Ordering::SeqCst) == 0 {
                                Err(dead_name_error())
                            } else {
                                Err(dead_name_error().context("failed to invoke AT-SPI action 0"))
                            }
                        }
                    }
                },
                {
                    let refreshes = Arc::clone(&refreshes);
                    move |_scope| async move {
                        refreshes.fetch_add(1, Ordering::SeqCst);
                        Ok(refreshed_snapshot(
                            vec![action_node(0, NEW_REF)],
                            true,
                            Some(1234),
                            Some(1234),
                        ))
                    }
                },
            )
            .await;

        assert!(!output.ok);
        assert!(output.message.contains("failed to invoke AT-SPI action 0"));
        assert_eq!(queries.load(Ordering::SeqCst), 2);
        assert_eq!(refreshes.load(Ordering::SeqCst), 1);
        assert!(backend.last_snapshot.lock().unwrap().nodes.is_empty());
        assert!(output.message.contains("Call get_app_state"));
    }

    #[tokio::test]
    async fn dead_name_without_stable_scope_requires_fresh_app_state() {
        let backend = ComputerUseLinux::default();
        backend.cache_nodes(&[action_node(0, OLD_REF)]);
        let refreshes = Arc::new(AtomicUsize::new(0));
        let params = semantic_params();

        let Json(output) = backend
            .perform_element_action_with(
                &params,
                Some("0"),
                |_object_ref, _action| async { Err(dead_name_error()) },
                {
                    let refreshes = Arc::clone(&refreshes);
                    move |_scope| async move {
                        refreshes.fetch_add(1, Ordering::SeqCst);
                        Ok(refreshed_snapshot(Vec::new(), true, None, None))
                    }
                },
            )
            .await;

        assert!(!output.ok);
        assert!(output.message.contains("no stable scoped recovery target"));
        assert!(output.message.contains("Call get_app_state"));
        assert_eq!(refreshes.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn post_action_snapshot_does_not_retain_stale_recovery_scope() {
        let backend = ComputerUseLinux::default();
        backend.cache_snapshot_with_scope(
            &[action_node(0, OLD_REF)],
            Some(1234),
            Some(named_scope()),
        );

        backend
            .commit_snapshot(&[action_node(0, NEW_REF)], Some(5678))
            .await;

        let snapshot = backend.last_snapshot.lock().unwrap();
        assert_eq!(snapshot.nodes[0].object_ref, NEW_REF);
        assert_eq!(snapshot.pid, Some(5678));
        assert!(snapshot.recovery_scope.is_none());
    }
}

#[cfg(test)]
mod node_target_scope_tests {
    use super::*;

    fn cached_node(index: u32, object_ref: &str) -> AccessibilityNode {
        AccessibilityNode {
            index,
            parent_index: None,
            depth: 1,
            object_ref: object_ref.to_string(),
            role: "push button".to_string(),
            name: Some("Hit me".to_string()),
            description: None,
            child_count: 0,
            bounds: None,
            states: vec!["enabled".to_string()],
            actions: Vec::new(),
            value: None,
            text: None,
            supports_editable_text: false,
        }
    }

    #[tokio::test]
    async fn index_from_another_apps_snapshot_is_rejected() {
        let backend = ComputerUseLinux::default();
        let node = cached_node(2, ":1.9/org/a11y/atspi/accessible/42");
        backend.cache_snapshot(std::slice::from_ref(&node), Some(2_690_687));

        let error = backend
            .check_node_target(&node, Some(2_690_664))
            .await
            .unwrap_err();
        assert!(error.contains("pid 2690687"), "{error}");
        assert!(error.contains("target pid 2690664"), "{error}");
        assert!(
            error.contains("Call get_app_state for the target app"),
            "{error}"
        );
    }

    #[tokio::test]
    async fn same_target_or_no_target_is_allowed() {
        let backend = ComputerUseLinux::default();
        let node = cached_node(2, ":1.9/org/a11y/atspi/accessible/42");
        backend.cache_snapshot(std::slice::from_ref(&node), Some(2_690_664));

        assert!(backend
            .check_node_target(&node, Some(2_690_664))
            .await
            .is_ok());
        assert!(backend.check_node_target(&node, None).await.is_ok());
    }

    #[tokio::test]
    async fn unscoped_snapshot_with_unknown_owner_is_allowed() {
        // No snapshot pid, and the owner lookup cannot resolve this ref here,
        // so a mismatch cannot be shown and the action proceeds.
        let backend = ComputerUseLinux::default();
        let node = cached_node(2, ":1.9999/org/a11y/atspi/accessible/42");
        backend.cache_snapshot(std::slice::from_ref(&node), None);

        assert!(backend.check_node_target(&node, Some(1)).await.is_ok());
    }

    #[tokio::test]
    async fn concurrent_snapshot_commit_waits_until_checked_action_finishes() {
        let backend = ComputerUseLinux::default();
        let mut original = cached_node(2, ":1.9/org/a11y/atspi/accessible/42");
        original.bounds = Some(Bounds {
            x: 10,
            y: 20,
            width: 100,
            height: 40,
        });
        original.actions = vec![AccessibilityAction {
            index: 0,
            name: "click".into(),
            description: String::new(),
            keybinding: String::new(),
        }];
        backend
            .commit_snapshot(std::slice::from_ref(&original), Some(10))
            .await;
        // Model the click/scroll operation: it holds this same lock while its
        // target ownership check awaits and until the action has been resolved.
        let input_guard = Arc::clone(&backend.input_operation_lock).lock_owned().await;
        let checked_node = backend
            .cached_node_for(
                Some(2),
                &ElementSelector::default(),
                ElementResolvePurpose::Click,
            )
            .unwrap();
        let barrier = Arc::new(tokio::sync::Barrier::new(2));
        let writer_backend = backend.clone();
        let writer_barrier = Arc::clone(&barrier);
        let writer = tokio::spawn(async move {
            let replacement = cached_node(2, ":1.20/org/a11y/atspi/accessible/99");
            writer_barrier.wait().await;
            writer_backend
                .commit_snapshot(&[replacement], Some(20))
                .await;
        });
        barrier.wait().await;
        tokio::task::yield_now().await;
        assert!(
            !writer.is_finished(),
            "snapshot publication must wait for input"
        );
        assert!(backend
            .check_node_target(&checked_node, Some(10))
            .await
            .is_ok());
        let params = ClickParams {
            element_index: Some(2),
            ..Default::default()
        };
        assert!(matches!(backend.resolve_click_target(&params).unwrap(),
            ClickTarget::PrimaryAction { object_ref, .. } if object_ref == original.object_ref));
        assert_eq!(
            backend
                .resolve_optional_target_point(None, None, Some(2))
                .unwrap(),
            Some((60, 40))
        );
        // perform_action/set_value resolve the same snapshot while holding the
        // input lock; their explicit object identifiers remain independent.
        for purpose in [
            ElementResolvePurpose::Action,
            ElementResolvePurpose::SetValue,
        ] {
            assert_eq!(
                backend
                    .resolve_object_ref(Some(2), None, &ElementSelector::default(), purpose)
                    .unwrap(),
                original.object_ref
            );
        }
        drop(input_guard);
        writer.await.unwrap();
        let snapshot = backend.last_snapshot.lock().unwrap();
        assert_eq!(snapshot.pid, Some(20));
        assert_eq!(
            snapshot.nodes[0].object_ref,
            ":1.20/org/a11y/atspi/accessible/99"
        );
    }

    #[test]
    fn a_new_snapshot_replaces_the_recorded_pid() {
        let backend = ComputerUseLinux::default();
        backend.cache_snapshot(&[], Some(10));
        backend.cache_snapshot(&[], None);
        assert_eq!(backend.last_snapshot.lock().unwrap().pid, None);
        backend.cache_snapshot(&[], Some(11));
        backend.clear_cached_nodes();
        assert_eq!(backend.last_snapshot.lock().unwrap().pid, None);
    }
}

#[cfg(test)]
mod post_action_capture_tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::sync::atomic::{AtomicUsize, Ordering};

    type ToolCall<'a> =
        std::pin::Pin<Box<dyn Future<Output = Result<CallToolResult, ErrorData>> + 'a>>;

    fn arguments<T: serde::de::DeserializeOwned>(value: serde_json::Value) -> Parameters<T> {
        Parameters(serde_json::from_value(value).unwrap())
    }

    /// Runs `action` against a freshly cached report, then reads readiness the
    /// way get_app_state does. Returns the action's result and whether that
    /// read had to probe again.
    async fn readiness_probed_after(
        server: &ComputerUseLinux,
        probes: &AtomicUsize,
        action: impl Future<Output = Result<CallToolResult, ErrorData>>,
    ) -> (CallToolResult, bool) {
        server.diagnostics.report(false).await;
        let cached = probes.load(Ordering::SeqCst);
        let result = action.await.unwrap();
        server.diagnostics.report(false).await;
        (result, probes.load(Ordering::SeqCst) != cached)
    }

    fn solid_png(width: u32, height: u32) -> Vec<u8> {
        let img = image::RgbaImage::from_pixel(width, height, image::Rgba([32, 128, 192, 255]));
        let mut out = Vec::new();
        image::DynamicImage::ImageRgba8(img)
            .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
            .unwrap();
        out
    }

    #[test]
    fn screenshot_after_deserializes_bool_and_scope_strings() {
        let empty: PostActionCaptureParams = serde_json::from_value(serde_json::json!({})).unwrap();
        assert_eq!(empty.screenshot_scope(), None);
        assert_eq!(empty.include_tree, None);

        let disabled: PostActionCaptureParams =
            serde_json::from_value(serde_json::json!({"screenshot_after": false})).unwrap();
        assert_eq!(disabled.screenshot_scope(), None);

        let enabled: PostActionCaptureParams =
            serde_json::from_value(serde_json::json!({"screenshot_after": true})).unwrap();
        assert_eq!(
            enabled.screenshot_scope(),
            Some(ScreenshotAfterScope::Screen)
        );

        let screen: PostActionCaptureParams =
            serde_json::from_value(serde_json::json!({"screenshot_after": "screen"})).unwrap();
        assert_eq!(
            screen.screenshot_scope(),
            Some(ScreenshotAfterScope::Screen)
        );

        let window: PostActionCaptureParams =
            serde_json::from_value(serde_json::json!({"screenshot_after": "window"})).unwrap();
        assert_eq!(
            window.screenshot_scope(),
            Some(ScreenshotAfterScope::Window)
        );

        let tree_only: PostActionCaptureParams =
            serde_json::from_value(serde_json::json!({"include_tree": true})).unwrap();
        assert_eq!(tree_only.screenshot_scope(), None);
        assert_eq!(tree_only.include_tree, Some(true));

        assert!(serde_json::from_value::<PostActionCaptureParams>(
            serde_json::json!({"screenshot_after": "invalid"})
        )
        .is_err());
    }

    #[test]
    fn editable_text_results_map_ok_verified_and_mcp_error_status() {
        for (outcome, expected_ok, expected_verified) in [
            (EditableTextSetOutcome::Verified, true, Some(true)),
            (
                EditableTextSetOutcome::MismatchAfterDeadline,
                false,
                Some(false),
            ),
            (EditableTextSetOutcome::ReadbackFailed, false, Some(false)),
            (EditableTextSetOutcome::ReadbackTimedOut, false, Some(false)),
            (
                EditableTextSetOutcome::PasswordUnverifiable,
                true,
                Some(false),
            ),
        ] {
            let (output, verified) = editable_text_action_result(outcome, None);
            assert_eq!(output.ok, expected_ok);
            assert_eq!(verified, expected_verified);
            let result = structured_tool_result(
                SetValueToolOutput {
                    action: output,
                    verified,
                    observation: PostActionObservation::default(),
                },
                None,
            )
            .unwrap();
            assert_eq!(result.is_error, Some(!expected_ok));
            let structured = result.structured_content.unwrap();
            assert_eq!(structured["ok"], serde_json::json!(expected_ok));
            assert_eq!(structured["verified"], serde_json::json!(expected_verified));
        }
    }

    #[test]
    fn set_value_output_omits_verified_for_numeric_and_early_failures() {
        let output = SetValueToolOutput {
            action: action_result("set_value", Ok(Vec::new()), None),
            verified: None,
            observation: PostActionObservation::default(),
        };

        let value = serde_json::to_value(output).unwrap();

        assert!(!value.as_object().unwrap().contains_key("verified"));
    }

    #[test]
    fn only_set_value_schema_exposes_verified() {
        let tools = ComputerUseLinux::default().mcp_tool_router().list_all();
        for tool in tools {
            let value = serde_json::to_value(&tool).unwrap();
            let Some(properties) = value["outputSchema"]["properties"].as_object() else {
                continue;
            };
            if tool.name == "set_value" {
                assert!(properties.contains_key("verified"));
            } else {
                assert!(!properties.contains_key("verified"), "tool {}", tool.name);
            }
        }
    }

    #[test]
    fn action_tool_output_omits_observation_fields_when_not_requested() {
        let output = ActionToolOutput {
            action: action_result("click", Ok(Vec::new()), None),
            observation: PostActionObservation::default(),
        };
        let value = serde_json::to_value(output).unwrap();
        let object = value.as_object().unwrap();
        for key in [
            "screenshot",
            "screenshot_error",
            "accessibility_tree",
            "accessibility_tree_raw_count",
            "tree_scoped",
            "accessibility_tree_truncated",
            "accessibility_error",
        ] {
            assert!(!object.contains_key(key), "unexpected key {key} in {value}");
        }
    }

    #[test]
    fn mutating_tool_schemas_expose_post_action_capture_parameters() {
        let router = ComputerUseLinux::default().mcp_tool_router();
        let tools = router.list_all();
        for name in [
            "activate_window",
            "move_window",
            "resize_window",
            "click",
            "drag",
            "scroll",
            "press_key",
            "type_text",
            "perform_action",
            "set_value",
        ] {
            let tool = tools
                .iter()
                .find(|tool| tool.name == name)
                .unwrap_or_else(|| panic!("missing tool {name}"));
            let value = serde_json::to_value(tool).unwrap();
            let properties = value["inputSchema"]["properties"]
                .as_object()
                .unwrap_or_else(|| panic!("{name} inputSchema.properties is not an object"));
            for prop in [
                "screenshot_after",
                "include_tree",
                "format",
                "quality",
                "scale",
                "max_width",
                "max_height",
                "max_bytes",
            ] {
                assert!(
                    properties.contains_key(prop),
                    "{name} is missing post-action capture property {prop}"
                );
            }
        }
    }

    #[test]
    fn post_action_capture_executes_after_action_and_preserves_action_ok_on_capture_failure() {
        let dir = std::env::temp_dir().join(format!(
            "cul-post-action-capture-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        struct Cleanup(std::path::PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let _cleanup = Cleanup(dir.clone());

        let sample_png = dir.join("sample.png");
        std::fs::write(&sample_png, solid_png(64, 48)).unwrap();
        let log_path = dir.join("events.log");

        let xdotool = dir.join("xdotool");
        std::fs::write(
            &xdotool,
            "#!/bin/sh\nprintf 'xdotool\\n' >> \"$CUL_POST_ACTION_LOG\"\nexit \"${CUL_POST_ACTION_FAIL_INPUT:-0}\"\n",
        )
        .unwrap();
        std::fs::set_permissions(&xdotool, std::fs::Permissions::from_mode(0o700)).unwrap();

        let gnome_screenshot = dir.join("gnome-screenshot");
        std::fs::write(
            &gnome_screenshot,
            r#"#!/bin/sh
printf 'gnome-screenshot\n' >> "$CUL_POST_ACTION_LOG"
if [ "${CUL_POST_ACTION_FAIL_SCREENSHOT:-0}" = "1" ]; then
  echo "simulated capture failure" >&2
  exit 1
fi
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-f" ] && [ "$#" -ge 2 ]; then
    /bin/cp "$CUL_POST_ACTION_PNG" "$2"
    exit 0
  fi
  shift
done
exit 1
"#,
        )
        .unwrap();
        std::fs::set_permissions(&gnome_screenshot, std::fs::Permissions::from_mode(0o700))
            .unwrap();

        // wmctrl answers only while CUL_WMCTRL_STATE names a file. It lists
        // window 7, applies a resize, and fails every listing after the one
        // that verified the resize.
        let wmctrl = dir.join("wmctrl");
        std::fs::write(
            &wmctrl,
            r#"#!/bin/sh
[ -n "$CUL_WMCTRL_STATE" ] || exit 1
read -r state < "$CUL_WMCTRL_STATE"
case "$1:$state" in
  -l:verified) exit 1 ;;
  -l:resized) echo verified > "$CUL_WMCTRL_STATE"; size="40 30" ;;
  -l:*) size="32 24" ;;
  *) case "$*" in *" -e "*) echo resized > "$CUL_WMCTRL_STATE" ;; esac; exit 0 ;;
esac
echo "0x00000007 0 0 0 0 $size fixture.Fixture host Fixture"
"#,
        )
        .unwrap();
        std::fs::set_permissions(&wmctrl, std::fs::Permissions::from_mode(0o700)).unwrap();

        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "server::post_action_capture_tests::post_action_capture_child",
                "--ignored",
                "--nocapture",
            ])
            .env_clear()
            .env("PATH", &dir)
            .env("HOME", &dir)
            .env("XDG_RUNTIME_DIR", &dir)
            .env("DISPLAY", ":9876")
            .env("WAYLAND_DISPLAY", "")
            .env("XDG_SESSION_TYPE", "x11")
            .env("CU_DISABLE_ABS_POINTER", "1")
            .env("COMPUTER_USE_LINUX_SCREENSHOT_BACKEND", "gnome-screenshot")
            .env("CUL_POST_ACTION_CHILD", "1")
            .env("CUL_POST_ACTION_LOG", &log_path)
            .env("CUL_POST_ACTION_PNG", &sample_png)
            .env(
                "DBUS_SESSION_BUS_ADDRESS",
                format!("unix:path={}/no-bus", dir.display()),
            );
        for key in [
            "DESKTOP_SESSION",
            "HYPRLAND_INSTANCE_SIGNATURE",
            "XAUTHORITY",
            "XDG_SESSION_DESKTOP",
            "XDG_CURRENT_DESKTOP",
        ] {
            command.env(key, "post-action-test");
        }

        let output = crate::command_runner::output_blocking_with_timeout(
            &mut command,
            "post-action capture child",
            Duration::from_secs(15),
        )
        .unwrap();
        assert!(
            String::from_utf8_lossy(&output.stdout).contains("running 1 test"),
            "post-action capture child must execute its assertions"
        );
        assert!(
            output.status.success(),
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[tokio::test]
    #[ignore = "isolated environment subprocess; invoked by post_action_capture_executes_after_action_and_preserves_action_ok_on_capture_failure"]
    async fn post_action_capture_child() {
        assert_eq!(std::env::var("CUL_POST_ACTION_CHILD").as_deref(), Ok("1"));
        let log_path = std::path::PathBuf::from(std::env::var("CUL_POST_ACTION_LOG").unwrap());
        // The fake desktop has a window backend exactly while wmctrl answers.
        let (server, diagnostics_probes) = super::tests::server_with_labelled_diagnostics(
            || false,
            || std::env::var_os("CUL_WMCTRL_STATE").is_some(),
        );
        server.diagnostics.report(false).await;

        // 1. Successful click + post-action JPEG screenshot.
        let click_params: ClickParams = serde_json::from_value(serde_json::json!({
            "x": 120,
            "y": 240,
            "screenshot_after": true,
            "format": "jpeg",
            "quality": 75
        }))
        .unwrap();
        let result = server.click(Parameters(click_params)).await.unwrap();
        assert_ne!(result.is_error, Some(true));
        assert_eq!(result.content.len(), 2);
        let image = result.content[0]
            .as_image()
            .expect("first content block must be the post-action image");
        assert_eq!(image.mime_type, "image/jpeg");
        assert!(!image.data.is_empty());

        let structured = result.structured_content.expect("structured content");
        assert_eq!(structured["ok"], serde_json::json!(true));
        assert_eq!(
            structured["screenshot"]["mime_type"],
            serde_json::json!("image/jpeg")
        );
        assert_eq!(
            structured["screenshot"]["cropped_to_window"],
            serde_json::json!(false)
        );
        assert_eq!(structured["screenshot"]["width"], serde_json::json!(64));
        assert_eq!(structured["screenshot"]["height"], serde_json::json!(48));

        let events = std::fs::read_to_string(&log_path).unwrap();
        assert_eq!(
            events, "xdotool\ngnome-screenshot\n",
            "action must execute strictly before post-action screenshot capture"
        );
        server.diagnostics.report(false).await;
        assert_eq!(
            diagnostics_probes.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "a successful post-action capture keeps the cached diagnostics"
        );

        // 2. Screenshot failure after a successful action must keep ok=true.
        std::fs::write(&log_path, "").unwrap();
        std::env::set_var("CUL_POST_ACTION_FAIL_SCREENSHOT", "1");
        let click_params: ClickParams = serde_json::from_value(serde_json::json!({
            "x": 120,
            "y": 240,
            "screenshot_after": "screen"
        }))
        .unwrap();
        let result = server.click(Parameters(click_params)).await.unwrap();
        std::env::remove_var("CUL_POST_ACTION_FAIL_SCREENSHOT");
        assert_ne!(result.is_error, Some(true));
        assert_eq!(result.content.len(), 1);
        let structured = result.structured_content.expect("structured content");
        assert_eq!(structured["ok"], serde_json::json!(true));
        assert!(structured.get("screenshot").is_none());
        assert!(structured["screenshot_error"]
            .as_str()
            .unwrap()
            .contains("gnome-screenshot"));
        assert!(structured["message"]
            .as_str()
            .unwrap()
            .contains("Post-action screenshot failed:"));
        server.diagnostics.report(false).await;
        assert_eq!(
            diagnostics_probes.load(std::sync::atomic::Ordering::SeqCst),
            2,
            "a failed post-action capture makes the next readiness read probe again"
        );

        // 3. Failed action (relative coordinates without a target) must not capture.
        std::fs::write(&log_path, "").unwrap();
        let bad_click: ClickParams = serde_json::from_value(serde_json::json!({
            "x": 120,
            "y": 240,
            "relative": true,
            "screenshot_after": true
        }))
        .unwrap();
        let result = server.click(Parameters(bad_click)).await.unwrap();
        assert_eq!(result.is_error, Some(true));
        let structured = result.structured_content.expect("structured content");
        assert_eq!(structured["ok"], serde_json::json!(false));
        assert!(structured.get("screenshot").is_none());
        assert!(structured.get("screenshot_error").is_none());
        let events = std::fs::read_to_string(&log_path).unwrap();
        assert!(
            events.is_empty(),
            "failed action must not run xdotool or gnome-screenshot: {events}"
        );

        // 4. activate_window preserves post-action observation notes in message.
        std::env::set_var("CUL_POST_ACTION_FAIL_SCREENSHOT", "1");
        let activate_capture: PostActionCaptureParams =
            serde_json::from_value(serde_json::json!({"screenshot_after": "screen"})).unwrap();
        let activate_result = server
            .finish_activate_window_output(
                ActivateWindowOutput {
                    ok: true,
                    implemented: true,
                    backend: "test".to_string(),
                    focus: None,
                    error: None,
                    permissions_hint: None,
                    received: None,
                },
                &activate_capture,
                &WindowTarget::default(),
            )
            .await
            .unwrap();
        std::env::remove_var("CUL_POST_ACTION_FAIL_SCREENSHOT");
        let activate_structured = activate_result
            .structured_content
            .expect("structured activate_window content");
        assert_eq!(activate_structured["ok"], serde_json::json!(true));
        assert!(activate_structured["message"]
            .as_str()
            .unwrap()
            .contains("Post-action screenshot failed:"));

        // 5. A window capture that falls back to the activated window when the
        // window list fails still makes the next readiness read probe again.
        server.diagnostics.report(false).await;
        let probes = diagnostics_probes.load(std::sync::atomic::Ordering::SeqCst);
        let window: WindowInfo = serde_json::from_value(serde_json::json!({
            "window_id": 7,
            "bounds": {"x": 8, "y": 8, "width": 32, "height": 24},
            "focused": true,
            "hidden": false,
            "backend": "test"
        }))
        .unwrap();
        let window_capture: PostActionCaptureParams =
            serde_json::from_value(serde_json::json!({"screenshot_after": "window"})).unwrap();
        let activate_result = server
            .finish_activate_window_output(
                ActivateWindowOutput {
                    ok: true,
                    implemented: true,
                    backend: "test".to_string(),
                    focus: Some(WindowFocusResult {
                        requested_window: window.clone(),
                        focused_window: Some(window),
                        exact_window_focused: true,
                        app_focused: true,
                        backend: "test".to_string(),
                        note: String::new(),
                    }),
                    error: None,
                    permissions_hint: None,
                    received: None,
                },
                &window_capture,
                &WindowTarget {
                    window_id: Some(7),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        let activate_structured = activate_result
            .structured_content
            .expect("structured activate_window content");
        assert!(activate_structured.get("screenshot_error").is_none());
        assert_eq!(
            activate_structured["screenshot"]["cropped_to_window"],
            serde_json::json!(true)
        );
        server.diagnostics.report(false).await;
        assert_eq!(
            diagnostics_probes.load(std::sync::atomic::Ordering::SeqCst),
            probes + 1,
            "a failed window list makes the next readiness read probe again"
        );

        // 6. Every action that fails, whatever the reason, makes the next
        // readiness read probe again. Input commands fail or are missing, no
        // window backend answers, and no observation has cached an element
        // index.
        std::env::set_var("CUL_POST_ACTION_FAIL_INPUT", "9");
        let failed_actions: Vec<(&str, ToolCall<'_>)> = vec![
            (
                "click",
                Box::pin(server.click(arguments(serde_json::json!({"x": 120, "y": 240})))),
            ),
            (
                "type_text",
                Box::pin(server.type_text(arguments(serde_json::json!({"text": "a"})))),
            ),
            (
                "press_key",
                Box::pin(server.press_key(arguments(serde_json::json!({"key": "Escape"})))),
            ),
            (
                "scroll",
                Box::pin(server.scroll(arguments(
                    serde_json::json!({"x": 120, "y": 240, "direction": "down"}),
                ))),
            ),
            (
                "drag",
                Box::pin(server.drag(arguments(serde_json::json!({
                    "start_x": 10, "start_y": 10, "end_x": 40, "end_y": 40
                })))),
            ),
            (
                "perform_action",
                Box::pin(server.perform_action(arguments(serde_json::json!({"element_index": 3})))),
            ),
            (
                "set_value",
                Box::pin(server.set_value(arguments(
                    serde_json::json!({"element_index": 3, "value": "x"}),
                ))),
            ),
            (
                "activate_window",
                Box::pin(server.activate_window(arguments(serde_json::json!({"window_id": 7})))),
            ),
            (
                "move_window",
                Box::pin(server.move_window(arguments(
                    serde_json::json!({"window_id": 7, "x": 0, "y": 0}),
                ))),
            ),
            (
                "resize_window",
                Box::pin(server.resize_window(arguments(
                    serde_json::json!({"window_id": 7, "width": 40, "height": 30}),
                ))),
            ),
        ];
        for (tool, action) in failed_actions {
            let (result, probed) =
                readiness_probed_after(&server, &diagnostics_probes, action).await;
            assert_eq!(
                result.is_error,
                Some(true),
                "{tool} must fail here: {:?}",
                result.structured_content
            );
            assert!(
                probed,
                "a failed {tool} makes the next readiness read probe again"
            );
        }
        std::env::remove_var("CUL_POST_ACTION_FAIL_INPUT");

        // 7. A resize that lands but whose geometry re-query finds no window
        // backend stays ok and still makes the next readiness read probe again.
        let wmctrl_state = log_path.with_file_name("wmctrl.state");
        std::fs::write(&wmctrl_state, "").unwrap();
        std::env::set_var("CUL_WMCTRL_STATE", &wmctrl_state);
        let (result, probed) = readiness_probed_after(
            &server,
            &diagnostics_probes,
            server.resize_window(arguments(
                serde_json::json!({"window_id": 7, "width": 40, "height": 30}),
            )),
        )
        .await;
        std::env::remove_var("CUL_WMCTRL_STATE");
        let structured = result.structured_content.unwrap();
        assert_eq!(structured["ok"], true, "{structured}");
        assert!(structured["window"].is_null(), "{structured}");
        assert!(
            probed,
            "a failed geometry re-query makes the next readiness read probe again"
        );

        // 8. A get_app_state whose window lookup fails reports readiness from a
        // probe it ran itself, that report carries the call's own screenshot
        // result, and the next call probes again. The raw capture succeeds
        // before the unresolved target refuses the crop.
        server.diagnostics.report(false).await;
        let probes = diagnostics_probes.load(Ordering::SeqCst);
        let state =
            super::tests::app_state_value(&server, serde_json::json!({"window_id": 7})).await;
        assert!(state["window_error"].is_string(), "{state}");
        assert_eq!(
            state["readiness"]["recommended_next_step"],
            format!("probe run {}", probes + 1)
        );
        assert_eq!(state["readiness"]["screenshot_capture_status"], "verified");
        let next = super::tests::app_state_value(
            &server,
            serde_json::json!({"include_screenshot": false}),
        )
        .await;
        assert_eq!(
            next["readiness"]["recommended_next_step"],
            format!("probe run {}", probes + 2),
            "the call after a failed one probes again"
        );

        // 9. A get_app_state that resolves a window the cached report says no
        // backend can list reports refreshed readiness, and the next call
        // reuses that report.
        let cached = server.diagnostics.report(false).await;
        assert!(!cached.readiness.can_query_windows);
        std::fs::write(&wmctrl_state, "").unwrap();
        std::env::set_var("CUL_WMCTRL_STATE", &wmctrl_state);
        let probes = diagnostics_probes.load(Ordering::SeqCst);
        let window_7 = serde_json::json!({"window_id": 7, "include_screenshot": false});
        let state = super::tests::app_state_value(&server, window_7.clone()).await;
        assert_eq!(state["window_context"]["window_id"], 7, "{state}");
        assert_eq!(state["readiness"]["can_query_windows"], true, "{state}");
        assert_eq!(
            state["readiness"]["recommended_next_step"],
            format!("probe run {}", probes + 1)
        );
        let next = super::tests::app_state_value(&server, window_7).await;
        std::env::remove_var("CUL_WMCTRL_STATE");
        assert_eq!(next["window_context"]["window_id"], 7, "{next}");
        assert_eq!(
            next["readiness"]["recommended_next_step"],
            format!("probe run {}", probes + 1),
            "the refreshed report already shows the window backend"
        );

        // 10. A window that wmctrl lists after the GNOME extension failed. A
        // cached report that calls the extension healthy is refreshed for this
        // call, and the next call probes again. One that calls it unhealthy,
        // as on KDE, where it fails on every call, stays cached.
        for (extension_ok, expected) in [
            (true, ["probe run 2", "probe run 3"]),
            (false, ["probe run 1", "probe run 1"]),
        ] {
            let (server, _) = super::tests::server_with_labelled_reports(
                || false,
                move || {
                    let mut report = crate::diagnostics::tests::doctor_report_fixture(false, true);
                    report.windowing.backends.insert(
                        GNOME_SHELL_EXTENSION_BACKEND.to_string(),
                        crate::diagnostics::Check {
                            ok: extension_ok,
                            detail: String::new(),
                        },
                    );
                    report
                },
            );
            server.diagnostics.report(false).await;
            std::fs::write(&wmctrl_state, "").unwrap();
            std::env::set_var("CUL_WMCTRL_STATE", &wmctrl_state);
            let state = super::tests::app_state_value(
                &server,
                serde_json::json!({"window_id": 7, "include_screenshot": false}),
            )
            .await;
            std::env::remove_var("CUL_WMCTRL_STATE");
            assert_eq!(
                state["window_context"]["backend"],
                crate::windows::X11_BACKEND,
                "{state}"
            );
            let next = super::tests::app_state_value(
                &server,
                serde_json::json!({"include_screenshot": false}),
            )
            .await;
            assert_eq!(
                [
                    &state["readiness"]["recommended_next_step"],
                    &next["readiness"]["recommended_next_step"],
                ],
                expected,
                "cached report calls the failed GNOME extension healthy: {extension_ok}"
            );
        }

        // The fake display cannot monitor XKB. Preserve xdotool compatibility
        // and make the unavailable detection explicit, including after capture.
        std::fs::write(&log_path, "").unwrap();
        let params = serde_json::from_value(serde_json::json!({
            "text": "quotes '\"; : / date +%H:%M:%S",
            "screenshot_after": true
        }))
        .unwrap();
        let (result, probed) = readiness_probed_after(
            &server,
            &diagnostics_probes,
            server.type_text(Parameters(params)),
        )
        .await;
        assert!(
            !probed,
            "a successful type_text keeps the cached diagnostics"
        );
        let structured = result.structured_content.unwrap();
        assert_eq!(structured["ok"], true);
        assert!(structured.get("screenshot").is_some());
        let message = structured["message"].as_str().unwrap();
        for expected in [
            "WARNING: X11 keyboard layout",
            "br/ABNT2",
            "before pressing Enter",
            "Field contents were not verified",
        ] {
            assert!(message.contains(expected), "missing {expected}: {message}");
        }
        assert!(
            message.contains("layout-change detection was unavailable"),
            "{message}"
        );
        assert_eq!(
            std::fs::read_to_string(&log_path).unwrap(),
            "xdotool\ngnome-screenshot\n"
        );

        // The text-specific risk does not apply to named key dispatch.
        let (result, probed) = readiness_probed_after(
            &server,
            &diagnostics_probes,
            server.press_key(arguments(serde_json::json!({"key": "Escape"}))),
        )
        .await;
        assert!(
            !probed,
            "a successful press_key keeps the cached diagnostics"
        );
        assert_eq!(result.structured_content.as_ref().unwrap()["ok"], true);
        assert!(!result.structured_content.unwrap()["message"]
            .as_str()
            .unwrap()
            .contains("WARNING: X11 keyboard layout"));

        // A launched failure stays an error and must not claim dispatch.
        std::env::set_var("CUL_POST_ACTION_FAIL_INPUT", "9");
        let params = serde_json::from_value(serde_json::json!({"key": "Escape"})).unwrap();
        let result = server.press_key(Parameters(params)).await.unwrap();
        std::env::remove_var("CUL_POST_ACTION_FAIL_INPUT");
        let structured = result.structured_content.unwrap();
        assert_eq!(structured["ok"], false);
        assert!(!structured["message"]
            .as_str()
            .unwrap()
            .contains("WARNING: X11 keyboard layout"));

        std::fs::write(&log_path, "").unwrap();
        let set_value_capture: PostActionCaptureParams = serde_json::from_value(
            serde_json::json!({"screenshot_after": "screen", "include_tree": true}),
        )
        .unwrap();
        let (output, verified) =
            editable_text_action_result(EditableTextSetOutcome::MismatchAfterDeadline, None);
        let result = server
            .finish_set_value_output(output, verified, &set_value_capture)
            .await
            .unwrap();
        assert_eq!(result.is_error, Some(true));
        assert_eq!(result.content.len(), 2);
        let structured = result.structured_content.unwrap();
        assert_eq!(structured["ok"], false);
        assert_eq!(structured["verified"], false);
        assert_eq!(structured["screenshot"]["width"], 64);
        assert!(structured["accessibility_error"].is_string());
        assert_eq!(
            std::fs::read_to_string(&log_path).unwrap(),
            "gnome-screenshot\n"
        );

        std::fs::write(&log_path, "").unwrap();
        let output = action_result("set_value", Err("pre-dispatch failure".to_string()), None);
        let result = server
            .finish_set_value_output(output, None, &set_value_capture)
            .await
            .unwrap();
        assert_eq!(result.is_error, Some(true));
        let structured = result.structured_content.unwrap();
        assert_eq!(structured["ok"], false);
        assert!(structured.get("screenshot").is_none());
        assert!(structured.get("accessibility_tree").is_none());
        assert!(structured.get("accessibility_error").is_none());
        assert!(std::fs::read_to_string(&log_path).unwrap().is_empty());
    }
}

#[cfg(test)]
mod focus_feedback_tests {
    use super::*;

    #[test]
    fn document_focus_warns_without_claiming_text_was_lost() {
        // A container is only reported once its subtree was searched and nothing
        // inside it holds focus, so the document itself has the keys.
        let element = FocusedElementSummary {
            role: "document web".into(),
            name: Some("Synthetic host".into()),
            editable: false,
            states: vec!["focused".into()],
            is_terminal: false,
        };
        let feedback = describe_focused_element(&element, true);
        assert!(feedback.starts_with("WARNING:"));
        assert!(!feedback.contains("went nowhere"));
        assert_eq!(
            describe_focused_element(&element, false),
            "Focused element: document web \"Synthetic host\" (not editable).",
            "press_key feedback on a page is unchanged"
        );
    }

    #[test]
    fn editable_state_is_enough_without_editable_text_interface() {
        let element = FocusedElementSummary {
            role: "entry".into(),
            name: Some("Synthetic composer".into()),
            editable: false,
            states: vec!["focused".into(), "editable".into()],
            is_terminal: false,
        };
        assert!(describe_focused_element(&element, true).contains("(editable)"));
    }

    #[test]
    fn concrete_non_editable_control_keeps_warning_without_claiming_delivery() {
        let element = FocusedElementSummary {
            role: "button".into(),
            name: None,
            editable: false,
            states: vec!["focused".into()],
            is_terminal: false,
        };
        let feedback = describe_focused_element(&element, true);
        assert!(feedback.starts_with("WARNING:"));
        assert!(feedback.contains("not editable"));
        assert!(!feedback.contains("went nowhere"));
    }
}

#[cfg(test)]
mod tree_spill_server_tests {
    use super::*;
    use std::os::unix::fs::DirBuilderExt;

    fn node(index: u32) -> AccessibilityNode {
        AccessibilityNode {
            index,
            parent_index: index.checked_sub(1),
            depth: 1,
            object_ref: format!(":1.1/org/a11y/atspi/accessible/{index}"),
            role: "push button".into(),
            name: Some(format!("Button {index} {}", "x".repeat(300))),
            description: None,
            child_count: 0,
            bounds: Some(Bounds {
                x: 10,
                y: i32::try_from(index).unwrap() * 20,
                width: 80,
                height: 18,
            }),
            states: vec!["enabled".into(), "visible".into(), "showing".into()],
            actions: Vec::new(),
            value: None,
            text: None,
            supports_editable_text: false,
        }
    }

    fn backend(name: &str) -> (ComputerUseLinux, std::path::PathBuf) {
        let root =
            std::env::temp_dir().join(format!("cul-spill-server-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&root)
            .unwrap();
        let spiller = crate::tree_spill::TreeSpiller::new(Some(root.join("cul").join("trees")));
        (
            ComputerUseLinux {
                tree_spiller: Arc::new(spiller),
                ..ComputerUseLinux::default()
            },
            root,
        )
    }

    #[test]
    fn an_index_past_the_inline_prefix_resolves_against_the_cached_tree() {
        let (backend, root) = backend("index");
        let tree: Vec<_> = (0..300).map(node).collect();
        backend.cache_snapshot(&tree, None);
        let mut inline = tree.clone();
        let (spill, note) = fit_tree(&backend.tree_spiller, &mut inline, tree_budget(2_000));
        let spill = spill.expect("a 300-node tree spills");
        assert!(note.unwrap().contains("get_tree_page"));
        assert!(
            inline.len() < 250,
            "inline prefix is short: {}",
            inline.len()
        );
        // The last node is only in the file, yet element_index actions still find it.
        assert_eq!(
            backend.center_for_cached_node(299),
            Some((50, 299 * 20 + 9))
        );
        assert!(std::path::Path::new(&spill.path).exists());
        // The next snapshot, even a small one, removes the file it no longer matches.
        backend.cache_snapshot(&tree[..3], None);
        assert!(!std::path::Path::new(&spill.path).exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn tree_pages_cover_the_whole_tree_in_order() {
        let tree: Vec<_> = (0..300).map(node).collect();
        let mut seen = Vec::new();
        let mut offset = 0;
        loop {
            let page = tree_page(&tree, offset);
            assert!(!page.nodes.is_empty());
            assert!(
                serde_json::to_string(&page).unwrap().len()
                    <= crate::tree_spill::INLINE_RESULT_BYTES
            );
            assert_eq!(page.node_count, 300);
            seen.extend(page.nodes.iter().map(|node| node.index));
            match page.next_offset {
                Some(next) => offset = next,
                None => break,
            }
        }
        assert_eq!(seen, (0..300).collect::<Vec<_>>());
        assert!(tree_page(&tree, 999).nodes.is_empty());
        assert!(tree_page(&[], 0).message.contains("call get_app_state"));
    }

    #[test]
    fn a_page_holds_one_node_even_past_the_budget() {
        let mut huge = node(0);
        huge.name = Some("x".repeat(crate::tree_spill::INLINE_RESULT_BYTES * 2));
        let page = tree_page(&[huge, node(1)], 0);
        assert_eq!(page.nodes.len(), 1);
        assert_eq!(page.next_offset, Some(1));
    }
}

#[cfg(test)]
mod pixelflux_routing_tests {
    use super::pixelflux_point_for_element;
    use crate::remote_desktop::LogicalMonitor;
    use std::os::unix::fs::PermissionsExt;

    #[tokio::test]
    async fn cancelled_pixelflux_typing_keeps_input_locked() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        async fn read_request(stream: &mut tokio::net::TcpStream) {
            let mut request = Vec::new();
            let mut bytes = [0; 4096];
            loop {
                let n = stream.read(&mut bytes).await.unwrap();
                assert!(n > 0, "fixture request ended early");
                request.extend_from_slice(&bytes[..n]);
                if let Some(end) = request.windows(4).position(|part| part == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&request[..end]);
                    let length: usize = headers
                        .lines()
                        .find_map(|line| line.strip_prefix("Content-Length: "))
                        .unwrap()
                        .parse()
                        .unwrap();
                    if request.len() >= end + 4 + length {
                        return;
                    }
                }
            }
        }
        const TEST: &str =
            "server::pixelflux_routing_tests::cancelled_pixelflux_typing_keeps_input_locked";
        if std::env::var_os("CUL_CANCEL_PIXELFLUX_CHILD").is_none() {
            let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("target/pixelflux-cancel-fixture");
            std::fs::create_dir_all(&root).unwrap();
            let systemctl = root.join("systemctl");
            std::fs::write(&systemctl, "#!/bin/sh\nexit 0\n").unwrap();
            std::fs::set_permissions(&systemctl, std::fs::Permissions::from_mode(0o700)).unwrap();
            let status = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", TEST, "--nocapture"])
                .env_clear()
                .env("CUL_CANCEL_PIXELFLUX_CHILD", "1")
                .env("PATH", &root)
                .env("HOME", &root)
                .env("XDG_RUNTIME_DIR", &root)
                .env(
                    "DBUS_SESSION_BUS_ADDRESS",
                    format!("unix:path={}/no-bus", root.display()),
                )
                .env("DISPLAY", ":9876")
                .env("WAYLAND_DISPLAY", "no-wayland")
                .env("XDG_CURRENT_DESKTOP", "fixture")
                .env("XDG_SESSION_TYPE", "wayland")
                .env("COMPUTER_USE_LINUX_FORCE_YDOTOOL_POINTER", "1")
                .env("COMPUTER_USE_LINUX_FORCE_YDOTOOL_KEYBOARD", "1")
                .env("CU_DISABLE_ABS_POINTER", "1")
                .status()
                .unwrap();
            assert!(
                status.success(),
                "cancelled pixelflux request unlocked input"
            );
            return;
        }
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        std::env::set_var(
            "PIXELFLUX_CU",
            listener.local_addr().unwrap().port().to_string(),
        );
        std::env::set_var("PIXELFLUX_CU_TOKEN", "fixture-token");
        let (sent, started) = tokio::sync::oneshot::channel();
        let (finish, finished) = tokio::sync::oneshot::channel();
        let peer = tokio::spawn(async move {
            let reply = b"HTTP/1.1 200 OK\r\nContent-Length: 15\r\n\r\n{\"result\":\"ok\"}";
            let (mut probe, _) = listener.accept().await.unwrap();
            read_request(&mut probe).await;
            probe.write_all(reply).await.unwrap();
            drop(probe);
            let (mut action, _) = listener.accept().await.unwrap();
            read_request(&mut action).await;
            sent.send(()).unwrap();
            finished.await.unwrap();
            action.write_all(reply).await.unwrap();
        });
        let server = super::ComputerUseLinux::default();
        let input_lock = std::sync::Arc::clone(&server.input_operation_lock);
        let caller = tokio::spawn(async move {
            let params =
                serde_json::from_value(serde_json::json!({"text": "fixture typing"})).unwrap();
            server.dispatch_type_text(params).await
        });
        tokio::time::timeout(std::time::Duration::from_secs(5), started)
            .await
            .unwrap()
            .unwrap();
        caller.abort();
        let _ = caller.await;
        let still_locked = input_lock.try_lock().is_err();
        finish.send(()).unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(2), peer)
            .await
            .unwrap()
            .unwrap();
        let _guard = tokio::time::timeout(std::time::Duration::from_secs(2), input_lock.lock())
            .await
            .unwrap();
        assert!(
            still_locked,
            "typing continued after its operation lock was released"
        );
    }

    fn monitor(width: i32, height: i32) -> LogicalMonitor {
        LogicalMonitor {
            x: 0,
            y: 0,
            width,
            height,
            scale: 2.0,
        }
    }

    #[test]
    fn pixelflux_point_for_element_scales() {
        let bounds = (166, 714, 54, 46);
        let layout = [monitor(1432, 768)];
        assert_eq!(
            pixelflux_point_for_element(bounds, (2864, 1536), &layout),
            Some((386, 1474))
        );
        assert_eq!(
            pixelflux_point_for_element(bounds, (1432, 768), &layout),
            Some((193, 737))
        );
        assert_eq!(
            pixelflux_point_for_element(bounds, (2864, 1000), &layout),
            None
        );
        assert_eq!(pixelflux_point_for_element(bounds, (2864, 1536), &[]), None);
    }

    #[test]
    fn pixelflux_click_uses_new_geometry_after_resize() {
        let server = super::ComputerUseLinux::default();
        let bounds = (166, 714, 54, 46);
        server.cache_desktop_size(2864, 1536);
        server.cache_desktop_size(1428, 1536);
        let capture = server.desktop_size.lock().unwrap().unwrap();
        let layout = [monitor(714, 768)];
        assert_eq!(
            pixelflux_point_for_element(bounds, capture, &layout),
            Some((386, 1474))
        );
        assert_eq!(
            pixelflux_point_for_element(bounds, (2864, 1536), &layout),
            None
        );
    }
    /// Clicks in a child process against a fake pixelflux that answers the probe, then
    /// `action_reply` (or hangs up after reading the action when `None`).
    /// Returns the click message and what a recording `ydotool` received.
    fn click_after_probe(
        test: &str,
        mode: &str,
        action_reply: Option<&'static str>,
    ) -> (String, String) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let ok = "HTTP/1.1 200 X\r\nContent-Length: 18\r\nConnection: close\r\n\r\n{\"text\":\"X=0,Y=0\"}";
            for reply in [Some(ok), action_reply] {
                let (mut sock, _) = listener.accept().unwrap();
                let mut buf = [0u8; 2048];
                let _ = std::io::Read::read(&mut sock, &mut buf);
                if let Some(reply) = reply {
                    let _ = std::io::Write::write_all(&mut sock, reply.as_bytes());
                }
            }
        });
        let dir = std::env::temp_dir().join(format!("cul-pf-{mode}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let log = dir.join("ydotool.log");
        let out = dir.join("out.txt");
        let ydotool = dir.join("ydotool");
        std::fs::write(
            &ydotool,
            "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$CUL_PIXELFLUX_LOG\"\nexit 0\n",
        )
        .unwrap();
        std::fs::set_permissions(&ydotool, std::fs::Permissions::from_mode(0o700)).unwrap();
        let systemctl = dir.join("systemctl");
        std::fs::write(&systemctl, "#!/bin/sh\nexit 0\n").unwrap();
        std::fs::set_permissions(&systemctl, std::fs::Permissions::from_mode(0o700)).unwrap();
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", test, "--nocapture"])
            .env_clear()
            .env("PATH", &dir)
            .env("HOME", &dir)
            .env("XDG_RUNTIME_DIR", &dir)
            .env(
                "DBUS_SESSION_BUS_ADDRESS",
                format!("unix:path={}/no-bus", dir.display()),
            )
            .env("DISPLAY", ":9876")
            .env("WAYLAND_DISPLAY", "no-wayland")
            .env("XDG_CURRENT_DESKTOP", "fixture")
            .env("XDG_SESSION_TYPE", "wayland")
            .env("COMPUTER_USE_LINUX_FORCE_YDOTOOL_POINTER", "1")
            .env("CUL_PIXELFLUX_CHILD", mode)
            .env("CUL_PIXELFLUX_LOG", &log)
            .env("CUL_PIXELFLUX_OUT", &out)
            .env("PIXELFLUX_CU", port.to_string())
            .env("PIXELFLUX_CU_TOKEN", "secret")
            .env("CU_DISABLE_ABS_POINTER", "1")
            .status()
            .unwrap();
        assert!(status.success(), "{status}");
        let message = std::fs::read_to_string(&out).unwrap();
        let recorded = std::fs::read_to_string(&log).unwrap_or_default();
        let _ = std::fs::remove_dir_all(&dir);
        (message, recorded)
    }

    async fn record_click_message() {
        for (button, count) in [("right", 2), ("middle", 3)] {
            let guard = std::sync::Arc::new(
                std::sync::Arc::new(tokio::sync::Mutex::new(()))
                    .lock_owned()
                    .await,
            );
            assert!(super::ComputerUseLinux::default()
                .try_pixelflux_click(10, 20, false, None, Some(button), count, None, guard)
                .await
                .is_none());
        }
        if std::env::var("CUL_PIXELFLUX_CHILD").as_deref() == Ok("scroll") {
            let params = serde_json::from_value(serde_json::json!({"direction": "down"})).unwrap();
            let result = super::ComputerUseLinux::default()
                .scroll(rmcp::handler::server::wrapper::Parameters(params))
                .await
                .unwrap();
            std::fs::write(
                std::env::var("CUL_PIXELFLUX_OUT").unwrap(),
                result.structured_content.unwrap()["message"]
                    .as_str()
                    .unwrap(),
            )
            .unwrap();
            return;
        }
        let params = serde_json::from_value(serde_json::json!({"x": 10, "y": 20})).unwrap();
        let result = super::ComputerUseLinux::default()
            .click(rmcp::handler::server::wrapper::Parameters(params))
            .await
            .unwrap();
        let message = result.structured_content.unwrap()["message"]
            .as_str()
            .unwrap()
            .to_string();
        std::fs::write(std::env::var("CUL_PIXELFLUX_OUT").unwrap(), message).unwrap();
    }

    #[tokio::test]
    async fn pixelflux_untargeted_scroll_uses_current_cursor() {
        if std::env::var("CUL_PIXELFLUX_CHILD").as_deref() == Ok("scroll") {
            return record_click_message().await;
        }
        let (message, recorded) = click_after_probe(
            "server::pixelflux_routing_tests::pixelflux_untargeted_scroll_uses_current_cursor",
            "scroll",
            Some("HTTP/1.1 200 X\r\nContent-Length: 15\r\n\r\n{\"result\":\"ok\"}"),
        );
        assert!(
            message.contains("Action sent through pixelflux"),
            "{message}"
        );
        assert!(recorded.is_empty(), "{recorded}");
    }

    #[tokio::test]
    async fn pixelflux_malformed_reply_reports_unknown_outcome() {
        if std::env::var("CUL_PIXELFLUX_CHILD").as_deref() == Ok("malformed") {
            return record_click_message().await;
        }
        let (message, recorded) = click_after_probe(
            "server::pixelflux_routing_tests::pixelflux_malformed_reply_reports_unknown_outcome",
            "malformed",
            Some("HTTP/1.1 200 X\r\nContent-Length: 4\r\n\r\noops"),
        );
        assert!(message.contains("it may have run"), "{message}");
        assert!(!message.contains("did not accept"), "{message}");
        assert!(recorded.is_empty(), "{recorded}");
    }

    #[tokio::test]
    async fn pixelflux_failure_after_send_is_not_replayed() {
        if std::env::var("CUL_PIXELFLUX_CHILD").as_deref() == Ok("500") {
            return record_click_message().await;
        }
        let (message, recorded) = click_after_probe(
            "server::pixelflux_routing_tests::pixelflux_failure_after_send_is_not_replayed",
            "500",
            Some("HTTP/1.1 500 X\r\nContent-Length: 14\r\nConnection: close\r\n\r\n{\"error\":\"no\"}"),
        );
        assert!(message.contains("pixelflux did not accept"), "{message}");
        assert!(!message.contains("secret"), "{message}");
        assert!(recorded.is_empty(), "{recorded}");
    }

    #[tokio::test]
    async fn pixelflux_hangup_after_send_reports_unknown_outcome() {
        if std::env::var("CUL_PIXELFLUX_CHILD").as_deref() == Ok("hangup") {
            return record_click_message().await;
        }
        let (message, recorded) = click_after_probe(
            "server::pixelflux_routing_tests::pixelflux_hangup_after_send_reports_unknown_outcome",
            "hangup",
            None,
        );
        assert!(message.contains("it may have run"), "{message}");
        assert!(!message.contains("did not accept"), "{message}");
        assert!(recorded.is_empty(), "{recorded}");
    }

    #[tokio::test]
    async fn pixelflux_probe_failure_falls_through() {
        if std::env::var("CUL_PIXELFLUX_CHILD").as_deref() == Ok("down") {
            let server = super::ComputerUseLinux::default();
            let params = serde_json::from_value(serde_json::json!({"x": 10, "y": 20})).unwrap();
            let without = server
                .click(rmcp::handler::server::wrapper::Parameters(params))
                .await
                .unwrap();
            std::env::set_var("PIXELFLUX_CU", "1");
            std::env::set_var("PIXELFLUX_CU_TOKEN", "secret");
            let params = serde_json::from_value(serde_json::json!({"x": 10, "y": 20})).unwrap();
            let with = server
                .click(rmcp::handler::server::wrapper::Parameters(params))
                .await
                .unwrap();
            let left = without.structured_content.unwrap()["message"].to_string();
            let right = with.structured_content.unwrap()["message"].to_string();
            assert_eq!(left, right, "unreachable pixelflux changed the fallback");
            assert!(!right.contains("secret"));
            return;
        }
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "server::pixelflux_routing_tests::pixelflux_probe_failure_falls_through",
                "--nocapture",
            ])
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("CUL_PIXELFLUX_CHILD", "down")
            .env("CU_DISABLE_ABS_POINTER", "1")
            .env("DBUS_SESSION_BUS_ADDRESS", "unix:path=/tmp/cul-no-bus")
            .env("XDG_SESSION_TYPE", "tty")
            .status()
            .unwrap();
        assert!(status.success(), "{status}");
    }
}
