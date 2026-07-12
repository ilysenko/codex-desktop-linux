use anyhow::{Context, Result};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, VecDeque},
    env, fs,
    fs::{File, OpenOptions},
    io::{self, BufRead, BufReader, Read, Write},
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener},
    os::unix::{
        ffi::OsStrExt,
        fs::{FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt},
        process::CommandExt,
    },
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Condvar, Mutex, Weak,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::{
    net::{TcpListener as TokioTcpListener, UnixStream as TokioUnixStream},
    sync::{oneshot, Semaphore},
};
use tokio_tungstenite::{
    accept_hdr_async, client_async,
    tungstenite::{
        handshake::server::{Callback, ErrorResponse, Request, Response},
        http::StatusCode,
    },
};

const MANIFEST_SCHEMA_VERSION: u32 = 2;
const NATIVE_HOST_PROTOCOL_VERSION: u32 = 2;
const APP_SERVER_START_TIMEOUT: Duration = Duration::from_secs(10);
const APP_SERVER_STOP_TIMEOUT: Duration = Duration::from_secs(2);
const PROXY_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_APP_SERVER_PROCESSES: usize = 16;
const MAX_PENDING_HANDSHAKES: usize = 32;
const MAX_AUTHENTICATED_CONNECTIONS: usize = 32;
const MAX_ACTIVE_ASSETS: usize = 32;
const MAX_ASSET_BYTES: u64 = 64 * 1024 * 1024;
const MAX_ASSET_CHUNK_BASE64: usize = 64 * 1024;
const MAX_CLIENT_ID_BYTES: usize = 128;
const MAX_UNIX_SOCKET_PATH_BYTES: usize = 107;
const PROCESS_REAPER_INTERVAL: Duration = Duration::from_millis(250);
const UNCONNECTED_PROCESS_TIMEOUT: Duration = Duration::from_secs(15);
const DISCONNECTED_PROCESS_GRACE: Duration = Duration::from_secs(2);
const MANIFEST_FILE_NAME: &str = "chrome-native-hosts-v2.json";
const OPEN_LOCAL_FILE_METHOD: &str = "codexRuntime/openLocalFile";

type RuntimeResult<T> = std::result::Result<T, RuntimeError>;

#[derive(Debug)]
struct RuntimeError {
    code: i64,
    message: String,
    kind: Option<&'static str>,
}

impl RuntimeError {
    fn invalid_params(message: impl Into<String>) -> Self {
        Self {
            code: -32602,
            message: message.into(),
            kind: None,
        }
    }

    fn method_not_found(method: &str) -> Self {
        Self {
            code: -32601,
            message: format!("Unsupported native host method: {method}"),
            kind: None,
        }
    }

    fn typed(kind: &'static str, message: impl Into<String>) -> Self {
        Self {
            code: 1,
            message: message.into(),
            kind: Some(kind),
        }
    }

    fn internal(message: impl Into<String>) -> Self {
        Self {
            code: 1,
            message: message.into(),
            kind: Some("app_server_runtime_error"),
        }
    }

