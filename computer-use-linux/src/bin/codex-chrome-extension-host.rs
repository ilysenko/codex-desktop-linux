use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    env, fs,
    fs::File,
    io::{self, BufRead, BufReader, ErrorKind, Read, Seek, SeekFrom, Write},
    net::Shutdown,
    os::unix::{
        fs::{MetadataExt, PermissionsExt},
        io::AsRawFd,
        net::{UnixListener, UnixStream},
    },
    path::{Path, PathBuf},
    process,
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[path = "../chrome_runtime.rs"]
mod chrome_runtime;

use chrome_runtime::RuntimeManager;

const HOST_NAME: &str = "com.openai.codexextension";
const SOCKET_DIR_ENV: &str = "CODEX_BROWSER_USE_SOCKET_DIR";
const SESSIONS_DIR_ENV: &str = "CODEX_BROWSER_USE_SESSIONS_DIR";
const DEFAULT_SOCKET_DIR: &str = "/tmp/codex-browser-use";
const ROLLOUT_POLL_INTERVAL: Duration = Duration::from_millis(500);
const OBSERVED_TURN_TTL: Duration = Duration::from_secs(6 * 60 * 60);
const ROLLOUT_SEARCH_MAX_DEPTH: usize = 5;
/// Chrome permits native-messaging payloads up to 64 MiB from the extension.
const MAX_ACCEPTED_FRAME_BYTES: usize = 64 * 1024 * 1024;
/// Requests older than this can no longer hold correlation state indefinitely.
const PENDING_REQUEST_TTL: Duration = Duration::from_secs(10 * 60);
/// Bounds unanswered correlations independently in each bridge direction.
const MAX_PENDING_REQUESTS_PER_DIRECTION: usize = 1024;
/// Bounds retained string IDs to about 4 MiB per direction at the entry cap.
const MAX_PENDING_REQUEST_ID_STRING_BYTES: usize = 4 * 1024;
const PENDING_REQUEST_LIMIT_ERROR_CODE: i64 = -32001;
const INVALID_REQUEST_ERROR_CODE: i64 = -32600;

type SharedState = Arc<Mutex<HostState>>;
type SharedChromeWriter = Arc<Mutex<Box<dyn Write + Send>>>;
type SharedClientWriter = Arc<Mutex<UnixStream>>;

#[derive(Clone)]
struct Client {
    writer: SharedClientWriter,
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
                "Multiple Codex browser clients are connected; Chrome requests require exactly one"
            }
        }
    }
}

struct HostState {
    stdout: SharedChromeWriter,
    rollout_tracker: RolloutTracker,
    extension_id: Option<String>,
    clients: HashMap<usize, Client>,
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
            pending_chrome_requests: HashMap::new(),
            pending_client_requests: HashMap::new(),
            next_client_id: 1,
            next_chrome_id: 1,
            next_client_request_id: 1,
            runtime_manager,
        }
    }

    fn replace_with_client(&mut self, writer: SharedClientWriter) -> (usize, Vec<(usize, Client)>) {
        let evicted_clients = self.clients.drain().collect::<Vec<_>>();
        if !evicted_clients.is_empty() {
            self.pending_chrome_requests.clear();
            self.pending_client_requests.clear();
        }

        let id = self.next_client_id;
        self.next_client_id += 1;
        self.clients.insert(id, Client { writer });
        (id, evicted_clients)
    }

    fn remove_client(&mut self, client_id: usize) {
        self.clients.remove(&client_id);
        remove_pending_requests_for_client(
            &mut self.pending_chrome_requests,
            &mut self.pending_client_requests,
            client_id,
        );
    }

    fn prune_expired_pending_requests(&mut self, now: Instant) {
        self.pending_chrome_requests.retain(|_, pending| {
            now.saturating_duration_since(pending.created_at) < PENDING_REQUEST_TTL
        });
        self.pending_client_requests.retain(|_, pending| {
            now.saturating_duration_since(pending.created_at) < PENDING_REQUEST_TTL
        });
    }

    fn send_chrome(&self, message: &Value) {
        let mut stdout = self.stdout.lock().expect("stdout mutex poisoned");
        if let Err(error) = write_frame(&mut *stdout, message) {
            log(&format!("native stdout error: {error}"));
            process::exit(1);
        }
    }

    fn send_client(&self, client_id: usize, message: &Value) {
        let Some(client) = self.clients.get(&client_id) else {
            return;
        };

        let mut writer = client.writer.lock().expect("client writer mutex poisoned");
        if let Err(error) = write_frame(&mut *writer, message) {
            log(&format!("client socket write error: {error}"));
        }
    }

    fn broadcast_clients(&self, message: &Value) {
        for client_id in self.clients.keys().copied().collect::<Vec<_>>() {
            self.send_client(client_id, message);
        }
    }
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
    let socket_dir = socket_dir();
    prepare_socket_dir(&socket_dir)?;
    let socket_path = socket_path(&socket_dir);
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

fn socket_dir() -> PathBuf {
    env::var_os(SOCKET_DIR_ENV)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(DEFAULT_SOCKET_DIR))
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

fn socket_path(socket_dir: &Path) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    socket_dir.join(format!("extension-{}-{nonce}.sock", process::id()))
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
            Ok(stream) => Arc::new(Mutex::new(stream)),
            Err(error) => {
                log(&format!("client socket clone error: {error}"));
                continue;
            }
        };

        let (client_id, evicted_clients) = {
            let mut state = state.lock().expect("host state mutex poisoned");
            state.replace_with_client(writer)
        };
        for (evicted_id, evicted_client) in evicted_clients {
            log(&format!(
                "evicting stale browser client {evicted_id} after a newer client connected"
            ));
            close_client_socket(&evicted_client);
        }

        let state = Arc::clone(&state);
        thread::spawn(move || read_client_messages(state, client_id, stream));
    }
}

