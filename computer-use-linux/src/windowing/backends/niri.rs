//! Window listing and exact focus for niri, using `niri msg` with a direct IPC
//! fallback. Both transports use the same session socket, discovered from
//! `NIRI_SOCKET` or, when that is unset, from an unambiguous `niri.*.sock` in
//! `XDG_RUNTIME_DIR` matching `WAYLAND_DISPLAY`.
//!
//! The socket transport is not redundant: MCP hosts can spawn their servers
//! with a scrubbed `PATH` that carries no `niri` binary, and `niri msg` refuses
//! to run at all unless `NIRI_SOCKET` is set in its environment.

use crate::command_runner;
use crate::remote_desktop::LogicalMonitor;
use crate::terminal::enrich_terminal_windows;
use crate::windowing::registry::BackendProbe;
use crate::windowing::types::{WindowBounds, WindowInfo};
use anyhow::{anyhow, bail, Context, Result};
use serde::Deserialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::fs::{FileTypeExt, MetadataExt};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::Command as StdCommand;
use std::time::Duration;

pub const NIRI_BACKEND: &str = "niri";

/// Bound individual socket reads and writes if the compositor stops responding.
const NIRI_IPC_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_IPC_REPLY_BYTES: u64 = 8 * 1024 * 1024;

/// Raw niri IPC requests. The socket takes JSON; `niri msg` takes argv.
const WINDOWS_REQUEST: &str = "\"Windows\"";
const WINDOWS_CLI: &[&str] = &["msg", "--json", "windows"];
const OUTPUTS_REQUEST: &str = "\"Outputs\"";
const OUTPUTS_CLI: &[&str] = &["msg", "--json", "outputs"];
const WORKSPACES_REQUEST: &str = "\"Workspaces\"";
const WORKSPACES_CLI: &[&str] = &["msg", "--json", "workspaces"];

/// Transport labels used in `doctor` detail strings.
const TRANSPORT_SOCKET: &str = "the niri IPC socket";
const TRANSPORT_CLI: &str = "niri msg";

pub fn probe() -> BackendProbe {
    match request_value(WINDOWS_REQUEST, WINDOWS_CLI, "Windows").and_then(|reply| {
        let windows: Vec<NiriWindow> =
            serde_json::from_value(reply.value).context("failed to parse the niri window list")?;
        Ok((windows, reply.transport))
    }) {
        Ok((windows, transport)) => BackendProbe {
            id: NIRI_BACKEND,
            ok: true,
            can_list_windows: true,
            can_focus_apps: true,
            can_focus_windows: true,
            detail: format!("{transport} returned {} window(s)", windows.len()),
        },
        Err(error) => BackendProbe {
            id: NIRI_BACKEND,
            ok: false,
            can_list_windows: false,
            can_focus_apps: false,
            can_focus_windows: false,
            detail: format!("{error:#}"),
        },
    }
}

pub async fn list_windows() -> Result<Vec<WindowInfo>> {
    let (windows, _transport) = tokio::task::spawn_blocking(list_windows_with_transport)
        .await
        .context("niri window listing task panicked")??;
    Ok(windows)
}

/// Focus an exact niri window by id.
///
/// niri replies `{"Ok":"Handled"}` even for an id that does not exist, so a
/// successful return here means "the compositor accepted the action", not "the
/// window is now focused". Callers that need certainty re-query the focused
/// window, which is what the server's focus verification already does.
pub async fn activate_window(window_id: u64) -> Result<()> {
    tokio::task::spawn_blocking(move || activate_window_blocking(window_id))
        .await
        .context("niri focus task panicked")?
}

fn activate_window_blocking(window_id: u64) -> Result<()> {
    let request = format!("{{\"Action\":{{\"FocusWindow\":{{\"id\":{window_id}}}}}}}");
    let cli_args = [
        "msg",
        "action",
        "focus-window",
        "--id",
        &window_id.to_string(),
    ];
    match cli_action(&cli_args) {
        Ok(()) => Ok(()),
        Err(cli_error) => match socket_request(&request)
            .and_then(|reply| ensure_socket_action_succeeded(&request, &reply))
        {
            Ok(()) => Ok(()),
            Err(socket_error) => Err(anyhow!(
                "niri action focus-window --id {window_id} failed: {cli_error:#} (the direct niri IPC fallback also failed: {socket_error:#})"
            )),
        },
    }
}

fn list_windows_with_transport() -> Result<(Vec<WindowInfo>, &'static str)> {
    let reply = request_value(WINDOWS_REQUEST, WINDOWS_CLI, "Windows")?;
    let windows: Vec<NiriWindow> =
        serde_json::from_value(reply.value).context("failed to parse the niri window list")?;

    // A missing workspace map should not discard a known output scale.
    let layout = output_layout().unwrap_or_default();

    let mut windows = windows
        .into_iter()
        .map(|window| window.into_window_info(&layout))
        .collect::<Vec<_>>();
    windows.sort_by_key(|window| window.window_id);
    enrich_terminal_windows(&mut windows);
    Ok((windows, reply.transport))
}

/// Maps a uniformly scaled logical desktop into device pixels. Capture paths
/// with different output scales need capture metadata and are not inferred here.
#[derive(Debug, Clone, Copy)]
struct NiriCaptureLayout {
    origin_x: i32,
    origin_y: i32,
    scale: f64,
}

