use crate::windowing::backends::{
    cosmic, gnome, hyprland, i3, kwin, labwc, niri, wlr_foreign_toplevel, x11,
};
use crate::windowing::types::WindowInfo;
use anyhow::{anyhow, Result};
use std::future::Future;

pub use cosmic::COSMIC_WAYLAND_BACKEND;
pub use gnome::{GNOME_SHELL_EXTENSION_BACKEND, GNOME_SHELL_INTROSPECT_BACKEND};
pub use hyprland::HYPRLAND_BACKEND;
pub use i3::I3_BACKEND;
pub use kwin::KWIN_BACKEND;
pub use labwc::LABWC_BACKEND;
pub use niri::NIRI_BACKEND;
pub use wlr_foreign_toplevel::WLR_FOREIGN_TOPLEVEL_BACKEND;
pub use x11::X11_BACKEND;

/// Reported when no window backend answered, so no backend can be named.
pub const UNAVAILABLE_BACKEND: &str = "unavailable";

pub const WINDOW_PERMISSION_HINT: &str = "Computer Use could not access a supported window list backend. Targeted window input requires session-bus access plus GNOME Shell Introspect, the Codex GNOME Shell extension, the COSMIC Wayland helper, KWin/Plasma DBus scripting, Hyprland hyprctl, the niri IPC socket, labwc.sock, i3-msg or swaymsg, or zwlr_foreign_toplevel_manager_v1. On GNOME, run setup_window_targeting to install the extension backend.";

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
    Labwc,
    WlrForeignToplevel,
    X11,
}

const BACKEND_ORDER: &[BackendKind] = &[
    BackendKind::GnomeExtension,
    BackendKind::GnomeIntrospect,
    BackendKind::Cosmic,
    BackendKind::Kwin,
    BackendKind::Hyprland,
    BackendKind::Niri,
    BackendKind::I3,
    BackendKind::Labwc,
    // Generic wlroots protocol: after the compositor-specific backends, which
    // report pids and exact IDs where this protocol cannot.
    BackendKind::WlrForeignToplevel,
    // Generic X11/EWMH: last, so a session-native backend always wins first.
    BackendKind::X11,
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
        failure_label: "niri",
        list_note: "Window list came from niri msg or its direct IPC fallback. Terminal windows may include best-effort PTY and active-process context when the process tree is readable.",
        missing_hint: "On niri, export the session's NIRI_SOCKET or expose an unambiguous matching socket in XDG_RUNTIME_DIR. The niri binary is optional.",
        can_exact_focus: true,
    },
    BackendDescriptor {
        id: I3_BACKEND,
        failure_label: "i3",
        list_note: "Window list came from i3-msg or swaymsg over the i3 or Sway IPC socket. Native Wayland windows on Sway get ids above 2^32, derived from their container id. Terminal windows may include best-effort PTY and active-process context when the process tree is readable; on i3 the pid also needs xprop.",
        missing_hint: "On i3 or Sway, ensure i3-msg or swaymsg can reach the active IPC socket (I3SOCK or SWAYSOCK).",
        can_exact_focus: true,
    },
    BackendDescriptor {
        id: LABWC_BACKEND,
        failure_label: "labwc",
        list_note: "Window list came from the labwc IPC socket. Terminal windows may include best-effort PTY and active-process context when the process tree is readable.",
        missing_hint: "On labwc, the session socket labwc.sock lists windows. Activation uses wlr-foreign-toplevel-management.",
        can_exact_focus: true,
    },
    BackendDescriptor {
        id: WLR_FOREIGN_TOPLEVEL_BACKEND,
        failure_label: "wlr-foreign-toplevel",
        list_note: "Window list came from wlr-foreign-toplevel-management. It reports no pids or bounds, and window IDs derive from the app id and title, so they change when the title changes and windows sharing both cannot be targeted exactly.",
        missing_hint: "The compositor must advertise zwlr_foreign_toplevel_manager_v1 on WAYLAND_DISPLAY; not all Wayland compositors provide it.",
        can_exact_focus: true,
    },
    BackendDescriptor {
        id: X11_BACKEND,
        failure_label: "X11/EWMH",
        list_note: "Window list came from X11/EWMH (wmctrl). Terminal windows may include best-effort PTY and active-process context when the process tree is readable.",
        missing_hint: "On other X11 window managers (Cinnamon, MATE, Xfce, Openbox, etc.), ensure wmctrl and xprop are installed.",
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
    if id == X11_BACKEND {
        x11::can_exact_focus()
    } else {
        descriptor(id).is_some_and(|descriptor| descriptor.can_exact_focus)
    }
}

