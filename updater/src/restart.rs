//! Detects when the running updater binary has been replaced on disk.

use crate::install;
use std::{
    fs,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
};

const PROC_SELF_EXE: &str = "/proc/self/exe";

/// Returns the replacement path when the running image and its path on disk
/// no longer refer to the same inode.
pub fn replacement_binary() -> Option<PathBuf> {
    let link_target = fs::read_link(PROC_SELF_EXE).ok()?;
    let installed_path = install::strip_deleted_path_suffix(&link_target).unwrap_or(link_target);
    replacement_at(Path::new(PROC_SELF_EXE), &installed_path)
}

fn replacement_at(running_image: &Path, installed_path: &Path) -> Option<PathBuf> {
    let running = fs::metadata(running_image).ok()?;
    let installed = fs::metadata(installed_path).ok()?;
    if running.dev() == installed.dev() && running.ino() == installed.ino() {
        return None;
    }
    Some(installed_path.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;
    use anyhow::Result;

    #[test]
    fn same_file_is_not_a_replacement() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let binary = temp.path().join("codex-update-manager");
        fs::write(&binary, b"current")?;

        assert_eq!(replacement_at(&binary, &binary), None);
        Ok(())
    }

    #[test]
    fn different_inode_is_a_replacement_even_with_identical_contents() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let running = temp.path().join("codex-update-manager.old");
        let installed = temp.path().join("codex-update-manager");
        fs::write(&running, b"same updater")?;
        fs::write(&installed, b"same updater")?;

        assert_eq!(replacement_at(&running, &installed), Some(installed));
        Ok(())
    }

    #[test]
    fn missing_installed_binary_is_not_a_replacement() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let running = temp.path().join("codex-update-manager.old");
        fs::write(&running, b"current")?;

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
