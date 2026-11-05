use crate::command_runner;
use std::{
    env,
    ffi::{CString, OsStr, OsString},
    fs, io,
    os::unix::{
        ffi::{OsStrExt, OsStringExt},
        fs::{DirBuilderExt, FileTypeExt, MetadataExt, PermissionsExt},
        net::UnixDatagram,
    },
    path::{Path, PathBuf},
    process::{self, Command, Stdio},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CliGeneration {
    RawEvents,
    LegacyNamed,
}

const MAX_UNIX_SOCKET_PATH_BYTES: usize = 107;
const PROBE_DIRECTORY_ATTEMPTS: usize = 8;
const PROBE_COMMAND_TIMEOUT: Duration = Duration::from_secs(2);
const FAILED_PROBE_CACHE_TTL: Duration = Duration::from_secs(5);
const UNSUPPORTED_MESSAGE: &str = "unsupported ydotool CLI; Computer Use requires ydotool 1.0.3 or newer with raw key events, wheel movement, stdin typing, and absolute mouse movement";
const YDOTOOL_SOCKET_NAME: &str = ".ydotool_socket";

/// Resolve the socket used for real input. An explicit `YDOTOOL_SOCKET` is an
/// operator trust override; implicit discovery is restricted to an owner-only
/// runtime directory and socket so a different local UID cannot capture input.
pub(crate) fn socket_path_for_command() -> Result<PathBuf, String> {
    if let Ok(socket) = env::var("YDOTOOL_SOCKET") {
        let socket = socket.trim();
        if !socket.is_empty() {
            return Ok(PathBuf::from(socket));
        }
    }

    let uid = unsafe { libc::geteuid() };
    implicit_socket_path(env::var_os("XDG_RUNTIME_DIR").as_deref(), uid)
}

pub(crate) fn connectable_socket_path() -> Result<PathBuf, String> {
    let path = socket_path_for_command()?;
    UnixDatagram::unbound()
        .and_then(|socket| socket.connect(&path))
        .map_err(|error| format!("{}: datagram: {error}", path.display()))?;
    Ok(path)
}

fn implicit_socket_path(runtime_dir: Option<&OsStr>, uid: libc::uid_t) -> Result<PathBuf, String> {
    let runtime_dir = runtime_dir
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(format!("/run/user/{uid}")));
    validate_private_runtime_dir(&runtime_dir, uid)?;
    let socket = runtime_dir.join(YDOTOOL_SOCKET_NAME);
    validate_private_socket(&socket, uid)?;
    Ok(socket)
}

fn validate_private_runtime_dir(path: &Path, uid: libc::uid_t) -> Result<(), String> {
    if !path.is_absolute() {
        return Err(format!(
            "ydotool runtime directory is not absolute: {}",
            path.display()
        ));
    }
    let metadata =
        fs::symlink_metadata(path).map_err(|error| format!("{}: {error}", path.display()))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(format!(
            "ydotool runtime path is not a real directory: {}",
            path.display()
        ));
    }
    if metadata.uid() != uid || metadata.permissions().mode() & 0o022 != 0 {
        return Err(format!(
            "ydotool runtime directory must be owned by uid {uid} and not group/world-writable: {}",
            path.display()
        ));
    }
    Ok(())
}

fn validate_private_socket(path: &Path, uid: libc::uid_t) -> Result<(), String> {
    let metadata =
        fs::symlink_metadata(path).map_err(|error| format!("{}: {error}", path.display()))?;
    if metadata.file_type().is_symlink() || !metadata.file_type().is_socket() {
        return Err(format!(
            "ydotool path is not a real Unix socket: {}",
            path.display()
        ));
    }
    if metadata.uid() != uid || metadata.permissions().mode() & 0o077 != 0 {
        return Err(format!(
            "ydotool socket must be owned by uid {uid} with no group/other access: {}",
            path.display()
        ));
    }
    Ok(())
}

