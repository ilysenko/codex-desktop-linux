// SPDX-License-Identifier: MIT
//! Background keyboard input for a Chromium tab over the DevTools protocol.
//!
//! The user opts in by starting the browser with `--remote-debugging-port`
//! and naming that port, or the browser's `DevToolsActivePort` file, in
//! `CODEX_COMPUTER_USE_DEVTOOLS` (standalone alias `COMPUTER_USE_LINUX_DEVTOOLS`).
//! The server only connects to that port on
//! 127.0.0.1; it never starts or restarts a browser. `Input.insertText` and
//! `Input.dispatchKeyEvent` reach the tab's focused element without OS
//! keyboard focus. The WebSocket client here is the small subset DevTools
//! needs: one connection, masked text frames out, text frames in.

use crate::background_input::Chord;
use anyhow::{anyhow, bail, Context, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{env, path::Path, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    time::{sleep, timeout, Instant},
};

pub(crate) const DEVTOOLS_ENV: &str = "CODEX_COMPUTER_USE_DEVTOOLS";
/// Standalone alias of [`DEVTOOLS_ENV`], read when the Codex name is unset.
pub(crate) const DEVTOOLS_ENV_STANDALONE: &str = "COMPUTER_USE_LINUX_DEVTOOLS";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
const CALL_TIMEOUT: Duration = Duration::from_secs(5);
const READBACK_TIMEOUT: Duration = Duration::from_secs(1);
const MAX_HTTP_BYTES: usize = 4 * 1024 * 1024;
const MAX_FRAME_BYTES: u64 = 16 * 1024 * 1024;
/// Characters of a mismatched readback that an error quotes.
const MAX_QUOTED_CHARS: usize = 256;

/// The loopback port of the browser the user opened for DevTools.
pub(crate) fn configured_port() -> std::result::Result<u16, String> {
    let value = env::var(DEVTOOLS_ENV)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| env::var(DEVTOOLS_ENV_STANDALONE).ok())
        .unwrap_or_default();
    if value.trim().is_empty() {
        return Err(format!(
            "background delivery to a browser tab needs {DEVTOOLS_ENV} (or {DEVTOOLS_ENV_STANDALONE}): the port of a browser started with --remote-debugging-port, or the path of its DevToolsActivePort file"
        ));
    }
    parse_port_setting(value.trim(), |path| {
        std::fs::read_to_string(path).map_err(|error| error.to_string())
    })
}

/// A port number, or an absolute path to a `DevToolsActivePort` file whose
/// first line is the port.
fn parse_port_setting(
    value: &str,
    read: impl FnOnce(&Path) -> std::result::Result<String, String>,
) -> std::result::Result<u16, String> {
    let parse = |text: &str, what: &str| {
        text.trim()
            .parse::<u16>()
            .ok()
            .filter(|port| *port != 0)
            .ok_or_else(|| format!("{DEVTOOLS_ENV}: {what} is not a port number"))
    };
    if value.bytes().all(|byte| byte.is_ascii_digit()) {
        return parse(value, &format!("{value:?}"));
    }
    let path = Path::new(value);
    if !path.is_absolute() {
        return Err(format!(
            "{DEVTOOLS_ENV} must be a port number or an absolute path to a DevToolsActivePort file"
        ));
    }
    let contents = read(path).map_err(|error| format!("cannot read {value}: {error}"))?;
    parse(
        contents.lines().next().unwrap_or_default(),
        &format!("the first line of {value}"),
    )
}

/// One DevTools target the HTTP endpoint lists.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub(crate) struct Tab {
    pub id: String,
    #[serde(rename = "type", default)]
    pub kind: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub url: String,
}

/// The page tab a `browser_tab` selector names: a target id exactly, or else
/// one page whose URL or title contains it, ignoring ASCII case.
pub(crate) fn select_tab<'a>(
    tabs: &'a [Tab],
    selector: &str,
) -> std::result::Result<&'a Tab, String> {
    let selector = selector.trim();
    if selector.is_empty() {
        return Err("browser_tab is empty".to_string());
    }
    let pages = tabs
        .iter()
        .filter(|tab| tab.kind == "page")
        .collect::<Vec<_>>();
    if let Some(tab) = pages.iter().find(|tab| tab.id == selector) {
        return Ok(tab);
    }
    let needle = selector.to_ascii_lowercase();
    let matches = pages
        .iter()
        .filter(|tab| {
            tab.url.to_ascii_lowercase().contains(&needle)
                || tab.title.to_ascii_lowercase().contains(&needle)
        })
        .collect::<Vec<_>>();
    let listing = |tabs: &[&&Tab]| {
        tabs.iter()
            .take(10)
            .map(|tab| format!("{} {:?} {}", tab.id, tab.title, tab.url))
            .collect::<Vec<_>>()
            .join("; ")
    };
    match matches.as_slice() {
        [tab] => Ok(tab),
        [] => Err(format!(
            "no page tab has id {selector:?} or a URL or title containing it; page tabs: {}",
            if pages.is_empty() {
                "none".to_string()
            } else {
                listing(&pages.iter().collect::<Vec<_>>())
            }
        )),
        several => Err(format!(
            "{} page tabs match {selector:?}; pass one id: {}",
            several.len(),
            listing(several)
        )),
    }
}

