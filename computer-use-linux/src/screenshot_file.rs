//! Screenshot file output (`screenshot_file_path`): the encoded image is saved
//! on the host instead of returned as MCP image content, so a caller that does
//! not need to look at every capture spends no image tokens on it.
//!
//! File output only creates a new file; it never replaces anything. The path
//! is checked before anything is captured and again when the file is written.
//! The write goes to a private temp file in the same directory, which is then
//! moved to the requested path with a step that fails if anything exists
//! there: a reader never sees a partial image, and an entry created meanwhile,
//! a symlink included, is neither followed nor replaced.

use std::fs;
use std::io::{self, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};

use crate::screenshot::ScreenshotOutputFormat;

/// The refusal for a call that reaches the server over `mcp --listen`.
pub(crate) const REMOTE_REFUSAL: &str = "screenshot_file_path is refused over HTTP (mcp --listen): a remote client must not write files on the server host. Omit it to get the image inline.";

/// Checks `path` for a `format` image and returns it as a path. `remote` is
/// set when the call came over HTTP, which never gets file output.
pub(crate) fn validate_screenshot_file_path(
    path: &str,
    format: ScreenshotOutputFormat,
    remote: bool,
) -> Result<PathBuf> {
    if remote {
        bail!(REMOTE_REFUSAL);
    }
    if path.is_empty() {
        bail!("screenshot_file_path is empty");
    }
    let path = Path::new(path);
    if !path.is_absolute() {
        bail!(
            "screenshot_file_path must be an absolute path, got {}",
            path.display()
        );
    }
    let Some(name) = path.file_name() else {
        bail!(
            "screenshot_file_path must name a file, got {}",
            path.display()
        );
    };
    // file_name() drops a trailing "/" or "/.", which the write would not.
    if !path
        .as_os_str()
        .as_encoded_bytes()
        .ends_with(name.as_encoded_bytes())
    {
        bail!(
            "screenshot_file_path must end with the file name, got {}",
            path.display()
        );
    }
    let extension = Path::new(name)
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("");
    let matches = match format {
        ScreenshotOutputFormat::Png => extension.eq_ignore_ascii_case("png"),
        ScreenshotOutputFormat::Jpeg => {
            extension.eq_ignore_ascii_case("jpg") || extension.eq_ignore_ascii_case("jpeg")
        }
    };
    if !matches {
        let expected = match format {
            ScreenshotOutputFormat::Png => ".png",
            ScreenshotOutputFormat::Jpeg => ".jpg or .jpeg",
        };
        bail!(
            "screenshot_file_path {} does not match format {}: use a {expected} extension, or set format to match the file",
            path.display(),
            format_name(format)
        );
    }
    let parent = path.parent().unwrap_or(Path::new("/"));
    match fs::metadata(parent) {
        Ok(metadata) if metadata.is_dir() => {}
        Ok(_) => bail!(
            "the parent of screenshot_file_path, {}, is not a directory",
            parent.display()
        ),
        Err(error) if error.kind() == io::ErrorKind::NotFound => bail!(
            "the parent directory of screenshot_file_path, {}, does not exist; it is not created",
            parent.display()
        ),
        Err(error) => {
            return Err(error).with_context(|| {
                format!(
                    "cannot read the parent directory of screenshot_file_path, {}",
                    parent.display()
                )
            })
        }
    }
    check_existing_entry(path)?;
    Ok(path.to_path_buf())
}

/// Any existing entry is refused: a file, a directory, a symlink, dangling
/// or not.
fn check_existing_entry(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(_) => bail!(already_exists(path)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error)
            .with_context(|| format!("cannot inspect screenshot_file_path {}", path.display())),
    }
}

fn already_exists(path: &Path) -> String {
    format!(
        "screenshot_file_path {} already exists; file output creates a new file and never replaces one",
        path.display()
    )
}

/// Writes `bytes` to the new file `path` through a temp file in the same
/// directory, moved into place only if nothing exists at `path`. The file is
/// created with owner-only permissions. The temp name is short and fixed, so
/// any name that fits the directory also leaves room for it.
pub(crate) fn write_screenshot_file(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path.parent().unwrap_or(Path::new("/"));
    let suffix = getrandom::u64().context("cannot pick a temp file name")?;
    let temp = parent.join(format!(".cul-shot.{suffix:016x}.tmp"));
    let written = (|| -> io::Result<()> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(&temp)?;
        file.write_all(bytes)?;
        file.flush()?;
        drop(file);
        move_without_replacing(&temp, path)
    })();
    if let Err(error) = written {
        let _ = fs::remove_file(&temp);
        if error.kind() == io::ErrorKind::AlreadyExists {
            bail!(already_exists(path));
        }
        return Err(error)
            .with_context(|| format!("failed to write screenshot file {}", path.display()));
    }
    Ok(())
}

