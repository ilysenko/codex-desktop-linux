//! Umbriel (a wlroots compositor) window backend, driven through the
//! `umbriel` CLI, which talks to the compositor over `UMBRIEL_SOCKET`.
//!
//! `umbriel windows --json` lists every toplevel with a 128-bit hex id, pid,
//! output and logical geometry; `umbriel msg window-focus <id>` focuses one
//! exactly. Bounds are converted to capture pixels with the output layout
//! from `umbriel outputs --json`.

use crate::command_runner;
use crate::terminal::enrich_terminal_windows;
use crate::windowing::registry::BackendProbe;
use crate::windowing::types::{WindowBounds, WindowInfo};
use anyhow::{anyhow, bail, Context, Result};
use serde::Deserialize;
use std::collections::HashMap;
use std::os::unix::fs::FileTypeExt;
use std::path::{Path, PathBuf};
use std::process::Command as StdCommand;
use tokio::process::Command;

pub const UMBRIEL_BACKEND: &str = "umbriel";

const WINDOWS_ARGS: &[&str] = &["windows", "--json"];
const OUTPUTS_ARGS: &[&str] = &["outputs", "--json"];

/// Hex digits of an Umbriel window id kept for `window_id`: 13 digits are 52
/// bits, so the number stays within `MAX_WINDOW_ID` (2^53-1).
const WINDOW_ID_HEX_DIGITS: usize = 13;

/// Full Umbriel ids of the windows in the last listing, by `window_id`, so
/// focusing does not have to list every window again.
static FULL_IDS: std::sync::Mutex<Option<HashMap<u64, String>>> = std::sync::Mutex::new(None);

pub fn probe() -> BackendProbe {
    let (ok, detail) = match umbriel_output(WINDOWS_ARGS) {
        Ok(output) if output.status.success() => {
            let ok = matches!(
                serde_json::from_slice::<serde_json::Value>(&output.stdout),
                Ok(serde_json::Value::Array(_))
            );
            let detail = if ok {
                "umbriel windows --json returned a JSON array"
            } else {
                "umbriel windows --json did not return a JSON array"
            };
            (ok, detail.to_string())
        }
        Ok(output) => (false, command_detail(&output)),
        Err(error) => (false, format!("{error:#}")),
    };
    BackendProbe {
        id: UMBRIEL_BACKEND,
        ok,
        can_list_windows: ok,
        can_focus_apps: ok,
        can_focus_windows: ok,
        detail,
    }
}

pub async fn list_windows() -> Result<Vec<WindowInfo>> {
    let (output, outputs) = tokio::join!(
        umbriel_output_async(WINDOWS_ARGS),
        umbriel_output_async(OUTPUTS_ARGS)
    );
    let output = output.context("failed to run umbriel windows --json")?;
    if !output.status.success() {
        bail!("umbriel windows --json failed: {}", command_detail(&output));
    }
    // Windows are still listed and focused without a layout; only their
    // bounds are left out.
    let layout = match outputs {
        Ok(outputs) if outputs.status.success() => parse_capture_layout(&outputs.stdout),
        _ => None,
    };
    let (mut windows, full_ids) = parse_windows(&output.stdout, layout)?;
    if let Ok(mut cache) = FULL_IDS.lock() {
        *cache = Some(full_ids);
    }
    enrich_terminal_windows(&mut windows);
    Ok(windows)
}

pub async fn activate_window(window_id: u64) -> Result<()> {
    let cached = FULL_IDS
        .lock()
        .ok()
        .and_then(|cache| cache.as_ref().and_then(|ids| ids.get(&window_id).cloned()));
    let full_id = match cached {
        Some(full_id) => full_id,
        None => {
            list_windows().await?;
            FULL_IDS
                .lock()
                .ok()
                .and_then(|cache| cache.as_ref().and_then(|ids| ids.get(&window_id).cloned()))
                .ok_or_else(|| anyhow!("Umbriel has no window with window_id {window_id}"))?
        }
    };
    let output = umbriel_output_async(&["msg", "window-focus", &full_id])
        .await
        .with_context(|| format!("failed to run umbriel msg window-focus {full_id}"))?;
    if output.status.success() {
        Ok(())
    } else {
        bail!(
            "umbriel msg window-focus {full_id} failed: {}",
            command_detail(&output)
        );
    }
}

/// Maps Umbriel's logical layout coordinates to capture pixels: relative to
/// the one enabled output, scaled by its scale.
#[derive(Debug, Clone, Copy, PartialEq)]
struct CaptureLayout {
    origin_x: i32,
    origin_y: i32,
    scale: f64,
}

