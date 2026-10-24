use crate::diagnostics::hydrate_session_bus_env;
use crate::terminal::enrich_terminal_windows;
use crate::windowing::registry::BackendProbe;
use crate::windowing::types::{WindowBounds, WindowInfo};
use anyhow::{bail, Context, Result};
use serde::Deserialize;
use std::{
    fs::{self, OpenOptions},
    io::Write,
    sync::atomic::{AtomicBool, AtomicU64, Ordering},
    sync::mpsc,
    time::Duration,
};
use tokio::time::{sleep, timeout};
use zbus::{
    message::Header,
    names::{BusName, OwnedUniqueName},
    Proxy,
};

pub const KWIN_BACKEND: &str = "kwin";
const KWIN_SCRIPT_TIMEOUT: Duration = Duration::from_secs(2);
const KWIN_SCRIPTING_SERVICE: &str = "org.kde.KWin";
const KWIN_SCRIPTING_OBJECT_PATH: &str = "/Scripting";
const KWIN_SCRIPTING_INTERFACE: &str = "org.kde.kwin.Scripting";
const KWIN_CALLBACK_OBJECT_PATH_PREFIX: &str = "/com/openai/Codex/KWinWindowQuery";
const KWIN_CALLBACK_INTERFACE: &str = "com.openai.Codex.KWinWindowQuery";
static KWIN_PLUGIN_SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub fn probe() -> BackendProbe {
    let check = gdbus_introspect_contains(
        "org.kde.KWin",
        "/Scripting",
        "org.kde.kwin.Scripting",
        "loadScript",
    );
    BackendProbe {
        id: KWIN_BACKEND,
        ok: check.ok,
        can_list_windows: check.ok,
        can_focus_apps: check.ok,
        can_focus_windows: check.ok,
        detail: if check.ok {
            "KWin scripting is available on the session bus".to_string()
        } else {
            format!("KWin scripting unavailable: {}", check.detail)
        },
    }
}

pub async fn list_windows() -> Result<Vec<WindowInfo>> {
    let json = call_kwin_window_script().await?;
    let mut windows = parse_kwin_windows(&json)?;
    enrich_terminal_windows(&mut windows);
    Ok(windows)
}

pub(crate) async fn logical_desktop_rect() -> Result<(i32, i32, i32, i32)> {
    let json = call_kwin_window_script().await?;
    parse_kwin_logical_desktop_rect(&json)
}

pub(crate) async fn element_click_snapshot() -> Result<KwinElementClickSnapshot> {
    let json = call_kwin_window_script().await?;
    KwinElementClickSnapshot::from_json(&json)
}

pub async fn activate_window(window_id: u64) -> Result<()> {
    let uuid = kwin_uuid_for_window_id(window_id).await?.with_context(|| {
        format!("No KWin window matched window_id {window_id} during activation")
    })?;
    call_kwin_activate_script(&uuid).await
}

async fn kwin_uuid_for_window_id(window_id: u64) -> Result<Option<String>> {
    let json = call_kwin_window_script().await?;
    let snapshot = parse_kwin_snapshot(&json)?;
    Ok(snapshot.windows.into_iter().find_map(|window| {
        let uuid = window.kwin_uuid()?;
        (kwin_window_id_from_uuid(&uuid) == window_id).then_some(uuid)
    }))
}

#[derive(Debug, Deserialize)]
struct KwinScriptResult {
    #[serde(default)]
    ok: bool,
    error: Option<String>,
}

async fn call_kwin_activate_script(uuid: &str) -> Result<()> {
    let uuid = uuid.to_string();
    let json = call_kwin_script(
        KwinCallbackKind::Result,
        move |service_name, callback_object_path, plugin_name| {
            write_kwin_activate_script(service_name, callback_object_path, plugin_name, &uuid)
        },
    )
    .await?;
    let result: KwinScriptResult =
        serde_json::from_str(&json).context("failed to parse KWin activation script output")?;

    if result.ok {
        Ok(())
    } else {
        bail!(
            "KWin activation script refused activation: {}",
            result.error.unwrap_or_else(|| "unknown error".to_string())
        );
    }
}

async fn call_kwin_window_script() -> Result<String> {
    call_kwin_script(KwinCallbackKind::Windows, write_kwin_window_script).await
}

async fn call_kwin_script<F>(expected_kind: KwinCallbackKind, write_script: F) -> Result<String>
where
    F: FnOnce(&str, &str, &str) -> Result<std::path::PathBuf>,
{
    hydrate_session_bus_env();

    let connection = timeout(KWIN_SCRIPT_TIMEOUT, zbus::Connection::session())
        .await
        .context("timed out while connecting to the session bus for KWin scripting")?
        .context("failed to connect to session bus")?;

    call_kwin_script_on_connection(connection, expected_kind, write_script, KWIN_SCRIPT_TIMEOUT)
        .await
}

async fn call_kwin_script_on_connection<F>(
    connection: zbus::Connection,
    expected_kind: KwinCallbackKind,
    write_script: F,
    transaction_timeout: Duration,
) -> Result<String>
where
    F: FnOnce(&str, &str, &str) -> Result<std::path::PathBuf>,
{
    call_kwin_script_on_connection_with_plugin_name(
        connection,
        expected_kind,
        write_script,
        transaction_timeout,
        temporary_kwin_plugin_name()?,
    )
    .await
}

async fn call_kwin_script_on_connection_with_plugin_name<F>(
    connection: zbus::Connection,
    expected_kind: KwinCallbackKind,
    write_script: F,
    transaction_timeout: Duration,
    plugin_name: String,
) -> Result<String>
where
    F: FnOnce(&str, &str, &str) -> Result<std::path::PathBuf>,
{
    let unique_name = connection
        .unique_name()
        .context("session bus did not assign a unique name")?
        .to_string();
    let callback_object_path = format!("{KWIN_CALLBACK_OBJECT_PATH_PREFIX}/{plugin_name}");
    let mut cleanup = KwinScriptCleanup::new(
        connection.clone(),
        plugin_name.clone(),
        callback_object_path.clone(),
    );

    let transaction = async {
        let dbus_proxy = zbus::fdo::DBusProxy::new(&connection)
            .await
            .context("failed to create session-bus identity proxy")?;
        let expected_sender = dbus_proxy
            .get_name_owner(BusName::try_from(KWIN_SCRIPTING_SERVICE)?)
            .await
            .context("failed to resolve the KWin session-bus owner")?;
        let (sender, receiver) = mpsc::channel();
        let callback_registered = connection
            .object_server()
            .at(
                callback_object_path.as_str(),
                KwinWindowCallback {
                    sender,
                    expected_sender,
                    expected_kind,
                    plugin_name: plugin_name.clone(),
                    delivered: AtomicBool::new(false),
                },
            )
            .await
            .context("failed to register temporary KWin callback object")?;
        if !callback_registered {
            bail!("temporary KWin callback object path was already registered");
        }
        cleanup.owns_callback = true;

        let path = write_script(&unique_name, &callback_object_path, &plugin_name)?;
        cleanup.script_path = Some(path.clone());
        let scripting_proxy = Proxy::new(
            &connection,
            KWIN_SCRIPTING_SERVICE,
            KWIN_SCRIPTING_OBJECT_PATH,
            KWIN_SCRIPTING_INTERFACE,
        )
        .await
        .context("failed to create KWin scripting proxy")?;

        // Plasma 6 can return 0 here even when isScriptLoaded reports success;
        // the callback below is the authoritative completion signal.
        let _script_id: i32 = scripting_proxy
            .call(
                "loadScript",
                &(path.to_string_lossy().as_ref(), plugin_name.as_str()),
            )
            .await
            .context("KWin loadScript failed")?;

        let _: () = scripting_proxy
            .call("start", &())
            .await
            .context("KWin start failed after loading the temporary script")?;

        loop {
            match receiver.try_recv() {
                Ok(json) => return Ok(json),
                Err(mpsc::TryRecvError::Disconnected) => {
                    bail!("KWin temporary script callback disconnected before returning data");
                }
                Err(mpsc::TryRecvError::Empty) => sleep(Duration::from_millis(20)).await,
            }
        }
    };
    let result = match timeout(transaction_timeout, transaction).await {
        Ok(result) => result,
        Err(_) => Err(anyhow::anyhow!(
            "KWin temporary script transaction timed out"
        )),
    };
    cleanup.run().await;
    result
}

struct KwinScriptCleanup {
    connection: zbus::Connection,
    plugin_name: String,
    callback_object_path: String,
    script_path: Option<std::path::PathBuf>,
    owns_callback: bool,
    armed: bool,
}

impl KwinScriptCleanup {
    fn new(
        connection: zbus::Connection,
        plugin_name: String,
        callback_object_path: String,
    ) -> Self {
        Self {
            connection,
            plugin_name,
            callback_object_path,
            script_path: None,
            owns_callback: false,
            armed: true,
        }
    }

    async fn run(&mut self) {
        cleanup_kwin_script(
            self.connection.clone(),
            self.plugin_name.clone(),
            self.callback_object_path.clone(),
            self.script_path.clone(),
            self.owns_callback,
        )
        .await;
        self.script_path = None;
        self.owns_callback = false;
        self.armed = false;
    }
}

impl Drop for KwinScriptCleanup {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let connection = self.connection.clone();
        let plugin_name = self.plugin_name.clone();
        let callback_object_path = self.callback_object_path.clone();
        let script_path = self.script_path.take();
        let owns_callback = self.owns_callback;
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(cleanup_kwin_script(
                connection,
                plugin_name,
                callback_object_path,
                script_path,
                owns_callback,
            ));
        }
    }
}

