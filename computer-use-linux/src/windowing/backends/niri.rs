use crate::terminal::enrich_terminal_windows;
use crate::windowing::registry::BackendProbe;
use crate::windowing::types::{WindowBounds, WindowInfo};
use anyhow::{bail, Context, Result};
use serde::Deserialize;
use std::process::Command;

pub const NIRI_BACKEND: &str = "niri";

pub fn probe() -> BackendProbe {
    match niri_output(&["msg", "-j", "windows"]) {
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
                    "niri msg -j windows returned a JSON array".to_string()
                } else {
                    "niri msg -j windows did not return a JSON array".to_string()
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
    let output =
        niri_output(&["msg", "-j", "windows"]).context("failed to run niri msg -j windows")?;
    if !output.status.success() {
        bail!(
            "niri msg -j windows failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }

    parse_niri_windows(&String::from_utf8_lossy(&output.stdout))
}

pub fn focused_window() -> Result<Option<WindowInfo>> {
    let output = niri_output(&["msg", "-j", "focused-window"])
        .context("failed to run niri msg -j focused-window")?;
    if !output.status.success() {
        bail!(
            "niri msg -j focused-window failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }

    let mut window: Option<WindowInfo> =
        serde_json::from_slice::<Option<NiriWindow>>(&output.stdout)
            .context("failed to parse niri focused-window JSON")?
            .map(WindowInfo::from);
    if let Some(window) = window.as_mut() {
        window.backend = NIRI_BACKEND.to_string();
    }
    Ok(window)
}

pub(crate) fn parse_niri_windows(json: &str) -> Result<Vec<WindowInfo>> {
    let niri_windows: Vec<NiriWindow> =
        serde_json::from_str(json).context("failed to parse niri msg -j windows output")?;

    let mut windows = niri_windows
        .into_iter()
        .map(WindowInfo::from)
        .collect::<Vec<_>>();
    windows.sort_by_key(|window| window.window_id);
    enrich_terminal_windows(&mut windows);
    Ok(windows)
}

pub fn activate_window(window_id: u64) -> Result<()> {
    let id = window_id.to_string();
    let output = niri_output(&["msg", "action", "focus-window", "--id", &id])
        .with_context(|| format!("failed to run niri msg action focus-window --id {id}"))?;
    if output.status.success() {
        Ok(())
    } else {
        bail!(
            "niri msg action focus-window --id {id} failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
}

fn niri_output(args: &[&str]) -> std::io::Result<std::process::Output> {
    Command::new("niri").args(args).output()
}

fn clean_string(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

#[derive(Debug, Deserialize)]
struct NiriWindow {
    id: u64,
    title: Option<String>,
    app_id: Option<String>,
    pid: Option<i64>,
    workspace_id: Option<i32>,
    #[serde(default)]
    is_focused: bool,
    layout: Option<NiriWindowLayout>,
}

#[derive(Debug, Deserialize)]
struct NiriWindowLayout {
    tile_size: Option<[f64; 2]>,
    window_size: Option<[u32; 2]>,
    tile_pos_in_workspace_view: Option<[f64; 2]>,
}

impl From<NiriWindow> for WindowInfo {
    fn from(window: NiriWindow) -> Self {
        let bounds = window.layout.as_ref().and_then(niri_window_bounds);
        let app_id = clean_string(window.app_id);

        WindowInfo {
            window_id: window.id,
            title: clean_string(window.title),
            app_id: app_id.clone(),
            wm_class: app_id,
            pid: window.pid.and_then(|pid| u32::try_from(pid).ok()),
            bounds,
            workspace: window.workspace_id,
            focused: window.is_focused,
            hidden: false,
            client_type: None,
            backend: NIRI_BACKEND.to_string(),
            terminal: None,
        }
    }
}

fn niri_window_bounds(layout: &NiriWindowLayout) -> Option<WindowBounds> {
    let [width, height] = layout.window_size.or_else(|| {
        layout
            .tile_size
            .map(|[width, height]| [width as u32, height as u32])
    })?;
    let [x, y] = layout
        .tile_pos_in_workspace_view
        .map(|[x, y]| [Some(x.round() as i32), Some(y.round() as i32)])
        .unwrap_or([None, None]);

    Some(WindowBounds {
        x,
        y,
        width,
        height,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_niri_window_json() {
        let windows = parse_niri_windows(
            r#"[
                {
                    "id": 14,
                    "title": "Codex",
                    "app_id": "codex-desktop",
                    "pid": 16589,
                    "workspace_id": 3,
                    "is_focused": false,
                    "is_floating": false,
                    "layout": {
                        "pos_in_scrolling_layout": [3, 1],
                        "tile_size": [1888.0, 994.0],
                        "window_size": [1888, 994],
                        "tile_pos_in_workspace_view": null
                    }
                },
                {
                    "id": 2,
                    "title": "tns /m/m/M/g/codex-desktop-linux",
                    "app_id": "Alacritty",
                    "pid": 1877,
                    "workspace_id": 3,
                    "is_focused": true,
                    "is_floating": false,
                    "layout": {
                        "pos_in_scrolling_layout": [2, 1],
                        "tile_size": [1888.0, 994.0],
                        "window_size": [1888, 994],
                        "tile_pos_in_workspace_view": null
                    }
                }
            ]"#,
        )
        .unwrap();

        assert_eq!(windows.len(), 2);
        assert_eq!(windows[0].window_id, 2);
        assert_eq!(windows[0].app_id.as_deref(), Some("Alacritty"));
        assert_eq!(windows[0].pid, Some(1877));
        assert_eq!(windows[0].workspace, Some(3));
        assert!(windows[0].focused);
        assert_eq!(windows[0].bounds.as_ref().unwrap().width, 1888);
        assert_eq!(windows[0].bounds.as_ref().unwrap().x, None);
        assert_eq!(windows[0].client_type, None);
        assert_eq!(windows[0].backend, NIRI_BACKEND);
    }

    #[test]
    fn parses_niri_workspace_view_position() {
        let windows = parse_niri_windows(
            r#"[
                {
                    "id": 3,
                    "title": "Dialog",
                    "app_id": "example",
                    "layout": {
                        "tile_size": [500.0, 400.0],
                        "tile_pos_in_workspace_view": [12.5, 20.2]
                    }
                }
            ]"#,
        )
        .unwrap();

        assert_eq!(windows[0].bounds.as_ref().unwrap().x, Some(13));
        assert_eq!(windows[0].bounds.as_ref().unwrap().y, Some(20));
        assert_eq!(windows[0].client_type, None);
    }
}
