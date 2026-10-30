use crate::{
    command_runner,
    diagnostics::hydrate_session_bus_env,
    ei_input::{DeviceKind, EiInput, Input},
};
use anyhow::{bail, Context, Result};
use futures_util::StreamExt;
use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::{self, Read, Write},
    os::fd::AsRawFd,
    os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, OnceLock,
    },
    time::Duration,
};
use tokio::process::Command;
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};
use xkeysym::Keysym;
use zbus::{
    proxy::SignalStream,
    zvariant::{OwnedObjectPath, OwnedValue, Value},
    Connection, Proxy,
};

const PORTAL_DESKTOP_SERVICE: &str = "org.freedesktop.portal.Desktop";
const PORTAL_DESKTOP_PATH: &str = "/org/freedesktop/portal/desktop";
const PORTAL_REMOTE_DESKTOP_INTERFACE: &str = "org.freedesktop.portal.RemoteDesktop";
const PORTAL_SCREENCAST_INTERFACE: &str = "org.freedesktop.portal.ScreenCast";
const PORTAL_REQUEST_INTERFACE: &str = "org.freedesktop.portal.Request";
const PORTAL_SESSION_INTERFACE: &str = "org.freedesktop.portal.Session";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);
const PORTAL_CALL_TIMEOUT: Duration = Duration::from_secs(5);
const RELEASE_TIMEOUT: Duration = Duration::from_secs(1);
const INPUT_TIMEOUT: Duration = Duration::from_secs(3);

const DEVICE_KEYBOARD: u32 = 1;
const DEVICE_POINTER: u32 = 2;
const SOURCE_MONITOR: u32 = 1;
const CURSOR_MODE_HIDDEN: u32 = 1;

const KEY_RELEASED: u32 = 0;
const KEY_PRESSED: u32 = 1;

const POINTER_BUTTON_RELEASED: u32 = 0;
const POINTER_BUTTON_PRESSED: u32 = 1;

const AXIS_VERTICAL: u32 = 0;
const AXIS_HORIZONTAL: u32 = 1;

const BTN_LEFT: i32 = 0x110;
const BTN_RIGHT: i32 = 0x111;
const BTN_MIDDLE: i32 = 0x112;
const BTN_SIDE: i32 = 0x113;
const BTN_EXTRA: i32 = 0x114;
const BTN_FORWARD: i32 = 0x115;
const BTN_BACK: i32 = 0x116;

#[derive(Clone)]
pub struct PortalPointerSession {
    ei: Option<EiInput>,
    connection: Connection,
    session_handle: OwnedObjectPath,
    streams: Vec<PortalStream>,
    desktop_layout: Option<Vec<LogicalMonitor>>,
    /// Revalidate against KWin only, so a transient KWin failure cannot swap in kscreen.
    layout_from_kwin: bool,
    input_lock: Arc<AsyncMutex<()>>,
    valid: Arc<AtomicBool>,
}

#[derive(Clone)]
pub struct PortalKeyboardSession {
    ei: Option<EiInput>,
    connection: Connection,
    session_handle: OwnedObjectPath,
    input_lock: Arc<AsyncMutex<()>>,
    valid: Arc<AtomicBool>,
}

#[derive(Clone)]
pub(crate) struct InputOperationGuard {
    _guard: Arc<OwnedMutexGuard<()>>,
}

impl InputOperationGuard {
    pub(crate) fn new(guard: OwnedMutexGuard<()>) -> Self {
        Self {
            _guard: Arc::new(guard),
        }
    }
}

#[derive(Debug, Clone)]
struct PortalStream {
    node_id: u32,
    position: Option<(i32, i32)>,
    size: Option<(i32, i32)>,
    /// Stream pixels per logical pixel for NotifyPointerMotionAbsolute. mutter
    /// divides stream coordinates by the monitor scale when its stage views
    /// are scaled (logical layout mode), so a logical point must be multiplied
    /// back; 1.0 everywhere else (#169).
    pixel_scale: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct LogicalMonitor {
    pub(crate) x: i32,
    pub(crate) y: i32,
    pub(crate) width: i32,
    pub(crate) height: i32,
    pub(crate) scale: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PortalKey {
    Keysym(i32),
    Keycode(i32),
}

struct PointerReleaseGuard {
    ei: Option<EiInput>,
    connection: Connection,
    session_handle: OwnedObjectPath,
    button: Option<i32>,
    input_guard: Option<OwnedMutexGuard<()>>,
    operation_guard: Option<InputOperationGuard>,
    valid: Arc<AtomicBool>,
}

struct KeyboardReleaseGuard {
    ei: Option<EiInput>,
    connection: Connection,
    session_handle: OwnedObjectPath,
    pressed: Vec<PortalKey>,
    input_guard: Option<OwnedMutexGuard<()>>,
    operation_guard: Option<InputOperationGuard>,
    valid: Arc<AtomicBool>,
}

struct PortalSessionCleanup {
    connection: Connection,
    session_handle: OwnedObjectPath,
    armed: bool,
}

#[derive(Debug, Clone, Copy)]
pub enum PointerButton {
    Left,
    Right,
    Middle,
    Side,
    Extra,
    Forward,
    Back,
}

#[derive(Debug, Clone, Copy)]
pub enum ScrollDirection {
    Up,
    Down,
    Left,
    Right,
}

pub async fn start_portal_pointer_session() -> Result<PortalPointerSession> {
    match start_portal_pointer_session_inner(true).await {
        Err(error) if error.is::<GnomeEisStartupFailure>() => {
            eprintln!("[codex-computer-use] GNOME EIS startup failed ({error:#}); starting a fresh legacy pointer session");
            start_portal_pointer_session_inner(false).await
        }
        result => result,
    }
}

#[derive(Debug)]
struct GnomeEisStartupFailure(String);
impl std::fmt::Display for GnomeEisStartupFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for GnomeEisStartupFailure {}

async fn start_portal_pointer_session_inner(try_gnome_eis: bool) -> Result<PortalPointerSession> {
    hydrate_session_bus_env();

    let connection = Connection::session()
        .await
        .context("failed to connect to session bus for remote desktop portal")?;
    let persistence = remote_desktop_persistence(&connection).await;
    let permit = claim_restore_permit(&persistence, PortalDeviceKind::Pointer).await;
    let session_handle = create_remote_desktop_session(&connection).await?;
    let mut cleanup = PortalSessionCleanup::new(connection.clone(), session_handle.clone());
    select_pointer_devices(&connection, &session_handle, permit.as_ref()).await?;
    select_monitor_sources(&connection, &session_handle).await?;
    let (devices, streams, restore_token) =
        start_remote_desktop_session(&connection, &session_handle).await?;
    // A grant with no pointer or no monitors must not be restored. The next
    // process would skip the dialog and fail the same way.
    let restore_token = restore_token_to_keep(
        devices & DEVICE_POINTER != 0 && !streams.is_empty(),
        restore_token,
    );
    if devices & DEVICE_POINTER == 0 {
        commit_restore_permit(permit, restore_token).await;
        bail!("remote desktop portal session started without pointer access");
    }
    if streams.is_empty() {
        commit_restore_permit(permit, restore_token).await;
        bail!("remote desktop portal session started without any monitor streams");
    }

    let kwin_layout = kwin_desktop_layout().await;
    let layout_from_kwin = kwin_layout.is_some();
    let desktop_layout = match kwin_layout {
        Some(layout) => Some(layout),
        None => logical_desktop_layout().await,
    };
    let mut streams = streams;
    if env_token_contains("XDG_CURRENT_DESKTOP", "gnome")
        && mutter_stage_views_scaled(&connection).await
    {
        assign_stream_pixel_scales(&mut streams, desktop_layout.as_deref());
    }
    let gnome_eis = try_gnome_eis
        && env_token_contains("XDG_CURRENT_DESKTOP", "gnome")
        && streams.iter().any(|stream| stream.pixel_scale > 1.0);
    let ei = match portal_eis_input(&connection, &session_handle, DeviceKind::Pointer, gnome_eis)
        .await
    {
        Ok(ei) => ei,
        Err(error) if gnome_eis => {
            // ConnectToEIS may already have upgraded this session, including
            // after a lost reply. Notify* is then forbidden. No input was sent;
            // close it before opening a legacy session. Retain the grant's
            // restore token so persistence can avoid another consent dialog.
            let _ = tokio::time::timeout(
                RELEASE_TIMEOUT,
                close_portal_session(&connection, &session_handle),
            )
            .await;
            cleanup.disarm();
            commit_restore_permit(permit, restore_token).await;
            return Err(anyhow::Error::new(GnomeEisStartupFailure(format!(
                "{error:#}"
            ))));
        }
        Err(error) => return Err(error),
    };
    if ei.is_some() {
        // EIS takes global logical coordinates on COSMIC and GNOME. Stream
        // rectangles select outputs; the D-Bus stream pixel scale is unused.
        normalize_eis_streams(&mut streams, desktop_layout.as_deref());
    }
    commit_restore_permit(permit, restore_token).await;
    cleanup.disarm();

    Ok(PortalPointerSession {
        ei,
        connection,
        session_handle,
        streams,
        desktop_layout,
        layout_from_kwin,
        input_lock: portal_input_lock(),
        valid: Arc::new(AtomicBool::new(true)),
    })
}

fn normalize_eis_streams(streams: &mut [PortalStream], layout: Option<&[LogicalMonitor]>) {
    for stream in streams {
        if let Some(monitor) = layout.and_then(|layout| {
            layout
                .iter()
                .find(|monitor| stream.position == Some((monitor.x, monitor.y)))
        }) {
            stream.size = Some((monitor.width, monitor.height));
            stream.pixel_scale = 1.0;
        }
    }
}

pub async fn start_portal_keyboard_session() -> Result<PortalKeyboardSession> {
    hydrate_session_bus_env();

    let connection = Connection::session()
        .await
        .context("failed to connect to session bus for remote desktop portal")?;
    let persistence = remote_desktop_persistence(&connection).await;
    let permit = claim_restore_permit(&persistence, PortalDeviceKind::Keyboard).await;
    let session_handle = create_remote_desktop_session(&connection).await?;
    let mut cleanup = PortalSessionCleanup::new(connection.clone(), session_handle.clone());
    select_keyboard_devices(&connection, &session_handle, permit.as_ref()).await?;
    let (devices, _, restore_token) =
        start_remote_desktop_session(&connection, &session_handle).await?;
    let restore_token = restore_token_to_keep(devices & DEVICE_KEYBOARD != 0, restore_token);
    commit_restore_permit(permit, restore_token).await;

    if devices & DEVICE_KEYBOARD == 0 {
        bail!("remote desktop portal session started without keyboard access");
    }
    let ei = portal_eis_input(&connection, &session_handle, DeviceKind::Keyboard, false).await?;
    cleanup.disarm();

    Ok(PortalKeyboardSession {
        ei,
        connection,
        session_handle,
        input_lock: portal_input_lock(),
        valid: Arc::new(AtomicBool::new(true)),
    })
}

fn portal_input_lock() -> Arc<AsyncMutex<()>> {
    static INPUT_LOCK: OnceLock<Arc<AsyncMutex<()>>> = OnceLock::new();
    Arc::clone(INPUT_LOCK.get_or_init(|| Arc::new(AsyncMutex::new(()))))
}

pub(crate) async fn kwin_desktop_layout() -> Option<Vec<LogicalMonitor>> {
    if !env_token_contains("XDG_CURRENT_DESKTOP", "kde")
        && !env_token_contains("XDG_CURRENT_DESKTOP", "plasma")
    {
        return None;
    }
    crate::windowing::backends::kwin::output_layout().await.ok()
}

pub(crate) async fn logical_desktop_layout() -> Option<Vec<LogicalMonitor>> {
    if env_token_contains("XDG_CURRENT_DESKTOP", "gnome") {
        if let Some(layout) = crate::windowing::backends::gnome::extension_monitor_layout()
            .await
            .ok()
            .filter(|monitors| !monitors.is_empty())
            .map(|monitors| {
                monitors
                    .into_iter()
                    .map(|monitor| LogicalMonitor {
                        x: monitor.x,
                        y: monitor.y,
                        width: monitor.width,
                        height: monitor.height,
                        scale: monitor.scale,
                    })
                    .collect::<Vec<_>>()
            })
        {
            if layout.iter().all(|monitor| {
                monitor.width > 0
                    && monitor.height > 0
                    && monitor.scale.is_finite()
                    && monitor.scale >= 0.0
            }) {
                return Some(layout);
            }
        }
    }

    if env_token_contains("XDG_CURRENT_DESKTOP", "hyprland") {
        let mut command = Command::new("hyprctl");
        command.args(["monitors", "-j"]);
        if let Ok(output) = command_runner::output(command, "query Hyprland monitor layout").await {
            if output.status.success() {
                if let Some(layout) = parse_hyprland_monitor_layout(&output.stdout) {
                    return Some(layout);
                }
            }
        }
    }

    if env_token_contains("XDG_CURRENT_DESKTOP", "kde")
        || env_token_contains("XDG_CURRENT_DESKTOP", "plasma")
    {
        let mut command = Command::new("kscreen-doctor");
        command.arg("-j");
        if let Ok(output) = command_runner::output(command, "query KDE monitor layout").await {
            if output.status.success() {
                if let Some(layout) = parse_kscreen_monitor_layout(&output.stdout) {
                    return Some(layout);
                }
            }
        }
    }

    if env_token_contains("XDG_CURRENT_DESKTOP", "sway") || std::env::var_os("SWAYSOCK").is_some() {
        let mut command = Command::new("swaymsg");
        command.args(["-t", "get_outputs", "-r"]);
        if let Ok(output) = command_runner::output(command, "query Sway output layout").await {
            if output.status.success() {
                if let Some(layout) = parse_sway_monitor_layout(&output.stdout) {
                    return Some(layout);
                }
            }
        }
    }

    if env_token_contains("XDG_CURRENT_DESKTOP", "cosmic") {
        if let Ok(monitors) = crate::cosmic_helper::monitor_layout().await {
            let layout = monitors
                .into_iter()
                .map(|monitor| LogicalMonitor {
                    x: monitor.x,
                    y: monitor.y,
                    width: monitor.width,
                    height: monitor.height,
                    scale: monitor.scale,
                })
                .collect::<Vec<_>>();
            if !layout.is_empty()
                && layout.iter().all(|monitor| {
                    monitor.width > 0
                        && monitor.height > 0
                        && monitor.scale.is_finite()
                        && monitor.scale > 0.0
                })
            {
                return Some(layout);
            }
        }
    }

    if env_token_contains("XDG_CURRENT_DESKTOP", "niri") {
        let mut command = Command::new("niri");
        command.args(["msg", "--json", "outputs"]);
        if let Ok(output) = command_runner::output(command, "query Niri output layout").await {
            if output.status.success() {
                if let Some(layout) = parse_niri_monitor_layout(&output.stdout) {
                    return Some(layout);
                }
            }
        }
    }
    if std::env::var_os("WAYLAND_DISPLAY").is_some() {
        if let Some(layout) = crate::wlr_outputs::wlr_output_layout().await {
            return Some(layout);
        }
    }

    let mut command = Command::new("xrandr");
    command.arg("--listactivemonitors");
    let output = command_runner::output(command, "query XRandR monitor layout")
        .await
        .ok()?;
    output
        .status
        .success()
        .then(|| parse_xrandr_monitor_layout(&String::from_utf8_lossy(&output.stdout)))
        .flatten()
}

#[derive(serde::Deserialize)]
struct HyprlandMonitorLayout {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    scale: f64,
    #[serde(default)]
    transform: i32,
}

fn parse_hyprland_monitor_layout(json: &[u8]) -> Option<Vec<LogicalMonitor>> {
    let monitors: Vec<HyprlandMonitorLayout> = serde_json::from_slice(json).ok()?;
    let layout = monitors
        .into_iter()
        .map(|monitor| {
            if !monitor.scale.is_finite()
                || monitor.scale <= 0.0
                || monitor.width <= 0
                || monitor.height <= 0
            {
                return None;
            }
            let (width, height) = if monitor.transform.rem_euclid(2) == 1 {
                (monitor.height, monitor.width)
            } else {
                (monitor.width, monitor.height)
            };
            let width = (f64::from(width) / monitor.scale).round() as i32;
            let height = (f64::from(height) / monitor.scale).round() as i32;
            (width > 0 && height > 0).then_some(LogicalMonitor {
                x: monitor.x,
                y: monitor.y,
                width,
                height,
                scale: monitor.scale,
            })
        })
        .collect::<Option<Vec<_>>>()?;
    (!layout.is_empty()).then_some(layout)
}

#[derive(serde::Deserialize)]
struct KscreenConfig {
    outputs: Vec<KscreenOutput>,
}

#[derive(serde::Deserialize)]
struct KscreenOutput {
    pos: KscreenPoint,
    size: KscreenSize,
    scale: f64,
    connected: bool,
    enabled: bool,
    #[serde(default, rename = "replicationSource")]
    replication_source: Option<i64>,
}

#[derive(serde::Deserialize)]
struct KscreenPoint {
    x: i32,
    y: i32,
}

#[derive(serde::Deserialize)]
struct KscreenSize {
    width: i32,
    height: i32,
}

fn parse_kscreen_monitor_layout(json: &[u8]) -> Option<Vec<LogicalMonitor>> {
    let config: KscreenConfig = serde_json::from_slice(json).ok()?;
    let layout = config
        .outputs
        .into_iter()
        .filter(|output| {
            output.connected && output.enabled && output.replication_source.unwrap_or(0) == 0
        })
        .map(|output| {
            if !output.scale.is_finite()
                || output.scale <= 0.0
                || output.size.width <= 0
                || output.size.height <= 0
            {
                return None;
            }
            let width = (f64::from(output.size.width) / output.scale).round() as i32;
            let height = (f64::from(output.size.height) / output.scale).round() as i32;
            (width > 0 && height > 0).then_some(LogicalMonitor {
                x: output.pos.x,
                y: output.pos.y,
                width,
                height,
                scale: output.scale,
            })
        })
        .collect::<Option<Vec<_>>>()?;
    (!layout.is_empty()).then_some(layout)
}

#[derive(serde::Deserialize)]
struct SwayOutput {
    active: bool,
    rect: SwayRect,
    scale: f64,
}

#[derive(serde::Deserialize)]
struct SwayRect {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
}

fn parse_sway_monitor_layout(json: &[u8]) -> Option<Vec<LogicalMonitor>> {
    let outputs: Vec<SwayOutput> = serde_json::from_slice(json).ok()?;
    let layout = outputs
        .into_iter()
        .filter(|output| output.active)
        .map(|output| {
            (output.scale.is_finite()
                && output.scale > 0.0
                && output.rect.width > 0
                && output.rect.height > 0)
                .then_some(LogicalMonitor {
                    x: output.rect.x,
                    y: output.rect.y,
                    width: output.rect.width,
                    height: output.rect.height,
                    scale: output.scale,
                })
        })
        .collect::<Option<Vec<_>>>()?;
    (!layout.is_empty()).then_some(layout)
}

#[derive(serde::Deserialize)]
struct NiriMonitorLayout {
    logical: Option<NiriLogicalMonitor>,
}

#[derive(serde::Deserialize)]
struct NiriLogicalMonitor {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    scale: f64,
}

fn parse_niri_monitor_layout(json: &[u8]) -> Option<Vec<LogicalMonitor>> {
    let outputs: HashMap<String, NiriMonitorLayout> = serde_json::from_slice(json).ok()?;
    let layout = outputs
        .into_values()
        .filter_map(|output| output.logical)
        .map(|monitor| {
            (monitor.scale.is_finite()
                && monitor.scale > 0.0
                && monitor.width > 0
                && monitor.height > 0)
                .then_some(LogicalMonitor {
                    x: monitor.x,
                    y: monitor.y,
                    width: monitor.width,
                    height: monitor.height,
                    scale: monitor.scale,
                })
        })
        .collect::<Option<Vec<_>>>()?;
    (!layout.is_empty()).then_some(layout)
}

fn parse_xrandr_monitor_layout(output: &str) -> Option<Vec<LogicalMonitor>> {
    let mut lines = output.lines();
    let monitor_count = lines
        .next()?
        .strip_prefix("Monitors:")?
        .trim()
        .parse::<usize>()
        .ok()?;
    let layout = lines
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            line.split_whitespace()
                .find_map(parse_xrandr_monitor_geometry)
        })
        .collect::<Option<Vec<_>>>()?;
    (monitor_count > 0 && layout.len() == monitor_count).then_some(layout)
}

