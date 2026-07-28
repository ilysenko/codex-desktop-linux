//! Persisted updater state and compatibility with older on-disk formats.

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeSet,
    fs::{self, OpenOptions},
    io::Write,
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    process,
    time::{SystemTime, UNIX_EPOCH},
};

const STATE_LOCK_FILE_NAME: &str = "state.lock";

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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
/// Installation channel inferred for a user-installed Codex CLI.
pub enum CliInstallChannel {
    Standalone,
    Homebrew,
    Npm,
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
    pub rollback_blocked_dmg_sha256: Option<String>,
    #[serde(default)]
    pub cli_path: Option<PathBuf>,
    #[serde(default)]
    pub cli_install_channel: Option<CliInstallChannel>,
    #[serde(default)]
    pub cli_installed_version: Option<String>,
    #[serde(default, alias = "cli_latest_version")]
    pub cli_official_latest_version: Option<String>,
    #[serde(default)]
    pub cli_package_manager_latest_version: Option<String>,
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
            rollback_blocked_dmg_sha256: None,
            cli_path: None,
            cli_install_channel: None,
            cli_installed_version: None,
            cli_official_latest_version: None,
            cli_package_manager_latest_version: None,
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
    #[cfg(test)]
    pub fn save(&self, path: &Path) -> Result<()> {
        let _lock = StateLock::acquire(path)?;
        self.save_unlocked(path)
    }

    pub fn save_updater(&self, path: &Path) -> Result<()> {
        let _lock = StateLock::acquire(path)?;
        let mut merged = self.clone();
        if let Some(latest) = Self::load_if_present(path)? {
            merged.copy_cli_state_from(&latest);
        }
        merged.save_unlocked(path)
    }

    pub fn save_cli(&mut self, path: &Path) -> Result<()> {
        let _lock = StateLock::acquire(path)?;
        let mut merged = Self::load_if_present(path)?
            .unwrap_or_else(|| Self::new(self.auto_install_on_app_exit));
        merged.copy_cli_state_from(self);
        merged.save_unlocked(path)?;
        *self = merged;
        Ok(())
    }

    pub fn reload_cli(&mut self, path: &Path) -> Result<()> {
        let _lock = StateLock::acquire(path)?;
        if let Some(latest) = Self::load_if_present(path)? {
            self.copy_cli_state_from(&latest);
        }
        Ok(())
    }

    pub fn save_cli_if_unchanged(&mut self, path: &Path, expected: &Self) -> Result<bool> {
        let _lock = StateLock::acquire(path)?;
        let latest = Self::load_if_present(path)?.unwrap_or_else(|| expected.clone());
        if !latest.same_cli_state(expected) {
            *self = latest;
            return Ok(false);
        }
        let mut merged = latest;
        merged.copy_cli_state_from(self);
        merged.save_unlocked(path)?;
        *self = merged;
        Ok(true)
    }

    pub fn save_cli_status(&mut self, path: &Path) -> Result<()> {
        let _lock = StateLock::acquire(path)?;
        let mut latest = Self::load_if_present(path)?.unwrap_or_else(|| self.clone());
        latest.cli_status = self.cli_status.clone();
        latest.cli_error_message = self.cli_error_message.clone();
        latest.save_unlocked(path)?;
        *self = latest;
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

    fn load_if_present(path: &Path) -> Result<Option<Self>> {
        match fs::read_to_string(path) {
            Ok(content) => serde_json::from_str::<Self>(&content)
                .with_context(|| format!("Failed to parse {}", path.display()))
                .map(Some),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error).with_context(|| format!("Failed to read {}", path.display())),
        }
    }

    fn save_unlocked(&self, path: &Path) -> Result<()> {
        let content = serde_json::to_string_pretty(self)?;
        atomic_write(path, content.as_bytes())
    }

    fn copy_cli_state_from(&mut self, source: &Self) {
        self.cli_path = source.cli_path.clone();
        self.cli_install_channel = source.cli_install_channel.clone();
        self.cli_installed_version = source.cli_installed_version.clone();
        self.cli_official_latest_version = source.cli_official_latest_version.clone();
        self.cli_package_manager_latest_version = source.cli_package_manager_latest_version.clone();
        self.cli_status = source.cli_status.clone();
        self.cli_last_check_at = source.cli_last_check_at;
        self.cli_last_verified_at = source.cli_last_verified_at;
        self.cli_error_message = source.cli_error_message.clone();
    }

