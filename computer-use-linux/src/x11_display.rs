//! Minimal X11 protocol client for native X11 sessions.
//!
//! The EWMH window backend lists windows with `wmctrl -lG`, but wmctrl's x/y
//! are not the window origin: it translates the client's offset inside its
//! parent a second time (Red Hat bug 654888, closed WONTFIX). Under a
//! reparenting WM that adds the frame offset twice; under a non-reparenting WM
//! it doubles the absolute position. This module asks the X server directly.
//!
//! It also captures the root window for the native X11 screenshot route:
//! `GetImage` returns device pixels, the same space xdotool/XTEST and these
//! window origins use, with no toolkit scaling layer (issue #155).
//!
//! Callers must gate on [`is_native_x11_session`] first, so XWayland under a
//! Wayland compositor is never used.

use anyhow::{anyhow, bail, Context, Result};
use std::{
    env, io,
    net::{IpAddr, SocketAddr, TcpStream},
    os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd},
    os::unix::net::UnixStream,
    sync::Mutex,
    time::{Duration, Instant},
};
use x11rb::connection::Connection;
use x11rb::protocol::xkb::ConnectionExt as _;
use x11rb::protocol::xproto::{
    AtomEnum, ChangeWindowAttributesAux, ConnectionExt as _, EventMask, ImageFormat, ImageOrder,
    VisualClass, Window,
};
use x11rb::protocol::{xkb, Event};
use x11rb::{
    reexports::x11rb_protocol::{
        parse_display::{parse_display, ConnectAddress},
        xauth::get_auth,
    },
    rust_connection::{DefaultStream, PollMode, RustConnection, Stream},
    utils::RawFdContainer,
};

/// Bound on one X11 query, including the connection handshake.
pub(crate) const X11_QUERY_TIMEOUT: Duration = Duration::from_secs(2);
/// Root-window capture moves tens of MB on large screens; allow more time.
pub(crate) const X11_CAPTURE_TIMEOUT: Duration = Duration::from_secs(5);

/// True when this looks like a plain X11 session.
///
/// Requires an X `DISPLAY` and either an explicit `x11` session type or the
/// absence of a Wayland display, so we never hijack XWayland under a Wayland
/// compositor (where a native backend should answer instead).
pub(crate) fn is_native_x11_session() -> bool {
    if env_nonempty("DISPLAY").is_none() {
        return false;
    }
    match env_nonempty("XDG_SESSION_TYPE").as_deref() {
        Some("x11") => true,
        Some("wayland") => false,
        _ => env_nonempty("WAYLAND_DISPLAY").is_none(),
    }
}

fn env_nonempty(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// Run `f` against a fresh X connection off the async runtime, bounded by
/// `limit` so a wedged X server cannot hang a tool call.
pub(crate) async fn with_x11_display<T, F>(limit: Duration, f: F) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce(&X11Display) -> T + Send + 'static,
{
    let deadline = Instant::now() + limit;
    tokio::task::spawn_blocking(move || {
        X11Display::connect_until(deadline).map(|display| f(&display))
    })
    .await
    .map_err(|join_error| anyhow!("X11 query task failed: {join_error}"))?
}

/// The deadline is enforced in the transport itself, including handshake and
/// every reply. Timing out a JoinHandle would leave its blocking task alive.
struct DeadlineStream {
    inner: DefaultStream,
    deadline: Mutex<Instant>,
}

fn remaining(deadline: Instant) -> io::Result<Duration> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|remaining| !remaining.is_zero())
        .ok_or_else(|| io::Error::new(io::ErrorKind::TimedOut, "X server query deadline exceeded"))
}