fn close_client_socket(client: &Client) {
    match client.writer.lock() {
        Ok(writer) => {
            let _ = writer.shutdown(Shutdown::Both);
        }
        Err(error) => log(&format!("client socket close lock error: {error}")),
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
        let state = state.lock().expect("host state mutex poisoned");
        state.send_client(
            client_id,
            &json!({ "jsonrpc": "2.0", "id": id, "result": "pong" }),
        );
        return;
    }

    let client_request_id = match bounded_pending_request_id(&message) {
        Ok(id) => id,
        Err(error) => {
            let state = state.lock().expect("host state mutex poisoned");
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
            state.send_client(
                pending.client_id,
                &extension_info_response(pending.client_request_id, state.extension_id.as_deref()),
            );
            return;
        }

        state.send_client(
            pending.client_id,
            &with_id(message, pending.client_request_id),
        );
        return;
    }

    if !is_request(&message) {
        let state = state.lock().expect("host state mutex poisoned");
        state.broadcast_clients(&message);
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
    let client_id = match select_single_client_id(&state.clients) {
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
            chrome_request_id,
            created_at: Instant::now(),
        },
    );
    state.send_client(
        client_id,
        &with_id(message, Value::String(client_request_id)),
    );
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

fn message_id_as_str(message: &Value) -> Option<&str> {
    message.get("id").and_then(Value::as_str)
}

fn with_id(mut message: Value, id: Value) -> Value {
    if let Value::Object(ref mut object) = message {
        object.insert("id".to_string(), id);
    }
    message
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
    let session_id = non_empty_string(params.get("session_id")?)?;
    let turn_id = non_empty_string(params.get("turn_id")?)?;
    Some((session_id.to_string(), turn_id.to_string()))
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
    let body = serde_json::to_vec(message).map_err(io::Error::other)?;
    if body.len() > u32::MAX as usize {
        return Err(io::Error::new(
            ErrorKind::InvalidInput,
            "message too large for 4-byte length prefix",
        ));
    }

    writer.write_all(&(body.len() as u32).to_ne_bytes())?;
    writer.write_all(&body)?;
    writer.flush()
}

fn log(message: &str) {
    let _ = writeln!(io::stderr(), "[{HOST_NAME}] {message}");
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn replacing_browser_client_evicts_stale_clients_and_pending_requests() {
        let mut state = test_host_state();

        let (first_client_id, evicted_clients) =
            state.replace_with_client(test_client().writer.clone());
        assert!(evicted_clients.is_empty());
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
                created_at: Instant::now(),
            },
        );

        let (second_client_id, evicted_clients) =
            state.replace_with_client(test_client().writer.clone());

        assert_ne!(first_client_id, second_client_id);
        assert_eq!(evicted_clients.len(), 1);
        assert_eq!(evicted_clients[0].0, first_client_id);
        assert!(!state.clients.contains_key(&first_client_id));
        assert!(state.clients.contains_key(&second_client_id));
        assert!(state.pending_chrome_requests.is_empty());
        assert!(state.pending_client_requests.is_empty());
    }

    #[test]
    fn evicted_client_requests_are_ignored() {
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
        state.clients.insert(
            1,
            Client {
                writer: Arc::new(Mutex::new(client_writer)),
            },
        );
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
        state.clients.insert(
            1,
            Client {
                writer: Arc::new(Mutex::new(client_writer)),
            },
        );
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
                created_at: expired_at,
            },
        );
        state.pending_client_requests.insert(
            "live-client".to_string(),
            PendingClientRequest {
                client_id: 4,
                chrome_request_id: json!("live-chrome-id"),
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
        state.clients.insert(
            1,
            Client {
                writer: Arc::new(Mutex::new(client_writer)),
            },
        );
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
    fn full_chrome_request_map_returns_correlated_error_to_client() {
        let (client_writer, mut client_reader) = UnixStream::pair().unwrap();
        let (mut state, chrome_output) = test_host_state_with_output();
        state.clients.insert(
            1,
            Client {
                writer: Arc::new(Mutex::new(client_writer)),
            },
        );
        let now = Instant::now();
        for index in 0..MAX_PENDING_REQUESTS_PER_DIRECTION {
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
            MAX_PENDING_REQUESTS_PER_DIRECTION
        );
        assert_eq!(state.next_chrome_id, 1);
    }

    #[test]
    fn full_client_request_map_returns_correlated_error_to_chrome() {
        let (mut state, chrome_output) = test_host_state_with_output();
        state.clients.insert(1, test_client());
        let now = Instant::now();
        for index in 0..MAX_PENDING_REQUESTS_PER_DIRECTION {
            state.pending_client_requests.insert(
                format!("pending-{index}"),
                PendingClientRequest {
                    client_id: 1,
                    chrome_request_id: json!(index),
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
            MAX_PENDING_REQUESTS_PER_DIRECTION
        );
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
                    created_at: Instant::now(),
                },
            ),
            (
                "drop".to_string(),
                PendingClientRequest {
                    client_id: 2,
                    chrome_request_id: json!("client-request-2"),
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

    fn test_client() -> Client {
        let (stream, _peer) = UnixStream::pair().unwrap();
        Client {
            writer: Arc::new(Mutex::new(stream)),
        }
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
        let data = output.lock().unwrap().clone();
        let mut cursor = io::Cursor::new(data);
        read_frame(&mut cursor).unwrap().unwrap()
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
