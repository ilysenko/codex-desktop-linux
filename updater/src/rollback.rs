//! Manual rollback to the immediately previous retained native package.

use crate::{
    config::{RuntimeConfig, RuntimePaths},
    install, install_rollback, install_transaction, liveness,
    state::{InstallOperation, PersistedState, UpdateStatus},
};
use anyhow::Result;
use std::path::Path;

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
    let blocked_version = state
        .candidate_version
        .clone()
        .or_else(|| Some(state.installed_version.clone()));
    let blocked_sha = state.upstream_package_sha256.clone();
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
    state.installed_version = install::installed_package_version();
    state.installed_upstream_version = state.last_known_good_upstream_version.clone();
    state.installed_upstream_sha256 = state.last_known_good_upstream_sha256.clone();
    state.candidate_version = None;
    state.rollback_blocked_candidate_version = blocked_version;
    state.rollback_blocked_package_sha256 = blocked_sha;
    state.artifact_paths.package_path = Some(package.clone());
    state.artifact_paths.rollback_package_path = Some(package);
    state.last_known_good_version = Some(state.installed_version.clone());
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
        assert!(result.is_err(), "forced post-release rollback failure must surface");

        let persisted =
            PersistedState::load_or_default(&paths.state_file, config.auto_install_on_app_exit)?;
        assert_eq!(persisted.status, UpdateStatus::Installing);
        assert!(
            persisted.install_transaction.is_some(),
            "post-release rollback failure must preserve durable recovery evidence"
        );
        Ok(())
    }
}
