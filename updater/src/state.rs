//! Persisted updater state and compatibility with older on-disk formats.

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeSet,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    process,
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
/// High-level lifecycle states for the local updater daemon.
pub enum UpdateStatus {
    Idle,
    CheckingUpstream,
    UpdateDetected,
    DownloadingDmg,
    PreparingWorkspace,
    PatchingApp,
    /// Building a native Linux package (.deb, .rpm, or .pkg.tar.*). Serialised as
    /// `"building_package"` in new state files; the legacy key
    /// `"building_deb"` is accepted on read for backward compatibility.
    #[serde(alias = "building_deb")]
    BuildingPackage,
    ReadyToInstall,
    WaitingForAppExit,
    Installing,
    Installed,
    Failed,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
/// Status of the user-installed Codex CLI preflight check.
pub enum CliStatus {
    #[default]
    Unknown,
    NotInstalled,
    Checking,
    UpToDate,
    UpdateRequired,
    Updating,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
/// Artifact paths tracked across update checks, rebuilds, and installation.
pub struct ArtifactPaths {
    pub dmg_path: Option<PathBuf>,
    pub workspace_dir: Option<PathBuf>,
    /// Path to the built native package (.deb, .rpm, or .pkg.tar.*). Stored as
    /// `"deb_path"` in JSON for backward compatibility with existing state
    /// files.
    #[serde(rename = "deb_path")]
    pub package_path: Option<PathBuf>,
    #[serde(default)]
    pub rollback_package_path: Option<PathBuf>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
/// Full updater state stored on disk between daemon runs.
pub struct PersistedState {
    pub installed_version: String,
    pub candidate_version: Option<String>,
    pub status: UpdateStatus,
    pub last_check_at: Option<DateTime<Utc>>,
    pub last_successful_check_at: Option<DateTime<Utc>>,
    pub remote_headers_fingerprint: Option<String>,
    pub dmg_sha256: Option<String>,
    pub artifact_paths: ArtifactPaths,
    pub error_message: Option<String>,
    pub notified_events: BTreeSet<String>,
    pub auto_install_on_app_exit: bool,
    #[serde(default)]
    pub waiting_for_app_exit_auto_install: bool,
    #[serde(default)]
    pub last_known_good_version: Option<String>,
    #[serde(default)]
    pub rollback_blocked_candidate_version: Option<String>,
    #[serde(default)]
    pub cli_path: Option<PathBuf>,
    #[serde(default)]
    pub cli_installed_version: Option<String>,
    #[serde(default)]
    pub cli_latest_version: Option<String>,
    #[serde(default)]
    pub cli_status: CliStatus,
    #[serde(default)]
    pub cli_last_check_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub cli_last_verified_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub cli_error_message: Option<String>,
    #[serde(default)]
    pub cli_prompt_dismissed_at: Option<DateTime<Utc>>,
    /// Wrapper (repo) version currently installed, when known.
    #[serde(default)]
    pub installed_wrapper_version: Option<String>,
    /// Wrapper commit currently installed, when known.
    #[serde(default)]
    pub installed_wrapper_commit: Option<String>,
    /// Newer wrapper version detected upstream, when one is available.
    #[serde(default)]
    pub candidate_wrapper_version: Option<String>,
    /// Newer wrapper commit detected upstream, when one is available.
    #[serde(default)]
    pub candidate_wrapper_commit: Option<String>,
    /// Changelog (curated sections or git subjects) for the detected wrapper
    /// update.
    #[serde(default)]
    pub wrapper_changelog: Option<String>,
    /// True when the installed wrapper build appears to be ahead of upstream,
    /// so applying the remote candidate would be a downgrade.
    #[serde(default)]
    pub wrapper_dev_mode: Option<bool>,
}

impl PersistedState {
    /// Creates a new default state using the selected auto-install preference.
    pub fn new(auto_install_on_app_exit: bool) -> Self {
        Self {
            installed_version: "unknown".to_string(),
            candidate_version: None,
            status: UpdateStatus::Idle,
            last_check_at: None,
            last_successful_check_at: None,
            remote_headers_fingerprint: None,
            dmg_sha256: None,
            artifact_paths: ArtifactPaths::default(),
            error_message: None,
            notified_events: BTreeSet::new(),
            auto_install_on_app_exit,
            waiting_for_app_exit_auto_install: false,
            last_known_good_version: None,
            rollback_blocked_candidate_version: None,
            cli_path: None,
            cli_installed_version: None,
            cli_latest_version: None,
            cli_status: CliStatus::Unknown,
            cli_last_check_at: None,
            cli_last_verified_at: None,
            cli_error_message: None,
            cli_prompt_dismissed_at: None,
            installed_wrapper_version: None,
            installed_wrapper_commit: None,
            candidate_wrapper_version: None,
            candidate_wrapper_commit: None,
            wrapper_changelog: None,
            wrapper_dev_mode: None,
        }
    }

