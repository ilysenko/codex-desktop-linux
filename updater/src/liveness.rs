//! Process liveness checks for the Electron app managed by the updater.

use crate::config::{self, RuntimeConfig};
use anyhow::{Context, Result};
use std::{
    fs,
    path::{Path, PathBuf},
};

/// Returns the PID file used by the Linux launcher to track the Electron app.
pub fn app_pid_file() -> Result<PathBuf> {
    Ok(config::resolve_app_state_dir()?.join("app.pid"))
}

/// Detects whether the managed Electron app is currently running.
pub fn is_app_running(config: &RuntimeConfig) -> Result<bool> {
    if let Some(pid) =
        read_pid_file()?.filter(|pid| process_matches(*pid, &config.app_executable_path))
    {
        return Ok(is_process_alive(pid));
    }

    scan_proc_for_executable(&config.app_executable_path)
}

fn read_pid_file() -> Result<Option<u32>> {
    let path = app_pid_file()?;
    if !path.exists() {
        return Ok(None);
    }

    let content =
        fs::read_to_string(&path).with_context(|| format!("Failed to read {}", path.display()))?;
    match content.trim().parse::<u32>() {
        Ok(pid) => Ok(Some(pid)),
        Err(_) => Ok(None),
    }
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
            .map(|path| path == expected)
            .unwrap_or(false)
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
    use crate::test_util::{env_lock, EnvRestoreGuard};
    use anyhow::Result;

    #[test]
    fn pid_file_is_located_under_resolved_app_state() -> Result<()> {
        let _env_guard = env_lock();
        let _restore_env = EnvRestoreGuard::capture(&[
            "CODEX_LINUX_APP_ID",
            "CODEX_APP_ID",
            "CODEX_LINUX_INSTANCE_ID",
        ]);
        std::env::set_var("CODEX_LINUX_APP_ID", "codex-test");
        std::env::set_var("CODEX_LINUX_INSTANCE_ID", "port-6175");

        let pid_file = app_pid_file()?;
        assert!(pid_file.ends_with("codex-test/instances/port-6175/app.pid"));
        Ok(())
    }

    #[test]
    fn current_process_is_not_mistaken_for_electron() -> Result<()> {
        let mut config = crate::config::RuntimeConfig::default_with_paths(
            &crate::config::RuntimePaths::detect()?,
        );
        config.app_executable_path = PathBuf::from("/opt/codex-desktop/electron");

        assert!(!process_matches(
            std::process::id(),
            &config.app_executable_path
        ));
        Ok(())
    }
}
