//! On-screen indicator for agent activity.
//!
//! The MCP server reports each desktop action to the
//! `computer-use-linux-indicator` overlay as one JSON datagram on a socket in
//! `$XDG_RUNTIME_DIR`. The overlay draws a software cursor that glides to the
//! target, keycaps for key presses, an edge glow and a status pill. The server
//! starts the overlay on the first action. Set `COMPUTER_USE_LINUX_INDICATOR=0`
//! to turn it off.
//!
//! Every server keeps the overlay out of its screen captures, even with its
//! own indicator disabled, because one overlay serves all agents in the
//! session. For the length of a capture the server holds a shared lock on
//! [`capture_lock_path`], and the overlay draws nothing while anyone holds it.
//! The kernel drops the lock of a server that dies, so a crash cannot freeze
//! the overlay. `capture: begin` and `end` datagrams make the overlay react
//! at once; it answers `begin` with [`CAPTURE_REPLY_SHOWN`] or
//! [`CAPTURE_REPLY_EMPTY`], so a capture waits for the compositor only when
//! something was on screen.

use std::{
    env,
    fs::{File, OpenOptions, TryLockError},
    io::{self, ErrorKind},
    os::linux::net::SocketAddrExt,
    os::unix::net::{SocketAddr, UnixDatagram},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicU32, Ordering},
        Mutex, OnceLock,
    },
    time::{Duration, Instant},
};

use rmcp::{
    model::{Implementation, RequestMetaObject},
    Peer, RoleServer,
};
use serde::{Deserialize, Serialize};

/// Overlay binary name, resolved next to the server binary or on `PATH`.
pub const INDICATOR_BINARY: &str = "codex-computer-use-indicator";
/// Socket file name inside `$XDG_RUNTIME_DIR`.
pub const SOCKET_NAME: &str = "computer-use-linux-indicator.sock";
/// Reply to `capture: begin` when the overlay had something on screen.
pub const CAPTURE_REPLY_SHOWN: &[u8] = b"shown";
/// Reply to `capture: begin` when nothing was on screen.
pub const CAPTURE_REPLY_EMPTY: &[u8] = b"empty";

const DISABLE_ENV: &str = "COMPUTER_USE_LINUX_INDICATOR";
const HIDE_TEXT_ENV: &str = "COMPUTER_USE_LINUX_INDICATOR_HIDE_TEXT";
const AGENT_ENV: &str = "COMPUTER_USE_LINUX_AGENT_NAME";
const CODEX_AGENT_ENV: &str = "CODEX_COMPUTER_USE_AGENT_NAME";
const BINARY_ENV: &str = "COMPUTER_USE_LINUX_INDICATOR_BIN";

/// The agent name shown on the indicator, from `CODEX_COMPUTER_USE_AGENT_NAME`
/// or its standalone alias `COMPUTER_USE_LINUX_AGENT_NAME`. A blank value
/// counts as unset.
fn agent_override(lookup: impl Fn(&str) -> Option<String>) -> Option<String> {
    [CODEX_AGENT_ENV, AGENT_ENV]
        .into_iter()
        .filter_map(lookup)
        .find(|name| !name.trim().is_empty())
}

/// How long the overlay cursor takes to reach a target. Pointer actions wait
/// this long so the cursor lands before the real input happens.
pub const GLIDE: Duration = Duration::from_millis(350);
/// Time for the compositor to drop overlay surfaces before a capture.
pub const HIDE_SETTLE: Duration = Duration::from_millis(120);
/// How long to wait for the overlay to answer `capture: begin`.
/// Allow short compositor stalls without capturing an unconfirmed overlay.
const CAPTURE_REPLY_WAIT: Duration = Duration::from_millis(300);
const SPAWN_WAIT: Duration = Duration::from_secs(1);
const TEXT_LIMIT: usize = 64;

/// A server starting or finishing a screen capture.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Capture {
    Begin,
    End,
}

/// One overlay update.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct IndicatorEvent {
    /// Capture phase; such an event carries nothing else.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capture: Option<Capture>,
    /// Display name of the agent, e.g. `Claude`.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub agent: String,
    /// MCP tool name, e.g. `click`.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub tool: String,
    /// Target in screenshot pixels, the coordinate space of the click tools.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub x: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub y: Option<i32>,
    /// Size of the full-desktop capture that `x`/`y` refer to. The overlay
    /// spreads it over the logical output layout, as the compositor does for
    /// the absolute pointer. Without it `x`/`y` are taken as logical.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub space: Option<(u32, u32)>,
    /// Key chord parts for `press_key`, e.g. `["ctrl", "l"]`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub keys: Vec<String>,
    /// Typed text (tail only, possibly masked).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

/// Path of the overlay socket, or `None` without `XDG_RUNTIME_DIR`.
pub fn socket_path() -> Option<PathBuf> {
    env::var_os("XDG_RUNTIME_DIR")
        .filter(|dir| !dir.is_empty())
        .map(|dir| Path::new(&dir).join(SOCKET_NAME))
}

/// Lock file held shared by every server for the length of a capture.
pub fn capture_lock_path(socket: &Path) -> PathBuf {
    socket.with_extension("capture")
}

/// Whether the session uses the GNOME Shell renderer.
pub fn is_gnome_session() -> bool {
    env::var("XDG_CURRENT_DESKTOP")
        .unwrap_or_default()
        .split(':')
        .any(|desktop| desktop.eq_ignore_ascii_case("gnome"))
}

