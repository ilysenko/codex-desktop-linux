use crate::command_runner;
use crate::remote_desktop::{parse_sway_monitor_layout, LogicalMonitor};
use crate::terminal::enrich_terminal_windows;
use crate::windowing::backends::x11::command_on_path;
use crate::windowing::registry::BackendProbe;
use crate::windowing::types::{WindowBounds, WindowInfo, MAX_WINDOW_ID};
use anyhow::{bail, Context, Result};
use serde::Deserialize;
use std::{env, fs, os::unix::fs::FileTypeExt, path::PathBuf, process::Command};
use tokio::process::Command as TokioCommand;

pub const I3_BACKEND: &str = "i3";

/// Native Wayland windows on Sway are listed as this base plus their container
/// id. X11 ids fit in 32 bits, so the two kinds never share a `window_id`,
/// although Sway container ids and X11 ids count independently.
pub(crate) const SWAY_CONTAINER_ID_BASE: u64 = 1 << 32;

pub fn probe() -> BackendProbe {
    let program = ipc_program();
    match i3_msg_command().args(["-t", "get_tree"]).output() {
        Ok(output) if output.status.success() => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let ok = matches!(
                serde_json::from_str::<serde_json::Value>(&stdout),
                Ok(serde_json::Value::Object(_))
            );
            BackendProbe {
                id: I3_BACKEND,
                ok,
                can_list_windows: ok,
                can_focus_apps: ok,
                can_focus_windows: ok,
                detail: if ok {
                    format!("{program} get_tree returned a JSON tree")
                } else {
                    format!("{program} get_tree did not return a JSON object")
                },
            }
        }
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            BackendProbe {
                id: I3_BACKEND,
                ok: false,
                can_list_windows: false,
                can_focus_apps: false,
                can_focus_windows: false,
                detail: if stderr.is_empty() { stdout } else { stderr },
            }
        }
        Err(error) => BackendProbe {
            id: I3_BACKEND,
            ok: false,
            can_list_windows: false,
            can_focus_apps: false,
            can_focus_windows: false,
            detail: error.to_string(),
        },
    }
}

pub async fn list_windows() -> Result<Vec<WindowInfo>> {
    let program = ipc_program();
    let mut command = i3_msg_command_async();
    command.args(["-t", "get_tree"]);
    let output = command_runner::output(command, &format!("run {program} -t get_tree")).await?;
    if !output.status.success() {
        bail!(
            "{program} -t get_tree failed: {}",
            command_failure_text(&output)
        );
    }

    let root = parse_i3_root(&String::from_utf8_lossy(&output.stdout))?;
    let sway_outputs = if root.is_sway() {
        sway_outputs().await
    } else {
        None
    };
    let mut windows = windows_from_root(&root, sway_outputs.as_deref());
    hydrate_i3_window_pids(&mut windows).await;
    enrich_terminal_windows(&mut windows);
    Ok(windows)
}

/// Sway's active outputs, in the layout (logical) coordinates its tree uses.
async fn sway_outputs() -> Option<Vec<LogicalMonitor>> {
    let mut command = i3_msg_command_async();
    command.args(["-t", "get_outputs"]);
    let output = command_runner::output(command, "query Sway outputs")
        .await
        .ok()?;
    if !output.status.success() {
        return None;
    }
    parse_sway_monitor_layout(&output.stdout)
}

/// Maps Sway's layout coordinates to capture pixels when every active output
/// has the same scale. When the active outputs differ in scale, or one has an
/// unusable scale, no mapping is built: window bounds are left out, so window
/// crops and window-relative clicks are refused.
#[derive(Debug, Clone, Copy)]
struct SwayCaptureLayout {
    origin_x: i32,
    origin_y: i32,
    scale: f64,
}

impl SwayCaptureLayout {
    fn from_outputs(outputs: &[LogicalMonitor]) -> Option<Self> {
        let first = outputs.first()?;
        if outputs.iter().any(|output| {
            !output.scale.is_finite() || output.scale <= 0.0 || output.scale != first.scale
        }) {
            return None;
        }
        Some(Self {
            origin_x: outputs.iter().map(|output| output.x).min()?,
            origin_y: outputs.iter().map(|output| output.y).min()?,
            // Screenshots on Sway come from grim (directly or through
            // xdg-desktop-portal-wlr), which never captures below scale 1.
            scale: first.scale.max(1.0),
        })
    }

