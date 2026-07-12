use crate::windowing::backends::{cosmic, gnome, hyprland, i3, kwin, niri};
use crate::windowing::types::WindowInfo;
use anyhow::{anyhow, Result};

pub use cosmic::COSMIC_WAYLAND_BACKEND;
pub use gnome::{GNOME_SHELL_EXTENSION_BACKEND, GNOME_SHELL_INTROSPECT_BACKEND};
pub use hyprland::HYPRLAND_BACKEND;
pub use i3::I3_BACKEND;
pub use kwin::KWIN_BACKEND;
pub use niri::NIRI_BACKEND;

pub const WINDOW_PERMISSION_HINT: &str = "Computer Use could not access a supported window list backend. Targeted window input requires session-bus access plus GNOME Shell Introspect, the Codex GNOME Shell extension, the COSMIC Wayland helper, KWin/Plasma DBus scripting, Hyprland hyprctl, Niri IPC, or i3-msg. On GNOME, run setup_window_targeting to install the extension backend.";

#[derive(Debug, Clone, Copy)]
pub struct BackendDescriptor {
    pub id: &'static str,
    pub failure_label: &'static str,
    pub list_note: &'static str,
    pub missing_hint: &'static str,
    pub can_exact_focus: bool,
}

#[derive(Debug, Clone)]
pub struct BackendProbe {
    pub id: &'static str,
    pub ok: bool,
    pub can_list_windows: bool,
    pub can_focus_apps: bool,
    pub can_focus_windows: bool,
    pub detail: String,
}

#[derive(Debug, Clone, Copy)]
enum BackendKind {
    GnomeExtension,
    GnomeIntrospect,
    Cosmic,
    Kwin,
    Hyprland,
    Niri,
    I3,
}

const BACKEND_ORDER: &[BackendKind] = &[
    BackendKind::GnomeExtension,
    BackendKind::GnomeIntrospect,
    BackendKind::Cosmic,
    BackendKind::Kwin,
    BackendKind::Hyprland,
    BackendKind::Niri,
    BackendKind::I3,
];

const DESCRIPTORS: &[BackendDescriptor] = &[
    BackendDescriptor {
        id: GNOME_SHELL_EXTENSION_BACKEND,
        failure_label: "Codex GNOME Shell extension",
        list_note: "Window list came from the Codex GNOME Shell extension. Terminal windows may include best-effort PTY and active-process context when the process tree is readable.",
        missing_hint: "On GNOME, run setup_window_targeting to install the optional GNOME Shell extension backend.",
        can_exact_focus: true,
    },
    BackendDescriptor {
        id: GNOME_SHELL_INTROSPECT_BACKEND,
        failure_label: "GNOME Shell Introspect",
        list_note: "Window list came from GNOME Shell Introspect. Terminal windows may include best-effort PTY and active-process context when the process tree is readable.",
        missing_hint: "On GNOME, ensure org.gnome.Shell.Introspect is available on the session bus.",
        can_exact_focus: false,
    },
    BackendDescriptor {
        id: COSMIC_WAYLAND_BACKEND,
        failure_label: "COSMIC helper",
        list_note: "Window list came from the COSMIC Wayland helper. Terminal windows may include best-effort PTY and active-process context when the process tree is readable.",
        missing_hint: "On COSMIC, ensure the bundled COSMIC helper is present and can connect to the session.",
        can_exact_focus: true,
    },
    BackendDescriptor {
        id: KWIN_BACKEND,
        failure_label: "KWin",
        list_note: "Window list came from KWin/Plasma DBus scripting. Terminal windows may include best-effort PTY and active-process context when the process tree is readable.",
        missing_hint: "On KDE/Plasma, ensure KWin exposes org.kde.KWin scripting on the session bus.",
        can_exact_focus: true,
    },
    BackendDescriptor {
        id: HYPRLAND_BACKEND,
        failure_label: "Hyprland",
        list_note: "Window list came from Hyprland hyprctl. Terminal windows may include best-effort PTY and active-process context when the process tree is readable.",
        missing_hint: "On Hyprland, ensure hyprctl is available in the session.",
        can_exact_focus: true,
    },
    BackendDescriptor {
        id: NIRI_BACKEND,
        failure_label: "Niri",
        list_note: "Window list came from Niri IPC. Terminal windows may include best-effort PTY and active-process context when the process tree is readable.",
        missing_hint: "On Niri, ensure NIRI_SOCKET is available and niri msg can reach the active compositor.",
        can_exact_focus: true,
    },
    BackendDescriptor {
        id: I3_BACKEND,
        failure_label: "i3",
        list_note: "Window list came from i3-msg. Terminal windows may include best-effort PTY and active-process context when xprop and the process tree are readable.",
        missing_hint: "On i3, ensure i3-msg can reach the active i3 IPC socket.",
        can_exact_focus: true,
    },
];

pub fn descriptors() -> &'static [BackendDescriptor] {
    DESCRIPTORS
}

pub fn descriptor(id: &str) -> Option<&'static BackendDescriptor> {
    DESCRIPTORS.iter().find(|descriptor| descriptor.id == id)
}

pub fn list_note(id: &str) -> &'static str {
    descriptor(id)
        .map(|descriptor| descriptor.list_note)
        .unwrap_or_else(|| {
            descriptor(GNOME_SHELL_INTROSPECT_BACKEND)
                .unwrap()
                .list_note
        })
}

