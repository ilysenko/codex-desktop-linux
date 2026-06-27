use crate::terminal::enrich_terminal_windows;
use crate::windowing::registry::BackendProbe;
use crate::windowing::types::{WindowBounds, WindowInfo};
use anyhow::{bail, Context, Result};
use serde::Deserialize;
use std::process::Command;

pub const NIRI_BACKEND: &str = "niri";

pub fn probe() -> BackendProbe {
    match niri_msg_output(&["msg", "--json", "windows"]) {
        Ok(output) if output.status.success() => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let ok = matches!(
                serde_json::from_str::<serde_json::Value>(&stdout),
                Ok(serde_json::Value::Array(_))
            );
            BackendProbe {
                id: NIRI_BACKEND,
                ok,
                can_list_windows: ok,
                can_focus_apps: ok,
                can_focus_windows: ok,
                detail: if ok {
                    "niri msg --json windows returned a JSON array".to_string()
                } else {
                    "niri msg --json windows did not return a JSON array".to_string()
                },
            }
        }
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            BackendProbe {
                id: NIRI_BACKEND,
                ok: false,
                can_list_windows: false,
                can_focus_apps: false,
                can_focus_windows: false,
                detail: if stderr.is_empty() { stdout } else { stderr },
            }
        }
        Err(error) => BackendProbe {
            id: NIRI_BACKEND,
            ok: false,
            can_list_windows: false,
            can_focus_apps: false,
            can_focus_windows: false,
            detail: error.to_string(),
        },
    }
}

pub fn list_windows() -> Result<Vec<WindowInfo>> {
    let output = niri_msg_output(&["msg", "--json", "windows"])
        .context("failed to run niri msg --json windows")?;
    if !output.status.success() {
        bail!(
            "niri msg --json windows failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }

    let mut windows = parse_niri_windows(&String::from_utf8_lossy(&output.stdout))?;
    enrich_terminal_windows(&mut windows);
    Ok(windows)
}

pub(crate) fn parse_niri_windows(json: &str) -> Result<Vec<WindowInfo>> {
    let niri_windows: Vec<NiriWindow> =
        serde_json::from_str(json).context("failed to parse niri msg --json windows output")?;

    let mut windows = niri_windows
        .into_iter()
        .map(WindowInfo::from)
        .collect::<Vec<_>>();
    windows.sort_by_key(|window| window.window_id);
    Ok(windows)
}

pub fn activate_window(window_id: u64) -> Result<()> {
    let window_id = window_id.to_string();
    let output = niri_msg_output(&["msg", "action", "focus-window", "--id", &window_id])
        .with_context(|| format!("failed to run niri msg action focus-window --id {window_id}"))?;
    if output.status.success() {
        Ok(())
    } else {
        bail!(
            "niri msg action focus-window --id {window_id} failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
}

fn niri_msg_output(args: &[&str]) -> std::io::Result<std::process::Output> {
    Command::new("niri").args(args).output()
}

#[derive(Debug, Deserialize)]
struct NiriWindow {
    id: u64,
    title: Option<String>,
    app_id: Option<String>,
    pid: Option<i64>,
    workspace_id: Option<i32>,
    is_focused: Option<bool>,
    layout: Option<NiriWindowLayout>,
}

#[derive(Debug, Deserialize)]
struct NiriWindowLayout {
    pos_in_scrolling_layout: Option<[f64; 2]>,
    window_size: Option<[u32; 2]>,
}

impl From<NiriWindow> for WindowInfo {
    fn from(window: NiriWindow) -> Self {
        let bounds = window.layout.as_ref().and_then(|layout| {
            let [width, height] = layout.window_size?;
            let (x, y) = layout
                .pos_in_scrolling_layout
                .map(|[x, y]| (finite_rounded_i32(x), finite_rounded_i32(y)))
                .unwrap_or((None, None));

            Some(WindowBounds {
                x,
                y,
                width,
                height,
            })
        });

        WindowInfo {
            window_id: window.id,
            title: window.title,
            app_id: window.app_id.clone(),
            wm_class: window.app_id,
            pid: window.pid.and_then(|pid| u32::try_from(pid).ok()),
            bounds,
            workspace: window.workspace_id,
            focused: window.is_focused.unwrap_or(false),
            hidden: false,
            client_type: Some("wayland".to_string()),
            backend: NIRI_BACKEND.to_string(),
            terminal: None,
        }
    }
}

fn finite_rounded_i32(value: f64) -> Option<i32> {
    if value.is_finite() && value >= i32::MIN as f64 && value <= i32::MAX as f64 {
        Some(value.round() as i32)
    } else {
        None
    }
}