/// A window list, with the backends that failed on the way to it.
pub struct WindowListing {
    pub windows: Vec<WindowInfo>,
    /// Backends whose list call failed: those tried before the one that
    /// answered, and X11 when its exact-focus list failed after GNOME Shell
    /// Introspect answered. A backend that listed no windows did not fail.
    pub failed_backends: Vec<&'static str>,
}

pub async fn list_windows() -> Result<Vec<WindowInfo>> {
    Ok(list_windows_with_failures().await?.windows)
}

pub async fn list_windows_with_failures() -> Result<WindowListing> {
    first_answer(list_windows_for, || {
        x11::can_exact_focus().then(x11::list_windows_for_exact_focus)
    })
    .await
}

/// Lists through the first backend in `BACKEND_ORDER` that returns windows.
/// After GNOME Shell Introspect answers, `exact_x11` can supply X11's list,
/// which wins because X11 can focus a window exactly.
async fn first_answer<L, LF, X, XF>(mut list: L, exact_x11: X) -> Result<WindowListing>
where
    L: FnMut(BackendKind) -> LF,
    LF: Future<Output = Result<Vec<WindowInfo>>>,
    X: FnOnce() -> Option<XF>,
    XF: Future<Output = Result<Vec<WindowInfo>>>,
{
    let mut misses = Misses::default();
    for backend in BACKEND_ORDER {
        if let Some(windows) = usable_backend_windows(*backend, list(*backend).await, &mut misses) {
            let windows = if matches!(backend, BackendKind::GnomeIntrospect) {
                let x11_result = match exact_x11() {
                    Some(listing) => Some(listing.await),
                    None => None,
                };
                prefer_exact_x11_windows(windows, x11_result, &mut misses)
            } else {
                windows
            };
            return Ok(WindowListing {
                windows,
                failed_backends: misses.failed,
            });
        }
    }
    Err(anyhow!(misses.notes.join("; ")))
}

/// What the backends that gave no usable window list said, in call order.
#[derive(Default)]
struct Misses {
    /// One note per backend, joined into the error when none answers.
    notes: Vec<String>,
    failed: Vec<&'static str>,
}

fn prefer_exact_x11_windows(
    introspect_windows: Vec<WindowInfo>,
    x11_result: Option<Result<Vec<WindowInfo>>>,
    misses: &mut Misses,
) -> Vec<WindowInfo> {
    x11_result
        .and_then(|result| usable_backend_windows(BackendKind::X11, result, misses))
        .unwrap_or(introspect_windows)
}

fn usable_backend_windows(
    backend: BackendKind,
    result: Result<Vec<WindowInfo>>,
    misses: &mut Misses,
) -> Option<Vec<WindowInfo>> {
    match result {
        Ok(windows) if !windows.is_empty() => Some(windows),
        Ok(_) => {
            misses
                .notes
                .push(format!("{} returned no windows", backend.failure_label()));
            None
        }
        Err(error) => {
            misses
                .notes
                .push(format!("{} failed: {error:#}", backend.failure_label()));
            misses.failed.push(backend.id());
            None
        }
    }
}

async fn list_windows_for(backend: BackendKind) -> Result<Vec<WindowInfo>> {
    match backend {
        BackendKind::GnomeExtension => gnome::list_extension_windows().await,
        BackendKind::GnomeIntrospect => gnome::list_introspect_windows().await,
        BackendKind::Cosmic => cosmic::list_windows().await,
        BackendKind::Kwin => kwin::list_windows().await,
        BackendKind::Hyprland => hyprland::list_windows().await,
        BackendKind::Niri => niri::list_windows().await,
        BackendKind::I3 => i3::list_windows().await,
        BackendKind::Labwc => labwc::list_windows().await,
        BackendKind::WlrForeignToplevel => wlr_foreign_toplevel::list_windows().await,
        BackendKind::X11 => x11::list_windows().await,
    }
}