struct ProbeSocket {
    _socket: UnixDatagram,
    directory: PathBuf,
    path: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ExecutableFingerprint {
    path: PathBuf,
    device: u64,
    inode: u64,
    length: u64,
    modified_seconds: i64,
    modified_nanoseconds: i64,
    changed_seconds: i64,
    changed_nanoseconds: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SupportedYdotool {
    pub(crate) executable: PathBuf,
    pub(crate) detail: String,
}

#[derive(Debug, PartialEq, Eq)]
enum ProbeCacheKey {
    Executable(ExecutableFingerprint),
    SearchPath {
        path: OsString,
        current_dir: Option<PathBuf>,
    },
}

struct CachedProbe<K, V> {
    key: K,
    result: Result<V, String>,
    checked_at: Instant,
}

impl ProbeSocket {
    fn bind_with(runtime_dir: Option<&OsStr>, temp_dir: &Path) -> Result<Self, String> {
        let uid = unsafe { libc::geteuid() };
        let mut failures = Vec::new();
        for base in probe_socket_bases(runtime_dir, temp_dir) {
            if let Err(error) = validate_probe_base(&base, uid) {
                failures.push(format!("{}: {error}", base.display()));
                continue;
            }
            match Self::bind_in(&base) {
                Ok(socket) => return Ok(socket),
                Err(error) => failures.push(format!("{}: {error}", base.display())),
            }
        }

        let detail = if failures.is_empty() {
            "no candidate runtime directory was available".to_string()
        } else {
            failures.join("; ")
        };
        Err(format!(
            "failed to bind isolated ydotool probe socket: {detail}"
        ))
    }

    fn bind_in(base: &Path) -> io::Result<Self> {
        let sample_path = base.join(format!(
            ".codex-ydotool-probe-{}-0000000000000000/s",
            process::id()
        ));
        if !unix_socket_path_fits(&sample_path) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "probe socket path is too long",
            ));
        }

        for _ in 0..PROBE_DIRECTORY_ATTEMPTS {
            let nonce = random_hex(8)?;
            let directory = base.join(format!(".codex-ydotool-probe-{}-{nonce}", process::id()));
            let path = directory.join("s");
            let mut builder = fs::DirBuilder::new();
            builder.mode(0o700);
            match builder.create(&directory) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error),
            }
            if let Err(error) = fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)) {
                let _ = fs::remove_dir(&directory);
                return Err(error);
            }
            match UnixDatagram::bind(&path) {
                Ok(socket) => {
                    return Ok(Self {
                        _socket: socket,
                        directory,
                        path,
                    });
                }
                Err(error) => {
                    let _ = fs::remove_file(&path);
                    let _ = fs::remove_dir(&directory);
                    return Err(error);
                }
            }
        }

        Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "could not allocate a unique probe directory",
        ))
    }
}

impl Drop for ProbeSocket {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
        let _ = fs::remove_dir(&self.directory);
    }
}

pub(crate) fn ensure_supported() -> Result<SupportedYdotool, String> {
    static SUPPORTED: OnceLock<Mutex<Option<CachedProbe<ProbeCacheKey, SupportedYdotool>>>> =
        OnceLock::new();
    let search_path = executable_search_path();
    let current_dir = env::current_dir().ok();
    let executable = resolve_executable_with("ydotool", &search_path, current_dir.as_deref());
    let key = executable
        .as_deref()
        .and_then(executable_fingerprint)
        .map(ProbeCacheKey::Executable)
        .unwrap_or_else(|| ProbeCacheKey::SearchPath {
            path: search_path,
            current_dir,
        });
    cached_result_or_probe(
        SUPPORTED.get_or_init(|| Mutex::new(None)),
        key,
        FAILED_PROBE_CACHE_TTL,
        move || probe_executable(executable),
    )
}

pub(crate) async fn ensure_supported_async() -> Result<SupportedYdotool, String> {
    tokio::task::spawn_blocking(ensure_supported)
        .await
        .map_err(|error| format!("ydotool capability probe task failed: {error}"))?
}