    /// Loads state from disk or returns a new default state if the file is missing.
    pub fn load_or_default(path: &Path, auto_install_on_app_exit: bool) -> Result<Self> {
        if !path.exists() {
            return Ok(Self::new(auto_install_on_app_exit));
        }

        let content = fs::read_to_string(path)
            .with_context(|| format!("Failed to read {}", path.display()))?;
        let state = serde_json::from_str::<Self>(&content)
            .with_context(|| format!("Failed to parse {}", path.display()))?;
        Ok(state)
    }

    /// Persists the updater state to JSON on disk.
    pub fn save(&self, path: &Path) -> Result<()> {
        let content = serde_json::to_string_pretty(self)?;
        atomic_write(path, content.as_bytes())?;
        Ok(())
    }

    /// Marks the state as failed while preserving any useful recovery metadata.
    pub fn mark_failed(&mut self, message: impl Into<String>) {
        self.status = UpdateStatus::Failed;
        self.waiting_for_app_exit_auto_install = false;
        self.error_message = Some(message.into());
    }

    /// Clears the currently advertised wrapper update candidate.
    pub fn clear_wrapper_update_candidate(&mut self) {
        self.candidate_wrapper_version = None;
        self.candidate_wrapper_commit = None;
        self.wrapper_changelog = None;
        self.wrapper_dev_mode = None;
    }
}

fn atomic_write(path: &Path, contents: &[u8]) -> Result<()> {
    let parent = path
        .parent()
        .with_context(|| format!("{} has no parent directory", path.display()))?;
    fs::create_dir_all(parent).with_context(|| format!("Failed to create {}", parent.display()))?;

    let temp_path = atomic_temp_path(path);
    let mut temp_file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp_path)
        .with_context(|| format!("Failed to create {}", temp_path.display()))?;

    let write_result = (|| -> Result<()> {
        temp_file
            .write_all(contents)
            .with_context(|| format!("Failed to write {}", temp_path.display()))?;
        temp_file
            .sync_all()
            .with_context(|| format!("Failed to sync {}", temp_path.display()))?;
        Ok(())
    })();

    if let Err(error) = write_result {
        let _ = fs::remove_file(&temp_path);
        return Err(error);
    }

    fs::rename(&temp_path, path).with_context(|| {
        format!(
            "Failed to atomically replace {} with {}",
            path.display(),
            temp_path.display()
        )
    })?;
    Ok(())
}

fn atomic_temp_path(path: &Path) -> PathBuf {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("state.json");
    path.with_file_name(format!(".{file_name}.tmp.{}.{}", process::id(), timestamp))
}

#[cfg(test)]
mod tests {
    use super::*;
    use anyhow::Result;
    use tempfile::tempdir;

    #[test]
    fn creates_default_state_when_missing() -> Result<()> {
        let temp = tempdir()?;
        let state = PersistedState::load_or_default(&temp.path().join("state.json"), true)?;
        assert_eq!(state.status, UpdateStatus::Idle);
        assert!(state.auto_install_on_app_exit);
        Ok(())
    }