impl NiriCaptureLayout {
    /// A uniform output scale defines one desktop-wide pixel coordinate space.
    /// Mixed scales require capture metadata; omit bounds rather than guess.
    fn from_outputs(outputs: &BTreeMap<String, NiriOutputGeometry>) -> Option<Self> {
        let first = outputs.values().next()?;
        if outputs.values().any(|geometry| {
            !geometry.scale.is_finite() || geometry.scale <= 0.0 || geometry.scale != first.scale
        }) {
            return None;
        }
        Some(Self {
            origin_x: outputs.values().map(|geometry| geometry.x).min()?,
            origin_y: outputs.values().map(|geometry| geometry.y).min()?,
            scale: first.scale,
        })
    }

    /// Device-pixel bounds for a logical window rect. A `None` position yields
    /// populated size with `null` x/y rather than dropping bounds entirely.
    fn window_bounds(
        &self,
        position: Option<(f64, f64)>,
        width: f64,
        height: f64,
    ) -> Option<WindowBounds> {
        if !width.is_finite() || !height.is_finite() || width <= 0.0 || height <= 0.0 {
            return None;
        }
        Some(WindowBounds {
            x: position.and_then(|(x, _)| self.map_axis(x, self.origin_x)),
            y: position.and_then(|(_, y)| self.map_axis(y, self.origin_y)),
            width: self.map_dimension(width)?,
            height: self.map_dimension(height)?,
        })
    }

    fn map_axis(&self, value: f64, origin: i32) -> Option<i32> {
        round_coordinate((value - f64::from(origin)) * self.scale)
    }

    fn map_dimension(&self, value: f64) -> Option<u32> {
        positive_dimension(value * self.scale)
    }
}

/// niri window geometry, plus the output it belongs to.
#[derive(Debug, Default)]
struct NiriOutputLayout {
    /// Output name -> logical geometry of that output.
    geometries: BTreeMap<String, NiriOutputGeometry>,
    /// Workspace id -> name of the output currently holding it.
    workspace_outputs: BTreeMap<u64, String>,
    capture: Option<NiriCaptureLayout>,
}

impl NiriOutputLayout {
    /// Global logical position of a window, when niri reports one.
    ///
    /// `tile_pos_in_workspace_view` is relative to the workspace view of the
    /// output that holds the workspace, so the output's logical origin is added
    /// back in to get a desktop-wide coordinate.
    fn position(&self, window: &NiriWindow) -> Option<(f64, f64)> {
        let local = window.workspace_view_position()?;
        let output = self.workspace_outputs.get(&window.workspace_id?)?;
        let geometry = self.geometries.get(output)?;
        Some((
            f64::from(geometry.x) + local[0],
            f64::from(geometry.y) + local[1],
        ))
    }
}

fn output_layout() -> Option<NiriOutputLayout> {
    let outputs = request_value(OUTPUTS_REQUEST, OUTPUTS_CLI, "Outputs").ok()?;
    let workspaces = request_value(WORKSPACES_REQUEST, WORKSPACES_CLI, "Workspaces").ok();
    let geometries = parse_output_geometries(&outputs.value);
    Some(NiriOutputLayout {
        capture: NiriCaptureLayout::from_outputs(&geometries),
        geometries,
        workspace_outputs: workspaces
            .map(|reply| parse_workspace_outputs(&reply.value))
            .unwrap_or_default(),
    })
}

/// The logical monitor layout niri reports, for mapping portal pointer
/// coordinates. `None` when niri cannot be reached or reports an output with
/// an unusable size or scale.
pub(crate) async fn monitor_layout() -> Option<Vec<LogicalMonitor>> {
    tokio::task::spawn_blocking(|| {
        let outputs = request_value(OUTPUTS_REQUEST, OUTPUTS_CLI, "Outputs").ok()?;
        parse_monitor_layout(&outputs.value)
    })
    .await
    .ok()
    .flatten()
}

/// Disabled outputs carry no logical geometry and are skipped. One enabled
/// output with a zero size or a bad scale makes the whole layout unusable.
fn parse_monitor_layout(outputs: &Value) -> Option<Vec<LogicalMonitor>> {
    let outputs = BTreeMap::<String, NiriMonitorOutput>::deserialize(outputs).ok()?;
    let layout = outputs
        .into_values()
        .filter_map(|output| output.logical)
        .map(|monitor| {
            (monitor.scale.is_finite()
                && monitor.scale > 0.0
                && monitor.width > 0
                && monitor.height > 0)
                .then_some(LogicalMonitor {
                    x: monitor.x,
                    y: monitor.y,
                    width: monitor.width,
                    height: monitor.height,
                    scale: monitor.scale,
                })
        })
        .collect::<Option<Vec<_>>>()?;
    (!layout.is_empty()).then_some(layout)
}

fn parse_output_geometries(outputs: &Value) -> BTreeMap<String, NiriOutputGeometry> {
    let Ok(outputs) = BTreeMap::<String, NiriOutput>::deserialize(outputs) else {
        return BTreeMap::new();
    };
    outputs
        .into_iter()
        .filter_map(|(name, output)| {
            let logical = output.logical?;
            Some((
                name,
                NiriOutputGeometry {
                    x: logical.x,
                    y: logical.y,
                    scale: logical.scale,
                },
            ))
        })
        .collect()
}

fn parse_workspace_outputs(workspaces: &Value) -> BTreeMap<u64, String> {
    let Ok(workspaces) = Vec::<NiriWorkspace>::deserialize(workspaces) else {
        return BTreeMap::new();
    };
    workspaces
        .into_iter()
        .filter_map(|workspace| {
            let output = workspace.output?;
            Some((workspace.id, output))
        })
        .collect()
}

/// One niri request, plus how it was answered for `doctor` detail strings.
struct NiriReply {
    value: Value,
    transport: &'static str,
}

