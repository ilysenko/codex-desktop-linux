use super::*;
use std::collections::HashSet;
use tokio::{
    io::{unix::AsyncFd, Interest},
    sync::{mpsc, watch, Semaphore},
    task::{JoinHandle, JoinSet},
};

const PORTAL_CLIPBOARD_INTERFACE: &str = "org.freedesktop.portal.Clipboard";
const CLIPBOARD_CALL_TIMEOUT: Duration = Duration::from_secs(5);
const INITIAL_OWNER_SETTLE_TIMEOUT: Duration = Duration::from_millis(250);
const CLEAR_OWNER_SETTLE_TIMEOUT: Duration = Duration::from_millis(250);
const SELECTION_READ_RETRY_DELAYS_MS: &[u64] = &[10, 15, 25, 40, 60, 80, 100, 150];
const MAX_CLIPBOARD_MIME_TYPES: usize = 64;
const MAX_CLIPBOARD_MIME_BYTES: usize = 16 * 1024 * 1024;
const MAX_CLIPBOARD_TOTAL_BYTES: usize = 64 * 1024 * 1024;
const MAX_CLIPBOARD_READ_DURATION: Duration = Duration::from_secs(15);
const MAX_CONCURRENT_TRANSFERS: usize = 8;
const TRANSFER_SEMAPHORE_TIMEOUT: Duration = Duration::from_secs(5);
/// Uncached sentinel MIME type set immediately before unsetting an empty
/// clipboard so Mutter's `MetaClipboardManager` drops its saved copy of the
/// temporary pasted text instead of restoring it on `meta_selection_unset_owner`.
const EMPTY_CLIPBOARD_CLEAR_MIME: &str = "application/x-codex-computer-use-linux-clear";
const ICCCM_META_TARGETS: &[&str] = &["TARGETS", "TIMESTAMP", "MULTIPLE", "SAVE_TARGETS", "DELETE"];

/// Clipboard snapshot refusal caused by local restore limits or a concurrent
/// external clipboard update rather than a broken portal session.
#[derive(Debug)]
struct ClipboardSnapshotRefused(String);

impl std::fmt::Display for ClipboardSnapshotRefused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ClipboardSnapshotRefused {}

pub(crate) fn is_non_fatal_clipboard_error(error: &anyhow::Error) -> bool {
    error.is::<ClipboardSnapshotRefused>()
}

fn set_nonblocking(fd: &std::os::fd::OwnedFd) -> io::Result<()> {
    let flags = unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_GETFL) };
    if flags < 0 {
        return Err(io::Error::last_os_error());
    }
    if flags & libc::O_NONBLOCK != 0 {
        return Ok(());
    }
    let result = unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_SETFL, flags | libc::O_NONBLOCK) };
    if result < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

async fn read_nonblocking_fd_bounded(
    fd: std::os::fd::OwnedFd,
    max_bytes: usize,
) -> Result<Vec<u8>> {
    set_nonblocking(&fd).context("failed to set clipboard read pipe non-blocking")?;
    // SAFETY: `fd` is an exclusively owned valid file descriptor kept alive by `AsyncFd`.
    let async_fd = unsafe { AsyncFd::register_with_interest(fd, Interest::READABLE) }
        .context("failed to register clipboard read pipe with tokio reactor")?;
    let mut payload = Vec::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let mut guard = async_fd
            .readable()
            .await
            .context("clipboard read pipe readiness wait failed")?;
        match guard.try_io(|inner| {
            let n = unsafe {
                libc::read(
                    inner.get_ref().as_raw_fd(),
                    buf.as_mut_ptr().cast(),
                    buf.len(),
                )
            };
            if n < 0 {
                Err(io::Error::last_os_error())
            } else {
                Ok(n as usize)
            }
        }) {
            Ok(Ok(0)) => return Ok(payload),
            Ok(Ok(n)) => {
                if payload.len().saturating_add(n) > max_bytes {
                    return Err(anyhow::Error::new(ClipboardSnapshotRefused(
                        "Clipboard MIME payload exceeds the 16 MiB restore limit".to_string(),
                    )));
                }
                payload.extend_from_slice(&buf[..n]);
            }
            Ok(Err(error)) if error.kind() == io::ErrorKind::Interrupted => continue,
            Ok(Err(error)) => {
                return Err(error).context("failed reading clipboard MIME payload");
            }
            Err(_would_block) => continue,
        }
    }
}

async fn write_nonblocking_fd(fd: std::os::fd::OwnedFd, data: &[u8]) -> io::Result<()> {
    set_nonblocking(&fd)?;
    // SAFETY: `fd` is an exclusively owned valid file descriptor kept alive by `AsyncFd`.
    let async_fd = unsafe { AsyncFd::register_with_interest(fd, Interest::WRITABLE) }?;
    let mut offset = 0usize;
    while offset < data.len() {
        let mut guard = async_fd.writable().await?;
        match guard.try_io(|inner| {
            let remaining = &data[offset..];
            let n = unsafe {
                libc::write(
                    inner.get_ref().as_raw_fd(),
                    remaining.as_ptr().cast(),
                    remaining.len(),
                )
            };
            if n < 0 {
                Err(io::Error::last_os_error())
            } else {
                Ok(n as usize)
            }
        }) {
            Ok(Ok(0)) => {
                return Err(io::Error::new(
                    io::ErrorKind::WriteZero,
                    "clipboard write pipe returned zero bytes",
                ));
            }
            Ok(Ok(n)) => offset += n,
            Ok(Err(error)) if error.kind() == io::ErrorKind::Interrupted => continue,
            Ok(Err(error)) => return Err(error),
            Err(_would_block) => continue,
        }
    }
    Ok(())
}

struct StartupTaskGuard {
    handle: Option<JoinHandle<()>>,
}

impl StartupTaskGuard {
    fn new(handle: JoinHandle<()>) -> Self {
        Self {
            handle: Some(handle),
        }
    }

    fn disarm(&mut self) -> JoinHandle<()> {
        self.handle
            .take()
            .expect("startup task guard already disarmed")
    }
}

