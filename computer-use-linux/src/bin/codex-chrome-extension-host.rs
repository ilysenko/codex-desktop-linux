use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    env, fs,
    fs::File,
    io::{self, BufRead, BufReader, ErrorKind, Read, Seek, SeekFrom, Write},
    net::Shutdown,
    os::unix::{
        ffi::OsStrExt,
        fs::{MetadataExt, PermissionsExt},
        io::AsRawFd,
        net::{UnixListener, UnixStream},
    },
    path::{Path, PathBuf},
    process,
    sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc::{sync_channel, Receiver, SyncSender, TrySendError},
        Arc, Mutex, Weak,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[path = "../chrome_runtime.rs"]
mod chrome_runtime;

use chrome_runtime::RuntimeManager;

const HOST_NAME: &str = "com.openai.codexextension";
const SOCKET_DIR_ENV: &str = "CODEX_BROWSER_USE_SOCKET_DIR";
const SESSIONS_DIR_ENV: &str = "CODEX_BROWSER_USE_SESSIONS_DIR";
const SOCKET_DIR_NAME: &str = "codex-browser-use";
const MAX_UNIX_SOCKET_PATH_BYTES: usize = 107;
const ROLLOUT_POLL_INTERVAL: Duration = Duration::from_millis(500);
const OBSERVED_TURN_TTL: Duration = Duration::from_secs(6 * 60 * 60);
const ROLLOUT_SEARCH_MAX_DEPTH: usize = 5;
/// Chrome permits native-messaging payloads up to 64 MiB from the extension.
const MAX_ACCEPTED_FRAME_BYTES: usize = 64 * 1024 * 1024;
/// Requests older than this can no longer hold correlation state indefinitely.
const PENDING_REQUEST_TTL: Duration = Duration::from_secs(10 * 60);
/// Bounds unanswered correlations independently in each bridge direction.
const MAX_PENDING_REQUESTS_PER_DIRECTION: usize = 1024;
/// Prevents one stalled browser client from exhausting the shared request pool.
const MAX_PENDING_REQUESTS_PER_CLIENT_PER_DIRECTION: usize = 256;
/// Bounds retained string IDs to about 4 MiB per direction at the entry cap.
const MAX_PENDING_REQUEST_ID_STRING_BYTES: usize = 4 * 1024;
/// Bounds simultaneously connected Codex browser clients and their I/O threads.
const MAX_CONNECTED_CLIENTS: usize = 64;
/// Retains a small secondary item bound for streams of tiny messages.
const CLIENT_WRITE_QUEUE_MAX_MESSAGES: usize = 64;
/// Bounds each client's queued and in-flight serialized frame bytes.
const CLIENT_WRITE_QUEUE_MAX_BYTES: usize = MAX_ACCEPTED_FRAME_BYTES + std::mem::size_of::<u32>();
/// Bounds retained browser-session routing state.
const MAX_TRACKED_SESSIONS: usize = 1024;
const MAX_SESSION_ID_BYTES: usize = 1024;
const PENDING_REQUEST_LIMIT_ERROR_CODE: i64 = -32001;
const INVALID_REQUEST_ERROR_CODE: i64 = -32600;

type SharedState = Arc<Mutex<HostState>>;
type SharedChromeWriter = Arc<Mutex<Box<dyn Write + Send>>>;
type SharedClientFrame = Arc<[u8]>;

struct Client {
    sender: SyncSender<QueuedClientFrame>,
    queued_bytes: Arc<AtomicUsize>,
    max_queued_bytes: usize,
    shutdown: UnixStream,
}

impl Client {
    fn new(
        sender: SyncSender<QueuedClientFrame>,
        queued_bytes: Arc<AtomicUsize>,
        shutdown: UnixStream,
    ) -> Self {
        Self {
            sender,
            queued_bytes,
            max_queued_bytes: CLIENT_WRITE_QUEUE_MAX_BYTES,
            shutdown,
        }
    }

    #[cfg(test)]
    fn with_max_queued_bytes(
        sender: SyncSender<QueuedClientFrame>,
        queued_bytes: Arc<AtomicUsize>,
        max_queued_bytes: usize,
        shutdown: UnixStream,
    ) -> Self {
        Self {
            sender,
            queued_bytes,
            max_queued_bytes,
            shutdown,
        }
    }
}

struct QueuedClientFrame {
    bytes: SharedClientFrame,
    queued_bytes: Arc<AtomicUsize>,
}

impl Drop for QueuedClientFrame {
    fn drop(&mut self) {
        self.queued_bytes
            .fetch_sub(self.bytes.len(), Ordering::AcqRel);
    }
}

struct PendingChromeRequest {
    client_id: usize,
    client_request_id: Value,
    fallback_extension_info: bool,
    created_at: Instant,
}

#[derive(Clone)]
struct PendingClientRequest {
    client_id: usize,
    chrome_request_id: Value,
    fanout_group: Option<u64>,
    created_at: Instant,
}

#[derive(Debug, PartialEq, Eq)]
enum ChromeClientRouteError {
    NoClients,
    MultipleClients,
}

impl ChromeClientRouteError {
    fn message(&self) -> &'static str {
        match self {
            Self::NoClients => "No Codex browser client is connected",
            Self::MultipleClients => {
                "Multiple Codex browser clients are connected; Chrome request is not scoped to a known browser session"
            }
        }
    }
}

struct HostState {
    stdout: SharedChromeWriter,
    rollout_tracker: RolloutTracker,
    extension_id: Option<String>,
    clients: HashMap<usize, Client>,
    session_owners: HashMap<String, usize>,
    pending_chrome_requests: HashMap<String, PendingChromeRequest>,
    pending_client_requests: HashMap<String, PendingClientRequest>,
    next_client_id: usize,
    next_chrome_id: u64,
    next_client_request_id: u64,
    runtime_manager: Arc<RuntimeManager>,
}

impl HostState {
    fn new(
        stdout: SharedChromeWriter,
        rollout_tracker: RolloutTracker,
        extension_id: Option<String>,
        runtime_manager: Arc<RuntimeManager>,
    ) -> Self {
        Self {
            stdout,
            rollout_tracker,
            extension_id,
            clients: HashMap::new(),
            session_owners: HashMap::new(),
            pending_chrome_requests: HashMap::new(),
            pending_client_requests: HashMap::new(),
            next_client_id: 1,
            next_chrome_id: 1,
            next_client_request_id: 1,
            runtime_manager,
        }
    }

    fn add_client(&mut self, client: Client) -> Option<usize> {
        if self.clients.len() >= MAX_CONNECTED_CLIENTS {
            return None;
        }

        let mut id = self.next_client_id.max(1);
        while self.clients.contains_key(&id) {
            id = id.checked_add(1).unwrap_or(1);
        }
        self.next_client_id = id.checked_add(1).unwrap_or(1);
        self.clients.insert(id, client);
        Some(id)
    }

    fn remove_client(&mut self, client_id: usize) -> bool {
        let Some(client) = self.clients.remove(&client_id) else {
            return false;
        };
        let _ = client.shutdown.shutdown(Shutdown::Both);
        self.session_owners
            .retain(|_, owner_client_id| *owner_client_id != client_id);
        remove_pending_requests_for_client(
            &mut self.pending_chrome_requests,
            &mut self.pending_client_requests,
            client_id,
        );
        true
    }

    fn track_session_owner(&mut self, client_id: usize, message: &Value) {
        let Some(session_id) = session_id_from_message(message) else {
            return;
        };
        if !self.clients.contains_key(&client_id) {
            return;
        }
        if !self.session_owners.contains_key(session_id)
            && self.session_owners.len() >= MAX_TRACKED_SESSIONS
        {
            return;
        }

        self.session_owners
            .insert(session_id.to_string(), client_id);
    }

    fn session_owner(&self, message: &Value) -> Option<usize> {
        let session_id = session_id_from_message(message)?;
        let client_id = *self.session_owners.get(session_id)?;
        self.clients.contains_key(&client_id).then_some(client_id)
    }

    fn prune_expired_pending_requests(&mut self, now: Instant) {
        self.pending_chrome_requests.retain(|_, pending| {
            now.saturating_duration_since(pending.created_at) < PENDING_REQUEST_TTL
        });
        self.pending_client_requests.retain(|_, pending| {
            now.saturating_duration_since(pending.created_at) < PENDING_REQUEST_TTL
        });
    }

    fn pending_chrome_request_count(&self, client_id: usize) -> usize {
        self.pending_chrome_requests
            .values()
            .filter(|pending| pending.client_id == client_id)
            .count()
    }

    fn pending_client_request_count(&self, client_id: usize) -> usize {
        self.pending_client_requests
            .values()
            .filter(|pending| pending.client_id == client_id)
            .count()
    }

    fn send_chrome(&self, message: &Value) {
        let mut stdout = self.stdout.lock().expect("stdout mutex poisoned");
        if let Err(error) = write_frame(&mut *stdout, message) {
            log(&format!("native stdout error: {error}"));
            process::exit(1);
        }
    }

    fn send_client(&mut self, client_id: usize, message: &Value) -> bool {
        if !self.clients.contains_key(&client_id) {
            return false;
        }

        let frame = match serialize_frame(message) {
            Ok(frame) => frame,
            Err(error) => {
                log(&format!("client frame serialization error: {error}"));
                self.remove_client(client_id);
                return false;
            }
        };
        self.send_client_frame(client_id, frame)
    }

    fn send_client_frame(&mut self, client_id: usize, frame: SharedClientFrame) -> bool {
        let Some(client) = self.clients.get(&client_id) else {
            return false;
        };
        let sender = client.sender.clone();
        let queued_bytes = Arc::clone(&client.queued_bytes);
        let max_queued_bytes = client.max_queued_bytes;

        if !try_reserve_queue_bytes(&queued_bytes, frame.len(), max_queued_bytes) {
            log(&format!(
                "disconnecting browser client {client_id}: outbound byte limit exceeded"
            ));
            self.remove_client(client_id);
            return false;
        }

        let queued = QueuedClientFrame {
            bytes: frame,
            queued_bytes,
        };

        match sender.try_send(queued) {
            Ok(()) => true,
            Err(TrySendError::Full(queued)) => {
                drop(queued);
                log(&format!(
                    "disconnecting browser client {client_id}: outbound queue is full"
                ));
                self.remove_client(client_id);
                false
            }
            Err(TrySendError::Disconnected(queued)) => {
                drop(queued);
                log(&format!(
                    "disconnecting browser client {client_id}: writer is unavailable"
                ));
                self.remove_client(client_id);
                false
            }
        }
    }

    fn broadcast_clients(&mut self, message: &Value) {
        let frame = match serialize_frame(message) {
            Ok(frame) => frame,
            Err(error) => {
                log(&format!("client frame serialization error: {error}"));
                return;
            }
        };
        for client_id in self.clients.keys().copied().collect::<Vec<_>>() {
            self.send_client_frame(client_id, Arc::clone(&frame));
        }
    }

    fn send_chrome_notification(&mut self, message: &Value) {
        if let Some(client_id) = self.session_owner(message) {
            self.send_client(client_id, message);
        } else {
            self.broadcast_clients(message);
        }
    }
}

fn try_reserve_queue_bytes(counter: &AtomicUsize, bytes: usize, max_bytes: usize) -> bool {
    counter
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
            current
                .checked_add(bytes)
                .filter(|total| *total <= max_bytes)
        })
        .is_ok()
}

#[derive(Clone)]
struct RolloutTracker {
    inner: Arc<Mutex<RolloutTrackerState>>,
    stdout: SharedChromeWriter,
    sessions_root: Option<PathBuf>,
}

struct RolloutTrackerState {
    observed: HashMap<String, ObservedTurn>,
}

struct ObservedTurn {
    session_id: String,
    turn_id: String,
    path: Option<PathBuf>,
    offset: u64,
    created_at: Instant,
}