fn parse_xrandr_monitor_geometry(value: &str) -> Option<LogicalMonitor> {
    let (width, rest) = value.split_once('/')?;
    let (_, rest) = rest.split_once('x')?;
    let (height, rest) = rest.split_once('/')?;
    let offset_start = rest.find(['+', '-'])?;
    let offsets = &rest[offset_start..];
    let second_sign = offsets[1..].find(['+', '-'])? + 1;
    let (x, y) = offsets.split_at(second_sign);
    let width = width.parse().ok()?;
    let height = height.parse().ok()?;
    let x = x.parse().ok()?;
    let y = y.parse().ok()?;
    (width > 0 && height > 0).then_some(LogicalMonitor {
        x,
        y,
        width,
        height,
        scale: 0.0,
    })
}

pub fn keysyms_for_text(text: &str) -> Result<Vec<i32>> {
    text.chars()
        .map(|ch| {
            let keysym = Keysym::from_char(ch);
            if keysym == Keysym::NoSymbol {
                bail!(
                    "character U+{:04X} cannot be represented as an X11 keysym",
                    ch as u32
                );
            }
            i32::try_from(keysym.raw()).context("X11 keysym did not fit in D-Bus int32")
        })
        .collect()
}

pub(crate) async fn click(
    session: &PortalPointerSession,
    x: i32,
    y: i32,
    button: PointerButton,
    click_count: u32,
    operation_guard: InputOperationGuard,
) -> Result<()> {
    let input_guard = Arc::clone(&session.input_lock).lock_owned().await;
    session.ensure_current_layout().await?;
    let proxy = input_proxy(
        &session.connection,
        session.ei.clone(),
        session.streams.clone(),
    )
    .await?;
    let mut release_guard = PointerReleaseGuard::new(session, input_guard, operation_guard);
    let (stream_id, x, y) = session.map_absolute_point(x, y)?;
    notify_pointer_motion_absolute(&proxy, &session.session_handle, stream_id, x, y).await?;
    for _ in 0..click_count.max(1) {
        release_guard.arm(button.evdev_code());
        notify_pointer_button(
            &proxy,
            &session.session_handle,
            button.evdev_code(),
            POINTER_BUTTON_PRESSED,
        )
        .await?;
        tokio::time::sleep(Duration::from_millis(35)).await;
        notify_pointer_button(
            &proxy,
            &session.session_handle,
            button.evdev_code(),
            POINTER_BUTTON_RELEASED,
        )
        .await?;
        release_guard.disarm();
    }
    Ok(())
}

pub async fn scroll(
    session: &PortalPointerSession,
    target_point: Option<(i32, i32)>,
    direction: ScrollDirection,
    steps: i32,
) -> Result<()> {
    let _input_guard = Arc::clone(&session.input_lock).lock_owned().await;
    if target_point.is_some() {
        session.ensure_current_layout().await?;
    } else {
        session.ensure_valid()?;
    }
    let proxy = input_proxy(
        &session.connection,
        session.ei.clone(),
        session.streams.clone(),
    )
    .await?;
    if let Some((x, y)) = target_point {
        let (stream_id, x, y) = session.map_absolute_point(x, y)?;
        notify_pointer_motion_absolute(&proxy, &session.session_handle, stream_id, x, y).await?;
    }

    let (axis, steps) = portal_scroll_axis_steps(direction, steps, portal_scroll_polarity());
    notify_pointer_axis_discrete(&proxy, &session.session_handle, axis, steps).await
}

/// Wayland axis signs for `NotifyPointerAxisDiscrete`: negative means up/left,
/// positive means down/right. Mutter converts these signs directly to scroll
/// directions, and KDE's discrete portal path forwards them unchanged. The
/// signs therefore differ from ydotool's `REL_WHEEL` convention.
///
/// `COMPUTER_USE_LINUX_PORTAL_SCROLL_INVERT=1` explicitly reverses only vertical
/// scrolling. It is not needed for either GNOME or KDE Plasma by default.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PortalScrollPolarity {
    Standard,
    InvertVertical,
}

fn portal_scroll_polarity() -> PortalScrollPolarity {
    for key in [
        "COMPUTER_USE_LINUX_PORTAL_SCROLL_INVERT",
        "CODEX_COMPUTER_USE_PORTAL_SCROLL_INVERT",
    ] {
        let Ok(value) = std::env::var(key) else {
            continue;
        };
        let value = value.trim();
        if value.eq_ignore_ascii_case("1")
            || value.eq_ignore_ascii_case("true")
            || value.eq_ignore_ascii_case("yes")
            || value.eq_ignore_ascii_case("on")
        {
            return PortalScrollPolarity::InvertVertical;
        }
        if value.eq_ignore_ascii_case("0")
            || value.eq_ignore_ascii_case("false")
            || value.eq_ignore_ascii_case("no")
            || value.eq_ignore_ascii_case("off")
        {
            return PortalScrollPolarity::Standard;
        }
    }

    PortalScrollPolarity::Standard
}

fn env_token_contains(key: &str, needle: &str) -> bool {
    std::env::var(key)
        .map(|value| {
            value
                .split([':', ';', ','])
                .any(|part| part.trim().eq_ignore_ascii_case(needle))
        })
        .unwrap_or(false)
}

pub(crate) fn portal_scroll_axis_steps(
    direction: ScrollDirection,
    steps: i32,
    polarity: PortalScrollPolarity,
) -> (u32, i32) {
    let magnitude = steps.max(1);
    let (axis, standard_signed) = match direction {
        ScrollDirection::Up => (AXIS_VERTICAL, -magnitude),
        ScrollDirection::Down => (AXIS_VERTICAL, magnitude),
        ScrollDirection::Left => (AXIS_HORIZONTAL, -magnitude),
        ScrollDirection::Right => (AXIS_HORIZONTAL, magnitude),
    };

    let signed = match (polarity, axis) {
        (PortalScrollPolarity::InvertVertical, AXIS_VERTICAL) => -standard_signed,
        _ => standard_signed,
    };
    (axis, signed)
}

pub(crate) async fn drag(
    session: &PortalPointerSession,
    start_x: i32,
    start_y: i32,
    end_x: i32,
    end_y: i32,
    operation_guard: InputOperationGuard,
) -> Result<()> {
    let input_guard = Arc::clone(&session.input_lock).lock_owned().await;
    session.ensure_current_layout().await?;
    let proxy = input_proxy(
        &session.connection,
        session.ei.clone(),
        session.streams.clone(),
    )
    .await?;
    let mut release_guard = PointerReleaseGuard::new(session, input_guard, operation_guard);
    let start = (start_x, start_y);
    let (start_stream, start_x, start_y) = session.map_absolute_point(start_x, start_y)?;
    // Endpoints must be shared. Intermediate motion may cross a monitor gap;
    // project it onto the nearest shared stream instead of cancelling consent.
    session.map_absolute_point(end_x, end_y)?;
    let points = crate::pointer_path::drag_points(start, (end_x, end_y))
        .map(|point| {
            drag_point_on_shared_stream(&session.streams, point)
                .context("remote desktop portal has no usable stream for drag motion")
        })
        .collect::<Result<Vec<_>>>()?;
    notify_pointer_motion_absolute(
        &proxy,
        &session.session_handle,
        start_stream,
        start_x,
        start_y,
    )
    .await?;
    release_guard.arm(BTN_LEFT);
    notify_pointer_button(
        &proxy,
        &session.session_handle,
        BTN_LEFT,
        POINTER_BUTTON_PRESSED,
    )
    .await?;
    tokio::time::sleep(Duration::from_millis(35)).await;
    for (stream, x, y) in points {
        notify_pointer_motion_absolute(&proxy, &session.session_handle, stream, x, y).await?;
        tokio::time::sleep(crate::pointer_path::DRAG_STEP_DELAY).await;
    }
    notify_pointer_button(
        &proxy,
        &session.session_handle,
        BTN_LEFT,
        POINTER_BUTTON_RELEASED,
    )
    .await?;
    release_guard.disarm();
    Ok(())
}

