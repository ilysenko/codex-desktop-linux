//! Durable updater state for official Linux packages.

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProcessIdentity {
    pub pid: u32,
    pub start_time_ticks: u64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum InstallOperation {
    Update,
    Rollback,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct InstallTransaction {
    pub package_path: PathBuf,
    #[serde(default)]
    pub package_sha256: Option<String>,
    pub package_command: Option<ProcessIdentity>,
    pub started_at: DateTime<Utc>,
    pub operation: InstallOperation,
}

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
    pub install_transaction: Option<InstallTransaction>,
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
            install_transaction: None,
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
        if raw
            .get("schema_version")
            .and_then(|v| v.as_u64())
            .unwrap_or(1)
            < 2
        {
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
        self.install_transaction = None;
        self.error_message = Some(message.into());
        self.waiting_for_app_exit_auto_install = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_v1_candidate_is_reset_but_rollback_is_preserved() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let state_path = dir.path().join("state.json");
        fs::write(
            &state_path,
            r#"{
          "installed_version":"1.2.3",
          "candidate_version":"legacy",
          "status":"ready_to_install",
          "artifact_paths":{"legacy_source_path":"/tmp/legacy-upstream","rollback_package_path":"/tmp/good.deb"},
          "last_known_good_version":"1.2.2"
        }"#,
        )?;
        let state = PersistedState::load_or_default(&state_path, true)?;
        assert_eq!(state.schema_version, 2);
        assert_eq!(state.candidate_version, None);
        assert_eq!(state.installed_version, "1.2.3");
        assert_eq!(
            state.artifact_paths.rollback_package_path,
            Some(PathBuf::from("/tmp/good.deb"))
        );
        Ok(())
    }
}