/// The page tabs of the browser on `port`.
pub(crate) async fn list_tabs(port: u16) -> Result<Vec<Tab>> {
    let body = http_get(port, "/json/list").await?;
    serde_json::from_str(&body).context("the DevTools endpoint returned an unreadable tab list")
}

async fn http_get(port: u16, path: &str) -> Result<String> {
    let mut stream = connect(port).await?;
    let request =
        format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    let mut response = Vec::new();
    timeout(CALL_TIMEOUT, async {
        stream.write_all(request.as_bytes()).await?;
        let mut chunk = [0u8; 16 * 1024];
        loop {
            let read = stream.read(&mut chunk).await?;
            if read == 0 {
                break;
            }
            response.extend_from_slice(&chunk[..read]);
            if response.len() > MAX_HTTP_BYTES {
                bail!("the DevTools endpoint answered with more than 4 MiB");
            }
            // Chrome keeps the connection open, so stop at the body's end.
            if http_response_complete(&response) {
                break;
            }
        }
        Ok(())
    })
    .await
    .context("the DevTools endpoint did not answer within 5 seconds")??;
    let split = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(|| anyhow!("the DevTools endpoint sent no HTTP header"))?;
    let head = String::from_utf8_lossy(&response[..split]).to_string();
    let body = &response[split + 4..];
    let status = head.lines().next().unwrap_or_default();
    if status.split_whitespace().nth(1) != Some("200") {
        bail!("the DevTools endpoint answered {status:?}");
    }
    let chunked = head.lines().any(|line| {
        line.to_ascii_lowercase()
            .replace(' ', "")
            .starts_with("transfer-encoding:chunked")
    });
    let body = if chunked {
        dechunk(body)?
    } else {
        body.to_vec()
    };
    String::from_utf8(body).context("the DevTools endpoint sent non-UTF-8 text")
}

/// Whether `response` holds a whole HTTP response: its Content-Length is
/// read, or its chunked body ended.
fn http_response_complete(response: &[u8]) -> bool {
    let Some(split) = response.windows(4).position(|window| window == b"\r\n\r\n") else {
        return false;
    };
    let head = String::from_utf8_lossy(&response[..split]).to_ascii_lowercase();
    let body = &response[split + 4..];
    if let Some(length) = head.lines().find_map(|line| {
        line.strip_prefix("content-length:")
            .and_then(|value| value.trim().parse::<usize>().ok())
    }) {
        return body.len() >= length;
    }
    head.lines()
        .any(|line| line.replace(' ', "") == "transfer-encoding:chunked")
        && body.ends_with(b"0\r\n\r\n")
}

fn dechunk(mut body: &[u8]) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    loop {
        let line_end = body
            .windows(2)
            .position(|window| window == b"\r\n")
            .ok_or_else(|| anyhow!("a chunked HTTP body ended early"))?;
        let size_text = String::from_utf8_lossy(&body[..line_end]).to_string();
        let size = usize::from_str_radix(size_text.split(';').next().unwrap_or("").trim(), 16)
            .context("a chunked HTTP body has a bad chunk size")?;
        body = &body[line_end + 2..];
        if size == 0 {
            return Ok(out);
        }
        if body.len() < size {
            bail!("a chunked HTTP body ended early");
        }
        out.extend_from_slice(&body[..size]);
        body = body.get(size + 2..).unwrap_or_default();
    }
}

/// Whether the listener on 127.0.0.1:`port` belongs to this user. Once
/// the browser exits, another user could take the port and read what is
/// typed, so a port whose listener is someone else's is refused.
fn listener_is_ours(port: u16) -> std::result::Result<(), String> {
    // SAFETY: getuid cannot fail.
    let uid = unsafe { libc::getuid() };
    let tables = ["/proc/net/tcp", "/proc/net/tcp6"]
        .iter()
        .filter_map(|path| std::fs::read_to_string(path).ok())
        .collect::<Vec<_>>();
    let owners = tables
        .iter()
        .flat_map(|table| loopback_listener_uids(table, port))
        .collect::<Vec<_>>();
    if owners.is_empty() {
        return Err(format!(
            "nothing listens on 127.0.0.1:{port}; is the browser running with --remote-debugging-port={port}?"
        ));
    }
    if owners.iter().any(|owner| *owner != uid) {
        return Err(format!(
            "the listener on 127.0.0.1:{port} belongs to another user, so nothing is sent to it"
        ));
    }
    Ok(())
}

