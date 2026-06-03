//! Interactive feature picker for the in-app wrapper Update button.
//!
//! When the user clicks the wrapper "Update" button, the renderer shells out to
//! `codex-update-manager pick-features` *while the display is still alive* (the
//! detached `apply-wrapper-update` runs after the app exits → headless, so the
//! dialog must run here, at click time). This subcommand:
//!
//! 1. Locates a wrapper source checkout that ships the feature catalog
//!    (`scripts/lib/linux-features.js` + the `linux-features/<id>/feature.json`
//!    set). When an update candidate is recorded, it prepares that candidate
//!    source first so the picker reflects the build that will actually run. A
//!    manual `pick-features` invocation without a candidate falls back to the
//!    installed builder bundle.
//! 2. Reads the catalog (`--features-json`) and the currently-enabled set
//!    (the saved `linux-features.json`, else `--enabled`).
//! 3. Shows a zenity/kdialog checklist pre-checked with the enabled set, plus a
//!    sentinel "(Don't ask again …)" row.
//! 4. Writes the chosen `{"enabled":[…]}` to [`config::feature_config_path`] so
//!    the rebuild (which points `CODEX_LINUX_FEATURES_CONFIG` at that path) uses
//!    the selection. If the sentinel row was checked, persists
//!    `codex-linux-feature-picker-on-update=false` so future updates skip the
//!    prompt.
//!
//! Every failure mode (no display, no dialog tool, no catalog, cancelled dialog,
//! or dialog launch failure) is a graceful skip that leaves the current feature
//! set unchanged — the picker must never block or fail the update it precedes.

use anyhow::{Context, Result};
use std::{
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Command,
};
use tracing::{info, warn};

use crate::{
    config::{self, RuntimeConfig, RuntimePaths},
    state::PersistedState,
    wrapper_apply,
};

/// Sentinel checklist row id for "don't ask again". Contains underscores so it
/// can never collide with a real feature id (`^[a-z0-9][a-z0-9-]*$`).
const DONT_ASK_SENTINEL: &str = "__dont_ask_again__";
const DONT_ASK_LABEL: &str = "(Don't ask again on future updates)";

/// A catalog feature row (id + human title) read from `--features-json`.
struct CatalogEntry {
    id: String,
    title: String,
}