impl RolloutTracker {
    fn new(stdout: SharedChromeWriter) -> Self {
        let tracker = Self {
            inner: Arc::new(Mutex::new(RolloutTrackerState {
                observed: HashMap::new(),
            })),
            stdout,
            sessions_root: sessions_root(),
        };

        let worker = tracker.clone();
        if let Err(error) = thread::Builder::new()
            .name("codex-rollout-tracker".to_string())
            .spawn(move || worker.watch_loop())
        {
            log(&format!("extension-host: rollout watcher error: {error}"));
        }

        tracker
    }

    fn observe_request(&self, message: &Value) {
        let Some((session_id, turn_id)) = session_turn_from_message(message) else {
            return;
        };

        let key = observed_turn_key(&session_id, &turn_id);
        let mut state = self.inner.lock().expect("rollout watcher mutex poisoned");
        if state.observed.contains_key(&key) {
            return;
        }

        let (path, offset) = self
            .sessions_root
            .as_deref()
            .and_then(|root| find_rollout_path(root, &session_id))
            .map(|path| {
                let offset = file_len(&path).unwrap_or_default();
                (Some(path), offset)
            })
            .unwrap_or((None, 0));

        state.observed.insert(
            key,
            ObservedTurn {
                session_id,
                turn_id,
                path,
                offset,
                created_at: Instant::now(),
            },
        );
    }

    fn watch_loop(self) {
        loop {
            thread::sleep(ROLLOUT_POLL_INTERVAL);
            if let Err(error) = self.process_rollouts() {
                log(&format!("extension-host: rollout watcher error: {error}"));
            }
        }
    }

    fn process_rollouts(&self) -> Result<()> {
        let Some(sessions_root) = self.sessions_root.as_deref() else {
            return Ok(());
        };

        let mut completed = Vec::new();
        let mut expired = Vec::new();
        {
            let mut state = self.inner.lock().expect("tracker mutex poisoned");
            for (key, observed) in &mut state.observed {
                if observed.created_at.elapsed() >= OBSERVED_TURN_TTL {
                    expired.push(key.clone());
                    continue;
                }

                if observed.path.is_none() {
                    if let Some(path) = find_rollout_path(sessions_root, &observed.session_id) {
                        observed.offset = 0;
                        observed.path = Some(path);
                    }
                }

                let Some(path) = observed.path.as_ref() else {
                    continue;
                };

                let (offset, is_complete) =
                    drain_rollout_file(path, observed.offset, &observed.turn_id).with_context(
                        || format!("failed to drain rollout file {}", path.display()),
                    )?;
                observed.offset = offset;
                if is_complete {
                    completed.push((
                        key.clone(),
                        observed.session_id.clone(),
                        observed.turn_id.clone(),
                    ));
                }
            }

            for key in expired {
                state.observed.remove(&key);
            }
            for (key, _, _) in &completed {
                state.observed.remove(key);
            }
        }

        for (_, session_id, turn_id) in completed {
            self.emit_turn_ended(&session_id, &turn_id);
        }

        Ok(())
    }

    fn emit_turn_ended(&self, session_id: &str, turn_id: &str) {
        let message = json!({
            "jsonrpc": "2.0",
            "id": format!("native-turn-ended:{session_id}:{turn_id}"),
            "method": "turnEnded",
            "params": {
                "session_id": session_id,
                "turn_id": turn_id
            }
        });

        let mut stdout = self.stdout.lock().expect("stdout writer mutex poisoned");
        if let Err(error) = write_frame(&mut *stdout, &message) {
            log(&format!(
                "extension-host: failed to emit turnEnded for session {session_id}: {error}"
            ));
        }
    }
}

fn main() -> Result<()> {
    let effective_uid = unsafe { libc::geteuid() };
    let socket_dir = socket_dir(effective_uid);
    let socket_path = socket_path(&socket_dir)?;
    prepare_socket_dir(&socket_dir)?;
    remove_socket_if_present(&socket_path)?;

    let listener = UnixListener::bind(&socket_path)
        .with_context(|| format!("failed to bind {}", socket_path.display()))?;
    fs::set_permissions(&socket_path, fs::Permissions::from_mode(0o600))
        .with_context(|| format!("failed to chmod {}", socket_path.display()))?;

    let stdout: SharedChromeWriter = Arc::new(Mutex::new(Box::new(io::stdout())));
    let rollout_tracker = RolloutTracker::new(Arc::clone(&stdout));
    let extension_id = extension_id_from_args();
    let runtime_manager = Arc::new(RuntimeManager::new(extension_id.clone()));
    let state = Arc::new(Mutex::new(HostState::new(
        stdout,
        rollout_tracker,
        extension_id,
        Arc::clone(&runtime_manager),
    )));

    log(&format!("listening on {}", socket_path.display()));

    {
        let state = Arc::clone(&state);
        thread::spawn(move || accept_clients(listener, state));
    }

    let result = read_chrome_messages(Arc::clone(&state));
    runtime_manager.shutdown();
    remove_socket_if_present(&socket_path)?;
    result
}

fn socket_dir(effective_uid: u32) -> PathBuf {
    if let Some(path) = env::var_os(SOCKET_DIR_ENV).filter(|value| !value.is_empty()) {
        return PathBuf::from(path);
    }

    default_socket_dir(effective_uid)
}

fn default_socket_dir(effective_uid: u32) -> PathBuf {
    PathBuf::from(format!("/tmp/{SOCKET_DIR_NAME}-{effective_uid}"))
}

fn sessions_root() -> Option<PathBuf> {
    if let Some(path) = env::var_os(SESSIONS_DIR_ENV).map(PathBuf::from) {
        return Some(path);
    }

    if let Some(path) = env::var_os("CODEX_HOME").map(PathBuf::from) {
        return Some(path.join("sessions"));
    }

    env::var_os("HOME")
        .map(PathBuf::from)
        .map(|home| home.join(".codex").join("sessions"))
}

fn extension_id_from_args() -> Option<String> {
    env::args().skip(1).find_map(|arg| {
        arg.strip_prefix("chrome-extension://")
            .and_then(|value| value.split('/').next())
            .filter(|value| is_extension_id(value))
            .map(ToString::to_string)
    })
}

fn is_extension_id(value: &str) -> bool {
    value.len() == 32 && value.bytes().all(|byte| matches!(byte, b'a'..=b'p'))
}

fn socket_path(socket_dir: &Path) -> Result<PathBuf> {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    socket_path_for(socket_dir, process::id(), nonce)
}

fn socket_path_for(socket_dir: &Path, process_id: u32, nonce: u128) -> Result<PathBuf> {
    let path = socket_dir.join(format!("extension-{process_id}-{nonce}.sock"));
    if path.as_os_str().as_bytes().len() > MAX_UNIX_SOCKET_PATH_BYTES {
        bail!(
            "unix socket path exceeds the {MAX_UNIX_SOCKET_PATH_BYTES}-byte Linux limit: {}",
            path.display()
        );
    }
    Ok(path)
}

fn prepare_socket_dir(path: &Path) -> Result<()> {
    fs::create_dir_all(path).with_context(|| format!("failed to create {}", path.display()))?;

    let metadata =
        fs::symlink_metadata(path).with_context(|| format!("failed to stat {}", path.display()))?;
    if !metadata.file_type().is_dir() {
        bail!(
            "unix socket directory path is not a directory: {}",
            path.display()
        );
    }

    let effective_uid = unsafe { libc::geteuid() };
    if metadata.uid() != effective_uid {
        bail!(
            "unix socket directory is owned by uid {}, expected {}: {}",
            metadata.uid(),
            effective_uid,
            path.display()
        );
    }

    if metadata.permissions().mode() & 0o777 != 0o700 {
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .with_context(|| format!("failed to chmod {}", path.display()))?;
    }

    Ok(())
}

fn remove_socket_if_present(path: &Path) -> Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).with_context(|| format!("failed to remove {}", path.display())),
    }
}

fn accept_clients(listener: UnixListener, state: SharedState) {
    for stream in listener.incoming() {
        let stream = match stream {
            Ok(stream) => stream,
            Err(error) => {
                log(&format!("platform accept error: {error}"));
                continue;
            }
        };

        match authorize_peer(&stream) {
            Ok(true) => {}
            Ok(false) => continue,
            Err(error) => {
                log(&format!("peer authorization error: {error}"));
                continue;
            }
        }

        let writer = match stream.try_clone() {
            Ok(stream) => stream,
            Err(error) => {
                log(&format!("client socket clone error: {error}"));
                continue;
            }
        };
        let shutdown = match stream.try_clone() {
            Ok(stream) => stream,
            Err(error) => {
                log(&format!("client socket clone error: {error}"));
                continue;
            }
        };
        let (sender, receiver) = sync_channel::<QueuedClientFrame>(CLIENT_WRITE_QUEUE_MAX_MESSAGES);
        let queued_bytes = Arc::new(AtomicUsize::new(0));

        let client_id = {
            let mut state = state.lock().expect("host state mutex poisoned");
            state.add_client(Client::new(sender, queued_bytes, shutdown))
        };
        let Some(client_id) = client_id else {
            log(&format!(
                "rejecting browser client because the {MAX_CONNECTED_CLIENTS}-client limit was reached"
            ));
            let _ = stream.shutdown(Shutdown::Both);
            continue;
        };

        let writer_state = Arc::downgrade(&state);
        thread::spawn(move || write_client_messages(writer_state, client_id, writer, receiver));

        let reader_state = Arc::clone(&state);
        thread::spawn(move || read_client_messages(reader_state, client_id, stream));
    }
}

fn authorize_peer(stream: &UnixStream) -> Result<bool> {
    let credentials = peer_credentials(stream)?;
    let effective_uid = unsafe { libc::geteuid() };

    if credentials.uid != effective_uid {
        log(&format!(
            "rejecting peer pid {} uid {}, expected uid {}",
            credentials.pid, credentials.uid, effective_uid
        ));
        return Ok(false);
    }

    Ok(true)
}

fn peer_credentials(stream: &UnixStream) -> Result<libc::ucred> {
    let mut credentials = libc::ucred {
        pid: 0,
        uid: 0,
        gid: 0,
    };
    let mut length = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    let result = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            (&mut credentials as *mut libc::ucred).cast(),
            &mut length,
        )
    };

    if result != 0 {
        return Err(io::Error::last_os_error()).context("failed to read peer credentials");
    }

    Ok(credentials)
}

fn read_chrome_messages(state: SharedState) -> Result<()> {
    let stdin = io::stdin();
    let mut reader = stdin.lock();
    while let Some(message) =
        read_frame(&mut reader).context("extension-host: platform reader error")?
    {
        handle_chrome_message(&state, message);
    }
    Ok(())
}

fn read_client_messages(state: SharedState, client_id: usize, stream: UnixStream) {
    let mut stream = stream;
    loop {
        match read_frame(&mut stream) {
            Ok(Some(message)) => handle_client_message(&state, client_id, message),
            Ok(None) => break,
            Err(error) => {
                log(&format!("client socket read error: {error}"));
                break;
            }
        }
    }

    disconnect_client(&state, client_id);
}

fn write_client_messages(
    state: Weak<Mutex<HostState>>,
    client_id: usize,
    mut stream: UnixStream,
    receiver: Receiver<QueuedClientFrame>,
) {
    while let Ok(frame) = receiver.recv() {
        if let Err(error) = write_serialized_frame(&mut stream, &frame.bytes) {
            log(&format!("client socket write error: {error}"));
            break;
        }
    }

    if let Some(state) = state.upgrade() {
        disconnect_client(&state, client_id);
    }
}

fn disconnect_client(state: &SharedState, client_id: usize) {
    let mut state = state.lock().expect("host state mutex poisoned");
    state.remove_client(client_id);
}

