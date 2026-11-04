//! Generic X11 / EWMH window backend.
//!
//! Unlike the compositor-specific backends (GNOME Shell, KWin, Hyprland, i3),
//! this one talks plain [EWMH]/[ICCCM] through `wmctrl` + `xprop`, so it works
//! on any reasonably standards-compliant X11 window manager that does not have
//! a dedicated backend — Cinnamon/Muffin, MATE/Marco, Xfce/xfwm4, Openbox, etc.
//! It is intentionally registered last so a session-native backend always wins
//! when one is present.
//!
//! Window origins come from the X server, not from `wmctrl -lG`, whose x/y
//! count the client's offset in its parent twice (#157). Width and height
//! from wmctrl are the client size and stay. Bounds are the client area.
//!
//! [EWMH]: https://specifications.freedesktop.org/wm-spec/latest/
//! [ICCCM]: https://tronche.com/gui/x/icccm/

use crate::command_runner;
use crate::terminal::enrich_terminal_windows;
use crate::windowing::registry::BackendProbe;
use crate::windowing::types::{WindowBounds, WindowInfo};
use crate::x11_display::{
    frame_origin, is_native_x11_session as is_x11_session, with_x11_display, X11_QUERY_TIMEOUT,
};
use anyhow::{bail, Result};
use std::env;
use std::os::unix::fs::PermissionsExt;
use std::process::Command;
use tokio::process::Command as TokioCommand;
use tokio::time::{sleep, Duration};

pub const X11_BACKEND: &str = "x11";
const GEOMETRY_VERIFY_ATTEMPTS: usize = 11;
const GEOMETRY_VERIFY_DELAY: Duration = Duration::from_millis(50);
const PROBE_TIMEOUT: Duration = Duration::from_secs(2);

pub(crate) fn can_exact_focus() -> bool {
    is_x11_session() && command_on_path("wmctrl") && command_on_path("xprop")
}