fn poll_until(fd: RawFd, mode: PollMode, deadline: Instant) -> io::Result<()> {
    let mut pollfd = libc::pollfd {
        fd,
        events: (if mode.readable() { libc::POLLIN } else { 0 })
            | (if mode.writable() { libc::POLLOUT } else { 0 }),
        revents: 0,
    };
    loop {
        let timeout = remaining(deadline)?
            .as_millis()
            .saturating_add(1)
            .min(i32::MAX as u128) as i32;
        // SAFETY: pollfd points to one valid descriptor record for this call.
        match unsafe { libc::poll(&mut pollfd, 1, timeout) } {
            0 => {
                remaining(deadline)?;
            }
            -1 => {
                let error = io::Error::last_os_error();
                if error.kind() != io::ErrorKind::Interrupted {
                    return Err(error);
                }
            }
            _ => return Ok(()),
        }
    }
}

impl Stream for DeadlineStream {
    fn poll(&self, mode: PollMode) -> io::Result<()> {
        poll_until(self.inner.as_raw_fd(), mode, *self.deadline.lock().unwrap())
    }
    fn read(&self, buf: &mut [u8], fds: &mut Vec<RawFdContainer>) -> io::Result<usize> {
        remaining(*self.deadline.lock().unwrap())?;
        self.inner.read(buf, fds)
    }
    fn write(&self, buf: &[u8], fds: &mut Vec<RawFdContainer>) -> io::Result<usize> {
        remaining(*self.deadline.lock().unwrap())?;
        self.inner.write(buf, fds)
    }
}

pub(crate) fn connect_unix(path: &str, deadline: Instant) -> io::Result<UnixStream> {
    remaining(deadline)?;
    // SAFETY: socket returns a new descriptor owned below or -1 on failure.
    let raw = unsafe {
        libc::socket(
            libc::AF_UNIX,
            libc::SOCK_STREAM | libc::SOCK_CLOEXEC | libc::SOCK_NONBLOCK,
            0,
        )
    };
    if raw == -1 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: raw is a new owned descriptor.
    let fd = unsafe { OwnedFd::from_raw_fd(raw) };
    // SAFETY: zero is valid for sockaddr_un; all used fields are filled below.
    let mut address: libc::sockaddr_un = unsafe { std::mem::zeroed() };
    address.sun_family = libc::AF_UNIX as _;
    if path.len() >= address.sun_path.len() || path.as_bytes().contains(&0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid X11 Unix socket path",
        ));
    }
    for (dest, &byte) in address.sun_path.iter_mut().zip(path.as_bytes()) {
        *dest = byte as _;
    }
    // SAFETY: address is initialized and the length describes the entire struct.
    let status = unsafe {
        libc::connect(
            fd.as_raw_fd(),
            (&address as *const libc::sockaddr_un).cast(),
            std::mem::size_of_val(&address) as _,
        )
    };
    if status == -1 {
        let error = io::Error::last_os_error();
        // Unix sockets report EAGAIN when their listen queue is full. Unlike
        // TCP EINPROGRESS this is not an in-flight connection; fail promptly.
        if error.raw_os_error() != Some(libc::EINPROGRESS) {
            return Err(error);
        }
        poll_until(fd.as_raw_fd(), PollMode::Writable, deadline)?;
        let stream = UnixStream::from(fd);
        if let Some(error) = stream.take_error()? {
            return Err(error);
        }
        return Ok(stream);
    }
    Ok(UnixStream::from(fd))
}

fn tcp_addresses(host: &str, port: u16, deadline: Instant) -> Result<Vec<SocketAddr>> {
    if let Ok(ip) = host.parse::<IpAddr>() {
        return Ok(vec![SocketAddr::new(ip, port)]);
    }
    if host == "localhost" {
        return Ok(vec![
            SocketAddr::from(([127, 0, 0, 1], port)),
            SocketAddr::from(([0, 0, 0, 0, 0, 0, 0, 1], port)),
        ]);
    }
    // std's hostname resolver can block indefinitely in NSS. Isolate only
    // that lookup in the existing bounded process runner, never a detached thread.
    let result = crate::command_runner::output_blocking_with_timeout(
        std::process::Command::new("getent").args(["ahosts", "--", host]),
        "resolve X11 host",
        remaining(deadline)?,
    )?;
    let addresses = String::from_utf8_lossy(&result.stdout)
        .lines()
        .filter_map(|line| line.split_whitespace().next()?.parse::<IpAddr>().ok())
        .map(|ip| SocketAddr::new(ip, port))
        .collect::<Vec<_>>();
    if !result.status.success() || addresses.is_empty() {
        bail!("failed to resolve X11 host {host}");
    }
    Ok(addresses)
}

