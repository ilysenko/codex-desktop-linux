//! Durable updater state for official Linux packages.

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::{fs, os::unix::fs::PermissionsExt, path::{Path, PathBuf}};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum UpdateStatus {
    #[default]
    Idle,
    CheckingUpstream,
    UpdateDetected,
    DownloadingPackage,
    PreparingWorkspace,
    PatchingApp,
    BuildingPackage,
    ReadyToInstall,
    WaitingForAppExit,
    Installing,
    Installed,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(default)]
pub struct ArtifactPaths {
    pub upstream_package_path: Option<PathBuf>,
    pub workspace_dir: Option<PathBuf>,
    #[serde(alias = "deb_path")]
    pub package_path: Option<PathBuf>,
    pub rollback_package_path: Option<PathBuf>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct PersistedState {
    pub schema_version: u32,
    pub installed_version: String,
    pub installed_upstream_version: Option<String>,
    pub installed_upstream_sha256: Option<String>,
    pub candidate_version: Option<String>,
    pub candidate_architecture: Option<String>,
    pub candidate_repository_path: Option<String>,
    pub upstream_package_sha256: Option<String>,
    pub status: UpdateStatus,
    pub last_check_at: Option<DateTime<Utc>>,
    pub last_successful_check_at: Option<DateTime<Utc>>,
    pub artifact_paths: ArtifactPaths,
    pub error_message: Option<String>,
    pub auto_install_on_app_exit: bool,
    pub waiting_for_app_exit_auto_install: bool,
    pub last_known_good_version: Option<String>,
    pub last_known_good_upstream_version: Option<String>,
    pub last_known_good_upstream_sha256: Option<String>,
    pub rollback_blocked_candidate_version: Option<String>,
    pub rollback_blocked_package_sha256: Option<String>,
    pub install_auth_blocked_package_sha256: Option<String>,
    pub install_after_app_exit_requested: bool,
}

impl Default for PersistedState {
    fn default() -> Self {
        Self::new(true)
    }
}

impl PersistedState {
    pub fn new(auto_install_on_app_exit: bool) -> Self {
        Self {
            schema_version: 2,
            installed_version: "unknown".into(),
            installed_upstream_version: None,
            installed_upstream_sha256: None,
            candidate_version: None,
            candidate_architecture: None,
            candidate_repository_path: None,
            upstream_package_sha256: None,
            status: UpdateStatus::Idle,
            last_check_at: None,
            last_successful_check_at: None,
            artifact_paths: ArtifactPaths::default(),
            error_message: None,
            auto_install_on_app_exit,
            waiting_for_app_exit_auto_install: false,
            last_known_good_version: None,
            last_known_good_upstream_version: None,
            last_known_good_upstream_sha256: None,
            rollback_blocked_candidate_version: None,
            rollback_blocked_package_sha256: None,
            install_auth_blocked_package_sha256: None,
            install_after_app_exit_requested: false,
        }
    }

    pub fn load_or_default(path: &Path, auto_install: bool) -> Result<Self> {
        if !path.exists() {
            return Ok(Self::new(auto_install));
        }
        let text = fs::read_to_string(path)
            .with_context(|| format!("Failed to read {}", path.display()))?;
        let raw: serde_json::Value = serde_json::from_str(&text)
            .with_context(|| format!("Failed to parse {}", path.display()))?;

        // A schema-v1 candidate cannot be resumed safely. Preserve only the
        // installed/rollback facts and drop the pending candidate atomically on
        // the next save.
        if raw.get("schema_version").and_then(|v| v.as_u64()).unwrap_or(1) < 2 {
            let mut migrated = Self::new(auto_install);
            migrated.installed_version = raw
                .get("installed_version")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown")
                .to_string();
            migrated.last_known_good_version = raw
                .get("last_known_good_version")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            migrated.artifact_paths.rollback_package_path = raw
                .pointer("/artifact_paths/rollback_package_path")
                .and_then(|v| v.as_str())
                .map(PathBuf::from);
            return Ok(migrated);
        }

        let mut state: Self = serde_json::from_value(raw)?;
        state.schema_version = 2;
        state.auto_install_on_app_exit = auto_install;
        Ok(state)
    }