pub async fn activate_window(window: &WindowInfo) -> Result<()> {
    match window.backend.as_str() {
        GNOME_SHELL_EXTENSION_BACKEND => gnome::activate_extension_window(window.window_id).await,
        GNOME_SHELL_INTROSPECT_BACKEND => Err(anyhow!(
            "GNOME Introspect cannot activate windows. Focus the app manually or install the GNOME Shell extension."
        )),
        COSMIC_WAYLAND_BACKEND => cosmic::activate_window(window.window_id).await,
        KWIN_BACKEND => kwin::activate_window(window.window_id).await,
        HYPRLAND_BACKEND => hyprland::activate_window(window.window_id).await,
        NIRI_BACKEND => niri::activate_window(window.window_id).await,
        I3_BACKEND => i3::activate_window(window.window_id).await,
        LABWC_BACKEND => labwc::activate(window).await,
        WLR_FOREIGN_TOPLEVEL_BACKEND => wlr_foreign_toplevel::activate(window).await,
        X11_BACKEND => x11::activate_window(window.window_id).await,
        backend => Err(anyhow!(
            "Unsupported window backend for activation: {backend}"
        )),
    }
}

pub async fn focused_window_for_backend(backend: &str) -> Result<Option<WindowInfo>> {
    let windows = match backend {
        GNOME_SHELL_EXTENSION_BACKEND => gnome::list_extension_windows().await?,
        GNOME_SHELL_INTROSPECT_BACKEND => gnome::list_introspect_windows().await?,
        COSMIC_WAYLAND_BACKEND => return cosmic::focused_window().await,
        KWIN_BACKEND => kwin::list_windows().await?,
        HYPRLAND_BACKEND => hyprland::list_windows().await?,
        NIRI_BACKEND => niri::list_windows().await?,
        I3_BACKEND => i3::list_windows().await?,
        LABWC_BACKEND => return labwc::focused_window().await,
        WLR_FOREIGN_TOPLEVEL_BACKEND => return wlr_foreign_toplevel::focused_window().await,
        X11_BACKEND => x11::list_windows_for_exact_focus().await?,
        backend => {
            return Err(anyhow!(
                "Unsupported window backend for focus query: {backend}"
            ))
        }
    };
    Ok(windows.into_iter().find(|window| window.focused))
}

pub async fn move_window(window: &WindowInfo, x: i32, y: i32) -> Result<String> {
    match window.backend.as_str() {
        GNOME_SHELL_EXTENSION_BACKEND => {
            gnome::move_extension_window(window.window_id, x, y).await
        }
        X11_BACKEND => x11::move_window(window.window_id, x, y).await,
        backend => Err(anyhow!(
            "Window backend {backend} cannot move windows; move_window needs the Codex GNOME Shell extension or a generic X11/EWMH session."
        )),
    }
}

pub async fn resize_window(window: &WindowInfo, width: i32, height: i32) -> Result<String> {
    match window.backend.as_str() {
        GNOME_SHELL_EXTENSION_BACKEND => {
            gnome::resize_extension_window(window.window_id, width, height).await
        }
        X11_BACKEND => x11::resize_window(window.window_id, width, height).await,
        backend => Err(anyhow!(
            "Window backend {backend} cannot resize windows; resize_window needs the Codex GNOME Shell extension or a generic X11/EWMH session."
        )),
    }
}