async fn cleanup_kwin_script(
    connection: zbus::Connection,
    plugin_name: String,
    callback_object_path: String,
    script_path: Option<std::path::PathBuf>,
    owns_callback: bool,
) {
    if owns_callback {
        let _ = timeout(Duration::from_secs(1), async {
            if let Ok(scripting_proxy) = Proxy::new(
                &connection,
                KWIN_SCRIPTING_SERVICE,
                KWIN_SCRIPTING_OBJECT_PATH,
                KWIN_SCRIPTING_INTERFACE,
            )
            .await
            {
                let _: Result<bool, _> = scripting_proxy
                    .call("unloadScript", &(plugin_name.as_str()))
                    .await;
            }
        })
        .await;
        let _: Result<bool, _> = connection
            .object_server()
            .remove::<KwinWindowCallback, _>(callback_object_path.as_str())
            .await;
    }
    if let Some(script_path) = script_path {
        let _ = fs::remove_file(script_path);
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum KwinCallbackKind {
    Windows,
    Result,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct KwinCallbackEnvelope {
    backend: String,
    plugin_name: String,
}

struct KwinWindowCallback {
    sender: mpsc::Sender<String>,
    expected_sender: OwnedUniqueName,
    expected_kind: KwinCallbackKind,
    plugin_name: String,
    delivered: AtomicBool,
}

impl KwinWindowCallback {
    fn accept(
        &self,
        actual_sender: Option<&str>,
        kind: KwinCallbackKind,
        json: &str,
    ) -> zbus::fdo::Result<()> {
        if actual_sender != Some(self.expected_sender.as_str()) {
            return Err(zbus::fdo::Error::AccessDenied(
                "KWin callback sender did not own org.kde.KWin".to_string(),
            ));
        }
        if kind != self.expected_kind {
            return Err(zbus::fdo::Error::AccessDenied(
                "KWin callback method did not match the requested operation".to_string(),
            ));
        }
        let envelope: KwinCallbackEnvelope = serde_json::from_str(json).map_err(|error| {
            zbus::fdo::Error::InvalidArgs(format!("invalid KWin callback payload: {error}"))
        })?;
        if envelope.backend != KWIN_BACKEND || envelope.plugin_name != self.plugin_name {
            return Err(zbus::fdo::Error::AccessDenied(
                "KWin callback payload did not match the active script".to_string(),
            ));
        }
        if self
            .delivered
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Err(zbus::fdo::Error::AccessDenied(
                "KWin callback response was already delivered".to_string(),
            ));
        }
        self.sender
            .send(json.to_string())
            .map_err(|error| zbus::fdo::Error::Failed(error.to_string()))
    }
}

#[zbus::interface(name = "com.openai.Codex.KWinWindowQuery")]
impl KwinWindowCallback {
    fn receive_windows(
        &self,
        #[zbus(header)] header: Header<'_>,
        json: &str,
    ) -> zbus::fdo::Result<()> {
        self.accept(
            header.sender().map(|sender| sender.as_str()),
            KwinCallbackKind::Windows,
            json,
        )
    }

    fn receive_result(
        &self,
        #[zbus(header)] header: Header<'_>,
        json: &str,
    ) -> zbus::fdo::Result<()> {
        self.accept(
            header.sender().map(|sender| sender.as_str()),
            KwinCallbackKind::Result,
            json,
        )
    }
}

fn temporary_kwin_plugin_name() -> Result<String> {
    let pid = std::process::id();
    let sequence = next_kwin_plugin_sequence(&KWIN_PLUGIN_SEQUENCE)?;
    let mut nonce = [0_u8; 16];
    getrandom::fill(&mut nonce).map_err(|error| {
        anyhow::anyhow!("failed to generate temporary KWin plugin nonce: {error}")
    })?;
    let nonce = nonce
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Ok(format!("codex_kwin_window_query_{pid}_{sequence}_{nonce}"))
}

fn next_kwin_plugin_sequence(counter: &AtomicU64) -> Result<u64> {
    let mut current = counter.load(Ordering::Relaxed);
    loop {
        let next = current
            .checked_add(1)
            .ok_or_else(|| anyhow::anyhow!("temporary KWin plugin sequence exhausted"))?;
        match counter.compare_exchange_weak(current, next, Ordering::Relaxed, Ordering::Relaxed) {
            Ok(_) => return Ok(current),
            Err(observed) => current = observed,
        }
    }
}

fn write_kwin_window_script(
    service_name: &str,
    callback_object_path: &str,
    plugin_name: &str,
) -> Result<std::path::PathBuf> {
    let script = kwin_window_script_source(service_name, callback_object_path, plugin_name)?;
    write_kwin_script_file(plugin_name, &script)
}

fn kwin_window_script_source(
    service_name: &str,
    callback_object_path: &str,
    plugin_name: &str,
) -> Result<String> {
    let service_name = serde_json::to_string(service_name)?;
    let object_path = serde_json::to_string(callback_object_path)?;
    let interface = serde_json::to_string(KWIN_CALLBACK_INTERFACE)?;
    let plugin_name_json = serde_json::to_string(plugin_name)?;
    Ok(format!(
        r#"(function() {{
    var serviceName = {service_name};
    var objectPath = {object_path};
    var iface = {interface};
    var pluginName = {plugin_name_json};

    function read(obj, key) {{
        try {{
            if (obj === null || obj === undefined) {{
                return null;
            }}
            var value = obj[key];
            if (typeof value === "function") {{
                return null;
            }}
            return serialize(value);
        }} catch (error) {{
            return null;
        }}
    }}

    function serialize(value) {{
        if (value === null || value === undefined) {{
            return null;
        }}
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {{
            return value;
        }}
        if (Array.isArray(value)) {{
            return value.map(serialize);
        }}
        try {{
            if (typeof value.toString === "function") {{
                return value.toString();
            }}
        }} catch (error) {{}}
        return null;
    }}

    function rect(obj, key) {{
        var value = null;
        try {{
            value = obj[key];
        }} catch (error) {{}}
        if (value === null || value === undefined) {{
            return null;
        }}
        return {{
            x: read(value, "x"),
            y: read(value, "y"),
            width: read(value, "width"),
            height: read(value, "height")
        }};
    }}

    function geometry(window) {{
        var frame = rect(window, "frameGeometry");
        var x = read(window, "x");
        var y = read(window, "y");
        var width = read(window, "width");
        var height = read(window, "height");
        return {{
            x: x !== null ? x : (frame === null ? null : frame.x),
            y: y !== null ? y : (frame === null ? null : frame.y),
            width: width !== null ? width : (frame === null ? null : frame.width),
            height: height !== null ? height : (frame === null ? null : frame.height)
        }};
    }}

    function outputIdentity(window) {{
        var output = null;
        try {{
            output = window.output;
        }} catch (error) {{}}
        return read(output, "name");
    }}

    function activeOutputs() {{
        var outputs = null;
        try {{
            outputs = workspace.screens;
        }} catch (error) {{}}
        if (outputs === null || outputs === undefined) {{
            try {{
                outputs = workspace.outputs;
            }} catch (error) {{}}
        }}
        if (outputs === null || outputs === undefined) {{
            return [];
        }}
        var active = Array.prototype.filter.call(outputs, function(output) {{
            return read(output, "enabled") !== false;
        }});
        return Array.prototype.map.call(active, function(output) {{
            return {{
                name: read(output, "name"),
                geometry: rect(output, "geometry"),
                devicePixelRatio: read(output, "devicePixelRatio")
            }};
        }});
    }}

    function workspaceGeometry() {{
        var rect = null;
        try {{
            rect = workspace.virtualScreenGeometry;
        }} catch (error) {{}}
        if (rect === null || rect === undefined) {{
            return null;
        }}
        return {{
            x: read(rect, "x"),
            y: read(rect, "y"),
            width: read(rect, "width"),
            height: read(rect, "height")
        }};
    }}

    function firstDesktop(window) {{
        var desktops = read(window, "desktops");
        if (!Array.isArray(desktops) || desktops.length === 0) {{
            return null;
        }}
        var first = desktops[0];
        var parsed = parseInt(first, 10);
        return isFinite(parsed) ? parsed : null;
    }}

    function onCurrentDesktop(window) {{
        // KWin::Window exposes desktops/onAllDesktops, not onCurrentDesktop.
        // Keep the QObject list intact instead of serializing its members.
        if (read(window, "onAllDesktops") === true) {{
            return true;
        }}
        try {{
            var desktops = window.desktops;
            if (desktops === null || desktops === undefined) {{
                return null;
            }}
            if (desktops.length === 0) {{
                return true;
            }}
            var current = typeof workspace.currentDesktopForScreen === "function"
                ? workspace.currentDesktopForScreen(window.output)
                : workspace.currentDesktop;
            var currentId = read(current, "id");
            if (currentId === null) {{
                return null;
            }}
            var unknown = false;
            for (var i = 0; i < desktops.length; ++i) {{
                var id = read(desktops[i], "id");
                if (id === currentId) {{
                    return true;
                }}
                unknown = unknown || id === null;
            }}
            return unknown ? null : false;
        }} catch (error) {{
            return null;
        }}
    }}

    function clientType(window) {{
        if (read(window, "waylandClient")) {{
            return "wayland";
        }}
        if (read(window, "x11Client")) {{
            return "x11";
        }}
        var objectDescription = serialize(window);
        if (typeof objectDescription === "string") {{
            var separator = objectDescription.indexOf("(");
            var objectClass = (separator >= 0
                ? objectDescription.slice(0, separator)
                : objectDescription).trim();
            if (objectClass === "KWin::XdgToplevelWindow") {{
                return "wayland";
            }}
            if (objectClass === "KWin::X11Window") {{
                return "x11";
            }}
        }}
        return null;
    }}

    function listWindows() {{
        try {{
            if (typeof workspace.windowList === "function") {{
                return workspace.windowList();
            }}
        }} catch (error) {{}}
        try {{
            if (typeof workspace.clientList === "function") {{
                return workspace.clientList();
            }}
        }} catch (error) {{}}
        try {{
            if (workspace.stackingOrder && typeof workspace.stackingOrder.length === "number") {{
                return workspace.stackingOrder;
            }}
        }} catch (error) {{}}
        return [];
    }}

    var activeWindow = null;
    try {{
        activeWindow = "activeWindow" in workspace ? workspace.activeWindow : workspace.activeClient;
    }} catch (error) {{}}
    var windows = listWindows().map(function(window) {{
        var geo = geometry(window);
        return {{
            uuid: read(window, "uuid"),
            internalId: read(window, "internalId"),
            caption: read(window, "caption"),
            desktopFile: read(window, "desktopFile"),
            resourceClass: read(window, "resourceClass"),
            resourceName: read(window, "resourceName"),
            windowClass: read(window, "windowClass"),
            pid: read(window, "pid"),
            x: geo.x,
            y: geo.y,
            width: geo.width,
            height: geo.height,
            frameGeometry: rect(window, "frameGeometry"),
            clientGeometry: rect(window, "clientGeometry"),
            output: outputIdentity(window),
            workspace: firstDesktop(window),
            minimized: read(window, "minimized"),
            onCurrentDesktop: onCurrentDesktop(window),
            active: read(window, "active") || window === activeWindow,
            clientType: clientType(window),
            normalWindow: read(window, "normalWindow"),
            dialog: read(window, "dialog"),
            transient: read(window, "transient"),
            managed: read(window, "managed"),
            wantsInput: read(window, "wantsInput"),
            specialWindow: read(window, "specialWindow"),
            popupWindow: read(window, "popupWindow") || read(window, "popupMenu")
                || read(window, "dropdownMenu") || read(window, "tooltip")
                || read(window, "comboBox") || read(window, "menu"),
            desktopWindow: read(window, "desktopWindow"),
            skipTaskbar: read(window, "skipTaskbar"),
            dock: read(window, "dock")
        }};
    }});

    callDBus(serviceName, objectPath, iface, "ReceiveWindows", JSON.stringify({{
        backend: "kwin",
        pluginName: pluginName,
        desktopGeometry: workspaceGeometry(),
        outputs: activeOutputs(),
        windows: windows
    }}));
}})();
"#
    ))
}

