//! Manual rollback support for the local update manager.

use crate::{
    cache_cleanup,
    config::{RuntimeConfig, RuntimePaths},
    install, install_rollback, liveness, notify,
    state::{PersistedState, UpdateStatus},
};
use anyhow::{Context, Result};
use std::path::Path;
use tracing::error;

/// Retains the currently installed package as the rollback target, when known.
pub fn record_current_package_as_known_good(state: &mut PersistedState) {
    if state.installed_version == "unknown" {
        return;
    }

    if state.candidate_version.is_some() {
        return;
    }

    let Some(package_path) = state.artifact_paths.package_path.as_ref() else {
        return;
    };

    if !package_path.exists() {
        return;
    }

    state.last_known_good_version = Some(state.installed_version.clone());
    state.artifact_paths.rollback_package_path = Some(package_path.clone());
}

/// Runs a user-requested rollback to the last retained known-good package.
pub async fn run(
    config: &RuntimeConfig,
    state: &mut PersistedState,
    paths: &RuntimePaths,
) -> Result<()> {
    if liveness::is_app_running(config)? {
        println!("ChatGPT Desktop is running. Close it before rollback.");
        return Ok(());
    }

    let Some(package_path) = state.artifact_paths.rollback_package_path.clone() else {
        println!("No rollback package is available.");
        return Ok(());
    };

    if !package_path.exists() {
        state.mark_failed(format!(
            "Rollback package is missing: {}",
            package_path.display()
        ));
        state.save_updater(&paths.state_file)?;
        println!("Rollback package is missing: {}", package_path.display());
        return Ok(());
    }

    trigger_rollback(config, state, paths, &package_path).await
}

async fn trigger_rollback(
    config: &RuntimeConfig,
    state: &mut PersistedState,
    paths: &RuntimePaths,
    package_path: &Path,
) -> Result<()> {
    let (blocked_candidate, blocked_dmg_sha256) = rollback_block_identifiers(state);

    state.status = UpdateStatus::Installing;
    state.error_message = None;
    state.save_updater(&paths.state_file)?;

    let _ = notify::send(
        "Rolling back ChatGPT Desktop",
        "Installing the last retained known-good package.",
    );

    let current_exe = std::env::current_exe().context("Failed to resolve updater binary path")?;
    let output = install_rollback::pkexec_command(&current_exe, package_path)
        .output()
        .context("Failed to launch pkexec for rollback")?;
    let status = output.status;

    if status.success() {
        apply_successful_rollback_state(
            state,
            install::installed_package_version(),
            package_path,
            blocked_candidate,
            blocked_dmg_sha256,
        );
        state.save_updater(&paths.state_file)?;
        let _ = cache_cleanup::prune_unreferenced_workspaces(&config.workspace_root, state);
        println!(
            "Rolled back ChatGPT Desktop to {}.",
            state.installed_version
        );
        return Ok(());
    }

    let stdout = summarize_command_output(&output.stdout);
    let stderr = summarize_command_output(&output.stderr);
    error!(
        status = %status,
        stdout = stdout.as_deref().unwrap_or(""),
        stderr = stderr.as_deref().unwrap_or(""),
        "privileged rollback failed"
    );

    let mut message = format!("Privileged rollback exited with status {status}");
    if let Some(stderr) = stderr {
        message.push_str(": ");
        message.push_str(&stderr);
    }

    state.mark_failed(message.clone());
    state.save_updater(&paths.state_file)?;
    let _ = notify::send(
        "ChatGPT Desktop rollback failed",
        "The previous package could not be installed. Check the updater log for details.",
    );
    Err(anyhow::anyhow!(message))
}

fn rollback_block_identifiers(state: &PersistedState) -> (Option<String>, Option<String>) {
    let blocked_candidate = if state.installed_version == "unknown" {
        state.candidate_version.clone()
    } else {
        Some(state.installed_version.clone())
    };
    (blocked_candidate, state.dmg_sha256.clone())
}