    fn response(&self, id: Value) -> Value {
        json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": {
                "code": self.code,
                "message": self.message,
                "data": self.kind.map(|kind| json!({ "type": kind }))
            }
        })
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct RuntimeConstraints {
    extension_build_channel: String,
    extension_id: String,
    extension_version: String,
    native_host_name: String,
    required_app_server_protocol_version: u32,
    required_native_host_protocol_version: u32,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeManifest {
    schema_version: u32,
    entries: Vec<Value>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeEntry {
    schema_version: u32,
    app_server_protocol_version: u32,
    app_version: String,
    channel: String,
    cli_version: String,
    entry_id: String,
    extension_build_channels: Vec<String>,
    extension_ids: Vec<String>,
    install_id: String,
    native_host_names: Vec<String>,
    native_host_protocol_version: u32,
    native_host_version: String,
    paths: RuntimePaths,
    proxy_host: String,
    proxy_port: u16,
    updated_at: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimePaths {
    browser_client_path: Option<PathBuf>,
    codex_cli_path: PathBuf,
    codex_home: PathBuf,
    extension_host_path: PathBuf,
    node_path: PathBuf,
    #[serde(default)]
    node_module_dirs: Vec<PathBuf>,
    node_repl_path: Option<PathBuf>,
    resources_path: PathBuf,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct FileIdentity {
    device: u64,
    inode: u64,
}

struct ManagedProcess {
    child: Child,
    cleanup_deadline: Option<Instant>,
    entry_id: String,
    instance_id: u64,
    last_touched: Instant,
    leases: usize,
    process_group: libc::pid_t,
    proxy_host: String,
    proxy_port: u16,
    socket_path: PathBuf,
}

#[derive(Clone, Copy)]
struct ProcessCleanupTiming {
    disconnected_grace: Duration,
    reaper_interval: Duration,
    unconnected_timeout: Duration,
}

impl Default for ProcessCleanupTiming {
    fn default() -> Self {
        Self {
            disconnected_grace: DISCONNECTED_PROCESS_GRACE,
            reaper_interval: PROCESS_REAPER_INTERVAL,
            unconnected_timeout: UNCONNECTED_PROCESS_TIMEOUT,
        }
    }
}

struct ProcessLease {
    client_id: String,
    instance_id: u64,
    manager: Weak<RuntimeManager>,
}

impl Drop for ProcessLease {
    fn drop(&mut self) {
        if let Some(manager) = self.manager.upgrade() {
            manager.release_process_lease(&self.client_id, self.instance_id);
        }
    }
}

struct ProxyServer {
    address: SocketAddr,
    join: Option<thread::JoinHandle<()>>,
    requested_address: SocketAddr,
    shutdown: Option<oneshot::Sender<()>>,
    token: String,
}

struct TabContextAsset {
    file: File,
    finished: bool,
    path: PathBuf,
    size: u64,
}

struct ProxyHandshakeCallback {
    authenticated: Arc<Mutex<Option<AuthenticatedProxyConnection>>>,
    state: ProxyConnectionState,
}

struct AuthenticatedProxyConnection {
    _permit: tokio::sync::OwnedSemaphorePermit,
    _process_lease: ProcessLease,
    socket_path: PathBuf,
}

#[derive(Default)]
struct PendingHandshakePool {
    next_id: u64,
    pending: VecDeque<(u64, oneshot::Sender<()>)>,
}

#[derive(Clone)]
struct ProxyConnectionState {
    allowed_origin: String,
    authenticated_permits: Arc<Semaphore>,
    manager: Arc<RuntimeManager>,
    pending_handshakes: Arc<Mutex<PendingHandshakePool>>,
    token: String,
}

impl PendingHandshakePool {
    fn register(&mut self) -> (u64, oneshot::Receiver<()>) {
        if self.pending.len() >= MAX_PENDING_HANDSHAKES {
            if let Some((_, cancel)) = self.pending.pop_front() {
                let _ = cancel.send(());
            }
        }
        self.next_id = self.next_id.wrapping_add(1);
        let id = self.next_id;
        let (cancel, cancelled) = oneshot::channel();
        self.pending.push_back((id, cancel));
        (id, cancelled)
    }

    fn remove(&mut self, id: u64) {
        if let Some(index) = self
            .pending
            .iter()
            .position(|(pending_id, _)| *pending_id == id)
        {
            self.pending.remove(index);
        }
    }
}

impl Callback for ProxyHandshakeCallback {
    fn on_request(
        self,
        request: &Request,
        response: Response,
    ) -> std::result::Result<Response, ErrorResponse> {
        let client_id =
            validate_proxy_request(request, &self.state.allowed_origin, &self.state.token)
                .map_err(forbidden_response)?;
        let permit = Arc::clone(&self.state.authenticated_permits)
            .try_acquire_owned()
            .map_err(|_| unavailable_response())?;
        let (socket_path, process_lease) = self
            .state
            .manager
            .acquire_process_lease(&client_id)
            .map_err(|_| unavailable_response())?;
        *self
            .authenticated
            .lock()
            .expect("proxy connection mutex poisoned") = Some(AuthenticatedProxyConnection {
            _permit: permit,
            _process_lease: process_lease,
            socket_path,
        });
        Ok(response)
    }
}

pub struct RuntimeManager {
    assets: Mutex<HashMap<String, TabContextAsset>>,
    cleanup_control: Arc<(Mutex<bool>, Condvar)>,
    cleanup_join: Mutex<Option<thread::JoinHandle<()>>>,
    cleanup_timing: ProcessCleanupTiming,
    extension_id: Option<String>,
    #[cfg(test)]
    current_executable_identity_override: Option<FileIdentity>,
    lifecycle: Mutex<()>,
    manifest_paths_override: Option<Vec<PathBuf>>,
    next_process_instance: AtomicU64,
    processes: Mutex<HashMap<String, ManagedProcess>>,
    proxy: Mutex<Option<ProxyServer>>,
    runtime_root: PathBuf,
}

impl RuntimeManager {
    pub fn new(extension_id: Option<String>) -> Self {
        Self::with_runtime_root(extension_id, unique_runtime_root(), None)
    }

    fn with_runtime_root(
        extension_id: Option<String>,
        runtime_root: PathBuf,
        manifest_paths_override: Option<Vec<PathBuf>>,
    ) -> Self {
        Self::with_runtime_root_and_timing(
            extension_id,
            runtime_root,
            manifest_paths_override,
            ProcessCleanupTiming::default(),
        )
    }

    fn with_runtime_root_and_timing(
        extension_id: Option<String>,
        runtime_root: PathBuf,
        manifest_paths_override: Option<Vec<PathBuf>>,
        cleanup_timing: ProcessCleanupTiming,
    ) -> Self {
        Self {
            assets: Mutex::new(HashMap::new()),
            cleanup_control: Arc::new((Mutex::new(false), Condvar::new())),
            cleanup_join: Mutex::new(None),
            cleanup_timing,
            extension_id,
            #[cfg(test)]
            current_executable_identity_override: None,
            lifecycle: Mutex::new(()),
            manifest_paths_override,
            next_process_instance: AtomicU64::new(1),
            processes: Mutex::new(HashMap::new()),
            proxy: Mutex::new(None),
            runtime_root,
        }
    }

    pub fn handle_request(self: &Arc<Self>, message: &Value) -> Value {
        let id = message.get("id").cloned().unwrap_or(Value::Null);
        let method = message
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let params = message.get("params").cloned().unwrap_or_else(|| json!({}));

        let result = match method {
            "codexRuntime/hello" => self.hello(&params),
            "codexRuntime/ensure" => self.ensure(&params, false),
            "codexRuntime/restart" => self.ensure(&params, true),
            "codexRuntime/tabContextAsset/create" => self.create_asset(&params),
            "codexRuntime/tabContextAsset/appendChunk" => self.append_asset(&params),
            "codexRuntime/tabContextAsset/finish" => self.finish_asset(&params),
            "codexRuntime/tabContextAsset/abort" | "codexRuntime/tabContextAsset/remove" => {
                self.remove_asset(&params)
            }
            OPEN_LOCAL_FILE_METHOD => self.open_local_file(&params),
            _ => Err(RuntimeError::method_not_found(method)),
        };

        match result {
            Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
            Err(error) => error.response(id),
        }
    }

    fn hello(&self, params: &Value) -> RuntimeResult<Value> {
        if let Some(constraints) = params.get("constraints") {
            parse_constraints(constraints)?;
        }

        let mut supported_methods = Vec::new();
        if executable_in_path("xdg-open") {
            supported_methods.push(OPEN_LOCAL_FILE_METHOD);
        }

        Ok(json!({
            "manifestSchemaVersion": MANIFEST_SCHEMA_VERSION,
            "nativeHostProtocolVersion": NATIVE_HOST_PROTOCOL_VERSION,
            "nativeHostVersion": env!("CARGO_PKG_VERSION"),
            "supportedMethods": supported_methods,
            "supportedProtocolVersions": [NATIVE_HOST_PROTOCOL_VERSION]
        }))
    }

    fn ensure(self: &Arc<Self>, params: &Value, restart: bool) -> RuntimeResult<Value> {
        let constraints = parse_constraints(params.get("constraints").ok_or_else(|| {
            RuntimeError::invalid_params("Missing required parameter: constraints")
        })?)?;
        self.validate_invocation(&constraints)?;
        let client_id = normalized_client_id(params.get("clientId"))?;
        let current_executable_identity = self.current_executable_identity()?;
        let mut entry = select_runtime_entry_for_host(
            &constraints,
            self.manifest_paths_override.as_deref(),
            &current_executable_identity,
        )?;
        validate_runtime_entry_for_host(&mut entry, &current_executable_identity)?;
        let _lifecycle = self
            .lifecycle
            .lock()
            .expect("app-server lifecycle mutex poisoned");
        let (address, token) = self.ensure_proxy(&entry)?;
        self.ensure_process_locked(
            &entry,
            &constraints.extension_id,
            &client_id,
            address.port(),
            restart,
        )?;

        let local_app_server_url = format!(
            "ws://{}:{}/?token={}",
            display_ip(address.ip()),
            address.port(),
            token
        );
        Ok(json!({
            "appServerProtocolVersion": entry.app_server_protocol_version,
            "appVersion": entry.app_version,
            "channel": entry.channel,
            "cliVersion": entry.cli_version,
            "connected": true,
            "entryId": entry.entry_id,
            "localAppServerUrl": local_app_server_url,
            "nativeHostProtocolVersion": entry.native_host_protocol_version,
            "nativeHostVersion": entry.native_host_version,
            "runtimeConfig": runtime_config(&entry)?
        }))
    }

    fn validate_invocation(&self, constraints: &RuntimeConstraints) -> RuntimeResult<()> {
        if constraints.required_native_host_protocol_version != NATIVE_HOST_PROTOCOL_VERSION {
            return Err(RuntimeError::typed(
                "version_mismatch",
                "The Codex app and Chrome extension versions are incompatible.",
            ));
        }
        if constraints.native_host_name.trim().is_empty()
            || constraints.extension_build_channel.trim().is_empty()
            || constraints.extension_version.trim().is_empty()
        {
            return Err(RuntimeError::invalid_params(
                "Runtime constraints contain empty values",
            ));
        }
        if self.extension_id.as_deref() != Some(constraints.extension_id.as_str()) {
            return Err(RuntimeError::typed(
                "no_matching_codex_install",
                "No compatible Codex app-server entry was found",
            ));
        }
        Ok(())
    }

    fn ensure_proxy(self: &Arc<Self>, entry: &RuntimeEntry) -> RuntimeResult<(SocketAddr, String)> {
        let bind_address = proxy_bind_address(entry)?;
        let mut proxy = self.proxy.lock().expect("runtime proxy mutex poisoned");
        if proxy.as_ref().is_some_and(|proxy| {
            proxy.join.as_ref().is_some_and(|join| !join.is_finished())
                && proxy.requested_address == bind_address
        }) {
            let proxy = proxy.as_ref().expect("checked proxy");
            return Ok((proxy.address, proxy.token.clone()));
        }
        if let Some(mut stale) = proxy.take() {
            stop_proxy(&mut stale);
        }

        prepare_private_dir(&self.runtime_root).map_err(|error| {
            RuntimeError::internal(format!(
                "Failed to prepare Chrome runtime directory: {error}"
            ))
        })?;
        let listener = bind_proxy_listener(bind_address)?;
        listener.set_nonblocking(true).map_err(|error| {
            RuntimeError::internal(format!(
                "Failed to configure Codex app-server proxy: {error}"
            ))
        })?;
        let address = listener.local_addr().map_err(|error| {
            RuntimeError::internal(format!(
                "Failed to read Codex app-server proxy address: {error}"
            ))
        })?;
        let token = random_hex(32).map_err(|error| {
            RuntimeError::internal(format!(
                "Failed to create Codex app-server proxy token: {error}"
            ))
        })?;
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        let manager = Arc::clone(self);
        let extension_id = self.extension_id.clone().ok_or_else(|| {
            RuntimeError::typed(
                "no_matching_codex_install",
                "No compatible Codex app-server entry was found",
            )
        })?;
        let allowed_origin = format!("chrome-extension://{extension_id}");
        let proxy_token = token.clone();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|error| {
                RuntimeError::internal(format!(
                    "Failed to create Codex app-server proxy runtime: {error}"
                ))
            })?;
        let join = thread::Builder::new()
            .name("codex-app-server-proxy".to_string())
            .spawn(move || {
                runtime.block_on(run_proxy(
                    listener,
                    manager,
                    allowed_origin,
                    proxy_token,
                    shutdown_rx,
                ));
            })
            .map_err(|error| {
                RuntimeError::internal(format!("Failed to start Codex app-server proxy: {error}"))
            })?;

        *proxy = Some(ProxyServer {
            address,
            join: Some(join),
            requested_address: bind_address,
            shutdown: Some(shutdown_tx),
            token: token.clone(),
        });
        Ok((address, token))
    }

    #[cfg(test)]
    fn ensure_process(
        self: &Arc<Self>,
        entry: &RuntimeEntry,
        extension_id: &str,
        client_id: &str,
        proxy_port: u16,
        restart: bool,
    ) -> RuntimeResult<PathBuf> {
        let _lifecycle = self
            .lifecycle
            .lock()
            .expect("app-server lifecycle mutex poisoned");
        self.ensure_process_locked(entry, extension_id, client_id, proxy_port, restart)
    }

    fn ensure_process_locked(
        self: &Arc<Self>,
        entry: &RuntimeEntry,
        extension_id: &str,
        client_id: &str,
        proxy_port: u16,
        restart: bool,
    ) -> RuntimeResult<PathBuf> {
        self.ensure_cleanup_worker()?;
        let mut processes = self
            .processes
            .lock()
            .expect("app-server process mutex poisoned");

        let keep_existing = if let Some(process) = processes.get(client_id) {
            process_is_reusable(process, entry, proxy_port, restart)?
        } else {
            false
        };
        if keep_existing {
            let process = processes.get_mut(client_id).expect("checked process");
            process.last_touched = Instant::now();
            if process.leases == 0 {
                process.cleanup_deadline =
                    Some(Instant::now() + self.cleanup_timing.unconnected_timeout);
            }
            let socket_path = process.socket_path.clone();
            return Ok(socket_path);
        }

        let stale = processes.remove(client_id);
        drop(processes);
        if let Some(mut stale) = stale {
            stop_managed_process(&mut stale);
        }

        let mut processes = self
            .processes
            .lock()
            .expect("app-server process mutex poisoned");
        let exited_clients = processes
            .iter()
            .filter_map(|(client_id, process)| {
                match leader_exited_without_reaping(&process.child) {
                    Ok(true) => Some(client_id.clone()),
                    Ok(false) => None,
                    Err(error) => {
                        runtime_log(&format!("app-server status check failed: {error}"));
                        None
                    }
                }
            })
            .collect::<Vec<_>>();
        let mut exited_processes = exited_clients
            .into_iter()
            .filter_map(|client_id| processes.remove(&client_id))
            .collect::<Vec<_>>();
        drop(processes);
        for process in &mut exited_processes {
            stop_managed_process(process);
        }
        let mut processes = self
            .processes
            .lock()
            .expect("app-server process mutex poisoned");
        if processes.len() >= MAX_APP_SERVER_PROCESSES {
            let idle_client = processes
                .iter()
                .filter(|(_, process)| process.leases == 0)
                .min_by_key(|(_, process)| process.last_touched)
                .map(|(client_id, _)| client_id.clone());
            let evicted = idle_client.and_then(|client_id| processes.remove(&client_id));
            drop(processes);
            if let Some(mut evicted) = evicted {
                stop_managed_process(&mut evicted);
            } else {
                return Err(RuntimeError::internal(
                    "Too many active Chrome sidepanel app-server processes",
                ));
            }
            processes = self
                .processes
                .lock()
                .expect("app-server process mutex poisoned");
        }

        let instance_id = self.next_process_instance.fetch_add(1, Ordering::Relaxed);
        drop(processes);
        let process = start_app_server(
            entry,
            extension_id,
            client_id,
            proxy_port,
            &self.runtime_root,
            instance_id,
            self.cleanup_timing.unconnected_timeout,
        )?;
        let socket_path = process.socket_path.clone();
        let mut processes = self
            .processes
            .lock()
            .expect("app-server process mutex poisoned");
        if let Some(previous) = processes.insert(client_id.to_string(), process) {
            let mut previous = previous;
            drop(processes);
            stop_managed_process(&mut previous);
        } else {
            drop(processes);
        }
        Ok(socket_path)
    }

    fn acquire_process_lease(
        self: &Arc<Self>,
        client_id: &str,
    ) -> RuntimeResult<(PathBuf, ProcessLease)> {
        let mut processes = self
            .processes
            .lock()
            .expect("app-server process mutex poisoned");
        let process = processes.get_mut(client_id).ok_or_else(|| {
            RuntimeError::internal("Codex app-server is not running for this sidepanel")
        })?;
        if leader_exited_without_reaping(&process.child).map_err(|error| {
            RuntimeError::internal(format!("Failed to inspect Codex app-server: {error}"))
        })? {
            let mut process = processes
                .remove(client_id)
                .expect("checked app-server process");
            drop(processes);
            stop_managed_process(&mut process);
            return Err(RuntimeError::internal(
                "Codex app-server exited before the sidepanel connected",
            ));
        }
        process.leases = process.leases.checked_add(1).ok_or_else(|| {
            RuntimeError::internal("Too many app-server leases for this sidepanel")
        })?;
        process.cleanup_deadline = None;
        process.last_touched = Instant::now();
        let socket_path = process.socket_path.clone();
        let instance_id = process.instance_id;
        Ok((
            socket_path,
            ProcessLease {
                client_id: client_id.to_string(),
                instance_id,
                manager: Arc::downgrade(self),
            },
        ))
    }

    fn release_process_lease(&self, client_id: &str, instance_id: u64) {
        let mut processes = self
            .processes
            .lock()
            .expect("app-server process mutex poisoned");
        let Some(process) = processes.get_mut(client_id) else {
            return;
        };
        if process.instance_id != instance_id {
            return;
        }
        if process.leases == 0 {
            runtime_log("app-server lease underflow prevented");
            return;
        }
        process.leases -= 1;
        process.last_touched = Instant::now();
        if process.leases == 0 {
            process.cleanup_deadline =
                Some(Instant::now() + self.cleanup_timing.disconnected_grace);
            self.cleanup_control.1.notify_all();
        }
    }

    fn ensure_cleanup_worker(self: &Arc<Self>) -> RuntimeResult<()> {
        let mut join = self
            .cleanup_join
            .lock()
            .expect("app-server cleanup worker mutex poisoned");
        if join.as_ref().is_some_and(|join| !join.is_finished()) {
            return Ok(());
        }
        if let Some(finished) = join.take() {
            let _ = finished.join();
        }
        if *self
            .cleanup_control
            .0
            .lock()
            .expect("app-server cleanup state mutex poisoned")
        {
            return Err(RuntimeError::internal(
                "Codex app-server runtime is shutting down",
            ));
        }

        let manager = Arc::downgrade(self);
        let control = Arc::clone(&self.cleanup_control);
        let interval = self.cleanup_timing.reaper_interval;
        let worker = thread::Builder::new()
            .name("codex-app-server-reaper".to_string())
            .spawn(move || loop {
                let (shutdown, wake) = &*control;
                let shutdown = shutdown
                    .lock()
                    .expect("app-server cleanup state mutex poisoned");
                let (shutdown, _) = wake
                    .wait_timeout_while(shutdown, interval, |shutdown| !*shutdown)
                    .expect("app-server cleanup wait poisoned");
                if *shutdown {
                    break;
                }
                drop(shutdown);
                let Some(manager) = manager.upgrade() else {
                    break;
                };
                manager.reap_idle_processes();
            })
            .map_err(|error| {
                RuntimeError::internal(format!("Failed to start app-server reaper: {error}"))
            })?;
        *join = Some(worker);
        Ok(())
    }

    fn reap_idle_processes(&self) {
        let now = Instant::now();
        let mut processes = self
            .processes
            .lock()
            .expect("app-server process mutex poisoned");
        let expired_clients = processes
            .iter()
            .filter_map(|(client_id, process)| {
                let leader_exited = match leader_exited_without_reaping(&process.child) {
                    Ok(exited) => exited,
                    Err(error) => {
                        runtime_log(&format!("app-server status check failed: {error}"));
                        false
                    }
                };
                let lease_expired = process.leases == 0
                    && process
                        .cleanup_deadline
                        .is_some_and(|deadline| deadline <= now);
                (leader_exited || lease_expired).then(|| client_id.clone())
            })
            .collect::<Vec<_>>();
        let mut expired_processes = expired_clients
            .into_iter()
            .filter_map(|client_id| processes.remove(&client_id))
            .collect::<Vec<_>>();
        drop(processes);
        for process in &mut expired_processes {
            stop_managed_process(process);
        }
    }

    fn create_asset(&self, params: &Value) -> RuntimeResult<Value> {
        let file_name = required_string(params, "fileName")?;
        validate_asset_file_name(file_name)?;
        prepare_private_dir(&self.runtime_root).map_err(|error| {
            RuntimeError::internal(format!(
                "Failed to prepare Chrome runtime directory: {error}"
            ))
        })?;
        let asset_dir = self.runtime_root.join("codex-tab-context-assets");
        prepare_private_dir(&asset_dir).map_err(|error| {
            RuntimeError::internal(format!(
                "Failed to create Chrome tab context asset directory: {error}"
            ))
        })?;

        let mut assets = self
            .assets
            .lock()
            .expect("tab context asset mutex poisoned");
        if assets.len() >= MAX_ACTIVE_ASSETS {
            return Err(RuntimeError::internal(
                "Too many active Chrome tab context assets",
            ));
        }
        let asset_id = random_hex(16).map_err(|error| {
            RuntimeError::internal(format!(
                "Failed to create Chrome tab context asset: {error}"
            ))
        })?;
        let path = asset_dir.join(format!("{asset_id}-{file_name}"));
        let file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(&path)
            .map_err(|error| {
                RuntimeError::internal(format!(
                    "Failed to create Chrome tab context asset: {error}"
                ))
            })?;
        assets.insert(
            asset_id.clone(),
            TabContextAsset {
                file,
                finished: false,
                path: path.clone(),
                size: 0,
            },
        );
        Ok(json!({ "assetId": asset_id, "path": path }))
    }

    fn append_asset(&self, params: &Value) -> RuntimeResult<Value> {
        let asset_id = required_string(params, "assetId")?;
        let data_base64 = required_string(params, "dataBase64")?;
        if data_base64.len() > MAX_ASSET_CHUNK_BASE64 {
            return Err(RuntimeError::invalid_params(
                "Invalid Chrome tab context asset chunk",
            ));
        }
        let data = BASE64_STANDARD
            .decode(data_base64)
            .map_err(|_| RuntimeError::invalid_params("Invalid Chrome tab context asset chunk"))?;
        let mut assets = self
            .assets
            .lock()
            .expect("tab context asset mutex poisoned");
        let asset = assets.get_mut(asset_id).ok_or_else(|| {
            RuntimeError::invalid_params("Chrome tab context asset was not found")
        })?;
        if asset.finished {
            return Err(RuntimeError::invalid_params(
                "Chrome tab context asset is already finished",
            ));
        }
        let next_size = asset.size.saturating_add(data.len() as u64);
        if next_size > MAX_ASSET_BYTES {
            return Err(RuntimeError::invalid_params(
                "Chrome tab context asset is too large",
            ));
        }
        asset.file.write_all(&data).map_err(|error| {
            RuntimeError::internal(format!("Failed to write Chrome tab context asset: {error}"))
        })?;
        asset.size = next_size;
        Ok(json!({ "ok": true }))
    }

    fn finish_asset(&self, params: &Value) -> RuntimeResult<Value> {
        let asset_id = required_string(params, "assetId")?;
        let mut assets = self
            .assets
            .lock()
            .expect("tab context asset mutex poisoned");
        let asset = assets.get_mut(asset_id).ok_or_else(|| {
            RuntimeError::invalid_params("Chrome tab context asset was not found")
        })?;
        asset.file.sync_all().map_err(|error| {
            RuntimeError::internal(format!(
                "Failed to secure Chrome tab context asset: {error}"
            ))
        })?;
        asset.finished = true;
        Ok(json!({ "assetId": asset_id, "path": asset.path }))
    }

    fn remove_asset(&self, params: &Value) -> RuntimeResult<Value> {
        let asset_id = required_string(params, "assetId")?;
        let asset = self
            .assets
            .lock()
            .expect("tab context asset mutex poisoned")
            .remove(asset_id)
            .ok_or_else(|| {
                RuntimeError::invalid_params("Chrome tab context asset was not found")
            })?;
        drop(asset.file);
        match fs::remove_file(&asset.path) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(RuntimeError::internal(format!(
                    "Failed to remove Chrome tab context asset: {error}"
                )))
            }
        }
        Ok(json!({ "ok": true }))
    }

    fn open_local_file(&self, params: &Value) -> RuntimeResult<Value> {
        let path = PathBuf::from(required_string(params, "path")?);
        validate_openable_file(&path)?;
        let mut child = Command::new("xdg-open")
            .arg(&path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| {
                RuntimeError::internal(format!("Failed to open local file: {error}"))
            })?;
        let _ = thread::Builder::new()
            .name("codex-open-local-file".to_string())
            .spawn(move || {
                let _ = child.wait();
            });
        Ok(json!({}))
    }

    pub fn shutdown(&self) {
        let _lifecycle = self
            .lifecycle
            .lock()
            .expect("app-server lifecycle mutex poisoned");
        {
            let mut shutdown = self
                .cleanup_control
                .0
                .lock()
                .expect("app-server cleanup state mutex poisoned");
            *shutdown = true;
            self.cleanup_control.1.notify_all();
        }
        if let Some(mut proxy) = self
            .proxy
            .lock()
            .expect("runtime proxy mutex poisoned")
            .take()
        {
            stop_proxy(&mut proxy);
        }
        if let Some(worker) = self
            .cleanup_join
            .lock()
            .expect("app-server cleanup worker mutex poisoned")
            .take()
        {
            let _ = worker.join();
        }
        let processes = std::mem::take(
            &mut *self
                .processes
                .lock()
                .expect("app-server process mutex poisoned"),
        );
        for mut process in processes.into_values() {
            stop_managed_process(&mut process);
        }
        let assets = std::mem::take(
            &mut *self
                .assets
                .lock()
                .expect("tab context asset mutex poisoned"),
        );
        drop(assets);
        let _ = fs::remove_dir_all(&self.runtime_root);
    }

    #[cfg(test)]
    pub(crate) fn for_test(
        extension_id: String,
        runtime_root: PathBuf,
        manifest_path: PathBuf,
    ) -> Self {
        Self::with_runtime_root(Some(extension_id), runtime_root, Some(vec![manifest_path]))
    }

    #[cfg(test)]
    pub(crate) fn for_test_with_current_executable_path(
        extension_id: String,
        runtime_root: PathBuf,
        manifest_path: PathBuf,
        current_executable_path: &Path,
    ) -> Self {
        let mut manager = Self::for_test(extension_id, runtime_root, manifest_path);
        manager.current_executable_identity_override = Some(
            file_identity(current_executable_path)
                .expect("test current executable path should identify a file"),
        );
        manager
    }

    fn current_executable_identity(&self) -> RuntimeResult<FileIdentity> {
        #[cfg(test)]
        if let Some(identity) = &self.current_executable_identity_override {
            return Ok(*identity);
        }

        current_executable_identity()
    }

    #[cfg(test)]
    pub(crate) fn running_process_count(&self) -> usize {
        let processes = self
            .processes
            .lock()
            .expect("app-server process mutex poisoned");
        processes
            .values()
            .map(|process| {
                leader_exited_without_reaping(&process.child).is_ok_and(|exited| !exited)
            })
            .filter(|running| *running)
            .count()
    }
}

fn process_is_reusable(
    process: &ManagedProcess,
    entry: &RuntimeEntry,
    proxy_port: u16,
    restart: bool,
) -> RuntimeResult<bool> {
    if restart
        || process.entry_id != entry.entry_id
        || process.proxy_host != entry.proxy_host
        || process.proxy_port != proxy_port
    {
        return Ok(false);
    }
    let exited = leader_exited_without_reaping(&process.child).map_err(|error| {
        RuntimeError::internal(format!("Failed to inspect Codex app-server: {error}"))
    })?;
    Ok(!exited && socket_is_ready(&process.socket_path))
}

impl RuntimeEntry {
    fn matches(&self, constraints: &RuntimeConstraints) -> bool {
        self.schema_version == MANIFEST_SCHEMA_VERSION
            && self.app_server_protocol_version == constraints.required_app_server_protocol_version
            && self.native_host_protocol_version
                == constraints.required_native_host_protocol_version
            && self
                .extension_build_channels
                .iter()
                .any(|channel| channel == &constraints.extension_build_channel)
            && self
                .extension_ids
                .iter()
                .any(|extension_id| extension_id == &constraints.extension_id)
            && self
                .native_host_names
                .iter()
                .any(|host_name| host_name == &constraints.native_host_name)
    }
}

fn parse_constraints(value: &Value) -> RuntimeResult<RuntimeConstraints> {
    serde_json::from_value(value.clone())
        .map_err(|_| RuntimeError::invalid_params("Invalid Codex runtime constraints"))
}

#[cfg(test)]
fn select_runtime_entry(
    constraints: &RuntimeConstraints,
    manifest_paths_override: Option<&[PathBuf]>,
) -> RuntimeResult<RuntimeEntry> {
    let current_host = current_executable_identity()?;
    select_runtime_entry_for_host(constraints, manifest_paths_override, &current_host)
}

fn select_runtime_entry_for_host(
    constraints: &RuntimeConstraints,
    manifest_paths_override: Option<&[PathBuf]>,
    current_host: &FileIdentity,
) -> RuntimeResult<RuntimeEntry> {
    let manifest_paths = manifest_paths_override
        .map(<[PathBuf]>::to_vec)
        .unwrap_or_else(manifest_paths);
    let mut saw_manifest = false;
    let mut entries = Vec::new();
    for path in manifest_paths {
        let contents = match fs::read_to_string(&path) {
            Ok(contents) => {
                saw_manifest = true;
                contents
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(_) => {
                return Err(RuntimeError::typed(
                    "manifest_invalid",
                    "Codex Chrome native host v2 manifest is invalid",
                ))
            }
        };
        let manifest: RuntimeManifest = serde_json::from_str(&contents).map_err(|_| {
            RuntimeError::typed(
                "manifest_invalid",
                "Codex Chrome native host v2 manifest is invalid",
            )
        })?;
        if manifest.schema_version != MANIFEST_SCHEMA_VERSION {
            return Err(RuntimeError::typed(
                "manifest_invalid",
                "Codex Chrome native host manifest must use schemaVersion 2",
            ));
        }
        entries.extend(manifest.entries);
    }
    if !saw_manifest {
        return Err(RuntimeError::typed(
            "manifest_missing",
            "Codex Chrome native host v2 manifest is missing",
        ));
    }

    let mut matching = entries
        .into_iter()
        .filter_map(|entry| serde_json::from_value::<RuntimeEntry>(entry).ok())
        .filter(|entry| {
            entry.matches(constraints)
                && fs::canonicalize(&entry.paths.extension_host_path)
                    .ok()
                    .and_then(|path| file_identity(&path).ok())
                    .is_some_and(|identity| &identity == current_host)
        })
        .collect::<Vec<_>>();
    matching.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    matching.into_iter().next().ok_or_else(|| {
        RuntimeError::typed(
            "no_matching_codex_install",
            "No compatible Codex app-server entry was found",
        )
    })
}

fn manifest_paths() -> Vec<PathBuf> {
    if let Some(path) = env::var_os("CODEX_CHROME_NATIVE_HOSTS_MANIFEST") {
        return vec![PathBuf::from(path)];
    }
    let mut paths = Vec::new();
    if let Some(path) = env::var_os("XDG_STATE_HOME") {
        paths.push(
            PathBuf::from(path)
                .join("openai-codex")
                .join(MANIFEST_FILE_NAME),
        );
    } else if let Some(home) = env::var_os("HOME") {
        paths.push(
            PathBuf::from(home)
                .join(".local/state/openai-codex")
                .join(MANIFEST_FILE_NAME),
        );
    }
    if let Some(codex_home) = env::var_os("CODEX_HOME") {
        paths.push(PathBuf::from(codex_home).join(MANIFEST_FILE_NAME));
    } else if let Some(home) = env::var_os("HOME") {
        paths.push(PathBuf::from(home).join(".codex").join(MANIFEST_FILE_NAME));
    }
    paths.dedup();
    paths
}

fn validate_runtime_entry_for_host(
    entry: &mut RuntimeEntry,
    current_exe: &FileIdentity,
) -> RuntimeResult<()> {
    if entry.entry_id.trim().is_empty()
        || entry.install_id.trim().is_empty()
        || entry.app_version.trim().is_empty()
        || entry.cli_version.trim().is_empty()
        || entry.native_host_version.trim().is_empty()
    {
        return Err(RuntimeError::typed(
            "manifest_invalid",
            "Matching manifest entry is malformed",
        ));
    }
    validate_owned_dir(&entry.paths.codex_home, true)?;
    validate_owned_dir(&entry.paths.resources_path, false)?;
    entry.paths.codex_cli_path = validate_owned_file(&entry.paths.codex_cli_path, true)?;
    validate_owned_file(&entry.paths.extension_host_path, true)?;
    validate_owned_file(&entry.paths.node_path, true)?;
    if let Some(path) = &entry.paths.node_repl_path {
        validate_owned_file(path, true)?;
    }
    if let Some(path) = &entry.paths.browser_client_path {
        validate_owned_file(path, false)?;
    }
    for path in &entry.paths.node_module_dirs {
        validate_owned_dir(path, false)?;
    }

    let configured_host = file_identity(&entry.paths.extension_host_path)
        .map_err(|_| required_path_error("extensionHostPath"))?;
    if current_exe != &configured_host {
        return Err(RuntimeError::typed(
            "no_matching_codex_install",
            "No compatible Codex app-server entry was found",
        ));
    }
    Ok(())
}

fn validate_owned_file(path: &Path, executable: bool) -> RuntimeResult<PathBuf> {
    if !path.is_absolute() {
        return Err(required_path_error("file"));
    }
    let canonical = fs::canonicalize(path).map_err(|_| required_path_error("file"))?;
    let metadata = fs::metadata(&canonical).map_err(|_| required_path_error("file"))?;
    if !metadata.is_file() || has_unsafe_write_permissions(&metadata) {
        return Err(required_path_error("file"));
    }
    let euid = unsafe { libc::geteuid() };
    if metadata.uid() != euid && metadata.uid() != 0 {
        return Err(required_path_error("file"));
    }
    if executable && metadata.permissions().mode() & 0o111 == 0 {
        return Err(required_path_error("executable"));
    }
    validate_trusted_parent_chain(&canonical)?;
    Ok(canonical)
}

fn validate_owned_dir(path: &Path, require_user_owner: bool) -> RuntimeResult<()> {
    if !path.is_absolute() {
        return Err(required_path_error("directory"));
    }
    let canonical = fs::canonicalize(path).map_err(|_| required_path_error("directory"))?;
    let metadata = fs::metadata(&canonical).map_err(|_| required_path_error("directory"))?;
    if !metadata.is_dir() || has_unsafe_write_permissions(&metadata) {
        return Err(required_path_error("directory"));
    }
    let euid = unsafe { libc::geteuid() };
    if (require_user_owner && metadata.uid() != euid)
        || (!require_user_owner && metadata.uid() != euid && metadata.uid() != 0)
    {
        return Err(required_path_error("directory"));
    }
    validate_trusted_parent_chain(&canonical)?;
    Ok(())
}

fn required_path_error(field: &str) -> RuntimeError {
    RuntimeError::typed(
        "required_path_missing",
        format!("Codex app-server manifest entry is missing required path {field}"),
    )
}

fn validate_trusted_parent_chain(path: &Path) -> RuntimeResult<()> {
    let euid = unsafe { libc::geteuid() };
    for parent in path.ancestors().skip(1) {
        let metadata = fs::symlink_metadata(parent).map_err(|_| required_path_error("parent"))?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(required_path_error("parent"));
        }
        if metadata.uid() != euid && metadata.uid() != 0 {
            return Err(required_path_error("parent"));
        }
        if has_unsafe_write_permissions(&metadata) && !is_root_owned_sticky_directory(&metadata) {
            return Err(required_path_error("parent"));
        }
    }
    Ok(())
}

fn is_root_owned_sticky_directory(metadata: &fs::Metadata) -> bool {
    let mode = metadata.permissions().mode();
    metadata.uid() == 0 && mode & libc::S_ISVTX != 0 && mode & 0o002 != 0
}

fn current_executable_identity() -> RuntimeResult<FileIdentity> {
    file_identity(Path::new("/proc/self/exe")).map_err(|_| required_path_error("extensionHostPath"))
}

fn file_identity(path: &Path) -> io::Result<FileIdentity> {
    let metadata = fs::metadata(path)?;
    Ok(FileIdentity {
        device: metadata.dev(),
        inode: metadata.ino(),
    })
}

fn runtime_config(entry: &RuntimeEntry) -> RuntimeResult<Value> {
    let trusted_hashes = match &entry.paths.browser_client_path {
        Some(path) => vec![sha256_file(path)?],
        None => Vec::new(),
    };
    let defaults = desktop_agent_mode_defaults(&entry.paths.codex_home);
    Ok(json!({
        "browserClientPath": entry.paths.browser_client_path,
        "codexCliPath": entry.paths.codex_cli_path,
        "codexHome": entry.paths.codex_home,
        "desktopAgentModeDefaults": defaults,
        "nodeModuleDirs": entry.paths.node_module_dirs,
        "nodePath": entry.paths.node_path,
        "nodeReplPath": entry.paths.node_repl_path,
        "platform": "linux",
        "trustedBrowserClientSha256s": trusted_hashes
    }))
}

fn sha256_file(path: &Path) -> RuntimeResult<String> {
    let mut file = File::open(path).map_err(|_| required_path_error("browserClientPath"))?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|error| {
            RuntimeError::internal(format!("Failed to hash Browser Use client: {error}"))
        })?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(hex_encode(digest.finalize().as_slice()))
}