/// Prefer the CLI, with direct IPC as a fallback when the binary is unavailable.
fn request_value(request: &str, cli_args: &[&str], key: &str) -> Result<NiriReply> {
    match cli_value(cli_args, key) {
        Ok(value) => Ok(NiriReply {
            value,
            transport: TRANSPORT_CLI,
        }),
        Err(cli_error) => match socket_value(request, key) {
            Ok(value) => Ok(NiriReply {
                value,
                transport: TRANSPORT_SOCKET,
            }),
            Err(socket_error) => Err(anyhow!(
                "niri {} failed: {cli_error:#} (the direct niri IPC fallback also failed: {socket_error:#})",
                cli_args.join(" ")
            )),
        },
    }
}

fn cli_value(cli_args: &[&str], key: &str) -> Result<Value> {
    let output = niri_cli(cli_args)?;
    if !output.status.success() {
        bail!("{}", command_detail(&output));
    }
    parse_reply(&String::from_utf8_lossy(&output.stdout), key)
}

fn cli_action(cli_args: &[&str]) -> Result<()> {
    let output = niri_cli(cli_args)?;
    if !output.status.success() {
        bail!("{}", command_detail(&output));
    }
    Ok(())
}

fn socket_value(request: &str, key: &str) -> Result<Value> {
    parse_reply(&socket_request(request)?, key)
}

fn niri_cli(cli_args: &[&str]) -> Result<std::process::Output> {
    let mut command = StdCommand::new("niri");
    command
        .args(cli_args)
        .env("NIRI_SOCKET", niri_socket_path()?);
    command_runner::output_blocking(&mut command, "run niri msg")
}

fn command_detail(output: &std::process::Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let detail = if stderr.is_empty() {
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    } else {
        stderr
    };
    if detail.is_empty() {
        format!("exit status {}", output.status)
    } else {
        detail
    }
}

/// Send one JSON request over the niri IPC socket and return the raw reply.
fn socket_request(request: &str) -> Result<String> {
    socket_request_at(&niri_socket_path()?, request)
}

fn socket_request_at(path: &Path, request: &str) -> Result<String> {
    let mut stream = UnixStream::connect(path).with_context(|| {
        format!(
            "failed to connect to the niri IPC socket {}",
            path.display()
        )
    })?;
    stream.set_read_timeout(Some(NIRI_IPC_TIMEOUT))?;
    stream.set_write_timeout(Some(NIRI_IPC_TIMEOUT))?;
    writeln!(stream, "{request}").context("failed to send the niri IPC request")?;

    // Replies are newline-delimited. The server may keep the connection open.
    read_ipc_reply(stream)
}

fn read_ipc_reply(reader: impl Read) -> Result<String> {
    let mut reply = String::new();
    BufReader::new(reader.take(MAX_IPC_REPLY_BYTES + 1))
        .read_line(&mut reply)
        .context("failed to read the niri IPC reply")?;
    if reply.len() as u64 > MAX_IPC_REPLY_BYTES {
        bail!("niri IPC reply exceeds the size limit");
    }
    if !reply.ends_with('\n') {
        bail!("niri IPC connection closed before a complete reply");
    }
    Ok(reply)
}

/// Unwrap a niri reply.
///
/// The socket wraps every answer as `{"Ok": <payload>}` or `{"Err": "..."}`
/// with the payload nested under a request-named key (`{"Windows": [...]}`),
/// while `niri msg --json` prints only the bare payload. Both shapes normalise
/// to the payload here.
fn parse_reply(raw: &str, key: &str) -> Result<Value> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        bail!("the niri IPC reply was empty");
    }
    let value: Value = serde_json::from_str(trimmed).context("invalid niri JSON reply")?;
    if value.get("Ok").is_none() && value.get("Err").is_none() {
        return Ok(value); // Bare CLI payload.
    }
    let result: std::result::Result<Value, String> =
        serde_json::from_value(value).context("invalid niri IPC reply envelope")?;
    let mut payload = result.map_err(|error| anyhow!("niri IPC returned an error: {error}"))?;
    payload
        .as_object_mut()
        .and_then(|map| map.remove(key))
        .with_context(|| format!("niri IPC reply does not contain {key}"))
}

/// Validate the reply to an `Action` request.
fn ensure_socket_action_succeeded(request: &str, reply: &str) -> Result<()> {
    let result: std::result::Result<String, String> =
        serde_json::from_str(reply).context("invalid niri IPC action reply")?;
    match result {
        Ok(response) if response == "Handled" => Ok(()),
        Ok(response) => bail!("unexpected niri IPC action response: {response}"),
        Err(error) => bail!("niri IPC returned an error for {request}: {error}"),
    }
}

/// An explicit socket is authoritative, even if stale. Never silently switch
/// sessions when it fails. Discovery requires an unambiguous matching socket.
fn niri_socket_path() -> Result<PathBuf> {
    if let Some(value) = std::env::var_os("NIRI_SOCKET") {
        let path = PathBuf::from(value);
        if !is_socket(&path) {
            bail!(
                "NIRI_SOCKET does not identify a Unix socket: {}",
                path.display()
            );
        }
        return Ok(path);
    }
    let runtime = xdg_runtime_dir().context("cannot determine XDG_RUNTIME_DIR")?;
    let display = std::env::var_os("WAYLAND_DISPLAY");
    // WAYLAND_DISPLAY may be an absolute socket path.
    let display = display
        .as_deref()
        .and_then(|value| Path::new(value).file_name());
    let display = display.and_then(|value| value.to_str());
    let display = display
        .filter(|value| !value.is_empty())
        .context("NIRI_SOCKET and WAYLAND_DISPLAY are unset; cannot identify the niri session")?;
    infer_niri_socket_path(&runtime, display)
}