fn cached_result_or_probe<K: PartialEq, V: Clone>(
    cache: &Mutex<Option<CachedProbe<K, V>>>,
    key: K,
    failure_ttl: Duration,
    probe: impl FnOnce() -> Result<V, String>,
) -> Result<V, String> {
    let Ok(mut cached) = cache.lock() else {
        return probe();
    };
    if let Some(cached) = cached.as_ref() {
        if cached.key == key && (cached.result.is_ok() || cached.checked_at.elapsed() < failure_ttl)
        {
            return cached.result.clone();
        }
    }
    let result = probe();
    *cached = Some(CachedProbe {
        key,
        result: result.clone(),
        checked_at: Instant::now(),
    });
    result
}

fn executable_search_path() -> OsString {
    env::var_os("PATH").unwrap_or_else(default_search_path)
}

fn default_search_path() -> OsString {
    let length = unsafe { libc::confstr(libc::_CS_PATH, std::ptr::null_mut(), 0) };
    if length == 0 {
        return OsString::from("/bin:/usr/bin");
    }
    let mut buffer = vec![0_u8; length];
    let written = unsafe {
        libc::confstr(
            libc::_CS_PATH,
            buffer.as_mut_ptr().cast::<libc::c_char>(),
            buffer.len(),
        )
    };
    if written == 0 {
        return OsString::from("/bin:/usr/bin");
    }
    if buffer.last() == Some(&0) {
        buffer.pop();
    }
    OsString::from_vec(buffer)
}

fn resolve_executable_with(
    command: &str,
    search_path: &OsStr,
    current_dir: Option<&Path>,
) -> Option<PathBuf> {
    env::split_paths(search_path)
        .filter_map(|directory| {
            let directory = if directory.as_os_str().is_empty() {
                current_dir?.to_path_buf()
            } else if directory.is_absolute() {
                directory
            } else {
                current_dir?.join(directory)
            };
            Some(directory.join(command))
        })
        .find(|path| executable_by_effective_user(path))
}

fn executable_by_effective_user(path: &Path) -> bool {
    if !path.metadata().is_ok_and(|metadata| metadata.is_file()) {
        return false;
    }
    let Ok(path) = CString::new(path.as_os_str().as_bytes()) else {
        return false;
    };
    unsafe { libc::faccessat(libc::AT_FDCWD, path.as_ptr(), libc::X_OK, libc::AT_EACCESS) == 0 }
}

fn executable_fingerprint(path: &Path) -> Option<ExecutableFingerprint> {
    let metadata = path.metadata().ok()?;
    Some(ExecutableFingerprint {
        path: path.to_path_buf(),
        device: metadata.dev(),
        inode: metadata.ino(),
        length: metadata.len(),
        modified_seconds: metadata.mtime(),
        modified_nanoseconds: metadata.mtime_nsec(),
        changed_seconds: metadata.ctime(),
        changed_nanoseconds: metadata.ctime_nsec(),
    })
}

fn probe_executable(executable: Option<PathBuf>) -> Result<SupportedYdotool, String> {
    let executable =
        executable.ok_or_else(|| "ydotool executable was not found in PATH".to_string())?;
    let runtime_dir = env::var_os("XDG_RUNTIME_DIR");
    let detail = probe_with(&executable, runtime_dir.as_deref(), &env::temp_dir())?;
    Ok(SupportedYdotool { executable, detail })
}

fn probe_with(
    ydotool_path: &Path,
    runtime_dir: Option<&OsStr>,
    temp_dir: &Path,
) -> Result<String, String> {
    let mut output_text = String::new();
    for argument in ["help", "--help"] {
        let mut command = Command::new(ydotool_path);
        command.arg(argument);
        let output = command_output_with_timeout(&mut command, "ydotool", PROBE_COMMAND_TIMEOUT)?;
        output_text.push_str(&String::from_utf8_lossy(&output.stdout));
        output_text.push_str(&String::from_utf8_lossy(&output.stderr));
        if let Some(generation) = classify_help(&output_text) {
            return match generation {
                CliGeneration::RawEvents => {
                    probe_raw_semantics(ydotool_path, runtime_dir, temp_dir)
                        .map(|()| "compatible raw-event CLI detected".to_string())
                }
                CliGeneration::LegacyNamed => Err(UNSUPPORTED_MESSAGE.to_string()),
            };
        }
    }
    Err("unrecognized ydotool CLI; Computer Use requires ydotool 1.0.3 or newer".to_string())
}

