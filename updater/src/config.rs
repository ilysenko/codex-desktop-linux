//! Runtime configuration loading and XDG path discovery for the updater.

use anyhow::{Context, Result};
use directories::BaseDirs;
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};

const SERVICE_NAME: &str = "codex-update-manager";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
/// Optional cleanup for generated wrapper checkout artifacts such as `dist/`
/// and `target/`. Disabled by default; when enabled, cleanup only runs if the
/// filesystem containing a configured root is below `min_free_bytes`.
pub struct GeneratedArtifactCleanupConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_generated_artifact_cleanup_min_free_bytes")]
    pub min_free_bytes: u64,
    #[serde(default)]
    pub roots: Vec<PathBuf>,
    #[serde(default = "default_generated_artifact_cleanup_entries")]
    pub entries: Vec<PathBuf>,
}

impl Default for GeneratedArtifactCleanupConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            min_free_bytes: default_generated_artifact_cleanup_min_free_bytes(),
            roots: Vec::new(),
            entries: default_generated_artifact_cleanup_entries(),
        }
    }
}

fn default_generated_artifact_cleanup_min_free_bytes() -> u64 {
    10 * 1024 * 1024 * 1024
}

fn default_generated_artifact_cleanup_entries() -> Vec<PathBuf> {
    ["codex-app", "codex-app-next", "dist", "dist-next", "target"]
        .into_iter()
        .map(PathBuf::from)
        .collect()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
/// Runtime configuration values that control how the updater behaves on Linux.
pub struct RuntimeConfig {
    pub dmg_url: String,
    pub initial_check_delay_seconds: u64,
    pub check_interval_hours: u64,
    pub auto_install_on_app_exit: bool,
    pub notifications: bool,
    pub workspace_root: PathBuf,
    pub builder_bundle_root: PathBuf,
    pub app_executable_path: PathBuf,
    /// Opt-in tracking of newer *wrapper* releases (this repo's own Linux
    /// features/fixes), in addition to the upstream Codex DMG. Off by default
    /// so existing installs keep their current DMG-only behavior.
    #[serde(default)]
    pub enable_wrapper_updates: bool,
    /// Git remote (name or URL) used to detect wrapper updates. Empty means
    /// "use the builder checkout's configured `origin`".
    #[serde(default)]
    pub wrapper_remote: String,
    /// Branch to track for wrapper updates.
    #[serde(default = "default_wrapper_branch")]
    pub wrapper_branch: String,
    /// Optional cleanup for generated wrapper checkout artifacts. This is
    /// intentionally opt-in so users keep manual build output unless they
    /// configure cleanup.
    #[serde(default)]
    pub generated_artifact_cleanup: GeneratedArtifactCleanupConfig,
}

fn default_wrapper_branch() -> String {
    "main".to_string()
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
            dmg_url: "https://persistent.oaistatic.com/codex-app-prod/Codex.dmg".to_string(),
            initial_check_delay_seconds: 30,
            check_interval_hours: 6,
            auto_install_on_app_exit: true,
            notifications: true,
            workspace_root: paths.cache_dir.clone(),
            builder_bundle_root,
            app_executable_path: PathBuf::from("/opt/codex-desktop/electron"),
            enable_wrapper_updates: false,
            wrapper_remote: String::new(),
            wrapper_branch: default_wrapper_branch(),
            generated_artifact_cleanup: GeneratedArtifactCleanupConfig::default(),
        }
    }

    /// Loads the runtime configuration from disk, or returns defaults if missing.
    pub fn load_or_default(paths: &RuntimePaths) -> Result<Self> {
        if !paths.config_file.exists() {
            return Ok(Self::default_with_paths(paths));
        }

        let content = fs::read_to_string(&paths.config_file)
            .with_context(|| format!("Failed to read {}", paths.config_file.display()))?;
        let config = toml::from_str::<Self>(&content)
            .with_context(|| format!("Failed to parse {}", paths.config_file.display()))?;
        Ok(config)
    }
}

const APP_SETTINGS_FILE: &str = "settings.json";
pub(crate) const DEFAULT_APP_ID: &str = "codex-desktop";
const AUTO_INSTALL_SETTING_KEY: &str = "codex-linux-auto-update-on-exit";
const WRAPPER_UPDATES_SETTING_KEY: &str = "codex-linux-wrapper-updates-enabled";