fn write_kwin_activate_script(
    service_name: &str,
    callback_object_path: &str,
    plugin_name: &str,
    uuid: &str,
) -> Result<std::path::PathBuf> {
    let script =
        kwin_activate_script_source(service_name, callback_object_path, plugin_name, uuid)?;
    write_kwin_script_file(plugin_name, &script)
}

fn kwin_activate_script_source(
    service_name: &str,
    callback_object_path: &str,
    plugin_name: &str,
    uuid: &str,
) -> Result<String> {
    let target_uuid = normalize_kwin_uuid(uuid).context("KWin activation requires a uuid")?;
    let service_name = serde_json::to_string(service_name)?;
    let object_path = serde_json::to_string(callback_object_path)?;
    let interface = serde_json::to_string(KWIN_CALLBACK_INTERFACE)?;
    let plugin_name_json = serde_json::to_string(plugin_name)?;
    let target_uuid = serde_json::to_string(&target_uuid)?;

    Ok(format!(
        r#"(function() {{
    var serviceName = {service_name};
    var objectPath = {object_path};
    var iface = {interface};
    var pluginName = {plugin_name_json};
    var targetUuid = {target_uuid};

    function send(payload) {{
        payload.backend = "kwin";
        payload.pluginName = pluginName;
        callDBus(serviceName, objectPath, iface, "ReceiveResult", JSON.stringify(payload));
    }}

    function serialize(value) {{
        if (value === null || value === undefined) {{
            return null;
        }}
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {{
            return value;
        }}
        try {{
            if (typeof value.toString === "function") {{
                return value.toString();
            }}
        }} catch (error) {{}}
        return null;
    }}

    function read(obj, key) {{
        try {{
            if (obj === null || obj === undefined) {{
                return null;
            }}
            var value = obj[key];
            if (typeof value === "function") {{
                return null;
            }}
            return serialize(value);
        }} catch (error) {{
            return null;
        }}
    }}

    function normalizeUuid(value) {{
        var text = serialize(value);
        if (text === null || text === undefined) {{
            return null;
        }}
        text = String(text).trim().toLowerCase();
        if (text.charAt(0) === "{{" && text.charAt(text.length - 1) === "}}") {{
            text = text.substring(1, text.length - 1);
        }}
        return text.length > 0 ? text : null;
    }}

    function windowUuid(window) {{
        return normalizeUuid(read(window, "uuid")) || normalizeUuid(read(window, "internalId"));
    }}

    function listWindows() {{
        try {{
            if (typeof workspace.windowList === "function") {{
                return workspace.windowList();
            }}
        }} catch (error) {{}}
        try {{
            if (typeof workspace.clientList === "function") {{
                return workspace.clientList();
            }}
        }} catch (error) {{}}
        try {{
            if (workspace.stackingOrder && typeof workspace.stackingOrder.length === "number") {{
                return workspace.stackingOrder;
            }}
        }} catch (error) {{}}
        return [];
    }}

    function activateDesktop(window) {{
        var desktops = null;
        try {{
            desktops = window.desktops;
        }} catch (error) {{}}
        if (desktops && desktops.length > 0) {{
            try {{
                workspace.currentDesktop = desktops[0];
            }} catch (error) {{}}
        }}
    }}

    try {{
        var targetWindow = null;
        var windows = listWindows();
        for (var i = 0; i < windows.length; i++) {{
            if (windowUuid(windows[i]) === targetUuid) {{
                targetWindow = windows[i];
                break;
            }}
        }}

        if (!targetWindow) {{
            throw new Error("window not found: " + targetUuid);
        }}

        try {{
            targetWindow.minimized = false;
        }} catch (error) {{}}
        activateDesktop(targetWindow);

        var activated = false;
        var activationError = null;
        if ("activeWindow" in workspace) {{
            try {{
                workspace.activeWindow = targetWindow;
                activated = true;
            }} catch (error) {{
                activationError = error;
            }}
        }} else {{
            try {{
                workspace.activeClient = targetWindow;
                activated = true;
            }} catch (error) {{
                activationError = error;
            }}
        }}
        if (!activated) {{
            try {{
                if (typeof targetWindow.activate === "function") {{
                    targetWindow.activate();
                    activated = true;
                }}
            }} catch (error) {{
                activationError = error;
            }}
        }}
        if (!activated) {{
            throw activationError || new Error("workspace refused activeWindow assignment");
        }}

        try {{
            if (typeof workspace.raiseWindow === "function") {{
                workspace.raiseWindow(targetWindow);
            }}
        }} catch (error) {{}}

        send({{
            ok: true,
            uuid: windowUuid(targetWindow)
        }});
    }} catch (error) {{
        send({{
            ok: false,
            error: String(error && error.message ? error.message : error)
        }});
    }}
}})();
"#
    ))
}

fn write_kwin_script_file(plugin_name: &str, script: &str) -> Result<std::path::PathBuf> {
    for attempt in 0..4 {
        let filename = if attempt == 0 {
            format!("{plugin_name}.js")
        } else {
            format!("{plugin_name}-{attempt}.js")
        };
        let path = std::env::temp_dir().join(filename);
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                if let Err(error) = file.write_all(script.as_bytes()) {
                    let _ = fs::remove_file(&path);
                    return Err(error).with_context(|| {
                        format!("failed to write temporary KWin script {}", path.display())
                    });
                }
                return Ok(path);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(error).with_context(|| {
                    format!("failed to create temporary KWin script {}", path.display())
                });
            }
        }
    }

    bail!("failed to create a unique temporary KWin script path for {plugin_name}")
}

fn parse_kwin_windows(json: &str) -> Result<Vec<WindowInfo>> {
    let snapshot = parse_kwin_snapshot(json)?;
    let mut windows = snapshot
        .windows
        .into_iter()
        .filter(element_window)
        .map(WindowInfo::try_from)
        .collect::<Result<Vec<_>>>()?;
    windows.sort_by_key(|window| window.window_id);
    Ok(windows)
}

fn parse_kwin_logical_desktop_rect(json: &str) -> Result<(i32, i32, i32, i32)> {
    parse_kwin_snapshot(json)?.logical_desktop_rect()
}

fn parse_kwin_snapshot(json: &str) -> Result<KwinWindowSnapshot> {
    serde_json::from_str(json).context("failed to parse KWin temporary script output")
}

#[derive(Debug, Deserialize)]
struct KwinWindowSnapshot {
    #[serde(default, rename = "desktopGeometry")]
    desktop_geometry: Option<KwinRawGeometry>,
    #[serde(default)]
    outputs: Vec<KwinRawOutput>,
    windows: Vec<KwinRawWindow>,
}

impl KwinWindowSnapshot {
    fn logical_desktop_rect(&self) -> Result<(i32, i32, i32, i32)> {
        let geometry = self
            .desktop_geometry
            .as_ref()
            .context("KWin did not expose virtualScreenGeometry")?;
        let x = json_value_as_i32(geometry.x.as_ref())
            .context("KWin virtualScreenGeometry x is unavailable")?;
        let y = json_value_as_i32(geometry.y.as_ref())
            .context("KWin virtualScreenGeometry y is unavailable")?;
        let width = json_value_as_i32(geometry.width.as_ref())
            .filter(|width| *width > 0)
            .context("KWin virtualScreenGeometry width is unavailable")?;
        let height = json_value_as_i32(geometry.height.as_ref())
            .filter(|height| *height > 0)
            .context("KWin virtualScreenGeometry height is unavailable")?;
        Ok((x, y, width, height))
    }
}

