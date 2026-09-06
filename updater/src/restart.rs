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
    use std::{
        env,
        process::{Command, Stdio},
        thread,
        time::Duration,
    };

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

    #[test]
    fn replacement_process_fixture() -> Result<()> {
        let Some(mode) = env::var_os("CODEX_RESTART_FIXTURE_MODE") else {
            return Ok(());
        };
        let marker = PathBuf::from(
            env::var_os("CODEX_RESTART_FIXTURE_MARKER")
                .expect("fixture marker path is required"),
        );
        match mode.to_string_lossy().as_ref() {
            "block" => {
                fs::write(&marker, b"ready")?;
                let release = PathBuf::from(
                    env::var_os("CODEX_RESTART_FIXTURE_RELEASE")
                        .expect("fixture release path is required"),
                );
                while !release.exists() {
                    thread::sleep(Duration::from_millis(10));
                }
                exit_for_replacement();
            }
            "report" => {
                fs::write(&marker, env::current_exe()?.as_os_str().as_bytes())?;
            }
            other => panic!("unknown replacement fixture mode: {other}"),
        }
        Ok(())
    }

    #[test]
    fn successful_self_replacement_restarts_on_new_binary_and_next_build_uses_it() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let source = env::current_exe()?;
        let installed = temp.path().join("codex-update-manager");
        let replacement = temp.path().join("codex-update-manager.new");
        let ready = temp.path().join("old-ready");
        let release = temp.path().join("release-old");
        let report = temp.path().join("new-exe");

        fs::copy(&source, &installed)?;
        let mut old = Command::new(&installed)
            .args([
                "restart::tests::replacement_process_fixture",
                "--exact",
                "--nocapture",
            ])
            .env("CODEX_RESTART_FIXTURE_MODE", "block")
            .env("CODEX_RESTART_FIXTURE_MARKER", &ready)
            .env("CODEX_RESTART_FIXTURE_RELEASE", &release)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()?;

        for _ in 0..200 {
            if ready.exists() {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        assert!(ready.exists(), "old updater fixture did not become ready");

        fs::copy(&source, &replacement)?;
        fs::rename(&replacement, &installed)?;

        let running_image = PathBuf::from(format!("/proc/{}/exe", old.id()));
        assert_eq!(
            replacement_at(&running_image, &installed),
            Some(installed.clone()),
            "running old inode must detect the newly installed updater"
        );

        fs::write(&release, b"go")?;
        assert_eq!(
            old.wait()?.code(),
            Some(REPLACEMENT_RESTART_EXIT_CODE),
            "old updater must exit with the Restart=on-failure code"
        );

        let restarted = Command::new(&installed)
            .args([
                "restart::tests::replacement_process_fixture",
                "--exact",
                "--nocapture",
            ])
            .env("CODEX_RESTART_FIXTURE_MODE", "report")
            .env("CODEX_RESTART_FIXTURE_MARKER", &report)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()?;
        assert!(restarted.success(), "replacement updater fixture failed to start");

        let restarted_exe = PathBuf::from(OsStr::from_bytes(&fs::read(&report)?));
        assert_eq!(restarted_exe, installed);
        assert_eq!(
            crate::builder::updater_binary_source_at(&restarted_exe, &installed),
            installed,
            "the next rebuild must source the live replacement updater, never a deleted process image"
        );
        Ok(())
    }
}
