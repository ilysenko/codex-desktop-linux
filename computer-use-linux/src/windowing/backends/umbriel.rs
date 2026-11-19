//! Umbriel (a wlroots compositor) window backend, driven through the
//! `umbriel` CLI, which talks to the compositor over `UMBRIEL_SOCKET`.
//!
//! `umbriel windows --json` lists every toplevel with a 128-bit hex id, pid,
//! output and logical geometry; `umbriel msg window-focus <id>` focuses one
//! exactly. Bounds are converted to capture pixels with the output layout
//! from `umbriel outputs --json`.

use crate::abs_pointer::{CaptureFit, CapturePlacement};
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
    list_windows_for(CaptureKnowledge::current()).await
}

/// `window` as listed for a capture of `width`×`height`, so its bounds are
/// in that capture's space or left out. The server resolves a target before
/// it captures, and a capture can come from another route than the one the
/// listing assumed; bounds are therefore read again for the frame in hand.
pub(crate) async fn window_for_capture(
    window: &WindowInfo,
    width: u32,
    height: u32,
) -> Result<WindowInfo> {
    let capture = CaptureKnowledge {
        last_capture: Some((width, height)),
        all_outputs_expected: false,
    };
    list_windows_for(capture)
        .await?
        .into_iter()
        .find(|listed| listed.window_id == window.window_id)
        .ok_or_else(|| anyhow!("Umbriel no longer lists window_id {}", window.window_id))
}

async fn list_windows_for(capture: CaptureKnowledge) -> Result<Vec<WindowInfo>> {
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
        Ok(outputs) if outputs.status.success() => parse_capture_layout(&outputs.stdout, capture),
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
/// an origin, scaled by the outputs' shared scale.
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

/// Whether the server runs in an Umbriel session: the desktop names say so,
/// or the compositor's socket is there. A session started without
/// `XDG_CURRENT_DESKTOP` still lists windows through the socket, so the
/// capture and pointer paths must agree with the window backend.
pub(crate) fn is_umbriel_session() -> bool {
    let named = [
        "XDG_CURRENT_DESKTOP",
        "XDG_SESSION_DESKTOP",
        "DESKTOP_SESSION",
    ]
    .iter()
    .filter_map(|key| std::env::var(key).ok())
    .any(|value| {
        value
            .split([':', ';', ','])
            .any(|token| token.trim().eq_ignore_ascii_case("umbriel"))
    });
    named
        || std::env::var_os("UMBRIEL_SOCKET").is_some_and(|path| is_socket(Path::new(&path)))
        || inferred_socket().is_some()
}

/// How a `width`×`height` capture fits the output layout; an error when the
/// layout could not be read. Runs the CLI on the calling thread.
///
/// xdg-desktop-portal-umbriel answers a non-interactive screenshot with one
/// output, not the whole desktop, while the compositor maps an absolute
/// pointer across every enabled output.
pub(crate) fn capture_fit(width: i32, height: i32) -> Result<CaptureFit> {
    if !is_umbriel_session() {
        return Ok(CaptureFit::WholeLayout);
    }
    let output = umbriel_output(OUTPUTS_ARGS)?;
    if !output.status.success() {
        bail!("umbriel outputs --json failed: {}", command_detail(&output));
    }
    let outputs = parse_enabled_outputs(&output.stdout)
        .context("failed to parse umbriel outputs --json output")?;
    Ok(fit_in(&outputs, width, height))
}

/// Whether two pixel sizes agree within `tolerance` pixels on both axes.
/// Logical sizes are integers, so a fractional scale does not round-trip
/// (2560 at 1.5 comes back as 2559 or 2561), and a stitched capture rounds
/// each output's origin on its own.
fn sizes_agree(a: (i32, i32), b: (i32, i32), tolerance: i32) -> bool {
    (i64::from(a.0) - i64::from(b.0)).abs() <= i64::from(tolerance)
        && (i64::from(a.1) - i64::from(b.1)).abs() <= i64::from(tolerance)
}

fn fit_in(outputs: &[EnabledOutput], width: i32, height: i32) -> CaptureFit {
    if outputs.len() < 2 {
        return CaptureFit::WholeLayout;
    }
    let per_output = i32::try_from(outputs.len()).unwrap_or(i32::MAX);
    // A capture of every output exists only for outputs that share a scale.
    if let Some(layout_size) =
        CaptureLayout::union_of(outputs).and_then(|layout| layout.pixel_size(outputs))
    {
        if sizes_agree((width, height), layout_size, per_output) {
            return CaptureFit::WholeLayout;
        }
    }
    let unsupported = |reason: &str| {
        CaptureFit::Unsupported(format!(
            "a {width}x{height} capture of {} enabled outputs {reason}",
            outputs.len()
        ))
    };
    // The portal sorts its outputs by name (`std::ranges::sort` on the name
    // string, the byte order `str` compares in) and captures the first.
    let Some(first) = outputs.iter().min_by(|a, b| a.name.cmp(&b.name)) else {
        return unsupported("has no first output");
    };
    // The compositor maps the device linearly over the logical layout, so
    // in the captured output's pixels the layout is its logical size times
    // that output's scale, whatever the other outputs' scales are.
    let pixels = |logical: i32| (f64::from(logical) * first.scale).round() as i32;
    let Some((first_width, first_height)) = first.logical_size else {
        return unsupported("cannot be compared with an output of unknown size");
    };
    if !sizes_agree(
        (width, height),
        (pixels(first_width), pixels(first_height)),
        1,
    ) {
        return unsupported("matches neither the whole layout nor the first output by name");
    }
    let mut left = i32::MAX;
    let mut top = i32::MAX;
    let mut right = i32::MIN;
    let mut bottom = i32::MIN;
    for output in outputs {
        let edges = output
            .logical_size
            .and_then(|(output_width, output_height)| {
                Some((
                    output.x.checked_add(output_width)?,
                    output.y.checked_add(output_height)?,
                ))
            });
        let Some((output_right, output_bottom)) = edges else {
            return unsupported("sits in a layout with an output of unknown size");
        };
        left = left.min(output.x);
        top = top.min(output.y);
        right = right.max(output_right);
        bottom = bottom.max(output_bottom);
    }
    CaptureFit::Placed(CapturePlacement {
        layout_width: pixels(right.saturating_sub(left)),
        layout_height: pixels(bottom.saturating_sub(top)),
        offset_x: pixels(first.x.saturating_sub(left)),
        offset_y: pixels(first.y.saturating_sub(top)),
    })
}

/// An enabled output of `umbriel outputs --json`, in logical coordinates.
#[derive(Debug, Clone, PartialEq)]
struct EnabledOutput {
    name: String,
    x: i32,
    y: i32,
    logical_size: Option<(i32, i32)>,
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
                name: output.name.unwrap_or_default(),
                x: position.x,
                y: position.y,
                logical_size: output
                    .logical_size
                    .filter(|size| size.width > 0 && size.height > 0)
                    .map(|size| (size.width, size.height)),
                // wlroots stores the scale as f32 (1.8 arrives as
                // 1.7999999523162842); round to the 1/120 steps of
                // wp-fractional-scale so 1600 logical pixels map to exactly
                // 2880 capture pixels.
                scale: (scale * 120.0).round() / 120.0,
            })
        })
        .collect()
}

