use crate::diagnostics::hydrate_session_bus_env;
use anyhow::{anyhow, bail, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use futures_util::StreamExt;
use schemars::JsonSchema;
use serde::Serialize;
use std::{
    collections::HashMap,
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use zbus::{
    message::{Message, Type as MessageType},
    zvariant::{OwnedObjectPath, OwnedValue, Value},
    MatchRule, MessageStream, Proxy,
};

const PORTAL_REQUEST_INTERFACE: &str = "org.freedesktop.portal.Request";
const PORTAL_REQUEST_PATH_NAMESPACE: &str = "/org/freedesktop/portal/desktop/request";

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct ScreenshotCapture {
    pub mime_type: String,
    pub data_url: String,
    pub source: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ScreenshotCleanup {
    DeletePath(PathBuf),
    Preserve,
}

pub async fn capture_screenshot() -> Result<ScreenshotCapture> {
    capture_screenshot_inner(true).await
}

pub async fn capture_screenshot_without_cli_fallback() -> Result<ScreenshotCapture> {
    capture_screenshot_inner(false).await
}

async fn capture_screenshot_inner(allow_cli_fallback: bool) -> Result<ScreenshotCapture> {
    hydrate_session_bus_env();

    match capture_with_gnome_shell().await {
        Ok(capture) => Ok(capture),
        Err(gnome_error) => match capture_with_portal().await {
            Ok(capture) => Ok(capture),
            Err(portal_error) if allow_cli_fallback => match capture_with_cli_fallback().await {
                Ok(capture) => Ok(capture),
                Err(cli_error) => Err(anyhow!(
                    "GNOME Shell screenshot failed: {gnome_error}; XDG portal screenshot failed: {portal_error}; CLI screenshot fallback failed: {cli_error}"
                )),
            },
            Err(portal_error) => Err(anyhow!(
                "GNOME Shell screenshot failed: {gnome_error}; XDG portal screenshot failed: {portal_error}; CLI screenshot fallback disabled"
            )),
        },
    }
}

async fn capture_with_gnome_shell() -> Result<ScreenshotCapture> {
    let connection = zbus::Connection::session()
        .await
        .context("failed to connect to session bus")?;
    let proxy = Proxy::new(
        &connection,
        "org.gnome.Shell.Screenshot",
        "/org/gnome/Shell/Screenshot",
        "org.gnome.Shell.Screenshot",
    )
    .await
    .context("failed to create GNOME Shell screenshot proxy")?;
    let path = temp_png_path("gnome-shell");
    let filename = path
        .to_str()
        .context("temporary screenshot path is not valid UTF-8")?;
    let result = proxy.call("Screenshot", &(false, false, filename)).await;
    let (success, filename_used): (bool, String) = match result {
        Ok(result) => result,
        Err(error) => {
            cleanup_gnome_requested_path(&path);
            return Err(error).context("GNOME Shell Screenshot call failed");
        }
    };

    if !success {
        cleanup_gnome_requested_path(&path);
        bail!("GNOME Shell reported screenshot failure");
    }

    read_png_as_capture(
        PathBuf::from(filename_used),
        "gnome-shell",
        ScreenshotCleanup::DeletePath(path),
    )
    .await
}

async fn capture_with_portal() -> Result<ScreenshotCapture> {
    let connection = zbus::Connection::session()
        .await
        .context("failed to connect to session bus")?;
    let token = request_token();
    // Some portals rewrite the request handle, so subscribe before calling Screenshot
    // and filter by the returned handle instead of subscribing after the call.
    let mut response_stream = portal_response_stream(&connection).await?;

    let portal_proxy = Proxy::new(
        &connection,
        "org.freedesktop.portal.Desktop",
        "/org/freedesktop/portal/desktop",
        "org.freedesktop.portal.Screenshot",
    )
    .await
    .context("failed to create XDG portal screenshot proxy")?;
    let mut options: HashMap<&str, Value<'_>> = HashMap::new();
    options.insert("handle_token", Value::from(token.as_str()));
    options.insert("interactive", Value::from(false));
    let handle: OwnedObjectPath = portal_proxy
        .call("Screenshot", &("", options))
        .await
        .context("XDG portal Screenshot call failed")?;

    let (response_code, results) = tokio::time::timeout(
        Duration::from_secs(20),
        wait_for_portal_response(&mut response_stream, handle.as_str()),
    )
    .await
    .context("timed out waiting for XDG portal screenshot response")??;

    if response_code != 0 {
        bail!("XDG portal screenshot was denied or cancelled with response code {response_code}");
    }

    let uri_value = results
        .get("uri")
        .context("XDG portal screenshot response did not include a uri")?;
    let uri: String = uri_value
        .try_clone()
        .context("failed to clone XDG portal screenshot uri")?
        .try_into()
        .context("XDG portal screenshot uri was not a string")?;
    let path = file_uri_to_path(&uri)?;

    read_png_as_capture(path, "xdg-desktop-portal", ScreenshotCleanup::Preserve).await
}

async fn capture_with_cli_fallback() -> Result<ScreenshotCapture> {
    let mut attempts = Vec::new();
    for candidate in screenshot_command_candidates() {
        if !command_exists(candidate.program) {
            attempts.push(format!("{} not found", candidate.program));
            continue;
        }

        let path = temp_png_path(candidate.source);
        let result = run_screenshot_command(&candidate, &path)
            .and_then(|_| read_png_as_capture_inner(&path, candidate.source));
        cleanup_gnome_requested_path(&path);

        match result {
            Ok(capture) => return Ok(capture),
            Err(error) => attempts.push(format!("{} failed: {error:#}", candidate.program)),
        }
    }

    bail!("{}", attempts.join("; "))
}

#[derive(Debug, Clone, Copy)]
struct ScreenshotCommand {
    source: &'static str,
    program: &'static str,
    args: &'static [&'static str],
    output_path_arg: OutputPathArg,
}

#[derive(Debug, Clone, Copy)]
enum OutputPathArg {
    Append,
    After(&'static str),
}

fn screenshot_command_candidates() -> Vec<ScreenshotCommand> {
    vec![
        ScreenshotCommand {
            source: "grim",
            program: "grim",
            args: &[],
            output_path_arg: OutputPathArg::Append,
        },
        ScreenshotCommand {
            source: "gnome-screenshot",
            program: "gnome-screenshot",
            args: &[],
            output_path_arg: OutputPathArg::After("-f"),
        },
        ScreenshotCommand {
            source: "spectacle",
            program: "spectacle",
            args: &["-b", "-n"],
            output_path_arg: OutputPathArg::After("-o"),
        },
        ScreenshotCommand {
            source: "imagemagick-import",
            program: "import",
            args: &["-window", "root"],
            output_path_arg: OutputPathArg::Append,
        },
    ]
}

fn run_screenshot_command(candidate: &ScreenshotCommand, path: &Path) -> Result<()> {
    let path = path
        .to_str()
        .context("temporary screenshot path is not valid UTF-8")?;
    let args = screenshot_command_args(candidate, path);
    let mut child = Command::new(candidate.program)
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("failed to spawn {}", candidate.program))?;
    let started_at = std::time::Instant::now();

    loop {
        if let Some(status) = child
            .try_wait()
            .with_context(|| format!("failed to wait for {}", candidate.program))?
        {
            let mut stderr = String::new();
            if let Some(mut stream) = child.stderr.take() {
                let _ = stream.read_to_string(&mut stderr);
            }
            if status.success() {
                return Ok(());
            }
            let stderr = stderr.trim();
            if stderr.is_empty() {
                bail!("{} exited with status {status}", candidate.program);
            }
            bail!(
                "{} exited with status {status}: {stderr}",
                candidate.program
            );
        }

        if started_at.elapsed() >= Duration::from_secs(10) {
            let _ = child.kill();
            let _ = child.wait();
            bail!("{} timed out", candidate.program);
        }
        thread::sleep(Duration::from_millis(50));
    }
}

fn screenshot_command_args(candidate: &ScreenshotCommand, output_path: &str) -> Vec<String> {
    let mut args = candidate
        .args
        .iter()
        .map(|arg| (*arg).to_string())
        .collect::<Vec<_>>();
    match candidate.output_path_arg {
        OutputPathArg::Append => args.push(output_path.to_string()),
        OutputPathArg::After(flag) => {
            args.push(flag.to_string());
            args.push(output_path.to_string());
        }
    }
    args
}

fn command_exists(program: &str) -> bool {
    let program_path = Path::new(program);
    if program_path.components().count() > 1 {
        return program_path.is_file();
    }

    std::env::var_os("PATH")
        .into_iter()
        .flat_map(|paths| std::env::split_paths(&paths).collect::<Vec<_>>())
        .any(|dir| dir.join(program).is_file())
}

async fn portal_response_stream(connection: &zbus::Connection) -> Result<MessageStream> {
    let response_rule = MatchRule::builder()
        .msg_type(MessageType::Signal)
        .interface(PORTAL_REQUEST_INTERFACE)?
        .member("Response")?
        .path_namespace(PORTAL_REQUEST_PATH_NAMESPACE)?
        .build();

    MessageStream::for_match_rule(response_rule, connection, None)
        .await
        .context("failed to subscribe to XDG portal screenshot responses")
}

async fn wait_for_portal_response(
    response_stream: &mut MessageStream,
    request_path: &str,
) -> Result<(u32, HashMap<String, OwnedValue>)> {
    loop {
        let response = response_stream
            .next()
            .await
            .context("XDG portal screenshot response stream ended")?
            .context("XDG portal screenshot response stream failed")?;

        if !portal_response_matches_path(&response, request_path) {
            continue;
        }

        return response
            .body()
            .deserialize()
            .context("failed to decode XDG portal screenshot response");
    }
}

fn portal_response_matches_path(response: &Message, request_path: &str) -> bool {
    response
        .header()
        .path()
        .is_some_and(|path| path.as_str() == request_path)
}

async fn read_png_as_capture(
    path: PathBuf,
    source: &str,
    cleanup: ScreenshotCleanup,
) -> Result<ScreenshotCapture> {
    let result = read_png_as_capture_inner(&path, source);
    if let ScreenshotCleanup::DeletePath(path) = cleanup {
        let _ = fs::remove_file(path);
    }
    result
}

fn read_png_as_capture_inner(path: &Path, source: &str) -> Result<ScreenshotCapture> {
    let bytes = fs::read(path)
        .with_context(|| format!("failed to read screenshot file {}", path.display()))?;
    if bytes.is_empty() {
        bail!("screenshot file was empty: {}", path.display());
    }
    let (width, height) = png_dimensions(&bytes)?;
    let encoded = STANDARD.encode(bytes);
    Ok(ScreenshotCapture {
        mime_type: "image/png".to_string(),
        data_url: format!("data:image/png;base64,{encoded}"),
        source: source.to_string(),
        width,
        height,
    })
}

fn cleanup_gnome_requested_path(path: &Path) {
    let _ = fs::remove_file(path);
}

fn png_dimensions(bytes: &[u8]) -> Result<(u32, u32)> {
    const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";
    if bytes.len() < 24 || &bytes[..8] != PNG_SIGNATURE || &bytes[12..16] != b"IHDR" {
        bail!("screenshot file was not a valid PNG");
    }
    let width = u32::from_be_bytes(bytes[16..20].try_into().unwrap());
    let height = u32::from_be_bytes(bytes[20..24].try_into().unwrap());
    if width == 0 || height == 0 {
        bail!("screenshot PNG had invalid dimensions {width}x{height}");
    }
    Ok((width, height))
}

fn file_uri_to_path(uri: &str) -> Result<PathBuf> {
    let Some(rest) = uri.strip_prefix("file://") else {
        bail!("unsupported screenshot uri: {uri}");
    };
    Ok(PathBuf::from(percent_decode(rest)))
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;

    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let Ok(hex) = std::str::from_utf8(&bytes[index + 1..index + 3]) {
                if let Ok(byte) = u8::from_str_radix(hex, 16) {
                    decoded.push(byte);
                    index += 3;
                    continue;
                }
            }
        }

        decoded.push(bytes[index]);
        index += 1;
    }

    String::from_utf8_lossy(&decoded).into_owned()
}

