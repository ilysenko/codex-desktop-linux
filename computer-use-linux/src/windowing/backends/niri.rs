use crate::terminal::enrich_terminal_windows;
use crate::windowing::registry::BackendProbe;
use crate::windowing::types::{WindowBounds, WindowInfo};
use anyhow::{bail, Context, Result};
use serde::Deserialize;
use std::fs;
use std::os::unix::fs::{FileTypeExt, MetadataExt};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::SystemTime;

pub const NIRI_BACKEND: &str = "niri";

pub fn probe() -> BackendProbe {
    match niri_msg_output(&["windows"]) {
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
    let output = niri_msg_output(&["windows"]).context("failed to run niri msg --json windows")?;
    if !output.status.success() {
        bail!(
            "niri msg --json windows failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }

    parse_niri_windows(&String::from_utf8_lossy(&output.stdout))
}

pub(crate) fn parse_niri_windows(json: &str) -> Result<Vec<WindowInfo>> {
    let windows: Vec<NiriWindow> =
        serde_json::from_str(json).context("failed to parse niri msg --json windows output")?;

    let mut windows = windows
        .into_iter()
        .map(WindowInfo::from)
        .collect::<Vec<_>>();
    windows.sort_by_key(|window| window.window_id);
    enrich_terminal_windows(&mut windows);
    Ok(windows)
}

pub fn activate_window(window_id: u64) -> Result<()> {
    let window_id = window_id.to_string();
    let output = niri_msg_output(&["action", "focus-window", "--id", &window_id])
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
    let mut command = Command::new("niri");
    command.args(["msg", "--json"]);
    command.args(args);
    if let Some(socket_path) = niri_socket_path() {
        command.env("NIRI_SOCKET", socket_path);
    } else {
        command.env_remove("NIRI_SOCKET");
    }
    command.output()
}

pub(crate) fn niri_socket_path() -> Option<PathBuf> {
    if let Some(path) = env_path("NIRI_SOCKET") {
        if is_live_niri_socket(&path) {
            return Some(path);
        }
    }

    infer_niri_socket_path()
}

fn infer_niri_socket_path() -> Option<PathBuf> {
    let runtime = xdg_runtime_dir()?;
    let wayland_display = env_string("WAYLAND_DISPLAY");
    let candidates = fs::read_dir(runtime)
        .ok()?
        .filter_map(|entry| {
            let entry = entry.ok()?;
            niri_socket_candidate(&entry.path(), wayland_display.as_deref())
        })
        .collect::<Vec<_>>();

    select_niri_socket(candidates).map(|candidate| candidate.path)
}

fn niri_socket_candidate(
    path: &Path,
    wayland_display: Option<&str>,
) -> Option<NiriSocketCandidate> {
    let metadata = path.metadata().ok()?;
    if !metadata.file_type().is_socket() {
        return None;
    }

    let file_name = path.file_name()?.to_str()?;
    let parsed = parse_niri_socket_name(file_name)?;
    let pid_alive = Path::new("/proc").join(parsed.pid.to_string()).exists();
    if !pid_alive {
        return None;
    }

    Some(NiriSocketCandidate {
        path: path.to_path_buf(),
        wayland_display_matches: wayland_display == Some(parsed.wayland_display.as_str()),
        modified: metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH),
    })
}

fn select_niri_socket(candidates: Vec<NiriSocketCandidate>) -> Option<NiriSocketCandidate> {
    candidates
        .into_iter()
        .max_by_key(|candidate| (candidate.wayland_display_matches, candidate.modified))
}

fn is_live_niri_socket(path: &Path) -> bool {
    let metadata = path.metadata().ok();
    if !metadata
        .as_ref()
        .map(|metadata| metadata.file_type().is_socket())
        .unwrap_or(false)
    {
        return false;
    }

    path.file_name()
        .and_then(|name| name.to_str())
        .and_then(parse_niri_socket_name)
        .is_none_or(|parsed| Path::new("/proc").join(parsed.pid.to_string()).exists())
}

fn parse_niri_socket_name(file_name: &str) -> Option<NiriSocketName> {
    let body = file_name.strip_prefix("niri.")?.strip_suffix(".sock")?;
    let (wayland_display, pid) = body.rsplit_once('.')?;
    Some(NiriSocketName {
        wayland_display: wayland_display.to_string(),
        pid: pid.parse::<u32>().ok()?,
    })
}

fn xdg_runtime_dir() -> Option<PathBuf> {
    if let Some(value) = std::env::var_os("XDG_RUNTIME_DIR") {
        return Some(PathBuf::from(value));
    }
    let uid = fs::metadata("/proc/self").ok()?.uid();
    Some(PathBuf::from(format!("/run/user/{uid}")))
}

fn env_path(name: &str) -> Option<PathBuf> {
    env_string(name).map(PathBuf::from)
}

fn env_string(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn clean_string(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

#[derive(Debug)]
struct NiriSocketName {
    wayland_display: String,
    pid: u32,
}

#[derive(Debug)]
struct NiriSocketCandidate {
    path: PathBuf,
    wayland_display_matches: bool,
    modified: SystemTime,
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
    is_floating: bool,
    layout: Option<NiriWindowLayout>,
}

#[derive(Debug, Deserialize)]
struct NiriWindowLayout {
    tile_size: Option<(f64, f64)>,
    window_size: Option<(i32, i32)>,
    tile_pos_in_workspace_view: Option<(f64, f64)>,
}

impl From<NiriWindow> for WindowInfo {
    fn from(window: NiriWindow) -> Self {
        let app_id = clean_string(window.app_id);
        let bounds = window.layout.as_ref().and_then(NiriWindowLayout::bounds);

        WindowInfo {
            window_id: window.id,
            title: clean_string(window.title),
            app_id: app_id.clone(),
            wm_class: app_id,
            pid: window.pid.and_then(|pid| u32::try_from(pid).ok()),
            bounds,
            workspace: window
                .workspace_id
                .and_then(|workspace| i32::try_from(workspace).ok()),
            focused: window.is_focused,
            hidden: false,
            client_type: Some(
                if window.is_floating {
                    "wayland-floating"
                } else {
                    "wayland"
                }
                .to_string(),
            ),
            backend: NIRI_BACKEND.to_string(),
            terminal: None,
        }
    }
}

impl NiriWindowLayout {
    fn bounds(&self) -> Option<WindowBounds> {
        let (width, height) = self
            .tile_size
            .and_then(|(width, height)| {
                Some((rounded_positive_u32(width)?, rounded_positive_u32(height)?))
            })
            .or_else(|| {
                self.window_size.and_then(|(width, height)| {
                    Some((u32::try_from(width).ok()?, u32::try_from(height).ok()?))
                })
            })?;

        Some(WindowBounds {
            x: self
                .tile_pos_in_workspace_view
                .and_then(|(x, _)| rounded_i32(x)),
            y: self
                .tile_pos_in_workspace_view
                .and_then(|(_, y)| rounded_i32(y)),
            width,
            height,
        })
    }
}

fn rounded_positive_u32(value: f64) -> Option<u32> {
    if value.is_finite() && value > 0.0 && value <= u32::MAX as f64 {
        Some(value.round() as u32)
    } else {
        None
    }
}

fn rounded_i32(value: f64) -> Option<i32> {
    if value.is_finite() && value >= i32::MIN as f64 && value <= i32::MAX as f64 {
        Some(value.round() as i32)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn parses_niri_socket_name() {
        let parsed = parse_niri_socket_name("niri.wayland-1.607057.sock").unwrap();

        assert_eq!(parsed.wayland_display, "wayland-1");
        assert_eq!(parsed.pid, 607057);
    }

    #[test]
    fn parses_wayland_display_names_with_dots() {
        let parsed = parse_niri_socket_name("niri.custom.display.42.sock").unwrap();

        assert_eq!(parsed.wayland_display, "custom.display");
        assert_eq!(parsed.pid, 42);
    }

    #[test]
    fn rejects_non_niri_socket_names() {
        assert!(parse_niri_socket_name("wayland-1").is_none());
        assert!(parse_niri_socket_name("niri.wayland-1.sock").is_none());
        assert!(parse_niri_socket_name("niri.wayland-1.not-a-pid.sock").is_none());
    }

    #[test]
    fn selects_wayland_matching_socket_before_newer_nonmatch() {
        let older_match = NiriSocketCandidate {
            path: PathBuf::from("/run/user/1000/niri.wayland-1.1.sock"),
            wayland_display_matches: true,
            modified: SystemTime::UNIX_EPOCH,
        };
        let newer_nonmatch = NiriSocketCandidate {
            path: PathBuf::from("/run/user/1000/niri.wayland-2.2.sock"),
            wayland_display_matches: false,
            modified: SystemTime::UNIX_EPOCH + Duration::from_secs(10),
        };

        let selected = select_niri_socket(vec![older_match, newer_nonmatch]).unwrap();

        assert_eq!(
            selected.path,
            PathBuf::from("/run/user/1000/niri.wayland-1.1.sock")
        );
    }

    #[test]
    fn selects_newest_socket_when_wayland_match_is_tied() {
        let older = NiriSocketCandidate {
            path: PathBuf::from("/run/user/1000/niri.wayland-1.1.sock"),
            wayland_display_matches: true,
            modified: SystemTime::UNIX_EPOCH,
        };
        let newer = NiriSocketCandidate {
            path: PathBuf::from("/run/user/1000/niri.wayland-1.2.sock"),
            wayland_display_matches: true,
            modified: SystemTime::UNIX_EPOCH + Duration::from_secs(10),
        };

        let selected = select_niri_socket(vec![older, newer]).unwrap();

        assert_eq!(
            selected.path,
            PathBuf::from("/run/user/1000/niri.wayland-1.2.sock")
        );
    }
}
