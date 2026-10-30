use crate::windowing::registry::{
    self, COSMIC_WAYLAND_BACKEND, GNOME_SHELL_EXTENSION_BACKEND, GNOME_SHELL_INTROSPECT_BACKEND,
    HYPRLAND_BACKEND, I3_BACKEND, KWIN_BACKEND, LABWC_BACKEND, NIRI_BACKEND, X11_BACKEND,
};
use crate::ydotool;
use schemars::JsonSchema;
use serde::Serialize;
use std::{
    collections::{BTreeMap, HashMap},
    env, fs,
    fs::OpenOptions,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
    process::Command,
    sync::Mutex,
};

const DESKTOP_ENV_KEYS: &[&str] = &[
    "DBUS_SESSION_BUS_ADDRESS",
    "DESKTOP_SESSION",
    "DISPLAY",
    "HYPRLAND_INSTANCE_SIGNATURE",
    "NIRI_SOCKET",
    "XAUTHORITY",
    "YDOTOOL_SOCKET",
    "XDG_SESSION_DESKTOP",
    "WAYLAND_DISPLAY",
    "XDG_CURRENT_DESKTOP",
    "XDG_RUNTIME_DIR",
    "XDG_SESSION_TYPE",
];
const FORCE_YDOTOOL_KEYBOARD_ENV_KEYS: &[&str] = &[
    "COMPUTER_USE_LINUX_FORCE_YDOTOOL_KEYBOARD",
    "CODEX_COMPUTER_USE_FORCE_YDOTOOL_KEYBOARD",
];
const FORCE_YDOTOOL_POINTER_ENV_KEYS: &[&str] = &[
    "COMPUTER_USE_LINUX_FORCE_YDOTOOL_POINTER",
    "CODEX_COMPUTER_USE_FORCE_YDOTOOL_POINTER",
];
const FORCE_XDOTOOL_KEYBOARD_ENV_KEYS: &[&str] = &[
    "COMPUTER_USE_LINUX_FORCE_XDOTOOL_KEYBOARD",
    "CODEX_COMPUTER_USE_FORCE_XDOTOOL_KEYBOARD",
];
const FORCE_PORTAL_KEYBOARD_ENV_KEYS: &[&str] = &[
    "COMPUTER_USE_LINUX_FORCE_PORTAL_KEYBOARD",
    "CODEX_COMPUTER_USE_FORCE_PORTAL_KEYBOARD",
];
const FORCE_PORTAL_POINTER_ENV_KEYS: &[&str] = &[
    "COMPUTER_USE_LINUX_FORCE_PORTAL_POINTER",
    "CODEX_COMPUTER_USE_FORCE_PORTAL_POINTER",
];
const PORTAL_DEVICE_KEYBOARD: u32 = 1;
const PORTAL_DEVICE_POINTER: u32 = 2;
const PORTAL_CURSOR_MODE_HIDDEN: u32 = 1;
const PORTAL_SOURCE_MONITOR: u32 = 1;
const SCREENCAST_CURSOR_MODE_VERSION: u32 = 2;
const REMOTE_DESKTOP_KEYBOARD_METHODS: &[&str] = &[
    "CreateSession",
    "SelectDevices",
    "Start",
    "NotifyKeyboardKeycode",
    "NotifyKeyboardKeysym",
];
const REMOTE_DESKTOP_POINTER_METHODS: &[&str] = &[
    "CreateSession",
    "SelectDevices",
    "Start",
    "NotifyPointerMotionAbsolute",
    "NotifyPointerButton",
    "NotifyPointerAxisDiscrete",
];
const SCREENCAST_POINTER_METHODS: &[&str] = &["SelectSources"];
// Methods each standalone portal entry must export before doctor reports it.
// `busctl introspect` exits 0 and prints only its header for an interface the
// portal does not export, so exit status alone proves nothing (issue #156).
const SCREENSHOT_PORTAL_METHODS: &[&str] = &["Screenshot"];
const SCREENCAST_PORTAL_METHODS: &[&str] = &["CreateSession", "SelectSources", "Start"];
const INPUT_CAPTURE_PORTAL_METHODS: &[&str] = &["GetZones", "Enable", "ConnectToEIS"];

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct DoctorReport {
    pub platform: PlatformReport,
    pub portals: PortalReport,
    pub accessibility: AccessibilityReport,
    pub windowing: WindowingReport,
    pub input: InputReport,
    pub readiness: ReadinessReport,
    /// Which interchangeable backends this environment supports, per layer, plus
    /// the one the tool prefers. Lets an agent (or selector) understand what's
    /// available and choose accordingly instead of assuming one fixed path.
    pub capabilities: CapabilityMap,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct CapabilityMap {
    /// Pointer/keyboard injection backends, best-first.
    pub input: Vec<String>,
    /// Screen capture backends, best-first.
    pub screenshot: Vec<String>,
    /// Window listing/focus backends available.
    pub window_control: Vec<String>,
    /// Accessibility (element-targeted, non-pointer) backends.
    pub accessibility: Vec<String>,
    /// Display/session isolation contexts the host can provide.
    pub isolation: Vec<String>,
    /// The backend the tool will use by default for each selectable layer.
    pub preferred: PreferredBackends,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct PreferredBackends {
    pub input: Option<String>,
    pub screenshot: Option<String>,
    pub window_control: Option<String>,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct PlatformReport {
    pub os: String,
    pub arch: String,
    pub desktop_session: Option<String>,
    pub xdg_session_type: Option<String>,
    pub xdg_current_desktop: Option<String>,
    pub wayland_display: Option<String>,
    pub display: Option<String>,
    pub xauthority: Option<String>,
    pub dbus_session_bus_address: Option<String>,
    pub xdg_runtime_dir: Option<String>,
    pub gnome_shell_version: Check,
    pub gnome_screenshot: Check,
    /// Native X11 display for the root-window screenshot route. Fails on
    /// Wayland sessions, including XWayland, by design.
    pub x11_display: Check,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct PortalReport {
    pub desktop_portal: Check,
    pub remote_desktop: Check,
    pub remote_desktop_keyboard: Check,
    pub screencast: Check,
    pub screenshot: Check,
    pub input_capture: Check,
    pub mutter_remote_desktop: Check,
    pub mutter_screencast: Check,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct AccessibilityReport {
    pub at_spi_bus: Check,
    pub toolkit_accessibility: Check,
    pub at_spi_enabled: Check,
    pub screen_reader_enabled: Check,
    pub forced_toolkit_bridge: bool,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct WindowingReport {
    pub gnome_shell_introspect: Check,
    pub codex_gnome_shell_extension: Check,
    pub codex_gnome_shell_extension_screenshot: Check,
    pub cosmic_helper: Check,
    pub kwin: Check,
    pub hyprland: Check,
    pub niri: Check,
    pub backends: BTreeMap<String, Check>,
    pub can_list_windows: bool,
    pub can_focus_apps: bool,
    pub can_focus_windows: bool,
    pub note: String,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct InputReport {
    pub ydotool: Check,
    pub ydotoold: Check,
    pub ydotool_socket: Check,
    pub uinput: Check,
    /// X11 XTEST keyboard backend. Preferred over ydotool on X11 sessions,
    /// where raw evdev scancodes are re-mapped by the active XKB layout.
    pub xdotool: Check,
    /// Wayland virtual-keyboard backend for layout-safe Unicode literal text.
    pub wtype: Check,
    /// Selkies pixelflux computer-use server. Detail is the port only.
    pub pixelflux: Check,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct ReadinessReport {
    pub can_register_mcp_tools: bool,
    pub can_build_accessibility_tree: bool,
    pub can_query_windows: bool,
    pub can_focus_apps: bool,
    pub can_focus_windows: bool,
    pub can_send_development_input: bool,
    /// A raw screenshot was successfully captured while producing this report.
    /// Doctor only detects routes, so this remains false until capture is tested.
    pub can_capture_screenshots: bool,
    pub screenshot_capture_status: ScreenshotCaptureStatus,
    pub recommended_next_step: String,
    pub blockers: Vec<String>,
    /// Untested capabilities and optional remediation, without blocking setup.
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ScreenshotCaptureStatus {
    /// No backend route was detected; no capture was attempted.
    Unavailable,
    /// At least one route was detected; no capture was attempted.
    Unverified,
    /// A raw screenshot was captured successfully for this report.
    Verified,
    /// The raw capture attempted for this report failed.
    Failed,
}

const SCREENSHOT_UNAVAILABLE: &str = "No screenshot route was detected: GNOME Shell is absent, the XDG portal does not export org.freedesktop.portal.Screenshot, this is not a native X11 session, and gnome-screenshot is not installed. get_app_state and screenshot return no image; element-aware actions from the accessibility tree still work.";
const SCREENSHOT_UNVERIFIED: &str = "Screenshot routes were detected, but capture is unverified. Doctor does not take a screenshot or check screenshot consent. GNOME Shell can reject callers, and a portal may require consent for the caller's app ID. Call screenshot or get_app_state to verify capture.";
const SCREENSHOT_MISSING_GNOME_FALLBACK: &str = "gnome-screenshot is not installed. On GNOME it provides a fallback when Shell or portal calls are denied; install it or inspect the desktop portal logs and screenshot permissions for the actual caller.";
const SCREENSHOT_FAILED: &str = "Screenshot capture failed for this request. Inspect screenshot_error for the full backend errors; accessibility-tree actions still work.";
const SCREENSHOT_FAILED_NEXT_STEP: &str = "Inspect screenshot_error and the desktop portal logs for the failed capture. On GNOME, gnome-screenshot can provide a fallback when Shell or portal calls are denied.";
const READY_NEXT_STEP: &str = "Computer Use is ready: AT-SPI tree support, window targeting, and a Linux input backend are available.";

impl ReadinessReport {
    /// Record only the raw backend capture, before crop or encoding can fail.
    pub(crate) fn record_screenshot_result(&mut self, succeeded: bool) {
        self.can_capture_screenshots = succeeded;
        self.screenshot_capture_status = if succeeded {
            ScreenshotCaptureStatus::Verified
        } else {
            ScreenshotCaptureStatus::Failed
        };
        self.warnings.retain(|warning| {
            warning != SCREENSHOT_UNVERIFIED && warning != SCREENSHOT_MISSING_GNOME_FALLBACK
        });
        self.blockers
            .retain(|blocker| blocker != SCREENSHOT_UNAVAILABLE && blocker != SCREENSHOT_FAILED);
        if !succeeded {
            self.blockers.push(SCREENSHOT_FAILED.to_string());
        }
        if self.can_build_accessibility_tree
            && self.can_query_windows
            && self.can_focus_windows
            && self.can_send_development_input
        {
            self.recommended_next_step = if succeeded {
                READY_NEXT_STEP
            } else {
                SCREENSHOT_FAILED_NEXT_STEP
            }
            .to_string();
        }
    }
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct SetupReport {
    pub before: DoctorReport,
    pub accessibility_command: Check,
    pub after: DoctorReport,
    pub changed_accessibility: bool,
    pub requires_target_app_restart: bool,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct Check {
    pub ok: bool,
    pub detail: String,
}

impl Check {
    fn ok(detail: impl Into<String>) -> Self {
        Self {
            ok: true,
            detail: detail.into(),
        }
    }

    fn fail(detail: impl Into<String>) -> Self {
        Self {
            ok: false,
            detail: detail.into(),
        }
    }
}

pub fn doctor_report() -> DoctorReport {
    hydrate_session_bus_env();

    let platform = platform_report();
    let portals = portal_report();
    let accessibility = accessibility_report();
    let windowing = windowing_report(&platform);
    let input = input_report();
    let readiness = readiness_report_with_portal_keyboard(
        &platform,
        &portals.remote_desktop_keyboard,
        &accessibility,
        &windowing,
        &input,
        !screenshot_backends(&platform, &portals, &windowing, &input).is_empty(),
    );

    let capabilities = capability_map_with_portal_keyboard(
        &platform,
        &portals,
        &portals.remote_desktop_keyboard,
        &accessibility,
        &windowing,
        &input,
    );

    DoctorReport {
        platform,
        portals,
        accessibility,
        windowing,
        input,
        readiness,
        capabilities,
    }
}

/// Derive the per-layer backend capability map from the individual checks. Lists
/// are ordered best-first and mirror the order the tool actually tries them.
#[cfg(test)]
fn capability_map(
    platform: &PlatformReport,
    portals: &PortalReport,
    accessibility: &AccessibilityReport,
    windowing: &WindowingReport,
    input: &InputReport,
) -> CapabilityMap {
    capability_map_with_portal_keyboard(
        platform,
        portals,
        &portals.remote_desktop,
        accessibility,
        windowing,
        input,
    )
}

fn capability_map_with_portal_keyboard(
    platform: &PlatformReport,
    portals: &PortalReport,
    remote_desktop_keyboard: &Check,
    accessibility: &AccessibilityReport,
    windowing: &WindowingReport,
    input: &InputReport,
) -> CapabilityMap {
    let mut input_backends = Vec::new();
    if input.pixelflux.ok {
        input_backends.push("pixelflux".to_string());
    }
    // Absolute uinput pointer: accurate, non-blocking of coordinates; preferred.
    if input.uinput.ok && platform_is_wayland(platform) && !is_cosmic_wayland_platform(platform) {
        input_backends.push("abs_pointer".to_string());
    }
    let force_ydotool = env_flag_enabled_any(FORCE_YDOTOOL_KEYBOARD_ENV_KEYS);
    let force_xdotool = env_flag_enabled_any(FORCE_XDOTOOL_KEYBOARD_ENV_KEYS);
    let force_portal_keyboard = env_flag_enabled_any(FORCE_PORTAL_KEYBOARD_ENV_KEYS);
    let portal_pointer_available = portal_pointer_input_available(platform, portals);
    let portal_keyboard_available =
        portal_keyboard_input_available(platform, remote_desktop_keyboard);
    let portal_available = portal_pointer_available || portal_keyboard_available;
    let portal_forced_for_all_input = portal_pointer_available
        && portal_keyboard_available
        && force_portal_for_all_input(
            env_flag_enabled_any(FORCE_PORTAL_POINTER_ENV_KEYS),
            env_flag_enabled_any(FORCE_PORTAL_KEYBOARD_ENV_KEYS),
            env_flag_enabled_any(FORCE_YDOTOOL_POINTER_ENV_KEYS),
            force_ydotool,
        );
    if should_advertise_xdotool(platform, input, force_ydotool, force_xdotool) {
        input_backends.push("xdotool".to_string());
    }
    if should_advertise_wtype(
        platform,
        input,
        force_ydotool,
        force_xdotool,
        force_portal_keyboard,
    ) {
        input_backends.push("wtype".to_string());
    }
    let portal_first = portal_forced_for_all_input
        || (is_cosmic_wayland_platform(platform)
            && portal_pointer_available
            && !env_flag_enabled_any(FORCE_YDOTOOL_POINTER_ENV_KEYS));
    if portal_available && portal_first {
        input_backends.push("portal".to_string());
    }
    if input.ydotool.ok && input.ydotool_socket.ok {
        input_backends.push("ydotool".to_string());
    }
    if portal_available && !portal_first {
        input_backends.push("portal".to_string());
    }

    let screenshot_backends = screenshot_backends(platform, portals, windowing, input);

    let mut window_backends = Vec::new();
    let x11_available = windowing
        .backends
        .get(X11_BACKEND)
        .is_some_and(|check| check.ok);
    let prefer_x11_over_introspect = windowing.gnome_shell_introspect.ok
        && x11_available
        && registry::backend_can_exact_focus(X11_BACKEND);
    if windowing.codex_gnome_shell_extension.ok {
        window_backends.push("gnome_shell_extension".to_string());
    }
    if prefer_x11_over_introspect {
        window_backends.push(X11_BACKEND.to_string());
    }
    if windowing.gnome_shell_introspect.ok {
        window_backends.push("gnome_introspect".to_string());
    }
    if windowing.cosmic_helper.ok {
        window_backends.push("cosmic".to_string());
    }
    if windowing.kwin.ok {
        window_backends.push("kwin".to_string());
    }
    if windowing.hyprland.ok {
        window_backends.push("hyprland".to_string());
    }
    if windowing.niri.ok {
        window_backends.push(NIRI_BACKEND.to_string());
    }
    // i3, labwc and the generic X11/EWMH backend have no dedicated
    // WindowingReport field; read them from the probe map so the capability
    // list matches the registry order.
    for backend in [I3_BACKEND, LABWC_BACKEND] {
        if windowing
            .backends
            .get(backend)
            .is_some_and(|check| check.ok)
        {
            window_backends.push(backend.to_string());
        }
    }
    if x11_available && !prefer_x11_over_introspect {
        window_backends.push(X11_BACKEND.to_string());
    }

    let mut accessibility_backends = Vec::new();
    if can_build_accessibility_tree(accessibility) {
        accessibility_backends.push("at_spi".to_string());
    }

    // Isolation contexts: the live shared session is always available; a headless
    // GNOME session is possible when gnome-shell is installed (it supports
    // --headless --virtual-monitor), giving the agent its own seat.
    let mut isolation = vec!["shared".to_string()];
    if platform.gnome_shell_version.ok {
        isolation.push("headless_gnome".to_string());
    }

    let preferred = PreferredBackends {
        input: input_backends.first().cloned(),
        screenshot: screenshot_backends.first().cloned(),
        window_control: window_backends.first().cloned(),
    };

    CapabilityMap {
        input: input_backends,
        screenshot: screenshot_backends,
        window_control: window_backends,
        accessibility: accessibility_backends,
        isolation,
        preferred,
    }
}

pub fn hydrate_session_bus_env() {
    static HYDRATED_ENV: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);
    let mut hydrated = HYDRATED_ENV
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let current = desktop_environment();
    if hydrated.as_ref() == Some(&current) {
        return;
    }
    hydrate_common_command_path();
    hydrate_desktop_env_from_process_tree();
    let systemd_discovery_succeeded = hydrate_desktop_env_from_systemd_user();

    if env_var("XDG_RUNTIME_DIR").is_none() {
        if let Some(runtime) = xdg_runtime_dir() {
            if runtime.exists() {
                env::set_var("XDG_RUNTIME_DIR", runtime);
            }
        }
    }

    if env_var("DBUS_SESSION_BUS_ADDRESS").is_none() {
        if let Some(runtime) = xdg_runtime_dir() {
            let bus = runtime.join("bus");
            if bus.exists() {
                env::set_var(
                    "DBUS_SESSION_BUS_ADDRESS",
                    format!("unix:path={}", bus.display()),
                );
            }
        }
    }
    let current = desktop_environment();
    if systemd_discovery_succeeded
        && current.contains_key("DBUS_SESSION_BUS_ADDRESS")
        && current.contains_key("XDG_RUNTIME_DIR")
        && current.contains_key("XDG_CURRENT_DESKTOP")
        && current.contains_key("XDG_SESSION_TYPE")
        && process_env_has_graphical_display(&current)
    {
        *hydrated = Some(current);
    }
}

fn desktop_environment() -> HashMap<String, String> {
    DESKTOP_ENV_KEYS
        .iter()
        .copied()
        .chain(["PATH"])
        .filter_map(|key| env_var(key).map(|value| (key.to_string(), value)))
        .collect()
}

fn hydrate_common_command_path() {
    let mut entries = env::var_os("PATH")
        .map(|path| env::split_paths(&path).collect::<Vec<_>>())
        .unwrap_or_default();
    for path in [
        "/run/current-system/sw/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
    ] {
        let path = PathBuf::from(path);
        if path.exists() && !entries.iter().any(|entry| entry == &path) {
            entries.push(path);
        }
    }
    if let Ok(path) = env::join_paths(entries) {
        env::set_var("PATH", path);
    }
}

fn hydrate_desktop_env_from_process_tree() {
    for process_env in desktop_process_environments() {
        hydrate_desktop_env_from_map(&process_env);

        if DESKTOP_ENV_KEYS.iter().all(|key| env_var(key).is_some()) {
            break;
        }
    }
}

fn hydrate_desktop_env_from_systemd_user() -> bool {
    let mut command = Command::new("systemctl");
    command.args(["--user", "show-environment"]);
    let Ok(output) =
        crate::command_runner::output_blocking(&mut command, "read systemd user environment")
    else {
        return false;
    };
    if !output.status.success() {
        return false;
    }
    let env_map = parse_line_environment(&output.stdout);
    hydrate_desktop_env_from_map(&env_map);
    true
}

fn hydrate_desktop_env_from_map(process_env: &HashMap<String, String>) {
    let current_env = DESKTOP_ENV_KEYS
        .iter()
        .filter_map(|key| env_var(key).map(|value| ((*key).to_string(), value)))
        .collect();
    for (key, value) in desktop_env_hydration_updates(&current_env, process_env) {
        env::set_var(key, value);
    }
}

fn desktop_env_hydration_updates(
    current_env: &HashMap<String, String>,
    source_env: &HashMap<String, String>,
) -> Vec<(&'static str, String)> {
    // A nested X11 desktop can share a user manager with a Wayland host.
    // Preserve its complete process-local session instead of grafting the
    // host's WAYLAND_DISPLAY onto it.
    let preserve_native_x11 = current_env
        .get("XDG_SESSION_TYPE")
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("x11"))
        && current_env
            .get("DISPLAY")
            .is_some_and(|value| !value.trim().is_empty())
        && current_env
            .get("WAYLAND_DISPLAY")
            .is_none_or(|value| value.trim().is_empty());

    DESKTOP_ENV_KEYS
        .iter()
        .filter_map(|key| {
            if current_env
                .get(*key)
                .is_some_and(|value| !value.trim().is_empty())
                || preserve_native_x11 && *key == "WAYLAND_DISPLAY"
            {
                return None;
            }
            source_env
                .get(*key)
                .filter(|value| !value.trim().is_empty())
                .map(|value| (*key, value.clone()))
        })
        .collect()
}

fn desktop_process_environments() -> Vec<HashMap<String, String>> {
    let mut environments = Vec::new();
    let mut visited_pids = Vec::new();
    let mut pid = parent_pid("self");

    for _ in 0..8 {
        let Some(current_pid) = pid else {
            break;
        };
        if current_pid <= 1 {
            break;
        }

        visited_pids.push(current_pid);
        if let Some(process_env) = read_process_environ(current_pid) {
            environments.push(process_env);
        }
        pid = parent_pid(&current_pid.to_string());
    }

    if !visited_pids.contains(&1) && process_owner_matches_current_user(1) {
        if let Some(process_env) = read_process_environ(1).filter(process_env_has_graphical_display)
        {
            environments.push(process_env);
        }
    }

    environments
}

fn parent_pid(pid: &str) -> Option<u32> {
    let status = fs::read_to_string(format!("/proc/{pid}/status")).ok()?;
    parse_parent_pid(&status)
}

fn parse_parent_pid(status: &str) -> Option<u32> {
    status.lines().find_map(|line| {
        let value = line.strip_prefix("PPid:")?.trim();
        value.parse::<u32>().ok()
    })
}

fn read_process_environ(pid: u32) -> Option<HashMap<String, String>> {
    let bytes = fs::read(format!("/proc/{pid}/environ")).ok()?;
    Some(parse_environ(&bytes))
}

fn process_owner_matches_current_user(pid: u32) -> bool {
    let Some(current_uid) = user_id().and_then(|uid| uid.parse::<u32>().ok()) else {
        return false;
    };
    fs::metadata(format!("/proc/{pid}"))
        .ok()
        .is_some_and(|metadata| metadata.uid() == current_uid)
}

fn process_env_has_graphical_display(process_env: &HashMap<String, String>) -> bool {
    process_env
        .get("DISPLAY")
        .or_else(|| process_env.get("WAYLAND_DISPLAY"))
        .is_some_and(|value| !value.trim().is_empty())
}

fn parse_environ(bytes: &[u8]) -> HashMap<String, String> {
    bytes
        .split(|byte| *byte == 0)
        .filter_map(|entry| {
            if entry.is_empty() {
                return None;
            }
            let split = entry.iter().position(|byte| *byte == b'=')?;
            let (key, value) = entry.split_at(split);
            let value = &value[1..];
            let key = std::str::from_utf8(key).ok()?.to_string();
            let value = std::str::from_utf8(value).ok()?.to_string();
            Some((key, value))
        })
        .collect()
}

fn parse_line_environment(bytes: &[u8]) -> HashMap<String, String> {
    bytes
        .split(|byte| *byte == b'\n')
        .filter_map(|entry| {
            if entry.is_empty() {
                return None;
            }
            let split = entry.iter().position(|byte| *byte == b'=')?;
            let (key, value) = entry.split_at(split);
            let value = &value[1..];
            let key = std::str::from_utf8(key).ok()?.to_string();
            let value = std::str::from_utf8(value).ok()?.to_string();
            Some((key, value))
        })
        .collect()
}

pub fn setup_accessibility_report() -> SetupReport {
    hydrate_session_bus_env();

    let before = doctor_report();
    let accessibility_command =
        enable_accessibility(&before.accessibility, command_check_with_session_bus);
    let after = doctor_report();
    let before_ready = before.readiness.can_build_accessibility_tree;
    let after_ready = after.readiness.can_build_accessibility_tree;
    let saved_before = check_detail_contains_true(&before.accessibility.toolkit_accessibility);
    let saved_after = check_detail_contains_true(&after.accessibility.toolkit_accessibility);
    let changed_accessibility = after_ready && saved_after && (!before_ready || !saved_before);
    let requires_target_app_restart = changed_accessibility;
    let message = if after_ready && !saved_after {
        "AT-SPI is available at runtime, but toolkit-accessibility could not be verified as enabled in GSettings. Newly launched apps may have no accessibility tree. Check accessibility_command and the saved setting; other accessibility tools can change it."
    } else if after_ready {
        if changed_accessibility {
            "AT-SPI accessibility is enabled. Restart already-running target apps if their AT-SPI tree is still empty."
        } else {
            "AT-SPI accessibility is ready."
        }
    } else {
        "Could not enable AT-SPI accessibility automatically. Check the accessibility_command detail and enable org.a11y.Status IsEnabled or org.gnome.desktop.interface toolkit-accessibility manually."
    }
    .to_string();

    SetupReport {
        before,
        accessibility_command,
        after,
        changed_accessibility,
        requires_target_app_restart,
        message,
    }
}

// Runtime IsEnabled does not establish the setting read by newly launched
// GTK apps. Always check the saved key, even when an existing tree is usable.
fn enable_accessibility(
    before: &AccessibilityReport,
    mut run: impl FnMut(&str, &[&str]) -> Check,
) -> Check {
    let setting = if check_detail_contains_true(&before.toolkit_accessibility) {
        before.toolkit_accessibility.clone()
    } else {
        let write = run(
            "gsettings",
            &[
                "set",
                "org.gnome.desktop.interface",
                "toolkit-accessibility",
                "true",
            ],
        );
        let read = run(
            "gsettings",
            &[
                "get",
                "org.gnome.desktop.interface",
                "toolkit-accessibility",
            ],
        );
        if !check_detail_contains_true(&read) {
            let runtime = run(
                "busctl",
                &[
                    "--user",
                    "set-property",
                    "org.a11y.Bus",
                    "/org/a11y/bus",
                    "org.a11y.Status",
                    "IsEnabled",
                    "b",
                    "true",
                ],
            );
            return Check::fail(format!(
                "Saved toolkit-accessibility was not verified: {}; write: {}; runtime fallback: {}",
                read.detail, write.detail, runtime.detail
            ));
        }
        read
    };
    if !can_build_accessibility_tree(before) {
        let runtime = run(
            "busctl",
            &[
                "--user",
                "set-property",
                "org.a11y.Bus",
                "/org/a11y/bus",
                "org.a11y.Status",
                "IsEnabled",
                "b",
                "true",
            ],
        );
        return Check::ok(format!(
            "Saved toolkit-accessibility verified: {}; runtime request: {}",
            setting.detail, runtime.detail
        ));
    }
    Check::ok("Saved toolkit-accessibility is enabled; runtime AT-SPI is available")
}

fn platform_report() -> PlatformReport {
    PlatformReport {
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        desktop_session: env_var("DESKTOP_SESSION"),
        xdg_session_type: env_var("XDG_SESSION_TYPE"),
        xdg_current_desktop: env_var("XDG_CURRENT_DESKTOP"),
        wayland_display: env_var("WAYLAND_DISPLAY"),
        display: env_var("DISPLAY"),
        xauthority: env_var("XAUTHORITY"),
        dbus_session_bus_address: dbus_session_address(),
        xdg_runtime_dir: xdg_runtime_dir().map(|path| path.display().to_string()),
        gnome_shell_version: command_check("gnome-shell", &["--version"]),
        gnome_screenshot: command_check("gnome-screenshot", &["--version"]),
        x11_display: x11_display_check(),
    }
}

fn x11_display_check() -> Check {
    if !crate::x11_display::is_native_x11_session() {
        return Check::fail("not a native X11 session");
    }
    // The transport enforces the deadline, so no detached worker remains
    // blocked after a diagnostic timeout.
    match crate::x11_display::X11Display::connect().map(|display| display.describe()) {
        Ok(detail) => Check::ok(detail),
        Err(error) => Check::fail(format!("{error:#}")),
    }
}

fn portal_report() -> PortalReport {
    let (remote_desktop, remote_desktop_keyboard, screencast) = remote_desktop_portal_checks();
    PortalReport {
        remote_desktop_keyboard,
        desktop_portal: bus_name_check("org.freedesktop.portal.Desktop"),
        remote_desktop,
        screencast,
        screenshot: portal_interface_methods_check(
            "org.freedesktop.portal.Screenshot",
            SCREENSHOT_PORTAL_METHODS,
        ),
        input_capture: portal_interface_methods_check(
            "org.freedesktop.portal.InputCapture",
            INPUT_CAPTURE_PORTAL_METHODS,
        ),
        mutter_remote_desktop: bus_name_check("org.gnome.Mutter.RemoteDesktop"),
        mutter_screencast: bus_name_check("org.gnome.Mutter.ScreenCast"),
    }
}

fn accessibility_report() -> AccessibilityReport {
    AccessibilityReport {
        at_spi_bus: atspi_bus_address_check(),
        toolkit_accessibility: command_check_with_session_bus(
            "gsettings",
            &[
                "get",
                "org.gnome.desktop.interface",
                "toolkit-accessibility",
            ],
        ),
        at_spi_enabled: at_spi_enabled_check(),
        screen_reader_enabled: screen_reader_enabled_check(),
        forced_toolkit_bridge: toolkit_bridge_forced(),
    }
}

fn gdbus_introspect_contains(destination: &str, object_path: &str, needle: &str) -> Check {
    let check = command_check_with_session_bus(
        "gdbus",
        &[
            "introspect",
            "--session",
            "--dest",
            destination,
            "--object-path",
            object_path,
        ],
    );
    if check.ok && check.detail.contains(needle) {
        Check::ok(format!("DBus introspection includes {needle}"))
    } else if check.ok {
        Check::fail(format!("DBus introspection did not include {needle}"))
    } else {
        check
    }
}

fn windowing_report(platform: &PlatformReport) -> WindowingReport {
    let probes = registry::probe_backends();
    let backend_check = |id: &str| {
        probes
            .iter()
            .find(|probe| probe.id == id)
            .map(check_from_backend_probe)
            .unwrap_or_else(|| Check::fail("backend probe did not run"))
    };
    let gnome_shell_introspect = backend_check(GNOME_SHELL_INTROSPECT_BACKEND);
    let codex_gnome_shell_extension = backend_check(GNOME_SHELL_EXTENSION_BACKEND);
    let codex_gnome_shell_extension_screenshot = gdbus_introspect_contains(
        crate::identity::DBUS_SERVICE,
        crate::identity::DBUS_OBJECT_PATH,
        "CaptureScreenshot",
    );
    let cosmic_helper = backend_check(COSMIC_WAYLAND_BACKEND);
    let kwin = backend_check(KWIN_BACKEND);
    let hyprland = backend_check(HYPRLAND_BACKEND);
    let niri = backend_check(NIRI_BACKEND);
    let backends = probes
        .iter()
        .map(|probe| (probe.id.to_string(), check_from_backend_probe(probe)))
        .collect::<BTreeMap<_, _>>();
    let can_list_windows = probes.iter().any(|probe| probe.can_list_windows);
    let can_focus_apps = probes.iter().any(|probe| probe.can_focus_apps);
    let can_focus_windows = probes.iter().any(|probe| probe.can_focus_windows);
    let note = if can_list_windows {
        if !can_focus_windows {
            "A window listing backend is available for list_windows, but focused-window and targeted-input verification are unavailable (for example wmctrl is present but xprop is missing on X11)."
        } else if cosmic_helper.ok && is_cosmic_wayland_platform(platform) {
            "A COSMIC Wayland window backend is available for list_windows, focused_window, and targeted input verification."
        } else if kwin.ok {
            "A KWin/Plasma window backend is available for list_windows, focused_window, and targeted input verification."
        } else if hyprland.ok {
            "A Hyprland window backend is available for list_windows, focused_window, and targeted input verification."
        } else if niri.ok {
            "A niri window backend is available for list_windows, focused_window, and targeted input verification."
        } else {
            "A window listing backend is available for list_windows, focused_window, and targeted input verification."
        }
    } else {
        "Window listing is unavailable or denied. Computer Use can still use screenshots, AT-SPI, and global ydotool input, but targeted window input cannot be verified. On GNOME, run setup_window_targeting to install the optional GNOME Shell extension backend. On COSMIC, ensure the bundled COSMIC helper is present and can connect to the session. On KDE/Plasma, ensure KWin exposes org.kde.KWin scripting on the session bus. On Hyprland, ensure hyprctl is available in the session. On niri, export the session's NIRI_SOCKET or expose an unambiguous matching socket in XDG_RUNTIME_DIR; the niri binary is optional. On labwc, the Selkies IPC socket labwc.sock lists windows."
    }
    .to_string();

    WindowingReport {
        gnome_shell_introspect,
        codex_gnome_shell_extension,
        codex_gnome_shell_extension_screenshot,
        cosmic_helper,
        kwin,
        hyprland,
        niri,
        backends,
        can_list_windows,
        can_focus_apps,
        can_focus_windows,
        note,
    }
}

fn check_from_backend_probe(probe: &registry::BackendProbe) -> Check {
    if probe.ok {
        Check::ok(probe.detail.clone())
    } else {
        Check::fail(probe.detail.clone())
    }
}

fn pixelflux_check() -> Check {
    let Some(config) = crate::pixelflux::PixelfluxConfig::from_env() else {
        return Check::fail("PIXELFLUX_CU is not set");
    };
    let port = config.port;
    let probed = std::thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .ok()?;
        runtime.block_on(crate::pixelflux::probe(&config)).ok()
    })
    .join();
    match probed {
        Ok(Some(())) => Check::ok(port.to_string()),
        _ => Check::fail(format!("{port} unreachable")),
    }
}

fn input_report() -> InputReport {
    InputReport {
        ydotool: match ydotool::ensure_supported() {
            Ok(support) => Check::ok(support.detail),
            Err(detail) => Check::fail(detail),
        },
        ydotoold: process_check("ydotoold"),
        ydotool_socket: ydotool_socket_check(),
        uinput: read_write_path_check(Path::new("/dev/uinput")),
        xdotool: command_path_check("xdotool"),
        wtype: command_path_check("wtype"),
        pixelflux: pixelflux_check(),
    }
}

#[cfg(test)]
fn readiness_report(
    platform: &PlatformReport,
    portals: &PortalReport,
    accessibility: &AccessibilityReport,
    windowing: &WindowingReport,
    input: &InputReport,
) -> ReadinessReport {
    readiness_report_with_portal_keyboard(
        platform,
        &portals.remote_desktop,
        accessibility,
        windowing,
        input,
        !screenshot_backends(platform, portals, windowing, input).is_empty(),
    )
}

/// Screenshot routes in the order `capture_screenshot_raw` tries them. Both the
/// capability map and readiness read this list so they cannot disagree.
fn screenshot_backends(
    platform: &PlatformReport,
    portals: &PortalReport,
    windowing: &WindowingReport,
    input: &InputReport,
) -> Vec<String> {
    let mut backends = Vec::new();
    if input.pixelflux.ok {
        backends.push("pixelflux".to_string());
    }
    if platform.gnome_shell_version.ok {
        backends.push("gnome_shell".to_string());
    }
    if windowing.codex_gnome_shell_extension_screenshot.ok {
        backends.push("codex_gnome_shell_extension".to_string());
    }
    if portals.screenshot.ok {
        backends.push("portal".to_string());
    }
    if platform.x11_display.ok {
        backends.push("x11".to_string());
    }
    // Subprocess fallback for background/systemd contexts the DBus paths reject.
    if platform.gnome_screenshot.ok {
        backends.push("gnome_screenshot".to_string());
    }
    backends
}

fn readiness_report_with_portal_keyboard(
    platform: &PlatformReport,
    remote_desktop_keyboard: &Check,
    accessibility: &AccessibilityReport,
    windowing: &WindowingReport,
    input: &InputReport,
    screenshot_routes_detected: bool,
) -> ReadinessReport {
    let mut blockers = Vec::new();
    let mut warnings = Vec::new();
    let can_build_accessibility_tree = can_build_accessibility_tree(accessibility);
    let can_query_windows = windowing.can_list_windows;
    let can_focus_apps = windowing.can_focus_apps;
    let can_focus_windows = windowing.can_focus_windows;
    let can_send_development_input =
        can_send_development_input(platform, remote_desktop_keyboard, input);

    if let Some(blocker) =
        atspi_disabled_blocker(accessibility, accessibility.forced_toolkit_bridge)
    {
        blockers.push(blocker);
    }

    if !can_query_windows {
        blockers.push(if is_cosmic_wayland_platform(platform) {
            "COSMIC Wayland window introspection is unavailable; targeted window focus and verification will be disabled.".to_string()
        } else {
            "Window introspection is unavailable; targeted window focus and verification will be disabled."
                .to_string()
        });
    }

    if can_query_windows && !can_focus_windows {
        blockers.push(
            "Exact window activation is unavailable; app-level focus may work, but window_id/title/terminal-targeted input cannot be verified."
                .to_string(),
        );
    }

    if !can_send_development_input {
        blockers.push(
            "Development keyboard input is unavailable; enable XDG RemoteDesktop portal input or install wtype on compatible Wayland compositors, install xdotool with DISPLAY on X11, or use ydotool with a connectable ydotoold socket. Read/write /dev/uinput alone provides only absolute pointer input."
                .to_string(),
        );
    }

    if screenshot_routes_detected {
        warnings.push(SCREENSHOT_UNVERIFIED.to_string());
        if platform.gnome_shell_version.ok && !platform.gnome_screenshot.ok {
            warnings.push(SCREENSHOT_MISSING_GNOME_FALLBACK.to_string());
        }
    } else {
        blockers.push(SCREENSHOT_UNAVAILABLE.to_string());
    }

    let recommended_next_step = if !can_build_accessibility_tree {
        "Run setup_accessibility to enable AT-SPI accessibility before element-aware actions."
            .to_string()
    } else if !can_query_windows {
        format!(
            "Enable a supported window backend before using targeted keyboard input: {}",
            registry::descriptors()
                .iter()
                .map(|descriptor| descriptor.missing_hint)
                .collect::<Vec<_>>()
                .join(" ")
        )
    } else if !can_focus_windows {
        "Enable an exact-focus window backend before using window_id, title, or terminal-targeted input.".to_string()
    } else if !can_send_development_input {
        "Enable a keyboard-capable input backend: enable the XDG RemoteDesktop portal or install wtype on compatible Wayland compositors, install xdotool for X11, or start ydotoold with a socket accessible to this desktop user."
            .to_string()
    } else if !screenshot_routes_detected {
        "Enable a screenshot route: install an XDG desktop portal backend that implements Screenshot for this desktop, or install gnome-screenshot. Accessibility-tree actions work meanwhile."
            .to_string()
    } else {
        "AT-SPI tree support, window targeting, and a Linux input backend are available. Call screenshot or get_app_state to verify screenshot capture."
            .to_string()
    };

    ReadinessReport {
        can_register_mcp_tools: true,
        can_build_accessibility_tree,
        can_query_windows,
        can_focus_apps,
        can_focus_windows,
        can_send_development_input,
        can_capture_screenshots: false,
        screenshot_capture_status: if screenshot_routes_detected {
            ScreenshotCaptureStatus::Unverified
        } else {
            ScreenshotCaptureStatus::Unavailable
        },
        recommended_next_step,
        blockers,
        warnings,
    }
}

fn can_send_development_input(
    platform: &PlatformReport,
    remote_desktop_keyboard: &Check,
    input: &InputReport,
) -> bool {
    let force_ydotool = env_flag_enabled_any(FORCE_YDOTOOL_KEYBOARD_ENV_KEYS);
    let force_xdotool = env_flag_enabled_any(FORCE_XDOTOOL_KEYBOARD_ENV_KEYS);
    input.pixelflux.ok
        || portal_keyboard_input_available(platform, remote_desktop_keyboard)
        || platform_is_wayland(platform)
            && wtype_compatible_wayland_desktop(platform.xdg_current_desktop.as_deref())
            && input.wtype.ok
            && !force_ydotool
        || should_advertise_xdotool(platform, input, force_ydotool, force_xdotool)
        || input.ydotool.ok && input.ydotool_socket.ok
}

fn portal_pointer_input_available(platform: &PlatformReport, portals: &PortalReport) -> bool {
    platform_is_wayland(platform) && portals.remote_desktop.ok
}

fn portal_keyboard_input_available(
    platform: &PlatformReport,
    remote_desktop_keyboard: &Check,
) -> bool {
    platform_is_wayland(platform) && remote_desktop_keyboard.ok
}

fn is_cosmic_wayland_platform(platform: &PlatformReport) -> bool {
    platform
        .xdg_current_desktop
        .as_deref()
        .is_some_and(|desktop| desktop.to_ascii_lowercase().contains("cosmic"))
        && platform.xdg_session_type.as_deref() == Some("wayland")
}

pub(crate) fn can_build_accessibility_tree_now() -> bool {
    hydrate_session_bus_env();
    let accessibility = accessibility_report();
    can_build_accessibility_tree(&accessibility)
}

fn can_build_accessibility_tree(accessibility: &AccessibilityReport) -> bool {
    accessibility_tree_ready(accessibility, accessibility.forced_toolkit_bridge)
}

fn accessibility_tree_ready(accessibility: &AccessibilityReport, forced_bridge: bool) -> bool {
    accessibility.at_spi_bus.ok
        && (forced_bridge
            || check_detail_contains_true(&accessibility.at_spi_enabled)
            || check_detail_contains_true(&accessibility.toolkit_accessibility))
}

fn atspi_disabled_blocker(
    accessibility: &AccessibilityReport,
    forced_bridge: bool,
) -> Option<String> {
    if accessibility_tree_ready(accessibility, forced_bridge) {
        None
    } else {
        Some(
            "AT-SPI accessibility is disabled; enable org.a11y.Status IsEnabled or org.gnome.desktop.interface toolkit-accessibility for tree extraction."
                .to_string(),
        )
    }
}

fn toolkit_bridge_forced() -> bool {
    if toolkit_bridge_forced_by_env(env_var) {
        return true;
    }
    let compositor = compositor_environ();
    toolkit_bridge_forced_by_env(|key| {
        env_var(key).or_else(|| compositor.as_ref().and_then(|vars| vars.get(key).cloned()))
    })
}

fn toolkit_bridge_forced_by_env(vars: impl Fn(&str) -> Option<String>) -> bool {
    vars("QT_LINUX_ACCESSIBILITY_ALWAYS_ON").is_some_and(|value| value == "1")
        || vars("GTK_MODULES").is_some_and(|value| value.contains("atk-bridge"))
}

fn compositor_environ() -> Option<HashMap<String, String>> {
    // Read only the process proven to own the selected Wayland connection.
    // Another desktop or nested compositor must not enable this session's tree.
    let pid = crate::windowing::wayland_session::compositor_pid()?;
    read_process_environ(pid)
}

fn check_detail_contains_true(check: &Check) -> bool {
    check.ok && check.detail.to_ascii_lowercase().contains("true")
}

fn env_var(key: &str) -> Option<String> {
    env::var(key).ok().filter(|value| !value.trim().is_empty())
}

fn xdg_runtime_dir() -> Option<PathBuf> {
    if let Some(value) = env_var("XDG_RUNTIME_DIR") {
        return Some(PathBuf::from(value));
    }
    user_id().map(|uid| PathBuf::from(format!("/run/user/{uid}")))
}

fn dbus_session_address() -> Option<String> {
    if let Some(value) = env_var("DBUS_SESSION_BUS_ADDRESS") {
        return Some(value);
    }
    xdg_runtime_dir()
        .map(|runtime| format!("unix:path={}", runtime.join("bus").display()))
        .filter(|address| {
            address
                .strip_prefix("unix:path=")
                .is_some_and(|p| Path::new(p).exists())
        })
}

fn ydotool_socket_check() -> Check {
    match ydotool::connectable_socket_path() {
        Ok(path) => Check::ok(format!("connectable: {}", path.display())),
        Err(detail) => Check::fail(format!("no trusted connectable ydotool socket ({detail})")),
    }
}

fn user_id() -> Option<String> {
    let mut command = Command::new("id");
    command.arg("-u");
    let output = crate::command_runner::output_blocking(&mut command, "query user id").ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .filter(|value| !value.is_empty())
}

fn command_path_check(command: &str) -> Check {
    command_check("sh", &["-c", &format!("command -v {command}")])
}

fn platform_is_wayland(platform: &PlatformReport) -> bool {
    match platform.xdg_session_type.as_deref() {
        Some(value) => value.eq_ignore_ascii_case("wayland"),
        None => platform
            .wayland_display
            .as_deref()
            .is_some_and(|display| !display.trim().is_empty()),
    }
}

pub(crate) fn wtype_compatible_wayland_desktop(desktop: Option<&str>) -> bool {
    desktop.is_none_or(|desktop| {
        let desktop = desktop.to_ascii_lowercase();
        !["gnome", "kde", "plasma", "cosmic"]
            .iter()
            .any(|known_incompatible| desktop.contains(known_incompatible))
    })
}

fn should_advertise_wtype(
    platform: &PlatformReport,
    input: &InputReport,
    force_ydotool: bool,
    force_xdotool: bool,
    force_portal_keyboard: bool,
) -> bool {
    platform_is_wayland(platform)
        && wtype_compatible_wayland_desktop(platform.xdg_current_desktop.as_deref())
        && input.wtype.ok
        && !force_ydotool
        && !force_xdotool
        && !force_portal_keyboard
}

fn should_advertise_xdotool(
    platform: &PlatformReport,
    input: &InputReport,
    force_ydotool: bool,
    force_xdotool: bool,
) -> bool {
    !force_ydotool
        && input.xdotool.ok
        && platform
            .display
            .as_deref()
            .is_some_and(|display| !display.trim().is_empty())
        && (force_xdotool || !platform_is_wayland(platform))
}

fn env_flag_enabled_any(keys: &[&str]) -> bool {
    keys.iter()
        .any(|key| env::var(key).ok().as_deref() == Some("1"))
}

fn force_portal_for_all_input(
    force_portal_pointer: bool,
    force_portal_keyboard: bool,
    force_ydotool_pointer: bool,
    force_ydotool_keyboard: bool,
) -> bool {
    force_portal_pointer
        && force_portal_keyboard
        && !force_ydotool_pointer
        && !force_ydotool_keyboard
}

fn process_check(process_name: &str) -> Check {
    command_check("pgrep", &["-a", process_name])
}

#[cfg(test)]
fn socket_connect_check(path: &Path) -> Check {
    match socket_connect_result(path) {
        Ok(()) => Check::ok(format!("connectable: {}", path.display())),
        Err(detail) => Check::fail(detail),
    }
}

#[cfg(test)]
fn socket_connect_result(path: &Path) -> std::result::Result<(), String> {
    if !path.exists() {
        return Err(format!("missing: {}", path.display()));
    }

    std::os::unix::net::UnixDatagram::unbound()
        .and_then(|socket| socket.connect(path))
        .map_err(|error| format!("{}: datagram: {error}", path.display()))
}

fn read_write_path_check(path: &Path) -> Check {
    if !path.exists() {
        return Check::fail(format!("missing: {}", path.display()));
    }

    match OpenOptions::new().read(true).write(true).open(path) {
        Ok(_) => Check::ok(format!("read/write: {}", path.display())),
        Err(error) => Check::fail(format!("{}: {error}", path.display())),
    }
}

fn bus_name_check(name: &str) -> Check {
    command_check_with_session_bus("busctl", &["--user", "status", name])
}

fn portal_interface_check(interface: &str) -> Check {
    command_check_with_session_bus(
        "busctl",
        &[
            "--user",
            "introspect",
            "org.freedesktop.portal.Desktop",
            "/org/freedesktop/portal/desktop",
            interface,
        ],
    )
}

/// Introspect a portal interface and require it to export `methods`.
fn portal_interface_methods_check(interface: &str, methods: &[&str]) -> Check {
    require_busctl_methods(portal_interface_check(interface), interface, methods)
}

fn require_busctl_methods(introspection: Check, interface: &str, methods: &[&str]) -> Check {
    if !introspection.ok {
        return introspection;
    }
    let missing = missing_busctl_methods(&introspection, methods);
    if missing.is_empty() {
        return introspection;
    }
    if !busctl_introspection_has_members(&introspection.detail) {
        return Check::fail(format!(
            "{interface} is not exported by the portal (introspection listed no members)"
        ));
    }
    Check::fail(format!(
        "{interface} is missing required methods: {}",
        missing.join(", ")
    ))
}

fn busctl_introspection_has_members(detail: &str) -> bool {
    detail
        .lines()
        .any(|line| line.trim_start().starts_with('.'))
}

fn remote_desktop_portal_checks() -> (Check, Check, Check) {
    let introspection = portal_interface_check("org.freedesktop.portal.RemoteDesktop");
    let screencast = portal_interface_methods_check(
        "org.freedesktop.portal.ScreenCast",
        SCREENCAST_PORTAL_METHODS,
    );
    if !introspection.ok {
        return (introspection.clone(), introspection, screencast);
    }

    let available_device_types = command_check_with_session_bus(
        "busctl",
        &[
            "--user",
            "get-property",
            "org.freedesktop.portal.Desktop",
            "/org/freedesktop/portal/desktop",
            "org.freedesktop.portal.RemoteDesktop",
            "AvailableDeviceTypes",
        ],
    );
    let available_source_types = command_check_with_session_bus(
        "busctl",
        &[
            "--user",
            "get-property",
            "org.freedesktop.portal.Desktop",
            "/org/freedesktop/portal/desktop",
            "org.freedesktop.portal.ScreenCast",
            "AvailableSourceTypes",
        ],
    );
    let screencast_version = command_check_with_session_bus(
        "busctl",
        &[
            "--user",
            "get-property",
            "org.freedesktop.portal.Desktop",
            "/org/freedesktop/portal/desktop",
            "org.freedesktop.portal.ScreenCast",
            "version",
        ],
    );
    let available_cursor_modes = command_check_with_session_bus(
        "busctl",
        &[
            "--user",
            "get-property",
            "org.freedesktop.portal.Desktop",
            "/org/freedesktop/portal/desktop",
            "org.freedesktop.portal.ScreenCast",
            "AvailableCursorModes",
        ],
    );
    let pointer = remote_desktop_pointer_check_from(
        &introspection,
        &screencast,
        &available_device_types,
        &available_source_types,
        &screencast_version,
        &available_cursor_modes,
    );
    let keyboard = remote_desktop_keyboard_check_from(&introspection, &available_device_types);
    (pointer, keyboard, screencast)
}

fn remote_desktop_pointer_check_from(
    introspection: &Check,
    screencast: &Check,
    available_device_types: &Check,
    available_source_types: &Check,
    screencast_version: &Check,
    available_cursor_modes: &Check,
) -> Check {
    if !introspection.ok {
        return Check::fail(introspection.detail.clone());
    }
    let missing_methods = missing_busctl_methods(introspection, REMOTE_DESKTOP_POINTER_METHODS);
    if !missing_methods.is_empty() {
        return Check::fail(format!(
            "RemoteDesktop interface is missing required pointer methods: {}",
            missing_methods.join(", ")
        ));
    }

    if !screencast.ok {
        return Check::fail(format!(
            "ScreenCast interface is unavailable for portal pointer input: {}",
            screencast.detail
        ));
    }
    let missing_screencast_methods = missing_busctl_methods(screencast, SCREENCAST_POINTER_METHODS);
    if !missing_screencast_methods.is_empty() {
        return Check::fail(format!(
            "ScreenCast interface is missing required pointer methods: {}",
            missing_screencast_methods.join(", ")
        ));
    }

    let device_types = match remote_desktop_device_types(available_device_types) {
        Ok(device_types) => device_types,
        Err(detail) => return Check::fail(detail),
    };
    if device_types & PORTAL_DEVICE_POINTER == 0 {
        return Check::fail(format!(
            "RemoteDesktop AvailableDeviceTypes={device_types} does not include pointer input"
        ));
    }

    let source_types = match screencast_source_types(available_source_types) {
        Ok(source_types) => source_types,
        Err(detail) => return Check::fail(detail),
    };
    if source_types & PORTAL_SOURCE_MONITOR == 0 {
        return Check::fail(format!(
            "ScreenCast AvailableSourceTypes={source_types} does not include monitor sources"
        ));
    }

    let version = match screencast_version_number(screencast_version) {
        Ok(version) => version,
        Err(detail) => return Check::fail(detail),
    };
    if version >= SCREENCAST_CURSOR_MODE_VERSION {
        let cursor_modes = match screencast_cursor_modes(available_cursor_modes) {
            Ok(cursor_modes) => cursor_modes,
            Err(detail) => return Check::fail(detail),
        };
        if cursor_modes & PORTAL_CURSOR_MODE_HIDDEN == 0 {
            return Check::fail(format!(
                "ScreenCast AvailableCursorModes={cursor_modes} does not include hidden cursor mode"
            ));
        }

        return Check::ok(format!(
            "pointer-capable RemoteDesktop portal (AvailableDeviceTypes={device_types}, AvailableSourceTypes={source_types}, ScreenCast version={version}, AvailableCursorModes={cursor_modes})"
        ));
    }

    Check::ok(format!(
        "pointer-capable RemoteDesktop portal (AvailableDeviceTypes={device_types}, AvailableSourceTypes={source_types}, ScreenCast version={version}, hidden cursor mode is the interface default)"
    ))
}

fn screencast_version_number(screencast_version: &Check) -> Result<u32, String> {
    if !screencast_version.ok {
        return Err(format!(
            "ScreenCast version is unavailable: {}",
            screencast_version.detail
        ));
    }
    parse_busctl_u32_property(&screencast_version.detail).ok_or_else(|| {
        format!(
            "ScreenCast version has an unexpected value: {}",
            screencast_version.detail
        )
    })
}

fn screencast_cursor_modes(available_cursor_modes: &Check) -> Result<u32, String> {
    if !available_cursor_modes.ok {
        return Err(format!(
            "ScreenCast AvailableCursorModes is unavailable: {}",
            available_cursor_modes.detail
        ));
    }
    parse_busctl_u32_property(&available_cursor_modes.detail).ok_or_else(|| {
        format!(
            "ScreenCast AvailableCursorModes has an unexpected value: {}",
            available_cursor_modes.detail
        )
    })
}

fn remote_desktop_keyboard_check_from(
    introspection: &Check,
    available_device_types: &Check,
) -> Check {
    if !introspection.ok {
        return Check::fail(introspection.detail.clone());
    }

    let missing_methods = missing_busctl_methods(introspection, REMOTE_DESKTOP_KEYBOARD_METHODS);
    if !missing_methods.is_empty() {
        return Check::fail(format!(
            "RemoteDesktop interface is missing required keyboard methods: {}",
            missing_methods.join(", ")
        ));
    }

    let device_types = match remote_desktop_device_types(available_device_types) {
        Ok(device_types) => device_types,
        Err(detail) => return Check::fail(detail),
    };
    if device_types & PORTAL_DEVICE_KEYBOARD == 0 {
        return Check::fail(format!(
            "RemoteDesktop AvailableDeviceTypes={device_types} does not include keyboard input"
        ));
    }

    Check::ok(format!(
        "keyboard-capable RemoteDesktop portal (AvailableDeviceTypes={device_types})"
    ))
}

fn missing_busctl_methods<'a>(introspection: &Check, methods: &'a [&'a str]) -> Vec<&'a str> {
    methods
        .iter()
        .copied()
        .filter(|method| !busctl_introspection_has_method(&introspection.detail, method))
        .collect()
}

fn remote_desktop_device_types(available_device_types: &Check) -> Result<u32, String> {
    if !available_device_types.ok {
        return Err(format!(
            "RemoteDesktop AvailableDeviceTypes is unavailable: {}",
            available_device_types.detail
        ));
    }
    parse_busctl_u32_property(&available_device_types.detail).ok_or_else(|| {
        format!(
            "RemoteDesktop AvailableDeviceTypes has an unexpected value: {}",
            available_device_types.detail
        )
    })
}

fn screencast_source_types(available_source_types: &Check) -> Result<u32, String> {
    if !available_source_types.ok {
        return Err(format!(
            "ScreenCast AvailableSourceTypes is unavailable: {}",
            available_source_types.detail
        ));
    }
    parse_busctl_u32_property(&available_source_types.detail).ok_or_else(|| {
        format!(
            "ScreenCast AvailableSourceTypes has an unexpected value: {}",
            available_source_types.detail
        )
    })
}

fn busctl_introspection_has_method(detail: &str, method: &str) -> bool {
    detail.lines().any(|line| {
        let mut fields = line.split_whitespace();
        fields
            .next()
            .is_some_and(|name| name.trim_start_matches('.') == method)
            && fields.next() == Some("method")
    })
}

fn parse_busctl_u32_property(detail: &str) -> Option<u32> {
    let mut fields = detail.split_whitespace();
    if fields.next()? != "u" {
        return None;
    }
    let value = fields.next()?;
    value
        .strip_prefix("0x")
        .map(|hex| u32::from_str_radix(hex, 16).ok())
        .unwrap_or_else(|| value.parse().ok())
}

fn atspi_bus_address_check() -> Check {
    let busctl = command_check_with_session_bus(
        "busctl",
        &[
            "--user",
            "call",
            "org.a11y.Bus",
            "/org/a11y/bus",
            "org.a11y.Bus",
            "GetAddress",
        ],
    );
    if busctl.ok {
        return busctl;
    }

    gdbus_call_check(
        "org.a11y.Bus",
        "/org/a11y/bus",
        "org.a11y.Bus.GetAddress",
        &[],
    )
}

fn atspi_status_property_check(property: &str) -> Check {
    let busctl = command_check_with_session_bus(
        "busctl",
        &[
            "--user",
            "get-property",
            "org.a11y.Bus",
            "/org/a11y/bus",
            "org.a11y.Status",
            property,
        ],
    );
    if busctl.ok {
        return busctl;
    }

    gdbus_call_check(
        "org.a11y.Bus",
        "/org/a11y/bus",
        "org.freedesktop.DBus.Properties.Get",
        &["org.a11y.Status", property],
    )
}

// check_detail_contains_true reads this detail, so keep "true" in it.
fn at_spi_enabled_check() -> Check {
    describe_bool(
        atspi_status_property_check("IsEnabled"),
        "AT-SPI IsEnabled is true",
        "AT-SPI IsEnabled is false",
    )
}

// at-spi2-core 2.62 removed ScreenReaderEnabled; it mirrored this key.
fn screen_reader_enabled_check() -> Check {
    let mut check = atspi_status_property_check("ScreenReaderEnabled");
    if !check.ok {
        check = command_check_with_session_bus(
            "gsettings",
            &[
                "get",
                "org.gnome.desktop.a11y.applications",
                "screen-reader-enabled",
            ],
        );
    }
    describe_bool(check, "Screen reader is on", "Screen reader is off")
}

// Replaces raw busctl, gdbus or gsettings boolean output with text.
fn describe_bool(check: Check, on: &str, off: &str) -> Check {
    let detail = check.detail.to_ascii_lowercase();
    match (check.ok, detail.contains("true"), detail.contains("false")) {
        (true, true, false) => Check::ok(on),
        (true, false, true) => Check::ok(off),
        _ => check,
    }
}

fn gdbus_call_check(destination: &str, object_path: &str, method: &str, args: &[&str]) -> Check {
    let mut command_args = vec![
        "call",
        "--session",
        "--dest",
        destination,
        "--object-path",
        object_path,
        "--method",
        method,
    ];
    command_args.extend_from_slice(args);
    command_check_with_session_bus("gdbus", &command_args)
}

fn command_check(command: &str, args: &[&str]) -> Check {
    run_command(command, args, false)
}

fn command_check_with_session_bus(command: &str, args: &[&str]) -> Check {
    run_command(command, args, true)
}

fn run_command(command: &str, args: &[&str], with_session_bus: bool) -> Check {
    let mut cmd = Command::new(command);
    cmd.args(args);

    if with_session_bus {
        if let Some(address) = dbus_session_address() {
            cmd.env("DBUS_SESSION_BUS_ADDRESS", address);
        }
        if let Some(runtime) = xdg_runtime_dir() {
            cmd.env("XDG_RUNTIME_DIR", runtime);
        }
    }

    // Introspection can block while a portal retrieves backend properties.
    // Bound every probe and reap its process group instead of stalling doctor
    // and every get_app_state request waiting for that diagnostic.
    match crate::command_runner::output_blocking(&mut cmd, &format!("run diagnostic {command}")) {
        Ok(output) if output.status.success() => {
            let detail = String::from_utf8_lossy(&output.stdout).trim().to_string();
            Check::ok(if detail.is_empty() {
                "ok".into()
            } else {
                detail
            })
        }
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let detail = if !stderr.is_empty() { stderr } else { stdout };
            Check::fail(if detail.is_empty() {
                format!("exit status {}", output.status)
            } else {
                detail
            })
        }
        Err(error) => Check::fail(format!("{error:#}")),
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A complete report for tests outside this module. With accessibility
    /// disabled, get_app_state skips the tree and touches no desktop service.
    pub(crate) fn doctor_report_fixture(
        accessibility_enabled: bool,
        windows_available: bool,
    ) -> DoctorReport {
        let platform = platform_report();
        let portals = portal_report(Check::fail("missing"));
        let accessibility = accessibility_report(
            Check::ok("bus"),
            Check::ok(accessibility_enabled.to_string()),
        );
        let windowing = windowing_report(windows_available, windows_available);
        let input = input_report(true);
        DoctorReport {
            readiness: readiness_report(&platform, &portals, &accessibility, &windowing, &input),
            capabilities: capability_map(&platform, &portals, &accessibility, &windowing, &input),
            platform,
            portals,
            accessibility,
            windowing,
            input,
        }
    }

    #[test]
    fn describe_bool_reads_busctl_gdbus_and_gsettings_output() {
        for (raw, expected) in [("b true", "on"), ("(<false>,)", "off"), ("false", "off")] {
            assert_eq!(describe_bool(Check::ok(raw), "on", "off").detail, expected);
        }
        let failed = describe_bool(Check::fail("no such property"), "on", "off");
        assert!(!failed.ok);
        assert_eq!(failed.detail, "no such property");
    }

    #[test]
    fn diagnostic_command_timeout_reaps_the_hung_process() {
        use std::time::{Duration, Instant};

        let pid_path = std::env::temp_dir().join(format!(
            "cul-diagnostic-timeout-{}-{}.pid",
            std::process::id(),
            getrandom::u64().unwrap()
        ));
        let started = Instant::now();
        let result = run_command(
            "/bin/sh",
            &[
                "-c",
                "printf '%s' \"$$\" > \"$1\"; exec /bin/sleep 60",
                "diagnostic-timeout-test",
                pid_path.to_str().unwrap(),
            ],
            false,
        );
        let elapsed = started.elapsed();
        let pid = fs::read_to_string(&pid_path);
        let _ = fs::remove_file(&pid_path);
        let pid: u32 = pid.expect("fixture must record its pid").parse().unwrap();

        assert!(!result.ok, "hung diagnostic must fail");
        assert!(result.detail.contains("timed out after 2000 ms"));
        assert!(elapsed < Duration::from_secs(4), "took {elapsed:?}");
        assert!(
            !Path::new(&format!("/proc/{pid}")).exists(),
            "diagnostic child must be killed and reaped before returning"
        );
    }

    #[test]
    fn diagnostic_spawn_failure_keeps_the_os_cause() {
        let path = std::env::temp_dir().join(format!(
            "cul-missing-diagnostic-{}-{}",
            std::process::id(),
            getrandom::u64().unwrap()
        ));
        let result = run_command(path.to_str().unwrap(), &[], false);
        assert!(!result.ok);
        assert!(result.detail.contains("failed to run diagnostic"));
        assert!(result.detail.contains("os error 2"));
    }

    #[test]
    fn setup_repairs_saved_key_even_when_runtime_is_ready() {
        let mut before = accessibility_report(Check::ok("bus"), Check::ok("false"));
        before.at_spi_enabled = Check::ok("b true");
        let mut calls = Vec::new();
        let result = enable_accessibility(&before, |program, args| {
            calls.push((program.to_string(), args.join(" ")));
            Check::ok(if args[0] == "get" { "true" } else { "" })
        });
        assert!(result.ok);
        assert_eq!(
            calls,
            vec![
                (
                    "gsettings".into(),
                    "set org.gnome.desktop.interface toolkit-accessibility true".into()
                ),
                (
                    "gsettings".into(),
                    "get org.gnome.desktop.interface toolkit-accessibility".into()
                ),
            ]
        );
    }

    #[test]
    fn setup_does_not_claim_saved_success_from_command_exit_status() {
        let before = accessibility_report(Check::ok("bus"), Check::ok("false"));
        let mut calls = Vec::new();
        let result = enable_accessibility(&before, |program, args| {
            calls.push(program.to_string());
            Check::ok(if args[0] == "get" {
                "false"
            } else {
                "exit status 0"
            })
        });
        assert!(!result.ok);
        assert!(result.detail.contains("not verified"));
        assert_eq!(calls, ["gsettings", "gsettings", "busctl"]);
    }

    #[test]
    fn setup_preserves_enabled_settings_without_writing() {
        let before = accessibility_report(Check::ok("bus"), Check::ok("true"));
        let result = enable_accessibility(&before, |_, _| panic!("already enabled"));
        assert!(result.ok);
    }

    fn platform_report() -> PlatformReport {
        PlatformReport {
            os: "linux".to_string(),
            arch: "x86_64".to_string(),
            desktop_session: None,
            xdg_session_type: Some("wayland".to_string()),
            xdg_current_desktop: Some("GNOME".to_string()),
            wayland_display: Some("wayland-0".to_string()),
            display: Some(":0".to_string()),
            xauthority: Some("/run/user/1000/Xauthority".to_string()),
            dbus_session_bus_address: Some("unix:path=/run/user/1000/bus".to_string()),
            xdg_runtime_dir: Some("/run/user/1000".to_string()),
            gnome_shell_version: Check::ok("GNOME Shell 46.0"),
            gnome_screenshot: Check::ok("gnome-screenshot 41.0"),
            x11_display: Check::fail("not a native X11 session"),
        }
    }

    fn portal_report(remote_desktop: Check) -> PortalReport {
        PortalReport {
            remote_desktop_keyboard: remote_desktop.clone(),
            desktop_portal: Check::ok("ok"),
            remote_desktop,
            screencast: Check::fail("missing"),
            screenshot: Check::fail("missing"),
            input_capture: Check::fail("missing"),
            mutter_remote_desktop: Check::fail("missing"),
            mutter_screencast: Check::fail("missing"),
        }
    }

    fn accessibility_report(
        at_spi_bus: Check,
        toolkit_accessibility: Check,
    ) -> AccessibilityReport {
        AccessibilityReport {
            at_spi_bus,
            toolkit_accessibility,
            at_spi_enabled: Check::fail("(<false>,)"),
            screen_reader_enabled: Check::fail("(<false>,)"),
            forced_toolkit_bridge: false,
        }
    }
    #[test]
    fn bus_reachable_and_forced_bridge_is_enabled() {
        let enabled = accessibility_report(Check::ok("bus"), Check::fail("false"));
        assert!(accessibility_tree_ready(&enabled, true));
        assert!(atspi_disabled_blocker(&enabled, true).is_none());
        let down = accessibility_report(Check::fail("no bus"), Check::fail("false"));
        assert!(!accessibility_tree_ready(&down, true));
        assert!(
            atspi_disabled_blocker(&down, true).is_some_and(|blocker| blocker.contains("disabled"))
        );
        assert!(toolkit_bridge_forced_by_env(|key| {
            (key == "QT_LINUX_ACCESSIBILITY_ALWAYS_ON").then(|| "1".to_string())
        }));
        assert!(toolkit_bridge_forced_by_env(|key| {
            (key == "GTK_MODULES").then(|| "gail:atk-bridge".to_string())
        }));
        assert!(!toolkit_bridge_forced_by_env(|_| None));
    }

    fn windowing_report(can_list_windows: bool, can_focus_windows: bool) -> WindowingReport {
        WindowingReport {
            gnome_shell_introspect: if can_list_windows {
                Check::ok("ok")
            } else {
                Check::fail("denied")
            },
            codex_gnome_shell_extension: if can_focus_windows {
                Check::ok("ok")
            } else {
                Check::fail("missing")
            },
            codex_gnome_shell_extension_screenshot: Check::fail("missing"),
            cosmic_helper: Check::fail("missing"),
            kwin: Check::fail("not a KWin session"),
            hyprland: Check::fail("not a Hyprland session"),
            niri: Check::fail("not a Niri session"),
            backends: BTreeMap::new(),
            can_list_windows,
            can_focus_apps: true,
            can_focus_windows,
            note: String::new(),
        }
    }

    fn input_report(can_send_input: bool) -> InputReport {
        let check = if can_send_input {
            Check::ok("ok")
        } else {
            Check::fail("missing")
        };
        input_report_parts(check.clone(), check.clone(), check.clone(), check)
    }

    fn input_report_parts(
        ydotool: Check,
        ydotoold: Check,
        ydotool_socket: Check,
        uinput: Check,
    ) -> InputReport {
        InputReport {
            ydotool,
            ydotoold,
            ydotool_socket,
            uinput,
            xdotool: Check::fail("missing xdotool"),
            wtype: Check::fail("missing wtype"),
            pixelflux: Check::fail("PIXELFLUX_CU is not set"),
        }
    }

    #[test]
    fn accessibility_tree_requires_reachable_at_spi_bus() {
        let report = accessibility_report(Check::fail("permission denied"), Check::ok("true"));

        assert!(!can_build_accessibility_tree(&report));
    }

    #[test]
    fn accessibility_tree_is_ready_when_bus_and_toolkit_are_ready() {
        let report = accessibility_report(
            Check::ok("('unix:path=/run/user/1000/at-spi/bus',)"),
            Check::ok("true"),
        );

        assert!(can_build_accessibility_tree(&report));
    }

    #[test]
    fn capability_map_advertises_only_a_buildable_accessibility_tree() {
        let platform = platform_report();
        let portals = portal_report(Check::fail("missing"));
        let windowing = windowing_report(false, false);
        let input = input_report(false);

        for accessibility in [
            accessibility_report(Check::fail("permission denied"), Check::ok("true")),
            accessibility_report(
                Check::ok("('unix:path=/run/user/1000/at-spi/bus',)"),
                Check::ok("false"),
            ),
        ] {
            let capabilities =
                capability_map(&platform, &portals, &accessibility, &windowing, &input);
            assert!(capabilities.accessibility.is_empty());
        }
    }

    #[test]
    fn parses_parent_pid_from_proc_status() {
        let status = "Name:\ttest\nPid:\t42\nPPid:\t7\n";

        assert_eq!(parse_parent_pid(status), Some(7));
    }

    #[test]
    fn parses_nul_separated_process_environment() {
        let environment = parse_environ(
            b"DISPLAY=:0\0WAYLAND_DISPLAY=wayland-0\0EMPTY=\0NO_EQUALS\0XDG_SESSION_TYPE=wayland\0",
        );

        assert_eq!(environment.get("DISPLAY").map(String::as_str), Some(":0"));
        assert_eq!(
            environment.get("WAYLAND_DISPLAY").map(String::as_str),
            Some("wayland-0")
        );
        assert_eq!(environment.get("EMPTY").map(String::as_str), Some(""));
        assert!(!environment.contains_key("NO_EQUALS"));
    }

    #[test]
    fn desktop_env_hydration_includes_xauthority() {
        assert!(DESKTOP_ENV_KEYS.contains(&"XAUTHORITY"));
    }

    #[test]
    fn desktop_env_hydration_preserves_explicit_native_x11() {
        let current_env = HashMap::from([
            ("DISPLAY".to_string(), ":90".to_string()),
            ("XDG_SESSION_TYPE".to_string(), "x11".to_string()),
        ]);
        let host_env = HashMap::from([
            ("WAYLAND_DISPLAY".to_string(), "wayland-0".to_string()),
            (
                "XDG_CURRENT_DESKTOP".to_string(),
                "ubuntu:GNOME".to_string(),
            ),
        ]);

        let updates = desktop_env_hydration_updates(&current_env, &host_env);

        assert!(!updates.iter().any(|(key, _)| *key == "WAYLAND_DISPLAY"));
        assert!(updates
            .iter()
            .any(|(key, value)| { *key == "XDG_CURRENT_DESKTOP" && value == "ubuntu:GNOME" }));
    }

    #[test]
    fn desktop_env_hydration_still_imports_wayland_for_incomplete_sessions() {
        let current_env = HashMap::new();
        let host_env = HashMap::from([("WAYLAND_DISPLAY".to_string(), "wayland-0".to_string())]);

        let updates = desktop_env_hydration_updates(&current_env, &host_env);

        assert!(updates
            .iter()
            .any(|(key, value)| *key == "WAYLAND_DISPLAY" && value == "wayland-0"));
    }

    #[test]
    fn graphical_process_env_requires_display() {
        let with_display = HashMap::from([("DISPLAY".to_string(), ":0".to_string())]);
        let with_wayland =
            HashMap::from([("WAYLAND_DISPLAY".to_string(), "wayland-0".to_string())]);
        let without_display = HashMap::from([("XAUTHORITY".to_string(), "/tmp/xauth".to_string())]);

        assert!(process_env_has_graphical_display(&with_display));
        assert!(process_env_has_graphical_display(&with_wayland));
        assert!(!process_env_has_graphical_display(&without_display));
    }

    #[test]
    fn capabilities_prefer_xdotool_before_ydotool_on_x11() {
        let mut platform = platform_report();
        platform.xdg_session_type = Some("x11".to_string());
        platform.wayland_display = None;
        platform.display = Some(":0".to_string());
        let input = InputReport {
            ydotool: Check::ok("ydotool"),
            ydotoold: Check::ok("ydotoold"),
            ydotool_socket: Check::ok("connectable"),
            uinput: Check::fail("missing"),
            xdotool: Check::ok("xdotool"),
            wtype: Check::fail("missing wtype"),
            pixelflux: Check::fail("PIXELFLUX_CU is not set"),
        };

        let capabilities = capability_map(
            &platform,
            &portal_report(Check::fail("missing")),
            &accessibility_report(Check::fail("missing"), Check::fail("missing")),
            &windowing_report(false, false),
            &input,
        );

        assert_eq!(capabilities.input, ["xdotool", "ydotool"]);
        assert_eq!(capabilities.preferred.input.as_deref(), Some("xdotool"));
    }

    #[test]
    fn pixelflux_only_desktop_is_input_ready() {
        let platform = platform_report();
        let mut input = input_report(false);
        input.pixelflux = Check::ok("loopback port 8080");
        assert!(can_send_development_input(
            &platform,
            &Check::fail("missing portal"),
            &input,
        ));
    }

    #[test]
    fn x11_diagnostics_ignore_portal_and_accept_xdotool() {
        let mut platform = platform_report();
        platform.xdg_session_type = Some("x11".to_string());
        platform.wayland_display = None;
        platform.display = Some(":0".to_string());
        let portals = portal_report(Check::ok("org.freedesktop.portal.RemoteDesktop"));
        let accessibility = accessibility_report(Check::ok("bus"), Check::ok("true"));
        let windowing = windowing_report(true, true);
        let mut input = input_report(false);
        input.xdotool = Check::ok("xdotool");

        let capabilities = capability_map(&platform, &portals, &accessibility, &windowing, &input);
        let readiness = readiness_report(&platform, &portals, &accessibility, &windowing, &input);

        assert_eq!(capabilities.input, ["xdotool"]);
        assert_eq!(capabilities.preferred.input.as_deref(), Some("xdotool"));
        assert!(readiness.can_send_development_input);
    }

    #[test]
    fn wayland_diagnostics_advertise_wtype_without_portal_or_ydotool() {
        let mut platform = platform_report();
        platform.xdg_session_type = Some("wayland".to_string());
        platform.xdg_current_desktop = Some("Hyprland".to_string());
        platform.wayland_display = Some("wayland-0".to_string());
        let portals = portal_report(Check::fail("missing"));
        let accessibility = accessibility_report(Check::ok("bus"), Check::ok("true"));
        let windowing = windowing_report(true, true);
        let mut input = input_report(false);
        input.wtype = Check::ok("wtype");

        let capabilities = capability_map(&platform, &portals, &accessibility, &windowing, &input);
        let readiness = readiness_report(&platform, &portals, &accessibility, &windowing, &input);

        assert_eq!(capabilities.input, ["wtype"]);
        assert_eq!(capabilities.preferred.input.as_deref(), Some("wtype"));
        assert!(readiness.can_send_development_input);
    }

    #[test]
    fn wtype_excludes_known_incompatible_wayland_desktops() {
        assert!(wtype_compatible_wayland_desktop(Some("Hyprland")));
        assert!(wtype_compatible_wayland_desktop(Some("sway")));
        assert!(wtype_compatible_wayland_desktop(None));
        assert!(!wtype_compatible_wayland_desktop(Some("GNOME")));
        assert!(!wtype_compatible_wayland_desktop(Some("KDE;Plasma")));
        assert!(!wtype_compatible_wayland_desktop(Some("COSMIC")));
    }

    #[test]
    fn wayland_diagnostics_prefer_ydotool_before_portal() {
        let platform = platform_report();
        let portals = portal_report(Check::ok("org.freedesktop.portal.RemoteDesktop"));
        let accessibility = accessibility_report(Check::ok("bus"), Check::ok("true"));
        let windowing = windowing_report(true, true);
        let input = input_report_parts(
            Check::ok("ydotool"),
            Check::ok("ydotoold"),
            Check::ok("connectable"),
            Check::fail("missing uinput"),
        );

        let capabilities = capability_map(&platform, &portals, &accessibility, &windowing, &input);

        assert_eq!(capabilities.input, ["ydotool", "portal"]);
        assert_eq!(capabilities.preferred.input.as_deref(), Some("ydotool"));
    }

    #[test]
    fn writable_uinput_advertises_abs_pointer_first() {
        let platform = platform_report();
        let portals = portal_report(Check::fail("missing"));
        let accessibility = accessibility_report(Check::ok("bus"), Check::ok("true"));
        let windowing = windowing_report(true, true);
        let input = input_report_parts(
            Check::ok("ydotool"),
            Check::ok("ydotoold"),
            Check::ok("connectable"),
            Check::ok("read/write: /dev/uinput"),
        );

        let capabilities = capability_map(&platform, &portals, &accessibility, &windowing, &input);

        assert_eq!(capabilities.input, ["abs_pointer", "ydotool"]);
    }

    #[test]
    fn portal_force_order_requires_both_input_modalities() {
        assert!(force_portal_for_all_input(true, true, false, false));
        assert!(!force_portal_for_all_input(true, false, false, false));
        assert!(!force_portal_for_all_input(true, true, true, false));
        assert!(!force_portal_for_all_input(true, true, false, true));
    }

    fn remote_desktop_runtime_introspection() -> Check {
        Check::ok(
            "NAME TYPE SIGNATURE RESULT/VALUE FLAGS\n\
             .CreateSession method a{sv} o -\n\
             .SelectDevices method oa{sv} o -\n\
             .Start method osa{sv} o -\n\
             .NotifyPointerMotionAbsolute method oa{sv}udd - -\n\
             .NotifyPointerButton method oa{sv}iu - -\n\
             .NotifyPointerAxisDiscrete method oa{sv}ui - -\n\
             .NotifyKeyboardKeycode method ouu - -\n\
             .NotifyKeyboardKeysym method ouu - -\n\
             .AvailableDeviceTypes property u 3 emits-change",
        )
    }

    fn screencast_runtime_introspection() -> Check {
        Check::ok(
            "NAME TYPE SIGNATURE RESULT/VALUE FLAGS\n\
             .SelectSources method oa{sv} o -",
        )
    }

    #[test]
    fn cosmic_prefers_per_monitor_portal_over_uinput_and_ydotool() {
        let mut platform = platform_report();
        platform.xdg_session_type = Some("wayland".to_string());
        platform.xdg_current_desktop = Some("COSMIC".to_string());
        let input = input_report_parts(
            Check::ok("ydotool"),
            Check::ok("socket"),
            Check::ok("socket"),
            Check::ok("uinput"),
        );
        let capabilities = capability_map(
            &platform,
            &portal_report(Check::ok("portal")),
            &accessibility_report(Check::ok("bus"), Check::ok("true")),
            &windowing_report(true, true),
            &input,
        );
        assert_eq!(capabilities.preferred.input.as_deref(), Some("portal"));
        assert!(!capabilities
            .input
            .iter()
            .any(|backend| backend == "abs_pointer"));
    }

    #[test]
    fn remote_desktop_portal_rejects_header_only_introspection() {
        let introspection = Check::ok("NAME TYPE SIGNATURE RESULT/VALUE FLAGS");
        let available_device_types = Check::ok("u 3");
        let pointer = remote_desktop_pointer_check_from(
            &introspection,
            &screencast_runtime_introspection(),
            &available_device_types,
            &Check::ok("u 1"),
            &Check::ok("u 2"),
            &Check::ok("u 2"),
        );
        let keyboard = remote_desktop_keyboard_check_from(&introspection, &available_device_types);

        assert!(!pointer.ok);
        assert!(pointer.detail.contains("CreateSession"));
        assert!(pointer.detail.contains("NotifyPointerButton"));
        assert!(!keyboard.ok);
        assert!(keyboard.detail.contains("NotifyKeyboardKeysym"));

        let input = input_report_parts(
            Check::ok("ydotool"),
            Check::ok("ydotoold"),
            Check::fail("no connectable ydotool socket"),
            Check::ok("read/write: /dev/uinput"),
        );
        let platform = platform_report();
        let portals = portal_report(pointer);
        let accessibility = accessibility_report(Check::ok("bus"), Check::ok("true"));
        let windowing = windowing_report(true, true);
        let capabilities = capability_map_with_portal_keyboard(
            &platform,
            &portals,
            &keyboard,
            &accessibility,
            &windowing,
            &input,
        );
        let readiness = readiness_report_with_portal_keyboard(
            &platform,
            &keyboard,
            &accessibility,
            &windowing,
            &input,
            true,
        );

        assert!(!capabilities.input.iter().any(|backend| backend == "portal"));
        assert!(!readiness.can_send_development_input);
    }

    #[test]
    fn keyboard_only_portal_remains_advertised_without_pointer_capability() {
        let platform = platform_report();
        let keyboard = remote_desktop_keyboard_check_from(
            &remote_desktop_runtime_introspection(),
            &Check::ok("u 1"),
        );
        let portals = portal_report(Check::fail(
            "ScreenCast AvailableSourceTypes=2 does not include monitor sources",
        ));
        let accessibility = accessibility_report(Check::ok("bus"), Check::ok("true"));
        let windowing = windowing_report(true, true);
        let input = input_report_parts(
            Check::fail("missing ydotool"),
            Check::fail("ydotoold not running"),
            Check::fail("no connectable ydotool socket"),
            Check::fail("/dev/uinput: Permission denied"),
        );

        let capabilities = capability_map_with_portal_keyboard(
            &platform,
            &portals,
            &keyboard,
            &accessibility,
            &windowing,
            &input,
        );
        let readiness = readiness_report_with_portal_keyboard(
            &platform,
            &keyboard,
            &accessibility,
            &windowing,
            &input,
            true,
        );

        assert!(!portals.remote_desktop.ok);
        assert_eq!(capabilities.input, ["portal"]);
        assert_eq!(capabilities.preferred.input.as_deref(), Some("portal"));
        assert!(readiness.can_send_development_input);
    }

    #[test]
    fn remote_desktop_pointer_rejects_missing_screencast_contract() {
        let check = remote_desktop_pointer_check_from(
            &remote_desktop_runtime_introspection(),
            &Check::ok("NAME TYPE SIGNATURE RESULT/VALUE FLAGS"),
            &Check::ok("u 2"),
            &Check::ok("u 1"),
            &Check::ok("u 2"),
            &Check::ok("u 2"),
        );

        assert!(!check.ok);
        assert!(check.detail.contains("SelectSources"));
    }

    #[test]
    fn remote_desktop_pointer_rejects_missing_monitor_source_type() {
        let check = remote_desktop_pointer_check_from(
            &remote_desktop_runtime_introspection(),
            &screencast_runtime_introspection(),
            &Check::ok("u 2"),
            &Check::ok("u 2"),
            &Check::ok("u 2"),
            &Check::ok("u 2"),
        );

        assert!(!check.ok);
        assert!(check.detail.contains("does not include monitor sources"));
    }

    #[test]
    fn remote_desktop_portal_rejects_missing_keyboard_device_type() {
        let check = remote_desktop_keyboard_check_from(
            &remote_desktop_runtime_introspection(),
            &Check::ok("u 2"),
        );

        assert!(!check.ok);
        assert!(check.detail.contains("does not include keyboard input"));
    }

    #[test]
    fn remote_desktop_portal_accepts_runtime_keyboard_contract() {
        let check = remote_desktop_keyboard_check_from(
            &remote_desktop_runtime_introspection(),
            &Check::ok("u 3"),
        );

        assert!(check.ok);
        assert!(check.detail.contains("AvailableDeviceTypes=3"));
    }

    #[test]
    fn pointer_only_portal_remains_advertised_without_keyboard_readiness() {
        let platform = platform_report();
        let available_device_types = Check::ok("u 2");
        let pointer = remote_desktop_pointer_check_from(
            &remote_desktop_runtime_introspection(),
            &screencast_runtime_introspection(),
            &available_device_types,
            &Check::ok("u 1"),
            &Check::ok("u 2"),
            &Check::ok("u 1"),
        );
        let keyboard = remote_desktop_keyboard_check_from(
            &remote_desktop_runtime_introspection(),
            &available_device_types,
        );
        let portals = portal_report(pointer);
        let accessibility = accessibility_report(Check::ok("bus"), Check::ok("true"));
        let windowing = windowing_report(true, true);
        let input = input_report_parts(
            Check::fail("missing ydotool"),
            Check::fail("ydotoold not running"),
            Check::fail("no connectable ydotool socket"),
            Check::fail("/dev/uinput: Permission denied"),
        );

        let capabilities = capability_map_with_portal_keyboard(
            &platform,
            &portals,
            &keyboard,
            &accessibility,
            &windowing,
            &input,
        );
        let readiness = readiness_report_with_portal_keyboard(
            &platform,
            &keyboard,
            &accessibility_report(Check::ok("bus"), Check::ok("true")),
            &windowing_report(true, true),
            &input,
            true,
        );

        assert!(portals.remote_desktop.ok);
        assert!(capabilities.input.iter().any(|backend| backend == "portal"));
        assert!(!readiness.can_send_development_input);
    }

    #[test]
    fn capabilities_require_display_to_advertise_xdotool() {
        let mut platform = platform_report();
        platform.xdg_session_type = Some("x11".to_string());
        platform.wayland_display = None;
        platform.display = None;
        let input = InputReport {
            ydotool: Check::ok("ydotool"),
            ydotoold: Check::ok("ydotoold"),
            ydotool_socket: Check::ok("connectable"),
            uinput: Check::fail("missing"),
            xdotool: Check::ok("xdotool"),
            wtype: Check::fail("missing wtype"),
            pixelflux: Check::fail("PIXELFLUX_CU is not set"),
        };

        let capabilities = capability_map(
            &platform,
            &portal_report(Check::fail("missing")),
            &accessibility_report(Check::fail("missing"), Check::fail("missing")),
            &windowing_report(false, false),
            &input,
        );

        assert_eq!(capabilities.input, ["ydotool"]);
        assert_eq!(capabilities.preferred.input.as_deref(), Some("ydotool"));
    }

    #[test]
    fn xdotool_diagnostics_force_precedence_matches_runtime() {
        let mut platform = platform_report();
        platform.xdg_session_type = Some("wayland".to_string());
        platform.display = Some(":0".to_string());
        let mut input = input_report(false);
        input.xdotool = Check::ok("xdotool");

        assert!(should_advertise_xdotool(&platform, &input, false, true));
        assert!(!should_advertise_xdotool(&platform, &input, true, true));
    }

    #[test]
    fn parses_systemd_show_environment_output() {
        let environment = parse_line_environment(
            b"DISPLAY=:0\nHYPRLAND_INSTANCE_SIGNATURE=abc\nNO_EQUALS\nYDOTOOL_SOCKET=/run/ydotoold/socket\n",
        );

        assert_eq!(environment.get("DISPLAY").map(String::as_str), Some(":0"));
        assert_eq!(
            environment
                .get("HYPRLAND_INSTANCE_SIGNATURE")
                .map(String::as_str),
            Some("abc")
        );
        assert_eq!(
            environment.get("YDOTOOL_SOCKET").map(String::as_str),
            Some("/run/ydotoold/socket")
        );
        assert!(!environment.contains_key("NO_EQUALS"));
    }

    #[test]
    fn readiness_requires_exact_window_focus_for_targeted_input() {
        let platform = platform_report();
        let accessibility = accessibility_report(Check::ok("bus"), Check::ok("true"));
        let windowing = windowing_report(true, false);
        let input = input_report(true);

        let mut readiness = readiness_report(
            &platform,
            &portal_report(Check::fail("missing")),
            &accessibility,
            &windowing,
            &input,
        );

        readiness.record_screenshot_result(true);
        assert!(readiness.can_capture_screenshots);

        assert!(readiness.can_query_windows);
        assert!(!readiness.can_focus_windows);
        assert!(readiness
            .recommended_next_step
            .contains("exact-focus window backend"));
        assert!(readiness
            .blockers
            .iter()
            .any(|blocker| blocker.contains("Exact window activation")));
    }

    #[test]
    fn header_only_introspection_is_not_an_exported_interface() {
        // busctl introspect of an interface the portal lacks: header line, exit 0.
        let header_only = Check::ok("NAME TYPE SIGNATURE RESULT/VALUE FLAGS");

        let check = require_busctl_methods(
            header_only,
            "org.freedesktop.portal.Screenshot",
            SCREENSHOT_PORTAL_METHODS,
        );

        assert!(!check.ok);
        assert!(check.detail.contains("is not exported by the portal"));
    }

    #[test]
    fn portal_interface_must_export_every_required_method() {
        let partial = Check::ok(
            "NAME        TYPE     SIGNATURE RESULT/VALUE FLAGS\n.PickColor  method   sa{sv}    o            -\n.version    property u         2            emits-change",
        );
        let check = require_busctl_methods(
            partial,
            "org.freedesktop.portal.Screenshot",
            SCREENSHOT_PORTAL_METHODS,
        );
        assert!(!check.ok);
        assert!(check
            .detail
            .contains("missing required methods: Screenshot"));

        let full = Check::ok(
            "NAME        TYPE     SIGNATURE RESULT/VALUE FLAGS\n.PickColor  method   sa{sv}    o            -\n.Screenshot method   sa{sv}    o            -",
        );
        assert!(
            require_busctl_methods(
                full,
                "org.freedesktop.portal.Screenshot",
                SCREENSHOT_PORTAL_METHODS
            )
            .ok
        );

        let failed = Check::fail("busctl: No such interface");
        let passthrough = require_busctl_methods(
            failed,
            "org.freedesktop.portal.Screenshot",
            SCREENSHOT_PORTAL_METHODS,
        );
        assert!(!passthrough.ok);
        assert_eq!(passthrough.detail, "busctl: No such interface");
    }

    #[test]
    fn readiness_blocks_when_no_screenshot_route_is_detected() {
        let mut platform = platform_report();
        platform.gnome_shell_version = Check::fail("No such file or directory (os error 2)");
        platform.gnome_screenshot = Check::fail("No such file or directory (os error 2)");
        let accessibility = accessibility_report(Check::ok("bus"), Check::ok("true"));
        let windowing = windowing_report(true, true);
        let input = input_report(true);
        let portals = portal_report(Check::fail("missing"));

        let readiness = readiness_report(&platform, &portals, &accessibility, &windowing, &input);

        assert!(!readiness.can_capture_screenshots);
        assert_eq!(
            readiness.screenshot_capture_status,
            ScreenshotCaptureStatus::Unavailable
        );
        assert!(readiness.warnings.is_empty());
        assert!(readiness
            .blockers
            .iter()
            .any(|blocker| blocker.contains("No screenshot route was detected")));
        assert!(readiness
            .recommended_next_step
            .contains("Enable a screenshot route"));
        let capabilities = capability_map(&platform, &portals, &accessibility, &windowing, &input);
        assert!(capabilities.screenshot.is_empty());
        assert_eq!(capabilities.preferred.screenshot, None);
    }

    #[test]
    fn native_x11_display_is_a_screenshot_route_ahead_of_gnome_screenshot() {
        let mut platform = platform_report();
        platform.gnome_shell_version = Check::fail("missing");
        platform.x11_display = Check::ok("native X11 root window 2880x1920, depth 24");
        let portals = portal_report(Check::fail("missing"));
        let accessibility = accessibility_report(Check::ok("bus"), Check::ok("true"));
        let windowing = windowing_report(true, true);
        let input = input_report(true);

        let capabilities = capability_map(&platform, &portals, &accessibility, &windowing, &input);
        let readiness = readiness_report(&platform, &portals, &accessibility, &windowing, &input);

        assert_eq!(capabilities.screenshot, ["x11", "gnome_screenshot"]);
        assert_eq!(capabilities.preferred.screenshot.as_deref(), Some("x11"));
        assert!(!readiness.can_capture_screenshots);
        assert_eq!(
            readiness.screenshot_capture_status,
            ScreenshotCaptureStatus::Unverified
        );
        assert!(readiness.blockers.is_empty());
    }

    #[test]
    fn screenshot_route_detection_is_not_capture_verification() {
        let mut platform = platform_report();
        platform.gnome_shell_version = Check::fail("missing");
        platform.gnome_screenshot = Check::fail("missing");
        let mut portals = portal_report(Check::fail("missing"));
        portals.screenshot = Check::ok(".Screenshot method sa{sv} o -");
        let accessibility = accessibility_report(Check::ok("bus"), Check::ok("true"));
        let windowing = windowing_report(true, true);
        let input = input_report(true);

        let mut readiness =
            readiness_report(&platform, &portals, &accessibility, &windowing, &input);
        let capabilities = capability_map(&platform, &portals, &accessibility, &windowing, &input);

        assert!(!readiness.can_capture_screenshots);
        assert_eq!(
            readiness.screenshot_capture_status,
            ScreenshotCaptureStatus::Unverified
        );
        assert_eq!(readiness.warnings, [SCREENSHOT_UNVERIFIED]);
        assert!(readiness.blockers.is_empty());
        assert_eq!(capabilities.screenshot, ["portal"]);

        readiness.record_screenshot_result(false);
        assert!(!readiness.can_capture_screenshots);
        assert_eq!(
            readiness.screenshot_capture_status,
            ScreenshotCaptureStatus::Failed
        );
        assert_eq!(readiness.blockers, [SCREENSHOT_FAILED]);
        assert!(readiness.warnings.is_empty());
        assert_eq!(readiness.recommended_next_step, SCREENSHOT_FAILED_NEXT_STEP);

        readiness.record_screenshot_result(true);
        assert!(readiness.can_capture_screenshots);
        assert_eq!(
            readiness.screenshot_capture_status,
            ScreenshotCaptureStatus::Verified
        );
        assert!(readiness.blockers.is_empty());
        assert_eq!(readiness.recommended_next_step, READY_NEXT_STEP);
    }

    #[test]
    fn readiness_treats_kwin_as_full_window_backend() {
        let platform = platform_report();
        let accessibility = accessibility_report(Check::ok("bus"), Check::ok("true"));
        let mut windowing = windowing_report(false, false);
        windowing.kwin = Check::ok("KWin scripting is available");
        windowing.can_list_windows = true;
        windowing.can_focus_apps = true;
        windowing.can_focus_windows = true;
        let input = input_report(true);

        let readiness = readiness_report(
            &platform,
            &portal_report(Check::fail("missing")),
            &accessibility,
            &windowing,
            &input,
        );

        assert!(readiness.can_query_windows);
        assert!(readiness.can_focus_apps);
        assert!(readiness.can_focus_windows);
        assert!(readiness.blockers.is_empty());
    }

    #[test]
    fn readiness_message_mentions_generic_window_targeting() {
        let platform = platform_report();
        let accessibility = accessibility_report(Check::ok("bus"), Check::ok("true"));
        let windowing = windowing_report(true, true);
        let input = input_report(true);

        let readiness = readiness_report(
            &platform,
            &portal_report(Check::fail("missing")),
            &accessibility,
            &windowing,
            &input,
        );

        assert!(readiness.blockers.is_empty());
        assert!(readiness
            .recommended_next_step
            .contains("AT-SPI tree support"));
        assert!(readiness.recommended_next_step.contains("window targeting"));
        assert!(!readiness
            .recommended_next_step
            .contains("GNOME window targeting"));
    }

    #[test]
    fn readiness_accepts_connectable_ydotool_socket_without_direct_uinput_access() {
        let platform = platform_report();
        let accessibility = accessibility_report(Check::ok("bus"), Check::ok("true"));
        let windowing = windowing_report(true, true);
        let input = input_report_parts(
            Check::ok("ydotool"),
            Check::ok("ydotoold"),
            Check::ok("connectable: /tmp/.ydotool_socket"),
            Check::fail("/dev/uinput: Permission denied"),
        );

        let readiness = readiness_report(
            &platform,
            &portal_report(Check::fail("missing")),
            &accessibility,
            &windowing,
            &input,
        );

        assert!(readiness.can_send_development_input);
        assert!(readiness.blockers.is_empty());
    }

    #[test]
    fn readiness_uses_connectable_ydotool_socket_when_process_probe_fails() {
        let platform = platform_report();
        let accessibility = accessibility_report(Check::ok("bus"), Check::ok("true"));
        let windowing = windowing_report(true, true);
        let input = input_report_parts(
            Check::ok("ydotool"),
            Check::fail("ydotoold process name not found"),
            Check::ok("connectable: /run/user/1000/.ydotool_socket"),
            Check::fail("/dev/uinput: Permission denied"),
        );
        let portals = portal_report(Check::fail("missing"));

        let capabilities = capability_map(&platform, &portals, &accessibility, &windowing, &input);
        let readiness = readiness_report(&platform, &portals, &accessibility, &windowing, &input);

        assert!(capabilities
            .input
            .iter()
            .any(|backend| backend == "ydotool"));
        assert!(readiness.can_send_development_input);
    }

    #[test]
    fn wayland_readiness_rejects_pointer_only_uinput_without_keyboard_backend() {
        let platform = platform_report();
        let accessibility = accessibility_report(Check::ok("bus"), Check::ok("true"));
        let windowing = windowing_report(true, true);
        let input = input_report_parts(
            Check::ok("ydotool"),
            Check::fail("ydotoold not running"),
            Check::fail("no connectable ydotool socket"),
            Check::ok("read/write: /dev/uinput"),
        );

        let readiness = readiness_report(
            &platform,
            &portal_report(Check::fail("missing")),
            &accessibility,
            &windowing,
            &input,
        );

        assert!(!readiness.can_send_development_input);
        assert!(readiness
            .blockers
            .iter()
            .any(|blocker| blocker.contains("absolute pointer input")));
        assert!(readiness
            .recommended_next_step
            .contains("keyboard-capable input backend"));
    }

    #[test]
    fn x11_readiness_rejects_pointer_only_uinput_without_keyboard_backend() {
        let mut platform = platform_report();
        platform.xdg_session_type = Some("x11".to_string());
        platform.wayland_display = None;
        let accessibility = accessibility_report(Check::ok("bus"), Check::ok("true"));
        let windowing = windowing_report(true, true);
        let input = input_report_parts(
            Check::fail("missing ydotool"),
            Check::fail("ydotoold not running"),
            Check::fail("no connectable ydotool socket"),
            Check::ok("read/write: /dev/uinput"),
        );

        let readiness = readiness_report(
            &platform,
            &portal_report(Check::fail("missing")),
            &accessibility,
            &windowing,
            &input,
        );

        assert!(!readiness.can_send_development_input);
    }

    #[test]
    fn readiness_accepts_remote_desktop_portal_without_local_input_backend() {
        let platform = platform_report();
        let accessibility = accessibility_report(Check::ok("bus"), Check::ok("true"));
        let windowing = windowing_report(true, true);
        let input = input_report_parts(
            Check::fail("missing ydotool"),
            Check::fail("ydotoold not running"),
            Check::fail("no connectable ydotool socket"),
            Check::fail("/dev/uinput: Permission denied"),
        );

        let readiness = readiness_report(
            &platform,
            &portal_report(Check::ok("org.freedesktop.portal.RemoteDesktop")),
            &accessibility,
            &windowing,
            &input,
        );

        assert!(readiness.can_send_development_input);
        assert!(readiness.blockers.is_empty());
    }

    #[test]
    fn readiness_rejects_inaccessible_ydotool_paths() {
        let platform = platform_report();
        let accessibility = accessibility_report(Check::ok("bus"), Check::ok("true"));
        let windowing = windowing_report(true, true);
        let input = input_report_parts(
            Check::ok("ydotool"),
            Check::ok("ydotoold"),
            Check::fail("/tmp/.ydotool_socket: Permission denied"),
            Check::fail("/dev/uinput: Permission denied"),
        );

        let readiness = readiness_report(
            &platform,
            &portal_report(Check::fail("missing")),
            &accessibility,
            &windowing,
            &input,
        );

        assert!(!readiness.can_send_development_input);
        assert!(readiness
            .recommended_next_step
            .contains("Enable a keyboard-capable input backend"));
        assert!(readiness
            .blockers
            .iter()
            .any(|blocker| blocker.contains("Development keyboard input is unavailable")));
    }

    #[test]
    fn capability_map_rejects_incompatible_ydotool_with_live_daemon() {
        let platform = platform_report();
        let portals = portal_report(Check::fail("missing"));
        let accessibility = accessibility_report(Check::ok("bus"), Check::ok("true"));
        let windowing = windowing_report(true, true);
        let input = input_report_parts(
            Check::fail("unsupported legacy ydotool CLI"),
            Check::ok("ydotoold"),
            Check::ok("connectable socket"),
            Check::fail("/dev/uinput: Permission denied"),
        );

        let capabilities = capability_map(&platform, &portals, &accessibility, &windowing, &input);
        let readiness = readiness_report(&platform, &portals, &accessibility, &windowing, &input);

        assert!(!capabilities
            .input
            .iter()
            .any(|backend| backend == "ydotool"));
        assert!(!readiness.can_send_development_input);
    }

    #[test]
    fn ydotool_socket_check_rejects_legacy_stream_socket() {
        let dir = std::env::temp_dir().join(format!("cd-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create temp diagnostics dir");
        let socket = dir.join("ydotool.sock");
        let listener =
            std::os::unix::net::UnixListener::bind(&socket).expect("bind temp diagnostics socket");

        let check = socket_connect_check(&socket);

        assert!(!check.ok, "{check:?}");
        drop(listener);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ydotool_socket_check_accepts_datagram_socket() {
        let dir = std::env::temp_dir().join(format!("cd-dgram-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create temp diagnostics dir");
        let socket = dir.join("ydotool.sock");
        let datagram =
            std::os::unix::net::UnixDatagram::bind(&socket).expect("bind temp datagram socket");

        let check = socket_connect_check(&socket);

        assert!(check.ok, "{check:?}");
        drop(datagram);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn readiness_reports_cosmic_window_blocker_on_cosmic() {
        let mut platform = platform_report();
        platform.xdg_current_desktop = Some("COSMIC".to_string());
        let accessibility = accessibility_report(Check::ok("bus"), Check::ok("true"));
        let windowing = windowing_report(false, false);
        let input = input_report(true);

        let readiness = readiness_report(
            &platform,
            &portal_report(Check::fail("missing")),
            &accessibility,
            &windowing,
            &input,
        );

        assert!(readiness
            .blockers
            .iter()
            .any(|blocker| blocker.contains("COSMIC Wayland window introspection")));
    }

    #[test]
    fn desktop_env_hydration_includes_niri_socket() {
        assert!(DESKTOP_ENV_KEYS.contains(&"NIRI_SOCKET"));
    }

    #[test]
    fn wtype_capability_honors_keyboard_backend_overrides() {
        let mut platform = platform_report();
        platform.xdg_session_type = Some("wayland".to_string());
        platform.xdg_current_desktop = Some("Hyprland".to_string());
        platform.wayland_display = Some("wayland-0".to_string());
        let mut input = input_report(false);
        input.wtype = Check::ok("wtype");

        assert!(should_advertise_wtype(
            &platform, &input, false, false, false
        ));
        assert!(!should_advertise_wtype(
            &platform, &input, true, false, false
        ));
        assert!(!should_advertise_wtype(
            &platform, &input, false, true, false
        ));
        assert!(!should_advertise_wtype(
            &platform, &input, false, false, true
        ));
    }

    #[test]
    fn remote_desktop_pointer_rejects_missing_hidden_cursor_mode() {
        let check = remote_desktop_pointer_check_from(
            &remote_desktop_runtime_introspection(),
            &screencast_runtime_introspection(),
            &Check::ok("u 2"),
            &Check::ok("u 1"),
            &Check::ok("u 2"),
            &Check::ok("u 2"),
        );

        assert!(!check.ok);
        assert!(check.detail.contains("does not include hidden cursor mode"));
    }

    #[test]
    fn remote_desktop_pointer_accepts_screencast_v1_default_hidden_cursor() {
        let check = remote_desktop_pointer_check_from(
            &remote_desktop_runtime_introspection(),
            &screencast_runtime_introspection(),
            &Check::ok("u 2"),
            &Check::ok("u 1"),
            &Check::ok("u 1"),
            &Check::fail("AvailableCursorModes is not available on ScreenCast v1"),
        );

        assert!(check.ok);
        assert!(check
            .detail
            .contains("hidden cursor mode is the interface default"));
    }

    #[test]
    fn capability_map_reports_niri_window_control() {
        let platform = platform_report();
        let portals = portal_report(Check::fail("missing"));
        let accessibility = accessibility_report(Check::ok("bus"), Check::ok("true"));
        let mut windowing = windowing_report(false, false);
        windowing.niri = Check::ok("niri msg returned windows");
        let input = input_report(false);

        let capabilities = capability_map(&platform, &portals, &accessibility, &windowing, &input);

        assert_eq!(capabilities.window_control, vec![NIRI_BACKEND]);
        assert_eq!(
            capabilities.preferred.window_control.as_deref(),
            Some(NIRI_BACKEND)
        );
    }

    #[test]
    fn readiness_and_capabilities_share_the_screenshot_route_list() {
        let mut platform = platform_report();
        platform.gnome_shell_version = Check::fail("missing");
        platform.gnome_screenshot = Check::fail("missing");
        let mut portals = portal_report(Check::fail("missing"));
        portals.screenshot = Check::ok(".Screenshot method sa{sv} o -");
        let accessibility = accessibility_report(Check::ok("bus"), Check::ok("true"));
        let mut windowing = windowing_report(true, true);
        // The embedded fixture enables the Codex extension screenshot route with
        // window focus; switch it off so this test isolates the routes it names.
        windowing.codex_gnome_shell_extension_screenshot = Check::fail("missing");
        let input = input_report(true);

        let readiness = readiness_report(&platform, &portals, &accessibility, &windowing, &input);
        let capabilities = capability_map(&platform, &portals, &accessibility, &windowing, &input);

        assert!(!readiness.can_capture_screenshots);
        assert_eq!(
            readiness.screenshot_capture_status,
            ScreenshotCaptureStatus::Unverified
        );
        assert_eq!(capabilities.screenshot, ["portal"]);
    }
}
