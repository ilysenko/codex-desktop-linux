//! Runtime Linux feature selection for app-driven update rebuilds.

use crate::config::{RuntimeConfig, RuntimePaths};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeSet,
    ffi::OsString,
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Command,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PromptHelper {
    Zenity,
    Kdialog,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum PromptHelperOutcome {
    Selected(Vec<String>),
    Cancelled,
    Unavailable,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FeatureConfig {
    pub enabled: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FeatureOption {
    pub id: String,
    pub title: String,
    pub description: String,
    pub enabled: bool,
    pub default_enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FeatureSelection {
    pub config_path: PathBuf,
    pub available: Vec<FeatureOption>,
    pub enabled: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PromptFeaturesOutcome {
    pub prompted: bool,
    pub changed: bool,
    pub cancelled: bool,
    pub selection: FeatureSelection,
}

#[derive(Debug, Deserialize)]
struct FeatureManifest {
    id: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default, rename = "defaultEnabled")]
    default_enabled: bool,
    #[serde(default)]
    hidden: bool,
}

pub fn user_features_config_path(paths: &RuntimePaths) -> PathBuf {
    paths.config_dir.join("features.json")
}

pub fn effective_enabled_feature_ids(
    config: &RuntimeConfig,
    paths: &RuntimePaths,
) -> Result<Vec<String>> {
    let path = user_features_config_path(paths);
    if path.exists() {
        return read_enabled_feature_ids(&path);
    }

    let bundled = bundled_features_config_path(config);
    if bundled.exists() {
        return read_enabled_feature_ids(&bundled);
    }

    Ok(Vec::new())
}

pub fn write_features_config(path: &Path, enabled: &[String]) -> Result<()> {
    let parent = path
        .parent()
        .with_context(|| format!("{} has no parent directory", path.display()))?;
    fs::create_dir_all(parent).with_context(|| format!("Failed to create {}", parent.display()))?;
    let config = FeatureConfig {
        enabled: normalize_feature_ids(enabled.iter().map(String::as_str)),
    };
    fs::write(
        path,
        format!("{}\n", serde_json::to_string_pretty(&config)?),
    )
    .with_context(|| format!("Failed to write {}", path.display()))
}

pub fn selection(config: &RuntimeConfig, paths: &RuntimePaths) -> Result<FeatureSelection> {
    let enabled = effective_enabled_feature_ids(config, paths)?;
    let enabled_set = enabled.iter().cloned().collect::<BTreeSet<_>>();
    let available = discover_feature_options(config)?
        .into_iter()
        .map(|mut option| {
            option.enabled = enabled_set.contains(&option.id);
            option
        })
        .collect::<Vec<_>>();

    Ok(FeatureSelection {
        config_path: user_features_config_path(paths),
        available,
        enabled,
    })
}

pub fn prompt_for_update(
    config: &RuntimeConfig,
    paths: &RuntimePaths,
) -> Result<PromptFeaturesOutcome> {
    let before = selection(config, paths)?;
    if before.available.is_empty() || !has_graphical_session() {
        return Ok(PromptFeaturesOutcome {
            prompted: false,
            changed: false,
            cancelled: false,
            selection: before,
        });
    }

    let enabled = match prompt_with_available_helper(&before.available)? {
        PromptHelperOutcome::Selected(enabled) => enabled,
        PromptHelperOutcome::Cancelled => {
            return Ok(PromptFeaturesOutcome {
                prompted: true,
                changed: false,
                cancelled: true,
                selection: before,
            });
        }
        PromptHelperOutcome::Unavailable => {
            return Ok(PromptFeaturesOutcome {
                prompted: false,
                changed: false,
                cancelled: false,
                selection: before,
            });
        }
    };

    let enabled = normalize_feature_ids(enabled.iter().map(String::as_str));
    let changed = enabled != before.enabled;
    if changed {
        write_features_config(&before.config_path, &enabled)?;
    }

    Ok(PromptFeaturesOutcome {
        prompted: true,
        changed,
        cancelled: false,
        selection: selection(config, paths)?,
    })
}

fn bundled_features_config_path(config: &RuntimeConfig) -> PathBuf {
    config
        .builder_bundle_root
        .join("linux-features")
        .join("features.json")
}

fn read_enabled_feature_ids(path: &Path) -> Result<Vec<String>> {
    let contents =
        fs::read_to_string(path).with_context(|| format!("Failed to read {}", path.display()))?;
    let config = serde_json::from_str::<FeatureConfig>(&contents)
        .with_context(|| format!("Failed to parse {}", path.display()))?;
    Ok(normalize_feature_ids(
        config.enabled.iter().map(String::as_str),
    ))
}

fn discover_feature_options(config: &RuntimeConfig) -> Result<Vec<FeatureOption>> {
    let root = config.builder_bundle_root.join("linux-features");
    let mut options = Vec::new();
    if !root.is_dir() {
        return Ok(options);
    }

    for entry in
        fs::read_dir(&root).with_context(|| format!("Failed to read {}", root.display()))?
    {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let manifest_path = entry.path().join("feature.json");
        if !manifest_path.is_file() {
            continue;
        }
        let contents = fs::read_to_string(&manifest_path)
            .with_context(|| format!("Failed to read {}", manifest_path.display()))?;
        let manifest = serde_json::from_str::<FeatureManifest>(&contents)
            .with_context(|| format!("Failed to parse {}", manifest_path.display()))?;
        if manifest.hidden {
            continue;
        }
        if !is_valid_feature_id(&manifest.id) {
            continue;
        }
        let title = manifest
            .title
            .or(manifest.name)
            .unwrap_or_else(|| manifest.id.clone());
        options.push(FeatureOption {
            id: manifest.id,
            title,
            description: manifest.description.unwrap_or_default(),
            enabled: false,
            default_enabled: manifest.default_enabled,
        });
    }

    options.sort_by(|left, right| left.title.cmp(&right.title).then(left.id.cmp(&right.id)));
    Ok(options)
}

fn prompt_with_available_helper(options: &[FeatureOption]) -> Result<PromptHelperOutcome> {
    let helper = choose_prompt_helper(
        prefers_kdialog(),
        command_in_path("zenity").is_some(),
        command_in_path("kdialog").is_some(),
    );
    match helper {
        Some(PromptHelper::Zenity) => run_zenity_checklist(options),
        Some(PromptHelper::Kdialog) => run_kdialog_checklist(options),
        None => Ok(PromptHelperOutcome::Unavailable),
    }
}

fn choose_prompt_helper(
    prefers_kdialog: bool,
    has_zenity: bool,
    has_kdialog: bool,
) -> Option<PromptHelper> {
    if prefers_kdialog && has_kdialog {
        return Some(PromptHelper::Kdialog);
    }
    if has_zenity {
        return Some(PromptHelper::Zenity);
    }
    if has_kdialog {
        return Some(PromptHelper::Kdialog);
    }
    None
}

fn run_zenity_checklist(options: &[FeatureOption]) -> Result<PromptHelperOutcome> {
    let mut command = Command::new("zenity");
    command.args([
        "--list",
        "--checklist",
        "--title=Codex Desktop update",
        "--text=Choose optional Linux features for this update rebuild.",
        "--column=Use",
        "--column=Id",
        "--column=Feature",
        "--column=Description",
        "--hide-column=2",
        "--print-column=2",
        "--separator=,",
    ]);
    for option in options {
        command
            .arg(if option.enabled { "TRUE" } else { "FALSE" })
            .arg(&option.id)
            .arg(&option.title)
            .arg(option.description.trim());
    }

    let output = command.output().context("Failed to launch zenity")?;
    if !output.status.success() {
        return Ok(PromptHelperOutcome::Cancelled);
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(PromptHelperOutcome::Selected(
        stdout
            .trim()
            .split(',')
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .collect(),
    ))
}

fn run_kdialog_checklist(options: &[FeatureOption]) -> Result<PromptHelperOutcome> {
    let mut command = Command::new("kdialog");
    command.args([
        "--title",
        "Codex Desktop update",
        "--checklist",
        "Choose optional Linux features for this update rebuild.",
    ]);
    for option in options {
        command
            .arg(&option.id)
            .arg(feature_prompt_label(option))
            .arg(if option.enabled { "on" } else { "off" });
    }

    let output = command.output().context("Failed to launch kdialog")?;
    if !output.status.success() {
        return Ok(PromptHelperOutcome::Cancelled);
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(PromptHelperOutcome::Selected(
        stdout
            .split_whitespace()
            .map(|value| value.trim_matches('"').to_string())
            .filter(|value| !value.is_empty())
            .collect(),
    ))
}

fn feature_prompt_label(option: &FeatureOption) -> String {
    if option.description.trim().is_empty() {
        return option.title.clone();
    }
    format!("{} - {}", option.title, option.description)
}

fn normalize_feature_ids<'a>(ids: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    let mut seen = BTreeSet::new();
    ids.into_iter()
        .map(str::trim)
        .filter(|id| is_valid_feature_id(id))
        .filter(|id| seen.insert((*id).to_string()))
        .map(str::to_string)
        .collect()
}

fn is_valid_feature_id(id: &str) -> bool {
    let mut chars = id.chars();
    matches!(chars.next(), Some(ch) if ch.is_ascii_lowercase() || ch.is_ascii_digit())
        && chars.all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-')
}

fn has_graphical_session() -> bool {
    let has_display =
        std::env::var_os("DISPLAY").is_some() || std::env::var_os("WAYLAND_DISPLAY").is_some();
    let has_dbus = std::env::var_os("DBUS_SESSION_BUS_ADDRESS").is_some()
        || std::env::var_os("XDG_RUNTIME_DIR").is_some();
    has_display && has_dbus
}

fn prefers_kdialog() -> bool {
    desktop_tokens().iter().any(|token| {
        matches!(
            token.as_str(),
            "kde" | "plasma" | "plasmawayland" | "plasmax11"
        )
    })
}

fn desktop_tokens() -> Vec<String> {
    [
        std::env::var("XDG_CURRENT_DESKTOP").ok(),
        std::env::var("DESKTOP_SESSION").ok(),
    ]
    .into_iter()
    .flatten()
    .flat_map(|value| {
        value
            .split(':')
            .map(|segment| segment.trim().to_ascii_lowercase())
            .collect::<Vec<_>>()
    })
    .filter(|token| !token.is_empty())
    .collect()
}

fn command_in_path(name: &str) -> Option<PathBuf> {
    let path_env = std::env::var_os("PATH").unwrap_or_else(|| OsString::from(""));
    std::env::split_paths(&path_env).find_map(|entry| {
        let candidate = entry.join(name);
        if is_executable_file(&candidate) {
            Some(candidate)
        } else {
            None
        }
    })
}

fn is_executable_file(path: &Path) -> bool {
    path.is_file()
        && path
            .metadata()
            .map(|metadata| metadata.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn test_paths(root: &Path) -> RuntimePaths {
        RuntimePaths {
            config_file: root.join("config/config.toml"),
            state_file: root.join("state/state.json"),
            log_file: root.join("state/service.log"),
            cache_dir: root.join("cache"),
            state_dir: root.join("state"),
            config_dir: root.join("config"),
        }
    }

    fn test_config(root: &Path) -> RuntimeConfig {
        RuntimeConfig {
            dmg_url: "https://example.com/Codex.dmg".to_string(),
            initial_check_delay_seconds: 1,
            check_interval_hours: 6,
            auto_install_on_app_exit: true,
            notifications: false,
            workspace_root: root.join("cache"),
            builder_bundle_root: root.join("builder"),
            app_executable_path: root.join("not-running-electron"),
        }
    }

    #[test]
    fn reads_user_feature_config_before_bundled_default() -> Result<()> {
        let temp = tempdir()?;
        let paths = test_paths(temp.path());
        let config = test_config(temp.path());
        let bundled = config
            .builder_bundle_root
            .join("linux-features")
            .join("features.json");
        write_features_config(&bundled, &["read-aloud".to_string()])?;
        write_features_config(
            &user_features_config_path(&paths),
            &["remote-control-ui".to_string()],
        )?;

        assert_eq!(
            effective_enabled_feature_ids(&config, &paths)?,
            vec!["remote-control-ui"]
        );
        Ok(())
    }

    #[test]
    fn discovers_feature_manifest_options() -> Result<()> {
        let temp = tempdir()?;
        let paths = test_paths(temp.path());
        let config = test_config(temp.path());
        let feature_dir = config.builder_bundle_root.join("linux-features/read-aloud");
        fs::create_dir_all(&feature_dir)?;
        fs::write(
            feature_dir.join("feature.json"),
            r#"{
  "id": "read-aloud",
  "title": "Read Aloud",
  "description": "Speak assistant responses",
  "defaultEnabled": false
}"#,
        )?;
        write_features_config(
            &user_features_config_path(&paths),
            &["read-aloud".to_string()],
        )?;

        let selection = selection(&config, &paths)?;

        assert_eq!(selection.enabled, vec!["read-aloud"]);
        assert_eq!(selection.available.len(), 1);
        assert!(selection.available[0].enabled);
        assert_eq!(selection.available[0].title, "Read Aloud");
        Ok(())
    }

    #[test]
    fn hidden_feature_manifests_are_not_prompted() -> Result<()> {
        let temp = tempdir()?;
        let config = test_config(temp.path());
        let feature_dir = config
            .builder_bundle_root
            .join("linux-features/example-feature");
        fs::create_dir_all(&feature_dir)?;
        fs::write(
            feature_dir.join("feature.json"),
            r#"{
  "id": "example-feature",
  "title": "Example Linux Feature",
  "description": "Developer-only fixture",
  "hidden": true
}"#,
        )?;

        assert!(discover_feature_options(&config)?.is_empty());
        Ok(())
    }

    #[test]
    fn prompt_helper_selection_degrades_when_dialog_helpers_are_missing() {
        assert_eq!(choose_prompt_helper(false, false, false), None);
        assert_eq!(
            choose_prompt_helper(false, true, false),
            Some(PromptHelper::Zenity)
        );
        assert_eq!(
            choose_prompt_helper(true, true, true),
            Some(PromptHelper::Kdialog)
        );
        assert_eq!(
            choose_prompt_helper(false, false, true),
            Some(PromptHelper::Kdialog)
        );
    }
}
