use crate::terminal::enrich_terminal_windows;
use crate::windowing::registry::BackendProbe;
use crate::windowing::types::{WindowBounds, WindowInfo};
use anyhow::{bail, Context, Result};
use serde::Deserialize;
use std::process::Command;

pub const SWAY_BACKEND: &str = "sway";

pub fn probe() -> BackendProbe {
    match swaymsg_command().args(["-t", "get_tree"]).output() {
        Ok(output) if output.status.success() => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let ok = matches!(
                serde_json::from_str::<serde_json::Value>(&stdout),
                Ok(serde_json::Value::Object(_))
            );
            BackendProbe {
                id: SWAY_BACKEND,
                ok,
                can_list_windows: ok,
                can_focus_apps: ok,
                can_focus_windows: ok,
                detail: if ok {
                    "swaymsg get_tree returned a JSON tree".to_string()
                } else {
                    "swaymsg get_tree did not return a JSON object".to_string()
                },
            }
        }
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            BackendProbe {
                id: SWAY_BACKEND,
                ok: false,
                can_list_windows: false,
                can_focus_apps: false,
                can_focus_windows: false,
                detail: if stderr.is_empty() { stdout } else { stderr },
            }
        }
        Err(error) => BackendProbe {
            id: SWAY_BACKEND,
            ok: false,
            can_list_windows: false,
            can_focus_apps: false,
            can_focus_windows: false,
            detail: error.to_string(),
        },
    }
}

pub fn list_windows() -> Result<Vec<WindowInfo>> {
    let output = swaymsg_command()
        .args(["-t", "get_tree"])
        .output()
        .context("failed to run swaymsg -t get_tree")?;
    if !output.status.success() {
        bail!(
            "swaymsg -t get_tree failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }

    let mut windows = parse_sway_tree(&String::from_utf8_lossy(&output.stdout))?;
    enrich_terminal_windows(&mut windows);
    Ok(windows)
}

pub(crate) fn parse_sway_tree(json: &str) -> Result<Vec<WindowInfo>> {
    let root: SwayNode =
        serde_json::from_str(json).context("failed to parse swaymsg get_tree output")?;
    let mut windows = Vec::new();
    collect_sway_windows(&root, None, false, &mut windows);
    windows.sort_by_key(|window| window.window_id);
    Ok(windows)
}

pub fn activate_window(window_id: u64) -> Result<()> {
    let selector = sway_focus_selector(window_id);
    let output = swaymsg_command()
        .arg(&selector)
        .output()
        .with_context(|| format!("failed to run swaymsg {selector}"))?;
    if !output.status.success() {
        bail!(
            "swaymsg {selector} failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }

    let replies: Vec<SwayCommandReply> =
        serde_json::from_slice(&output.stdout).context("failed to parse swaymsg focus reply")?;
    if replies.iter().all(|reply| reply.success) {
        Ok(())
    } else {
        let details = replies
            .into_iter()
            .filter_map(|reply| reply.error)
            .collect::<Vec<_>>()
            .join("; ");
        bail!(
            "swaymsg {selector} did not focus the window: {}",
            if details.is_empty() {
                "unknown Sway failure"
            } else {
                details.as_str()
            }
        );
    }
}

fn collect_sway_windows(
    node: &SwayNode,
    workspace: Option<i32>,
    in_dockarea: bool,
    windows: &mut Vec<WindowInfo>,
) {
    let node_type = node.node_type.as_deref();
    let current_workspace = if node_type == Some("workspace") {
        node.num
    } else {
        workspace
    };
    let current_in_dockarea = in_dockarea || node_type == Some("dockarea");

    if let Some(window) = node.to_window_info(current_workspace, current_in_dockarea) {
        windows.push(window);
    }

    for child in &node.nodes {
        collect_sway_windows(child, current_workspace, current_in_dockarea, windows);
    }
    for child in &node.floating_nodes {
        collect_sway_windows(child, current_workspace, current_in_dockarea, windows);
    }
}

fn swaymsg_command() -> Command {
    let mut command = Command::new("swaymsg");
    command.arg("--raw");
    command
}

fn sway_focus_selector(window_id: u64) -> String {
    format!("[con_id={window_id}] focus")
}

fn clean_string(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "null")
        .map(ToOwned::to_owned)
}

fn sway_client_type(shell: Option<&str>, window: Option<u64>) -> Option<String> {
    match shell.map(str::trim).filter(|value| !value.is_empty()) {
        Some("xwayland") => Some("x11".to_string()),
        Some("xdg_shell") => Some("wayland".to_string()),
        Some(value) => Some(value.to_string()),
        None if window.is_some() => Some("x11".to_string()),
        None => None,
    }
}

#[derive(Debug, Deserialize)]
struct SwayCommandReply {
    success: bool,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SwayNode {
    id: Option<u64>,
    #[serde(rename = "type")]
    node_type: Option<String>,
    name: Option<String>,
    app_id: Option<String>,
    pid: Option<u32>,
    shell: Option<String>,
    window: Option<u64>,
    window_type: Option<String>,
    window_properties: Option<SwayWindowProperties>,
    rect: Option<SwayRect>,
    geometry: Option<SwayRect>,
    #[serde(default)]
    focused: bool,
    #[serde(default)]
    nodes: Vec<SwayNode>,
    #[serde(default)]
    floating_nodes: Vec<SwayNode>,
    num: Option<i32>,
    scratchpad_state: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SwayWindowProperties {
    class: Option<String>,
    instance: Option<String>,
    title: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SwayRect {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

impl SwayNode {
    fn to_window_info(&self, workspace: Option<i32>, in_dockarea: bool) -> Option<WindowInfo> {
        if in_dockarea {
            return None;
        }
        if self.window_type.as_deref() == Some("dock") {
            return None;
        }
        if !matches!(self.node_type.as_deref(), Some("con" | "floating_con")) {
            return None;
        }
        if self.app_id.is_none()
            && self.pid.is_none()
            && self.window.is_none()
            && self.window_properties.is_none()
        {
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
        let app_id = clean_string(
            self.app_id
                .as_deref()
                .or_else(|| properties.and_then(|properties| properties.instance.as_deref()))
                .or(wm_class.as_deref()),
        );
        let rect = self.rect.as_ref().or(self.geometry.as_ref());
        let bounds = rect.map(|rect| WindowBounds {
            x: Some(rect.x),
            y: Some(rect.y),
            width: rect.width,
            height: rect.height,
        });

        Some(WindowInfo {
            window_id: self.id?,
            title,
            app_id,
            wm_class,
            pid: self.pid,
            bounds,
            workspace,
            focused: self.focused,
            hidden: self.scratchpad_state.as_deref() == Some("fresh"),
            client_type: sway_client_type(self.shell.as_deref(), self.window),
            backend: SWAY_BACKEND.to_string(),
            terminal: None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn focuses_exact_container_id() {
        assert_eq!(sway_focus_selector(42), "[con_id=42] focus");
    }
}