impl Drop for StartupTaskGuard {
    fn drop(&mut self) {
        if let Some(handle) = self.handle.take() {
            handle.abort();
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ClipboardSelection {
    formats: Vec<(String, Vec<u8>)>,
}

impl ClipboardSelection {
    pub fn text(text: &str) -> Self {
        let utf8 = text.as_bytes().to_vec();
        Self {
            formats: vec![
                ("text/plain;charset=utf-8".to_string(), utf8.clone()),
                ("text/plain".to_string(), utf8.clone()),
                ("UTF8_STRING".to_string(), utf8),
            ],
        }
    }

    pub fn is_empty(&self) -> bool {
        self.formats.is_empty()
    }

    fn mime_types(&self) -> Vec<String> {
        self.formats
            .iter()
            .map(|(mime_type, _)| mime_type.clone())
            .collect()
    }

    fn payload(&self, mime_type: &str) -> Option<&[u8]> {
        self.formats
            .iter()
            .find(|(candidate, _)| candidate == mime_type)
            .map(|(_, payload)| payload.as_slice())
    }
}

#[derive(Debug, Clone, Default)]
struct ClipboardOwner {
    mime_types: Vec<String>,
    session_is_owner: bool,
}

fn owned_string_list(value: &OwnedValue) -> Result<Vec<String>> {
    if let Ok(strings) = value.try_clone().and_then(Vec::<String>::try_from) {
        return Ok(strings);
    }
    let (strings,): (Vec<String>,) = value
        .try_clone()
        .and_then(<(Vec<String>,)>::try_from)
        .context("clipboard MIME list was neither an array nor a one-element array tuple")?;
    Ok(strings)
}

fn parse_owner_options(options: &HashMap<String, OwnedValue>) -> ClipboardOwner {
    let mime_types = options
        .get("mime_types")
        .or_else(|| options.get("mime-types"))
        .and_then(|value| owned_string_list(value).ok())
        .unwrap_or_default();
    let session_is_owner = options
        .get("session_is_owner")
        .or_else(|| options.get("session-is-owner"))
        .and_then(|value| bool::try_from(value).ok())
        .unwrap_or_default();
    ClipboardOwner {
        mime_types,
        session_is_owner,
    }
}

fn filter_readable_mime_types(mime_types: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut filtered = Vec::new();
    for mime_type in mime_types {
        if mime_type.is_empty() || ICCCM_META_TARGETS.contains(&mime_type.as_str()) {
            continue;
        }
        if seen.insert(mime_type.clone()) {
            filtered.push(mime_type.clone());
        }
    }
    filtered
}

fn is_transient_selection_read_error(error: &zbus::Error) -> bool {
    let text = error.to_string();
    text.contains("Tried to read in parallel")
        || text.contains("Internal error")
        || text.contains("Failed to selection read")
}

pub struct PortalClipboardSession {
    keyboard: PortalKeyboardSession,
    connection: Connection,
    session_handle: OwnedObjectPath,
    owner_changed: mpsc::UnboundedReceiver<ClipboardOwner>,
    owner_task: JoinHandle<()>,
    transfer_task: JoinHandle<()>,
    selection: watch::Sender<Arc<ClipboardSelection>>,
    latest_owner: Option<ClipboardOwner>,
    owner_generation: u64,
    initial_owner_checked: bool,
    owner: bool,
    closed: bool,
}

impl PortalClipboardSession {
    pub fn keyboard(&self) -> &PortalKeyboardSession {
        &self.keyboard
    }

    pub fn is_valid(&self) -> bool {
        self.keyboard.is_valid()
            && !self.was_closed_by_keyboard_cleanup()
            && !self.owner_task.is_finished()
            && !self.transfer_task.is_finished()
    }

    pub(crate) async fn wait_for_keyboard_cleanup(&self) {
        self.keyboard.wait_for_release_cleanup().await;
    }

    pub(crate) fn was_closed_by_keyboard_cleanup(&self) -> bool {
        self.keyboard.was_closed_by_release_cleanup()
    }

    fn apply_owner_update(&mut self, owner: ClipboardOwner) {
        self.owner_generation = self.owner_generation.wrapping_add(1);
        self.owner = owner.session_is_owner;
        self.latest_owner = Some(owner);
    }

    fn drain_owner_updates(&mut self) {
        while let Ok(owner) = self.owner_changed.try_recv() {
            self.apply_owner_update(owner);
        }
    }

    async fn portal_ping_barrier(&self) {
        let _ = tokio::time::timeout(
            CLIPBOARD_CALL_TIMEOUT,
            self.connection.call_method(
                Some(PORTAL_DESKTOP_SERVICE),
                PORTAL_DESKTOP_PATH,
                Some("org.freedesktop.DBus.Peer"),
                "Ping",
                &(),
            ),
        )
        .await;
        // Let the signal forwarding task drain any SelectionOwnerChanged
        // messages that arrived ahead of the Peer.Ping reply.
        tokio::task::yield_now().await;
    }

    pub(crate) async fn sync_owner_state(&mut self) {
        self.drain_owner_updates();
        self.portal_ping_barrier().await;
        self.drain_owner_updates();
        if self.initial_owner_checked {
            return;
        }
        self.initial_owner_checked = true;
        if self.latest_owner.is_some() {
            return;
        }
        if let Ok(Some(owner)) =
            tokio::time::timeout(INITIAL_OWNER_SETTLE_TIMEOUT, self.owner_changed.recv()).await
        {
            self.apply_owner_update(owner);
            self.drain_owner_updates();
        }
    }

    async fn read_mime_payload(
        &self,
        mime_type: &str,
        deadline: tokio::time::Instant,
    ) -> Result<Vec<u8>> {
        let proxy = clipboard_proxy(&self.connection).await?;
        let mut attempt = 0usize;
        let fd: zbus::zvariant::OwnedFd = loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                bail!("Clipboard snapshot exceeded the 15s read budget");
            }
            let call_timeout = remaining.min(CLIPBOARD_CALL_TIMEOUT);
            let call = tokio::time::timeout(
                call_timeout,
                proxy.call("SelectionRead", &(&self.session_handle, mime_type)),
            )
            .await
            .context("Clipboard SelectionRead call timed out")?;
            match call {
                Ok(fd) => break fd,
                Err(error)
                    if attempt < SELECTION_READ_RETRY_DELAYS_MS.len()
                        && is_transient_selection_read_error(&error) =>
                {
                    let delay = Duration::from_millis(SELECTION_READ_RETRY_DELAYS_MS[attempt]);
                    attempt += 1;
                    tokio::time::sleep(delay).await;
                }
                Err(error) => {
                    return Err(error).context("Clipboard SelectionRead call failed");
                }
            }
        };
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            bail!("Clipboard snapshot exceeded the 15s read budget");
        }
        let read_timeout = remaining.min(CLIPBOARD_CALL_TIMEOUT);
        let fd: std::os::fd::OwnedFd = fd.into();
        tokio::time::timeout(
            read_timeout,
            read_nonblocking_fd_bounded(fd, MAX_CLIPBOARD_MIME_BYTES),
        )
        .await
        .context("Clipboard payload read timed out")?
    }

