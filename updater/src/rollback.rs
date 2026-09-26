//! Manual rollback to the immediately previous retained native package.

use crate::{
    config::{RuntimeConfig, RuntimePaths},
    install, install_rollback, install_transaction, liveness,
    state::{InstallOperation, PersistedState, UpdateStatus},
};
use anyhow::{Context, Result};
use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

/// Keep a rollback package alive when a rebuild is about to remove its old
/// candidate workspace. This is primarily needed for recovered legacy
/// transactions, whose package path can still be inside that workspace.
pub fn preserve_before_workspace_cleanup(
    state: &mut PersistedState,
    paths: &RuntimePaths,
    workspace: &Path,
) -> Result<()> {
    let Some(source) = state.artifact_paths.rollback_package_path.clone() else {
        return Ok(());
    };
    if !source.starts_with(workspace) || !source.is_file() {
        return Ok(());
    }

    let package_dir = paths.cache_dir.join("packages");
    fs::create_dir_all(&package_dir).with_context(|| {
        format!(
            "Failed to create rollback package cache {}",
            package_dir.display()
        )
    })?;
    let file_name = source
        .file_name()
        .context("rollback package path has no file name")?;
    let destination = package_dir.join(file_name);
    anyhow::ensure!(
        destination != source,
        "rollback package destination is still inside the candidate workspace"
    );

    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let staging = package_dir.join(format!(
        ".rollback-{}-{nonce}-{}.tmp",
        std::process::id(),
        file_name.to_string_lossy()
    ));
    fs::copy(&source, &staging).with_context(|| {
        format!(
            "Failed to copy rollback package {} before workspace cleanup",
            source.display()
        )
    })?;
    fs::File::open(&staging)
        .and_then(|file| file.sync_all())
        .with_context(|| {
            format!(
                "Failed to sync rollback package staging {}",
                staging.display()
            )
        })?;
    if let Err(error) = fs::rename(&staging, &destination) {
        let _ = fs::remove_file(&staging);
        return Err(error).with_context(|| {
            format!(
                "Failed to publish rollback package {}",
                destination.display()
            )
        });
    }
    fs::File::open(&package_dir)
        .and_then(|directory| directory.sync_all())
        .with_context(|| {
            format!(
                "Failed to sync rollback package cache directory {}",
                package_dir.display()
            )
        })?;

    state.artifact_paths.rollback_package_path = Some(destination.clone());
    // The state journal must point at the durable copy before the old
    // workspace is allowed to disappear.
    state.save_updater(&paths.state_file)?;
    fs::remove_file(&source).with_context(|| {
        format!(
            "Failed to remove the old rollback package {} after preservation",
            source.display()
        )
    })?;
    Ok(())
}

pub fn record_current_package_as_known_good(state: &mut PersistedState) {
    if state.installed_version == "unknown" || state.candidate_version.is_some() {
        return;
    }
    if let Some(path) = state
        .artifact_paths
        .package_path
        .clone()
        .filter(|path| path.is_file())
    {
        state.last_known_good_version = Some(state.installed_version.clone());
        state.last_known_good_upstream_version = state.installed_upstream_version.clone();
        state.last_known_good_upstream_sha256 = state.installed_upstream_sha256.clone();
        state.artifact_paths.rollback_package_path = Some(path);
    }
}

fn rejected_upstream_identity(state: &PersistedState) -> (Option<String>, Option<String>) {
    if let (Some(version), Some(sha256)) = (
        state.candidate_version.clone(),
        state.upstream_package_sha256.clone(),
    ) {
        return (Some(version), Some(sha256));
    }

    let installed = state
        .installed_upstream_version
        .clone()
        .zip(state.installed_upstream_sha256.clone());
    let installed_is_known_good = installed.as_ref().is_some_and(|(version, sha256)| {
        state.last_known_good_upstream_version.as_deref() == Some(version.as_str())
            && state.last_known_good_upstream_sha256.as_deref() == Some(sha256.as_str())
    });
    if !installed_is_known_good {
        if let Some((version, sha256)) = installed {
            return (Some(version), Some(sha256));
        }
    }

    if let (Some(version), Some(sha256)) = (
        state.rollback_blocked_candidate_version.clone(),
        state.rollback_blocked_package_sha256.clone(),
    ) {
        return (Some(version), Some(sha256));
    }

    match installed {
        Some((version, sha256)) => (Some(version), Some(sha256)),
        None => (None, None),
    }
}

