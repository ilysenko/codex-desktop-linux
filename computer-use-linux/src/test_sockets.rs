//! Paths for unit tests that bind or connect to Unix sockets.
//!
//! A socket path must fit `sun_path`, so a fixture under a long `TMPDIR`
//! fails with a bind error that reads like a product bug. Fixtures pick their
//! place here instead: the temp dir when the longest socket path fits, else
//! `XDG_RUNTIME_DIR`, else a panic that names the limit and the path.
//! `scripts/socket_fixture.py` applies the same rule to the Python fixtures.

use std::path::{Path, PathBuf};

/// `sun_path` holds 108 bytes, including the terminating NUL.
const SOCKET_PATH_MAX: usize = 107;
/// dbus-daemon refuses a listen path longer than this.
const DBUS_SOCKET_PATH_MAX: usize = 99;

/// Path of the fixture `name`, whose longest socket path is `name/deepest`,
/// or `name` itself when `deepest` is empty. Nothing is created.
pub(crate) fn socket_fixture(name: &str, deepest: &str) -> PathBuf {
    fixture(name, deepest, SOCKET_PATH_MAX)
}

/// [`socket_fixture`] for a directory that holds a private dbus-daemon's
/// listen socket, `name/socket`.
pub(crate) fn bus_fixture(name: &str, socket: &str) -> PathBuf {
    fixture(name, socket, DBUS_SOCKET_PATH_MAX)
}

fn fixture(name: &str, deepest: &str, limit: usize) -> PathBuf {
    let runtime = std::env::var_os("XDG_RUNTIME_DIR")
        .filter(|dir| !dir.is_empty())
        .map(PathBuf::from);
    place(
        name,
        deepest,
        limit,
        &std::env::temp_dir(),
        runtime.as_deref(),
    )
    .unwrap_or_else(|message| panic!("{message}"))
}

fn place(
    name: &str,
    deepest: &str,
    limit: usize,
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
        (length > limit).then(|| {
            format!(
                "{} is {length} bytes, over the {limit}-byte limit",
                path.display()
            )
        })
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
        "Unix socket path too long: {first}; {fallback}. \
         Set TMPDIR or XDG_RUNTIME_DIR to a shorter path."
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
            place("f", "bus", 107, &long, Some(root)),
            Ok(long.join("f"))
        );
        assert_eq!(place("f", "bus", 99, &long, Some(root)), Ok(root.join("f")));
        assert_eq!(
            place("fixture", "a.sock", 107, &long, Some(root)),
            Ok(root.join("fixture"))
        );

        let error = place("fixture", "a.sock", 107, &long, None).unwrap_err();
        let path = long.join("fixture/a.sock");
        assert!(
            error.contains(&format!(
                "{} is 111 bytes, over the 107-byte limit;",
                path.display()
            )),
            "{error}"
        );
        assert!(error.contains("XDG_RUNTIME_DIR is unset"), "{error}");
        let error = place("fixture", "a.sock", 10, &long, Some(root)).unwrap_err();
        assert!(
            error.contains("under XDG_RUNTIME_DIR, /fixture/a.sock is 15 bytes"),
            "{error}"
        );
        let error = place("f.sock", "", 10, &long, Some(Path::new("run"))).unwrap_err();
        assert!(error.contains("/f.sock is 103 bytes"), "{error}");
        assert!(
            error.contains("(run) is not an absolute directory"),
            "{error}"
        );
    }
}