pub fn probe() -> BackendProbe {
    if !is_x11_session() {
        return probe_fail("no X11 session (needs DISPLAY on an X11, not Wayland, session)");
    }
    let mut command = wmctrl();
    command.args(["-l", "-p", "-G", "-x"]);
    match command_runner::output_blocking_with_timeout(
        &mut command,
        "probe X11 windows",
        PROBE_TIMEOUT,
    ) {
        Ok(output) if output.status.success() => {
            // Listing only needs wmctrl, but the `focused` flag (and therefore
            // focused_window() and activate_window's focus verification) comes
            // from `_NET_ACTIVE_WINDOW` read via xprop. Without xprop we can list
            // but cannot verify focus, so don't advertise focus capabilities.
            let can_focus = can_exact_focus() && active_window_query().is_some();
            BackendProbe {
                id: X11_BACKEND,
                ok: true,
                can_list_windows: true,
                can_focus_apps: can_focus,
                can_focus_windows: can_focus,
                detail: if can_focus {
                    "wmctrl listed X11/EWMH windows".to_string()
                } else {
                    "wmctrl listed X11/EWMH windows; xprop missing, so focused-window verification is unavailable".to_string()
                },
            }
        }
        Ok(output) => probe_fail(&format!(
            "wmctrl -l failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )),
        Err(error) => probe_fail(&format!("wmctrl unavailable: {error}")),
    }
}

fn probe_fail(detail: &str) -> BackendProbe {
    BackendProbe {
        id: X11_BACKEND,
        ok: false,
        can_list_windows: false,
        can_focus_apps: false,
        can_focus_windows: false,
        detail: detail.to_string(),
    }
}

pub async fn list_windows() -> Result<Vec<WindowInfo>> {
    list_windows_with_focus_query(false).await
}

pub(crate) async fn list_windows_for_exact_focus() -> Result<Vec<WindowInfo>> {
    list_windows_with_focus_query(true).await
}

async fn list_windows_with_focus_query(require_focus_query: bool) -> Result<Vec<WindowInfo>> {
    // Guard the session too, not just probe(): registry::list_windows() tries
    // each backend directly, so without this a Wayland session with no native
    // backend would fall through here and return XWayland-only windows.
    if !is_x11_session() {
        bail!("not an X11 session (needs DISPLAY on an X11, not Wayland, session)");
    }
    let mut command = wmctrl_async();
    command.args(["-l", "-p", "-G", "-x"]);
    let output = command_runner::output(command, "run wmctrl -l -p -G -x").await?;
    if !output.status.success() {
        bail!(
            "wmctrl -l -p -G -x failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }

    let active_id =
        resolve_active_window_query(active_window_query_async().await, require_focus_query)?;
    let mut windows = parse_wmctrl_windows(&String::from_utf8_lossy(&output.stdout), active_id);
    correct_client_origins(&mut windows).await;
    enrich_terminal_windows(&mut windows);
    Ok(windows)
}

/// Replace wmctrl's double-counted x/y with the absolute client origin. When the
/// X server cannot be asked, or a window vanished, the origin becomes unknown:
/// a wrong origin would shift crops and relative clicks, while an unknown one
/// makes them refuse.
async fn correct_client_origins(windows: &mut [WindowInfo]) {
    let ids = windows.iter().map(x11_window_id).collect::<Vec<_>>();
    let origins = with_x11_display(X11_QUERY_TIMEOUT, move |display| {
        display.client_origins(&ids)
    })
    .await
    .unwrap_or_else(|_| vec![None; windows.len()]);
    apply_client_origins(windows, &origins);
}

fn x11_window_id(window: &WindowInfo) -> u32 {
    // X resource ids are 29-bit; anything larger is not a window and the
    // server answers with an error, which becomes an unknown origin.
    u32::try_from(window.window_id).unwrap_or(0)
}

pub(crate) fn apply_client_origins(windows: &mut [WindowInfo], origins: &[Option<(i32, i32)>]) {
    for (window, origin) in windows.iter_mut().zip(origins) {
        if let Some(bounds) = window.bounds.as_mut() {
            bounds.x = origin.map(|(x, _)| x);
            bounds.y = origin.map(|(_, y)| y);
        }
    }
}

pub async fn activate_window(window_id: u64) -> Result<()> {
    let id = window_id_arg(window_id);
    run_wmctrl(&["-i", "-a", id.as_str()], "activate window", window_id).await
}

pub async fn move_window(window_id: u64, x: i32, y: i32) -> Result<String> {
    unmaximize(window_id).await?;
    let id = window_id_arg(window_id);
    // wmctrl -e is `gravity,x,y,width,height`; the trailing -1,-1 keep the size.
    // wmctrl also reads -1 in the x/y fields as "preserve current position", so a
    // literal -1 target would be dropped — nudge it to -2 so the move still lands.
    let geometry = format!("0,{},{},-1,-1", wmctrl_move_coord(x), wmctrl_move_coord(y));
    run_wmctrl(
        &["-i", "-r", id.as_str(), "-e", geometry.as_str()],
        "move window",
        window_id,
    )
    .await?;
    let expected = (wmctrl_move_coord(x), wmctrl_move_coord(y));
    // `-e 0,x,y` uses the window's gravity; the default NorthWest places the
    // frame's outer corner at x,y, so compare the frame origin, not the client.
    let (geometry, exact) =
        wait_for_window_geometry(window_id, |geometry| frame_at_position(geometry, expected))
            .await?;
    if exact {
        Ok(format!("Moved window to ({x}, {y}) via X11/EWMH (wmctrl)."))
    } else {
        Ok(format!(
            "Requested move to ({x}, {y}) via X11/EWMH; the window manager reported frame position {}.",
            geometry
                .frame_origin
                .map_or_else(|| "unknown".to_string(), |(fx, fy)| format!("({fx}, {fy})"))
        ))
    }
}

/// `wmctrl -e` treats -1 in any field as "keep current value", so a literal -1
/// coordinate is silently ignored. Map it to -2 so the window actually moves
/// (a 1px difference at the screen edge is harmless).
fn wmctrl_move_coord(value: i32) -> i32 {
    if value == -1 {
        -2
    } else {
        value
    }
}

pub async fn resize_window(window_id: u64, width: i32, height: i32) -> Result<String> {
    // wmctrl -e reads -1 (and rejects <= 0) as "preserve current value" per
    // field, so a non-positive size would silently leave a dimension unchanged
    // while reporting success. Reject it up front.
    if width <= 0 || height <= 0 {
        bail!("resize requires positive width and height (got {width}x{height})");
    }
    unmaximize(window_id).await?;
    let id = window_id_arg(window_id);
    let geometry = format!("0,-1,-1,{width},{height}");
    run_wmctrl(
        &["-i", "-r", id.as_str(), "-e", geometry.as_str()],
        "resize window",
        window_id,
    )
    .await?;
    let (geometry, exact) = wait_for_window_geometry(window_id, |geometry| {
        bounds_at_size(&geometry.bounds, width as u32, height as u32)
    })
    .await?;
    let bounds = geometry.bounds;
    if exact {
        Ok(format!(
            "Resized window to {width}x{height} via X11/EWMH (wmctrl)."
        ))
    } else {
        Ok(format!(
            "Requested resize to {width}x{height} via X11/EWMH; the window manager reported {}x{}.",
            bounds.width, bounds.height
        ))
    }
}

/// Client-area bounds plus the frame origin derived from `_NET_FRAME_EXTENTS`.
#[derive(Debug, Clone)]
struct X11Geometry {
    bounds: WindowBounds,
    frame_origin: Option<(i32, i32)>,
}

async fn wait_for_window_geometry(
    window_id: u64,
    matches: impl Fn(&X11Geometry) -> bool,
) -> Result<(X11Geometry, bool)> {
    let mut last_bounds = None;
    for attempt in 0..GEOMETRY_VERIFY_ATTEMPTS {
        if let Some(bounds) = query_window_geometry(window_id).await {
            if matches(&bounds) {
                return Ok((bounds, true));
            }
            last_bounds = Some(bounds);
        }
        if attempt + 1 < GEOMETRY_VERIFY_ATTEMPTS {
            sleep(GEOMETRY_VERIFY_DELAY).await;
        }
    }
    match last_bounds {
        Some(bounds) => Ok((bounds, false)),
        None => {
            bail!("X11/EWMH window 0x{window_id:x} could not be queried after the geometry request")
        }
    }
}

async fn query_window_geometry(window_id: u64) -> Option<X11Geometry> {
    let mut command = wmctrl_async();
    command.args(["-l", "-p", "-G", "-x"]);
    let output = command_runner::output(command, "query X11 window geometry")
        .await
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let window = parse_wmctrl_windows(&String::from_utf8_lossy(&output.stdout), None)
        .into_iter()
        .find(|window| window.window_id == window_id)?;
    let id = x11_window_id(&window);
    let mut bounds = window.bounds?;
    let (client_origin, extents) = with_x11_display(X11_QUERY_TIMEOUT, move |display| {
        let origin = display.client_origins(&[id]).into_iter().next().flatten();
        let extents = display.frame_extents(id).ok().flatten();
        (origin, extents)
    })
    .await
    .unwrap_or((None, None));
    bounds.x = client_origin.map(|(x, _)| x);
    bounds.y = client_origin.map(|(_, y)| y);
    Some(X11Geometry {
        bounds,
        // No _NET_FRAME_EXTENTS means no decorations the WM will tell us about;
        // the frame is then the client area.
        frame_origin: client_origin.map(|origin| frame_origin(origin, extents.unwrap_or_default())),
    })
}

fn frame_at_position(geometry: &X11Geometry, expected: (i32, i32)) -> bool {
    geometry.frame_origin == Some(expected)
}

fn bounds_at_size(bounds: &WindowBounds, width: u32, height: u32) -> bool {
    bounds.width == width && bounds.height == height
}

/// EWMH move/resize only take effect on unmaximized windows, so drop the
/// maximized state first (mirrors the GNOME extension backend behaviour).
async fn unmaximize(window_id: u64) -> Result<()> {
    let id = window_id_arg(window_id);
    run_wmctrl(
        &[
            "-i",
            "-r",
            id.as_str(),
            "-b",
            "remove,maximized_vert,maximized_horz",
        ],
        "unmaximize window",
        window_id,
    )
    .await
}

async fn run_wmctrl(args: &[&str], action: &str, window_id: u64) -> Result<()> {
    let mut command = wmctrl_async();
    command.args(args);
    let output =
        command_runner::output(command, &format!("run wmctrl to {action} 0x{window_id:x}")).await?;
    if !output.status.success() {
        bail!(
            "wmctrl failed to {action} 0x{window_id:x}: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    Ok(())
}

fn window_id_arg(window_id: u64) -> String {
    format!("0x{window_id:08x}")
}

fn wmctrl() -> Command {
    Command::new("wmctrl")
}

fn wmctrl_async() -> TokioCommand {
    TokioCommand::new("wmctrl")
}

async fn active_window_query_async() -> Option<Option<u64>> {
    let mut command = TokioCommand::new("xprop");
    command.args(["-root", "-notype", "_NET_ACTIVE_WINDOW"]);
    let output = command_runner::output(command, "query the active X11 window")
        .await
        .ok()?;
    if !output.status.success() {
        return None;
    }
    parse_active_window_query(&String::from_utf8_lossy(&output.stdout))
}

fn resolve_active_window_query(
    query: Option<Option<u64>>,
    require_focus_query: bool,
) -> Result<Option<u64>> {
    if require_focus_query && query.is_none() {
        bail!("xprop could not query _NET_ACTIVE_WINDOW");
    }
    Ok(query.flatten())
}

fn active_window_query() -> Option<Option<u64>> {
    let mut command = Command::new("xprop");
    command.args(["-root", "-notype", "_NET_ACTIVE_WINDOW"]);
    let output = command_runner::output_blocking_with_timeout(
        &mut command,
        "probe the active X11 window",
        PROBE_TIMEOUT,
    )
    .ok()?;
    if !output.status.success() {
        return None;
    }
    parse_active_window_query(&String::from_utf8_lossy(&output.stdout))
}

fn parse_active_window_query(xprop_output: &str) -> Option<Option<u64>> {
    let after = xprop_output.split("0x").nth(1)?;
    let hex: String = after
        .chars()
        .take_while(|character| character.is_ascii_hexdigit())
        .collect();
    let id = u64::from_str_radix(&hex, 16).ok()?;
    Some((id != 0).then_some(id))
}

/// Parse `wmctrl -l -p -G -x` output into window records.
///
/// Each line is: `id desktop pid x y w h wm_class client_machine title...`,
/// where `title` is the free-form remainder (may contain spaces).
pub(crate) fn parse_wmctrl_windows(list_output: &str, active_id: Option<u64>) -> Vec<WindowInfo> {
    let mut windows: Vec<WindowInfo> = list_output
        .lines()
        .filter_map(|line| parse_wmctrl_line(line, active_id))
        .collect();
    windows.sort_by_key(|window| window.window_id);
    windows
}

fn parse_wmctrl_line(line: &str, active_id: Option<u64>) -> Option<WindowInfo> {
    let mut rest = line;
    let id_field = next_field(&mut rest)?;
    let desktop_field = next_field(&mut rest)?;
    let pid_field = next_field(&mut rest)?;
    let x_field = next_field(&mut rest)?;
    let y_field = next_field(&mut rest)?;
    let width_field = next_field(&mut rest)?;
    let height_field = next_field(&mut rest)?;
    let class_field = next_field(&mut rest)?;
    let _client_machine = next_field(&mut rest);
    let title = rest.trim();

    let window_id = u64::from_str_radix(id_field.trim_start_matches("0x"), 16).ok()?;
    let desktop = desktop_field.parse::<i32>().ok()?;
    let pid = pid_field.parse::<u32>().ok().filter(|pid| *pid != 0);
    let x = x_field.parse::<i32>().ok()?;
    let y = y_field.parse::<i32>().ok()?;
    let width = width_field.parse::<u32>().ok()?;
    let height = height_field.parse::<u32>().ok()?;

    let (app_id, wm_class) = split_wm_class(class_field);

    Some(WindowInfo {
        window_id,
        title: clean(title),
        app_id,
        wm_class,
        pid,
        bounds: Some(WindowBounds {
            x: Some(x),
            y: Some(y),
            width,
            height,
        }),
        workspace: (desktop >= 0).then_some(desktop),
        focused: active_id == Some(window_id),
        hidden: false,
        client_type: Some("x11".to_string()),
        backend: X11_BACKEND.to_string(),
        terminal: None,
    })
}

/// `wmctrl -x` prints `WM_CLASS` as `instance.Class`. Map `instance` to
/// `app_id` and `Class` to `wm_class`, mirroring the i3 backend.
fn split_wm_class(value: &str) -> (Option<String>, Option<String>) {
    match value.split_once('.') {
        Some((instance, class)) => (clean(instance), clean(class)),
        None => (clean(value), clean(value)),
    }
}

/// Consume the next whitespace-delimited field, advancing `rest` past it.
fn next_field<'a>(rest: &mut &'a str) -> Option<&'a str> {
    *rest = rest.trim_start();
    if rest.is_empty() {
        return None;
    }
    let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
    let (field, tail) = rest.split_at(end);
    *rest = tail;
    Some(field)
}

fn clean(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty() && !value.eq_ignore_ascii_case("N/A")).then(|| value.to_string())
}

/// True if `cmd` is an executable found on `$PATH`. Used to gate focus
/// capabilities on `xprop` without spawning it (xprop with no args would block
/// reading a window interactively).
pub(crate) fn command_on_path(cmd: &str) -> bool {
    env::var_os("PATH").is_some_and(|paths| {
        env::split_paths(&paths).any(|dir| {
            dir.join(cmd).metadata().is_ok_and(|metadata| {
                metadata.is_file() && metadata.permissions().mode() & 0o111 != 0
            })
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_active_window_id_from_xprop() {
        assert_eq!(
            parse_active_window_query("_NET_ACTIVE_WINDOW: window id # 0x7000004\n"),
            Some(Some(0x7000004))
        );
        assert_eq!(
            parse_active_window_query("_NET_ACTIVE_WINDOW(WINDOW): window id # 0x03a00017\n"),
            Some(Some(0x03a00017))
        );
        assert_eq!(
            parse_active_window_query("_NET_ACTIVE_WINDOW: window id # 0x0\n"),
            Some(None)
        );
        assert_eq!(
            parse_active_window_query("_NET_ACTIVE_WINDOW:  not found.\n"),
            None
        );
    }

    #[test]
    fn exact_focus_listing_requires_a_live_active_window_query() {
        assert!(resolve_active_window_query(None, true).is_err());
        assert_eq!(resolve_active_window_query(Some(None), true).unwrap(), None);
        assert_eq!(
            resolve_active_window_query(Some(Some(0x7000004)), true).unwrap(),
            Some(0x7000004)
        );
        assert_eq!(resolve_active_window_query(None, false).unwrap(), None);
    }

    #[test]
    fn parses_wmctrl_windows_as_window_info() {
        // Real `wmctrl -l -p -G -x` lines: id desktop pid x y w h class host title.
        let output = "\
0x03000003  0 3843   0    0    5120 1400 nemo-desktop.Nemo-desktop  rog nemo-desktop
0x03a00017  2 4564   -40  -40  2600 1440 Navigator.firefox     rog Nouvel onglet — Mozilla Firefox
0x05c00007  0 26606  0    72   2560 1368 terminator.Terminator  rog jo@rog: ~
0x07000004 -1 0      10   10   400  300  claude-desktop.claude-desktop  rog Claude
";
        let windows = parse_wmctrl_windows(output, Some(0x07000004));

        assert_eq!(windows.len(), 4);

        let firefox = windows
            .iter()
            .find(|window| window.window_id == 0x03a00017)
            .unwrap();
        assert_eq!(firefox.app_id.as_deref(), Some("Navigator"));
        assert_eq!(firefox.wm_class.as_deref(), Some("firefox"));
        assert_eq!(firefox.pid, Some(4564));
        assert_eq!(
            firefox.title.as_deref(),
            Some("Nouvel onglet — Mozilla Firefox")
        );
        assert_eq!(firefox.workspace, Some(2));
        let bounds = firefox.bounds.as_ref().unwrap();
        assert_eq!(
            (bounds.x, bounds.y, bounds.width, bounds.height),
            (Some(-40), Some(-40), 2600, 1440)
        );
        assert_eq!(firefox.client_type.as_deref(), Some("x11"));
        assert_eq!(firefox.backend, X11_BACKEND);
        assert!(!firefox.focused);

        // Active window is flagged; sticky desktop (-1) has no workspace; pid 0 -> None.
        let claude = windows
            .iter()
            .find(|window| window.window_id == 0x07000004)
            .unwrap();
        assert!(claude.focused);
        assert_eq!(claude.workspace, None);
        assert_eq!(claude.pid, None);
    }

    #[test]
    fn move_coord_avoids_wmctrl_preserve_sentinel() {
        assert_eq!(wmctrl_move_coord(-1), -2);
        assert_eq!(wmctrl_move_coord(0), 0);
        assert_eq!(wmctrl_move_coord(-40), -40);
        assert_eq!(wmctrl_move_coord(1920), 1920);
    }

    #[test]
    fn geometry_matchers_require_the_requested_values() {
        let bounds = WindowBounds {
            x: Some(10),
            y: Some(20),
            width: 800,
            height: 600,
        };
        assert!(bounds_at_size(&bounds, 800, 600));
        assert!(!bounds_at_size(&bounds, 801, 600));

        let geometry = X11Geometry {
            bounds,
            frame_origin: Some((9, -2)),
        };
        assert!(frame_at_position(&geometry, (9, -2)));
        assert!(
            !frame_at_position(&geometry, (10, 20)),
            "the client origin is not the requested frame position"
        );
        let unknown = X11Geometry {
            frame_origin: None,
            ..geometry
        };
        assert!(!frame_at_position(&unknown, (9, -2)));
    }

    #[test]
    fn client_origins_replace_wmctrl_positions_and_unknown_clears_them() {
        // wmctrl -lG under MATE/marco (issue #157): x,y = absolute + relative.
        let output = "0x05600003  0 4242   24   280  640  480  gtk3.Gtk3 host GTK3 test window\n\
0x05800004  0 4243   1892 328  400  500  mate-calculator.Mate-calculator host Calculator\n";
        let mut windows = parse_wmctrl_windows(output, None);
        apply_client_origins(&mut windows, &[Some((2, 192)), None]);

        let gtk = windows[0].bounds.as_ref().unwrap();
        assert_eq!(
            (gtk.x, gtk.y, gtk.width, gtk.height),
            (Some(2), Some(192), 640, 480)
        );
        let calculator = windows[1].bounds.as_ref().unwrap();
        assert_eq!(
            (calculator.x, calculator.y, calculator.width),
            (None, None, 400),
            "a window the X server could not locate must not keep wmctrl's shifted origin"
        );
    }

    #[test]
    fn clean_drops_na_case_insensitively_and_blanks() {
        assert_eq!(clean("N/A"), None);
        assert_eq!(clean("n/a"), None);
        assert_eq!(clean("   "), None);
        assert_eq!(clean(" Firefox "), Some("Firefox".to_string()));
    }

    #[test]
    fn parses_title_with_multiple_spaces_and_empty_title() {
        let output = "0x00000001  0 100 0 0 800 600 term.Term  rog\n";
        let windows = parse_wmctrl_windows(output, None);
        assert_eq!(windows.len(), 1);
        assert_eq!(windows[0].title, None);
        assert_eq!(windows[0].wm_class.as_deref(), Some("Term"));
    }
}
