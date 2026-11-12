use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const TOKEN: &str = "cul-secret";

/// A private temp dir with stub desktop tools, so a server under test cannot
/// reach the developer's session: diagnostics only fills empty variables
/// from the process tree, so every desktop variable gets a dead value here.
struct Hermetic {
    dir: PathBuf,
}

impl Hermetic {
    fn new() -> Hermetic {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("cul-http-{}-{nanos}", std::process::id()));
        std::fs::create_dir(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        for program in [
            "ydotool",
            "xdotool",
            "wtype",
            "systemctl",
            "gnome-screenshot",
            "busctl",
            "gsettings",
        ] {
            let path = dir.join(program);
            std::fs::write(
                &path,
                // Read-only probes (environment, capability help) fail silently;
                // anything else these tools run would be input, so record it.
                r#"#!/bin/sh
case "${0##*/} $1" in
  "systemctl "*|"busctl "*|"gsettings "*|"ydotool help"|"ydotool --help") exit 1 ;;
esac
printf '%s %s\n' "${0##*/}" "$*" >> "${0%/*}/commands.log"
exit 1
"#,
            )
            .unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        Hermetic { dir }
    }

    fn command(&self) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_codex-computer-use-linux"));
        command
            .env_clear()
            .env("PATH", &self.dir)
            .env("HOME", &self.dir)
            .env("XDG_RUNTIME_DIR", &self.dir)
            .env(
                "DBUS_SESSION_BUS_ADDRESS",
                format!("unix:path={}/no-bus", self.dir.display()),
            )
            .env("DISPLAY", ":9876")
            .env("WAYLAND_DISPLAY", "no-wayland")
            .env("XDG_SESSION_TYPE", "wayland")
            .env("YDOTOOL_SOCKET", self.dir.join("no-ydotool"))
            .env("NIRI_SOCKET", self.dir.join("no-niri"))
            .env("CU_DISABLE_ABS_POINTER", "1");
        // Keep in step with DESKTOP_ENV_KEYS in src/diagnostics.rs: the server
        // fills any empty one from the process tree; checked by
        // hermetic_sets_every_desktop_key.
        for key in [
            "DESKTOP_SESSION",
            "HYPRLAND_INSTANCE_SIGNATURE",
            "XAUTHORITY",
            "XDG_SESSION_DESKTOP",
            "XDG_CURRENT_DESKTOP",
        ] {
            command.env(key, "hermetic-test");
        }
        command
    }

    fn recorded(&self) -> String {
        std::fs::read_to_string(self.dir.join("commands.log")).unwrap_or_default()
    }
}

#[test]
fn hermetic_sets_every_desktop_key() {
    let source = include_str!("../src/diagnostics.rs");
    let list = source
        .split_once("const DESKTOP_ENV_KEYS: &[&str] = &[")
        .and_then(|(_, rest)| rest.split_once("];"))
        .expect("DESKTOP_ENV_KEYS not found in src/diagnostics.rs")
        .0;
    let hermetic = Hermetic::new();
    let command = hermetic.command();
    let keys: Vec<&str> = list.split('"').skip(1).step_by(2).collect();
    assert!(!keys.is_empty());
    for key in keys {
        let set = command
            .get_envs()
            .any(|(name, value)| name == key && value.is_some_and(|v| !v.is_empty()));
        assert!(set, "Hermetic::command() leaves {key} empty");
    }
}

impl Drop for Hermetic {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn spawn(hermetic: &Hermetic, token: Option<&str>) -> std::process::Child {
    spawn_with(hermetic, token, &[])
}

fn spawn_with(hermetic: &Hermetic, token: Option<&str>, args: &[&str]) -> std::process::Child {
    let mut command = hermetic.command();
    command
        .args(["mcp", "--listen", "127.0.0.1:0"])
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    if let Some(token) = token {
        command.env("CODEX_COMPUTER_USE_MCP_TOKEN", token);
    }
    command.spawn().unwrap()
}

/// Waits up to eight seconds for the `listening` line. A reader thread owns
/// the blocking pipe and keeps draining it, so the server never blocks on
/// a full stderr; on timeout or EOF the child is killed and reaped.
fn bound_port(child: &mut std::process::Child) -> u16 {
    let stderr = child.stderr.take().unwrap();
    let (lines, received) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).split(b'\n') {
            let Ok(line) = line else { break };
            let _ = lines.send(String::from_utf8_lossy(&line).into_owned());
        }
    });
    let mut seen = String::new();
    let deadline = Instant::now() + Duration::from_secs(8);
    while let Ok(line) = received.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
        if let Some(addr) = line.trim().strip_prefix("listening ") {
            return addr.rsplit(':').next().unwrap().parse().unwrap();
        }
        seen.push_str(&line);
        seen.push('\n');
    }
    let _ = child.kill();
    let _ = child.wait();
    panic!("server did not print a listen address: {seen}");
}

