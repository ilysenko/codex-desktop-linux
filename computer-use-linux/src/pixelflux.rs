use crate::remote_desktop::{PointerButton, ScrollDirection};
use anyhow::{anyhow, bail, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

const SEND_TIMEOUT: Duration = Duration::from_secs(5);
const PROBE_TIMEOUT: Duration = Duration::from_secs(1);
// pixelflux types on its own seat one key at a time (up to ~28 ms a character) and replies when done.
const TYPE_MS_PER_CHAR: u64 = 40;
const MAX_BODY: usize = 64 * 1024 * 1024;
const MAX_HEADERS: usize = 64 * 1024;

pub(crate) struct PixelfluxConfig {
    pub(crate) port: u16,
    pub(crate) token: String,
}

impl PixelfluxConfig {
    /// `PIXELFLUX_CU` plus `PIXELFLUX_CU_TOKEN`. A non-loopback port is ignored
    /// so this client cannot be pointed at another host.
    pub(crate) fn from_env() -> Option<Self> {
        let port_raw = std::env::var("PIXELFLUX_CU")
            .ok()
            .filter(|value| !value.is_empty())?;
        let Some(port) = loopback_port(&port_raw) else {
            eprintln!(
                "[codex-computer-use] PIXELFLUX_CU must be a bare port or a loopback address (127.0.0.1, localhost, or [::1]); ignoring it"
            );
            return None;
        };
        let token = std::env::var("PIXELFLUX_CU_TOKEN")
            .ok()
            .filter(|value| !value.is_empty())?;
        Some(Self { port, token })
    }
}

pub(crate) enum PixelfluxAction {
    Screenshot,
    Click {
        x: i32,
        y: i32,
        button: PointerButton,
        count: u8,
    },
    #[cfg_attr(not(test), allow(dead_code))]
    MouseMove {
        x: i32,
        y: i32,
    },
    #[cfg_attr(not(test), allow(dead_code))]
    MouseDown {
        x: i32,
        y: i32,
    },
    #[cfg_attr(not(test), allow(dead_code))]
    MouseUp {
        x: i32,
        y: i32,
    },
    Drag {
        from: (i32, i32),
        to: (i32, i32),
    },
    Scroll {
        point: Option<(i32, i32)>,
        direction: ScrollDirection,
        amount: u32,
    },
    Key {
        chord: String,
    },
    Type {
        text: String,
    },
}

#[derive(Debug)]
pub(crate) struct PixelfluxReply {
    pub(crate) data: Option<Vec<u8>>,
}

pub(crate) async fn send(
    config: &PixelfluxConfig,
    action: &PixelfluxAction,
) -> Result<PixelfluxReply> {
    exchange(config, &action_body(action)?, send_timeout(action)).await
}

fn send_timeout(action: &PixelfluxAction) -> Duration {
    match action {
        PixelfluxAction::Type { text } => SEND_TIMEOUT.saturating_add(Duration::from_millis(
            (text.chars().count() as u64).saturating_mul(TYPE_MS_PER_CHAR),
        )),
        _ => SEND_TIMEOUT,
    }
}

pub(crate) async fn probe(config: &PixelfluxConfig) -> Result<()> {
    exchange(config, br#"{"action":"cursor_position"}"#, PROBE_TIMEOUT).await?;
    Ok(())
}

pub(crate) fn is_unreachable(error: &anyhow::Error) -> bool {
    if matches!(
        error.downcast_ref::<DispatchError>(),
        Some(DispatchError::Rejected(_))
    ) {
        return false;
    }
    let text = format!("{error:#}");
    text.contains("connection failed")
        || text.contains("timed out")
        || text.contains("closed the connection before")
}

/// The request went out but no answer came back, so pixelflux may have acted.
pub(crate) fn outcome_unknown(error: &anyhow::Error) -> bool {
    error
        .downcast_ref::<DispatchError>()
        .is_some_and(|error| matches!(error, DispatchError::Unknown(_)))
}

#[derive(Debug)]
enum DispatchError {
    Unknown(String),
    Rejected(String),
}
impl std::fmt::Display for DispatchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unknown(message) | Self::Rejected(message) => f.write_str(message),
        }
    }
}
impl std::error::Error for DispatchError {}

