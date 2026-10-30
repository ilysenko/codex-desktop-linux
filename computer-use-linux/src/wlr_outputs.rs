use crate::remote_desktop::LogicalMonitor;
use anyhow::{Context, Result};
use std::time::{Duration, Instant};
use std::{collections::HashMap, os::fd::AsRawFd};
use wayland_client::protocol::{wl_callback, wl_registry};
use wayland_client::{event_created_child, Connection, Dispatch, Proxy, QueueHandle};
use wayland_protocols_wlr::output_management::v1::client::{
    zwlr_output_head_v1, zwlr_output_manager_v1, zwlr_output_mode_v1,
};

const LAYOUT_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug, Clone)]
pub(crate) struct RecordedHead {
    pub x: i32,
    pub y: i32,
    pub mode_width: i32,
    pub mode_height: i32,
    pub scale: f64,
    pub transform: u32,
    pub enabled: bool,
}

/// Logical size is the current mode divided by the head scale. Odd transforms
/// swap width and height. Disabled or unfinished heads are dropped.
pub(crate) fn logical_layout(heads: &[RecordedHead]) -> Option<Vec<LogicalMonitor>> {
    let mut layout = Vec::new();
    for head in heads {
        if !head.enabled || !head.scale.is_finite() || head.scale <= 0.0 {
            continue;
        }
        if head.mode_width <= 0 || head.mode_height <= 0 {
            continue;
        }
        let (mode_width, mode_height) = if head.transform % 2 == 1 {
            (head.mode_height, head.mode_width)
        } else {
            (head.mode_width, head.mode_height)
        };
        let width = (f64::from(mode_width) / head.scale).round() as i32;
        let height = (f64::from(mode_height) / head.scale).round() as i32;
        if width <= 0 || height <= 0 {
            continue;
        }
        layout.push(LogicalMonitor {
            x: head.x,
            y: head.y,
            width,
            height,
            scale: head.scale,
        });
    }
    layout.sort_by_key(|monitor| (monitor.x, monitor.y, monitor.width, monitor.height));
    (!layout.is_empty()).then_some(layout)
}

pub(crate) async fn wlr_output_layout() -> Option<Vec<LogicalMonitor>> {
    tokio::task::spawn_blocking(collect_layout)
        .await
        .ok()
        .and_then(Result::ok)
}

fn collect_layout() -> Result<Vec<LogicalMonitor>> {
    // Open a separate connection without consuming an inherited WAYLAND_SOCKET.
    let display = std::path::PathBuf::from(
        std::env::var_os("WAYLAND_DISPLAY").context("no Wayland display")?,
    );
    let path = if display.is_absolute() {
        display
    } else {
        let runtime = std::path::PathBuf::from(
            std::env::var_os("XDG_RUNTIME_DIR").context("no Wayland runtime directory")?,
        );
        anyhow::ensure!(
            runtime.is_absolute(),
            "Wayland runtime directory is not absolute"
        );
        runtime.join(display)
    };
    let socket = crate::x11_display::connect_unix(
        path.to_str().context("Wayland socket path is not UTF-8")?,
        Instant::now() + LAYOUT_TIMEOUT,
    )?;
    let conn = Connection::from_socket(socket).context("Wayland connection failed")?;
    collect_layout_from_connection(conn)
}

fn collect_layout_from_connection(conn: Connection) -> Result<Vec<LogicalMonitor>> {
    let mut event_queue = conn.new_event_queue::<State>();
    let mut state = State::default();
    let qh = event_queue.handle();
    let _registry = conn.display().get_registry(&qh, ());
    conn.display().sync(&qh, ());
    let deadline = Instant::now() + LAYOUT_TIMEOUT;
    loop {
        anyhow::ensure!(Instant::now() < deadline, "wlr output layout timed out");
        event_queue
            .dispatch_pending(&mut state)
            .context("Wayland dispatch failed")?;
        if state.done {
            break;
        }
        anyhow::ensure!(
            !state.registry_done || state.manager.is_some(),
            "zwlr_output_manager_v1 is not advertised"
        );
        event_queue.flush().context("Wayland flush failed")?;
        if let Some(guard) = event_queue.prepare_read() {
            let mut fd = libc::pollfd {
                fd: guard.connection_fd().as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            };
            let remaining = deadline.saturating_duration_since(Instant::now());
            let millis = remaining.as_millis().min(i32::MAX as u128) as i32;
            // SAFETY: fd describes one live Wayland connection for this call.
            let ready = unsafe { libc::poll(&mut fd, 1, millis) };
            anyhow::ensure!(ready != 0, "wlr output layout timed out");
            if ready < 0 {
                let error = std::io::Error::last_os_error();
                if error.kind() == std::io::ErrorKind::Interrupted {
                    continue;
                }
                return Err(error).context("Wayland poll failed");
            }
            match guard.read() {
                Ok(_) => {}
                Err(wayland_client::backend::WaylandError::Io(error))
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
                    ) => {}
                Err(error) => return Err(error).context("Wayland read failed"),
            }
        }
    }
    state.layout().context("wlr output layout was not ready")
}

#[derive(Default)]
struct State {
    registry_done: bool,
    manager: Option<zwlr_output_manager_v1::ZwlrOutputManagerV1>,
    done: bool,
    heads: HashMap<u32, Head>,
    modes: HashMap<u32, Mode>,
}

#[derive(Default)]
struct Head {
    enabled: bool,
    finished: bool,
    position: Option<(i32, i32)>,
    transform: Option<u32>,
    scale: Option<f64>,
    current_mode: Option<u32>,
}

#[derive(Default)]
struct Mode {
    finished: bool,
    size: Option<(i32, i32)>,
}