    fn same_cli_state(&self, other: &Self) -> bool {
        self.cli_path == other.cli_path
            && self.cli_install_channel == other.cli_install_channel
            && self.cli_installed_version == other.cli_installed_version
            && self.cli_official_latest_version == other.cli_official_latest_version
            && self.cli_package_manager_latest_version == other.cli_package_manager_latest_version
            && self.cli_status == other.cli_status
            && self.cli_last_check_at == other.cli_last_check_at
            && self.cli_last_verified_at == other.cli_last_verified_at
            && self.cli_error_message == other.cli_error_message
    }
}

pub(crate) fn atomic_write(path: &Path, contents: &[u8]) -> Result<()> {
    let parent = path
        .parent()
        .with_context(|| format!("{} has no parent directory", path.display()))?;
    fs::create_dir_all(parent).with_context(|| format!("Failed to create {}", parent.display()))?;

    let temp_path = atomic_temp_path(path);
    let mut temp_file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
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
    sync_directory(parent)?;
    Ok(())
}

pub(crate) fn sync_directory(path: &Path) -> Result<()> {
    fs::File::open(path)
        .with_context(|| format!("Failed to open directory {}", path.display()))?
        .sync_all()
        .with_context(|| format!("Failed to sync directory {}", path.display()))
}

struct StateLock {
    _file: fs::File,
}

