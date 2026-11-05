//! Paths for unit tests that bind or connect to Unix sockets, and the
//! private D-Bus daemon they share.
//!
//! A socket path must fit `sun_path`, so a fixture under a long `TMPDIR`
//! fails with a bind error that reads like a product bug. Fixtures pick their
//! place here instead: the temp dir when the longest socket path fits, else
//! `XDG_RUNTIME_DIR`, else a panic that names the limit and the path. A bus
//! socket's path must also need no escaping in a D-Bus address: zbus reads
//! `%XX` escapes literally, so a client could not connect.
//! `scripts/socket_fixture.py` applies the same rule to the Python fixtures.
//! `tests/window_targeting_setup.rs` includes this file too.

use std::{
    fs,
    io::{BufRead, BufReader},
    os::unix::{ffi::OsStrExt, fs::PermissionsExt},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
};

/// `sun_path` holds 108 bytes, including the terminating NUL.
const SOCKET_PATH_MAX: usize = 107;
/// dbus-daemon refuses a listen path longer than this.
const DBUS_SOCKET_PATH_MAX: usize = 99;
/// The socket dbus-daemon makes for `<listen>unix:dir=DIR</listen>`.
const DBUS_DIR_SOCKET: &str = "dbus-XXXXXXXXXX";

/// A dbus-daemon whose socket stays in a fixture directory of its own.
///
/// The config has no service directories, so nothing on the bus can
/// activate a desktop service, and the daemon starts with an empty
/// environment. dbus-daemon leaves its socket behind when it is killed, so
/// drop removes the directory after the daemon exits.
pub(crate) struct PrivateBus {
    child: Child,
    address: String,
    // Dropped after the daemon is killed.
    dir: FixtureDir,
}

/// Removes the directory when dropped, also when a start step panics.
struct FixtureDir(PathBuf);

impl Drop for FixtureDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

impl PrivateBus {
    /// Starts a bus in a new fixture directory whose name begins with `label`.
    pub(crate) fn start(label: &str) -> Self {
        let dir = FixtureDir(bus_fixture(
            &format!("{label}-{:016x}", getrandom::u64().unwrap()),
            DBUS_DIR_SOCKET,
        ));
        fs::create_dir(&dir.0).expect("create private bus dir");
        // The directory also serves as a private XDG_RUNTIME_DIR.
        fs::set_permissions(&dir.0, fs::Permissions::from_mode(0o700)).unwrap();
        let config = dir.0.join("bus.conf");
        fs::write(
            &config,
            format!(
                "<busconfig><type>session</type><listen>unix:dir={}</listen>\
                 <policy context=\"default\"><allow own=\"*\"/>\
                 <allow send_destination=\"*\"/><allow receive_sender=\"*\"/>\
                 </policy></busconfig>",
                dir.0.display()
            ),
        )
        .unwrap();
        let child = Command::new("dbus-daemon")
            .arg(format!("--config-file={}", config.display()))
            .args(["--nofork", "--nopidfile", "--print-address=1"])
            .env_clear()
            .stdout(Stdio::piped())
            .spawn()
            .expect("start private dbus-daemon");
        let mut bus = Self {
            child,
            address: String::new(),
            dir,
        };
        BufReader::new(bus.child.stdout.take().unwrap())
            .read_line(&mut bus.address)
            .expect("read private bus address");
        bus.address = bus.address.trim().to_string();
        assert!(!bus.address.is_empty(), "private bus printed no address");
        bus
    }

    pub(crate) fn address(&self) -> &str {
        &self.address
    }

    /// The fixture directory, which holds the socket and the config.
    pub(crate) fn dir(&self) -> &Path {
        &self.dir.0
    }
}

