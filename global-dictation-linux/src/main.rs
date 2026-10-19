use std::{
    collections::HashMap,
    future::Future,
    io::Write,
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};

use anyhow::{bail, Context, Result};
use futures_util::StreamExt;
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    signal::unix::{signal, Signal, SignalKind},
};
use zbus::{
    proxy::{CacheProperties, MethodFlags, SignalStream},
    zvariant::{OwnedObjectPath, OwnedValue, Value},
    Connection, Proxy,
};

const PORTAL_SERVICE: &str = "org.freedesktop.portal.Desktop";
const PORTAL_PATH: &str = "/org/freedesktop/portal/desktop";
const SHORTCUTS_INTERFACE: &str = "org.freedesktop.portal.GlobalShortcuts";
const REQUEST_INTERFACE: &str = "org.freedesktop.portal.Request";
const SESSION_INTERFACE: &str = "org.freedesktop.portal.Session";
// GDBus answers UnknownMethod and zbus/sd-bus UnknownObject or UnknownInterface
// once the portal has already released a session object.
const SESSION_GONE_ERRORS: [&str; 3] = [
    "org.freedesktop.DBus.Error.UnknownObject",
    "org.freedesktop.DBus.Error.UnknownMethod",
    "org.freedesktop.DBus.Error.UnknownInterface",
];
const SESSION_CLOSED_BY_PORTAL: &str = "GlobalShortcuts session was closed by the desktop portal";
const REMOTE_DESKTOP_INTERFACE: &str = "org.freedesktop.portal.RemoteDesktop";
const GNOME_SERVICE: &str = "org.chatgpt.Community.Dictation";
const GNOME_PATH: &str = "/org/chatgpt/Community/Dictation";
const GNOME_INTERFACE: &str = "org.chatgpt.Community.Dictation1";
const GNOME_TIMEOUT: Duration = Duration::from_secs(2);
const GNOME_GUIDANCE: &str = "Enable the ChatGPT Community dictation GNOME extension (compatible version 1) and try again; RemoteDesktop fallback is disabled";
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
    // Owl rewrites CHROME_DESKTOP; the wrapper keeps its installed identity here.
    let app_id = std::env::var("CODEX_LINUX_APP_ID").unwrap_or_else(|_| app_id.to_owned());
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

#[derive(Debug, PartialEq, Eq)]
struct Shortcut {
    id: String,
    description: String,
    trigger: String,
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    exit_with(run().await)
}

/// Exits before the runtime is dropped: tokio reads stdin with a blocking read
/// that cannot be cancelled, so runtime shutdown would wait for the next line.
fn exit_with(result: Result<()>) -> ! {
    if let Err(error) = result {
        eprintln!("{error:#}");
        std::process::exit(1);
    }
    std::process::exit(0)
}

async fn run() -> Result<()> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    let check = args.first().is_some_and(|command| command == "check");
    let shortcuts = parse_args(args)?;
    if check {
        for shortcut in shortcuts {
            emit(&shortcut.trigger)?;
        }
        return Ok(());
    }
    // Install the handler before connecting: SIGINT is the stop request, and a
    // signal delivered while no phase is polling must still end the helper.
    let mut interrupt =
        signal(SignalKind::interrupt()).context("failed to install the SIGINT handler")?;
    let Some(connection) = interruptible(&mut interrupt, Connection::session()).await else {
        return Ok(());
    };
    let connection = connection.context("failed to connect to the session bus")?;
    run_portal_on(&connection, &shortcuts, &mut interrupt).await
}

/// Runs `future` unless SIGINT arrives first; dropping it before a session
/// handle is known is safe because the portal closes sessions with the connection.
async fn interruptible<T>(interrupt: &mut Signal, future: impl Future<Output = T>) -> Option<T> {
    tokio::select! {
        biased;
        _ = interrupt.recv() => None,
        value = future => Some(value),
    }
}