/// Resolves the Codex Desktop app id the same way the Linux launcher and main
/// bundle do: `CODEX_LINUX_APP_ID`, then `CODEX_APP_ID`, then `codex-desktop`.
/// Invalid ids fall back to the default so a malformed env value can never point
/// the lookup at an attacker-controlled path.
pub(crate) fn resolve_app_id() -> String {
    for var in ["CODEX_LINUX_APP_ID", "CODEX_APP_ID"] {
        if let Ok(value) = std::env::var(var) {
            if valid_app_id(&value) {
                return value;
            }
        }
    }
    DEFAULT_APP_ID.to_string()
}

pub(crate) fn valid_app_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

pub(crate) fn resolve_launch_instance_id() -> Option<String> {
    std::env::var("CODEX_LINUX_INSTANCE_ID")
        .ok()
        .filter(|value| valid_app_id(value))
}

pub(crate) fn resolve_app_state_dir() -> Result<PathBuf> {
    let base_dirs = BaseDirs::new().context("Could not resolve XDG base directories")?;
    let state_root = base_dirs
        .state_dir()
        .unwrap_or_else(|| base_dirs.data_local_dir());
    let app_state_dir = state_root.join(resolve_app_id());
    Ok(match resolve_launch_instance_id() {
        Some(instance) => app_state_dir.join("instances").join(instance),
        None => app_state_dir,
    })
}

/// Resolves the app `settings.json` path mirroring the launcher
/// (`launcher/start.sh.template`) and the main-bundle persistence helper
/// (`scripts/patches/launch-actions.js`): honor `CODEX_LINUX_SETTINGS_FILE`
/// first, then `XDG_CONFIG_HOME`, then `$HOME/.config`, joined with the app id.
fn app_settings_path() -> Option<PathBuf> {
    if let Ok(explicit) = std::env::var("CODEX_LINUX_SETTINGS_FILE") {
        if !explicit.is_empty() {
            return Some(PathBuf::from(explicit));
        }
    }

    let config_home = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")))?;

    Some(config_home.join(resolve_app_id()).join(APP_SETTINGS_FILE))
}

/// Coerces a settings.json value into a boolean the same way the launcher's
/// `linux_setting_enabled` helper does: real booleans pass through, numbers are
/// truthy when non-zero, and strings are falsey only for `0/false/no/off`.
fn coerce_setting_bool(value: &serde_json::Value) -> Option<bool> {
    match value {
        serde_json::Value::Bool(flag) => Some(*flag),
        serde_json::Value::Number(number) => number.as_f64().map(|n| n != 0.0),
        serde_json::Value::String(text) => {
            let normalized = text.trim().to_ascii_lowercase();
            Some(!matches!(normalized.as_str(), "0" | "false" | "no" | "off"))
        }
        _ => None,
    }
}

/// Reads a boolean app setting from `settings.json`. Returns `Some(true|false)`
/// only when the toggle key is present and coercible; any missing file, parse
/// error, or absent key yields `None` so callers fall back to config/defaults.
fn settings_bool_override(key: &str) -> Option<bool> {
    let path = app_settings_path()?;
    let content = fs::read_to_string(&path).ok()?;
    let parsed = serde_json::from_str::<serde_json::Value>(&content).ok()?;
    let object = parsed.as_object()?;
    coerce_setting_bool(object.get(key)?)
}

/// Reads the user's auto-install-on-exit preference from the app settings.
pub fn settings_auto_install_override() -> Option<bool> {
    settings_bool_override(AUTO_INSTALL_SETTING_KEY)
}

/// Reads the user's opt-in wrapper update tracking preference from app settings.
pub fn settings_wrapper_updates_override() -> Option<bool> {
    settings_bool_override(WRAPPER_UPDATES_SETTING_KEY)
}

const FEATURE_CONFIG_FILE: &str = "linux-features.json";
const BUNDLED_FEATURE_CONFIG_FILE: &str = "features.json";
const FEATURE_PICKER_ON_UPDATE_SETTING_KEY: &str = "codex-linux-feature-picker-on-update";

/// Resolves the stable per-user feature-config path
/// (`<config>/<appId>/linux-features.json`), alongside `settings.json`. The
/// wrapper-update feature picker writes the chosen `{"enabled":[...]}` here, and
/// the rebuild points `CODEX_LINUX_FEATURES_CONFIG` at it. Deliberately outside
/// any wrapper-src checkout so a fresh clone cannot clobber it.
pub fn feature_config_path() -> Option<PathBuf> {
    let settings = app_settings_path()?;
    let dir = settings.parent()?;
    Some(dir.join(FEATURE_CONFIG_FILE))
}

