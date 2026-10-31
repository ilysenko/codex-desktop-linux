use crate::windowing::registry::BackendProbe;
use crate::windowing::types::{WindowInfo, MAX_WINDOW_ID};
use crate::windowing::wayland_session::peer_pid;
use anyhow::{anyhow, bail, Context, Result};
use serde::Deserialize;
use std::os::fd::AsRawFd;
use std::path::PathBuf;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;

pub const LABWC_BACKEND: &str = "labwc";
const REPLY_CAP: usize = 4 * 1024 * 1024;
const QUERY_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug, Deserialize)]
struct LabwcWindow {
    pid: u32,
    title: Option<String>,
    app_id: Option<String>,
    minimized: bool,
    focused: bool,
}

fn window_id(pid: u32, app_id: Option<&str>, title: Option<&str>) -> u64 {
    // The Selkies IPC exposes no persistent per-window identifier. Include the
    // title to distinguish siblings, and reject ambiguous fingerprints before
    // activation or focus verification. A title change requires a fresh list.
    let mut id = 0xcbf29ce484222325u64;
    for byte in pid.to_le_bytes().into_iter().chain(
        [app_id.unwrap_or(""), title.unwrap_or("")]
            .into_iter()
            .flat_map(|value| {
                (value.len() as u64)
                    .to_le_bytes()
                    .into_iter()
                    .chain(value.bytes())
            }),
    ) {
        id ^= u64::from(byte);
        id = id.wrapping_mul(0x100000001b3);
    }
    id & MAX_WINDOW_ID
}

fn unique_window<'a>(windows: &'a [WindowInfo], requested: &WindowInfo) -> Result<&'a WindowInfo> {
    let mut matches = windows
        .iter()
        .filter(|window| window.window_id == requested.window_id);
    let first = matches
        .next()
        .context("labwc window identity changed; list windows again")?;
    if matches.next().is_some() {
        bail!("labwc window identity is ambiguous; windows share a pid, app id and title");
    }
    if first.pid != requested.pid
        || first.app_id != requested.app_id
        || first.title != requested.title
    {
        bail!("labwc window identity changed; list windows again");
    }
    Ok(first)
}

pub(crate) fn parse_windows(json: &str) -> Result<Vec<WindowInfo>> {
    let value: serde_json::Value =
        serde_json::from_str(json).context("labwc reply was not JSON")?;
    if let Some(error) = value.get("error").and_then(|item| item.as_str()) {
        bail!("{error}");
    }
    let windows: Vec<LabwcWindow> =
        serde_json::from_value(value).context("labwc window list had an unexpected shape")?;
    Ok(windows.into_iter().map(to_window).collect())
}

pub(crate) fn parse_window(json: &str) -> Result<Option<WindowInfo>> {
    let value: serde_json::Value =
        serde_json::from_str(json).context("labwc reply was not JSON")?;
    if value.is_null() || value.as_object().is_some_and(|object| object.is_empty()) {
        return Ok(None);
    }
    if let Some(error) = value.get("error").and_then(|item| item.as_str()) {
        bail!("{error}");
    }
    let window: LabwcWindow =
        serde_json::from_value(value).context("labwc focused window had an unexpected shape")?;
    Ok(Some(to_window(window)))
}

fn to_window(window: LabwcWindow) -> WindowInfo {
    let app_id = window.app_id.filter(|value| !value.is_empty());
    let title = window.title.filter(|value| !value.is_empty());
    WindowInfo {
        window_id: window_id(window.pid, app_id.as_deref(), title.as_deref()),
        title,
        wm_class: app_id.clone(),
        app_id: app_id.clone(),
        pid: Some(window.pid),
        // IPC rectangles are logical coordinates. Without output scale and
        // origin metadata they cannot safely become capture-pixel bounds.
        bounds: None,
        workspace: None,
        focused: window.focused,
        hidden: window.minimized,
        client_type: None,
        backend: LABWC_BACKEND.to_string(),
        terminal: None,
    }
}

