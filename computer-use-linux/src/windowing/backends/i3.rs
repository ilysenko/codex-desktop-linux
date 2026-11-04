use crate::command_runner;
use crate::terminal::enrich_terminal_windows;
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
                    "i3-msg get_tree returned a JSON tree".to_string()
                } else {
                    "i3-msg get_tree did not return a JSON object".to_string()
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
    let mut command = i3_msg_command_async();
    command.args(["-t", "get_tree"]);
    let output = command_runner::output(command, "run i3-msg -t get_tree").await?;
    if !output.status.success() {
        bail!(
            "i3-msg -t get_tree failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }

    let mut windows = parse_i3_tree(&String::from_utf8_lossy(&output.stdout))?;
    hydrate_i3_window_pids(&mut windows).await;
    enrich_terminal_windows(&mut windows);
    Ok(windows)
}

/// Window ids are X11 ids where the window has one (every i3 window, Xwayland
/// on Sway) and `SWAY_CONTAINER_ID_BASE` plus the Sway container id for native
/// Wayland windows. X11 ids rise
/// with each new window of a client, which terminal pairing relies on; i3
/// container ids are heap addresses that are reused after a window closes.
pub(crate) fn parse_i3_tree(json: &str) -> Result<Vec<WindowInfo>> {
    let root: I3Node =
        serde_json::from_str(json).context("failed to parse i3-msg get_tree output")?;
    let mut windows = Vec::new();
    collect_i3_windows(&root, None, false, false, &mut windows);
    windows.sort_by_key(|window| window.window_id);
    Ok(windows)
}

pub async fn activate_window(window_id: u64) -> Result<()> {
    let selector = i3_focus_command(window_id);
    let mut command = i3_msg_command_async();
    command.arg(&selector);
    let output = command_runner::output(command, &format!("run i3-msg {selector}")).await?;
    if !output.status.success() {
        bail!(
            "i3-msg {selector} failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }

    let replies: Vec<I3CommandReply> =
        serde_json::from_slice(&output.stdout).context("failed to parse i3-msg focus reply")?;
    if replies.iter().all(|reply| reply.success) {
        Ok(())
    } else {
        let details = replies
            .into_iter()
            .filter_map(|reply| reply.error)
            .collect::<Vec<_>>()
            .join("; ");
        bail!(
            "i3-msg {selector} did not focus the window: {}",
            if details.is_empty() {
                "unknown i3 failure"
            } else {
                details.as_str()
            }
        );
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

fn i3_msg_command() -> Command {
    let mut command = Command::new("i3-msg");
    if let Some(socket_path) = i3_socket_path() {
        command.arg("-s").arg(socket_path);
    }
    command
}

fn i3_msg_command_async() -> TokioCommand {
    let mut command = TokioCommand::new("i3-msg");
    if let Some(socket_path) = i3_socket_path() {
        command.arg("-s").arg(socket_path);
    }
    command
}

fn i3_socket_path() -> Option<PathBuf> {
    if let Some(value) = env_var("I3SOCK") {
        return Some(PathBuf::from(value));
    }

    let socket_dir = xdg_runtime_dir()?.join("i3");
    let mut sockets = fs::read_dir(socket_dir)
        .ok()?
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let file_name = entry.file_name();
            let file_name = file_name.to_str()?;
            if !file_name.starts_with("ipc-socket.") {
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