pub fn backend_can_exact_focus(id: &str) -> bool {
    descriptor(id).is_some_and(|descriptor| descriptor.can_exact_focus)
}

pub async fn list_windows() -> Result<Vec<WindowInfo>> {
    let mut errors = Vec::new();
    for backend in BACKEND_ORDER {
        if let Some(windows) =
            usable_backend_windows(*backend, list_windows_for(*backend).await, &mut errors)
        {
            return Ok(windows);
        }
    }
    Err(anyhow!(errors.join("; ")))
}

fn usable_backend_windows(
    backend: BackendKind,
    result: Result<Vec<WindowInfo>>,
    errors: &mut Vec<String>,
) -> Option<Vec<WindowInfo>> {
    match result {
        Ok(windows) if !windows.is_empty() => Some(windows),
        Ok(_) => {
            errors.push(format!("{} returned no windows", backend.failure_label()));
            None
        }
        Err(error) => {
            errors.push(format!("{} failed: {error:#}", backend.failure_label()));
            None
        }
    }
}

async fn list_windows_for(backend: BackendKind) -> Result<Vec<WindowInfo>> {
    match backend {
        BackendKind::GnomeExtension => gnome::list_extension_windows().await,
        BackendKind::GnomeIntrospect => gnome::list_introspect_windows().await,
        BackendKind::Cosmic => cosmic::list_windows(),
        BackendKind::Kwin => kwin::list_windows().await,
        BackendKind::Hyprland => hyprland::list_windows(),
        BackendKind::Niri => niri::list_windows(),
        BackendKind::I3 => i3::list_windows(),
    }
}

pub async fn activate_window(window: &WindowInfo) -> Result<()> {
    match window.backend.as_str() {
        GNOME_SHELL_EXTENSION_BACKEND => gnome::activate_extension_window(window.window_id).await,
        GNOME_SHELL_INTROSPECT_BACKEND => {
            let app_id = window
                .app_id
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    anyhow!(
                        "GNOME Shell can only focus by app_id; the matched window has no app_id"
                    )
                })?;
            gnome::focus_app(app_id).await
        }
        COSMIC_WAYLAND_BACKEND => cosmic::activate_window(window.window_id),
        KWIN_BACKEND => kwin::activate_window(window.window_id).await,
        HYPRLAND_BACKEND => hyprland::activate_window(window.window_id),
        NIRI_BACKEND => niri::activate_window(window.window_id),
        I3_BACKEND => i3::activate_window(window.window_id),
        backend => Err(anyhow!(
            "Unsupported window backend for activation: {backend}"
        )),
    }
}

pub fn focused_window_override() -> Option<WindowInfo> {
    cosmic::focused_window().ok().flatten()
}

pub fn probe_backends() -> Vec<BackendProbe> {
    vec![
        gnome::probe_extension(),
        gnome::probe_introspect(),
        cosmic::probe(),
        kwin::probe(),
        hyprland::probe(),
        niri::probe(),
        i3::probe(),
    ]
}

impl BackendKind {
    fn id(self) -> &'static str {
        match self {
            BackendKind::GnomeExtension => GNOME_SHELL_EXTENSION_BACKEND,
            BackendKind::GnomeIntrospect => GNOME_SHELL_INTROSPECT_BACKEND,
            BackendKind::Cosmic => COSMIC_WAYLAND_BACKEND,
            BackendKind::Kwin => KWIN_BACKEND,
            BackendKind::Hyprland => HYPRLAND_BACKEND,
            BackendKind::Niri => NIRI_BACKEND,
            BackendKind::I3 => I3_BACKEND,
        }
    }

    fn failure_label(self) -> &'static str {
        descriptor(self.id())
            .map(|item| item.failure_label)
            .unwrap_or(self.id())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::windowing::types::WindowBounds;

    fn window(backend: &str) -> WindowInfo {
        WindowInfo {
            window_id: 1,
            title: Some("Codex".to_string()),
            app_id: Some("codex-desktop".to_string()),
            wm_class: Some("codex-desktop".to_string()),
            pid: Some(1234),
            bounds: Some(WindowBounds {
                x: Some(0),
                y: Some(0),
                width: 800,
                height: 600,
            }),
            workspace: None,
            focused: true,
            hidden: false,
            client_type: Some("wayland".to_string()),
            backend: backend.to_string(),
            terminal: None,
        }
    }

    #[test]
    fn skips_empty_backend_results_so_later_backends_can_answer() {
        let mut errors = Vec::new();

        assert!(
            usable_backend_windows(BackendKind::GnomeIntrospect, Ok(Vec::new()), &mut errors,)
                .is_none()
        );

        let windows = usable_backend_windows(
            BackendKind::Kwin,
            Ok(vec![window(KWIN_BACKEND)]),
            &mut errors,
        )
        .expect("non-empty backend result should be accepted");

        assert_eq!(windows[0].backend, KWIN_BACKEND);
        assert_eq!(errors, vec!["GNOME Shell Introspect returned no windows"]);
    }

    #[test]
    fn records_backend_failures_with_registry_labels() {
        let mut errors = Vec::new();

        assert!(usable_backend_windows(
            BackendKind::Kwin,
            Err(anyhow!("loadScript failed")),
            &mut errors,
        )
        .is_none());

        assert_eq!(errors, vec!["KWin failed: loadScript failed"]);
    }
}
