use crate::windowing::registry::BackendProbe;
use crate::windowing::types::{WindowInfo, MAX_WINDOW_ID};
use crate::windowing::wayland_session::{self, bounded_sync, peer_pid, SyncState};
use anyhow::{bail, Context, Result};
use std::os::fd::AsRawFd;
use std::os::unix::net::UnixStream;
use std::time::{Duration, Instant};
use wayland_client::protocol::{wl_callback, wl_registry, wl_seat};
use wayland_client::{event_created_child, Connection, Dispatch, EventQueue, QueueHandle};
use wayland_protocols_wlr::foreign_toplevel::v1::client::{
    zwlr_foreign_toplevel_handle_v1 as toplevel_handle,
    zwlr_foreign_toplevel_manager_v1 as toplevel_manager,
};

pub const WLR_FOREIGN_TOPLEVEL_BACKEND: &str = "wlr-foreign-toplevel";
const QUERY_TIMEOUT: Duration = Duration::from_secs(2);
const LIST_ACTION: &str = "wlr-foreign-toplevel query";
const ACTIVATE_ACTION: &str = "wlr-foreign-toplevel activation";
// Compositors describe every existing toplevel, ending with `done`, before
// answering the sync that follows the bind. Later roundtrips only cover a
// toplevel that maps during the query.
const MAX_ROUNDTRIPS: usize = 3;

#[derive(Debug, Default)]
struct Toplevel {
    title: Option<String>,
    app_id: Option<String>,
    activated: bool,
    minimized: bool,
    done: bool,
}

fn window_id(app_id: Option<&str>, title: Option<&str>) -> u64 {
    // The protocol exposes no persistent identifier, pid or geometry, and
    // handle object IDs are per connection. The app id and title are all a
    // fresh connection can match, so siblings that share both are ambiguous
    // and rejected before activation or focus verification. A title change
    // requires a fresh list.
    let mut id = 0xcbf29ce484222325u64;
    for byte in [app_id.unwrap_or(""), title.unwrap_or("")]
        .into_iter()
        .flat_map(|value| {
            (value.len() as u64)
                .to_le_bytes()
                .into_iter()
                .chain(value.bytes())
        })
    {
        id ^= u64::from(byte);
        id = id.wrapping_mul(0x100000001b3);
    }
    id & MAX_WINDOW_ID
}

fn apply_states(toplevel: &mut Toplevel, raw: &[u8]) {
    let states = raw
        .as_chunks::<4>()
        .0
        .iter()
        .map(|chunk| u32::from_ne_bytes(*chunk))
        .collect::<Vec<_>>();
    toplevel.activated = states.contains(&u32::from(toplevel_handle::State::Activated));
    toplevel.minimized = states.contains(&u32::from(toplevel_handle::State::Minimized));
}

fn to_window(toplevel: &Toplevel) -> WindowInfo {
    let app_id = toplevel.app_id.clone().filter(|value| !value.is_empty());
    let title = toplevel.title.clone().filter(|value| !value.is_empty());
    WindowInfo {
        window_id: window_id(app_id.as_deref(), title.as_deref()),
        title,
        wm_class: app_id.clone(),
        app_id,
        pid: None,
        bounds: None,
        workspace: None,
        focused: toplevel.activated,
        hidden: toplevel.minimized,
        client_type: None,
        backend: WLR_FOREIGN_TOPLEVEL_BACKEND.to_string(),
        terminal: None,
    }
}

fn unique_window<'a>(windows: &'a [WindowInfo], requested: &WindowInfo) -> Result<&'a WindowInfo> {
    let mut matches = windows
        .iter()
        .filter(|window| window.window_id == requested.window_id);
    let first = matches
        .next()
        .context("wlr toplevel identity changed; list windows again")?;
    if matches.next().is_some() {
        bail!("wlr toplevel identity is ambiguous; windows share an app id and title");
    }
    if first.app_id != requested.app_id || first.title != requested.title {
        bail!("wlr toplevel identity changed; list windows again");
    }
    Ok(first)
}

fn focused_in(windows: &[WindowInfo]) -> Result<Option<WindowInfo>> {
    let mut focused = windows.iter().filter(|window| window.focused);
    let Some(first) = focused.next() else {
        return Ok(None);
    };
    if focused.next().is_some() {
        bail!("more than one wlr toplevel is activated");
    }
    Ok(Some(unique_window(windows, first)?.clone()))
}