fn infer_niri_socket_path(runtime: &Path, display: &str) -> Result<PathBuf> {
    let candidates = fs::read_dir(runtime)
        .context("cannot read the niri socket directory")?
        .filter_map(|entry| {
            let path = entry.ok()?.path();
            let name = path.file_name()?.to_str()?;
            let stem = name.strip_prefix("niri.")?.strip_suffix(".sock")?;
            if !is_socket(&path) || !niri_socket_name_matches_display(stem, display) {
                return None;
            }
            Some(path)
        })
        .collect::<Vec<_>>();
    match candidates.as_slice() {
        [path] => Ok(path.clone()),
        [] => bail!("no niri IPC socket matches this session; export NIRI_SOCKET"),
        _ => bail!("multiple niri IPC sockets match this session; export NIRI_SOCKET"),
    }
}

fn is_socket(path: &Path) -> bool {
    fs::metadata(path)
        .map(|metadata| metadata.file_type().is_socket())
        .unwrap_or(false)
}

/// Match either the legacy name or a numeric PID suffix, never another display.
fn niri_socket_name_matches_display(stem: &str, display: &str) -> bool {
    stem == display
        || stem
            .strip_prefix(display)
            .and_then(|rest| rest.strip_prefix('.'))
            .is_some_and(|pid| !pid.is_empty() && pid.bytes().all(|byte| byte.is_ascii_digit()))
}

fn xdg_runtime_dir() -> Option<PathBuf> {
    if let Some(value) = std::env::var_os("XDG_RUNTIME_DIR") {
        return Some(PathBuf::from(value));
    }
    let uid = fs::metadata("/proc/self").ok()?.uid();
    Some(PathBuf::from(format!("/run/user/{uid}")))
}

#[derive(Debug, Deserialize)]
struct NiriWindow {
    id: u64,
    title: Option<String>,
    app_id: Option<String>,
    pid: Option<i64>,
    workspace_id: Option<u64>,
    #[serde(default)]
    is_focused: bool,
    #[serde(default)]
    is_minimized: bool,
    #[serde(default)]
    layout: Option<NiriWindowLayout>,
}

#[derive(Debug, Deserialize)]
struct NiriWindowLayout {
    window_size: Option<[f64; 2]>,
    tile_size: Option<[f64; 2]>,
    /// Position inside the workspace view, in logical coordinates. niri leaves
    /// this `null` when it cannot supply a rendered position.
    tile_pos_in_workspace_view: Option<[f64; 2]>,
    window_offset_in_tile: Option<[f64; 2]>,
}

#[derive(Debug, Deserialize)]
struct NiriOutput {
    logical: Option<NiriOutputLogical>,
}

#[derive(Debug, Deserialize)]
struct NiriOutputLogical {
    x: i32,
    y: i32,
    scale: f64,
}

#[derive(Debug, Deserialize)]
struct NiriMonitorOutput {
    logical: Option<NiriMonitorLogical>,
}

#[derive(Debug, Deserialize)]
struct NiriMonitorLogical {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    scale: f64,
}

/// Logical geometry of one output.
#[derive(Debug, Clone, Copy, PartialEq)]
struct NiriOutputGeometry {
    x: i32,
    y: i32,
    scale: f64,
}

#[derive(Debug, Deserialize)]
struct NiriWorkspace {
    id: u64,
    output: Option<String>,
}

impl NiriWindow {
    fn workspace_view_position(&self) -> Option<[f64; 2]> {
        let layout = self.layout.as_ref()?;
        let [x, y] = layout.tile_pos_in_workspace_view?;
        // niri reports the tile offset alongside a size. A window that has a
        // size without an offset has no rendered position yet, so report none
        // rather than a guessed one.
        let [dx, dy] = if layout.window_size.is_some() {
            layout.window_offset_in_tile?
        } else {
            [0.0, 0.0]
        };
        Some([x + dx, y + dy])
    }

    /// Window size in niri's logical pixels, preferring the window's own size
    /// over the tile it sits in.
    fn logical_size(&self) -> Option<(f64, f64)> {
        let layout = self.layout.as_ref()?;
        let [width, height] = layout.window_size.or(layout.tile_size)?;
        Some((width, height))
    }

    fn into_window_info(self, layout: &NiriOutputLayout) -> WindowInfo {
        let bounds = self.logical_size().and_then(|(width, height)| {
            layout
                .capture?
                .window_bounds(layout.position(&self), width, height)
        });
        WindowInfo {
            window_id: self.id,
            title: self.title,
            app_id: self.app_id.clone(),
            wm_class: self.app_id,
            pid: self.pid.and_then(|pid| u32::try_from(pid).ok()),
            bounds,
            workspace: self
                .workspace_id
                .and_then(|workspace| i32::try_from(workspace).ok()),
            focused: self.is_focused,
            // Minimized windows are hidden from targeted actions.
            hidden: self.is_minimized,
            client_type: None,
            backend: NIRI_BACKEND.to_string(),
            terminal: None,
        }
    }
}

fn positive_dimension(value: f64) -> Option<u32> {
    if !value.is_finite() || value <= 0.0 {
        return None;
    }
    let rounded = value.round();
    if rounded < 1.0 || rounded > f64::from(u32::MAX) {
        return None;
    }
    Some(rounded as u32)
}