    pub fn save_updater(&self, path: &Path) -> Result<()> {
        let parent = path.parent().context("state path has no parent")?;
        fs::create_dir_all(parent)?;
        let temp = parent.join(format!(".state-{}.tmp", std::process::id()));
        fs::write(&temp, format!("{}\n", serde_json::to_string_pretty(self)?))?;
        fs::set_permissions(&temp, fs::Permissions::from_mode(0o600))?;
        fs::rename(&temp, path)?;
        Ok(())
    }

    pub fn mark_failed(&mut self, message: impl Into<String>) {
        self.status = UpdateStatus::Failed;
        self.error_message = Some(message.into());
        self.waiting_for_app_exit_auto_install = false;
        self.install_auth_blocked_package_sha256 = None;
        self.install_after_app_exit_requested = false;
    }

    pub fn install_auth_retry_is_blocked(&self) -> bool {
        self.upstream_package_sha256.is_some()
            && self.install_auth_blocked_package_sha256 == self.upstream_package_sha256
    }

    pub fn block_install_auth_retry(&mut self) {
        self.install_auth_blocked_package_sha256 = self.upstream_package_sha256.clone();
    }

    pub fn clear_install_auth_retry_block(&mut self) {
        self.install_auth_blocked_package_sha256 = None;
    }

}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_v1_candidate_is_reset_but_rollback_is_preserved() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let state_path = dir.path().join("state.json");
        fs::write(&state_path, r#"{
          "installed_version":"1.2.3",
          "candidate_version":"legacy",
          "status":"ready_to_install",
          "artifact_paths":{"legacy_source_path":"/tmp/legacy-upstream","rollback_package_path":"/tmp/good.deb"},
          "last_known_good_version":"1.2.2"
        }"#)?;
        let state = PersistedState::load_or_default(&state_path, true)?;
        assert_eq!(state.schema_version, 2);
        assert_eq!(state.candidate_version, None);
        assert_eq!(state.installed_version, "1.2.3");
        assert_eq!(state.artifact_paths.rollback_package_path, Some(PathBuf::from("/tmp/good.deb")));
        Ok(())
    }

    #[test]
    fn install_auth_retry_block_is_scoped_to_package_hash() {
        let mut state = PersistedState::new(true);
        state.upstream_package_sha256 = Some("candidate-a".into());

        assert!(!state.install_auth_retry_is_blocked());
        state.block_install_auth_retry();
        assert!(state.install_auth_retry_is_blocked());

        state.upstream_package_sha256 = Some("candidate-b".into());
        assert!(!state.install_auth_retry_is_blocked());
    }

    #[test]
    fn schema_v2_state_defaults_and_round_trips_install_auth_retry_block() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let state_path = dir.path().join("state.json");
        fs::write(&state_path, r#"{"schema_version":2}"#)?;

        let mut state = PersistedState::load_or_default(&state_path, true)?;
        assert_eq!(state.install_auth_blocked_package_sha256, None);
        assert!(!state.install_after_app_exit_requested);

        state.upstream_package_sha256 = Some("candidate".into());
        state.block_install_auth_retry();
        state.save_updater(&state_path)?;
        let loaded = PersistedState::load_or_default(&state_path, true)?;
        assert!(loaded.install_auth_retry_is_blocked());
        Ok(())
    }

    #[test]
    fn legacy_waiting_state_does_not_gain_explicit_install_consent() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let state_path = dir.path().join("state.json");
        fs::write(
            &state_path,
            r#"{"schema_version":2,"status":"waiting_for_app_exit","waiting_for_app_exit_auto_install":false}"#,
        )?;

        let state = PersistedState::load_or_default(&state_path, false)?;
        assert_eq!(state.status, UpdateStatus::WaitingForAppExit);
        assert!(!state.waiting_for_app_exit_auto_install);
        assert!(!state.install_after_app_exit_requested);
        Ok(())
    }
}