impl CaptureLayout {
    fn map_bounds(&self, x: i32, y: i32, width: u32, height: u32) -> Option<WindowBounds> {
        if width == 0 || height == 0 {
            return None;
        }
        let scaled = |value: i64, origin: i32| (value - i64::from(origin)) as f64 * self.scale;
        let left = scaled(i64::from(x), self.origin_x).floor();
        let top = scaled(i64::from(y), self.origin_y).floor();
        let right = scaled(i64::from(x) + i64::from(width), self.origin_x).ceil();
        let bottom = scaled(i64::from(y) + i64::from(height), self.origin_y).ceil();
        let fits_i32 = |value: f64| value >= f64::from(i32::MIN) && value <= f64::from(i32::MAX);
        if !fits_i32(left)
            || !fits_i32(top)
            || right <= left
            || bottom <= top
            || right - left > f64::from(u32::MAX)
            || bottom - top > f64::from(u32::MAX)
        {
            return None;
        }
        Some(WindowBounds {
            x: Some(left as i32),
            y: Some(top as i32),
            width: (right - left) as u32,
            height: (bottom - top) as u32,
        })
    }
}

/// An enabled output of `umbriel outputs --json`, in logical coordinates.
#[derive(Debug, Clone, PartialEq)]
struct EnabledOutput {
    x: i32,
    y: i32,
    scale: f64,
}

/// The enabled outputs, or `None` when the JSON is not an output list or an
/// enabled output lacks a position or a usable scale. Disabled outputs may
/// omit any field.
fn parse_enabled_outputs(outputs_json: &[u8]) -> Option<Vec<EnabledOutput>> {
    let outputs: Vec<UmbrielOutput> = serde_json::from_slice(outputs_json).ok()?;
    outputs
        .into_iter()
        .filter(|output| output.enabled.unwrap_or(true))
        .map(|output| {
            let position = output.position?;
            let scale = output
                .scale
                .filter(|scale| scale.is_finite() && *scale > 0.0)?;
            Some(EnabledOutput {
                x: position.x,
                y: position.y,
                // wlroots stores the scale as f32 (1.8 arrives as
                // 1.7999999523162842); round to the 1/120 steps of
                // wp-fractional-scale so 1600 logical pixels map to exactly
                // 2880 capture pixels.
                scale: (scale * 120.0).round() / 120.0,
            })
        })
        .collect()
}

impl CaptureLayout {
    /// The capture space of a session with one enabled output. With several,
    /// xdg-desktop-portal-umbriel captures one output, not their union, so
    /// which pixels a window covers in the capture is unknown and bounds are
    /// left out, as other backends do when the capture space is unknown.
    fn from_outputs(outputs: &[EnabledOutput]) -> Option<Self> {
        let [output] = outputs else {
            return None;
        };
        Some(Self {
            origin_x: output.x,
            origin_y: output.y,
            scale: output.scale,
        })
    }
}

fn parse_capture_layout(outputs_json: &[u8]) -> Option<CaptureLayout> {
    CaptureLayout::from_outputs(&parse_enabled_outputs(outputs_json)?)
}

fn parse_windows(
    windows_json: &[u8],
    layout: Option<CaptureLayout>,
) -> Result<(Vec<WindowInfo>, HashMap<u64, String>)> {
    let raw: Vec<UmbrielWindow> = serde_json::from_slice(windows_json)
        .context("failed to parse umbriel windows --json output")?;
    let mut windows = Vec::with_capacity(raw.len());
    let mut full_ids = HashMap::with_capacity(raw.len());
    for window in raw {
        let window_id = parse_window_id(&window.id)?;
        if full_ids.insert(window_id, window.id.clone()).is_some() {
            bail!(
                "two Umbriel windows share the window_id prefix of {}",
                window.id
            );
        }
        let bounds = layout.and_then(|layout| {
            let width = u32::try_from(window.w?).ok()?;
            let height = u32::try_from(window.h?).ok()?;
            layout.map_bounds(window.x?, window.y?, width, height)
        });
        let app_id = window.app_id.filter(|app_id| !app_id.is_empty());
        windows.push(WindowInfo {
            window_id,
            title: window.title,
            wm_class: app_id.clone(),
            app_id,
            pid: window.pid.and_then(|pid| u32::try_from(pid).ok()),
            bounds,
            workspace: window.workspace.as_deref().and_then(parse_workspace_index),
            // `focused` marks the focused window of each workspace; `active`
            // is the one window holding keyboard focus.
            focused: window.active.unwrap_or(false),
            hidden: window.minimized.unwrap_or(false) || !window.visible.unwrap_or(true),
            client_type: window.xwayland.map(|xwayland| {
                if xwayland {
                    "x11".to_string()
                } else {
                    "wayland".to_string()
                }
            }),
            backend: UMBRIEL_BACKEND.to_string(),
            terminal: None,
        });
    }
    windows.sort_by_key(|window| window.window_id);
    Ok((windows, full_ids))
}

