use std::{
    collections::HashMap,
    io::Write,
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};

use anyhow::{bail, Context, Result};
use futures_util::StreamExt;
use tokio::io::{AsyncBufReadExt, BufReader};
use zbus::{
    proxy::{CacheProperties, MethodFlags},
    zvariant::{OwnedObjectPath, OwnedValue, Value},
    Connection, Proxy,
};

const PORTAL_SERVICE: &str = "org.freedesktop.portal.Desktop";
const PORTAL_PATH: &str = "/org/freedesktop/portal/desktop";
const SHORTCUTS_INTERFACE: &str = "org.freedesktop.portal.GlobalShortcuts";
const REQUEST_INTERFACE: &str = "org.freedesktop.portal.Request";
const REMOTE_DESKTOP_INTERFACE: &str = "org.freedesktop.portal.RemoteDesktop";
const GNOME_SERVICE: &str = "org.chatgpt.Community.Dictation";
const GNOME_PATH: &str = "/org/chatgpt/Community/Dictation";
const GNOME_INTERFACE: &str = "org.chatgpt.Community.Dictation1";
const GNOME_TIMEOUT: Duration = Duration::from_secs(2);
const GNOME_GUIDANCE: &str = "Enable the ChatGPT Community dictation GNOME extension (compatible version 1) and try again; RemoteDesktop fallback is disabled";
const SHORTCUT_ID: &str = "global-dictation";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const DEVICE_KEYBOARD: u32 = 1;
const KEY_RELEASED: u32 = 0;
const KEY_PRESSED: u32 = 1;
const KEYSYM_CONTROL_L: i32 = 0xffe3;
const KEYSYM_V: i32 = b'v' as i32;
static REQUEST_NONCE: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PasteBackend {
    RemoteDesktop,
    Gnome,
}

async fn register_host_app_id(connection: &Connection, app_id: &str) -> Result<()> {
    let registry_proxy = Proxy::new(
        connection,
        "org.freedesktop.portal.Desktop",
        "/org/freedesktop/portal/desktop",
        "org.freedesktop.host.portal.Registry",
    )
    .await
    .context("Failed to create portal registry proxy")?;

    let options: HashMap<&str, Value<'_>> = HashMap::new();

    // Register associates this D-Bus connection with your desktop app ID.
    // If it was already registered on this connection, ignore the error.
    let _: Result<(), _> = registry_proxy.call("Register", &(app_id, options)).await;

    Ok(())
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("{error:#}");
        std::process::exit(1);
    }
}

async fn run() -> Result<()> {
    let accelerator = parse_args(std::env::args().skip(1))?;
    let trigger = portal_trigger(&accelerator)?;
    run_portal(&trigger).await
}

fn parse_args(args: impl IntoIterator<Item = String>) -> Result<String> {
    let mut args = args.into_iter();
    let Some(command) = args.next() else {
        bail!("usage: codex-global-dictation-linux portal --accelerator <shortcut>");
    };
    if command != "portal" {
        bail!("unknown command: {command}");
    }

    let mut accelerator = None;
    while let Some(argument) = args.next() {
        match argument.as_str() {
            "--accelerator" => {
                let value = args.next().context("missing --accelerator value")?;
                if accelerator.replace(value).is_some() {
                    bail!("--accelerator may only be provided once");
                }
            }
            _ => bail!("unknown argument: {argument}"),
        }
    }

    let accelerator = accelerator.context("missing --accelerator")?;
    if accelerator.is_empty()
        || accelerator.len() > 128
        || accelerator.chars().any(char::is_control)
    {
        bail!("accelerator must contain between 1 and 128 printable characters");
    }
    Ok(accelerator)
}

fn portal_trigger(accelerator: &str) -> Result<String> {
    let mut modifiers = Vec::new();
    let mut key = None;

    for part in accelerator
        .split('+')
        .map(str::trim)
        .filter(|part| !part.is_empty())
    {
        let normalized = part.to_ascii_lowercase().replace([' ', '_', '-'], "");
        let modifier = match normalized.as_str() {
            "cmdorctrl" | "commandorcontrol" | "control" | "ctrl" => Some("CTRL"),
            "super" | "meta" => Some("LOGO"),
            "alt" => Some("ALT"),
            "shift" => Some("SHIFT"),
            _ => None,
        };
        if let Some(modifier) = modifier {
            if !modifiers.contains(&modifier) {
                modifiers.push(modifier);
            }
            continue;
        }
        if key.replace(portal_key(part)?).is_some() {
            bail!("shortcut must include exactly one non-modifier key");
        }
    }

    let key = key.context("shortcut must include one non-modifier key")?;
    if modifiers.is_empty() {
        bail!("shortcut must include at least one modifier");
    }
    modifiers.push(&key);
    Ok(modifiers.join("+"))
}

fn portal_key(key: &str) -> Result<String> {
    let key = key.trim();
    let punctuation = match key {
        ")" => Some("parenright"),
        "!" => Some("exclam"),
        "@" => Some("at"),
        "#" => Some("numbersign"),
        "$" => Some("dollar"),
        "%" => Some("percent"),
        "^" => Some("asciicircum"),
        "&" => Some("ampersand"),
        "*" => Some("asterisk"),
        "(" => Some("parenleft"),
        ":" => Some("colon"),
        ";" => Some("semicolon"),
        "+" => Some("plus"),
        "=" => Some("equal"),
        "<" => Some("less"),
        "," => Some("comma"),
        "_" => Some("underscore"),
        "-" => Some("minus"),
        ">" => Some("greater"),
        "." => Some("period"),
        "?" => Some("question"),
        "/" => Some("slash"),
        "~" => Some("asciitilde"),
        "`" => Some("grave"),
        "{" => Some("braceleft"),
        "]" => Some("bracketright"),
        "[" => Some("bracketleft"),
        "|" => Some("bar"),
        "\\" => Some("backslash"),
        "}" => Some("braceright"),
        "\"" => Some("quotedbl"),
        _ => None,
    };
    if let Some(punctuation) = punctuation {
        return Ok(punctuation.to_string());
    }

    let normalized = key.to_ascii_lowercase().replace([' ', '-', '/'], "");
    let mapped = match normalized.as_str() {
        "plus" => "plus",
        "space" => "space",
        "tab" => "Tab",
        "capslock" => "Caps_Lock",
        "numlock" => "Num_Lock",
        "scrolllock" => "Scroll_Lock",
        "enter" | "return" => "Return",
        "escape" | "esc" => "Escape",
        "backspace" => "BackSpace",
        "delete" => "Delete",
        "insert" => "Insert",
        "home" => "Home",
        "end" => "End",
        "pageup" => "Page_Up",
        "pagedown" => "Page_Down",
        "left" | "leftarrow" => "Left",
        "right" | "rightarrow" => "Right",
        "up" | "uparrow" => "Up",
        "down" | "downarrow" => "Down",
        "volumeup" => "XF86AudioRaiseVolume",
        "volumedown" => "XF86AudioLowerVolume",
        "volumemute" => "XF86AudioMute",
        "medianexttrack" => "XF86AudioNext",
        "mediaprevioustrack" => "XF86AudioPrev",
        "mediastop" => "XF86AudioStop",
        "mediaplaypause" => "XF86AudioPlay",
        "printscreen" => "Print",
        _ if normalized
            .strip_prefix("num")
            .is_some_and(|suffix| suffix.len() == 1 && suffix.as_bytes()[0].is_ascii_digit()) =>
        {
            return Ok(format!("KP_{}", &normalized[3..]))
        }
        "numdec" => "KP_Decimal",
        "numadd" => "KP_Add",
        "numsub" => "KP_Subtract",
        "nummult" => "KP_Multiply",
        "numdiv" => "KP_Divide",
        _ if normalized.len() == 1 && normalized.chars().all(|ch| ch.is_ascii_alphanumeric()) => {
            return Ok(normalized)
        }
        _ if normalized
            .strip_prefix('f')
            .and_then(|digits| digits.parse::<u8>().ok())
            .is_some_and(|number| (1..=35).contains(&number)) =>
        {
            return Ok(normalized.to_ascii_uppercase())
        }
        _ => bail!("unsupported portal shortcut key: {key}"),
    };
    Ok(mapped.to_string())
}