    /// Edges round outward, so a fractional scale never crops a window's
    /// last pixel row or column.
    fn map(&self, bounds: &WindowBounds) -> Option<WindowBounds> {
        let edges = |start: Option<i32>, length: u32, origin: i32| -> Option<(Option<i32>, u32)> {
            let offset = f64::from(start.unwrap_or(origin)) - f64::from(origin);
            let near = (offset * self.scale).floor();
            let far = ((offset + f64::from(length)) * self.scale).ceil();
            let size = far - near;
            if !near.is_finite()
                || near < f64::from(i32::MIN)
                || near > f64::from(i32::MAX)
                || !(1.0..=f64::from(u32::MAX)).contains(&size)
            {
                return None;
            }
            Some((start.map(|_| near as i32), size as u32))
        };
        let (x, width) = edges(bounds.x, bounds.width, self.origin_x)?;
        let (y, height) = edges(bounds.y, bounds.height, self.origin_y)?;
        Some(WindowBounds {
            x,
            y,
            width,
            height,
        })
    }
}

/// Parse a `get_tree` reply into windows; see `windows_from_root`.
#[cfg(test)]
pub(crate) fn parse_i3_tree(
    json: &str,
    sway_outputs: Option<&[LogicalMonitor]>,
) -> Result<Vec<WindowInfo>> {
    Ok(windows_from_root(&parse_i3_root(json)?, sway_outputs))
}

fn parse_i3_root(json: &str) -> Result<I3Node> {
    serde_json::from_str(json).context("failed to parse the i3 IPC get_tree reply")
}

/// Window ids are X11 ids where the window has one (every i3 window, Xwayland
/// on Sway) and `SWAY_CONTAINER_ID_BASE` plus the Sway container id for native
/// Wayland windows. X11 ids rise with each new window of a client, which
/// terminal pairing relies on; i3 container ids are heap addresses that are
/// reused after a window closes.
///
/// i3 bounds are X11 pixels and pass through. Sway bounds are layout
/// coordinates: they are scaled to capture pixels with `sway_outputs`, and left
/// out when the outputs are unknown or mixed in scale.
fn windows_from_root(root: &I3Node, sway_outputs: Option<&[LogicalMonitor]>) -> Vec<WindowInfo> {
    let mut windows = Vec::new();
    collect_i3_windows(root, None, false, false, &mut windows);
    if root.is_sway() {
        let layout = sway_outputs.and_then(SwayCaptureLayout::from_outputs);
        for window in &mut windows {
            window.bounds = match (layout, window.bounds.as_ref()) {
                (Some(layout), Some(bounds)) => layout.map(bounds),
                _ => None,
            };
        }
    }
    windows.sort_by_key(|window| window.window_id);
    windows
}

pub async fn activate_window(window_id: u64) -> Result<()> {
    let program = ipc_program();
    let selector = i3_focus_command(window_id);
    let mut command = i3_msg_command_async();
    command.arg(&selector);
    let output = command_runner::output(command, &format!("run {program} {selector}")).await?;
    // swaymsg prints a failed command's reply on stdout only and exits 2, so
    // the reply is read before the exit status.
    match serde_json::from_slice::<Vec<I3CommandReply>>(&output.stdout) {
        Ok(replies) if replies.iter().all(|reply| reply.success) && output.status.success() => {
            Ok(())
        }
        Ok(replies) => {
            let details = replies
                .into_iter()
                .filter_map(|reply| reply.error)
                .collect::<Vec<_>>()
                .join("; ");
            bail!(
                "{program} {selector} did not focus the window: {}",
                if details.is_empty() {
                    "unknown i3 failure"
                } else {
                    details.as_str()
                }
            )
        }
        Err(_) if !output.status.success() => {
            bail!(
                "{program} {selector} failed: {}",
                command_failure_text(&output)
            )
        }
        Err(error) => Err(error).context("failed to parse the i3 IPC focus reply"),
    }
}

/// stderr, or stdout when stderr is empty (swaymsg reports errors there).
fn command_failure_text(output: &std::process::Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if stderr.is_empty() {
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    } else {
        stderr
    }
}

