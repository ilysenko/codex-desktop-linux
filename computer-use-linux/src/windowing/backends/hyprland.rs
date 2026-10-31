use crate::command_runner;
use crate::terminal::enrich_terminal_windows;
use crate::windowing::registry::BackendProbe;
use crate::windowing::types::{WindowBounds, WindowInfo};
use anyhow::{bail, Context, Result};
use serde::Deserialize;
use std::fs;
use std::os::unix::fs::{FileTypeExt, MetadataExt};
use std::path::{Path, PathBuf};
use std::process::Command as StdCommand;
use std::time::SystemTime;
use tokio::process::Command;

pub const HYPRLAND_BACKEND: &str = "hyprland";

pub fn probe() -> BackendProbe {
    match hyprctl_output(&["clients", "-j"]) {
        Ok(output) if output.status.success() => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let ok = matches!(
                serde_json::from_str::<serde_json::Value>(&stdout),
                Ok(serde_json::Value::Array(_))
            );
            BackendProbe {
                id: HYPRLAND_BACKEND,
                ok,
                can_list_windows: ok,
                can_focus_apps: ok,
                can_focus_windows: ok,
                detail: if ok {
                    "hyprctl clients -j returned a JSON array".to_string()
                } else {
                    "hyprctl clients -j did not return a JSON array".to_string()
                },
            }
        }
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            BackendProbe {
                id: HYPRLAND_BACKEND,
                ok: false,
                can_list_windows: false,
                can_focus_apps: false,
                can_focus_windows: false,
                detail: if stderr.is_empty() { stdout } else { stderr },
            }
        }
        Err(error) => BackendProbe {
            id: HYPRLAND_BACKEND,
            ok: false,
            can_list_windows: false,
            can_focus_apps: false,
            can_focus_windows: false,
            detail: error.to_string(),
        },
    }
}

