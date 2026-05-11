//! Runtime configuration loading and XDG path discovery for the updater.

use anyhow::{anyhow, Context, Result};
use directories::BaseDirs;
use serde::{Deserialize, Serialize};
use std::{env, fs, path::PathBuf, str::FromStr};

const SERVICE_NAME: &str = "codex-update-manager";
pub const STABLE_DMG_URL: &str = "https://persistent.oaistatic.com/codex-app-prod/Codex.dmg";
pub const BETA_APPCAST_URL: &str = "https://persistent.oaistatic.com/codex-app-beta/appcast.xml";

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
/// Release track selected for app and CLI update checks.
pub enum ReleaseTrack {
    #[default]
    Stable,
    Preview,
}

impl ReleaseTrack {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Stable => "stable",
            Self::Preview => "preview",
        }
    }
}

impl FromStr for ReleaseTrack {
    type Err = anyhow::Error;

    fn from_str(value: &str) -> std::result::Result<Self, Self::Err> {
        match value {
            "stable" => Ok(Self::Stable),
            "preview" => Ok(Self::Preview),
            _ => Err(anyhow!(
                "Unknown release track: {value} (expected stable or preview)"
            )),
        }
    }
}

fn default_dmg_url() -> String {
    STABLE_DMG_URL.to_string()
}