async fn run_portal(trigger: &str) -> Result<()> {
    let connection = Connection::session()
        .await
        .context("failed to connect to the session bus")?;
    run_portal_on(&connection, trigger).await
}

async fn run_portal_on(connection: &Connection, trigger: &str) -> Result<()> {
    let proxy = Proxy::new(connection, PORTAL_SERVICE, PORTAL_PATH, SHORTCUTS_INTERFACE)
        .await
        .context("GlobalShortcuts portal is unavailable")?;
    let version: u32 = proxy
        .get_property("version")
        .await
        .context("GlobalShortcuts portal version is unavailable")?;
    if version < 1 {
        bail!("GlobalShortcuts portal version {version} is unsupported");
    }

    let session = create_session(connection, &proxy).await?;
    if let Err(error) = bind_shortcut(connection, &proxy, &session, trigger).await {
        close_session(connection, &session).await;
        return Err(error);
    }

    let mut activated = proxy
        .receive_signal("Activated")
        .await
        .context("failed to subscribe to shortcut activation")?;
    let mut deactivated = proxy
        .receive_signal("Deactivated")
        .await
        .context("failed to subscribe to shortcut deactivation")?;

    let backend = detect_paste_backend(connection).await;
    emit("ready")?;
    let mut pressed = false;
    let mut commands = BufReader::new(tokio::io::stdin()).lines();
    let mut paste_session = None;
    loop {
        tokio::select! {
            message = activated.next() => {
                let message = message.context("shortcut activation stream ended")?;
                if signal_matches(&message, &session)? && !pressed {
                    pressed = true;
                    emit("down")?;
                }
            }
            message = deactivated.next() => {
                let message = message.context("shortcut deactivation stream ended")?;
                if signal_matches(&message, &session)? && pressed {
                    pressed = false;
                    emit("up")?;
                }
            }
            command = commands.next_line() => {
                match command.context("failed to read helper command")? {
                    Some(command) if command == "paste" => {
                        let result = paste_with_backend(connection, &mut paste_session, backend).await;
                        match result {
                            Ok(()) => emit("paste-ok")?,
                            Err(error) => {
                                if let Some(session) = paste_session.take() {
                                    close_session(connection, &session).await;
                                }
                                emit_error("paste-error", &error)?;
                            }
                        }
                    }
                    Some(command) if command.trim().is_empty() => {}
                    Some(_) => emit("command-error:unsupported command")?,
                    None => break,
                }
            }
            _ = tokio::signal::ctrl_c() => break,
        }
    }
    if let Some(session) = paste_session {
        close_session(connection, &session).await;
    }
    close_session(connection, &session).await;
    Ok(())
}

async fn detect_paste_backend(connection: &Connection) -> PasteBackend {
    // Discovery never activates the extension or requests input permissions.
    // Keep this choice for the helper lifetime to avoid unexpected consent prompts.
    match tokio::time::timeout(GNOME_TIMEOUT, probe_gnome_companion(connection)).await {
        Ok(Ok(_)) => PasteBackend::Gnome,
        _ => PasteBackend::RemoteDesktop,
    }
}

async fn paste_with_backend(
    connection: &Connection,
    session: &mut Option<OwnedObjectPath>,
    backend: PasteBackend,
) -> Result<()> {
    match backend {
        PasteBackend::RemoteDesktop => paste_through_portal(connection, session).await,
        PasteBackend::Gnome => paste_through_gnome(connection)
            .await
            .context(GNOME_GUIDANCE),
    }
}

async fn probe_gnome_companion(connection: &Connection) -> Result<Proxy<'_>> {
    // GetNameOwner does not activate services. Pin both calls to this owner so a
    // replacement cannot receive Paste after a different owner's version check.
    let bus = zbus::fdo::DBusProxy::new(connection).await?;
    let owner = bus
        .get_name_owner(GNOME_SERVICE.try_into()?)
        .await
        .context("GNOME dictation companion is unavailable")?;
    let proxy: Proxy<'_> = zbus::proxy::Builder::new(connection)
        .destination(owner)?
        .path(GNOME_PATH)?
        .interface(GNOME_INTERFACE)?
        .cache_properties(CacheProperties::No)
        .build()
        .await?;
    let version: u32 = proxy
        .call_with_flags("GetVersion", MethodFlags::NoAutoStart.into(), &())
        .await
        .context("GNOME dictation companion version probe failed")?
        .context("GNOME dictation companion returned no version reply")?;
    if version != 1 {
        bail!("GNOME dictation companion version {version} is unsupported (expected 1)");
    }
    Ok(proxy)
}

async fn paste_through_gnome(connection: &Connection) -> Result<()> {
    let proxy = tokio::time::timeout(GNOME_TIMEOUT, probe_gnome_companion(connection))
        .await
        .context("GNOME dictation companion probe timed out")??;
    // Never retry: a timeout or error may occur after input was already submitted.
    let reply: Option<()> = tokio::time::timeout(
        GNOME_TIMEOUT,
        proxy.call_with_flags("Paste", MethodFlags::NoAutoStart.into(), &()),
    )
    .await
    .context("GNOME dictation Paste timed out; input may already have been submitted")?
    .context("GNOME dictation Paste failed; input may already have been submitted")?;
    reply.context("GNOME dictation companion returned no Paste reply")?;
    // Success acknowledges event submission, not delivery to the focused app.
    Ok(())
}