pub async fn list_windows() -> Result<Vec<WindowInfo>> {
    let output = hyprctl_output_async(&["clients", "-j"])
        .await
        .context("failed to run hyprctl clients -j")?;
    if !output.status.success() {
        bail!(
            "hyprctl clients -j failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }

    let clients_json = String::from_utf8_lossy(&output.stdout);
    let monitors_output = hyprctl_output_async(&["monitors", "-j"]).await.ok();
    match monitors_output.filter(|output| output.status.success()) {
        Some(monitors) => parse_hyprland_clients_with_monitors(&clients_json, &monitors.stdout),
        None => parse_hyprland_clients_without_bounds(&clients_json),
    }
}

fn parse_hyprland_clients_with_monitors(
    clients_json: &str,
    monitors_json: &[u8],
) -> Result<Vec<WindowInfo>> {
    let mut clients: Vec<HyprlandClient> =
        serde_json::from_str(clients_json).context("failed to parse hyprctl clients -j output")?;
    let Ok(monitors) = serde_json::from_slice::<Vec<HyprlandMonitor>>(monitors_json) else {
        clear_hyprland_client_bounds(&mut clients);
        return windows_from_hyprland_clients(clients);
    };
    let Some(layout) = HyprlandCaptureLayout::from_monitors(&monitors) else {
        clear_hyprland_client_bounds(&mut clients);
        return windows_from_hyprland_clients(clients);
    };
    let monitor_ids = monitors
        .iter()
        .map(|monitor| monitor.id)
        .collect::<std::collections::HashSet<_>>();
    for client in &mut clients {
        if !client
            .monitor
            .is_some_and(|monitor_id| monitor_ids.contains(&monitor_id))
        {
            client.at = None;
            client.size = None;
            continue;
        }
        let Some((at, size)) = client
            .at
            .zip(client.size)
            .and_then(|(at, size)| layout.map_bounds(at, size))
        else {
            client.at = None;
            client.size = None;
            continue;
        };
        client.at = Some(at);
        client.size = Some(size);
    }
    windows_from_hyprland_clients(clients)
}

#[cfg(test)]
pub(crate) fn parse_hyprland_clients(json: &str) -> Result<Vec<WindowInfo>> {
    let clients: Vec<HyprlandClient> =
        serde_json::from_str(json).context("failed to parse hyprctl clients -j output")?;
    windows_from_hyprland_clients(clients)
}

fn parse_hyprland_clients_without_bounds(json: &str) -> Result<Vec<WindowInfo>> {
    let mut clients: Vec<HyprlandClient> =
        serde_json::from_str(json).context("failed to parse hyprctl clients -j output")?;
    clear_hyprland_client_bounds(&mut clients);
    windows_from_hyprland_clients(clients)
}

fn clear_hyprland_client_bounds(clients: &mut [HyprlandClient]) {
    for client in clients {
        client.at = None;
        client.size = None;
    }
}

#[derive(Debug, Clone, Copy)]
struct HyprlandCaptureLayout {
    origin_x: i32,
    origin_y: i32,
    scale: f64,
}

impl HyprlandCaptureLayout {
    fn from_monitors(monitors: &[HyprlandMonitor]) -> Option<Self> {
        let first = monitors.first()?;
        if monitors
            .iter()
            .any(|monitor| !monitor.scale.is_finite() || monitor.scale <= 0.0)
        {
            return None;
        }
        Some(Self {
            origin_x: monitors
                .iter()
                .map(|monitor| monitor.x)
                .min()
                .unwrap_or(first.x),
            origin_y: monitors
                .iter()
                .map(|monitor| monitor.y)
                .min()
                .unwrap_or(first.y),
            scale: monitors
                .iter()
                .map(|monitor| monitor.scale)
                .fold(first.scale, f64::max),
        })
    }

    fn map_bounds(&self, at: [i32; 2], size: [u32; 2]) -> Option<([i32; 2], [u32; 2])> {
        if size[0] == 0 || size[1] == 0 {
            return None;
        }
        let left = ((i64::from(at[0]) - i64::from(self.origin_x)) as f64 * self.scale).floor();
        let top = ((i64::from(at[1]) - i64::from(self.origin_y)) as f64 * self.scale).floor();
        let right = ((i64::from(at[0]) + i64::from(size[0]) - i64::from(self.origin_x)) as f64
            * self.scale)
            .ceil();
        let bottom = ((i64::from(at[1]) + i64::from(size[1]) - i64::from(self.origin_y)) as f64
            * self.scale)
            .ceil();
        if !left.is_finite()
            || !top.is_finite()
            || !right.is_finite()
            || !bottom.is_finite()
            || left < f64::from(i32::MIN)
            || left > f64::from(i32::MAX)
            || top < f64::from(i32::MIN)
            || top > f64::from(i32::MAX)
            || right <= left
            || bottom <= top
            || right - left > f64::from(u32::MAX)
            || bottom - top > f64::from(u32::MAX)
        {
            return None;
        }
        Some((
            [left as i32, top as i32],
            [(right - left) as u32, (bottom - top) as u32],
        ))
    }
}

fn windows_from_hyprland_clients(clients: Vec<HyprlandClient>) -> Result<Vec<WindowInfo>> {
    let mut windows = clients
        .into_iter()
        .filter(|client| client.mapped.unwrap_or(true))
        .map(WindowInfo::try_from)
        .collect::<Result<Vec<_>>>()?;
    windows.sort_by_key(|window| window.window_id);
    enrich_terminal_windows(&mut windows);
    Ok(windows)
}

pub async fn activate_window(window_id: u64) -> Result<()> {
    let address = format!("address:0x{window_id:x}");
    let lua_dispatch = lua_focus_dispatch(&address);
    let lua_output = hyprctl_output_async(&["dispatch", &lua_dispatch])
        .await
        .with_context(|| format!("failed to run Hyprland Lua focus dispatcher for {address}"))?;
    if dispatch_succeeded(&lua_output) {
        return Ok(());
    }

    let legacy_output = hyprctl_output_async(&["dispatch", "focuswindow", &address])
        .await
        .with_context(|| format!("failed to run hyprctl dispatch focuswindow {address}"))?;
    if dispatch_succeeded(&legacy_output) {
        Ok(())
    } else {
        bail!(
            "Hyprland window focus failed for {address}; Lua dispatcher: {}; legacy dispatcher: {}",
            command_detail(&lua_output),
            command_detail(&legacy_output)
        );
    }
}

/// Sends key presses to a window without focusing it, through Hyprland's
/// `send_key_state` dispatcher. Every press is a down and an up event; all
/// events go in one `[[BATCH]]` socket request per chunk. A failure after
/// any key arrived says how many did, so the caller does not resend them.
pub async fn send_key_events(
    window_id: u64,
    presses: &[crate::hyprland_input::KeyPress],
) -> Result<()> {
    const PRESSES_PER_BATCH: usize = 64;
    let address = format!("address:0x{window_id:x}");
    let total = presses.len();
    let mut delivered = 0;
    for chunk in presses.chunks(PRESSES_PER_BATCH) {
        let batch = chunk
            .iter()
            .flat_map(|press| {
                ["down", "up"].map(|state| {
                    format!(
                        "dispatch hl.dsp.send_key_state({{ mods = \"{}\", key = \"{}\", state = \"{state}\", window = \"{address}\" }})",
                        press.mods, press.key
                    )
                })
            })
            .collect::<Vec<_>>()
            .join(" ; ");
        let stream = match socket_connect().await {
            Ok(stream) => stream,
            Err(error) if delivered == 0 => {
                return Err(error.context("No keys were sent: could not reach the Hyprland socket"))
            }
            Err(error) => bail!(
                "Hyprland send_key_state stopped for {address}: {delivered} of {total} key presses were delivered, the rest were not sent. Inspect the target before retrying, and send only the remainder: {error:#}"
            ),
        };
        let reply = match socket_exchange(stream, &format!("[[BATCH]]{batch}")).await {
            Ok(reply) => reply,
            Err(error) => bail!(
                "Hyprland send_key_state failed for {address}: {delivered} of {total} key presses were delivered, and up to {} more may have been. Inspect the target before retrying: {error:#}",
                chunk.len()
            ),
        };
        // Hyprland runs a batch in order and answers each dispatch. Only a
        // complete answer says what ran: an empty or short reply (the stream
        // closed early) or an ok after an error leaves the batch uncertain.
        let expected = chunk.len() * 2;
        let replies = if reply.trim().is_empty() {
            Vec::new()
        } else {
            reply.split("\n\n\n").map(str::trim).collect::<Vec<_>>()
        };
        let first_error = replies.iter().position(|reply| *reply != "ok");
        let exact = replies.len() == expected
            && first_error.is_none_or(|at| replies[at..].iter().all(|reply| *reply != "ok"));
        if !exact {
            bail!(
                "Hyprland send_key_state failed for {address}: {delivered} of {total} key presses were confirmed, and up to {} more may have been delivered (Hyprland answered {} of {expected} dispatches). Inspect the target before retrying: {}",
                chunk.len(),
                replies.len(),
                reply.trim()
            );
        }
        if let Some(accepted) = first_error {
            let done = delivered + accepted / 2;
            if done == 0 && accepted == 0 {
                bail!(
                    "No keys were sent: Hyprland send_key_state refused {address}: {}",
                    reply.trim()
                );
            }
            let held = if accepted % 2 == 1 {
                " The last key went down without its release."
            } else {
                ""
            };
            bail!(
                "Hyprland send_key_state stopped for {address}: {done} of {total} key presses were delivered.{held} Inspect the target before retrying, and send only the remainder: {}",
                reply.trim()
            );
        }
        delivered += chunk.len();
    }
    Ok(())
}

/// Connects to Hyprland's control socket. Requests written here never
/// appear in a process's argv, unlike `hyprctl`, so text spelled as key
/// names cannot be read from `/proc/<pid>/cmdline`.
async fn socket_connect() -> Result<tokio::net::UnixStream> {
    let signature = std::env::var("HYPRLAND_INSTANCE_SIGNATURE")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(infer_hyprland_instance_signature)
        .context("no Hyprland instance signature")?;
    let path = xdg_runtime_dir()
        .context("XDG_RUNTIME_DIR is unset")?
        .join("hypr")
        .join(signature)
        .join(".socket.sock");
    tokio::time::timeout(SOCKET_TIMEOUT, tokio::net::UnixStream::connect(&path))
        .await
        .with_context(|| format!("timed out connecting to {}", path.display()))?
        .with_context(|| format!("failed to connect to {}", path.display()))
}

/// Writes one request and reads the reply until Hyprland closes the stream.
async fn socket_exchange(mut stream: tokio::net::UnixStream, request: &str) -> Result<String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let exchange = async {
        stream.write_all(request.as_bytes()).await?;
        stream.shutdown().await?;
        let mut reply = String::new();
        stream.read_to_string(&mut reply).await?;
        std::io::Result::Ok(reply)
    };
    tokio::time::timeout(SOCKET_TIMEOUT, exchange)
        .await
        .context("timed out waiting for the Hyprland socket reply")?
        .context("Hyprland socket request failed")
}

const SOCKET_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// A PNG of one window, captured without focusing or raising it.
pub struct WindowCapture {
    pub png: Vec<u8>,
    pub width: u32,
    pub height: u32,
    /// Set when the window was on a hidden workspace. Hyprland stops sending
    /// frame callbacks to off-screen windows, so their buffer holds the last
    /// frame drawn while visible. Each capture makes the compositor send one
    /// and the client repaints; some clients (Chromium) need several rounds.
    pub hidden_workspace: Option<HiddenWorkspaceCapture>,
}

pub struct HiddenWorkspaceCapture {
    pub workspace: i64,
    /// Captures taken before two consecutive frames matched or the cap hit.
    pub captures: u32,
    /// False when frames were still changing at the cap: an animation, a
    /// blinking caret, or a page that is still loading.
    pub settled: bool,
}

/// Captures a window through `grim -T <stableId>` (ext-foreign-toplevel
/// image capture). Works for unfocused windows and windows on hidden
/// workspaces, needs no portal consent and never changes focus.
pub async fn capture_window(window_id: u64) -> Result<WindowCapture> {
    let address = format!("0x{window_id:x}");
    let clients = hyprctl_output_async(&["clients", "-j"])
        .await
        .context("failed to run hyprctl clients -j")?;
    let clients: serde_json::Value =
        serde_json::from_slice(&clients.stdout).context("failed to parse hyprctl clients -j")?;
    let client = clients
        .as_array()
        .and_then(|clients| {
            clients
                .iter()
                .find(|client| client.get("address").and_then(|a| a.as_str()) == Some(&address))
        })
        .with_context(|| format!("Hyprland window {address} is no longer listed"))?;
    let stable_id = match client.get("stableId") {
        Some(serde_json::Value::String(id)) => id.clone(),
        Some(serde_json::Value::Number(id)) => id.to_string(),
        _ => bail!("Hyprland window {address} has no stableId; this Hyprland is too old for per-window capture"),
    };
    if stable_id.is_empty() || !stable_id.chars().all(|c| c.is_ascii_alphanumeric()) {
        bail!("Hyprland window {address} has an unexpected stableId {stable_id:?}");
    }
    let workspace_id = client
        .get("workspace")
        .and_then(|workspace| workspace.get("id"))
        .and_then(|id| id.as_i64());
    let workspace_visible = match (workspace_id, visible_workspace_ids().await) {
        (Some(id), Some(visible)) => Some(visible.contains(&id)),
        _ => None,
    };

    const MAX_CAPTURES: u32 = 8;
    const SETTLE_INTERVAL: std::time::Duration = std::time::Duration::from_millis(150);
    let mut png = grim_toplevel(&stable_id, &address).await?;
    let hidden_workspace = match (workspace_visible, workspace_id) {
        (Some(false), Some(workspace)) => {
            // Capture until two consecutive frames match: the first capture
            // only wakes the client, and Chromium takes several rounds.
            let mut captures = 1;
            let mut settled = false;
            while captures < MAX_CAPTURES {
                tokio::time::sleep(SETTLE_INTERVAL).await;
                let next = grim_toplevel(&stable_id, &address).await?;
                captures += 1;
                let same = next == png;
                png = next;
                if same && captures > 2 {
                    settled = true;
                    break;
                }
            }
            Some(HiddenWorkspaceCapture {
                workspace,
                captures,
                settled,
            })
        }
        _ => None,
    };
    let (width, height) = crate::screenshot::png_dimensions(&png)
        .context("grim -T did not return a usable PNG image")?;
    Ok(WindowCapture {
        png,
        width,
        height,
        hidden_workspace,
    })
}

async fn grim_toplevel(stable_id: &str, address: &str) -> Result<Vec<u8>> {
    let mut command = Command::new("grim");
    command.args(["-t", "png", "-T", stable_id, "-"]);
    let output = command_runner::output(command, "capture a Hyprland window with grim -T")
        .await
        .context("grim is required for Hyprland background capture")?;
    if !output.status.success() {
        bail!(
            "grim -T {stable_id} failed for {address}: {}",
            command_detail(&output)
        );
    }
    Ok(output.stdout)
}

async fn visible_workspace_ids() -> Option<Vec<i64>> {
    let output = hyprctl_output_async(&["monitors", "-j"]).await.ok()?;
    let monitors: serde_json::Value = serde_json::from_slice(&output.stdout).ok()?;
    let ids = monitors
        .as_array()?
        .iter()
        .flat_map(|monitor| {
            ["activeWorkspace", "specialWorkspace"].map(|key| {
                monitor
                    .get(key)
                    .and_then(|workspace| workspace.get("id"))
                    .and_then(|id| id.as_i64())
                    .filter(|id| *id != 0)
            })
        })
        .flatten()
        .collect();
    Some(ids)
}

/// Raw `hyprctl devices -j` output, used to check the active keymap.
pub async fn devices_json() -> Result<Vec<u8>> {
    let output = hyprctl_output_async(&["devices", "-j"])
        .await
        .context("failed to run hyprctl devices -j")?;
    if !output.status.success() {
        bail!("hyprctl devices -j failed: {}", command_detail(&output));
    }
    Ok(output.stdout)
}

fn dispatch_succeeded(output: &std::process::Output) -> bool {
    output.status.success() && String::from_utf8_lossy(&output.stdout).trim() == "ok"
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

fn lua_focus_dispatch(address: &str) -> String {
    format!("hl.dsp.focus({{ window = \"{address}\" }})")
}

fn hyprctl_output(args: &[&str]) -> std::io::Result<std::process::Output> {
    let mut command = StdCommand::new("hyprctl");
    let has_signature = std::env::var("HYPRLAND_INSTANCE_SIGNATURE")
        .ok()
        .is_some_and(|value| !value.trim().is_empty());
    if !has_signature {
        if let Some(signature) = infer_hyprland_instance_signature() {
            command.args(["-i", &signature]);
        }
    }
    command.args(args).output()
}

async fn hyprctl_output_async(args: &[&str]) -> Result<std::process::Output> {
    let mut command = Command::new("hyprctl");
    let has_signature = std::env::var("HYPRLAND_INSTANCE_SIGNATURE")
        .ok()
        .is_some_and(|value| !value.trim().is_empty());
    if !has_signature {
        if let Some(signature) = infer_hyprland_instance_signature() {
            command.args(["-i", &signature]);
        }
    }
    command.args(args);
    command_runner::output(command, "run hyprctl").await
}

fn infer_hyprland_instance_signature() -> Option<String> {
    let runtime = xdg_runtime_dir()?;
    let hypr_dir = runtime.join("hypr");
    let wayland_display = std::env::var("WAYLAND_DISPLAY").ok();
    let candidates = fs::read_dir(hypr_dir)
        .ok()?
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let path = entry.path();
            let signature = path.file_name()?.to_string_lossy().into_owned();
            hyprland_instance_candidate(&path, signature, wayland_display.as_deref())
        })
        .collect::<Vec<_>>();

    select_hyprland_instance(candidates).map(|candidate| candidate.signature)
}