/// Returns the feature config that should drive a rebuild. A saved per-user
/// picker selection wins; otherwise preserve the currently installed/bundled
/// feature selection from the builder bundle.
pub fn effective_feature_config_path(config: &RuntimeConfig) -> Option<PathBuf> {
    feature_config_path()
        .filter(|path| path.is_file())
        .or_else(|| {
            let bundled = config
                .builder_bundle_root
                .join("linux-features")
                .join(BUNDLED_FEATURE_CONFIG_FILE);
            bundled.is_file().then_some(bundled)
        })
}

/// Reads the user's "ask which features to enable on update" preference (the
/// in-app Update-button feature picker). Absent ⇒ `None` ⇒ caller defaults to
/// asking.
pub fn settings_feature_picker_on_update_override() -> Option<bool> {
    settings_bool_override(FEATURE_PICKER_ON_UPDATE_SETTING_KEY)
}

/// Persists the "Ask which features to enable on update" preference to the app
/// `settings.json`, merging into the existing object (preserving every other
/// key). Used to honor the picker's "Don't ask again" row. Never panics; returns
/// the IO/serialization error so the caller can log-and-continue.
pub fn write_feature_picker_on_update(value: bool) -> Result<()> {
    write_settings_bool(FEATURE_PICKER_ON_UPDATE_SETTING_KEY, value)
}