fn desktop_agent_mode_defaults(codex_home: &Path) -> Option<Value> {
    let state: Value = serde_json::from_str(
        &fs::read_to_string(codex_home.join(".codex-global-state.json")).ok()?,
    )
    .ok()?;
    let persisted = state
        .get("electron-persisted-atom-state")
        .and_then(Value::as_object)?;
    let agent_modes = persisted
        .get("agentModesByHostId")
        .or_else(|| persisted.get("agent-mode-by-host-id"))
        .cloned()
        .unwrap_or_else(|| json!({}));
    let preferred_modes = persisted
        .get("preferredNonFullAccessModesByHostId")
        .or_else(|| persisted.get("preferred-non-full-access-agent-mode-by-host-id"))
        .cloned()
        .unwrap_or_else(|| json!({}));
    Some(json!({
        "agentModesByHostId": agent_modes,
        "preferredNonFullAccessModesByHostId": preferred_modes
    }))
}

fn proxy_bind_address(entry: &RuntimeEntry) -> RuntimeResult<SocketAddr> {
    let ip = match entry.proxy_host.as_str() {
        "localhost" => IpAddr::V4(Ipv4Addr::LOCALHOST),
        value => value.parse::<IpAddr>().map_err(|_| {
            RuntimeError::typed("manifest_invalid", "Codex app-server proxy host is invalid")
        })?,
    };
    if !ip.is_loopback() {
        return Err(RuntimeError::typed(
            "manifest_invalid",
            "Codex app-server proxy must use a loopback address",
        ));
    }
    Ok(SocketAddr::new(ip, entry.proxy_port))
}