/// The uids of listening sockets in a `/proc/net/tcp` or `tcp6` table that
/// accept connections to 127.0.0.1:`port`.
fn loopback_listener_uids(table: &str, port: u16) -> Vec<u32> {
    const REACHES_LOOPBACK: &[&str] = &[
        "0100007F",
        "00000000",
        "00000000000000000000000000000000",
        "0000000000000000FFFF00000100007F",
    ];
    table
        .lines()
        .skip(1)
        .filter_map(|line| {
            let fields = line.split_whitespace().collect::<Vec<_>>();
            let (address, local_port) = fields.get(1)?.split_once(':')?;
            let listening = fields.get(3)? == &"0A";
            let matches = u16::from_str_radix(local_port, 16).ok()? == port
                && REACHES_LOOPBACK.contains(&address);
            (listening && matches).then(|| fields.get(7)?.parse().ok())?
        })
        .collect()
}

async fn connect(port: u16) -> Result<TcpStream> {
    listener_is_ours(port).map_err(|error| anyhow!(error))?;
    timeout(CONNECT_TIMEOUT, TcpStream::connect(("127.0.0.1", port)))
        .await
        .with_context(|| format!("connecting to DevTools on 127.0.0.1:{port} timed out"))?
        .with_context(|| {
            format!("cannot connect to DevTools on 127.0.0.1:{port}; is the browser running with --remote-debugging-port={port}?")
        })
}

/// A DevTools WebSocket session to one tab.
struct Session {
    stream: TcpStream,
    next_id: u64,
}

