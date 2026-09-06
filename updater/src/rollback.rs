//! Manual rollback to the immediately previous retained native package.

use crate::{
    config::{RuntimeConfig, RuntimePaths},
    install, install_rollback, install_transaction, liveness,
    state::{InstallOperation, PersistedState, UpdateStatus},
};
use anyhow::{Context, Result};

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
    let output = install_transaction::run_owned_command(&mut command, state, &paths.state_file)
        .context("Failed to launch privileged rollback")?;
    if !output.status.success() {
        let message = format!(
            "rollback failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
        state.mark_failed(&message);
        state.save_updater(&paths.state_file)?;
        anyhow::bail!(message);
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
}