fn temp_png_path(source: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "codex-computer-use-{source}-{}.png",
        unique_suffix()
    ))
}

fn request_token() -> String {
    format!("codex_{}", unique_suffix().replace('-', "_"))
}

fn unique_suffix() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    format!("{}-{nanos}", std::process::id())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("codex-screenshot-test-{name}-{}", unique_suffix()))
    }

    fn valid_png(width: u32, height: u32) -> Vec<u8> {
        let mut png = Vec::new();
        png.extend_from_slice(b"\x89PNG\r\n\x1a\n");
        png.extend_from_slice(&13_u32.to_be_bytes());
        png.extend_from_slice(b"IHDR");
        png.extend_from_slice(&width.to_be_bytes());
        png.extend_from_slice(&height.to_be_bytes());
        png.extend_from_slice(&[8, 6, 0, 0, 0]);
        png
    }

    #[test]
    fn builds_cli_screenshot_args() {
        let import = ScreenshotCommand {
            source: "imagemagick-import",
            program: "import",
            args: &["-window", "root"],
            output_path_arg: OutputPathArg::Append,
        };
        assert_eq!(
            screenshot_command_args(&import, "/tmp/shot.png"),
            vec!["-window", "root", "/tmp/shot.png"]
        );

        let spectacle = ScreenshotCommand {
            source: "spectacle",
            program: "spectacle",
            args: &["-b", "-n"],
            output_path_arg: OutputPathArg::After("-o"),
        };
        assert_eq!(
            screenshot_command_args(&spectacle, "/tmp/shot.png"),
            vec!["-b", "-n", "-o", "/tmp/shot.png"]
        );
    }

    #[test]
    fn decodes_file_uri_percent_escapes() {
        assert_eq!(
            file_uri_to_path("file:///tmp/Codex%20Screenshot.png").unwrap(),
            PathBuf::from("/tmp/Codex Screenshot.png")
        );
    }

    #[test]
    fn request_token_is_portal_safe() {
        let token = request_token();
        assert!(token.starts_with("codex_"));
        assert!(token.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'));
    }

    #[test]
    fn reads_png_dimensions_from_ihdr() {
        let png = valid_png(3840, 1080);

        assert_eq!(png_dimensions(&png).unwrap(), (3840, 1080));
    }

    #[tokio::test]
    async fn portal_capture_preserves_valid_returned_path() {
        let path = test_path("portal-valid");
        fs::write(&path, valid_png(1, 1)).unwrap();

        let capture = read_png_as_capture(
            path.clone(),
            "xdg-desktop-portal",
            ScreenshotCleanup::Preserve,
        )
        .await
        .unwrap();

        assert_eq!(capture.source, "xdg-desktop-portal");
        assert!(path.exists());
        let _ = fs::remove_file(path);
    }

    #[tokio::test]
    async fn portal_capture_preserves_invalid_returned_path() {
        let path = test_path("portal-invalid");
        fs::write(&path, b"").unwrap();

        let error = read_png_as_capture(
            path.clone(),
            "xdg-desktop-portal",
            ScreenshotCleanup::Preserve,
        )
        .await
        .unwrap_err();

        assert!(error.to_string().contains("screenshot file was empty"));
        assert!(path.exists());
        let _ = fs::remove_file(path);
    }

    #[tokio::test]
    async fn gnome_capture_deletes_backend_temp_path_on_success() {
        let path = test_path("gnome-valid");
        fs::write(&path, valid_png(1, 1)).unwrap();

        let capture = read_png_as_capture(
            path.clone(),
            "gnome-shell",
            ScreenshotCleanup::DeletePath(path.clone()),
        )
        .await
        .unwrap();

        assert_eq!(capture.source, "gnome-shell");
        assert!(!path.exists());
    }

    #[tokio::test]
    async fn gnome_capture_deletes_backend_temp_path_on_parse_failure() {
        let path = test_path("gnome-invalid");
        fs::write(&path, b"").unwrap();

        let error = read_png_as_capture(
            path.clone(),
            "gnome-shell",
            ScreenshotCleanup::DeletePath(path.clone()),
        )
        .await
        .unwrap_err();

        assert!(error.to_string().contains("screenshot file was empty"));
        assert!(!path.exists());
    }

    #[test]
    fn gnome_failure_cleanup_removes_requested_temp_path() {
        let path = test_path("gnome-pre-read-failure");
        fs::write(&path, b"partial").unwrap();

        cleanup_gnome_requested_path(&path);

        assert!(!path.exists());
    }

    #[tokio::test]
    async fn gnome_deletes_requested_temp_path_and_preserves_unexpected_returned_path() {
        let requested = test_path("gnome-requested");
        let returned = test_path("gnome-returned");
        fs::write(&requested, b"partial").unwrap();
        fs::write(&returned, valid_png(1, 1)).unwrap();

        let capture = read_png_as_capture(
            returned.clone(),
            "gnome-shell",
            ScreenshotCleanup::DeletePath(requested.clone()),
        )
        .await
        .unwrap();

        assert_eq!(capture.source, "gnome-shell");
        assert!(!requested.exists());
        assert!(returned.exists());
        let _ = fs::remove_file(returned);
    }
}