pub(crate) fn apply_successful_rollback(
    state: &mut PersistedState,
    package: PathBuf,
    installed_version: String,
) {
    let (blocked_version, blocked_sha) = rejected_upstream_identity(state);
    state.installed_version = installed_version;
    state.installed_upstream_version = state.last_known_good_upstream_version.clone();
    state.installed_upstream_sha256 = state.last_known_good_upstream_sha256.clone();
    state.candidate_version = None;
    state.rollback_blocked_candidate_version = blocked_version;
    state.rollback_blocked_package_sha256 = blocked_sha;
    state.artifact_paths.package_path = Some(package.clone());
    state.artifact_paths.package_candidate_sha256 = None;
    state.artifact_paths.rollback_package_path = Some(package);
    state.last_known_good_version = Some(state.installed_version.clone());
}

pub async fn run(
    config: &RuntimeConfig,
    state: &mut PersistedState,
    paths: &RuntimePaths,
) -> Result<()> {
    run_with_launcher(config, state, paths, Path::new("/bin/sh")).await
}

async fn run_with_launcher(
    config: &RuntimeConfig,
    state: &mut PersistedState,
    paths: &RuntimePaths,
    launcher_program: &Path,
) -> Result<()> {
    if liveness::is_app_running(config)? {
        println!("ChatGPT Community is running. Close it before rollback.");
        return Ok(());
    }
    let package = match state.artifact_paths.rollback_package_path.clone() {
        Some(path) if path.is_file() => path,
        _ => {
            println!("No rollback package is available.");
            return Ok(());
        }
    };
    // The explicit rollback command confirms that the user has checked for an
    // orphaned package manager after any ambiguous interrupted transaction.
    state.manual_recovery_required = false;
    install_transaction::begin(
        state,
        &paths.state_file,
        &package,
        InstallOperation::Rollback,
    )?;
    let mut command = install_rollback::pkexec_command(&std::env::current_exe()?, &package);
    let output = match install_transaction::run_owned_command_with_launcher(
        &mut command,
        state,
        &paths.state_file,
        launcher_program,
    ) {
        Ok(output) => output,
        Err(failure) if !failure.mutation_may_have_started => {
            let message = format!("Failed to launch privileged rollback: {:#}", failure.error);
            state.mark_failed(&message);
            state.save_updater(&paths.state_file)?;
            anyhow::bail!(message);
        }
        Err(failure) => {
            return Err(failure
                .error
                .context("Privileged rollback outcome is unknown"));
        }
    };
    if !output.status.success() {
        if matches!(output.status.code(), Some(126 | 127)) {
            // pkexec uses 126/127 when authorization was dismissed or could
            // not be obtained. No package mutation was released, so clear the
            // transaction and leave the candidate retryable instead of making
            // recovery wait for the abandoned-transaction grace period.
            let mut message = format!("privileged rollback exited with status {}", output.status);
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stderr = stderr.trim();
            if !stderr.is_empty() {
                message.push_str(": ");
                message.push_str(stderr);
            }
            state.mark_failed(&message);
            state.save_updater(&paths.state_file)?;
            anyhow::bail!(message);
        }
        // Once the gated command has been released, a nonzero package-manager
        // exit is not evidence that rollback made no changes. Preserve the
        // durable transaction so the same recovery path can reconcile it.
        anyhow::bail!(
            "privileged rollback exited unsuccessfully after package mutation may have started: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    state.status = UpdateStatus::Installed;
    state.install_transaction = None;
    apply_successful_rollback(state, package, install::installed_package_version());
    state.error_message = None;
    state.save_updater(&paths.state_file)?;
    println!("Rolled back codex-desktop to {}.", state.installed_version);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, os::unix::fs::PermissionsExt};

    #[test]
    fn current_package_becomes_the_single_rollback_artifact() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let package = dir.path().join("codex.deb");
        std::fs::write(&package, b"package")?;
        let mut state = PersistedState::new(true);
        state.installed_version = "26.1".into();
        state.artifact_paths.package_path = Some(package.clone());
        record_current_package_as_known_good(&mut state);
        assert_eq!(state.artifact_paths.rollback_package_path, Some(package));
        Ok(())
    }

    #[test]
    fn recovered_workspace_package_survives_candidate_workspace_cleanup() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let paths = RuntimePaths {
            config_file: dir.path().join("config/config.toml"),
            state_file: dir.path().join("state/state.json"),
            log_file: dir.path().join("state/service.log"),
            cache_dir: dir.path().join("cache"),
            state_dir: dir.path().join("state"),
            config_dir: dir.path().join("config"),
        };
        paths.ensure_dirs()?;

        let workspace = dir.path().join("workspaces/2026.09.10.120000");
        let source = workspace.join("dist/codex-desktop-2026.09.10.120000.deb");
        fs::create_dir_all(source.parent().expect("package parent"))?;
        fs::write(&source, b"recovered legacy package")?;

        let mut state = PersistedState::new(true);
        state.schema_version = 3;
        state.installed_version = "26.1".into();
        state.artifact_paths.rollback_package_path = Some(source.clone());
        state.save_updater(&paths.state_file)?;

        preserve_before_workspace_cleanup(&mut state, &paths, &workspace)?;
        let retained = state
            .artifact_paths
            .rollback_package_path
            .clone()
            .expect("preserved rollback package");
        assert!(!retained.starts_with(&workspace));
        assert!(retained.starts_with(paths.cache_dir.join("packages")));
        assert!(!source.exists());
        assert_eq!(fs::read(&retained)?, b"recovered legacy package");

        // This is the cleanup performed by the next same-candidate rebuild.
        fs::remove_dir_all(&workspace)?;
        assert!(retained.is_file());
        let persisted = PersistedState::load_or_default(&paths.state_file, true)?;
        assert_eq!(
            persisted.artifact_paths.rollback_package_path,
            Some(retained)
        );
        Ok(())
    }

    #[tokio::test]
    async fn nonzero_exit_after_gate_release_preserves_rollback_recovery_evidence() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let paths = RuntimePaths {
            config_file: dir.path().join("config/config.toml"),
            state_file: dir.path().join("state/state.json"),
            log_file: dir.path().join("state/service.log"),
            cache_dir: dir.path().join("cache"),
            state_dir: dir.path().join("state"),
            config_dir: dir.path().join("config"),
        };
        paths.ensure_dirs()?;
        let mut config = RuntimeConfig::default_with_paths(&paths);
        config.app_executable_path = dir.path().join("app-not-running");

        let package = dir.path().join("known-good.deb");
        fs::write(&package, b"fixture package")?;
        let launcher = dir.path().join("released-then-fails");
        fs::write(
            &launcher,
            "#!/bin/sh\nIFS= read -r state || exit 125\n[ \"$state\" = go ] || exit 125\nexit 42\n",
        )?;
        fs::set_permissions(&launcher, fs::Permissions::from_mode(0o755))?;

        let mut state = PersistedState::new(true);
        state.status = UpdateStatus::Installed;
        state.installed_version = "bad-local".into();
        state.artifact_paths.rollback_package_path = Some(package);
        state.save_updater(&paths.state_file)?;

        let result = run_with_launcher(&config, &mut state, &paths, &launcher).await;
        assert!(
            result.is_err(),
            "forced post-release rollback failure must surface"
        );

        let persisted =
            PersistedState::load_or_default(&paths.state_file, config.auto_install_on_app_exit)?;
        assert_eq!(persisted.status, UpdateStatus::Installing);
        assert!(
            persisted.install_transaction.is_some(),
            "post-release rollback failure must preserve durable recovery evidence"
        );
        Ok(())
    }

    #[tokio::test]
    async fn authentication_cancelled_rollback_is_retryable() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let paths = RuntimePaths {
            config_file: dir.path().join("config/config.toml"),
            state_file: dir.path().join("state/state.json"),
            log_file: dir.path().join("state/service.log"),
            cache_dir: dir.path().join("cache"),
            state_dir: dir.path().join("state"),
            config_dir: dir.path().join("config"),
        };
        paths.ensure_dirs()?;
        let mut config = RuntimeConfig::default_with_paths(&paths);
        config.app_executable_path = dir.path().join("app-not-running");

        let package = dir.path().join("known-good.deb");
        fs::write(&package, b"fixture package")?;

        for code in [126, 127] {
            let launcher = dir.path().join(format!("cancelled-rollback-{code}"));
            fs::write(
                &launcher,
                format!(
                    "#!/bin/sh\nIFS= read -r state || exit 125\n[ \"$state\" = go ] || exit 125\nexit {code}\n"
                ),
            )?;
            fs::set_permissions(&launcher, fs::Permissions::from_mode(0o755))?;

            let mut state = PersistedState::new(true);
            state.status = UpdateStatus::Installed;
            state.installed_version = "bad-local".into();
            state.artifact_paths.rollback_package_path = Some(package.clone());
            state.save_updater(&paths.state_file)?;

            let error = run_with_launcher(&config, &mut state, &paths, &launcher)
                .await
                .expect_err("authentication cancellation should be reported");
            assert!(error
                .to_string()
                .contains(&format!("status exit status: {code}")));

            let persisted = PersistedState::load_or_default(
                &paths.state_file,
                config.auto_install_on_app_exit,
            )?;
            assert_eq!(persisted.status, UpdateStatus::Failed);
            assert!(persisted.install_transaction.is_none());
            assert!(!persisted.manual_recovery_required);
            assert!(persisted
                .error_message
                .as_deref()
                .is_some_and(|message| message.contains("privileged rollback exited")));
        }
        Ok(())
    }
}