pub(crate) async fn type_text_with_keysyms(
    session: &PortalKeyboardSession,
    keysyms: &[i32],
    operation_guard: Option<InputOperationGuard>,
) -> Result<()> {
    let input_guard = Arc::clone(&session.input_lock).lock_owned().await;
    session.ensure_valid()?;
    let proxy = input_proxy(&session.connection, session.ei.clone(), Vec::new()).await?;
    let mut release_guard = KeyboardReleaseGuard::new(session, input_guard, operation_guard);
    for keysym in keysyms {
        release_guard.push(PortalKey::Keysym(*keysym));
        notify_keyboard_keysym(&proxy, &session.session_handle, *keysym, KEY_PRESSED).await?;
        tokio::time::sleep(Duration::from_millis(5)).await;
        notify_keyboard_keysym(&proxy, &session.session_handle, *keysym, KEY_RELEASED).await?;
        release_guard.pop();
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    Ok(())
}

pub(crate) async fn press_keycode_chord(
    session: &PortalKeyboardSession,
    modifiers: &[i32],
    keycode: i32,
    operation_guard: Option<InputOperationGuard>,
) -> Result<()> {
    let modifiers: Vec<PortalKey> = modifiers.iter().copied().map(PortalKey::Keycode).collect();
    press_key_chord(
        session,
        &modifiers,
        PortalKey::Keycode(keycode),
        operation_guard,
    )
    .await
}

/// Press `key` while holding `modifiers`. Keysyms are resolved by the
/// compositor against the live keymap, so remapped modifiers still act as
/// the requested modifier; keycodes are physical positions.
pub(crate) async fn press_key_chord(
    session: &PortalKeyboardSession,
    modifiers: &[PortalKey],
    key: PortalKey,
    operation_guard: Option<InputOperationGuard>,
) -> Result<()> {
    let input_guard = Arc::clone(&session.input_lock).lock_owned().await;
    session.ensure_valid()?;
    let proxy = input_proxy(&session.connection, session.ei.clone(), Vec::new()).await?;
    let mut release_guard = KeyboardReleaseGuard::new(session, input_guard, operation_guard);
    for modifier in modifiers {
        release_guard.push(*modifier);
        notify_keyboard_key(&proxy, &session.session_handle, *modifier, KEY_PRESSED).await?;
    }
    release_guard.push(key);
    notify_keyboard_key(&proxy, &session.session_handle, key, KEY_PRESSED).await?;
    tokio::time::sleep(Duration::from_millis(35)).await;
    notify_keyboard_key(&proxy, &session.session_handle, key, KEY_RELEASED).await?;
    release_guard.pop();
    for modifier in modifiers.iter().rev() {
        notify_keyboard_key(&proxy, &session.session_handle, *modifier, KEY_RELEASED).await?;
        release_guard.pop();
    }
    Ok(())
}

impl PointerReleaseGuard {
    fn new(
        session: &PortalPointerSession,
        input_guard: OwnedMutexGuard<()>,
        operation_guard: InputOperationGuard,
    ) -> Self {
        Self {
            ei: session.ei.clone(),
            connection: session.connection.clone(),
            session_handle: session.session_handle.clone(),
            button: None,
            input_guard: Some(input_guard),
            operation_guard: Some(operation_guard),
            valid: Arc::clone(&session.valid),
        }
    }

    fn arm(&mut self, button: i32) {
        self.button = Some(button);
    }

    fn disarm(&mut self) {
        self.button = None;
    }
}

impl Drop for PointerReleaseGuard {
    fn drop(&mut self) {
        let input_guard = self.input_guard.take();
        let operation_guard = self.operation_guard.take();
        let Some(button) = self.button else {
            return;
        };
        self.valid.store(false, Ordering::Release);
        let connection = self.connection.clone();
        let ei = self.ei.clone();
        let session_handle = self.session_handle.clone();
        spawn_release_cleanup(input_guard, operation_guard, async move {
            let _ = tokio::time::timeout(RELEASE_TIMEOUT, async {
                if let Ok(proxy) = input_proxy(&connection, ei, Vec::new()).await {
                    let _ = notify_pointer_button(
                        &proxy,
                        &session_handle,
                        button,
                        POINTER_BUTTON_RELEASED,
                    )
                    .await;
                }
            })
            .await;
            let _ = tokio::time::timeout(
                RELEASE_TIMEOUT,
                close_portal_session(&connection, &session_handle),
            )
            .await;
        });
    }
}

impl KeyboardReleaseGuard {
    fn new(
        session: &PortalKeyboardSession,
        input_guard: OwnedMutexGuard<()>,
        operation_guard: Option<InputOperationGuard>,
    ) -> Self {
        Self {
            ei: session.ei.clone(),
            connection: session.connection.clone(),
            session_handle: session.session_handle.clone(),
            pressed: Vec::new(),
            input_guard: Some(input_guard),
            operation_guard,
            valid: Arc::clone(&session.valid),
        }
    }

    fn push(&mut self, key: PortalKey) {
        self.pressed.push(key);
    }

    fn pop(&mut self) {
        self.pressed.pop();
    }
}

impl PortalSessionCleanup {
    fn new(connection: Connection, session_handle: OwnedObjectPath) -> Self {
        Self {
            connection,
            session_handle,
            armed: true,
        }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for PortalSessionCleanup {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let connection = self.connection.clone();
        let session_handle = self.session_handle.clone();
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                let _ = tokio::time::timeout(
                    RELEASE_TIMEOUT,
                    close_portal_session(&connection, &session_handle),
                )
                .await;
            });
        }
    }
}

impl Drop for KeyboardReleaseGuard {
    fn drop(&mut self) {
        let input_guard = self.input_guard.take();
        let operation_guard = self.operation_guard.take();
        if self.pressed.is_empty() {
            return;
        }
        self.valid.store(false, Ordering::Release);
        let connection = self.connection.clone();
        let ei = self.ei.clone();
        let session_handle = self.session_handle.clone();
        let pressed = std::mem::take(&mut self.pressed);
        spawn_release_cleanup(input_guard, operation_guard, async move {
            let _ = tokio::time::timeout(RELEASE_TIMEOUT, async {
                if let Ok(proxy) = input_proxy(&connection, ei, Vec::new()).await {
                    for key in pressed.into_iter().rev() {
                        let _ =
                            notify_keyboard_key(&proxy, &session_handle, key, KEY_RELEASED).await;
                    }
                }
            })
            .await;
            let _ = tokio::time::timeout(
                RELEASE_TIMEOUT,
                close_portal_session(&connection, &session_handle),
            )
            .await;
        });
    }
}

fn spawn_release_cleanup<F>(
    input_guard: Option<OwnedMutexGuard<()>>,
    operation_guard: Option<InputOperationGuard>,
    cleanup: F,
) where
    F: std::future::Future<Output = ()> + Send + 'static,
{
    if let Ok(runtime) = tokio::runtime::Handle::try_current() {
        runtime.spawn(async move {
            cleanup.await;
            drop(input_guard);
            drop(operation_guard);
        });
    }
}

impl PortalPointerSession {
    pub(crate) fn is_valid(&self) -> bool {
        self.valid.load(Ordering::Acquire)
    }

    pub(crate) fn invalidate_and_close(&self) {
        invalidate_and_close(&self.valid, &self.connection, &self.session_handle);
    }

    pub(crate) fn same_session(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.valid, &other.valid)
    }

    fn ensure_valid(&self) -> Result<()> {
        if !self.is_valid() {
            bail!("remote desktop portal pointer session is no longer valid");
        }
        Ok(())
    }

    async fn ensure_current_layout(&self) -> Result<()> {
        self.ensure_valid()?;
        let expected = self
            .desktop_layout
            .as_deref()
            .context("remote desktop portal session has no authoritative monitor layout")?;
        let current = if self.layout_from_kwin {
            kwin_desktop_layout().await
        } else {
            logical_desktop_layout().await
        }
        .context("could not revalidate the current monitor layout")?;
        if !same_monitor_layout(expected, &current) {
            self.invalidate_and_close();
            bail!("desktop monitor layout changed after the remote desktop portal session started");
        }
        Ok(())
    }

    pub(crate) fn logical_point_from_capture(
        &self,
        x: i32,
        y: i32,
        capture_size: Option<(u32, u32)>,
    ) -> Option<(i32, i32)> {
        let (width, height) = capture_size?;
        map_capture_point_to_stream_layout(
            &self.streams,
            self.desktop_layout.as_deref()?,
            x,
            y,
            width,
            height,
        )
    }

    fn map_absolute_point(&self, x: i32, y: i32) -> Result<(u32, f64, f64)> {
        if let Some(stream) = self
            .streams
            .iter()
            .find(|stream| stream.contains_global_point(x, y))
        {
            return Ok(stream.relative_point(x, y));
        }

        bail!("point ({x}, {y}) is outside the monitors shared with the remote desktop portal")
    }
}

impl PortalKeyboardSession {
    pub(crate) fn is_valid(&self) -> bool {
        self.valid.load(Ordering::Acquire)
    }

    pub(crate) fn invalidate_and_close(&self) {
        invalidate_and_close(&self.valid, &self.connection, &self.session_handle);
    }

    pub(crate) fn same_session(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.valid, &other.valid)
    }

    fn ensure_valid(&self) -> Result<()> {
        if !self.is_valid() {
            bail!("remote desktop portal keyboard session is no longer valid");
        }
        Ok(())
    }
}

fn same_monitor_layout(expected: &[LogicalMonitor], current: &[LogicalMonitor]) -> bool {
    if expected.len() != current.len() {
        return false;
    }
    let mut expected = expected.to_vec();
    let mut current = current.to_vec();
    let sort_key = |monitor: &LogicalMonitor| (monitor.x, monitor.y, monitor.width, monitor.height);
    expected.sort_by_key(sort_key);
    current.sort_by_key(sort_key);
    expected.iter().zip(current.iter()).all(|(left, right)| {
        sort_key(left) == sort_key(right) && (left.scale - right.scale).abs() <= 0.01
    })
}

fn map_capture_point_to_stream_layout(
    streams: &[PortalStream],
    desktop_layout: &[LogicalMonitor],
    x: i32,
    y: i32,
    capture_width: u32,
    capture_height: u32,
) -> Option<(i32, i32)> {
    if capture_width == 0
        || capture_height == 0
        || x < 0
        || y < 0
        || x >= i32::try_from(capture_width).unwrap_or(i32::MAX)
        || y >= i32::try_from(capture_height).unwrap_or(i32::MAX)
    {
        return None;
    }

    let mut stream_rects = streams
        .iter()
        .map(|stream| {
            let (x, y) = stream.position?;
            let (width, height) = stream.size?;
            (width > 0 && height > 0).then_some((x, y, width, height))
        })
        .collect::<Option<Vec<_>>>()?;
    if desktop_layout.is_empty()
        || desktop_layout
            .iter()
            .any(|monitor| monitor.width <= 0 || monitor.height <= 0)
    {
        return None;
    }
    let mut monitor_rects = desktop_layout
        .iter()
        .map(|monitor| (monitor.x, monitor.y, monitor.width, monitor.height))
        .collect::<Vec<_>>();
    stream_rects.sort_unstable();
    monitor_rects.sort_unstable();
    if stream_rects != monitor_rects {
        return None;
    }

    let unknown_multi_monitor_scale = desktop_layout.len() > 1
        && desktop_layout
            .iter()
            .any(|monitor| !monitor.scale.is_finite() || monitor.scale <= 0.0);
    if desktop_layout.len() > 1 && !unknown_multi_monitor_scale {
        let first_scale = desktop_layout.first()?.scale;
        if desktop_layout
            .iter()
            .any(|monitor| (monitor.scale - first_scale).abs() > 0.01)
        {
            return None;
        }
    }

    let mut bounds = monitor_rects.iter().map(|(x, y, width, height)| {
        (
            i64::from(*x),
            i64::from(*y),
            i64::from(*x) + i64::from(*width),
            i64::from(*y) + i64::from(*height),
        )
    });
    let (mut min_x, mut min_y, mut max_x, mut max_y) = bounds.next()?;
    for (left, top, right, bottom) in bounds {
        min_x = min_x.min(left);
        min_y = min_y.min(top);
        max_x = max_x.max(right);
        max_y = max_y.max(bottom);
    }
    let logical_width = max_x - min_x;
    let logical_height = max_y - min_y;
    if logical_width <= 0 || logical_height <= 0 {
        return None;
    }
    if unknown_multi_monitor_scale
        && (i64::from(capture_width) != logical_width
            || i64::from(capture_height) != logical_height)
    {
        return None;
    }
    let scale_x = f64::from(capture_width) / logical_width as f64;
    let scale_y = f64::from(capture_height) / logical_height as f64;
    if !scale_x.is_finite() || !scale_y.is_finite() || (scale_x - scale_y).abs() > 0.01 {
        return None;
    }

    let point = (
        map_capture_axis(x, capture_width, min_x, max_x - min_x),
        map_capture_axis(y, capture_height, min_y, max_y - min_y),
    );
    streams
        .iter()
        .any(|stream| stream.contains_global_point(point.0, point.1))
        .then_some(point)
}

fn map_capture_axis(value: i32, capture_size: u32, target_origin: i64, target_size: i64) -> i32 {
    let scaled = i64::from(value).saturating_mul(target_size) / i64::from(capture_size);
    target_origin
        .saturating_add(scaled)
        .clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32
}

fn drag_point_on_shared_stream(
    streams: &[PortalStream],
    point: (i32, i32),
) -> Option<(u32, f64, f64)> {
    streams
        .iter()
        .filter_map(|stream| {
            let (x, y) = stream.position?;
            let (width, height) = stream.size?;
            if width <= 0 || height <= 0 {
                return None;
            }
            let projected = (
                i64::from(point.0).clamp(i64::from(x), i64::from(x) + i64::from(width) - 1) as i32,
                i64::from(point.1).clamp(i64::from(y), i64::from(y) + i64::from(height) - 1) as i32,
            );
            let dx = i128::from(point.0) - i128::from(projected.0);
            let dy = i128::from(point.1) - i128::from(projected.1);
            Some((
                dx * dx + dy * dy,
                stream.relative_point(projected.0, projected.1),
            ))
        })
        .min_by_key(|(distance, _)| *distance)
        .map(|(_, point)| point)
}

