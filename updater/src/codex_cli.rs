//! CLI discovery and prelaunch update checks for the user-installed Codex CLI.

use crate::{
    config::RuntimePaths,
    state::{CliStatus, PersistedState},
};
use anyhow::{anyhow, Context, Result};
use chrono::{Duration, Utc};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::{
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
};
use tracing::{info, warn};

const CLI_PACKAGE_NAME: &str = "@openai/codex";
const CLI_VERSION_CHECK_TTL: Duration = Duration::hours(1);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreflightOutcome {
    pub cli_path: PathBuf,
    pub installed_version: String,
    pub latest_version: Option<String>,
    pub updated: bool,
}

pub fn preflight(
    state: &mut PersistedState,
    paths: &RuntimePaths,
    explicit_cli_path: Option<PathBuf>,
    allow_install_missing: bool,
) -> Result<PreflightOutcome> {
    let requested_path = explicit_cli_path.as_deref();
    let cli_path = match resolve_cli_path(requested_path) {
        Some(path) => path,
        None if allow_install_missing => install_missing_cli(state, paths, requested_path)?,
        None => anyhow::bail!("Codex CLI not found in PATH or known install locations"),
    };
    let cached_installed_version = state.cli_installed_version.clone();
    let installed_version = read_installed_version(&cli_path)?;
    state.cli_path = Some(cli_path.clone());
    state.cli_installed_version = Some(installed_version.clone());
    persist_state(paths, state)?;

    if should_skip_latest_version_check(
        state,
        cached_installed_version.as_deref(),
        &installed_version,
    ) {
        info!(
            installed_version,
            "skipping Codex CLI registry lookup because the cached result is still fresh"
        );
        refresh_cli_status_from_latest(state, &installed_version);
        state.cli_error_message = None;
        persist_state(paths, state)?;
        return Ok(PreflightOutcome {
            cli_path,
            installed_version,
            latest_version: state.cli_latest_version.clone(),
            updated: false,
        });
    }

    state.cli_last_check_at = Some(Utc::now());
    state.cli_error_message = None;
    state.cli_status = CliStatus::Checking;
    persist_state(paths, state)?;

    let latest_version = match read_latest_version() {
        Ok(version) => version,
        Err(error) => {
            state.cli_status = CliStatus::Unknown;
            state.cli_latest_version = None;
            state.cli_error_message = Some(format!(
                "Could not check the latest {} version: {error}",
                CLI_PACKAGE_NAME
            ));
            persist_state(paths, state)?;
            warn!(?error, "unable to check latest Codex CLI version");
            return Ok(PreflightOutcome {
                cli_path,
                installed_version,
                latest_version: None,
                updated: false,
            });
        }
    };

    state.cli_latest_version = Some(latest_version.clone());
    if installed_version == latest_version {
        state.cli_status = CliStatus::UpToDate;
        state.cli_error_message = None;
        persist_state(paths, state)?;
        return Ok(PreflightOutcome {
            cli_path,
            installed_version,
            latest_version: Some(latest_version),
            updated: false,
        });
    }

    state.cli_status = CliStatus::UpdateRequired;
    persist_state(paths, state)?;
    info!(
        installed_version,
        latest_version, "Codex CLI is outdated; attempting prelaunch upgrade"
    );

    state.cli_status = CliStatus::Updating;
    persist_state(paths, state)?;
    install_latest_cli(&latest_version)?;

    let refreshed_path = resolve_cli_path(requested_path)
        .or_else(|| resolve_cli_path(None))
        .ok_or_else(|| anyhow!("Codex CLI disappeared after the automatic upgrade attempt"))?;
    let refreshed_version = read_installed_version(&refreshed_path)?;
    state.cli_path = Some(refreshed_path.clone());
    state.cli_installed_version = Some(refreshed_version.clone());

    if refreshed_version != latest_version {
        let message = format!(
            "Codex CLI upgrade finished but the installed version is still {} instead of {}",
            refreshed_version, latest_version
        );
        state.cli_status = CliStatus::Failed;
        state.cli_error_message = Some(message.clone());
        persist_state(paths, state)?;
        anyhow::bail!(message);
    }

    state.cli_status = CliStatus::UpToDate;
    state.cli_error_message = None;
    persist_state(paths, state)?;
    Ok(PreflightOutcome {
        cli_path: refreshed_path,
        installed_version: refreshed_version,
        latest_version: Some(latest_version),
        updated: true,
    })
}

