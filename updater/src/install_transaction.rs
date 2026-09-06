//! Durable ownership for package-replacing updater transactions.

use crate::state::{
    InstallOperation, InstallTransaction, PersistedState, ProcessIdentity, UpdateStatus,
};
use anyhow::{Context, Result};
use chrono::Utc;
use sha2::{Digest, Sha256};
use std::{
    ffi::OsString,
    fs,
    io::Write,
    path::Path,
    process::{Command, Output, Stdio},
    time::Duration,
};

pub(crate) const ABANDONED_INSTALL_GRACE: Duration = Duration::from_secs(300);

const GATED_EXEC_SCRIPT: &str = r#"
IFS= read -r state || exit 125
[ "$state" = "go" ] || exit 125
exec "$@"
"#;

pub(crate) fn begin(
    state: &mut PersistedState,
    state_file: &Path,
    package_path: &Path,
    operation: InstallOperation,
) -> Result<()> {
    let owner = process_identity(std::process::id())
        .context("Failed to record updater transaction ownership")?;
    let package_sha256 = package_sha256(package_path)
        .with_context(|| format!("Failed to hash install package {}", package_path.display()))?;
    state.status = UpdateStatus::Installing;
    state.error_message = None;
    state.install_transaction = Some(InstallTransaction {
        package_path: package_path.to_path_buf(),
        package_sha256: Some(package_sha256),
        package_command: Some(owner),
        started_at: Utc::now(),
        operation,
    });
    state.save_updater(state_file)
}

pub(crate) fn run_owned_command(
    command: &mut Command,
    state: &mut PersistedState,
    state_file: &Path,
) -> Result<Output> {
    // Spawn only a non-mutating launcher first. Its PID is the PID that will
    // become pkexec via exec(2), so we can durably publish that exact process
    // identity before permitting package mutation.
    //
    // The launch token travels over stdin. If this updater dies before the
    // durable owner save and token write, the pipe closes and the launcher
    // exits without ever exec'ing pkexec. This removes the spawn-before-owner
    // crash window without a polling timeout or persistent gate file.
    let mut launcher = gated_command(command);
    launcher
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = launcher
        .spawn()
        .context("Failed to launch gated privileged package command")?;

    let identity = match process_identity(child.id()) {
        Ok(identity) => identity,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error.context("Failed to identify privileged package-command owner"));
        }
    };
    let Some(transaction) = state.install_transaction.as_mut() else {
        let _ = child.kill();
        let _ = child.wait();
        anyhow::bail!("Package command started without a durable install transaction");
    };
    transaction.package_command = Some(identity);
    if let Err(error) = state
        .save_updater(state_file)
        .context("Failed to persist package-command ownership")
    {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }

    let release_result = child
        .stdin
        .take()
        .context("Privileged package-command launcher has no stdin gate")
        .and_then(|mut stdin| {
            stdin
                .write_all(b"go\n")
                .context("Failed to release privileged package-command launch gate")
        });
    if let Err(error) = release_result {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }

    child
        .wait_with_output()
        .context("Failed while waiting for privileged package command")
}

fn gated_command(command: &Command) -> Command {
    let program = command.get_program().to_os_string();
    let args = command
        .get_args()
        .map(OsString::from)
        .collect::<Vec<OsString>>();

    let mut launcher = Command::new("/bin/sh");
    launcher
        .arg("-c")
        .arg(GATED_EXEC_SCRIPT)
        .arg("codex-update-launcher")
        .arg(program)
        .args(args);

    for (key, value) in command.get_envs() {
        match value {
            Some(value) => {
                launcher.env(key, value);
            }
            None => {
                launcher.env_remove(key);
            }
        }
    }
    if let Some(dir) = command.get_current_dir() {
        launcher.current_dir(dir);
    }

    launcher
}

pub(crate) fn is_active(transaction: &InstallTransaction) -> bool {
    transaction
        .package_command
        .as_ref()
        .is_some_and(identity_is_alive)
}