impl State {
    fn layout(&self) -> Option<Vec<LogicalMonitor>> {
        if !self.done {
            return None;
        }
        let heads = self
            .heads
            .values()
            .filter(|head| !head.finished)
            .filter_map(|head| {
                let (x, y) = head.position?;
                let (mode_width, mode_height) = self.modes.get(&head.current_mode?)?.size?;
                Some(RecordedHead {
                    x,
                    y,
                    mode_width,
                    mode_height,
                    scale: head.scale?,
                    transform: head.transform.unwrap_or(0),
                    enabled: head.enabled,
                })
            })
            .collect::<Vec<_>>();
        logical_layout(&heads)
    }
}

impl Dispatch<zwlr_output_manager_v1::ZwlrOutputManagerV1, ()> for State {
    fn event(
        state: &mut Self,
        _: &zwlr_output_manager_v1::ZwlrOutputManagerV1,
        event: zwlr_output_manager_v1::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        match event {
            zwlr_output_manager_v1::Event::Head { head } => {
                state.done = false;
                state.heads.entry(head.id().protocol_id()).or_default();
            }
            zwlr_output_manager_v1::Event::Done { .. } => state.done = true,
            zwlr_output_manager_v1::Event::Finished => state.done = false,
            _ => {}
        }
    }

    event_created_child!(
        State,
        zwlr_output_manager_v1::ZwlrOutputManagerV1,
        [zwlr_output_manager_v1::EVT_HEAD_OPCODE => (zwlr_output_head_v1::ZwlrOutputHeadV1, ())]
    );
}

impl Dispatch<zwlr_output_head_v1::ZwlrOutputHeadV1, ()> for State {
    fn event(
        state: &mut Self,
        head: &zwlr_output_head_v1::ZwlrOutputHeadV1,
        event: zwlr_output_head_v1::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        state.done = false;
        let slot = state.heads.entry(head.id().protocol_id()).or_default();
        match event {
            zwlr_output_head_v1::Event::Mode { mode } => {
                state.modes.entry(mode.id().protocol_id()).or_default();
            }
            zwlr_output_head_v1::Event::Enabled { enabled } => slot.enabled = enabled != 0,
            zwlr_output_head_v1::Event::CurrentMode { mode } => {
                slot.current_mode = Some(mode.id().protocol_id());
            }
            zwlr_output_head_v1::Event::Position { x, y } => slot.position = Some((x, y)),
            zwlr_output_head_v1::Event::Transform { transform } => {
                slot.transform = Some(transform.into());
            }
            zwlr_output_head_v1::Event::Scale { scale } => slot.scale = Some(scale),
            zwlr_output_head_v1::Event::Finished => slot.finished = true,
            _ => {}
        }
    }

    event_created_child!(
        State,
        zwlr_output_head_v1::ZwlrOutputHeadV1,
        [zwlr_output_head_v1::EVT_MODE_OPCODE => (zwlr_output_mode_v1::ZwlrOutputModeV1, ())]
    );
}

impl Dispatch<zwlr_output_mode_v1::ZwlrOutputModeV1, ()> for State {
    fn event(
        state: &mut Self,
        mode: &zwlr_output_mode_v1::ZwlrOutputModeV1,
        event: zwlr_output_mode_v1::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        state.done = false;
        let slot = state.modes.entry(mode.id().protocol_id()).or_default();
        match event {
            zwlr_output_mode_v1::Event::Size { width, height } => {
                slot.size = Some((width, height));
            }
            zwlr_output_mode_v1::Event::Finished => slot.finished = true,
            _ => {}
        }
    }
}

impl Dispatch<wl_callback::WlCallback, ()> for State {
    fn event(
        state: &mut Self,
        _: &wl_callback::WlCallback,
        _: wl_callback::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        state.registry_done = true;
    }
}

impl Dispatch<wl_registry::WlRegistry, ()> for State {
    fn event(
        state: &mut Self,
        registry: &wl_registry::WlRegistry,
        event: wl_registry::Event,
        _: &(),
        _: &Connection,
        qh: &QueueHandle<Self>,
    ) {
        if let wl_registry::Event::Global {
            name,
            interface,
            version,
        } = event
        {
            if interface == "zwlr_output_manager_v1" && version > 0 && state.manager.is_none() {
                state.manager = Some(registry.bind(name, version.min(4), qh, ()));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stalled_peer_releases_layout_worker() {
        let (client, peer) = std::os::unix::net::UnixStream::pair().unwrap();
        let (finished, result) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            let connection = Connection::from_socket(client).unwrap();
            let _ = finished.send(collect_layout_from_connection(connection));
        });
        let completed = result.recv_timeout(LAYOUT_TIMEOUT + Duration::from_secs(1));
        drop(peer);
        worker.join().unwrap();
        assert!(completed.is_ok(), "layout worker outlived its deadline");
        assert!(completed.unwrap().is_err());
    }

    #[test]
    fn logical_layout_divides_mode_by_scale() {
        let layout = logical_layout(&[
            RecordedHead {
                x: 0,
                y: 0,
                mode_width: 2048,
                mode_height: 1536,
                scale: 2.0,
                transform: 0,
                enabled: true,
            },
            RecordedHead {
                x: 10,
                y: 0,
                mode_width: 800,
                mode_height: 600,
                scale: 1.0,
                transform: 0,
                enabled: false,
            },
        ])
        .unwrap();
        assert_eq!(layout.len(), 1);
        assert_eq!(layout[0].width, 1024);
        assert_eq!(layout[0].height, 768);
        assert_eq!(layout[0].scale, 2.0);
    }
}