async fn paste_through_portal(
    connection: &Connection,
    session: &mut Option<OwnedObjectPath>,
) -> Result<()> {
    if session.is_none() {
        *session = Some(start_remote_desktop_keyboard_session(connection).await?);
    }
    let session = session.as_ref().context("paste session was not created")?;
    let proxy = Proxy::new(
        connection,
        PORTAL_SERVICE,
        PORTAL_PATH,
        REMOTE_DESKTOP_INTERFACE,
    )
    .await
    .context("RemoteDesktop portal is unavailable")?;
    let options: HashMap<&str, Value<'_>> = HashMap::new();
    for (keysym, state) in [
        (KEYSYM_CONTROL_L, KEY_PRESSED),
        (KEYSYM_V, KEY_PRESSED),
        (KEYSYM_V, KEY_RELEASED),
        (KEYSYM_CONTROL_L, KEY_RELEASED),
    ] {
        let _: () = proxy
            .call("NotifyKeyboardKeysym", &(session, &options, keysym, state))
            .await
            .context("RemoteDesktop keyboard input failed")?;
    }
    Ok(())
}

async fn start_remote_desktop_keyboard_session(connection: &Connection) -> Result<OwnedObjectPath> {
    let proxy = Proxy::new(
        connection,
        PORTAL_SERVICE,
        PORTAL_PATH,
        REMOTE_DESKTOP_INTERFACE,
    )
    .await
    .context("RemoteDesktop portal is unavailable")?;
    let session = create_remote_desktop_session(connection, &proxy).await?;
    if let Err(error) = async {
        select_remote_desktop_keyboard(connection, &proxy, &session).await?;
        start_remote_desktop_session(connection, &proxy, &session).await
    }
    .await
    {
        close_session(connection, &session).await;
        return Err(error);
    }
    Ok(session)
}

async fn create_remote_desktop_session(
    connection: &Connection,
    proxy: &Proxy<'_>,
) -> Result<OwnedObjectPath> {
    // Register the app ID before invoking any portal methods.
    // The string MUST match the basename of your .desktop file (e.g., "codex-desktop")
    let app_id = std::env::var("CHROME_DESKTOP")
        .unwrap_or_else(|_| "codex-desktop".to_string())
        .replace(".desktop", "");

    register_host_app_id(connection, &app_id).await?;

    let (request_path, mut response_stream) =
        portal_request_stream(connection, "paste_create").await?;
    let session_token = request_token("paste_session");
    let mut options: HashMap<&str, Value<'_>> = HashMap::new();
    options.insert(
        "handle_token",
        Value::from(last_path_component(&request_path)),
    );
    options.insert("session_handle_token", Value::from(session_token.as_str()));
    let handle: OwnedObjectPath = proxy
        .call("CreateSession", &(options))
        .await
        .context("RemoteDesktop CreateSession failed")?;
    let (response_code, results) =
        await_portal_response(connection, handle, &request_path, &mut response_stream).await?;
    if response_code != 0 {
        bail!("RemoteDesktop session was denied or cancelled with response code {response_code}");
    }
    let session_handle: String = results
        .get("session_handle")
        .context("RemoteDesktop CreateSession response did not include session_handle")?
        .try_clone()
        .context("failed to clone RemoteDesktop session_handle")?
        .try_into()
        .context("RemoteDesktop session_handle was not a string")?;
    OwnedObjectPath::try_from(session_handle)
        .context("RemoteDesktop session_handle was not a valid object path")
}

async fn select_remote_desktop_keyboard(
    connection: &Connection,
    proxy: &Proxy<'_>,
    session: &OwnedObjectPath,
) -> Result<()> {
    let (request_path, mut response_stream) =
        portal_request_stream(connection, "paste_devices").await?;
    let mut options: HashMap<&str, Value<'_>> = HashMap::new();
    options.insert(
        "handle_token",
        Value::from(last_path_component(&request_path)),
    );
    options.insert("types", Value::from(DEVICE_KEYBOARD));
    let handle: OwnedObjectPath = proxy
        .call("SelectDevices", &(session, options))
        .await
        .context("RemoteDesktop SelectDevices failed")?;
    let (response_code, _) =
        await_portal_response(connection, handle, &request_path, &mut response_stream).await?;
    if response_code != 0 {
        bail!("RemoteDesktop keyboard access was denied or cancelled with response code {response_code}");
    }
    Ok(())
}

async fn start_remote_desktop_session(
    connection: &Connection,
    proxy: &Proxy<'_>,
    session: &OwnedObjectPath,
) -> Result<()> {
    let (request_path, mut response_stream) =
        portal_request_stream(connection, "paste_start").await?;
    let mut options: HashMap<&str, Value<'_>> = HashMap::new();
    options.insert(
        "handle_token",
        Value::from(last_path_component(&request_path)),
    );
    let handle: OwnedObjectPath = proxy
        .call("Start", &(session, "", options))
        .await
        .context("RemoteDesktop Start failed")?;
    let (response_code, results) =
        await_portal_response(connection, handle, &request_path, &mut response_stream).await?;
    if response_code != 0 {
        bail!("RemoteDesktop session was denied or cancelled with response code {response_code}");
    }
    let devices = results
        .get("devices")
        .and_then(|value| u32::try_from(value).ok())
        .unwrap_or_default();
    if devices & DEVICE_KEYBOARD == 0 {
        bail!("RemoteDesktop session started without keyboard access");
    }
    Ok(())
}

async fn create_session(connection: &Connection, proxy: &Proxy<'_>) -> Result<OwnedObjectPath> {
    // Register the app ID before invoking any portal methods.
    // The string MUST match the basename of your .desktop file (e.g., "codex-desktop")
    let app_id = std::env::var("CHROME_DESKTOP")
        .unwrap_or_else(|_| "codex-desktop".to_string())
        .replace(".desktop", "");

    register_host_app_id(connection, &app_id).await?;

    let (request_path, mut response_stream) =
        portal_request_stream(connection, "dictation_create").await?;
    let session_token = request_token("dictation_session");
    let mut options: HashMap<&str, Value<'_>> = HashMap::new();
    options.insert(
        "handle_token",
        Value::from(last_path_component(&request_path)),
    );
    options.insert("session_handle_token", Value::from(session_token.as_str()));

    let handle: OwnedObjectPath = proxy
        .call("CreateSession", &(options))
        .await
        .context("GlobalShortcuts CreateSession failed")?;
    let (response_code, results) =
        await_portal_response(connection, handle, &request_path, &mut response_stream).await?;
    if response_code != 0 {
        bail!("GlobalShortcuts session was denied or cancelled with response code {response_code}");
    }
    let session_handle: String = results
        .get("session_handle")
        .context("CreateSession response did not include session_handle")?
        .try_clone()
        .context("failed to clone session_handle")?
        .try_into()
        .context("session_handle was not a string")?;
    OwnedObjectPath::try_from(session_handle).context("session_handle was not a valid object path")
}