fn post(
    port: u16,
    token: Option<&str>,
    body: &str,
    session: Option<&str>,
) -> (u16, String, Option<String>) {
    post_with(port, token, body, session, &[])
}

/// `extra` headers are sent as given; a `Host` entry replaces the default one.
fn post_with(
    port: u16,
    token: Option<&str>,
    body: &str,
    session: Option<&str>,
    extra: &[(&str, &str)],
) -> (u16, String, Option<String>) {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(12)))
        .unwrap();
    let default_host = format!("127.0.0.1:{port}");
    let host = extra
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case("host"))
        .map_or(default_host.as_str(), |(_, value)| value);
    let mut headers = format!(
        "POST /mcp HTTP/1.1\r\nHost: {host}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n",
        body.len()
    );
    if let Some(token) = token {
        headers.push_str(&format!("Authorization: Bearer {token}\r\n"));
    }
    if let Some(session) = session {
        headers.push_str(&format!("Mcp-Session-Id: {session}\r\n"));
    }
    for (name, value) in extra {
        if !name.eq_ignore_ascii_case("host") {
            headers.push_str(&format!("{name}: {value}\r\n"));
        }
    }
    headers.push_str("\r\n");
    stream.write_all(headers.as_bytes()).unwrap();
    stream.write_all(body.as_bytes()).unwrap();
    let mut raw = Vec::new();
    let _ = stream.read_to_end(&mut raw);
    let text = String::from_utf8_lossy(&raw).to_string();
    let status = text
        .split_whitespace()
        .nth(1)
        .unwrap_or("0")
        .parse()
        .unwrap_or(0);
    let session = text.lines().find_map(|line| {
        line.split_once(':')
            .filter(|(name, _)| name.eq_ignore_ascii_case("mcp-session-id"))
            .map(|(_, value)| value.trim().to_string())
    });
    (status, text, session)
}

fn initialize_body(name: &str) -> String {
    format!(
        r#"{{"jsonrpc":"2.0","id":1,"method":"initialize","params":{{"protocolVersion":"2024-11-05","capabilities":{{}},"clientInfo":{{"name":"{name}","version":"0"}}}}}}"#
    )
}

fn initialize(port: u16, name: &str) -> String {
    let body = initialize_body(name);
    let (status, text, session) = post(port, Some(TOKEN), &body, None);
    assert_eq!(status, 200, "{text}");
    session.expect("session id")
}

#[test]
fn listen_requires_token() {
    let hermetic = Hermetic::new();
    for token in [None, Some("")] {
        let mut child = spawn(&hermetic, token);
        let status = child.wait().unwrap();
        let mut err = String::new();
        child.stderr.unwrap().read_to_string(&mut err).unwrap();
        assert!(!status.success(), "{err}");
        assert!(
            err.contains(
                "--listen needs CODEX_COMPUTER_USE_MCP_TOKEN_FILE or CODEX_COMPUTER_USE_MCP_TOKEN"
            ),
            "{err}"
        );
    }
    assert_eq!(hermetic.recorded(), "");
}

#[test]
fn listen_refuses_shell() {
    let hermetic = Hermetic::new();
    // The shell switch and its standalone alias both refuse the listener.
    for shell_var in [
        "CODEX_COMPUTER_USE_ENABLE_SHELL",
        "COMPUTER_USE_LINUX_ENABLE_SHELL",
    ] {
        let output = hermetic
            .command()
            .args(["mcp", "--listen", "127.0.0.1:0"])
            .env("CODEX_COMPUTER_USE_MCP_TOKEN", TOKEN)
            .env(shell_var, "1")
            .stdin(Stdio::null())
            .output()
            .unwrap();
        let err = String::from_utf8_lossy(&output.stderr);
        assert!(!output.status.success(), "{shell_var}: {err}");
        assert!(err.contains("CODEX_COMPUTER_USE_ENABLE_SHELL=1"), "{err}");
    }
    assert_eq!(hermetic.recorded(), "");
}