impl PortalStream {
    fn contains_global_point(&self, x: i32, y: i32) -> bool {
        let Some((stream_x, stream_y)) = self.position else {
            return false;
        };
        let Some((width, height)) = self.size else {
            return false;
        };
        width > 0
            && height > 0
            && x >= stream_x
            && y >= stream_y
            && i64::from(x) < i64::from(stream_x) + i64::from(width)
            && i64::from(y) < i64::from(stream_y) + i64::from(height)
    }

    fn relative_point(&self, x: i32, y: i32) -> (u32, f64, f64) {
        let (stream_x, stream_y) = self.position.unwrap_or((0, 0));
        let (width, height) = self.size.unwrap_or((i32::MAX, i32::MAX));
        let rel_x = (x - stream_x).clamp(0, width.saturating_sub(1)) as f64 * self.pixel_scale;
        let rel_y = (y - stream_y).clamp(0, height.saturating_sub(1)) as f64 * self.pixel_scale;
        (self.node_id, rel_x, rel_y)
    }
}

impl PointerButton {
    pub fn from_name(name: Option<&str>) -> Self {
        match name.unwrap_or("left").to_ascii_lowercase().as_str() {
            "right" => Self::Right,
            "middle" => Self::Middle,
            "side" => Self::Side,
            "extra" => Self::Extra,
            "forward" => Self::Forward,
            "back" => Self::Back,
            _ => Self::Left,
        }
    }

    fn evdev_code(self) -> i32 {
        match self {
            Self::Left => BTN_LEFT,
            Self::Right => BTN_RIGHT,
            Self::Middle => BTN_MIDDLE,
            Self::Side => BTN_SIDE,
            Self::Extra => BTN_EXTRA,
            Self::Forward => BTN_FORWARD,
            Self::Back => BTN_BACK,
        }
    }
}

const PERSIST_REMOTE_DESKTOP_ENV_KEYS: &[&str] = &[
    "COMPUTER_USE_LINUX_PERSIST_REMOTE_DESKTOP",
    "CODEX_COMPUTER_USE_PERSIST_REMOTE_DESKTOP",
];
/// `SelectDevices` persist_mode: keep the grant until the user revokes it.
const PERSIST_MODE_UNTIL_REVOKED: u32 = 2;
/// `persist_mode` and `restore_token` were added in version 2.
const REMOTE_DESKTOP_PERSIST_VERSION: u32 = 2;
const RESTORE_TOKEN_MAX_LEN: usize = 4096;
/// How long a second process waits for the restore-token lock.
///
/// Long enough for another process to finish a silent restore. Short enough
/// that an open portal dialog, or a stopped holder, cannot stall input.
const RESTORE_LOCK_WAIT: Duration = Duration::from_secs(3);
const RESTORE_LOCK_POLL: Duration = Duration::from_millis(20);

#[derive(Clone, Copy)]
enum PortalDeviceKind {
    Pointer,
    Keyboard,
}

impl PortalDeviceKind {
    fn token_file_name(self) -> &'static str {
        match self {
            Self::Pointer => "remote-desktop-pointer.token",
            Self::Keyboard => "remote-desktop-keyboard.token",
        }
    }

    fn lock_file_name(self) -> &'static str {
        match self {
            Self::Pointer => "remote-desktop-pointer.lock",
            Self::Keyboard => "remote-desktop-keyboard.lock",
        }
    }
}

enum RemoteDesktopPersistence {
    Off,
    On,
}

impl RemoteDesktopPersistence {
    fn is_on(&self) -> bool {
        matches!(self, Self::On)
    }
}

enum ParsedRestoreToken {
    Absent,
    Usable(String),
    Rejected,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DeviceSelectPersistence {
    persist_mode: Option<u32>,
    restore_token: Option<String>,
}

/// Exclusive hold on one device kind's restore token.
///
/// Pointer and keyboard are separate portal sessions (different device
/// masks, and only the pointer session selects monitors), so they do not
/// share a token. The token is single-use: the lock is held from the read
/// through `Start`, then the file is replaced. Waiting for a busy lock is
/// bounded. `_lock` is unread on purpose.
struct RestorePermit {
    _lock: fs::File,
    restore_token: Option<String>,
    directory: PathBuf,
    kind: PortalDeviceKind,
}

impl RestorePermit {
    async fn acquire(kind: PortalDeviceKind) -> io::Result<Self> {
        match tokio::task::spawn_blocking(move || Self::acquire_blocking(kind)).await {
            Ok(result) => result,
            Err(error) => Err(io::Error::other(error)),
        }
    }

    fn acquire_blocking(kind: PortalDeviceKind) -> io::Result<Self> {
        let directory = remote_desktop_state_dir_from_env()?;
        Self::acquire_in(&directory, kind)
    }

    fn acquire_in(directory: &Path, kind: PortalDeviceKind) -> io::Result<Self> {
        Self::acquire_in_for(directory, kind, RESTORE_LOCK_WAIT)
    }

    fn acquire_in_for(
        directory: &Path,
        kind: PortalDeviceKind,
        wait: Duration,
    ) -> io::Result<Self> {
        ensure_private_dir(directory)?;
        let lock = open_lock_file(&directory.join(kind.lock_file_name()))?;
        lock_exclusive(&lock, wait)?;
        let restore_token = read_token_file(&directory.join(kind.token_file_name()))?;
        Ok(Self {
            _lock: lock,
            restore_token,
            directory: directory.to_path_buf(),
            kind,
        })
    }

    fn token(&self) -> Option<&str> {
        self.restore_token.as_deref()
    }

    fn commit(self, parsed: ParsedRestoreToken) -> io::Result<()> {
        let token = match parsed {
            ParsedRestoreToken::Usable(token) if acceptable_restore_token(&token) => Some(token),
            _ => None,
        };
        write_token_file(&self.directory, self.kind, token.as_deref())
    }
}

fn device_select_persistence(
    persist: bool,
    restore_token: Option<&str>,
) -> DeviceSelectPersistence {
    if !persist {
        return DeviceSelectPersistence {
            persist_mode: None,
            restore_token: None,
        };
    }
    DeviceSelectPersistence {
        persist_mode: Some(PERSIST_MODE_UNTIL_REVOKED),
        restore_token: restore_token
            .filter(|token| acceptable_restore_token(token))
            .map(ToString::to_string),
    }
}

fn acceptable_restore_token(token: &str) -> bool {
    !token.is_empty()
        && token.len() <= RESTORE_TOKEN_MAX_LEN
        && !token
            .chars()
            .any(|ch| ch.is_control() || ch.is_whitespace())
}

fn restore_token_to_keep(granted: bool, parsed: ParsedRestoreToken) -> ParsedRestoreToken {
    if granted {
        parsed
    } else {
        ParsedRestoreToken::Absent
    }
}

fn parse_restore_token(results: &HashMap<String, OwnedValue>) -> ParsedRestoreToken {
    let Some(value) = results.get("restore_token") else {
        return ParsedRestoreToken::Absent;
    };
    let Ok(cloned) = value.try_clone() else {
        return ParsedRestoreToken::Rejected;
    };
    match String::try_from(cloned) {
        Ok(token) if acceptable_restore_token(&token) => ParsedRestoreToken::Usable(token),
        _ => ParsedRestoreToken::Rejected,
    }
}

async fn remote_desktop_persistence(connection: &Connection) -> RemoteDesktopPersistence {
    if !PERSIST_REMOTE_DESKTOP_ENV_KEYS
        .iter()
        .any(|key| std::env::var(key).ok().as_deref() == Some("1"))
    {
        return RemoteDesktopPersistence::Off;
    }
    match remote_desktop_interface_version(connection).await {
        Ok(version) if version >= REMOTE_DESKTOP_PERSIST_VERSION => RemoteDesktopPersistence::On,
        Ok(version) => {
            warn_persist_disabled_once(&format!(
                "RemoteDesktop version {version} does not support persist_mode (need {REMOTE_DESKTOP_PERSIST_VERSION})"
            ));
            RemoteDesktopPersistence::Off
        }
        Err(error) => {
            warn_persist_disabled_once(&format!(
                "could not read RemoteDesktop version ({error:#})"
            ));
            RemoteDesktopPersistence::Off
        }
    }
}

async fn remote_desktop_interface_version(connection: &Connection) -> Result<u32> {
    let proxy = remote_desktop_proxy(connection).await?;
    tokio::time::timeout(PORTAL_CALL_TIMEOUT, proxy.get_property::<u32>("version"))
        .await
        .context("RemoteDesktop version property timed out")?
        .context("RemoteDesktop version property failed")
}

async fn claim_restore_permit(
    persistence: &RemoteDesktopPersistence,
    kind: PortalDeviceKind,
) -> Option<RestorePermit> {
    if !persistence.is_on() {
        return None;
    }
    match RestorePermit::acquire(kind).await {
        Ok(permit) => Some(permit),
        Err(error) => {
            warn_persist_store_once(&error);
            None
        }
    }
}

async fn commit_restore_permit(permit: Option<RestorePermit>, parsed: ParsedRestoreToken) {
    let Some(permit) = permit else {
        return;
    };
    if matches!(parsed, ParsedRestoreToken::Rejected) {
        warn_rejected_restore_token_once();
    }
    let joined = tokio::task::spawn_blocking(move || permit.commit(parsed)).await;
    match joined {
        Ok(Ok(())) => {}
        Ok(Err(error)) => warn_persist_commit_once(&error),
        Err(error) => warn_persist_commit_once(&io::Error::other(error)),
    }
}

fn warn_persist_disabled_once(reason: &str) {
    static ONCE: OnceLock<()> = OnceLock::new();
    if ONCE.set(()).is_ok() {
        eprintln!("[computer-use-linux] remote desktop persistence disabled: {reason}");
    }
}

fn warn_persist_store_once(error: &io::Error) {
    static ONCE: OnceLock<()> = OnceLock::new();
    if ONCE.set(()).is_ok() {
        eprintln!(
            "[computer-use-linux] remote desktop persistence disabled: could not open the restore-token store ({error})"
        );
    }
}

fn warn_persist_commit_once(error: &io::Error) {
    static ONCE: OnceLock<()> = OnceLock::new();
    if ONCE.set(()).is_ok() {
        eprintln!("[computer-use-linux] could not store the remote desktop restore token: {error}");
    }
}

fn warn_rejected_restore_token_once() {
    static ONCE: OnceLock<()> = OnceLock::new();
    if ONCE.set(()).is_ok() {
        eprintln!(
            "[computer-use-linux] RemoteDesktop returned a restore token this process will not store (empty, too long, or it contains whitespace or control characters). The next portal session will prompt again."
        );
    }
}

fn remote_desktop_state_dir_from_env() -> io::Result<PathBuf> {
    remote_desktop_state_dir(
        std::env::var("XDG_STATE_HOME").ok().as_deref(),
        std::env::var("HOME").ok().as_deref(),
    )
    .ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::NotFound,
            "no XDG state directory is available for the restore token",
        )
    })
}

fn remote_desktop_state_dir(xdg_state_home: Option<&str>, home: Option<&str>) -> Option<PathBuf> {
    if let Some(path) = absolute_dir_component(xdg_state_home) {
        return Some(path.join("codex-computer-use-linux"));
    }
    absolute_dir_component(home).map(|path| path.join(".local/state/codex-computer-use-linux"))
}

fn absolute_dir_component(value: Option<&str>) -> Option<PathBuf> {
    let value = value.map(str::trim).filter(|value| !value.is_empty())?;
    let path = PathBuf::from(value);
    path.is_absolute().then_some(path)
}

fn ensure_private_dir(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "restore-token directory is a symlink",
            ));
        }
        Ok(meta) if !meta.is_dir() => {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "restore-token path is not a directory",
            ));
        }
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            if let Some(parent) = path.parent() {
                if !parent.as_os_str().is_empty() {
                    fs::create_dir_all(parent)?;
                }
            }
            let mut builder = fs::DirBuilder::new();
            builder.mode(0o700);
            builder.create(path)?;
        }
        Err(error) => return Err(error),
    }
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    let meta = fs::symlink_metadata(path)?;
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "restore-token path is not a private directory",
        ));
    }
    if meta.permissions().mode() & 0o077 != 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "could not restrict the restore-token directory to mode 0700",
        ));
    }
    Ok(())
}

fn open_lock_file(path: &Path) -> io::Result<fs::File> {
    match open_lock_file_once(path) {
        Err(error) if error.raw_os_error() == Some(libc::ELOOP) => {
            fs::remove_file(path)?;
            open_lock_file_once(path)
        }
        other => other,
    }
}

fn open_lock_file_once(path: &Path) -> io::Result<fs::File> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    let meta = file.metadata()?;
    if !meta.file_type().is_file() || meta.permissions().mode() & 0o077 != 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "restore-token lock is not a private file",
        ));
    }
    Ok(file)
}

fn lock_exclusive(file: &fs::File, wait: Duration) -> io::Result<()> {
    let deadline = std::time::Instant::now() + wait;
    loop {
        // SAFETY: `file` owns this fd. LOCK_NB returns instead of waiting
        // inside the kernel, so a stopped holder cannot block this call.
        let rc = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
        if rc == 0 {
            return Ok(());
        }
        let error = io::Error::last_os_error();
        if !flock_would_block(&error) {
            return Err(error);
        }
        if std::time::Instant::now() >= deadline {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "timed out waiting for the restore-token lock",
            ));
        }
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        std::thread::sleep(RESTORE_LOCK_POLL.min(remaining));
    }
}

fn flock_would_block(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::WouldBlock
        || error.raw_os_error() == Some(libc::EAGAIN)
        || error.raw_os_error() == Some(libc::EWOULDBLOCK)
}