fn parse_window_id(id: &str) -> Result<u64> {
    let id = id.trim();
    let prefix = id
        .get(..WINDOW_ID_HEX_DIGITS)
        .with_context(|| format!("Umbriel window id {id:?} is shorter than expected"))?;
    u64::from_str_radix(prefix, 16)
        .with_context(|| format!("failed to parse Umbriel window id {id:?}"))
}

/// Workspaces are named `<output>:<index>`, for example `eDP-2:4`.
fn parse_workspace_index(workspace: &str) -> Option<i32> {
    workspace.rsplit(':').next()?.trim().parse().ok()
}

fn command_detail(output: &std::process::Output) -> String {
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let detail = if stderr.trim().is_empty() {
        stdout.trim()
    } else {
        stderr.trim()
    };
    if detail.is_empty() {
        format!("exit status {}", output.status)
    } else {
        detail.to_string()
    }
}

/// Runs the CLI on the calling thread, bounded by the command runner's
/// timeout so a stalled compositor cannot hold the caller.
fn umbriel_output(args: &[&str]) -> Result<std::process::Output> {
    let mut command = StdCommand::new("umbriel");
    if let Some(socket) = inferred_socket() {
        command.env("UMBRIEL_SOCKET", socket);
    }
    command.args(args);
    command_runner::output_blocking(&mut command, "run umbriel")
}

async fn umbriel_output_async(args: &[&str]) -> Result<std::process::Output> {
    let mut command = Command::new("umbriel");
    if let Some(socket) = inferred_socket() {
        command.env("UMBRIEL_SOCKET", socket);
    }
    command.args(args);
    command_runner::output(command, "run umbriel").await
}

/// The socket to hand the CLI when the host did not pass `UMBRIEL_SOCKET`:
/// `$XDG_RUNTIME_DIR/umbriel-$WAYLAND_DISPLAY.sock`, if it is a socket.
fn inferred_socket() -> Option<PathBuf> {
    let has_socket = std::env::var_os("UMBRIEL_SOCKET").is_some_and(|value| !value.is_empty());
    if has_socket {
        return None;
    }
    let runtime = std::env::var_os("XDG_RUNTIME_DIR").filter(|value| !value.is_empty())?;
    let display = std::env::var("WAYLAND_DISPLAY").ok()?;
    let display = display.trim();
    if display.is_empty() || display.contains('/') {
        return None;
    }
    let path = PathBuf::from(runtime).join(format!("umbriel-{display}.sock"));
    is_socket(&path).then_some(path)
}

fn is_socket(path: &Path) -> bool {
    std::fs::metadata(path).is_ok_and(|metadata| metadata.file_type().is_socket())
}

#[derive(Debug, Deserialize)]
struct UmbrielWindow {
    id: String,
    app_id: Option<String>,
    title: Option<String>,
    pid: Option<i64>,
    x: Option<i32>,
    y: Option<i32>,
    w: Option<i64>,
    h: Option<i64>,
    workspace: Option<String>,
    active: Option<bool>,
    visible: Option<bool>,
    minimized: Option<bool>,
    xwayland: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct UmbrielOutput {
    enabled: Option<bool>,
    position: Option<UmbrielPosition>,
    scale: Option<f64>,
}

#[derive(Debug, Deserialize)]
struct UmbrielPosition {
    x: i32,
    y: i32,
}

#[cfg(test)]
mod tests {
    use super::*;

    const OUTPUTS: &str = r#"[
        {"name":"eDP-1","enabled":true,"position":{"x":0,"y":0},
         "logical_size":{"height":1000,"width":1600},"scale":1.7999999523162842,"transform":"180"},
        {"name":"eDP-2","enabled":false,"position":{"x":0,"y":1000},
         "logical_size":{"height":1000,"width":1600},"scale":1.7999999523162842,"transform":"normal"}
    ]"#;