fn probe_raw_semantics(
    ydotool_path: &Path,
    runtime_dir: Option<&OsStr>,
    temp_dir: &Path,
) -> Result<(), String> {
    let absolute = run_probe_command(
        ydotool_path,
        runtime_dir,
        temp_dir,
        &["mousemove", "--absolute", "--", "0", "0"],
        None,
    )?;
    require_semantic_probe(&absolute)?;
    let wheel = run_probe_command(
        ydotool_path,
        runtime_dir,
        temp_dir,
        &["mousemove", "--wheel", "--", "0", "0"],
        None,
    )?;
    require_semantic_probe(&wheel)?;
    let click = run_probe_command(
        ydotool_path,
        runtime_dir,
        temp_dir,
        &["click", "0xC0"],
        None,
    )?;
    require_semantic_probe(&click)?;
    let key = run_probe_command(
        ydotool_path,
        runtime_dir,
        temp_dir,
        &["key", "-d", "100", "1:1", "1:0"],
        None,
    )?;
    require_semantic_probe(&key)?;
    let type_from_stdin = run_probe_command(
        ydotool_path,
        runtime_dir,
        temp_dir,
        &["type", "--file", "-"],
        Some(Path::new("/proc/self/fd")),
    )?;
    require_semantic_probe(&type_from_stdin)
}

fn run_probe_command(
    ydotool_path: &Path,
    runtime_dir: Option<&OsStr>,
    temp_dir: &Path,
    args: &[&str],
    current_dir: Option<&Path>,
) -> Result<std::process::Output, String> {
    let socket = ProbeSocket::bind_with(runtime_dir, temp_dir)?;
    let mut command = Command::new(ydotool_path);
    command
        .args(args)
        .env("YDOTOOL_SOCKET", &socket.path)
        // ydotool 1.0.2 swapped the YDOTOOL_SOCKET/XDG_RUNTIME_DIR branches.
        // Removing XDG_RUNTIME_DIR makes that version fail closed instead of
        // sending capability-probe events to the user's live daemon.
        .env_remove("XDG_RUNTIME_DIR")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(current_dir) = current_dir {
        command.current_dir(current_dir);
    }
    command_output_with_timeout(
        &mut command,
        "ydotool capability probe",
        PROBE_COMMAND_TIMEOUT,
    )
}

fn command_output_with_timeout(
    command: &mut Command,
    label: &str,
    timeout_duration: Duration,
) -> Result<std::process::Output, String> {
    command_runner::output_blocking_with_timeout(command, label, timeout_duration)
        .map_err(|error| format!("{error:#}"))
}

fn probe_socket_bases(runtime_dir: Option<&OsStr>, temp_dir: &Path) -> Vec<PathBuf> {
    let mut bases = Vec::new();
    if let Some(runtime_dir) = runtime_dir {
        push_unique_path(&mut bases, PathBuf::from(runtime_dir));
    }
    push_unique_path(&mut bases, temp_dir.to_path_buf());
    push_unique_path(&mut bases, PathBuf::from("/tmp"));
    bases
}

fn push_unique_path(paths: &mut Vec<PathBuf>, path: PathBuf) {
    if !paths.iter().any(|candidate| candidate == &path) {
        paths.push(path);
    }
}

fn validate_probe_base(path: &Path, uid: libc::uid_t) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("path is not absolute".to_string());
    }
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("path is not a real directory".to_string());
    }
    let mode = metadata.permissions().mode();
    let user_owned_safe_directory = metadata.uid() == uid && mode & 0o022 == 0;
    let root_owned_sticky_directory = metadata.uid() == 0 && mode & libc::S_ISVTX != 0;
    if !user_owned_safe_directory && !root_owned_sticky_directory {
        return Err("directory is not private or root-owned sticky".to_string());
    }
    Ok(())
}