    pub async fn read_current_selection(&mut self) -> Result<ClipboardSelection> {
        self.sync_owner_state().await;
        if self.owner {
            return Ok((**self.selection.borrow()).clone());
        }
        let start_generation = self.owner_generation;
        let mime_types = self
            .latest_owner
            .as_ref()
            .map(|owner| filter_readable_mime_types(&owner.mime_types))
            .unwrap_or_default();
        if mime_types.is_empty() {
            return Ok(ClipboardSelection::default());
        }
        if mime_types.len() > MAX_CLIPBOARD_MIME_TYPES {
            return Err(anyhow::Error::new(ClipboardSnapshotRefused(format!(
                "Clipboard offers {} MIME types, exceeding the {} MIME type restore limit",
                mime_types.len(),
                MAX_CLIPBOARD_MIME_TYPES
            ))));
        }

        let read_deadline = tokio::time::Instant::now() + MAX_CLIPBOARD_READ_DURATION;
        let mut selection = ClipboardSelection::default();
        let mut total_bytes = 0usize;
        for mime_type in mime_types {
            self.drain_owner_updates();
            if self.owner_generation != start_generation {
                return Err(anyhow::Error::new(ClipboardSnapshotRefused(
                    "Clipboard owner changed while snapshotting previous contents".to_string(),
                )));
            }
            let payload = self.read_mime_payload(&mime_type, read_deadline).await?;
            total_bytes = total_bytes.saturating_add(payload.len());
            if total_bytes > MAX_CLIPBOARD_TOTAL_BYTES {
                return Err(anyhow::Error::new(ClipboardSnapshotRefused(
                    "Clipboard contents exceed the 64 MiB restore limit".to_string(),
                )));
            }
            selection.formats.push((mime_type, payload));
        }
        self.drain_owner_updates();
        if self.owner_generation != start_generation {
            return Err(anyhow::Error::new(ClipboardSnapshotRefused(
                "Clipboard owner changed while snapshotting previous contents".to_string(),
            )));
        }
        Ok(selection)
    }

    pub async fn replace_selection(&mut self, selection: ClipboardSelection) -> Result<()> {
        let is_empty = selection.is_empty();
        if is_empty {
            // First take ownership with a sentinel MIME type outside Mutter's
            // MetaClipboardManager allowlist (`text/plain*`, `image/*`) so
            // Mutter drops its saved copy of the temporary paste text, then
            // unset the selection completely.
            self.selection
                .send_replace(Arc::new(ClipboardSelection::default()));
            self.set_selection_and_await_owner(vec![EMPTY_CLIPBOARD_CLEAR_MIME.to_string()])
                .await
                .context("Clipboard sentinel clear before unset failed")?;
            self.drain_owner_updates();
            let proxy = clipboard_proxy(&self.connection).await?;
            let empty_options: HashMap<&str, Value<'_>> = HashMap::new();
            tokio::time::timeout(
                CLIPBOARD_CALL_TIMEOUT,
                proxy.call::<_, _, ()>("SetSelection", &(&self.session_handle, empty_options)),
            )
            .await
            .context("Clipboard SetSelection unset call timed out")?
            .context("Clipboard SetSelection unset call failed")?;
            self.owner = false;
            self.latest_owner = Some(ClipboardOwner::default());
            let _ = tokio::time::timeout(CLEAR_OWNER_SETTLE_TIMEOUT, async {
                while let Some(owner) = self.owner_changed.recv().await {
                    let is_sentinel_echo = owner.session_is_owner
                        && owner.mime_types.len() == 1
                        && owner.mime_types[0] == EMPTY_CLIPBOARD_CLEAR_MIME;
                    if is_sentinel_echo {
                        continue;
                    }
                    let owned = owner.session_is_owner;
                    self.apply_owner_update(owner);
                    if !owned {
                        break;
                    }
                }
            })
            .await;
            return Ok(());
        }

        let mime_types = selection.mime_types();
        self.selection.send_replace(Arc::new(selection));
        self.set_selection_and_await_owner(mime_types).await
    }

    async fn set_selection_and_await_owner(&mut self, mime_types: Vec<String>) -> Result<()> {
        let mut options: HashMap<&str, Value<'_>> = HashMap::new();
        options.insert("mime_types", Value::from(mime_types));
        self.drain_owner_updates();

        let proxy = clipboard_proxy(&self.connection).await?;
        tokio::time::timeout(
            CLIPBOARD_CALL_TIMEOUT,
            proxy.call::<_, _, ()>("SetSelection", &(&self.session_handle, options)),
        )
        .await
        .context("Clipboard SetSelection call timed out")?
        .context("Clipboard SetSelection call failed")?;

        // xdg-desktop-portal completes SetSelection before forwarding to the
        // backend. Wait for SelectionOwnerChanged(session_is_owner=true) so the
        // compositor holds the new clipboard before the paste chord fires.
        let deadline = tokio::time::Instant::now() + CLIPBOARD_CALL_TIMEOUT;
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                bail!("Clipboard SetSelection ownership confirmation timed out");
            }
            match tokio::time::timeout(remaining, self.owner_changed.recv()).await {
                Ok(Some(owner)) => {
                    let owned = owner.session_is_owner;
                    self.apply_owner_update(owner);
                    if owned {
                        return Ok(());
                    }
                }
                Ok(None) => bail!("Clipboard owner notification stream closed"),
                Err(_) => bail!("Clipboard SetSelection ownership confirmation timed out"),
            }
        }
    }

    pub fn selection_still_owned(&mut self) -> bool {
        if self.was_closed_by_keyboard_cleanup() {
            self.owner = false;
            return false;
        }
        self.drain_owner_updates();
        self.owner
    }

    pub(crate) fn can_keep_alive_as_owner(&mut self) -> bool {
        self.selection_still_owned()
            && !self.selection.borrow().is_empty()
            && !self.transfer_task.is_finished()
            && !self.owner_task.is_finished()
    }

    pub fn keep_alive_until_replaced(self) {
        tokio::spawn(async move {
            let mut session = self;
            while session.can_keep_alive_as_owner() {
                tokio::select! {
                    owner = session.owner_changed.recv() => match owner {
                        Some(owner) => session.apply_owner_update(owner),
                        None => break,
                    },
                    _ = &mut session.transfer_task => break,
                }
            }
            session.close().await;
        });
    }

    pub async fn close(mut self) {
        self.owner_task.abort();
        self.transfer_task.abort();
        if !self.was_closed_by_keyboard_cleanup() {
            let _ = tokio::time::timeout(
                RELEASE_TIMEOUT,
                close_portal_session(&self.connection, &self.session_handle),
            )
            .await;
        }
        self.closed = true;
    }
}

impl Drop for PortalClipboardSession {
    fn drop(&mut self) {
        self.owner_task.abort();
        self.transfer_task.abort();
        if self.closed || self.was_closed_by_keyboard_cleanup() {
            return;
        }
        self.closed = true;
        let connection = self.connection.clone();
        let session_handle = self.session_handle.clone();
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                let _ = tokio::time::timeout(
                    RELEASE_TIMEOUT,
                    close_portal_session(&connection, &session_handle),
                )
                .await;
            });
        }
    }
}

pub async fn start_portal_keyboard_clipboard_session() -> Result<PortalClipboardSession> {
    hydrate_session_bus_env();

    let connection = Connection::session()
        .await
        .context("failed to connect to session bus for remote desktop clipboard portal")?;
    let persistence = remote_desktop_persistence(&connection).await;
    let permit = claim_restore_permit(&persistence, PortalDeviceKind::KeyboardClipboard).await;
    start_portal_keyboard_clipboard_session_on(connection, permit, true).await
}