    const WINDOWS: &str = r#"[
        {"active":true,"app_id":"Alacritty","focused":true,"h":964,
         "id":"3d39ba759b7589ee3c98ddd21b65aeee","minimized":false,"output":"eDP-1",
         "pid":134616,"title":"shell","visible":true,"w":772,"workspace":"eDP-1:4",
         "x":810,"xwayland":false,"y":34},
        {"active":false,"app_id":"com.anthropic.Claude","focused":true,"h":976,
         "id":"2a7e463b56373a52dc59bd3271c705be","minimized":false,"output":"eDP-1",
         "pid":2537,"title":"Claude","visible":false,"w":1600,"workspace":"eDP-1:1",
         "x":0,"xwayland":false,"y":24}
    ]"#;

    #[test]
    fn a_disabled_output_may_omit_its_geometry() {
        let outputs = parse_enabled_outputs(
            br#"[
                {"name":"eDP-1","enabled":true,"position":{"x":0,"y":0},
                 "logical_size":{"height":1000,"width":1600},"scale":1.7999999523162842},
                {"name":"HDMI-A-1","enabled":false,"position":null}
            ]"#,
        )
        .unwrap();
        assert_eq!(outputs.len(), 1);
        assert_eq!(outputs[0].scale, 1.8);
        // An enabled output without a position leaves the layout unknown.
        assert!(parse_enabled_outputs(br#"[{"name":"eDP-1","scale":1.0}]"#).is_none());
    }

    #[test]
    fn several_enabled_outputs_leave_bounds_out() {
        // The portal captures one output of several, so the capture space of
        // a window is unknown; listing and ids are unaffected.
        let stacked = OUTPUTS.replace(r#""enabled":false"#, r#""enabled":true"#);
        let layout = parse_capture_layout(stacked.as_bytes());
        assert!(layout.is_none());
        let (windows, _) = parse_windows(WINDOWS.as_bytes(), layout).unwrap();
        assert_eq!(windows.len(), 2);
        assert!(windows.iter().all(|window| window.bounds.is_none()));
    }

    #[test]
    fn layout_rounds_the_float_scale_and_starts_at_the_output_origin() {
        let layout = parse_capture_layout(OUTPUTS.as_bytes()).unwrap();
        assert_eq!(
            layout,
            CaptureLayout {
                origin_x: 0,
                origin_y: 0,
                scale: 1.8
            }
        );
    }

    #[test]
    fn windows_map_to_capture_pixels_with_exact_ids() {
        let layout = parse_capture_layout(OUTPUTS.as_bytes());
        let (windows, full_ids) = parse_windows(WINDOWS.as_bytes(), layout).unwrap();
        assert_eq!(windows.len(), 2);

        let claude = &windows[0];
        assert_eq!(claude.window_id, 0x2a7e463b56373);
        assert_eq!(claude.app_id.as_deref(), Some("com.anthropic.Claude"));
        assert!(!claude.focused, "per-workspace focus is not keyboard focus");
        assert!(claude.hidden, "a window on an inactive workspace is hidden");
        assert_eq!(claude.workspace, Some(1));

        let shell = &windows[1];
        assert_eq!(shell.window_id, 0x3d39ba759b758);
        assert!(shell.window_id <= crate::windowing::types::MAX_WINDOW_ID);
        assert_eq!(shell.pid, Some(134616));
        assert!(shell.focused);
        assert!(!shell.hidden);
        assert_eq!(shell.client_type.as_deref(), Some("wayland"));
        let bounds = shell.bounds.as_ref().unwrap();
        assert_eq!((bounds.x, bounds.y), (Some(1458), Some(61)));
        assert_eq!((bounds.width, bounds.height), (1390, 1736));

        assert_eq!(
            full_ids.get(&shell.window_id).map(String::as_str),
            Some("3d39ba759b7589ee3c98ddd21b65aeee")
        );
    }

    #[test]
    fn bounds_are_omitted_without_an_output_layout() {
        let (windows, _) = parse_windows(WINDOWS.as_bytes(), None).unwrap();
        assert!(windows.iter().all(|window| window.bounds.is_none()));
    }

    #[test]
    fn short_or_non_hex_ids_are_rejected() {
        assert!(parse_window_id("abc").is_err());
        assert!(parse_window_id("zzzzzzzzzzzzzzzz").is_err());
    }

    #[test]
    fn workspace_index_is_the_part_after_the_output_name() {
        assert_eq!(parse_workspace_index("eDP-2:4"), Some(4));
        assert_eq!(parse_workspace_index("scratch"), None);
    }
}