fn parse_args(args: impl IntoIterator<Item = String>) -> Result<Vec<Shortcut>> {
    let mut args = args.into_iter();
    let Some(command) = args.next() else {
        bail!("usage: codex-global-dictation-linux <portal|check> --shortcut <id> <description> <accelerator>");
    };
    if command != "portal" && command != "check" {
        bail!("unknown command: {command}");
    }

    let mut shortcuts: Vec<Shortcut> = Vec::new();
    while let Some(argument) = args.next() {
        if argument != "--shortcut" {
            bail!("unknown argument: {argument}");
        }
        if shortcuts.len() == 32 {
            bail!("provide between 1 and 32 --shortcut arguments");
        }
        let id = args.next().context("missing shortcut id")?;
        let description = args.next().context("missing shortcut description")?;
        let accelerator = args.next().context("missing shortcut accelerator")?;
        if id.is_empty()
            || id.len() > 128
            || !id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
        {
            bail!(
                "shortcut id must contain 1 to 128 letters, digits, dots, underscores or hyphens"
            );
        }
        if description.trim().is_empty()
            || description.len() > 512
            || description.chars().any(char::is_control)
        {
            bail!("shortcut description must contain 1 to 512 printable bytes");
        }
        if accelerator.is_empty()
            || accelerator.len() > 128
            || accelerator.chars().any(char::is_control)
        {
            bail!("accelerator must contain between 1 and 128 printable characters");
        }
        let trigger = portal_trigger(&accelerator)?;
        if shortcuts
            .iter()
            .any(|shortcut| shortcut.id == id || shortcut.trigger == trigger)
        {
            bail!("global shortcuts must have distinct command ids and triggers");
        }
        shortcuts.push(Shortcut {
            id,
            description,
            trigger,
        });
    }
    if shortcuts.is_empty() {
        bail!("provide between 1 and 32 --shortcut arguments");
    }
    Ok(shortcuts)
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
    modifiers.sort_unstable();
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

async fn run_portal_on(
    connection: &Connection,
    shortcuts: &[Shortcut],
    interrupt: &mut Signal,
) -> Result<()> {
    let opened = interruptible(interrupt, async {
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
        Ok((proxy, session))
    })
    .await;
    let Some(opened) = opened else {
        return Ok(());
    };
    let (proxy, session) = opened?;
    let subscriptions = async {
        let closed = session_closed_stream(connection, &session).await?;
        let signals = proxy
            .receive_all_signals()
            .await
            .context("failed to subscribe to global shortcut events")?;
        Ok::<_, anyhow::Error>((closed, signals))
    };
    let (mut closed, mut signals) = match subscriptions.await {
        Ok(streams) => streams,
        Err(error) => {
            close_session(connection, &session).await;
            return Err(error);
        }
    };
    let bound = tokio::select! {
        biased;
        _ = interrupt.recv() => return close_session_checked(connection, &session).await,
        _ = closed.next() => bail!(SESSION_CLOSED_BY_PORTAL),
        result = bind_shortcuts(connection, &proxy, &session, shortcuts) => result,
    };
    let bound = match bound {
        Ok(bound) => bound,
        Err(error) => {
            close_session(connection, &session).await;
            return Err(error);
        }
    };

    let backend = tokio::select! {
        biased;
        _ = interrupt.recv() => return close_session_checked(connection, &session).await,
        _ = closed.next() => bail!(SESSION_CLOSED_BY_PORTAL),
        backend = detect_paste_backend(connection) => backend,
    };
    let mut pressed = vec![false; shortcuts.len()];
    emit_bindings(shortcuts, &bound, &mut pressed)?;
    let mut commands = BufReader::new(tokio::io::stdin()).lines();
    let mut paste_session = None;
    let mut portal_closed = false;
    loop {
        tokio::select! {
            biased;
            _ = interrupt.recv() => break,
            _ = closed.next() => {
                portal_closed = true;
                break;
            }
            message = signals.next() => {
                let message = message.context("global shortcut event stream ended")?;
                let header = message.header();
                match header.member().map(|member| member.as_str()) {
                    Some("Activated" | "Deactivated") => {
                        let down = header.member().is_some_and(|member| member.as_str() == "Activated");
                        for (index, shortcut) in shortcuts.iter().enumerate() {
                            if signal_matches(&message, &session, &shortcut.id)? && pressed[index] != down {
                                pressed[index] = down;
                                emit_shortcut(if down { "down" } else { "up" }, index, shortcuts.len())?;
                            }
                        }
                    }
                    Some("ShortcutsChanged") => {
                        let (signal_session, bound): (OwnedObjectPath, BoundShortcuts) = message
                            .body().deserialize().context("failed to decode shortcut changes")?;
                        if signal_session == session {
                            emit_bindings(shortcuts, &bound, &mut pressed)?;
                        }
                    }
                    _ => {}
                }
            }
            command = commands.next_line() => {
                match command.context("failed to read helper command")? {
                    Some(command) if command == "paste" => {
                        let Some(result) =
                            paste_until_interrupted(connection, &mut paste_session, backend, interrupt).await
                        else {
                            break;
                        };
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
        }
    }
    if let Some(session) = paste_session {
        close_session(connection, &session).await;
    }
    if portal_closed {
        bail!(SESSION_CLOSED_BY_PORTAL);
    }
    close_session_checked(connection, &session).await
}

/// Returns `None` when SIGINT interrupts the paste. Consent and probing may be
/// abandoned, but RemoteDesktop key events always finish so Ctrl is released.
async fn paste_until_interrupted(
    connection: &Connection,
    session: &mut Option<OwnedObjectPath>,
    backend: PasteBackend,
    interrupt: &mut Signal,
) -> Option<Result<()>> {
    if backend == PasteBackend::RemoteDesktop && session.is_none() {
        match interruptible(interrupt, start_remote_desktop_keyboard_session(connection)).await? {
            Ok(started) => *session = Some(started),
            Err(error) => return Some(Err(error)),
        }
    }
    match backend {
        PasteBackend::RemoteDesktop => Some(paste_with_backend(connection, session, backend).await),
        PasteBackend::Gnome => {
            interruptible(interrupt, paste_with_backend(connection, session, backend)).await
        }
    }
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

type BoundShortcuts = Vec<(String, HashMap<String, OwnedValue>)>;

async fn bind_shortcuts(
    connection: &Connection,
    proxy: &Proxy<'_>,
    session: &OwnedObjectPath,
    shortcuts: &[Shortcut],
) -> Result<BoundShortcuts> {
    let (request_path, mut response_stream) =
        portal_request_stream(connection, "dictation_bind").await?;
    let portal_shortcuts = shortcuts
        .iter()
        .map(|shortcut| {
            let mut properties: HashMap<&str, Value<'_>> = HashMap::new();
            properties.insert("description", Value::from(shortcut.description.as_str()));
            properties.insert("preferred_trigger", Value::from(shortcut.trigger.as_str()));
            (shortcut.id.as_str(), properties)
        })
        .collect::<Vec<_>>();
    let mut options: HashMap<&str, Value<'_>> = HashMap::new();
    options.insert(
        "handle_token",
        Value::from(last_path_component(&request_path)),
    );

    let handle: OwnedObjectPath = proxy
        .call("BindShortcuts", &(session, portal_shortcuts, "", options))
        .await
        .context("GlobalShortcuts BindShortcuts failed")?;
    let (response_code, results) =
        await_portal_response(connection, handle, &request_path, &mut response_stream).await?;
    if response_code != 0 {
        bail!("Global shortcut was denied or cancelled with response code {response_code}");
    }
    let bound: BoundShortcuts = results
        .get("shortcuts")
        .context("BindShortcuts response did not include shortcuts")?
        .try_clone()
        .context("failed to clone bound shortcuts")?
        .try_into()
        .context("bound shortcuts had an unexpected type")?;
    Ok(bound)
}

fn binding_lines(
    shortcuts: &[Shortcut],
    bound: &BoundShortcuts,
    pressed: &mut [bool],
) -> Result<Vec<String>> {
    debug_assert_eq!(shortcuts.len(), pressed.len());
    if bound.len() > shortcuts.len()
        || bound.iter().enumerate().any(|(index, (id, _))| {
            !shortcuts.iter().any(|shortcut| shortcut.id == *id)
                || bound[..index].iter().any(|(previous, _)| previous == id)
        })
    {
        bail!("portal returned unknown or duplicate shortcut identities");
    }
    let mut lines = vec!["bindings".to_string()];
    for (index, shortcut) in shortcuts.iter().enumerate() {
        let Some((_, properties)) = bound.iter().find(|(id, _)| *id == shortcut.id) else {
            pressed[index] = false;
            continue;
        };
        let description = properties
            .get("trigger_description")
            .map(<&str>::try_from)
            .transpose()
            .context("invalid trigger description")?;
        // KDE retains declined actions with an explicitly empty trigger.
        if description == Some("") {
            pressed[index] = false;
            continue;
        }
        let description: String = description
            .unwrap_or_default()
            .chars()
            .filter(|ch| !ch.is_control())
            .take(512)
            .collect();
        lines.push(format!("bound:{index}:{description}"));
    }
    lines.push("ready".to_string());
    Ok(lines)
}

fn emit_bindings(
    shortcuts: &[Shortcut],
    bound: &BoundShortcuts,
    pressed: &mut [bool],
) -> Result<()> {
    for line in binding_lines(shortcuts, bound, pressed)? {
        emit(&line)?;
    }
    Ok(())
}

fn signal_matches(
    message: &zbus::Message,
    session: &OwnedObjectPath,
    expected_id: &str,
) -> Result<bool> {
    let (signal_session, shortcut_id, _timestamp, _options): (
        OwnedObjectPath,
        String,
        u64,
        HashMap<String, OwnedValue>,
    ) = message
        .body()
        .deserialize()
        .context("failed to decode global shortcut signal")?;
    Ok(signal_session == *session && shortcut_id == expected_id)
}

async fn close_session(connection: &Connection, session: &OwnedObjectPath) {
    let _ = close_session_checked(connection, session).await;
}

async fn session_closed_stream<'a>(
    connection: &'a Connection,
    session: &OwnedObjectPath,
) -> Result<SignalStream<'a>> {
    Proxy::new(
        connection,
        PORTAL_SERVICE,
        session.as_str().to_owned(),
        SESSION_INTERFACE,
    )
    .await
    .context("failed to open portal session")?
    .receive_signal("Closed")
    .await
    .context("failed to subscribe to portal session closure")
}

async fn close_session_checked(connection: &Connection, session: &OwnedObjectPath) -> Result<()> {
    let proxy = Proxy::new(
        connection,
        PORTAL_SERVICE,
        session.as_str(),
        SESSION_INTERFACE,
    )
    .await
    .context("failed to open portal session for cleanup")?;
    match proxy.call::<_, _, ()>("Close", &()).await {
        // The portal already closed the session; the release still succeeded.
        Err(zbus::Error::MethodError(name, _, _))
            if SESSION_GONE_ERRORS.contains(&name.as_str()) =>
        {
            Ok(())
        }
        result => result.context("failed to close portal session"),
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

fn emit_shortcut(event: &str, index: usize, count: usize) -> Result<()> {
    if count == 1 {
        emit(event)
    } else {
        emit(&format!("{event}:{index}"))
    }
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
        bind_shortcuts, close_session_checked, create_session, detect_paste_backend, parse_args,
        paste_with_backend, portal_key, portal_trigger, probe_gnome_companion, request_path,
        signal_matches, PasteBackend, Shortcut, DEVICE_KEYBOARD, GNOME_GUIDANCE, GNOME_PATH,
        GNOME_SERVICE, GNOME_TIMEOUT, KEYSYM_CONTROL_L, KEYSYM_V, KEY_PRESSED, KEY_RELEASED,
        PORTAL_PATH, PORTAL_SERVICE, REQUEST_INTERFACE, SESSION_CLOSED_BY_PORTAL,
        SESSION_INTERFACE, SHORTCUTS_INTERFACE,
    };

    // Saved compositor bindings are keyed by this ID; it predates the shared backend.
    const SHORTCUT_ID: &str = "global-dictation";
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
    struct FakeHostRegistry {
        app_ids: Arc<Mutex<Vec<String>>>,
    }

    #[zbus::interface(name = "org.freedesktop.host.portal.Registry")]
    impl FakeHostRegistry {
        fn register(&self, app_id: String, _options: HashMap<String, OwnedValue>) {
            self.app_ids.lock().unwrap().push(app_id);
        }
    }

    #[derive(Clone, Default)]
    struct FakePortal {
        trigger: Arc<Mutex<Option<String>>>,
        ids: Arc<Mutex<Vec<String>>>,
        description: Arc<Mutex<Option<String>>>,
        accepted: Option<Vec<String>>,
        delay_create: bool,
        delay_bind: bool,
        create_calls: Arc<Mutex<u32>>,
    }

    #[zbus::interface(name = "org.freedesktop.portal.GlobalShortcuts")]
    impl FakePortal {
        #[zbus(property, name = "version")]
        fn version(&self) -> u32 {
            2
        }

        async fn create_session(
            &self,
            options: HashMap<String, OwnedValue>,
            #[zbus(header)] header: Header<'_>,
            #[zbus(connection)] connection: &Connection,
        ) -> zbus::fdo::Result<OwnedObjectPath> {
            *self.create_calls.lock().unwrap() += 1;
            let handle = request_handle(&header, &options)?;
            let mut results = HashMap::new();
            results.insert(
                "session_handle".to_string(),
                OwnedValue::try_from(zbus::zvariant::Value::from(TEST_SESSION))
                    .map_err(|error| zbus::fdo::Error::Failed(error.to_string()))?,
            );
            if !self.delay_create {
                emit_response(connection, &handle, 0, results).await?;
            }
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
            let description: String = properties
                .get("description")
                .ok_or_else(|| zbus::fdo::Error::InvalidArgs("missing description".to_string()))?
                .try_clone()
                .map_err(|error| zbus::fdo::Error::InvalidArgs(error.to_string()))?
                .try_into()
                .map_err(|error: zbus::zvariant::Error| {
                    zbus::fdo::Error::InvalidArgs(error.to_string())
                })?;
            *self.description.lock().unwrap() = Some(description);

            let handle = request_handle(&header, &options)?;
            *self.ids.lock().unwrap() = shortcuts.iter().map(|(id, _)| id.clone()).collect();
            let bound: Vec<_> = shortcuts
                .into_iter()
                .filter(|(id, _)| {
                    self.accepted
                        .as_ref()
                        .is_none_or(|accepted| accepted.contains(id))
                })
                .collect();
            let mut results = HashMap::new();
            results.insert(
                "shortcuts".to_string(),
                OwnedValue::try_from(zbus::zvariant::Value::from(bound))
                    .map_err(|error| zbus::fdo::Error::Failed(error.to_string()))?,
            );
            if !self.delay_bind {
                emit_response(connection, &handle, 0, results).await?;
            }
            Ok(handle)
        }
    }

    #[derive(Clone, Default)]
    struct FakeShortcutsSession {
        closed: Arc<Mutex<bool>>,
        close_error: Option<fn(String) -> zbus::fdo::Error>,
    }

    #[zbus::interface(name = "org.freedesktop.portal.Session")]
    impl FakeShortcutsSession {
        fn close(&self) -> zbus::fdo::Result<()> {
            if let Some(error) = self.close_error {
                return Err(error("session is gone".into()));
            }
            *self.closed.lock().unwrap() = true;
            Ok(())
        }
    }

    #[derive(Clone, Default)]
    struct FakeRemoteDesktop {
        create_count: Arc<Mutex<u32>>,
        key_events: Arc<Mutex<Vec<(i32, u32)>>>,
        response_code: u32,
        delay_create: bool,
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
            if !self.delay_create {
                emit_response(connection, &handle, self.response_code, results).await?;
            }
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
        assert_eq!(
            portal_trigger("Alt+Control+G").unwrap(),
            portal_trigger("Ctrl+Alt+G").unwrap()
        );
        assert_eq!(
            portal_trigger("Shift+Ctrl+Alt+Shift+G").unwrap(),
            "ALT+CTRL+SHIFT+g"
        );
    }

    #[test]
    fn validation_mode_reuses_the_portal_parser() {
        let portal = parse_args(
            ["portal", "--shortcut", "hotkeyWindow", "Popout", "Ctrl+G"].map(str::to_string),
        )
        .unwrap();
        let check = parse_args(
            ["check", "--shortcut", "hotkeyWindow", "Popout", "Ctrl+G"].map(str::to_string),
        )
        .unwrap();
        assert_eq!(portal, check);
        assert!(parse_args(
            [
                "check",
                "--shortcut",
                "hotkeyWindow",
                "Popout",
                "Ctrl+Unsupported"
            ]
            .map(str::to_string)
        )
        .is_err());
    }

    #[test]
    fn reports_partial_disabled_and_changed_bindings_by_identity() {
        let shortcuts = parse_args(
            [
                "portal",
                "--shortcut",
                "hotkeyWindow",
                "Popout",
                "Ctrl+G",
                "--shortcut",
                "openAvatarOverlay",
                "Mini",
                "Super+P",
            ]
            .map(str::to_string),
        )
        .unwrap();
        let properties = |description: &str| {
            HashMap::from([(
                "trigger_description".to_string(),
                OwnedValue::try_from(zbus::zvariant::Value::from(description)).unwrap(),
            )])
        };
        assert_eq!(
            super::binding_lines(&shortcuts, &vec![], &mut [false, false]).unwrap(),
            ["bindings", "ready"]
        );
        let mut pressed = [true, true];
        assert_eq!(
            super::binding_lines(
                &shortcuts,
                &vec![
                    ("hotkeyWindow".into(), properties("Meta+G\n")),
                    ("openAvatarOverlay".into(), properties("")),
                ],
                &mut pressed
            )
            .unwrap(),
            ["bindings", "bound:0:Meta+G", "ready"]
        );
        assert_eq!(pressed, [true, false]);
        assert!(super::binding_lines(
            &shortcuts,
            &vec![("unknown".into(), properties("Ctrl+G"))],
            &mut [false, false]
        )
        .is_err());
        assert!(super::binding_lines(
            &shortcuts,
            &vec![
                ("hotkeyWindow".into(), properties("Ctrl+G")),
                ("hotkeyWindow".into(), properties("Ctrl+H"))
            ],
            &mut [false, false]
        )
        .is_err());
    }

    #[test]
    fn command_identity_survives_keybinding_and_description_changes() {
        let parse = |label, accelerator| {
            parse_args(
                ["portal", "--shortcut", "hotkeyWindow", label, accelerator].map(str::to_string),
            )
            .unwrap()
            .remove(0)
        };
        let original = parse("Open popout chat window", "Ctrl+Alt+G");
        let changed = parse("Открыть всплывающее окно чата", "Ctrl+Alt+H");
        assert_eq!(original.id, changed.id);
        assert_ne!(original.trigger, changed.trigger);
        assert_ne!(original.description, changed.description);
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
            parse_args(
                [
                    "portal",
                    "--shortcut",
                    "hotkeyWindow",
                    "Open popout chat window",
                    "Ctrl+Space"
                ]
                .map(str::to_string)
            )
            .unwrap(),
            [Shortcut {
                id: "hotkeyWindow".into(),
                description: "Open popout chat window".into(),
                trigger: "CTRL+space".into()
            }]
        );
        assert!(parse_args(["portal", "--shortcut"].map(str::to_string)).is_err());
        assert_eq!(
            parse_args(
                [
                    "portal",
                    "--shortcut",
                    "hotkeyWindow",
                    "Open popout chat window",
                    "Ctrl+Alt+G",
                    "--shortcut",
                    "openAvatarOverlay",
                    "Show Mini / Pet",
                    "Super+Alt+P"
                ]
                .map(str::to_string)
            )
            .unwrap()
            .len(),
            2
        );
        for (id, label, key) in [
            ("", "Show Mini", "Super+Alt+P"),
            ("bad id", "Show Mini", "Super+Alt+P"),
            ("openAvatarOverlay", "", "Super+Alt+P"),
            ("openAvatarOverlay", "Show\nMini", "Super+Alt+P"),
            ("openAvatarOverlay", "Show Mini", ""),
            ("openAvatarOverlay", "Show Mini", "Escape"),
            (&"x".repeat(129), "Show Mini", "Super+Alt+P"),
            ("openAvatarOverlay", &"x".repeat(513), "Super+Alt+P"),
            ("openAvatarOverlay", "Show Mini", &"x".repeat(129)),
        ] {
            assert!(
                parse_args(["portal", "--shortcut", id, label, key].map(str::to_string)).is_err()
            );
        }
        for (id, key) in [
            ("hotkeyWindow", "Ctrl+Alt+H"),
            ("openAvatarOverlay", "Ctrl+Alt+G"),
            ("openAvatarOverlay", "Alt+Control+G"),
        ] {
            assert!(parse_args(
                [
                    "portal",
                    "--shortcut",
                    "hotkeyWindow",
                    "Popout",
                    "Ctrl+Alt+G",
                    "--shortcut",
                    id,
                    "Other action",
                    key
                ]
                .map(str::to_string)
            )
            .is_err());
        }
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
    async fn portal_helper_subprocess() {
        let Ok(address) = std::env::var("CODEX_TEST_SHORTCUTS_BUS") else {
            return;
        };
        let client = Builder::address(address.as_str())
            .unwrap()
            .build()
            .await
            .unwrap();
        let shortcuts = parse_args(
            ["portal", "--shortcut", SHORTCUT_ID, "Dictation", "Ctrl+G"].map(str::to_string),
        )
        .unwrap();
        let mut interrupt =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt()).unwrap();
        super::exit_with(super::run_portal_on(&client, &shortcuts, &mut interrupt).await)
    }

    /// Runs the real helper loop in a child test process so SIGINT stays
    /// isolated from the test runner.
    fn spawn_helper(bus: &TestBus) -> Child {
        Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "tests::portal_helper_subprocess", "--nocapture"])
            .env("CODEX_TEST_SHORTCUTS_BUS", &bus.address)
            .env("CODEX_LINUX_APP_ID", "codex-desktop")
            .env("CHROME_DESKTOP", "chatgpt.desktop")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap()
    }

    /// Waits for BindShortcuts plus the fast paste-backend probe of an empty bus.
    async fn wait_for_event_loop(bound: &Mutex<Vec<String>>) {
        tokio::time::timeout(Duration::from_secs(3), async {
            while bound.lock().unwrap().is_empty() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("helper did not bind its shortcuts");
        tokio::time::sleep(Duration::from_millis(200)).await;
    }

    /// Waits until `ready` holds, optionally sends SIGINT, and returns the exit
    /// status with the helper's stderr. A helper that outlives the timeout fails.
    async fn finish_helper(
        mut child: Child,
        ready: impl Fn() -> bool,
        interrupt: bool,
    ) -> (std::process::ExitStatus, String) {
        let result = tokio::time::timeout(Duration::from_secs(5), async {
            while !ready() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            if interrupt {
                assert!(Command::new("kill")
                    .args(["-INT", &child.id().to_string()])
                    .status()
                    .unwrap()
                    .success());
            }
            loop {
                if let Some(status) = child.try_wait().unwrap() {
                    break status;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await;
        if result.is_err() {
            let _ = child.kill();
            let _ = child.wait();
        }
        let status = result.expect("helper did not stop in time");
        let mut stderr = String::new();
        std::io::Read::read_to_string(&mut child.stderr.take().unwrap(), &mut stderr).unwrap();
        (status, stderr)
    }

    #[tokio::test(flavor = "current_thread")]
    async fn cancellation_closes_a_session_while_consent_is_pending() {
        let bus = TestBus::start();
        let registry = FakeHostRegistry::default();
        let app_ids = registry.app_ids.clone();
        let portal = FakePortal {
            delay_bind: true,
            ..FakePortal::default()
        };
        let bound = portal.ids.clone();
        let session = FakeShortcutsSession::default();
        let closed = session.closed.clone();
        let _server = Builder::address(bus.address.as_str())
            .unwrap()
            .name(PORTAL_SERVICE)
            .unwrap()
            .serve_at(PORTAL_PATH, portal)
            .unwrap()
            .serve_at(PORTAL_PATH, registry)
            .unwrap()
            .serve_at(TEST_SESSION, session)
            .unwrap()
            .build()
            .await
            .unwrap();
        let child = spawn_helper(&bus);
        let (status, stderr) =
            finish_helper(child, || !bound.lock().unwrap().is_empty(), true).await;
        assert!(status.success(), "{stderr}");
        assert!(*closed.lock().unwrap());
        assert_eq!(*app_ids.lock().unwrap(), ["codex-desktop"]);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn interrupt_before_a_session_handle_exits_cleanly() {
        let bus = TestBus::start();
        let portal = FakePortal {
            delay_create: true,
            ..FakePortal::default()
        };
        let create_calls = portal.create_calls.clone();
        let _server = Builder::address(bus.address.as_str())
            .unwrap()
            .name(PORTAL_SERVICE)
            .unwrap()
            .serve_at(PORTAL_PATH, portal)
            .unwrap()
            .serve_at(PORTAL_PATH, FakeHostRegistry::default())
            .unwrap()
            .build()
            .await
            .unwrap();
        // Without a handler installed up front, SIGINT here killed the helper by signal.
        let (status, stderr) = finish_helper(
            spawn_helper(&bus),
            || *create_calls.lock().unwrap() > 0,
            true,
        )
        .await;
        assert!(status.success(), "{stderr}");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn interrupt_during_paste_consent_closes_the_shortcuts_session() {
        let bus = TestBus::start();
        let remote = FakeRemoteDesktop {
            delay_create: true,
            ..FakeRemoteDesktop::default()
        };
        let paste_requests = remote.create_count.clone();
        let key_events = remote.key_events.clone();
        let session = FakeShortcutsSession::default();
        let closed = session.closed.clone();
        let _server = Builder::address(bus.address.as_str())
            .unwrap()
            .name(PORTAL_SERVICE)
            .unwrap()
            .serve_at(PORTAL_PATH, FakePortal::default())
            .unwrap()
            .serve_at(PORTAL_PATH, FakeHostRegistry::default())
            .unwrap()
            .serve_at(PORTAL_PATH, remote)
            .unwrap()
            .serve_at(TEST_SESSION, session)
            .unwrap()
            .build()
            .await
            .unwrap();
        let mut child = spawn_helper(&bus);
        std::io::Write::write_all(child.stdin.as_mut().unwrap(), b"paste\n").unwrap();
        // The RemoteDesktop consent request stays pending; SIGINT used to wait
        // for its 30-second timeout and was then lost.
        let (status, stderr) =
            finish_helper(child, || *paste_requests.lock().unwrap() > 0, true).await;
        assert!(status.success(), "{stderr}");
        assert!(*closed.lock().unwrap());
        assert!(key_events.lock().unwrap().is_empty());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn portal_session_closure_ends_the_helper_without_closing_again() {
        let bus = TestBus::start();
        let portal = FakePortal::default();
        let bound = portal.ids.clone();
        let session = FakeShortcutsSession::default();
        let closed = session.closed.clone();
        let server = Builder::address(bus.address.as_str())
            .unwrap()
            .name(PORTAL_SERVICE)
            .unwrap()
            .serve_at(PORTAL_PATH, portal)
            .unwrap()
            .serve_at(PORTAL_PATH, FakeHostRegistry::default())
            .unwrap()
            .serve_at(TEST_SESSION, session)
            .unwrap()
            .build()
            .await
            .unwrap();
        let child = spawn_helper(&bus);
        wait_for_event_loop(&bound).await;
        let details: HashMap<String, OwnedValue> = HashMap::new();
        server
            .emit_signal(
                None::<&str>,
                TEST_SESSION,
                SESSION_INTERFACE,
                "Closed",
                &(details,),
            )
            .await
            .unwrap();
        let (status, stderr) = finish_helper(child, || true, false).await;
        assert!(!status.success());
        assert!(stderr.contains(SESSION_CLOSED_BY_PORTAL), "{stderr}");
        assert!(!*closed.lock().unwrap());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn interrupt_in_the_event_loop_exits_promptly() {
        let bus = TestBus::start();
        let portal = FakePortal::default();
        let bound = portal.ids.clone();
        let session = FakeShortcutsSession::default();
        let closed = session.closed.clone();
        let _server = Builder::address(bus.address.as_str())
            .unwrap()
            .name(PORTAL_SERVICE)
            .unwrap()
            .serve_at(PORTAL_PATH, portal)
            .unwrap()
            .serve_at(PORTAL_PATH, FakeHostRegistry::default())
            .unwrap()
            .serve_at(TEST_SESSION, session)
            .unwrap()
            .build()
            .await
            .unwrap();
        let child = spawn_helper(&bus);
        wait_for_event_loop(&bound).await;
        // The pending stdin read used to block runtime shutdown after Close.
        let (status, stderr) = finish_helper(child, || true, true).await;
        assert!(status.success(), "{stderr}");
        assert!(*closed.lock().unwrap());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn closing_an_already_released_session_succeeds() {
        let bus = TestBus::start();
        let unknown_method = "/org/freedesktop/portal/desktop/session/test/gdbus_gone";
        let denied = "/org/freedesktop/portal/desktop/session/test/denied";
        let _server = Builder::address(bus.address.as_str())
            .unwrap()
            .name(PORTAL_SERVICE)
            .unwrap()
            .serve_at(
                unknown_method,
                FakeShortcutsSession {
                    close_error: Some(zbus::fdo::Error::UnknownMethod),
                    ..FakeShortcutsSession::default()
                },
            )
            .unwrap()
            .serve_at(
                denied,
                FakeShortcutsSession {
                    close_error: Some(zbus::fdo::Error::AccessDenied),
                    ..FakeShortcutsSession::default()
                },
            )
            .unwrap()
            .build()
            .await
            .unwrap();
        let client = bus_client(&bus).await;
        // No object at the path: zbus answers UnknownObject.
        close_session_checked(&client, &OwnedObjectPath::try_from(TEST_SESSION).unwrap())
            .await
            .unwrap();
        // GDBus, which xdg-desktop-portal uses, answers UnknownMethod.
        close_session_checked(&client, &OwnedObjectPath::try_from(unknown_method).unwrap())
            .await
            .unwrap();
        assert!(
            close_session_checked(&client, &OwnedObjectPath::try_from(denied).unwrap())
                .await
                .is_err()
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn accepts_partial_portal_approval() {
        let bus = TestBus::start();
        let portal = FakePortal {
            accepted: Some(vec![SHORTCUT_ID.into()]),
            ..FakePortal::default()
        };
        let _server = Builder::address(bus.address.as_str())
            .unwrap()
            .name(PORTAL_SERVICE)
            .unwrap()
            .serve_at(PORTAL_PATH, portal)
            .unwrap()
            .build()
            .await
            .unwrap();
        let client = bus_client(&bus).await;
        let proxy = zbus::Proxy::new(&client, PORTAL_SERVICE, PORTAL_PATH, SHORTCUTS_INTERFACE)
            .await
            .unwrap();
        let session = create_session(&client, &proxy).await.unwrap();
        let shortcuts = parse_args(
            [
                "portal",
                "--shortcut",
                SHORTCUT_ID,
                "Dictation",
                "Ctrl+G",
                "--shortcut",
                "hotkeyWindow",
                "Popout",
                "Ctrl+H",
            ]
            .map(str::to_string),
        )
        .unwrap();
        let bound = bind_shortcuts(&client, &proxy, &session, &shortcuts)
            .await
            .unwrap();
        assert_eq!(bound.len(), 1);
        assert_eq!(
            super::binding_lines(&shortcuts, &bound, &mut [false, false]).unwrap(),
            ["bindings", "bound:0:", "ready"]
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn registers_and_receives_press_and_release_through_the_portal() {
        let bus = TestBus::start();
        let portal = FakePortal::default();
        let observed_trigger = portal.trigger.clone();
        let observed_ids = portal.ids.clone();
        let observed_description = portal.description.clone();
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
        bind_shortcuts(
            &client,
            &proxy,
            &session,
            &[
                Shortcut {
                    id: SHORTCUT_ID.into(),
                    description: "Dictation: hold to talk".into(),
                    trigger: "CTRL+SHIFT+space".into(),
                },
                Shortcut {
                    id: "openAvatarOverlay".into(),
                    description: "Показать Mini / Pet".into(),
                    trigger: "LOGO+ALT+p".into(),
                },
            ],
        )
        .await
        .unwrap();
        assert_eq!(
            observed_trigger.lock().unwrap().as_deref(),
            Some("CTRL+SHIFT+space")
        );
        assert_eq!(
            *observed_ids.lock().unwrap(),
            [SHORTCUT_ID, "openAvatarOverlay"]
        );
        assert_eq!(
            observed_description.lock().unwrap().as_deref(),
            Some("Dictation: hold to talk")
        );

        let mut signals = proxy.receive_all_signals().await.unwrap();
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

        let down = tokio::time::timeout(Duration::from_secs(1), signals.next())
            .await
            .unwrap()
            .unwrap();
        let up = tokio::time::timeout(Duration::from_secs(1), signals.next())
            .await
            .unwrap()
            .unwrap();
        assert!(signal_matches(&down, &session, SHORTCUT_ID).unwrap());
        assert!(signal_matches(&up, &session, SHORTCUT_ID).unwrap());
        assert_eq!(down.header().member().unwrap().as_str(), "Activated");
        assert_eq!(up.header().member().unwrap().as_str(), "Deactivated");
        assert!(!signal_matches(&down, &session, "hotkeyWindow").unwrap());
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