impl Session {
    async fn open(port: u16, tab: &Tab) -> Result<Self> {
        if tab.id.is_empty()
            || !tab
                .id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        {
            bail!("the DevTools tab id {:?} is not a plain id", tab.id);
        }
        let mut stream = connect(port).await?;
        let mut key = [0u8; 16];
        getrandom::fill(&mut key).map_err(|error| anyhow!("no random bytes: {error}"))?;
        let key = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, key);
        let request = format!(
            "GET /devtools/page/{} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n",
            tab.id
        );
        timeout(CALL_TIMEOUT, async {
            stream.write_all(request.as_bytes()).await?;
            let mut head = Vec::new();
            let mut byte = [0u8; 1];
            while !head.ends_with(b"\r\n\r\n") {
                if stream.read(&mut byte).await? == 0 {
                    bail!("DevTools closed the connection during the WebSocket handshake");
                }
                head.push(byte[0]);
                if head.len() > 16 * 1024 {
                    bail!("the DevTools WebSocket handshake answer is too long");
                }
            }
            let status = String::from_utf8_lossy(&head)
                .lines()
                .next()
                .unwrap_or_default()
                .to_string();
            if status.split_whitespace().nth(1) != Some("101") {
                bail!("DevTools refused the WebSocket connection: {status:?}");
            }
            Ok(())
        })
        .await
        .context("the DevTools WebSocket handshake timed out")??;
        Ok(Self { stream, next_id: 1 })
    }

    async fn send_frame(&mut self, opcode: u8, payload: &[u8]) -> Result<()> {
        let mut frame = vec![0x80 | opcode];
        let len = payload.len();
        if len < 126 {
            frame.push(0x80 | len as u8);
        } else if len <= u16::MAX as usize {
            frame.push(0x80 | 126);
            frame.extend_from_slice(&(len as u16).to_be_bytes());
        } else {
            frame.push(0x80 | 127);
            frame.extend_from_slice(&(len as u64).to_be_bytes());
        }
        let mut mask = [0u8; 4];
        getrandom::fill(&mut mask).map_err(|error| anyhow!("no random bytes: {error}"))?;
        frame.extend_from_slice(&mask);
        frame.extend(
            payload
                .iter()
                .enumerate()
                .map(|(index, byte)| byte ^ mask[index % 4]),
        );
        self.stream.write_all(&frame).await?;
        Ok(())
    }

    /// The next whole text message, answering pings on the way.
    async fn read_message(&mut self) -> Result<String> {
        let mut message = Vec::new();
        loop {
            let mut head = [0u8; 2];
            self.stream.read_exact(&mut head).await?;
            let fin = head[0] & 0x80 != 0;
            let opcode = head[0] & 0x0f;
            let masked = head[1] & 0x80 != 0;
            let mut len = u64::from(head[1] & 0x7f);
            if len == 126 {
                let mut bytes = [0u8; 2];
                self.stream.read_exact(&mut bytes).await?;
                len = u64::from(u16::from_be_bytes(bytes));
            } else if len == 127 {
                let mut bytes = [0u8; 8];
                self.stream.read_exact(&mut bytes).await?;
                len = u64::from_be_bytes(bytes);
            }
            if len > MAX_FRAME_BYTES {
                bail!("a DevTools message is larger than 16 MiB");
            }
            let mut mask = [0u8; 4];
            if masked {
                self.stream.read_exact(&mut mask).await?;
            }
            let mut payload = vec![0u8; len as usize];
            self.stream.read_exact(&mut payload).await?;
            if masked {
                for (index, byte) in payload.iter_mut().enumerate() {
                    *byte ^= mask[index % 4];
                }
            }
            match opcode {
                0x0 | 0x1 => {
                    message.extend_from_slice(&payload);
                    if message.len() as u64 > MAX_FRAME_BYTES {
                        bail!("a DevTools message is larger than 16 MiB");
                    }
                    if fin {
                        return String::from_utf8(message)
                            .context("DevTools sent a non-UTF-8 message");
                    }
                }
                0x8 => bail!("DevTools closed the WebSocket"),
                0x9 => self.send_frame(0xA, &payload).await?,
                _ => {}
            }
        }
    }

    /// One DevTools command; events that arrive before its answer are skipped.
    async fn call(&mut self, method: &str, params: Value) -> Result<Value> {
        let id = self.next_id;
        self.next_id += 1;
        let request = json!({"id": id, "method": method, "params": params}).to_string();
        timeout(CALL_TIMEOUT, async {
            self.send_frame(0x1, request.as_bytes()).await?;
            loop {
                let message: Value = serde_json::from_str(&self.read_message().await?)
                    .context("DevTools sent unreadable JSON")?;
                if message.get("id").and_then(Value::as_u64) != Some(id) {
                    continue;
                }
                if let Some(error) = message.get("error") {
                    bail!(
                        "{method} failed: {}",
                        error
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("unknown error")
                    );
                }
                return Ok(message.get("result").cloned().unwrap_or(Value::Null));
            }
        })
        .await
        .with_context(|| format!("{method} did not answer within 5 seconds"))?
    }

    async fn close(mut self) {
        let _ = self.send_frame(0x8, &[]).await;
    }

    /// Let the page act as focused although its window is not, so focus
    /// handlers and caret logic run as they do for typing.
    async fn emulate_focus(&mut self) {
        let _ = self
            .call(
                "Emulation.setFocusEmulationEnabled",
                json!({"enabled": true}),
            )
            .await;
    }

    async fn focused_field(&mut self) -> Result<FocusedField> {
        let result = self
            .call(
                "Runtime.evaluate",
                json!({"expression": FOCUSED_FIELD_SCRIPT, "returnByValue": true}),
            )
            .await?;
        if let Some(details) = result.get("exceptionDetails") {
            bail!("reading the tab's focused element failed: {details}");
        }
        let value = result
            .get("result")
            .and_then(|result| result.get("value"))
            .cloned()
            .unwrap_or(Value::Null);
        Ok(FocusedField::from_value(&value))
    }
}

/// Finds the focused element through shadow roots and same-origin frames.
const FOCUSED_FIELD_SCRIPT: &str = r#"(() => {
  let doc = document, e = doc.activeElement;
  for (let i = 0; i < 32 && e; i++) {
    if (e.shadowRoot && e.shadowRoot.activeElement) { e = e.shadowRoot.activeElement; continue; }
    if (e.tagName === 'IFRAME' || e.tagName === 'FRAME') {
      let inner = null;
      try { inner = e.contentDocument; } catch (_) {}
      if (!inner) return {kind: 'frame'};
      doc = inner; e = inner.activeElement; continue;
    }
    break;
  }
  // A designMode document or a contenteditable body is an editor itself.
  if (e && (e === doc.body || e === doc.documentElement)) {
    if (doc.designMode === 'on' || (doc.body && doc.body.isContentEditable)) return {kind: 'editable', tag: 'body'};
    return {kind: 'none'};
  }
  if (!e) return {kind: 'none'};
  const tag = e.tagName.toLowerCase();
  if (tag === 'textarea' || tag === 'input') {
    let start = null, end = null;
    try { start = e.selectionStart; end = e.selectionEnd; } catch (_) {}
    return {kind: 'field', tag, type: (e.type || '').toLowerCase(), value: String(e.value),
      start, end, readOnly: !!(e.readOnly || e.disabled)};
  }
  if (e.isContentEditable) return {kind: 'editable', tag};
  return {kind: 'other', tag, role: e.getAttribute('role') || ''};
})()"#;