/// Moves `from` to `to`, failing with `AlreadyExists` when anything is at
/// `to`. Neither step follows a symlink at `to`.
fn move_without_replacing(from: &Path, to: &Path) -> io::Result<()> {
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;
        let from_c = CString::new(from.as_os_str().as_bytes())?;
        let to_c = CString::new(to.as_os_str().as_bytes())?;
        // SAFETY: both paths are NUL-terminated C strings that outlive the call.
        let result = unsafe {
            libc::renameat2(
                libc::AT_FDCWD,
                from_c.as_ptr(),
                libc::AT_FDCWD,
                to_c.as_ptr(),
                libc::RENAME_NOREPLACE,
            )
        };
        if result == 0 {
            return Ok(());
        }
        let error = io::Error::last_os_error();
        // A filesystem or kernel without RENAME_NOREPLACE falls back to link.
        if !matches!(
            error.raw_os_error(),
            Some(libc::EINVAL | libc::ENOSYS | libc::EOPNOTSUPP)
        ) {
            return Err(error);
        }
    }
    link_without_replacing(from, to)
}

/// The fallback for filesystems without RENAME_NOREPLACE: link `from` to
/// `to`, which fails with `AlreadyExists` when anything is at `to` and never
/// follows a symlink there, then remove `from`. It consumes `from` either way.
/// Once the link exists the image is in place, so removing `from` is best
/// effort: a leftover temp file must not turn a written file into an error.
fn link_without_replacing(from: &Path, to: &Path) -> io::Result<()> {
    let linked = fs::hard_link(from, to);
    let _ = fs::remove_file(from);
    linked.map_err(link_error)
}

/// A filesystem that refuses hard links gets a clear error instead of a write
/// that could replace an entry.
fn link_error(error: io::Error) -> io::Error {
    match error.raw_os_error() {
        Some(libc::EPERM | libc::EOPNOTSUPP | libc::ENOSYS) => io::Error::new(
            io::ErrorKind::Unsupported,
            format!(
                "the filesystem supports neither a no-replace rename nor hard links, so the file cannot be created without risking a replace; pass a screenshot_file_path on another filesystem ({error})"
            ),
        ),
        _ => error,
    }
}