fn handle_client_message(state: &SharedState, client_id: usize, message: Value) {
    {
        let mut state = state.lock().expect("host state mutex poisoned");
        state.prune_expired_pending_requests(Instant::now());
        if !state.clients.contains_key(&client_id) {
            return;
        }
    }

    if is_response(&message) {
        let Some(id) = message_id_as_str(&message) else {
            return;
        };

        let mut state = state.lock().expect("host state mutex poisoned");
        let Some(pending) = state.pending_client_requests.get(id).cloned() else {
            return;
        };
        if pending.client_id != client_id {
            return;
        }
        state.pending_client_requests.remove(id);
        if let Some(group) = pending.fanout_group {
            if is_successful_heartbeat_response(&message) {
                state
                    .pending_client_requests
                    .retain(|_, sibling| sibling.fanout_group != Some(group));
                state.send_chrome(&with_id(message, pending.chrome_request_id));
            } else if !state
                .pending_client_requests
                .values()
                .any(|sibling| sibling.fanout_group == Some(group))
            {
                state.send_chrome(&json!({
                    "jsonrpc": "2.0",
                    "id": pending.chrome_request_id,
                    "error": {
                        "code": -32000,
                        "message": "No browser client returned a valid heartbeat response"
                    }
                }));
            }
            return;
        }

        state.send_chrome(&with_id(message, pending.chrome_request_id));
        return;
    }

    if !is_request(&message) {
        let state = state.lock().expect("host state mutex poisoned");
        if state.clients.contains_key(&client_id) {
            state.send_chrome(&message);
        }
        return;
    }

    {
        let tracker = {
            let state = state.lock().expect("host state mutex poisoned");
            state.rollout_tracker.clone()
        };
        tracker.observe_request(&message);
    }

    if message.get("method").and_then(Value::as_str) == Some("ping") {
        let Some(id) = message.get("id").cloned() else {
            return;
        };
        let mut state = state.lock().expect("host state mutex poisoned");
        state.send_client(
            client_id,
            &json!({ "jsonrpc": "2.0", "id": id, "result": "pong" }),
        );
        return;
    }

    let client_request_id = match bounded_pending_request_id(&message) {
        Ok(id) => id,
        Err(error) => {
            let mut state = state.lock().expect("host state mutex poisoned");
            if state.clients.contains_key(&client_id) {
                state.send_client(client_id, &invalid_request_id_error(error));
            }
            return;
        }
    };
    let fallback_extension_info = message.get("method").and_then(Value::as_str) == Some("getInfo");

    let mut state = state.lock().expect("host state mutex poisoned");
    if !state.clients.contains_key(&client_id) {
        return;
    }
    state.track_session_owner(client_id, &message);
    if state.pending_chrome_request_count(client_id)
        >= MAX_PENDING_REQUESTS_PER_CLIENT_PER_DIRECTION
    {
        state.send_client(
            client_id,
            &pending_request_limit_error(
                client_request_id,
                "Too many pending requests from this browser client to Chrome",
            ),
        );
        return;
    }
    if state.pending_chrome_requests.len() >= MAX_PENDING_REQUESTS_PER_DIRECTION {
        state.send_client(
            client_id,
            &pending_request_limit_error(
                client_request_id,
                "Too many pending client requests to Chrome",
            ),
        );
        return;
    }
    let chrome_id = format!("linux-{}-{}", process::id(), state.next_chrome_id);
    state.next_chrome_id += 1;
    state.pending_chrome_requests.insert(
        chrome_id.clone(),
        PendingChromeRequest {
            client_id,
            client_request_id,
            fallback_extension_info,
            created_at: Instant::now(),
        },
    );
    state.send_chrome(&with_id(message, Value::String(chrome_id)));
}

fn handle_chrome_message(state: &SharedState, message: Value) {
    {
        let mut state = state.lock().expect("host state mutex poisoned");
        state.prune_expired_pending_requests(Instant::now());
    }

    if chrome_runtime::is_runtime_request(&message) {
        let runtime_manager = {
            let state = state.lock().expect("host state mutex poisoned");
            Arc::clone(&state.runtime_manager)
        };
        // App-server children use PR_SET_PDEATHSIG. Launch them from this
        // long-lived native-messaging thread, not a short-lived request worker.
        let response = runtime_manager.handle_request(&message);
        let state = state.lock().expect("host state mutex poisoned");
        state.send_chrome(&response);
        return;
    }

    if is_response(&message) {
        let Some(id) = message_id_as_str(&message) else {
            return;
        };

        let mut state = state.lock().expect("host state mutex poisoned");
        let Some(pending) = state.pending_chrome_requests.remove(id) else {
            return;
        };

        // chrome.runtime.getVersion() is available in Chrome/Chromium 143+.
        // Keep forwarding getInfo for browsers that support it, and only
        // synthesize discovery metadata for this older-runtime compatibility
        // failure.
        if pending.fallback_extension_info && is_missing_chrome_runtime_get_version_error(&message)
        {
            let response =
                extension_info_response(pending.client_request_id, state.extension_id.as_deref());
            state.send_client(pending.client_id, &response);
            return;
        }

        state.send_client(
            pending.client_id,
            &with_id(message, pending.client_request_id),
        );
        return;
    }

    if !is_request(&message) {
        let mut state = state.lock().expect("host state mutex poisoned");
        state.send_chrome_notification(&message);
        return;
    }

    let chrome_request_id = match bounded_pending_request_id(&message) {
        Ok(id) => id,
        Err(error) => {
            let state = state.lock().expect("host state mutex poisoned");
            state.send_chrome(&invalid_request_id_error(error));
            return;
        }
    };
    let mut state = state.lock().expect("host state mutex poisoned");
    if message.get("method").and_then(Value::as_str) == Some("ping")
        && state.session_owner(&message).is_none()
    {
        forward_chrome_heartbeat(&mut state, message, chrome_request_id);
        return;
    }

    let client_id = match select_client_id_for_chrome_request(&state, &message) {
        Ok(client_id) => client_id,
        Err(error) => {
            state.send_chrome(&json!({
                "jsonrpc": "2.0",
                "id": chrome_request_id,
                "error": {
                    "code": -32000,
                    "message": error.message()
                }
            }));
            return;
        }
    };

    let client_request_id = format!("chrome-{}-{}", process::id(), state.next_client_request_id);
    if state.pending_client_request_count(client_id)
        >= MAX_PENDING_REQUESTS_PER_CLIENT_PER_DIRECTION
    {
        state.send_chrome(&pending_request_limit_error(
            chrome_request_id,
            "Too many pending Chrome requests to this browser client",
        ));
        return;
    }
    if state.pending_client_requests.len() >= MAX_PENDING_REQUESTS_PER_DIRECTION {
        state.send_chrome(&pending_request_limit_error(
            chrome_request_id,
            "Too many pending Chrome requests to the browser client",
        ));
        return;
    }
    state.next_client_request_id += 1;
    state.pending_client_requests.insert(
        client_request_id.clone(),
        PendingClientRequest {
            client_id,
            chrome_request_id: chrome_request_id.clone(),
            fanout_group: None,
            created_at: Instant::now(),
        },
    );
    if !state.send_client(
        client_id,
        &with_id(message, Value::String(client_request_id)),
    ) {
        state.send_chrome(&json!({
            "jsonrpc": "2.0",
            "id": chrome_request_id,
            "error": {
                "code": -32000,
                "message": "Browser client disconnected before the request could be forwarded"
            }
        }));
    }
}

fn select_client_id_for_chrome_request(
    state: &HostState,
    message: &Value,
) -> std::result::Result<usize, ChromeClientRouteError> {
    if let Some(client_id) = state.session_owner(message) {
        return Ok(client_id);
    }

    select_single_client_id(&state.clients)
}

fn forward_chrome_heartbeat(state: &mut HostState, message: Value, chrome_request_id: Value) {
    if state.clients.is_empty() {
        state.send_chrome(&json!({
            "jsonrpc": "2.0",
            "id": chrome_request_id,
            "error": {
                "code": -32000,
                "message": ChromeClientRouteError::NoClients.message()
            }
        }));
        return;
    }

    let remaining_global_capacity =
        MAX_PENDING_REQUESTS_PER_DIRECTION.saturating_sub(state.pending_client_requests.len());
    let mut client_ids = state
        .clients
        .keys()
        .copied()
        .filter(|client_id| {
            state.pending_client_request_count(*client_id)
                < MAX_PENDING_REQUESTS_PER_CLIENT_PER_DIRECTION
        })
        .collect::<Vec<_>>();
    client_ids.sort_unstable_by_key(|client_id| {
        (state.pending_client_request_count(*client_id), *client_id)
    });
    client_ids.truncate(remaining_global_capacity);

    if client_ids.is_empty() {
        state.send_chrome(&pending_request_limit_error(
            chrome_request_id,
            "Too many pending Chrome requests to connected browser clients",
        ));
        return;
    }

    let fanout_group = state.next_client_request_id;
    let mut sent = false;
    let mut message = message;
    for client_id in client_ids {
        let client_request_id =
            format!("chrome-{}-{}", process::id(), state.next_client_request_id);
        state.next_client_request_id += 1;
        state.pending_client_requests.insert(
            client_request_id.clone(),
            PendingClientRequest {
                client_id,
                chrome_request_id: chrome_request_id.clone(),
                fanout_group: Some(fanout_group),
                created_at: Instant::now(),
            },
        );
        set_message_id(&mut message, Value::String(client_request_id));
        sent |= state.send_client(client_id, &message);
    }

    if !sent {
        state.send_chrome(&json!({
            "jsonrpc": "2.0",
            "id": chrome_request_id,
            "error": {
                "code": -32000,
                "message": "No writable Codex browser client is connected"
            }
        }));
    }
}

fn select_single_client_id(
    clients: &HashMap<usize, Client>,
) -> std::result::Result<usize, ChromeClientRouteError> {
    match clients.len() {
        0 => Err(ChromeClientRouteError::NoClients),
        1 => Ok(*clients.keys().next().expect("one client id")),
        _ => Err(ChromeClientRouteError::MultipleClients),
    }
}

fn remove_pending_requests_for_client(
    pending_chrome_requests: &mut HashMap<String, PendingChromeRequest>,
    pending_client_requests: &mut HashMap<String, PendingClientRequest>,
    client_id: usize,
) {
    pending_chrome_requests.retain(|_, pending| pending.client_id != client_id);
    pending_client_requests.retain(|_, pending| pending.client_id != client_id);
}

fn pending_request_limit_error(id: Value, message: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {
            "code": PENDING_REQUEST_LIMIT_ERROR_CODE,
            "message": message
        }
    })
}

fn bounded_pending_request_id(message: &Value) -> std::result::Result<Value, &'static str> {
    match message.get("id") {
        Some(Value::String(id)) if id.len() <= MAX_PENDING_REQUEST_ID_STRING_BYTES => {
            Ok(Value::String(id.clone()))
        }
        Some(Value::String(_)) => Err("JSON-RPC request id exceeds the retained size limit"),
        Some(Value::Number(id)) => Ok(Value::Number(id.clone())),
        Some(Value::Null) => Ok(Value::Null),
        Some(_) => Err("JSON-RPC request id must be a string, number, or null"),
        None => Err("JSON-RPC request id is missing"),
    }
}

fn invalid_request_id_error(message: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": Value::Null,
        "error": {
            "code": INVALID_REQUEST_ERROR_CODE,
            "message": message
        }
    })
}

fn is_request(message: &Value) -> bool {
    message.get("id").is_some() && message.get("method").and_then(Value::as_str).is_some()
}

fn is_response(message: &Value) -> bool {
    message.get("id").is_some() && message.get("method").and_then(Value::as_str).is_none()
}

fn is_successful_heartbeat_response(message: &Value) -> bool {
    message.get("jsonrpc").and_then(Value::as_str) == Some("2.0")
        && message.get("result").and_then(Value::as_str) == Some("pong")
        && message.get("error").is_none()
}

fn message_id_as_str(message: &Value) -> Option<&str> {
    message.get("id").and_then(Value::as_str)
}

fn with_id(mut message: Value, id: Value) -> Value {
    set_message_id(&mut message, id);
    message
}

fn set_message_id(message: &mut Value, id: Value) {
    if let Value::Object(ref mut object) = message {
        object.insert("id".to_string(), id);
    }
}

fn is_missing_chrome_runtime_get_version_error(message: &Value) -> bool {
    message
        .get("error")
        .and_then(|error| error.get("message"))
        .and_then(Value::as_str)
        .is_some_and(|message| message.contains("chrome.runtime.getVersion is not a function"))
}

