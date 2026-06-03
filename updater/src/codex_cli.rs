//! CLI discovery and prelaunch update checks for the user-installed Codex CLI.

use crate::{
    config::RuntimePaths,
    state::{CliStatus, PersistedState},
};
use anyhow::{anyhow, Context, Result};
use chrono::{Duration, Utc};
use semver::Version;
use std::{
    ffi::OsString,
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Command, Output},
};
use tracing::{info, warn};

const CLI_PACKAGE_NAME: &str = "@openai/codex";
const CLI_NOT_INSTALLED_MESSAGE: &str =
    "Codex CLI is required but not currently installed. Open the app to retry the automatic install flow, or install it manually with npm.";
const CLI_VERSION_CHECK_TTL: Duration = Duration::hours(1);
#[cfg(test)]
const CLI_INSTALLED_VERSION_TTL: Duration = Duration::hours(1);

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
    state.cli_last_verified_at = Some(Utc::now());
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
                "Could not check the latest {CLI_PACKAGE_NAME} version: {error}"
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
    if installed_cli_version_satisfies_latest(&installed_version, &latest_version) {
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

    let (refreshed_path, refreshed_version) = if let Some(updated_cli) =
        resolve_cli_path_with_version(requested_path, &latest_version)
    {
        updated_cli
    } else {
        let fallback_path = resolve_cli_path(requested_path)
            .or_else(|| resolve_cli_path(None))
            .ok_or_else(|| anyhow!("Codex CLI disappeared after the automatic upgrade attempt"))?;
        let fallback_version = read_installed_version(&fallback_path)?;
        (fallback_path, fallback_version)
    };
    state.cli_path = Some(refreshed_path.clone());
    state.cli_installed_version = Some(refreshed_version.clone());

    if refreshed_version != latest_version {
        let message = format!(
            "Codex CLI upgrade finished but the installed version is still {refreshed_version} instead of {latest_version}"
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

#[cfg(test)]
pub fn refresh_cached_status(state: &mut PersistedState, paths: &RuntimePaths) -> Result<()> {
    let original_state = state.clone();
    let requested_path = requested_cli_path(state);
    let cli_path = match resolve_cli_path(requested_path.as_deref()) {
        Some(path) => path,
        None => {
            mark_cli_missing(state);
            return persist_if_changed(paths, state, &original_state);
        }
    };

    let Some(installed_version) = cached_installed_version_if_fresh(state, &cli_path) else {
        return refresh_status(state, paths);
    };

    state.cli_path = Some(cli_path);
    state.cli_installed_version = Some(installed_version.clone());
    refresh_cli_status_from_latest(state, &installed_version);
    state.cli_error_message = None;

    persist_if_changed(paths, state, &original_state)
}

pub fn refresh_status(state: &mut PersistedState, paths: &RuntimePaths) -> Result<()> {
    let requested_path = requested_cli_path(state);
    let cli_path = match resolve_cli_path(requested_path.as_deref()) {
        Some(path) => path,
        None => {
            mark_cli_missing(state);
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
            state.cli_last_verified_at = None;
            state.cli_status = CliStatus::Failed;
            state.cli_error_message = Some(format!(
                "Could not read the installed {CLI_PACKAGE_NAME} version: {error}"
            ));
            persist_state(paths, state)?;
            warn!(?error, "unable to read installed Codex CLI version");
            return Ok(());
        }
    };

    state.cli_path = Some(cli_path);
    state.cli_installed_version = Some(installed_version.clone());
    state.cli_last_verified_at = Some(Utc::now());

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
                "Could not check the latest {CLI_PACKAGE_NAME} version: {error}"
            ));
            warn!(?error, "unable to check latest Codex CLI version");
        }
    }

    persist_state(paths, state)
}

pub fn reconcile_if_present(state: &mut PersistedState, paths: &RuntimePaths) -> Result<bool> {
    let requested_path = requested_cli_path(state);
    if resolve_cli_path(requested_path.as_deref()).is_none() {
        refresh_status(state, paths)?;
        return Ok(false);
    }

    Ok(preflight(state, paths, requested_path, false)?.updated)
}