async fn start_portal_keyboard_clipboard_session_on(
    connection: Connection,
    permit: Option<RestorePermit>,
    connect_eis: bool,
) -> Result<PortalClipboardSession> {
    let session_handle = create_remote_desktop_session(&connection).await?;
    let mut cleanup = PortalSessionCleanup::new(connection.clone(), session_handle.clone());
    select_keyboard_devices(&connection, &session_handle, permit.as_ref()).await?;

    let clipboard = clipboard_proxy(&connection).await?;
    let owner_stream = clipboard
        .receive_signal("SelectionOwnerChanged")
        .await
        .context("failed to subscribe to Clipboard SelectionOwnerChanged")?;
    let transfer_stream = clipboard
        .receive_signal("SelectionTransfer")
        .await
        .context("failed to subscribe to Clipboard SelectionTransfer")?;

    let (owner_sender, owner_changed) = mpsc::unbounded_channel();
    let mut owner_task = StartupTaskGuard::new(tokio::spawn(forward_owner_changes(
        owner_stream,
        session_handle.clone(),
        owner_sender,
    )));

    let (selection, receiver) = watch::channel(Arc::new(ClipboardSelection::default()));
    let mut transfer_task = StartupTaskGuard::new(tokio::spawn(serve_clipboard_transfers(
        connection.clone(),
        session_handle.clone(),
        transfer_stream,
        receiver,
    )));

    let request_options: HashMap<&str, Value<'_>> = HashMap::new();
    tokio::time::timeout(
        CLIPBOARD_CALL_TIMEOUT,
        clipboard.call::<_, _, ()>("RequestClipboard", &(&session_handle, request_options)),
    )
    .await
    .context("Clipboard RequestClipboard call timed out")?
    .context("Clipboard RequestClipboard call failed")?;

    let (devices, _, restore_token, clipboard_enabled) =
        start_remote_desktop_session(&connection, &session_handle).await?;

    let granted = devices & DEVICE_KEYBOARD != 0 && clipboard_enabled;
    let restore_token = restore_token_to_keep(granted, restore_token);
    commit_restore_permit(permit, restore_token).await;

    if devices & DEVICE_KEYBOARD == 0 {
        bail!("remote desktop portal session started without keyboard access");
    }
    if !clipboard_enabled {
        bail!("remote desktop portal session started without clipboard access");
    }

    let ei = if connect_eis {
        portal_eis_input(&connection, &session_handle, DeviceKind::Keyboard, false).await?
    } else {
        None
    };

    cleanup.disarm();
    let keyboard = PortalKeyboardSession {
        ei,
        connection: connection.clone(),
        session_handle: session_handle.clone(),
        input_lock: portal_input_lock(),
        valid: Arc::new(AtomicBool::new(true)),
        always_close_on_cleanup: false,
        closed_by_release_cleanup: Arc::new(AtomicBool::new(false)),
    };
    Ok(PortalClipboardSession {
        keyboard,
        connection,
        session_handle,
        owner_changed,
        owner_task: owner_task.disarm(),
        transfer_task: transfer_task.disarm(),
        selection,
        latest_owner: None,
        owner_generation: 0,
        initial_owner_checked: false,
        owner: false,
        closed: false,
    })
}

async fn clipboard_proxy<'a>(connection: &'a Connection) -> Result<Proxy<'a>> {
    Proxy::new(
        connection,
        PORTAL_DESKTOP_SERVICE,
        PORTAL_DESKTOP_PATH,
        PORTAL_CLIPBOARD_INTERFACE,
    )
    .await
    .context("failed to create remote desktop clipboard portal proxy")
}

async fn forward_owner_changes(
    mut stream: SignalStream<'static>,
    session_handle: OwnedObjectPath,
    sender: mpsc::UnboundedSender<ClipboardOwner>,
) {
    while let Some(signal) = stream.next().await {
        let Ok((signal_session, options)) = signal
            .body()
            .deserialize::<(OwnedObjectPath, HashMap<String, OwnedValue>)>()
        else {
            continue;
        };
        if signal_session != session_handle {
            continue;
        }
        let owner = parse_owner_options(&options);
        if sender.send(owner).is_err() {
            break;
        }
    }
}