fn read_token_file(path: &Path) -> io::Result<Option<String>> {
    let file = match OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) if error.raw_os_error() == Some(libc::ELOOP) => {
            remove_token_file(path)?;
            return Ok(None);
        }
        Err(error) => return Err(error),
    };
    let token = read_private_token(file)?;
    if token.is_none() {
        remove_token_file(path)?;
    }
    Ok(token)
}

fn read_private_token(file: fs::File) -> io::Result<Option<String>> {
    let meta = file.metadata()?;
    if !meta.file_type().is_file() || meta.permissions().mode() & 0o077 != 0 {
        return Ok(None);
    }
    let mut buf = Vec::new();
    file.take((RESTORE_TOKEN_MAX_LEN as u64).saturating_add(1))
        .read_to_end(&mut buf)?;
    match String::from_utf8(buf) {
        Ok(token) if acceptable_restore_token(&token) => Ok(Some(token)),
        _ => Ok(None),
    }
}

fn write_token_file(
    directory: &Path,
    kind: PortalDeviceKind,
    token: Option<&str>,
) -> io::Result<()> {
    let path = directory.join(kind.token_file_name());
    let Some(token) = token else {
        return remove_token_file(&path);
    };
    let tmp = temp_token_path(directory, kind);
    if let Err(error) = write_private_file(&tmp, token.as_bytes()) {
        let _ = fs::remove_file(&tmp);
        return Err(error);
    }
    if let Err(error) = fs::rename(&tmp, &path) {
        let _ = fs::remove_file(&tmp);
        return Err(error);
    }
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
    let mode = fs::symlink_metadata(&path)?.permissions().mode();
    if mode & 0o077 != 0 {
        remove_token_file(&path)?;
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "restore token was not private after replace",
        ));
    }
    Ok(())
}

fn write_private_file(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    Ok(())
}

fn temp_token_path(directory: &Path, kind: PortalDeviceKind) -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let nonce = NEXT.fetch_add(1, Ordering::Relaxed);
    directory.join(format!(
        ".{}.{}.{nonce}.tmp",
        kind.token_file_name(),
        std::process::id()
    ))
}

fn remove_token_file(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

async fn create_remote_desktop_session(connection: &Connection) -> Result<OwnedObjectPath> {
    let remote_proxy = remote_desktop_proxy(connection).await?;
    let (request_path, mut response_stream) =
        portal_request_stream(connection, "rd_create").await?;
    let session_token = request_token("rd_session");
    let mut options: HashMap<&str, Value<'_>> = HashMap::new();
    options.insert(
        "handle_token",
        Value::from(last_path_component(&request_path)),
    );
    options.insert("session_handle_token", Value::from(session_token.as_str()));

    let handle: OwnedObjectPath = tokio::time::timeout(
        PORTAL_CALL_TIMEOUT,
        remote_proxy.call("CreateSession", &(options)),
    )
    .await
    .context("RemoteDesktop CreateSession call timed out")?
    .context("RemoteDesktop CreateSession call failed")?;
    let (response_code, results) =
        await_portal_response(connection, handle, &request_path, &mut response_stream).await?;
    if response_code != 0 {
        bail!("RemoteDesktop CreateSession denied or cancelled with response code {response_code}");
    }

    let session_handle: String = results
        .get("session_handle")
        .context("RemoteDesktop CreateSession response did not include session_handle")?
        .try_clone()
        .context("failed to clone session_handle")?
        .try_into()
        .context("RemoteDesktop session_handle was not a string")?;
    OwnedObjectPath::try_from(session_handle)
        .context("RemoteDesktop session_handle was not a valid object path")
}

async fn select_pointer_devices(
    connection: &Connection,
    session: &OwnedObjectPath,
    permit: Option<&RestorePermit>,
) -> Result<()> {
    select_devices(connection, session, DEVICE_POINTER, "rd_devices", permit).await
}

async fn select_keyboard_devices(
    connection: &Connection,
    session: &OwnedObjectPath,
    permit: Option<&RestorePermit>,
) -> Result<()> {
    select_devices(
        connection,
        session,
        DEVICE_KEYBOARD,
        "rd_keyboard_devices",
        permit,
    )
    .await
}

async fn select_devices(
    connection: &Connection,
    session: &OwnedObjectPath,
    device_types: u32,
    request_prefix: &str,
    permit: Option<&RestorePermit>,
) -> Result<()> {
    let remote_proxy = remote_desktop_proxy(connection).await?;
    let (request_path, mut response_stream) =
        portal_request_stream(connection, request_prefix).await?;
    let requested =
        device_select_persistence(permit.is_some(), permit.and_then(RestorePermit::token));
    let mut options: HashMap<&str, Value<'_>> = HashMap::new();
    options.insert(
        "handle_token",
        Value::from(last_path_component(&request_path)),
    );
    options.insert("types", Value::from(device_types));
    if let Some(mode) = requested.persist_mode {
        options.insert("persist_mode", Value::from(mode));
    }
    if let Some(token) = requested.restore_token.as_deref() {
        options.insert("restore_token", Value::from(token));
    }

    let handle: OwnedObjectPath = tokio::time::timeout(
        PORTAL_CALL_TIMEOUT,
        remote_proxy.call("SelectDevices", &(session, options)),
    )
    .await
    .context("RemoteDesktop SelectDevices call timed out")?
    .context("RemoteDesktop SelectDevices call failed")?;
    let (response_code, _) =
        await_portal_response(connection, handle, &request_path, &mut response_stream).await?;
    if response_code != 0 {
        bail!("RemoteDesktop SelectDevices denied or cancelled with response code {response_code}");
    }
    Ok(())
}

fn insert_screencast_source_options<'a>(
    options: &mut HashMap<&'a str, Value<'a>>,
    handle_token: &'a str,
) {
    options.insert("handle_token", Value::from(handle_token));
    options.insert("types", Value::from(SOURCE_MONITOR));
    options.insert("multiple", Value::from(true));
    options.insert("cursor_mode", Value::from(CURSOR_MODE_HIDDEN));
}

async fn select_monitor_sources(connection: &Connection, session: &OwnedObjectPath) -> Result<()> {
    let screencast_proxy = screencast_proxy(connection).await?;
    let (request_path, mut response_stream) =
        portal_request_stream(connection, "rd_sources").await?;
    // Persistence stays on RemoteDesktop.SelectDevices. persist_mode or
    // restore_token here makes the portal reject the call: "Remote desktop
    // sessions cannot persist".
    let mut options: HashMap<&str, Value<'_>> = HashMap::new();
    insert_screencast_source_options(&mut options, last_path_component(&request_path));

    let handle: OwnedObjectPath = tokio::time::timeout(
        PORTAL_CALL_TIMEOUT,
        screencast_proxy.call("SelectSources", &(session, options)),
    )
    .await
    .context("ScreenCast SelectSources call timed out for remote desktop session")?
    .context("ScreenCast SelectSources call failed for remote desktop session")?;
    let (response_code, _) =
        await_portal_response(connection, handle, &request_path, &mut response_stream).await?;
    if response_code != 0 {
        bail!("ScreenCast SelectSources denied or cancelled with response code {response_code}");
    }
    Ok(())
}

async fn start_remote_desktop_session(
    connection: &Connection,
    session: &OwnedObjectPath,
) -> Result<(u32, Vec<PortalStream>, ParsedRestoreToken)> {
    let remote_proxy = remote_desktop_proxy(connection).await?;
    let (request_path, mut response_stream) = portal_request_stream(connection, "rd_start").await?;
    let mut options: HashMap<&str, Value<'_>> = HashMap::new();
    options.insert(
        "handle_token",
        Value::from(last_path_component(&request_path)),
    );

    let handle: OwnedObjectPath = tokio::time::timeout(
        PORTAL_CALL_TIMEOUT,
        remote_proxy.call("Start", &(session, "", options)),
    )
    .await
    .context("RemoteDesktop Start call timed out")?
    .context("RemoteDesktop Start call failed")?;
    let (response_code, results) =
        await_portal_response(connection, handle, &request_path, &mut response_stream).await?;
    if response_code != 0 {
        bail!("RemoteDesktop Start denied or cancelled with response code {response_code}");
    }

    let devices = results
        .get("devices")
        .and_then(|value| u32::try_from(value).ok())
        .unwrap_or_default();
    let streams = results
        .get("streams")
        .map(parse_streams)
        .transpose()?
        .unwrap_or_default();
    Ok((devices, streams, parse_restore_token(&results)))
}

struct InputProxy<'a> {
    portal: Proxy<'a>,
    ei: Option<EiInput>,
    streams: Vec<PortalStream>,
}
impl<'a> std::ops::Deref for InputProxy<'a> {
    type Target = Proxy<'a>;
    fn deref(&self) -> &Self::Target {
        &self.portal
    }
}
async fn input_proxy(
    connection: &Connection,
    ei: Option<EiInput>,
    streams: Vec<PortalStream>,
) -> Result<InputProxy<'_>> {
    Ok(InputProxy {
        portal: remote_desktop_proxy(connection).await?,
        ei,
        streams,
    })
}

async fn portal_eis_input(
    connection: &Connection,
    session: &OwnedObjectPath,
    kind: DeviceKind,
    try_gnome_pointer: bool,
) -> Result<Option<EiInput>> {
    // GNOME's legacy absolute-motion path scales stream coordinates, but the
    // portal validates against logical stream sizes first (#330). EIS uses
    // negotiated logical regions and reaches the whole fractional-scale output.
    // Keep GNOME keyboard sessions on D-Bus: older EIS peers lack text devices.
    let gnome_pointer = try_gnome_pointer
        && matches!(kind, DeviceKind::Pointer)
        && env_token_contains("XDG_CURRENT_DESKTOP", "gnome");
    if !env_token_contains("XDG_CURRENT_DESKTOP", "cosmic") && !gnome_pointer {
        return Ok(None);
    }
    let proxy = remote_desktop_proxy(connection).await?;
    let options: HashMap<&str, Value<'_>> = HashMap::new();
    let fd: zbus::zvariant::OwnedFd = match tokio::time::timeout(
        PORTAL_CALL_TIMEOUT,
        proxy.call("ConnectToEIS", &(session, options)),
    )
    .await
    .context("RemoteDesktop ConnectToEIS timed out")?
    {
        Ok(fd) => fd,
        Err(zbus::Error::MethodError(name, _, _))
            if matches!(
                name.as_str(),
                "org.freedesktop.DBus.Error.UnknownMethod"
                    | "org.freedesktop.DBus.Error.NotSupported"
                    | "org.freedesktop.portal.Error.NotSupported"
            ) =>
        {
            return Ok(None)
        }
        Err(zbus::Error::MethodError(_, _, _)) if gnome_pointer => {
            // A definitive rejection leaves the approved session on D-Bus.
            return Ok(None);
        }
        Err(error) => {
            return Err(error).context("RemoteDesktop ConnectToEIS failed; no input was sent")
        }
    };
    let fd: std::os::fd::OwnedFd = fd.into();
    let input = EiInput::connect(std::os::unix::net::UnixStream::from(fd), kind).await?;
    Ok(Some(input))
}

async fn notify_pointer_motion_absolute(
    proxy: &InputProxy<'_>,
    session: &OwnedObjectPath,
    stream_id: u32,
    x: f64,
    y: f64,
) -> Result<()> {
    if let Some(ei) = proxy.ei.as_ref() {
        let stream = proxy
            .streams
            .iter()
            .find(|entry| entry.node_id == stream_id)
            .context("EIS pointer stream disappeared")?;
        let (ox, oy) = stream
            .position
            .context("EIS pointer stream has no global position")?;
        return ei
            .send(Input::Motion(
                ox as f64 + x / stream.pixel_scale,
                oy as f64 + y / stream.pixel_scale,
            ))
            .await;
    }
    let options: HashMap<&str, Value<'_>> = HashMap::new();
    let _: () = tokio::time::timeout(
        INPUT_TIMEOUT,
        proxy.call(
            "NotifyPointerMotionAbsolute",
            &(session, options, stream_id, x, y),
        ),
    )
    .await
    .context("RemoteDesktop NotifyPointerMotionAbsolute timed out")?
    .context("RemoteDesktop NotifyPointerMotionAbsolute failed")?;
    Ok(())
}

async fn notify_pointer_button(
    proxy: &InputProxy<'_>,
    session: &OwnedObjectPath,
    button: i32,
    state: u32,
) -> Result<()> {
    if let Some(ei) = proxy.ei.as_ref() {
        return ei.send(Input::Button(button, state)).await;
    }
    let options: HashMap<&str, Value<'_>> = HashMap::new();
    let _: () = tokio::time::timeout(
        INPUT_TIMEOUT,
        proxy.call("NotifyPointerButton", &(session, options, button, state)),
    )
    .await
    .context("RemoteDesktop NotifyPointerButton timed out")?
    .context("RemoteDesktop NotifyPointerButton failed")?;
    Ok(())
}

async fn notify_pointer_axis_discrete(
    proxy: &InputProxy<'_>,
    session: &OwnedObjectPath,
    axis: u32,
    steps: i32,
) -> Result<()> {
    if let Some(ei) = proxy.ei.as_ref() {
        return ei.send(Input::Scroll(axis, steps)).await;
    }
    let options: HashMap<&str, Value<'_>> = HashMap::new();
    let _: () = tokio::time::timeout(
        INPUT_TIMEOUT,
        proxy.call(
            "NotifyPointerAxisDiscrete",
            &(session, options, axis, steps),
        ),
    )
    .await
    .context("RemoteDesktop NotifyPointerAxisDiscrete timed out")?
    .context("RemoteDesktop NotifyPointerAxisDiscrete failed")?;
    Ok(())
}

async fn notify_keyboard_key(
    proxy: &InputProxy<'_>,
    session: &OwnedObjectPath,
    key: PortalKey,
    state: u32,
) -> Result<()> {
    match key {
        PortalKey::Keysym(keysym) => notify_keyboard_keysym(proxy, session, keysym, state).await,
        PortalKey::Keycode(keycode) => {
            notify_keyboard_keycode(proxy, session, keycode, state).await
        }
    }
}