#[derive(Debug, Clone, PartialEq)]
enum FocusedField {
    /// An input or textarea; offsets are UTF-16 units, `None` where the
    /// input type has no selection API (email, number).
    Field {
        tag: String,
        kind: String,
        value: String,
        selection: Option<(usize, usize)>,
        read_only: bool,
    },
    ContentEditable(String),
    /// Focus is in a frame this page cannot read (another origin).
    Frame,
    None,
    Other(String),
}

impl FocusedField {
    fn from_value(value: &Value) -> Self {
        let text = |key: &str| {
            value
                .get(key)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string()
        };
        match value.get("kind").and_then(Value::as_str) {
            Some("field") => {
                let offset = |key: &str| value.get(key).and_then(Value::as_u64).map(|n| n as usize);
                FocusedField::Field {
                    tag: text("tag"),
                    kind: text("type"),
                    value: text("value"),
                    selection: offset("start").zip(offset("end")),
                    read_only: value
                        .get("readOnly")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                }
            }
            Some("editable") => FocusedField::ContentEditable(text("tag")),
            Some("frame") => FocusedField::Frame,
            Some("none") => FocusedField::None,
            _ => {
                let role = text("role");
                FocusedField::Other(if role.is_empty() {
                    text("tag")
                } else {
                    format!("{} (role {role})", text("tag"))
                })
            }
        }
    }

    fn describe(&self) -> String {
        match self {
            FocusedField::Field { tag, kind, .. } if tag == "input" => format!("input type={kind}"),
            FocusedField::Field { tag, .. } => tag.clone(),
            FocusedField::ContentEditable(tag) => format!("contenteditable {tag}"),
            FocusedField::Frame => "a frame from another origin".to_string(),
            FocusedField::None => "no element".to_string(),
            FocusedField::Other(tag) => tag.clone(),
        }
    }

    fn is_password(&self) -> bool {
        matches!(self, FocusedField::Field { kind, .. } if kind == "password")
    }
}

/// What a tab text insert did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum TabTextOutcome {
    /// The field reads back the text where it went in, the rest unchanged.
    Verified { field: String },
    /// A password field took the text; its value is never read back or quoted.
    PasswordVerified,
    /// A contenteditable element: DevTools inserted, nothing checks where.
    Unverified { field: String },
}

/// The value a field should hold after `text` replaces UTF-16 range
/// `start..end` of `before`, or `None` when the range does not fit.
fn expected_value(before: &str, start: usize, end: usize, text: &str) -> Option<String> {
    let units = before.encode_utf16().collect::<Vec<_>>();
    if start > end || end > units.len() {
        return None;
    }
    let mut out = units[..start].to_vec();
    out.extend(text.encode_utf16());
    out.extend_from_slice(&units[end..]);
    String::from_utf16(&out).ok()
}

fn has_control(text: &str, allow_lines: bool) -> bool {
    text.chars()
        .any(|ch| ch.is_control() && !(allow_lines && (ch == '\n' || ch == '\t')))
}

fn quoted(text: &str) -> String {
    let mut out = text.chars().take(MAX_QUOTED_CHARS).collect::<String>();
    if text.chars().count() > MAX_QUOTED_CHARS {
        out.push('…');
    }
    format!("{out:?}")
}

/// Insert `text` at the caret of the tab's focused element, as typing would
/// (a selection is replaced), and read it back. Refused before anything is
/// sent when the focused element does not take text.
pub(crate) async fn insert_text(
    port: u16,
    tab: &Tab,
    text: &str,
) -> std::result::Result<TabTextOutcome, String> {
    let mut session = Session::open(port, tab)
        .await
        .map_err(|error| format!("{error:#}"))?;
    let result = insert_text_in(&mut session, text).await;
    session.close().await;
    result
}