/// Updates the indicator in the verified GNOME Shell extension. The age keeps
/// a capture resume from extending the idle deadline.
pub async fn show_gnome_indicator(
    connection: &zbus::Connection,
    event: &IndicatorEvent,
    age_ms: u32,
) -> anyhow::Result<()> {
    let proxy = crate::windowing::backends::gnome::verified_extension_proxy(connection).await?;
    let _: () = proxy
        .call("ShowIndicator", &(serde_json::to_string(event)?, age_ms))
        .await?;
    Ok(())
}

/// State of the activity renderer in the verified GNOME Shell extension.
pub async fn gnome_indicator_state(connection: &zbus::Connection) -> anyhow::Result<String> {
    let proxy = crate::windowing::backends::gnome::verified_extension_proxy(connection).await?;
    Ok(proxy.call("GetIndicatorState", &()).await?)
}

/// Hides the GNOME indicator and reports whether compositor settling is needed.
/// An absent or older extension cannot show an indicator.
pub async fn hide_gnome_indicator(connection: &zbus::Connection) -> anyhow::Result<bool> {
    let bus = zbus::fdo::DBusProxy::new(connection).await?;
    if !bus
        .name_has_owner(crate::identity::DBUS_SERVICE.try_into()?)
        .await?
    {
        return Ok(false);
    }
    let proxy = crate::windowing::backends::gnome::verified_extension_proxy(connection).await?;
    match proxy.call("HideIndicator", &()).await {
        Ok(shown) => Ok(shown),
        Err(error) if error.to_string().contains("UnknownMethod") => Ok(false),
        Err(error) => Err(error.into()),
    }
}

async fn settle_gnome_indicator_if_present() -> anyhow::Result<()> {
    // Unit-test senders must never connect to the real desktop bus. A server
    // launched without desktop metadata can still share GNOME's renderer.
    let runtime_bus = env::var_os("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            // SAFETY: geteuid takes no arguments and only reads the process uid.
            PathBuf::from(format!("/run/user/{}", unsafe { libc::geteuid() }))
        })
        .join("bus");
    if cfg!(test)
        || (!is_gnome_session()
            && env::var_os("DBUS_SESSION_BUS_ADDRESS").is_none()
            && !runtime_bus.exists())
    {
        return Ok(());
    }
    let probe = tokio::time::timeout(CAPTURE_REPLY_WAIT, async {
        let connection = zbus::Connection::session().await?;
        let bus = zbus::fdo::DBusProxy::new(&connection).await?;
        let present = bus
            .name_has_owner(crate::identity::DBUS_SERVICE.try_into()?)
            .await?;
        Ok::<_, anyhow::Error>(present.then_some(connection))
    })
    .await;
    let connection = match probe {
        Ok(Ok(Some(connection))) => connection,
        Ok(Ok(None)) => return Ok(()),
        Ok(Err(error)) if is_gnome_session() => return Err(error),
        Err(error) if is_gnome_session() => return Err(error.into()),
        _ => return Ok(()),
    };
    let hidden = tokio::time::timeout(CAPTURE_REPLY_WAIT, hide_gnome_indicator(&connection))
        .await
        .map_err(|_| {
            anyhow::anyhow!("GNOME indicator did not acknowledge hiding before capturing")
        })??;
    if hidden {
        tokio::time::sleep(HIDE_SETTLE).await;
    }
    Ok(())
}

/// Maps an MCP `clientInfo` to the name shown on screen.
pub fn agent_display_name(name: &str, title: Option<&str>) -> String {
    let lower = name.to_ascii_lowercase();
    let known = [
        ("claude", "Claude"),
        ("codex", "Codex"),
        ("opencode", "OpenCode"),
        ("gemini", "Gemini"),
        ("antigravity", "Antigravity"),
        ("hermes", "Hermes"),
        ("cursor", "Cursor"),
        ("goose", "Goose"),
    ];
    if let Some((_, display)) = known.iter().find(|(needle, _)| lower.contains(needle)) {
        return (*display).to_string();
    }
    // Pi's native extension identifies as `computer-use-linux-pi`.
    if lower == "pi" || lower.starts_with("pi-") || lower.ends_with("-pi") {
        return "Pi".to_string();
    }
    if let Some(title) = title.map(str::trim).filter(|title| !title.is_empty()) {
        return title.to_string();
    }
    match name.trim() {
        "" => "Agent".to_string(),
        other => other.to_string(),
    }
}

fn disabled_value(value: Option<&str>) -> bool {
    matches!(
        value
            .map(|value| value.trim().to_ascii_lowercase())
            .as_deref(),
        Some("0" | "false" | "off" | "no")
    )
}