pub fn refresh_status(state: &mut PersistedState, paths: &RuntimePaths) -> Result<()> {
    let requested_path = requested_cli_path(state);
    let cli_path = match resolve_cli_path(requested_path.as_deref()) {
        Some(path) => path,
        None => {
            state.cli_path = None;
            state.cli_installed_version = None;
            state.cli_status = CliStatus::Unknown;
            state.cli_error_message =
                Some("Codex CLI not found in PATH or known install locations".to_string());
            persist_state(paths, state)?;
            return Ok(());
        }
    };

    let cached_installed_version = state.cli_installed_version.clone();
    let installed_version = match read_installed_version(&cli_path) {
        Ok(version) => version,
        Err(error) => {
            state.cli_path = Some(cli_path);
            state.cli_installed_version = None;
            state.cli_status = CliStatus::Failed;
            state.cli_error_message = Some(format!(
                "Could not read the installed {} version: {error}",
                CLI_PACKAGE_NAME
            ));
            persist_state(paths, state)?;
            warn!(?error, "unable to read installed Codex CLI version");
            return Ok(());
        }
    };

    state.cli_path = Some(cli_path);
    state.cli_installed_version = Some(installed_version.clone());

    if should_skip_latest_version_check(
        state,
        cached_installed_version.as_deref(),
        &installed_version,
    ) {
        info!(
            installed_version,
            "skipping Codex CLI registry lookup because the cached result is still fresh"
        );
        refresh_cli_status_from_latest(state, &installed_version);
        state.cli_error_message = None;
        persist_state(paths, state)?;
        return Ok(());
    }

    state.cli_last_check_at = Some(Utc::now());
    state.cli_error_message = None;
    state.cli_status = CliStatus::Checking;
    persist_state(paths, state)?;

    match read_latest_version() {
        Ok(latest_version) => {
            state.cli_latest_version = Some(latest_version);
            refresh_cli_status_from_latest(state, &installed_version);
            state.cli_error_message = None;
        }
        Err(error) => {
            let cached_latest_matches_install = cached_latest_version_matches_install(
                state,
                cached_installed_version.as_deref(),
                &installed_version,
            );
            if cached_latest_matches_install {
                refresh_cli_status_from_latest(state, &installed_version);
            } else {
                state.cli_status = CliStatus::Unknown;
            }
            state.cli_error_message = Some(format!(
                "Could not check the latest {} version: {error}",
                CLI_PACKAGE_NAME
            ));
            warn!(?error, "unable to check latest Codex CLI version");
        }
    }

    persist_state(paths, state)
}

fn persist_state(paths: &RuntimePaths, state: &PersistedState) -> Result<()> {
    state.save(&paths.state_file)
}

fn resolve_cli_path(explicit_path: Option<&Path>) -> Option<PathBuf> {
    if let Some(path) = explicit_path {
        if is_executable(path) {
            return Some(path.to_path_buf());
        }
    }

    known_cli_locations()
        .into_iter()
        .find(|path| is_executable(path))
        .or_else(|| find_in_path("codex", &command_path_env()))
}

fn known_cli_locations() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        candidates.push(home.join(".nvm/versions/node/current/bin/codex"));
        let versions_root = home.join(".nvm/versions/node");
        if let Ok(entries) = fs::read_dir(versions_root) {
            let mut versioned_paths = entries
                .filter_map(|entry| entry.ok().map(|item| item.path().join("bin/codex")))
                .collect::<Vec<_>>();
            versioned_paths.sort();
            versioned_paths.reverse();
            candidates.extend(versioned_paths);
        }
        candidates.push(home.join(".npm-global/bin/codex"));
        candidates.push(home.join(".local/share/pnpm/codex"));
        candidates.push(home.join(".local/bin/codex"));
    }
    candidates.push(PathBuf::from("/usr/local/bin/codex"));
    candidates.push(PathBuf::from("/usr/bin/codex"));
    candidates
}