async fn insert_text_in(
    session: &mut Session,
    text: &str,
) -> std::result::Result<TabTextOutcome, String> {
    session.emulate_focus().await;
    let field = session
        .focused_field()
        .await
        .map_err(|error| format!("{error:#}"))?;
    let multi_line = match &field {
        FocusedField::Field { tag, read_only, .. } => {
            if *read_only {
                return Err(format!(
                    "nothing was sent: the tab's focused {} is read-only",
                    field.describe()
                ));
            }
            tag == "textarea"
        }
        FocusedField::ContentEditable(_) => true,
        other => {
            return Err(format!(
                "nothing was sent: the tab's focused element ({}) does not take text; focus a field in the tab first",
                other.describe()
            ))
        }
    };
    if has_control(text, multi_line) {
        return Err(format!(
            "nothing was sent: the text has a control character that the tab's focused {} would not take as text; send keys with press_key",
            field.describe()
        ));
    }
    session
        .call("Input.insertText", json!({"text": text}))
        .await
        .map_err(|error| format!("{error:#} (the field may have changed)"))?;
    let FocusedField::Field {
        value: before,
        selection,
        ..
    } = &field
    else {
        return Ok(TabTextOutcome::Unverified {
            field: field.describe(),
        });
    };
    let expected = match selection {
        Some((start, end)) => expected_value(before, *start, *end, text),
        None => None,
    };
    let deadline = Instant::now() + READBACK_TIMEOUT;
    let mut last = None;
    loop {
        if let Ok(FocusedField::Field { value, .. }) = session.focused_field().await {
            let matched = match &expected {
                Some(expected) => &value == expected,
                // No selection API: the text went in somewhere, the rest kept.
                None => {
                    value.encode_utf16().count()
                        == before.encode_utf16().count() + text.encode_utf16().count()
                        && value.contains(text)
                }
            };
            if matched {
                return Ok(if field.is_password() {
                    TabTextOutcome::PasswordVerified
                } else {
                    TabTextOutcome::Verified {
                        field: field.describe(),
                    }
                });
            }
            last = Some(value);
        }
        if Instant::now() >= deadline {
            break;
        }
        sleep(Duration::from_millis(50)).await;
    }
    Err(match (field.is_password(), last) {
        (true, _) => "DevTools inserted the text, but the password field does not read it back; it may have changed".to_string(),
        (false, Some(value)) => format!(
            "DevTools inserted the text, but the {} reads {} instead of {}; it may have changed",
            field.describe(),
            quoted(&value),
            expected.as_deref().map_or_else(|| "the text added to its old value".to_string(), quoted)
        ),
        (false, None) => "DevTools inserted the text, but the field could not be read back; it may have changed".to_string(),
    })
}

/// Whether DevTools has key events for `chord`, checked before any connection.
pub(crate) fn key_supported(chord: &Chord) -> std::result::Result<(), String> {
    key_events(chord).map(drop)
}

/// Send a chord to the tab's focused element. Returns the element it went to.
pub(crate) async fn press_key(
    port: u16,
    tab: &Tab,
    chord: &Chord,
) -> std::result::Result<String, String> {
    let events = key_events(chord)?;
    let mut session = Session::open(port, tab)
        .await
        .map_err(|error| format!("{error:#}"))?;
    let result = async {
        session.emulate_focus().await;
        let field = session
            .focused_field()
            .await
            .map_err(|error| format!("{error:#}"))?;
        for (index, event) in events.into_iter().enumerate() {
            session
                .call("Input.dispatchKeyEvent", event)
                .await
                .map_err(|error| {
                    if index == 0 {
                        format!("{error:#}; nothing was sent")
                    } else {
                        format!("{error:#}; part of the chord was sent")
                    }
                })?;
        }
        Ok(field.describe())
    }
    .await;
    session.close().await;
    result
}

struct KeyInfo {
    key: String,
    code: String,
    key_code: u32,
    text: Option<String>,
}

fn key_info(name: &str, shift: bool) -> std::result::Result<KeyInfo, String> {
    let info = |key: &str, code: &str, key_code: u32, text: Option<&str>| KeyInfo {
        key: key.to_string(),
        code: code.to_string(),
        key_code,
        text: text.map(str::to_string),
    };
    let mut chars = name.chars();
    if let (Some(ch), None) = (chars.next(), chars.next()) {
        if ch.is_ascii_lowercase() {
            let key = if shift { ch.to_ascii_uppercase() } else { ch }.to_string();
            return Ok(KeyInfo {
                code: format!("Key{}", ch.to_ascii_uppercase()),
                key_code: u32::from(ch.to_ascii_uppercase()),
                text: Some(key.clone()),
                key,
            });
        }
        if ch.is_ascii_digit() {
            if shift {
                return Err(
                    "Shift with a digit depends on the keyboard layout; type the symbol with type_text"
                        .to_string(),
                );
            }
            return Ok(info(
                &ch.to_string(),
                &format!("Digit{ch}"),
                u32::from(ch),
                Some(&ch.to_string()),
            ));
        }
    }
    Ok(match name {
        "Return" => info("Enter", "Enter", 13, Some("\r")),
        "KP_Enter" => info("Enter", "NumpadEnter", 13, Some("\r")),
        "Escape" => info("Escape", "Escape", 27, None),
        "Tab" => info("Tab", "Tab", 9, None),
        "BackSpace" => info("Backspace", "Backspace", 8, None),
        "Delete" => info("Delete", "Delete", 46, None),
        "space" => info(" ", "Space", 32, Some(" ")),
        "Home" => info("Home", "Home", 36, None),
        "End" => info("End", "End", 35, None),
        "Prior" => info("PageUp", "PageUp", 33, None),
        "Next" => info("PageDown", "PageDown", 34, None),
        "Left" => info("ArrowLeft", "ArrowLeft", 37, None),
        "Up" => info("ArrowUp", "ArrowUp", 38, None),
        "Right" => info("ArrowRight", "ArrowRight", 39, None),
        "Down" => info("ArrowDown", "ArrowDown", 40, None),
        "Control_L" => info("Control", "ControlLeft", 17, None),
        "Alt_L" => info("Alt", "AltLeft", 18, None),
        "Shift_L" => info("Shift", "ShiftLeft", 16, None),
        "Super_L" => info("Meta", "MetaLeft", 91, None),
        function => {
            let number = function
                .strip_prefix('F')
                .and_then(|n| n.parse::<u32>().ok())
                .filter(|n| (1..=12).contains(n))
                .ok_or_else(|| format!("{function} has no DevTools key"))?;
            info(function, function, 111 + number, None)
        }
    })
}