/// Outcome of `run_pick_features`, surfaced as JSON when `--json` is passed.
enum PickOutcome {
    Skipped(&'static str),
    Picked { count: usize, dont_ask: bool },
}

/// Runs the feature picker. Returns `Ok(())` in every non-panic case; a skip
/// (no display, no dialog tool, no catalog, cancelled) leaves features unchanged.
pub fn run_pick_features(config: &RuntimeConfig, paths: &RuntimePaths, json: bool) -> Result<()> {
    let outcome = pick(config, paths)?;
    if json {
        match &outcome {
            PickOutcome::Skipped(reason) => {
                println!("{{\"ok\":true,\"skipped\":\"{reason}\"}}");
            }
            PickOutcome::Picked { count, dont_ask } => {
                println!("{{\"ok\":true,\"picked\":{count},\"dont_ask\":{dont_ask}}}");
            }
        }
    }
    Ok(())
}

fn pick(config: &RuntimeConfig, paths: &RuntimePaths) -> Result<PickOutcome> {
    // Defensive double-gate: the button already checks this, but honor it here
    // too so a stray invocation can't re-prompt after "don't ask again".
    if config::settings_feature_picker_on_update_override() == Some(false) {
        return Ok(PickOutcome::Skipped("disabled"));
    }
    if !has_display() {
        return Ok(PickOutcome::Skipped("no-display"));
    }
    let Some(tool) = dialog_tool() else {
        return Ok(PickOutcome::Skipped("no-dialog-tool"));
    };
    // Try each allowed source in turn; the first that yields a non-empty catalog
    // wins. If a wrapper-update candidate is recorded, candidate_sources()
    // returns only that prepared candidate checkout so the picker cannot fall
    // back to the installed wrapper catalog.
    let mut chosen: Option<(PathBuf, Vec<CatalogEntry>)> = None;
    for source in candidate_sources(config, paths) {
        match read_catalog(config, &source) {
            Ok(catalog) if !catalog.is_empty() => {
                chosen = Some((source, catalog));
                break;
            }
            Ok(_) => continue,
            Err(error) => {
                warn!(?error, source = %source.display(), "feature picker could not read catalog from this source");
                continue;
            }
        }
    }
    let Some((source, catalog)) = chosen else {
        return Ok(PickOutcome::Skipped("no-catalog"));
    };
    let enabled = read_enabled(config, &source);

    match show_picker(&tool, &catalog, &enabled)? {
        None => {
            info!("feature picker cancelled; feature set unchanged");
            Ok(PickOutcome::Skipped("cancelled"))
        }
        Some(selection) => {
            let dont_ask = selection.iter().any(|id| id == DONT_ASK_SENTINEL);
            let catalog_ids: std::collections::HashSet<&str> =
                catalog.iter().map(|entry| entry.id.as_str()).collect();
            let mut picked: Vec<String> = selection
                .into_iter()
                .filter(|id| id != DONT_ASK_SENTINEL && catalog_ids.contains(id.as_str()))
                .collect();
            picked.extend(
                enabled
                    .iter()
                    .filter(|id| id.as_str() != DONT_ASK_SENTINEL)
                    .filter(|id| !catalog_ids.contains(id.as_str()))
                    .cloned(),
            );
            picked.sort();
            picked.dedup();

            write_feature_config(&picked)?;
            if dont_ask {
                if let Err(error) = config::write_feature_picker_on_update(false) {
                    warn!(?error, "could not persist don't-ask-again preference");
                }
            }
            info!(
                count = picked.len(),
                dont_ask, "feature picker selection saved"
            );
            Ok(PickOutcome::Picked {
                count: picked.len(),
                dont_ask,
            })
        }
    }
}

/// True when an X11 or Wayland display is available for a GUI dialog.
fn has_display() -> bool {
    ["DISPLAY", "WAYLAND_DISPLAY"].iter().any(|var| {
        std::env::var(var)
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false)
    })
}