/// Last `TEXT_LIMIT` characters, or a fixed mask that does not reveal the
/// length.
fn shown_text(text: &str, mask: bool) -> String {
    if mask {
        return "••••••••".to_string();
    }
    let chars: Vec<char> = text.chars().collect();
    chars[chars.len().saturating_sub(TEXT_LIMIT)..]
        .iter()
        .collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Overlay {
    NotStarted,
    Started(Instant),
    /// No Wayland session, no binary, or the overlay could not start (for
    /// example GNOME, which has no layer-shell). Not retried by this server.
    Unavailable,
}

/// Server-side sender. Action reports are cheap no-ops when disabled;
/// capture holds work regardless.
#[derive(Debug)]
pub(crate) struct Indicator {
    enabled: bool,
    mask_text: bool,
    agent_override: Option<String>,
    peer: OnceLock<Peer<RoleServer>>,
    socket: Option<UnixDatagram>,
    /// The overlay's socket.
    path: Option<PathBuf>,
    overlay: Mutex<Overlay>,
    /// Replies share one socket; captures must not consume each other's ACKs.
    capture_handshake: tokio::sync::Mutex<()>,
}

impl Default for Indicator {
    fn default() -> Self {
        // Unit tests build servers freely; they must not touch a real overlay.
        let live = !cfg!(test);
        let socket = live
            .then(client_socket)
            .flatten()
            .filter(|socket| socket.set_nonblocking(true).is_ok());
        Self {
            enabled: socket.is_some()
                && !disabled_value(
                    env::var("CODEX_COMPUTER_USE_INDICATOR")
                        .or_else(|_| env::var(DISABLE_ENV))
                        .ok()
                        .as_deref(),
                ),
            mask_text: env::var("CODEX_COMPUTER_USE_INDICATOR_HIDE_TEXT")
                .or_else(|_| env::var(HIDE_TEXT_ENV))
                .ok()
                .as_deref()
                == Some("1"),
            agent_override: agent_override(|key| env::var(key).ok()),
            peer: OnceLock::new(),
            socket,
            path: live.then(socket_path).flatten(),
            overlay: Mutex::new(Overlay::NotStarted),
            capture_handshake: tokio::sync::Mutex::new(()),
        }
    }
}

tokio::task_local! {
    /// The calling client's display name, scoped to one HTTP request.
    static REQUEST_AGENT: String;
}

/// Runs `future` with its events naming `agent`, when given.
pub(crate) async fn with_request_agent<F: std::future::Future>(
    agent: Option<String>,
    future: F,
) -> F::Output {
    match agent {
        Some(agent) => REQUEST_AGENT.scope(agent, future).await,
        None => future.await,
    }
}

/// The display name for one request. A request that negotiates its own
/// protocol version is named only by its `_meta`: rmcp gives it a placeholder
/// peer (`rmcp`) instead of a session's `initialize`.
pub(crate) fn request_agent_name(
    meta: &RequestMetaObject,
    session: Option<Implementation>,
) -> Option<String> {
    let info = if meta.protocol_version().is_some() {
        meta.client_info()
    } else {
        session
    };
    info.filter(|info| !info.name.trim().is_empty())
        .map(|info| agent_display_name(&info.name, info.title.as_deref()))
}

impl Indicator {
    /// Remembers the MCP client so events carry its name.
    pub(crate) fn attach(&self, peer: Peer<RoleServer>) {
        let _ = self.peer.set(peer);
    }

    fn agent(&self) -> String {
        if let Some(name) = &self.agent_override {
            return name.clone();
        }
        if let Ok(name) = REQUEST_AGENT.try_with(String::clone) {
            return name;
        }
        self.peer
            .get()
            .and_then(Peer::peer_info)
            .map(|info| {
                agent_display_name(&info.client_info.name, info.client_info.title.as_deref())
            })
            .unwrap_or_else(|| "Agent".to_string())
    }

    fn event(&self, tool: &str) -> IndicatorEvent {
        IndicatorEvent {
            agent: self.agent(),
            tool: tool.to_string(),
            ..IndicatorEvent::default()
        }
    }

    pub(crate) fn enabled(&self) -> bool {
        self.enabled
    }

    /// Moves the overlay cursor to a point in screenshot pixels and waits until
    /// it lands. Without the capture size the point cannot be placed, so only
    /// the action is shown.
    pub(crate) async fn pointer(&self, tool: &str, (x, y): (i32, i32), space: Option<(u32, u32)>) {
        let Some(space) = space else {
            return self.action(tool).await;
        };
        let event = IndicatorEvent {
            x: Some(x),
            y: Some(y),
            space: Some(space),
            ..self.event(tool)
        };
        if self.send(&event).await {
            tokio::time::sleep(GLIDE).await;
        }
    }

    /// Moves the overlay cursor without waiting, e.g. to a drop point.
    pub(crate) async fn follow(&self, tool: &str, (x, y): (i32, i32), space: Option<(u32, u32)>) {
        let Some(space) = space else {
            return;
        };
        let event = IndicatorEvent {
            x: Some(x),
            y: Some(y),
            space: Some(space),
            ..self.event(tool)
        };
        self.send(&event).await;
    }

    /// Reports an action that moves no pointer.
    pub(crate) async fn action(&self, tool: &str) {
        self.send(&self.event(tool)).await;
    }

    pub(crate) async fn keys(&self, chord: &str, secret: bool) {
        let event = IndicatorEvent {
            // Character-by-character password entry must not leak through keycaps.
            keys: if self.mask_text || secret {
                vec!["••••••••".to_string()]
            } else {
                chord
                    .split('+')
                    .map(str::trim)
                    .filter(|key| !key.is_empty())
                    .map(str::to_string)
                    .collect()
            },
            ..self.event("press_key")
        };
        self.send(&event).await;
    }

    /// Shows entered text; `set_value` and `secret` are always masked.
    pub(crate) async fn text(&self, tool: &str, text: &str, secret: bool) {
        let event = IndicatorEvent {
            // An app can change a settable field to a password after the snapshot.
            text: Some(shown_text(
                text,
                self.mask_text || secret || tool == "set_value",
            )),
            ..self.event(tool)
        };
        self.send(&event).await;
    }

    /// Keeps every overlay off the screen until the returned hold drops, and
    /// waits until the compositor has dropped whatever was showing. Works with
    /// this server's indicator disabled too: another agent's overlay must not
    /// end up in this server's captures. Fails when a running overlay cannot
    /// confirm it has hidden, rather than capture it.
    pub(crate) async fn hold_for_capture(&self) -> anyhow::Result<CaptureHold<'_>> {
        let _handshake = self.capture_handshake.lock().await;
        let hold = CaptureHold {
            indicator: self,
            lock: self.take_capture_lock().await?,
        };
        let Some(socket) = &self.socket else {
            if self.path.is_some() {
                anyhow::bail!("no client socket to confirm the action indicator overlay is hidden");
            }
            return Ok(hold);
        };
        let mut reply = [0u8; 16];
        // Drop a late answer to an earlier request.
        while socket.recv(&mut reply).is_ok() {}
        let begin = IndicatorEvent {
            capture: Some(Capture::Begin),
            ..Default::default()
        };
        let deadline = Instant::now() + CAPTURE_REPLY_WAIT;
        loop {
            match self.send_raw(&begin) {
                Ok(()) => break,
                // No overlay is running; the lock keeps one that starts now blank.
                Err(error)
                    if matches!(
                        error.kind(),
                        ErrorKind::NotFound | ErrorKind::ConnectionRefused
                    ) =>
                {
                    settle_gnome_indicator_if_present().await?;
                    return Ok(hold);
                }
                // A full queue: the overlay is running but not reading.
                Err(error)
                    if error.kind() == ErrorKind::WouldBlock && Instant::now() < deadline =>
                {
                    tokio::time::sleep(Duration::from_millis(5)).await
                }
                Err(error) => anyhow::bail!(
                    "could not hide the action indicator overlay before capturing: {error}"
                ),
            }
        }
        let deadline = Instant::now() + CAPTURE_REPLY_WAIT;
        while Instant::now() < deadline {
            match socket.recv_from(&mut reply) {
                // Only the overlay's socket, in the user's private runtime
                // directory, can confirm that its surfaces were removed.
                Ok((len, from)) if from.as_pathname() == self.path.as_deref() => {
                    match &reply[..len] {
                        CAPTURE_REPLY_EMPTY => return Ok(hold),
                        CAPTURE_REPLY_SHOWN => {
                            tokio::time::sleep(HIDE_SETTLE).await;
                            return Ok(hold);
                        }
                        _ => anyhow::bail!(
                            "invalid action indicator overlay acknowledgement before capturing"
                        ),
                    }
                }
                Ok(_) => {}
                Err(error) if error.kind() == ErrorKind::WouldBlock => {
                    tokio::time::sleep(Duration::from_millis(5)).await
                }
                Err(error) => anyhow::bail!(
                    "could not confirm the action indicator overlay is hidden before capturing: {error}"
                ),
            }
        }
        anyhow::bail!("action indicator overlay did not acknowledge hiding before capturing")
    }

    async fn take_capture_lock(&self) -> anyhow::Result<Option<File>> {
        let Some(path) = self.path.as_deref() else {
            return Ok(None);
        };
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(capture_lock_path(path))
            .map_err(|error| anyhow::anyhow!("could not open indicator capture lock: {error}"))?;
        // The overlay tests the lock exclusively for an instant; retry past it.
        for _ in 0..20 {
            match file.try_lock_shared() {
                Ok(()) => return Ok(Some(file)),
                Err(TryLockError::WouldBlock) => tokio::time::sleep(Duration::from_millis(1)).await,
                Err(TryLockError::Error(error)) => {
                    anyhow::bail!("could not take indicator capture lock: {error}")
                }
            }
        }
        anyhow::bail!("indicator capture lock remained busy")
    }

    fn send_raw(&self, event: &IndicatorEvent) -> io::Result<()> {
        let (Some(socket), Some(path)) = (&self.socket, &self.path) else {
            return Err(ErrorKind::NotFound.into());
        };
        socket.send_to(&serde_json::to_vec(event)?, path).map(drop)
    }

    /// Sends an event, starting the overlay first if it is not running.
    async fn send(&self, event: &IndicatorEvent) -> bool {
        if !self.enabled {
            return false;
        }
        let (Some(socket), Some(path)) = (&self.socket, &self.path) else {
            return false;
        };
        let Ok(payload) = serde_json::to_vec(event) else {
            return false;
        };
        let sent = match socket.send_to(&payload, path) {
            Ok(_) => true,
            Err(error)
                if matches!(
                    error.kind(),
                    ErrorKind::NotFound | ErrorKind::ConnectionRefused
                ) =>
            {
                self.start_overlay(path).await && socket.send_to(&payload, path).is_ok()
            }
            Err(_) => false,
        };
        sent
    }

    async fn start_overlay(&self, path: &Path) -> bool {
        {
            let Ok(mut overlay) = self.overlay.lock() else {
                return false;
            };
            match *overlay {
                Overlay::Unavailable => return false,
                // Still starting, or exited after idling: allow a restart later.
                Overlay::Started(at) if at.elapsed() < SPAWN_WAIT => return false,
                _ => {}
            }
            if (!is_gnome_session() && env::var_os("WAYLAND_DISPLAY").is_none())
                || spawn_overlay().is_err()
            {
                *overlay = Overlay::Unavailable;
                return false;
            }
            *overlay = Overlay::Started(Instant::now());
        }
        let deadline = Instant::now() + SPAWN_WAIT;
        while Instant::now() < deadline {
            if UnixDatagram::unbound()
                .and_then(|probe| probe.connect(path))
                .is_ok()
            {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        if let Ok(mut overlay) = self.overlay.lock() {
            *overlay = Overlay::Unavailable;
        }
        false
    }
}

/// A capture in progress. Dropping it, also when the request is cancelled,
/// releases the lock and tells the overlay it may draw again.
pub(crate) struct CaptureHold<'a> {
    indicator: &'a Indicator,
    lock: Option<File>,
}

impl Drop for CaptureHold<'_> {
    fn drop(&mut self) {
        // A concurrently spawning child can inherit the descriptor until exec.
        // Explicitly unlock before notifying the overlay, even while it is open.
        if let Some(lock) = self.lock.take() {
            let _ = lock.unlock();
        }
        let _ = self.indicator.send_raw(&IndicatorEvent {
            capture: Some(Capture::End),
            ..Default::default()
        });
    }
}