fn loopback_port(raw: &str) -> Option<u16> {
    let port = if let Some(rest) = raw.strip_prefix("[::1]:") {
        rest
    } else if let Some(rest) = raw.strip_prefix("127.0.0.1:") {
        rest
    } else if let Some(rest) = raw.strip_prefix("localhost:") {
        rest
    } else if raw.bytes().all(|byte| byte.is_ascii_digit()) {
        raw
    } else {
        return None;
    };
    port.parse().ok()
}

fn action_body(action: &PixelfluxAction) -> Result<Vec<u8>> {
    let value = match action {
        PixelfluxAction::Screenshot => json!({"action": "screenshot"}),
        PixelfluxAction::Click {
            x,
            y,
            button,
            count,
        } => json!({
            "action": click_action(*button, *count)?,
            "coordinate": [x, y],
        }),
        PixelfluxAction::MouseMove { x, y } => {
            json!({"action": "mouse_move", "coordinate": [x, y]})
        }
        PixelfluxAction::MouseDown { x, y } => {
            json!({"action": "left_mouse_down", "coordinate": [x, y]})
        }
        PixelfluxAction::MouseUp { x, y } => {
            json!({"action": "left_mouse_up", "coordinate": [x, y]})
        }
        PixelfluxAction::Drag { from, to } => json!({
            "action": "left_click_drag",
            "start_coordinate": [from.0, from.1],
            "coordinate": [to.0, to.1],
        }),
        PixelfluxAction::Scroll {
            point,
            direction,
            amount,
        } => {
            let mut value = json!({
            "action": "scroll",
            "scroll_direction": scroll_name(*direction),
            "scroll_amount": amount,
            });
            if let Some((x, y)) = point {
                value["coordinate"] = json!([x, y]);
            }
            value
        }
        PixelfluxAction::Key { chord } => json!({"action": "key", "text": chord}),
        PixelfluxAction::Type { text } => json!({"action": "type", "text": text}),
    };
    Ok(serde_json::to_vec(&value)?)
}

fn click_action(button: PointerButton, count: u8) -> Result<&'static str> {
    match (button, count) {
        (PointerButton::Left, 1) => Ok("left_click"),
        (PointerButton::Left, 2) => Ok("double_click"),
        (PointerButton::Left, 3) => Ok("triple_click"),
        (PointerButton::Right, 1) => Ok("right_click"),
        (PointerButton::Middle, 1) => Ok("middle_click"),
        _ => bail!("pixelflux has no click for {button:?} count {count}"),
    }
}

fn scroll_name(direction: ScrollDirection) -> &'static str {
    match direction {
        ScrollDirection::Up => "up",
        ScrollDirection::Down => "down",
        ScrollDirection::Left => "left",
        ScrollDirection::Right => "right",
    }
}

async fn exchange(
    config: &PixelfluxConfig,
    body: &[u8],
    timeout: Duration,
) -> Result<PixelfluxReply> {
    let token = &config.token;
    match tokio::time::timeout(timeout, exchange_inner(config, body)).await {
        Ok(result) => result.map_err(|error| {
            let message = redact(&format!("{error:#}"), token);
            if outcome_unknown(&error) {
                anyhow!(DispatchError::Unknown(message))
            } else if matches!(
                error.downcast_ref::<DispatchError>(),
                Some(DispatchError::Rejected(_))
            ) {
                anyhow!(DispatchError::Rejected(message))
            } else {
                anyhow!(message)
            }
        }),
        Err(_) => Err(anyhow!(DispatchError::Unknown(redact(
            "pixelflux timed out",
            token
        )))),
    }
}

async fn exchange_inner(config: &PixelfluxConfig, body: &[u8]) -> Result<PixelfluxReply> {
    if config
        .token
        .bytes()
        .any(|byte| byte == b'\r' || byte == b'\n')
    {
        bail!("PIXELFLUX_CU_TOKEN contains a character that cannot go in an HTTP header");
    }
    let mut stream = TcpStream::connect(("127.0.0.1", config.port))
        .await
        .context("pixelflux connection failed")?;
    let header = format!(
        "POST /computer-use HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {len}\r\nConnection: close\r\n\r\n",
        port = config.port,
        token = config.token,
        len = body.len(),
    );
    let mut request = header.into_bytes();
    request.extend_from_slice(body);
    if let Err(error) = stream
        .write_all(&request)
        .await
        .context("pixelflux request failed")
    {
        return Err(anyhow!(DispatchError::Unknown(format!("{error:#}"))));
    }
    read_reply(&mut stream).await.map_err(|error| {
        if matches!(
            error.downcast_ref::<DispatchError>(),
            Some(DispatchError::Rejected(_))
        ) {
            error
        } else {
            anyhow!(DispatchError::Unknown(format!("{error:#}")))
        }
    })
}