fn random_hex(byte_count: usize) -> io::Result<String> {
    let mut bytes = vec![0_u8; byte_count];
    getrandom::fill(&mut bytes).map_err(io::Error::other)?;
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(byte_count * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    Ok(output)
}

fn unix_socket_path_fits(path: &Path) -> bool {
    path.as_os_str().as_bytes().len() <= MAX_UNIX_SOCKET_PATH_BYTES
}

fn raw_semantic_probes_succeeded(results: &[(bool, &[u8])]) -> bool {
    results
        .iter()
        .all(|(success, stderr)| *success && cli_error(stderr).is_none())
}

fn require_semantic_probe(output: &std::process::Output) -> Result<(), String> {
    if raw_semantic_probes_succeeded(&[(output.status.success(), &output.stderr)]) {
        Ok(())
    } else {
        Err(UNSUPPORTED_MESSAGE.to_string())
    }
}

pub(crate) fn classify_help(help: &str) -> Option<CliGeneration> {
    let commands = help
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>();
    let required_raw_commands = ["click", "mousemove", "type", "key", "debug"];
    if required_raw_commands
        .iter()
        .all(|command| commands.contains(command))
    {
        Some(CliGeneration::RawEvents)
    } else if commands.contains(&"recorder") {
        Some(CliGeneration::LegacyNamed)
    } else {
        None
    }
}

pub(crate) fn cli_error(stderr: &[u8]) -> Option<String> {
    let detail = String::from_utf8_lossy(stderr).trim().to_string();
    let normalized = detail.to_ascii_lowercase();
    [
        "unrecognised option",
        "unrecognized option",
        "unknown option",
        "invalid option",
        "unknown command",
    ]
    .iter()
    .any(|needle| normalized.contains(needle))
    .then_some(detail)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Barrier,
    };
    use std::thread;

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new(label: &str) -> Self {
            Self::create(env::temp_dir().join(Self::name(label)))
        }

        /// A directory for sockets no longer than `deepest`.
        fn with_sockets(label: &str, deepest: &str) -> Self {
            Self::create(crate::test_sockets::socket_fixture(
                &Self::name(label),
                deepest,
            ))
        }

        fn name(label: &str) -> String {
            format!(
                "cul-yd-{label}-{}-{}",
                process::id(),
                random_hex(8).expect("test nonce")
            )
        }

        fn create(path: PathBuf) -> Self {
            let mut builder = fs::DirBuilder::new();
            builder.mode(0o700);
            builder.create(&path).expect("create test directory");
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700))
                .expect("secure test directory");
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn fake_supported_ydotool(root: &Path) -> PathBuf {
        let path = root.join("ydotool");
        fs::write(
            &path,
            r#"#!/bin/sh
case "$1" in
  help|--help)
    printf '%s\n' \
      'Usage: ydotool <cmd> <args>' \
      'Available commands:' \
      '  click' \
      '  mousemove' \
      '  type' \
      '  key' \
      '  debug'
    exit 0
    ;;
  *)
    test -z "${XDG_RUNTIME_DIR+x}" || exit 65
    printf '%s\n' "$YDOTOOL_SOCKET" >> "${0%/*}/socket-paths"
    ;;
esac
case "$1" in
  mousemove)
    test -S "$YDOTOOL_SOCKET" &&
      { test "$2" = '--wheel' || test "$2" = '--absolute'; } &&
      test "$3" = '--' && test "$4" = '0' && test "$5" = '0'
    ;;
  click)
    test -S "$YDOTOOL_SOCKET" && test "$2" = '0xC0'
    ;;
  key)
    test -S "$YDOTOOL_SOCKET" && test "$2" = '-d' &&
      test "$3" = '100' && test "$4" = '1:1' && test "$5" = '1:0'
    ;;
  type)
    test -S "$YDOTOOL_SOCKET" &&
      test "$2" = '--file' &&
      test "$3" = '-'
    ;;
  *)
    exit 64
    ;;
