//! Process liveness checks for the Electron app managed by the updater.

use crate::config::{self, RuntimeConfig};
use anyhow::{Context, Result};
use std::{
    fs::{self, OpenOptions},
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
};

pub const APP_RUNNING_INSTALL_ERROR_MARKER: &str = "CODEX_UPDATE_APP_RUNNING";

/// Exclusive access to the launcher's detection -> spawn critical section.
///
/// Holding this while applying a native package prevents a desktop launch from
/// publishing a new Electron process between the updater's final liveness
/// check and the package manager replacing the webview asset tree.
pub struct LauncherLock {
    _file: fs::File,
}

#[derive(Debug)]
struct AppRunningDuringInstall {
    executable: PathBuf,
}

impl std::fmt::Display for AppRunningDuringInstall {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "{APP_RUNNING_INSTALL_ERROR_MARKER}: ChatGPT Desktop started before the package install; close {} and retry",
            self.executable.display()
        )
    }
}

impl std::error::Error for AppRunningDuringInstall {}

/// Returns the PID file used by the Linux launcher to track the Electron app.
pub fn app_pid_file() -> Result<PathBuf> {
    Ok(config::resolve_app_state_dir()?.join("app.pid"))
}

/// Tries to acquire the same lock the launcher holds until Electron is spawned
/// and its PID is published. `None` means a launch is currently in progress.
pub fn try_acquire_launcher_lock() -> Result<Option<LauncherLock>> {
    let state_dir = config::resolve_app_state_dir()?;
    fs::create_dir_all(&state_dir)
        .with_context(|| format!("Failed to create {}", state_dir.display()))?;
    let lock_path = state_dir.join("launcher.lock");
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(&lock_path)
        .with_context(|| format!("Failed to open {}", lock_path.display()))?;
    let metadata = file
        .metadata()
        .with_context(|| format!("Failed to inspect {}", lock_path.display()))?;
    anyhow::ensure!(
        metadata.is_file() && metadata.uid() == unsafe { libc::geteuid() },
        "Launcher lock {} is not a user-owned regular file",
        lock_path.display()
    );
    if metadata.permissions().mode() & 0o077 != 0 {
        file.set_permissions(fs::Permissions::from_mode(0o600))
            .with_context(|| format!("Failed to secure {}", lock_path.display()))?;
    }

    match file.try_lock() {
        Ok(()) => Ok(Some(LauncherLock { _file: file })),
        Err(fs::TryLockError::WouldBlock) => Ok(None),
        Err(fs::TryLockError::Error(error)) => {
            Err(error).with_context(|| format!("Failed to lock {}", lock_path.display()))
        }
    }
}

/// Detects whether the managed Electron app is currently running.
pub fn is_app_running(config: &RuntimeConfig) -> Result<bool> {
    let executable = executable_identity_path(&config.app_executable_path);
    if let Some(pid) = read_pid_file()?.filter(|pid| process_matches(*pid, &executable)) {
        return Ok(is_process_alive(pid));
    }

    scan_proc_for_executable(&executable)
}

/// Detects any live process whose executable is the requested app binary.
pub fn is_executable_running(executable: &Path) -> Result<bool> {
    scan_proc_for_executable(&executable_identity_path(executable))
}

/// Fails with a machine-recognizable marker when a privileged package helper
/// observes that the app was reopened after the unprivileged updater check.
pub fn ensure_executable_not_running(executable: &Path) -> Result<()> {
    if is_executable_running(executable)? {
        return Err(AppRunningDuringInstall {
            executable: executable.to_path_buf(),
        }
        .into());
    }
    Ok(())
}

pub fn error_reports_app_running(stderr: &[u8]) -> bool {
    String::from_utf8_lossy(stderr).contains(APP_RUNNING_INSTALL_ERROR_MARKER)
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
            .map(|path| executable_paths_match(&path, expected))
            .unwrap_or(false)
}

fn executable_paths_match(actual: &Path, expected: &Path) -> bool {
    if actual == expected {
        return true;
    }

    // Linux appends this suffix to /proc/<pid>/exe after a package manager has
    // replaced the inode. The process is still alive and must continue to block
    // another update even though its old executable has been unlinked.
    actual
        .as_os_str()
        .as_encoded_bytes()
        .strip_suffix(b" (deleted)")
        .is_some_and(|path| path == expected.as_os_str().as_encoded_bytes())
}