/// A socket the overlay can answer: bound to a unique abstract address. Falls
/// back to an unbound socket, which only loses the capture replies.
fn client_socket() -> Option<UnixDatagram> {
    static NEXT: AtomicU32 = AtomicU32::new(0);
    let name = format!(
        "computer-use-linux-indicator-client.{}.{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    );
    SocketAddr::from_abstract_name(name.as_bytes())
        .and_then(|address| UnixDatagram::bind_addr(&address))
        .or_else(|_| UnixDatagram::unbound())
        .ok()
}

/// Whether text for an element with this AT-SPI role must be masked: a
/// password field (`password text`, or the `PasswordText` fallback name), or
/// a role that could not be read and so might be one.
pub(crate) fn is_secret_role(role: &str) -> bool {
    // Generic enum fallback names do not establish whether an editable field
    // obscures input. GTK's fresh "text box" role is similarly ambiguous.
    if matches!(role.trim(), "Entry" | "Text") {
        return true;
    }
    let role = role.trim().to_ascii_lowercase();
    role.is_empty()
        || role == crate::atspi_tree::UNKNOWN_ROLE
        || role == "invalid"
        || matches!(role.as_str(), "text box" | "textbox" | "terminal")
        || role.contains("password")
}

fn overlay_binary() -> PathBuf {
    if let Some(path) = env::var_os("CODEX_COMPUTER_USE_INDICATOR_BIN")
        .or_else(|| env::var_os(BINARY_ENV))
        .filter(|path| !path.is_empty())
    {
        return PathBuf::from(path);
    }
    env::current_exe()
        .ok()
        .map(|exe| exe.with_file_name(INDICATOR_BINARY))
        .filter(|sibling| sibling.is_file())
        .unwrap_or_else(|| PathBuf::from(INDICATOR_BINARY))
}

fn spawn_overlay() -> std::io::Result<()> {
    let mut child = tokio::process::Command::new(overlay_binary())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        // Own process group: a Ctrl-C aimed at the agent must not kill the
        // overlay that other agents may be sharing.
        .process_group(0)
        .spawn()?;
    // Reap it when it exits (it quits on its own after idling).
    tokio::spawn(async move {
        let _ = child.wait().await;
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_override_reads_the_codex_name_and_its_standalone_alias() {
        let env = |pairs: &'static [(&'static str, &'static str)]| {
            move |key: &str| {
                pairs
                    .iter()
                    .find(|(name, _)| *name == key)
                    .map(|(_, value)| value.to_string())
            }
        };
        assert_eq!(
            agent_override(env(&[("CODEX_COMPUTER_USE_AGENT_NAME", "Helper")])),
            Some("Helper".to_string())
        );
        assert_eq!(
            agent_override(env(&[("COMPUTER_USE_LINUX_AGENT_NAME", "Helper")])),
            Some("Helper".to_string())
        );
        assert_eq!(
            agent_override(env(&[
                ("CODEX_COMPUTER_USE_AGENT_NAME", "Codex name"),
                ("COMPUTER_USE_LINUX_AGENT_NAME", "Standalone name"),
            ])),
            Some("Codex name".to_string())
        );
        assert_eq!(
            agent_override(env(&[
                ("CODEX_COMPUTER_USE_AGENT_NAME", "  "),
                ("COMPUTER_USE_LINUX_AGENT_NAME", "Standalone name"),
            ])),
            Some("Standalone name".to_string())
        );
        assert_eq!(agent_override(env(&[])), None);
    }

    #[test]
    fn agent_names_come_from_client_info() {
        assert_eq!(agent_display_name("claude-code", None), "Claude");
        assert_eq!(agent_display_name("codex-mcp-client", None), "Codex");
        assert_eq!(agent_display_name("opencode", None), "OpenCode");
        assert_eq!(agent_display_name("pi", None), "Pi");
        assert_eq!(agent_display_name("computer-use-linux-pi", None), "Pi");
        assert_eq!(
            agent_display_name("pipeline", Some("Pipeline Bot")),
            "Pipeline Bot"
        );
        assert_eq!(agent_display_name("my-agent", None), "my-agent");
        assert_eq!(agent_display_name(" ", None), "Agent");
    }

    #[tokio::test]
    async fn request_agent_names_each_event_and_unscoped_events_fall_back() {
        let indicator = Indicator {
            agent_override: None,
            ..Indicator::default()
        };
        let named = |agent: &'static str| {
            with_request_agent(Some(agent.to_string()), async {
                tokio::task::yield_now().await;
                indicator.event("click").agent
            })
        };
        let (alpha, beta) = tokio::join!(named("Alpha"), named("Beta"));
        assert_eq!((alpha.as_str(), beta.as_str()), ("Alpha", "Beta"));
        assert_eq!(indicator.event("click").agent, "Agent");
        assert_eq!(
            with_request_agent(None, async { indicator.event("click").agent }).await,
            "Agent"
        );
    }

    #[test]
    fn stateless_requests_are_named_only_by_their_meta() {
        use rmcp::model::ProtocolVersion;
        let placeholder = Some(Implementation::default());
        assert_eq!(placeholder.as_ref().unwrap().name, "rmcp");
        let mut stateless = RequestMetaObject::default();
        stateless.set_protocol_version(ProtocolVersion::V_2026_07_28);
        // Stateless without clientInfo: the placeholder peer must not name it.
        assert_eq!(request_agent_name(&stateless, placeholder.clone()), None);
        // Stateless with clientInfo: its own name.
        stateless.set_client_info(Implementation::new("claude-code", "1"));
        assert_eq!(
            request_agent_name(&stateless, placeholder).as_deref(),
            Some("Claude")
        );
        // Legacy session: the session's initialize name (via client_info()).
        let legacy = RequestMetaObject::default();
        assert_eq!(
            request_agent_name(&legacy, Some(Implementation::new("codex-mcp-client", "1")))
                .as_deref(),
            Some("Codex")
        );
        assert_eq!(
            request_agent_name(&legacy, Some(Implementation::new(" ", "1"))),
            None
        );
    }

    #[test]
    fn password_fields_are_secret() {
        assert!(is_secret_role("password text"));
        assert!(is_secret_role("PasswordText"));
        assert!(!is_secret_role("text"));
        assert!(!is_secret_role("entry"));
    }

    #[test]
    fn unreadable_roles_are_secret() {
        // `role_name` reports this when both AT-SPI role reads fail.
        assert!(is_secret_role(crate::atspi_tree::UNKNOWN_ROLE));
        assert!(is_secret_role("Unknown"));
        assert!(is_secret_role("Invalid"));
        assert!(is_secret_role(" "));
    }

    #[test]
    fn generic_text_boxes_do_not_establish_password_safety() {
        // GTK exposes obscured entries with the same text-box role as public
        // entries. A successful role read does not establish clear-text input.
        assert!(is_secret_role("text box"));
        assert!(is_secret_role("TextBox"));
    }

    #[test]
    fn enum_fallback_text_and_terminal_roles_are_masked() {
        assert!(is_secret_role("Entry"));
        assert!(is_secret_role("Text"));
        assert!(is_secret_role("terminal"));
        // A fresh non-generic role read keeps the original public-text path.
        assert!(!is_secret_role("entry"));
    }

    /// A sender talking to a stand-in overlay at `path`.
    fn sender_for(path: &Path, enabled: bool) -> Indicator {
        let socket = client_socket().unwrap();
        socket.set_nonblocking(true).unwrap();
        Indicator {
            enabled,
            mask_text: false,
            agent_override: None,
            peer: OnceLock::new(),
            socket: Some(socket),
            path: Some(path.to_path_buf()),
            overlay: Mutex::new(Overlay::Unavailable),
            capture_handshake: tokio::sync::Mutex::new(()),
        }
    }

    fn scratch_dir(name: &str) -> PathBuf {
        let dir = crate::test_sockets::socket_fixture(
            &format!("cul-{}-{name}", std::process::id()),
            SOCKET_NAME,
        );
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Whether some server holds the capture lock next to `socket`.
    fn capture_held(socket: &Path) -> bool {
        let file = File::open(capture_lock_path(socket)).unwrap();
        match file.try_lock() {
            Ok(()) => false,
            Err(TryLockError::WouldBlock) => true,
            Err(TryLockError::Error(error)) => panic!("{error}"),
        }
    }

    /// Takes a capture hold against a stand-in overlay that answers `begin`
    /// with `reply`, from its own socket or, when `spoofed`, from another one.
    /// Returns how long taking the hold took, or its error.
    async fn hold_with_reply(
        name: &str,
        reply: &'static [u8],
        spoofed: bool,
    ) -> anyhow::Result<Duration> {
        let dir = scratch_dir(name);
        let socket = dir.join(SOCKET_NAME);
        let overlay = UnixDatagram::bind(&socket).unwrap();
        overlay
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let impostor = UnixDatagram::bind(dir.join("impostor.sock")).unwrap();
        let sender = sender_for(&socket, true);
        let answer = std::thread::spawn(move || {
            let mut buf = [0u8; 64];
            let (len, from) = overlay.recv_from(&mut buf).unwrap();
            assert_eq!(&buf[..len], br#"{"capture":"begin"}"#);
            let via = if spoofed { &impostor } else { &overlay };
            via.send_to_addr(reply, &from).unwrap();
            let len = overlay.recv(&mut buf).unwrap();
            assert_eq!(&buf[..len], br#"{"capture":"end"}"#);
        });
        let started = Instant::now();
        let hold = sender.hold_for_capture().await;
        let took = started.elapsed();
        let result = hold.map(|hold| {
            assert!(capture_held(&socket));
            drop(hold);
            took
        });
        assert!(!capture_held(&socket));
        answer.join().unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        result
    }

    #[tokio::test]
    async fn captures_wait_only_while_the_overlay_was_on_screen() {
        assert!(
            hold_with_reply("empty", CAPTURE_REPLY_EMPTY, false)
                .await
                .unwrap()
                < HIDE_SETTLE
        );
        assert!(
            hold_with_reply("shown", CAPTURE_REPLY_SHOWN, false)
                .await
                .unwrap()
                >= HIDE_SETTLE
        );
        // Neither another sender nor an unknown reply can authorize a capture.
        assert!(hold_with_reply("spoofed", CAPTURE_REPLY_EMPTY, true)
            .await
            .is_err());
        assert!(hold_with_reply("invalid", b"garbage", false).await.is_err());
    }

    #[tokio::test]
    async fn captures_hold_the_lock_without_an_overlay() {
        // An overlay another agent starts mid-capture must still stay blank.
        let dir = scratch_dir("none");
        let socket = dir.join(SOCKET_NAME);
        let sender = sender_for(&socket, true);
        let started = Instant::now();
        let hold = sender.hold_for_capture().await.unwrap();
        assert!(started.elapsed() < HIDE_SETTLE);
        assert!(capture_held(&socket));
        drop(hold);
        assert!(!capture_held(&socket));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn capture_release_unlocks_an_inherited_descriptor() {
        let dir = scratch_dir("inherited-lock");
        let socket = dir.join(SOCKET_NAME);
        let sender = sender_for(&socket, true);
        let hold = sender.hold_for_capture().await.unwrap();
        let _inherited = hold.lock.as_ref().unwrap().try_clone().unwrap();
        assert!(capture_held(&socket));
        drop(hold);
        assert!(!capture_held(&socket));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn captures_fail_while_a_stalled_overlay_cannot_be_told_to_hide() {
        let dir = scratch_dir("stalled");
        let socket = dir.join(SOCKET_NAME);
        let _overlay = UnixDatagram::bind(&socket).unwrap();
        let sender = sender_for(&socket, true);
        // Fill this sender's buffer: a different socket can still enqueue begin.
        let socket_sender = sender.socket.as_ref().unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            assert!(Instant::now() < deadline, "sender never became blocked");
            match socket_sender.send_to(b"{}", &socket) {
                Ok(_) => {}
                Err(error) => {
                    assert_eq!(error.kind(), ErrorKind::WouldBlock);
                    break;
                }
            }
        }
        let error = sender.hold_for_capture().await.err().unwrap();
        assert!(error.to_string().contains("could not hide"), "{error}");
        assert!(!capture_held(&socket));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn captures_fail_when_a_running_overlay_does_not_reply() {
        let dir = scratch_dir("silent");
        let socket = dir.join(SOCKET_NAME);
        let overlay = UnixDatagram::bind(&socket).unwrap();
        overlay.set_nonblocking(true).unwrap();
        let sender = sender_for(&socket, true);
        let error = sender.hold_for_capture().await.err().unwrap();
        assert!(error.to_string().contains("did not acknowledge"), "{error}");
        let mut buf = [0u8; 64];
        let len = overlay.recv(&mut buf).unwrap();
        assert_eq!(&buf[..len], br#"{"capture":"begin"}"#);
        assert!(!capture_held(&socket));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn set_values_are_masked_even_when_the_cached_role_was_public() {
        let dir = scratch_dir("set-value-mask");
        let socket = dir.join(SOCKET_NAME);
        let overlay = UnixDatagram::bind(&socket).unwrap();
        overlay
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let sender = sender_for(&socket, true);
        sender.text("set_value", "secret", false).await;
        let mut buf = [0u8; 512];
        let len = overlay.recv(&mut buf).unwrap();
        let event: IndicatorEvent = serde_json::from_slice(&buf[..len]).unwrap();
        assert_eq!(event.text.as_deref(), Some("••••••••"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn keycaps_mask_secret_focus_and_the_hide_text_setting() {
        let dir = scratch_dir("key-mask");
        let socket = dir.join(SOCKET_NAME);
        let overlay = UnixDatagram::bind(&socket).unwrap();
        overlay
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut sender = sender_for(&socket, true);
        for (secret, hide_text, expected) in [
            (true, false, vec!["••••••••"]),
            (false, true, vec!["••••••••"]),
            (false, false, vec!["Shift", "a"]),
        ] {
            sender.mask_text = hide_text;
            sender.keys("Shift+a", secret).await;
            let mut buf = [0u8; 512];
            let len = overlay.recv(&mut buf).unwrap();
            let event: IndicatorEvent = serde_json::from_slice(&buf[..len]).unwrap();
            assert_eq!(event.keys, expected);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn captures_fail_when_the_capture_lock_cannot_be_taken() {
        let dir = scratch_dir("unavailable-lock");
        let socket = dir.join(SOCKET_NAME);
        let lock_path = capture_lock_path(&socket);
        std::fs::create_dir(&lock_path).unwrap();
        let sender = sender_for(&socket, true);
        assert!(sender.hold_for_capture().await.is_err());
        std::fs::remove_dir(&lock_path).unwrap();
        let lock = File::create(&lock_path).unwrap();
        lock.try_lock().unwrap();
        assert!(sender.hold_for_capture().await.is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn captures_fail_without_a_client_socket_in_a_live_runtime() {
        let dir = scratch_dir("no-client-socket");
        let socket = dir.join(SOCKET_NAME);
        let mut sender = sender_for(&socket, true);
        sender.socket = None;
        assert!(sender.hold_for_capture().await.is_err());
        assert!(!capture_held(&socket));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn concurrent_captures_do_not_consume_each_others_replies() {
        let dir = scratch_dir("concurrent");
        let socket = dir.join(SOCKET_NAME);
        let overlay = UnixDatagram::bind(&socket).unwrap();
        overlay
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let sender = sender_for(&socket, true);
        let (ack_tx, ack_rx) = std::sync::mpsc::channel();
        let answer = std::thread::spawn(move || {
            let mut buf = [0u8; 64];
            for n in 0..2 {
                let (len, from) = overlay.recv_from(&mut buf).unwrap();
                assert_eq!(&buf[..len], br#"{"capture":"begin"}"#);
                overlay.send_to_addr(CAPTURE_REPLY_EMPTY, &from).unwrap();
                if n == 0 {
                    ack_tx.send(()).unwrap();
                }
            }
        });
        let mut first = Box::pin(sender.hold_for_capture());
        assert!(futures_util::poll!(first.as_mut()).is_pending());
        ack_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        // Poll the second request before the first can consume its queued ACK.
        let (second, first) = tokio::join!(biased; sender.hold_for_capture(), first);
        let (first, second) = (first.unwrap(), second.unwrap());
        assert!(capture_held(&socket));
        drop(first);
        assert!(capture_held(&socket), "the second capture is still running");
        drop(second);
        assert!(!capture_held(&socket));
        answer.join().unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn disabled_servers_still_hold_captures() {
        let dir = scratch_dir("disabled");
        let socket = dir.join(SOCKET_NAME);
        let overlay = UnixDatagram::bind(&socket).unwrap();
        overlay.set_nonblocking(true).unwrap();
        let sender = sender_for(&socket, false);
        let hold = sender.hold_for_capture();
        let acknowledge = async {
            let mut buf = [0u8; 64];
            let deadline = Instant::now() + Duration::from_secs(2);
            loop {
                assert!(Instant::now() < deadline, "capture begin was not received");
                match overlay.recv_from(&mut buf) {
                    Ok((len, from)) => {
                        assert_eq!(&buf[..len], br#"{"capture":"begin"}"#);
                        overlay.send_to_addr(CAPTURE_REPLY_EMPTY, &from).unwrap();
                        break;
                    }
                    Err(error) if error.kind() == ErrorKind::WouldBlock => {
                        tokio::time::sleep(Duration::from_millis(1)).await
                    }
                    Err(error) => panic!("{error}"),
                }
            }
        };
        let (hold, ()) = tokio::join!(hold, acknowledge);
        let hold = hold.unwrap();
        assert!(capture_held(&socket));
        let mut buf = [0u8; 64];
        // It reports no actions of its own.
        sender.action("click").await;
        assert!(overlay.recv(&mut buf).is_err());
        drop(hold);
        let len = overlay.recv(&mut buf).unwrap();
        assert_eq!(&buf[..len], br#"{"capture":"end"}"#);
        assert!(!capture_held(&socket));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn overlays_can_answer_the_client_socket() {
        let dir = scratch_dir("answer");
        let overlay_path = dir.join(SOCKET_NAME);
        let overlay = UnixDatagram::bind(&overlay_path).unwrap();
        let client = client_socket().unwrap();
        client.send_to(b"ping", &overlay_path).unwrap();
        let mut buf = [0u8; 64];
        let (_, from) = overlay.recv_from(&mut buf).unwrap();
        overlay.send_to_addr(CAPTURE_REPLY_EMPTY, &from).unwrap();
        let len = client.recv(&mut buf).unwrap();
        assert_eq!(&buf[..len], CAPTURE_REPLY_EMPTY);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn opt_out_values() {
        for value in ["0", "false", "OFF", "no"] {
            assert!(disabled_value(Some(value)), "{value}");
        }
        for value in [None, Some("1"), Some("")] {
            assert!(!disabled_value(value), "{value:?}");
        }
    }

    #[test]
    fn text_is_trimmed_to_its_tail_and_masked() {
        let long = "a".repeat(80) + "end";
        assert_eq!(shown_text(&long, false).chars().count(), TEXT_LIMIT);
        assert!(shown_text(&long, false).ends_with("end"));
        assert_eq!(shown_text("пароль", true), shown_text("x", true));
        assert!(!shown_text("пароль", true).contains("пароль"));
    }

    #[test]
    fn events_serialize_compactly() {
        let event = IndicatorEvent {
            agent: "Claude".into(),
            tool: "click".into(),
            x: Some(10),
            y: Some(20),
            ..Default::default()
        };
        let json = serde_json::to_string(&event).unwrap();
        assert_eq!(json, r#"{"agent":"Claude","tool":"click","x":10,"y":20}"#);
        assert_eq!(
            serde_json::from_str::<IndicatorEvent>(&json).unwrap(),
            event
        );
        let scaled = IndicatorEvent {
            space: Some((3840, 2160)),
            ..event
        };
        let json = serde_json::to_string(&scaled).unwrap();
        assert!(json.ends_with(r#""space":[3840,2160]}"#), "{json}");
        assert_eq!(
            serde_json::from_str::<IndicatorEvent>(&json).unwrap(),
            scaled
        );
        let begin = serde_json::to_string(&IndicatorEvent {
            capture: Some(Capture::Begin),
            ..Default::default()
        });
        assert_eq!(begin.unwrap(), r#"{"capture":"begin"}"#);
    }
}