async fn bind_shortcut(
    connection: &Connection,
    proxy: &Proxy<'_>,
    session: &OwnedObjectPath,
    trigger: &str,
) -> Result<()> {
    let (request_path, mut response_stream) =
        portal_request_stream(connection, "dictation_bind").await?;
    let mut properties: HashMap<&str, Value<'_>> = HashMap::new();
    properties.insert("description", Value::from("Global dictation"));
    properties.insert("preferred_trigger", Value::from(trigger));
    let shortcuts = vec![(SHORTCUT_ID, properties)];
    let mut options: HashMap<&str, Value<'_>> = HashMap::new();
    options.insert(
        "handle_token",
        Value::from(last_path_component(&request_path)),
    );

    let handle: OwnedObjectPath = proxy
        .call("BindShortcuts", &(session, shortcuts, "", options))
        .await
        .context("GlobalShortcuts BindShortcuts failed")?;
    let (response_code, results) =
        await_portal_response(connection, handle, &request_path, &mut response_stream).await?;
    if response_code != 0 {
        bail!("Global shortcut was denied or cancelled with response code {response_code}");
    }
    let bound: Vec<(String, HashMap<String, OwnedValue>)> = results
        .get("shortcuts")
        .context("BindShortcuts response did not include shortcuts")?
        .try_clone()
        .context("failed to clone bound shortcuts")?
        .try_into()
        .context("bound shortcuts had an unexpected type")?;
    if !bound.iter().any(|(id, _)| id == SHORTCUT_ID) {
        bail!("Global shortcut was not accepted by the portal");
    }
    Ok(())
}

fn signal_matches(message: &zbus::Message, session: &OwnedObjectPath) -> Result<bool> {
    let (signal_session, shortcut_id, _timestamp, _options): (
        OwnedObjectPath,
        String,
        u64,
        HashMap<String, OwnedValue>,
    ) = message
        .body()
        .deserialize()
        .context("failed to decode global shortcut signal")?;
    Ok(signal_session == *session && shortcut_id == SHORTCUT_ID)
}

async fn close_session(connection: &Connection, session: &OwnedObjectPath) {
    if let Ok(proxy) = Proxy::new(
        connection,
        PORTAL_SERVICE,
        session.as_str(),
        "org.freedesktop.portal.Session",
    )
    .await
    {
        let _: Result<(), _> = proxy.call("Close", &()).await;
    }
}

async fn portal_request_stream<'a>(
    connection: &'a Connection,
    prefix: &str,
) -> Result<(String, zbus::proxy::SignalStream<'a>)> {
    let unique_name = connection
        .unique_name()
        .context("session bus connection has no unique name")?;
    let token = request_token(prefix);
    let request_path = request_path(unique_name.as_str(), &token);
    let request_proxy = Proxy::new(
        connection,
        PORTAL_SERVICE,
        request_path.as_str(),
        REQUEST_INTERFACE,
    )
    .await
    .context("failed to create portal request proxy")?;
    let response_stream = request_proxy
        .receive_signal("Response")
        .await
        .context("failed to subscribe to portal response")?;
    Ok((request_path, response_stream))
}

async fn await_portal_response(
    connection: &Connection,
    handle: OwnedObjectPath,
    expected_request_path: &str,
    response_stream: &mut zbus::proxy::SignalStream<'_>,
) -> Result<(u32, HashMap<String, OwnedValue>)> {
    if handle.as_str() != expected_request_path {
        *response_stream = Proxy::new(
            connection,
            PORTAL_SERVICE,
            handle.as_str(),
            REQUEST_INTERFACE,
        )
        .await
        .context("failed to create returned portal request proxy")?
        .receive_signal("Response")
        .await
        .context("failed to subscribe to returned portal response")?;
    }
    let response = tokio::time::timeout(REQUEST_TIMEOUT, response_stream.next())
        .await
        .context("timed out waiting for portal response")?
        .context("portal response stream ended")?;
    response
        .body()
        .deserialize()
        .context("failed to decode portal response")
}

fn request_path(unique_name: &str, token: &str) -> String {
    format!(
        "/org/freedesktop/portal/desktop/request/{}/{}",
        unique_name.trim_start_matches(':').replace('.', "_"),
        token
    )
}

fn last_path_component(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

fn request_token(prefix: &str) -> String {
    let nonce = REQUEST_NONCE.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}_{}_{nonce}", std::process::id())
}

fn emit(event: &str) -> Result<()> {
    let mut stdout = std::io::stdout().lock();
    writeln!(stdout, "{event}").context("failed to write helper event")?;
    stdout.flush().context("failed to flush helper event")
}

fn emit_error(event: &str, error: &anyhow::Error) -> Result<()> {
    let message = format!("{error:#}")
        .replace(['\r', '\n'], " ")
        .chars()
        .take(1024)
        .collect::<String>();
    emit(&format!("{event}:{message}"))
}

#[cfg(test)]
mod tests {
    use std::{
        collections::HashMap,
        io::{BufRead, BufReader},
        process::{Child, Command, Stdio},
        sync::{Arc, Mutex},
        time::Duration,
    };

    use futures_util::StreamExt;
    use zbus::{
        connection::Builder,
        message::Header,
        zvariant::{OwnedObjectPath, OwnedValue},
        Connection,
    };

    use super::{
        bind_shortcut, create_session, detect_paste_backend, parse_args, paste_with_backend,
        portal_key, portal_trigger, probe_gnome_companion, request_path, signal_matches,
        PasteBackend, DEVICE_KEYBOARD, GNOME_GUIDANCE, GNOME_PATH, GNOME_SERVICE, GNOME_TIMEOUT,
        KEYSYM_CONTROL_L, KEYSYM_V, KEY_PRESSED, KEY_RELEASED, PORTAL_PATH, PORTAL_SERVICE,
        REQUEST_INTERFACE, SHORTCUTS_INTERFACE, SHORTCUT_ID,
    };

    const TEST_SESSION: &str = "/org/freedesktop/portal/desktop/session/test/global_dictation";
    const TEST_PASTE_SESSION: &str = "/org/freedesktop/portal/desktop/session/test/paste";

    struct TestBus {
        child: Child,
        address: String,
        activation_dir: Option<std::path::PathBuf>,
    }

    impl TestBus {
        fn start() -> Self {
            let mut child = Command::new("dbus-daemon")
                .args(["--session", "--print-address=1", "--nofork"])
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .expect("failed to start test D-Bus daemon");
            let address = BufReader::new(child.stdout.take().unwrap())
                .lines()
                .next()
                .expect("test D-Bus daemon did not print an address")
                .expect("failed to read test D-Bus address");
            Self {
                child,
                address,
                activation_dir: None,
            }
        }