fn ambiguous_count(windows: &[WindowInfo]) -> usize {
    windows
        .iter()
        .filter(|window| {
            windows
                .iter()
                .filter(|other| other.window_id == window.window_id)
                .count()
                > 1
        })
        .count()
}

pub fn probe() -> BackendProbe {
    let listed = connect().and_then(|conn| {
        let (_queue, state) = collect(&conn, Instant::now() + QUERY_TIMEOUT, LIST_ACTION)?;
        Ok((state.seat.is_some(), state.windows()))
    });
    match listed {
        Ok((has_seat, windows)) => {
            let ambiguous = ambiguous_count(&windows);
            let mut detail = format!(
                "zwlr_foreign_toplevel_manager_v1 listed {} toplevels",
                windows.len()
            );
            if !has_seat {
                detail.push_str("; no wl_seat, so activation is unavailable");
            }
            if ambiguous > 0 {
                detail.push_str(&format!(
                    "; {ambiguous} share an app id and title, so exact focus is unavailable until their titles differ"
                ));
            }
            BackendProbe {
                id: WLR_FOREIGN_TOPLEVEL_BACKEND,
                ok: true,
                can_list_windows: true,
                can_focus_apps: has_seat,
                can_focus_windows: has_seat && ambiguous == 0,
                detail,
            }
        }
        Err(error) => BackendProbe {
            id: WLR_FOREIGN_TOPLEVEL_BACKEND,
            ok: false,
            can_list_windows: false,
            can_focus_apps: false,
            can_focus_windows: false,
            detail: format!("{error:#}"),
        },
    }
}

pub(crate) async fn list_windows() -> Result<Vec<WindowInfo>> {
    query(|conn, deadline| Ok(collect(&conn, deadline, LIST_ACTION)?.1.windows())).await
}

pub(crate) async fn focused_window() -> Result<Option<WindowInfo>> {
    focused_in(&list_windows().await?)
}

pub(crate) async fn activate(window: &WindowInfo) -> Result<()> {
    let window = window.clone();
    query(move |conn, deadline| activate_connection(&conn, &window, deadline)).await
}

async fn query<T: Send + 'static>(
    run: impl FnOnce(Connection, Instant) -> Result<T> + Send + 'static,
) -> Result<T> {
    let deadline = Instant::now() + QUERY_TIMEOUT;
    // Await the bounded worker itself. Dropping a timed-out JoinHandle would
    // let it continue and potentially activate after the tool had returned.
    tokio::task::spawn_blocking(move || run(connect()?, deadline))
        .await
        .context("wlr-foreign-toplevel task failed")?
}

fn connect() -> Result<Connection> {
    let path = wayland_session::display_path()
        .context("wlr-foreign-toplevel requires WAYLAND_DISPLAY for an independent connection")?;
    let socket = UnixStream::from(
        wayland_session::connect_nonblocking(&path)
            .with_context(|| format!("could not connect to {}", path.display()))?,
    );
    let compositor = peer_pid(socket.as_raw_fd())?;
    // An inherited Wayland fd is one protocol client, not a reconnectable
    // socket. Use it only to verify that both name the same compositor.
    if let Ok(fd) = std::env::var("WAYLAND_SOCKET") {
        if peer_pid(fd.parse().context("invalid WAYLAND_SOCKET")?)? != compositor {
            bail!("WAYLAND_SOCKET and WAYLAND_DISPLAY belong to different compositors");
        }
    }
    Connection::from_socket(socket).context("no Wayland display")
}

fn collect(
    conn: &Connection,
    deadline: Instant,
    action: &str,
) -> Result<(EventQueue<State>, State)> {
    let mut queue = conn.new_event_queue::<State>();
    let mut state = State::default();
    let _registry = conn.display().get_registry(&queue.handle(), ());
    bounded_sync(conn, &mut queue, &mut state, deadline, action)?;
    if state.manager.is_none() {
        bail!("compositor does not advertise zwlr_foreign_toplevel_manager_v1");
    }
    for _ in 0..MAX_ROUNDTRIPS {
        bounded_sync(conn, &mut queue, &mut state, deadline, action)?;
        if state.finished {
            bail!("wlr foreign toplevel manager has finished");
        }
        if state.toplevels.iter().all(|(_, toplevel)| toplevel.done) {
            return Ok((queue, state));
        }
    }
    bail!("wlr toplevel descriptions did not complete")
}