impl Drop for PrivateBus {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Whether `path` goes into a D-Bus address as is: every byte is in
/// `[-0-9A-Za-z_/.\*]`, the set that needs no `%XX` escape. Such a path
/// needs no XML escaping either.
fn dbus_plain(path: &Path) -> bool {
    path.as_os_str()
        .as_bytes()
        .iter()
        .all(|byte| byte.is_ascii_alphanumeric() || b"-_/.\\*".contains(byte))
}

/// Path of the fixture `name`, whose longest socket path is `name/deepest`,
/// or `name` itself when `deepest` is empty. Nothing is created.
pub(crate) fn socket_fixture(name: &str, deepest: &str) -> PathBuf {
    fixture(name, deepest, SOCKET_PATH_MAX, false)
}

/// [`socket_fixture`] for a directory that holds a private dbus-daemon's
/// listen socket, `name/socket`. The path also needs no escaping in a D-Bus
/// address.
pub(crate) fn bus_fixture(name: &str, socket: &str) -> PathBuf {
    fixture(name, socket, DBUS_SOCKET_PATH_MAX, true)
}

fn fixture(name: &str, deepest: &str, limit: usize, plain: bool) -> PathBuf {
    let runtime = std::env::var_os("XDG_RUNTIME_DIR")
        .filter(|dir| !dir.is_empty())
        .map(PathBuf::from);
    place(
        name,
        deepest,
        limit,
        plain,
        &std::env::temp_dir(),
        runtime.as_deref(),
    )
    .unwrap_or_else(|message| panic!("{message}"))
}

fn place(
    name: &str,
    deepest: &str,
    limit: usize,
    plain: bool,
    temp: &Path,
    runtime: Option<&Path>,
) -> Result<PathBuf, String> {
    let socket = |base: &Path| {
        let path = base.join(name);
        if deepest.is_empty() {
            path
        } else {
            path.join(deepest)
        }
    };
    let overflow = |base: &Path| {
        let path = socket(base);
        let length = path.as_os_str().len();
        if length > limit {
            Some(format!(
                "{} is {length} bytes, over the {limit}-byte limit",
                path.display()
            ))
        } else if plain && !dbus_plain(&path) {
            Some(format!(
                "{} has a byte that a D-Bus address escapes, and zbus does not decode escapes",
                path.display()
            ))
        } else {
            None
        }
    };
    let Some(first) = overflow(temp) else {
        return Ok(temp.join(name));
    };
    let fallback = match runtime {
        Some(dir) if dir.is_absolute() && dir.is_dir() => match overflow(dir) {
            None => return Ok(dir.join(name)),
            Some(second) => format!("under XDG_RUNTIME_DIR, {second}"),
        },
        Some(dir) => format!(
            "XDG_RUNTIME_DIR ({}) is not an absolute directory",
            dir.display()
        ),
        None => "XDG_RUNTIME_DIR is unset".to_string(),
    };
    Err(format!(
        "No usable Unix socket path: {first}; {fallback}. \
         Set TMPDIR or XDG_RUNTIME_DIR to a path that fits."
    ))
}

mod tests {
    use super::*;

    #[test]
    fn a_long_temp_dir_moves_to_the_runtime_dir_or_names_the_limit() {
        let root = Path::new("/");
        // 96 bytes: a socket two short names below it fits 107 bytes but
        // not dbus-daemon's 99.
        let long = PathBuf::from(format!("/{}", "t".repeat(95)));
        assert_eq!(
            place("f", "bus", 107, false, &long, Some(root)),
            Ok(long.join("f"))
        );
        assert_eq!(
            place("f", "bus", 99, true, &long, Some(root)),
            Ok(root.join("f"))
        );
        assert_eq!(
            place("fixture", "a.sock", 107, false, &long, Some(root)),
            Ok(root.join("fixture"))
        );

        let error = place("fixture", "a.sock", 107, false, &long, None).unwrap_err();
        let path = long.join("fixture/a.sock");
        assert!(
            error.contains(&format!(
                "{} is 111 bytes, over the 107-byte limit;",
                path.display()
            )),
            "{error}"
        );
        assert!(error.contains("XDG_RUNTIME_DIR is unset"), "{error}");
        let error = place("fixture", "a.sock", 10, false, &long, Some(root)).unwrap_err();
        assert!(
            error.contains("under XDG_RUNTIME_DIR, /fixture/a.sock is 15 bytes"),
            "{error}"
        );
        let error = place("f.sock", "", 10, false, &long, Some(Path::new("run"))).unwrap_err();
        assert!(error.contains("/f.sock is 103 bytes"), "{error}");
        assert!(
            error.contains("(run) is not an absolute directory"),
            "{error}"
        );
    }