#[test]
fn http_initialize_and_list_tools() {
    let hermetic = Hermetic::new();
    let mut child = spawn(&hermetic, Some(TOKEN));
    let port = bound_port(&mut child);
    let session = initialize(port, "cul");
    let _ = post(
        port,
        Some(TOKEN),
        r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
        Some(&session),
    );
    let (status, body, _) = post(
        port,
        Some(TOKEN),
        r#"{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}"#,
        Some(&session),
    );
    assert_eq!(status, 200, "{body}");
    assert!(body.contains("get_app_state"), "{body}");
    for bad in [None, Some("wrong")] {
        let (status, body, _) = post(
            port,
            bad,
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#,
            None,
        );
        assert_eq!(status, 401, "{body}");
        assert!(!body.contains(TOKEN), "{body}");
    }
    let _ = child.kill();
    assert_eq!(hermetic.recorded(), "");
}

#[test]
fn http_client_disconnect_does_not_wedge() {
    let hermetic = Hermetic::new();
    let mut child = spawn(&hermetic, Some(TOKEN));
    let port = bound_port(&mut child);
    let session = initialize(port, "a");
    let mut dropped = TcpStream::connect(("127.0.0.1", port)).unwrap();
    let body = r#"{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"click","arguments":{"x":1,"y":1}}}"#;
    let request = format!(
        "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nAuthorization: Bearer {TOKEN}\r\nMcp-Session-Id: {session}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    dropped.write_all(request.as_bytes()).unwrap();
    drop(dropped);
    let (status, body, _) = post(
        port,
        Some(TOKEN),
        r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"click","arguments":{"x":3,"y":3}}}"#,
        Some(&session),
    );
    assert_eq!(status, 200, "{body}");
    let _ = child.kill();
    assert_eq!(hermetic.recorded(), "");
}

#[test]
fn unauthorized_says_bearer() {
    let hermetic = Hermetic::new();
    let mut child = spawn(&hermetic, Some(TOKEN));
    let port = bound_port(&mut child);
    let (status, text, _) = post(port, None, &initialize_body("cul"), None);
    let _ = child.kill();
    assert_eq!(status, 401, "{text}");
    assert!(
        text.lines()
            .any(|line| line.eq_ignore_ascii_case("www-authenticate: Bearer")),
        "{text}"
    );
    assert_eq!(hermetic.recorded(), "");
}

#[test]
fn allowed_and_unknown_hosts() {
    let hermetic = Hermetic::new();
    let mut child = spawn_with(
        &hermetic,
        Some(TOKEN),
        &["--allowed-host", "desktop.ns.svc"],
    );
    let port = bound_port(&mut child);
    let body = initialize_body("cul");
    let results: Vec<_> = ["desktop.ns.svc:5200", "Desktop.NS.svc", "evil.example"]
        .iter()
        .map(|host| post_with(port, Some(TOKEN), &body, None, &[("Host", host)]))
        .collect();
    let _ = child.kill();
    assert_eq!(results[0].0, 200, "{}", results[0].1);
    assert_eq!(results[1].0, 200, "{}", results[1].1);
    assert_eq!(results[2].0, 403, "{}", results[2].1);
    assert_eq!(hermetic.recorded(), "");
}

#[test]
fn any_origin_is_refused() {
    let hermetic = Hermetic::new();
    let mut child = spawn(&hermetic, Some(TOKEN));
    let port = bound_port(&mut child);
    let (status, text, _) = post_with(
        port,
        Some(TOKEN),
        &initialize_body("cul"),
        None,
        &[("Origin", "http://127.0.0.1")],
    );
    let _ = child.kill();
    assert_eq!(status, 403, "{text}");
    assert_eq!(hermetic.recorded(), "");
}