        fn start_with_activatable_companion() -> Self {
            let cache = std::env::var_os("XDG_CACHE_HOME")
                .map(std::path::PathBuf::from)
                .unwrap_or_else(|| {
                    std::path::PathBuf::from(std::env::var_os("HOME").unwrap()).join(".cache")
                });
            let dir = cache.join("codex-desktop-dev").join(format!(
                "dictation-bus-{}-{}",
                std::process::id(),
                super::REQUEST_NONCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
            ));
            std::fs::create_dir_all(&dir).unwrap();
            let path = dir.display().to_string();
            let xml_path = path.replace('&', "&amp;").replace('<', "&lt;");
            std::fs::write(
                dir.join(format!("{GNOME_SERVICE}.service")),
                format!(
                    "[D-BUS Service]\nName={GNOME_SERVICE}\nExec=/bin/touch \"{path}/activated\"\n"
                ),
            )
            .unwrap();
            let config = dir.join("bus.conf");
            std::fs::write(&config, format!(
                "<busconfig><type>session</type><listen>unix:tmpdir={xml_path}</listen><servicedir>{xml_path}</servicedir><policy context=\"default\"><allow user=\"*\"/><allow own=\"*\"/><allow send_destination=\"*\"/><allow receive_sender=\"*\"/></policy></busconfig>"
            )).unwrap();
            let mut child = Command::new("dbus-daemon")
                .arg("--config-file")
                .arg(config)
                .args(["--print-address=1", "--nofork"])
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap();
            let address = BufReader::new(child.stdout.take().unwrap())
                .lines()
                .next()
                .unwrap()
                .unwrap();
            Self {
                child,
                address,
                activation_dir: Some(dir),
            }
        }
    }