impl StateLock {
    fn acquire(state_path: &Path) -> Result<Self> {
        let parent = state_path
            .parent()
            .with_context(|| format!("{} has no parent directory", state_path.display()))?;
        fs::create_dir_all(parent)
            .with_context(|| format!("Failed to create {}", parent.display()))?;
        let lock_path = parent.join(STATE_LOCK_FILE_NAME);
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
            "Updater state lock {} is not a user-owned regular file",
            lock_path.display()
        );
        if metadata.permissions().mode() & 0o077 != 0 {
            file.set_permissions(fs::Permissions::from_mode(0o600))
                .with_context(|| format!("Failed to secure {}", lock_path.display()))?;
        }
        file.lock()
            .with_context(|| format!("Failed to lock {}", lock_path.display()))?;
        Ok(Self { _file: file })
    }
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
        state.rollback_blocked_dmg_sha256 = Some("full-rollback-dmg-sha256".to_string());
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
        assert_eq!(
            loaded.rollback_blocked_dmg_sha256.as_deref(),
            Some("full-rollback-dmg-sha256")
        );
        assert!(!loaded.auto_install_on_app_exit);
        assert!(loaded.waiting_for_app_exit_auto_install);
        Ok(())
    }

    #[test]
    fn updater_and_cli_state_transactions_preserve_each_other() -> Result<()> {
        let temp = tempdir()?;
        let path = temp.path().join("state.json");
        PersistedState::new(true).save(&path)?;

        let mut cli = PersistedState::load_or_default(&path, true)?;
        cli.cli_status = CliStatus::UpToDate;
        cli.cli_installed_version = Some("0.42.1".to_string());

        let mut updater = PersistedState::load_or_default(&path, true)?;
        updater.status = UpdateStatus::DownloadingDmg;
        updater.remote_headers_fingerprint = Some("new-updater-state".to_string());
        updater.cli_prompt_dismissed_at = Some(Utc::now());

        cli.save_cli(&path)?;
        updater.save_updater(&path)?;

        let loaded = PersistedState::load_or_default(&path, true)?;
        assert_eq!(loaded.cli_status, CliStatus::UpToDate);
        assert_eq!(loaded.cli_installed_version.as_deref(), Some("0.42.1"));
        assert_eq!(loaded.status, UpdateStatus::DownloadingDmg);
        assert_eq!(
            loaded.remote_headers_fingerprint.as_deref(),
            Some("new-updater-state")
        );
        assert!(loaded.cli_prompt_dismissed_at.is_some());

        let mut later_cli = PersistedState::new(true);
        later_cli.cli_status = CliStatus::UpdateRequired;
        later_cli.cli_error_message = Some("repair required".to_string());
        later_cli.save_cli(&path)?;

        let loaded = PersistedState::load_or_default(&path, true)?;
        assert_eq!(loaded.cli_status, CliStatus::UpdateRequired);
        assert_eq!(
            loaded.remote_headers_fingerprint.as_deref(),
            Some("new-updater-state")
        );
        assert!(loaded.cli_prompt_dismissed_at.is_some());
        Ok(())
    }

    #[test]
    fn guarded_cli_state_write_reloads_a_newer_cli_result() -> Result<()> {
        let temp = tempdir()?;
        let path = temp.path().join("state.json");
        PersistedState::new(true).save(&path)?;

        let baseline = PersistedState::load_or_default(&path, true)?;
        let mut stale = baseline.clone();
        stale.cli_status = CliStatus::Unknown;
        stale.cli_installed_version = Some("0.42.0".to_string());

        let mut newer = baseline.clone();
        newer.cli_status = CliStatus::UpToDate;
        newer.cli_installed_version = Some("0.42.1".to_string());
        newer.save_cli(&path)?;
        newer.remote_headers_fingerprint = Some("must-survive".to_string());
        newer.save_updater(&path)?;

        assert!(!stale.save_cli_if_unchanged(&path, &baseline)?);
        assert_eq!(stale.cli_status, CliStatus::UpToDate);
        assert_eq!(stale.cli_installed_version.as_deref(), Some("0.42.1"));
        assert_eq!(
            stale.remote_headers_fingerprint.as_deref(),
            Some("must-survive")
        );
        let loaded = PersistedState::load_or_default(&path, true)?;
        assert_eq!(loaded.cli_status, CliStatus::UpToDate);
        assert_eq!(loaded.cli_installed_version.as_deref(), Some("0.42.1"));
        Ok(())
    }

    #[test]
    fn cli_status_write_preserves_the_latest_cli_identity() -> Result<()> {
        let temp = tempdir()?;
        let path = temp.path().join("state.json");
        let mut latest = PersistedState::new(true);
        latest.cli_path = Some(PathBuf::from("/new/codex"));
        latest.cli_installed_version = Some("0.42.1".to_string());
        latest.cli_official_latest_version = Some("0.42.1".to_string());
        latest.cli_last_verified_at = Some(Utc::now());
        latest.cli_status = CliStatus::UpToDate;
        latest.remote_headers_fingerprint = Some("must-survive".to_string());
        latest.save(&path)?;

        let mut stale = PersistedState::new(true);
        stale.cli_path = Some(PathBuf::from("/old/codex"));
        stale.cli_installed_version = Some("0.42.0".to_string());
        stale.cli_official_latest_version = None;
        stale.cli_status = CliStatus::UpdateRequired;
        stale.cli_error_message = Some("repair required".to_string());
        stale.save_cli_status(&path)?;

        assert_eq!(stale.cli_path, Some(PathBuf::from("/new/codex")));
        assert_eq!(stale.cli_installed_version.as_deref(), Some("0.42.1"));
        assert_eq!(stale.cli_official_latest_version.as_deref(), Some("0.42.1"));
        assert!(stale.cli_last_verified_at.is_some());
        assert_eq!(stale.cli_status, CliStatus::UpdateRequired);
        assert_eq!(stale.cli_error_message.as_deref(), Some("repair required"));
        assert_eq!(
            stale.remote_headers_fingerprint.as_deref(),
            Some("must-survive")
        );
        Ok(())
    }

    #[test]
    fn state_lock_rejects_a_symlink() -> Result<()> {
        let temp = tempdir()?;
        let path = temp.path().join("state.json");
        let target = temp.path().join("must-survive");
        fs::write(&target, "unchanged\n")?;
        std::os::unix::fs::symlink(&target, temp.path().join(STATE_LOCK_FILE_NAME))?;

        PersistedState::new(true)
            .save(&path)
            .expect_err("state lock must reject symlinks");

        assert_eq!(fs::read_to_string(target)?, "unchanged\n");
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
        assert_eq!(loaded.cli_official_latest_version, None);
        assert_eq!(loaded.cli_package_manager_latest_version, None);
        assert_eq!(loaded.cli_error_message, None);
        assert!(!loaded.waiting_for_app_exit_auto_install);
        Ok(())
    }

    #[test]
    fn loads_legacy_rollback_block_without_dmg_hash() -> Result<()> {
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
  "auto_install_on_app_exit": true,
  "rollback_blocked_candidate_version": "2026.03.25+badcafe0"
}"#,
        )?;

        let loaded = PersistedState::load_or_default(&path, true)?;

        assert_eq!(
            loaded.rollback_blocked_candidate_version.as_deref(),
            Some("2026.03.25+badcafe0")
        );
        assert_eq!(loaded.rollback_blocked_dmg_sha256, None);
        Ok(())
    }

    #[test]
    fn loads_legacy_cli_latest_version_into_official_latest() -> Result<()> {
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
  "auto_install_on_app_exit": true,
  "cli_latest_version": "0.42.1"
}"#,
        )?;

        let loaded = PersistedState::load_or_default(&path, true)?;
        assert_eq!(
            loaded.cli_official_latest_version.as_deref(),
            Some("0.42.1")
        );
        assert_eq!(loaded.cli_package_manager_latest_version, None);
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