#[test]
fn stateless_request_from_the_newer_protocol() {
    let hermetic = Hermetic::new();
    let mut child = spawn(&hermetic, Some(TOKEN));
    let port = bound_port(&mut child);
    let (status, text, _) = post_with(
        port,
        Some(TOKEN),
        r#"{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{"name":"cul","version":"0"},"io.modelcontextprotocol/clientCapabilities":{}}}}"#,
        None,
        &[
            ("MCP-Protocol-Version", "2026-07-28"),
            ("Mcp-Method", "tools/list"),
        ],
    );
    let _ = child.kill();
    assert_eq!(status, 200, "{text}");
    assert!(text.contains("get_app_state"), "{text}");
    assert_eq!(hermetic.recorded(), "");
}

#[test]
fn sigterm_stops_the_listener() {
    let hermetic = Hermetic::new();
    let mut child = spawn(&hermetic, Some(TOKEN));
    let port = bound_port(&mut child);
    initialize(port, "cul");
    assert_eq!(unsafe { libc::kill(child.id() as i32, libc::SIGTERM) }, 0);
    let deadline = Instant::now() + Duration::from_secs(5);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if Instant::now() > deadline {
            let _ = child.kill();
            panic!("server did not exit within 5 seconds of SIGTERM");
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    assert_eq!(status.code(), Some(143), "{status:?}");
    assert!(TcpStream::connect(("127.0.0.1", port)).is_err());
    assert_eq!(hermetic.recorded(), "");
}

#[test]
fn slow_headers_are_dropped() {
    let hermetic = Hermetic::new();
    let mut child = spawn(&hermetic, Some(TOKEN));
    let port = bound_port(&mut child);
    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    // HEADER_READ_TIMEOUT (10s) plus 2s of slack.
    stream
        .set_read_timeout(Some(Duration::from_secs(12)))
        .unwrap();
    stream
        .write_all(b"POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\n")
        .unwrap();
    let mut raw = Vec::new();
    let result = stream.read_to_end(&mut raw);
    let _ = child.kill();
    assert!(result.is_ok(), "connection still open: {result:?}");
    assert_eq!(hermetic.recorded(), "");
}

#[test]
fn http_index_click_without_snapshot_id_is_refused() {
    let hermetic = Hermetic::new();
    let mut child = spawn(&hermetic, Some(TOKEN));
    let port = bound_port(&mut child);
    let session = initialize(port, "cul");
    let (status, body, _) = post(
        port,
        Some(TOKEN),
        r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"click","arguments":{"element_index":0}}}"#,
        Some(&session),
    );
    assert_eq!(status, 200, "{body}");
    assert!(
        body.contains("click was not sent: snapshot_id is required over HTTP for element_index and selector calls, because another client's get_app_state can replace the cached tree. Pass the snapshot_id from your get_app_state result."),
        "{body}"
    );
    let _ = child.kill();
    assert_eq!(hermetic.recorded(), "");
}

#[test]
fn http_screenshot_file_path_is_refused_before_any_capture_or_input() {
    let hermetic = Hermetic::new();
    let mut child = spawn(&hermetic, Some(TOKEN));
    let port = bound_port(&mut child);
    let session = initialize(port, "cul");
    let target = hermetic.dir.join("shot.png");
    let target = target.to_str().unwrap();
    let calls = [
        (
            "screenshot",
            format!(r#"{{"screenshot_file_path":"{target}"}}"#),
        ),
        (
            "get_app_state",
            format!(r#"{{"screenshot_file_path":"{target}"}}"#),
        ),
        (
            "click",
            format!(r#"{{"x":1,"y":1,"screenshot_after":true,"screenshot_file_path":"{target}"}}"#),
        ),
    ];
    for (id, (tool, arguments)) in calls.iter().enumerate() {
        let body = format!(
            r#"{{"jsonrpc":"2.0","id":{},"method":"tools/call","params":{{"name":"{tool}","arguments":{arguments}}}}}"#,
            id + 2
        );
        let (status, text, _) = post(port, Some(TOKEN), &body, Some(&session));
        assert_eq!(status, 200, "{text}");
        assert!(
            text.contains(&format!(
                "{tool} was not run: screenshot_file_path is refused over HTTP (mcp --listen)"
            )),
            "{text}"
        );
        assert!(text.contains(r#""isError":true"#), "{text}");
    }
    let _ = child.kill();
    assert!(!std::path::Path::new(target).exists());
    assert_eq!(hermetic.recorded(), "");
}