/// What is known about the capture that window bounds must line up with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct CaptureKnowledge {
    /// Size of the latest capture, when one was taken.
    last_capture: Option<(u32, u32)>,
    /// Whether the next capture is expected to cover every output.
    all_outputs_expected: bool,
}

impl CaptureKnowledge {
    fn current() -> Self {
        Self {
            last_capture: crate::screenshot::last_capture_size(),
            all_outputs_expected: crate::screenshot::all_outputs_capture_expected(),
        }
    }
}

impl CaptureLayout {
    /// The capture space window bounds are reported in, or `None` when it is
    /// unknown. With one enabled output it is that output. With several it
    /// is their union only when the capture covers every output: the size of
    /// the latest capture decides, and before the first capture, whether the
    /// all-outputs route is expected. xdg-desktop-portal-umbriel captures one
    /// output, so in that fallback bounds are left out.
    fn for_capture(outputs: &[EnabledOutput], capture: CaptureKnowledge) -> Option<Self> {
        if let [output] = outputs {
            return Some(Self {
                origin_x: output.x,
                origin_y: output.y,
                scale: output.scale,
            });
        }
        let layout = Self::union_of(outputs)?;
        let covers_every_output = match capture.last_capture {
            Some((width, height)) => sizes_agree(
                (i32::try_from(width).ok()?, i32::try_from(height).ok()?),
                layout.pixel_size(outputs)?,
                i32::try_from(outputs.len()).ok()?,
            ),
            None => capture.all_outputs_expected,
        };
        covers_every_output.then_some(layout)
    }