#[derive(Debug, Deserialize)]
struct KwinRawGeometry {
    x: Option<serde_json::Value>,
    y: Option<serde_json::Value>,
    width: Option<serde_json::Value>,
    height: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct KwinRawOutput {
    name: Option<String>,
    geometry: Option<KwinRawGeometry>,
    device_pixel_ratio: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct KwinRawWindow {
    uuid: Option<String>,
    internal_id: Option<String>,
    caption: Option<String>,
    desktop_file: Option<String>,
    resource_class: Option<String>,
    resource_name: Option<String>,
    window_class: Option<String>,
    pid: Option<serde_json::Value>,
    x: Option<serde_json::Value>,
    y: Option<serde_json::Value>,
    width: Option<serde_json::Value>,
    height: Option<serde_json::Value>,
    frame_geometry: Option<KwinRawGeometry>,
    client_geometry: Option<KwinRawGeometry>,
    output: Option<String>,
    workspace: Option<serde_json::Value>,
    minimized: Option<serde_json::Value>,
    on_current_desktop: Option<serde_json::Value>,
    active: Option<serde_json::Value>,
    client_type: Option<String>,
    normal_window: Option<serde_json::Value>,
    dialog: Option<serde_json::Value>,
    transient: Option<serde_json::Value>,
    managed: Option<serde_json::Value>,
    wants_input: Option<serde_json::Value>,
    special_window: Option<serde_json::Value>,
    popup_window: Option<serde_json::Value>,
    desktop_window: Option<serde_json::Value>,
    skip_taskbar: Option<serde_json::Value>,
    dock: Option<serde_json::Value>,
}

impl KwinRawWindow {
    fn kwin_uuid(&self) -> Option<String> {
        self.uuid
            .as_deref()
            .or(self.internal_id.as_deref())
            .and_then(normalize_kwin_uuid)
    }
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct KwinElementFrame {
    pub(crate) x: i32,
    pub(crate) y: i32,
    pub(crate) width: i32,
    pub(crate) height: i32,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct KwinElementClickTarget {
    pub(crate) window_id: Option<u64>,
    pub(crate) pid: Option<u32>,
    pub(crate) frame: KwinElementFrame,
    pub(crate) center: (i32, i32),
    pub(crate) require_exact_focus: bool,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub(crate) struct KwinElementClickPoint {
    pub(crate) logical: (i32, i32),
    pub(crate) capture: (i32, i32),
}

pub(crate) struct KwinElementClickSnapshot {
    windows: Vec<KwinRawWindow>,
    outputs: Vec<KwinElementOutput>,
}

struct KwinElementOutput {
    name: String,
    geometry: KwinRect,
    device_pixel_ratio: f64,
}

#[derive(Clone, Copy)]
struct KwinRect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

impl KwinRect {
    fn new(x: f64, y: f64, width: f64, height: f64) -> Result<Self> {
        if ![x, y, width, height].into_iter().all(f64::is_finite) || width <= 0.0 || height <= 0.0 {
            anyhow::bail!("geometry must be finite with positive width and height");
        }
        Ok(Self {
            x,
            y,
            width,
            height,
        })
    }

    fn from_raw(geometry: Option<&KwinRawGeometry>, label: &str) -> Result<Self> {
        let geometry = geometry.with_context(|| format!("KWin did not expose {label}"))?;
        Self::new(
            json_value_as_f64(geometry.x.as_ref())
                .with_context(|| format!("KWin {label} x is unavailable"))?,
            json_value_as_f64(geometry.y.as_ref())
                .with_context(|| format!("KWin {label} y is unavailable"))?,
            json_value_as_f64(geometry.width.as_ref())
                .with_context(|| format!("KWin {label} width is unavailable"))?,
            json_value_as_f64(geometry.height.as_ref())
                .with_context(|| format!("KWin {label} height is unavailable"))?,
        )
        .with_context(|| format!("KWin {label} is unusable"))
    }

    fn right(self) -> f64 {
        self.x + self.width
    }

    fn bottom(self) -> f64 {
        self.y + self.height
    }

    fn contains(self, point: (f64, f64)) -> bool {
        point.0 >= self.x && point.0 < self.right() && point.1 >= self.y && point.1 < self.bottom()
    }

    fn overlaps(self, other: Self) -> bool {
        self.x.max(other.x) < self.right().min(other.right())
            && self.y.max(other.y) < self.bottom().min(other.bottom())
    }
}

impl KwinElementClickSnapshot {
    fn from_json(json: &str) -> Result<Self> {
        let snapshot = parse_kwin_snapshot(json)?;
        let outputs = snapshot
            .outputs
            .iter()
            .map(|output| {
                let name = clean_string(output.name.as_deref())
                    .context("KWin output name is unavailable")?;
                let geometry = KwinRect::from_raw(
                    output.geometry.as_ref(),
                    &format!("geometry for output {name}"),
                )?;
                let device_pixel_ratio = json_value_as_f64(output.device_pixel_ratio.as_ref())
                    .with_context(|| {
                        format!("KWin output {name} devicePixelRatio is unavailable")
                    })?;
                if !device_pixel_ratio.is_finite() || device_pixel_ratio <= 0.0 {
                    anyhow::bail!("KWin output {name} has an invalid devicePixelRatio");
                }
                Ok(KwinElementOutput {
                    name,
                    geometry,
                    device_pixel_ratio,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        if outputs.is_empty() {
            anyhow::bail!("KWin did not expose any active outputs");
        }
        Ok(Self {
            windows: snapshot.windows,
            outputs,
        })
    }

    pub(crate) fn map_element_click(
        &self,
        target: &KwinElementClickTarget,
        capture_width: u32,
        capture_height: u32,
    ) -> Result<KwinElementClickPoint> {
        let window = self.associated_window(target)?;
        if target
            .pid
            .is_some_and(|pid| json_value_as_u32(window.pid.as_ref()) != Some(pid))
        {
            anyhow::bail!("cached KWin window identity and AT-SPI root PID disagree");
        }
        if target.require_exact_focus
            && !json_value_as_bool(window.active.as_ref()).unwrap_or(false)
        {
            anyhow::bail!(
                "the explicitly targeted KWin window is not exactly focused; app-only focus is insufficient"
            );
        }
        let window_id = window
            .kwin_uuid()
            .map(|uuid| kwin_window_id_from_uuid(&uuid))
            .context("associated KWin window has no stable identity")?;
        let frame = KwinRect::from_raw(
            window.frame_geometry.as_ref(),
            &format!("frameGeometry for window_id {window_id}"),
        )?;
        let client = KwinRect::from_raw(
            window.client_geometry.as_ref(),
            &format!("clientGeometry for window_id {window_id}"),
        )?;
        let output_name = clean_string(window.output.as_deref())
            .with_context(|| format!("KWin window_id {window_id} has no output identity"))?;
        if self
            .outputs
            .iter()
            .filter(|output| output.name == output_name)
            .count()
            != 1
        {
            anyhow::bail!("KWin window_id {window_id} output identity is missing or ambiguous");
        }
        let global = global_element_point(target, frame, client)?;
        self.capture_point(global, &output_name, capture_width, capture_height)
    }

    fn associated_window(&self, target: &KwinElementClickTarget) -> Result<&KwinRawWindow> {
        let pid = target
            .pid
            .context("cached element has no root PID identity")?;
        if let Some(window_id) = target.window_id {
            let identified = self
                .windows
                .iter()
                .filter(|window| {
                    window
                        .kwin_uuid()
                        .is_some_and(|uuid| kwin_window_id_from_uuid(&uuid) == window_id)
                })
                .collect::<Vec<_>>();
            match identified.as_slice() {
                [window] if json_value_as_u32(window.pid.as_ref()) == Some(pid) => {}
                [_] => anyhow::bail!("cached KWin window identity and AT-SPI root PID disagree"),
                [] => anyhow::bail!("no KWin window matched the cached window identity"),
                _ => anyhow::bail!("cached window identity matched multiple KWin windows"),
            }
        }
        // PID-scoped AT-SPI trees include every window of an application. A
        // requested window or current focus cannot establish which frame owns
        // a selected element. Even hidden same-PID windows can be its owner.
        let candidates = self
            .windows
            .iter()
            .filter(|window| json_value_as_u32(window.pid.as_ref()) == Some(pid))
            .collect::<Vec<_>>();
        let mut matching = Vec::new();
        for window in &candidates {
            let frame =
                KwinRect::from_raw(window.frame_geometry.as_ref(), "candidate frameGeometry")?;
            let client =
                KwinRect::from_raw(window.client_geometry.as_ref(), "candidate clientGeometry")?;
            if !element_coordinate_matches(target, frame, client)?.is_empty() {
                matching.push(*window);
            }
        }
        let window = match matching.as_slice() {
            [window] => *window,
            [] => anyhow::bail!("AT-SPI frame matches neither client-local, global client, nor global decorated KWin geometry for the root PID"),
            _ => anyhow::bail!(
                "AT-SPI frame matches multiple same-PID KWin windows; focus or a requested window_id cannot prove element ownership"
            ),
        };
        if target.window_id.is_some_and(|id| {
            window
                .kwin_uuid()
                .is_none_or(|uuid| kwin_window_id_from_uuid(&uuid) != id)
        }) {
            anyhow::bail!("selected AT-SPI frame belongs to a different KWin window than the cached or requested window identity");
        }
        if !element_window(window) {
            anyhow::bail!(
                "unsupported KWin window type: element mapping requires a normal window, dialog, or verified interactive top-level transient; desktop, dock, and popup windows cannot be mapped by refreshing the snapshot"
            );
        }
        if !visible_element_window(window) {
            anyhow::bail!(
                "associated KWin window is hidden or its current-desktop visibility is unknown"
            );
        }
        Ok(window)
    }

    fn capture_point(
        &self,
        global: (f64, f64),
        window_output: &str,
        capture_width: u32,
        capture_height: u32,
    ) -> Result<KwinElementClickPoint> {
        if capture_width == 0 || capture_height == 0 {
            anyhow::bail!("raw desktop capture is empty");
        }
        let mut names = std::collections::BTreeSet::new();
        if !self
            .outputs
            .iter()
            .all(|output| names.insert(output.name.as_str()))
        {
            anyhow::bail!("KWin active-output identities are ambiguous");
        }
        for (index, output) in self.outputs.iter().enumerate() {
            if self.outputs[index + 1..]
                .iter()
                .any(|other| output.geometry.overlaps(other.geometry))
            {
                anyhow::bail!("overlapping or mirrored KWin outputs are unsupported");
            }
        }
        let union = logical_output_union(&self.outputs)?;
        let scale_x = f64::from(capture_width) / union.width;
        let scale_y = f64::from(capture_height) / union.height;
        if !scale_x.is_finite()
            || !scale_y.is_finite()
            || scale_x <= 0.0
            || scale_y <= 0.0
            || (scale_x - scale_y).abs() > 0.01
        {
            anyhow::bail!("raw capture does not have a finite, positive, uniform desktop scale");
        }
        if let Some(output) = self.outputs.iter().find(|output| {
            (output.device_pixel_ratio - scale_x).abs() > 0.01
                || (output.device_pixel_ratio - scale_y).abs() > 0.01
        }) {
            anyhow::bail!(
                "mixed or unknown KWin output scales are unsupported (output {} DPR {}, capture scale {:.4}x{:.4})",
                output.name,
                output.device_pixel_ratio,
                scale_x,
                scale_y
            );
        }
        let containing = self
            .outputs
            .iter()
            .filter(|output| output.geometry.contains(global))
            .collect::<Vec<_>>();
        let output = match containing.as_slice() {
            [output] => *output,
            [] => anyhow::bail!("mapped element point is outside every active KWin output"),
            _ => anyhow::bail!("mapped element point belongs to multiple KWin outputs"),
        };
        if output.name != window_output {
            anyhow::bail!("mapped element point is not on the associated KWin window's output");
        }
        let logical = (round_coordinate(global.0)?, round_coordinate(global.1)?);
        let capture = (
            round_coordinate((global.0 - union.x) * scale_x)?,
            round_coordinate((global.1 - union.y) * scale_y)?,
        );
        if capture.0 < 0
            || capture.1 < 0
            || capture.0 as u32 >= capture_width
            || capture.1 as u32 >= capture_height
        {
            anyhow::bail!("mapped element point is outside the raw desktop capture");
        }
        Ok(KwinElementClickPoint { logical, capture })
    }
}

fn visible_element_window(window: &KwinRawWindow) -> bool {
    !json_value_as_bool(window.minimized.as_ref()).unwrap_or(false)
        && json_value_as_bool(window.on_current_desktop.as_ref()) == Some(true)
}

fn element_window(window: &KwinRawWindow) -> bool {
    if [
        &window.desktop_window,
        &window.dock,
        &window.popup_window,
        &window.special_window,
    ]
    .into_iter()
    .any(|flag| json_value_as_bool(flag.as_ref()) == Some(true))
    {
        return false;
    }
    // skipTaskbar is a presentation hint. Dialogs and proven interactive
    // transients remain targetable even when they do not have a taskbar entry.
    let dialog = json_value_as_bool(window.dialog.as_ref()) == Some(true);
    let interactive_transient = json_value_as_bool(window.transient.as_ref()) == Some(true)
        && json_value_as_bool(window.managed.as_ref()) == Some(true)
        && json_value_as_bool(window.wants_input.as_ref()) == Some(true)
        && json_value_as_bool(window.special_window.as_ref()) == Some(false)
        && json_value_as_bool(window.popup_window.as_ref()) == Some(false);
    let normal = json_value_as_bool(window.normal_window.as_ref()).unwrap_or(true)
        && !json_value_as_bool(window.skip_taskbar.as_ref()).unwrap_or(false);
    normal || dialog || interactive_transient
}

fn global_element_point(
    target: &KwinElementClickTarget,
    frame: KwinRect,
    client: KwinRect,
) -> Result<(f64, f64)> {
    let mut matches = element_coordinate_matches(target, frame, client)?;
    // Undecorated global client/frame signatures describe the same mapping.
    // Collapse only identical points; tolerance must not hide different ones.
    matches.dedup();
    match matches.as_slice() {
        [point] => Ok(*point),
        [] => anyhow::bail!(
            "AT-SPI frame matches neither client-local, global client, nor global decorated KWin geometry"
        ),
        _ => anyhow::bail!("AT-SPI frame has an ambiguous KWin coordinate signature"),
    }
}

fn element_coordinate_matches(
    target: &KwinElementClickTarget,
    frame: KwinRect,
    client: KwinRect,
) -> Result<Vec<(f64, f64)>> {
    let atspi = KwinRect::new(
        f64::from(target.frame.x),
        f64::from(target.frame.y),
        f64::from(target.frame.width),
        f64::from(target.frame.height),
    )
    .context("AT-SPI frame bounds are unusable")?;
    let center = (f64::from(target.center.0), f64::from(target.center.1));
    if !atspi.contains(center) {
        anyhow::bail!("element center is outside its depth-1 AT-SPI frame");
    }
    let local_origin = near(atspi.x, 0.0) && near(atspi.y, 0.0);
    let client_size = near(atspi.width, client.width) && near(atspi.height, client.height);
    let decorated_size = near(atspi.width, frame.width) && near(atspi.height, frame.height);
    let mut matches = Vec::new();
    if local_origin && client_size {
        matches.push((client.x + center.0 - atspi.x, client.y + center.1 - atspi.y));
    }
    if near(atspi.x, client.x) && near(atspi.y, client.y) && client_size {
        matches.push(center);
    }
    if near(atspi.x, frame.x) && near(atspi.y, frame.y) && decorated_size {
        matches.push(center);
    }
    Ok(matches)
}

fn near(left: f64, right: f64) -> bool {
    (left - right).abs() <= 1.0
}

fn logical_output_union(outputs: &[KwinElementOutput]) -> Result<KwinRect> {
    let first = outputs
        .first()
        .context("KWin active-output list is empty")?
        .geometry;
    let left = outputs
        .iter()
        .fold(first.x, |value, output| value.min(output.geometry.x));
    let top = outputs
        .iter()
        .fold(first.y, |value, output| value.min(output.geometry.y));
    let right = outputs.iter().fold(first.right(), |value, output| {
        value.max(output.geometry.right())
    });
    let bottom = outputs.iter().fold(first.bottom(), |value, output| {
        value.max(output.geometry.bottom())
    });
    KwinRect::new(left, top, right - left, bottom - top).context("KWin output union is unusable")
}

fn round_coordinate(value: f64) -> Result<i32> {
    if !value.is_finite() || value < i32::MIN as f64 || value > i32::MAX as f64 {
        anyhow::bail!("mapped coordinate is not a finite i32");
    }
    Ok(value.round() as i32)
}

impl TryFrom<KwinRawWindow> for WindowInfo {
    type Error = anyhow::Error;

    fn try_from(window: KwinRawWindow) -> Result<Self> {
        let uuid = window
            .kwin_uuid()
            .context("KWin window did not include uuid or internalId")?;
        let width = json_value_as_u32(window.width.as_ref());
        let height = json_value_as_u32(window.height.as_ref());
        let bounds = width.zip(height).map(|(width, height)| WindowBounds {
            x: json_value_as_i32(window.x.as_ref()),
            y: json_value_as_i32(window.y.as_ref()),
            width,
            height,
        });
        let app_id = clean_string(window.desktop_file.as_deref())
            .or_else(|| clean_string(window.resource_class.as_deref()));
        let wm_class = clean_string(window.resource_class.as_deref())
            .or_else(|| clean_string(window.window_class.as_deref()))
            .or_else(|| clean_string(window.resource_name.as_deref()));
        let client_type = clean_string(window.client_type.as_deref());

        Ok(WindowInfo {
            window_id: kwin_window_id_from_uuid(&uuid),
            title: clean_string(window.caption.as_deref()),
            app_id,
            wm_class,
            pid: json_value_as_u32(window.pid.as_ref()),
            bounds,
            workspace: json_value_as_i32(window.workspace.as_ref()),
            focused: json_value_as_bool(window.active.as_ref()).unwrap_or(false),
            hidden: json_value_as_bool(window.minimized.as_ref()).unwrap_or(false),
            client_type,
            backend: KWIN_BACKEND.to_string(),
            terminal: None,
        })
    }
}

fn kwin_window_id_from_uuid(uuid: &str) -> u64 {
    let normalized = normalize_kwin_uuid(uuid).unwrap_or_else(|| uuid.trim().to_ascii_lowercase());
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in normalized.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

fn normalize_kwin_uuid(uuid: &str) -> Option<String> {
    let value = uuid
        .trim()
        .trim_start_matches('{')
        .trim_end_matches('}')
        .trim()
        .to_ascii_lowercase();
    (!value.is_empty()).then_some(value)
}

fn clean_string(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "null")
        .map(ToOwned::to_owned)
}

fn json_value_as_bool(value: Option<&serde_json::Value>) -> Option<bool> {
    match value? {
        serde_json::Value::Bool(value) => Some(*value),
        serde_json::Value::String(value) => match value.to_ascii_lowercase().as_str() {
            "true" => Some(true),
            "false" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

fn json_value_as_u32(value: Option<&serde_json::Value>) -> Option<u32> {
    let value = json_value_as_f64(value)?;
    if !value.is_finite() || value < 0.0 || value > u32::MAX as f64 {
        return None;
    }
    Some(value.round() as u32)
}

fn json_value_as_i32(value: Option<&serde_json::Value>) -> Option<i32> {
    let value = json_value_as_f64(value)?;
    if !value.is_finite() || value < i32::MIN as f64 || value > i32::MAX as f64 {
        return None;
    }
    Some(value.round() as i32)
}

fn json_value_as_f64(value: Option<&serde_json::Value>) -> Option<f64> {
    match value? {
        serde_json::Value::Number(value) => value.as_f64(),
        serde_json::Value::String(value) => value.parse::<f64>().ok(),
        _ => None,
    }
}

struct ProbeCheck {
    ok: bool,
    detail: String,
}

fn gdbus_introspect_contains(
    destination: &str,
    object_path: &str,
    interface: &str,
    member: &str,
) -> ProbeCheck {
    match std::process::Command::new("gdbus")
        .args([
            "introspect",
            "--session",
            "--dest",
            destination,
            "--object-path",
            object_path,
        ])
        .output()
    {
        Ok(output) if output.status.success() => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let needle = format!("{interface}.{member}");
            let ok = stdout.contains(&needle) || stdout.contains(member);
            ProbeCheck {
                ok,
                detail: if ok {
                    format!("{interface}.{member} is present")
                } else {
                    format!("{interface}.{member} not found")
                },
            }
        }
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            ProbeCheck {
                ok: false,
                detail: if stderr.is_empty() { stdout } else { stderr },
            }
        }
        Err(error) => ProbeCheck {
            ok: false,
            detail: error.to_string(),
        },
    }
}

#[cfg(test)]
mod adapter_tests {
    use super::*;

    #[test]
    fn parses_kwin_windows_as_window_info() {
        let uuid = "b4dfacf8-a559-43c9-8b1f-ecd5cfd78359";
        let windows_json = r#"{
          "backend": "kwin",
          "desktopGeometry": {"x": 100, "y": -50, "width": 3840, "height": "2160"},
          "windows": [
            {
              "uuid": "{b4dfacf8-a559-43c9-8b1f-ecd5cfd78359}",
              "caption": "Codex",
              "desktopFile": "codex-desktop",
              "resourceClass": "codex-desktop",
              "resourceName": "codex",
              "pid": 68986,
              "x": 10,
              "y": 48,
              "width": 1200,
              "height": 800,
              "workspace": 1,
              "minimized": false,
              "active": true,
              "clientType": "wayland",
              "normalWindow": true,
              "desktopWindow": false,
              "dock": false
            },
            {
              "uuid": "{11111111-2222-3333-4444-555555555555}",
              "caption": "Desktop",
              "desktopWindow": true
            }
          ]
        }"#;

        let windows = parse_kwin_windows(windows_json).unwrap();

        assert_eq!(windows.len(), 1);
        assert_eq!(windows[0].window_id, kwin_window_id_from_uuid(uuid));
        assert_eq!(windows[0].title.as_deref(), Some("Codex"));
        assert_eq!(windows[0].app_id.as_deref(), Some("codex-desktop"));
        assert_eq!(windows[0].wm_class.as_deref(), Some("codex-desktop"));
        assert_eq!(windows[0].pid, Some(68986));
        assert_eq!(windows[0].bounds.as_ref().unwrap().x, Some(10));
        assert_eq!(windows[0].bounds.as_ref().unwrap().height, 800);
        assert_eq!(windows[0].workspace, Some(1));
        assert!(windows[0].focused);
        assert!(!windows[0].hidden);
        assert_eq!(windows[0].client_type.as_deref(), Some("wayland"));
        assert_eq!(windows[0].backend, KWIN_BACKEND);
        assert_eq!(
            parse_kwin_logical_desktop_rect(windows_json).unwrap(),
            (100, -50, 3840, 2160)
        );
    }

    #[test]
    fn kwin_window_ids_are_stable_across_uuid_formats() {
        let bare = "b4dfacf8-a559-43c9-8b1f-ecd5cfd78359";
        let braced_upper = "{B4DFACF8-A559-43C9-8B1F-ECD5CFD78359}";

        assert_eq!(
            kwin_window_id_from_uuid(bare),
            kwin_window_id_from_uuid(braced_upper)
        );
    }

    #[test]
    fn kwin_plugin_sequence_returns_unique_values_and_rejects_overflow() {
        let counter = AtomicU64::new(u64::MAX - 1);

        assert_eq!(next_kwin_plugin_sequence(&counter).unwrap(), u64::MAX - 1);
        assert_eq!(counter.load(Ordering::Relaxed), u64::MAX);
        assert_eq!(
            next_kwin_plugin_sequence(&counter).unwrap_err().to_string(),
            "temporary KWin plugin sequence exhausted"
        );
        assert_eq!(counter.load(Ordering::Relaxed), u64::MAX);
    }

    #[test]
    fn kwin_window_script_supports_plasma5_and_plasma6_window_apis() {
        let script = kwin_window_script_source(
            ":1.234",
            "/com/openai/Codex/KWinWindowQuery/test",
            "codex_kwin_window_query_test",
        )
        .unwrap();

        assert!(script.contains(r#"typeof workspace.windowList === "function""#));
        assert!(script.contains("workspace.windowList()"));
        assert!(script.contains(r#"typeof workspace.clientList === "function""#));
        assert!(script.contains("workspace.clientList()"));
        assert!(script.contains(
            r#"activeWindow = "activeWindow" in workspace ? workspace.activeWindow : workspace.activeClient;"#
        ));
        assert!(script.contains("workspace.virtualScreenGeometry"));
        assert!(script.contains("desktopGeometry: workspaceGeometry()"));
        assert!(script.contains("var objectDescription = serialize(window)"));
        assert!(script.contains(r#"objectClass === "KWin::XdgToplevelWindow""#));
        assert!(script.contains(r#"objectClass === "KWin::X11Window""#));
        assert!(!script.contains("objectClass: objectClass(window)"));
    }

    #[test]
    fn kwin_activation_script_focuses_window_directly() {
        let script = kwin_activate_script_source(
            ":1.234",
            "/com/openai/Codex/KWinWindowQuery/test",
            "codex_kwin_window_query_test",
            "{B4DFACF8-A559-43C9-8B1F-ECD5CFD78359}",
        )
        .unwrap();

        assert!(script.contains(r#"var targetUuid = "b4dfacf8-a559-43c9-8b1f-ecd5cfd78359";"#));
        assert!(script.contains("targetWindow.minimized = false;"));
        assert!(script.contains("workspace.activeWindow = targetWindow;"));
        assert!(script.contains(r#"typeof workspace.clientList === "function""#));
        assert!(script.contains("workspace.clientList()"));
        assert!(script.contains(r#""activeWindow" in workspace"#));
        assert!(script.contains("workspace.activeClient = targetWindow;"));
        assert!(script.contains(r#""ReceiveResult""#));
        assert!(!script.contains("WindowsRunner"));
    }
}

#[cfg(test)]
mod element_click_tests {
    use super::*;
    use serde_json::{json, Value};

    const UUID: &str = "b4dfacf8-a559-43c9-8b1f-ecd5cfd78359";
    const OTHER_UUID: &str = "11111111-2222-3333-4444-555555555555";
    const PID: u32 = 4242;

    fn rect(x: i32, y: i32, width: i32, height: i32) -> Value {
        json!({"x": x, "y": y, "width": width, "height": height})
    }

    fn output(name: &str, geometry: Value, dpr: Value) -> Value {
        json!({"name": name, "geometry": geometry, "devicePixelRatio": dpr})
    }

    fn window(uuid: &str, frame: Value, client: Value, output: &str) -> Value {
        json!({
            "uuid": uuid,
            "pid": PID,
            "frameGeometry": frame,
            "clientGeometry": client,
            "output": output,
            "active": true,
            "normalWindow": true,
            "minimized": false,
            "onCurrentDesktop": true
        })
    }

    fn snapshot(windows: Vec<Value>, outputs: Vec<Value>) -> KwinElementClickSnapshot {
        KwinElementClickSnapshot::from_json(
            &json!({"backend": "kwin", "windows": windows, "outputs": outputs}).to_string(),
        )
        .unwrap()
    }

    fn target(atspi: [i32; 4], center: (i32, i32)) -> KwinElementClickTarget {
        KwinElementClickTarget {
            window_id: Some(kwin_window_id_from_uuid(UUID)),
            pid: Some(PID),
            frame: KwinElementFrame {
                x: atspi[0],
                y: atspi[1],
                width: atspi[2],
                height: atspi[3],
            },
            center,
            require_exact_focus: false,
        }
    }

    fn reporter_window() -> Value {
        window(
            UUID,
            rect(246, 308, 800, 628),
            rect(246, 336, 800, 600),
            "DP-1",
        )
    }

    #[test]
    fn reporter_menu_center_maps_to_global_logical_and_raw_capture_points() {
        let snapshot = snapshot(
            vec![reporter_window()],
            vec![output("DP-1", rect(0, 0, 2560, 1440), json!(1.5))],
        );

        let point = snapshot
            .map_element_click(&target([0, 0, 800, 600], (32, 16)), 3840, 2160)
            .unwrap();

        assert_eq!(point.logical, (278, 352));
        assert_eq!(point.capture, (417, 528));
    }

    fn dialog_window(caption: &str, skip_taskbar: bool) -> Value {
        let mut dialog = reporter_window();
        dialog["caption"] = json!(caption);
        dialog["normalWindow"] = json!(false);
        dialog["dialog"] = json!(true);
        dialog["transient"] = json!(true);
        dialog["skipTaskbar"] = json!(skip_taskbar);
        dialog
    }

    #[test]
    fn dialog_windows_are_listed_even_when_they_skip_the_taskbar() {
        for caption in ["Save File", "Open File", "Confirm overwrite"] {
            for skip_taskbar in [false, true] {
                let json = json!({"windows": [dialog_window(caption, skip_taskbar)]}).to_string();
                let listed = parse_kwin_windows(&json).unwrap();
                assert_eq!(listed.len(), 1, "{caption}: skipTaskbar={skip_taskbar}");
                assert_eq!(listed[0].title.as_deref(), Some(caption));
            }
        }
    }

    #[test]
    fn dialog_element_clicks_map_even_when_they_skip_the_taskbar() {
        for caption in ["Save File", "Open File", "Confirm overwrite"] {
            for skip_taskbar in [false, true] {
                let snapshot = snapshot(
                    vec![dialog_window(caption, skip_taskbar)],
                    vec![output("DP-1", rect(0, 0, 2560, 1440), json!(1.5))],
                );
                let point = snapshot
                    .map_element_click(&target([0, 0, 800, 600], (32, 16)), 3840, 2160)
                    .unwrap();
                assert_eq!(point.logical, (278, 352));
                assert_eq!(point.capture, (417, 528));
            }
        }
    }

    #[test]
    fn interactive_transients_require_proven_top_level_input_capabilities() {
        let mut transient = dialog_window("Tool window", true);
        transient["dialog"] = json!(false);
        transient["managed"] = json!(true);
        transient["wantsInput"] = json!(true);
        transient["specialWindow"] = json!(false);
        transient["popupWindow"] = json!(false);
        let json = json!({"windows": [transient.clone()]}).to_string();
        assert_eq!(parse_kwin_windows(&json).unwrap().len(), 1);
        let outputs = vec![output("DP-1", rect(0, 0, 2560, 1440), json!(1.5))];
        assert!(snapshot(vec![transient.clone()], outputs.clone())
            .map_element_click(&target([0, 0, 800, 600], (32, 16)), 3840, 2160)
            .is_ok());
        for flag in ["managed", "wantsInput", "specialWindow", "popupWindow"] {
            let mut unproven = transient.clone();
            unproven[flag] = Value::Null;
            assert!(
                parse_kwin_windows(&json!({"windows": [unproven.clone()]}).to_string())
                    .unwrap()
                    .is_empty(),
                "{flag}"
            );
            let error = snapshot(vec![unproven], outputs.clone())
                .map_element_click(&target([0, 0, 800, 600], (32, 16)), 3840, 2160)
                .unwrap_err()
                .to_string();
            assert!(
                error.contains("unsupported KWin window type"),
                "{flag}: {error}"
            );
        }
    }

    #[test]
    fn desktop_dock_special_and_popup_windows_are_neither_listed_nor_mapped() {
        for flag in ["desktopWindow", "dock", "specialWindow", "popupWindow"] {
            let mut excluded = dialog_window("Excluded surface", true);
            excluded[flag] = json!(true);
            assert!(
                parse_kwin_windows(&json!({"windows": [excluded.clone()]}).to_string())
                    .unwrap()
                    .is_empty(),
                "{flag}"
            );
            let snapshot = snapshot(
                vec![excluded],
                vec![output("DP-1", rect(0, 0, 2560, 1440), json!(1.5))],
            );
            let error = snapshot
                .map_element_click(&target([0, 0, 800, 600], (32, 16)), 3840, 2160)
                .unwrap_err()
                .to_string();
            assert!(
                error.contains("unsupported KWin window type"),
                "{flag}: {error}"
            );
        }
    }

    #[test]
    fn same_pid_local_frames_cannot_borrow_focused_or_explicit_window_identity() {
        let first = reporter_window();
        let mut second = window(
            OTHER_UUID,
            rect(1100, 308, 800, 628),
            rect(1100, 336, 800, 600),
            "DP-1",
        );
        second["active"] = json!(false);
        let snapshot = snapshot(
            vec![first, second],
            vec![output("DP-1", rect(0, 0, 2560, 1440), json!(1.5))],
        );
        for window_id in [None, Some(kwin_window_id_from_uuid(UUID))] {
            let mut target = target([0, 0, 800, 600], (32, 16));
            target.window_id = window_id;
            assert!(snapshot.map_element_click(&target, 3840, 2160).is_err());
        }
    }

    #[test]
    fn unknown_or_other_desktop_visibility_never_dispatches() {
        for visibility in [Value::Null, json!(false)] {
            let mut window = reporter_window();
            window["onCurrentDesktop"] = visibility;
            let snapshot = snapshot(
                vec![window],
                vec![output("DP-1", rect(0, 0, 2560, 1440), json!(1.5))],
            );
            assert!(snapshot
                .map_element_click(&target([0, 0, 800, 600], (32, 16)), 3840, 2160)
                .is_err());
        }
    }

    #[test]
    fn equivalent_global_undecorated_signatures_share_one_point() {
        let snapshot = snapshot(
            vec![window(
                UUID,
                rect(100, 100, 200, 200),
                rect(100, 100, 200, 200),
                "DP-1",
            )],
            vec![output("DP-1", rect(0, 0, 1000, 800), json!(1.0))],
        );
        assert_eq!(
            snapshot
                .map_element_click(&target([100, 100, 200, 200], (110, 110)), 1000, 800)
                .unwrap()
                .logical,
            (110, 110)
        );
    }

    #[test]
    fn asymmetric_and_undecorated_frames_use_actual_client_origin() {
        let outputs = vec![output("DP-1", rect(0, 0, 1280, 720), json!(1.0))];
        let asymmetric = snapshot(
            vec![window(
                UUID,
                rect(100, 100, 800, 630),
                rect(110, 130, 780, 600),
                "DP-1",
            )],
            outputs.clone(),
        );
        assert_eq!(
            asymmetric
                .map_element_click(&target([0, 0, 780, 600], (40, 50)), 1280, 720)
                .unwrap(),
            KwinElementClickPoint {
                logical: (150, 180),
                capture: (150, 180)
            }
        );

        let undecorated = snapshot(
            vec![window(
                UUID,
                rect(300, 200, 640, 480),
                rect(300, 200, 640, 480),
                "DP-1",
            )],
            outputs,
        );
        assert_eq!(
            undecorated
                .map_element_click(&target([0, 0, 640, 480], (20, 30)), 1280, 720)
                .unwrap()
                .logical,
            (320, 230)
        );
    }

    #[test]
    fn global_client_and_decorated_frames_do_not_apply_another_offset() {
        let outputs = vec![output("DP-1", rect(0, 0, 2560, 1440), json!(1.5))];
        for atspi in [[246, 336, 800, 600], [246, 308, 800, 628]] {
            let snapshot = snapshot(vec![reporter_window()], outputs.clone());
            let point = snapshot
                .map_element_click(&target(atspi, (300, 400)), 3840, 2160)
                .unwrap();
            assert_eq!(point.logical, (300, 400));
            assert_eq!(point.capture, (450, 600));
        }
    }

    #[test]
    fn signature_tolerance_is_one_logical_pixel_and_fractional_capture_rounds() {
        let tolerant = snapshot(
            vec![window(
                UUID,
                rect(100, 100, 200, 200),
                rect(100, 100, 200, 200),
                "DP-1",
            )],
            vec![output("DP-1", rect(0, 0, 1000, 800), json!(1.25))],
        );
        assert_eq!(
            tolerant
                .map_element_click(&target([1, -1, 201, 199], (10, 10)), 1250, 1000)
                .unwrap()
                .logical,
            (109, 111)
        );

        let rounded = snapshot(
            vec![window(
                UUID,
                rect(100, 100, 200, 200),
                rect(100, 100, 200, 200),
                "DP-1",
            )],
            vec![output("DP-1", rect(0, 0, 1000, 800), json!(1.25))],
        );
        let point = rounded
            .map_element_click(&target([0, 0, 200, 200], (2, 3)), 1250, 1000)
            .unwrap();
        assert_eq!(point.logical, (102, 103));
        assert_eq!(point.capture, (128, 129));
    }

    #[test]
    fn negative_and_second_monitor_origins_are_preserved() {
        let left = output("HDMI-1", rect(-1280, 0, 1280, 1024), json!(1.25));
        let right = output("DP-1", rect(0, 0, 1600, 900), json!(1.25));
        let snapshot = snapshot(
            vec![window(
                UUID,
                rect(-1000, 100, 200, 200),
                rect(-1000, 100, 200, 200),
                "HDMI-1",
            )],
            vec![left, right],
        );

        let point = snapshot
            .map_element_click(&target([0, 0, 200, 200], (10, 20)), 3600, 1280)
            .unwrap();

        assert_eq!(point.logical, (-990, 120));
        assert_eq!(point.capture, (363, 150));
    }

    #[test]
    fn mixed_unknown_and_mismatched_output_scales_fail() {
        let window = reporter_window();
        let mixed = snapshot(
            vec![window.clone()],
            vec![
                output("DP-1", rect(0, 0, 1000, 800), json!(1.25)),
                output("HDMI-1", rect(1000, 0, 1000, 800), json!(1.0)),
            ],
        );
        let error = mixed
            .map_element_click(&target([0, 0, 800, 600], (32, 16)), 2500, 1000)
            .unwrap_err()
            .to_string();
        assert!(error.contains("mixed or unknown"), "{error}");

        let mismatch = snapshot(
            vec![window],
            vec![output("DP-1", rect(0, 0, 1000, 800), json!(1.0))],
        );
        assert!(mismatch
            .map_element_click(&target([0, 0, 800, 600], (32, 16)), 2000, 1600)
            .is_err());

        let error = KwinElementClickSnapshot::from_json(
            &json!({
                "backend": "kwin",
                "windows": [],
                "outputs": [output("DP-1", rect(0, 0, 1000, 800), Value::Null)]
            })
            .to_string(),
        )
        .err()
        .unwrap()
        .to_string();
        assert!(error.contains("devicePixelRatio"), "{error}");
    }

    #[test]
    fn overlap_ambiguous_signature_and_out_of_frame_geometry_fail() {
        let overlap = snapshot(
            vec![reporter_window()],
            vec![
                output("DP-1", rect(0, 0, 2560, 1440), json!(1.5)),
                output("HDMI-1", rect(0, 0, 2560, 1440), json!(1.5)),
            ],
        );
        let error = overlap
            .map_element_click(&target([0, 0, 800, 600], (32, 16)), 3840, 2160)
            .unwrap_err()
            .to_string();
        assert!(error.contains("overlapping or mirrored"), "{error}");

        let ambiguous = snapshot(
            vec![window(
                UUID,
                rect(1, 0, 200, 200),
                rect(1, 0, 200, 200),
                "DP-1",
            )],
            vec![output("DP-1", rect(0, 0, 1000, 800), json!(1.0))],
        );
        let error = ambiguous
            .map_element_click(&target([0, 0, 200, 200], (110, 110)), 1000, 800)
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("ambiguous KWin coordinate signature"),
            "{error}"
        );

        let error = ambiguous
            .map_element_click(&target([0, 0, 200, 200], (250, 10)), 1000, 800)
            .unwrap_err()
            .to_string();
        assert!(error.contains("outside"), "{error}");
        let error = ambiguous
            .map_element_click(&target([50, 50, 20, 20], (55, 55)), 1000, 800)
            .unwrap_err()
            .to_string();
        assert!(error.contains("matches neither"), "{error}");

        let outside_output = snapshot(
            vec![reporter_window()],
            vec![output("DP-1", rect(1000, 1000, 100, 100), json!(1.0))],
        );
        let error = outside_output
            .map_element_click(&target([0, 0, 800, 600], (32, 16)), 100, 100)
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("outside every active KWin output"),
            "{error}"
        );
    }

    #[test]
    fn same_pid_requires_unique_frame_geometry_and_explicit_focus_is_exact() {
        let mut first = window(
            UUID,
            rect(100, 100, 200, 200),
            rect(100, 100, 200, 200),
            "DP-1",
        );
        let mut second = window(
            OTHER_UUID,
            rect(400, 100, 200, 200),
            rect(400, 100, 200, 200),
            "DP-1",
        );
        first["active"] = json!(false);
        second["active"] = json!(false);
        let outputs = vec![output("DP-1", rect(0, 0, 1000, 800), json!(1.0))];
        let ambiguous = snapshot(vec![first.clone(), second.clone()], outputs.clone());
        let mut pid_target = target([0, 0, 200, 200], (10, 10));
        pid_target.window_id = None;
        let error = ambiguous
            .map_element_click(&pid_target, 1000, 800)
            .unwrap_err()
            .to_string();
        assert!(error.contains("multiple same-PID KWin windows"), "{error}");

        second["active"] = json!(true);
        let focused = snapshot(vec![first.clone(), second], outputs.clone());
        let error = focused
            .map_element_click(&pid_target, 1000, 800)
            .unwrap_err()
            .to_string();
        assert!(error.contains("multiple same-PID KWin windows"), "{error}");

        // Equal-size global frames still associate by their distinct origins.
        pid_target.frame.x = 400;
        pid_target.frame.y = 100;
        pid_target.center = (410, 110);
        assert_eq!(
            focused
                .map_element_click(&pid_target, 1000, 800)
                .unwrap()
                .logical,
            (410, 110)
        );
        pid_target.window_id = Some(kwin_window_id_from_uuid(UUID));
        let error = focused
            .map_element_click(&pid_target, 1000, 800)
            .unwrap_err()
            .to_string();
        assert!(error.contains("different KWin window"), "{error}");
        let mut mismatched_identity = target([0, 0, 200, 200], (10, 10));
        mismatched_identity.pid = Some(PID + 1);
        let error = focused
            .map_element_click(&mismatched_identity, 1000, 800)
            .unwrap_err()
            .to_string();
        assert!(error.contains("root PID disagree"), "{error}");

        let not_focused = snapshot(vec![first], outputs);
        let mut exact_target = target([0, 0, 200, 200], (10, 10));
        exact_target.require_exact_focus = true;
        let error = not_focused
            .map_element_click(&exact_target, 1000, 800)
            .unwrap_err()
            .to_string();
        assert!(error.contains("app-only focus is insufficient"), "{error}");
    }

    #[test]
    fn distinct_same_pid_client_sizes_allow_local_frame_association() {
        let first = reporter_window();
        let second = window(
            OTHER_UUID,
            rect(1100, 308, 600, 428),
            rect(1100, 336, 600, 400),
            "DP-1",
        );
        let snapshot = snapshot(
            vec![first, second],
            vec![output("DP-1", rect(0, 0, 2560, 1440), json!(1.5))],
        );
        let mut target = target([0, 0, 600, 400], (32, 16));
        target.window_id = None;
        assert_eq!(
            snapshot
                .map_element_click(&target, 3840, 2160)
                .unwrap()
                .logical,
            (1132, 352)
        );
    }

    #[test]
    fn snapshot_script_reads_only_coherent_frame_client_and_output_metadata() {
        let script = kwin_window_script_source(":1.234", "/callback", "plugin").unwrap();
        for required in [
            "frameGeometry",
            "clientGeometry",
            "outputIdentity",
            "activeOutputs",
            "workspace.screens",
            "read(output, \"enabled\")",
            "devicePixelRatio",
            "outputs: activeOutputs()",
            "dialog: read(window, \"dialog\")",
            "transient: read(window, \"transient\")",
            "read(window, \"popupMenu\")",
            "read(window, \"dropdownMenu\")",
            "read(window, \"tooltip\")",
            "read(window, \"comboBox\")",
            "read(window, \"menu\")",
            "window.desktops",
            "workspace.currentDesktopForScreen(window.output)",
            "read(window, \"onAllDesktops\")",
        ] {
            assert!(script.contains(required), "missing {required}");
        }
        assert!(!script.contains("bufferGeometry"));
        assert!(!script.contains("shadow"));
        assert!(!script.contains("read(window, \"onCurrentDesktop\")"));
    }
}

#[cfg(test)]
mod callback_tests {
    use super::*;

    fn callback() -> (KwinWindowCallback, mpsc::Receiver<String>) {
        let (sender, receiver) = mpsc::channel();
        (
            KwinWindowCallback {
                sender,
                expected_sender: OwnedUniqueName::try_from(":1.42").unwrap(),
                expected_kind: KwinCallbackKind::Windows,
                plugin_name: "codex_kwin_window_query_test".to_string(),
                delivered: AtomicBool::new(false),
            },
            receiver,
        )
    }

    #[test]
    fn callback_accepts_only_the_kwin_owner_requested_method_nonce_and_first_response() {
        let (callback, receiver) = callback();
        let valid =
            r#"{"backend":"kwin","pluginName":"codex_kwin_window_query_test","windows":[]}"#;

        assert!(callback
            .accept(Some(":1.99"), KwinCallbackKind::Windows, valid)
            .is_err());
        assert!(receiver.try_recv().is_err());

        assert!(callback
            .accept(Some(":1.42"), KwinCallbackKind::Result, valid)
            .is_err());
        assert!(receiver.try_recv().is_err());

        for payload in [
            "not-json",
            r#"{"backend":"other","pluginName":"codex_kwin_window_query_test","windows":[]}"#,
            r#"{"backend":"kwin","pluginName":"wrong","windows":[]}"#,
        ] {
            assert!(callback
                .accept(Some(":1.42"), KwinCallbackKind::Windows, payload)
                .is_err());
            assert!(receiver.try_recv().is_err());
        }

        callback
            .accept(Some(":1.42"), KwinCallbackKind::Windows, valid)
            .unwrap();
        assert_eq!(receiver.try_recv().unwrap(), valid);

        assert!(callback
            .accept(Some(":1.42"), KwinCallbackKind::Windows, valid)
            .is_err());
        assert!(receiver.try_recv().is_err());
    }
}

#[cfg(test)]
mod transaction_tests {
    use super::*;
    use std::{
        future::pending,
        io::{BufRead, BufReader},
        process::{Child, Command, Stdio},
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc, Mutex,
        },
        time::Instant,
    };

    #[derive(Clone, Copy)]
    enum FakeKwinBehavior {
        HangLoad,
        HangStart,
        NoCallback,
    }

    struct FakeKwinScripting {
        behavior: FakeKwinBehavior,
        load_calls: Arc<AtomicUsize>,
        start_calls: Arc<AtomicUsize>,
        unload_calls: Arc<AtomicUsize>,
    }

    #[zbus::interface(name = "org.kde.kwin.Scripting")]
    impl FakeKwinScripting {
        #[zbus(name = "loadScript")]
        async fn load_script(&self, _path: &str, _plugin_name: &str) -> i32 {
            self.load_calls.fetch_add(1, Ordering::SeqCst);
            if matches!(self.behavior, FakeKwinBehavior::HangLoad) {
                pending::<()>().await;
            }
            1
        }

        #[zbus(name = "start")]
        async fn start(&self) {
            self.start_calls.fetch_add(1, Ordering::SeqCst);
            if matches!(self.behavior, FakeKwinBehavior::HangStart) {
                pending::<()>().await;
            }
        }

        #[zbus(name = "unloadScript")]
        fn unload_script(&self, _plugin_name: &str) -> bool {
            self.unload_calls.fetch_add(1, Ordering::SeqCst);
            true
        }
    }

    struct TestSessionBus {
        child: Child,
        address: String,
    }

    impl TestSessionBus {
        fn start() -> Self {
            let mut child = Command::new("dbus-daemon")
                .args(["--session", "--nofork", "--nopidfile", "--print-address=1"])
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .expect("start private dbus-daemon");
            let mut address = String::new();
            BufReader::new(child.stdout.take().expect("private bus stdout"))
                .read_line(&mut address)
                .expect("read private bus address");
            assert!(!address.trim().is_empty(), "private bus emitted no address");
            Self {
                child,
                address: address.trim().to_string(),
            }
        }
    }

    impl Drop for TestSessionBus {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }

    async fn assert_transaction_timeout_cleans_up(behavior: FakeKwinBehavior) {
        let bus = TestSessionBus::start();
        let load_calls = Arc::new(AtomicUsize::new(0));
        let start_calls = Arc::new(AtomicUsize::new(0));
        let unload_calls = Arc::new(AtomicUsize::new(0));
        let service_connection = zbus::connection::Builder::address(bus.address.as_str())
            .unwrap()
            .name(KWIN_SCRIPTING_SERVICE)
            .unwrap()
            .serve_at(
                KWIN_SCRIPTING_OBJECT_PATH,
                FakeKwinScripting {
                    behavior,
                    load_calls: Arc::clone(&load_calls),
                    start_calls: Arc::clone(&start_calls),
                    unload_calls: Arc::clone(&unload_calls),
                },
            )
            .unwrap()
            .build()
            .await
            .unwrap();
        let client_connection = zbus::connection::Builder::address(bus.address.as_str())
            .unwrap()
            .build()
            .await
            .unwrap();
        let callback_path = Arc::new(Mutex::new(None::<String>));
        let script_path = Arc::new(Mutex::new(None::<std::path::PathBuf>));
        let callback_path_for_writer = Arc::clone(&callback_path);
        let script_path_for_writer = Arc::clone(&script_path);
        let started = Instant::now();

        let error = call_kwin_script_on_connection(
            client_connection.clone(),
            KwinCallbackKind::Windows,
            move |service_name, object_path, plugin_name| {
                let path = write_kwin_window_script(service_name, object_path, plugin_name)?;
                *callback_path_for_writer.lock().unwrap() = Some(object_path.to_string());
                *script_path_for_writer.lock().unwrap() = Some(path.clone());
                Ok(path)
            },
            Duration::from_millis(100),
        )
        .await
        .unwrap_err();

        assert!(error.to_string().contains("timed out"));
        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(unload_calls.load(Ordering::SeqCst) >= 1);

        let path = script_path.lock().unwrap().clone().unwrap();
        assert!(!path.exists(), "temporary KWin script was not removed");
        let object_path = callback_path.lock().unwrap().clone().unwrap();
        assert!(client_connection
            .object_server()
            .interface::<_, KwinWindowCallback>(object_path.as_str())
            .await
            .is_err());

        drop(service_connection);
        drop(client_connection);
        drop(bus);
    }

    #[tokio::test]
    async fn transaction_times_out_and_cleans_up_when_load_script_never_replies() {
        assert_transaction_timeout_cleans_up(FakeKwinBehavior::HangLoad).await;
    }

    #[tokio::test]
    async fn transaction_times_out_and_cleans_up_when_start_never_replies() {
        assert_transaction_timeout_cleans_up(FakeKwinBehavior::HangStart).await;
    }

    #[tokio::test]
    async fn transaction_times_out_and_cleans_up_when_callback_never_arrives() {
        assert_transaction_timeout_cleans_up(FakeKwinBehavior::NoCallback).await;
    }

    #[tokio::test]
    async fn duplicate_callback_path_fails_without_disturbing_its_owner() {
        let bus = TestSessionBus::start();
        let load_calls = Arc::new(AtomicUsize::new(0));
        let start_calls = Arc::new(AtomicUsize::new(0));
        let unload_calls = Arc::new(AtomicUsize::new(0));
        let service_connection = zbus::connection::Builder::address(bus.address.as_str())
            .unwrap()
            .name(KWIN_SCRIPTING_SERVICE)
            .unwrap()
            .serve_at(
                KWIN_SCRIPTING_OBJECT_PATH,
                FakeKwinScripting {
                    behavior: FakeKwinBehavior::NoCallback,
                    load_calls: Arc::clone(&load_calls),
                    start_calls: Arc::clone(&start_calls),
                    unload_calls: Arc::clone(&unload_calls),
                },
            )
            .unwrap()
            .build()
            .await
            .unwrap();
        let client_connection = zbus::connection::Builder::address(bus.address.as_str())
            .unwrap()
            .build()
            .await
            .unwrap();
        let plugin_name = "codex_kwin_window_query_duplicate";
        let callback_path = format!("{KWIN_CALLBACK_OBJECT_PATH_PREFIX}/{plugin_name}");
        let expected_sender = service_connection.unique_name().unwrap().to_owned();
        let expected_sender_name = expected_sender.to_string();
        let (sender, receiver) = mpsc::channel();
        assert!(client_connection
            .object_server()
            .at(
                callback_path.as_str(),
                KwinWindowCallback {
                    sender,
                    expected_sender,
                    expected_kind: KwinCallbackKind::Windows,
                    plugin_name: plugin_name.to_string(),
                    delivered: AtomicBool::new(false),
                },
            )
            .await
            .unwrap());

        let error = call_kwin_script_on_connection_with_plugin_name(
            client_connection.clone(),
            KwinCallbackKind::Windows,
            |_, _, _| bail!("script writer must not run after a callback collision"),
            Duration::from_millis(100),
            plugin_name.to_string(),
        )
        .await
        .unwrap_err();

        assert!(error.to_string().contains("already registered"));
        assert_eq!(load_calls.load(Ordering::SeqCst), 0);
        assert_eq!(start_calls.load(Ordering::SeqCst), 0);
        assert_eq!(unload_calls.load(Ordering::SeqCst), 0);

        let callback = client_connection
            .object_server()
            .interface::<_, KwinWindowCallback>(callback_path.as_str())
            .await
            .expect("the original callback must remain registered");
        let payload = format!(r#"{{"backend":"kwin","pluginName":"{plugin_name}","windows":[]}}"#);
        callback
            .get()
            .await
            .accept(
                Some(expected_sender_name.as_str()),
                KwinCallbackKind::Windows,
                &payload,
            )
            .unwrap();
        assert_eq!(receiver.try_recv().unwrap(), payload);

        drop(service_connection);
        drop(client_connection);
        drop(bus);
    }
}