pub(crate) struct X11Display {
    conn: RustConnection<DeadlineStream>,
    root: Window,
    screen: usize,
}

/// Observe layout and focus events for the complete xdotool dispatch. Unlike
/// comparing only before/after hashes, this catches a layout changed and then
/// restored during one call. It deliberately ignores core MappingNotify:
/// xdotool temporarily maps spare keycodes for otherwise unavailable symbols.
pub(crate) struct X11TypingGuard {
    display: X11Display,
    mapping: (u8, Vec<u32>),
    group: xkb::Group,
    focus: Window,
}

impl X11TypingGuard {
    pub(crate) fn start() -> Result<Self> {
        let display = X11Display::connect()?;
        let conn = &display.conn;
        let focus = conn.get_input_focus()?.reply()?.focus;
        // PointerRoot (1) is not a window: focus can follow pointer motion
        // without an observable focus event on the current target.
        if focus == 1 {
            bail!("X11 keyboard monitoring does not support PointerRoot; input follows the window under the pointer");
        }
        // GetInputFocus stays unchanged during an active keyboard grab. Core
        // focus events still report NotifyGrab/NotifyUngrab, including when
        // the application itself reads keyboard input through XInput2.
        let monitor_window = if focus > 1 { focus } else { display.root };
        conn.change_window_attributes(
            monitor_window,
            &ChangeWindowAttributesAux::new().event_mask(EventMask::FOCUS_CHANGE),
        )?
        .check()?;
        if !conn.xkb_use_extension(1, 0)?.reply()?.supported {
            bail!("X11 keyboard layout monitoring requires XKB");
        }
        conn.xkb_select_events(
            xkb::ID::USE_CORE_KBD.into(),
            xkb::EventType::default(),
            xkb::EventType::NEW_KEYBOARD_NOTIFY | xkb::EventType::NAMES_NOTIFY,
            xkb::MapPart::default(),
            xkb::MapPart::default(),
            &xkb::SelectEventsAux::default(),
        )?
        .check()?;
        let mapping = display.keyboard_mapping()?;
        let group = conn
            .xkb_get_state(xkb::ID::USE_CORE_KBD.into())?
            .reply()?
            .group;
        // Finish registration and discard events preceding the dispatch boundary.
        conn.get_input_focus()?.reply()?;
        while conn.poll_for_event()?.is_some() {
            remaining(*conn.stream().deadline.lock().unwrap())?;
        }
        Ok(Self {
            display,
            mapping,
            group,
            focus,
        })
    }

    pub(crate) fn verify(self) -> Result<()> {
        let conn = &self.display.conn;
        // Dispatch can take longer than a query. Renew the transport deadline
        // only after xdotool exits, keeping setup and verification bounded.
        *conn.stream().deadline.lock().unwrap() = Instant::now() + X11_QUERY_TIMEOUT;
        let mapping = self.display.keyboard_mapping()?;
        let group = conn
            .xkb_get_state(xkb::ID::USE_CORE_KBD.into())?
            .reply()?
            .group;
        let focus = conn.get_input_focus()?.reply()?.focus;
        let mut changed = self.mapping != mapping || self.group != group;
        let mut diverted = self.focus != focus;
        while let Some(event) = conn.poll_for_event()? {
            remaining(*conn.stream().deadline.lock().unwrap())?;
            // FocusIn also catches a grab ending after the monitor started.
            if matches!(event, Event::FocusOut(_) | Event::FocusIn(_)) {
                diverted = true;
            }
            // Xorg also emits NewKeyboardNotify for xdotool's temporary
            // scratch-keycode SetMap requests. Those are not layout loads.
            // Persistent mapping differences are checked above; names and
            // GetKeyboardByName loads still catch br -> us -> br replacements.
            if matches!(event, Event::XkbNamesNotify(_))
                || matches!(event, Event::XkbNewKeyboardNotify(ref event)
                    if event.request_minor != xkb::SET_MAP_REQUEST)
            {
                changed = true;
            }
        }
        if changed {
            bail!("X11 keyboard layout changed during type_text; dispatched text may be substituted or missing. Inspect the target before submitting or retrying; do not retry blindly.");
        }
        if diverted {
            bail!("X11 keyboard focus changed or was grabbed during type_text; some dispatched text may have been diverted or lost. Inspect the target before submitting or retrying; do not retry blindly.");
        }
        Ok(())
    }
}