fn activate_connection(conn: &Connection, requested: &WindowInfo, deadline: Instant) -> Result<()> {
    let (mut queue, mut state) = collect(conn, deadline, ACTIVATE_ACTION)?;
    let seat = state
        .seat
        .clone()
        .context("wlr-foreign-toplevel activation requires a wl_seat")?;
    let window_id = unique_window(&state.windows(), requested)?.window_id;
    let (handle, _) = state
        .described()
        .find(|(_, toplevel)| to_window(toplevel).window_id == window_id)
        .context("wlr toplevel identity changed; list windows again")?;
    handle.activate(&seat);
    bounded_sync(conn, &mut queue, &mut state, deadline, ACTIVATE_ACTION)
}

#[derive(Default)]
struct State {
    manager: Option<toplevel_manager::ZwlrForeignToplevelManagerV1>,
    seat: Option<wl_seat::WlSeat>,
    finished: bool,
    synced: bool,
    toplevels: Vec<(toplevel_handle::ZwlrForeignToplevelHandleV1, Toplevel)>,
}

impl State {
    /// Toplevels whose initial description ended with `done`.
    fn described(
        &self,
    ) -> impl Iterator<Item = &(toplevel_handle::ZwlrForeignToplevelHandleV1, Toplevel)> {
        self.toplevels.iter().filter(|(_, toplevel)| toplevel.done)
    }

    fn windows(&self) -> Vec<WindowInfo> {
        self.described()
            .map(|(_, toplevel)| to_window(toplevel))
            .collect()
    }
}

impl SyncState for State {
    fn synced(&mut self) -> &mut bool {
        &mut self.synced
    }
}

impl Dispatch<toplevel_manager::ZwlrForeignToplevelManagerV1, ()> for State {
    fn event(
        state: &mut Self,
        _: &toplevel_manager::ZwlrForeignToplevelManagerV1,
        event: toplevel_manager::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        match event {
            toplevel_manager::Event::Toplevel { toplevel } => {
                state.toplevels.push((toplevel, Toplevel::default()));
            }
            toplevel_manager::Event::Finished => state.finished = true,
            _ => {}
        }
    }

    event_created_child!(
        State,
        toplevel_manager::ZwlrForeignToplevelManagerV1,
        [toplevel_manager::EVT_TOPLEVEL_OPCODE => (toplevel_handle::ZwlrForeignToplevelHandleV1, ())]
    );
}