/// Read-modify-writes a boolean key into the app `settings.json`, preserving all
/// other keys. Creates the file (and parent dir) when absent. A malformed
/// existing file is replaced with a fresh object rather than failing.
fn write_settings_bool(key: &str, value: bool) -> Result<()> {
    let path = app_settings_path().context("could not resolve settings.json path")?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).with_context(|| format!("Failed to create {}", dir.display()))?;
    }
    let mut object = fs::read_to_string(&path)
        .ok()
        .and_then(|content| serde_json::from_str::<serde_json::Value>(&content).ok())
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    object.insert(key.to_string(), serde_json::Value::Bool(value));
    let serialized = serde_json::to_string_pretty(&serde_json::Value::Object(object))
        .context("Failed to serialize settings.json")?;
    fs::write(&path, format!("{serialized}\n"))
        .with_context(|| format!("Failed to write {}", path.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use anyhow::Result;
    use tempfile::tempdir;

    /// Writes `settings.json` content to a tempfile, points
    /// `CODEX_LINUX_SETTINGS_FILE` at it, and returns the override result.
    /// `None` content means "do not create the file" (missing-file case).
    fn override_with_settings(content: Option<&str>, key: &str) -> Option<bool> {
        let _guard = crate::test_util::env_lock();
        let temp = tempdir().expect("tempdir");
        let settings_path = temp.path().join("settings.json");
        if let Some(body) = content {
            std::fs::write(&settings_path, body).expect("write settings");
        }
        std::env::set_var("CODEX_LINUX_SETTINGS_FILE", &settings_path);
        let result = settings_bool_override(key);
        std::env::remove_var("CODEX_LINUX_SETTINGS_FILE");
        result
    }

    #[test]
    fn settings_override_reads_explicit_bool() {
        assert_eq!(
            override_with_settings(
                Some(r#"{"codex-linux-auto-update-on-exit": false}"#),
                AUTO_INSTALL_SETTING_KEY
            ),
            Some(false)
        );
        assert_eq!(
            override_with_settings(
                Some(r#"{"codex-linux-auto-update-on-exit": true}"#),
                AUTO_INSTALL_SETTING_KEY
            ),
            Some(true)
        );
    }

    #[test]
    fn settings_override_coerces_string_and_number() {
        assert_eq!(
            override_with_settings(
                Some(r#"{"codex-linux-auto-update-on-exit": "off"}"#),
                AUTO_INSTALL_SETTING_KEY
            ),
            Some(false)
        );
        assert_eq!(
            override_with_settings(
                Some(r#"{"codex-linux-auto-update-on-exit": "on"}"#),
                AUTO_INSTALL_SETTING_KEY
            ),
            Some(true)
        );
        assert_eq!(
            override_with_settings(
                Some(r#"{"codex-linux-auto-update-on-exit": 0}"#),
                AUTO_INSTALL_SETTING_KEY
            ),
            Some(false)
        );
        assert_eq!(
            override_with_settings(
                Some(r#"{"codex-linux-auto-update-on-exit": 1}"#),
                AUTO_INSTALL_SETTING_KEY
            ),
            Some(true)
        );
    }

    #[test]
    fn settings_override_absent_yields_none() {
        // Missing file, malformed JSON, non-object, and absent key all fall back.
        assert_eq!(override_with_settings(None, AUTO_INSTALL_SETTING_KEY), None);
        assert_eq!(
            override_with_settings(Some("not json{"), AUTO_INSTALL_SETTING_KEY),
            None
        );
        assert_eq!(
            override_with_settings(Some("[1,2,3]"), AUTO_INSTALL_SETTING_KEY),
            None
        );
        assert_eq!(
            override_with_settings(Some(r#"{"other-key": true}"#), AUTO_INSTALL_SETTING_KEY),
            None
        );
    }

    #[test]
    fn wrapper_settings_override_reads_explicit_bool() {
        assert_eq!(
            override_with_settings(
                Some(r#"{"codex-linux-wrapper-updates-enabled": true}"#),
                WRAPPER_UPDATES_SETTING_KEY
            ),
            Some(true)
        );
        assert_eq!(
            override_with_settings(
                Some(r#"{"codex-linux-wrapper-updates-enabled": false}"#),
                WRAPPER_UPDATES_SETTING_KEY
            ),
            Some(false)
        );
    }

    #[test]
    fn effective_feature_config_prefers_saved_picker_config_then_builder_config() -> Result<()> {
        let _guard = crate::test_util::env_lock();
        let temp = tempdir()?;
        let settings_dir = temp.path().join("settings");
        let settings_file = settings_dir.join("settings.json");
        let saved_feature_config = settings_dir.join("linux-features.json");
        let builder_feature_config = temp.path().join("builder/linux-features/features.json");

        fs::create_dir_all(builder_feature_config.parent().unwrap())?;
        fs::write(
            &builder_feature_config,
            r#"{"enabled":["codex-wrapper-updater"]}"#,
        )?;
        std::env::set_var("CODEX_LINUX_SETTINGS_FILE", &settings_file);

        let paths = RuntimePaths {
            config_file: temp.path().join("config/config.toml"),
            state_file: temp.path().join("state/state.json"),
            log_file: temp.path().join("state/service.log"),
            cache_dir: temp.path().join("cache"),
            state_dir: temp.path().join("state"),
            config_dir: temp.path().join("config"),
        };
        let mut config = RuntimeConfig::default_with_paths(&paths);
        config.builder_bundle_root = temp.path().join("builder");

        assert_eq!(
            effective_feature_config_path(&config),
            Some(builder_feature_config.clone())
        );

        fs::create_dir_all(&settings_dir)?;
        fs::write(&saved_feature_config, r#"{"enabled":["read-aloud"]}"#)?;
        assert_eq!(
            effective_feature_config_path(&config),
            Some(saved_feature_config)
        );

        std::env::remove_var("CODEX_LINUX_SETTINGS_FILE");
        Ok(())
    }

    #[test]
    fn loads_default_when_config_is_missing() -> Result<()> {
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
        assert_eq!(config.initial_check_delay_seconds, 30);
        assert!(config.auto_install_on_app_exit);
        assert_eq!(config.workspace_root, paths.cache_dir);
        assert!(config.builder_bundle_root.is_absolute());
        assert!(!config.generated_artifact_cleanup.enabled);
        assert_eq!(
            config.generated_artifact_cleanup.min_free_bytes,
            10 * 1024 * 1024 * 1024
        );
        assert_eq!(
            config.generated_artifact_cleanup.entries,
            vec![
                PathBuf::from("codex-app"),
                PathBuf::from("codex-app-next"),
                PathBuf::from("dist"),
                PathBuf::from("dist-next"),
                PathBuf::from("target"),
            ]
        );
        Ok(())
    }

    #[test]
    fn parses_runtime_config_from_disk() -> Result<()> {
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
initial_check_delay_seconds = 5
check_interval_hours = 12
auto_install_on_app_exit = false
notifications = false
workspace_root = "/tmp/codex-workspaces"
builder_bundle_root = "/tmp/codex-builder"
app_executable_path = "/opt/codex-desktop/electron"

[generated_artifact_cleanup]
enabled = true
min_free_bytes = 2147483648
roots = ["/home/mohit/Github/codex-desktop-linux"]
entries = ["dist", "target", "Codex.dmg"]
"#,
        )?;

        let config = RuntimeConfig::load_or_default(&paths)?;
        assert_eq!(config.dmg_url, "https://example.com/Codex.dmg");
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
        assert!(config.generated_artifact_cleanup.enabled);
        assert_eq!(config.generated_artifact_cleanup.min_free_bytes, 2147483648);
        assert_eq!(
            config.generated_artifact_cleanup.roots,
            vec![PathBuf::from("/home/mohit/Github/codex-desktop-linux")]
        );
        assert_eq!(
            config.generated_artifact_cleanup.entries,
            vec![
                PathBuf::from("dist"),
                PathBuf::from("target"),
                PathBuf::from("Codex.dmg"),
            ]
        );
        Ok(())
    }
}
