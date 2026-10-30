//! Private D-Bus and EIS peers. No connection to the host desktop is used.
use super::*;
use reis::{
    eis,
    event::DeviceCapability,
    handshake::EisHandshaker,
    request::{EisRequest, EisRequestConverter},
    PendingRequestResult,
};
use std::{os::unix::net::UnixStream, sync::mpsc, time::Instant};

struct Portal(
    std::sync::Mutex<Option<UnixStream>>,
    std::sync::atomic::AtomicUsize,
);

#[zbus::interface(name = "org.freedesktop.portal.RemoteDesktop")]
impl Portal {
    #[zbus(name = "ConnectToEIS")]
    async fn connect_to_eis(
        &self,
        _session: OwnedObjectPath,
        _options: HashMap<String, OwnedValue>,
    ) -> zbus::fdo::Result<zbus::zvariant::OwnedFd> {
        let socket = self.0.lock().unwrap().take().ok_or_else(|| {
            if self.1.fetch_add(1, Ordering::Relaxed) == 0 {
                zbus::fdo::Error::Failed("fixture EIS unavailable".into())
            } else {
                zbus::fdo::Error::NotSupported("fixture EIS unavailable".into())
            }
        })?;
        let fd: std::os::fd::OwnedFd = socket.into();
        Ok(fd.into())
    }
}

fn next(context: &eis::Context) -> Option<eis::Request> {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(request) = context.pending_request() {
            return match request {
                PendingRequestResult::Request(request) => Some(request),
                _ => None,
            };
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return None;
        }
        let mut fd = libc::pollfd {
            fd: context.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        // SAFETY: fd describes one live fixture socket for the duration of poll.
        if unsafe { libc::poll(&mut fd, 1, remaining.as_millis() as i32) } <= 0 {
            return None;
        }
        if context.read().is_err() {
            return None;
        }
    }
}

#[tokio::test]
async fn gnome_fractional_pointer_reaches_full_eis_region() {
    const TEST: &str =
        "remote_desktop::eis_tests::gnome_fractional_pointer_reaches_full_eis_region";
    if std::env::var_os("CUL_PRIVATE_EIS_TEST").is_none() {
        let root =
            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/gnome-eis-fixture");
        std::fs::create_dir_all(&root).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
        let status = std::process::Command::new("dbus-run-session")
            .arg("--")
            .arg(std::env::current_exe().unwrap())
            .args(["--exact", TEST, "--nocapture"])
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("CUL_PRIVATE_EIS_TEST", "1")
            .env("XDG_CURRENT_DESKTOP", "GNOME")
            .env("XDG_SESSION_TYPE", "wayland")
            .env("XDG_RUNTIME_DIR", &root)
            .status()
            .unwrap();
        assert!(status.success(), "private GNOME/EIS regression failed");
        return;
    }

    let (client, server) = UnixStream::pair().unwrap();
    let (recorded, events) = mpsc::channel();
    let peer = std::thread::spawn(move || {
        let context = eis::Context::new(server).unwrap();
        let mut handshake = EisHandshaker::new(&context, 1);
        let response = loop {
            let Some(request) = next(&context) else {
                return;
            };
            if let Some(response) = handshake.handle_request(request).unwrap() {
                break response;
            }
            context.flush().unwrap();
        };
        let mut converter = EisRequestConverter::new(&context, response, 1);
        let connection = converter.handle().clone();
        let capabilities =
            DeviceCapability::PointerAbsolute | DeviceCapability::Button | DeviceCapability::Scroll;
        let _seat = connection.add_seat(Some("GNOME fixture"), capabilities);
        connection.flush().unwrap();
        while let Some(request) = next(&context) {
            if converter.handle_request(request).is_err() {
                return;
            }
            while let Some(request) = converter.next_request() {
                match request {
                    EisRequest::Bind(request) => {
                        request.seat.add_device(
                            Some("125% monitor"),
                            eis::device::DeviceType::Virtual,
                            capabilities,
                            |device| {
                                device.device().region(0, 0, 1536, 960, 1.25);
                            },
                        );
                    }
                    EisRequest::Ready(request) => {
                        request.device.resumed();
                    }
                    EisRequest::PointerMotionAbsolute(request) => {
                        recorded
                            .send((request.dx_absolute, request.dy_absolute))
                            .unwrap();
                    }
                    _ => {}
                }
            }
            if connection.flush().is_err() {
                return;
            }
        }
    });
    let fixture = zbus::connection::Builder::session()
        .unwrap()
        .name(PORTAL_DESKTOP_SERVICE)
        .unwrap()
        .serve_at(
            PORTAL_DESKTOP_PATH,
            Portal(
                std::sync::Mutex::new(Some(client)),
                std::sync::atomic::AtomicUsize::new(0),
            ),
        )
        .unwrap()
        .build()
        .await
        .unwrap();
    let connection = Connection::session().await.unwrap();
    let session = OwnedObjectPath::try_from("/fixture/session").unwrap();
    assert!(
        portal_eis_input(&connection, &session, DeviceKind::Keyboard, true)
            .await
            .unwrap()
            .is_none(),
        "GNOME keyboard must keep the legacy path"
    );
    let ei = portal_eis_input(&connection, &session, DeviceKind::Pointer, true)
        .await
        .unwrap()
        .expect("GNOME pointer session must negotiate EIS");
    // EIS streams select outputs in logical space, just as on COSMIC.
    let mut streams = vec![PortalStream {
        node_id: 7,
        position: Some((0, 0)),
        size: Some((1536, 960)),
        pixel_scale: 1.25,
    }];
    let layout = [LogicalMonitor {
        x: 0,
        y: 0,
        width: 1536,
        height: 960,
        scale: 1.25,
    }];
    normalize_eis_streams(&mut streams, Some(&layout));
    assert_eq!(streams[0].pixel_scale, 1.0);
    let proxy = input_proxy(&connection, Some(ei), streams.clone())
        .await
        .unwrap();
    for (capture, expected) in [
        ((1650, 975), (1320.0, 780.0)),
        ((1919, 1199), (1535.0, 959.0)),
        ((790, 783), (632.0, 626.0)),
    ] {
        let logical =
            map_capture_point_to_stream_layout(&streams, &layout, capture.0, capture.1, 1920, 1200)
                .unwrap();
        let (node, x, y) = streams[0].relative_point(logical.0, logical.1);
        notify_pointer_motion_absolute(&proxy, &session, node, x, y)
            .await
            .unwrap();
        assert_eq!(
            events.recv_timeout(Duration::from_secs(2)).unwrap(),
            expected
        );
    }
    drop(proxy);
    assert!(
        portal_eis_input(&connection, &session, DeviceKind::Pointer, true)
            .await
            .unwrap()
            .is_none(),
        "unsupported EIS must retain legacy fallback"
    );
    assert!(
        portal_eis_input(&connection, &session, DeviceKind::Pointer, true)
            .await
            .unwrap()
            .is_none(),
        "standard D-Bus NotSupported must retain legacy fallback"
    );
    drop(fixture);
    peer.join().unwrap();
}