fn persist_state(paths: &RuntimePaths, state: &PersistedState) -> Result<()> {
    state.save(&paths.state_file)
}

#[cfg(test)]
fn persist_if_changed(
    paths: &RuntimePaths,
    state: &PersistedState,
    original_state: &PersistedState,
) -> Result<()> {
    if state != original_state {
        persist_state(paths, state)?;
    }

    Ok(())
}

pub(crate) fn resolve_cli_path(explicit_path: Option<&Path>) -> Option<PathBuf> {
    cli_path_candidates(explicit_path)
        .into_iter()
        .find(|path| is_executable(path))
}

fn resolve_cli_path_with_version(
    explicit_path: Option<&Path>,
    expected_version: &str,
) -> Option<(PathBuf, String)> {
    post_install_cli_path_candidates(explicit_path)
        .into_iter()
        .filter(|path| is_executable(path))
        .find_map(|path| match read_installed_version(&path) {
            Ok(version) if installed_cli_version_satisfies_latest(&version, expected_version) => {
                Some((path, version))
            }
            _ => None,
        })
}

fn cli_path_candidates(explicit_path: Option<&Path>) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(path) = explicit_path {
        candidates.push(path.to_path_buf());
    }

    candidates.extend(find_all_in_path("codex", &command_path_env()));
    candidates.extend(known_cli_locations());
    dedupe_paths(candidates)
}

fn post_install_cli_path_candidates(explicit_path: Option<&Path>) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    candidates.extend(find_all_in_path("codex", &command_path_env()));
    candidates.extend(known_cli_locations());
    if let Some(path) = explicit_path {
        candidates.push(path.to_path_buf());
    }
    dedupe_paths(candidates)
}

fn known_cli_locations() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        append_nvm_cli_locations(&mut candidates, xdg_nvm_root(&home));
        append_nvm_cli_locations(&mut candidates, home.join(".nvm"));
        candidates.push(home.join(".npm-global/bin/codex"));
        candidates.push(home.join(".local/share/pnpm/codex"));
        candidates.push(home.join(".local/bin/codex"));
    }
    if include_system_cli_locations() {
        candidates.push(PathBuf::from("/usr/local/bin/codex"));
        candidates.push(PathBuf::from("/usr/bin/codex"));
    }
    candidates
}

fn append_nvm_cli_locations(candidates: &mut Vec<PathBuf>, nvm_root: PathBuf) {
    candidates.push(nvm_root.join("versions/node/current/bin/codex"));
    let versions_root = nvm_root.join("versions/node");
    if let Ok(entries) = fs::read_dir(versions_root) {
        let mut versioned_paths = entries
            .filter_map(|entry| entry.ok().map(|item| item.path().join("bin/codex")))
            .collect::<Vec<_>>();
        versioned_paths.sort();
        versioned_paths.reverse();
        candidates.extend(versioned_paths);
    }
}

fn include_system_cli_locations() -> bool {
    #[cfg(test)]
    {
        std::env::var_os("CODEX_UPDATE_MANAGER_SKIP_SYSTEM_CLI_LOOKUP").is_none()
    }

    #[cfg(not(test))]
    {
        true
    }
}

fn requested_cli_path(state: &PersistedState) -> Option<PathBuf> {
    state.cli_path.clone().or_else(|| {
        std::env::var_os("CODEX_CLI_PATH")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
    })
}

fn mark_cli_missing(state: &mut PersistedState) {
    state.cli_path = None;
    state.cli_installed_version = None;
    state.cli_last_verified_at = None;
    state.cli_status = CliStatus::NotInstalled;
    state.cli_error_message = Some(CLI_NOT_INSTALLED_MESSAGE.to_string());
}