fn summarize_command_output(output: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(output).trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

fn apply_successful_rollback_state(
    state: &mut PersistedState,
    installed_version: String,
    package_path: &Path,
    blocked_candidate: Option<String>,
    blocked_dmg_sha256: Option<String>,
) {
    state.status = UpdateStatus::Installed;
    state.installed_version = installed_version.clone();
    state.candidate_version = None;
    state.artifact_paths.package_path = Some(package_path.to_path_buf());
    state.artifact_paths.rollback_package_path = Some(package_path.to_path_buf());
    state.last_known_good_version = Some(installed_version);
    state.rollback_blocked_candidate_version = blocked_candidate;
    state.rollback_blocked_dmg_sha256 = blocked_dmg_sha256;
    state.error_message = None;
    state.notified_events.clear();
    cache_cleanup::normalize_artifact_workspace_dir(Path::new(""), state);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{ArtifactPaths, PersistedState};
    use anyhow::Result;

    #[test]
    fn records_existing_current_package_as_known_good() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let package_path = temp.path().join("codex.deb");
        std::fs::write(&package_path, b"deb")?;

        let mut state = PersistedState::new(true);
        state.installed_version = "2026.04.20.120000".to_string();
        state.artifact_paths = ArtifactPaths {
            dmg_path: None,
            workspace_dir: None,
            package_path: Some(package_path.clone()),
            rollback_package_path: None,
        };

        record_current_package_as_known_good(&mut state);

        assert_eq!(
            state.last_known_good_version.as_deref(),
            Some("2026.04.20.120000")
        );
        assert_eq!(
            state.artifact_paths.rollback_package_path,
            Some(package_path)
        );
        Ok(())
    }

    #[test]
    fn ignores_missing_current_package() {
        let mut state = PersistedState::new(true);
        state.installed_version = "2026.04.20.120000".to_string();
        state.artifact_paths.package_path = Some(std::path::PathBuf::from("/missing/codex.deb"));

        record_current_package_as_known_good(&mut state);

        assert_eq!(state.last_known_good_version, None);
        assert_eq!(state.artifact_paths.rollback_package_path, None);
    }

    #[test]
    fn ignores_pending_candidate_package() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let package_path = temp.path().join("candidate.deb");
        std::fs::write(&package_path, b"deb")?;

        let mut state = PersistedState::new(true);
        state.installed_version = "2026.04.20.120000".to_string();
        state.candidate_version = Some("2026.04.21.120000+badcafe0".to_string());
        state.artifact_paths.package_path = Some(package_path);

        record_current_package_as_known_good(&mut state);

        assert_eq!(state.last_known_good_version, None);
        assert_eq!(state.artifact_paths.rollback_package_path, None);
        Ok(())
    }

    #[test]
    fn successful_rollback_repoints_package_paths_to_installed_package() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let update_path = temp.path().join("candidate.rpm");
        let rollback_path = temp.path().join("known-good.rpm");
        std::fs::write(&update_path, b"new")?;
        std::fs::write(&rollback_path, b"old")?;

        let mut state = PersistedState::new(true);
        state.installed_version = "2026.05.04.131500".to_string();
        state.candidate_version = Some("2026.05.04.131500+badcafe0".to_string());
        state.dmg_sha256 = Some("bad-dmg-sha256".to_string());
        state.status = UpdateStatus::Installing;
        state.artifact_paths = ArtifactPaths {
            dmg_path: None,
            workspace_dir: Some(temp.path().join("workspaces/2026.05.04.131500+badcafe0")),
            package_path: Some(update_path),
            rollback_package_path: Some(rollback_path.clone()),
        };

        apply_successful_rollback_state(
            &mut state,
            "2026.05.02.120000".to_string(),
            &rollback_path,
            Some("2026.05.04.131500".to_string()),
            Some("bad-dmg-sha256".to_string()),
        );

        assert_eq!(state.status, UpdateStatus::Installed);
        assert_eq!(state.candidate_version, None);
        assert_eq!(
            state.artifact_paths.package_path.as_deref(),
            Some(rollback_path.as_path())
        );
        assert_eq!(
            state.artifact_paths.rollback_package_path.as_deref(),
            Some(rollback_path.as_path())
        );
        assert_eq!(state.artifact_paths.workspace_dir, None);
        assert_eq!(
            state.last_known_good_version.as_deref(),
            Some("2026.05.02.120000")
        );
        assert_eq!(
            state.rollback_blocked_candidate_version.as_deref(),
            Some("2026.05.04.131500")
        );
        assert_eq!(
            state.rollback_blocked_dmg_sha256.as_deref(),
            Some("bad-dmg-sha256")
        );
        Ok(())
    }

    #[test]
    fn rollback_captures_current_dmg_hash_without_deriving_it_from_version() {
        let mut state = PersistedState::new(true);
        state.installed_version = "unknown".to_string();
        state.candidate_version = Some("2026.05.04.131500+badcafe0".to_string());
        state.dmg_sha256 = Some("full-recorded-dmg-sha256".to_string());

        let (blocked_version, blocked_sha256) = rollback_block_identifiers(&state);

        assert_eq!(
            blocked_version.as_deref(),
            Some("2026.05.04.131500+badcafe0")
        );
        assert_eq!(blocked_sha256.as_deref(), Some("full-recorded-dmg-sha256"));
    }
}