fn bind_proxy_listener(requested: SocketAddr) -> RuntimeResult<TcpListener> {
    match TcpListener::bind(requested) {
        Ok(listener) => Ok(listener),
        Err(first_error) if requested.port() != 0 => {
            let fallback = SocketAddr::new(requested.ip(), 0);
            runtime_log(&format!(
                "failed to bind app-server proxy to {requested}; using an available loopback port"
            ));
            TcpListener::bind(fallback).map_err(|fallback_error| {
                RuntimeError::internal(format!(
                    "Failed to bind Codex app-server proxy to {requested} ({first_error}) or an available fallback port ({fallback_error})"
                ))
            })
        }
        Err(error) => Err(RuntimeError::internal(format!(
            "Failed to bind Codex app-server proxy: {error}"
        ))),
    }
}

fn start_app_server(
    entry: &RuntimeEntry,
    extension_id: &str,
    client_id: &str,
    proxy_port: u16,
    runtime_root: &Path,
    instance_id: u64,
    unconnected_timeout: Duration,
) -> RuntimeResult<ManagedProcess> {
    prepare_private_dir(runtime_root).map_err(|error| {
        RuntimeError::internal(format!(
            "Failed to prepare Chrome runtime directory: {error}"
        ))
    })?;
    let client_hash = short_hash(client_id.as_bytes());
    let socket_path = runtime_root.join(format!("a-{client_hash}.sock"));
    if !unix_socket_path_fits(&socket_path) {
        return Err(RuntimeError::internal(
            "Codex app-server Unix socket path is too long",
        ));
    }
    match fs::remove_file(&socket_path) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(RuntimeError::internal(format!(
                "Failed to remove stale Codex app-server socket: {error}"
            )))
        }
    }

    let mut command = Command::new(&entry.paths.codex_cli_path);
    command
        .arg("-c")
        .arg("features.code_mode_host=true")
        .arg("app-server")
        .arg("--listen")
        .arg(format!("unix://{}", socket_path.display()))
        .arg("--analytics-default-enabled")
        .current_dir(&entry.paths.codex_home)
        .env("CODEX_HOME", &entry.paths.codex_home)
        .env("CODEX_CLI_PATH", &entry.paths.codex_cli_path)
        .env("CODEX_EXTENSION_ID", extension_id)
        .env("CODEX_BROWSER_USE_NODE_PATH", &entry.paths.node_path)
        .env("CODEX_APP_SERVER_PROXY_HOST", &entry.proxy_host)
        .env("CODEX_APP_SERVER_PROXY_PORT", proxy_port.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    if let Some(path) = &entry.paths.browser_client_path {
        command.env("CODEX_BROWSER_CLIENT_PATH", path);
    }
    if let Some(path) = &entry.paths.node_repl_path {
        command.env("CODEX_NODE_REPL_PATH", path);
    }
    let parent_pid = unsafe { libc::getpid() };
    unsafe {
        command.pre_exec(move || {
            if libc::setpgid(0, 0) != 0 {
                return Err(io::Error::last_os_error());
            }
            if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM) != 0 {
                return Err(io::Error::last_os_error());
            }
            if libc::getppid() != parent_pid {
                return Err(io::Error::from_raw_os_error(libc::EPIPE));
            }
            Ok(())
        });
    }
    let mut child = command.spawn().map_err(|error| {
        RuntimeError::internal(format!("Failed to start Codex app-server: {error}"))
    })?;
    if let Some(stderr) = child.stderr.take() {
        let _ = thread::Builder::new()
            .name("codex-app-server-stderr".to_string())
            .spawn(move || {
                for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                    runtime_log(&format!("app-server stderr: {line}"));
                }
            });
    }

    let process_group = child.id() as libc::pid_t;
    let deadline = Instant::now() + APP_SERVER_START_TIMEOUT;
    while Instant::now() < deadline {
        match leader_exited_without_reaping(&child) {
            Ok(true) => {
                let mut process = ManagedProcess {
                    child,
                    cleanup_deadline: None,
                    entry_id: entry.entry_id.clone(),
                    instance_id,
                    last_touched: Instant::now(),
                    leases: 0,
                    process_group,
                    proxy_host: entry.proxy_host.clone(),
                    proxy_port,
                    socket_path,
                };
                stop_managed_process(&mut process);
                return Err(RuntimeError::internal(
                    "Codex app-server exited before becoming ready",
                ));
            }
            Ok(false) => {}
            Err(error) => {
                let mut process = ManagedProcess {
                    child,
                    cleanup_deadline: None,
                    entry_id: entry.entry_id.clone(),
                    instance_id,
                    last_touched: Instant::now(),
                    leases: 0,
                    process_group,
                    proxy_host: entry.proxy_host.clone(),
                    proxy_port,
                    socket_path,
                };
                stop_managed_process(&mut process);
                return Err(RuntimeError::internal(format!(
                    "Failed to inspect Codex app-server: {error}"
                )));
            }
        }
        if socket_is_ready(&socket_path) {
            let now = Instant::now();
            return Ok(ManagedProcess {
                child,
                cleanup_deadline: Some(now + unconnected_timeout),
                entry_id: entry.entry_id.clone(),
                instance_id,
                last_touched: now,
                leases: 0,
                process_group,
                proxy_host: entry.proxy_host.clone(),
                proxy_port,
                socket_path,
            });
        }
        thread::sleep(Duration::from_millis(50));
    }
    let mut process = ManagedProcess {
        child,
        cleanup_deadline: None,
        entry_id: entry.entry_id.clone(),
        instance_id,
        last_touched: Instant::now(),
        leases: 0,
        process_group,
        proxy_host: entry.proxy_host.clone(),
        proxy_port,
        socket_path,
    };
    stop_managed_process(&mut process);
    Err(RuntimeError::internal(
        "Timed out waiting for Codex app-server to start",
    ))
}

fn stop_managed_process(process: &mut ManagedProcess) {
    let _ = signal_process_group(process.process_group, libc::SIGTERM);
    let deadline = Instant::now() + APP_SERVER_STOP_TIMEOUT;
    while Instant::now() < deadline
        && process_group_has_live_members(process.process_group).unwrap_or(true)
    {
        thread::sleep(Duration::from_millis(25));
    }
    if process_group_has_live_members(process.process_group).unwrap_or(true) {
        let _ = signal_process_group(process.process_group, libc::SIGKILL);
        let kill_deadline = Instant::now() + APP_SERVER_STOP_TIMEOUT;
        while Instant::now() < kill_deadline
            && process_group_has_live_members(process.process_group).unwrap_or(true)
        {
            thread::sleep(Duration::from_millis(25));
        }
    }
    let _ = process.child.wait();
    let _ = fs::remove_file(&process.socket_path);
}