#[cfg(test)]
fn cached_installed_version_if_fresh(state: &PersistedState, cli_path: &Path) -> Option<String> {
    let cached_path = state.cli_path.as_deref()?;
    if cached_path != cli_path {
        return None;
    }

    let installed_version = state.cli_installed_version.clone()?;
    let last_verified_at = state.cli_last_verified_at?;
    if state.cli_status == CliStatus::Failed {
        return None;
    }

    if Utc::now().signed_duration_since(last_verified_at) >= CLI_INSTALLED_VERSION_TTL {
        return None;
    }

    Some(installed_version)
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
        Some(latest_version)
            if installed_cli_version_satisfies_latest(installed_version, latest_version) =>
        {
            CliStatus::UpToDate
        }
        Some(_) => CliStatus::UpdateRequired,
        None => CliStatus::Unknown,
    };
}

fn installed_cli_version_satisfies_latest(installed_version: &str, latest_version: &str) -> bool {
    if installed_version == latest_version {
        return true;
    }

    match (
        Version::parse(installed_version),
        Version::parse(latest_version),
    ) {
        (Ok(installed), Ok(latest)) => installed >= latest,
        _ => false,
    }
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
    find_all_in_path(name, path_env).into_iter().next()
}

fn find_all_in_path(name: &str, path_env: &OsString) -> Vec<PathBuf> {
    std::env::split_paths(path_env)
        .map(|entry| entry.join(name))
        .filter(|candidate| is_executable(candidate))
        .collect()
}

fn dedupe_paths(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut deduped = Vec::new();
    for path in paths {
        if !deduped.iter().any(|existing| existing == &path) {
            deduped.push(path);
        }
    }
    deduped
}

fn command_path_env() -> OsString {
    let mut entries = preferred_node_bin_dirs();
    entries.extend(std::env::split_paths(
        &std::env::var_os("PATH").unwrap_or_default(),
    ));
    std::env::join_paths(entries).unwrap_or_else(|_| std::env::var_os("PATH").unwrap_or_default())
}

fn xdg_nvm_root(home: &Path) -> PathBuf {
    std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".config"))
        .join("nvm")
}

fn default_nvm_root() -> Option<PathBuf> {
    if let Some(nvm_dir) = std::env::var_os("NVM_DIR") {
        return Some(PathBuf::from(nvm_dir));
    }

    let home = PathBuf::from(std::env::var_os("HOME")?);
    let xdg_root = xdg_nvm_root(&home);
    if xdg_root.is_dir() {
        Some(xdg_root)
    } else {
        Some(home.join(".nvm"))
    }
}

fn preferred_node_bin_dirs() -> Vec<PathBuf> {
    let Some(nvm_root) = default_nvm_root() else {
        return Vec::new();
    };

    let mut directories = Vec::new();
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
        .all(|binary| path.join(binary).is_file())
}