impl Dispatch<toplevel_handle::ZwlrForeignToplevelHandleV1, ()> for State {
    fn event(
        state: &mut Self,
        handle: &toplevel_handle::ZwlrForeignToplevelHandleV1,
        event: toplevel_handle::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if let toplevel_handle::Event::Closed = event {
            state.toplevels.retain(|(item, _)| item != handle);
            return;
        }
        let Some((_, toplevel)) = state.toplevels.iter_mut().find(|(item, _)| item == handle)
        else {
            return;
        };
        match event {
            toplevel_handle::Event::Title { title } => toplevel.title = Some(title),
            toplevel_handle::Event::AppId { app_id } => toplevel.app_id = Some(app_id),
            toplevel_handle::Event::State { state } => apply_states(toplevel, &state),
            toplevel_handle::Event::Done => toplevel.done = true,
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
    use std::io::{Read, Write};

    const ACTIVATED: u32 = 2;
    const MINIMIZED: u32 = 1;

    struct FixtureToplevel {
        title: &'static str,
        app_id: &'static str,
        states: Vec<u32>,
        done: bool,
    }

    fn toplevel(title: &'static str, states: Vec<u32>) -> FixtureToplevel {
        FixtureToplevel {
            title,
            app_id: "foot",
            states,
            done: true,
        }
    }

    fn wire_string(value: &str) -> Vec<u8> {
        let mut bytes = ((value.len() + 1) as u32).to_ne_bytes().to_vec();
        bytes.extend_from_slice(value.as_bytes());
        bytes.push(0);
        bytes.resize(bytes.len().next_multiple_of(4), 0);
        bytes
    }

    fn wire_states(states: &[u32]) -> Vec<u8> {
        let mut bytes = ((states.len() * 4) as u32).to_ne_bytes().to_vec();
        bytes.extend(states.iter().flat_map(|state| state.to_ne_bytes()));
        bytes
    }

    fn send_event(
        stream: &mut std::os::unix::net::UnixStream,
        object: u32,
        opcode: u16,
        payload: &[u8],
    ) {
        let mut bytes = object.to_ne_bytes().to_vec();
        bytes.extend_from_slice(
            &((((payload.len() + 8) as u32) << 16) | u32::from(opcode)).to_ne_bytes(),
        );
        bytes.extend_from_slice(payload);
        stream.write_all(&bytes).unwrap();
    }

    // A minimal real Wayland peer exercises registry binding, server-created
    // handles, title/app-id/state events, `done` and activation on the wire.
    // It returns the handle index of each activation request.
    fn fixture<T>(
        manager: bool,
        toplevels: Vec<FixtureToplevel>,
        run: impl FnOnce(&Connection) -> T,
    ) -> (T, Vec<u32>) {
        let (client, mut server) = std::os::unix::net::UnixStream::pair().unwrap();
        server
            .set_read_timeout(Some(std::time::Duration::from_secs(1)))
            .unwrap();
        let peer = std::thread::spawn(move || {
            let mut registry = 0;
            let mut activations = Vec::new();
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
                    let globals = [
                        (1u32, "zwlr_foreign_toplevel_manager_v1", 3u32),
                        (2, "wl_seat", 7),
                    ];
                    for (name, interface, version) in
                        globals.into_iter().skip(usize::from(!manager))
                    {
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
                        for (index, toplevel) in toplevels.iter().enumerate() {
                            let handle = 0xff000000 + index as u32;
                            send_event(&mut server, bound, 0, &handle.to_ne_bytes());
                            send_event(&mut server, handle, 0, &wire_string(toplevel.title));
                            send_event(&mut server, handle, 1, &wire_string(toplevel.app_id));
                            send_event(&mut server, handle, 4, &wire_states(&toplevel.states));
                            if toplevel.done {
                                send_event(&mut server, handle, 5, &[]);
                            }
                        }
                    }
                } else if object == 1 && opcode == 0 {
                    let callback = u32::from_ne_bytes(payload[..4].try_into().unwrap());
                    send_event(&mut server, callback, 0, &1u32.to_ne_bytes());
                } else if object >= 0xff000000 && opcode == 4 {
                    activations.push(object - 0xff000000);
                }
            }
            activations
        });
        let conn = Connection::from_socket(client).unwrap();
        let result = run(&conn);
        drop(conn);
        (result, peer.join().unwrap())
    }

    fn deadline() -> Instant {
        Instant::now() + Duration::from_secs(1)
    }

    fn list(toplevels: Vec<FixtureToplevel>) -> Vec<WindowInfo> {
        fixture(true, toplevels, |conn| {
            collect(conn, deadline(), LIST_ACTION).unwrap().1.windows()
        })
        .0
    }

    #[test]
    fn lists_described_toplevels_with_activated_and_minimized_state() {
        let windows = list(vec![
            toplevel("editor", vec![ACTIVATED]),
            toplevel("logs", vec![MINIMIZED, 0]),
        ]);
        assert_eq!(windows.len(), 2);
        let (editor, logs) = (&windows[0], &windows[1]);
        assert_eq!(editor.title.as_deref(), Some("editor"));
        assert_eq!(editor.app_id.as_deref(), Some("foot"));
        assert_eq!(editor.wm_class.as_deref(), Some("foot"));
        assert!(editor.focused && !editor.hidden);
        assert!(!logs.focused && logs.hidden);
        assert!(windows
            .iter()
            .all(|window| window.pid.is_none() && window.bounds.is_none()));
        assert_eq!(editor.backend, "wlr-foreign-toplevel");
    }

    #[test]
    fn incomplete_descriptions_prevent_activation() {
        let requested = list(vec![toplevel("editor", Vec::new())]).remove(0);
        let mut partial = toplevel("editor", Vec::new());
        partial.done = false;
        let (result, activations) = fixture(
            true,
            vec![toplevel("editor", Vec::new()), partial],
            |conn| activate_connection(conn, &requested, deadline()),
        );
        assert!(result.unwrap_err().to_string().contains("did not complete"));
        assert!(activations.is_empty());
    }

    #[test]
    fn missing_manager_is_an_error() {
        let (result, _) = fixture(false, Vec::new(), |conn| {
            collect(conn, deadline(), LIST_ACTION).map(|(_, state)| state.windows())
        });
        let error = result.unwrap_err().to_string();
        assert!(
            error.contains("zwlr_foreign_toplevel_manager_v1"),
            "{error}"
        );
    }