pub(crate) fn grace_expired(transaction: &InstallTransaction) -> bool {
    (Utc::now() - transaction.started_at)
        .to_std()
        .map(|elapsed| elapsed >= ABANDONED_INSTALL_GRACE)
        .unwrap_or(false)
}

pub(crate) fn package_sha256(path: &Path) -> Result<String> {
    let bytes = fs::read(path).with_context(|| format!("Failed to read {}", path.display()))?;
    Ok(Sha256::digest(&bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

fn process_identity(pid: u32) -> Result<ProcessIdentity> {
    let stat_path = Path::new("/proc").join(pid.to_string()).join("stat");
    let stat = fs::read_to_string(&stat_path)
        .with_context(|| format!("Failed to read {}", stat_path.display()))?;
    let close_paren = stat
        .rfind(')')
        .context("Malformed /proc stat: missing process-name terminator")?;
    let fields = stat[close_paren + 1..]
        .split_whitespace()
        .collect::<Vec<_>>();
    let start_time_ticks = fields
        .get(19)
        .context("Malformed /proc stat: missing process start time")?
        .parse::<u64>()
        .context("Malformed /proc stat process start time")?;
    Ok(ProcessIdentity {
        pid,
        start_time_ticks,
    })
}

#[cfg(test)]
pub(crate) fn test_current_process_identity() -> Result<ProcessIdentity> {
    process_identity(std::process::id())
}

fn identity_is_alive(identity: &ProcessIdentity) -> bool {
    process_identity(identity.pid)
        .map(|current| current.start_time_ticks == identity.start_time_ticks)
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn process_identity_is_pid_reuse_safe() -> Result<()> {
        let current = process_identity(std::process::id())?;
        assert!(identity_is_alive(&current));

        let stale = ProcessIdentity {
            pid: current.pid,
            start_time_ticks: current.start_time_ticks.wrapping_add(1),
        };
        assert!(!identity_is_alive(&stale));
        Ok(())
    }

    #[test]
    fn stale_owner_does_not_keep_install_blocked() -> Result<()> {
        let current = process_identity(std::process::id())?;
        let stale = ProcessIdentity {
            pid: current.pid,
            start_time_ticks: current.start_time_ticks.wrapping_add(1),
        };
        let tx = InstallTransaction {
            package_path: PathBuf::from("/tmp/codex.deb"),
            package_sha256: Some("fixture".into()),
            package_command: Some(stale),
            started_at: Utc::now()
                - chrono::Duration::seconds(ABANDONED_INSTALL_GRACE.as_secs() as i64 + 1),
            operation: InstallOperation::Update,
        };
        assert!(!is_active(&tx));
        assert!(grace_expired(&tx));
        Ok(())
    }
    #[test]
    fn gated_launcher_requires_explicit_release_before_exec() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let marker = dir.path().join("started");

        let mut command = Command::new("/bin/sh");
        command
            .arg("-c")
            .arg("printf started > \"$1\"")
            .arg("fixture")
            .arg(&marker);

        let mut launcher = gated_command(&command);
        launcher
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let mut child = launcher.spawn()?;

        std::thread::sleep(Duration::from_millis(100));
        assert!(
            !marker.exists(),
            "privileged command executed before launch gate release"
        );

        child
            .stdin
            .take()
            .context("fixture launcher has no stdin gate")?
            .write_all(b"go\n")?;
        let status = child.wait()?;
        assert!(status.success());
        assert!(marker.is_file());
        Ok(())
    }

    #[test]
    fn gated_launcher_eof_exits_without_exec() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let marker = dir.path().join("started");

        let mut command = Command::new("/bin/sh");
        command
            .arg("-c")
            .arg("printf started > \"$1\"")
            .arg("fixture")
            .arg(&marker);

        let mut launcher = gated_command(&command);
        launcher
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let mut child = launcher.spawn()?;
        drop(child.stdin.take());

        let status = child.wait()?;
        assert_eq!(status.code(), Some(125));
        assert!(
            !marker.exists(),
            "EOF before durable owner publication must not execute package command"
        );
        Ok(())
    }
}