/// Root-window pixels as tightly packed RGB8.
pub(crate) struct RootImage {
    pub width: u32,
    pub height: u32,
    pub rgb: Vec<u8>,
}

/// `_NET_FRAME_EXTENTS`: decoration widths the WM adds around the client area.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct FrameExtents {
    pub left: u32,
    pub right: u32,
    pub top: u32,
    pub bottom: u32,
}

impl X11Display {
    fn keyboard_mapping(&self) -> Result<(u8, Vec<u32>)> {
        let setup = self.conn.setup();
        let count = setup.max_keycode - setup.min_keycode + 1;
        let reply = self
            .conn
            .get_keyboard_mapping(setup.min_keycode, count)?
            .reply()?;
        Ok((reply.keysyms_per_keycode, reply.keysyms))
    }

    /// Connect to the display named by `DISPLAY`, authenticating with
    /// `XAUTHORITY` or `~/.Xauthority` the same way Xlib clients do.
    pub(crate) fn connect() -> Result<Self> {
        Self::connect_until(Instant::now() + X11_QUERY_TIMEOUT)
    }

    fn connect_until(deadline: Instant) -> Result<Self> {
        let display = env::var("DISPLAY").context("DISPLAY is not set")?;
        Self::connect_named(&display, deadline)
    }

    fn connect_named(display: &str, deadline: Instant) -> Result<Self> {
        let parsed = parse_display(Some(display))?;
        let screen = usize::from(parsed.screen);
        let mut last_error = anyhow!("no X11 connection addresses");
        let mut connected = None;
        for address in parsed.connect_instruction() {
            let attempt = (|| -> Result<_> {
                match address {
                    ConnectAddress::Socket(path) => Ok(DefaultStream::from_unix_stream(
                        connect_unix(&path, deadline)?,
                    )?),
                    ConnectAddress::Hostname(host, port) => {
                        let mut error = anyhow!("no X11 TCP addresses");
                        for addr in tcp_addresses(host, port, deadline)? {
                            match TcpStream::connect_timeout(&addr, remaining(deadline)?) {
                                Ok(stream) => return Ok(DefaultStream::from_tcp_stream(stream)?),
                                Err(e) => error = e.into(),
                            }
                        }
                        Err(error)
                    }
                    _ => bail!("unsupported X11 address family"),
                }
            })();
            match attempt {
                Ok(stream) => {
                    connected = Some(stream);
                    break;
                }
                Err(error) => last_error = error,
            }
        }
        let (inner, (family, address)) = connected
            .ok_or(last_error)
            .context("failed to connect to the X server named by DISPLAY")?;
        let (auth_name, auth_data) = get_auth(family, &address, parsed.display)
            .unwrap_or(None)
            .unwrap_or_default();
        let conn = RustConnection::connect_to_stream_with_auth_info(
            DeadlineStream {
                inner,
                deadline: Mutex::new(deadline),
            },
            screen,
            auth_name,
            auth_data,
        )
        .context("failed X11 connection handshake")?;
        let root = conn
            .setup()
            .roots
            .get(screen)
            .context("X server reported no screen for DISPLAY")?
            .root;
        Ok(Self { conn, root, screen })
    }

    /// `DISPLAY` screen size and root depth, for doctor.
    pub(crate) fn describe(&self) -> String {
        let screen = &self.conn.setup().roots[self.screen];
        format!(
            "native X11 root window {}x{}, depth {}",
            screen.width_in_pixels, screen.height_in_pixels, screen.root_depth
        )
    }