fn format_name(format: ScreenshotOutputFormat) -> &'static str {
    match format {
        ScreenshotOutputFormat::Png => "png",
        ScreenshotOutputFormat::Jpeg => "jpeg",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(label: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "cul-shot-file-{label}-{}-{:016x}",
                std::process::id(),
                getrandom::u64().unwrap()
            ));
            fs::create_dir(&dir).unwrap();
            fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).unwrap();
            Self(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn error(path: &str, format: ScreenshotOutputFormat, remote: bool) -> String {
        format!(
            "{:#}",
            validate_screenshot_file_path(path, format, remote).unwrap_err()
        )
    }

    #[test]
    fn refuses_bad_paths_before_capture() {
        let dir = TempDir::new("refuse");
        let png = ScreenshotOutputFormat::Png;
        let jpeg = ScreenshotOutputFormat::Jpeg;
        let ok = dir.0.join("shot.png");
        let ok = ok.to_str().unwrap();

        assert!(error(ok, png, true).contains("refused over HTTP"));
        assert!(error("", png, false).contains("is empty"));
        assert!(error("shot.png", png, false).contains("must be an absolute path"));
        assert!(error("/", png, false).contains("must name a file"));
        assert!(error(ok, jpeg, false).contains("does not match format jpeg"));
        let jpg = dir.0.join("shot.jpg");
        assert!(error(jpg.to_str().unwrap(), png, false).contains("does not match format png"));
        let bare = dir.0.join("shot");
        assert!(error(bare.to_str().unwrap(), png, false).contains("does not match format png"));
        // file_name() drops a trailing slash or "/.", but the write cannot.
        for trailing in ["/", "/."] {
            let path = format!("{ok}{trailing}");
            assert!(
                error(&path, png, false).contains("must end with the file name"),
                "{path}"
            );
        }

        let missing = dir.0.join("missing").join("shot.png");
        assert!(error(missing.to_str().unwrap(), png, false).contains("does not exist"));
        assert!(!dir.0.join("missing").exists(), "no directory is created");

        let file_parent = dir.0.join("file");
        fs::write(&file_parent, b"x").unwrap();
        let under_file = file_parent.join("shot.png");
        assert!(error(under_file.to_str().unwrap(), png, false).contains("is not a directory"));

        // File output only creates: any existing entry is refused.
        let as_dir = dir.0.join("dir.png");
        fs::create_dir(&as_dir).unwrap();
        let existing = dir.0.join("existing.png");
        fs::write(&existing, b"keep").unwrap();
        let link = dir.0.join("link.png");
        std::os::unix::fs::symlink(&existing, &link).unwrap();
        let dangling = dir.0.join("dangling.png");
        std::os::unix::fs::symlink(dir.0.join("nowhere.png"), &dangling).unwrap();
        for path in [&as_dir, &existing, &link, &dangling] {
            let message = error(path.to_str().unwrap(), png, false);
            assert!(
                message.contains("already exists") && message.contains("never replaces"),
                "{}: {message}",
                path.display()
            );
        }
        assert_eq!(fs::read(&existing).unwrap(), b"keep");

        assert_eq!(
            validate_screenshot_file_path(ok, png, false).unwrap(),
            Path::new(ok)
        );
        for name in ["a.jpg", "a.JPEG", "a.jpeg"] {
            let path = dir.0.join(name);
            assert!(validate_screenshot_file_path(path.to_str().unwrap(), jpeg, false).is_ok());
        }
        assert!(
            validate_screenshot_file_path(dir.0.join("a.PNG").to_str().unwrap(), png, false)
                .is_ok()
        );
    }

    #[test]
    fn writes_a_new_private_file_even_with_a_long_name() {
        let dir = TempDir::new("write");
        let path = dir.0.join("shot.png");
        write_screenshot_file(&path, b"first").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"first");
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        // A name near the 255-byte limit still leaves room for the temp file.
        let long = dir.0.join(format!("{}.png", "a".repeat(250)));
        validate_screenshot_file_path(long.to_str().unwrap(), ScreenshotOutputFormat::Png, false)
            .unwrap();
        write_screenshot_file(&long, b"long").unwrap();
        assert_eq!(fs::read(&long).unwrap(), b"long");
        assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 2);
    }

    #[test]
    fn an_entry_created_after_validation_is_kept_and_the_temp_file_removed() {
        let dir = TempDir::new("exists");
        // The target appears after validation: the final step refuses it
        // after the temp file was written, and removes that temp file.
        let existing = dir.0.join("shot.png");
        validate_screenshot_file_path(
            existing.to_str().unwrap(),
            ScreenshotOutputFormat::Png,
            false,
        )
        .unwrap();
        fs::write(&existing, b"keep").unwrap();
        let message = format!(
            "{:#}",
            write_screenshot_file(&existing, b"new").unwrap_err()
        );
        assert!(message.contains("already exists"), "{message}");
        assert_eq!(fs::read(&existing).unwrap(), b"keep");

        // A symlink is neither followed nor replaced.
        let outside = dir.0.join("outside.png");
        fs::write(&outside, b"outside").unwrap();
        let link = dir.0.join("link.png");
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        assert!(write_screenshot_file(&link, b"new").is_err());
        assert_eq!(fs::read(&outside).unwrap(), b"outside");
        assert!(fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());

        let mut names: Vec<_> = fs::read_dir(&dir.0)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        assert_eq!(
            names,
            ["link.png", "outside.png", "shot.png"],
            "no temp file is left"
        );
    }

    #[test]
    fn the_link_fallback_creates_only_and_consumes_the_temp_file() {
        let dir = TempDir::new("link");
        let temp = dir.0.join(".cul-shot.0000000000000001.tmp");
        let target = dir.0.join("shot.png");
        fs::write(&temp, b"image").unwrap();
        link_without_replacing(&temp, &target).unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"image");
        assert!(!temp.exists(), "the temp file is gone");

        // An existing target is kept, the error is EEXIST, and the temp file
        // is removed.
        let temp = dir.0.join(".cul-shot.0000000000000002.tmp");
        fs::write(&temp, b"new").unwrap();
        let error = link_without_replacing(&temp, &target).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read(&target).unwrap(), b"image");
        assert!(!temp.exists(), "the temp file is removed");
    }

    #[test]
    fn a_failed_temp_unlink_after_the_link_still_succeeds() {
        // Root ignores directory permissions, so this needs an unprivileged user.
        if unsafe { libc::geteuid() } == 0 {
            return;
        }
        let dir = TempDir::new("unlink");
        let locked = dir.0.join("locked");
        fs::create_dir(&locked).unwrap();
        let temp = locked.join(".cul-shot.0000000000000003.tmp");
        fs::write(&temp, b"image").unwrap();
        // The link needs only search access to the temp file's directory,
        // removing the temp file needs write access too.
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o500)).unwrap();
        let target = dir.0.join("shot.png");
        let result = link_without_replacing(&temp, &target);
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o700)).unwrap();
        result.expect("the image is in place, so the move succeeded");
        assert_eq!(fs::read(&target).unwrap(), b"image");
    }

    #[test]
    fn a_filesystem_without_links_gets_a_clear_error() {
        for errno in [libc::EPERM, libc::EOPNOTSUPP, libc::ENOSYS] {
            let error = link_error(io::Error::from_raw_os_error(errno));
            assert_eq!(error.kind(), io::ErrorKind::Unsupported, "{errno}");
            let message = error.to_string();
            assert!(
                message.contains("supports neither a no-replace rename nor hard links")
                    && message.contains("another filesystem"),
                "{message}"
            );
        }
        let exists = link_error(io::Error::from_raw_os_error(libc::EEXIST));
        assert_eq!(exists.kind(), io::ErrorKind::AlreadyExists);
    }
}
