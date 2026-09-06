//! Detects when the running updater binary has been replaced on disk.
//!
//! Native package upgrades replace `/usr/bin/codex-update-manager` while the
//! old process can continue executing its unlinked inode. Detection is based on
//! device/inode identity, not content, because a package can replace the file
//! with byte-identical contents and `/proc/self/exe` will still become
//! `... (deleted)`.

use std::{
    ffi::OsStr,
    fs,
    os::unix::ffi::OsStrExt,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
};

const PROC_SELF_EXE: &str = "/proc/self/exe";
const DELETED_SUFFIX: &str = " (deleted)";
pub const REPLACEMENT_RESTART_EXIT_CODE: i32 = 12;

/// Returns the installed path of a replacement updater binary when the
/// running process image no longer matches the file now present on disk.
pub fn replacement_binary() -> Option<PathBuf> {
    let link_target = fs::read_link(PROC_SELF_EXE).ok()?;
    let installed_path = strip_deleted_suffix(&link_target);
    replacement_at(Path::new(PROC_SELF_EXE), &installed_path)
}

pub fn exit_for_replacement() -> ! {
    std::process::exit(REPLACEMENT_RESTART_EXIT_CODE);
}

fn replacement_at(running_image: &Path, installed_path: &Path) -> Option<PathBuf> {
    let running = fs::metadata(running_image).ok()?;
    let installed = fs::metadata(installed_path).ok()?;
    if running.dev() == installed.dev() && running.ino() == installed.ino() {
        return None;
    }
    Some(installed_path.to_path_buf())
}

fn strip_deleted_suffix(target: &Path) -> PathBuf {
    let bytes = target.as_os_str().as_bytes();
    match bytes.strip_suffix(DELETED_SUFFIX.as_bytes()) {
        Some(stripped) => PathBuf::from(OsStr::from_bytes(stripped)),
        None => target.to_path_buf(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use anyhow::Result;

    #[test]
    fn strips_deleted_suffix_from_replaced_binary_link() {
        assert_eq!(
            strip_deleted_suffix(Path::new("/usr/bin/codex-update-manager (deleted)")),
            PathBuf::from("/usr/bin/codex-update-manager")
        );
    }

    #[test]
    fn same_file_is_not_a_replacement() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let binary = temp.path().join("codex-update-manager");
        fs::write(&binary, b"current")?;
        assert_eq!(replacement_at(&binary, &binary), None);
        Ok(())
    }

    #[test]
    fn different_inode_is_a_replacement_even_when_contents_match() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let running = temp.path().join("codex-update-manager.old");
        let installed = temp.path().join("codex-update-manager");
        fs::write(&running, b"same bytes")?;
        fs::write(&installed, b"same bytes")?;
        assert_eq!(replacement_at(&running, &installed), Some(installed));
        Ok(())
    }

    #[test]
    fn missing_installed_binary_is_not_a_replacement() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let running = temp.path().join("codex-update-manager.old");
        fs::write(&running, b"old")?;
        assert_eq!(
            replacement_at(&running, &temp.path().join("codex-update-manager")),
            None
        );
        Ok(())
    }

    #[test]
    fn current_test_binary_is_not_reported_as_replaced() {
        assert_eq!(replacement_binary(), None);
    }
}