/// Sway parses criteria ids as decimal numbers and rejects hex; i3 accepts
/// both. A native Wayland window on Sway has no X11 id, so it is focused by
/// its container id.
pub(crate) fn i3_focus_command(window_id: u64) -> String {
    match window_id.checked_sub(SWAY_CONTAINER_ID_BASE) {
        Some(con_id) => format!(r#"[con_id="{con_id}"] focus"#),
        None => format!(r#"[id="{window_id}"] focus"#),
    }
}

fn collect_i3_windows(
    node: &I3Node,
    workspace: Option<i32>,
    in_dockarea: bool,
    in_scratchpad: bool,
    windows: &mut Vec<WindowInfo>,
) {
    let node_type = node.node_type.as_deref();
    let is_workspace = node_type == Some("workspace");
    let current_workspace = if is_workspace { node.num } else { workspace };
    let current_in_dockarea = in_dockarea || node_type == Some("dockarea");
    // i3 and Sway keep scratchpad windows that are not shown under this
    // workspace. `scratchpad_state` does not say whether a window is shown:
    // Sway keeps it `fresh` on a shown window, and i3 reports `none` on the
    // window node itself.
    let current_in_scratchpad =
        in_scratchpad || (is_workspace && node.name.as_deref() == Some("__i3_scratch"));

    if let Some(window) = node.to_window_info(
        current_workspace,
        current_in_dockarea,
        current_in_scratchpad,
    ) {
        windows.push(window);
    }

    for child in node.nodes.iter().chain(&node.floating_nodes) {
        collect_i3_windows(
            child,
            current_workspace,
            current_in_dockarea,
            current_in_scratchpad,
            windows,
        );
    }
}

/// X11 windows whose tree entry has no pid: every i3 window, and an Xwayland
/// window on Sway that reported pid 0. Their `window_id` is the X11 id.
pub(crate) fn windows_needing_xprop_pid(windows: &[WindowInfo]) -> Vec<usize> {
    windows
        .iter()
        .enumerate()
        .filter(|(_, window)| window.pid.is_none() && window.client_type.as_deref() == Some("x11"))
        .map(|(index, _)| index)
        .collect()
}

async fn hydrate_i3_window_pids(windows: &mut [WindowInfo]) {
    for index in windows_needing_xprop_pid(windows) {
        windows[index].pid = i3_window_pid(windows[index].window_id).await;
    }
}

async fn i3_window_pid(window_id: u64) -> Option<u32> {
    let mut command = TokioCommand::new("xprop");
    command.args(["-id", &window_id.to_string(), "_NET_WM_PID"]);
    let output = command_runner::output(command, "query X11 window pid")
        .await
        .ok()?;
    if !output.status.success() {
        return None;
    }
    parse_xprop_pid(&String::from_utf8_lossy(&output.stdout))
}

pub(crate) fn parse_xprop_pid(output: &str) -> Option<u32> {
    output.split('=').nth(1)?.trim().parse::<u32>().ok()
}

/// `i3-msg`, or Sway's `swaymsg` when i3 is not installed. Both take the same
/// `-s`, `-t get_tree`, `-t get_outputs` and criteria commands.
fn ipc_program() -> &'static str {
    ipc_program_from(command_on_path("i3-msg"), command_on_path("swaymsg"))
}

pub(crate) fn ipc_program_from(has_i3_msg: bool, has_swaymsg: bool) -> &'static str {
    if !has_i3_msg && has_swaymsg {
        "swaymsg"
    } else {
        "i3-msg"
    }
}

fn i3_msg_command() -> Command {
    let mut command = Command::new(ipc_program());
    if let Some(socket_path) = i3_socket_path() {
        command.arg("-s").arg(socket_path);
    }
    command
}

fn i3_msg_command_async() -> TokioCommand {
    let mut command = TokioCommand::new(ipc_program());
    if let Some(socket_path) = i3_socket_path() {
        command.arg("-s").arg(socket_path);
    }
    command
}

/// The first of `I3SOCK` and `SWAYSOCK` that names a socket file, then the
/// newest i3 socket (`i3/ipc-socket.*`), then the newest Sway socket
/// (`sway-ipc.*.sock`) in the runtime dir. A set variable that names no
/// socket is still used when nothing else is found, so the error names it.
fn i3_socket_path() -> Option<PathBuf> {
    let env_sockets = [env_var("I3SOCK"), env_var("SWAYSOCK")];
    choose_socket(&env_sockets, is_socket, || {
        let runtime_dir = xdg_runtime_dir()?;
        newest_socket(&runtime_dir.join("i3"), |name| {
            name.starts_with("ipc-socket.")
        })
        .or_else(|| {
            newest_socket(&runtime_dir, |name| {
                name.starts_with("sway-ipc.") && name.ends_with(".sock")
            })
        })
    })
}

pub(crate) fn choose_socket(
    env_sockets: &[Option<String>],
    is_socket: impl Fn(&std::path::Path) -> bool,
    runtime_dir_socket: impl FnOnce() -> Option<PathBuf>,
) -> Option<PathBuf> {
    let set = env_sockets.iter().flatten().map(PathBuf::from);
    set.clone()
        .find(|path| is_socket(path))
        .or_else(runtime_dir_socket)
        .or_else(|| set.clone().next())
}

fn is_socket(path: &std::path::Path) -> bool {
    fs::metadata(path).is_ok_and(|metadata| metadata.file_type().is_socket())
}