/// The dialog helper to use, preferring zenity then kdialog (PATH lookup).
fn dialog_tool() -> Option<DialogTool> {
    if which("zenity").is_some() {
        Some(DialogTool::Zenity)
    } else if which("kdialog").is_some() {
        Some(DialogTool::Kdialog)
    } else {
        None
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DialogTool {
    Zenity,
    Kdialog,
}

/// Candidate wrapper source checkouts that ship the feature catalog. When a
/// wrapper update candidate is recorded, fetch that candidate source first so
/// the picker shows the features that will actually be rebuilt. Without a
/// recorded candidate, fall back to the installed builder bundle for manual
/// `pick-features` invocations.
fn candidate_sources(config: &RuntimeConfig, paths: &RuntimePaths) -> Vec<PathBuf> {
    let candidate_commit =
        PersistedState::load_or_default(&paths.state_file, config.auto_install_on_app_exit)
            .ok()
            .and_then(|state| state.candidate_wrapper_commit);

    if let Some(candidate_commit) = candidate_commit.as_deref() {
        return match wrapper_apply::ensure_wrapper_source(config, paths, Some(candidate_commit)) {
            Ok(source) if source.join("scripts/lib/linux-features.js").is_file() => vec![source],
            Ok(_) => Vec::new(),
            Err(error) => {
                warn!(
                    ?error,
                    "feature picker could not prepare candidate wrapper source"
                );
                Vec::new()
            }
        };
    }

    [config.builder_bundle_root.clone()]
        .into_iter()
        .filter(|dir| dir.join("scripts/lib/linux-features.js").is_file())
        .collect()
}

/// Resolves a node binary: the bundle's managed runtime first, then PATH.
fn node_binary(config: &RuntimeConfig) -> PathBuf {
    let managed = config.builder_bundle_root.join("node-runtime/bin/node");
    if managed.is_file() {
        return managed;
    }
    which("node").unwrap_or_else(|| PathBuf::from("node"))
}

/// Reads the full feature catalog via `linux-features.js --features-json`.
fn read_catalog(config: &RuntimeConfig, source: &Path) -> Result<Vec<CatalogEntry>> {
    let script = source.join("scripts/lib/linux-features.js");
    let output = Command::new(node_binary(config))
        .arg(&script)
        .arg("--features-json")
        .output()
        .with_context(|| format!("Failed to run {}", script.display()))?;
    if !output.status.success() {
        anyhow::bail!(
            "linux-features.js --features-json exited with {}",
            output.status
        );
    }
    let parsed = serde_json::from_slice::<serde_json::Value>(&output.stdout)
        .context("Failed to parse --features-json output")?;
    let array = parsed
        .as_array()
        .context("--features-json did not return an array")?;
    let mut entries = Vec::new();
    for item in array {
        let Some(id) = item.get("id").and_then(|value| value.as_str()) else {
            continue;
        };
        let title = item
            .get("title")
            .and_then(|value| value.as_str())
            .filter(|title| !title.is_empty())
            .unwrap_or(id)
            .to_string();
        entries.push(CatalogEntry {
            id: id.to_string(),
            title: sanitize_label(&title),
        });
    }
    Ok(entries)
}

/// Reads the currently-enabled feature ids. Prefers the saved picker config,
/// then the installed builder bundle's preserved feature config, then
/// `linux-features.js --enabled` from the selected source. Errors degrade to an
/// empty set.
fn read_enabled(config: &RuntimeConfig, source: &Path) -> std::collections::HashSet<String> {
    if let Some(path) = config::effective_feature_config_path(config) {
        if let Ok(content) = std::fs::read_to_string(&path) {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&content) {
                if let Some(array) = value.get("enabled").and_then(|v| v.as_array()) {
                    return array
                        .iter()
                        .filter_map(|item| item.as_str())
                        .map(|s| s.to_string())
                        .collect();
                }
            }
        }
    }

    let script = source.join("scripts/lib/linux-features.js");
    let Ok(output) = Command::new(node_binary(config))
        .arg(&script)
        .arg("--enabled")
        .output()
    else {
        return std::collections::HashSet::new();
    };
    if !output.status.success() {
        return std::collections::HashSet::new();
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(|line| line.trim().to_string())
        .filter(|line| !line.is_empty())
        .collect()
}

/// Shows the checklist. Returns `Some(selected ids incl. maybe the sentinel)` on
/// OK, or `None` when the user cancelled (nonzero dialog exit).
fn show_picker(
    tool: &DialogTool,
    catalog: &[CatalogEntry],
    enabled: &std::collections::HashSet<String>,
) -> Result<Option<Vec<String>>> {
    let output = match tool {
        DialogTool::Zenity => {
            let mut cmd = Command::new("zenity");
            cmd.args([
                "--list",
                "--checklist",
                "--title=Codex Desktop Linux features",
                "--text=Select the optional Linux features to enable for this update.",
                "--column=Enable",
                "--column=Feature",
                "--column=Description",
                "--print-column=2",
                "--separator=\n",
            ]);
            for entry in catalog {
                cmd.arg(if enabled.contains(&entry.id) {
                    "TRUE"
                } else {
                    "FALSE"
                });
                cmd.arg(&entry.id);
                cmd.arg(&entry.title);
            }
            // Sentinel "don't ask again" row, unchecked by default.
            cmd.arg("FALSE").arg(DONT_ASK_SENTINEL).arg(DONT_ASK_LABEL);
            match cmd.output() {
                Ok(output) => output,
                Err(error) => {
                    warn!(?error, "feature picker could not launch zenity");
                    return Ok(None);
                }
            }
        }
        DialogTool::Kdialog => {
            let mut cmd = Command::new("kdialog");
            cmd.args([
                "--separate-output",
                "--checklist",
                "Select the optional Linux features to enable for this update.",
            ]);
            for entry in catalog {
                cmd.arg(&entry.id);
                cmd.arg(&entry.title);
                cmd.arg(if enabled.contains(&entry.id) {
                    "on"
                } else {
                    "off"
                });
            }
            cmd.arg(DONT_ASK_SENTINEL).arg(DONT_ASK_LABEL).arg("off");
            match cmd.output() {
                Ok(output) => output,
                Err(error) => {
                    warn!(?error, "feature picker could not launch kdialog");
                    return Ok(None);
                }
            }
        }
    };

    if !output.status.success() {
        // Nonzero exit = user cancelled (or dialog error) → treat as cancel.
        return Ok(None);
    }
    let ids = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(|line| line.trim().trim_matches('"').to_string())
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>();
    Ok(Some(ids))
}

/// Writes the chosen enabled set to the stable feature-config path.
fn write_feature_config(enabled: &[String]) -> Result<()> {
    let path = config::feature_config_path().context("could not resolve feature config path")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .with_context(|| format!("Failed to create {}", dir.display()))?;
    }
    let value = serde_json::json!({ "enabled": enabled });
    let serialized =
        serde_json::to_string_pretty(&value).context("Failed to serialize feature config")?;
    std::fs::write(&path, format!("{serialized}\n"))
        .with_context(|| format!("Failed to write {}", path.display()))?;
    Ok(())
}

/// Strips tab/newline from a label so it can't break dialog column parsing.
fn sanitize_label(label: &str) -> String {
    label.replace(['\t', '\n', '\r'], " ").trim().to_string()
}

/// Minimal PATH lookup for an executable (no extra deps).
fn which(tool: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(tool);
        if candidate.is_file()
            && candidate
                .metadata()
                .is_ok_and(|metadata| metadata.permissions().mode() & 0o111 != 0)
        {
            return Some(candidate);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_util::env_lock;
    use std::os::unix::fs::PermissionsExt;
    use tempfile::tempdir;

    fn base_config(bundle_root: &Path) -> RuntimeConfig {
        let paths = RuntimePaths {
            config_file: bundle_root.join("config.toml"),
            state_file: bundle_root.join("state.json"),
            log_file: bundle_root.join("log"),
            cache_dir: bundle_root.join("cache"),
            state_dir: bundle_root.join("state"),
            config_dir: bundle_root.join("config"),
        };
        let mut config = RuntimeConfig::default_with_paths(&paths);
        config.builder_bundle_root = bundle_root.to_path_buf();
        config
    }

    fn runtime_paths(root: &Path) -> RuntimePaths {
        RuntimePaths {
            config_file: root.join("config.toml"),
            state_file: root.join("state.json"),
            log_file: root.join("log"),
            cache_dir: root.join("cache"),
            state_dir: root.join("state"),
            config_dir: root.join("config"),
        }
    }

    /// Writes a fake `scripts/lib/linux-features.js` that emits a fixed catalog
    /// for `--features-json` and a fixed enabled list for `--enabled`.
    fn write_fake_catalog_script(source: &Path) {
        let script_dir = source.join("scripts/lib");
        std::fs::create_dir_all(&script_dir).unwrap();
        std::fs::write(
            script_dir.join("linux-features.js"),
            r#"
const arg = process.argv[2];
if (arg === "--features-json") {
  process.stdout.write(JSON.stringify([
    {"id":"alpha","title":"Alpha Feature"},
    {"id":"beta","title":"Beta Feature"}
  ]));
} else if (arg === "--enabled") {
  process.stdout.write("alpha\n");
}
"#,
        )
        .unwrap();
    }

    fn git(repo: &Path, args: &[&str]) {
        let status = Command::new("git")
            .current_dir(repo)
            .args(args)
            .status()
            .expect("git should run");
        assert!(status.success(), "git {args:?} failed with {status}");
    }

    fn init_fake_catalog_repo(repo: &Path) -> String {
        git(repo, &["init", "-q", "-b", "main"]);
        git(repo, &["config", "user.email", "codex@example.invalid"]);
        git(repo, &["config", "user.name", "Codex Test"]);
        write_fake_catalog_script(repo);
        git(repo, &["add", "-A"]);
        git(repo, &["commit", "-q", "-m", "catalog"]);
        let output = Command::new("git")
            .current_dir(repo)
            .args(["rev-parse", "HEAD"])
            .output()
            .expect("git rev-parse should run");
        assert!(output.status.success());
        String::from_utf8(output.stdout).unwrap().trim().to_string()
    }

    /// Installs a fake dialog tool on a temp PATH that echoes `stdout_lines` and
    /// exits with `exit_code`. Returns the temp dir (keep alive) and the PATH.
    fn fake_dialog(
        name: &str,
        stdout_lines: &str,
        exit_code: i32,
    ) -> (tempfile::TempDir, std::ffi::OsString) {
        let dir = tempdir().unwrap();
        let bin = dir.path().join(name);
        std::fs::write(
            &bin,
            format!("#!/bin/sh\nprintf '%s' \"{stdout_lines}\"\nexit {exit_code}\n"),
        )
        .unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        let path = dir.path().as_os_str().to_os_string();
        (dir, path)
    }

    #[test]
    fn skips_without_display() {
        let _g = env_lock();
        std::env::remove_var("DISPLAY");
        std::env::remove_var("WAYLAND_DISPLAY");
        let root = tempdir().unwrap();
        let config = base_config(root.path());
        let paths = runtime_paths(root.path());
        // No display -> Ok, no config written.
        run_pick_features(&config, &paths, false).unwrap();
        assert!(!root
            .path()
            .join("config/codex-desktop/linux-features.json")
            .exists());
    }

    #[test]
    fn candidate_sources_prefers_bundle_with_catalog_script() {
        let root = tempdir().unwrap();
        let config = base_config(root.path());
        let paths = runtime_paths(root.path());
        assert!(candidate_sources(&config, &paths).is_empty());
        write_fake_catalog_script(root.path());
        assert_eq!(
            candidate_sources(&config, &paths),
            vec![root.path().to_path_buf()]
        );
    }

    #[test]
    fn candidate_sources_uses_recorded_candidate_checkout() {
        let _g = env_lock();
        let root = tempdir().unwrap();
        let remote = tempdir().unwrap();
        let paths = runtime_paths(root.path());
        paths.ensure_dirs().unwrap();
        write_fake_catalog_script(root.path());
        let commit = init_fake_catalog_repo(remote.path());

        let mut config = base_config(root.path());
        config.wrapper_remote =
            format!("file://{}", remote.path().canonicalize().unwrap().display());
        let mut state = PersistedState::new(true);
        state.candidate_wrapper_commit = Some(commit);
        state.save(&paths.state_file).unwrap();

        assert_eq!(
            candidate_sources(&config, &paths),
            vec![paths.cache_dir.join("wrapper-src")]
        );
    }

    #[test]
    fn candidate_sources_do_not_fallback_when_recorded_candidate_cannot_be_prepared() {
        let _g = env_lock();
        let root = tempdir().unwrap();
        let paths = runtime_paths(root.path());
        paths.ensure_dirs().unwrap();
        write_fake_catalog_script(root.path());

        let config = base_config(root.path());
        let mut state = PersistedState::new(true);
        state.candidate_wrapper_commit = Some("a".repeat(40));
        state.save(&paths.state_file).unwrap();

        let empty_path = tempdir().unwrap();
        let previous_path = std::env::var_os("PATH");
        std::env::set_var("PATH", empty_path.path());

        let sources = candidate_sources(&config, &paths);

        if let Some(previous_path) = previous_path {
            std::env::set_var("PATH", previous_path);
        } else {
            std::env::remove_var("PATH");
        }

        assert!(
            sources.is_empty(),
            "recorded candidate failures must not use the installed catalog"
        );
    }

    #[test]
    fn enabled_reads_builder_feature_config_when_saved_picker_config_is_absent() {
        let _g = env_lock();
        let root = tempdir().unwrap();
        let settings = tempdir().unwrap();
        write_fake_catalog_script(root.path());
        let builder_config = root.path().join("linux-features/features.json");
        std::fs::create_dir_all(builder_config.parent().unwrap()).unwrap();
        std::fs::write(&builder_config, r#"{"enabled":["alpha"]}"#).unwrap();

        let settings_file = settings.path().join("settings.json");
        std::env::set_var("CODEX_LINUX_SETTINGS_FILE", &settings_file);
        let config = base_config(root.path());

        assert_eq!(
            read_enabled(&config, root.path()),
            std::collections::HashSet::from(["alpha".to_string()])
        );

        std::env::remove_var("CODEX_LINUX_SETTINGS_FILE");
    }

    #[test]
    fn selection_writes_feature_config_outside_wrapper_src() {
        let _g = env_lock();
        let root = tempdir().unwrap();
        let settings = tempdir().unwrap();
        write_fake_catalog_script(root.path());
        let config = base_config(root.path());
        let paths = runtime_paths(root.path());

        // Pin settings.json (and thus feature_config_path) into a temp dir.
        let settings_file = settings.path().join("settings.json");
        std::env::set_var("CODEX_LINUX_SETTINGS_FILE", &settings_file);
        std::env::set_var("DISPLAY", ":99");
        std::env::remove_var("WAYLAND_DISPLAY");

        // zenity selects beta + alpha (no sentinel).
        let (_d, fake_path) = fake_dialog("zenity", "beta\nalpha", 0);
        let prev_path = std::env::var_os("PATH");
        let mut joined = fake_path.clone();
        if let Some(prev) = &prev_path {
            joined.push(":");
            joined.push(prev);
        }
        std::env::set_var("PATH", &joined);

        run_pick_features(&config, &paths, false).unwrap();

        // feature_config_path is alongside settings.json, NOT under wrapper-src.
        let written = settings.path().join("linux-features.json");
        assert!(written.is_file(), "feature config must be written");
        assert!(!root.path().join("linux-features.json").exists());
        let value: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&written).unwrap()).unwrap();
        let enabled: Vec<String> = value["enabled"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_string())
            .collect();
        assert_eq!(enabled, vec!["alpha".to_string(), "beta".to_string()]);
        // Picker-on-update setting untouched (no sentinel selected).
        let settings_json: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&settings_file).unwrap_or_default())
                .unwrap_or(serde_json::json!({}));
        assert!(settings_json
            .get("codex-linux-feature-picker-on-update")
            .is_none());

        if let Some(prev) = prev_path {
            std::env::set_var("PATH", prev);
        }
        std::env::remove_var("CODEX_LINUX_SETTINGS_FILE");
        std::env::remove_var("DISPLAY");
    }

    #[test]
    fn selection_preserves_unknown_existing_feature_ids() {
        let _g = env_lock();
        let root = tempdir().unwrap();
        let settings = tempdir().unwrap();
        write_fake_catalog_script(root.path());
        let config = base_config(root.path());
        let paths = runtime_paths(root.path());

        let settings_file = settings.path().join("settings.json");
        let feature_config = settings.path().join("linux-features.json");
        std::fs::write(
            &feature_config,
            r#"{
  "enabled": ["alpha", "private-local-feature"]
}
"#,
        )
        .unwrap();
        std::env::set_var("CODEX_LINUX_SETTINGS_FILE", &settings_file);
        std::env::set_var("DISPLAY", ":99");
        std::env::remove_var("WAYLAND_DISPLAY");

        let (_d, fake_path) = fake_dialog("zenity", "beta", 0);
        let prev_path = std::env::var_os("PATH");
        let mut joined = fake_path.clone();
        if let Some(prev) = &prev_path {
            joined.push(":");
            joined.push(prev);
        }
        std::env::set_var("PATH", &joined);

        run_pick_features(&config, &paths, false).unwrap();

        let value: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&feature_config).unwrap()).unwrap();
        let enabled: Vec<String> = value["enabled"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_string())
            .collect();
        assert_eq!(
            enabled,
            vec!["beta".to_string(), "private-local-feature".to_string()]
        );

        if let Some(prev) = prev_path {
            std::env::set_var("PATH", prev);
        }
        std::env::remove_var("CODEX_LINUX_SETTINGS_FILE");
        std::env::remove_var("DISPLAY");
    }

    #[test]
    fn dont_ask_sentinel_writes_setting() {
        let _g = env_lock();
        let root = tempdir().unwrap();
        let settings = tempdir().unwrap();
        write_fake_catalog_script(root.path());
        let config = base_config(root.path());
        let paths = runtime_paths(root.path());

        let settings_file = settings.path().join("settings.json");
        std::env::set_var("CODEX_LINUX_SETTINGS_FILE", &settings_file);
        std::env::set_var("DISPLAY", ":99");
        std::env::remove_var("WAYLAND_DISPLAY");

        // Selection includes the sentinel + alpha.
        let (_d, fake_path) = fake_dialog("zenity", "alpha\n__dont_ask_again__", 0);
        let prev_path = std::env::var_os("PATH");
        let mut joined = fake_path.clone();
        if let Some(prev) = &prev_path {
            joined.push(":");
            joined.push(prev);
        }
        std::env::set_var("PATH", &joined);

        run_pick_features(&config, &paths, false).unwrap();

        let written = settings.path().join("linux-features.json");
        let value: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&written).unwrap()).unwrap();
        let enabled: Vec<String> = value["enabled"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_string())
            .collect();
        // Sentinel stripped, only real feature id remains.
        assert_eq!(enabled, vec!["alpha".to_string()]);
        let settings_json: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&settings_file).unwrap()).unwrap();
        assert_eq!(
            settings_json["codex-linux-feature-picker-on-update"],
            serde_json::Value::Bool(false)
        );

        if let Some(prev) = prev_path {
            std::env::set_var("PATH", prev);
        }
        std::env::remove_var("CODEX_LINUX_SETTINGS_FILE");
        std::env::remove_var("DISPLAY");
    }

    #[test]
    fn cancel_leaves_config_unchanged() {
        let _g = env_lock();
        let root = tempdir().unwrap();
        let settings = tempdir().unwrap();
        write_fake_catalog_script(root.path());
        let config = base_config(root.path());
        let paths = runtime_paths(root.path());

        let settings_file = settings.path().join("settings.json");
        std::env::set_var("CODEX_LINUX_SETTINGS_FILE", &settings_file);
        std::env::set_var("DISPLAY", ":99");
        std::env::remove_var("WAYLAND_DISPLAY");

        // Nonzero exit = cancel.
        let (_d, fake_path) = fake_dialog("zenity", "", 1);
        let prev_path = std::env::var_os("PATH");
        let mut joined = fake_path.clone();
        if let Some(prev) = &prev_path {
            joined.push(":");
            joined.push(prev);
        }
        std::env::set_var("PATH", &joined);

        run_pick_features(&config, &paths, false).unwrap();
        assert!(
            !settings.path().join("linux-features.json").exists(),
            "cancel must not write a feature config"
        );

        if let Some(prev) = prev_path {
            std::env::set_var("PATH", prev);
        }
        std::env::remove_var("CODEX_LINUX_SETTINGS_FILE");
        std::env::remove_var("DISPLAY");
    }

    #[test]
    fn dialog_tool_requires_executable_file() {
        let _g = env_lock();
        let dir = tempdir().unwrap();
        let zenity = dir.path().join("zenity");
        std::fs::write(&zenity, "#!/bin/sh\nexit 0\n").unwrap();
        std::fs::set_permissions(&zenity, std::fs::Permissions::from_mode(0o644)).unwrap();
        let prev_path = std::env::var_os("PATH");
        std::env::set_var("PATH", dir.path());

        assert_eq!(dialog_tool(), None);

        if let Some(prev) = prev_path {
            std::env::set_var("PATH", prev);
        }
    }

    #[test]
    fn dialog_launch_error_is_a_cancelled_picker() {
        let _g = env_lock();
        let dir = tempdir().unwrap();
        let zenity = dir.path().join("zenity");
        std::fs::write(&zenity, "#!/missing/interpreter\n").unwrap();
        std::fs::set_permissions(&zenity, std::fs::Permissions::from_mode(0o755)).unwrap();
        let prev_path = std::env::var_os("PATH");
        std::env::set_var("PATH", dir.path());

        let catalog = vec![CatalogEntry {
            id: "alpha".to_string(),
            title: "Alpha".to_string(),
        }];
        let enabled = std::collections::HashSet::new();
        let result = show_picker(&DialogTool::Zenity, &catalog, &enabled).unwrap();
        assert_eq!(result, None);

        if let Some(prev) = prev_path {
            std::env::set_var("PATH", prev);
        }
    }
}