    /// Capture the whole root window with one `GetImage` request.
    pub(crate) fn capture_root(&self) -> Result<RootImage> {
        let setup = self.conn.setup();
        let screen = &setup.roots[self.screen];
        let (width, height) = (screen.width_in_pixels, screen.height_in_pixels);
        let reply = self
            .conn
            .get_image(ImageFormat::Z_PIXMAP, self.root, 0, 0, width, height, !0)?
            .reply()
            .context("X server refused GetImage on the root window")?;
        let visual = screen
            .allowed_depths
            .iter()
            .flat_map(|depth| &depth.visuals)
            .find(|visual| visual.visual_id == reply.visual)
            .with_context(|| format!("root image visual 0x{:x} is not listed", reply.visual))?;
        if !matches!(
            visual.class,
            VisualClass::TRUE_COLOR | VisualClass::DIRECT_COLOR
        ) {
            bail!(
                "root visual class {:?} is not TrueColor or DirectColor; palette-based displays are not supported",
                visual.class
            );
        }
        let format = setup
            .pixmap_formats
            .iter()
            .find(|format| format.depth == reply.depth)
            .with_context(|| format!("no pixmap format for depth {}", reply.depth))?;
        let layout = ZPixmapLayout {
            bits_per_pixel: u32::from(format.bits_per_pixel),
            scanline_pad: u32::from(format.scanline_pad),
            msb_first: setup.image_byte_order == ImageOrder::MSB_FIRST,
            red_mask: visual.red_mask,
            green_mask: visual.green_mask,
            blue_mask: visual.blue_mask,
        };
        let rgb = zpixmap_to_rgb(&reply.data, u32::from(width), u32::from(height), &layout)?;
        Ok(RootImage {
            width: u32::from(width),
            height: u32::from(height),
            rgb,
        })
    }

    /// Absolute root-window origin of each window's client area, the value
    /// `xwininfo` prints as "Absolute upper-left". Requests are pipelined, so
    /// this costs one round trip for the whole list. `None` marks a window that
    /// vanished, is invalid, or sits on another screen.
    pub(crate) fn client_origins(&self, windows: &[Window]) -> Vec<Option<(i32, i32)>> {
        let cookies = windows
            .iter()
            .map(|&window| {
                self.conn
                    .translate_coordinates(window, self.root, 0, 0)
                    .ok()
            })
            .collect::<Vec<_>>();
        cookies
            .into_iter()
            .map(|cookie| {
                let reply = cookie?.reply().ok()?;
                reply
                    .same_screen
                    .then(|| (i32::from(reply.dst_x), i32::from(reply.dst_y)))
            })
            .collect()
    }

    /// The WM's `_NET_FRAME_EXTENTS` for `window`, or `None` when the WM does
    /// not publish it.
    pub(crate) fn frame_extents(&self, window: Window) -> Result<Option<FrameExtents>> {
        let atom = self
            .conn
            .intern_atom(true, b"_NET_FRAME_EXTENTS")?
            .reply()
            .context("failed to intern _NET_FRAME_EXTENTS")?
            .atom;
        if atom == x11rb::NONE {
            return Ok(None);
        }
        let reply = self
            .conn
            .get_property(false, window, atom, AtomEnum::CARDINAL, 0, 4)?
            .reply()
            .context("failed to read _NET_FRAME_EXTENTS")?;
        Ok(parse_frame_extents(
            reply.value32().map(|values| values.collect::<Vec<_>>()),
        ))
    }
}

fn parse_frame_extents(values: Option<Vec<u32>>) -> Option<FrameExtents> {
    match values.as_deref() {
        Some(&[left, right, top, bottom]) => Some(FrameExtents {
            left,
            right,
            top,
            bottom,
        }),
        _ => None,
    }
}