pub async fn focused_window_override() -> Option<WindowInfo> {
    cosmic::focused_window().await.ok().flatten()
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
        labwc::probe(),
        wlr_foreign_toplevel::probe(),
        x11::probe(),
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
            BackendKind::Labwc => LABWC_BACKEND,
            BackendKind::WlrForeignToplevel => WLR_FOREIGN_TOPLEVEL_BACKEND,
            BackendKind::X11 => X11_BACKEND,
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
        let mut misses = Misses::default();

        assert!(
            usable_backend_windows(BackendKind::GnomeIntrospect, Ok(Vec::new()), &mut misses,)
                .is_none()
        );

        let windows = usable_backend_windows(
            BackendKind::Kwin,
            Ok(vec![window(KWIN_BACKEND)]),
            &mut misses,
        )
        .expect("non-empty backend result should be accepted");

        assert_eq!(windows[0].backend, KWIN_BACKEND);
        assert_eq!(
            misses.notes,
            vec!["GNOME Shell Introspect returned no windows"]
        );
    }

    #[test]
    fn exact_x11_result_wins_over_gnome_list_only_result() {
        let mut misses = Misses::default();
        let selected = prefer_exact_x11_windows(
            vec![window(GNOME_SHELL_INTROSPECT_BACKEND)],
            Some(Ok(vec![window(X11_BACKEND)])),
            &mut misses,
        );
        assert_eq!(selected[0].backend, X11_BACKEND);
        assert!(misses.notes.is_empty());
    }

    #[test]
    fn gnome_list_only_result_survives_failed_x11_listing() {
        let mut misses = Misses::default();
        let selected = prefer_exact_x11_windows(
            vec![window(GNOME_SHELL_INTROSPECT_BACKEND)],
            Some(Err(anyhow!("wmctrl failed"))),
            &mut misses,
        );

        assert_eq!(selected[0].backend, GNOME_SHELL_INTROSPECT_BACKEND);
        assert_eq!(misses.notes, ["X11/EWMH failed: wmctrl failed"]);
    }

    #[test]
    fn records_backend_failures_with_registry_labels() {
        let mut misses = Misses::default();

        assert!(usable_backend_windows(
            BackendKind::Kwin,
            Err(anyhow!("loadScript failed")),
            &mut misses,
        )
        .is_none());

        assert_eq!(misses.notes, vec!["KWin failed: loadScript failed"]);
    }

    fn listed(backend: &str) -> Result<Vec<WindowInfo>> {
        Ok(vec![window(backend)])
    }

    #[tokio::test]
    async fn a_listing_names_the_backends_that_failed_before_one_answered() {
        let listing = first_answer(
            |backend| {
                std::future::ready(match backend {
                    BackendKind::GnomeExtension | BackendKind::Cosmic => {
                        Err(anyhow!("not on the session bus"))
                    }
                    BackendKind::GnomeIntrospect => Ok(Vec::new()),
                    BackendKind::Kwin => listed(KWIN_BACKEND),
                    _ => Err(anyhow!("tried after KWin answered")),
                })
            },
            || None::<std::future::Ready<_>>,
        )
        .await
        .unwrap();

        assert_eq!(listing.windows[0].backend, KWIN_BACKEND);
        assert_eq!(
            listing.failed_backends,
            [GNOME_SHELL_EXTENSION_BACKEND, COSMIC_WAYLAND_BACKEND],
            "Introspect listed no windows, which is not a failure"
        );
    }

    #[tokio::test]
    async fn an_exact_focus_x11_list_that_fails_after_introspect_answers_is_an_x11_failure() {
        let cases = [
            (
                "X11 cannot focus exactly here",
                None,
                GNOME_SHELL_INTROSPECT_BACKEND,
                vec![GNOME_SHELL_EXTENSION_BACKEND],
            ),
            (
                "X11's list failed",
                Some(Err(anyhow!("xprop could not query _NET_ACTIVE_WINDOW"))),
                GNOME_SHELL_INTROSPECT_BACKEND,
                vec![GNOME_SHELL_EXTENSION_BACKEND, X11_BACKEND],
            ),
            (
                "X11 listed no windows",
                Some(Ok(Vec::new())),
                GNOME_SHELL_INTROSPECT_BACKEND,
                vec![GNOME_SHELL_EXTENSION_BACKEND],
            ),
            (
                "X11 listed windows",
                Some(listed(X11_BACKEND)),
                X11_BACKEND,
                vec![GNOME_SHELL_EXTENSION_BACKEND],
            ),
        ];
        for (case, x11_result, answered, failed) in cases {
            let listing = first_answer(
                |backend| {
                    std::future::ready(match backend {
                        BackendKind::GnomeIntrospect => listed(GNOME_SHELL_INTROSPECT_BACKEND),
                        _ => Err(anyhow!("extension disabled")),
                    })
                },
                || x11_result.map(std::future::ready),
            )
            .await
            .unwrap();

            assert_eq!(listing.windows[0].backend, answered, "{case}");
            assert_eq!(listing.failed_backends, failed, "{case}");
        }
    }
}