fn leader_exited_without_reaping(child: &Child) -> io::Result<bool> {
    let mut info = std::mem::MaybeUninit::<libc::siginfo_t>::zeroed();
    loop {
        let result = unsafe {
            libc::waitid(
                libc::P_PID,
                child.id() as libc::id_t,
                info.as_mut_ptr(),
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            )
        };
        if result == 0 {
            break;
        }
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
    let info = unsafe { info.assume_init() };
    Ok(unsafe { info.si_pid() } != 0)
}

fn signal_process_group(process_group: libc::pid_t, signal: libc::c_int) -> io::Result<()> {
    if unsafe { libc::kill(-process_group, signal) } == 0 {
        return Ok(());
    }
    let error = io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        Ok(())
    } else {
        Err(error)
    }
}

fn process_group_has_live_members(process_group: libc::pid_t) -> io::Result<bool> {
    for entry in fs::read_dir("/proc")? {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        if entry
            .file_name()
            .to_str()
            .and_then(|value| value.parse::<libc::pid_t>().ok())
            .is_none()
        {
            continue;
        }
        let Ok(stat) = fs::read_to_string(entry.path().join("stat")) else {
            continue;
        };
        let Some((_, suffix)) = stat.rsplit_once(')') else {
            continue;
        };
        let mut fields = suffix.split_whitespace();
        let Some(state) = fields.next() else { continue };
        let _parent_pid = fields.next();
        let Some(member_group) = fields
            .next()
            .and_then(|value| value.parse::<libc::pid_t>().ok())
        else {
            continue;
        };
        if member_group == process_group && state != "Z" && state != "X" {
            return Ok(true);
        }
    }
    Ok(false)
}

fn socket_is_ready(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|metadata| {
        metadata.file_type().is_socket() && metadata.uid() == unsafe { libc::geteuid() }
    })
}

fn stop_proxy(proxy: &mut ProxyServer) {
    if let Some(shutdown) = proxy.shutdown.take() {
        let _ = shutdown.send(());
    }
    if let Some(join) = proxy.join.take() {
        let _ = join.join();
    }
}

async fn run_proxy(
    listener: TcpListener,
    manager: Arc<RuntimeManager>,
    allowed_origin: String,
    token: String,
    mut shutdown: oneshot::Receiver<()>,
) {
    let listener = match TokioTcpListener::from_std(listener) {
        Ok(listener) => listener,
        Err(error) => {
            runtime_log(&format!("proxy listener setup failed: {error}"));
            return;
        }
    };
    let pending_handshakes = Arc::new(Mutex::new(PendingHandshakePool::default()));
    let authenticated_permits = Arc::new(Semaphore::new(MAX_AUTHENTICATED_CONNECTIONS));
    let connection_state = ProxyConnectionState {
        allowed_origin,
        authenticated_permits,
        manager,
        pending_handshakes: Arc::clone(&pending_handshakes),
        token,
    };
    loop {
        tokio::select! {
            _ = &mut shutdown => break,
            accepted = listener.accept() => {
                let Ok((stream, _)) = accepted else { continue };
                let (handshake_id, cancelled) = pending_handshakes
                    .lock()
                    .expect("pending handshake pool mutex poisoned")
                    .register();
                let connection_state = connection_state.clone();
                tokio::spawn(async move {
                    if let Err(error) = handle_proxy_connection(
                        stream,
                        handshake_id,
                        cancelled,
                        connection_state,
                    ).await {
                        runtime_log(&format!("app-server proxy connection failed: {error}"));
                    }
                });
                tokio::task::yield_now().await;
            }
        }
    }
}

async fn handle_proxy_connection(
    stream: tokio::net::TcpStream,
    handshake_id: u64,
    mut cancelled: oneshot::Receiver<()>,
    state: ProxyConnectionState,
) -> Result<()> {
    let authenticated = Arc::new(Mutex::new(None::<AuthenticatedProxyConnection>));
    let handshake = tokio::select! {
        _ = &mut cancelled => {
            state.pending_handshakes
                .lock()
                .expect("pending handshake pool mutex poisoned")
                .remove(handshake_id);
            return Ok(());
        }
        result = tokio::time::timeout(
            PROXY_HANDSHAKE_TIMEOUT,
            accept_hdr_async(
                stream,
                ProxyHandshakeCallback {
                    authenticated: Arc::clone(&authenticated),
                    state: state.clone(),
                },
            ),
        ) => result,
    };
    state
        .pending_handshakes
        .lock()
        .expect("pending handshake pool mutex poisoned")
        .remove(handshake_id);
    let browser = handshake
        .context("browser WebSocket handshake timed out")?
        .context("browser WebSocket handshake failed")?;
    let authenticated = authenticated
        .lock()
        .expect("proxy connection mutex poisoned")
        .take()
        .context("proxy connection was not authenticated")?;
    let unix = tokio::time::timeout(
        PROXY_HANDSHAKE_TIMEOUT,
        TokioUnixStream::connect(&authenticated.socket_path),
    )
    .await
    .context("app-server Unix socket connection timed out")?
    .with_context(|| format!("failed to connect {}", authenticated.socket_path.display()))?;
    let (app_server, _) = tokio::time::timeout(
        PROXY_HANDSHAKE_TIMEOUT,
        client_async("ws://localhost/rpc", unix),
    )
    .await
    .context("app-server WebSocket handshake timed out")?
    .context("app-server WebSocket handshake failed")?;

    let (mut browser_tx, mut browser_rx) = browser.split();
    let (mut app_server_tx, mut app_server_rx) = app_server.split();
    loop {
        tokio::select! {
            message = browser_rx.next() => match message {
                Some(Ok(message)) => {
                    if app_server_tx.send(message).await.is_err() { break; }
                }
                Some(Err(error)) => return Err(error).context("browser WebSocket read failed"),
                None => break,
            },
            message = app_server_rx.next() => match message {
                Some(Ok(message)) => {
                    if browser_tx.send(message).await.is_err() { break; }
                }
                Some(Err(error)) => return Err(error).context("app-server WebSocket read failed"),
                None => break,
            },
        }
    }
    let _ = browser_tx.close().await;
    let _ = app_server_tx.close().await;
    Ok(())
}

fn validate_proxy_request(
    request: &Request,
    allowed_origin: &str,
    expected_token: &str,
) -> std::result::Result<String, &'static str> {
    let origin = request
        .headers()
        .get("origin")
        .and_then(|value| value.to_str().ok())
        .ok_or("Forbidden")?;
    if origin != allowed_origin && origin != format!("{allowed_origin}/") {
        return Err("Forbidden");
    }
    if request.uri().path() != "/" {
        return Err("Not Found");
    }
    parse_proxy_query(request.uri().query(), expected_token)
}

fn parse_proxy_query(
    query: Option<&str>,
    expected_token: &str,
) -> std::result::Result<String, &'static str> {
    let mut token = None;
    let mut client_id = None;
    for item in query.ok_or("Forbidden")?.split('&') {
        let (key, value) = item.split_once('=').ok_or("Forbidden")?;
        if value.contains('%') || !value.is_ascii() {
            return Err("Forbidden");
        }
        match key {
            "token" if token.is_none() => token = Some(value),
            "clientId" if client_id.is_none() => client_id = Some(value),
            _ => return Err("Forbidden"),
        }
    }
    if !constant_time_eq(
        token.ok_or("Forbidden")?.as_bytes(),
        expected_token.as_bytes(),
    ) {
        return Err("Forbidden");
    }
    normalized_client_id(client_id.map(Value::from).as_ref()).map_err(|_| "Forbidden")
}

fn forbidden_response(message: &'static str) -> ErrorResponse {
    let status = if message == "Not Found" {
        StatusCode::NOT_FOUND
    } else {
        StatusCode::FORBIDDEN
    };
    let mut response = ErrorResponse::new(Some(message.to_string()));
    *response.status_mut() = status;
    response
}

fn unavailable_response() -> ErrorResponse {
    let mut response = ErrorResponse::new(Some("Unavailable".to_string()));
    *response.status_mut() = StatusCode::SERVICE_UNAVAILABLE;
    response
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

fn normalized_client_id(value: Option<&Value>) -> RuntimeResult<String> {
    let client_id = match value {
        None | Some(Value::Null) => "default",
        Some(Value::String(value)) => value.as_str(),
        Some(_) => return Err(RuntimeError::invalid_params("Invalid clientId")),
    };
    if client_id.is_empty()
        || client_id.len() > MAX_CLIENT_ID_BYTES
        || !client_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
    {
        return Err(RuntimeError::invalid_params("Invalid clientId"));
    }
    Ok(client_id.to_string())
}

fn required_string<'a>(params: &'a Value, name: &str) -> RuntimeResult<&'a str> {
    params
        .get(name)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| RuntimeError::invalid_params(format!("Missing required parameter: {name}")))
}

fn validate_asset_file_name(file_name: &str) -> RuntimeResult<()> {
    if file_name.len() > 255
        || file_name == "."
        || file_name == ".."
        || file_name.contains('/')
        || file_name.contains('\\')
        || file_name.contains('\0')
    {
        return Err(RuntimeError::invalid_params(
            "Invalid Chrome tab context asset file name",
        ));
    }
    Ok(())
}

fn validate_openable_file(path: &Path) -> RuntimeResult<()> {
    if !path.is_absolute() {
        return Err(RuntimeError::invalid_params(
            "Local file path must be absolute",
        ));
    }
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| RuntimeError::invalid_params("Local file does not exist"))?;
    if metadata.file_type().is_symlink() {
        return Err(RuntimeError::invalid_params(
            "Opening symbolic links is not supported",
        ));
    }
    if !metadata.is_file() {
        return Err(RuntimeError::invalid_params("Invalid local file path"));
    }
    let forbidden_extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .is_some_and(|extension| {
            matches!(
                extension.as_str(),
                "command" | "desktop" | "jar" | "terminal" | "tool"
            )
        });
    if forbidden_extension || metadata.permissions().mode() & 0o111 != 0 {
        return Err(RuntimeError::invalid_params(
            "Opening executable files is not supported",
        ));
    }
    Ok(())
}

fn prepare_private_dir(path: &Path) -> io::Result<()> {
    fs::create_dir_all(path)?;
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "runtime path is not a directory",
        ));
    }
    let euid = unsafe { libc::geteuid() };
    if metadata.uid() != euid {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "runtime directory has an unexpected owner",
        ));
    }
    if metadata.permissions().mode() & 0o777 != 0o700 {
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn has_unsafe_write_permissions(metadata: &fs::Metadata) -> bool {
    let mode = metadata.permissions().mode();
    if mode & 0o002 != 0 {
        return true;
    }
    mode & 0o020 != 0
}

fn unique_runtime_root() -> PathBuf {
    let uid = unsafe { libc::geteuid() };
    let base = private_runtime_base(uid);
    let nonce = random_hex(8).unwrap_or_else(|_| {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos().to_string())
            .unwrap_or_else(|_| "fallback".to_string())
    });
    let leaf = format!("h-{}-{nonce}", std::process::id());
    let candidate = base.join("cdx-r").join(&leaf);
    if unix_socket_path_fits(&candidate.join("a-0000000000000000.sock")) {
        return candidate;
    }
    PathBuf::from("/tmp")
        .join(format!("cdx-r-{uid}-{nonce}"))
        .join(leaf)
}

fn private_runtime_base(uid: libc::uid_t) -> PathBuf {
    if let Some(path) = env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from) {
        if path.is_absolute()
            && fs::symlink_metadata(&path).is_ok_and(|metadata| {
                metadata.is_dir()
                    && !metadata.file_type().is_symlink()
                    && metadata.uid() == uid
                    && metadata.permissions().mode() & 0o077 == 0
            })
        {
            return path;
        }
    }
    if let Some(home) = env::var_os("HOME").map(PathBuf::from) {
        if home.is_absolute()
            && fs::symlink_metadata(&home).is_ok_and(|metadata| {
                metadata.is_dir() && !metadata.file_type().is_symlink() && metadata.uid() == uid
            })
        {
            return home.join(".cache");
        }
    }
    let nonce = random_hex(16).unwrap_or_else(|_| std::process::id().to_string());
    PathBuf::from("/tmp").join(format!("codex-chrome-runtime-{uid}-{nonce}"))
}

