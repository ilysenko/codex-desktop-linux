//! Process liveness checks for the Electron app managed by the updater.

use crate::config::{self, RuntimeConfig};
use anyhow::{Context, Result};
use directories::BaseDirs;
use sha2::{Digest, Sha256};
use std::{
    fmt::Write as _,
    fs::{self, OpenOptions},
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

pub const APP_RUNNING_INSTALL_ERROR_MARKER: &str = "CODEX_UPDATE_APP_RUNNING";
const INSTALL_LAUNCH_GATE_DIR: &str = ".local/state/codex-desktop/install-gates";
const INSTALL_LAUNCH_GATE_WAIT: Duration = Duration::from_secs(10);

/// Exclusive access to the launcher's detection -> spawn critical section.
///
/// Holding this while applying a native package prevents a desktop launch from
/// publishing a new Electron process between the updater's final liveness
/// check and the package manager replacing the webview asset tree.
pub struct InstallLaunchGate {
    file: fs::File,
    path: PathBuf,
}

impl InstallLaunchGate {
    /// Carries this exact flock lease into the privileged helper on fd 0.
    ///
    /// `pkexec` preserves the standard descriptors. Package-manager children
    /// inherit stdin in turn, so the lease remains alive even when a Debian
    /// upgrade stops the user-service process that originally acquired it.
    pub fn inherit_through_stdin(&self, command: &mut Command) -> Result<()> {
        let lease = self
            .file
            .try_clone()
            .with_context(|| format!("Failed to clone install gate {}", self.path.display()))?;
        command.stdin(Stdio::from(lease));
        Ok(())
    }

    #[cfg(test)]
    pub fn path(&self) -> &Path {
        &self.path
    }
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

/// Resolves the per-user, per-install gate shared by every launcher namespace.
///
/// This deliberately ignores the app id, launch instance, and XDG state root:
/// those values isolate runtime state, but all namespaces still execute files
/// from the same installation and must pause while those files are replaced.
pub fn install_launch_gate_path(executable: &Path) -> Result<PathBuf> {
    let base_dirs = BaseDirs::new().context("Could not resolve the home directory")?;
    let executable = executable_identity_path(executable);
    let digest = Sha256::digest(executable.as_os_str().as_encoded_bytes());
    let mut install_key = String::with_capacity(digest.len() * 2);
    for byte in digest {
        write!(&mut install_key, "{byte:02x}").expect("writing to a String cannot fail");
    }
    Ok(base_dirs
        .home_dir()
        .join(INSTALL_LAUNCH_GATE_DIR)
        .join(format!("{install_key}.lock")))
}

fn open_install_launch_gate(executable: &Path) -> Result<(fs::File, PathBuf)> {
    let lock_path = install_launch_gate_path(executable)?;
    let gate_dir = lock_path
        .parent()
        .context("Install launch gate path has no parent")?;
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(gate_dir)
        .with_context(|| format!("Failed to create {}", gate_dir.display()))?;
    let directory_metadata = fs::symlink_metadata(gate_dir)
        .with_context(|| format!("Failed to inspect {}", gate_dir.display()))?;
    anyhow::ensure!(
        directory_metadata.is_dir() && directory_metadata.uid() == unsafe { libc::geteuid() },
        "Install launch gate directory {} is not a user-owned directory",
        gate_dir.display()
    );
    if directory_metadata.permissions().mode() & 0o077 != 0 {
        fs::set_permissions(gate_dir, fs::Permissions::from_mode(0o700))
            .with_context(|| format!("Failed to secure {}", gate_dir.display()))?;
    }

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
        "Install launch gate {} is not a user-owned regular file",
        lock_path.display()
    );
    if metadata.permissions().mode() & 0o077 != 0 {
        file.set_permissions(fs::Permissions::from_mode(0o600))
            .with_context(|| format!("Failed to secure {}", lock_path.display()))?;
    }
    Ok((file, lock_path))
}

/// Creates and validates the gate so a terminal `flock` command can safely
/// serialize a manual native-package install.
pub fn prepare_install_launch_gate(executable: &Path) -> Result<PathBuf> {
    let (_file, path) = open_install_launch_gate(executable)?;
    Ok(path)
}

/// Tries to acquire the same install-wide gate held by every launcher until
/// Electron is spawned and its PID is published. `None` means another launch
/// or native package transaction currently owns the gate.
pub fn try_acquire_install_launch_gate(executable: &Path) -> Result<Option<InstallLaunchGate>> {
    let (file, lock_path) = open_install_launch_gate(executable)?;

    match file.try_lock() {
        Ok(()) => Ok(Some(InstallLaunchGate {
            file,
            path: lock_path,
        })),
        Err(fs::TryLockError::WouldBlock) => Ok(None),
        Err(fs::TryLockError::Error(error)) => {
            Err(error).with_context(|| format!("Failed to lock {}", lock_path.display()))
        }
    }
}

/// Waits a bounded interval for the shared install gate. Launchers use their
/// own shorter user-facing timeout; update flows wait a little longer so a
/// launch already in its spawn critical section can finish cleanly.
pub async fn acquire_install_launch_gate(executable: &Path) -> Result<Option<InstallLaunchGate>> {
    let deadline = Instant::now() + INSTALL_LAUNCH_GATE_WAIT;
    loop {
        if let Some(gate) = try_acquire_install_launch_gate(executable)? {
            return Ok(Some(gate));
        }
        if Instant::now() >= deadline {
            return Ok(None);
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
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

    fn wait_for_install_launch_gate(executable: &Path) -> Result<InstallLaunchGate> {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            if let Some(gate) = try_acquire_install_launch_gate(executable)? {
                return Ok(gate);
            }
            anyhow::ensure!(
                std::time::Instant::now() < deadline,
                "timed out waiting for install gate release"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }

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
    fn install_gate_serializes_with_other_holders() -> Result<()> {
        let _env_guard = env_lock();
        let temp = tempfile::tempdir()?;
        let _restore_env = EnvRestoreGuard::capture(&[
            "HOME",
            "XDG_STATE_HOME",
            "CODEX_LINUX_APP_ID",
            "CODEX_APP_ID",
            "CODEX_LINUX_INSTANCE_ID",
        ]);
        std::env::set_var("HOME", temp.path().join("home"));
        std::env::set_var("XDG_STATE_HOME", temp.path());
        std::env::set_var("CODEX_LINUX_APP_ID", "codex-lock-test");
        std::env::remove_var("CODEX_APP_ID");
        std::env::remove_var("CODEX_LINUX_INSTANCE_ID");

        let executable = Path::new("/opt/codex-desktop/electron");
        let first =
            try_acquire_install_launch_gate(executable)?.expect("first lock should succeed");
        assert!(try_acquire_install_launch_gate(executable)?.is_none());
        drop(first);
        let _reacquired = wait_for_install_launch_gate(executable)?;
        Ok(())
    }

    #[test]
    fn install_gate_is_shared_across_launcher_namespaces() -> Result<()> {
        let _env_guard = env_lock();
        let temp = tempfile::tempdir()?;
        let _restore_env = EnvRestoreGuard::capture(&[
            "HOME",
            "XDG_STATE_HOME",
            "CODEX_LINUX_APP_ID",
            "CODEX_APP_ID",
            "CODEX_LINUX_INSTANCE_ID",
        ]);
        std::env::set_var("HOME", temp.path().join("home"));
        std::env::set_var("XDG_STATE_HOME", temp.path().join("state-a"));
        std::env::set_var("CODEX_LINUX_APP_ID", "codex-primary");
        std::env::remove_var("CODEX_APP_ID");
        std::env::remove_var("CODEX_LINUX_INSTANCE_ID");

        let executable = Path::new("/opt/codex-desktop/electron");
        let primary = try_acquire_install_launch_gate(executable)?
            .expect("primary namespace should acquire the gate");
        let primary_path = primary.path().to_path_buf();

        std::env::set_var("XDG_STATE_HOME", temp.path().join("state-b"));
        std::env::set_var("CODEX_LINUX_APP_ID", "codex-alternate");
        std::env::set_var("CODEX_LINUX_INSTANCE_ID", "port-6176");
        assert_eq!(install_launch_gate_path(executable)?, primary_path);
        assert!(try_acquire_install_launch_gate(executable)?.is_none());
        drop(primary);
        let _reacquired = wait_for_install_launch_gate(executable)?;
        Ok(())
    }

    #[test]
    fn install_gate_interoperates_with_the_shell_flock_helper() -> Result<()> {
        let _env_guard = env_lock();
        let temp = tempfile::tempdir()?;
        let _restore_env = EnvRestoreGuard::capture(&["HOME"]);
        std::env::set_var("HOME", temp.path().join("home"));

        let executable = Path::new("/opt/codex-desktop/electron");
        let lock_path = install_launch_gate_path(executable)?;
        fs::create_dir_all(lock_path.parent().expect("install gate has a parent"))?;
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

        assert!(try_acquire_install_launch_gate(executable)?.is_none());
        drop(holder.stdin.take());
        assert!(holder.wait()?.success());
        let _reacquired = wait_for_install_launch_gate(executable)?;
        Ok(())
    }

    #[test]
    fn inherited_gate_lease_survives_the_original_holder_through_transaction() -> Result<()> {
        let _env_guard = env_lock();
        let temp = tempfile::tempdir()?;
        let _restore_env = EnvRestoreGuard::capture(&["HOME"]);
        std::env::set_var("HOME", temp.path().join("home"));
        let executable = Path::new("/opt/codex-desktop/electron");
        let gate = try_acquire_install_launch_gate(executable)?
            .expect("transaction should acquire the gate");
        let started = temp.path().join("package-replacement.started");
        let release = temp.path().join("package-replacement.release");

        let mut transaction_command = Command::new("sh");
        transaction_command
            .arg("-c")
            .arg("touch \"$1\"; while [ ! -e \"$2\" ]; do sleep 0.01; done")
            .arg("sh")
            .arg(&started)
            .arg(&release);
        gate.inherit_through_stdin(&mut transaction_command)?;
        let mut transaction = transaction_command.spawn()?;
        // `Command` is reusable and retains its configured stdin. Drop that
        // original duplicate so only the package transaction owns the lease.
        drop(transaction_command);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !started.exists() {
            anyhow::ensure!(
                std::time::Instant::now() < deadline,
                "timed out waiting for package replacement"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }

        drop(gate);
        assert!(
            try_acquire_install_launch_gate(executable)?.is_none(),
            "the package transaction must retain the inherited lease after the updater exits"
        );
        fs::write(&release, b"continue")?;
        assert!(transaction.wait()?.success());
        let _reacquired = wait_for_install_launch_gate(executable)?;
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