fn requested_cli_path(state: &PersistedState) -> Option<PathBuf> {
    state.cli_path.clone().or_else(|| {
        std::env::var_os("CODEX_CLI_PATH")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
    })
}

fn should_skip_latest_version_check(
    state: &PersistedState,
    cached_installed_version: Option<&str>,
    installed_version: &str,
) -> bool {
    let Some(last_check_at) = state.cli_last_check_at else {
        return false;
    };
    if !cached_latest_version_matches_install(state, cached_installed_version, installed_version) {
        return false;
    }

    Utc::now().signed_duration_since(last_check_at) < CLI_VERSION_CHECK_TTL
}

fn cached_latest_version_matches_install(
    state: &PersistedState,
    cached_installed_version: Option<&str>,
    installed_version: &str,
) -> bool {
    state.cli_latest_version.is_some() && cached_installed_version == Some(installed_version)
}

fn refresh_cli_status_from_latest(state: &mut PersistedState, installed_version: &str) {
    state.cli_status = match state.cli_latest_version.as_deref() {
        Some(latest_version) if latest_version == installed_version => CliStatus::UpToDate,
        Some(_) => CliStatus::UpdateRequired,
        None => CliStatus::Unknown,
    };
}

fn read_installed_version(cli_path: &Path) -> Result<String> {
    let primary = run_command(cli_path, ["--version"])?;
    if let Some(version) = extract_version(&primary) {
        return Ok(version);
    }

    let fallback = run_command(cli_path, ["version"])?;
    extract_version(&fallback).ok_or_else(|| {
        anyhow!(
            "Codex CLI returned an unparseable version string: {}",
            fallback.trim()
        )
    })
}

fn read_latest_version() -> Result<String> {
    let npm = npm_program();
    let output = Command::new(&npm)
        .env("PATH", command_path_env())
        .args(["view", CLI_PACKAGE_NAME, "version"])
        .output()
        .with_context(|| format!("Failed to spawn {}", npm.display()))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        anyhow::bail!(
            "{} view {} version failed with {}{}",
            npm.display(),
            CLI_PACKAGE_NAME,
            output.status,
            if stderr.is_empty() {
                String::new()
            } else {
                format!(": {stderr}")
            }
        );
    }

    extract_version(&String::from_utf8_lossy(&output.stdout)).ok_or_else(|| {
        anyhow!(
            "{} view {} version returned an unparseable version string",
            npm.display(),
            CLI_PACKAGE_NAME
        )
    })
}

fn install_latest_cli(latest_version: &str) -> Result<()> {
    let npm = npm_program();
    let package_spec = format!("{CLI_PACKAGE_NAME}@{latest_version}");
    let global_args = vec![
        OsString::from("install"),
        OsString::from("-g"),
        OsString::from(&package_spec),
    ];

    match run_npm_command(&npm, &global_args) {
        Ok(()) => Ok(()),
        Err(global_error) => {
            warn!(
                ?global_error,
                "global npm install failed; retrying Codex CLI upgrade with a user-local prefix"
            );

            let local_prefix = local_npm_prefix();
            fs::create_dir_all(&local_prefix).with_context(|| {
                format!(
                    "Failed to create local npm prefix {}",
                    local_prefix.display()
                )
            })?;

            let local_args = vec![
                OsString::from("install"),
                OsString::from("-g"),
                OsString::from("--prefix"),
                local_prefix.as_os_str().to_os_string(),
                OsString::from(&package_spec),
            ];

            run_npm_command(&npm, &local_args).with_context(|| {
                format!(
                    "npm install -g failed first ({global_error}); fallback install into {} also failed",
                    local_prefix.display()
                )
            })
        }
    }
}

