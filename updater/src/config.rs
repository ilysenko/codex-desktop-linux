//! Small runtime configuration for the signed Linux-package updater.

use anyhow::{Context, Result};
use directories::BaseDirs;
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf, time::Duration};

const SERVICE_NAME: &str = "codex-update-manager";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct RuntimeConfig {
    pub repository_url: String,
    pub initial_check_delay_seconds: u64,
    pub check_interval_hours: u64,
    pub auto_install_on_app_exit: bool,
    pub notifications: bool,
    pub workspace_root: PathBuf,
    pub builder_bundle_root: PathBuf,
    pub app_executable_path: PathBuf,
    pub feature_config_path: Option<PathBuf>,
}

impl Default for RuntimeConfig {
    fn default() -> Self {
        Self {
            repository_url: "https://persistent.oaistatic.com/codex-app-prod/linux/deb".into(),
            initial_check_delay_seconds: 30,
            check_interval_hours: 6,
            auto_install_on_app_exit: true,
            notifications: true,
            workspace_root: PathBuf::new(),
            builder_bundle_root: PathBuf::from("/opt/codex-desktop/update-builder"),
            app_executable_path: PathBuf::from("/opt/codex-desktop/ChatGPT"),
            feature_config_path: None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct RuntimePaths {
    pub config_file: PathBuf,
    pub state_file: PathBuf,
    pub log_file: PathBuf,
    pub cache_dir: PathBuf,
    pub state_dir: PathBuf,
    pub config_dir: PathBuf,
}

impl RuntimePaths {
    pub fn from_base_dirs(base: &BaseDirs) -> Self {
        let config_dir = base.config_dir().join(SERVICE_NAME);
        let state_dir = base
            .state_dir()
            .unwrap_or_else(|| base.data_local_dir())
            .join(SERVICE_NAME);
        let cache_dir = base.cache_dir().join(SERVICE_NAME);
        Self {
            config_file: config_dir.join("config.toml"),
            state_file: state_dir.join("state.json"),
            log_file: state_dir.join("service.log"),
            cache_dir,
            state_dir,
            config_dir,
        }
    }

    pub fn detect() -> Result<Self> {
        Ok(Self::from_base_dirs(
            &BaseDirs::new().context("Could not resolve XDG directories")?,
        ))
    }

    pub fn ensure_dirs(&self) -> Result<()> {
        for dir in [&self.config_dir, &self.state_dir, &self.cache_dir] {
            fs::create_dir_all(dir)
                .with_context(|| format!("Failed to create {}", dir.display()))?;
        }
        Ok(())
    }
}

impl RuntimeConfig {
    pub fn default_with_paths(paths: &RuntimePaths) -> Self {
        let mut value = Self {
            workspace_root: paths.cache_dir.clone(),
            ..Self::default()
        };
        if !value.builder_bundle_root.exists() {
            value.builder_bundle_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .expect("updater lives below repository root")
                .to_path_buf();
        }
        value
    }

    pub fn load_or_default(paths: &RuntimePaths) -> Result<Self> {
        let mut value = Self::default_with_paths(paths);
        if paths.config_file.exists() {
            let text = fs::read_to_string(&paths.config_file)
                .with_context(|| format!("Failed to read {}", paths.config_file.display()))?;
            let loaded: RuntimeConfig = toml::from_str(&text)
                .with_context(|| format!("Failed to parse {}", paths.config_file.display()))?;
            value = loaded;
            if value.workspace_root.as_os_str().is_empty() {
                value.workspace_root = paths.cache_dir.clone();
            }
        }
        value.validate()?;
        Ok(value)
    }

    fn validate(&self) -> Result<()> {
        anyhow::ensure!(
            self.repository_url.starts_with("https://")
                || self.repository_url.starts_with("http://127.0.0.1"),
            "repository_url must use HTTPS"
        );
        anyhow::ensure!(
            self.check_interval_hours > 0,
            "check_interval_hours must be positive"
        );
        Ok(())
    }

    pub fn initial_check_delay_duration(&self) -> Duration {
        Duration::from_secs(self.initial_check_delay_seconds)
    }

    pub fn check_interval_duration(&self) -> Duration {
        Duration::from_secs(self.check_interval_hours.saturating_mul(3600))
    }
}

pub fn effective_feature_config_path(config: &RuntimeConfig) -> Option<PathBuf> {
    config
        .feature_config_path
        .clone()
        .or_else(|| std::env::var_os("CODEX_LINUX_FEATURES_CONFIG").map(PathBuf::from))
        .filter(|path| path.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_target_the_official_linux_repository_and_runtime() -> Result<()> {
        let paths = RuntimePaths::detect()?;
        let config = RuntimeConfig::default_with_paths(&paths);
        assert!(config.repository_url.ends_with("/linux/deb"));
        assert_eq!(
            config.app_executable_path,
            PathBuf::from("/opt/codex-desktop/ChatGPT")
        );
        Ok(())
    }
}