    #[test]
    fn roundtrips_persisted_state() -> Result<()> {
        let temp = tempdir()?;
        let path = temp.path().join("state.json");
        let mut state = PersistedState::new(false);
        state.installed_version = "2026.03.24+deadbeef".to_string();
        state.status = UpdateStatus::WaitingForAppExit;
        state.candidate_version = Some("2026.03.25+feedface".to_string());
        state.notified_events.insert("ready_to_install".to_string());
        state.waiting_for_app_exit_auto_install = true;
        state.save(&path)?;

        let loaded = PersistedState::load_or_default(&path, true)?;
        assert_eq!(loaded.installed_version, "2026.03.24+deadbeef");
        assert_eq!(loaded.status, UpdateStatus::WaitingForAppExit);
        assert_eq!(
            loaded.candidate_version.as_deref(),
            Some("2026.03.25+feedface")
        );
        assert!(loaded.notified_events.contains("ready_to_install"));
        assert!(!loaded.auto_install_on_app_exit);
        assert!(loaded.waiting_for_app_exit_auto_install);
        Ok(())
    }

    #[test]
    fn loads_legacy_state_without_cli_fields() -> Result<()> {
        let temp = tempdir()?;
        let path = temp.path().join("state.json");
        fs::write(
            &path,
            r#"{
  "installed_version": "2026.03.24+deadbeef",
  "candidate_version": null,
  "status": "idle",
  "last_check_at": null,
  "last_successful_check_at": null,
  "remote_headers_fingerprint": null,
  "dmg_sha256": null,
  "artifact_paths": {"dmg_path": null, "workspace_dir": null, "deb_path": null},
  "error_message": null,
  "notified_events": [],
  "auto_install_on_app_exit": true
}"#,
        )?;

        let loaded = PersistedState::load_or_default(&path, true)?;
        assert_eq!(loaded.cli_status, CliStatus::Unknown);
        assert_eq!(loaded.cli_installed_version, None);
        assert_eq!(loaded.cli_latest_version, None);
        assert_eq!(loaded.cli_error_message, None);
        assert!(!loaded.waiting_for_app_exit_auto_install);
        Ok(())
    }

    #[test]
    fn serialises_not_installed_cli_status() {
        let json = serde_json::to_string(&CliStatus::NotInstalled).expect("should serialise");
        assert_eq!(json, r#""not_installed""#);
    }

    #[test]
    fn deserialises_not_installed_cli_status() {
        let status: CliStatus =
            serde_json::from_str(r#""not_installed""#).expect("should parse not_installed");
        assert_eq!(status, CliStatus::NotInstalled);
    }

    #[test]
    fn deserialises_legacy_building_deb_status() {
        let json = r#""building_deb""#;
        let status: UpdateStatus = serde_json::from_str(json).expect("should parse building_deb");
        assert_eq!(status, UpdateStatus::BuildingPackage);
    }

    #[test]
    fn deserialises_legacy_deb_path_field() {
        let json = r#"{"dmg_path":null,"workspace_dir":null,"deb_path":"/tmp/codex.deb"}"#;
        let paths: ArtifactPaths = serde_json::from_str(json).expect("should parse deb_path field");
        assert_eq!(
            paths.package_path.as_deref().and_then(|p| p.to_str()),
            Some("/tmp/codex.deb")
        );
    }

    #[test]
    fn serialises_package_path_as_deb_path() {
        let paths = ArtifactPaths {
            dmg_path: None,
            workspace_dir: None,
            package_path: Some(std::path::PathBuf::from("/tmp/codex.rpm")),
            rollback_package_path: None,
        };
        let json = serde_json::to_string(&paths).expect("should serialise");
        assert!(
            json.contains("\"deb_path\""),
            "JSON key must remain deb_path for backward compat"
        );
    }

    #[test]
    fn save_writes_state_atomically_without_temp_file_left_behind() -> Result<()> {
        let temp = tempdir()?;
        let path = temp.path().join("state.json");
        let mut state = PersistedState::new(true);
        state.installed_version = "2026.04.20.120000".to_string();

        state.save(&path)?;

        let content = fs::read_to_string(&path)?;
        assert!(content.contains("\"installed_version\": \"2026.04.20.120000\""));

        let leftover_temp_files = fs::read_dir(temp.path())?
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.contains(".tmp."))
            .collect::<Vec<_>>();
        assert!(
            leftover_temp_files.is_empty(),
            "temporary files should be cleaned up after atomic save: {leftover_temp_files:?}"
        );
        Ok(())
    }
}