    #[test]
    fn activates_one_unique_protocol_handle() {
        let toplevels = || {
            vec![
                toplevel("first", vec![ACTIVATED]),
                toplevel("second", Vec::new()),
            ]
        };
        let requested = list(toplevels()).remove(1);
        let (result, activations) = fixture(true, toplevels(), |conn| {
            activate_connection(conn, &requested, deadline())
        });
        result.unwrap();
        assert_eq!(activations, [1]);
    }

    #[test]
    fn ambiguous_or_stale_identity_sends_no_activation() {
        let same = || {
            vec![
                toplevel("foot", vec![ACTIVATED]),
                toplevel("foot", Vec::new()),
            ]
        };
        let requested = list(same()).remove(1);
        let (result, activations) = fixture(true, same(), |conn| {
            activate_connection(conn, &requested, deadline())
        });
        assert!(result.unwrap_err().to_string().contains("ambiguous"));
        assert!(activations.is_empty());

        let mut renamed = requested.clone();
        renamed.title = Some("renamed".into());
        renamed.window_id = window_id(Some("foot"), Some("renamed"));
        let (result, activations) = fixture(true, same(), |conn| {
            activate_connection(conn, &renamed, deadline())
        });
        assert!(result.unwrap_err().to_string().contains("changed"));
        assert!(activations.is_empty());
    }

    #[test]
    fn stalled_wayland_peer_finishes_at_deadline() {
        let (client, _server) = std::os::unix::net::UnixStream::pair().unwrap();
        let conn = Connection::from_socket(client).unwrap();
        let started = Instant::now();
        let error = collect(&conn, started + Duration::from_millis(30), LIST_ACTION)
            .map(|_| ())
            .unwrap_err();
        assert_eq!(error.to_string(), "wlr-foreign-toplevel query timed out");
        assert!(started.elapsed() < Duration::from_secs(1));

        let (client, _server) = std::os::unix::net::UnixStream::pair().unwrap();
        let conn = Connection::from_socket(client).unwrap();
        let requested = list(vec![toplevel("editor", Vec::new())]).remove(0);
        let error = activate_connection(
            &conn,
            &requested,
            Instant::now() + Duration::from_millis(30),
        )
        .unwrap_err();
        assert_eq!(
            error.to_string(),
            "wlr-foreign-toplevel activation timed out"
        );
    }

    #[test]
    fn focus_requires_one_activated_unambiguous_toplevel() {
        let unique = list(vec![
            toplevel("a", vec![ACTIVATED]),
            toplevel("b", Vec::new()),
        ]);
        assert_eq!(
            focused_in(&unique).unwrap().unwrap().title.as_deref(),
            Some("a")
        );
        assert_eq!(ambiguous_count(&unique), 0);

        let none = list(vec![toplevel("a", Vec::new())]);
        assert!(focused_in(&none).unwrap().is_none());

        let ambiguous = list(vec![
            toplevel("a", vec![ACTIVATED]),
            toplevel("a", Vec::new()),
        ]);
        assert!(focused_in(&ambiguous).is_err());
        assert_eq!(ambiguous_count(&ambiguous), 2);

        let two = list(vec![
            toplevel("a", vec![ACTIVATED]),
            toplevel("b", vec![ACTIVATED]),
        ]);
        assert!(focused_in(&two).is_err());
    }

    #[test]
    fn window_id_is_stable_distinct_and_json_safe() {
        assert_eq!(
            window_id(Some("foot"), Some("~")),
            window_id(Some("foot"), Some("~"))
        );
        assert_ne!(
            window_id(Some("foot"), Some("~")),
            window_id(Some("foot"), Some("~/src"))
        );
        // Length prefixes keep a moved boundary from colliding.
        assert_ne!(
            window_id(Some("ab"), Some("c")),
            window_id(Some("a"), Some("bc"))
        );
        assert_ne!(window_id(None, Some("x")), window_id(Some("x"), None));
        assert!(window_id(Some("foot"), Some("~")) <= MAX_WINDOW_ID);
    }

    #[test]
    fn empty_strings_are_missing_values() {
        let window = to_window(&Toplevel {
            title: Some(String::new()),
            app_id: Some(String::new()),
            ..Default::default()
        });
        assert!(window.title.is_none() && window.app_id.is_none());
        assert_eq!(window.window_id, window_id(None, None));
    }
}