async fn serve_clipboard_transfers(
    connection: Connection,
    session_handle: OwnedObjectPath,
    mut stream: SignalStream<'static>,
    selection: watch::Receiver<Arc<ClipboardSelection>>,
) {
    let semaphore = Arc::new(Semaphore::new(MAX_CONCURRENT_TRANSFERS));
    let mut transfers = JoinSet::new();
    loop {
        let signal = tokio::select! {
            Some(_) = transfers.join_next(), if !transfers.is_empty() => continue,
            next = stream.next() => match next {
                Some(signal) => signal,
                None => break,
            },
        };
        while transfers.try_join_next().is_some() {}

        let Ok((signal_session, mime_type, serial)) = signal
            .body()
            .deserialize::<(OwnedObjectPath, String, u32)>()
        else {
            continue;
        };
        if signal_session != session_handle {
            continue;
        }
        let permit = match Arc::clone(&semaphore).try_acquire_owned() {
            Ok(permit) => permit,
            Err(_) => {
                match tokio::time::timeout(
                    TRANSFER_SEMAPHORE_TIMEOUT,
                    Arc::clone(&semaphore).acquire_owned(),
                )
                .await
                {
                    Ok(Ok(permit)) => permit,
                    _ => continue,
                }
            }
        };
        let current_selection = Arc::clone(&*selection.borrow());
        let connection = connection.clone();
        let session_handle = session_handle.clone();
        transfers.spawn(async move {
            let _permit = permit;
            let Ok(proxy) = clipboard_proxy(&connection).await else {
                return;
            };
            let fd: zbus::zvariant::OwnedFd = match tokio::time::timeout(
                CLIPBOARD_CALL_TIMEOUT,
                proxy.call("SelectionWrite", &(&session_handle, serial)),
            )
            .await
            {
                Ok(Ok(fd)) => fd,
                _ => return,
            };
            let fd: std::os::fd::OwnedFd = fd.into();
            let success = match current_selection.payload(&mime_type) {
                Some(payload) => matches!(
                    tokio::time::timeout(
                        CLIPBOARD_CALL_TIMEOUT,
                        write_nonblocking_fd(fd, payload),
                    )
                    .await,
                    Ok(Ok(()))
                ),
                None => {
                    drop(fd);
                    false
                }
            };
            let _ = tokio::time::timeout(
                CLIPBOARD_CALL_TIMEOUT,
                proxy.call::<_, _, ()>("SelectionWriteDone", &(&session_handle, serial, success)),
            )
            .await;
        });
    }
    transfers.abort_all();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use std::os::unix::net::UnixStream;
    use std::sync::Mutex as StdMutex;
    use zbus::object_server::SignalEmitter;

    #[test]
    fn text_selection_offers_utf8_plain_and_xwayland_utf8_string() {
        let selection = ClipboardSelection::text("你好 Hello");
        assert_eq!(
            selection.mime_types(),
            ["text/plain;charset=utf-8", "text/plain", "UTF8_STRING"]
        );
        for mime_type in selection.mime_types() {
            assert_eq!(selection.payload(&mime_type), Some("你好 Hello".as_bytes()));
        }
        assert_eq!(selection.payload("text/html"), None);
    }

    #[test]
    fn filter_readable_mime_types_skips_icccm_meta_targets_and_duplicates() {
        let input = vec![
            "TARGETS".to_string(),
            "text/html".to_string(),
            "TIMESTAMP".to_string(),
            "text/plain;charset=utf-8".to_string(),
            "text/html".to_string(),
            "".to_string(),
            "SAVE_TARGETS".to_string(),
        ];
        assert_eq!(
            filter_readable_mime_types(&input),
            vec![
                "text/html".to_string(),
                "text/plain;charset=utf-8".to_string()
            ]
        );
    }

    #[test]
    fn parse_owner_options_supports_tuple_mime_list_and_hyphenated_keys() {
        let mut options: HashMap<String, OwnedValue> = HashMap::new();
        options.insert(
            "mime-types".to_string(),
            OwnedValue::try_from(Value::from((vec![
                "text/html".to_string(),
                "text/plain".to_string(),
            ],)))
            .unwrap(),
        );
        options.insert(
            "session-is-owner".to_string(),
            OwnedValue::try_from(Value::from(true)).unwrap(),
        );
        let owner = parse_owner_options(&options);
        assert!(owner.session_is_owner);
        assert_eq!(owner.mime_types, vec!["text/html", "text/plain"]);
    }

    #[tokio::test]
    async fn nonblocking_read_timeout_closes_stalled_pipe_immediately() {
        let (reader, mut writer) = UnixStream::pair().unwrap();
        let read_fd: std::os::fd::OwnedFd = reader.into();
        let timed_out = tokio::time::timeout(
            Duration::from_millis(60),
            read_nonblocking_fd_bounded(read_fd, MAX_CLIPBOARD_MIME_BYTES),
        )
        .await;
        assert!(timed_out.is_err(), "stalled pipe read should time out");
        // Dropping the timed-out future must have closed the read end immediately.
        let write_err = writer
            .write(b"late bytes")
            .expect_err("peer write must fail once timed-out read FD is closed");
        assert!(
            matches!(
                write_err.kind(),
                io::ErrorKind::BrokenPipe | io::ErrorKind::ConnectionReset
            ),
            "unexpected peer write error: {write_err}"
        );
    }

    #[derive(Default)]
    struct FakePortalState {
        clipboard_requested: bool,
        grant_clipboard: bool,
        initial_formats: Vec<(String, Vec<u8>)>,
        fail_first_second_read: bool,
        fail_sentinel_clear: bool,
        change_owner_after_first_read: bool,
        fail_keycode_press_index: Option<usize>,
        fail_keycode_release: bool,
        read_calls: usize,
        set_selection_calls: Vec<Vec<String>>,
        keycodes: Vec<(i32, u32)>,
        transfers: BTreeMap<u32, UnixStream>,
        write_done: Vec<(u32, bool)>,
        closed_sessions: usize,
    }

    struct FakeRequest;
    #[zbus::interface(name = "org.freedesktop.portal.Request")]
    impl FakeRequest {
        #[zbus(signal)]
        async fn response(
            emitter: &SignalEmitter<'_>,
            response: u32,
            results: HashMap<String, Value<'_>>,
        ) -> zbus::Result<()>;
    }

    struct FakeSession {
        state: Arc<StdMutex<FakePortalState>>,
    }
    #[zbus::interface(name = "org.freedesktop.portal.Session")]
    impl FakeSession {
        async fn close(&self) {
            self.state.lock().unwrap().closed_sessions += 1;
        }
    }

    struct FakeRemoteDesktop {
        state: Arc<StdMutex<FakePortalState>>,
    }

    #[zbus::interface(name = "org.freedesktop.portal.RemoteDesktop")]
    impl FakeRemoteDesktop {
        #[zbus(property)]
        async fn version(&self) -> u32 {
            2
        }

        async fn create_session(
            &self,
            options: HashMap<String, OwnedValue>,
            #[zbus(connection)] conn: &Connection,
            #[zbus(header)] header: zbus::message::Header<'_>,
        ) -> zbus::fdo::Result<OwnedObjectPath> {
            let sender = header.sender().unwrap().as_str();
            let sender_part = sender.trim_start_matches(':').replace('.', "_");
            let handle_token =
                String::try_from(options["handle_token"].try_clone().unwrap()).unwrap();
            let session_token =
                String::try_from(options["session_handle_token"].try_clone().unwrap()).unwrap();
            let req_path = OwnedObjectPath::try_from(format!(
                "/org/freedesktop/portal/desktop/request/{sender_part}/{handle_token}"
            ))
            .unwrap();
            let session_path = OwnedObjectPath::try_from(format!(
                "/org/freedesktop/portal/desktop/session/{sender_part}/{session_token}"
            ))
            .unwrap();
            conn.object_server()
                .at(
                    session_path.clone(),
                    FakeSession {
                        state: Arc::clone(&self.state),
                    },
                )
                .await
                .unwrap();
            let conn = conn.clone();
            let req_clone = req_path.clone();
            tokio::spawn(async move {
                let emitter = SignalEmitter::new(&conn, req_clone).unwrap();
                let mut results: HashMap<String, Value<'_>> = HashMap::new();
                results.insert(
                    "session_handle".to_string(),
                    Value::from(session_path.as_str()),
                );
                let _ = FakeRequest::response(&emitter, 0, results).await;
            });
            Ok(req_path)
        }

        async fn select_devices(
            &self,
            _session: OwnedObjectPath,
            options: HashMap<String, OwnedValue>,
            #[zbus(connection)] conn: &Connection,
            #[zbus(header)] header: zbus::message::Header<'_>,
        ) -> zbus::fdo::Result<OwnedObjectPath> {
            let sender = header.sender().unwrap().as_str();
            let sender_part = sender.trim_start_matches(':').replace('.', "_");
            let handle_token =
                String::try_from(options["handle_token"].try_clone().unwrap()).unwrap();
            let req_path = OwnedObjectPath::try_from(format!(
                "/org/freedesktop/portal/desktop/request/{sender_part}/{handle_token}"
            ))
            .unwrap();
            let conn = conn.clone();
            let req_clone = req_path.clone();
            tokio::spawn(async move {
                let emitter = SignalEmitter::new(&conn, req_clone).unwrap();
                let _ = FakeRequest::response(&emitter, 0, HashMap::new()).await;
            });
            Ok(req_path)
        }

        async fn start(
            &self,
            session: OwnedObjectPath,
            _parent_window: String,
            options: HashMap<String, OwnedValue>,
            #[zbus(connection)] conn: &Connection,
            #[zbus(header)] header: zbus::message::Header<'_>,
        ) -> zbus::fdo::Result<OwnedObjectPath> {
            let sender = header.sender().unwrap().as_str();
            let sender_part = sender.trim_start_matches(':').replace('.', "_");
            let handle_token =
                String::try_from(options["handle_token"].try_clone().unwrap()).unwrap();
            let req_path = OwnedObjectPath::try_from(format!(
                "/org/freedesktop/portal/desktop/request/{sender_part}/{handle_token}"
            ))
            .unwrap();
            let (clipboard_enabled, initial_mimes) = {
                let state = self.state.lock().unwrap();
                let enabled = state.clipboard_requested && state.grant_clipboard;
                let mimes: Vec<String> = state
                    .initial_formats
                    .iter()
                    .map(|(m, _)| m.clone())
                    .collect();
                (enabled, mimes)
            };
            let conn = conn.clone();
            let req_clone = req_path.clone();
            tokio::spawn(async move {
                if clipboard_enabled && !initial_mimes.is_empty() {
                    let cb_emitter = SignalEmitter::new(&conn, PORTAL_DESKTOP_PATH).unwrap();
                    let mut opts: HashMap<String, Value<'_>> = HashMap::new();
                    opts.insert("mime_types".to_string(), Value::from((initial_mimes,)));
                    opts.insert("session_is_owner".to_string(), Value::from(false));
                    let _ =
                        FakeClipboard::selection_owner_changed(&cb_emitter, session, opts).await;
                }
                let emitter = SignalEmitter::new(&conn, req_clone).unwrap();
                let mut results: HashMap<String, Value<'_>> = HashMap::new();
                results.insert("devices".to_string(), Value::from(DEVICE_KEYBOARD));
                results.insert(
                    "clipboard_enabled".to_string(),
                    Value::from(clipboard_enabled),
                );
                let _ = FakeRequest::response(&emitter, 0, results).await;
            });
            Ok(req_path)
        }

        async fn notify_keyboard_keycode(
            &self,
            _session: OwnedObjectPath,
            _options: HashMap<String, OwnedValue>,
            keycode: i32,
            state: u32,
        ) -> zbus::fdo::Result<()> {
            let mut guard = self.state.lock().unwrap();
            let press_index = guard
                .keycodes
                .iter()
                .filter(|(_, s)| *s == KEY_PRESSED)
                .count();
            guard.keycodes.push((keycode, state));
            if state == KEY_PRESSED && guard.fail_keycode_press_index == Some(press_index) {
                return Err(zbus::fdo::Error::Failed(
                    "injected press failure".to_string(),
                ));
            }
            if state == KEY_RELEASED && guard.fail_keycode_release {
                return Err(zbus::fdo::Error::Failed(
                    "injected release failure".to_string(),
                ));
            }
            Ok(())
        }
    }

    struct FakeClipboard {
        state: Arc<StdMutex<FakePortalState>>,
    }

    #[zbus::interface(name = "org.freedesktop.portal.Clipboard")]
    impl FakeClipboard {
        #[zbus(property)]
        async fn version(&self) -> u32 {
            1
        }

        async fn request_clipboard(
            &self,
            _session: OwnedObjectPath,
            _options: HashMap<String, OwnedValue>,
        ) {
            self.state.lock().unwrap().clipboard_requested = true;
        }

        async fn set_selection(
            &self,
            session: OwnedObjectPath,
            options: HashMap<String, OwnedValue>,
            #[zbus(connection)] conn: &Connection,
        ) -> zbus::fdo::Result<()> {
            let mimes = options
                .get("mime_types")
                .map(owned_string_list)
                .transpose()
                .map_err(|e| zbus::fdo::Error::InvalidArgs(e.to_string()))?
                .unwrap_or_default();
            if options.contains_key("mime_types") && mimes.is_empty() {
                return Err(zbus::fdo::Error::Failed(
                    "No mime types in mime types list".to_string(),
                ));
            }
            if mimes.len() == 1
                && mimes[0] == EMPTY_CLIPBOARD_CLEAR_MIME
                && self.state.lock().unwrap().fail_sentinel_clear
            {
                return Err(zbus::fdo::Error::Failed(
                    "sentinel clear rejected".to_string(),
                ));
            }
            self.state
                .lock()
                .unwrap()
                .set_selection_calls
                .push(mimes.clone());
            let conn = conn.clone();
            tokio::spawn(async move {
                let emitter = SignalEmitter::new(&conn, PORTAL_DESKTOP_PATH).unwrap();
                let mut opts: HashMap<String, Value<'_>> = HashMap::new();
                if !mimes.is_empty() {
                    opts.insert("mime_types".to_string(), Value::from((mimes,)));
                    opts.insert("session_is_owner".to_string(), Value::from(true));
                } else {
                    opts.insert("session_is_owner".to_string(), Value::from(false));
                }
                let _ = FakeClipboard::selection_owner_changed(&emitter, session, opts).await;
            });
            Ok(())
        }

        async fn selection_read(
            &self,
            session: OwnedObjectPath,
            mime_type: String,
            #[zbus(connection)] conn: &Connection,
        ) -> zbus::fdo::Result<zbus::zvariant::OwnedFd> {
            let (payload, emit_owner_change) = {
                let mut state = self.state.lock().unwrap();
                state.read_calls += 1;
                if state.fail_first_second_read && state.read_calls == 2 {
                    state.fail_first_second_read = false;
                    return Err(zbus::fdo::Error::Failed("Internal error".to_string()));
                }
                let emit_change = state.change_owner_after_first_read && state.read_calls == 1;
                if emit_change {
                    state.change_owner_after_first_read = false;
                }
                let bytes = state
                    .initial_formats
                    .iter()
                    .find(|(m, _)| m == &mime_type)
                    .map(|(_, bytes)| bytes.clone())
                    .ok_or_else(|| zbus::fdo::Error::Failed(format!("missing {mime_type}")))?;
                (bytes, emit_change)
            };
            let (reader, mut writer) = UnixStream::pair().unwrap();
            let _ = reader.set_nonblocking(true);
            tokio::task::spawn_blocking(move || {
                let _ = writer.write_all(&payload);
            });
            if emit_owner_change {
                let emitter = SignalEmitter::new(conn, PORTAL_DESKTOP_PATH).unwrap();
                let mut opts: HashMap<String, Value<'_>> = HashMap::new();
                opts.insert(
                    "mime_types".to_string(),
                    Value::from((vec!["text/plain".to_string()],)),
                );
                opts.insert("session_is_owner".to_string(), Value::from(false));
                let _ = FakeClipboard::selection_owner_changed(&emitter, session, opts).await;
            }
            let fd: std::os::fd::OwnedFd = reader.into();
            Ok(fd.into())
        }

        async fn selection_write(
            &self,
            _session: OwnedObjectPath,
            serial: u32,
        ) -> zbus::fdo::Result<zbus::zvariant::OwnedFd> {
            let (reader, writer) = UnixStream::pair().unwrap();
            let _ = writer.set_nonblocking(true);
            self.state.lock().unwrap().transfers.insert(serial, reader);
            let fd: std::os::fd::OwnedFd = writer.into();
            Ok(fd.into())
        }

        async fn selection_write_done(
            &self,
            _session: OwnedObjectPath,
            serial: u32,
            success: bool,
        ) {
            self.state
                .lock()
                .unwrap()
                .write_done
                .push((serial, success));
        }

        #[zbus(signal)]
        async fn selection_owner_changed(
            emitter: &SignalEmitter<'_>,
            session_handle: OwnedObjectPath,
            options: HashMap<String, Value<'_>>,
        ) -> zbus::Result<()>;

        #[zbus(signal)]
        async fn selection_transfer(
            emitter: &SignalEmitter<'_>,
            session_handle: OwnedObjectPath,
            mime_type: String,
            serial: u32,
        ) -> zbus::Result<()>;
    }

    async fn start_fake_portal(
        state: Arc<StdMutex<FakePortalState>>,
    ) -> (crate::test_sockets::PrivateBus, Connection, Connection) {
        let bus = crate::test_sockets::PrivateBus::start("cul-cb");
        let portal_conn = zbus::connection::Builder::address(bus.address())
            .unwrap()
            .name(PORTAL_DESKTOP_SERVICE)
            .unwrap()
            .serve_at(
                PORTAL_DESKTOP_PATH,
                FakeRemoteDesktop {
                    state: Arc::clone(&state),
                },
            )
            .unwrap()
            .serve_at(
                PORTAL_DESKTOP_PATH,
                FakeClipboard {
                    state: Arc::clone(&state),
                },
            )
            .unwrap()
            .build()
            .await
            .unwrap();
        let client_conn = zbus::connection::Builder::address(bus.address())
            .unwrap()
            .build()
            .await
            .unwrap();
        (bus, portal_conn, client_conn)
    }

    #[tokio::test]
    async fn fake_portal_preserves_rich_clipboard_retries_parallel_read_and_serves_transfers() {
        let state = Arc::new(StdMutex::new(FakePortalState {
            grant_clipboard: true,
            fail_first_second_read: true,
            initial_formats: vec![
                ("text/html".to_string(), b"<b>keep</b>".to_vec()),
                ("text/plain;charset=utf-8".to_string(), b"keep".to_vec()),
            ],
            ..Default::default()
        }));
        let (_bus, portal_conn, client_conn) = start_fake_portal(Arc::clone(&state)).await;
        let mut session = start_portal_keyboard_clipboard_session_on(client_conn, None, false)
            .await
            .unwrap();

        let previous = session.read_current_selection().await.unwrap();
        assert_eq!(previous.payload("text/html"), Some(&b"<b>keep</b>"[..]));
        assert_eq!(
            previous.payload("text/plain;charset=utf-8"),
            Some(&b"keep"[..])
        );
        // 1st read + failed 2nd read + retried 2nd read = 3 calls
        assert_eq!(state.lock().unwrap().read_calls, 3);

        session
            .replace_selection(ClipboardSelection::text("你好"))
            .await
            .unwrap();
        assert!(session.selection_still_owned());

        // Restore previous rich clipboard, then request a transfer via the portal.
        session.replace_selection(previous.clone()).await.unwrap();
        assert!(session.selection_still_owned());

        let emitter = SignalEmitter::new(&portal_conn, PORTAL_DESKTOP_PATH).unwrap();
        FakeClipboard::selection_transfer(
            &emitter,
            session.session_handle.clone(),
            "text/html".to_string(),
            42,
        )
        .await
        .unwrap();

        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        let mut received = Vec::new();
        loop {
            if let Some(mut stream) = state.lock().unwrap().transfers.remove(&42) {
                stream.read_to_end(&mut received).unwrap();
                break;
            }
            assert!(tokio::time::Instant::now() < deadline, "transfer timed out");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(received, b"<b>keep</b>");

        // Second paste reuses cached session without calling SelectionRead on own selection.
        let calls_before = state.lock().unwrap().read_calls;
        let second_prev = session.read_current_selection().await.unwrap();
        assert_eq!(second_prev, previous);
        assert_eq!(state.lock().unwrap().read_calls, calls_before);

        // External clipboard owner takes over -> selection_still_owned flips to false.
        let mut ext_opts: HashMap<String, Value<'_>> = HashMap::new();
        ext_opts.insert(
            "mime_types".to_string(),
            Value::from((vec!["text/plain".to_string()],)),
        );
        ext_opts.insert("session_is_owner".to_string(), Value::from(false));
        FakeClipboard::selection_owner_changed(&emitter, session.session_handle.clone(), ext_opts)
            .await
            .unwrap();
        session.sync_owner_state().await;
        assert!(!session.selection_still_owned());

        session.close().await;
        assert_eq!(state.lock().unwrap().closed_sessions, 1);
    }

    #[tokio::test]
    async fn fake_portal_handles_empty_clipboard_and_unsets_cleanly() {
        let state = Arc::new(StdMutex::new(FakePortalState {
            grant_clipboard: true,
            initial_formats: Vec::new(),
            ..Default::default()
        }));
        let (_bus, _portal_conn, client_conn) = start_fake_portal(Arc::clone(&state)).await;
        let mut session = start_portal_keyboard_clipboard_session_on(client_conn, None, false)
            .await
            .unwrap();

        let previous = session.read_current_selection().await.unwrap();
        assert!(previous.is_empty());

        session
            .replace_selection(ClipboardSelection::text("你好"))
            .await
            .unwrap();
        assert!(session.selection_still_owned());

        // Restoring an empty clipboard clears Mutter's clipboard manager cache
        // with the sentinel MIME type, then unsets selection (empty options).
        session.replace_selection(previous).await.unwrap();
        assert!(!session.selection_still_owned());
        let calls = state.lock().unwrap().set_selection_calls.clone();
        assert_eq!(calls.len(), 3);
        assert_eq!(calls[1], vec![EMPTY_CLIPBOARD_CLEAR_MIME.to_string()]);
        assert!(calls[2].is_empty());

        session.close().await;
    }

    #[tokio::test]
    async fn fake_portal_empty_restore_propagates_sentinel_failure_without_unsetting() {
        let state = Arc::new(StdMutex::new(FakePortalState {
            grant_clipboard: true,
            fail_sentinel_clear: true,
            initial_formats: Vec::new(),
            ..Default::default()
        }));
        let (_bus, _portal_conn, client_conn) = start_fake_portal(Arc::clone(&state)).await;
        let mut session = start_portal_keyboard_clipboard_session_on(client_conn, None, false)
            .await
            .unwrap();

        let previous = session.read_current_selection().await.unwrap();
        assert!(previous.is_empty());
        session
            .replace_selection(ClipboardSelection::text("你好"))
            .await
            .unwrap();

        let err = session
            .replace_selection(previous)
            .await
            .expect_err("sentinel failure must surface instead of silently unsetting");
        assert!(
            err.to_string().contains("sentinel clear"),
            "unexpected error: {err:#}"
        );
        // Only the temporary text SetSelection ran; unset must not run after sentinel failure.
        assert_eq!(state.lock().unwrap().set_selection_calls.len(), 1);
        assert!(
            !session.can_keep_alive_as_owner(),
            "failed empty restore cleared local selection and must not stay alive as retired owner"
        );
        session.close().await;
    }

    #[tokio::test]
    async fn fake_portal_rejects_oversized_mime_payload_without_invalidating_session() {
        let state = Arc::new(StdMutex::new(FakePortalState {
            grant_clipboard: true,
            initial_formats: vec![(
                "application/octet-stream".to_string(),
                vec![b'x'; MAX_CLIPBOARD_MIME_BYTES + 1],
            )],
            ..Default::default()
        }));
        let (_bus, _portal_conn, client_conn) = start_fake_portal(Arc::clone(&state)).await;
        let mut session = start_portal_keyboard_clipboard_session_on(client_conn, None, false)
            .await
            .unwrap();

        let error = session
            .read_current_selection()
            .await
            .expect_err("oversized payload must be refused");
        assert!(
            is_non_fatal_clipboard_error(&error),
            "size refusal should keep session healthy: {error:#}"
        );
        assert!(session.is_valid());
        session.close().await;
    }

    #[tokio::test]
    async fn fake_portal_detects_mid_read_owner_change() {
        let state = Arc::new(StdMutex::new(FakePortalState {
            grant_clipboard: true,
            change_owner_after_first_read: true,
            initial_formats: vec![
                ("text/html".to_string(), b"<b>a</b>".to_vec()),
                ("text/plain".to_string(), b"a".to_vec()),
            ],
            ..Default::default()
        }));
        let (_bus, _portal_conn, client_conn) = start_fake_portal(Arc::clone(&state)).await;
        let mut session = start_portal_keyboard_clipboard_session_on(client_conn, None, false)
            .await
            .unwrap();

        let error = session
            .read_current_selection()
            .await
            .expect_err("mid-read owner change must abort snapshot");
        assert!(
            is_non_fatal_clipboard_error(&error),
            "mid-read owner change should be non-fatal: {error:#}"
        );
        assert!(error.to_string().contains("owner changed"), "{error:#}");
        assert!(session.is_valid());
        session.close().await;
    }

    #[tokio::test]
    async fn fake_portal_keyboard_cleanup_preserves_session_when_keys_release_cleanly() {
        let state = Arc::new(StdMutex::new(FakePortalState {
            grant_clipboard: true,
            fail_keycode_press_index: Some(1),
            initial_formats: vec![("text/html".to_string(), b"<b>keep</b>".to_vec())],
            ..Default::default()
        }));
        let (_bus, _portal_conn, client_conn) = start_fake_portal(Arc::clone(&state)).await;
        let mut session = start_portal_keyboard_clipboard_session_on(client_conn, None, false)
            .await
            .unwrap();

        let previous = session.read_current_selection().await.unwrap();
        session
            .replace_selection(ClipboardSelection::text("temp"))
            .await
            .unwrap();

        let lock = Arc::new(AsyncMutex::new(()));
        let err = press_keycode_chord(
            session.keyboard(),
            &[29],
            47,
            InputOperationGuard::new(Arc::clone(&lock).lock_owned().await),
        )
        .await
        .expect_err("second key press must fail");
        assert!(
            format!("{err:#}").contains("injected press failure"),
            "{err:#}"
        );

        session.wait_for_keyboard_cleanup().await;
        assert!(!session.is_valid());
        assert!(!session.was_closed_by_keyboard_cleanup());
        assert_eq!(state.lock().unwrap().closed_sessions, 0);
        // Cleanup released the pushed keys and left the session open so restore succeeds.
        assert!(session.selection_still_owned());
        session.replace_selection(previous).await.unwrap();
        assert!(session.selection_still_owned());
        session.close().await;
        assert_eq!(state.lock().unwrap().closed_sessions, 1);
    }

    #[tokio::test]
    async fn fake_portal_keyboard_cleanup_closes_session_when_key_release_fails() {
        let state = Arc::new(StdMutex::new(FakePortalState {
            grant_clipboard: true,
            fail_keycode_press_index: Some(1),
            fail_keycode_release: true,
            initial_formats: vec![("text/html".to_string(), b"<b>keep</b>".to_vec())],
            ..Default::default()
        }));
        let (_bus, _portal_conn, client_conn) = start_fake_portal(Arc::clone(&state)).await;
        let mut session = start_portal_keyboard_clipboard_session_on(client_conn, None, false)
            .await
            .unwrap();

        session
            .replace_selection(ClipboardSelection::text("temp"))
            .await
            .unwrap();

        let lock = Arc::new(AsyncMutex::new(()));
        let _ = press_keycode_chord(
            session.keyboard(),
            &[29],
            47,
            InputOperationGuard::new(Arc::clone(&lock).lock_owned().await),
        )
        .await
        .expect_err("second key press must fail");

        session.wait_for_keyboard_cleanup().await;
        assert!(session.was_closed_by_keyboard_cleanup());
        assert!(!session.selection_still_owned());
        assert_eq!(state.lock().unwrap().closed_sessions, 1);
        session.close().await;
        assert_eq!(state.lock().unwrap().closed_sessions, 1);
    }

    #[tokio::test]
    async fn fake_portal_drop_closes_session_without_explicit_close() {
        let state = Arc::new(StdMutex::new(FakePortalState {
            grant_clipboard: true,
            ..Default::default()
        }));
        let (_bus, _portal_conn, client_conn) = start_fake_portal(Arc::clone(&state)).await;
        let session = start_portal_keyboard_clipboard_session_on(client_conn, None, false)
            .await
            .unwrap();
        drop(session);

        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        while state.lock().unwrap().closed_sessions == 0 {
            assert!(
                tokio::time::Instant::now() < deadline,
                "dropping PortalClipboardSession did not close portal session"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(state.lock().unwrap().closed_sessions, 1);
    }

    #[tokio::test]
    async fn fake_portal_rejects_session_without_clipboard_grant() {
        let state = Arc::new(StdMutex::new(FakePortalState {
            grant_clipboard: false,
            ..Default::default()
        }));
        let (_bus, _portal_conn, client_conn) = start_fake_portal(Arc::clone(&state)).await;
        let error = start_portal_keyboard_clipboard_session_on(client_conn, None, false)
            .await
            .err()
            .expect("missing clipboard grant must fail");
        assert!(
            error.to_string().contains("without clipboard access"),
            "{error:#}"
        );
    }
}