fn default_beta_appcast_url() -> String {
    BETA_APPCAST_URL.to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
/// Runtime configuration values that control how the updater behaves on Linux.
pub struct RuntimeConfig {
    #[serde(default)]
    pub release_track: ReleaseTrack,
    #[serde(default = "default_dmg_url")]
    pub dmg_url: String,
    #[serde(default = "default_beta_appcast_url")]
    pub beta_appcast_url: String,
    pub initial_check_delay_seconds: u64,
    pub check_interval_hours: u64,
    pub auto_install_on_app_exit: bool,
    pub notifications: bool,
    pub workspace_root: PathBuf,
    pub builder_bundle_root: PathBuf,
    pub app_executable_path: PathBuf,
}

#[derive(Debug, Default, Deserialize)]
struct RuntimeConfigFile {
    release_track: Option<ReleaseTrack>,
    dmg_url: Option<String>,
    beta_appcast_url: Option<String>,
    initial_check_delay_seconds: Option<u64>,
    check_interval_hours: Option<u64>,
    auto_install_on_app_exit: Option<bool>,
    notifications: Option<bool>,
    workspace_root: Option<PathBuf>,
    builder_bundle_root: Option<PathBuf>,
    app_executable_path: Option<PathBuf>,
}

#[derive(Debug, Clone)]
/// Resolved XDG filesystem locations used by the updater at runtime.
pub struct RuntimePaths {
    pub config_file: PathBuf,
    pub state_file: PathBuf,
    pub log_file: PathBuf,
    pub cache_dir: PathBuf,
    pub state_dir: PathBuf,
    pub config_dir: PathBuf,
}

impl RuntimePaths {
    /// Resolves updater paths from the current user's XDG base directories.
    pub fn from_base_dirs(base_dirs: &BaseDirs) -> Self {
        let config_dir = base_dirs.config_dir().join(SERVICE_NAME);
        let state_root = base_dirs
            .state_dir()
            .unwrap_or_else(|| base_dirs.data_local_dir());
        let state_dir = state_root.join(SERVICE_NAME);
        let cache_dir = base_dirs.cache_dir().join(SERVICE_NAME);

        Self {
            config_file: config_dir.join("config.toml"),
            state_file: state_dir.join("state.json"),
            log_file: state_dir.join("service.log"),
            cache_dir,
            state_dir,
            config_dir,
        }
    }

    /// Detects updater paths for the current machine.
    pub fn detect() -> Result<Self> {
        let base_dirs = BaseDirs::new().context("Could not resolve XDG base directories")?;
        Ok(Self::from_base_dirs(&base_dirs))
    }

    /// Creates the runtime directories needed by the updater.
    pub fn ensure_dirs(&self) -> Result<()> {
        fs::create_dir_all(&self.config_dir)
            .with_context(|| format!("Failed to create {}", self.config_dir.display()))?;
        fs::create_dir_all(&self.state_dir)
            .with_context(|| format!("Failed to create {}", self.state_dir.display()))?;
        fs::create_dir_all(&self.cache_dir)
            .with_context(|| format!("Failed to create {}", self.cache_dir.display()))?;
        Ok(())
    }
}

impl RuntimeConfig {
    /// Builds the default runtime configuration for the resolved paths.
    pub fn default_with_paths(paths: &RuntimePaths) -> Self {
        let packaged_bundle_root = PathBuf::from("/opt/codex-desktop/update-builder");
        let builder_bundle_root = if packaged_bundle_root.exists() {
            packaged_bundle_root
        } else {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .expect("updater crate should live inside the repository root")
                .to_path_buf()
        };

        Self {
            release_track: ReleaseTrack::Stable,
            dmg_url: default_dmg_url(),
            beta_appcast_url: default_beta_appcast_url(),
            initial_check_delay_seconds: 30,
            check_interval_hours: 6,
            auto_install_on_app_exit: true,
            notifications: true,
            workspace_root: paths.cache_dir.clone(),
            builder_bundle_root,
            app_executable_path: PathBuf::from("/opt/codex-desktop/electron"),
        }
    }

    fn apply_env_overrides(&mut self) -> Result<()> {
        if let Some(release_track) = release_track_env_override()? {
            self.release_track = release_track;
        }
        Ok(())
    }

    fn apply_file_config(&mut self, file_config: RuntimeConfigFile) {
        if let Some(value) = file_config.release_track {
            self.release_track = value;
        }
        if let Some(value) = file_config.dmg_url {
            self.dmg_url = value;
        }
        if let Some(value) = file_config.beta_appcast_url {
            self.beta_appcast_url = value;
        }
        if let Some(value) = file_config.initial_check_delay_seconds {
            self.initial_check_delay_seconds = value;
        }
        if let Some(value) = file_config.check_interval_hours {
            self.check_interval_hours = value;
        }
        if let Some(value) = file_config.auto_install_on_app_exit {
            self.auto_install_on_app_exit = value;
        }
        if let Some(value) = file_config.notifications {
            self.notifications = value;
        }
        if let Some(value) = file_config.workspace_root {
            self.workspace_root = value;
        }
        if let Some(value) = file_config.builder_bundle_root {
            self.builder_bundle_root = value;
        }
        if let Some(value) = file_config.app_executable_path {
            self.app_executable_path = value;
        }
    }

    fn validate(&self) -> Result<()> {
        if self.check_interval_hours == 0 {
            return Err(anyhow!("check_interval_hours must be greater than 0"));
        }
        Ok(())
    }

    /// Loads the runtime configuration from disk, or returns defaults if missing.
    pub fn load_or_default(paths: &RuntimePaths) -> Result<Self> {
        let mut config = Self::default_with_paths(paths);
        if paths.config_file.exists() {
            let content = fs::read_to_string(&paths.config_file)
                .with_context(|| format!("Failed to read {}", paths.config_file.display()))?;
            let file_config = toml::from_str::<RuntimeConfigFile>(&content).map_err(|error| {
                anyhow!("Failed to parse {}: {error}", paths.config_file.display())
            })?;
            config.apply_file_config(file_config);
        }
        config.apply_env_overrides()?;
        config.validate()?;
        Ok(config)
    }
}

fn release_track_env_override() -> Result<Option<ReleaseTrack>> {
    let Some(value) = env::var_os("CODEX_RELEASE_TRACK") else {
        return Ok(None);
    };
    let value = value
        .into_string()
        .map_err(|_| anyhow!("CODEX_RELEASE_TRACK must be valid UTF-8"))?;
    let value = value.trim();
    if value.is_empty() {
        return Ok(None);
    }
    value
        .parse()
        .map(Some)
        .map_err(|error| anyhow!("CODEX_RELEASE_TRACK: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use anyhow::Result;
    use std::ffi::OsString;
    use tempfile::tempdir;

    struct TrackEnvGuard {
        release_track: Option<OsString>,
    }

    impl TrackEnvGuard {
        fn clear() -> Self {
            let guard = Self {
                release_track: env::var_os("CODEX_RELEASE_TRACK"),
            };
            env::remove_var("CODEX_RELEASE_TRACK");
            guard
        }
    }

    impl Drop for TrackEnvGuard {
        fn drop(&mut self) {
            if let Some(value) = self.release_track.take() {
                env::set_var("CODEX_RELEASE_TRACK", value);
            } else {
                env::remove_var("CODEX_RELEASE_TRACK");
            }
        }
    }

    #[test]
    fn loads_default_when_config_is_missing() -> Result<()> {
        let _env_guard = crate::test_util::env_lock();
        let _track_env_guard = TrackEnvGuard::clear();
        let temp = tempdir()?;
        let paths = RuntimePaths {
            config_file: temp.path().join("config/config.toml"),
            state_file: temp.path().join("state/state.json"),
            log_file: temp.path().join("state/service.log"),
            cache_dir: temp.path().join("cache"),
            state_dir: temp.path().join("state"),
            config_dir: temp.path().join("config"),
        };

        let config = RuntimeConfig::load_or_default(&paths)?;
        assert_eq!(config.release_track, ReleaseTrack::Stable);
        assert_eq!(config.dmg_url, STABLE_DMG_URL);
        assert_eq!(config.beta_appcast_url, BETA_APPCAST_URL);
        assert_eq!(config.initial_check_delay_seconds, 30);
        assert!(config.auto_install_on_app_exit);
        assert_eq!(config.workspace_root, paths.cache_dir);
        assert!(config.builder_bundle_root.is_absolute());
        Ok(())
    }

    #[test]
    fn parses_runtime_config_from_disk() -> Result<()> {
        let _env_guard = crate::test_util::env_lock();
        let _track_env_guard = TrackEnvGuard::clear();
        let temp = tempdir()?;
        let paths = RuntimePaths {
            config_file: temp.path().join("config/config.toml"),
            state_file: temp.path().join("state/state.json"),
            log_file: temp.path().join("state/service.log"),
            cache_dir: temp.path().join("cache"),
            state_dir: temp.path().join("state"),
            config_dir: temp.path().join("config"),
        };
        fs::create_dir_all(&paths.config_dir)?;
        fs::write(
            &paths.config_file,
            r#"
	dmg_url = "https://example.com/Codex.dmg"
beta_appcast_url = "https://example.com/appcast.xml"
release_track = "preview"
initial_check_delay_seconds = 5
check_interval_hours = 12
auto_install_on_app_exit = false
notifications = false
workspace_root = "/tmp/codex-workspaces"
builder_bundle_root = "/tmp/codex-builder"
app_executable_path = "/opt/codex-desktop/electron"
"#,
        )?;

        let config = RuntimeConfig::load_or_default(&paths)?;
        assert_eq!(config.release_track, ReleaseTrack::Preview);
        assert_eq!(config.dmg_url, "https://example.com/Codex.dmg");
        assert_eq!(config.beta_appcast_url, "https://example.com/appcast.xml");
        assert_eq!(config.initial_check_delay_seconds, 5);
        assert_eq!(config.check_interval_hours, 12);
        assert!(!config.auto_install_on_app_exit);
        assert!(!config.notifications);
        assert_eq!(
            config.workspace_root,
            PathBuf::from("/tmp/codex-workspaces")
        );
        assert_eq!(
            config.builder_bundle_root,
            PathBuf::from("/tmp/codex-builder")
        );
        assert_eq!(
            config.app_executable_path,
            PathBuf::from("/opt/codex-desktop/electron")
        );
        Ok(())
    }

    #[test]
    fn merges_partial_runtime_config_with_defaults() -> Result<()> {
        let _env_guard = crate::test_util::env_lock();
        let _track_env_guard = TrackEnvGuard::clear();
        let temp = tempdir()?;
        let paths = RuntimePaths {
            config_file: temp.path().join("config/config.toml"),
            state_file: temp.path().join("state/state.json"),
            log_file: temp.path().join("state/service.log"),
            cache_dir: temp.path().join("cache"),
            state_dir: temp.path().join("state"),
            config_dir: temp.path().join("config"),
        };
        fs::create_dir_all(&paths.config_dir)?;
        fs::write(
            &paths.config_file,
            r#"
release_track = "preview"
"#,
        )?;

        let config = RuntimeConfig::load_or_default(&paths)?;
        assert_eq!(config.release_track, ReleaseTrack::Preview);
        assert_eq!(config.dmg_url, STABLE_DMG_URL);
        assert_eq!(config.beta_appcast_url, BETA_APPCAST_URL);
        assert_eq!(config.initial_check_delay_seconds, 30);
        assert_eq!(config.check_interval_hours, 6);
        assert!(config.auto_install_on_app_exit);
        assert!(config.notifications);
        assert_eq!(config.workspace_root, paths.cache_dir);
        Ok(())
    }

    #[test]
    fn release_track_env_overrides_config_file() -> Result<()> {
        let _env_guard = crate::test_util::env_lock();
        let _track_env_guard = TrackEnvGuard::clear();
        env::set_var("CODEX_RELEASE_TRACK", "preview");

        let temp = tempdir()?;
        let paths = RuntimePaths {
            config_file: temp.path().join("config/config.toml"),
            state_file: temp.path().join("state/state.json"),
            log_file: temp.path().join("state/service.log"),
            cache_dir: temp.path().join("cache"),
            state_dir: temp.path().join("state"),
            config_dir: temp.path().join("config"),
        };
        fs::create_dir_all(&paths.config_dir)?;
        fs::write(
            &paths.config_file,
            r#"
release_track = "stable"
initial_check_delay_seconds = 5
check_interval_hours = 12
auto_install_on_app_exit = false
notifications = false
workspace_root = "/tmp/codex-workspaces"
builder_bundle_root = "/tmp/codex-builder"
app_executable_path = "/opt/codex-desktop/electron"
"#,
        )?;

        let config = RuntimeConfig::load_or_default(&paths)?;
        assert_eq!(config.release_track, ReleaseTrack::Preview);
        Ok(())
    }

    #[test]
    fn rejects_invalid_release_track_env() -> Result<()> {
        let _env_guard = crate::test_util::env_lock();
        let _track_env_guard = TrackEnvGuard::clear();
        env::set_var("CODEX_RELEASE_TRACK", "nightly");

        let temp = tempdir()?;
        let paths = RuntimePaths {
            config_file: temp.path().join("config/config.toml"),
            state_file: temp.path().join("state/state.json"),
            log_file: temp.path().join("state/service.log"),
            cache_dir: temp.path().join("cache"),
            state_dir: temp.path().join("state"),
            config_dir: temp.path().join("config"),
        };

        let error = RuntimeConfig::load_or_default(&paths).expect_err("config should fail");
        assert!(error.to_string().contains("Unknown release track"));
        Ok(())
    }

    #[test]
    fn rejects_invalid_release_track() -> Result<()> {
        let _env_guard = crate::test_util::env_lock();
        let _track_env_guard = TrackEnvGuard::clear();
        let temp = tempdir()?;
        let paths = RuntimePaths {
            config_file: temp.path().join("config/config.toml"),
            state_file: temp.path().join("state/state.json"),
            log_file: temp.path().join("state/service.log"),
            cache_dir: temp.path().join("cache"),
            state_dir: temp.path().join("state"),
            config_dir: temp.path().join("config"),
        };
        fs::create_dir_all(&paths.config_dir)?;
        fs::write(
            &paths.config_file,
            r#"
release_track = "nightly"
initial_check_delay_seconds = 5
check_interval_hours = 12
auto_install_on_app_exit = false
notifications = false
workspace_root = "/tmp/codex-workspaces"
builder_bundle_root = "/tmp/codex-builder"
app_executable_path = "/opt/codex-desktop/electron"
"#,
        )?;

        let error = RuntimeConfig::load_or_default(&paths).expect_err("config should fail");
        assert!(error.to_string().contains("unknown variant"));
        Ok(())
    }
}