fn hyprland_instance_candidate(
    path: &Path,
    signature: String,
    wayland_display: Option<&str>,
) -> Option<HyprlandInstanceCandidate> {
    if !path
        .join(".socket.sock")
        .metadata()
        .map(|metadata| metadata.file_type().is_socket())
        .unwrap_or(false)
    {
        return None;
    }

    let lock = fs::read_to_string(path.join("hyprland.lock")).ok()?;
    let mut lines = lock.lines();
    let pid = lines.next()?.trim();
    if pid.is_empty() || !Path::new("/proc").join(pid).exists() {
        return None;
    }
    let lock_wayland_display = lines
        .next()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let wayland_display_matches =
        wayland_display.is_some() && lock_wayland_display == wayland_display;
    let modified = path
        .join(".socket.sock")
        .metadata()
        .and_then(|metadata| metadata.modified())
        .unwrap_or(SystemTime::UNIX_EPOCH);

    Some(HyprlandInstanceCandidate {
        signature,
        wayland_display_matches,
        modified,
    })
}

fn select_hyprland_instance(
    candidates: Vec<HyprlandInstanceCandidate>,
) -> Option<HyprlandInstanceCandidate> {
    candidates
        .into_iter()
        .max_by_key(|candidate| (candidate.wayland_display_matches, candidate.modified))
}