fn install_missing_cli(
    state: &mut PersistedState,
    paths: &RuntimePaths,
    requested_path: Option<&Path>,
) -> Result<PathBuf> {
    state.cli_status = CliStatus::Updating;
    persist_state(paths, state)?;

    let latest_version = read_latest_version()?;
    state.cli_latest_version = Some(latest_version.clone());
    persist_state(paths, state)?;

    info!(
        latest_version,
        "Codex CLI is missing; attempting automatic installation"
    );
    install_latest_cli(&latest_version)?;

    let cli_path = resolve_cli_path(requested_path)
        .or_else(|| resolve_cli_path(None))
        .ok_or_else(|| anyhow!("Codex CLI installed but could not be found afterwards"))?;

    Ok(cli_path)
}

fn run_command<I, S>(program: &Path, args: I) -> Result<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<std::ffi::OsStr>,
{
    let output = Command::new(program)
        .env("PATH", command_path_env())
        .args(args)
        .output()
        .with_context(|| format!("Failed to spawn {}", program.display()))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        anyhow::bail!(
            "{} exited with {}{}",
            program.display(),
            output.status,
            if stderr.is_empty() {
                String::new()
            } else {
                format!(": {stderr}")
            }
        );
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn extract_version(raw: &str) -> Option<String> {
    raw.split_whitespace()
        .find_map(normalize_version_token)
        .or_else(|| {
            let trimmed = raw.trim();
            normalize_version_token(trimmed)
        })
}

fn normalize_version_token(token: &str) -> Option<String> {
    let trimmed = token.trim_matches(|ch: char| {
        !ch.is_ascii_alphanumeric() && ch != '.' && ch != '-' && ch != '_'
    });
    let trimmed = trimmed.strip_prefix('v').unwrap_or(trimmed);
    if trimmed.is_empty() || !trimmed.contains('.') {
        return None;
    }
    if !trimmed
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '.' || ch == '-' || ch == '_')
    {
        return None;
    }
    if !trimmed.chars().any(|ch| ch.is_ascii_digit()) {
        return None;
    }
    Some(trimmed.to_string())
}

fn npm_program() -> PathBuf {
    find_in_path("npm", &command_path_env()).unwrap_or_else(|| PathBuf::from("npm"))
}

fn local_npm_prefix() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".local")
}

fn run_npm_command(npm: &Path, args: &[OsString]) -> Result<()> {
    let output = Command::new(npm)
        .env("PATH", command_path_env())
        .args(args)
        .output()
        .with_context(|| format!("Failed to spawn {}", npm.display()))?;

    anyhow::ensure!(
        output.status.success(),
        "{} {} failed with {}{}",
        npm.display(),
        format_command_args(args),
        output.status,
        format_command_output(&output)
    );

    Ok(())
}

fn format_command_args(args: &[OsString]) -> String {
    args.iter()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join(" ")
}

fn format_command_output(output: &Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !stderr.is_empty() {
        return format!(": {stderr}");
    }

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if stdout.is_empty() {
        String::new()
    } else {
        format!(": {stdout}")
    }
}

fn find_in_path(name: &str, path_env: &OsString) -> Option<PathBuf> {
    std::env::split_paths(path_env).find_map(|entry| {
        let candidate = entry.join(name);
        if is_executable(&candidate) {
            Some(candidate)
        } else {
            None
        }
    })
}

fn command_path_env() -> OsString {
    let mut entries = preferred_node_bin_dirs();
    entries.extend(std::env::split_paths(
        &std::env::var_os("PATH").unwrap_or_default(),
    ));
    std::env::join_paths(entries).unwrap_or_else(|_| std::env::var_os("PATH").unwrap_or_default())
}

fn preferred_node_bin_dirs() -> Vec<PathBuf> {
    let mut directories = Vec::new();

    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        let npm_global_bin = home.join(".npm-global/bin");
        if node_toolchain_dir(&npm_global_bin) {
            directories.push(npm_global_bin);
        }
    }

    let nvm_root = std::env::var_os("NVM_DIR")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".nvm")));

    let Some(nvm_root) = nvm_root else {
        return directories;
    };

    let current_bin = nvm_root.join("versions/node/current/bin");
    if node_toolchain_dir(&current_bin) {
        directories.push(current_bin);
    }

    let versions_root = nvm_root.join("versions/node");
    if let Ok(entries) = fs::read_dir(versions_root) {
        let mut version_bins = entries
            .filter_map(|entry| entry.ok().map(|item| item.path().join("bin")))
            .filter(|path| node_toolchain_dir(path))
            .collect::<Vec<_>>();
        version_bins.sort();
        version_bins.reverse();
        directories.extend(version_bins);
    }

    directories
}