fn newest_socket(dir: &std::path::Path, matches: impl Fn(&str) -> bool) -> Option<PathBuf> {
    let mut sockets = fs::read_dir(dir)
        .ok()?
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let file_name = entry.file_name();
            if !matches(file_name.to_str()?) {
                return None;
            }
            let metadata = entry.metadata().ok()?;
            if !metadata.file_type().is_socket() {
                return None;
            }
            let modified = metadata.modified().ok();
            Some((modified, entry.path()))
        })
        .collect::<Vec<_>>();
    sockets.sort_by_key(|(modified, _)| std::cmp::Reverse(*modified));
    sockets.into_iter().map(|(_, path)| path).next()
}

fn xdg_runtime_dir() -> Option<PathBuf> {
    env_var("XDG_RUNTIME_DIR").map(PathBuf::from)
}

fn env_var(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn clean_string(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "null")
        .map(ToOwned::to_owned)
}

#[derive(Debug, Deserialize)]
struct I3CommandReply {
    success: bool,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct I3Node {
    /// Container id. Every node has one on i3 and on Sway.
    id: Option<u64>,
    #[serde(rename = "type")]
    node_type: Option<String>,
    name: Option<String>,
    /// X11 window id; null for native Wayland windows and for containers.
    window: Option<u64>,
    /// Sway only: set on every window, `xdg_shell` or `xwayland`.
    shell: Option<String>,
    /// Sway only: the Wayland app id; null for Xwayland windows.
    app_id: Option<String>,
    /// Sway only: the client pid. i3 reports none.
    pid: Option<i64>,
    window_type: Option<String>,
    window_properties: Option<I3WindowProperties>,
    rect: Option<I3Rect>,
    geometry: Option<I3Rect>,
    #[serde(default)]
    focused: bool,
    #[serde(default)]
    nodes: Vec<I3Node>,
    #[serde(default)]
    floating_nodes: Vec<I3Node>,
    num: Option<i32>,
}

#[derive(Debug, Deserialize)]
struct I3WindowProperties {
    class: Option<String>,
    instance: Option<String>,
    title: Option<String>,
}

#[derive(Debug, Deserialize)]
struct I3Rect {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

impl I3Node {
    /// Sway marks every window with a `shell`; i3 never emits the field.
    fn is_sway(&self) -> bool {
        self.shell.is_some()
            || self
                .nodes
                .iter()
                .chain(&self.floating_nodes)
                .any(I3Node::is_sway)
    }

    fn to_window_info(
        &self,
        workspace: Option<i32>,
        in_dockarea: bool,
        in_scratchpad: bool,
    ) -> Option<WindowInfo> {
        if in_dockarea {
            return None;
        }
        // An X11 window has its X11 id (i3, Xwayland on Sway). A native
        // Wayland window on Sway has a shell and no X11 id, so it is named by
        // its container id above SWAY_CONTAINER_ID_BASE. Split, tabbed and
        // stacked containers have neither.
        let wayland = self.window.is_none()
            && self
                .shell
                .as_deref()
                .is_some_and(|shell| shell != "xwayland");
        let window_id = if wayland {
            SWAY_CONTAINER_ID_BASE
                .checked_add(self.id?)
                .filter(|id| *id <= MAX_WINDOW_ID)?
        } else {
            self.window.filter(|id| *id < SWAY_CONTAINER_ID_BASE)?
        };
        if self.window_type.as_deref() == Some("dock") {
            return None;
        }

        let properties = self.window_properties.as_ref();
        let title = clean_string(
            properties
                .and_then(|properties| properties.title.as_deref())
                .or(self.name.as_deref()),
        );
        let wm_class = clean_string(
            properties
                .and_then(|properties| properties.class.as_deref())
                .or_else(|| properties.and_then(|properties| properties.instance.as_deref())),
        );
        let app_id = clean_string(self.app_id.as_deref()).or_else(|| {
            clean_string(
                properties
                    .and_then(|properties| properties.instance.as_deref())
                    .or(wm_class.as_deref()),
            )
        });
        let rect = self.rect.as_ref().or(self.geometry.as_ref());
        let bounds = rect.map(|rect| WindowBounds {
            x: Some(rect.x),
            y: Some(rect.y),
            width: rect.width,
            height: rect.height,
        });

        Some(WindowInfo {
            window_id,
            title,
            app_id,
            wm_class,
            pid: self
                .pid
                .filter(|pid| *pid > 0)
                .and_then(|pid| u32::try_from(pid).ok()),
            bounds,
            workspace,
            focused: self.focused,
            hidden: in_scratchpad,
            client_type: Some(if wayland { "wayland" } else { "x11" }.to_string()),
            backend: I3_BACKEND.to_string(),
            terminal: None,
        })
    }
}