fn random_hex(byte_count: usize) -> io::Result<String> {
    let mut bytes = vec![0_u8; byte_count];
    getrandom::fill(&mut bytes).map_err(io::Error::other)?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn unix_socket_path_fits(path: &Path) -> bool {
    path.as_os_str().as_bytes().len() <= MAX_UNIX_SOCKET_PATH_BYTES
}

fn short_hash(value: &[u8]) -> String {
    hex_encode(Sha256::digest(value).as_slice())[..16].to_string()
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for &byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

fn executable_in_path(name: &str) -> bool {
    env::var_os("PATH").is_some_and(|path| {
        env::split_paths(&path).any(|directory| {
            fs::metadata(directory.join(name)).is_ok_and(|metadata| {
                metadata.is_file() && metadata.permissions().mode() & 0o111 != 0
            })
        })
    })
}

fn display_ip(ip: IpAddr) -> String {
    match ip {
        IpAddr::V4(ip) => ip.to_string(),
        IpAddr::V6(ip) => format!("[{ip}]"),
    }
}

fn runtime_log(message: &str) {
    let _ = writeln!(io::stderr(), "[chrome-runtime] {message}");
}

pub fn is_runtime_request(message: &Value) -> bool {
    message.get("id").is_some()
        && message
            .get("method")
            .and_then(Value::as_str)
            .is_some_and(|method| method.starts_with("codexRuntime/"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpStream as StdTcpStream;
    use std::os::unix::net::UnixListener;

    #[test]
    fn parses_proxy_query_and_rejects_untrusted_inputs() {
        assert_eq!(
            parse_proxy_query(Some("token=secret&clientId=sidepanel-window-42"), "secret"),
            Ok("sidepanel-window-42".to_string())
        );
        assert_eq!(
            parse_proxy_query(Some("token=secret"), "secret"),
            Ok("default".to_string())
        );
        assert!(parse_proxy_query(Some("token=wrong"), "secret").is_err());
        assert!(parse_proxy_query(Some("token=secret&token=secret"), "secret").is_err());
        assert!(parse_proxy_query(Some("token=secret&clientId=../escape"), "secret").is_err());
        assert!(parse_proxy_query(Some("token=secret&extra=value"), "secret").is_err());
        assert!(parse_proxy_query(Some("clientId=default&token=secret"), "secret").is_ok());
        assert!(parse_proxy_query(Some("token=secret&clientId=a%2Fb"), "secret").is_err());
    }

    #[test]
    fn proxy_request_requires_exact_origin_path_and_token() {
        let request = Request::builder()
            .uri("/?token=secret&clientId=sidepanel-window-7")
            .header("origin", "chrome-extension://abcdefghijklmnop")
            .body(())
            .unwrap();
        assert_eq!(
            validate_proxy_request(&request, "chrome-extension://abcdefghijklmnop", "secret"),
            Ok("sidepanel-window-7".to_string())
        );

        let wrong_origin = Request::builder()
            .uri("/?token=secret")
            .header("origin", "https://example.com")
            .body(())
            .unwrap();
        assert!(validate_proxy_request(
            &wrong_origin,
            "chrome-extension://abcdefghijklmnop",
            "secret"
        )
        .is_err());

        let wrong_path = Request::builder()
            .uri("/rpc?token=secret")
            .header("origin", "chrome-extension://abcdefghijklmnop")
            .body(())
            .unwrap();
        assert!(validate_proxy_request(
            &wrong_path,
            "chrome-extension://abcdefghijklmnop",
            "secret"
        )
        .is_err());
    }

    #[test]
    fn authenticated_limit_is_checked_only_after_request_validation() {
        let root = test_root("authenticated-proxy-limit");
        fs::create_dir_all(&root).unwrap();
        let fake_cli = fake_socket_app_server(&root);
        let manager = Arc::new(RuntimeManager::with_runtime_root(
            Some("abcdefghijklmnopabcdefghijklmnop".to_string()),
            root.clone(),
            None,
        ));
        let mut entry = test_entry();
        entry.paths.codex_cli_path = fake_cli;
        entry.paths.codex_home = root.clone();
        let client_id = "sidepanel-window-auth-limit";
        manager
            .ensure_process(
                &entry,
                "abcdefghijklmnopabcdefghijklmnop",
                client_id,
                41000,
                false,
            )
            .unwrap();
        let state = ProxyConnectionState {
            allowed_origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop".to_string(),
            authenticated_permits: Arc::new(Semaphore::new(1)),
            manager: Arc::clone(&manager),
            pending_handshakes: Arc::new(Mutex::new(PendingHandshakePool::default())),
            token: "secret".to_string(),
        };
        let request = |origin: &'static str| {
            Request::builder()
                .uri(format!("/?token=secret&clientId={client_id}"))
                .header("origin", origin)
                .body(())
                .unwrap()
        };

        let first = Arc::new(Mutex::new(None));
        assert!(ProxyHandshakeCallback {
            authenticated: Arc::clone(&first),
            state: state.clone(),
        }
        .on_request(
            &request("chrome-extension://abcdefghijklmnopabcdefghijklmnop"),
            Response::default(),
        )
        .is_ok());

        let invalid = ProxyHandshakeCallback {
            authenticated: Arc::new(Mutex::new(None)),
            state: state.clone(),
        }
        .on_request(&request("https://example.com"), Response::default())
        .unwrap_err();
        assert_eq!(invalid.status(), StatusCode::FORBIDDEN);

        let over_limit = ProxyHandshakeCallback {
            authenticated: Arc::new(Mutex::new(None)),
            state: state.clone(),
        }
        .on_request(
            &request("chrome-extension://abcdefghijklmnopabcdefghijklmnop"),
            Response::default(),
        )
        .unwrap_err();
        assert_eq!(over_limit.status(), StatusCode::SERVICE_UNAVAILABLE);

        drop(
            first
                .lock()
                .expect("proxy connection mutex poisoned")
                .take(),
        );
        let after_release = Arc::new(Mutex::new(None));
        assert!(ProxyHandshakeCallback {
            authenticated: Arc::clone(&after_release),
            state,
        }
        .on_request(
            &request("chrome-extension://abcdefghijklmnopabcdefghijklmnop"),
            Response::default(),
        )
        .is_ok());
        drop(
            after_release
                .lock()
                .expect("proxy connection mutex poisoned")
                .take(),
        );

        manager.shutdown();
    }

    #[test]
    fn proxy_reuses_an_available_port_when_the_requested_port_is_busy() {
        let occupied = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let requested_port = occupied.local_addr().unwrap().port();
        let root = test_root("proxy-port-fallback");
        let manager = Arc::new(RuntimeManager::with_runtime_root(
            Some("abcdefghijklmnopabcdefghijklmnop".to_string()),
            root.clone(),
            None,
        ));
        let mut entry = test_entry();
        entry.proxy_port = requested_port;

        let (first_address, first_token) = manager.ensure_proxy(&entry).unwrap();
        assert_eq!(first_address.ip(), IpAddr::V4(Ipv4Addr::LOCALHOST));
        assert_ne!(first_address.port(), requested_port);
        let (second_address, second_token) = manager.ensure_proxy(&entry).unwrap();
        assert_eq!(second_address, first_address);
        assert_eq!(second_token, first_token);

        manager.shutdown();
        assert!(!root.exists());
    }

    #[test]
    fn authenticated_handshake_displaces_stalled_pre_auth_connections() {
        let root = test_root("proxy-handshake-exhaustion");
        fs::create_dir_all(&root).unwrap();
        let fake_cli = fake_socket_app_server(&root);
        let manager = Arc::new(RuntimeManager::with_runtime_root(
            Some("abcdefghijklmnopabcdefghijklmnop".to_string()),
            root.clone(),
            None,
        ));
        let mut entry = test_entry();
        entry.paths.codex_cli_path = fake_cli;
        entry.paths.codex_home = root.clone();
        entry.proxy_port = 0;
        let (address, token) = manager.ensure_proxy(&entry).unwrap();
        manager
            .ensure_process(
                &entry,
                "abcdefghijklmnopabcdefghijklmnop",
                "sidepanel-window-99",
                address.port(),
                false,
            )
            .unwrap();

        let stalled = (0..MAX_PENDING_HANDSHAKES)
            .map(|_| StdTcpStream::connect(address).unwrap())
            .collect::<Vec<_>>();
        thread::sleep(Duration::from_millis(100));

        let mut legitimate = StdTcpStream::connect(address).unwrap();
        legitimate
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        write!(
            legitimate,
            "GET /?token={token}&clientId=sidepanel-window-99 HTTP/1.1\r\nHost: {address}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nOrigin: chrome-extension://abcdefghijklmnopabcdefghijklmnop\r\n\r\n"
        )
        .unwrap();
        let mut response = [0_u8; 1024];
        let response_len = legitimate.read(&mut response).unwrap_or(0);
        assert!(
            String::from_utf8_lossy(&response[..response_len]).contains("101 Switching Protocols"),
            "legitimate authenticated handshake was not admitted"
        );
        assert_eq!(
            manager
                .processes
                .lock()
                .expect("app-server process mutex poisoned")
                .get("sidepanel-window-99")
                .expect("authenticated app-server process")
                .leases,
            1
        );

        manager.shutdown();
        drop(stalled);
    }

    #[test]
    fn unconnected_processes_are_reclaimed_at_capacity() {
        let root = test_root("unconnected-process-capacity");
        fs::create_dir_all(&root).unwrap();
        let fake_cli = fake_socket_app_server(&root);
        let manager = Arc::new(RuntimeManager::with_runtime_root(
            Some("abcdefghijklmnopabcdefghijklmnop".to_string()),
            root.join("runtime"),
            None,
        ));
        let mut entry = test_entry();
        entry.entry_id = "capacity-entry".to_string();
        entry.paths.codex_cli_path = fake_cli;
        entry.paths.codex_home = root.clone();

        for index in 0..MAX_APP_SERVER_PROCESSES {
            manager
                .ensure_process(
                    &entry,
                    "abcdefghijklmnopabcdefghijklmnop",
                    &format!("sidepanel-window-{index}"),
                    41000,
                    false,
                )
                .unwrap();
        }
        assert!(manager
            .ensure_process(
                &entry,
                "abcdefghijklmnopabcdefghijklmnop",
                "sidepanel-window-over-capacity",
                41000,
                false,
            )
            .is_ok());
        assert_eq!(manager.running_process_count(), MAX_APP_SERVER_PROCESSES);

        manager.shutdown();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unconnected_process_is_reaped_after_its_deadline() {
        let root = test_root("unconnected-process-deadline");
        fs::create_dir_all(&root).unwrap();
        let fake_cli = fake_socket_app_server(&root);
        let manager = Arc::new(RuntimeManager::with_runtime_root_and_timing(
            Some("abcdefghijklmnopabcdefghijklmnop".to_string()),
            root.join("runtime"),
            None,
            test_cleanup_timing(),
        ));
        let mut entry = test_entry();
        entry.paths.codex_cli_path = fake_cli;
        entry.paths.codex_home = root.clone();

        manager
            .ensure_process(
                &entry,
                "abcdefghijklmnopabcdefghijklmnop",
                "sidepanel-window-unconnected",
                41000,
                false,
            )
            .unwrap();
        assert_eq!(manager.running_process_count(), 1);
        wait_for_process_count(&manager, 0);

        manager.shutdown();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reconnect_cancels_pending_process_cleanup() {
        let root = test_root("reconnect-cleanup-race");
        fs::create_dir_all(&root).unwrap();
        let fake_cli = fake_socket_app_server(&root);
        let manager = Arc::new(RuntimeManager::with_runtime_root_and_timing(
            Some("abcdefghijklmnopabcdefghijklmnop".to_string()),
            root.join("runtime"),
            None,
            test_cleanup_timing(),
        ));
        let mut entry = test_entry();
        entry.paths.codex_cli_path = fake_cli;
        entry.paths.codex_home = root.clone();
        let client_id = "sidepanel-window-reconnect";

        manager
            .ensure_process(
                &entry,
                "abcdefghijklmnopabcdefghijklmnop",
                client_id,
                41000,
                false,
            )
            .unwrap();
        let (_, first_lease) = manager.acquire_process_lease(client_id).unwrap();
        drop(first_lease);
        thread::sleep(Duration::from_millis(40));
        let (_, second_lease) = manager.acquire_process_lease(client_id).unwrap();
        thread::sleep(Duration::from_millis(100));
        assert_eq!(manager.running_process_count(), 1);

        drop(second_lease);
        wait_for_process_count(&manager, 0);
        manager.shutdown();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn process_cleanup_waits_for_the_last_connection_lease() {
        let root = test_root("last-connection-cleanup");
        fs::create_dir_all(&root).unwrap();
        let fake_cli = fake_socket_app_server(&root);
        let manager = Arc::new(RuntimeManager::with_runtime_root_and_timing(
            Some("abcdefghijklmnopabcdefghijklmnop".to_string()),
            root.join("runtime"),
            None,
            test_cleanup_timing(),
        ));
        let mut entry = test_entry();
        entry.paths.codex_cli_path = fake_cli;
        entry.paths.codex_home = root.clone();
        let client_id = "sidepanel-window-two-connections";

        manager
            .ensure_process(
                &entry,
                "abcdefghijklmnopabcdefghijklmnop",
                client_id,
                41000,
                false,
            )
            .unwrap();
        let (_, first_lease) = manager.acquire_process_lease(client_id).unwrap();
        let (_, second_lease) = manager.acquire_process_lease(client_id).unwrap();
        drop(first_lease);
        thread::sleep(Duration::from_millis(120));
        assert_eq!(manager.running_process_count(), 1);

        drop(second_lease);
        wait_for_process_count(&manager, 0);
        manager.shutdown();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn active_processes_are_not_evicted_at_capacity() {
        let root = test_root("active-process-capacity");
        fs::create_dir_all(&root).unwrap();
        let fake_cli = fake_socket_app_server(&root);
        let manager = Arc::new(RuntimeManager::with_runtime_root(
            Some("abcdefghijklmnopabcdefghijklmnop".to_string()),
            root.join("runtime"),
            None,
        ));
        let mut entry = test_entry();
        entry.paths.codex_cli_path = fake_cli;
        entry.paths.codex_home = root.clone();
        let mut leases = Vec::new();

        for index in 0..MAX_APP_SERVER_PROCESSES {
            let client_id = format!("sidepanel-window-active-{index}");
            manager
                .ensure_process(
                    &entry,
                    "abcdefghijklmnopabcdefghijklmnop",
                    &client_id,
                    41000,
                    false,
                )
                .unwrap();
            leases.push(manager.acquire_process_lease(&client_id).unwrap().1);
        }
        assert!(manager
            .ensure_process(
                &entry,
                "abcdefghijklmnopabcdefghijklmnop",
                "sidepanel-window-no-idle-capacity",
                41000,
                false,
            )
            .is_err());
        assert_eq!(manager.running_process_count(), MAX_APP_SERVER_PROCESSES);

        drop(leases);
        manager.shutdown();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn stale_lease_cannot_release_a_restarted_process() {
        let root = test_root("stale-process-lease");
        fs::create_dir_all(&root).unwrap();
        let fake_cli = fake_socket_app_server(&root);
        let manager = Arc::new(RuntimeManager::with_runtime_root_and_timing(
            Some("abcdefghijklmnopabcdefghijklmnop".to_string()),
            root.join("runtime"),
            None,
            test_cleanup_timing(),
        ));
        let mut entry = test_entry();
        entry.paths.codex_cli_path = fake_cli;
        entry.paths.codex_home = root.clone();
        let client_id = "sidepanel-window-restart";

        manager
            .ensure_process(
                &entry,
                "abcdefghijklmnopabcdefghijklmnop",
                client_id,
                41000,
                false,
            )
            .unwrap();
        let (_, stale_lease) = manager.acquire_process_lease(client_id).unwrap();
        manager
            .ensure_process(
                &entry,
                "abcdefghijklmnopabcdefghijklmnop",
                client_id,
                41000,
                true,
            )
            .unwrap();
        let (_, current_lease) = manager.acquire_process_lease(client_id).unwrap();
        drop(stale_lease);
        thread::sleep(Duration::from_millis(100));
        assert_eq!(manager.running_process_count(), 1);

        drop(current_lease);
        wait_for_process_count(&manager, 0);
        manager.shutdown();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn shutdown_serializes_with_a_new_process_start() {
        for index in 0..8 {
            let root = test_root(&format!("shutdown-start-race-{index}"));
            fs::create_dir_all(&root).unwrap();
            let fake_cli = fake_socket_app_server(&root);
            let manager = Arc::new(RuntimeManager::with_runtime_root(
                Some("abcdefghijklmnopabcdefghijklmnop".to_string()),
                root.join("runtime"),
                None,
            ));
            let mut entry = test_entry();
            entry.paths.codex_cli_path = fake_cli;
            entry.paths.codex_home = root.clone();
            let worker_manager = Arc::clone(&manager);
            let worker = thread::spawn(move || {
                worker_manager.ensure_process(
                    &entry,
                    "abcdefghijklmnopabcdefghijklmnop",
                    "sidepanel-window-shutdown-race",
                    41000,
                    false,
                )
            });

            manager.shutdown();
            let result = worker.join().unwrap();
            if let Err(error) = result {
                assert_eq!(error.message, "Codex app-server runtime is shutting down");
            }
            assert_eq!(manager.running_process_count(), 0);
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn validates_client_ids() {
        assert_eq!(normalized_client_id(None).unwrap(), "default");
        assert_eq!(
            normalized_client_id(Some(&json!("sidepanel-window-7"))).unwrap(),
            "sidepanel-window-7"
        );
        assert!(normalized_client_id(Some(&json!(""))).is_err());
        assert!(normalized_client_id(Some(&json!("../sidepanel"))).is_err());
        assert!(normalized_client_id(Some(&json!(7))).is_err());
        assert!(normalized_client_id(Some(&json!("a".repeat(MAX_CLIENT_ID_BYTES + 1)))).is_err());
    }

    #[test]
    fn runtime_requests_return_structured_errors_for_bad_input() {
        let manager = Arc::new(RuntimeManager::with_runtime_root(
            Some("abcdefghijklmnopabcdefghijklmnop".to_string()),
            test_root("request-errors"),
            None,
        ));
        let unknown = manager.handle_request(&json!({
            "jsonrpc": "2.0",
            "id": "unknown",
            "method": "codexRuntime/notSupported",
            "params": {}
        }));
        assert_eq!(unknown["error"]["code"], -32601);

        let malformed = manager.handle_request(&json!({
            "jsonrpc": "2.0",
            "id": "malformed",
            "method": "codexRuntime/hello",
            "params": { "constraints": [] }
        }));
        assert_eq!(malformed["error"]["code"], -32602);
        manager.shutdown();
    }

    #[test]
    fn tab_context_asset_lifecycle_is_bounded_and_idempotent() {
        let root = test_root("asset-lifecycle");
        let manager = Arc::new(RuntimeManager::with_runtime_root(None, root.clone(), None));
        let created = manager
            .create_asset(&json!({ "fileName": "capture.txt" }))
            .unwrap();
        let asset_id = created["assetId"].as_str().unwrap();
        let path = PathBuf::from(created["path"].as_str().unwrap());

        manager
            .append_asset(&json!({ "assetId": asset_id, "dataBase64": "aGVsbG8=" }))
            .unwrap();
        let finished = manager
            .finish_asset(&json!({ "assetId": asset_id }))
            .unwrap();
        assert_eq!(finished["path"], created["path"]);
        assert!(manager
            .finish_asset(&json!({ "assetId": asset_id }))
            .is_ok());
        assert_eq!(fs::read(&path).unwrap(), b"hello");
        assert!(manager
            .append_asset(&json!({ "assetId": asset_id, "dataBase64": "IQ==" }))
            .is_err());
        manager
            .remove_asset(&json!({ "assetId": asset_id }))
            .unwrap();
        assert!(!path.exists());
        assert!(manager
            .remove_asset(&json!({ "assetId": asset_id }))
            .is_err());
        manager.shutdown();
        assert!(!root.exists());
    }

    #[test]
    fn tab_context_assets_reject_traversal_and_invalid_base64() {
        let root = test_root("asset-invalid");
        let manager = Arc::new(RuntimeManager::with_runtime_root(None, root, None));
        assert!(manager
            .create_asset(&json!({ "fileName": "../escape.txt" }))
            .is_err());
        let created = manager
            .create_asset(&json!({ "fileName": "safe.txt" }))
            .unwrap();
        assert!(manager
            .append_asset(&json!({
                "assetId": created["assetId"],
                "dataBase64": "not base64"
            }))
            .is_err());
        assert!(manager
            .append_asset(&json!({
                "assetId": created["assetId"],
                "dataBase64": "A".repeat(MAX_ASSET_CHUNK_BASE64 + 1)
            }))
            .is_err());
        {
            let mut assets = manager.assets.lock().unwrap();
            assets
                .get_mut(created["assetId"].as_str().unwrap())
                .unwrap()
                .size = MAX_ASSET_BYTES;
        }
        assert!(manager
            .append_asset(&json!({
                "assetId": created["assetId"],
                "dataBase64": "YQ=="
            }))
            .is_err());
        manager.shutdown();
    }

    #[test]
    fn tab_context_asset_count_is_bounded() {
        let root = test_root("asset-count");
        let manager = Arc::new(RuntimeManager::with_runtime_root(None, root, None));
        for index in 0..MAX_ACTIVE_ASSETS {
            manager
                .create_asset(&json!({ "fileName": format!("capture-{index}.txt") }))
                .unwrap();
        }
        assert!(manager
            .create_asset(&json!({ "fileName": "one-too-many.txt" }))
            .is_err());
        manager.shutdown();
        manager.shutdown();
    }

    #[test]
    fn open_local_file_validation_rejects_symlinks_and_executables() {
        use std::os::unix::fs::symlink;

        let root = test_root("open-file");
        fs::create_dir_all(&root).unwrap();
        let regular = root.join("document.txt");
        fs::write(&regular, "ok").unwrap();
        assert!(validate_openable_file(&regular).is_ok());

        let executable = root.join("run.sh");
        fs::write(&executable, "#!/bin/sh\n").unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
        assert!(validate_openable_file(&executable).is_err());

        let desktop = root.join("launcher.desktop");
        fs::write(&desktop, "[Desktop Entry]\n").unwrap();
        assert!(validate_openable_file(&desktop).is_err());

        let link = root.join("link.txt");
        symlink(&regular, &link).unwrap();
        assert!(validate_openable_file(&link).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn entry_matching_requires_all_protocol_and_identity_constraints() {
        let constraints = test_constraints();
        let entry = test_entry();
        assert!(entry.matches(&constraints));

        let mut wrong_protocol = entry.clone();
        wrong_protocol.app_server_protocol_version = 3;
        assert!(!wrong_protocol.matches(&constraints));

        let mut wrong_extension = entry;
        wrong_extension.extension_ids = vec!["other".to_string()];
        assert!(!wrong_extension.matches(&constraints));
    }

    #[test]
    fn manifest_selection_ignores_newer_entry_for_another_host() {
        let root = test_root("manifest-selection");
        fs::create_dir_all(&root).unwrap();
        let manifest_path = root.join(MANIFEST_FILE_NAME);
        let current_host = env::current_exe().unwrap();
        let other_host = test_executable("true");
        fs::write(
            &manifest_path,
            serde_json::to_vec(&json!({
                "schemaVersion": 2,
                "entries": [
                    manifest_entry_json("other-host", &other_host, "2099-01-01T00:00:00Z"),
                    manifest_entry_json("current-host", &current_host, "2026-07-10T00:00:00Z")
                ]
            }))
            .unwrap(),
        )
        .unwrap();

        let selected = select_runtime_entry(&test_constraints(), Some(&[manifest_path])).unwrap();
        assert_eq!(selected.entry_id, "current-host");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn manifest_selection_reports_missing_invalid_and_no_match() {
        let root = test_root("manifest-errors");
        fs::create_dir_all(&root).unwrap();
        let missing = root.join("missing.json");
        assert_eq!(
            select_runtime_entry(&test_constraints(), Some(&[missing]))
                .unwrap_err()
                .kind,
            Some("manifest_missing")
        );

        let invalid = root.join("invalid.json");
        fs::write(&invalid, "not-json").unwrap();
        assert_eq!(
            select_runtime_entry(&test_constraints(), Some(&[invalid]))
                .unwrap_err()
                .kind,
            Some("manifest_invalid")
        );

        let no_match = root.join("no-match.json");
        let current_host = env::current_exe().unwrap();
        fs::write(
            &no_match,
            serde_json::to_vec(&json!({
                "schemaVersion": 2,
                "entries": [manifest_entry_json(
                    "wrong-extension",
                    &current_host,
                    "2026-07-10T00:00:00Z"
                )]
            }))
            .unwrap(),
        )
        .unwrap();
        let mut constraints = test_constraints();
        constraints.extension_id = "other-extension".to_string();
        assert_eq!(
            select_runtime_entry(&constraints, Some(&[no_match]))
                .unwrap_err()
                .kind,
            Some("no_matching_codex_install")
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn runtime_paths_reject_group_or_world_writable_entries() {
        let root = test_root("path-permissions");
        fs::create_dir_all(&root).unwrap();
        let path = root.join("binary");
        fs::write(&path, "binary").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o770)).unwrap();
        assert!(has_unsafe_write_permissions(&fs::metadata(&path).unwrap()));
        fs::set_permissions(&path, fs::Permissions::from_mode(0o777)).unwrap();
        assert!(has_unsafe_write_permissions(&fs::metadata(&path).unwrap()));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn executable_validation_rejects_a_world_writable_parent() {
        let root = test_root("unsafe-parent");
        let unsafe_parent = root.join("shared");
        fs::create_dir_all(&unsafe_parent).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        fs::set_permissions(&unsafe_parent, fs::Permissions::from_mode(0o777)).unwrap();
        let executable = unsafe_parent.join("codex");
        fs::write(&executable, "binary").unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
        assert!(validate_owned_file(&executable, true).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn executable_validation_returns_the_canonical_path() {
        let root = test_root("canonical-executable");
        let package_dir = root.join("lib/node_modules/@openai/codex/bin");
        let bin_dir = root.join("bin");
        fs::create_dir_all(&package_dir).unwrap();
        fs::create_dir_all(&bin_dir).unwrap();
        for directory in [
            root.clone(),
            root.join("lib"),
            root.join("lib/node_modules"),
            root.join("lib/node_modules/@openai"),
            root.join("lib/node_modules/@openai/codex"),
            package_dir.clone(),
            bin_dir.clone(),
        ] {
            fs::set_permissions(directory, fs::Permissions::from_mode(0o700)).unwrap();
        }
        let executable = package_dir.join("codex.js");
        fs::write(&executable, "#!/usr/bin/env node\n").unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
        let launcher = bin_dir.join("codex");
        std::os::unix::fs::symlink(&executable, &launcher).unwrap();

        assert_eq!(validate_owned_file(&launcher, true).unwrap(), executable);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn executable_validation_rejects_a_group_writable_parent() {
        let root = test_root("group-writable-parent");
        let unsafe_parent = root.join("shared");
        fs::create_dir_all(&unsafe_parent).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        fs::set_permissions(&unsafe_parent, fs::Permissions::from_mode(0o770)).unwrap();
        let executable = unsafe_parent.join("codex");
        fs::write(&executable, "binary").unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();

        assert!(validate_owned_file(&executable, true).is_err());
        assert!(validate_owned_dir(&unsafe_parent, true).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn runtime_paths_reject_an_unsafe_grandparent_directory() {
        let root = test_root("unsafe-grandparent");
        let unsafe_grandparent = root.join("shared");
        let safe_parent = unsafe_grandparent.join("private");
        fs::create_dir_all(&safe_parent).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        fs::set_permissions(&unsafe_grandparent, fs::Permissions::from_mode(0o777)).unwrap();
        fs::set_permissions(&safe_parent, fs::Permissions::from_mode(0o700)).unwrap();
        let executable = safe_parent.join("codex");
        fs::write(&executable, "binary").unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();

        assert!(validate_owned_file(&executable, true).is_err());
        assert!(validate_owned_dir(&safe_parent, true).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn runtime_paths_accept_a_safe_tree_below_root_owned_sticky_tmp() {
        let root = test_root("safe-sticky-ancestor");
        fs::create_dir_all(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let executable = root.join("codex");
        fs::write(&executable, "binary").unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();

        assert!(validate_owned_file(&executable, true).is_ok());
        assert!(validate_owned_dir(&root, true).is_ok());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn socket_readiness_requires_an_owned_unix_socket() {
        let root = test_root("socket-ready");
        fs::create_dir_all(&root).unwrap();
        let regular = root.join("regular.sock");
        fs::write(&regular, "not a socket").unwrap();
        assert!(!socket_is_ready(&regular));

        let socket = root.join("real.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        assert!(socket_is_ready(&socket));
        drop(listener);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn runtime_socket_paths_stay_within_the_linux_sun_path_limit() {
        let root = unique_runtime_root();
        assert!(unix_socket_path_fits(&root.join("a-0000000000000000.sock")));
        assert!(!unix_socket_path_fits(
            &PathBuf::from("/tmp").join("x".repeat(MAX_UNIX_SOCKET_PATH_BYTES))
        ));
    }

    #[test]
    fn process_reuse_requires_the_current_proxy_endpoint() {
        let root = test_root("process-reuse");
        fs::create_dir_all(&root).unwrap();
        let socket = root.join("app-server.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        let mut command = Command::new("sleep");
        command.arg("300");
        unsafe {
            command.pre_exec(|| {
                if libc::setpgid(0, 0) != 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let child = command.spawn().unwrap();
        let process_group = child.id() as libc::pid_t;
        let now = Instant::now();
        let mut process = ManagedProcess {
            child,
            cleanup_deadline: None,
            entry_id: "entry".to_string(),
            instance_id: 1,
            last_touched: now,
            leases: 0,
            process_group,
            proxy_host: "127.0.0.1".to_string(),
            proxy_port: 41000,
            socket_path: socket,
        };
        let entry = test_entry();
        assert!(process_is_reusable(&process, &entry, 41000, false).unwrap());
        assert!(!process_is_reusable(&process, &entry, 41001, false).unwrap());
        assert!(!process_is_reusable(&process, &entry, 41000, true).unwrap());
        stop_managed_process(&mut process);
        drop(listener);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cleanup_terminates_descendants_after_the_group_leader_exits() {
        let root = test_root("exited-leader-descendant");
        fs::create_dir_all(&root).unwrap();
        let descendant_path = root.join("descendant.pid");
        let mut command = Command::new("sh");
        command.arg("-c").arg(format!(
            "trap '' TERM; sleep 300 & printf '%s' $! > '{}'",
            descendant_path.display()
        ));
        unsafe {
            command.pre_exec(|| {
                if libc::setpgid(0, 0) != 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let child = command.spawn().unwrap();
        let process_group = child.id() as libc::pid_t;
        let deadline = Instant::now() + Duration::from_secs(2);
        while !descendant_path.exists() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        let descendant_pid = fs::read_to_string(&descendant_path)
            .unwrap()
            .parse::<libc::pid_t>()
            .unwrap();
        thread::sleep(Duration::from_millis(50));
        let now = Instant::now();
        let mut process = ManagedProcess {
            child,
            cleanup_deadline: None,
            entry_id: "entry".to_string(),
            instance_id: 1,
            last_touched: now,
            leases: 0,
            process_group,
            proxy_host: "127.0.0.1".to_string(),
            proxy_port: 41000,
            socket_path: root.join("unused.sock"),
        };

        stop_managed_process(&mut process);
        let descendant_survived = test_process_is_live(descendant_pid);
        if descendant_survived {
            unsafe {
                libc::kill(descendant_pid, libc::SIGKILL);
            }
        }
        assert!(!descendant_survived, "descendant survived group cleanup");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn desktop_agent_modes_support_current_persisted_state_shape() {
        let root = test_root("agent-modes");
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join(".codex-global-state.json"),
            serde_json::to_vec(&json!({
                "electron-persisted-atom-state": {
                    "agent-mode-by-host-id": { "local": "full-access" },
                    "preferred-non-full-access-agent-mode-by-host-id": { "local": "workspace-write" }
                }
            }))
            .unwrap(),
        )
        .unwrap();
        let defaults = desktop_agent_mode_defaults(&root).unwrap();
        assert_eq!(defaults["agentModesByHostId"]["local"], "full-access");
        assert_eq!(
            defaults["preferredNonFullAccessModesByHostId"]["local"],
            "workspace-write"
        );
        fs::remove_dir_all(root).unwrap();
    }

    fn test_constraints() -> RuntimeConstraints {
        RuntimeConstraints {
            extension_build_channel: "prod".to_string(),
            extension_id: "abcdefghijklmnopabcdefghijklmnop".to_string(),
            extension_version: "1.2.3".to_string(),
            native_host_name: "com.openai.codexextension".to_string(),
            required_app_server_protocol_version: 2,
            required_native_host_protocol_version: 2,
        }
    }

    fn test_entry() -> RuntimeEntry {
        let executable = env::current_exe().unwrap();
        RuntimeEntry {
            schema_version: 2,
            app_server_protocol_version: 2,
            app_version: "1.2.3".to_string(),
            channel: "prod".to_string(),
            cli_version: "1.2.3".to_string(),
            entry_id: "entry".to_string(),
            extension_build_channels: vec!["prod".to_string()],
            extension_ids: vec!["abcdefghijklmnopabcdefghijklmnop".to_string()],
            install_id: "install".to_string(),
            native_host_names: vec!["com.openai.codexextension".to_string()],
            native_host_protocol_version: 2,
            native_host_version: "1.2.3".to_string(),
            paths: RuntimePaths {
                browser_client_path: None,
                codex_cli_path: executable.clone(),
                codex_home: PathBuf::from("/tmp"),
                extension_host_path: executable.clone(),
                node_path: executable,
                node_module_dirs: Vec::new(),
                node_repl_path: None,
                resources_path: PathBuf::from("/tmp"),
            },
            proxy_host: "127.0.0.1".to_string(),
            proxy_port: 0,
            updated_at: "2026-07-10T00:00:00Z".to_string(),
        }
    }

    fn manifest_entry_json(entry_id: &str, extension_host_path: &Path, updated_at: &str) -> Value {
        let executable = env::current_exe().unwrap();
        json!({
            "schemaVersion": 2,
            "appServerProtocolVersion": 2,
            "appVersion": "1.2.3",
            "channel": "prod",
            "cliVersion": "1.2.3",
            "entryId": entry_id,
            "extensionBuildChannels": ["prod"],
            "extensionIds": ["abcdefghijklmnopabcdefghijklmnop"],
            "installId": "install",
            "nativeHostNames": ["com.openai.codexextension"],
            "nativeHostProtocolVersion": 2,
            "nativeHostVersion": "1.2.3",
            "paths": {
                "codexCliPath": executable,
                "codexHome": "/tmp",
                "extensionHostPath": extension_host_path,
                "nodePath": executable,
                "resourcesPath": "/tmp"
            },
            "proxyHost": "127.0.0.1",
            "proxyPort": 0,
            "updatedAt": updated_at
        })
    }

    fn test_root(name: &str) -> PathBuf {
        env::temp_dir().join(format!(
            "chrome-runtime-test-{name}-{}-{}",
            std::process::id(),
            random_hex(4).unwrap()
        ))
    }

    fn test_executable(name: &str) -> PathBuf {
        let path = env::var_os("PATH").expect("PATH is required for runtime tests");
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

    fn fake_socket_app_server(root: &Path) -> PathBuf {
        let path = root.join("fake-app-server.py");
        let python = test_executable("python3");
        fs::write(
            &path,
            format!(
                "#!{}\n{}",
                python.display(),
                r#"
import signal
import socket
import sys
import time

listen = sys.argv[sys.argv.index("--listen") + 1]
socket_path = listen.removeprefix("unix://")
server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
server.bind(socket_path)
server.listen()
signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
while True:
    time.sleep(0.1)
"#
            ),
        )
        .unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        path
    }

    #[test]
    fn app_server_launch_enables_code_mode_host() {
        let root = test_root("app-server-code-mode-host");
        fs::create_dir_all(&root).unwrap();
        let fake_cli = fake_socket_app_server(&root);
        let mut entry = test_entry();
        entry.paths.codex_cli_path = fake_cli;
        entry.paths.codex_home = root.clone();
        let runtime_root = root.join("runtime");

        let mut process = start_app_server(
            &entry,
            "abcdefghijklmnopabcdefghijklmnop",
            "sidepanel-code-mode-host",
            41000,
            &runtime_root,
            1,
            Duration::from_secs(1),
        )
        .unwrap();
        let cmdline = fs::read(format!("/proc/{}/cmdline", process.child.id())).unwrap();
        let args = cmdline
            .split(|byte| *byte == 0)
            .filter(|value| !value.is_empty())
            .map(|value| String::from_utf8(value.to_vec()).unwrap())
            .collect::<Vec<_>>();
        assert!(
            args.windows(3)
                .any(|window| window == ["-c", "features.code_mode_host=true", "app-server"]),
            "app-server command line: {args:?}"
        );

        stop_managed_process(&mut process);
        fs::remove_dir_all(root).unwrap();
    }

    fn test_process_is_live(pid: libc::pid_t) -> bool {
        let Ok(stat) = fs::read_to_string(format!("/proc/{pid}/stat")) else {
            return false;
        };
        stat.rsplit_once(')')
            .and_then(|(_, suffix)| suffix.trim_start().chars().next())
            .is_some_and(|state| state != 'Z')
    }

    fn test_cleanup_timing() -> ProcessCleanupTiming {
        ProcessCleanupTiming {
            disconnected_grace: Duration::from_millis(80),
            reaper_interval: Duration::from_millis(10),
            unconnected_timeout: Duration::from_millis(80),
        }
    }

    fn wait_for_process_count(manager: &RuntimeManager, expected: usize) {
        let deadline = Instant::now() + Duration::from_secs(2);
        while manager.running_process_count() != expected && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(manager.running_process_count(), expected);
    }
}