fn executable_identity_path(executable: &Path) -> PathBuf {
    fs::canonicalize(executable).unwrap_or_else(|_| executable.to_path_buf())
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
    use std::io::BufRead as _;

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

    #[test]
    fn deleted_proc_executable_still_matches_installed_path() {
        assert!(executable_paths_match(
            Path::new("/opt/codex-desktop/electron (deleted)"),
            Path::new("/opt/codex-desktop/electron")
        ));
        assert!(!executable_paths_match(
            Path::new("/opt/other/electron (deleted)"),
            Path::new("/opt/codex-desktop/electron")
        ));
    }

    #[test]
    fn running_unlinked_executable_is_detected_from_proc() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let executable = temp.path().join("electron");
        fs::copy(fs::canonicalize("/bin/sh")?, &executable)?;
        let mut child = std::process::Command::new(&executable)
            .args(["-c", "sleep 30"])
            .spawn()?;

        let result = (|| -> Result<()> {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            while read_exe_link(child.id()).ok().as_deref() != Some(executable.as_path()) {
                anyhow::ensure!(
                    std::time::Instant::now() < deadline,
                    "timed out waiting for the copied executable to start"
                );
                std::thread::sleep(std::time::Duration::from_millis(10));
            }

            fs::remove_file(&executable)?;
            let proc_executable = read_exe_link(child.id())?;
            anyhow::ensure!(
                proc_executable
                    .as_os_str()
                    .as_encoded_bytes()
                    .ends_with(b" (deleted)"),
                "expected a deleted /proc executable, got {}",
                proc_executable.display()
            );
            assert!(is_executable_running(&executable)?);
            Ok(())
        })();

        let _ = child.kill();
        let _ = child.wait();
        result
    }

    #[test]
    fn executable_identity_resolves_symlinks() -> Result<()> {
        let resolved = executable_identity_path(Path::new("/usr/bin/yes"));
        assert_eq!(resolved, fs::canonicalize("/usr/bin/yes")?);
        Ok(())
    }

    #[test]
    fn launcher_lock_serializes_with_other_holders() -> Result<()> {
        let _env_guard = env_lock();
        let temp = tempfile::tempdir()?;
        let _restore_env = EnvRestoreGuard::capture(&[
            "XDG_STATE_HOME",
            "CODEX_LINUX_APP_ID",
            "CODEX_APP_ID",
            "CODEX_LINUX_INSTANCE_ID",
        ]);
        std::env::set_var("XDG_STATE_HOME", temp.path());
        std::env::set_var("CODEX_LINUX_APP_ID", "codex-lock-test");
        std::env::remove_var("CODEX_APP_ID");
        std::env::remove_var("CODEX_LINUX_INSTANCE_ID");

        let first = try_acquire_launcher_lock()?.expect("first lock should succeed");
        assert!(try_acquire_launcher_lock()?.is_none());
        drop(first);
        assert!(try_acquire_launcher_lock()?.is_some());
        Ok(())
    }

    #[test]
    fn launcher_lock_interoperates_with_the_shell_flock_helper() -> Result<()> {
        let _env_guard = env_lock();
        let temp = tempfile::tempdir()?;
        let _restore_env = EnvRestoreGuard::capture(&[
            "XDG_STATE_HOME",
            "CODEX_LINUX_APP_ID",
            "CODEX_APP_ID",
            "CODEX_LINUX_INSTANCE_ID",
        ]);
        std::env::set_var("XDG_STATE_HOME", temp.path());
        std::env::set_var("CODEX_LINUX_APP_ID", "codex-shell-lock-test");
        std::env::remove_var("CODEX_APP_ID");
        std::env::remove_var("CODEX_LINUX_INSTANCE_ID");

        let lock_path = config::resolve_app_state_dir()?.join("launcher.lock");
        fs::create_dir_all(lock_path.parent().expect("launcher lock has a parent"))?;
        let mut holder = std::process::Command::new("flock")
            .arg("-x")
            .arg(&lock_path)
            .arg("sh")
            .arg("-c")
            .arg("printf 'locked\\n'; cat >/dev/null")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()?;
        let mut ready = String::new();
        std::io::BufReader::new(holder.stdout.as_mut().expect("holder stdout"))
            .read_line(&mut ready)?;
        assert_eq!(ready, "locked\n");

        assert!(try_acquire_launcher_lock()?.is_none());
        drop(holder.stdin.take());
        assert!(holder.wait()?.success());
        assert!(try_acquire_launcher_lock()?.is_some());
        Ok(())
    }

    #[test]
    fn privileged_guard_reports_a_machine_recognizable_running_app() -> Result<()> {
        let error = ensure_executable_not_running(&std::env::current_exe()?)
            .expect_err("the current test executable must be detected");
        assert!(error.to_string().contains(APP_RUNNING_INSTALL_ERROR_MARKER));
        assert!(error_reports_app_running(error.to_string().as_bytes()));
        Ok(())
    }
}