pub fn probe() -> BackendProbe {
    let path = socket_path();
    let expected = crate::windowing::wayland_session::display_path()
        .and_then(|_| crate::windowing::wayland_session::compositor_pid());
    let actual = path
        .as_deref()
        .and_then(crate::windowing::wayland_session::peer_pid_at);
    let ok = expected
        .zip(actual)
        .is_some_and(|(expected, actual)| expected == actual);
    BackendProbe {
        id: LABWC_BACKEND,
        ok,
        can_list_windows: ok,
        can_focus_apps: false,
        can_focus_windows: ok,
        detail: match path {
            Some(path) if ok => format!("socket {}", path.display()),
            Some(path) => format!(
                "socket {} is unavailable or does not belong to the selected Wayland compositor",
                path.display()
            ),
            None => "XDG_RUNTIME_DIR is unset".to_string(),
        },
    }
}

pub(crate) async fn list_windows() -> Result<Vec<WindowInfo>> {
    parse_windows(&query("GET_WINDOWS").await?)
}

pub(crate) async fn focused_window() -> Result<Option<WindowInfo>> {
    let Some(focused) = parse_window(&query("GET_FOCUSED_WINDOW").await?)? else {
        return Ok(None);
    };
    let windows = list_windows().await?;
    let current = unique_window(&windows, &focused)?;
    if !current.focused {
        bail!("labwc focus changed while verifying the window");
    }
    Ok(Some(current.clone()))
}

pub(crate) async fn activate(window: &WindowInfo) -> Result<()> {
    let windows = list_windows().await?;
    let current = unique_window(&windows, window)?;
    foreign::activate(current).await
}

fn socket_path() -> Option<PathBuf> {
    let runtime = std::env::var_os("XDG_RUNTIME_DIR")?;
    Some(PathBuf::from(runtime).join("labwc.sock"))
}

async fn query(command: &str) -> Result<String> {
    let path = socket_path().context("XDG_RUNTIME_DIR is unset")?;
    tokio::time::timeout(QUERY_TIMEOUT, async {
        let expected_pid = wayland_peer_pid().await?;
        query_at(&path, command, expected_pid).await
    })
    .await
    .context("labwc socket query timed out")?
}

async fn query_at(path: &std::path::Path, command: &str, expected_pid: u32) -> Result<String> {
    let mut stream = UnixStream::connect(path)
        .await
        .with_context(|| format!("could not connect to {}", path.display()))?;
    ensure_compositor(peer_pid(stream.as_raw_fd())?, expected_pid)?;
    stream
        .write_all(format!("{command}\n").as_bytes())
        .await
        .context("labwc socket write failed")?;
    let mut buf = Vec::new();
    let mut tmp = [0u8; 8192];
    loop {
        let n = stream
            .read(&mut tmp)
            .await
            .context("labwc socket read failed")?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&tmp[..n]);
        if buf.len() > REPLY_CAP {
            bail!("labwc reply exceeded 4 MiB");
        }
    }
    decode_reply(&buf)
}

fn decode_reply(buf: &[u8]) -> Result<String> {
    // Selkies can cut a multibyte title at its byte buffer limit. Repair that
    // string exactly as ipc_string_with_char does, preserving the other windows.
    let text = String::from_utf8_lossy(buf).into_owned();
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
        if let Some(error) = value.get("error").and_then(|item| item.as_str()) {
            return Err(anyhow!(error.to_string()));
        }
    }
    Ok(text)
}

fn ensure_compositor(actual: u32, expected: u32) -> Result<()> {
    if actual != expected {
        bail!("labwc IPC and Wayland sockets belong to different compositors");
    }
    Ok(())
}

async fn connect_wayland() -> Result<UnixStream> {
    // An inherited Wayland fd is one protocol client, not a reconnectable socket.
    // Use it only to verify identity; each activation needs a fresh connection.
    let inherited = std::env::var("WAYLAND_SOCKET")
        .ok()
        .map(|fd| peer_pid(fd.parse().context("invalid WAYLAND_SOCKET")?))
        .transpose()?;
    let path = crate::windowing::wayland_session::display_path()
        .context("labwc requires explicit WAYLAND_DISPLAY for an independent connection")?;
    let stream = UnixStream::connect(path)
        .await
        .context("could not connect to selected Wayland compositor")?;
    if let Some(expected) = inherited {
        ensure_compositor(peer_pid(stream.as_raw_fd())?, expected)?;
    }
    Ok(stream)
}