async fn notify_keyboard_keysym(
    proxy: &InputProxy<'_>,
    session: &OwnedObjectPath,
    keysym: i32,
    state: u32,
) -> Result<()> {
    if let Some(ei) = proxy.ei.as_ref() {
        return ei.send(Input::Keysym(keysym, state)).await;
    }
    let options: HashMap<&str, Value<'_>> = HashMap::new();
    let _: () = tokio::time::timeout(
        INPUT_TIMEOUT,
        proxy.call("NotifyKeyboardKeysym", &(session, options, keysym, state)),
    )
    .await
    .context("RemoteDesktop NotifyKeyboardKeysym timed out")?
    .context("RemoteDesktop NotifyKeyboardKeysym failed")?;
    Ok(())
}

async fn notify_keyboard_keycode(
    proxy: &InputProxy<'_>,
    session: &OwnedObjectPath,
    keycode: i32,
    state: u32,
) -> Result<()> {
    if let Some(ei) = proxy.ei.as_ref() {
        return ei.send(Input::Keycode(keycode, state)).await;
    }
    let options: HashMap<&str, Value<'_>> = HashMap::new();
    let _: () = tokio::time::timeout(
        INPUT_TIMEOUT,
        proxy.call("NotifyKeyboardKeycode", &(session, options, keycode, state)),
    )
    .await
    .context("RemoteDesktop NotifyKeyboardKeycode timed out")?
    .context("RemoteDesktop NotifyKeyboardKeycode failed")?;
    Ok(())
}

async fn close_portal_session(connection: &Connection, session: &OwnedObjectPath) {
    if let Ok(proxy) = Proxy::new(
        connection,
        PORTAL_DESKTOP_SERVICE,
        session.as_str(),
        PORTAL_SESSION_INTERFACE,
    )
    .await
    {
        let _: Result<(), _> = proxy.call("Close", &()).await;
    }
}

fn invalidate_and_close(valid: &AtomicBool, connection: &Connection, session: &OwnedObjectPath) {
    if !valid.swap(false, Ordering::AcqRel) {
        return;
    }
    let connection = connection.clone();
    let session = session.clone();
    if let Ok(runtime) = tokio::runtime::Handle::try_current() {
        runtime.spawn(async move {
            let _ =
                tokio::time::timeout(RELEASE_TIMEOUT, close_portal_session(&connection, &session))
                    .await;
        });
    }
}

async fn remote_desktop_proxy(connection: &Connection) -> Result<Proxy<'_>> {
    Proxy::new(
        connection,
        PORTAL_DESKTOP_SERVICE,
        PORTAL_DESKTOP_PATH,
        PORTAL_REMOTE_DESKTOP_INTERFACE,
    )
    .await
    .context("failed to create RemoteDesktop portal proxy")
}

async fn screencast_proxy(connection: &Connection) -> Result<Proxy<'_>> {
    Proxy::new(
        connection,
        PORTAL_DESKTOP_SERVICE,
        PORTAL_DESKTOP_PATH,
        PORTAL_SCREENCAST_INTERFACE,
    )
    .await
    .context("failed to create ScreenCast portal proxy")
}

async fn portal_request_stream<'a>(
    connection: &'a Connection,
    prefix: &str,
) -> Result<(String, SignalStream<'a>)> {
    let unique_name = connection
        .unique_name()
        .context("session bus connection has no unique name")?;
    let token = request_token(prefix);
    let request_path = request_path(unique_name.as_str(), &token);
    let request_proxy = Proxy::new(
        connection,
        PORTAL_DESKTOP_SERVICE,
        request_path.as_str(),
        PORTAL_REQUEST_INTERFACE,
    )
    .await
    .context("failed to create portal request proxy")?;
    let response_stream = request_proxy
        .receive_signal("Response")
        .await
        .context("failed to subscribe to portal request response")?;
    Ok((request_path, response_stream))
}

async fn await_portal_response(
    connection: &Connection,
    handle: OwnedObjectPath,
    expected_request_path: &str,
    response_stream: &mut SignalStream<'_>,
) -> Result<(u32, HashMap<String, OwnedValue>)> {
    if handle.as_str() != expected_request_path {
        *response_stream = Proxy::new(
            connection,
            PORTAL_DESKTOP_SERVICE,
            handle.as_str(),
            PORTAL_REQUEST_INTERFACE,
        )
        .await
        .context("failed to create returned portal request proxy")?
        .receive_signal("Response")
        .await
        .context("failed to subscribe to returned portal response")?;
    }

    let response = tokio::time::timeout(REQUEST_TIMEOUT, response_stream.next())
        .await
        .context("timed out waiting for portal response")?
        .context("portal response stream ended")?;
    response
        .body()
        .deserialize()
        .context("failed to decode portal response")
}

const MUTTER_DISPLAY_CONFIG: &str = "org.gnome.Mutter.DisplayConfig";
const MUTTER_DISPLAY_CONFIG_PATH: &str = "/org/gnome/Mutter/DisplayConfig";
/// `layout-mode` in DisplayConfig.GetCurrentState: 1 logical, 2 physical.
const MUTTER_LAYOUT_MODE_LOGICAL: u32 = 1;

/// Whether mutter's stage views are scaled, i.e. its layout mode is logical.
/// meta_screen_cast_monitor_stream_transform_position() then maps a stream
/// point to `monitor.x + stream_x / scale`. Any failure reads as unscaled,
/// which keeps the previous behavior.
async fn mutter_stage_views_scaled(connection: &Connection) -> bool {
    let reply = tokio::time::timeout(
        PORTAL_CALL_TIMEOUT,
        connection.call_method(
            Some(MUTTER_DISPLAY_CONFIG),
            MUTTER_DISPLAY_CONFIG_PATH,
            Some(MUTTER_DISPLAY_CONFIG),
            "GetCurrentState",
            &(),
        ),
    )
    .await;
    let Ok(Ok(message)) = reply else {
        return false;
    };
    current_state_properties(&message).is_some_and(|properties| layout_mode_is_logical(&properties))
}

/// The trailing `a{sv}` of GetCurrentState's `(ua(...)a(...)a{sv})` reply.
fn current_state_properties(message: &zbus::Message) -> Option<HashMap<String, OwnedValue>> {
    let body = message.body();
    let state: zbus::zvariant::Structure = body.deserialize().ok()?;
    let properties = state.fields().get(3)?.try_clone().ok()?;
    OwnedValue::try_from(properties).ok()?.try_into().ok()
}

fn layout_mode_is_logical(properties: &HashMap<String, OwnedValue>) -> bool {
    properties
        .get("layout-mode")
        .and_then(|value| value.try_clone().ok())
        .and_then(|value| u32::try_from(value).ok())
        == Some(MUTTER_LAYOUT_MODE_LOGICAL)
}

/// Give each stream its monitor's scale, matched by identical logical rect.
/// A stream with no matching monitor, or an unusable scale, keeps 1.0.
fn assign_stream_pixel_scales(streams: &mut [PortalStream], layout: Option<&[LogicalMonitor]>) {
    let Some(layout) = layout else {
        return;
    };
    for stream in streams {
        let (Some((x, y)), Some((width, height))) = (stream.position, stream.size) else {
            continue;
        };
        if let Some(monitor) = layout.iter().find(|monitor| {
            (monitor.x, monitor.y, monitor.width, monitor.height) == (x, y, width, height)
        }) {
            if monitor.scale.is_finite() && monitor.scale > 0.0 {
                stream.pixel_scale = monitor.scale;
            }
        }
    }
}

fn parse_streams(value: &OwnedValue) -> Result<Vec<PortalStream>> {
    let streams: Vec<(u32, HashMap<String, OwnedValue>)> = value
        .try_clone()
        .context("failed to clone streams response")?
        .try_into()
        .context("portal streams response had unexpected type")?;
    Ok(streams
        .into_iter()
        .map(|(node_id, properties)| PortalStream {
            node_id,
            position: get_pair_i32(&properties, "position"),
            size: get_pair_i32(&properties, "size"),
            pixel_scale: 1.0,
        })
        .collect())
}

fn get_pair_i32(properties: &HashMap<String, OwnedValue>, key: &str) -> Option<(i32, i32)> {
    properties.get(key).and_then(|value| {
        value
            .try_clone()
            .ok()
            .and_then(|owned| <(i32, i32)>::try_from(owned).ok())
            .or_else(|| {
                value
                    .try_clone()
                    .ok()
                    .and_then(|owned| <(u32, u32)>::try_from(owned).ok())
                    .map(|(left, right)| (left as i32, right as i32))
            })
    })
}

fn request_path(unique_name: &str, token: &str) -> String {
    format!(
        "/org/freedesktop/portal/desktop/request/{}/{}",
        unique_name.trim_start_matches(':').replace('.', "_"),
        token
    )
}

