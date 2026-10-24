//! GNOME Shell renders actors; this process retains the shared capture protocol.
use anyhow::{Context, Result};
use codex_computer_use_linux::indicator::{
    capture_lock_path, gnome_indicator_state, hide_gnome_indicator, show_gnome_indicator,
    socket_path, Capture, IndicatorEvent, CAPTURE_REPLY_EMPTY, CAPTURE_REPLY_SHOWN,
};
use std::{
    fs::{File, OpenOptions, TryLockError},
    os::unix::net::UnixDatagram,
    path::PathBuf,
    time::{Duration, Instant},
};

struct SocketFile(PathBuf);
impl Drop for SocketFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}
fn held(file: &File) -> bool {
    match file.try_lock() {
        Ok(()) => {
            let _ = file.unlock();
            false
        }
        Err(TryLockError::WouldBlock | TryLockError::Error(_)) => true,
    }
}

pub fn run() -> Result<()> {
    let path = socket_path().context("XDG_RUNTIME_DIR is not set")?;
    let singleton = File::create(path.with_extension("lock"))?;
    if singleton.try_lock().is_err() {
        return Ok(());
    }
    let capture = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(capture_lock_path(&path))?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    runtime.block_on(async {
        let connection = zbus::Connection::session().await?;
        // Check the new renderer before claiming the shared socket. A legacy
        // extension must leave the sender's unavailable fast path intact.
        gnome_indicator_state(&connection)
            .await
            .context("GNOME extension needs setup_window_targeting and a session restart")?;
        hide_gnome_indicator(&connection).await?;
        let _ = std::fs::remove_file(&path);
        let socket = UnixDatagram::bind(&path)?;
        let _cleanup = SocketFile(path.clone());
        socket.set_nonblocking(true)?;
        // SAFETY: `UnixDatagram` owns a valid file descriptor and we do not
        // replace or close it while owned by `AsyncFd`.
        let socket = unsafe { tokio::io::unix::AsyncFd::register(socket)? };
        let mut ticker = tokio::time::interval(Duration::from_millis(40));
        let mut last: Option<IndicatorEvent> = None;
        let mut action_at = Instant::now();
        let mut suspended = held(&capture);
        loop {
            tokio::select! {
                _ = ticker.tick() => {},
                ready = socket.readable() => {
                    let mut ready = ready?;
                    ready.clear_ready();
                }
            }
            let mut blocked = held(&capture);
            if blocked && !suspended {
                hide_gnome_indicator(&connection).await?;
            }
            if !blocked && suspended {
                if let Some(event) = &last {
                    if action_at.elapsed() < Duration::from_secs(8) {
                        show_gnome_indicator(
                            &connection,
                            event,
                            action_at.elapsed().as_millis().min(u32::MAX as u128) as u32,
                        )
                        .await?;
                    }
                }
            }
            suspended = blocked;
            let mut buf = [0; 4096];
            // Bound each batch so a busy sender cannot starve lock checks.
            for _ in 0..32 {
                let (len, sender) = match socket.get_ref().recv_from(&mut buf) {
                    Ok(message) => message,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => break,
                    Err(error) => return Err(error.into()),
                };
                let Ok(event) = serde_json::from_slice::<IndicatorEvent>(&buf[..len]) else {
                    continue;
                };
                match event.capture {
                    Some(Capture::Begin) => {
                        let shown = hide_gnome_indicator(&connection).await?;
                        suspended = true;
                        let _ = socket.get_ref().send_to_addr(
                            if shown {
                                CAPTURE_REPLY_SHOWN
                            } else {
                                CAPTURE_REPLY_EMPTY
                            },
                            &sender,
                        );
                    }
                    Some(Capture::End) => {} // The shared flock determines resumption.
                    None if !event.tool.is_empty() => {
                        blocked = held(&capture);
                        action_at = Instant::now();
                        if !blocked {
                            show_gnome_indicator(&connection, &event, 0).await?;
                        }
                        last = Some(event);
                        suspended = blocked;
                    }
                    None => {}
                }
            }
            if action_at.elapsed() >= Duration::from_secs(600) {
                return Ok(());
            }
        }
    })
}