    impl Drop for TestBus {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
            if let Some(dir) = &self.activation_dir {
                let _ = std::fs::remove_dir_all(dir);
            }
        }
    }

    #[derive(Clone, Default)]
    struct FakePortal {
        trigger: Arc<Mutex<Option<String>>>,
    }

    #[zbus::interface(name = "org.freedesktop.portal.GlobalShortcuts")]
    impl FakePortal {
        #[zbus(property)]
        fn version(&self) -> u32 {
            2
        }

        async fn create_session(
            &self,
            options: HashMap<String, OwnedValue>,
            #[zbus(header)] header: Header<'_>,
            #[zbus(connection)] connection: &Connection,
        ) -> zbus::fdo::Result<OwnedObjectPath> {
            let handle = request_handle(&header, &options)?;
            let mut results = HashMap::new();
            results.insert(
                "session_handle".to_string(),
                OwnedValue::try_from(zbus::zvariant::Value::from(TEST_SESSION))
                    .map_err(|error| zbus::fdo::Error::Failed(error.to_string()))?,
            );
            emit_response(connection, &handle, 0, results).await?;
            Ok(handle)
        }

        async fn bind_shortcuts(
            &self,
            session: OwnedObjectPath,
            shortcuts: Vec<(String, HashMap<String, OwnedValue>)>,
            _parent_window: String,
            options: HashMap<String, OwnedValue>,
            #[zbus(header)] header: Header<'_>,
            #[zbus(connection)] connection: &Connection,
        ) -> zbus::fdo::Result<OwnedObjectPath> {
            if session.as_str() != TEST_SESSION {
                return Err(zbus::fdo::Error::InvalidArgs(
                    "unexpected session handle".to_string(),
                ));
            }
            let properties = shortcuts
                .iter()
                .find_map(|(id, properties)| (id == SHORTCUT_ID).then_some(properties))
                .ok_or_else(|| {
                    zbus::fdo::Error::InvalidArgs("missing global dictation shortcut".to_string())
                })?;
            let trigger: String = properties
                .get("preferred_trigger")
                .ok_or_else(|| {
                    zbus::fdo::Error::InvalidArgs("missing preferred trigger".to_string())
                })?
                .try_clone()
                .map_err(|error| zbus::fdo::Error::InvalidArgs(error.to_string()))?
                .try_into()
                .map_err(|error: zbus::zvariant::Error| {
                    zbus::fdo::Error::InvalidArgs(error.to_string())
                })?;
            *self.trigger.lock().unwrap() = Some(trigger);

            let handle = request_handle(&header, &options)?;
            let mut returned_properties = HashMap::new();
            returned_properties.insert(
                "description".to_string(),
                OwnedValue::try_from(zbus::zvariant::Value::from("Global dictation"))
                    .map_err(|error| zbus::fdo::Error::Failed(error.to_string()))?,
            );
            let bound = vec![(SHORTCUT_ID.to_string(), returned_properties)];
            let mut results = HashMap::new();
            results.insert(
                "shortcuts".to_string(),
                OwnedValue::try_from(zbus::zvariant::Value::from(bound))
                    .map_err(|error| zbus::fdo::Error::Failed(error.to_string()))?,
            );
            emit_response(connection, &handle, 0, results).await?;
            Ok(handle)
        }
    }

    #[derive(Clone, Default)]
    struct FakeRemoteDesktop {
        create_count: Arc<Mutex<u32>>,
        key_events: Arc<Mutex<Vec<(i32, u32)>>>,
        response_code: u32,
    }

    #[zbus::interface(name = "org.freedesktop.portal.RemoteDesktop")]
    impl FakeRemoteDesktop {
        #[zbus(property)]
        fn version(&self) -> u32 {
            2
        }

        async fn create_session(
            &self,
            options: HashMap<String, OwnedValue>,
            #[zbus(header)] header: Header<'_>,
            #[zbus(connection)] connection: &Connection,
        ) -> zbus::fdo::Result<OwnedObjectPath> {
            *self.create_count.lock().unwrap() += 1;
            let handle = request_handle(&header, &options)?;
            let mut results = HashMap::new();
            results.insert(
                "session_handle".to_string(),
                OwnedValue::try_from(zbus::zvariant::Value::from(TEST_PASTE_SESSION))
                    .map_err(|error| zbus::fdo::Error::Failed(error.to_string()))?,
            );
            emit_response(connection, &handle, self.response_code, results).await?;
            Ok(handle)
        }

        async fn select_devices(
            &self,
            session: OwnedObjectPath,
            options: HashMap<String, OwnedValue>,
            #[zbus(header)] header: Header<'_>,
            #[zbus(connection)] connection: &Connection,
        ) -> zbus::fdo::Result<OwnedObjectPath> {
            validate_paste_session(&session)?;
            let types = options
                .get("types")
                .and_then(|value| u32::try_from(value).ok())
                .unwrap_or_default();
            if types != DEVICE_KEYBOARD {
                return Err(zbus::fdo::Error::InvalidArgs(
                    "keyboard access was not selected".to_string(),
                ));
            }
            let handle = request_handle(&header, &options)?;
            emit_response(connection, &handle, 0, HashMap::new()).await?;
            Ok(handle)
        }

        async fn start(
            &self,
            session: OwnedObjectPath,
            _parent_window: String,
            options: HashMap<String, OwnedValue>,
            #[zbus(header)] header: Header<'_>,
            #[zbus(connection)] connection: &Connection,
        ) -> zbus::fdo::Result<OwnedObjectPath> {
            validate_paste_session(&session)?;
            let handle = request_handle(&header, &options)?;
            let mut results = HashMap::new();
            results.insert("devices".to_string(), OwnedValue::from(DEVICE_KEYBOARD));
            emit_response(connection, &handle, 0, results).await?;
            Ok(handle)
        }

        async fn notify_keyboard_keysym(
            &self,
            session: OwnedObjectPath,
            _options: HashMap<String, OwnedValue>,
            keysym: i32,
            state: u32,
        ) -> zbus::fdo::Result<()> {
            validate_paste_session(&session)?;
            self.key_events.lock().unwrap().push((keysym, state));
            Ok(())
        }
    }

    #[derive(Clone)]
    struct FakeCompanion {
        version: u32,
        runtime: tokio::runtime::Handle,
        version_delay: Duration,
        paste_delay: Duration,
        version_error: bool,
        paste_error: bool,
        probes: Arc<Mutex<u32>>,
        pastes: Arc<Mutex<u32>>,
    }

    impl Default for FakeCompanion {
        fn default() -> Self {
            Self {
                version: 1,
                runtime: tokio::runtime::Handle::current(),
                version_delay: Duration::ZERO,
                paste_delay: Duration::ZERO,
                version_error: false,
                paste_error: false,
                probes: Arc::default(),
                pastes: Arc::default(),
            }
        }
    }

    #[zbus::interface(name = "org.chatgpt.Community.Dictation1")]
    impl FakeCompanion {
        async fn get_version(&self) -> zbus::fdo::Result<u32> {
            *self.probes.lock().unwrap() += 1;
            let delay = self.version_delay;
            self.runtime
                .spawn(async move { tokio::time::sleep(delay).await })
                .await
                .map_err(|error| zbus::fdo::Error::Failed(error.to_string()))?;
            if self.version_error {
                return Err(zbus::fdo::Error::Failed("probe rejected".into()));
            }
            Ok(self.version)
        }

        async fn paste(&self) -> zbus::fdo::Result<()> {
            *self.pastes.lock().unwrap() += 1;
            let delay = self.paste_delay;
            self.runtime
                .spawn(async move { tokio::time::sleep(delay).await })
                .await
                .map_err(|error| zbus::fdo::Error::Failed(error.to_string()))?;
            if self.paste_error {
                return Err(zbus::fdo::Error::Failed("paste rejected".into()));
            }
            Ok(())
        }
    }

    async fn companion_server(bus: &TestBus, companion: FakeCompanion) -> Connection {
        Builder::address(bus.address.as_str())
            .unwrap()
            .name(GNOME_SERVICE)
            .unwrap()
            .serve_at(GNOME_PATH, companion)
            .unwrap()
            .build()
            .await
            .unwrap()
    }

    async fn remote_server(bus: &TestBus, remote: FakeRemoteDesktop) -> Connection {
        Builder::address(bus.address.as_str())
            .unwrap()
            .name(PORTAL_SERVICE)
            .unwrap()
            .serve_at(PORTAL_PATH, remote)
            .unwrap()
            .build()
            .await
            .unwrap()
    }

    async fn bus_client(bus: &TestBus) -> Connection {
        Builder::address(bus.address.as_str())
            .unwrap()
            .build()
            .await
            .unwrap()
    }

    fn assert_no_remote_paste(remote: &FakeRemoteDesktop, session: &Option<OwnedObjectPath>) {
        assert!(session.is_none());
        assert_eq!(*remote.create_count.lock().unwrap(), 0);
        assert!(remote.key_events.lock().unwrap().is_empty());
    }

    fn validate_paste_session(session: &OwnedObjectPath) -> zbus::fdo::Result<()> {
        if session.as_str() == TEST_PASTE_SESSION {
            Ok(())
        } else {
            Err(zbus::fdo::Error::InvalidArgs(
                "unexpected paste session handle".to_string(),
            ))
        }
    }

    fn request_handle(
        header: &Header<'_>,
        options: &HashMap<String, OwnedValue>,
    ) -> zbus::fdo::Result<OwnedObjectPath> {
        let sender = header
            .sender()
            .ok_or_else(|| zbus::fdo::Error::Failed("request has no sender".to_string()))?;
        let token: String = options
            .get("handle_token")
            .ok_or_else(|| zbus::fdo::Error::InvalidArgs("missing handle token".to_string()))?
            .try_clone()
            .map_err(|error| zbus::fdo::Error::InvalidArgs(error.to_string()))?
            .try_into()
            .map_err(|error: zbus::zvariant::Error| {
                zbus::fdo::Error::InvalidArgs(error.to_string())
            })?;
        OwnedObjectPath::try_from(request_path(sender.as_str(), &token))
            .map_err(|error| zbus::fdo::Error::InvalidArgs(error.to_string()))
    }

    async fn emit_response(
        connection: &Connection,
        handle: &OwnedObjectPath,
        response_code: u32,
        results: HashMap<String, OwnedValue>,
    ) -> zbus::fdo::Result<()> {
        connection
            .emit_signal(
                None::<&str>,
                handle,
                REQUEST_INTERFACE,
                "Response",
                &(response_code, results),
            )
            .await
            .map_err(|error| zbus::fdo::Error::Failed(error.to_string()))
    }

    #[test]
    fn converts_electron_accelerators_to_xdg_triggers() {
        assert_eq!(
            portal_trigger("CommandOrControl+Shift+Space").unwrap(),
            "CTRL+SHIFT+space"
        );
        assert_eq!(portal_trigger("Alt+F12").unwrap(), "ALT+F12");
        assert_eq!(portal_trigger("Super+PageDown").unwrap(), "LOGO+Page_Down");
        assert_eq!(portal_trigger("Ctrl+Numlock").unwrap(), "CTRL+Num_Lock");
        assert_eq!(portal_trigger("Ctrl+Plus").unwrap(), "CTRL+plus");
        assert_eq!(portal_trigger("Ctrl+num7").unwrap(), "CTRL+KP_7");
    }

    #[test]
    fn rejects_ambiguous_or_unmodified_shortcuts() {
        assert!(portal_trigger("Ctrl+A+B").is_err());
        assert!(portal_trigger("Space").is_err());
        assert!(portal_trigger("Ctrl").is_err());
        assert!(portal_trigger("Command+Space").is_err());
        assert!(portal_trigger("Option+Space").is_err());
    }

    #[test]
    fn validates_cli_shape_and_size() {
        assert_eq!(
            parse_args(["portal", "--accelerator", "Ctrl+Space"].map(str::to_string)).unwrap(),
            "Ctrl+Space"
        );
        assert!(parse_args(["portal", "--accelerator"].map(str::to_string)).is_err());
        assert!(
            parse_args(["portal", "--accelerator", &"x".repeat(129)].map(str::to_string)).is_err()
        );
    }

    #[test]
    fn maps_only_known_portal_keys() {
        assert_eq!(portal_key("Return").unwrap(), "Return");
        assert_eq!(portal_key("a").unwrap(), "a");
        assert_eq!(portal_key("VolumeUp").unwrap(), "XF86AudioRaiseVolume");
        assert_eq!(portal_key(";").unwrap(), "semicolon");
        assert_eq!(portal_key("Media Play/Pause").unwrap(), "XF86AudioPlay");
    }

    #[test]
    fn request_paths_escape_dbus_unique_names() {
        assert_eq!(
            request_path(":1.204", "dictation_1"),
            "/org/freedesktop/portal/desktop/request/1_204/dictation_1"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn registers_and_receives_press_and_release_through_the_portal() {
        let bus = TestBus::start();
        let portal = FakePortal::default();
        let observed_trigger = portal.trigger.clone();
        let server = Builder::address(bus.address.as_str())
            .unwrap()
            .name(PORTAL_SERVICE)
            .unwrap()
            .serve_at(PORTAL_PATH, portal)
            .unwrap()
            .build()
            .await
            .unwrap();
        let client = Builder::address(bus.address.as_str())
            .unwrap()
            .build()
            .await
            .unwrap();
        let proxy = zbus::Proxy::new(&client, PORTAL_SERVICE, PORTAL_PATH, SHORTCUTS_INTERFACE)
            .await
            .unwrap();

        let session = create_session(&client, &proxy).await.unwrap();
        bind_shortcut(&client, &proxy, &session, "CTRL+SHIFT+space")
            .await
            .unwrap();
        assert_eq!(
            observed_trigger.lock().unwrap().as_deref(),
            Some("CTRL+SHIFT+space")
        );

        let mut activated = proxy.receive_signal("Activated").await.unwrap();
        let mut deactivated = proxy.receive_signal("Deactivated").await.unwrap();
        let empty: HashMap<String, OwnedValue> = HashMap::new();
        server
            .emit_signal(
                None::<&str>,
                PORTAL_PATH,
                SHORTCUTS_INTERFACE,
                "Activated",
                &(session.clone(), SHORTCUT_ID, 1u64, &empty),
            )
            .await
            .unwrap();
        server
            .emit_signal(
                None::<&str>,
                PORTAL_PATH,
                SHORTCUTS_INTERFACE,
                "Deactivated",
                &(session.clone(), SHORTCUT_ID, 2u64, &empty),
            )
            .await
            .unwrap();

        let down = tokio::time::timeout(Duration::from_secs(1), activated.next())
            .await
            .unwrap()
            .unwrap();
        let up = tokio::time::timeout(Duration::from_secs(1), deactivated.next())
            .await
            .unwrap()
            .unwrap();
        assert!(signal_matches(&down, &session).unwrap());
        assert!(signal_matches(&up, &session).unwrap());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn pastes_through_one_reused_remote_desktop_session() {
        let bus = TestBus::start();
        let remote = FakeRemoteDesktop::default();
        let create_count = remote.create_count.clone();
        let key_events = remote.key_events.clone();
        let _server = Builder::address(bus.address.as_str())
            .unwrap()
            .name(PORTAL_SERVICE)
            .unwrap()
            .serve_at(PORTAL_PATH, FakePortal::default())
            .unwrap()
            .serve_at(PORTAL_PATH, remote)
            .unwrap()
            .build()
            .await
            .unwrap();
        let client = Builder::address(bus.address.as_str())
            .unwrap()
            .build()
            .await
            .unwrap();
        let mut session = None;

        paste_with_backend(&client, &mut session, PasteBackend::RemoteDesktop)
            .await
            .unwrap();
        paste_with_backend(&client, &mut session, PasteBackend::RemoteDesktop)
            .await
            .unwrap();

        assert_eq!(*create_count.lock().unwrap(), 1);
        assert_eq!(
            *key_events.lock().unwrap(),
            vec![
                (KEYSYM_CONTROL_L, KEY_PRESSED),
                (KEYSYM_V, KEY_PRESSED),
                (KEYSYM_V, KEY_RELEASED),
                (KEYSYM_CONTROL_L, KEY_RELEASED),
                (KEYSYM_CONTROL_L, KEY_PRESSED),
                (KEYSYM_V, KEY_PRESSED),
                (KEYSYM_V, KEY_RELEASED),
                (KEYSYM_CONTROL_L, KEY_RELEASED),
            ]
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn startup_detection_prefers_companion_without_remote_session() {
        let bus = TestBus::start();
        let remote = FakeRemoteDesktop::default();
        let _portal = remote_server(&bus, remote.clone()).await;
        let companion = FakeCompanion::default();
        let _extension = companion_server(&bus, companion.clone()).await;
        let client = bus_client(&bus).await;
        let mut session = None;
        let backend = detect_paste_backend(&client).await;
        assert_eq!(backend, PasteBackend::Gnome);
        assert_eq!(*companion.pastes.lock().unwrap(), 0);
        assert_no_remote_paste(&remote, &session);
        for _ in 0..2 {
            paste_with_backend(&client, &mut session, backend)
                .await
                .unwrap();
        }
        assert_eq!(*companion.probes.lock().unwrap(), 3);
        assert_eq!(*companion.pastes.lock().unwrap(), 2);
        assert_no_remote_paste(&remote, &session);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn absent_companion_detection_and_selected_gnome_never_activate_service() {
        let bus = TestBus::start_with_activatable_companion();
        let remote = FakeRemoteDesktop::default();
        let _portal = remote_server(&bus, remote.clone()).await;
        let client = bus_client(&bus).await;
        let dbus = zbus::fdo::DBusProxy::new(&client).await.unwrap();
        assert!(dbus
            .list_activatable_names()
            .await
            .unwrap()
            .iter()
            .any(|name| name.as_str() == GNOME_SERVICE));
        let mut session = None;
        assert_eq!(
            detect_paste_backend(&client).await,
            PasteBackend::RemoteDesktop
        );
        assert_no_remote_paste(&remote, &session);
        let error = paste_with_backend(&client, &mut session, PasteBackend::Gnome)
            .await
            .unwrap_err();
        assert!(format!("{error:#}").contains("companion is unavailable"));
        assert!(error.to_string().contains(GNOME_GUIDANCE));
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(!bus
            .activation_dir
            .as_ref()
            .unwrap()
            .join("activated")
            .exists());
        assert_no_remote_paste(&remote, &session);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn incompatible_companion_never_receives_paste() {
        let bus = TestBus::start();
        let remote = FakeRemoteDesktop::default();
        let _portal = remote_server(&bus, remote.clone()).await;
        let client = bus_client(&bus).await;
        let mut session = None;
        for version in [0, 2] {
            let companion = FakeCompanion {
                version,
                ..FakeCompanion::default()
            };
            let server = companion_server(&bus, companion.clone()).await;
            let error = paste_with_backend(&client, &mut session, PasteBackend::Gnome)
                .await
                .unwrap_err();
            assert!(format!("{error:#}").contains("unsupported (expected 1)"));
            assert!(error.to_string().contains(GNOME_GUIDANCE));
            assert_eq!(*companion.pastes.lock().unwrap(), 0);
            assert_no_remote_paste(&remote, &session);
            server.close().await.unwrap();
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn companion_errors_and_timeouts_never_fall_back_or_retry() {
        let bus = TestBus::start();
        let remote = FakeRemoteDesktop::default();
        let _portal = remote_server(&bus, remote.clone()).await;
        let client = bus_client(&bus).await;
        let mut session = None;
        for (companion, expected, pastes) in [
            (
                FakeCompanion {
                    version_error: true,
                    ..FakeCompanion::default()
                },
                "version probe failed",
                0,
            ),
            (
                FakeCompanion {
                    version_delay: GNOME_TIMEOUT * 2,
                    ..FakeCompanion::default()
                },
                "probe timed out",
                0,
            ),
            (
                FakeCompanion {
                    paste_error: true,
                    ..FakeCompanion::default()
                },
                "Paste failed",
                1,
            ),
            (
                FakeCompanion {
                    paste_delay: GNOME_TIMEOUT * 2,
                    ..FakeCompanion::default()
                },
                "Paste timed out",
                1,
            ),
        ] {
            let server = companion_server(&bus, companion.clone()).await;
            let started = tokio::time::Instant::now();
            let error = paste_with_backend(&client, &mut session, PasteBackend::Gnome)
                .await
                .unwrap_err();
            assert!(started.elapsed() < GNOME_TIMEOUT + Duration::from_secs(1));
            assert!(format!("{error:#}").contains(expected));
            assert!(error.to_string().contains(GNOME_GUIDANCE));
            assert_eq!(*companion.probes.lock().unwrap(), 1);
            assert_eq!(*companion.pastes.lock().unwrap(), pastes);
            assert_no_remote_paste(&remote, &session);
            server.close().await.unwrap();
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn companion_disappearance_and_reappearance_use_current_owner() {
        let bus = TestBus::start();
        let remote = FakeRemoteDesktop::default();
        let _portal = remote_server(&bus, remote.clone()).await;
        let client = bus_client(&bus).await;
        let mut session = None;
        let old = FakeCompanion::default();
        let old_server = companion_server(&bus, old.clone()).await;
        let backend = detect_paste_backend(&client).await;
        assert_eq!(backend, PasteBackend::Gnome);
        paste_with_backend(&client, &mut session, backend)
            .await
            .unwrap();
        old_server.release_name(GNOME_SERVICE).await.unwrap();
        let error = paste_with_backend(&client, &mut session, backend)
            .await
            .unwrap_err();
        assert!(format!("{error:#}").contains("companion is unavailable"));
        let new = FakeCompanion::default();
        let _new_server = companion_server(&bus, new.clone()).await;
        assert_ne!(old_server.unique_name(), _new_server.unique_name());
        paste_with_backend(&client, &mut session, backend)
            .await
            .unwrap();
        assert_eq!(*old.pastes.lock().unwrap(), 1);
        assert_eq!(*new.probes.lock().unwrap(), 1);
        assert_eq!(*new.pastes.lock().unwrap(), 1);
        assert_no_remote_paste(&remote, &session);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn probed_proxy_is_pinned_to_unique_owner() {
        let bus = TestBus::start();
        let client = bus_client(&bus).await;
        let old_server = companion_server(&bus, FakeCompanion::default()).await;
        let proxy = tokio::time::timeout(GNOME_TIMEOUT, probe_gnome_companion(&client))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            proxy.destination().as_str(),
            old_server.unique_name().unwrap().as_str()
        );
        old_server.close().await.unwrap();
        let new = FakeCompanion::default();
        let _new_server = companion_server(&bus, new.clone()).await;
        let result: zbus::Result<()> = proxy.call("Paste", &()).await;
        assert!(result.is_err());
        assert_eq!(*new.pastes.lock().unwrap(), 0);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn startup_remote_choice_is_lazy_and_stable_when_companion_appears() {
        let bus = TestBus::start();
        let remote = FakeRemoteDesktop::default();
        let _portal = remote_server(&bus, remote.clone()).await;
        let client = bus_client(&bus).await;
        let mut session = None;
        let backend = detect_paste_backend(&client).await;
        assert_eq!(backend, PasteBackend::RemoteDesktop);
        assert_no_remote_paste(&remote, &session);
        let companion = FakeCompanion::default();
        let _extension = companion_server(&bus, companion.clone()).await;
        paste_with_backend(&client, &mut session, backend)
            .await
            .unwrap();
        assert_eq!(*remote.create_count.lock().unwrap(), 1);
        assert_eq!(remote.key_events.lock().unwrap().len(), 4);
        assert_eq!(*companion.probes.lock().unwrap(), 0);
        assert_eq!(*companion.pastes.lock().unwrap(), 0);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn startup_probe_failure_selects_remote_without_input() {
        let bus = TestBus::start();
        let remote = FakeRemoteDesktop::default();
        let _portal = remote_server(&bus, remote.clone()).await;
        let client = bus_client(&bus).await;
        for companion in [
            FakeCompanion {
                version: 0,
                ..FakeCompanion::default()
            },
            FakeCompanion {
                version: 2,
                ..FakeCompanion::default()
            },
            FakeCompanion {
                version_error: true,
                ..FakeCompanion::default()
            },
            FakeCompanion {
                version_delay: GNOME_TIMEOUT * 2,
                ..FakeCompanion::default()
            },
        ] {
            let server = companion_server(&bus, companion.clone()).await;
            let started = tokio::time::Instant::now();
            assert_eq!(
                detect_paste_backend(&client).await,
                PasteBackend::RemoteDesktop
            );
            assert!(started.elapsed() < GNOME_TIMEOUT + Duration::from_secs(1));
            assert_eq!(*companion.probes.lock().unwrap(), 1);
            assert_eq!(*companion.pastes.lock().unwrap(), 0);
            assert_no_remote_paste(&remote, &None);
            server.close().await.unwrap();
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn remote_desktop_denial_does_not_leave_a_paste_session() {
        let bus = TestBus::start();
        let remote = FakeRemoteDesktop {
            response_code: 2,
            ..FakeRemoteDesktop::default()
        };
        let create_count = remote.create_count.clone();
        let _server = Builder::address(bus.address.as_str())
            .unwrap()
            .name(PORTAL_SERVICE)
            .unwrap()
            .serve_at(PORTAL_PATH, remote)
            .unwrap()
            .build()
            .await
            .unwrap();
        let client = Builder::address(bus.address.as_str())
            .unwrap()
            .build()
            .await
            .unwrap();
        let mut session = None;

        let error = paste_with_backend(&client, &mut session, PasteBackend::RemoteDesktop)
            .await
            .unwrap_err();

        assert!(error.to_string().contains("denied or cancelled"));
        assert!(session.is_none());
        assert_eq!(*create_count.lock().unwrap(), 1);
    }
}