fn node_toolchain_dir(path: &Path) -> bool {
    ["node", "npm", "npx"]
        .into_iter()
        .all(|binary| is_executable(&path.join(binary)))
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    metadata.is_file() && metadata.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    path.is_file()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        config::RuntimePaths,
        state::{CliStatus, PersistedState},
    };
    use chrono::Utc;
    use std::{fs, os::unix::fs::PermissionsExt, path::Path};
    use tempfile::tempdir;

    fn write_executable_script(path: &Path, contents: &str) -> Result<()> {
        fs::write(path, contents)?;
        let mut permissions = fs::metadata(path)?.permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(path, permissions)?;
        Ok(())
    }

    fn write_plain_file(path: &Path, contents: &str) -> Result<()> {
        fs::write(path, contents)?;
        let mut permissions = fs::metadata(path)?.permissions();
        permissions.set_mode(0o644);
        fs::set_permissions(path, permissions)?;
        Ok(())
    }

    fn test_runtime_paths(root: &Path) -> RuntimePaths {
        RuntimePaths {
            config_file: root.join("config/config.toml"),
            state_file: root.join("state/state.json"),
            log_file: root.join("state/service.log"),
            cache_dir: root.join("cache"),
            state_dir: root.join("state"),
            config_dir: root.join("config"),
        }
    }

    #[test]
    fn extracts_plain_semver() {
        assert_eq!(extract_version("0.34.1"), Some("0.34.1".to_string()));
    }

    #[test]
    fn extracts_prefixed_semver() {
        assert_eq!(
            extract_version("codex-cli v0.34.1"),
            Some("0.34.1".to_string())
        );
    }

    #[test]
    fn ignores_non_version_text() {
        assert_eq!(extract_version("Codex CLI"), None);
    }

    #[test]
    fn executable_check_requires_execute_permission() -> Result<()> {
        let temp = tempdir()?;
        let path = temp.path().join("codex");

        write_plain_file(&path, "#!/bin/sh\n")?;
        assert!(!is_executable(&path));

        write_executable_script(&path, "#!/bin/sh\n")?;
        assert!(is_executable(&path));
        Ok(())
    }

    #[test]
    fn find_in_path_rejects_non_executable_entries() -> Result<()> {
        let temp = tempdir()?;
        let path = temp.path().join("codex");
        write_plain_file(&path, "#!/bin/sh\n")?;

        let path_env = std::env::join_paths([temp.path()])?;
        assert_eq!(find_in_path("codex", &path_env), None);

        write_executable_script(&path, "#!/bin/sh\n")?;
        assert_eq!(
            find_in_path("codex", &path_env).as_deref(),
            Some(path.as_path())
        );
        Ok(())
    }

    #[test]
    fn node_toolchain_dir_requires_executable_tools() -> Result<()> {
        let temp = tempdir()?;
        let bin = temp.path().join("bin");
        fs::create_dir_all(&bin)?;
        for tool in ["node", "npm", "npx"] {
            write_plain_file(&bin.join(tool), "#!/bin/sh\n")?;
        }
        assert!(!node_toolchain_dir(&bin));

        for tool in ["node", "npm", "npx"] {
            write_executable_script(&bin.join(tool), "#!/bin/sh\n")?;
        }
        assert!(node_toolchain_dir(&bin));
        Ok(())
    }

    #[test]
    fn skips_registry_lookup_when_previous_check_is_fresh_for_same_cli_version() {
        let mut state = PersistedState::new(true);
        state.cli_installed_version = Some("0.42.0".to_string());
        state.cli_latest_version = Some("0.42.1".to_string());
        state.cli_last_check_at = Some(Utc::now() - Duration::minutes(30));

        assert!(should_skip_latest_version_check(
            &state,
            Some("0.42.0"),
            "0.42.0"
        ));
    }

    #[test]
    fn does_not_skip_registry_lookup_when_cli_version_changed() {
        let mut state = PersistedState::new(true);
        state.cli_installed_version = Some("0.42.0".to_string());
        state.cli_latest_version = Some("0.42.1".to_string());
        state.cli_last_check_at = Some(Utc::now() - Duration::minutes(30));

        assert!(!should_skip_latest_version_check(
            &state,
            Some("0.42.0"),
            "0.43.0"
        ));
    }

    #[test]
    fn does_not_skip_registry_lookup_when_cached_check_is_stale() {
        let mut state = PersistedState::new(true);
        state.cli_installed_version = Some("0.42.0".to_string());
        state.cli_latest_version = Some("0.42.0".to_string());
        state.cli_last_check_at = Some(Utc::now() - Duration::hours(2));

        assert!(!should_skip_latest_version_check(
            &state,
            Some("0.42.0"),
            "0.42.0"
        ));
    }

    #[test]
    fn does_not_skip_registry_lookup_without_cached_latest_version() {
        let mut state = PersistedState::new(true);
        state.cli_installed_version = Some("0.42.0".to_string());
        state.cli_last_check_at = Some(Utc::now() - Duration::minutes(30));

        assert!(!should_skip_latest_version_check(
            &state,
            Some("0.42.0"),
            "0.42.0"
        ));
    }

    #[test]
    fn refresh_status_uses_persisted_cli_path_and_cached_latest() -> Result<()> {
        let temp = tempdir()?;
        let paths = test_runtime_paths(temp.path());
        paths.ensure_dirs()?;

        let codex_path = temp.path().join("codex");
        write_executable_script(
            &codex_path,
            "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then\n  echo 'codex-cli v0.42.0'\n  exit 0\nfi\nexit 1\n",
        )?;

        let mut state = PersistedState::new(true);
        state.cli_path = Some(codex_path.clone());
        state.cli_installed_version = Some("0.42.0".to_string());
        state.cli_latest_version = Some("0.43.0".to_string());
        state.cli_last_check_at = Some(Utc::now() - Duration::minutes(30));
        refresh_status(&mut state, &paths)?;

        assert_eq!(state.cli_path.as_deref(), Some(codex_path.as_path()));
        assert_eq!(state.cli_installed_version.as_deref(), Some("0.42.0"));
        assert_eq!(state.cli_latest_version.as_deref(), Some("0.43.0"));
        assert_eq!(state.cli_status, CliStatus::UpdateRequired);
        assert_eq!(state.cli_error_message, None);
        Ok(())
    }

    #[test]
    fn preflight_uses_cached_latest_for_fresh_explicit_cli_path() -> Result<()> {
        let temp = tempdir()?;
        let paths = test_runtime_paths(temp.path());
        paths.ensure_dirs()?;

        let codex_path = temp.path().join("codex");
        write_executable_script(
            &codex_path,
            "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then\n  echo 'codex-cli v0.42.0'\n  exit 0\nfi\nexit 1\n",
        )?;

        let mut state = PersistedState::new(true);
        state.cli_installed_version = Some("0.42.0".to_string());
        state.cli_latest_version = Some("0.42.0".to_string());
        state.cli_last_check_at = Some(Utc::now() - Duration::minutes(5));
        state.cli_status = CliStatus::Unknown;
        state.cli_error_message = Some("previous error".to_string());

        let outcome = preflight(&mut state, &paths, Some(codex_path.clone()), false)?;

        assert_eq!(outcome.cli_path, codex_path);
        assert_eq!(outcome.installed_version, "0.42.0");
        assert_eq!(outcome.latest_version.as_deref(), Some("0.42.0"));
        assert!(!outcome.updated);
        assert_eq!(state.cli_latest_version.as_deref(), Some("0.42.0"));
        assert_eq!(state.cli_status, CliStatus::UpToDate);
        assert_eq!(state.cli_error_message, None);
        Ok(())
    }
}