fn is_executable(path: &Path) -> bool {
    fs::metadata(path)
        .map(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        config::RuntimePaths,
        state::{CliStatus, PersistedState},
        test_util::env_lock,
    };
    use chrono::Utc;
    use std::{ffi::OsString, fs, os::unix::fs::PermissionsExt, path::Path};
    use tempfile::tempdir;

    fn write_executable_script(path: &Path, contents: &str) -> Result<()> {
        fs::write(path, contents)?;
        let mut permissions = fs::metadata(path)?.permissions();
        permissions.set_mode(0o755);
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

    struct EnvRestoreGuard {
        saved: Vec<(&'static str, Option<OsString>)>,
    }

    impl EnvRestoreGuard {
        fn capture(keys: &[&'static str]) -> Self {
            Self {
                saved: keys
                    .iter()
                    .map(|key| (*key, std::env::var_os(key)))
                    .collect(),
            }
        }
    }

    impl Drop for EnvRestoreGuard {
        fn drop(&mut self) {
            for (key, value) in &self.saved {
                if let Some(value) = value {
                    std::env::set_var(key, value);
                } else {
                    std::env::remove_var(key);
                }
            }
        }
    }

    #[test]
    fn xdg_nvm_install_is_discovered_without_shell_env() -> Result<()> {
        let _env_guard = env_lock();
        let temp = tempdir()?;
        let home = temp.path().join("home");
        let nvm_bin = home.join(".config/nvm/versions/node/v22.17.1/bin");
        fs::create_dir_all(&nvm_bin)?;

        for binary in ["node", "npm", "npx"] {
            fs::write(nvm_bin.join(binary), "")?;
        }
        let codex_path = nvm_bin.join("codex");
        write_executable_script(
            &codex_path,
            "#!/bin/sh\nif [ \"$1\" = \"--version\" ] || [ \"$1\" = \"version\" ]; then\n  echo 'codex-cli v0.42.0'\n  exit 0\nfi\nexit 1\n",
        )?;

        let _restore_env = EnvRestoreGuard::capture(&[
            "HOME",
            "PATH",
            "NVM_DIR",
            "XDG_CONFIG_HOME",
            "CODEX_CLI_PATH",
            "CODEX_UPDATE_MANAGER_SKIP_SYSTEM_CLI_LOOKUP",
        ]);
        std::env::set_var("HOME", &home);
        std::env::set_var("PATH", temp.path().join("missing-bin"));
        std::env::remove_var("NVM_DIR");
        std::env::remove_var("XDG_CONFIG_HOME");
        std::env::remove_var("CODEX_CLI_PATH");
        std::env::set_var("CODEX_UPDATE_MANAGER_SKIP_SYSTEM_CLI_LOOKUP", "1");

        let command_path = command_path_env();
        assert!(std::env::split_paths(&command_path).any(|path| path == nvm_bin.as_path()));
        assert_eq!(resolve_cli_path(None), Some(codex_path));
        Ok(())
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
    fn installed_cli_version_satisfies_equal_or_newer_semver() {
        assert!(installed_cli_version_satisfies_latest("0.42.1", "0.42.1"));
        assert!(installed_cli_version_satisfies_latest("0.43.0", "0.42.1"));
        assert!(!installed_cli_version_satisfies_latest("0.42.0", "0.42.1"));
        assert!(!installed_cli_version_satisfies_latest(
            "custom-build",
            "0.42.1"
        ));
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

    #[test]
    fn refresh_cached_status_uses_cached_installed_version_without_running_cli() -> Result<()> {
        let temp = tempdir()?;
        let paths = test_runtime_paths(temp.path());
        paths.ensure_dirs()?;

        let codex_path = temp.path().join("codex");
        write_executable_script(
            &codex_path,
            "#!/bin/sh\necho 'cli should not run during cached refresh' >&2\nexit 99\n",
        )?;

        let mut state = PersistedState::new(true);
        state.cli_path = Some(codex_path.clone());
        state.cli_installed_version = Some("0.42.0".to_string());
        state.cli_latest_version = Some("0.42.1".to_string());
        state.cli_last_check_at = Some(Utc::now() - Duration::minutes(30));
        state.cli_last_verified_at = Some(Utc::now() - Duration::minutes(30));

        refresh_cached_status(&mut state, &paths)?;

        assert_eq!(state.cli_path.as_deref(), Some(codex_path.as_path()));
        assert_eq!(state.cli_installed_version.as_deref(), Some("0.42.0"));
        assert_eq!(state.cli_status, CliStatus::UpdateRequired);
        assert_eq!(state.cli_error_message, None);
        Ok(())
    }

    #[test]
    fn refresh_cached_status_invalidates_missing_cached_cli_path() -> Result<()> {
        let _env_guard = env_lock();
        let temp = tempdir()?;
        let paths = test_runtime_paths(temp.path());
        paths.ensure_dirs()?;

        let original_home = std::env::var_os("HOME");
        let original_path = std::env::var_os("PATH");
        let original_nvm_dir = std::env::var_os("NVM_DIR");
        let original_codex_cli_path = std::env::var_os("CODEX_CLI_PATH");
        let original_skip_system_cli_lookup =
            std::env::var_os("CODEX_UPDATE_MANAGER_SKIP_SYSTEM_CLI_LOOKUP");
        std::env::set_var("HOME", temp.path());
        std::env::set_var("PATH", temp.path().join("missing-bin"));
        std::env::remove_var("NVM_DIR");
        std::env::remove_var("CODEX_CLI_PATH");
        std::env::set_var("CODEX_UPDATE_MANAGER_SKIP_SYSTEM_CLI_LOOKUP", "1");

        let missing_path = temp.path().join("missing-codex");
        let mut state = PersistedState::new(true);
        state.cli_path = Some(missing_path);
        state.cli_installed_version = Some("0.42.0".to_string());
        state.cli_last_verified_at = Some(Utc::now() - Duration::minutes(30));

        refresh_cached_status(&mut state, &paths)?;

        if let Some(home) = original_home {
            std::env::set_var("HOME", home);
        } else {
            std::env::remove_var("HOME");
        }
        if let Some(path) = original_path {
            std::env::set_var("PATH", path);
        } else {
            std::env::remove_var("PATH");
        }
        if let Some(nvm_dir) = original_nvm_dir {
            std::env::set_var("NVM_DIR", nvm_dir);
        } else {
            std::env::remove_var("NVM_DIR");
        }
        if let Some(cli_path) = original_codex_cli_path {
            std::env::set_var("CODEX_CLI_PATH", cli_path);
        } else {
            std::env::remove_var("CODEX_CLI_PATH");
        }
        if let Some(value) = original_skip_system_cli_lookup {
            std::env::set_var("CODEX_UPDATE_MANAGER_SKIP_SYSTEM_CLI_LOOKUP", value);
        } else {
            std::env::remove_var("CODEX_UPDATE_MANAGER_SKIP_SYSTEM_CLI_LOOKUP");
        }

        assert_eq!(state.cli_path, None);
        assert_eq!(state.cli_installed_version, None);
        assert_eq!(state.cli_status, CliStatus::NotInstalled);
        assert_eq!(
            state.cli_error_message.as_deref(),
            Some(CLI_NOT_INSTALLED_MESSAGE)
        );
        Ok(())
    }

    #[test]
    fn refresh_status_marks_missing_cli_as_not_installed() -> Result<()> {
        let _env_guard = env_lock();
        let temp = tempdir()?;
        let paths = test_runtime_paths(temp.path());
        paths.ensure_dirs()?;

        let original_home = std::env::var_os("HOME");
        let original_path = std::env::var_os("PATH");
        let original_nvm_dir = std::env::var_os("NVM_DIR");
        let original_codex_cli_path = std::env::var_os("CODEX_CLI_PATH");
        let original_skip_system_cli_lookup =
            std::env::var_os("CODEX_UPDATE_MANAGER_SKIP_SYSTEM_CLI_LOOKUP");
        std::env::set_var("HOME", temp.path());
        std::env::set_var("PATH", temp.path().join("missing-bin"));
        std::env::remove_var("NVM_DIR");
        std::env::remove_var("CODEX_CLI_PATH");
        std::env::set_var("CODEX_UPDATE_MANAGER_SKIP_SYSTEM_CLI_LOOKUP", "1");

        let mut state = PersistedState::new(true);
        refresh_status(&mut state, &paths)?;

        if let Some(home) = original_home {
            std::env::set_var("HOME", home);
        } else {
            std::env::remove_var("HOME");
        }
        if let Some(path) = original_path {
            std::env::set_var("PATH", path);
        } else {
            std::env::remove_var("PATH");
        }
        if let Some(nvm_dir) = original_nvm_dir {
            std::env::set_var("NVM_DIR", nvm_dir);
        } else {
            std::env::remove_var("NVM_DIR");
        }
        if let Some(cli_path) = original_codex_cli_path {
            std::env::set_var("CODEX_CLI_PATH", cli_path);
        } else {
            std::env::remove_var("CODEX_CLI_PATH");
        }
        if let Some(value) = original_skip_system_cli_lookup {
            std::env::set_var("CODEX_UPDATE_MANAGER_SKIP_SYSTEM_CLI_LOOKUP", value);
        } else {
            std::env::remove_var("CODEX_UPDATE_MANAGER_SKIP_SYSTEM_CLI_LOOKUP");
        }

        assert_eq!(state.cli_path, None);
        assert_eq!(state.cli_installed_version, None);
        assert_eq!(state.cli_status, CliStatus::NotInstalled);
        assert_eq!(
            state.cli_error_message.as_deref(),
            Some(CLI_NOT_INSTALLED_MESSAGE)
        );
        Ok(())
    }

    #[test]
    fn reconcile_if_present_upgrades_outdated_cli() -> Result<()> {
        let _env_guard = env_lock();
        let temp = tempdir()?;
        let paths = test_runtime_paths(temp.path());
        paths.ensure_dirs()?;

        let bin_dir = temp.path().join("bin");
        fs::create_dir_all(&bin_dir)?;

        let codex_path = bin_dir.join("codex");
        write_executable_script(
            &codex_path,
            "#!/bin/sh\nif [ \"$1\" = \"--version\" ] || [ \"$1\" = \"version\" ]; then\n  echo 'codex-cli v0.42.0'\n  exit 0\nfi\nexit 1\n",
        )?;

        let npm_path = bin_dir.join("npm");
        write_executable_script(
            &npm_path,
            "#!/bin/sh\nif [ \"$1\" = \"view\" ] && [ \"$2\" = \"@openai/codex\" ] && [ \"$3\" = \"version\" ]; then\n  echo '0.42.1'\n  exit 0\nfi\nif [ \"$1\" = \"install\" ] && [ \"$2\" = \"-g\" ]; then\n  printf '%s\\n' '#!/bin/sh' 'if [ \"$1\" = \"--version\" ] || [ \"$1\" = \"version\" ]; then' \"  echo 'codex-cli v0.42.1'\" '  exit 0' 'fi' 'exit 1' > \"$FAKE_CODEX_PATH\"\n  exit 0\nfi\nexit 1\n",
        )?;

        let original_home = std::env::var_os("HOME");
        let original_path = std::env::var_os("PATH");
        let original_nvm_dir = std::env::var_os("NVM_DIR");
        std::env::set_var("HOME", temp.path());
        std::env::set_var("PATH", std::env::join_paths([bin_dir.clone()])?);
        std::env::remove_var("NVM_DIR");
        std::env::set_var("FAKE_CODEX_PATH", &codex_path);

        assert_eq!(npm_program(), npm_path);

        let mut state = PersistedState::new(true);
        state.cli_path = Some(codex_path.clone());

        let updated = reconcile_if_present(&mut state, &paths)?;

        if let Some(home) = original_home {
            std::env::set_var("HOME", home);
        } else {
            std::env::remove_var("HOME");
        }
        if let Some(path) = original_path {
            std::env::set_var("PATH", path);
        } else {
            std::env::remove_var("PATH");
        }
        if let Some(nvm_dir) = original_nvm_dir {
            std::env::set_var("NVM_DIR", nvm_dir);
        } else {
            std::env::remove_var("NVM_DIR");
        }
        std::env::remove_var("FAKE_CODEX_PATH");

        assert!(updated);
        assert_eq!(state.cli_path.as_deref(), Some(codex_path.as_path()));
        assert_eq!(state.cli_installed_version.as_deref(), Some("0.42.1"));
        assert_eq!(state.cli_latest_version.as_deref(), Some("0.42.1"));
        assert_eq!(state.cli_status, CliStatus::UpToDate);
        assert_eq!(read_installed_version(&codex_path)?, "0.42.1");
        Ok(())
    }

    #[test]
    fn preflight_accepts_user_prefix_cli_after_system_cli_upgrade() -> Result<()> {
        let _env_guard = env_lock();
        let temp = tempdir()?;
        let paths = test_runtime_paths(temp.path());
        paths.ensure_dirs()?;

        let home = temp.path().join("home");
        let npm_bin = temp.path().join("npm-bin");
        let system_bin = temp.path().join("system-bin");
        fs::create_dir_all(&home)?;
        fs::create_dir_all(&npm_bin)?;
        fs::create_dir_all(&system_bin)?;

        let system_codex = system_bin.join("codex");
        write_executable_script(
            &system_codex,
            "#!/bin/sh\nif [ \"$1\" = \"--version\" ] || [ \"$1\" = \"version\" ]; then\n  echo 'codex-cli v0.42.0'\n  exit 0\nfi\nexit 1\n",
        )?;
        let user_codex = home.join(".npm-global/bin/codex");
        fs::create_dir_all(user_codex.parent().expect("user codex should have parent"))?;
        write_executable_script(
            &user_codex,
            "#!/bin/sh\nif [ \"$1\" = \"--version\" ] || [ \"$1\" = \"version\" ]; then\n  echo 'codex-cli v0.42.1'\n  exit 0\nfi\nexit 1\n",
        )?;

        let npm_path = npm_bin.join("npm");
        write_executable_script(
            &npm_path,
            r#"#!/bin/sh
if [ "$1" = "view" ] && [ "$2" = "@openai/codex" ] && [ "$3" = "version" ]; then
  echo '0.42.1'
  exit 0
fi
if [ "$1" = "install" ] && [ "$2" = "-g" ]; then
  exit 0
fi
exit 1
"#,
        )?;

        let _restore_env = EnvRestoreGuard::capture(&["HOME", "PATH", "NVM_DIR", "CODEX_CLI_PATH"]);
        std::env::set_var("HOME", &home);
        std::env::set_var("PATH", std::env::join_paths([npm_bin, system_bin])?);
        std::env::remove_var("NVM_DIR");
        std::env::remove_var("CODEX_CLI_PATH");

        let mut state = PersistedState::new(true);
        state.cli_path = Some(system_codex.clone());

        assert_eq!(
            resolve_cli_path_with_version(Some(&system_codex), "0.42.1"),
            Some((user_codex.clone(), "0.42.1".to_string()))
        );

        let outcome = preflight(&mut state, &paths, Some(system_codex.clone()), false)?;

        assert!(outcome.updated);
        assert_eq!(outcome.cli_path, user_codex);
        assert_eq!(outcome.installed_version, "0.42.1");
        assert_eq!(state.cli_path.as_deref(), Some(user_codex.as_path()));
        assert_eq!(state.cli_installed_version.as_deref(), Some("0.42.1"));
        assert_eq!(state.cli_latest_version.as_deref(), Some("0.42.1"));
        assert_eq!(state.cli_status, CliStatus::UpToDate);
        assert_eq!(read_installed_version(&system_codex)?, "0.42.0");
        Ok(())
    }

    #[test]
    fn reconcile_if_present_does_not_downgrade_newer_cli() -> Result<()> {
        let _env_guard = env_lock();
        let temp = tempdir()?;
        let paths = test_runtime_paths(temp.path());
        paths.ensure_dirs()?;

        let bin_dir = temp.path().join("bin");
        fs::create_dir_all(&bin_dir)?;

        let codex_path = bin_dir.join("codex");
        write_executable_script(
            &codex_path,
            "#!/bin/sh\nif [ \"$1\" = \"--version\" ] || [ \"$1\" = \"version\" ]; then\n  echo 'codex-cli v0.43.0'\n  exit 0\nfi\nexit 1\n",
        )?;

        let npm_path = bin_dir.join("npm");
        write_executable_script(
            &npm_path,
            "#!/bin/sh\nif [ \"$1\" = \"view\" ] && [ \"$2\" = \"@openai/codex\" ] && [ \"$3\" = \"version\" ]; then\n  echo '0.42.1'\n  exit 0\nfi\necho 'npm install should not run for newer installed Codex CLI' >&2\nexit 42\n",
        )?;

        let _restore_env = EnvRestoreGuard::capture(&["HOME", "PATH", "NVM_DIR"]);
        std::env::set_var("HOME", temp.path());
        std::env::set_var("PATH", std::env::join_paths([bin_dir.clone()])?);
        std::env::remove_var("NVM_DIR");

        assert_eq!(npm_program(), npm_path);

        let mut state = PersistedState::new(true);
        state.cli_path = Some(codex_path.clone());

        let updated = reconcile_if_present(&mut state, &paths)?;

        assert!(!updated);
        assert_eq!(state.cli_path.as_deref(), Some(codex_path.as_path()));
        assert_eq!(state.cli_installed_version.as_deref(), Some("0.43.0"));
        assert_eq!(state.cli_latest_version.as_deref(), Some("0.42.1"));
        assert_eq!(state.cli_status, CliStatus::UpToDate);
        assert_eq!(read_installed_version(&codex_path)?, "0.43.0");
        Ok(())
    }
}