async fn read_reply(stream: &mut TcpStream) -> Result<PixelfluxReply> {
    let (status, headers, leftover) = read_headers(stream).await?;
    let payload = read_body(stream, &headers, leftover).await?;
    let value: Value =
        serde_json::from_slice(&payload).context("pixelflux response was not JSON")?;
    if let Some(error) = value.get("error").and_then(Value::as_str) {
        return Err(anyhow!(DispatchError::Rejected(format!(
            "pixelflux returned HTTP {status}: {error}"
        ))));
    }
    if !(200..300).contains(&status) {
        return Err(anyhow!(DispatchError::Rejected(format!(
            "pixelflux returned HTTP {status}"
        ))));
    }
    let data = match value.get("data").and_then(Value::as_str) {
        Some(encoded) => Some(
            STANDARD
                .decode(encoded)
                .context("pixelflux screenshot was not base64")?,
        ),
        None => None,
    };
    Ok(PixelfluxReply { data })
}

fn redact(message: &str, token: &str) -> String {
    if token.is_empty() {
        return message.to_string();
    }
    message.replace(token, "[redacted]")
}

async fn read_headers(stream: &mut TcpStream) -> Result<(u16, Vec<(String, String)>, Vec<u8>)> {
    let mut buf = Vec::new();
    let mut tmp = [0u8; 4096];
    let end = loop {
        if let Some(pos) = buf.windows(4).position(|window| window == b"\r\n\r\n") {
            break pos;
        }
        if buf.len() > MAX_HEADERS {
            bail!("pixelflux response headers exceeded 64 KiB");
        }
        let n = stream
            .read(&mut tmp)
            .await
            .context("pixelflux response failed")?;
        if n == 0 {
            bail!("pixelflux closed the connection before the response finished");
        }
        buf.extend_from_slice(&tmp[..n]);
    };
    let head =
        std::str::from_utf8(&buf[..end]).context("pixelflux response headers were not UTF-8")?;
    let rest = buf[end + 4..].to_vec();
    let mut lines = head.split("\r\n");
    let status = lines
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse().ok())
        .context("pixelflux status line was not HTTP")?;
    let headers = lines
        .filter_map(|line| {
            let (name, value) = line.split_once(':')?;
            Some((name.trim().to_string(), value.trim().to_string()))
        })
        .collect();
    Ok((status, headers, rest))
}

fn header<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.as_str())
}

async fn read_body(
    stream: &mut TcpStream,
    headers: &[(String, String)],
    leftover: Vec<u8>,
) -> Result<Vec<u8>> {
    if header(headers, "transfer-encoding")
        .is_some_and(|value| value.to_ascii_lowercase().contains("chunked"))
    {
        return read_chunked(stream, leftover).await;
    }
    if let Some(len) = header(headers, "content-length") {
        let len: usize = len
            .trim()
            .parse()
            .context("pixelflux Content-Length was not a number")?;
        if len > MAX_BODY {
            bail!("pixelflux response exceeded 64 MiB");
        }
        let mut body = read_exact(stream, leftover, len).await?;
        body.truncate(len);
        return Ok(body);
    }
    let mut body = leftover;
    let mut tmp = [0u8; 8192];
    loop {
        if body.len() > MAX_BODY {
            bail!("pixelflux response exceeded 64 MiB");
        }
        let n = stream
            .read(&mut tmp)
            .await
            .context("pixelflux response failed")?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&tmp[..n]);
    }
    if body.len() > MAX_BODY {
        bail!("pixelflux response exceeded 64 MiB");
    }
    Ok(body)
}