async fn wayland_peer_pid() -> Result<u32> {
    peer_pid(connect_wayland().await?.as_raw_fd())
}

// The Selkies IPC serializer has a 512-byte output buffer, including JSON
// escaping. Match the decoded representation, and reject any ambiguity caused
// by truncation. Stock labwc does not expose this IPC.
fn ipc_string(value: &str) -> String {
    ipc_string_with_char(value, false)
}

fn ipc_string_with_char(value: &str, signed_char: bool) -> String {
    let mut serialized_len = 0;
    let mut bytes = Vec::new();
    for byte in value.bytes() {
        if serialized_len >= 510 {
            break;
        }
        if byte < 0x20 || (signed_char && byte >= 0x80) {
            continue;
        }
        let width = if byte == b'"' || byte == b'\\' { 2 } else { 1 };
        if serialized_len + width >= 512 {
            break;
        }
        serialized_len += width;
        bytes.push(byte);
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

fn ipc_matches(value: Option<&str>, expected: Option<&str>) -> bool {
    expected.is_none_or(|expected| {
        value.is_some_and(|value| {
            ipc_string(value) == expected || ipc_string_with_char(value, true) == expected
        })
    })
}

mod foreign {
    use super::WindowInfo;
    use anyhow::{bail, Context, Result};
    use std::collections::HashMap;
    use std::os::fd::{AsFd, AsRawFd};
    use std::time::Instant;
    use wayland_client::protocol::{wl_callback, wl_registry, wl_seat};
    use wayland_client::{
        event_created_child, Connection, Dispatch, EventQueue, Proxy, QueueHandle,
    };
    use wayland_protocols_wlr::foreign_toplevel::v1::client::{
        zwlr_foreign_toplevel_handle_v1, zwlr_foreign_toplevel_manager_v1,
    };

    pub(super) async fn activate(window: &WindowInfo) -> Result<()> {
        let title = window.title.clone();
        let app_id = window.app_id.clone();
        if title.is_none() && app_id.is_none() {
            bail!("labwc window has no title or app id for activation");
        }
        let deadline = Instant::now() + super::QUERY_TIMEOUT;
        let stream = tokio::time::timeout(super::QUERY_TIMEOUT, async {
            let stream = super::connect_wayland().await?;
            let ipc = super::UnixStream::connect(
                super::socket_path().context("XDG_RUNTIME_DIR is unset")?,
            )
            .await?;
            super::ensure_compositor(
                super::peer_pid(stream.as_raw_fd())?,
                super::peer_pid(ipc.as_raw_fd())?,
            )?;
            Ok::<_, anyhow::Error>(stream.into_std()?)
        })
        .await
        .context("labwc connection timed out")??;
        // Await the bounded worker itself. Dropping a timed-out JoinHandle would
        // let it continue and potentially activate after the tool had returned.
        tokio::task::spawn_blocking(move || {
            let conn = Connection::from_socket(stream).context("no Wayland display")?;
            activate_connection(conn, title.as_deref(), app_id.as_deref(), deadline)
        })
        .await
        .context("labwc activation task failed")?
    }

    fn activate_connection(
        conn: Connection,
        title: Option<&str>,
        app_id: Option<&str>,
        deadline: Instant,
    ) -> Result<()> {
        let mut queue = conn.new_event_queue::<State>();
        let qh = queue.handle();
        let mut state = State::default();
        let _registry = conn.display().get_registry(&qh, ());
        bounded_sync(&conn, &mut queue, &mut state, deadline)?;
        if state.manager.is_none() || state.seat.is_none() {
            bail!("labwc activation requires foreign-toplevel-management and a seat");
        }
        // Bind requests were sent while dispatching registry events. Wait for
        // their initial handles and titles without a blocking roundtrip.
        bounded_sync(&conn, &mut queue, &mut state, deadline)?;
        if state.finished {
            bail!("labwc toplevel manager has finished");
        }
        let candidates = state
            .proxies
            .iter()
            .filter(|proxy| {
                state
                    .handles
                    .get(&proxy.id().protocol_id())
                    .is_some_and(|handle| {
                        super::ipc_matches(handle.app_id.as_deref(), app_id)
                            && super::ipc_matches(handle.title.as_deref(), title)
                    })
            })
            .collect::<Vec<_>>();
        let proxy = match candidates.as_slice() {
            [proxy] => *proxy,
            [] => bail!("labwc has no toplevel matching the window"),
            _ => bail!(
                "labwc activation is ambiguous; multiple toplevels share the app id and title"
            ),
        };
        if Instant::now() >= deadline {
            bail!("labwc activation timed out before dispatch");
        }
        proxy.activate(state.seat.as_ref().unwrap());
        bounded_sync(&conn, &mut queue, &mut state, deadline)
    }

    fn bounded_sync(
        conn: &Connection,
        queue: &mut EventQueue<State>,
        state: &mut State,
        deadline: Instant,
    ) -> Result<()> {
        if Instant::now() >= deadline {
            bail!("labwc activation timed out");
        }
        state.synced = false;
        conn.display().sync(&queue.handle(), ());
        loop {
            queue
                .dispatch_pending(state)
                .context("Wayland dispatch failed")?;
            if Instant::now() >= deadline {
                bail!("labwc activation timed out");
            }
            if state.synced {
                return Ok(());
            }
            queue.flush().context("Wayland flush failed")?;
            if let Some(guard) = queue.prepare_read() {
                let mut fd = libc::pollfd {
                    fd: queue.as_fd().as_raw_fd(),
                    events: libc::POLLIN,
                    revents: 0,
                };
                let remaining = deadline.saturating_duration_since(Instant::now());
                let timeout_ms = remaining.as_millis().min(i32::MAX as u128) as i32;
                // SAFETY: fd is a valid single pollfd, and poll only updates revents.
                let ready = unsafe { libc::poll(&mut fd, 1, timeout_ms) };
                if ready < 0 {
                    let error = std::io::Error::last_os_error();
                    if error.kind() == std::io::ErrorKind::Interrupted {
                        continue;
                    }
                    return Err(error).context("Wayland poll failed");
                }
                if ready == 0 {
                    bail!("labwc activation timed out");
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
    }

    #[derive(Default)]
    struct State {
        manager: Option<zwlr_foreign_toplevel_manager_v1::ZwlrForeignToplevelManagerV1>,
        seat: Option<wl_seat::WlSeat>,
        finished: bool,
        synced: bool,
        handles: HashMap<u32, HandleState>,
        proxies: Vec<zwlr_foreign_toplevel_handle_v1::ZwlrForeignToplevelHandleV1>,
    }

    #[derive(Default)]
    struct HandleState {
        title: Option<String>,
        app_id: Option<String>,
    }

    impl Dispatch<zwlr_foreign_toplevel_manager_v1::ZwlrForeignToplevelManagerV1, ()> for State {
        fn event(
            state: &mut Self,
            _: &zwlr_foreign_toplevel_manager_v1::ZwlrForeignToplevelManagerV1,
            event: zwlr_foreign_toplevel_manager_v1::Event,
            _: &(),
            _: &Connection,
            _: &QueueHandle<Self>,
        ) {
            match event {
                zwlr_foreign_toplevel_manager_v1::Event::Toplevel { toplevel } => {
                    let id = toplevel.id().protocol_id();
                    state.handles.entry(id).or_default();
                    state.proxies.push(toplevel);
                }
                zwlr_foreign_toplevel_manager_v1::Event::Finished => state.finished = true,
                _ => {}
            }
        }

        event_created_child!(
            State,
            zwlr_foreign_toplevel_manager_v1::ZwlrForeignToplevelManagerV1,
            [zwlr_foreign_toplevel_manager_v1::EVT_TOPLEVEL_OPCODE => (zwlr_foreign_toplevel_handle_v1::ZwlrForeignToplevelHandleV1, ())]
        );
    }

    impl Dispatch<zwlr_foreign_toplevel_handle_v1::ZwlrForeignToplevelHandleV1, ()> for State {
        fn event(
            state: &mut Self,
            handle: &zwlr_foreign_toplevel_handle_v1::ZwlrForeignToplevelHandleV1,
            event: zwlr_foreign_toplevel_handle_v1::Event,
            _: &(),
            _: &Connection,
            _: &QueueHandle<Self>,
        ) {
            let slot = state.handles.entry(handle.id().protocol_id()).or_default();
            match event {
                zwlr_foreign_toplevel_handle_v1::Event::Title { title } => slot.title = Some(title),
                zwlr_foreign_toplevel_handle_v1::Event::AppId { app_id } => {
                    slot.app_id = Some(app_id)
                }
                zwlr_foreign_toplevel_handle_v1::Event::Closed => {
                    state.handles.remove(&handle.id().protocol_id());
                }
                _ => {}
            }
        }
    }

    impl Dispatch<wl_seat::WlSeat, ()> for State {
        fn event(
            _: &mut Self,
            _: &wl_seat::WlSeat,
            _: wl_seat::Event,
            _: &(),
            _: &Connection,
            _: &QueueHandle<Self>,
        ) {
        }
    }

    impl Dispatch<wl_callback::WlCallback, ()> for State {
        fn event(
            state: &mut Self,
            _: &wl_callback::WlCallback,
            event: wl_callback::Event,
            _: &(),
            _: &Connection,
            _: &QueueHandle<Self>,
        ) {
            if let wl_callback::Event::Done { .. } = event {
                state.synced = true;
            }
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
                match interface.as_str() {
                    "zwlr_foreign_toplevel_manager_v1" if state.manager.is_none() => {
                        state.manager = Some(registry.bind(name, version.min(3), qh, ()));
                    }
                    "wl_seat" if state.seat.is_none() => {
                        state.seat = Some(registry.bind(name, 1, qh, ()));
                    }
                    _ => {}
                }
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn wire_string(value: &str) -> Vec<u8> {
            let mut bytes = ((value.len() + 1) as u32).to_ne_bytes().to_vec();
            bytes.extend_from_slice(value.as_bytes());
            bytes.push(0);
            bytes.resize(bytes.len().next_multiple_of(4), 0);
            bytes
        }

        fn send_event(
            stream: &mut std::os::unix::net::UnixStream,
            object: u32,
            opcode: u16,
            payload: &[u8],
        ) {
            use std::io::Write;
            let mut bytes = object.to_ne_bytes().to_vec();
            bytes.extend_from_slice(
                &((((payload.len() + 8) as u32) << 16) | u32::from(opcode)).to_ne_bytes(),
            );
            bytes.extend_from_slice(payload);
            stream.write_all(&bytes).unwrap();
        }

        // A minimal real Wayland peer exercises registry binding, both syncs,
        // server-created toplevels, title/app-id matching and activation on wire.
        fn activation_fixture(titles: Vec<String>, requested: String) -> (Result<()>, usize) {
            use std::io::Read;
            let (client, mut server) = std::os::unix::net::UnixStream::pair().unwrap();
            server
                .set_read_timeout(Some(std::time::Duration::from_secs(1)))
                .unwrap();
            let peer = std::thread::spawn(move || {
                let mut registry = 0;
                let mut activations = 0;
                loop {
                    let mut header = [0u8; 8];
                    match server.read_exact(&mut header) {
                        Ok(()) => {}
                        Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => break,
                        Err(error) => panic!("fixture read failed: {error}"),
                    }
                    let object = u32::from_ne_bytes(header[..4].try_into().unwrap());
                    let word = u32::from_ne_bytes(header[4..].try_into().unwrap());
                    let opcode = word & 0xffff;
                    let mut payload = vec![0u8; ((word >> 16) as usize) - 8];
                    server.read_exact(&mut payload).unwrap();
                    if object == 1 && opcode == 1 {
                        registry = u32::from_ne_bytes(payload[..4].try_into().unwrap());
                        for (name, interface, version) in [
                            (1u32, "zwlr_foreign_toplevel_manager_v1", 3u32),
                            (2, "wl_seat", 1),
                        ] {
                            let mut global = name.to_ne_bytes().to_vec();
                            global.extend(wire_string(interface));
                            global.extend(version.to_ne_bytes());
                            send_event(&mut server, registry, 0, &global);
                        }
                    } else if object == registry && opcode == 0 {
                        let name = u32::from_ne_bytes(payload[..4].try_into().unwrap());
                        let bound =
                            u32::from_ne_bytes(payload[payload.len() - 4..].try_into().unwrap());
                        if name == 1 {
                            for (index, title) in titles.iter().enumerate() {
                                let handle = 0xff000000 + index as u32;
                                send_event(&mut server, bound, 0, &handle.to_ne_bytes());
                                send_event(&mut server, handle, 0, &wire_string(title));
                                send_event(&mut server, handle, 1, &wire_string("chrome"));
                                send_event(&mut server, handle, 5, &[]);
                            }
                        }
                    } else if object == 1 && opcode == 0 {
                        let callback = u32::from_ne_bytes(payload[..4].try_into().unwrap());
                        send_event(&mut server, callback, 0, &1u32.to_ne_bytes());
                    } else if object >= 0xff000000 && opcode == 4 {
                        activations += 1;
                    }
                }
                activations
            });
            let conn = Connection::from_socket(client).unwrap();
            let result = activate_connection(
                conn,
                Some(&requested),
                Some("chrome"),
                Instant::now() + std::time::Duration::from_secs(1),
            );
            (result, peer.join().unwrap())
        }

        #[test]
        fn activates_one_unique_protocol_handle() {
            let (result, activations) =
                activation_fixture(vec!["First".into(), "Second".into()], "Second".into());
            result.unwrap();
            assert_eq!(activations, 1);
        }

        #[test]
        fn ambiguous_protocol_handles_send_no_activation() {
            let (result, activations) =
                activation_fixture(vec!["Same".into(), "Same".into()], "Same".into());
            assert!(result.unwrap_err().to_string().contains("ambiguous"));
            assert_eq!(activations, 0);
        }

        #[test]
        fn serialized_long_title_matches_without_accepting_truncation_collisions() {
            let long = "x".repeat(600);
            let (result, activations) =
                activation_fixture(vec![long.clone()], super::super::ipc_string(&long));
            result.unwrap();
            assert_eq!(activations, 1);
            let (result, activations) = activation_fixture(
                vec![long.clone(), format!("{long}other")],
                super::super::ipc_string(&long),
            );
            assert!(result.unwrap_err().to_string().contains("ambiguous"));
            assert_eq!(activations, 0);
        }

        #[test]
        fn signed_char_ipc_titles_match_non_ascii_protocol_titles() {
            let (result, activations) =
                activation_fixture(vec!["שלום - Chrome".into()], " - Chrome".into());
            result.unwrap();
            assert_eq!(activations, 1);
            let (result, activations) = activation_fixture(
                vec!["שלום - Chrome".into(), "hello - Chrome".into()],
                " - Chrome".into(),
            );
            result.unwrap();
            assert_eq!(activations, 1);
        }

        #[test]
        fn stalled_wayland_peer_finishes_at_deadline() {
            let (client, _server) = std::os::unix::net::UnixStream::pair().unwrap();
            let conn = Connection::from_socket(client).unwrap();
            let started = Instant::now();
            let error = activate_connection(
                conn,
                Some("Chrome"),
                Some("chrome"),
                started + std::time::Duration::from_millis(30),
            )
            .unwrap_err();
            assert!(error.to_string().contains("timed out"), "{error}");
            assert!(started.elapsed() < std::time::Duration::from_secs(1));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = r#"[{"pid":510,"x":0,"y":0,"width":1024,"height":768,"title":"New Tab - Google Chrome","app_id":"google-chrome","minimized":false,"fullscreen":false,"maximized":true,"tiled":false,"focused":true}]"#;

    #[test]
    fn parses_labwc_windows() {
        let windows = parse_windows(FIXTURE).unwrap();
        assert_eq!(windows.len(), 1);
        let window = &windows[0];
        assert_eq!(window.title.as_deref(), Some("New Tab - Google Chrome"));
        assert_eq!(window.app_id.as_deref(), Some("google-chrome"));
        assert_eq!(window.pid, Some(510));
        assert!(window.bounds.is_none());
        assert!(window.focused);
        assert!(!window.hidden);
        assert_eq!(window.backend, "labwc");
        assert!(window.client_type.is_none());
    }

    #[test]
    fn labwc_error_reply_is_err() {
        let error = parse_windows(r#"{"error":"unknown command"}"#).unwrap_err();
        assert!(error.to_string().contains("unknown command"), "{error}");
    }

    #[test]
    fn empty_focused_reply_is_none() {
        assert!(parse_window("{}").unwrap().is_none());
        assert!(parse_window("null").unwrap().is_none());
    }

    #[test]
    fn sibling_windows_have_distinct_json_safe_ids() {
        let first: serde_json::Value = serde_json::from_str(FIXTURE).unwrap();
        let mut second = first[0].clone();
        second["title"] = serde_json::json!("Second Chrome window");
        second["focused"] = serde_json::json!(false);
        let windows = parse_windows(&serde_json::json!([first[0], second]).to_string()).unwrap();
        assert_ne!(windows[0].window_id, windows[1].window_id);
        assert!(windows.iter().all(|window| window.window_id < (1u64 << 53)));
        let focused = parse_window(&first[0].to_string()).unwrap().unwrap();
        assert_eq!(focused.window_id, windows[0].window_id);
    }

    #[test]
    fn duplicate_or_stale_window_identity_is_rejected() {
        let first = parse_windows(FIXTURE).unwrap().remove(0);
        assert!(unique_window(&[first.clone(), first.clone()], &first).is_err());
        let mut changed = first.clone();
        changed.title = Some("changed title".into());
        assert!(unique_window(&[changed], &first).is_err());
        assert!(unique_window(&[], &first).is_err());
        assert!(unique_window(std::slice::from_ref(&first), &first).is_ok());
    }

    #[test]
    fn different_compositor_is_rejected() {
        assert!(ensure_compositor(100, 101).is_err());
        assert!(ensure_compositor(100, 100).is_ok());
    }

    #[test]
    fn ipc_titles_match_serialized_limits_and_controls() {
        assert_eq!(ipc_string("a\nb\tc"), "abc");
        assert_eq!(ipc_string(&"x".repeat(600)).len(), 510);
        assert_eq!(ipc_string(&"\"".repeat(600)).len(), 255);
        assert_eq!(ipc_string("quotes \" and \\"), "quotes \" and \\");
    }

    #[test]
    fn byte_truncated_multibyte_title_does_not_break_other_windows() {
        let title = format!("Ab - {}", "日本語のニュース記事".repeat(20));
        let mut reply =
            br#"[{"pid":511,"app_id":"chrome","minimized":false,"focused":false,"title":""#
                .to_vec();
        reply.extend_from_slice(&title.as_bytes()[..510]);
        reply.extend_from_slice(br#""},"#);
        reply.extend_from_slice(&FIXTURE.as_bytes()[1..]);
        let windows = parse_windows(&decode_reply(&reply).unwrap()).unwrap();
        assert_eq!(windows.len(), 2);
        assert_eq!(
            windows[0].title.as_deref(),
            Some(ipc_string(&title).as_str())
        );
        assert!(ipc_matches(Some(&title), windows[0].title.as_deref()));
        assert_eq!(windows[1].title.as_deref(), Some("New Tab - Google Chrome"));
    }

    #[test]
    fn window_id_is_stable() {
        assert_eq!(
            window_id(510, Some("google-chrome"), Some("New Tab")),
            window_id(510, Some("google-chrome"), Some("New Tab"))
        );
        assert_ne!(
            window_id(510, Some("google-chrome"), Some("New Tab")),
            window_id(511, Some("google-chrome"), Some("New Tab"))
        );
    }
}