fn extension_info_response(id: Value, extension_id: Option<&str>) -> Value {
    let mut metadata = serde_json::Map::new();
    if let Some(extension_id) = extension_id {
        metadata.insert(
            "extensionId".to_string(),
            Value::String(extension_id.to_string()),
        );
    }

    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": {
            "name": "Chrome",
            "version": "unknown",
            "type": "extension",
            "capabilities": {
                "tab": [
                    {
                        "id": "pageAssets",
                        "description": "List assets already observed in the current page state and bundle selected assets into a temporary local artifact."
                    }
                ]
            },
            "metadata": Value::Object(metadata)
        }
    })
}

fn session_turn_from_message(message: &Value) -> Option<(String, String)> {
    let params = message.get("params")?;
    let session_id = session_id_from_message(message)?;
    let turn_id = non_empty_string(params.get("turn_id")?)?;
    Some((session_id.to_string(), turn_id.to_string()))
}

fn session_id_from_message(message: &Value) -> Option<&str> {
    let session_id = non_empty_string(message.get("params")?.get("session_id")?)?;
    (session_id.len() <= MAX_SESSION_ID_BYTES).then_some(session_id)
}

fn non_empty_string(value: &Value) -> Option<&str> {
    let value = value.as_str()?.trim();
    (!value.is_empty()).then_some(value)
}

fn observed_turn_key(session_id: &str, turn_id: &str) -> String {
    format!("{session_id}\n{turn_id}")
}

fn file_len(path: &Path) -> io::Result<u64> {
    Ok(fs::metadata(path)?.len())
}

fn find_rollout_path(root: &Path, session_id: &str) -> Option<PathBuf> {
    let mut stack = vec![(root.to_path_buf(), 0_usize)];
    let mut best: Option<(SystemTime, PathBuf)> = None;

    while let Some((dir, depth)) = stack.pop() {
        let entries = fs::read_dir(&dir).ok()?;
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(file_type) = entry.file_type() else {
                continue;
            };

            if file_type.is_dir() {
                if depth < ROLLOUT_SEARCH_MAX_DEPTH {
                    stack.push((path, depth + 1));
                }
                continue;
            }

            if !file_type.is_file() {
                continue;
            }

            let file_name = entry.file_name();
            let file_name = file_name.to_string_lossy();
            if !file_name.contains(session_id)
                || !(file_name.ends_with(".jsonl") || file_name.ends_with(".json"))
            {
                continue;
            }

            let modified = entry
                .metadata()
                .and_then(|metadata| metadata.modified())
                .unwrap_or(UNIX_EPOCH);
            if best
                .as_ref()
                .is_none_or(|(best_modified, _)| modified > *best_modified)
            {
                best = Some((modified, path));
            }
        }
    }

    best.map(|(_, path)| path)
}

fn drain_rollout_file(path: &Path, offset: u64, turn_id: &str) -> io::Result<(u64, bool)> {
    let mut file = File::open(path)?;
    let len = file.metadata()?.len();
    file.seek(SeekFrom::Start(offset.min(len)))?;

    let mut reader = BufReader::new(file);
    let mut line = String::new();
    let mut is_complete = false;

    loop {
        line.clear();
        if reader.read_line(&mut line)? == 0 {
            break;
        }
        if line_marks_turn_complete(&line, turn_id) {
            is_complete = true;
        }
    }

    Ok((reader.stream_position()?, is_complete))
}

fn line_marks_turn_complete(line: &str, turn_id: &str) -> bool {
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return false;
    };

    let payload = value.get("payload").unwrap_or(&value);
    let payload_type = payload.get("type").and_then(Value::as_str);
    let payload_turn_id = payload.get("turn_id").and_then(Value::as_str);
    if payload_type == Some("task_complete") && payload_turn_id == Some(turn_id) {
        return true;
    }

    let top_level_type = value.get("type").and_then(Value::as_str);
    let kind = value.get("kind").and_then(Value::as_str);
    top_level_type == Some("turn")
        && matches!(kind, Some("end" | "completed" | "complete"))
        && value.get("turn_id").and_then(Value::as_str) == Some(turn_id)
}

fn read_frame(reader: &mut impl Read) -> io::Result<Option<Value>> {
    loop {
        let mut header = [0_u8; 4];
        match reader.read_exact(&mut header) {
            Ok(()) => {}
            Err(error) if error.kind() == ErrorKind::UnexpectedEof => return Ok(None),
            Err(error) => return Err(error),
        }

        let length = u32::from_ne_bytes(header) as usize;
        if length > MAX_ACCEPTED_FRAME_BYTES {
            return Err(io::Error::new(
                ErrorKind::InvalidData,
                format!(
                    "native messaging frame length {length} exceeds {MAX_ACCEPTED_FRAME_BYTES}-byte limit"
                ),
            ));
        }
        let mut body = vec![0_u8; length];
        reader.read_exact(&mut body)?;

        match serde_json::from_slice(&body) {
            Ok(message) => return Ok(Some(message)),
            Err(error) => log(&format!("dropping invalid JSON frame: {error}")),
        }
    }
}

fn write_frame(writer: &mut impl Write, message: &Value) -> io::Result<()> {
    let frame = serialize_frame(message)?;
    write_serialized_frame(writer, &frame)
}

fn serialize_frame(message: &Value) -> io::Result<SharedClientFrame> {
    let mut frame = vec![0_u8; std::mem::size_of::<u32>()];
    serde_json::to_writer(&mut frame, message).map_err(io::Error::other)?;
    let body_len = frame.len() - std::mem::size_of::<u32>();
    if body_len > u32::MAX as usize {
        return Err(io::Error::new(
            ErrorKind::InvalidInput,
            "message too large for 4-byte length prefix",
        ));
    }

    frame[..std::mem::size_of::<u32>()].copy_from_slice(&(body_len as u32).to_ne_bytes());
    Ok(frame.into())
}

fn write_serialized_frame(writer: &mut impl Write, frame: &[u8]) -> io::Result<()> {
    writer.write_all(frame)?;
    writer.flush()
}