fn last_path_component(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

fn request_token(prefix: &str) -> String {
    format!(
        "{prefix}_{}_{:?}",
        std::process::id(),
        std::time::SystemTime::now()
    )
    .chars()
    .map(|ch| match ch {
        'a'..='z' | 'A'..='Z' | '0'..='9' | '_' => ch,
        _ => '_',
    })
    .collect()
}

#[cfg(test)]
mod eis_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use xkeysym::key;

    #[test]
    fn keysyms_for_url_text_round_trips_to_literal_characters() {
        let text = "https://example.com:8080/page#anchor";
        let keysyms = keysyms_for_text(text).expect("URL should map to keysyms");

        let round_tripped = keysyms
            .iter()
            .map(|keysym| {
                Keysym::new(*keysym as u32)
                    .key_char()
                    .expect("keysym should map back to a character")
            })
            .collect::<String>();

        assert_eq!(round_tripped, text);
    }

    #[test]
    fn keysyms_for_layout_sensitive_ascii_use_literal_symbols() {
        assert_eq!(
            keysyms_for_text(":#/?@").expect("symbols should map to keysyms"),
            vec![
                key::colon as i32,
                key::numbersign as i32,
                key::slash as i32,
                key::question as i32,
                key::at as i32,
            ]
        );
    }

    #[test]
    fn keysyms_for_non_ascii_use_legacy_and_unicode_mapped_values() {
        assert_eq!(
            keysyms_for_text("ä€😉").expect("non-ASCII text should map to keysyms"),
            vec![key::adiaeresis as i32, key::EuroSign as i32, 0x0101_F609]
        );
    }

    #[test]
    fn keysyms_for_text_rejects_unicode_non_symbols_before_input() {
        let error = keysyms_for_text("\u{FDD0}")
            .expect_err("Unicode non-characters should not be emitted through the portal")
            .to_string();

        assert!(error.contains("U+FDD0"));
    }

    #[test]
    fn portal_scroll_standard_polarity_matches_mutter_and_kde_wayland_axes() {
        assert_eq!(
            portal_scroll_axis_steps(ScrollDirection::Up, 1, PortalScrollPolarity::Standard),
            (AXIS_VERTICAL, -1)
        );
        assert_eq!(
            portal_scroll_axis_steps(ScrollDirection::Down, 3, PortalScrollPolarity::Standard),
            (AXIS_VERTICAL, 3)
        );
        assert_eq!(
            portal_scroll_axis_steps(ScrollDirection::Left, 2, PortalScrollPolarity::Standard),
            (AXIS_HORIZONTAL, -2)
        );
        assert_eq!(
            portal_scroll_axis_steps(ScrollDirection::Right, 2, PortalScrollPolarity::Standard),
            (AXIS_HORIZONTAL, 2)
        );
    }

    #[test]
    fn portal_scroll_explicit_override_inverts_vertical_only() {
        assert_eq!(
            portal_scroll_axis_steps(ScrollDirection::Up, 1, PortalScrollPolarity::InvertVertical),
            (AXIS_VERTICAL, 1)
        );
        assert_eq!(
            portal_scroll_axis_steps(
                ScrollDirection::Down,
                3,
                PortalScrollPolarity::InvertVertical
            ),
            (AXIS_VERTICAL, -3)
        );
        // The explicit vertical override must not change horizontal direction.
        assert_eq!(
            portal_scroll_axis_steps(
                ScrollDirection::Left,
                2,
                PortalScrollPolarity::InvertVertical
            ),
            (AXIS_HORIZONTAL, -2)
        );
        assert_eq!(
            portal_scroll_axis_steps(
                ScrollDirection::Right,
                2,
                PortalScrollPolarity::InvertVertical
            ),
            (AXIS_HORIZONTAL, 2)
        );
    }

    #[test]
    fn portal_scroll_clamps_zero_or_negative_steps_to_one() {
        assert_eq!(
            portal_scroll_axis_steps(ScrollDirection::Down, 0, PortalScrollPolarity::Standard),
            (AXIS_VERTICAL, 1)
        );
        assert_eq!(
            portal_scroll_axis_steps(
                ScrollDirection::Down,
                -5,
                PortalScrollPolarity::InvertVertical
            ),
            (AXIS_VERTICAL, -1)
        );
    }

    #[test]
    fn parses_xrandr_monitor_layout_with_negative_origins() {
        let layout = parse_xrandr_monitor_layout(
            "Monitors: 2\n 0: +*eDP-1 1920/344x1080/194+0+0 eDP-1\n 1: +DP-2 2560/600x1440/340-2560+0 DP-2\n",
        )
        .expect("XRandR layout should parse");

        assert_eq!(layout.len(), 2);
        assert_eq!(
            (layout[0].x, layout[0].y, layout[0].width, layout[0].height),
            (0, 0, 1920, 1080)
        );
        assert_eq!(
            (layout[1].x, layout[1].y, layout[1].width, layout[1].height),
            (-2560, 0, 2560, 1440)
        );
    }

    #[test]
    fn parses_hyprland_monitor_layout_in_logical_coordinates() {
        let layout = parse_hyprland_monitor_layout(
            br#"[
                {"x":0,"y":0,"width":3840,"height":2160,"scale":2.0,"transform":0},
                {"x":1920,"y":0,"width":2560,"height":1440,"scale":1.0,"transform":1}
            ]"#,
        )
        .expect("Hyprland layout should parse");

        assert_eq!(
            (layout[0].x, layout[0].y, layout[0].width, layout[0].height),
            (0, 0, 1920, 1080)
        );
        assert_eq!(
            (layout[1].x, layout[1].y, layout[1].width, layout[1].height),
            (1920, 0, 1440, 2560)
        );
    }

    #[test]
    fn parses_kscreen_physical_sizes_in_logical_coordinates() {
        let layout = parse_kscreen_monitor_layout(
            br#"{
                "outputs":[
                    {"pos":{"x":0,"y":0},"size":{"width":3840,"height":2160},"scale":2.0,"connected":true,"enabled":true},
                    {"pos":{"x":1920,"y":0},"size":{"width":1440,"height":2560},"scale":1.0,"connected":true,"enabled":true},
                    {"pos":{"x":0,"y":0},"size":{"width":0,"height":0},"scale":0.0,"connected":false,"enabled":false}
                ]
            }"#,
        )
        .expect("KScreen layout should parse");

        assert_eq!(layout.len(), 2);
        assert_eq!(
            (layout[0].x, layout[0].y, layout[0].width, layout[0].height),
            (0, 0, 1920, 1080)
        );
        assert_eq!(
            (layout[1].x, layout[1].y, layout[1].width, layout[1].height),
            (1920, 0, 1440, 2560)
        );
    }

    #[test]
    fn kscreen_layout_excludes_mirrored_outputs() {
        let layout = parse_kscreen_monitor_layout(
            br#"{"outputs":[
                {"pos":{"x":0,"y":0},"size":{"width":1920,"height":1080},"scale":1.0,"connected":true,"enabled":true,"replicationSource":0},
                {"pos":{"x":1920,"y":0},"size":{"width":3840,"height":2160},"scale":2.0,"connected":true,"enabled":true,"replicationSource":1}
            ]}"#,
        )
        .expect("KScreen workspace layout should parse");

        assert_eq!(layout.len(), 1);
        assert_eq!(
            (layout[0].x, layout[0].y, layout[0].width, layout[0].height),
            (0, 0, 1920, 1080)
        );
    }

    #[test]
    fn parses_sway_logical_output_rectangles() {
        let layout = parse_sway_monitor_layout(
            br#"[
                {"active":true,"rect":{"x":-1536,"y":0,"width":1536,"height":864},"scale":1.25},
                {"active":true,"rect":{"x":0,"y":0,"width":1920,"height":1080},"scale":1.0},
                {"active":false,"rect":{"x":0,"y":0,"width":0,"height":0},"scale":0.0}
            ]"#,
        )
        .expect("Sway layout should parse");

        assert_eq!(layout.len(), 2);
        assert_eq!(
            (
                layout[0].x,
                layout[0].y,
                layout[0].width,
                layout[0].height,
                layout[0].scale,
            ),
            (-1536, 0, 1536, 864, 1.25)
        );
    }

    #[test]
    fn monitor_parsers_reject_partial_active_layouts() {
        assert!(parse_hyprland_monitor_layout(
            br#"[
                {"x":0,"y":0,"width":1920,"height":1080,"scale":1.0},
                {"x":1920,"y":0,"width":1920,"height":1080,"scale":0.0}
            ]"#,
        )
        .is_none());
        assert!(parse_kscreen_monitor_layout(
            br#"{"outputs":[
                {"pos":{"x":0,"y":0},"size":{"width":1920,"height":1080},"scale":1.0,"connected":true,"enabled":true},
                {"pos":{"x":1920,"y":0},"size":{"width":0,"height":1080},"scale":1.0,"connected":true,"enabled":true}
            ]}"#,
        )
        .is_none());
        assert!(parse_sway_monitor_layout(
            br#"[
                {"active":true,"rect":{"x":0,"y":0,"width":1920,"height":1080},"scale":1.0},
                {"active":true,"rect":{"x":1920,"y":0,"width":1920,"height":1080},"scale":0.0}
            ]"#,
        )
        .is_none());
        assert!(parse_sway_monitor_layout(
            br#"[{"rect":{"x":0,"y":0,"width":1920,"height":1080},"scale":1.0}]"#,
        )
        .is_none());
        assert!(parse_niri_monitor_layout(
            br#"{
                "eDP-1":{"logical":{"x":0,"y":0,"width":1920,"height":1080,"scale":1.0}},
                "DP-1":{"logical":{"x":1920,"y":0,"width":1920,"height":1080,"scale":0.0}}
            }"#,
        )
        .is_none());
        assert!(parse_xrandr_monitor_layout(
            "Monitors: 2\n 0: +*eDP-1 1920/344x1080/194+0+0 eDP-1\n"
        )
        .is_none());
    }

    #[test]
    fn monitor_layout_comparison_detects_reconfiguration() {
        let original = [LogicalMonitor {
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
            scale: 1.0,
        }];
        let mut changed = original.clone();
        changed[0].scale = 1.25;
        assert!(!same_monitor_layout(&original, &changed));
        changed[0].scale = 1.0;
        changed[0].width = 1600;
        assert!(!same_monitor_layout(&original, &changed));
        assert!(same_monitor_layout(&original, &original));
    }

    #[test]
    fn parses_niri_logical_output_layout() {
        let layout = parse_niri_monitor_layout(
            br#"{
                "eDP-1":{"logical":{"x":0,"y":0,"width":1920,"height":1080,"scale":2.0}},
                "DP-1":{"logical":{"x":1920,"y":0,"width":2560,"height":1440,"scale":1.0}}
            }"#,
        )
        .expect("Niri layout should parse");

        assert_eq!(layout.len(), 2);
        assert!(layout.iter().any(|monitor| {
            (
                monitor.x,
                monitor.y,
                monitor.width,
                monitor.height,
                monitor.scale,
            ) == (0, 0, 1920, 1080, 2.0)
        }));
        assert!(layout.iter().any(|monitor| {
            (
                monitor.x,
                monitor.y,
                monitor.width,
                monitor.height,
                monitor.scale,
            ) == (1920, 0, 2560, 1440, 1.0)
        }));
    }

    #[test]
    fn capture_points_scale_to_portal_logical_stream_space() {
        let streams = [PortalStream {
            node_id: 1,
            position: Some((0, 0)),
            size: Some((1920, 1200)),
            pixel_scale: 1.0,
        }];
        let layout = [LogicalMonitor {
            x: 0,
            y: 0,
            width: 1920,
            height: 1200,
            scale: 4.0 / 3.0,
        }];

        assert_eq!(
            map_capture_point_to_stream_layout(&streams, &layout, 1280, 800, 2560, 1600),
            Some((960, 600))
        );
    }

    #[test]
    fn drag_motion_crosses_monitor_gaps_without_leaving_shared_streams() {
        let streams = [
            PortalStream {
                node_id: 1,
                position: Some((0, 0)),
                size: Some((1920, 1080)),
                pixel_scale: 1.0,
            },
            PortalStream {
                node_id: 2,
                position: Some((1920, 0)),
                size: Some((2560, 1440)),
                pixel_scale: 1.0,
            },
        ];
        let points: Vec<_> = crate::pointer_path::drag_points((100, 1000), (3000, 1400))
            .map(|point| drag_point_on_shared_stream(&streams, point).unwrap())
            .collect();
        assert_eq!(points.last(), Some(&(2, 1080.0, 1400.0)));
        assert!(points.iter().any(|(id, _, y)| *id == 1 && *y == 1079.0));
        for (id, x, y) in points {
            let stream = streams.iter().find(|stream| stream.node_id == id).unwrap();
            let (width, height) = stream.size.unwrap();
            assert!(x >= 0.0 && x < f64::from(width));
            assert!(y >= 0.0 && y < f64::from(height));
        }
    }

    #[test]
    fn kwin_layout_maps_nested_scale_two_capture() {
        // Recorded in the alpine-kde webtop at SELKIES_SCALING_DPI=192: kscreen-doctor
        // reports 2128x1152 at scale 1, while KWin and the portal stream are 1064x576.
        let streams = [PortalStream {
            node_id: 46,
            position: Some((0, 0)),
            size: Some((1064, 576)),
            pixel_scale: 1.0,
        }];
        let layout = crate::windowing::backends::kwin::kwin_output_layout(
            r#"{"desktopGeometry":{"x":0,"y":0,"width":1064,"height":576},"outputs":[{"name":"WL-0","geometry":{"x":0,"y":0,"width":1064,"height":576},"devicePixelRatio":2}],"windows":[]}"#,
        )
        .unwrap();

        assert_eq!(
            map_capture_point_to_stream_layout(&streams, &layout, 386, 1092, 2128, 1152),
            Some((193, 546))
        );

        // The kscreen view of the same session cannot be mapped: this is why KWin is preferred.
        let kscreen = parse_kscreen_monitor_layout(
            br#"{"outputs":[{"name":"WL-0","pos":{"x":0,"y":0},"size":{"height":1152,"width":2128},"scale":1,"connected":true,"enabled":true,"replicationSource":0}]}"#,
        )
        .unwrap();
        assert_eq!(
            map_capture_point_to_stream_layout(&streams, &kscreen, 386, 1092, 2128, 1152),
            None
        );
    }

    #[test]
    fn capture_points_preserve_negative_stream_layout_origins() {
        let streams = [
            PortalStream {
                node_id: 1,
                position: Some((-1920, 0)),
                size: Some((1920, 1080)),
                pixel_scale: 1.0,
            },
            PortalStream {
                node_id: 2,
                position: Some((0, 0)),
                size: Some((1920, 1080)),
                pixel_scale: 1.0,
            },
        ];
        let layout = [
            LogicalMonitor {
                x: -1920,
                y: 0,
                width: 1920,
                height: 1080,
                scale: 2.0,
            },
            LogicalMonitor {
                x: 0,
                y: 0,
                width: 1920,
                height: 1080,
                scale: 2.0,
            },
        ];

        assert_eq!(
            map_capture_point_to_stream_layout(&streams, &layout, 0, 0, 7680, 2160),
            Some((-1920, 0))
        );
        assert_eq!(
            map_capture_point_to_stream_layout(&streams, &layout, 3840, 1080, 7680, 2160),
            Some((0, 540))
        );
    }

    #[test]
    fn capture_point_mapping_requires_usable_stream_metadata() {
        let streams = [PortalStream {
            node_id: 1,
            position: None,
            size: None,
            pixel_scale: 1.0,
        }];
        let layout = [LogicalMonitor {
            x: 0,
            y: 0,
            width: 1920,
            height: 1200,
            scale: 1.0,
        }];

        assert_eq!(
            map_capture_point_to_stream_layout(&streams, &layout, 100, 200, 2560, 1600),
            None
        );
    }

    #[test]
    fn capture_point_mapping_rejects_invalid_desktop_monitors() {
        let streams = [PortalStream {
            node_id: 1,
            position: Some((0, 0)),
            size: Some((1920, 1080)),
            pixel_scale: 1.0,
        }];
        let layout = [
            LogicalMonitor {
                x: 0,
                y: 0,
                width: 1920,
                height: 1080,
                scale: 1.0,
            },
            LogicalMonitor {
                x: 1920,
                y: 0,
                width: 0,
                height: 1080,
                scale: 1.0,
            },
        ];

        assert_eq!(
            map_capture_point_to_stream_layout(&streams, &layout, 100, 200, 1920, 1080),
            None
        );
    }

    #[test]
    fn capture_point_mapping_rejects_partially_shared_desktops() {
        let streams = [PortalStream {
            node_id: 1,
            position: Some((0, 0)),
            size: Some((1920, 1080)),
            pixel_scale: 1.0,
        }];
        let layout = [
            LogicalMonitor {
                x: 0,
                y: 0,
                width: 1920,
                height: 1080,
                scale: 1.0,
            },
            LogicalMonitor {
                x: 1920,
                y: 0,
                width: 1920,
                height: 1080,
                scale: 1.0,
            },
        ];

        assert_eq!(
            map_capture_point_to_stream_layout(&streams, &layout, 3000, 500, 3840, 1080),
            None
        );
    }

    #[test]
    fn capture_point_mapping_rejects_mixed_scale_desktops() {
        let streams = [
            PortalStream {
                node_id: 1,
                position: Some((0, 0)),
                size: Some((1920, 1080)),
                pixel_scale: 1.0,
            },
            PortalStream {
                node_id: 2,
                position: Some((1920, 0)),
                size: Some((1920, 1080)),
                pixel_scale: 1.0,
            },
        ];
        let layout = [
            LogicalMonitor {
                x: 0,
                y: 0,
                width: 1920,
                height: 1080,
                scale: 1.0,
            },
            LogicalMonitor {
                x: 1920,
                y: 0,
                width: 1920,
                height: 1080,
                scale: 2.0,
            },
        ];

        assert_eq!(
            map_capture_point_to_stream_layout(&streams, &layout, 2000, 500, 3840, 1080),
            None
        );
    }

    #[test]
    fn unknown_multi_monitor_scale_only_allows_identity_mapping() {
        let streams = [
            PortalStream {
                node_id: 1,
                position: Some((0, 0)),
                size: Some((1920, 1080)),
                pixel_scale: 1.0,
            },
            PortalStream {
                node_id: 2,
                position: Some((1920, 0)),
                size: Some((1920, 1080)),
                pixel_scale: 1.0,
            },
        ];
        let layout = [
            LogicalMonitor {
                x: 0,
                y: 0,
                width: 1920,
                height: 1080,
                scale: 0.0,
            },
            LogicalMonitor {
                x: 1920,
                y: 0,
                width: 1920,
                height: 1080,
                scale: 0.0,
            },
        ];

        assert_eq!(
            map_capture_point_to_stream_layout(&streams, &layout, 2500, 500, 3840, 1080),
            Some((2500, 500))
        );
        assert_eq!(
            map_capture_point_to_stream_layout(&streams, &layout, 5000, 1000, 7680, 2160),
            None
        );
    }

    #[tokio::test]
    async fn release_cleanup_retains_portal_and_cross_backend_guards() {
        let portal_lock = Arc::new(AsyncMutex::new(()));
        let operation_lock = Arc::new(AsyncMutex::new(()));
        let portal_guard = Arc::clone(&portal_lock).lock_owned().await;
        let operation_guard =
            InputOperationGuard::new(Arc::clone(&operation_lock).lock_owned().await);
        let caller_operation_guard = operation_guard.clone();
        let (finish_tx, finish_rx) = tokio::sync::oneshot::channel();
        let (finished_tx, finished_rx) = tokio::sync::oneshot::channel();

        spawn_release_cleanup(Some(portal_guard), Some(operation_guard), async move {
            let _ = finish_rx.await;
            let _ = finished_tx.send(());
        });

        assert!(portal_lock.try_lock().is_err());
        assert!(operation_lock.try_lock().is_err());
        finish_tx.send(()).expect("release cleanup stopped early");
        tokio::time::timeout(Duration::from_secs(1), finished_rx)
            .await
            .expect("release cleanup did not finish")
            .expect("release cleanup dropped its completion marker");
        tokio::task::yield_now().await;
        assert!(portal_lock.try_lock().is_ok());
        assert!(operation_lock.try_lock().is_err());
        drop(caller_operation_guard);
        assert!(operation_lock.try_lock().is_ok());
    }

    #[test]
    fn scaled_gnome_stream_gets_physical_coordinates() {
        // Issue #169: 1920x1200 at 125 % is a 1536x960 logical monitor. mutter
        // maps stream_x to monitor.x + stream_x / 1.25, so a logical point
        // must be sent multiplied by 1.25 to land where it was aimed.
        let mut streams = [PortalStream {
            node_id: 7,
            position: Some((0, 0)),
            size: Some((1536, 960)),
            pixel_scale: 1.0,
        }];
        let layout = [LogicalMonitor {
            x: 0,
            y: 0,
            width: 1536,
            height: 960,
            scale: 1.25,
        }];
        assign_stream_pixel_scales(&mut streams, Some(&layout));
        assert_eq!(streams[0].pixel_scale, 1.25);

        // Calculator "7" at logical (632, 626).
        let (node, x, y) = streams[0].relative_point(632, 626);
        assert_eq!(node, 7);
        assert_eq!(
            (x / 1.25, y / 1.25),
            (632.0, 626.0),
            "mutter's divide must undo the scale"
        );
        assert_eq!((x, y), (790.0, 782.5));
    }

    #[test]
    fn unmatched_monitor_or_bad_scale_keeps_unit_stream_scale() {
        let mut streams = [
            PortalStream {
                node_id: 1,
                position: Some((0, 0)),
                size: Some((1536, 960)),
                pixel_scale: 1.0,
            },
            PortalStream {
                node_id: 2,
                position: Some((1536, 0)),
                size: Some((1920, 1080)),
                pixel_scale: 1.0,
            },
        ];
        let layout = [
            LogicalMonitor {
                x: 0,
                y: 0,
                width: 1536,
                height: 960,
                scale: f64::NAN,
            },
            LogicalMonitor {
                x: 5000,
                y: 0,
                width: 1920,
                height: 1080,
                scale: 2.0,
            },
        ];
        assign_stream_pixel_scales(&mut streams, Some(&layout));
        assert_eq!(streams[0].pixel_scale, 1.0, "non-finite scale is ignored");
        assert_eq!(streams[1].pixel_scale, 1.0, "no monitor with this rect");

        assign_stream_pixel_scales(&mut streams, None);
        assert_eq!(streams[0].relative_point(10, 20), (1, 10.0, 20.0));
    }

    #[test]
    fn only_mutter_logical_layout_mode_counts_as_scaled_stage_views() {
        let mode =
            |value: u32| HashMap::from([("layout-mode".to_string(), OwnedValue::from(value))]);
        assert!(layout_mode_is_logical(&mode(1)));
        assert!(!layout_mode_is_logical(&mode(2)));
        assert!(!layout_mode_is_logical(&HashMap::new()));
    }

    #[test]
    fn device_select_persistence_is_opt_in_and_drops_unusable_tokens() {
        assert_eq!(
            device_select_persistence(false, Some("abcDEF-123")),
            DeviceSelectPersistence {
                persist_mode: None,
                restore_token: None,
            }
        );
        assert_eq!(
            device_select_persistence(true, None),
            DeviceSelectPersistence {
                persist_mode: Some(PERSIST_MODE_UNTIL_REVOKED),
                restore_token: None,
            }
        );
        assert_eq!(
            device_select_persistence(true, Some("abcDEF-123_+/=.")),
            DeviceSelectPersistence {
                persist_mode: Some(PERSIST_MODE_UNTIL_REVOKED),
                restore_token: Some("abcDEF-123_+/=.".to_string()),
            }
        );
        assert_eq!(
            device_select_persistence(true, Some("has space")).restore_token,
            None
        );
        assert!(acceptable_restore_token("tökën"));
        assert!(acceptable_restore_token(&"a".repeat(RESTORE_TOKEN_MAX_LEN)));
        assert!(!acceptable_restore_token(""));
        assert!(!acceptable_restore_token("line\nbreak"));
        assert!(!acceptable_restore_token("tab\there"));
        assert!(!acceptable_restore_token(
            &"a".repeat(RESTORE_TOKEN_MAX_LEN + 1)
        ));
    }

    #[test]
    fn remote_desktop_screencast_options_omit_persistence() {
        let mut options = HashMap::new();
        insert_screencast_source_options(&mut options, "handle");
        assert!(options.contains_key("types"));
        assert!(options.contains_key("multiple"));
        assert!(options.contains_key("cursor_mode"));
        assert!(!options.contains_key("persist_mode"));
        assert!(!options.contains_key("restore_token"));
    }

    #[test]
    fn an_unusable_grant_drops_the_restore_token() {
        let kept = ParsedRestoreToken::Usable("good-token".to_string());
        match restore_token_to_keep(true, kept) {
            ParsedRestoreToken::Usable(token) => assert_eq!(token, "good-token"),
            _ => panic!("a usable grant should keep its restore token"),
        }
        assert!(matches!(
            restore_token_to_keep(false, ParsedRestoreToken::Usable("good-token".to_string())),
            ParsedRestoreToken::Absent
        ));
    }

    #[test]
    fn start_results_keep_only_a_usable_restore_token() {
        let mut results = HashMap::from([(
            "restore_token".to_string(),
            owned_portal_string("good-token"),
        )]);
        match parse_restore_token(&results) {
            ParsedRestoreToken::Usable(token) => assert_eq!(token, "good-token"),
            _ => panic!("expected a usable restore token"),
        }

        results.insert(
            "restore_token".to_string(),
            owned_portal_string("bad token"),
        );
        assert!(matches!(
            parse_restore_token(&results),
            ParsedRestoreToken::Rejected
        ));

        results.insert("restore_token".to_string(), OwnedValue::from(1u32));
        assert!(matches!(
            parse_restore_token(&results),
            ParsedRestoreToken::Rejected
        ));

        results.remove("restore_token");
        assert!(matches!(
            parse_restore_token(&results),
            ParsedRestoreToken::Absent
        ));
    }

    #[test]
    fn restore_token_state_dir_uses_an_absolute_xdg_state_home_only() {
        assert_eq!(
            remote_desktop_state_dir(Some("/var/state"), Some("/home/user")).unwrap(),
            PathBuf::from("/var/state/codex-computer-use-linux")
        );
        assert_eq!(
            remote_desktop_state_dir(Some(" /var/state "), Some("/home/user")).unwrap(),
            PathBuf::from("/var/state/codex-computer-use-linux")
        );
        assert_eq!(
            remote_desktop_state_dir(Some("relative"), Some("/home/user")).unwrap(),
            PathBuf::from("/home/user/.local/state/codex-computer-use-linux")
        );
        assert_eq!(
            remote_desktop_state_dir(Some(""), Some("/home/user")).unwrap(),
            PathBuf::from("/home/user/.local/state/codex-computer-use-linux")
        );
        assert!(remote_desktop_state_dir(Some("  "), None).is_none());
        assert!(remote_desktop_state_dir(None, Some("relative")).is_none());
        assert!(remote_desktop_state_dir(None, None).is_none());
    }

    #[test]
    fn restore_tokens_are_private_single_use_and_per_device() {
        let dir = TempState::new();
        let pointer = RestorePermit::acquire_in(&dir.path, PortalDeviceKind::Pointer).unwrap();
        let keyboard = RestorePermit::acquire_in(&dir.path, PortalDeviceKind::Keyboard).unwrap();
        assert_eq!(pointer.token(), None);
        assert_eq!(keyboard.token(), None);
        let dir_mode = std::fs::metadata(&dir.path).unwrap().permissions().mode() & 0o777;
        assert_eq!(dir_mode, 0o700);

        pointer
            .commit(ParsedRestoreToken::Usable("pointer-token".to_string()))
            .unwrap();
        keyboard
            .commit(ParsedRestoreToken::Usable("keyboard-token".to_string()))
            .unwrap();

        let pointer_path = dir.path.join("remote-desktop-pointer.token");
        let keyboard_path = dir.path.join("remote-desktop-keyboard.token");
        assert_eq!(
            std::fs::metadata(&pointer_path)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert_eq!(
            std::fs::read_to_string(&pointer_path).unwrap(),
            "pointer-token"
        );
        assert_eq!(
            std::fs::read_to_string(&keyboard_path).unwrap(),
            "keyboard-token"
        );

        let pointer = RestorePermit::acquire_in(&dir.path, PortalDeviceKind::Pointer).unwrap();
        assert_eq!(pointer.token(), Some("pointer-token"));
        pointer.commit(ParsedRestoreToken::Absent).unwrap();
        assert!(!pointer_path.exists());

        let keyboard = RestorePermit::acquire_in(&dir.path, PortalDeviceKind::Keyboard).unwrap();
        assert_eq!(keyboard.token(), Some("keyboard-token"));
        keyboard.commit(ParsedRestoreToken::Rejected).unwrap();
        assert!(!keyboard_path.exists());
    }

    #[test]
    fn restore_token_lock_wait_is_bounded() {
        let dir = TempState::new();
        let _held = RestorePermit::acquire_in(&dir.path, PortalDeviceKind::Pointer).unwrap();
        let started = std::time::Instant::now();
        let error = match RestorePermit::acquire_in_for(
            &dir.path,
            PortalDeviceKind::Pointer,
            std::time::Duration::from_millis(80),
        ) {
            Err(error) => error,
            Ok(_) => panic!("second permit acquired a held lock"),
        };
        assert_eq!(error.kind(), std::io::ErrorKind::TimedOut);
        let elapsed = started.elapsed();
        assert!(
            elapsed >= std::time::Duration::from_millis(80),
            "gave up too early: {elapsed:?}"
        );
        assert!(
            elapsed < std::time::Duration::from_secs(2),
            "lock wait was not bounded: {elapsed:?}"
        );
    }

    #[test]
    fn a_second_reader_waits_for_the_replacement_token() {
        let dir = TempState::new();
        RestorePermit::acquire_in(&dir.path, PortalDeviceKind::Pointer)
            .unwrap()
            .commit(ParsedRestoreToken::Usable("first-token".to_string()))
            .unwrap();
        let held = RestorePermit::acquire_in(&dir.path, PortalDeviceKind::Pointer).unwrap();
        assert_eq!(held.token(), Some("first-token"));

        let path = dir.path.clone();
        let reader = std::thread::spawn(move || {
            RestorePermit::acquire_in(&path, PortalDeviceKind::Pointer).unwrap()
        });
        held.commit(ParsedRestoreToken::Usable("second-token".to_string()))
            .unwrap();
        let next = reader.join().expect("second reader");
        assert_eq!(next.token(), Some("second-token"));
    }

    #[test]
    fn loose_invalid_or_symlinked_restore_tokens_are_not_used() {
        let dir = TempState::new();
        RestorePermit::acquire_in(&dir.path, PortalDeviceKind::Pointer)
            .unwrap()
            .commit(ParsedRestoreToken::Usable("pointer-token".to_string()))
            .unwrap();
        let token_path = dir.path.join("remote-desktop-pointer.token");
        std::fs::set_permissions(&token_path, std::fs::Permissions::from_mode(0o644)).unwrap();
        let permit = RestorePermit::acquire_in(&dir.path, PortalDeviceKind::Pointer).unwrap();
        assert_eq!(permit.token(), None);
        assert!(!token_path.exists());
        permit
            .commit(ParsedRestoreToken::Usable("pointer-token".to_string()))
            .unwrap();

        std::fs::write(&token_path, "bad token\n").unwrap();
        std::fs::set_permissions(&token_path, std::fs::Permissions::from_mode(0o600)).unwrap();
        let permit = RestorePermit::acquire_in(&dir.path, PortalDeviceKind::Pointer).unwrap();
        assert_eq!(permit.token(), None);
        assert!(!token_path.exists());
        drop(permit);

        let outside = dir.path.join("outside-secret");
        std::fs::write(&outside, "super-secret-token").unwrap();
        std::os::unix::fs::symlink(&outside, &token_path).unwrap();
        let permit = RestorePermit::acquire_in(&dir.path, PortalDeviceKind::Pointer).unwrap();
        assert_eq!(permit.token(), None);
        assert_eq!(
            std::fs::read_to_string(&outside).unwrap(),
            "super-secret-token"
        );
        assert!(!token_path.exists());
    }

    #[test]
    fn a_symlinked_state_directory_is_refused() {
        let parent = TempState::new();
        let real = parent.path.join("real");
        let linked = parent.path.join("linked");
        std::fs::create_dir(&real).unwrap();
        std::os::unix::fs::symlink(&real, &linked).unwrap();
        let Err(error) = RestorePermit::acquire_in(&linked, PortalDeviceKind::Pointer) else {
            panic!("symlinked state directory was accepted");
        };
        assert_eq!(error.kind(), std::io::ErrorKind::AlreadyExists);
        assert!(std::fs::read_dir(&real).unwrap().next().is_none());
    }

    fn owned_portal_string(value: &str) -> OwnedValue {
        OwnedValue::try_from(zbus::zvariant::Value::from(value)).expect("string portal value")
    }

    struct TempState {
        path: PathBuf,
    }

    impl TempState {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(1);
            let nonce = NEXT.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "cul-rd-persist-{}-{}-{nonce}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|duration| duration.as_nanos())
                    .unwrap_or(0)
            ));
            std::fs::create_dir_all(&path).expect("create temp state dir");
            Self { path }
        }
    }

    impl Drop for TempState {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }
}