/// Frame (outer) origin from a client origin and the WM's extents. With the
/// default NorthWest gravity this is the point `wmctrl -e 0,x,y,...` places.
pub(crate) fn frame_origin(client_origin: (i32, i32), extents: FrameExtents) -> (i32, i32) {
    (
        client_origin
            .0
            .saturating_sub(i32::try_from(extents.left).unwrap_or(i32::MAX)),
        client_origin
            .1
            .saturating_sub(i32::try_from(extents.top).unwrap_or(i32::MAX)),
    )
}

/// How the server packs one ZPixmap scanline, from the connection setup and
/// the image's visual.
#[derive(Clone, Copy, Debug)]
struct ZPixmapLayout {
    bits_per_pixel: u32,
    scanline_pad: u32,
    msb_first: bool,
    red_mask: u32,
    green_mask: u32,
    blue_mask: u32,
}

fn zpixmap_to_rgb(data: &[u8], width: u32, height: u32, layout: &ZPixmapLayout) -> Result<Vec<u8>> {
    let bytes_per_pixel = match layout.bits_per_pixel {
        16 | 24 | 32 => (layout.bits_per_pixel / 8) as usize,
        other => bail!("{other}-bit ZPixmap pixels are not supported"),
    };
    let pad = layout.scanline_pad.max(8);
    let stride = ((width * layout.bits_per_pixel).div_ceil(pad) * pad / 8) as usize;
    let (width, height) = (width as usize, height as usize);
    let needed = stride
        .checked_mul(height)
        .context("root image size overflowed")?;
    if data.len() < needed {
        bail!(
            "GetImage returned {} bytes; {width}x{height} at stride {stride} needs {needed}",
            data.len()
        );
    }
    let mut rgb = Vec::with_capacity(width * height * 3);
    for row in data[..needed].chunks_exact(stride) {
        for pixel in row[..width * bytes_per_pixel].chunks_exact(bytes_per_pixel) {
            let value = pixel.iter().enumerate().fold(0_u32, |acc, (index, &byte)| {
                let shift = if layout.msb_first {
                    8 * (bytes_per_pixel - 1 - index)
                } else {
                    8 * index
                };
                acc | (u32::from(byte) << shift)
            });
            rgb.push(channel_to_u8(value, layout.red_mask));
            rgb.push(channel_to_u8(value, layout.green_mask));
            rgb.push(channel_to_u8(value, layout.blue_mask));
        }
    }
    Ok(rgb)
}