    /// The union of outputs that share one scale. Mixed scales have no
    /// uniform capture space, as on niri and Sway.
    fn union_of(outputs: &[EnabledOutput]) -> Option<Self> {
        let scale = outputs.first()?.scale;
        if scale <= 0.0 || outputs.iter().any(|output| output.scale != scale) {
            return None;
        }
        Some(Self {
            origin_x: outputs.iter().map(|output| output.x).min()?,
            origin_y: outputs.iter().map(|output| output.y).min()?,
            scale,
        })
    }

    /// The size of the whole layout in capture pixels.
    fn pixel_size(&self, outputs: &[EnabledOutput]) -> Option<(i32, i32)> {
        let pixels = |logical: i32| (f64::from(logical) * self.scale).round() as i32;
        let mut right = i32::MIN;
        let mut bottom = i32::MIN;
        for output in outputs {
            let (logical_width, logical_height) = output.logical_size?;
            right = right.max(output.x.checked_add(logical_width)?);
            bottom = bottom.max(output.y.checked_add(logical_height)?);
        }
        Some((
            pixels(right.checked_sub(self.origin_x)?),
            pixels(bottom.checked_sub(self.origin_y)?),
        ))
    }
}

fn parse_capture_layout(outputs_json: &[u8], capture: CaptureKnowledge) -> Option<CaptureLayout> {
    CaptureLayout::for_capture(&parse_enabled_outputs(outputs_json)?, capture)
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
    name: Option<String>,
    enabled: Option<bool>,
    position: Option<UmbrielPosition>,
    logical_size: Option<UmbrielSize>,
    scale: Option<f64>,
}