    #[test]
    fn a_private_bus_keeps_its_socket_in_its_dir_and_removes_both() {
        use std::os::unix::fs::FileTypeExt;

        let bus = PrivateBus::start("cul-bus-test");
        let dir = bus.dir().to_path_buf();
        // Find the socket by listing the directory, not by parsing the
        // address. The address must still name it.
        let sockets: Vec<PathBuf> = fs::read_dir(&dir)
            .unwrap()
            .map(|entry| entry.unwrap())
            .filter(|entry| entry.file_type().unwrap().is_socket())
            .map(|entry| entry.path())
            .collect();
        let [socket] = sockets.as_slice() else {
            panic!("expected one socket in {}: {sockets:?}", dir.display());
        };
        let name = socket.file_name().unwrap().to_str().unwrap();
        assert!(
            bus.address().contains(&format!("/{name},")),
            "{} does not name {name}",
            bus.address()
        );
        let socket = socket.clone();
        drop(bus);
        assert!(!socket.exists(), "{} outlived its bus", socket.display());
        assert!(!dir.exists(), "{} outlived its bus", dir.display());
    }

    #[test]
    fn a_bus_moves_out_of_a_temp_dir_its_address_would_escape() {
        let root = Path::new("/");
        let spaced = Path::new("/t mp");
        assert_eq!(
            place("f", "bus", 99, false, spaced, Some(root)),
            Ok(spaced.join("f"))
        );
        assert_eq!(
            place("f", "bus", 99, true, spaced, Some(root)),
            Ok(root.join("f"))
        );
        assert_eq!(
            place("f", "bus", 99, true, Path::new("/a-b_c.d/e*"), None),
            Ok(Path::new("/a-b_c.d/e*/f").to_path_buf())
        );
        let error = place("f", "bus", 99, true, spaced, None).unwrap_err();
        assert!(
            error.contains("/t mp/f/bus has a byte that a D-Bus address escapes"),
            "{error}"
        );
        assert!(error.contains("XDG_RUNTIME_DIR is unset"), "{error}");
    }

    /// Every private bus a test or script starts listens in a fixture
    /// directory: Rust tests use [`PrivateBus`] or pass their own config,
    /// scripts pass one from `socket_fixture.private_bus_config`. The session
    /// config and `unix:tmpdir` put the socket in `/tmp`, where a killed
    /// daemon leaves it behind, and the session config can start any
    /// installed service.
    #[test]
    fn every_test_bus_listens_in_its_fixture() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let tmpdir_listen = concat!("unix:", "tmp", "dir=");
        let session_config = concat!("session", ".conf");
        let programs = [
            concat!("dbus-", "daemon"),
            concat!("dbus-", "run-session"),
            concat!("dbus-", "launch"),
        ];
        // All of src, and the files directly in tests and scripts.
        let mut files = Vec::new();
        let mut dirs = vec![root.join("src")];
        while let Some(dir) = dirs.pop() {
            for entry in fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    dirs.push(path);
                } else {
                    files.push(path);
                }
            }
        }
        for dir in ["tests", "scripts"] {
            for entry in fs::read_dir(root.join(dir)).unwrap() {
                files.push(entry.unwrap().path());
            }
        }
        files.retain(|path| {
            matches!(
                path.extension().and_then(|extension| extension.to_str()),
                Some("rs" | "py" | "sh")
            )
        });
        let mut offenders = Vec::new();
        for path in files {
            let shell = path.extension().is_some_and(|extension| extension == "sh");
            let text = fs::read_to_string(&path).unwrap();
            let lines: Vec<&str> = text.lines().collect();
            for (index, line) in lines.iter().enumerate() {
                // A Rust or Python call quotes the program name. A shell
                // line runs it as a word outside a comment.
                let code = if shell {
                    line.split(" #").next().unwrap_or_default()
                } else {
                    line
                };
                let starts_bus = programs.iter().any(|program| {
                    if shell {
                        !code.trim_start().starts_with('#')
                            && code.split_whitespace().any(|word| word == *program)
                    } else {
                        code.contains(&format!("'{program}'"))
                            || code.contains(&format!("\"{program}\""))
                    }
                });
                // A call may put its config on one of the next two lines.
                let call = lines[index..lines.len().min(index + 3)].join(" ");
                let own_config = call.contains("--config-file") && !call.contains(session_config);
                if line.contains(tmpdir_listen) || (starts_bus && !own_config) {
                    offenders.push(format!("{}:{}", path.display(), index + 1));
                }
            }
        }
        assert!(
            offenders.is_empty(),
            "private buses that listen outside their fixture: {offenders:?}"
        );
    }
}