async fn read_chunked(stream: &mut TcpStream, mut buf: Vec<u8>) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    loop {
        let line = read_line(stream, &mut buf).await?;
        let size = usize::from_str_radix(line.split(';').next().unwrap_or("").trim(), 16)
            .context("pixelflux chunk size was not hex")?;
        if size == 0 {
            loop {
                if read_line(stream, &mut buf).await?.is_empty() {
                    break;
                }
            }
            return Ok(out);
        }
        if out.len().saturating_add(size) > MAX_BODY {
            bail!("pixelflux response exceeded 64 MiB");
        }
        fill(stream, &mut buf, size + 2).await?;
        if &buf[size..size + 2] != b"\r\n" {
            bail!("pixelflux chunk was not terminated");
        }
        out.extend_from_slice(&buf[..size]);
        buf.drain(..size + 2);
    }
}

async fn fill(stream: &mut TcpStream, buf: &mut Vec<u8>, n: usize) -> Result<()> {
    while buf.len() < n {
        let mut tmp = [0u8; 8192];
        let got = stream
            .read(&mut tmp)
            .await
            .context("pixelflux response failed")?;
        if got == 0 {
            bail!("pixelflux closed the connection before the response finished");
        }
        buf.extend_from_slice(&tmp[..got]);
        if buf.len() > MAX_BODY {
            bail!("pixelflux response exceeded 64 MiB");
        }
    }
    Ok(())
}

async fn read_line(stream: &mut TcpStream, buf: &mut Vec<u8>) -> Result<String> {
    loop {
        if let Some(pos) = buf.windows(2).position(|window| window == b"\r\n") {
            let line = String::from_utf8(buf.drain(..pos).collect())
                .context("pixelflux chunk line was not UTF-8")?;
            buf.drain(..2);
            return Ok(line);
        }
        if buf.len() > MAX_HEADERS {
            bail!("pixelflux chunk line exceeded 64 KiB");
        }
        let mut tmp = [0u8; 1024];
        let n = stream
            .read(&mut tmp)
            .await
            .context("pixelflux response failed")?;
        if n == 0 {
            bail!("pixelflux closed the connection before the response finished");
        }
        buf.extend_from_slice(&tmp[..n]);
    }
}

async fn read_exact(stream: &mut TcpStream, mut buf: Vec<u8>, n: usize) -> Result<Vec<u8>> {
    fill(stream, &mut buf, n).await?;
    Ok(buf)
}