/// `Input.dispatchKeyEvent` parameters for a chord: modifier downs, the
/// key's down and up, then modifier ups in reverse. A key that types text
/// sends it with the down, as a keyboard does, unless Ctrl, Alt or Meta is
/// held.
fn key_events(chord: &Chord) -> std::result::Result<Vec<Value>, String> {
    let key = key_info(&chord.key, chord.shift)?;
    let held = [
        (chord.alt, "Alt_L", 1),
        (chord.ctrl, "Control_L", 2),
        (chord.meta, "Super_L", 4),
        (chord.shift, "Shift_L", 8),
    ];
    let mut events = Vec::new();
    let mut modifiers = 0;
    let event = |kind: &str, info: &KeyInfo, modifiers: u32, text: Option<&str>| {
        let mut event = json!({
            "type": kind,
            "key": info.key,
            "code": info.code,
            "windowsVirtualKeyCode": info.key_code,
            "nativeVirtualKeyCode": info.key_code,
            "modifiers": modifiers,
        });
        if let Some(text) = text {
            event["text"] = json!(text);
            event["unmodifiedText"] = json!(text);
        }
        event
    };
    for (on, name, bit) in held {
        if on {
            modifiers |= bit;
            events.push(event(
                "rawKeyDown",
                &key_info(name, false)?,
                modifiers,
                None,
            ));
        }
    }
    let text = key
        .text
        .as_deref()
        .filter(|_| !chord.ctrl && !chord.alt && !chord.meta);
    let down = if text.is_some() {
        "keyDown"
    } else {
        "rawKeyDown"
    };
    events.push(event(down, &key, modifiers, text));
    events.push(event("keyUp", &key, modifiers, None));
    for (on, name, bit) in held.iter().rev() {
        if *on {
            modifiers &= !bit;
            events.push(event("keyUp", &key_info(name, false)?, modifiers, None));
        }
    }
    Ok(events)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chord(key: &str) -> Chord {
        Chord::from_key_press(&crate::hyprland_input::chord_to_key_press(key).unwrap())
    }

    fn tab(id: &str, kind: &str, title: &str, url: &str) -> Tab {
        Tab {
            id: id.to_string(),
            kind: kind.to_string(),
            title: title.to_string(),
            url: url.to_string(),
        }
    }

    #[test]
    fn port_setting_takes_a_port_or_an_active_port_file() {
        let no_file = |_: &Path| -> std::result::Result<String, String> { panic!("read") };
        assert_eq!(parse_port_setting("9222", no_file), Ok(9222));
        assert!(parse_port_setting("0", no_file).is_err());
        assert!(parse_port_setting("70000", no_file).is_err());
        assert!(parse_port_setting("relative/DevToolsActivePort", no_file).is_err());
        assert_eq!(
            parse_port_setting("/p/DevToolsActivePort", |path| {
                assert_eq!(path, Path::new("/p/DevToolsActivePort"));
                Ok("41234\n/devtools/browser/abc\n".to_string())
            }),
            Ok(41234)
        );
        assert!(parse_port_setting("/p/x", |_| Ok("nope".to_string())).is_err());
    }

    #[test]
    fn tab_selection_needs_one_page() {
        let tabs = vec![
            tab("AAA", "page", "Inbox", "https://mail.example/"),
            tab("BBB", "page", "Docs", "https://docs.example/a"),
            tab("CCC", "service_worker", "sw", "https://docs.example/sw.js"),
            tab("DDD", "page", "Docs 2", "https://docs.example/b"),
        ];
        assert_eq!(select_tab(&tabs, "BBB").unwrap().id, "BBB");
        assert_eq!(select_tab(&tabs, "inbox").unwrap().id, "AAA");
        assert_eq!(select_tab(&tabs, "docs.example/a").unwrap().id, "BBB");
        assert!(select_tab(&tabs, "docs")
            .unwrap_err()
            .contains("2 page tabs"));
        assert!(select_tab(&tabs, "CCC").is_err());
        assert!(select_tab(&tabs, "nothing")
            .unwrap_err()
            .contains("no page tab"));
        assert!(select_tab(&tabs, " ").is_err());
    }

    #[test]
    fn loopback_listeners_are_read_from_proc_net_tcp() {
        let table = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:2406 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1 1
   1: 0100007F:2407 00000000:0000 01 00000000:00000000 00:00000000 00000000  1000        0 2 1
   2: 0101A8C0:2406 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1001        0 3 1
   3: 00000000:2406 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1002        0 4 1";
        assert_eq!(loopback_listener_uids(table, 9222), vec![1000, 1002]);
        assert!(loopback_listener_uids(table, 9223).is_empty());
    }

    #[test]
    fn http_responses_end_at_their_length() {
        assert!(!http_response_complete(
            b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\nab"
        ));
        assert!(http_response_complete(
            b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\nabcd"
        ));
        assert!(http_response_complete(
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nab\r\n0\r\n\r\n"
        ));
        assert!(!http_response_complete(
            b"HTTP/1.1 200 OK\r\nContent-Length: 4"
        ));
        assert_eq!(dechunk(b"2\r\nab\r\n1\r\nc\r\n0\r\n\r\n").unwrap(), b"abc");
    }

    #[test]
    fn expected_value_splices_utf16_offsets() {
        assert_eq!(
            expected_value("hello", 5, 5, "!").as_deref(),
            Some("hello!")
        );
        assert_eq!(expected_value("hello", 1, 4, "EY").as_deref(), Some("hEYo"));
        assert_eq!(expected_value("a😀b", 3, 3, "c").as_deref(), Some("a😀cb"));
        assert_eq!(expected_value("ab", 3, 3, "c"), None);
    }

    #[test]
    fn key_events_follow_devtools_key_fields() {
        let enter = key_events(&chord("Enter")).unwrap();
        assert_eq!(enter.len(), 2);
        assert_eq!(enter[0]["type"], "keyDown");
        assert_eq!(enter[0]["text"], "\r");
        assert_eq!(enter[0]["windowsVirtualKeyCode"], 13);
        assert_eq!(enter[1]["type"], "keyUp");
        let ctrl_a = key_events(&chord("Ctrl+a")).unwrap();
        assert_eq!(ctrl_a.len(), 4);
        assert_eq!(ctrl_a[0]["key"], "Control");
        assert_eq!(ctrl_a[1]["type"], "rawKeyDown");
        assert_eq!(ctrl_a[1]["modifiers"], 2);
        assert!(ctrl_a[1].get("text").is_none());
        assert_eq!(ctrl_a[3]["modifiers"], 0);
        let shift_b = key_events(&chord("Shift+b")).unwrap();
        assert_eq!(shift_b[1]["key"], "B");
        assert_eq!(shift_b[1]["text"], "B");
        assert_eq!(
            key_events(&chord("F5")).unwrap()[0]["windowsVirtualKeyCode"],
            116
        );
        assert_eq!(
            key_events(&chord("KP_Enter")).unwrap()[0]["code"],
            "NumpadEnter"
        );
        assert!(key_events(&chord("Shift+1")).is_err());
    }

    #[test]
    fn focused_field_reads_the_page_script_result() {
        let field = FocusedField::from_value(&json!({
            "kind": "field", "tag": "input", "type": "email", "value": "x",
            "start": null, "end": null, "readOnly": false
        }));
        assert_eq!(
            field,
            FocusedField::Field {
                tag: "input".to_string(),
                kind: "email".to_string(),
                value: "x".to_string(),
                selection: None,
                read_only: false
            }
        );
        assert!(
            FocusedField::from_value(&json!({"kind": "field", "type": "password"})).is_password()
        );
        assert_eq!(
            FocusedField::from_value(&json!({"kind": "none"})),
            FocusedField::None
        );
        assert!(has_control("a\nb", false));
        assert!(!has_control("a\nb\t", true));
        assert!(has_control("a\u{7}", true));
    }
}