#[derive(Debug, Deserialize)]
struct UmbrielSize {
    width: i32,
    height: i32,
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
        {"name":"eDP-2","enabled":true,"position":{"x":0,"y":1000},
         "logical_size":{"height":1000,"width":1600},"scale":1.7999999523162842,"transform":"normal"}
    ]"#;

    const WINDOWS: &str = r#"[
        {"active":true,"app_id":"Alacritty","focused":true,"h":964,
         "id":"3d39ba759b7589ee3c98ddd21b65aeee","minimized":false,"output":"eDP-2",
         "pid":134616,"title":"shell","visible":true,"w":772,"workspace":"eDP-2:4",
         "x":810,"xwayland":false,"y":1018},
        {"active":false,"app_id":"com.anthropic.Claude","focused":true,"h":976,
         "id":"2a7e463b56373a52dc59bd3271c705be","minimized":false,"output":"eDP-1",
         "pid":2537,"title":"Claude","visible":false,"w":1600,"workspace":"eDP-1:1",
         "x":0,"xwayland":false,"y":24}
    ]"#;

    const ALL_OUTPUTS: CaptureKnowledge = CaptureKnowledge {
        last_capture: None,
        all_outputs_expected: true,
    };

    fn after_capture(width: u32, height: u32) -> CaptureKnowledge {
        CaptureKnowledge {
            last_capture: Some((width, height)),
            all_outputs_expected: true,
        }
    }

    #[test]
    fn several_outputs_have_bounds_only_under_a_capture_of_all_of_them() {
        let layout = |capture| parse_capture_layout(OUTPUTS.as_bytes(), capture);
        // The stitched capture is a pixel taller than the layout.
        assert!(layout(after_capture(2880, 3601)).is_some());
        // The portal fallback captured one output: bounds are left out, even
        // though the all-outputs route was expected.
        assert!(layout(after_capture(2880, 1800)).is_none());
        // Before the first capture the expected route decides.
        assert!(layout(ALL_OUTPUTS).is_some());
        assert!(layout(CaptureKnowledge {
            last_capture: None,
            all_outputs_expected: false,
        })
        .is_none());
    }

    #[test]
    fn one_output_has_bounds_whatever_the_capture() {
        let docked = OUTPUTS.replace(
            "\"name\":\"eDP-2\",\"enabled\":true",
            "\"name\":\"eDP-2\",\"enabled\":false",
        );
        let capture = CaptureKnowledge {
            last_capture: None,
            all_outputs_expected: false,
        };
        assert_eq!(
            parse_capture_layout(docked.as_bytes(), capture),
            Some(CaptureLayout {
                origin_x: 0,
                origin_y: 0,
                scale: 1.8
            })
        );
    }

    fn fit(outputs_json: &str, width: i32, height: i32) -> CaptureFit {
        fit_in(
            &parse_enabled_outputs(outputs_json.as_bytes()).unwrap(),
            width,
            height,
        )
    }

    fn placed(layout: (i32, i32), offset: (i32, i32)) -> CaptureFit {
        CaptureFit::Placed(CapturePlacement {
            layout_width: layout.0,
            layout_height: layout.1,
            offset_x: offset.0,
            offset_y: offset.1,
        })
    }

    #[test]
    fn a_capture_that_matches_nothing_is_unsupported_not_whole() {
        // Sizing the device to an unrecognized capture would scale every
        // point across both outputs.
        assert!(matches!(
            fit(OUTPUTS, 1920, 1080),
            CaptureFit::Unsupported(_)
        ));
    }

    #[test]
    fn mixed_scales_place_a_first_output_capture_in_its_own_pixels() {
        // eDP-1 at scale 1 (1600x1000) above eDP-2 at 1.8: the device maps
        // linearly over the 1600x2000 logical layout.
        let mixed = OUTPUTS.replacen("1.7999999523162842", "1.0", 1);
        assert_eq!(fit(&mixed, 1600, 1000), placed((1600, 2000), (0, 0)));
        // No stitched capture exists for mixed scales.
        assert!(matches!(
            fit(&mixed, 2880, 3600),
            CaptureFit::Unsupported(_)
        ));
    }

    #[test]
    fn fractional_scales_match_within_a_pixel() {
        // 2560x1440 at 1.5 has an integer logical width of 1707, which maps
        // back to 2561 (2560.5 rounded).
        let outputs = r#"[
            {"name":"DP-1","enabled":true,"position":{"x":0,"y":0},
             "logical_size":{"height":960,"width":1707},"scale":1.5},
            {"name":"DP-2","enabled":true,"position":{"x":1707,"y":0},
             "logical_size":{"height":960,"width":1707},"scale":1.5}
        ]"#;
        assert_eq!(fit(outputs, 2560, 1440), placed((5121, 1440), (0, 0)));
        assert_eq!(fit(outputs, 5120, 1440), CaptureFit::WholeLayout);
    }

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
    fn mixed_output_scales_leave_bounds_out() {
        let mixed = OUTPUTS.replacen("1.7999999523162842", "1.0", 1);
        assert!(parse_capture_layout(mixed.as_bytes(), ALL_OUTPUTS).is_none());
    }

    #[test]
    fn layout_rounds_the_float_scale_and_starts_at_the_union_origin() {
        let layout = parse_capture_layout(OUTPUTS.as_bytes(), ALL_OUTPUTS).unwrap();
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
        let layout = parse_capture_layout(OUTPUTS.as_bytes(), ALL_OUTPUTS);
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
        assert_eq!((bounds.x, bounds.y), (Some(1458), Some(1832)));
        assert_eq!((bounds.width, bounds.height), (1390, 1736));

        assert_eq!(
            full_ids.get(&shell.window_id).map(String::as_str),
            Some("3d39ba759b7589ee3c98ddd21b65aeee")
        );
    }

    #[test]
    fn a_first_output_capture_is_placed_inside_the_stacked_layout() {
        // The portal captured eDP-1 (2880x1800) of two stacked outputs.
        assert_eq!(fit(OUTPUTS, 2880, 1800), placed((2880, 3600), (0, 0)));
        // A capture of the whole layout needs no placement; the stitched
        // one is a pixel taller than the layout.
        assert_eq!(fit(OUTPUTS, 2880, 3600), CaptureFit::WholeLayout);
        assert_eq!(fit(OUTPUTS, 2880, 3601), CaptureFit::WholeLayout);
    }

    #[test]
    fn the_first_output_by_name_sets_the_offset() {
        let swapped = OUTPUTS
            .replace("\"y\":1000", "\"y\":-1")
            .replace(
                "\"position\":{\"x\":0,\"y\":0}",
                "\"position\":{\"x\":0,\"y\":1000}",
            )
            .replace("\"y\":-1", "\"y\":0");
        assert_eq!(fit(&swapped, 2880, 1800), placed((2880, 3600), (0, 1800)));
    }

    #[test]
    fn a_single_enabled_output_needs_no_placement() {
        let docked = OUTPUTS.replace(
            "\"name\":\"eDP-2\",\"enabled\":true",
            "\"name\":\"eDP-2\",\"enabled\":false",
        );
        assert_eq!(fit(&docked, 2880, 1800), CaptureFit::WholeLayout);
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