/// Serializes tests that change `PIXELFLUX_CU*` or the screenshot backend variable.
#[cfg(test)]
pub(crate) static TEST_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    struct EnvReset {
        saved: Vec<(&'static str, Option<std::ffi::OsString>)>,
    }

    impl EnvReset {
        fn apply(pairs: &[(&'static str, Option<&str>)]) -> Self {
            let saved = pairs
                .iter()
                .map(|(key, value)| {
                    let old = std::env::var_os(key);
                    match value {
                        Some(value) => std::env::set_var(key, value),
                        None => std::env::remove_var(key),
                    }
                    (*key, old)
                })
                .collect();
            Self { saved }
        }
    }

    impl Drop for EnvReset {
        fn drop(&mut self) {
            for (key, value) in &self.saved {
                match value {
                    Some(value) => std::env::set_var(key, value),
                    None => std::env::remove_var(key),
                }
            }
        }
    }

    struct Hit {
        start: String,
        headers: String,
        body: Vec<u8>,
    }

    async fn serve(response: Vec<u8>) -> (u16, tokio::sync::oneshot::Receiver<Hit>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, rx) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 65536];
            let n = sock.read(&mut buf).await.unwrap();
            buf.truncate(n);
            let text = String::from_utf8_lossy(&buf);
            let (head, body) = text.split_once("\r\n\r\n").unwrap();
            let mut lines = head.split("\r\n");
            let start = lines.next().unwrap().to_string();
            let headers = lines.collect::<Vec<_>>().join("\r\n");
            let declared = headers
                .lines()
                .find_map(|line| {
                    line.split_once(':')
                        .filter(|(name, _)| name.eq_ignore_ascii_case("content-length"))
                        .map(|(_, value)| value.trim().parse::<usize>().unwrap())
                })
                .unwrap_or(0);
            let mut body = body.as_bytes().to_vec();
            while body.len() < declared {
                let mut more = [0u8; 4096];
                let n = sock.read(&mut more).await.unwrap();
                if n == 0 {
                    break;
                }
                body.extend_from_slice(&more[..n]);
            }
            body.truncate(declared);
            let _ = tx.send(Hit {
                start,
                headers,
                body,
            });
            let _ = sock.write_all(&response).await;
        });
        (port, rx)
    }

    fn config(port: u16) -> PixelfluxConfig {
        PixelfluxConfig {
            port,
            token: "secret".to_string(),
        }
    }

    #[test]
    fn from_env_requires_port_and_token() {
        let _guard = TEST_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        for (port, token) in [
            (None, None),
            (Some("5000"), None),
            (None, Some("secret")),
            (Some("5000"), Some("")),
            (Some(""), Some("secret")),
        ] {
            let _reset = EnvReset::apply(&[("PIXELFLUX_CU", port), ("PIXELFLUX_CU_TOKEN", token)]);
            assert!(PixelfluxConfig::from_env().is_none(), "{port:?} {token:?}");
        }
        for port in ["5000", "127.0.0.1:5000", "[::1]:5000", "localhost:5000"] {
            let _reset = EnvReset::apply(&[
                ("PIXELFLUX_CU", Some(port)),
                ("PIXELFLUX_CU_TOKEN", Some("secret")),
            ]);
            let got =
                PixelfluxConfig::from_env().unwrap_or_else(|| panic!("expected Some for {port}"));
            assert_eq!(got.port, 5000, "{port}");
            assert_eq!(got.token, "secret");
        }
        let _reset = EnvReset::apply(&[
            ("PIXELFLUX_CU", Some("10.0.0.1:5000")),
            ("PIXELFLUX_CU_TOKEN", Some("secret")),
        ]);
        assert!(PixelfluxConfig::from_env().is_none());
    }

    #[tokio::test]
    async fn send_builds_click_request() {
        let (port, hit) = serve(
            b"HTTP/1.1 200 OK\r\nContent-Length: 15\r\nConnection: close\r\n\r\n{\"result\":\"ok\"}"
                .to_vec(),
        )
        .await;
        send(
            &config(port),
            &PixelfluxAction::Click {
                x: 10,
                y: 20,
                button: PointerButton::Left,
                count: 1,
            },
        )
        .await
        .unwrap();
        let hit = hit.await.unwrap();
        assert_eq!(hit.start, "POST /computer-use HTTP/1.1");
        assert!(
            hit.headers
                .lines()
                .any(|line| line == "Authorization: Bearer secret"),
            "{}",
            hit.headers
        );
        let body: Value = serde_json::from_slice(&hit.body).unwrap();
        assert_eq!(body, json!({"action":"left_click","coordinate":[10,20]}));
    }

    #[tokio::test]
    async fn send_decodes_screenshot() {
        let png = {
            let image = image::RgbaImage::from_pixel(2, 3, image::Rgba([9, 8, 7, 255]));
            let mut bytes = Vec::new();
            image
                .write_to(
                    &mut std::io::Cursor::new(&mut bytes),
                    image::ImageFormat::Png,
                )
                .unwrap();
            bytes
        };
        let payload = json!({"data": STANDARD.encode(&png)}).to_string();
        let response = format!(
            "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n{size:x}\r\n{payload}\r\n0\r\n\r\n",
            size = payload.len(),
        )
        .into_bytes();
        let (port, _hit) = serve(response).await;
        let reply = send(&config(port), &PixelfluxAction::Screenshot)
            .await
            .unwrap();
        let data = reply.data.expect("screenshot bytes");
        assert_eq!(data, png);
        assert_eq!(&data[..8], b"\x89PNG\r\n\x1a\n");
    }

    #[tokio::test]
    async fn errors_never_contain_token() {
        let (port, _hit) = serve(
            b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 24\r\nConnection: close\r\n\r\n{\"error\":\"unauthorized\"}"
                .to_vec(),
        )
        .await;
        let error = send(&config(port), &PixelfluxAction::Screenshot)
            .await
            .unwrap_err();
        let shown = error.to_string();
        assert!(
            shown.contains("401") || shown.contains("unauthorized"),
            "{shown}"
        );
        assert!(!shown.contains("secret"), "{shown}");
        assert!(!format!("{error:#}").contains("secret"), "{error:#}");

        let (port, _hit) = serve(
            b"HTTP/1.1 200 OK\r\nContent-Length: 40\r\nConnection: close\r\n\r\n{\"result\":"
                .to_vec(),
        )
        .await;
        let error = probe(&config(port)).await.unwrap_err();
        let shown = error.to_string();
        assert!(
            shown.contains("closed") || shown.contains("ended") || shown.contains("short"),
            "{shown}"
        );
        assert!(!shown.contains("secret"), "{shown}");
        assert!(!format!("{error:#}").contains("secret"), "{error:#}");
    }

    #[tokio::test]
    async fn type_preserves_text() {
        let text = "a\tb\nä€😉";
        let (port, hit) = serve(
            b"HTTP/1.1 200 OK\r\nContent-Length: 15\r\nConnection: close\r\n\r\n{\"result\":\"ok\"}"
                .to_vec(),
        )
        .await;
        send(
            &config(port),
            &PixelfluxAction::Type {
                text: text.to_string(),
            },
        )
        .await
        .unwrap();
        let hit = hit.await.unwrap();
        let body: Value = serde_json::from_slice(&hit.body).unwrap();
        assert_eq!(body["text"], text);
        assert_eq!(body["action"], "type");
    }
    #[tokio::test]
    async fn explicit_probe_rejection_is_not_unreachable() {
        let payload = br#"{"error":"backend timed out"}"#;
        let mut response = format!(
            "HTTP/1.1 500 X\r\nContent-Length: {}\r\n\r\n",
            payload.len()
        )
        .into_bytes();
        response.extend_from_slice(payload);
        let (port, hit) = serve(response).await;
        let error = probe(&config(port)).await.unwrap_err();
        hit.await.unwrap();
        assert!(!is_unreachable(&error), "{error:#}");
        assert!(!outcome_unknown(&error));
    }

    #[tokio::test]
    async fn remaining_actions_match_observed_fields() {
        let ok = b"HTTP/1.1 200 OK\r\nContent-Length: 15\r\nConnection: close\r\n\r\n{\"result\":\"ok\"}".to_vec();
        let cases = [
            (
                PixelfluxAction::Drag {
                    from: (1, 2),
                    to: (3, 4),
                },
                json!({"action":"left_click_drag","start_coordinate":[1,2],"coordinate":[3,4]}),
            ),
            (
                PixelfluxAction::Scroll {
                    point: Some((5, 6)),
                    direction: ScrollDirection::Down,
                    amount: 3,
                },
                json!({"action":"scroll","coordinate":[5,6],"scroll_direction":"down","scroll_amount":3}),
            ),
            (
                PixelfluxAction::Scroll {
                    point: None,
                    direction: ScrollDirection::Down,
                    amount: 3,
                },
                json!({"action":"scroll","scroll_direction":"down","scroll_amount":3}),
            ),
            (
                PixelfluxAction::Key {
                    chord: "ctrl+l".to_string(),
                },
                json!({"action":"key","text":"ctrl+l"}),
            ),
            (
                PixelfluxAction::MouseMove { x: 7, y: 8 },
                json!({"action":"mouse_move","coordinate":[7,8]}),
            ),
            (
                PixelfluxAction::MouseDown { x: 7, y: 8 },
                json!({"action":"left_mouse_down","coordinate":[7,8]}),
            ),
            (
                PixelfluxAction::MouseUp { x: 7, y: 8 },
                json!({"action":"left_mouse_up","coordinate":[7,8]}),
            ),
        ];
        for (action, want) in cases {
            let (port, hit) = serve(ok.clone()).await;
            send(&config(port), &action).await.unwrap();
            let body: Value = serde_json::from_slice(&hit.await.unwrap().body).unwrap();
            assert_eq!(body, want);
        }
    }

    #[test]
    fn type_timeout_grows_with_text_length() {
        let typed = |text: String| send_timeout(&PixelfluxAction::Type { text });
        assert_eq!(typed(String::new()), SEND_TIMEOUT);
        // 1,000 characters at pixelflux's ~28 ms each take 28 s; count characters, not bytes.
        assert!(typed("x".repeat(1_000)) >= SEND_TIMEOUT + Duration::from_secs(28));
        assert_eq!(typed("é".repeat(1_000)), typed("x".repeat(1_000)));
        let key = PixelfluxAction::Key {
            chord: "ctrl+l".to_string(),
        };
        assert_eq!(send_timeout(&key), SEND_TIMEOUT);
    }
}