/// Extract the channel selected by `mask` and scale it to 8 bits.
fn channel_to_u8(pixel: u32, mask: u32) -> u8 {
    if mask == 0 {
        return 0;
    }
    let shift = mask.trailing_zeros();
    let bits = (mask >> shift).count_ones();
    let value = (pixel & mask) >> shift;
    if bits >= 8 {
        (value >> (bits - 8)) as u8
    } else {
        let max = (1_u32 << bits) - 1;
        ((value * 255 + max / 2) / max) as u8
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stalled_servers_release_queries_and_runtime() {
        const CHILD: &str = "COMPUTER_USE_LINUX_TEST_X11_DEADLINE_CHILD";
        if env::var_os(CHILD).is_some() {
            use std::io::{Read, Write};
            use std::net::TcpListener;
            use x11rb::protocol::xproto::{Screen, Setup};
            use x11rb::reexports::x11rb_protocol::x11_utils::Serialize;

            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            assert!(port >= 6000);
            env::set_var("DISPLAY", format!("127.0.0.1:{}", port - 6000));
            env::set_var("XAUTHORITY", "/dev/null");
            let server = std::thread::spawn(move || {
                for index in 0..6 {
                    let (mut peer, _) = listener.accept().unwrap();
                    let mut header = [0; 12];
                    peer.read_exact(&mut header).unwrap();
                    let name = u16::from_ne_bytes([header[6], header[7]]) as usize;
                    let data = u16::from_ne_bytes([header[8], header[9]]) as usize;
                    let mut auth = vec![0; name.div_ceil(4) * 4 + data.div_ceil(4) * 4];
                    peer.read_exact(&mut auth).unwrap();
                    if index >= 3 {
                        let mut setup = Setup {
                            status: 1,
                            protocol_major_version: 11,
                            resource_id_base: 0x02000000,
                            resource_id_mask: 0x001fffff,
                            maximum_request_length: u16::MAX,
                            roots: vec![Screen {
                                root: 1,
                                width_in_pixels: 16,
                                height_in_pixels: 16,
                                ..Screen::default()
                            }],
                            ..Setup::default()
                        };
                        setup.length = ((setup.serialize().len() - 8) / 4) as u16;
                        peer.write_all(&setup.serialize()).unwrap();
                    }
                    // Deliberately never answer handshake/reply. EOF proves
                    // the timed-out query actually dropped its transport.
                    let mut requests = Vec::new();
                    peer.read_to_end(&mut requests).unwrap();
                    if index >= 3 {
                        assert!(!requests.is_empty());
                    }
                }
            });
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            let started = Instant::now();
            runtime.block_on(async {
                for _ in 0..3 {
                    assert!(
                        with_x11_display(Duration::from_millis(70), |display| display.describe())
                            .await
                            .is_err()
                    );
                }
                // All reply consumers share the deadline, including geometry,
                // screenshot and the pipelined per-window origin queries.
                assert!(
                    with_x11_display(Duration::from_millis(70), |display| display
                        .frame_extents(1))
                    .await
                    .unwrap()
                    .is_err()
                );
                assert!(
                    with_x11_display(Duration::from_millis(70), |display| display.capture_root())
                        .await
                        .unwrap()
                        .is_err()
                );
                assert_eq!(
                    with_x11_display(Duration::from_millis(70), |display| display
                        .client_origins(&[1, 2]))
                    .await
                    .unwrap(),
                    vec![None, None]
                );
            });
            // Unlike timeout(JoinHandle), the runtime has no blocked workers
            // left to wait for, even while the fake server stays connected.
            drop(runtime);
            server.join().unwrap();
            assert!(started.elapsed() < Duration::from_secs(2));
            return;
        }
        // A subprocess makes runtime-exit regression fail in bounded time,
        // rather than hanging the entire test runner on drop(Runtime).
        let mut child = std::process::Command::new(env::current_exe().unwrap())
            .args([
                "--exact",
                "x11_display::tests::stalled_servers_release_queries_and_runtime",
                "--nocapture",
            ])
            .env(CHILD, "1")
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(status) = child.try_wait().unwrap() {
                assert!(status.success());
                break;
            }
            if Instant::now() >= deadline {
                child.kill().unwrap();
                child.wait().unwrap();
                panic!("X11 queries or runtime failed to terminate after transport deadlines");
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn unix_connect_fails_promptly_when_listen_queue_is_full() {
        use std::os::unix::net::UnixListener;
        let path = format!(
            "/tmp/computer-use-linux-x11-deadline-{}-{}",
            std::process::id(),
            getrandom::u64().unwrap()
        );
        let listener = UnixListener::bind(&path).unwrap();
        // SAFETY: listener owns a valid listening socket; shrink its backlog.
        assert_eq!(unsafe { libc::listen(listener.as_raw_fd(), 0) }, 0);
        let queued = UnixStream::connect(&path).unwrap();
        let started = Instant::now();
        assert!(connect_unix(&path, started + Duration::from_millis(70)).is_err());
        assert!(started.elapsed() < Duration::from_millis(500));
        drop(queued);
        drop(listener);
        std::fs::remove_file(path).unwrap();
    }

    const BGRX: ZPixmapLayout = ZPixmapLayout {
        bits_per_pixel: 32,
        scanline_pad: 32,
        msb_first: false,
        red_mask: 0x00ff_0000,
        green_mask: 0x0000_ff00,
        blue_mask: 0x0000_00ff,
    };

    #[test]
    fn depth24_lsb_first_is_bgrx_bytes() {
        // Two pixels: pure red, then 0x123456. Bytes are B,G,R,X per pixel.
        let data = [0x00, 0x00, 0xff, 0x00, 0x56, 0x34, 0x12, 0xaa];
        assert_eq!(
            zpixmap_to_rgb(&data, 2, 1, &BGRX).unwrap(),
            vec![0xff, 0x00, 0x00, 0x12, 0x34, 0x56]
        );
    }

    #[test]
    fn msb_first_reads_bytes_big_endian() {
        let layout = ZPixmapLayout {
            msb_first: true,
            ..BGRX
        };
        let data = [0x00, 0x12, 0x34, 0x56];
        assert_eq!(
            zpixmap_to_rgb(&data, 1, 1, &layout).unwrap(),
            vec![0x12, 0x34, 0x56]
        );
    }

    #[test]
    fn rgb565_scales_five_and_six_bit_channels_to_full_range() {
        let layout = ZPixmapLayout {
            bits_per_pixel: 16,
            scanline_pad: 32,
            msb_first: false,
            red_mask: 0xf800,
            green_mask: 0x07e0,
            blue_mask: 0x001f,
        };
        // white 0xffff, black 0x0000; width 2 at 16 bpp is already 32-bit aligned.
        let data = [0xff, 0xff, 0x00, 0x00];
        assert_eq!(
            zpixmap_to_rgb(&data, 2, 1, &layout).unwrap(),
            vec![255, 255, 255, 0, 0, 0]
        );
    }

    #[test]
    fn scanline_padding_is_skipped_between_rows() {
        let layout = ZPixmapLayout {
            bits_per_pixel: 16,
            scanline_pad: 32,
            msb_first: false,
            red_mask: 0xf800,
            green_mask: 0x07e0,
            blue_mask: 0x001f,
        };
        // Width 1 at 16 bpp pads each row to 4 bytes; the pad bytes are junk.
        let data = [0xff, 0xff, 0xee, 0xee, 0x00, 0x00, 0xee, 0xee];
        assert_eq!(
            zpixmap_to_rgb(&data, 1, 2, &layout).unwrap(),
            vec![255, 255, 255, 0, 0, 0]
        );
    }

    #[test]
    fn ten_bit_channels_keep_their_top_eight_bits() {
        let layout = ZPixmapLayout {
            red_mask: 0x3ff0_0000,
            green_mask: 0x000f_fc00,
            blue_mask: 0x0000_03ff,
            ..BGRX
        };
        let pixel: u32 = (0x3ff << 20) | (0x200 << 10) | 0x001;
        assert_eq!(
            zpixmap_to_rgb(&pixel.to_le_bytes(), 1, 1, &layout).unwrap(),
            vec![0xff, 0x80, 0x00]
        );
    }

    #[test]
    fn short_or_unsupported_images_are_errors() {
        assert!(zpixmap_to_rgb(&[0; 7], 2, 1, &BGRX).is_err());
        let one_bit = ZPixmapLayout {
            bits_per_pixel: 1,
            ..BGRX
        };
        assert!(zpixmap_to_rgb(&[0; 4], 1, 1, &one_bit).is_err());
    }

    #[test]
    fn frame_extents_need_exactly_four_cardinals() {
        assert_eq!(
            parse_frame_extents(Some(vec![1, 1, 22, 5])),
            Some(FrameExtents {
                left: 1,
                right: 1,
                top: 22,
                bottom: 5
            })
        );
        assert_eq!(parse_frame_extents(None), None);
        assert_eq!(parse_frame_extents(Some(vec![1, 1, 22])), None);
        assert_eq!(parse_frame_extents(Some(vec![])), None);
    }

    #[test]
    fn frame_origin_subtracts_left_and_top_extents() {
        // openbox measurement: client at 301,222 with extents 1,1,22,5 was
        // placed by `wmctrl -e 0,300,200,...`.
        let extents = FrameExtents {
            left: 1,
            right: 1,
            top: 22,
            bottom: 5,
        };
        assert_eq!(frame_origin((301, 222), extents), (300, 200));
        assert_eq!(
            frame_origin((0, 0), FrameExtents::default()),
            (0, 0),
            "an undecorated window's frame is its client area"
        );
    }
}
