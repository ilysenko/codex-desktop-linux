//! Process liveness checks for the Electron app managed by the updater.

use crate::{config::RuntimeConfig, install};
use anyhow::{Context, Result};
use std::{
    fs,
    path::{Path, PathBuf},
};

/// Detects whether the managed Electron app is currently running.
pub fn is_app_running(config: &RuntimeConfig) -> Result<bool> {
    scan_proc_for_executable(&config.app_executable_path)
}

fn scan_proc_for_executable(expected: &Path) -> Result<bool> {
    let proc_dir = Path::new("/proc");
    for entry in fs::read_dir(proc_dir).context("Failed to read /proc")? {
        let entry = entry?;
        let Some(file_name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        let Ok(pid) = file_name.parse::<u32>() else {
            continue;
        };

        if process_matches(pid, expected) {
            return Ok(true);
        }
    }

    Ok(false)
}

fn process_matches(pid: u32, expected: &Path) -> bool {
    is_process_alive(pid)
        && read_exe_link(pid)
            .map(|path| exe_link_matches(&path, expected))
            .unwrap_or(false)
}

/// A package upgrade that replaces the app image while the app is running
/// leaves `/proc/<pid>/exe` pointing at the unlinked file, which the kernel
/// reports as "<path> (deleted)". That process is still the managed app.
fn exe_link_matches(link_target: &Path, expected: &Path) -> bool {
    install::strip_deleted_path_suffix(link_target)
        .as_deref()
        .unwrap_or(link_target)
        == expected
}

fn is_process_alive(pid: u32) -> bool {
    Path::new("/proc").join(pid.to_string()).exists()
}

fn read_exe_link(pid: u32) -> Result<PathBuf> {
    fs::read_link(Path::new("/proc").join(pid.to_string()).join("exe"))
        .with_context(|| format!("Failed to read /proc/{pid}/exe"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use anyhow::Result;
    use std::process::Command;

    #[test]
    fn current_process_is_not_mistaken_for_electron() -> Result<()> {
        let mut config = crate::config::RuntimeConfig::default_with_paths(
            &crate::config::RuntimePaths::detect()?,
        );
        config.app_executable_path = PathBuf::from("/opt/codex-desktop/ChatGPT");

        assert!(!process_matches(
            std::process::id(),
            &config.app_executable_path
        ));
        Ok(())
    }

    #[test]
    fn running_app_is_still_detected_after_its_executable_is_replaced() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let app = temp.path().join("ChatGPT");
        // Copy in a child process so no writable descriptor for the new
        // executable exists in the parallel test runner, where another
        // thread's fork could inherit it and make the spawn fail with ETXTBSY.
        let copied = Command::new("cp").arg("/bin/sleep").arg(&app).status()?;
        anyhow::ensure!(copied.success(), "cp /bin/sleep failed: {copied}");
        let mut child = Command::new(&app).arg("30").spawn()?;

        // A package upgrade unlinks the old image while it is still running.
        // The kernel then reports `/proc/<pid>/exe` as "<path> (deleted)".
        fs::remove_file(&app)?;
        let link = read_exe_link(child.id());
        let still_detected = process_matches(child.id(), &app);
        child.kill()?;
        child.wait()?;
        let link = link?;

        assert!(
            link.to_string_lossy().ends_with(" (deleted)"),
            "unexpected exe link {link:?}"
        );
        assert!(still_detected);
        Ok(())
    }

    #[test]
    fn replaced_executable_of_another_path_is_not_mistaken_for_the_app() {
        let expected = Path::new("/opt/codex-desktop/ChatGPT");

        assert!(exe_link_matches(expected, expected));
        assert!(exe_link_matches(
            Path::new("/opt/codex-desktop/ChatGPT (deleted)"),
            expected
        ));
        assert!(!exe_link_matches(
            Path::new("/opt/other/ChatGPT (deleted)"),
            expected
        ));
        assert!(!exe_link_matches(
            Path::new("/opt/codex-desktop/ChatGPT-helper (deleted)"),
            expected
        ));
        assert!(!exe_link_matches(
            Path::new("/opt/codex-desktop/ChatGPT (deleted) (deleted)"),
            expected
        ));
    }
}