esac
"#,
        )
        .expect("write fake ydotool");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700))
            .expect("make fake ydotool executable");
        path
    }

    fn bind_test_datagram(path: &Path) -> Option<UnixDatagram> {
        match UnixDatagram::bind(path) {
            Ok(socket) => Some(socket),
            Err(error) if error.kind() == io::ErrorKind::PermissionDenied => {
                eprintln!("skipping Unix datagram assertion in restricted sandbox: {error}");
                None
            }
            Err(error) => panic!("bind datagram socket: {error}"),
        }
    }

    #[test]
    fn implicit_socket_requires_private_runtime_directory_and_socket() {
        let root = TestDirectory::with_sockets("implicit-socket", YDOTOOL_SOCKET_NAME);
        let socket_path = root.0.join(YDOTOOL_SOCKET_NAME);
        let Some(socket) = bind_test_datagram(&socket_path) else {
            return;
        };
        fs::set_permissions(&socket_path, fs::Permissions::from_mode(0o600))
            .expect("secure socket");
        let uid = unsafe { libc::geteuid() };

        assert_eq!(
            implicit_socket_path(Some(root.0.as_os_str()), uid).unwrap(),
            socket_path
        );

        fs::set_permissions(&socket_path, fs::Permissions::from_mode(0o666))
            .expect("make socket unsafe");
        assert!(implicit_socket_path(Some(root.0.as_os_str()), uid).is_err());
        fs::set_permissions(&socket_path, fs::Permissions::from_mode(0o600))
            .expect("restore socket mode");
        fs::set_permissions(&root.0, fs::Permissions::from_mode(0o777))
            .expect("make runtime directory unsafe");
        assert!(implicit_socket_path(Some(root.0.as_os_str()), uid).is_err());
        drop(socket);
    }

    #[test]
    fn implicit_socket_rejects_shared_tmp_and_wrong_owner() {
        let uid = unsafe { libc::geteuid() };
        assert!(implicit_socket_path(Some(OsStr::new("/tmp")), uid).is_err());

        let root = TestDirectory::with_sockets("wrong-owner", YDOTOOL_SOCKET_NAME);
        let socket_path = root.0.join(YDOTOOL_SOCKET_NAME);
        let Some(_socket) = bind_test_datagram(&socket_path) else {
            return;
        };
        fs::set_permissions(&socket_path, fs::Permissions::from_mode(0o600))
            .expect("secure socket");
        assert!(implicit_socket_path(Some(root.0.as_os_str()), uid.saturating_add(1)).is_err());
    }

    #[test]
    fn implicit_socket_rejects_symlinked_runtime_directory() {
        let root = TestDirectory::new("symlink-runtime");
        let real = root.0.join("real");
        let link = root.0.join("link");
        fs::create_dir(&real).expect("create real runtime directory");
        fs::set_permissions(&real, fs::Permissions::from_mode(0o700))
            .expect("secure real runtime directory");
        std::os::unix::fs::symlink(&real, &link).expect("create runtime symlink");

        assert!(implicit_socket_path(Some(link.as_os_str()), unsafe { libc::geteuid() }).is_err());
    }

    #[test]
    fn classifies_legacy_named_cli_from_ubuntu_ydotool() {
        let help = "Usage: ydotool <cmd> <args>\nAvailable commands:\n  type\n  recorder\n  mousemove\n  key\n  click\n";

        assert_eq!(classify_help(help), Some(CliGeneration::LegacyNamed));
    }

    #[test]
    fn classifies_raw_event_cli_from_current_ydotool() {
        let help = "Usage: ydotool <cmd> <args>\nAvailable commands:\n  click\n  mousemove\n  type\n  key\n  debug\n  stdin\n";

        assert_eq!(classify_help(help), Some(CliGeneration::RawEvents));
    }

    #[test]
    fn classifies_arch_1_0_4_cli_as_raw_events() {
        let help = "Usage: ydotool <cmd> <args>\nAvailable commands:\n  click\n  mousemove\n  type\n  key\n  debug\n  bakers\n";

        assert_eq!(classify_help(help), Some(CliGeneration::RawEvents));
    }

    #[test]
    fn accepts_supported_raw_cli_without_xdg_runtime_dir() {
        let root = TestDirectory::new("no-xdg-cli");
        let ydotool = fake_supported_ydotool(&root.0);

        assert_eq!(
            probe_with(&ydotool, None, &root.0),
            Ok("compatible raw-event CLI detected".to_string())
        );
        assert_eq!(
            fs::read_dir(&root.0)
                .expect("read test directory")
                .filter_map(Result::ok)
                .filter(|entry| {
                    entry
                        .file_name()
                        .to_string_lossy()
                        .starts_with(".codex-ydotool-probe-")
                })
                .count(),
            0
        );
        let socket_paths = fs::read_to_string(root.0.join("socket-paths"))
            .expect("read recorded probe socket paths")
            .lines()
            .map(str::to_string)
            .collect::<Vec<_>>();
        let mut unique_paths = socket_paths.clone();
        unique_paths.sort();
        unique_paths.dedup();
        assert_eq!(socket_paths.len(), 5);
        assert_eq!(unique_paths.len(), 5);
    }

    #[test]
    fn capability_probe_commands_are_bounded() {
        let mut command = Command::new("sh");
        command.args(["-c", "exec sleep 1"]);

        let started = Instant::now();
        let error =
            command_output_with_timeout(&mut command, "test probe", Duration::from_millis(20))
                .unwrap_err();

        assert!(error.contains("timed out"));
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn capability_probe_kills_descendants_that_hold_output_pipes() {
        let root = TestDirectory::new("probe-process-group");
        let pid_path = root.0.join("descendant-pid");
        let mut command = Command::new("sh");
        command.args([
            "-c",
            &format!("sleep 60 & printf %s $! > '{}'; exit 0", pid_path.display()),
        ]);

        let error =
            command_output_with_timeout(&mut command, "test probe", Duration::from_millis(100))
                .unwrap_err();

        assert!(error.contains("timed out"));
        let pid = fs::read_to_string(&pid_path)
            .expect("read descendant pid")
            .parse::<u32>()
            .expect("parse descendant pid");
        wait_for_process_exit(pid);
    }

    #[test]
    fn capability_probe_drains_large_output() {
        let mut command = Command::new("sh");
        command.args([
            "-c",
            "yes stdout | head -c 200000; yes stderr | head -c 200000 >&2",
        ]);

        let output =
            command_output_with_timeout(&mut command, "noisy probe", Duration::from_secs(5))
                .expect("noisy probe should complete");

        assert!(output.status.success());
        assert!(output.stdout.len() >= 200_000);
        assert!(output.stderr.len() >= 200_000);
    }

    #[test]
    fn capability_probe_continuous_output_remains_bounded() {
        let mut command = Command::new("sh");
        command.args(["-c", "exec yes output"]);
        let started = Instant::now();

        let error =
            command_output_with_timeout(&mut command, "continuous probe", Duration::from_secs(5))
                .unwrap_err();

        assert!(error.contains("output exceeded"));
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn capability_probe_forces_stdin_closed() {
        let mut command = Command::new("sh");
        command.args(["-c", "read value && exit 7 || exit 0"]);
        command.stdin(Stdio::piped());

        let output =
            command_output_with_timeout(&mut command, "stdin probe", Duration::from_millis(100))
                .expect("probe stdin should be closed");

        assert!(output.status.success());
    }

    #[test]
    fn executable_resolution_uses_one_absolute_path() {
        let root = TestDirectory::new("resolve-executable");
        let first = root.0.join("first");
        let second = root.0.join("second");
        fs::create_dir_all(&first).expect("create first PATH directory");
        fs::create_dir_all(&second).expect("create second PATH directory");
        fs::write(first.join("ydotool"), "not executable").expect("write first candidate");
        fs::write(second.join("ydotool"), "#!/bin/sh\nexit 0\n").expect("write second candidate");
        fs::set_permissions(second.join("ydotool"), fs::Permissions::from_mode(0o700))
            .expect("make second candidate executable");
        let search_path =
            env::join_paths([Path::new("first"), Path::new("second")]).expect("join relative PATH");

        let resolved = resolve_executable_with("ydotool", &search_path, Some(&root.0));

        assert_eq!(resolved, Some(second.join("ydotool")));
    }

    #[test]
    fn failed_probe_is_temporarily_cached_and_success_is_persistent() {
        let cache = Mutex::new(None);
        let attempts = AtomicUsize::new(0);
        let probe = || {
            let attempt = attempts.fetch_add(1, Ordering::SeqCst);
            if attempt == 0 {
                Err("not installed".to_string())
            } else {
                Ok("compatible".to_string())
            }
        };

        assert_eq!(
            cached_result_or_probe(&cache, "first", Duration::from_secs(60), probe),
            Err("not installed".to_string())
        );
        assert_eq!(
            cached_result_or_probe(&cache, "first", Duration::from_secs(60), probe),
            Err("not installed".to_string())
        );
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
        assert_eq!(
            cached_result_or_probe(&cache, "first", Duration::ZERO, probe),
            Ok("compatible".to_string())
        );
        assert_eq!(
            cached_result_or_probe(&cache, "first", Duration::ZERO, probe),
            Ok("compatible".to_string())
        );
        assert_eq!(attempts.load(Ordering::SeqCst), 2);

        assert_eq!(
            cached_result_or_probe(&cache, "replacement", Duration::ZERO, probe),
            Ok("compatible".to_string())
        );
        assert_eq!(attempts.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn concurrent_capability_probes_are_coalesced() {
        let cache = Arc::new(Mutex::new(None));
        let attempts = Arc::new(AtomicUsize::new(0));
        let barrier = Arc::new(Barrier::new(3));
        let handles = (0..2)
            .map(|_| {
                let cache = Arc::clone(&cache);
                let attempts = Arc::clone(&attempts);
                let barrier = Arc::clone(&barrier);
                thread::spawn(move || {
                    barrier.wait();
                    cached_result_or_probe(&cache, "same", Duration::from_secs(60), || {
                        attempts.fetch_add(1, Ordering::SeqCst);
                        thread::sleep(Duration::from_millis(30));
                        Ok("compatible".to_string())
                    })
                })
            })
            .collect::<Vec<_>>();
        barrier.wait();

        for handle in handles {
            assert_eq!(handle.join().unwrap(), Ok("compatible".to_string()));
        }
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn rejects_raw_cli_without_wheel_semantics() {
        assert!(!raw_semantic_probes_succeeded(&[
            (true, b""),
            (true, b"mousemove: unrecognized option '--wheel'\n"),
        ]));
    }

    #[test]
    fn rejects_raw_cli_without_stdin_file_semantics() {
        assert!(!raw_semantic_probes_succeeded(&[
            (true, b""),
            (
                false,
                b"ydotool: type: error: failed to open -: No such file or directory\n",
            ),
        ]));
    }

    #[test]
    fn accepts_raw_cli_with_required_semantics() {
        assert!(raw_semantic_probes_succeeded(&[
            (true, b""),
            (true, b""),
            (true, b""),
            (true, b""),
            (true, b""),
        ]));
    }

    #[test]
    fn rejects_unknown_cli_shape() {
        assert_eq!(classify_help("Usage: ydotool <cmd>"), None);
    }

    #[test]
    fn recognizes_cli_errors_even_when_exit_status_is_success() {
        assert_eq!(
            cli_error(b"error: unrecognised option '--absolute'\n"),
            Some("error: unrecognised option '--absolute'".to_string())
        );
    }

    #[test]
    fn ignores_non_error_stderr() {
        assert_eq!(cli_error(b"ydotoold socket ready\n"), None);
    }

    fn wait_for_process_exit(pid: u32) {
        for _ in 0..100 {
            if !Path::new(&format!("/proc/{pid}")).exists() {
                return;
            }
            thread::sleep(Duration::from_millis(10));
        }
        unsafe {
            libc::kill(pid as i32, libc::SIGKILL);
        }
        panic!("probe descendant {pid} was not killed")
    }
}