fn log(message: &str) {
    let _ = writeln!(io::stderr(), "[{HOST_NAME}] {message}");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn socket_directory_default_is_scoped_by_uid() {
        assert_eq!(
            default_socket_dir(1000),
            PathBuf::from("/tmp/codex-browser-use-1000")
        );
    }

    #[test]
    fn complete_socket_path_is_guarded_against_the_linux_limit() {
        let short = socket_path_for(Path::new("/tmp/codex-browser-use-1000"), 42, 7).unwrap();
        assert_eq!(
            short,
            PathBuf::from("/tmp/codex-browser-use-1000/extension-42-7.sock")
        );

        let long_dir = PathBuf::from("/tmp").join("x".repeat(MAX_UNIX_SOCKET_PATH_BYTES));
        let error = socket_path_for(&long_dir, 42, 7).unwrap_err();
        assert!(error.to_string().contains("unix socket path exceeds"));
    }

    #[test]
    fn frame_round_trip_uses_native_length_prefix() {
        let message = json!({ "jsonrpc": "2.0", "id": "1", "method": "ping" });
        let mut encoded = Vec::new();
        write_frame(&mut encoded, &message).unwrap();

        let length = u32::from_ne_bytes(encoded[..4].try_into().unwrap()) as usize;
        assert_eq!(length, encoded.len() - 4);

        let mut cursor = io::Cursor::new(encoded);
        assert_eq!(read_frame(&mut cursor).unwrap(), Some(message));
    }

    #[test]
    fn rejects_frame_above_accepted_maximum_before_reading_body() {
        let oversized_length = (MAX_ACCEPTED_FRAME_BYTES as u32) + 1;
        let mut cursor = io::Cursor::new(oversized_length.to_ne_bytes());

        let error = read_frame(&mut cursor).expect_err("oversized frame should be rejected");

        assert_eq!(error.kind(), ErrorKind::InvalidData);
        assert!(error.to_string().contains("exceeds"));
        assert_eq!(cursor.position(), 4, "body must not be read or allocated");
    }

    #[test]
    fn id_replacement_preserves_other_fields() {
        let message = json!({ "jsonrpc": "2.0", "id": 1, "method": "getTabs" });
        assert_eq!(
            with_id(message, Value::String("linux-1-1".to_string())),
            json!({ "jsonrpc": "2.0", "id": "linux-1-1", "method": "getTabs" })
        );
    }

    #[test]
    fn extracts_session_turn_from_browser_request() {
        let message = json!({
            "jsonrpc": "2.0",
            "id": "request-1",
            "method": "getTabs",
            "params": {
                "session_id": "session-1",
                "turn_id": "turn-1"
            }
        });

        assert_eq!(
            session_turn_from_message(&message),
            Some(("session-1".to_string(), "turn-1".to_string()))
        );
    }

    #[test]
    fn recognizes_task_complete_rollout_line() {
        let line = r#"{"timestamp":"2026-05-09T12:00:00Z","type":"event_msg","payload":{"type":"task_complete","turn_id":"turn-1"}}"#;
        assert!(line_marks_turn_complete(line, "turn-1"));
        assert!(!line_marks_turn_complete(line, "turn-2"));
    }

    #[test]
    fn finds_nested_rollout_path_by_session_id() {
        let root = unique_test_dir("codex-rollout-path");
        let nested = root.join("2026").join("05").join("09");
        fs::create_dir_all(&nested).unwrap();
        let path = nested.join("rollout-2026-05-09T12-00-00-session-1.jsonl");
        fs::write(&path, "{}\n").unwrap();

        assert_eq!(find_rollout_path(&root, "session-1"), Some(path));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn drains_rollout_file_from_offset() {
        let root = unique_test_dir("codex-rollout-drain");
        fs::create_dir_all(&root).unwrap();
        let path = root.join("rollout-session-1.jsonl");
        fs::write(
            &path,
            "{\"type\":\"event_msg\",\"payload\":{\"type\":\"other\"}}\n",
        )
        .unwrap();
        let offset = file_len(&path).unwrap();

        let complete =
            r#"{"type":"event_msg","payload":{"type":"task_complete","turn_id":"turn-1"}}"#;
        writeln!(
            fs::OpenOptions::new().append(true).open(&path).unwrap(),
            "ignored\n{complete}"
        )
        .unwrap();
        let (new_offset, is_complete) = drain_rollout_file(&path, offset, "turn-1").unwrap();

        assert!(new_offset >= offset);
        assert!(is_complete);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn late_discovered_rollout_file_scans_existing_content() {
        let root = unique_test_dir("codex-rollout-late");
        let nested = root.join("2026").join("05").join("09");
        fs::create_dir_all(&nested).unwrap();
        let path = nested.join("rollout-session-1.jsonl");
        let complete =
            r#"{"type":"event_msg","payload":{"type":"task_complete","turn_id":"turn-1"}}"#;
        writeln!(File::create(&path).unwrap(), "{complete}").unwrap();

        let discovered = find_rollout_path(&root, "session-1").unwrap();
        let (_, is_complete) = drain_rollout_file(&discovered, 0, "turn-1").unwrap();

        assert!(is_complete);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_chrome_request_routing_without_exactly_one_client() {
        let clients = HashMap::new();
        assert_eq!(
            select_single_client_id(&clients),
            Err(ChromeClientRouteError::NoClients)
        );

        let mut clients = HashMap::new();
        clients.insert(7, test_client());
        assert_eq!(select_single_client_id(&clients), Ok(7));

        clients.insert(8, test_client());
        assert_eq!(
            select_single_client_id(&clients),
            Err(ChromeClientRouteError::MultipleClients)
        );
    }

    #[test]
    fn handles_runtime_hello_without_a_browser_client() {
        let (host_state, output) = test_host_state_with_output();
        let state = Arc::new(Mutex::new(host_state));

        handle_chrome_message(
            &state,
            json!({
                "jsonrpc": "2.0",
                "id": "native-host:1",
                "method": "codexRuntime/hello",
                "params": {
                    "constraints": {
                        "extensionBuildChannel": "prod",
                        "extensionId": "abcdefghijklmnopabcdefghijklmnop",
                        "extensionVersion": "1.2.27203.26575",
                        "nativeHostName": HOST_NAME,
                        "requiredAppServerProtocolVersion": 2,
                        "requiredNativeHostProtocolVersion": 2
                    }
                }
            }),
        );

        let response = read_captured_message(&output);
        assert_eq!(response["id"], "native-host:1");
        assert_eq!(response["result"]["manifestSchemaVersion"], 2);
        assert_eq!(response["result"]["nativeHostProtocolVersion"], 2);
        assert_eq!(response["result"]["supportedProtocolVersions"], json!([2]));
    }

    #[test]
    fn runtime_ensure_keeps_child_alive_after_request_returns() {
        let root = unique_test_dir("codex-runtime-child");
        let codex_home = root.join("codex-home");
        let resources = root.join("resources");
        let runtime_root = root.join("runtime");
        fs::create_dir_all(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        fs::create_dir_all(&codex_home).unwrap();
        fs::create_dir_all(&resources).unwrap();
        fs::set_permissions(&codex_home, fs::Permissions::from_mode(0o700)).unwrap();
        fs::set_permissions(&resources, fs::Permissions::from_mode(0o700)).unwrap();

        let fake_cli = root.join("fake-app-server");
        let python = test_executable("python3");
        fs::write(
            &fake_cli,
            format!(
                "#!{}\n{}",
                python.display(),
                r#"
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

listen = sys.argv[sys.argv.index("--listen") + 1]
path = listen.removeprefix("unix://")
descendant = subprocess.Popen(["sleep", "300"])
Path(__file__).with_name("descendant.pid").write_text(str(descendant.pid))
server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
server.bind(path)
server.listen()
signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
while True:
    time.sleep(0.1)
"#
            ),
        )
        .unwrap();
        fs::set_permissions(&fake_cli, fs::Permissions::from_mode(0o700)).unwrap();
        let fake_node = root.join("fake-node");
        fs::write(&fake_node, "#!/bin/sh\nexit 0\n").unwrap();
        fs::set_permissions(&fake_node, fs::Permissions::from_mode(0o700)).unwrap();

        let extension_id = "abcdefghijklmnopabcdefghijklmnop";
        let extension_host_path = root.join("extension-host");
        fs::copy(env::current_exe().unwrap(), &extension_host_path).unwrap();
        fs::set_permissions(&extension_host_path, fs::Permissions::from_mode(0o700)).unwrap();
        let manifest_path = root.join("chrome-native-hosts-v2.json");
        fs::write(
            &manifest_path,
            serde_json::to_vec(&json!({
                "schemaVersion": 2,
                "entries": [{
                    "schemaVersion": 2,
                    "appServerProtocolVersion": 2,
                    "appVersion": "1.2.3",
                    "channel": "prod",
                    "cliVersion": "1.2.3",
                    "entryId": "runtime-test",
                    "extensionBuildChannels": ["prod"],
                    "extensionIds": [extension_id],
                    "installId": "install-test",
                    "nativeHostNames": [HOST_NAME],
                    "nativeHostProtocolVersion": 2,
                    "nativeHostVersion": "1.2.3",
                    "paths": {
                        "codexCliPath": fake_cli,
                        "codexHome": codex_home,
                        "extensionHostPath": extension_host_path,
                        "nodePath": fake_node,
                        "resourcesPath": resources
                    },
                    "proxyHost": "127.0.0.1",
                    "proxyPort": 0,
                    "updatedAt": "2026-07-10T00:00:00Z"
                }]
            }))
            .unwrap(),
        )
        .unwrap();
        fs::set_permissions(&manifest_path, fs::Permissions::from_mode(0o600)).unwrap();

        let runtime_manager = Arc::new(RuntimeManager::for_test_with_current_executable_path(
            extension_id.to_string(),
            runtime_root.clone(),
            manifest_path,
            &extension_host_path,
        ));
        let (mut host_state, output) = test_host_state_with_output();
        host_state.runtime_manager = Arc::clone(&runtime_manager);
        let state = Arc::new(Mutex::new(host_state));

        handle_chrome_message(
            &state,
            json!({
                "jsonrpc": "2.0",
                "id": "native-host:ensure",
                "method": "codexRuntime/ensure",
                "params": {
                    "constraints": {
                        "extensionBuildChannel": "prod",
                        "extensionId": extension_id,
                        "extensionVersion": "1.2.3",
                        "nativeHostName": HOST_NAME,
                        "requiredAppServerProtocolVersion": 2,
                        "requiredNativeHostProtocolVersion": 2
                    },
                    "clientId": "sidepanel-window-test"
                }
            }),
        );

        let response = read_captured_message(&output);
        assert_eq!(response["id"], "native-host:ensure");
        assert_eq!(
            response["result"]["connected"], true,
            "runtime ensure response: {response}"
        );
        assert_eq!(runtime_manager.running_process_count(), 1);
        let descendant_pid: libc::pid_t = fs::read_to_string(root.join("descendant.pid"))
            .unwrap()
            .parse()
            .unwrap();
        assert_eq!(unsafe { libc::kill(descendant_pid, 0) }, 0);

        runtime_manager.shutdown();
        assert_eq!(runtime_manager.running_process_count(), 0);
        assert!(!runtime_root.exists());
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline && process_is_live(descendant_pid) {
            thread::sleep(Duration::from_millis(25));
        }
        assert!(!process_is_live(descendant_pid));
        fs::remove_dir_all(root).unwrap();
    }

    fn test_executable(name: &str) -> PathBuf {
        let path = env::var_os("PATH").expect("PATH is required for extension host tests");
        env::split_paths(&path)
            .filter(|directory| directory.is_absolute())
            .map(|directory| directory.join(name))
            .find(|candidate| {
                fs::metadata(candidate).is_ok_and(|metadata| {
                    metadata.is_file() && metadata.permissions().mode() & 0o111 != 0
                })
            })
            .unwrap_or_else(|| panic!("could not resolve test executable from PATH: {name}"))
    }

    #[test]
    fn adding_browser_client_preserves_existing_clients_and_pending_requests() {
        let mut state = test_host_state();

        let first_client_id = state
            .add_client(test_client())
            .expect("first client should be accepted");
        assert!(state.clients.contains_key(&first_client_id));

        state.pending_chrome_requests.insert(
            "chrome-request".to_string(),
            PendingChromeRequest {
                client_id: first_client_id,
                client_request_id: json!("client-request-1"),
                fallback_extension_info: false,
                created_at: Instant::now(),
            },
        );
        state.pending_client_requests.insert(
            "client-request".to_string(),
            PendingClientRequest {
                client_id: first_client_id,
                chrome_request_id: json!("chrome-request-1"),
                fanout_group: None,
                created_at: Instant::now(),
            },
        );

        let second_client_id = state
            .add_client(test_client())
            .expect("second client should be accepted");

        assert_ne!(first_client_id, second_client_id);
        assert!(state.clients.contains_key(&first_client_id));
        assert!(state.clients.contains_key(&second_client_id));
        assert!(state.pending_chrome_requests.contains_key("chrome-request"));
        assert!(state.pending_client_requests.contains_key("client-request"));
    }

    #[test]
    fn connected_browser_clients_are_bounded() {
        let mut state = test_host_state();
        for _ in 0..MAX_CONNECTED_CLIENTS {
            assert!(state.add_client(test_client()).is_some());
        }

        assert_eq!(state.clients.len(), MAX_CONNECTED_CLIENTS);
        assert!(state.add_client(test_client()).is_none());
    }

    #[test]
    fn unknown_client_requests_are_ignored() {
        let state = Arc::new(Mutex::new(test_host_state()));

        handle_client_message(
            &state,
            99,
            json!({ "jsonrpc": "2.0", "id": 1, "method": "getTabs" }),
        );

        let state = state.lock().unwrap();
        assert!(state.pending_chrome_requests.is_empty());
        assert_eq!(state.next_chrome_id, 1);
    }

    #[test]
    fn interleaved_requests_return_to_the_originating_clients() {
        let (client_one_writer, mut client_one_reader) = UnixStream::pair().unwrap();
        let (client_two_writer, mut client_two_reader) = UnixStream::pair().unwrap();
        let (mut host_state, chrome_output) = test_host_state_with_output();
        host_state
            .clients
            .insert(1, queued_test_client(client_one_writer));
        host_state
            .clients
            .insert(2, queued_test_client(client_two_writer));
        let state = Arc::new(Mutex::new(host_state));

        handle_client_message(
            &state,
            1,
            json!({
                "jsonrpc": "2.0",
                "id": "client-one-request",
                "method": "getTabs",
                "params": {
                    "session_id": "session-one",
                    "turn_id": "turn-one"
                }
            }),
        );
        handle_client_message(
            &state,
            2,
            json!({
                "jsonrpc": "2.0",
                "id": "client-two-request",
                "method": "getTabs",
                "params": {
                    "session_id": "session-two",
                    "turn_id": "turn-two"
                }
            }),
        );

        let forwarded = read_captured_messages(&chrome_output);
        assert_eq!(forwarded.len(), 2);
        let first_chrome_id = forwarded[0]["id"].clone();
        let second_chrome_id = forwarded[1]["id"].clone();
        assert_eq!(forwarded[0]["params"]["session_id"], "session-one");
        assert_eq!(forwarded[1]["params"]["session_id"], "session-two");

        handle_chrome_message(
            &state,
            json!({ "jsonrpc": "2.0", "id": second_chrome_id, "result": "two" }),
        );
        handle_chrome_message(
            &state,
            json!({ "jsonrpc": "2.0", "id": first_chrome_id, "result": "one" }),
        );

        assert_eq!(
            read_frame(&mut client_one_reader).unwrap().unwrap(),
            json!({ "jsonrpc": "2.0", "id": "client-one-request", "result": "one" })
        );
        assert_eq!(
            read_frame(&mut client_two_reader).unwrap().unwrap(),
            json!({ "jsonrpc": "2.0", "id": "client-two-request", "result": "two" })
        );
        let state = state.lock().unwrap();
        assert_eq!(state.session_owners.get("session-one"), Some(&1));
        assert_eq!(state.session_owners.get("session-two"), Some(&2));
        assert!(state.pending_chrome_requests.is_empty());
    }

    #[test]
    fn session_scoped_chrome_messages_route_to_the_owning_client() {
        let (client_one_writer, client_one_reader) = UnixStream::pair().unwrap();
        let (client_two_writer, mut client_two_reader) = UnixStream::pair().unwrap();
        client_one_reader.set_nonblocking(true).unwrap();
        let mut host_state = test_host_state();
        host_state
            .clients
            .insert(1, queued_test_client(client_one_writer));
        host_state
            .clients
            .insert(2, queued_test_client(client_two_writer));
        host_state
            .session_owners
            .insert("session-two".to_string(), 2);
        let state = Arc::new(Mutex::new(host_state));
        let notification = json!({
            "jsonrpc": "2.0",
            "method": "onPageEvent",
            "params": {
                "session_id": "session-two",
                "type": "navigation"
            }
        });

        handle_chrome_message(&state, notification.clone());

        assert_eq!(
            read_frame(&mut client_two_reader).unwrap().unwrap(),
            notification
        );
        let mut client_one_reader = client_one_reader;
        assert_eq!(
            read_frame(&mut client_one_reader).unwrap_err().kind(),
            ErrorKind::WouldBlock
        );
    }

    #[test]
    fn unscoped_chrome_notifications_are_broadcast_to_all_clients() {
        let (client_one_writer, mut client_one_reader) = UnixStream::pair().unwrap();
        let (client_two_writer, mut client_two_reader) = UnixStream::pair().unwrap();
        let mut host_state = test_host_state();
        host_state
            .clients
            .insert(1, queued_test_client(client_one_writer));
        host_state
            .clients
            .insert(2, queued_test_client(client_two_writer));
        let state = Arc::new(Mutex::new(host_state));
        let notification = json!({
            "jsonrpc": "2.0",
            "method": "onCDPEvent",
            "params": {
                "source": { "tabId": 42 },
                "method": "Runtime.consoleAPICalled"
            }
        });

        handle_chrome_message(&state, notification.clone());

        assert_eq!(
            read_frame(&mut client_one_reader).unwrap().unwrap(),
            notification
        );
        assert_eq!(
            read_frame(&mut client_two_reader).unwrap().unwrap(),
            notification
        );
    }

    #[test]
    fn session_scoped_chrome_request_returns_through_the_owning_client() {
        let (client_one_writer, client_one_reader) = UnixStream::pair().unwrap();
        let (client_two_writer, mut client_two_reader) = UnixStream::pair().unwrap();
        client_one_reader.set_nonblocking(true).unwrap();
        let (mut host_state, chrome_output) = test_host_state_with_output();
        host_state
            .clients
            .insert(1, queued_test_client(client_one_writer));
        host_state
            .clients
            .insert(2, queued_test_client(client_two_writer));
        host_state
            .session_owners
            .insert("session-two".to_string(), 2);
        let state = Arc::new(Mutex::new(host_state));

        handle_chrome_message(
            &state,
            json!({
                "jsonrpc": "2.0",
                "id": "chrome-session-request",
                "method": "sessionCommand",
                "params": { "session_id": "session-two" }
            }),
        );

        let forwarded = read_frame(&mut client_two_reader).unwrap().unwrap();
        assert_eq!(forwarded["method"], "sessionCommand");
        let forwarded_id = forwarded["id"].clone();
        handle_client_message(
            &state,
            2,
            json!({ "jsonrpc": "2.0", "id": forwarded_id, "result": "done" }),
        );

        assert_eq!(
            read_captured_message(&chrome_output),
            json!({
                "jsonrpc": "2.0",
                "id": "chrome-session-request",
                "result": "done"
            })
        );
        let mut client_one_reader = client_one_reader;
        assert_eq!(
            read_frame(&mut client_one_reader).unwrap_err().kind(),
            ErrorKind::WouldBlock
        );
        assert!(state.lock().unwrap().pending_client_requests.is_empty());
    }

    #[test]
    fn chrome_heartbeat_uses_the_first_healthy_client_response() {
        let (client_one_writer, mut client_one_reader) = UnixStream::pair().unwrap();
        let (client_two_writer, mut client_two_reader) = UnixStream::pair().unwrap();
        let (mut host_state, chrome_output) = test_host_state_with_output();
        host_state
            .clients
            .insert(1, queued_test_client(client_one_writer));
        host_state
            .clients
            .insert(2, queued_test_client(client_two_writer));
        let state = Arc::new(Mutex::new(host_state));

        handle_chrome_message(
            &state,
            json!({ "jsonrpc": "2.0", "id": "heartbeat", "method": "ping" }),
        );

        let client_one_request = read_frame(&mut client_one_reader).unwrap().unwrap();
        let client_two_request = read_frame(&mut client_two_reader).unwrap().unwrap();
        assert_eq!(client_one_request["method"], "ping");
        assert_eq!(client_two_request["method"], "ping");
        handle_client_message(
            &state,
            2,
            json!({ "jsonrpc": "2.0", "id": client_two_request["id"], "result": "pong" }),
        );

        assert_eq!(
            read_captured_message(&chrome_output),
            json!({ "jsonrpc": "2.0", "id": "heartbeat", "result": "pong" })
        );
        handle_client_message(
            &state,
            1,
            json!({ "jsonrpc": "2.0", "id": client_one_request["id"], "result": "late" }),
        );
        assert_eq!(read_captured_messages(&chrome_output).len(), 1);
        let state = state.lock().unwrap();
        assert_eq!(state.clients.len(), 2);
        assert!(state.pending_client_requests.is_empty());
    }

    #[test]
    fn chrome_heartbeat_waits_for_a_healthy_response_after_invalid_responses() {
        let (client_one_writer, mut client_one_reader) = UnixStream::pair().unwrap();
        let (client_two_writer, mut client_two_reader) = UnixStream::pair().unwrap();
        let (client_three_writer, mut client_three_reader) = UnixStream::pair().unwrap();
        let (mut host_state, chrome_output) = test_host_state_with_output();
        host_state
            .clients
            .insert(1, queued_test_client(client_one_writer));
        host_state
            .clients
            .insert(2, queued_test_client(client_two_writer));
        host_state
            .clients
            .insert(3, queued_test_client(client_three_writer));
        let state = Arc::new(Mutex::new(host_state));

        handle_chrome_message(
            &state,
            json!({ "jsonrpc": "2.0", "id": "heartbeat", "method": "ping" }),
        );

        let client_one_request = read_frame(&mut client_one_reader).unwrap().unwrap();
        let client_two_request = read_frame(&mut client_two_reader).unwrap().unwrap();
        let client_three_request = read_frame(&mut client_three_reader).unwrap().unwrap();

        handle_client_message(
            &state,
            1,
            json!({
                "jsonrpc": "2.0",
                "id": client_one_request["id"],
                "error": { "code": -32000, "message": "not ready" }
            }),
        );
        assert!(chrome_output.lock().unwrap().is_empty());
        assert_eq!(state.lock().unwrap().pending_client_requests.len(), 2);

        handle_client_message(
            &state,
            2,
            json!({
                "id": client_two_request["id"],
                "result": "unexpected"
            }),
        );
        assert!(chrome_output.lock().unwrap().is_empty());
        assert_eq!(state.lock().unwrap().pending_client_requests.len(), 1);

        handle_client_message(
            &state,
            3,
            json!({
                "jsonrpc": "2.0",
                "id": client_three_request["id"],
                "result": "pong"
            }),
        );

        assert_eq!(
            read_captured_message(&chrome_output),
            json!({ "jsonrpc": "2.0", "id": "heartbeat", "result": "pong" })
        );
        let state = state.lock().unwrap();
        assert_eq!(state.clients.len(), 3);
        assert!(state.pending_client_requests.is_empty());
    }

    #[test]
    fn ambiguous_unscoped_chrome_request_fails_without_evicting_clients() {
        let (mut host_state, chrome_output) = test_host_state_with_output();
        host_state.clients.insert(1, test_client());
        host_state.clients.insert(2, test_client());
        let state = Arc::new(Mutex::new(host_state));

        handle_chrome_message(
            &state,
            json!({ "jsonrpc": "2.0", "id": "ambiguous", "method": "browserCommand" }),
        );

        let response = read_captured_message(&chrome_output);
        assert_eq!(response["id"], "ambiguous");
        assert_eq!(response["error"]["code"], -32000);
        let state = state.lock().unwrap();
        assert_eq!(state.clients.len(), 2);
        assert!(state.pending_client_requests.is_empty());
    }

    #[test]
    fn forwards_client_raw_cdp_call_requests_to_chrome_without_filtering() {
        let (mut host_state, output) = test_host_state_with_output();
        host_state.clients.insert(1, test_client());
        let state = Arc::new(Mutex::new(host_state));
        let request = json!({
            "jsonrpc": "2.0",
            "id": "client-cdp-call-1",
            "method": "tab_cdp_call",
            "params": {
                "browser_id": "browser-1",
                "tab_id": "42",
                "method": "Runtime.evaluate",
                "params": {
                    "expression": "document.title",
                    "returnByValue": true
                },
                "target": {
                    "target_id": "target-1"
                },
                "timeout_ms": 5000
            }
        });

        handle_client_message(&state, 1, request.clone());

        let chrome_id = format!("linux-{}-1", process::id());
        let forwarded = read_captured_message(&output);
        assert_eq!(forwarded["id"], chrome_id);
        assert_eq!(forwarded["method"], "tab_cdp_call");
        assert_eq!(forwarded["params"], request["params"]);

        let state = state.lock().unwrap();
        let pending = state.pending_chrome_requests.get(&chrome_id).unwrap();
        assert_eq!(pending.client_id, 1);
        assert_eq!(pending.client_request_id, json!("client-cdp-call-1"));
        assert!(!pending.fallback_extension_info);
    }

    #[test]
    fn forwards_client_raw_cdp_event_requests_to_chrome_without_filtering() {
        let (mut host_state, output) = test_host_state_with_output();
        host_state.clients.insert(1, test_client());
        let state = Arc::new(Mutex::new(host_state));
        let request = json!({
            "jsonrpc": "2.0",
            "id": "client-cdp-events-1",
            "method": "tab_cdp_events",
            "params": {
                "after_sequence": 7,
                "browser_id": "browser-1",
                "limit": 25,
                "methods": ["Runtime.consoleAPICalled", "Target.attachedToTarget"],
                "tab_id": "42",
                "target": {
                    "session_id": "session-1"
                },
                "timeout_ms": 500
            }
        });

        handle_client_message(&state, 1, request.clone());

        let forwarded = read_captured_message(&output);
        assert_eq!(forwarded["id"], format!("linux-{}-1", process::id()));
        assert_eq!(forwarded["method"], "tab_cdp_events");
        assert_eq!(forwarded["params"], request["params"]);
    }

    #[test]
    fn forwards_chrome_raw_cdp_responses_to_the_requesting_client() {
        let (client_writer, mut client_reader) = UnixStream::pair().unwrap();
        let mut state = test_host_state();
        state.clients.insert(1, queued_test_client(client_writer));
        state.pending_chrome_requests.insert(
            "linux-1-1".to_string(),
            PendingChromeRequest {
                client_id: 1,
                client_request_id: json!("client-cdp-call-1"),
                fallback_extension_info: false,
                created_at: Instant::now(),
            },
        );
        let state = Arc::new(Mutex::new(state));

        handle_chrome_message(
            &state,
            json!({
                "jsonrpc": "2.0",
                "id": "linux-1-1",
                "result": {
                    "result": {
                        "type": "string",
                        "value": "Codex"
                    }
                }
            }),
        );

        let message = read_frame(&mut client_reader).unwrap().unwrap();
        assert_eq!(message["id"], "client-cdp-call-1");
        assert_eq!(message["result"]["result"]["value"], "Codex");
        assert!(state.lock().unwrap().pending_chrome_requests.is_empty());
    }

    #[test]
    fn get_info_falls_back_when_runtime_get_version_is_missing() {
        let (client_writer, mut client_reader) = UnixStream::pair().unwrap();
        let mut state = test_host_state();
        state.clients.insert(1, queued_test_client(client_writer));
        state.pending_chrome_requests.insert(
            "linux-1-1".to_string(),
            PendingChromeRequest {
                client_id: 1,
                client_request_id: json!("info-1"),
                fallback_extension_info: true,
                created_at: Instant::now(),
            },
        );
        state.extension_id = Some("abcdefghijklmnopabcdefghijklmnop".to_string());
        let state = Arc::new(Mutex::new(state));

        handle_chrome_message(
            &state,
            json!({
                "jsonrpc": "2.0",
                "id": "linux-1-1",
                "error": {
                    "code": 1,
                    "message": "chrome.runtime.getVersion is not a function"
                }
            }),
        );

        let message = read_frame(&mut client_reader).unwrap().unwrap();
        assert_eq!(message["id"], "info-1");
        assert_eq!(message["result"]["type"], "extension");
        assert_eq!(message["result"]["version"], "unknown");
        assert_eq!(
            message["result"]["metadata"]["extensionId"],
            "abcdefghijklmnopabcdefghijklmnop"
        );
        assert!(state.lock().unwrap().pending_chrome_requests.is_empty());
    }

    #[test]
    fn pruning_removes_expired_requests_and_keeps_live_correlations() {
        let now = Instant::now();
        let expired_at = now - PENDING_REQUEST_TTL - Duration::from_secs(1);
        let mut state = test_host_state();
        state.pending_chrome_requests.insert(
            "expired-chrome".to_string(),
            PendingChromeRequest {
                client_id: 1,
                client_request_id: json!("expired-client-id"),
                fallback_extension_info: false,
                created_at: expired_at,
            },
        );
        state.pending_chrome_requests.insert(
            "live-chrome".to_string(),
            PendingChromeRequest {
                client_id: 2,
                client_request_id: json!("live-client-id"),
                fallback_extension_info: true,
                created_at: now,
            },
        );
        state.pending_client_requests.insert(
            "expired-client".to_string(),
            PendingClientRequest {
                client_id: 3,
                chrome_request_id: json!("expired-chrome-id"),
                fanout_group: None,
                created_at: expired_at,
            },
        );
        state.pending_client_requests.insert(
            "live-client".to_string(),
            PendingClientRequest {
                client_id: 4,
                chrome_request_id: json!("live-chrome-id"),
                fanout_group: None,
                created_at: now,
            },
        );

        state.prune_expired_pending_requests(now);

        assert!(!state.pending_chrome_requests.contains_key("expired-chrome"));
        let live_chrome = &state.pending_chrome_requests["live-chrome"];
        assert_eq!(live_chrome.client_id, 2);
        assert_eq!(live_chrome.client_request_id, json!("live-client-id"));
        assert!(live_chrome.fallback_extension_info);
        assert!(!state.pending_client_requests.contains_key("expired-client"));
        let live_client = &state.pending_client_requests["live-client"];
        assert_eq!(live_client.client_id, 4);
        assert_eq!(live_client.chrome_request_id, json!("live-chrome-id"));
    }

    #[test]
    fn pending_request_ids_accept_only_bounded_json_rpc_scalars() {
        let max_string = "x".repeat(MAX_PENDING_REQUEST_ID_STRING_BYTES);
        assert_eq!(
            bounded_pending_request_id(&json!({ "id": max_string })).unwrap(),
            Value::String("x".repeat(MAX_PENDING_REQUEST_ID_STRING_BYTES))
        );
        assert_eq!(
            bounded_pending_request_id(&json!({ "id": 42 })).unwrap(),
            json!(42)
        );
        assert_eq!(
            bounded_pending_request_id(&json!({ "id": null })).unwrap(),
            Value::Null
        );
        assert!(bounded_pending_request_id(&json!({
            "id": "x".repeat(MAX_PENDING_REQUEST_ID_STRING_BYTES + 1)
        }))
        .is_err());
        assert!(bounded_pending_request_id(&json!({ "id": { "nested": true } })).is_err());
    }

    #[test]
    fn oversized_client_request_id_is_rejected_without_retention() {
        let (client_writer, mut client_reader) = UnixStream::pair().unwrap();
        let (mut state, chrome_output) = test_host_state_with_output();
        state.clients.insert(1, queued_test_client(client_writer));
        let state = Arc::new(Mutex::new(state));

        handle_client_message(
            &state,
            1,
            json!({
                "jsonrpc": "2.0",
                "id": "x".repeat(MAX_PENDING_REQUEST_ID_STRING_BYTES + 1),
                "method": "getTabs"
            }),
        );

        let response = read_frame(&mut client_reader).unwrap().unwrap();
        assert_eq!(response["id"], Value::Null);
        assert_eq!(response["error"]["code"], INVALID_REQUEST_ERROR_CODE);
        assert!(chrome_output.lock().unwrap().is_empty());
        assert!(state.lock().unwrap().pending_chrome_requests.is_empty());
    }

    #[test]
    fn oversized_chrome_request_id_is_rejected_without_retention() {
        let (mut state, chrome_output) = test_host_state_with_output();
        state.clients.insert(1, test_client());
        let state = Arc::new(Mutex::new(state));

        handle_chrome_message(
            &state,
            json!({
                "jsonrpc": "2.0",
                "id": "x".repeat(MAX_PENDING_REQUEST_ID_STRING_BYTES + 1),
                "method": "browserCommand"
            }),
        );

        let response = read_captured_message(&chrome_output);
        assert_eq!(response["id"], Value::Null);
        assert_eq!(response["error"]["code"], INVALID_REQUEST_ERROR_CODE);
        assert!(state.lock().unwrap().pending_client_requests.is_empty());
    }

    #[test]
    fn client_writer_byte_limit_does_not_block_another_client() {
        let first_message = json!({ "jsonrpc": "2.0", "method": "fill-byte-budget" });
        let first_frame = serialize_frame(&first_message).unwrap();
        let (stalled_sender, stalled_receiver) = sync_channel(CLIENT_WRITE_QUEUE_MAX_MESSAGES);
        let stalled_queued_bytes = Arc::new(AtomicUsize::new(0));
        let (stalled_shutdown, _stalled_peer) = UnixStream::pair().unwrap();

        let (healthy_sender, healthy_receiver) = sync_channel(CLIENT_WRITE_QUEUE_MAX_MESSAGES);
        let healthy_queued_bytes = Arc::new(AtomicUsize::new(0));
        let (healthy_shutdown, _healthy_peer) = UnixStream::pair().unwrap();
        let mut state = test_host_state();
        state.clients.insert(
            1,
            Client::with_max_queued_bytes(
                stalled_sender,
                Arc::clone(&stalled_queued_bytes),
                first_frame.len(),
                stalled_shutdown,
            ),
        );
        state.clients.insert(
            2,
            Client::new(
                healthy_sender,
                Arc::clone(&healthy_queued_bytes),
                healthy_shutdown,
            ),
        );
        assert!(state.send_client(1, &first_message));
        assert_eq!(
            stalled_queued_bytes.load(Ordering::Acquire),
            first_frame.len()
        );

        let message = json!({ "jsonrpc": "2.0", "method": "healthy" });

        state.broadcast_clients(&message);

        let healthy_frame = healthy_receiver
            .recv_timeout(Duration::from_secs(1))
            .unwrap();
        assert_eq!(
            healthy_frame.bytes.as_ref(),
            serialize_frame(&message).unwrap().as_ref()
        );
        let stalled_frame = stalled_receiver
            .recv_timeout(Duration::from_secs(1))
            .unwrap();
        assert_eq!(stalled_frame.bytes.as_ref(), first_frame.as_ref());
        assert!(!state.clients.contains_key(&1));
        assert!(state.clients.contains_key(&2));

        drop(stalled_frame);
        drop(healthy_frame);
        assert_eq!(stalled_queued_bytes.load(Ordering::Acquire), 0);
        assert_eq!(healthy_queued_bytes.load(Ordering::Acquire), 0);
    }

    #[test]
    fn full_client_writer_message_queue_does_not_block_another_client() {
        let (stalled_sender, stalled_receiver) = sync_channel(CLIENT_WRITE_QUEUE_MAX_MESSAGES);
        let stalled_queued_bytes = Arc::new(AtomicUsize::new(0));
        let (stalled_shutdown, _stalled_peer) = UnixStream::pair().unwrap();
        let (healthy_sender, healthy_receiver) = sync_channel(CLIENT_WRITE_QUEUE_MAX_MESSAGES);
        let healthy_queued_bytes = Arc::new(AtomicUsize::new(0));
        let (healthy_shutdown, _healthy_peer) = UnixStream::pair().unwrap();
        let mut state = test_host_state();
        state.clients.insert(
            1,
            Client::new(
                stalled_sender,
                Arc::clone(&stalled_queued_bytes),
                stalled_shutdown,
            ),
        );
        state.clients.insert(
            2,
            Client::new(
                healthy_sender,
                Arc::clone(&healthy_queued_bytes),
                healthy_shutdown,
            ),
        );
        for index in 0..CLIENT_WRITE_QUEUE_MAX_MESSAGES {
            assert!(state.send_client(1, &json!(index)));
        }

        let message = json!({ "jsonrpc": "2.0", "method": "healthy" });
        assert!(!state.send_client(1, &message));
        assert!(state.send_client(2, &message));

        let healthy_frame = healthy_receiver
            .recv_timeout(Duration::from_secs(1))
            .unwrap();
        assert_eq!(
            healthy_frame.bytes.as_ref(),
            serialize_frame(&message).unwrap().as_ref()
        );
        assert_eq!(
            stalled_receiver.try_iter().count(),
            CLIENT_WRITE_QUEUE_MAX_MESSAGES
        );
        assert!(!state.clients.contains_key(&1));
        assert!(state.clients.contains_key(&2));

        drop(healthy_frame);
        assert_eq!(stalled_queued_bytes.load(Ordering::Acquire), 0);
        assert_eq!(healthy_queued_bytes.load(Ordering::Acquire), 0);
    }

    #[test]
    fn broadcast_reuses_one_serialized_frame_for_all_clients() {
        let (client_one_sender, client_one_receiver) =
            sync_channel(CLIENT_WRITE_QUEUE_MAX_MESSAGES);
        let client_one_queued_bytes = Arc::new(AtomicUsize::new(0));
        let (client_one_shutdown, _client_one_peer) = UnixStream::pair().unwrap();
        let (client_two_sender, client_two_receiver) =
            sync_channel(CLIENT_WRITE_QUEUE_MAX_MESSAGES);
        let client_two_queued_bytes = Arc::new(AtomicUsize::new(0));
        let (client_two_shutdown, _client_two_peer) = UnixStream::pair().unwrap();
        let mut state = test_host_state();
        state.clients.insert(
            1,
            Client::new(
                client_one_sender,
                Arc::clone(&client_one_queued_bytes),
                client_one_shutdown,
            ),
        );
        state.clients.insert(
            2,
            Client::new(
                client_two_sender,
                Arc::clone(&client_two_queued_bytes),
                client_two_shutdown,
            ),
        );
        let message = json!({ "jsonrpc": "2.0", "method": "shared" });

        state.broadcast_clients(&message);

        let client_one_frame = client_one_receiver
            .recv_timeout(Duration::from_secs(1))
            .unwrap();
        let client_two_frame = client_two_receiver
            .recv_timeout(Duration::from_secs(1))
            .unwrap();
        assert!(Arc::ptr_eq(
            &client_one_frame.bytes,
            &client_two_frame.bytes
        ));
        assert_eq!(
            client_one_frame.bytes.as_ref(),
            serialize_frame(&message).unwrap().as_ref()
        );
        assert_eq!(
            client_one_queued_bytes.load(Ordering::Acquire),
            client_one_frame.bytes.len()
        );
        assert_eq!(
            client_two_queued_bytes.load(Ordering::Acquire),
            client_two_frame.bytes.len()
        );

        drop(client_one_frame);
        drop(client_two_frame);
        assert_eq!(client_one_queued_bytes.load(Ordering::Acquire), 0);
        assert_eq!(client_two_queued_bytes.load(Ordering::Acquire), 0);
    }

    #[test]
    fn stalled_client_cannot_exhaust_chrome_request_capacity_for_another_client() {
        let (client_two_writer, _client_two_reader) = UnixStream::pair().unwrap();
        let (mut state, chrome_output) = test_host_state_with_output();
        state.clients.insert(1, test_client());
        state
            .clients
            .insert(2, queued_test_client(client_two_writer));
        let now = Instant::now();
        for index in 0..MAX_PENDING_REQUESTS_PER_CLIENT_PER_DIRECTION {
            state.pending_chrome_requests.insert(
                format!("stalled-{index}"),
                PendingChromeRequest {
                    client_id: 1,
                    client_request_id: json!(index),
                    fallback_extension_info: false,
                    created_at: now,
                },
            );
        }
        let state = Arc::new(Mutex::new(state));

        handle_client_message(
            &state,
            2,
            json!({ "jsonrpc": "2.0", "id": "healthy", "method": "getTabs" }),
        );

        let forwarded = read_captured_message(&chrome_output);
        assert_eq!(forwarded["method"], "getTabs");
        assert_eq!(state.lock().unwrap().pending_chrome_request_count(2), 1);
    }

    #[test]
    fn stalled_client_cannot_exhaust_client_request_capacity_for_another_client() {
        let (client_two_writer, mut client_two_reader) = UnixStream::pair().unwrap();
        let (mut state, _chrome_output) = test_host_state_with_output();
        state.clients.insert(1, test_client());
        state
            .clients
            .insert(2, queued_test_client(client_two_writer));
        state
            .session_owners
            .insert("healthy-session".to_string(), 2);
        let now = Instant::now();
        for index in 0..MAX_PENDING_REQUESTS_PER_CLIENT_PER_DIRECTION {
            state.pending_client_requests.insert(
                format!("stalled-{index}"),
                PendingClientRequest {
                    client_id: 1,
                    chrome_request_id: json!(index),
                    fanout_group: None,
                    created_at: now,
                },
            );
        }
        let state = Arc::new(Mutex::new(state));

        handle_chrome_message(
            &state,
            json!({
                "jsonrpc": "2.0",
                "id": "healthy",
                "method": "sessionCommand",
                "params": { "session_id": "healthy-session" }
            }),
        );

        let forwarded = read_frame(&mut client_two_reader).unwrap().unwrap();
        assert_eq!(forwarded["method"], "sessionCommand");
        assert_eq!(state.lock().unwrap().pending_client_request_count(2), 1);
    }

    #[test]
    fn client_to_chrome_per_client_limit_returns_correlated_error() {
        let (client_writer, mut client_reader) = UnixStream::pair().unwrap();
        let (mut state, chrome_output) = test_host_state_with_output();
        state.clients.insert(1, queued_test_client(client_writer));
        let now = Instant::now();
        for index in 0..MAX_PENDING_REQUESTS_PER_CLIENT_PER_DIRECTION {
            state.pending_chrome_requests.insert(
                format!("pending-{index}"),
                PendingChromeRequest {
                    client_id: 1,
                    client_request_id: json!(index),
                    fallback_extension_info: false,
                    created_at: now,
                },
            );
        }
        let state = Arc::new(Mutex::new(state));

        handle_client_message(
            &state,
            1,
            json!({ "jsonrpc": "2.0", "id": "over-cap", "method": "getTabs" }),
        );

        let response = read_frame(&mut client_reader).unwrap().unwrap();
        assert_eq!(response["id"], "over-cap");
        assert_eq!(response["error"]["code"], PENDING_REQUEST_LIMIT_ERROR_CODE);
        assert!(chrome_output.lock().unwrap().is_empty());
        let state = state.lock().unwrap();
        assert_eq!(
            state.pending_chrome_requests.len(),
            MAX_PENDING_REQUESTS_PER_CLIENT_PER_DIRECTION
        );
        assert_eq!(state.next_chrome_id, 1);
    }

    #[test]
    fn client_to_chrome_global_limit_returns_correlated_error() {
        let (client_writer, mut client_reader) = UnixStream::pair().unwrap();
        let (mut state, chrome_output) = test_host_state_with_output();
        for client_id in 1..=4 {
            state.clients.insert(client_id, test_client());
        }
        state.clients.insert(5, queued_test_client(client_writer));
        let now = Instant::now();
        for index in 0..MAX_PENDING_REQUESTS_PER_DIRECTION {
            let client_id = index / MAX_PENDING_REQUESTS_PER_CLIENT_PER_DIRECTION + 1;
            state.pending_chrome_requests.insert(
                format!("pending-{index}"),
                PendingChromeRequest {
                    client_id,
                    client_request_id: json!(index),
                    fallback_extension_info: false,
                    created_at: now,
                },
            );
        }
        let state = Arc::new(Mutex::new(state));

        handle_client_message(
            &state,
            5,
            json!({ "jsonrpc": "2.0", "id": "global-over-cap", "method": "getTabs" }),
        );

        let response = read_frame(&mut client_reader).unwrap().unwrap();
        assert_eq!(response["id"], "global-over-cap");
        assert_eq!(response["error"]["code"], PENDING_REQUEST_LIMIT_ERROR_CODE);
        assert!(chrome_output.lock().unwrap().is_empty());
        let state = state.lock().unwrap();
        assert_eq!(
            state.pending_chrome_requests.len(),
            MAX_PENDING_REQUESTS_PER_DIRECTION
        );
        assert_eq!(state.pending_chrome_request_count(5), 0);
        assert_eq!(state.next_chrome_id, 1);
    }

    #[test]
    fn chrome_to_client_per_client_limit_returns_correlated_error() {
        let (mut state, chrome_output) = test_host_state_with_output();
        state.clients.insert(1, test_client());
        let now = Instant::now();
        for index in 0..MAX_PENDING_REQUESTS_PER_CLIENT_PER_DIRECTION {
            state.pending_client_requests.insert(
                format!("pending-{index}"),
                PendingClientRequest {
                    client_id: 1,
                    chrome_request_id: json!(index),
                    fanout_group: None,
                    created_at: now,
                },
            );
        }
        let state = Arc::new(Mutex::new(state));

        handle_chrome_message(
            &state,
            json!({ "jsonrpc": "2.0", "id": "chrome-over-cap", "method": "browserCommand" }),
        );

        let response = read_captured_message(&chrome_output);
        assert_eq!(response["id"], "chrome-over-cap");
        assert_eq!(response["error"]["code"], PENDING_REQUEST_LIMIT_ERROR_CODE);
        let state = state.lock().unwrap();
        assert_eq!(
            state.pending_client_requests.len(),
            MAX_PENDING_REQUESTS_PER_CLIENT_PER_DIRECTION
        );
        assert_eq!(state.next_client_request_id, 1);
    }

    #[test]
    fn chrome_to_client_global_limit_returns_correlated_error() {
        let (mut state, chrome_output) = test_host_state_with_output();
        for client_id in 1..=5 {
            state.clients.insert(client_id, test_client());
        }
        state.session_owners.insert("target-session".to_string(), 5);
        let now = Instant::now();
        for index in 0..MAX_PENDING_REQUESTS_PER_DIRECTION {
            let client_id = index / MAX_PENDING_REQUESTS_PER_CLIENT_PER_DIRECTION + 1;
            state.pending_client_requests.insert(
                format!("pending-{index}"),
                PendingClientRequest {
                    client_id,
                    chrome_request_id: json!(index),
                    fanout_group: None,
                    created_at: now,
                },
            );
        }
        let state = Arc::new(Mutex::new(state));

        handle_chrome_message(
            &state,
            json!({
                "jsonrpc": "2.0",
                "id": "chrome-global-over-cap",
                "method": "sessionCommand",
                "params": { "session_id": "target-session" }
            }),
        );

        let response = read_captured_message(&chrome_output);
        assert_eq!(response["id"], "chrome-global-over-cap");
        assert_eq!(response["error"]["code"], PENDING_REQUEST_LIMIT_ERROR_CODE);
        let state = state.lock().unwrap();
        assert_eq!(
            state.pending_client_requests.len(),
            MAX_PENDING_REQUESTS_PER_DIRECTION
        );
        assert_eq!(state.pending_client_request_count(5), 0);
        assert_eq!(state.next_client_request_id, 1);
    }

    #[test]
    fn disconnect_cleanup_removes_pending_state_for_client() {
        let mut pending_chrome = HashMap::from([
            (
                "keep".to_string(),
                PendingChromeRequest {
                    client_id: 1,
                    client_request_id: json!("chrome-request-1"),
                    fallback_extension_info: false,
                    created_at: Instant::now(),
                },
            ),
            (
                "drop".to_string(),
                PendingChromeRequest {
                    client_id: 2,
                    client_request_id: json!("chrome-request-2"),
                    fallback_extension_info: false,
                    created_at: Instant::now(),
                },
            ),
        ]);
        let mut pending_client = HashMap::from([
            (
                "keep".to_string(),
                PendingClientRequest {
                    client_id: 1,
                    chrome_request_id: json!("client-request-1"),
                    fanout_group: None,
                    created_at: Instant::now(),
                },
            ),
            (
                "drop".to_string(),
                PendingClientRequest {
                    client_id: 2,
                    chrome_request_id: json!("client-request-2"),
                    fanout_group: None,
                    created_at: Instant::now(),
                },
            ),
        ]);

        remove_pending_requests_for_client(&mut pending_chrome, &mut pending_client, 2);

        assert!(pending_chrome.contains_key("keep"));
        assert!(!pending_chrome.contains_key("drop"));
        assert!(pending_client.contains_key("keep"));
        assert!(!pending_client.contains_key("drop"));
    }

    #[test]
    fn disconnect_cleanup_preserves_other_clients_and_session_routes() {
        let mut state = test_host_state();
        state.clients.insert(1, test_client());
        state.clients.insert(2, test_client());
        state.session_owners.insert("session-one".to_string(), 1);
        state.session_owners.insert("session-two".to_string(), 2);
        state.pending_chrome_requests.insert(
            "drop".to_string(),
            PendingChromeRequest {
                client_id: 1,
                client_request_id: json!("client-request"),
                fallback_extension_info: false,
                created_at: Instant::now(),
            },
        );

        state.remove_client(1);

        assert!(!state.clients.contains_key(&1));
        assert!(state.clients.contains_key(&2));
        assert!(!state.session_owners.contains_key("session-one"));
        assert_eq!(state.session_owners.get("session-two"), Some(&2));
        assert!(state.pending_chrome_requests.is_empty());
    }

    fn test_client() -> Client {
        let (stream, _peer) = UnixStream::pair().unwrap();
        queued_test_client(stream)
    }

    fn queued_test_client(mut stream: UnixStream) -> Client {
        let shutdown = stream.try_clone().unwrap();
        let (sender, receiver) = sync_channel::<QueuedClientFrame>(CLIENT_WRITE_QUEUE_MAX_MESSAGES);
        let queued_bytes = Arc::new(AtomicUsize::new(0));
        thread::spawn(move || {
            while let Ok(frame) = receiver.recv() {
                if write_serialized_frame(&mut stream, &frame.bytes).is_err() {
                    break;
                }
            }
        });
        Client::new(sender, queued_bytes, shutdown)
    }

    fn test_host_state() -> HostState {
        let stdout: SharedChromeWriter = Arc::new(Mutex::new(Box::new(io::stdout())));
        HostState::new(
            Arc::clone(&stdout),
            RolloutTracker {
                inner: Arc::new(Mutex::new(RolloutTrackerState {
                    observed: HashMap::new(),
                })),
                stdout,
                sessions_root: None,
            },
            Some("abcdefghijklmnopabcdefghijklmnop".to_string()),
            Arc::new(RuntimeManager::new(Some(
                "abcdefghijklmnopabcdefghijklmnop".to_string(),
            ))),
        )
    }

    fn test_host_state_with_output() -> (HostState, Arc<Mutex<Vec<u8>>>) {
        let output = Arc::new(Mutex::new(Vec::new()));
        let stdout: SharedChromeWriter = Arc::new(Mutex::new(Box::new(CaptureWriter {
            output: Arc::clone(&output),
        })));
        let state = HostState::new(
            Arc::clone(&stdout),
            RolloutTracker {
                inner: Arc::new(Mutex::new(RolloutTrackerState {
                    observed: HashMap::new(),
                })),
                stdout,
                sessions_root: None,
            },
            Some("abcdefghijklmnopabcdefghijklmnop".to_string()),
            Arc::new(RuntimeManager::new(Some(
                "abcdefghijklmnopabcdefghijklmnop".to_string(),
            ))),
        );
        (state, output)
    }

    fn read_captured_message(output: &Arc<Mutex<Vec<u8>>>) -> Value {
        read_captured_messages(output)
            .into_iter()
            .next()
            .expect("one captured message")
    }

    fn read_captured_messages(output: &Arc<Mutex<Vec<u8>>>) -> Vec<Value> {
        let data = output.lock().unwrap().clone();
        let mut cursor = io::Cursor::new(data);
        let mut messages = Vec::new();
        while let Some(message) = read_frame(&mut cursor).unwrap() {
            messages.push(message);
        }
        messages
    }

    fn process_is_live(pid: libc::pid_t) -> bool {
        let Ok(stat) = fs::read_to_string(format!("/proc/{pid}/stat")) else {
            return false;
        };
        stat.rsplit_once(')')
            .and_then(|(_, suffix)| suffix.trim_start().chars().next())
            .is_some_and(|state| state != 'Z')
    }

    struct CaptureWriter {
        output: Arc<Mutex<Vec<u8>>>,
    }

    impl Write for CaptureWriter {
        fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
            self.output.lock().unwrap().extend_from_slice(buffer);
            Ok(buffer.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    fn unique_test_dir(prefix: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        env::temp_dir().join(format!("{prefix}-{}-{nonce}", process::id()))
    }
}