fn xdg_runtime_dir() -> Option<PathBuf> {
    if let Some(value) = std::env::var_os("XDG_RUNTIME_DIR") {
        return Some(PathBuf::from(value));
    }
    let uid = fs::metadata("/proc/self").ok()?.uid();
    Some(PathBuf::from(format!("/run/user/{uid}")))
}

#[derive(Debug)]
struct HyprlandInstanceCandidate {
    signature: String,
    wayland_display_matches: bool,
    modified: SystemTime,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::process::ExitStatusExt;
    use std::time::Duration;

    #[test]
    fn rebases_global_window_coordinates_to_screenshot_space() {
        let clients = r#"[{
            "address":"0x1234",
            "mapped":true,
            "at":[4714,1494],
            "size":[931,1124],
            "monitor":0,
            "class":"com.mitchellh.ghostty",
            "title":"Ghostty"
        }]"#;
        let monitors = br#"[
            {"id":0,"x":3747,"y":1440,"scale":1.8},
            {"id":1,"x":5667,"y":0,"scale":2.0}
        ]"#;
        let windows = parse_hyprland_clients_with_monitors(clients, monitors).unwrap();

        let bounds = windows[0].bounds.as_ref().unwrap();
        assert_eq!((bounds.x, bounds.y), (Some(1934), Some(2988)));
        assert_eq!((bounds.width, bounds.height), (1862, 2248));
    }

    #[test]
    fn global_union_accounts_for_negative_monitor_origins() {
        let clients = r#"[{
            "address":"0x1234",
            "at":[-1800,100],
            "size":[600,400],
            "monitor":0,
            "class":"foot",
            "title":"Shell"
        }]"#;
        let monitors = br#"[
            {"id":0,"x":-1920,"y":0,"scale":1.0},
            {"id":1,"x":0,"y":0,"scale":2.0}
        ]"#;
        let windows = parse_hyprland_clients_with_monitors(clients, monitors).unwrap();

        let bounds = windows[0].bounds.as_ref().unwrap();
        assert_eq!((bounds.x, bounds.y), (Some(240), Some(200)));
        assert_eq!((bounds.width, bounds.height), (1200, 800));
    }

    #[test]
    fn fractional_scale_rounds_crop_edges_outward() {
        let clients = r#"[{
            "address":"0x1234",
            "at":[1,1],
            "size":[1,1],
            "monitor":0,
            "class":"foot",
            "title":"Shell"
        }]"#;
        let monitors = br#"[{"id":0,"x":0,"y":0,"scale":1.25}]"#;
        let windows = parse_hyprland_clients_with_monitors(clients, monitors).unwrap();

        let bounds = windows[0].bounds.as_ref().unwrap();
        assert_eq!((bounds.x, bounds.y), (Some(1), Some(1)));
        assert_eq!((bounds.width, bounds.height), (2, 2));
    }

    #[test]
    fn bounds_are_omitted_without_valid_monitor_metadata() {
        let clients = r#"[{
            "address":"0x1234",
            "at":[100,100],
            "size":[600,400],
            "monitor":7,
            "class":"foot",
            "title":"Shell"
        }]"#;

        for monitors in [
            br#"[]"#.as_slice(),
            br#"[{"id":7,"x":0,"y":0,"scale":0.0}]"#.as_slice(),
            b"not json".as_slice(),
        ] {
            let windows = parse_hyprland_clients_with_monitors(clients, monitors).unwrap();
            assert!(windows[0].bounds.is_none());
        }
        let windows = parse_hyprland_clients_without_bounds(clients).unwrap();
        assert!(windows[0].bounds.is_none());
    }

    #[test]
    fn builds_hyprland_055_lua_focus_dispatch() {
        assert_eq!(
            lua_focus_dispatch("address:0x1234abcd"),
            "hl.dsp.focus({ window = \"address:0x1234abcd\" })"
        );
    }

    #[test]
    fn dispatch_rejects_exit_zero_error_output() {
        let output = std::process::Output {
            status: std::process::ExitStatus::from_raw(0),
            stdout: b"Invalid dispatcher\n".to_vec(),
            stderr: Vec::new(),
        };

        assert!(!dispatch_succeeded(&output));
        assert_eq!(command_detail(&output), "Invalid dispatcher");
    }

    #[test]
    fn dispatch_accepts_ok_output() {
        let output = std::process::Output {
            status: std::process::ExitStatus::from_raw(0),
            stdout: b"ok\n".to_vec(),
            stderr: Vec::new(),
        };

        assert!(dispatch_succeeded(&output));
    }

    #[test]
    fn selects_wayland_matching_hyprland_instance_before_newer_nonmatch() {
        let older_match = HyprlandInstanceCandidate {
            signature: "match".to_string(),
            wayland_display_matches: true,
            modified: SystemTime::UNIX_EPOCH,
        };
        let newer_nonmatch = HyprlandInstanceCandidate {
            signature: "nonmatch".to_string(),
            wayland_display_matches: false,
            modified: SystemTime::UNIX_EPOCH + Duration::from_secs(10),
        };

        let selected = select_hyprland_instance(vec![older_match, newer_nonmatch]).unwrap();

        assert_eq!(selected.signature, "match");
    }

    #[test]
    fn selects_newest_hyprland_instance_when_wayland_match_is_tied() {
        let older = HyprlandInstanceCandidate {
            signature: "older".to_string(),
            wayland_display_matches: false,
            modified: SystemTime::UNIX_EPOCH,
        };
        let newer = HyprlandInstanceCandidate {
            signature: "newer".to_string(),
            wayland_display_matches: false,
            modified: SystemTime::UNIX_EPOCH + Duration::from_secs(10),
        };

        let selected = select_hyprland_instance(vec![older, newer]).unwrap();

        assert_eq!(selected.signature, "newer");
    }
}