fn round_coordinate(value: f64) -> Option<i32> {
    if !value.is_finite() {
        return None;
    }
    let rounded = value.round();
    if rounded < f64::from(i32::MIN) || rounded > f64::from(i32::MAX) {
        return None;
    }
    Some(rounded as i32)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Trimmed capture of `niri msg --json windows` from a live niri 26.04
    /// session: a focused tiled window, a tile without a rendered position, and
    /// a minimized window with no workspace.
    const LIVE_WINDOWS: &str = r#"[
        {"id":41,"title":"dsh web ~","app_id":"com.mitchellh.ghostty","pid":159272,
         "workspace_id":6,"is_focused":false,"is_floating":false,"is_minimized":false,
         "is_urgent":false,"layout":{"pos_in_scrolling_layout":[1,1],
         "tile_size":[744.0,876.0],"window_size":[744,876],
         "tile_pos_in_workspace_view":null,"window_offset_in_tile":[0.0,0.0]}},
        {"id":48,"title":"Zen Browser","app_id":"zen","pid":194746,
         "workspace_id":6,"is_focused":true,"is_floating":false,"is_minimized":false,
         "is_urgent":false,"layout":{"pos_in_scrolling_layout":[2,1],
         "tile_size":[1536.0,908.0],"window_size":[1536,908],
         "tile_pos_in_workspace_view":null,"window_offset_in_tile":[0.0,0.0]}},
        {"id":37,"title":"notes.md","app_id":"dev.zed.Zed","pid":156824,
         "workspace_id":null,"is_focused":false,"is_floating":false,"is_minimized":true,
         "is_urgent":false,"layout":{"pos_in_scrolling_layout":null,
         "tile_size":[1536.0,908.0],"window_size":[1536,908],
         "tile_pos_in_workspace_view":null,"window_offset_in_tile":[0.0,0.0]}}
    ]"#;

    const LIVE_OUTPUTS: &str = r#"{
        "eDP-1":{"name":"eDP-1","logical":{"x":0,"y":0,"width":1536,"height":960,"scale":2.0}}
    }"#;

    const LIVE_WORKSPACES: &str = r#"[
        {"id":6,"idx":1,"name":null,"output":"eDP-1","is_active":true,"is_focused":true},
        {"id":7,"idx":2,"name":null,"output":null,"is_active":false,"is_focused":false}
    ]"#;

    fn parse_windows(json: &str, layout: &NiriOutputLayout) -> Vec<WindowInfo> {
        serde_json::from_str::<Vec<NiriWindow>>(json)
            .expect("windows fixture should parse")
            .into_iter()
            .map(|window| window.into_window_info(layout))
            .collect()
    }

    fn live_layout() -> NiriOutputLayout {
        let geometries =
            parse_output_geometries(&serde_json::from_str(LIVE_OUTPUTS).expect("outputs fixture"));
        NiriOutputLayout {
            capture: NiriCaptureLayout::from_outputs(&geometries),
            geometries,
            workspace_outputs: parse_workspace_outputs(
                &serde_json::from_str(LIVE_WORKSPACES).expect("workspaces fixture"),
            ),
        }
    }

    /// Build a layout from a units-scale set of outputs so position maths is
    /// readable in the tests that are not about scaling.
    fn layout_at_unit_scale(
        geometries: &[(&str, i32, i32)],
        workspaces: &[(u64, &str)],
    ) -> NiriOutputLayout {
        let geometries = geometries
            .iter()
            .map(|(name, x, y)| {
                (
                    (*name).to_string(),
                    NiriOutputGeometry {
                        x: *x,
                        y: *y,
                        scale: 1.0,
                    },
                )
            })
            .collect::<BTreeMap<_, _>>();
        NiriOutputLayout {
            capture: NiriCaptureLayout::from_outputs(&geometries),
            geometries,
            workspace_outputs: workspaces
                .iter()
                .map(|(id, output)| (*id, (*output).to_string()))
                .collect(),
        }
    }

    #[test]
    fn reads_id_app_id_pid_focus_and_size_from_a_live_capture() {
        let windows = parse_windows(LIVE_WINDOWS, &live_layout());
        assert_eq!(
            windows
                .iter()
                .map(|window| window.window_id)
                .collect::<Vec<_>>(),
            [41, 48, 37]
        );

        let zen = &windows[1];
        assert_eq!(zen.app_id.as_deref(), Some("zen"));
        assert_eq!(zen.title.as_deref(), Some("Zen Browser"));
        assert_eq!(zen.pid, Some(194746));
        assert!(zen.focused);
        assert_eq!(zen.workspace, Some(6));
        assert_eq!(zen.backend, NIRI_BACKEND);

        // niri reports logical 1536x908; the 2x output is captured as device
        // pixels, so the bounds must describe a 3072x1816 rect.
        let bounds = zen.bounds.as_ref().expect("size is always reported");
        assert_eq!((bounds.width, bounds.height), (3072, 1816));
    }

    #[test]
    fn scales_logical_geometry_into_the_screenshot_coordinate_space() {
        // Regression guard: `computer-use-linux screenshot` reports
        // coordinate_width/height 3072x1920 for this 1536x960 logical output.
        // Unscaled logical bounds would crop at half the intended size.
        let layout = live_layout();
        assert_eq!(layout.capture.unwrap().scale, 2.0);

        let windows = parse_windows(
            r#"[{"id":1,"app_id":"a","workspace_id":6,
                 "layout":{"window_size":[1536,908],"window_offset_in_tile":[0.0,0.0],"tile_pos_in_workspace_view":[10.0,20.0]}}]"#,
            &layout,
        );
        let bounds = windows[0].bounds.as_ref().unwrap();
        assert_eq!((bounds.width, bounds.height), (3072, 1816));
        assert_eq!((bounds.x, bounds.y), (Some(20), Some(40)));
    }

    #[test]
    fn omits_bounds_when_the_output_scale_is_unknown() {
        let windows = parse_windows(LIVE_WINDOWS, &NiriOutputLayout::default());
        assert!(windows.iter().all(|window| window.bounds.is_none()));
    }

    #[test]
    fn keeps_position_null_while_niri_does_not_render_the_workspace_view() {
        // Every window in the live capture has tile_pos_in_workspace_view null,
        // even the focused one; bounds must degrade to size-only, not to zero.
        let windows = parse_windows(LIVE_WINDOWS, &live_layout());
        for window in &windows {
            let bounds = window.bounds.as_ref().expect("size is always reported");
            assert_eq!(bounds.x, None, "window {} reported x", window.window_id);
            assert_eq!(bounds.y, None, "window {} reported y", window.window_id);
        }
    }

    #[test]
    fn offsets_a_rendered_position_by_its_output_origin() {
        let layout = layout_at_unit_scale(
            &[("eDP-1", 0, 0), ("HDMI-A-1", 1920, 180)],
            &[(6, "eDP-1"), (9, "HDMI-A-1")],
        );
        let json = r#"[
            {"id":1,"app_id":"a","workspace_id":6,
             "layout":{"window_size":[800,600],"window_offset_in_tile":[0.0,0.0],"tile_pos_in_workspace_view":[100.4,49.6]}},
            {"id":2,"app_id":"b","workspace_id":9,
             "layout":{"window_size":[800,600],"window_offset_in_tile":[0.0,0.0],"tile_pos_in_workspace_view":[10.0,20.0]}},
            {"id":3,"app_id":"c","workspace_id":null,
             "layout":{"window_size":[800,600],"window_offset_in_tile":[0.0,0.0],"tile_pos_in_workspace_view":[10.0,20.0]}}
        ]"#;
        let windows = parse_windows(json, &layout);

        let first = windows[0].bounds.as_ref().unwrap();
        assert_eq!((first.x, first.y), (Some(100), Some(50)));
        let second = windows[1].bounds.as_ref().unwrap();
        assert_eq!((second.x, second.y), (Some(1930), Some(200)));
        // No workspace means the output is unknown, so a reported view position
        // cannot be promoted to a desktop coordinate.
        let third = windows[2].bounds.as_ref().unwrap();
        assert_eq!((third.x, third.y), (None, None));
    }

    #[test]
    fn rebases_the_y_axis_by_its_own_origin() {
        // Guards against subtracting origin_x from the y axis: both axes are
        // mapped by the same helper, so the origin has to be passed per axis.
        let layout = layout_at_unit_scale(
            &[("eDP-1", 0, 100), ("HDMI-A-1", 0, 300)],
            &[(6, "eDP-1"), (9, "HDMI-A-1")],
        );
        assert_eq!(layout.capture.unwrap().origin_y, 100);

        let json = r#"[
            {"id":1,"app_id":"a","workspace_id":6,
             "layout":{"window_size":[800,600],"window_offset_in_tile":[0.0,0.0],"tile_pos_in_workspace_view":[10.0,20.0]}},
            {"id":2,"app_id":"b","workspace_id":9,
             "layout":{"window_size":[800,600],"window_offset_in_tile":[0.0,0.0],"tile_pos_in_workspace_view":[10.0,20.0]}}
        ]"#;
        let windows = parse_windows(json, &layout);

        let first = windows[0].bounds.as_ref().unwrap();
        assert_eq!((first.x, first.y), (Some(10), Some(20)));
        // output y 300 + local 20 - capture origin 100 = 220.
        let second = windows[1].bounds.as_ref().unwrap();
        assert_eq!((second.x, second.y), (Some(10), Some(220)));
    }

    #[test]
    fn falls_back_to_the_tile_size_when_window_size_is_missing() {
        let json = r#"[
            {"id":1,"app_id":"a","layout":{"tile_size":[1200.6,700.2]}},
            {"id":2,"app_id":"b","layout":{"tile_size":[0.0,700.0]}},
            {"id":3,"app_id":"c"},
            {"id":4,"app_id":"d","layout":{"window_size":[800,600],"tile_size":[1.0,1.0]}}
        ]"#;
        let windows = parse_windows(json, &layout_at_unit_scale(&[("eDP-1", 0, 0)], &[]));

        let bounds = windows[0].bounds.as_ref().unwrap();
        assert_eq!((bounds.width, bounds.height), (1201, 700));
        // A zero dimension is not a usable rect, so bounds are omitted entirely.
        assert!(windows[1].bounds.is_none());
        assert!(windows[2].bounds.is_none());
        // window_size wins over tile_size.
        assert_eq!(windows[3].bounds.as_ref().unwrap().width, 800);
    }

    #[test]
    fn a_minimized_window_is_hidden_and_loses_its_workspace() {
        let windows = parse_windows(LIVE_WINDOWS, &live_layout());
        let zed = &windows[2];
        assert!(zed.hidden, "is_minimized should map to hidden");
        assert_eq!(zed.workspace, None);
        assert!(!zed.focused);
        assert!(!windows[1].hidden);
    }

    #[test]
    fn parses_both_the_socket_envelope_and_the_bare_cli_payload() {
        let socket_reply = r#"{"Ok":{"Windows":[{"id":41}]}}"#;
        let cli_payload = r#"[{"id":41}]"#;
        let expected = serde_json::json!([{"id":41}]);

        assert_eq!(parse_reply(socket_reply, "Windows").unwrap(), expected);
        assert_eq!(parse_reply(cli_payload, "Windows").unwrap(), expected);
        // niri terminates socket replies with a newline.
        assert_eq!(
            parse_reply(&format!("{socket_reply}\n"), "Windows").unwrap(),
            expected
        );
    }

    #[test]
    fn surfaces_the_error_envelope_that_niri_returns_for_bad_requests() {
        let error = parse_reply(r#"{"Err":"error parsing request"}"#, "Windows")
            .expect_err("an Err envelope must not parse as a window list");
        assert!(format!("{error:#}").contains("error parsing request"));

        assert!(parse_reply("   ", "Windows").is_err());
        assert!(parse_reply("not json", "Windows").is_err());
    }

    #[test]
    fn tolerates_actions_that_niri_answers_with_handled() {
        assert!(ensure_socket_action_succeeded("focus", r#"{"Ok":"Handled"}"#).is_ok());
        for reply in [
            "",
            "not json",
            "{}",
            r#"{"Ok":"Unknown"}"#,
            r#"{"Ok":null}"#,
        ] {
            assert!(
                ensure_socket_action_succeeded("focus", reply).is_err(),
                "{reply}"
            );
        }
        assert!(ensure_socket_action_succeeded(
            "focus",
            r#"{"Err":"cannot focus: no such window"}"#
        )
        .is_err());
    }

    #[test]
    fn parses_output_geometries_and_ignores_outputs_without_logical_geometry() {
        let geometries = parse_output_geometries(
            &serde_json::from_str(
                r#"{
                    "eDP-1":{"logical":{"x":0,"y":0,"width":1536,"height":960,"scale":2.0}},
                    "HDMI-A-1":{"logical":{"x":-1920,"y":100,"width":1920,"height":1080,"scale":1.0}},
                    "DP-1":{"name":"DP-1"}
                }"#,
            )
            .unwrap(),
        );
        let edp = geometries.get("eDP-1").expect("eDP-1 should be parsed");
        assert_eq!((edp.x, edp.y, edp.scale), (0, 0, 2.0));
        let hdmi = geometries
            .get("HDMI-A-1")
            .expect("HDMI-A-1 should be parsed");
        assert_eq!((hdmi.x, hdmi.y, hdmi.scale), (-1920, 100, 1.0));
        assert_eq!(geometries.get("DP-1"), None);
    }

    #[test]
    fn only_uniform_valid_output_scales_produce_bounds() {
        for scale in [0.0, -1.0, 1.25, 2.0] {
            let geometries = parse_output_geometries(&serde_json::json!({
                "A":{"logical":{"x":0,"y":100,"scale":2.0}},
                "B":{"logical":{"x":-1920,"y":0,"scale":scale}}
            }));
            let capture = NiriCaptureLayout::from_outputs(&geometries);
            if scale == 2.0 {
                let capture = capture.unwrap();
                assert_eq!(
                    (capture.origin_x, capture.origin_y, capture.scale),
                    (-1920, 0, 2.0)
                );
            } else {
                assert!(capture.is_none());
            }
        }
        assert!(NiriCaptureLayout::from_outputs(&BTreeMap::new()).is_none());
        assert!(
            parse_output_geometries(&serde_json::json!({"A":{"logical":{"x":0,"y":0}}})).is_empty()
        );
    }

    #[test]
    fn socket_names_require_an_exact_display_and_numeric_pid() {
        for name in ["wayland-1", "wayland-1.5081"] {
            assert!(niri_socket_name_matches_display(name, "wayland-1"));
        }
        for name in ["wayland-10.99", "wayland-2", "wayland-1.", "wayland-1.fake"] {
            assert!(!niri_socket_name_matches_display(name, "wayland-1"));
        }
    }

    #[test]
    fn parses_workspace_outputs_and_ignores_detached_workspaces() {
        let outputs = parse_workspace_outputs(&serde_json::from_str(LIVE_WORKSPACES).unwrap());
        assert_eq!(outputs.get(&6).map(String::as_str), Some("eDP-1"));
        assert_eq!(outputs.get(&7), None);
    }

    struct TempDir(PathBuf);
    impl TempDir {
        /// A directory for sockets no longer than `deepest`.
        fn new(deepest: &str) -> Self {
            let mut random = [0u8; 8];
            getrandom::fill(&mut random).unwrap();
            let path = crate::test_sockets::socket_fixture(
                &format!("niri-test-{}", u64::from_ne_bytes(random)),
                deepest,
            );
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn discovery_refuses_other_sessions_and_ambiguous_sockets() {
        use std::os::unix::net::UnixListener;
        let dir = TempDir::new("niri.wayland-10.12.sock");
        let other = dir.0.join("niri.wayland-10.12.sock");
        let _other = UnixListener::bind(&other).unwrap();
        assert!(infer_niri_socket_path(&dir.0, "wayland-1").is_err());
        let own = dir.0.join("niri.wayland-1.34.sock");
        let _own = UnixListener::bind(&own).unwrap();
        assert_eq!(infer_niri_socket_path(&dir.0, "wayland-1").unwrap(), own);
        fs::write(dir.0.join("niri.wayland-1.56.sock"), "not a socket").unwrap();
        assert_eq!(infer_niri_socket_path(&dir.0, "wayland-1").unwrap(), own);
        let _duplicate = UnixListener::bind(dir.0.join("niri.wayland-1.78.sock")).unwrap();
        assert!(infer_niri_socket_path(&dir.0, "wayland-1").is_err());
    }

    #[test]
    fn uses_the_window_offset_for_decorated_or_centered_windows() {
        let windows = parse_windows(
            r#"[{"id":1,"workspace_id":6,"layout":{
            "window_size":[100,80],"tile_pos_in_workspace_view":[10,20],
            "window_offset_in_tile":[3,5]}}]"#,
            &live_layout(),
        );
        let bounds = windows[0].bounds.as_ref().unwrap();
        assert_eq!(
            (bounds.x, bounds.y, bounds.width, bounds.height),
            (Some(26), Some(50), 200, 160)
        );
        let windows = parse_windows(
            r#"[{"id":1,"workspace_id":6,"layout":{
            "window_size":[100,80],"tile_pos_in_workspace_view":[10,20]}}]"#,
            &live_layout(),
        );
        assert_eq!(windows[0].bounds.as_ref().unwrap().x, None);
    }

    #[test]
    fn dimensions_must_still_be_positive_after_rounding() {
        for value in [
            0.0,
            0.1,
            -1.0,
            f64::NAN,
            f64::INFINITY,
            f64::from(u32::MAX) + 1.0,
        ] {
            assert_eq!(positive_dimension(value), None);
        }
        assert_eq!(positive_dimension(0.5), Some(1));
    }

    #[test]
    fn socket_reads_a_complete_line_without_waiting_for_eof() {
        use std::os::unix::net::UnixListener;
        let dir = TempDir::new("niri.sock");
        let path = dir.0.join("niri.sock");
        let listener = UnixListener::bind(&path).unwrap();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = String::new();
            BufReader::new(stream.try_clone().unwrap())
                .read_line(&mut request)
                .unwrap();
            assert_eq!(request, "\"Windows\"\n");
            stream.write_all(b"{\"Ok\":{\"Windows\":[]}}\n").unwrap();
            let _ = release_rx.recv_timeout(Duration::from_secs(4));
        });
        let reply = socket_request_at(&path, WINDOWS_REQUEST);
        release_tx.send(()).unwrap();
        server.join().unwrap();
        assert_eq!(
            parse_reply(&reply.unwrap(), "Windows").unwrap(),
            serde_json::json!([])
        );
    }

    #[test]
    fn socket_rejects_truncated_and_oversized_replies() {
        use std::os::unix::net::UnixListener;
        for response in [
            String::new(),
            "{}".to_string(),
            "x".repeat(MAX_IPC_REPLY_BYTES as usize + 1),
        ] {
            let dir = TempDir::new("niri.sock");
            let path = dir.0.join("niri.sock");
            let listener = UnixListener::bind(&path).unwrap();
            let server = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = String::new();
                BufReader::new(stream.try_clone().unwrap())
                    .read_line(&mut request)
                    .unwrap();
                let _ = stream.write_all(response.as_bytes());
            });
            assert!(socket_request_at(&path, WINDOWS_REQUEST).is_err());
            server.join().unwrap();
        }
    }
    #[test]
    fn reads_only_the_first_newline_delimited_reply() {
        let reply = read_ipc_reply(&b"{\"Ok\":{\"Windows\":[]}}\nsecond line\n"[..]).unwrap();
        assert_eq!(
            parse_reply(&reply, "Windows").unwrap(),
            serde_json::json!([])
        );
    }

    #[test]
    fn rejects_incomplete_oversized_and_invalid_utf8_lines() {
        for response in [
            vec![],
            b"{}".to_vec(),
            vec![b'x'; MAX_IPC_REPLY_BYTES as usize + 1],
            vec![0xff, b'\n'],
        ] {
            assert!(read_ipc_reply(response.as_slice()).is_err());
        }
    }

    #[test]
    fn rejects_wrong_or_malformed_socket_envelopes() {
        for response in [
            r#"{"Ok":{"Outputs":{}}}"#,
            r#"{"Ok":"Handled"}"#,
            r#"{"Err":null}"#,
            r#"{"Ok":{},"Err":"failure"}"#,
        ] {
            assert!(parse_reply(response, "Windows").is_err(), "{response}");
        }
    }

    #[test]
    fn parses_the_logical_monitor_layout_for_portal_pointer_mapping() {
        let outputs: Value = serde_json::from_str(
            r#"{
                "eDP-1":{"logical":{"x":0,"y":0,"width":1920,"height":1080,"scale":2.0,"transform":"Normal"}},
                "DP-1":{"logical":{"x":1920,"y":0,"width":2560,"height":1440,"scale":1.0,"transform":"Normal"}},
                "HDMI-A-1":{"logical":null}
            }"#,
        )
        .unwrap();

        let layout = parse_monitor_layout(&outputs).expect("niri layout should parse");

        let mut monitors = layout
            .iter()
            .map(|monitor| {
                (
                    monitor.x,
                    monitor.y,
                    monitor.width,
                    monitor.height,
                    monitor.scale,
                )
            })
            .collect::<Vec<_>>();
        monitors.sort_by_key(|monitor| monitor.0);
        assert_eq!(
            monitors,
            [(0, 0, 1920, 1080, 2.0), (1920, 0, 2560, 1440, 1.0)]
        );
    }

    #[test]
    fn rejects_a_monitor_layout_with_an_unusable_output() {
        for outputs in [
            r#"{
                "eDP-1":{"logical":{"x":0,"y":0,"width":1920,"height":1080,"scale":1.0}},
                "DP-1":{"logical":{"x":1920,"y":0,"width":1920,"height":1080,"scale":0.0}}
            }"#,
            r#"{"eDP-1":{"logical":{"x":0,"y":0,"width":0,"height":1080,"scale":1.0}}}"#,
            r#"{"eDP-1":{"logical":null}}"#,
            r#"{}"#,
        ] {
            let outputs: Value = serde_json::from_str(outputs).unwrap();
            assert!(parse_monitor_layout(&outputs).is_none(), "{outputs}");
        }
    }
}