#[derive(Debug, Deserialize)]
struct HyprlandMonitor {
    id: i32,
    x: i32,
    y: i32,
    scale: f64,
}

#[derive(Debug, Deserialize)]
struct HyprlandClient {
    address: String,
    mapped: Option<bool>,
    hidden: Option<bool>,
    at: Option<[i32; 2]>,
    size: Option<[u32; 2]>,
    monitor: Option<i32>,
    workspace: Option<HyprlandWorkspace>,
    #[serde(rename = "class")]
    class_name: Option<String>,
    title: Option<String>,
    pid: Option<i64>,
    xwayland: Option<bool>,
    #[serde(rename = "focusHistoryID")]
    focus_history_id: Option<i32>,
}

#[derive(Debug, Deserialize)]
struct HyprlandWorkspace {
    id: Option<i32>,
}

impl TryFrom<HyprlandClient> for WindowInfo {
    type Error = anyhow::Error;

    fn try_from(client: HyprlandClient) -> Result<Self> {
        let window_id = parse_hyprland_address(&client.address)?;
        let bounds = client.size.map(|[width, height]| WindowBounds {
            x: client.at.map(|[x, _]| x),
            y: client.at.map(|[_, y]| y),
            width,
            height,
        });
        let client_type = client.xwayland.map(|xwayland| {
            if xwayland {
                "x11".to_string()
            } else {
                "wayland".to_string()
            }
        });

        Ok(WindowInfo {
            window_id,
            title: client.title,
            app_id: client.class_name.clone(),
            wm_class: client.class_name,
            pid: client.pid.and_then(|pid| u32::try_from(pid).ok()),
            bounds,
            workspace: client.workspace.and_then(|workspace| workspace.id),
            focused: client.focus_history_id == Some(0),
            hidden: client.hidden.unwrap_or(false),
            client_type,
            backend: HYPRLAND_BACKEND.to_string(),
            terminal: None,
        })
    }
}

fn parse_hyprland_address(address: &str) -> Result<u64> {
    let hex = address
        .trim()
        .strip_prefix("0x")
        .context("Hyprland window address did not start with 0x")?;
    u64::from_str_radix(hex, 16)
        .with_context(|| format!("failed to parse Hyprland window address {address}"))
}
