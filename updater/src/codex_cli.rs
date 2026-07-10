//! CLI discovery and prelaunch update checks for the user-installed Codex CLI.

use crate::{
    cli_management,
    config::RuntimePaths,
    state::{CliStatus, PersistedState},
};
use anyhow::{anyhow, Context, Result};
use chrono::{Duration, Utc};
use semver::Version;
use serde::Deserialize;
use std::{
    collections::BTreeMap,
    ffi::{OsStr, OsString},
    fs,
    io::Write,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
};
use tracing::{info, warn};

const CLI_PACKAGE_NAME: &str = "@openai/codex";
const STANDALONE_INSTALLER_URL: &str = "https://chatgpt.com/codex/install.sh";
const CLI_NOT_INSTALLED_MESSAGE: &str =
    "Codex CLI is required but not currently installed. Open the app to retry the automatic install flow, or install it manually with npm optional dependencies enabled.";
const CLI_VERSION_CHECK_TTL: Duration = Duration::hours(1);
#[cfg(test)]
const CLI_INSTALLED_VERSION_TTL: Duration = Duration::hours(1);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreflightOutcome {
    pub cli_path: PathBuf,
    pub installed_version: String,
    pub official_latest_version: Option<String>,
    pub package_manager_latest_version: Option<String>,
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
    let path_env = command_path_env();
    let managed_cli = cli_management::detect_system_package_managed_cli(&cli_path, &path_env);
    let mut repaired_npm_install = None;
    let installed_version = match read_installed_version(&cli_path) {
        Ok(version) => version,
        Err(probe_error) => {
            let Some(missing_dependency) = missing_platform_optional_dependency(&probe_error)
            else {
                return Err(probe_error);
            };
            if managed_cli.is_some() {
                return Err(probe_error);
            }
            let Some(npm_install) = npm_cli_install(&cli_path, &missing_dependency) else {
                return Err(probe_error);
            };

            warn!(
                ?probe_error,
                "repairing Codex CLI with missing platform optional dependency"
            );
            state.cli_path = Some(cli_path.clone());
            state.cli_installed_version = None;
            state.cli_package_manager_latest_version = None;
            state.cli_last_verified_at = None;
            state.cli_status = CliStatus::Updating;
            state.cli_error_message = None;
            persist_state(paths, state)?;

            let repaired_version = repair_npm_optional_dependency(&npm_install)
                .and_then(|()| read_installed_version(&cli_path))
                .with_context(|| {
                    format!(
                        "Failed to repair npm-managed Codex CLI at {} after its version probe failed: {probe_error}",
                        cli_path.display()
                    )
                });
            match repaired_version {
                Ok(version) => {
                    repaired_npm_install = Some(npm_install);
                    version
                }
                Err(error) => {
                    persist_cli_failure(state, paths, &error)?;
                    return Err(error);
                }
            }
        }
    };
    let repaired = repaired_npm_install.is_some();
    let package_manager_version_status =
        current_package_manager_version_status(managed_cli.as_ref(), &path_env);
    let cached_installed_version = state.cli_installed_version.clone();
    state.cli_path = Some(cli_path.clone());
    state.cli_installed_version = Some(installed_version.clone());
    state.cli_package_manager_latest_version = package_manager_version_status
        .as_ref()
        .map(|status| status.latest_version.clone());
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
        refresh_cli_status_from_latest(
            state,
            &cli_path,
            &installed_version,
            managed_cli.as_ref(),
            package_manager_version_status.as_ref(),
        );
        persist_state(paths, state)?;
        return Ok(preflight_outcome_from_state(
            cli_path,
            installed_version,
            state,
            repaired,
        ));
    }

    state.cli_last_check_at = Some(Utc::now());
    state.cli_error_message = None;
    state.cli_status = CliStatus::Checking;
    persist_state(paths, state)?;

    let latest_version_result = repaired_npm_install
        .as_ref()
        .map_or_else(read_latest_version, |install| {
            read_latest_version_with_npm(&install.npm_program, &install.command_path_env())
        });
    let official_latest_version = match latest_version_result {
        Ok(version) => Some(version),
        Err(error) => {
            state.cli_official_latest_version = None;
            if managed_cli.is_none() {
                state.cli_status = CliStatus::Unknown;
                state.cli_error_message = Some(format!(
                    "Could not check the latest {CLI_PACKAGE_NAME} version: {error}"
                ));
                persist_state(paths, state)?;
                warn!(?error, "unable to check latest Codex CLI version");
                return Ok(preflight_outcome_from_state(
                    cli_path,
                    installed_version,
                    state,
                    repaired,
                ));
            }
            warn!(?error, "unable to check latest official Codex CLI version");
            None
        }
    };

    state.cli_official_latest_version = official_latest_version.clone();

    refresh_cli_status_from_latest(
        state,
        &cli_path,
        &installed_version,
        managed_cli.as_ref(),
        package_manager_version_status.as_ref(),
    );

    if managed_cli.is_some() {
        persist_state(paths, state)?;
        return Ok(preflight_outcome_from_state(
            cli_path,
            installed_version,
            state,
            repaired,
        ));
    }

    let latest_version = match official_latest_version {
        Some(version) => version,
        None => {
            state.cli_status = CliStatus::Unknown;
            state.cli_official_latest_version = None;
            state.cli_error_message = Some(format!(
                "Could not check the latest {CLI_PACKAGE_NAME} version"
            ));
            persist_state(paths, state)?;
            return Ok(preflight_outcome_from_state(
                cli_path,
                installed_version,
                state,
                repaired,
            ));
        }
    };
    if state.cli_status == CliStatus::UpToDate {
        persist_state(paths, state)?;
        return Ok(preflight_outcome_from_state(
            cli_path,
            installed_version,
            state,
            repaired,
        ));
    }
    if repaired {
        persist_state(paths, state)?;
        return Ok(preflight_outcome_from_state(
            cli_path,
            installed_version,
            state,
            true,
        ));
    }

    persist_state(paths, state)?;
    info!(
        installed_version,
        latest_version, "Codex CLI is outdated; attempting prelaunch upgrade"
    );

    state.cli_status = CliStatus::Updating;
    persist_state(paths, state)?;
    if let Err(error) = update_existing_cli(&cli_path, &latest_version) {
        persist_cli_failure(state, paths, &error)?;
        return Err(error);
    }

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
    Ok(preflight_outcome_from_state(
        refreshed_path,
        refreshed_version,
        state,
        true,
    ))
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
    let path_env = command_path_env();
    let managed_cli = cli_management::detect_system_package_managed_cli(&cli_path, &path_env);
    let package_manager_version_status =
        current_package_manager_version_status(managed_cli.as_ref(), &path_env);

    state.cli_path = Some(cli_path.clone());
    state.cli_installed_version = Some(installed_version.clone());
    state.cli_package_manager_latest_version = package_manager_version_status
        .as_ref()
        .map(|status| status.latest_version.clone());
    refresh_cli_status_from_latest(
        state,
        &cli_path,
        &installed_version,
        managed_cli.as_ref(),
        package_manager_version_status.as_ref(),
    );

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
    let path_env = command_path_env();
    let managed_cli = cli_management::detect_system_package_managed_cli(&cli_path, &path_env);
    let package_manager_version_status =
        current_package_manager_version_status(managed_cli.as_ref(), &path_env);

    let cached_installed_version = state.cli_installed_version.clone();
    let installed_version = match read_installed_version(&cli_path) {
        Ok(version) => version,
        Err(error) => {
            state.cli_path = Some(cli_path);
            state.cli_installed_version = None;
            state.cli_package_manager_latest_version = None;
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

    state.cli_path = Some(cli_path.clone());
    state.cli_installed_version = Some(installed_version.clone());
    state.cli_package_manager_latest_version = package_manager_version_status
        .as_ref()
        .map(|status| status.latest_version.clone());
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
        refresh_cli_status_from_latest(
            state,
            &cli_path,
            &installed_version,
            managed_cli.as_ref(),
            package_manager_version_status.as_ref(),
        );
        persist_state(paths, state)?;
        return Ok(());
    }

    state.cli_last_check_at = Some(Utc::now());
    state.cli_error_message = None;
    state.cli_status = CliStatus::Checking;
    persist_state(paths, state)?;

    match read_latest_version() {
        Ok(latest_version) => {
            state.cli_official_latest_version = Some(latest_version);
            refresh_cli_status_from_latest(
                state,
                &cli_path,
                &installed_version,
                managed_cli.as_ref(),
                package_manager_version_status.as_ref(),
            );
        }
        Err(error) => {
            if managed_cli.is_some() {
                state.cli_official_latest_version = None;
                refresh_cli_status_from_latest(
                    state,
                    &cli_path,
                    &installed_version,
                    managed_cli.as_ref(),
                    package_manager_version_status.as_ref(),
                );
                warn!(?error, "unable to check latest official Codex CLI version");
            } else {
                let cached_latest_matches_install = cached_latest_version_matches_install(
                    state,
                    cached_installed_version.as_deref(),
                    &installed_version,
                );
                if cached_latest_matches_install {
                    refresh_cli_status_from_latest(
                        state,
                        &cli_path,
                        &installed_version,
                        managed_cli.as_ref(),
                        package_manager_version_status.as_ref(),
                    );
                } else {
                    state.cli_status = CliStatus::Unknown;
                }
                state.cli_error_message = Some(format!(
                    "Could not check the latest {CLI_PACKAGE_NAME} version: {error}"
                ));
                warn!(?error, "unable to check latest Codex CLI version");
            }
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

fn persist_cli_failure(
    state: &mut PersistedState,
    paths: &RuntimePaths,
    error: &anyhow::Error,
) -> Result<()> {
    state.cli_status = CliStatus::Failed;
    state.cli_error_message = Some(format!("{error:#}"));
    persist_state(paths, state)
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
    let home = std::env::var_os("HOME").map(PathBuf::from);
    if let Some(active_dir) = std::env::var_os("FNM_MULTISHELL_PATH").map(PathBuf::from) {
        candidates.push(active_dir.join("bin/codex"));
    }
    for root in fnm_roots(home.as_deref()) {
        append_fnm_cli_locations(&mut candidates, root);
    }
    if let Some(home) = home {
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

fn append_fnm_cli_locations(candidates: &mut Vec<PathBuf>, fnm_root: PathBuf) {
    candidates.push(fnm_root.join("aliases/default/bin/codex"));
    candidates.extend(
        fnm_installation_dirs(&fnm_root)
            .into_iter()
            .map(|path| path.join("bin/codex")),
    );
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
    state.cli_package_manager_latest_version = None;
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
    state.cli_official_latest_version.is_some()
        && cached_installed_version == Some(installed_version)
}

fn refresh_cli_status_from_latest(
    state: &mut PersistedState,
    cli_path: &Path,
    installed_version: &str,
    managed_cli: Option<&cli_management::SystemPackageManagedCli>,
    package_manager_version_status: Option<&cli_management::PacmanPackageVersionStatus>,
) {
    match managed_cli {
        Some(cli_management::SystemPackageManagedCli::ManagedByPacman { package_name, .. }) => {
            match package_manager_version_status {
                Some(status) if status.update_available => {
                    state.cli_status = CliStatus::UpdateRequired;
                    state.cli_error_message = Some(format!(
                        "This Codex CLI is managed by pacman package '{package_name}'. Pacman currently offers {}. Update it through pacman instead of npm (for example: sudo pacman -Syu).",
                        status.latest_version
                    ));
                }
                Some(status) => {
                    state.cli_status = CliStatus::UpToDate;
                    state.cli_error_message = state
                        .cli_official_latest_version
                        .as_deref()
                        .filter(|official_latest| {
                            !installed_cli_version_satisfies_latest(installed_version, official_latest)
                        })
                        .map(|official_latest| {
                            format!(
                                "This Codex CLI is managed by pacman package '{package_name}'. Pacman does not currently offer a newer package (latest known package: {}), but the official {CLI_PACKAGE_NAME} upstream is {official_latest}. Decide for yourself whether to keep the distro-managed package or switch CLI installation channels.",
                                status.latest_version
                            )
                        });
                }
                None => {
                    state.cli_status = CliStatus::Unknown;
                    state.cli_error_message = Some(format!(
                        "This Codex CLI is managed by pacman package '{package_name}', but Codex Desktop could not determine the latest version currently available through pacman. This install will not be auto-updated through npm; check pacman directly."
                    ));
                }
            }
        }
        Some(cli_management::SystemPackageManagedCli::PacmanOwnershipUnknown { query_path }) => {
            match state.cli_official_latest_version.as_deref() {
                Some(official_latest)
                    if installed_cli_version_satisfies_latest(
                        installed_version,
                        official_latest,
                    ) =>
                {
                    state.cli_status = CliStatus::UpToDate;
                    state.cli_error_message = None;
                }
                Some(official_latest) => {
                    state.cli_status = CliStatus::Unknown;
                    state.cli_error_message = Some(format!(
                        "Codex Desktop resolved Codex CLI to {}, but pacman -Qo {} could not determine which package owns it. The official {CLI_PACKAGE_NAME} upstream is {official_latest}; this install will not be auto-updated through npm, so inspect the CLI source and decide how to update it.",
                        cli_path.display(),
                        query_path.display()
                    ));
                }
                None => {
                    state.cli_status = CliStatus::Unknown;
                    state.cli_error_message = Some(format!(
                        "Codex Desktop resolved Codex CLI to {}, but pacman -Qo {} could not determine which package owns it, and the official {CLI_PACKAGE_NAME} version could not be checked. This install will not be auto-updated through npm; inspect the CLI source and decide how to update it.",
                        cli_path.display(),
                        query_path.display()
                    ));
                }
            }
        }
        None => match state.cli_official_latest_version.as_deref() {
            Some(latest_version)
                if installed_cli_version_satisfies_latest(installed_version, latest_version) =>
            {
                state.cli_status = CliStatus::UpToDate;
                state.cli_error_message = None;
            }
            Some(_) => {
                state.cli_status = CliStatus::UpdateRequired;
                state.cli_error_message = None;
            }
            None => {
                state.cli_status = CliStatus::Unknown;
                state.cli_error_message = None;
            }
        },
    }
}

fn current_package_manager_version_status(
    managed_cli: Option<&cli_management::SystemPackageManagedCli>,
    path_env: &OsString,
) -> Option<cli_management::PacmanPackageVersionStatus> {
    managed_cli.and_then(|managed_cli| {
        cli_management::query_package_manager_version_status(managed_cli, path_env)
    })
}

fn preflight_outcome_from_state(
    cli_path: PathBuf,
    installed_version: String,
    state: &PersistedState,
    updated: bool,
) -> PreflightOutcome {
    PreflightOutcome {
        cli_path,
        installed_version,
        official_latest_version: state.cli_official_latest_version.clone(),
        package_manager_latest_version: state.cli_package_manager_latest_version.clone(),
        updated,
    }
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

fn missing_platform_optional_dependency(error: &anyhow::Error) -> Option<String> {
    const ERROR_PREFIX: &str = "Missing optional dependency ";
    let message = error.to_string();
    let dependency = message
        .split_once(ERROR_PREFIX)?
        .1
        .split_whitespace()
        .next()?
        .trim_end_matches('.');
    match dependency {
        "@openai/codex-linux-x64" | "@openai/codex-linux-arm64" => Some(dependency.to_string()),
        _ => None,
    }
}

fn read_latest_version() -> Result<String> {
    let npm = npm_program();
    read_latest_version_with_npm(&npm, &command_path_env())
}

fn read_latest_version_with_npm(npm: &Path, path_env: &OsString) -> Result<String> {
    let output = Command::new(npm)
        .env("PATH", path_env)
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

#[derive(Debug, Clone, PartialEq, Eq)]
struct NpmCliInstall {
    package_root: PathBuf,
    npm_program: PathBuf,
}

impl NpmCliInstall {
    fn command_path_env(&self) -> OsString {
        let fallback = command_path_env();
        let Some(toolchain_bin) = self.npm_program.parent() else {
            return fallback;
        };
        let mut entries = vec![toolchain_bin.to_path_buf()];
        entries.extend(std::env::split_paths(&fallback).filter(|entry| entry != toolchain_bin));
        std::env::join_paths(entries).unwrap_or(fallback)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodexNpmPackageManifest {
    name: String,
    bin: CodexNpmPackageBins,
    optional_dependencies: BTreeMap<String, String>,
}

#[derive(Deserialize)]
struct CodexNpmPackageBins {
    codex: String,
}

fn npm_cli_install(cli_path: &Path, missing_dependency: &str) -> Option<NpmCliInstall> {
    if cli_path.file_name()? != OsStr::new("codex")
        || !fs::symlink_metadata(cli_path)
            .ok()?
            .file_type()
            .is_symlink()
    {
        return None;
    }

    let entrypoint = fs::canonicalize(cli_path).ok()?;
    if entrypoint.file_name()? != OsStr::new("codex.js") {
        return None;
    }
    let entrypoint_bin = entrypoint.parent()?;
    if entrypoint_bin.file_name()? != OsStr::new("bin") {
        return None;
    }
    let package_root = entrypoint_bin.parent()?;
    let scope_dir = package_root.parent()?;
    let node_modules_dir = scope_dir.parent()?;
    let lib_dir = node_modules_dir.parent()?;
    if package_root.file_name()? != OsStr::new("codex")
        || scope_dir.file_name()? != OsStr::new("@openai")
        || node_modules_dir.file_name()? != OsStr::new("node_modules")
        || lib_dir.file_name()? != OsStr::new("lib")
    {
        return None;
    }

    let prefix = lib_dir.parent()?;
    if path_is_system_managed_location(prefix)
        || lib_dir.join("bun.lock").exists()
        || lib_dir.join("pnpm-lock.yaml").exists()
        || node_modules_dir.join(".modules.yaml").exists()
    {
        return None;
    }
    let toolchain_bin = prefix.join("bin");
    if fs::canonicalize(cli_path.parent()?).ok()? != fs::canonicalize(&toolchain_bin).ok()? {
        return None;
    }
    let npm_program = toolchain_bin.join("npm");
    if !is_executable(&npm_program) {
        return None;
    }

    let manifest = fs::read(package_root.join("package.json"))
        .ok()
        .and_then(|contents| serde_json::from_slice::<CodexNpmPackageManifest>(&contents).ok())?;
    if manifest.name != CLI_PACKAGE_NAME
        || manifest.bin.codex != "bin/codex.js"
        || !manifest
            .optional_dependencies
            .contains_key(missing_dependency)
    {
        return None;
    }

    Some(NpmCliInstall {
        package_root: package_root.to_path_buf(),
        npm_program,
    })
}

fn path_is_system_managed_location(path: &Path) -> bool {
    path == Path::new("/")
        || ["/usr", "/bin", "/sbin", "/opt", "/nix", "/snap"]
            .into_iter()
            .any(|root| path.starts_with(root))
}

fn repair_npm_optional_dependency(install: &NpmCliInstall) -> Result<()> {
    let args = [
        OsString::from("install"),
        OsString::from("--include=optional"),
    ];
    let output = Command::new(&install.npm_program)
        .current_dir(&install.package_root)
        .env("PATH", install.command_path_env())
        .args(&args)
        .output()
        .with_context(|| format!("Failed to spawn {}", install.npm_program.display()))?;

    anyhow::ensure!(
        output.status.success(),
        "{} {} failed with {}{}",
        install.npm_program.display(),
        format_command_args(&args),
        output.status,
        format_command_output(&output)
    );

    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum CliInstallKind {
    Standalone(StandaloneCliInstall),
    Npm,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct StandaloneCliInstall {
    codex_home: PathBuf,
    install_dir: Option<PathBuf>,
}

fn update_existing_cli(cli_path: &Path, latest_version: &str) -> Result<()> {
    match classify_cli_install(cli_path) {
        CliInstallKind::Standalone(install) => update_standalone_cli(&install, latest_version),
        CliInstallKind::Npm => install_latest_cli(latest_version),
    }
}

fn classify_cli_install(cli_path: &Path) -> CliInstallKind {
    standalone_cli_install(cli_path)
        .map(CliInstallKind::Standalone)
        .unwrap_or(CliInstallKind::Npm)
}

fn standalone_cli_install(cli_path: &Path) -> Option<StandaloneCliInstall> {
    let canonical_path = fs::canonicalize(cli_path).ok();
    let codex_home = canonical_path
        .as_deref()
        .and_then(standalone_home_from_path)
        .or_else(|| standalone_home_from_path(cli_path))?;
    let cli_path_is_standalone = standalone_home_from_path(cli_path).is_some();
    let install_dir = if cli_path_is_standalone {
        None
    } else {
        cli_path.parent().and_then(|parent| {
            if parent.as_os_str().is_empty() {
                None
            } else {
                Some(parent.to_path_buf())
            }
        })
    };

    Some(StandaloneCliInstall {
        codex_home,
        install_dir,
    })
}

fn standalone_home_from_path(path: &Path) -> Option<PathBuf> {
    let components = path.components().collect::<Vec<_>>();
    for (index, window) in components.windows(3).enumerate() {
        if window[0].as_os_str() != OsStr::new("packages")
            || window[1].as_os_str() != OsStr::new("standalone")
        {
            continue;
        }
        if window[2].as_os_str() != OsStr::new("current")
            && window[2].as_os_str() != OsStr::new("releases")
        {
            continue;
        }

        let mut codex_home = PathBuf::new();
        for component in &components[..index] {
            codex_home.push(component.as_os_str());
        }
        if codex_home.as_os_str().is_empty() {
            return None;
        }
        return Some(codex_home);
    }

    None
}

fn update_standalone_cli(install: &StandaloneCliInstall, latest_version: &str) -> Result<()> {
    let downloader = standalone_installer_downloader()?;
    let installer_script = downloader.download_installer()?;
    let mut command = Command::new("sh");
    command
        .arg("-s")
        .env("PATH", command_path_env())
        .env("CODEX_RELEASE", latest_version)
        .env("CODEX_NON_INTERACTIVE", "1")
        .env("CODEX_HOME", &install.codex_home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(install_dir) = &install.install_dir {
        command.env("CODEX_INSTALL_DIR", install_dir);
    }

    let mut child = command
        .spawn()
        .with_context(|| "Failed to spawn standalone Codex CLI installer")?;

    {
        let mut stdin = child
            .stdin
            .take()
            .context("Failed to open standalone Codex CLI installer stdin")?;
        stdin
            .write_all(&installer_script)
            .with_context(|| "Failed to write standalone Codex CLI installer script")?;
    }

    let output = child
        .wait_with_output()
        .with_context(|| "Failed to wait for standalone Codex CLI installer")?;

    anyhow::ensure!(
        output.status.success(),
        "standalone Codex CLI installer failed with {}{}",
        output.status,
        format_command_output(&output)
    );

    Ok(())
}

enum StandaloneInstallerDownloader {
    Curl(PathBuf),
    Wget(PathBuf),
}

impl StandaloneInstallerDownloader {
    fn download_installer(&self) -> Result<Vec<u8>> {
        let output = match self {
            Self::Curl(program) => Command::new(program)
                .env("PATH", command_path_env())
                .args(["-fsSL", STANDALONE_INSTALLER_URL])
                .output()
                .with_context(|| {
                    format!(
                        "Failed to spawn standalone Codex CLI installer downloader {}",
                        program.display()
                    )
                })?,
            Self::Wget(program) => Command::new(program)
                .env("PATH", command_path_env())
                .args(["-q", "-O", "-", STANDALONE_INSTALLER_URL])
                .output()
                .with_context(|| {
                    format!(
                        "Failed to spawn standalone Codex CLI installer downloader {}",
                        program.display()
                    )
                })?,
        };

        anyhow::ensure!(
            output.status.success(),
            "standalone Codex CLI installer download failed with {}{}",
            output.status,
            format_command_output(&output)
        );
        anyhow::ensure!(
            !output.stdout.is_empty(),
            "standalone Codex CLI installer download returned an empty script"
        );

        Ok(output.stdout)
    }
}

fn standalone_installer_downloader() -> Result<StandaloneInstallerDownloader> {
    let path_env = command_path_env();
    if let Some(path) = find_in_path("curl", &path_env) {
        return Ok(StandaloneInstallerDownloader::Curl(resolved_program_path(
            path,
        )));
    }
    if let Some(path) = find_in_path("wget", &path_env) {
        return Ok(StandaloneInstallerDownloader::Wget(resolved_program_path(
            path,
        )));
    }

    anyhow::bail!(
        "curl or wget is required to run the standalone Codex CLI installer from {STANDALONE_INSTALLER_URL}"
    );
}

fn resolved_program_path(path: PathBuf) -> PathBuf {
    fs::canonicalize(&path).unwrap_or(path)
}

fn install_latest_cli(latest_version: &str) -> Result<()> {
    let npm = npm_program();
    let package_spec = format!("{CLI_PACKAGE_NAME}@{latest_version}");
    let global_args = vec![
        OsString::from("install"),
        OsString::from("-g"),
        OsString::from("--include=optional"),
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
                OsString::from("--include=optional"),
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
    state.cli_official_latest_version = Some(latest_version.clone());
    state.cli_package_manager_latest_version = None;
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

fn xdg_fnm_root(home: &Path) -> PathBuf {
    std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".local/share"))
        .join("fnm")
}

fn fnm_roots(home: Option<&Path>) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(root) = std::env::var_os("FNM_DIR").filter(|value| !value.is_empty()) {
        roots.push(PathBuf::from(root));
    }
    if let Some(home) = home {
        roots.push(xdg_fnm_root(home));
        roots.push(home.join(".fnm"));
    }
    dedupe_paths(roots)
}

fn fnm_installation_dirs(fnm_root: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(fnm_root.join("node-versions")) else {
        return Vec::new();
    };
    let mut versions = entries
        .filter_map(|entry| entry.ok().map(|item| item.path()))
        .collect::<Vec<_>>();
    versions.sort_by(|left, right| {
        let left_version = left
            .file_name()
            .and_then(|name| name.to_str())
            .and_then(|name| Version::parse(name.trim_start_matches('v')).ok());
        let right_version = right
            .file_name()
            .and_then(|name| name.to_str())
            .and_then(|name| Version::parse(name.trim_start_matches('v')).ok());
        match (left_version, right_version) {
            (Some(left), Some(right)) => right.cmp(&left),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => right.file_name().cmp(&left.file_name()),
        }
    });
    versions
        .into_iter()
        .map(|path| path.join("installation"))
        .collect()
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
    let mut directories = Vec::new();
    if let Some(nvm_root) = default_nvm_root() {
        append_nvm_node_toolchain_dirs(&mut directories, nvm_root);
    }

    let home = std::env::var_os("HOME").map(PathBuf::from);
    if let Some(active_dir) = std::env::var_os("FNM_MULTISHELL_PATH").map(PathBuf::from) {
        let active_bin = active_dir.join("bin");
        if node_toolchain_dir(&active_bin) {
            directories.push(active_bin);
        }
    }
    for root in fnm_roots(home.as_deref()) {
        append_fnm_node_toolchain_dirs(&mut directories, root);
    }

    dedupe_paths(directories)
}

fn append_nvm_node_toolchain_dirs(directories: &mut Vec<PathBuf>, nvm_root: PathBuf) {
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
}

fn append_fnm_node_toolchain_dirs(directories: &mut Vec<PathBuf>, fnm_root: PathBuf) {
    let default_bin = fnm_root.join("aliases/default/bin");
    if node_toolchain_dir(&default_bin) {
        directories.push(default_bin);
    }
    directories.extend(
        fnm_installation_dirs(&fnm_root)
            .into_iter()
            .map(|path| path.join("bin"))
            .filter(|path| node_toolchain_dir(path)),
    );
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
        test_util::{env_lock, EnvRestoreGuard},
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

    #[derive(Debug)]
    struct NpmCliFixture {
        visible_cli: PathBuf,
        package_root: PathBuf,
        entrypoint: PathBuf,
        npm_program: PathBuf,
    }

    fn write_npm_cli_install(prefix: &Path, entrypoint_contents: &str) -> Result<NpmCliFixture> {
        let package_root = prefix.join("lib/node_modules/@openai/codex");
        let entrypoint = package_root.join("bin/codex.js");
        let toolchain_bin = prefix.join("bin");
        let visible_cli = toolchain_bin.join("codex");
        let npm_program = toolchain_bin.join("npm");

        fs::create_dir_all(
            entrypoint
                .parent()
                .context("npm CLI entrypoint has no parent")?,
        )?;
        fs::create_dir_all(&toolchain_bin)?;
        write_executable_script(&entrypoint, entrypoint_contents)?;
        fs::write(
            package_root.join("package.json"),
            r#"{
  "name": "@openai/codex",
  "bin": { "codex": "bin/codex.js" },
  "optionalDependencies": {
    "@openai/codex-linux-x64": "0.42.1-linux-x64",
    "@openai/codex-linux-arm64": "0.42.1-linux-arm64"
  }
}
"#,
        )?;
        std::os::unix::fs::symlink(
            Path::new("../lib/node_modules/@openai/codex/bin/codex.js"),
            &visible_cli,
        )?;

        Ok(NpmCliFixture {
            visible_cli,
            package_root,
            entrypoint,
            npm_program,
        })
    }

    fn configure_cli_test_env<I>(home: &Path, path_entries: I) -> Result<EnvRestoreGuard>
    where
        I: IntoIterator<Item = PathBuf>,
    {
        let restore = EnvRestoreGuard::capture(&[
            "HOME",
            "PATH",
            "NVM_DIR",
            "XDG_DATA_HOME",
            "FNM_DIR",
            "FNM_MULTISHELL_PATH",
            "CODEX_CLI_PATH",
            "CODEX_UPDATE_MANAGER_SKIP_SYSTEM_CLI_LOOKUP",
            "DECOY_NPM_LOG",
            "FAKE_CODEX_ENTRYPOINT",
            "NPM_LOG",
            "NPM_REPAIR_LOG",
        ]);
        std::env::set_var("HOME", home);
        std::env::set_var("PATH", std::env::join_paths(path_entries)?);
        std::env::remove_var("NVM_DIR");
        std::env::remove_var("CODEX_CLI_PATH");
        std::env::set_var("CODEX_UPDATE_MANAGER_SKIP_SYSTEM_CLI_LOOKUP", "1");
        Ok(restore)
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

    fn write_standalone_codex_release(
        codex_home: &Path,
        version: &str,
        target: &str,
    ) -> Result<PathBuf> {
        let release_dir = codex_home
            .join("packages/standalone/releases")
            .join(format!("{version}-{target}"));
        let release_bin = release_dir.join("bin");
        fs::create_dir_all(&release_bin)?;
        write_executable_script(
            &release_bin.join("codex"),
            &format!(
                "#!/bin/sh\nif [ \"$1\" = \"--version\" ] || [ \"$1\" = \"version\" ]; then\n  echo 'codex-cli v{version}'\n  exit 0\nfi\nexit 1\n"
            ),
        )?;
        Ok(release_dir)
    }

    fn link_standalone_cli(
        codex_home: &Path,
        install_dir: &Path,
        release_dir: &Path,
    ) -> Result<PathBuf> {
        let standalone_root = codex_home.join("packages/standalone");
        fs::create_dir_all(&standalone_root)?;
        fs::create_dir_all(install_dir)?;

        let current_link = standalone_root.join("current");
        let _ = fs::remove_file(&current_link);
        std::os::unix::fs::symlink(release_dir, &current_link)?;

        let visible_codex = install_dir.join("codex");
        let _ = fs::remove_file(&visible_codex);
        std::os::unix::fs::symlink(current_link.join("bin/codex"), &visible_codex)?;

        Ok(visible_codex)
    }

    fn link_test_system_tool(tool_bin: &Path, name: &str) -> Result<()> {
        let target = [
            PathBuf::from("/bin").join(name),
            PathBuf::from("/usr/bin").join(name),
        ]
        .into_iter()
        .find(|candidate| candidate.is_file())
        .ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!("system tool {name} not found"),
            )
        })?;
        let link_path = tool_bin.join(name);
        if !link_path.exists() {
            std::os::unix::fs::symlink(target, link_path)?;
        }
        Ok(())
    }

    fn set_test_path_with_tool_bin(tool_bin: &Path) -> Result<()> {
        for tool in ["sh", "cat", "mkdir", "ln", "chmod"] {
            link_test_system_tool(tool_bin, tool)?;
        }
        std::env::set_var("PATH", std::env::join_paths([tool_bin.to_path_buf()])?);
        Ok(())
    }

    fn write_fake_latest_npm(
        tool_bin: &Path,
        latest_version: &str,
        install_log: &Path,
    ) -> Result<()> {
        let npm_path = tool_bin.join("npm");
        write_executable_script(
            &npm_path,
            &format!(
                "#!/bin/sh\nif [ \"$1\" = \"view\" ] && [ \"$2\" = \"@openai/codex\" ] && [ \"$3\" = \"version\" ]; then\n  echo '{latest_version}'\n  exit 0\nfi\nif [ \"$1\" = \"install\" ]; then\n  echo npm-install >> \"{}\"\n  exit 42\nfi\nexit 1\n",
                install_log.display()
            ),
        )
    }

    fn write_fake_pacman_managed_package(
        tool_bin: &Path,
        package_name: &str,
        sync_version: &str,
        upgrade_version: Option<&str>,
        query_log: &Path,
    ) -> Result<PathBuf> {
        let pacman_path = tool_bin.join("pacman");
        write_executable_script(
            &pacman_path,
            &format!(
                "#!/bin/sh\necho \"$1|$2|$3\" >> \"{}\"\nif [ \"$1\" = \"-Qo\" ] && [ \"$2\" = \"--\" ]; then\n  printf '%s is owned by {} 0.143.0-1\\n' \"$3\"\n  exit 0\nfi\nif [ \"$1\" = \"-Si\" ] && [ \"$2\" = \"--\" ] && [ \"$3\" = \"{}\" ]; then\n  printf 'Repository      : extra\\nName            : {}\\nVersion         : {}\\n'\n  exit 0\nfi\nif [ \"$1\" = \"-Qu\" ] && [ \"$2\" = \"--\" ] && [ \"$3\" = \"{}\" ]; then\n{}\n  exit 0\nfi\nexit 1\n",
                query_log.display(),
                package_name,
                package_name,
                package_name,
                sync_version,
                package_name,
                upgrade_version.map_or_else(
                    String::new,
                    |version| format!("  printf '{} 0.42.0-1 -> {}\\n'\n", package_name, version),
                )
            ),
        )?;
        Ok(pacman_path)
    }

    fn write_fake_pacman_unknown_owner(tool_bin: &Path, query_log: &Path) -> Result<PathBuf> {
        let pacman_path = tool_bin.join("pacman");
        write_executable_script(
            &pacman_path,
            &format!(
                "#!/bin/sh\necho \"$1|$2|$3\" >> \"{}\"\nif [ \"$1\" = \"-Qo\" ] && [ \"$2\" = \"--\" ]; then\n  echo 'error: No package owns path' >&2\n  exit 1\nfi\nexit 1\n",
                query_log.display()
            ),
        )?;
        Ok(pacman_path)
    }

    fn write_fake_standalone_installer_curl(tool_bin: &Path) -> Result<()> {
        write_executable_script(
            &tool_bin.join("curl"),
            r#"#!/bin/sh
if [ "$1" = "-fsSL" ]; then
  cat <<'SCRIPT'
#!/bin/sh
set -eu
release_dir="$CODEX_HOME/packages/standalone/releases/$CODEX_RELEASE-test-target"
mkdir -p "$release_dir/bin" "$CODEX_INSTALL_DIR"
cat > "$release_dir/bin/codex" <<CODEX_BIN
#!/bin/sh
if [ "\$1" = "--version" ] || [ "\$1" = "version" ]; then
  echo 'codex-cli v$CODEX_RELEASE'
  exit 0
fi
exit 1
CODEX_BIN
chmod 0755 "$release_dir/bin/codex"
ln -sfn "$release_dir" "$CODEX_HOME/packages/standalone/current"
ln -sfn "$CODEX_HOME/packages/standalone/current/bin/codex" "$CODEX_INSTALL_DIR/codex"
SCRIPT
  exit 0
fi
exit 1
"#,
        )
    }

    fn write_failing_standalone_installer_curl(tool_bin: &Path, call_log: &Path) -> Result<()> {
        write_executable_script(
            &tool_bin.join("curl"),
            &format!(
                "#!/bin/sh\nif [ \"$1\" = \"-fsSL\" ]; then\n  echo curl-called >> \"{}\"\n  printf '%s\\n' '#!/bin/sh' 'exit 77'\n  exit 0\nfi\nexit 1\n",
                call_log.display()
            ),
        )
    }

    fn write_broken_install_dir_curl(install_dir: &Path, call_log: &Path) -> Result<()> {
        write_executable_script(
            &install_dir.join("curl"),
            &format!(
                "#!/bin/sh\necho install-dir-curl-called >> \"{}\"\nexit 99\n",
                call_log.display()
            ),
        )
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
            "FNM_DIR",
            "FNM_MULTISHELL_PATH",
            "CODEX_CLI_PATH",
            "CODEX_UPDATE_MANAGER_SKIP_SYSTEM_CLI_LOOKUP",
        ]);
        std::env::set_var("HOME", &home);
        std::env::set_var("PATH", temp.path().join("missing-bin"));
        std::env::remove_var("NVM_DIR");
        std::env::remove_var("XDG_CONFIG_HOME");
        std::env::remove_var("FNM_DIR");
        std::env::remove_var("FNM_MULTISHELL_PATH");
        std::env::remove_var("CODEX_CLI_PATH");
        std::env::set_var("CODEX_UPDATE_MANAGER_SKIP_SYSTEM_CLI_LOOKUP", "1");

        let command_path = command_path_env();
        assert!(std::env::split_paths(&command_path).any(|path| path == nvm_bin.as_path()));
        assert_eq!(resolve_cli_path(None), Some(codex_path));
        Ok(())
    }

    #[test]
    fn fnm_custom_root_uses_newest_version_without_shell_env() -> Result<()> {
        let _env_guard = env_lock();
        let temp = tempdir()?;
        let home = temp.path().join("home");
        let fnm_root = temp.path().join("custom-fnm");
        let old_bin = fnm_root.join("node-versions/v9.11.2/installation/bin");
        let fnm_bin = fnm_root.join("node-versions/v24.14.0/installation/bin");
        fs::create_dir_all(&old_bin)?;
        fs::create_dir_all(&fnm_bin)?;

        for bin in [&old_bin, &fnm_bin] {
            for binary in ["node", "npm", "npx"] {
                fs::write(bin.join(binary), "")?;
            }
            write_executable_script(&bin.join("codex"), "#!/bin/sh\necho 'codex-cli v0.144.1'\n")?;
        }
        let codex_path = fnm_bin.join("codex");

        let _restore_env = EnvRestoreGuard::capture(&[
            "HOME",
            "PATH",
            "NVM_DIR",
            "XDG_CONFIG_HOME",
            "XDG_DATA_HOME",
            "FNM_DIR",
            "FNM_MULTISHELL_PATH",
            "CODEX_CLI_PATH",
            "CODEX_UPDATE_MANAGER_SKIP_SYSTEM_CLI_LOOKUP",
        ]);
        std::env::set_var("HOME", &home);
        std::env::set_var("PATH", temp.path().join("missing-bin"));
        std::env::remove_var("NVM_DIR");
        std::env::remove_var("XDG_CONFIG_HOME");
        std::env::remove_var("XDG_DATA_HOME");
        std::env::set_var("FNM_DIR", &fnm_root);
        std::env::remove_var("FNM_MULTISHELL_PATH");
        std::env::remove_var("CODEX_CLI_PATH");
        std::env::set_var("CODEX_UPDATE_MANAGER_SKIP_SYSTEM_CLI_LOOKUP", "1");

        let command_path = command_path_env();
        assert!(std::env::split_paths(&command_path).any(|path| path == fnm_bin.as_path()));
        assert_eq!(resolve_cli_path(None), Some(codex_path));
        Ok(())
    }

    #[test]
    fn fnm_default_alias_is_preferred_over_newest_version() -> Result<()> {
        let _env_guard = env_lock();
        let temp = tempdir()?;
        let fnm_root = temp.path().join("fnm");
        let default_install = fnm_root.join("node-versions/v20.19.0/installation");
        let newest_install = fnm_root.join("node-versions/v24.14.0/installation");
        for install in [&default_install, &newest_install] {
            let bin = install.join("bin");
            fs::create_dir_all(&bin)?;
            for binary in ["node", "npm", "npx"] {
                fs::write(bin.join(binary), "")?;
            }
            write_executable_script(&bin.join("codex"), "#!/bin/sh\necho 'codex-cli v0.144.1'\n")?;
        }
        fs::create_dir_all(fnm_root.join("aliases"))?;
        std::os::unix::fs::symlink(&default_install, fnm_root.join("aliases/default"))?;

        let _restore_env = EnvRestoreGuard::capture(&[
            "HOME",
            "PATH",
            "NVM_DIR",
            "FNM_DIR",
            "FNM_MULTISHELL_PATH",
            "CODEX_CLI_PATH",
            "CODEX_UPDATE_MANAGER_SKIP_SYSTEM_CLI_LOOKUP",
        ]);
        std::env::set_var("HOME", temp.path().join("home"));
        std::env::set_var("PATH", temp.path().join("missing-bin"));
        std::env::remove_var("NVM_DIR");
        std::env::set_var("FNM_DIR", &fnm_root);
        std::env::remove_var("FNM_MULTISHELL_PATH");
        std::env::remove_var("CODEX_CLI_PATH");
        std::env::set_var("CODEX_UPDATE_MANAGER_SKIP_SYSTEM_CLI_LOOKUP", "1");

        assert_eq!(
            resolve_cli_path(None),
            Some(fnm_root.join("aliases/default/bin/codex"))
        );
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
        state.cli_official_latest_version = Some("0.42.1".to_string());
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
        state.cli_official_latest_version = Some("0.42.1".to_string());
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
        state.cli_official_latest_version = Some("0.42.0".to_string());
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
        state.cli_official_latest_version = Some("0.43.0".to_string());
        state.cli_last_check_at = Some(Utc::now() - Duration::minutes(30));
        refresh_status(&mut state, &paths)?;

        assert_eq!(state.cli_path.as_deref(), Some(codex_path.as_path()));
        assert_eq!(state.cli_installed_version.as_deref(), Some("0.42.0"));
        assert_eq!(state.cli_official_latest_version.as_deref(), Some("0.43.0"));
        assert_eq!(state.cli_package_manager_latest_version, None);
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
        state.cli_official_latest_version = Some("0.42.0".to_string());
        state.cli_last_check_at = Some(Utc::now() - Duration::minutes(5));
        state.cli_status = CliStatus::Unknown;
        state.cli_error_message = Some("previous error".to_string());

        let outcome = preflight(&mut state, &paths, Some(codex_path.clone()), false)?;

        assert_eq!(outcome.cli_path, codex_path);
        assert_eq!(outcome.installed_version, "0.42.0");
        assert_eq!(outcome.official_latest_version.as_deref(), Some("0.42.0"));
        assert_eq!(outcome.package_manager_latest_version, None);
        assert!(!outcome.updated);
        assert_eq!(state.cli_official_latest_version.as_deref(), Some("0.42.0"));
        assert_eq!(state.cli_package_manager_latest_version, None);
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
        state.cli_official_latest_version = Some("0.42.1".to_string());
        state.cli_last_check_at = Some(Utc::now() - Duration::minutes(30));
        state.cli_last_verified_at = Some(Utc::now() - Duration::minutes(30));

        refresh_cached_status(&mut state, &paths)?;

        assert_eq!(state.cli_path.as_deref(), Some(codex_path.as_path()));
        assert_eq!(state.cli_installed_version.as_deref(), Some("0.42.0"));
        assert_eq!(state.cli_official_latest_version.as_deref(), Some("0.42.1"));
        assert_eq!(state.cli_package_manager_latest_version, None);
        assert_eq!(state.cli_status, CliStatus::UpdateRequired);
        assert_eq!(state.cli_error_message, None);
        Ok(())
    }

    #[test]
    fn preflight_reports_actionable_pacman_update_without_running_npm_install() -> Result<()> {
        let _env_guard = env_lock();
        let temp = tempdir()?;
        let paths = test_runtime_paths(temp.path());
        paths.ensure_dirs()?;

        let tool_bin = temp.path().join("tool-bin");
        let pacman_bin = temp.path().join("pacman-bin");
        let system_root = temp.path().join("system-root/usr/bin");
        fs::create_dir_all(&tool_bin)?;
        fs::create_dir_all(&pacman_bin)?;
        fs::create_dir_all(&system_root)?;

        let codex_path = system_root.join("codex");
        write_executable_script(
            &codex_path,
            "#!/bin/sh\nif [ \"$1\" = \"--version\" ] || [ \"$1\" = \"version\" ]; then\n  echo 'codex-cli v0.42.0'\n  exit 0\nfi\nexit 1\n",
        )?;

        let npm_install_log = temp.path().join("npm-install.log");
        let pacman_query_log = temp.path().join("pacman-query.log");
        write_fake_latest_npm(&tool_bin, "0.42.2", &npm_install_log)?;
        let pacman_path = write_fake_pacman_managed_package(
            &pacman_bin,
            "openai-codex",
            "0.42.1-1",
            Some("0.42.1-1"),
            &pacman_query_log,
        )?;

        let _restore_env = EnvRestoreGuard::capture(&[
            "HOME",
            "PATH",
            "NVM_DIR",
            "CODEX_CLI_PATH",
            "CODEX_UPDATE_MANAGER_SKIP_SYSTEM_CLI_LOOKUP",
            "CODEX_UPDATE_MANAGER_TEST_SYSTEM_CLI_ROOT",
            "CODEX_UPDATE_MANAGER_TEST_PACMAN_PATH",
            "CODEX_UPDATE_MANAGER_TEST_FORCE_ARCH_HOST",
        ]);
        std::env::set_var("HOME", temp.path());
        set_test_path_with_tool_bin(&tool_bin)?;
        std::env::remove_var("NVM_DIR");
        std::env::remove_var("XDG_DATA_HOME");
        std::env::remove_var("FNM_DIR");
        std::env::remove_var("FNM_MULTISHELL_PATH");
        std::env::remove_var("CODEX_CLI_PATH");
        std::env::remove_var("CODEX_UPDATE_MANAGER_SKIP_SYSTEM_CLI_LOOKUP");
        std::env::set_var("CODEX_UPDATE_MANAGER_TEST_SYSTEM_CLI_ROOT", &system_root);
        std::env::set_var("CODEX_UPDATE_MANAGER_TEST_PACMAN_PATH", &pacman_path);
        std::env::set_var("CODEX_UPDATE_MANAGER_TEST_FORCE_ARCH_HOST", "1");

        let mut state = PersistedState::new(true);
        let outcome = preflight(&mut state, &paths, Some(codex_path.clone()), false)?;

        assert!(!outcome.updated);
        assert_eq!(outcome.cli_path, codex_path);
        assert_eq!(outcome.installed_version, "0.42.0");
        assert_eq!(outcome.official_latest_version.as_deref(), Some("0.42.2"));
        assert_eq!(
            outcome.package_manager_latest_version.as_deref(),
            Some("0.42.1-1")
        );
        assert_eq!(state.cli_status, CliStatus::UpdateRequired);
        assert_eq!(state.cli_installed_version.as_deref(), Some("0.42.0"));
        assert_eq!(state.cli_official_latest_version.as_deref(), Some("0.42.2"));
        assert_eq!(
            state.cli_package_manager_latest_version.as_deref(),
            Some("0.42.1-1")
        );
        assert_eq!(
            state.cli_error_message.as_deref(),
            Some(
                "This Codex CLI is managed by pacman package 'openai-codex'. Pacman currently offers 0.42.1-1. Update it through pacman instead of npm (for example: sudo pacman -Syu)."
            )
        );
        assert!(!npm_install_log.exists());
        assert_eq!(
            fs::read_to_string(&pacman_query_log)?,
            format!(
                "-Qo|--|{}\n-Si|--|openai-codex\n-Qu|--|openai-codex\n",
                codex_path.display()
            )
        );
        assert_eq!(read_installed_version(&codex_path)?, "0.42.0");
        Ok(())
    }

    #[test]
    fn preflight_reports_channel_mismatch_for_pacman_managed_cli_without_actionable_update(
    ) -> Result<()> {
        let _env_guard = env_lock();
        let temp = tempdir()?;
        let paths = test_runtime_paths(temp.path());
        paths.ensure_dirs()?;

        let tool_bin = temp.path().join("tool-bin");
        let pacman_bin = temp.path().join("pacman-bin");
        let system_root = temp.path().join("system-root/usr/bin");
        fs::create_dir_all(&tool_bin)?;
        fs::create_dir_all(&pacman_bin)?;
        fs::create_dir_all(&system_root)?;

        let codex_path = system_root.join("codex");
        write_executable_script(
            &codex_path,
            "#!/bin/sh\nif [ \"$1\" = \"--version\" ] || [ \"$1\" = \"version\" ]; then\n  echo 'codex-cli v0.42.0'\n  exit 0\nfi\nexit 1\n",
        )?;

        let npm_install_log = temp.path().join("npm-install.log");
        let pacman_query_log = temp.path().join("pacman-query.log");
        write_fake_latest_npm(&tool_bin, "0.42.2", &npm_install_log)?;
        let pacman_path = write_fake_pacman_managed_package(
            &pacman_bin,
            "openai-codex",
            "0.42.0-1",
            None,
            &pacman_query_log,
        )?;

        let _restore_env = EnvRestoreGuard::capture(&[
            "HOME",
            "PATH",
            "NVM_DIR",
            "XDG_DATA_HOME",
            "FNM_DIR",
            "FNM_MULTISHELL_PATH",
            "CODEX_CLI_PATH",
            "CODEX_UPDATE_MANAGER_SKIP_SYSTEM_CLI_LOOKUP",
            "CODEX_UPDATE_MANAGER_TEST_SYSTEM_CLI_ROOT",
            "CODEX_UPDATE_MANAGER_TEST_PACMAN_PATH",
            "CODEX_UPDATE_MANAGER_TEST_FORCE_ARCH_HOST",
        ]);
        std::env::set_var("HOME", temp.path());
        set_test_path_with_tool_bin(&tool_bin)?;
        std::env::remove_var("NVM_DIR");
        std::env::remove_var("XDG_DATA_HOME");
        std::env::remove_var("FNM_DIR");
        std::env::remove_var("FNM_MULTISHELL_PATH");
        std::env::remove_var("CODEX_CLI_PATH");
        std::env::remove_var("CODEX_UPDATE_MANAGER_SKIP_SYSTEM_CLI_LOOKUP");
        std::env::set_var("CODEX_UPDATE_MANAGER_TEST_SYSTEM_CLI_ROOT", &system_root);
        std::env::set_var("CODEX_UPDATE_MANAGER_TEST_PACMAN_PATH", &pacman_path);
        std::env::set_var("CODEX_UPDATE_MANAGER_TEST_FORCE_ARCH_HOST", "1");

        let mut state = PersistedState::new(true);
        let outcome = preflight(&mut state, &paths, Some(codex_path.clone()), false)?;

        assert!(!outcome.updated);
        assert_eq!(outcome.cli_path, codex_path);
        assert_eq!(outcome.installed_version, "0.42.0");
        assert_eq!(outcome.official_latest_version.as_deref(), Some("0.42.2"));
        assert_eq!(
            outcome.package_manager_latest_version.as_deref(),
            Some("0.42.0-1")
        );
        assert_eq!(state.cli_status, CliStatus::UpToDate);
        assert_eq!(state.cli_installed_version.as_deref(), Some("0.42.0"));
        assert_eq!(state.cli_official_latest_version.as_deref(), Some("0.42.2"));
        assert_eq!(
            state.cli_package_manager_latest_version.as_deref(),
            Some("0.42.0-1")
        );
        let message = state
            .cli_error_message
            .as_deref()
            .expect("channel mismatch should set a guidance message");
        assert!(message.contains("Pacman does not currently offer a newer package"));
        assert!(message.contains("latest known package: 0.42.0-1"));
        assert!(message.contains("official @openai/codex upstream is 0.42.2"));
        assert!(message.contains("switch CLI installation channels"));
        assert!(!npm_install_log.exists());
        assert_eq!(
            fs::read_to_string(&pacman_query_log)?,
            format!(
                "-Qo|--|{}\n-Si|--|openai-codex\n-Qu|--|openai-codex\n",
                codex_path.display()
            )
        );
        assert_eq!(read_installed_version(&codex_path)?, "0.42.0");
        Ok(())
    }

    #[test]
    fn preflight_skips_npm_upgrade_when_pacman_cannot_confirm_owner() -> Result<()> {
        let _env_guard = env_lock();
        let temp = tempdir()?;
        let paths = test_runtime_paths(temp.path());
        paths.ensure_dirs()?;

        let tool_bin = temp.path().join("tool-bin");
        let pacman_bin = temp.path().join("pacman-bin");
        let system_root = temp.path().join("system-root/usr/bin");
        fs::create_dir_all(&tool_bin)?;
        fs::create_dir_all(&pacman_bin)?;
        fs::create_dir_all(&system_root)?;

        let codex_path = system_root.join("codex");
        write_executable_script(
            &codex_path,
            "#!/bin/sh\nif [ \"$1\" = \"--version\" ] || [ \"$1\" = \"version\" ]; then\n  echo 'codex-cli v0.42.0'\n  exit 0\nfi\nexit 1\n",
        )?;

        let npm_install_log = temp.path().join("npm-install.log");
        let pacman_query_log = temp.path().join("pacman-query.log");
        write_fake_latest_npm(&tool_bin, "0.42.1", &npm_install_log)?;
        let pacman_path = write_fake_pacman_unknown_owner(&pacman_bin, &pacman_query_log)?;

        let _restore_env = EnvRestoreGuard::capture(&[
            "HOME",
            "PATH",
            "NVM_DIR",
            "XDG_DATA_HOME",
            "FNM_DIR",
            "FNM_MULTISHELL_PATH",
            "CODEX_CLI_PATH",
            "CODEX_UPDATE_MANAGER_SKIP_SYSTEM_CLI_LOOKUP",
            "CODEX_UPDATE_MANAGER_TEST_SYSTEM_CLI_ROOT",
            "CODEX_UPDATE_MANAGER_TEST_PACMAN_PATH",
            "CODEX_UPDATE_MANAGER_TEST_FORCE_ARCH_HOST",
        ]);
        std::env::set_var("HOME", temp.path());
        set_test_path_with_tool_bin(&tool_bin)?;
        std::env::remove_var("NVM_DIR");
        std::env::remove_var("XDG_DATA_HOME");
        std::env::remove_var("FNM_DIR");
        std::env::remove_var("FNM_MULTISHELL_PATH");
        std::env::remove_var("CODEX_CLI_PATH");
        std::env::remove_var("CODEX_UPDATE_MANAGER_SKIP_SYSTEM_CLI_LOOKUP");
        std::env::set_var("CODEX_UPDATE_MANAGER_TEST_SYSTEM_CLI_ROOT", &system_root);
        std::env::set_var("CODEX_UPDATE_MANAGER_TEST_PACMAN_PATH", &pacman_path);
        std::env::set_var("CODEX_UPDATE_MANAGER_TEST_FORCE_ARCH_HOST", "1");

        let mut state = PersistedState::new(true);
        let outcome = preflight(&mut state, &paths, Some(codex_path.clone()), false)?;

        assert!(!outcome.updated);
        assert_eq!(outcome.cli_path, codex_path);
        assert_eq!(outcome.installed_version, "0.42.0");
        assert_eq!(outcome.official_latest_version.as_deref(), Some("0.42.1"));
        assert_eq!(outcome.package_manager_latest_version, None);
        assert_eq!(state.cli_status, CliStatus::Unknown);
        assert_eq!(state.cli_installed_version.as_deref(), Some("0.42.0"));
        assert_eq!(state.cli_official_latest_version.as_deref(), Some("0.42.1"));
        assert_eq!(state.cli_package_manager_latest_version, None);
        let message = state
            .cli_error_message
            .as_deref()
            .expect("ownership failure should set a guidance message");
        assert!(message.contains("pacman -Qo"));
        assert!(message.contains("could not determine which package owns it"));
        assert!(message.contains(&codex_path.display().to_string()));
        assert!(!npm_install_log.exists());
        assert_eq!(
            fs::read_to_string(&pacman_query_log)?,
            format!("-Qo|--|{}\n", codex_path.display())
        );
        assert_eq!(read_installed_version(&codex_path)?, "0.42.0");
        Ok(())
    }

    #[test]
    fn refresh_cached_status_invalidates_missing_cached_cli_path() -> Result<()> {
        let _env_guard = env_lock();
        let _restore_fnm_env =
            EnvRestoreGuard::capture(&["XDG_DATA_HOME", "FNM_DIR", "FNM_MULTISHELL_PATH"]);
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
        std::env::remove_var("XDG_DATA_HOME");
        std::env::remove_var("FNM_DIR");
        std::env::remove_var("FNM_MULTISHELL_PATH");
        std::env::remove_var("CODEX_CLI_PATH");
        std::env::set_var("CODEX_UPDATE_MANAGER_SKIP_SYSTEM_CLI_LOOKUP", "1");

        let missing_path = temp.path().join("missing-codex");
        let mut state = PersistedState::new(true);
        state.cli_path = Some(missing_path);
        state.cli_installed_version = Some("0.42.0".to_string());
        state.cli_package_manager_latest_version = Some("0.42.1-1".to_string());
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
        assert_eq!(state.cli_package_manager_latest_version, None);
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
        let _restore_fnm_env =
            EnvRestoreGuard::capture(&["XDG_DATA_HOME", "FNM_DIR", "FNM_MULTISHELL_PATH"]);
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
        std::env::remove_var("XDG_DATA_HOME");
        std::env::remove_var("FNM_DIR");
        std::env::remove_var("FNM_MULTISHELL_PATH");
        std::env::remove_var("CODEX_CLI_PATH");
        std::env::set_var("CODEX_UPDATE_MANAGER_SKIP_SYSTEM_CLI_LOOKUP", "1");

        let mut state = PersistedState::new(true);
        state.cli_package_manager_latest_version = Some("0.42.1-1".to_string());
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
        assert_eq!(state.cli_package_manager_latest_version, None);
        assert_eq!(state.cli_status, CliStatus::NotInstalled);
        assert_eq!(
            state.cli_error_message.as_deref(),
            Some(CLI_NOT_INSTALLED_MESSAGE)
        );
        Ok(())
    }

    #[test]
    fn refresh_status_clears_package_manager_latest_when_cli_version_is_unreadable() -> Result<()> {
        let _env_guard = env_lock();
        let temp = tempdir()?;
        let paths = test_runtime_paths(temp.path());
        paths.ensure_dirs()?;

        let bin_dir = temp.path().join("bin");
        fs::create_dir_all(&bin_dir)?;
        let codex_path = bin_dir.join("codex");
        write_executable_script(&codex_path, "#!/bin/sh\nexit 1\n")?;

        let _restore_env = EnvRestoreGuard::capture(&[
            "HOME",
            "PATH",
            "NVM_DIR",
            "XDG_DATA_HOME",
            "FNM_DIR",
            "FNM_MULTISHELL_PATH",
            "CODEX_CLI_PATH",
            "CODEX_UPDATE_MANAGER_SKIP_SYSTEM_CLI_LOOKUP",
        ]);
        std::env::set_var("HOME", temp.path());
        std::env::set_var("PATH", std::env::join_paths([bin_dir])?);
        std::env::remove_var("NVM_DIR");
        std::env::remove_var("CODEX_CLI_PATH");
        std::env::set_var("CODEX_UPDATE_MANAGER_SKIP_SYSTEM_CLI_LOOKUP", "1");

        let mut state = PersistedState::new(true);
        state.cli_path = Some(codex_path.clone());
        state.cli_package_manager_latest_version = Some("0.42.1-1".to_string());
        refresh_status(&mut state, &paths)?;

        assert_eq!(state.cli_path.as_deref(), Some(codex_path.as_path()));
        assert_eq!(state.cli_installed_version, None);
        assert_eq!(state.cli_package_manager_latest_version, None);
        assert_eq!(state.cli_status, CliStatus::Failed);
        assert!(state
            .cli_error_message
            .as_deref()
            .unwrap_or_default()
            .contains("Could not read the installed"));
        Ok(())
    }

    #[test]
    fn standalone_cli_symlink_updates_with_standalone_installer() -> Result<()> {
        let _env_guard = env_lock();
        let temp = tempdir()?;
        let paths = test_runtime_paths(temp.path());
        paths.ensure_dirs()?;

        let home = temp.path().join("home");
        let tool_bin = temp.path().join("tool-bin");
        let install_dir = home.join(".local/bin");
        let codex_home = home.join(".codex");
        fs::create_dir_all(&tool_bin)?;

        let initial_release =
            write_standalone_codex_release(&codex_home, "0.42.0", "x86_64-unknown-linux-musl")?;
        let visible_codex = link_standalone_cli(&codex_home, &install_dir, &initial_release)?;
        let npm_install_log = temp.path().join("npm-install.log");
        let install_dir_curl_log = temp.path().join("install-dir-curl.log");
        write_fake_latest_npm(&tool_bin, "0.42.1", &npm_install_log)?;
        write_fake_standalone_installer_curl(&tool_bin)?;
        write_broken_install_dir_curl(&install_dir, &install_dir_curl_log)?;

        let _restore_env = EnvRestoreGuard::capture(&[
            "HOME",
            "PATH",
            "NVM_DIR",
            "CODEX_CLI_PATH",
            "CODEX_UPDATE_MANAGER_SKIP_SYSTEM_CLI_LOOKUP",
        ]);
        std::env::set_var("HOME", &home);
        set_test_path_with_tool_bin(&tool_bin)?;
        std::env::remove_var("NVM_DIR");
        std::env::remove_var("XDG_DATA_HOME");
        std::env::remove_var("FNM_DIR");
        std::env::remove_var("FNM_MULTISHELL_PATH");
        std::env::remove_var("CODEX_CLI_PATH");
        std::env::set_var("CODEX_UPDATE_MANAGER_SKIP_SYSTEM_CLI_LOOKUP", "1");

        assert_eq!(
            classify_cli_install(&visible_codex),
            CliInstallKind::Standalone(StandaloneCliInstall {
                codex_home: codex_home.clone(),
                install_dir: Some(install_dir.clone()),
            })
        );

        let mut state = PersistedState::new(true);
        state.cli_path = Some(visible_codex.clone());
        let outcome = preflight(&mut state, &paths, Some(visible_codex.clone()), false)?;

        assert!(outcome.updated);
        assert_eq!(outcome.cli_path, visible_codex);
        assert_eq!(outcome.installed_version, "0.42.1");
        assert_eq!(state.cli_installed_version.as_deref(), Some("0.42.1"));
        assert_eq!(state.cli_official_latest_version.as_deref(), Some("0.42.1"));
        assert_eq!(state.cli_package_manager_latest_version, None);
        assert_eq!(state.cli_status, CliStatus::UpToDate);
        assert_eq!(read_installed_version(&outcome.cli_path)?, "0.42.1");
        assert!(!npm_install_log.exists());
        assert!(!install_dir_curl_log.exists());
        Ok(())
    }

    #[test]
    fn newer_standalone_cli_is_not_downgraded() -> Result<()> {
        let _env_guard = env_lock();
        let temp = tempdir()?;
        let paths = test_runtime_paths(temp.path());
        paths.ensure_dirs()?;

        let home = temp.path().join("home");
        let tool_bin = temp.path().join("tool-bin");
        let install_dir = home.join(".local/bin");
        let codex_home = home.join(".codex");
        fs::create_dir_all(&tool_bin)?;

        let initial_release =
            write_standalone_codex_release(&codex_home, "0.43.0", "x86_64-unknown-linux-musl")?;
        let visible_codex = link_standalone_cli(&codex_home, &install_dir, &initial_release)?;
        let npm_install_log = temp.path().join("npm-install.log");
        let curl_call_log = temp.path().join("curl-call.log");
        write_fake_latest_npm(&tool_bin, "0.42.1", &npm_install_log)?;
        write_failing_standalone_installer_curl(&tool_bin, &curl_call_log)?;

        let _restore_env = EnvRestoreGuard::capture(&[
            "HOME",
            "PATH",
            "NVM_DIR",
            "XDG_DATA_HOME",
            "FNM_DIR",
            "FNM_MULTISHELL_PATH",
            "CODEX_CLI_PATH",
            "CODEX_UPDATE_MANAGER_SKIP_SYSTEM_CLI_LOOKUP",
        ]);
        std::env::set_var("HOME", &home);
        set_test_path_with_tool_bin(&tool_bin)?;
        std::env::remove_var("NVM_DIR");
        std::env::remove_var("XDG_DATA_HOME");
        std::env::remove_var("FNM_DIR");
        std::env::remove_var("FNM_MULTISHELL_PATH");
        std::env::remove_var("CODEX_CLI_PATH");
        std::env::set_var("CODEX_UPDATE_MANAGER_SKIP_SYSTEM_CLI_LOOKUP", "1");

        let mut state = PersistedState::new(true);
        state.cli_path = Some(visible_codex.clone());
        let updated = reconcile_if_present(&mut state, &paths)?;

        assert!(!updated);
        assert_eq!(state.cli_path.as_deref(), Some(visible_codex.as_path()));
        assert_eq!(state.cli_installed_version.as_deref(), Some("0.43.0"));
        assert_eq!(state.cli_official_latest_version.as_deref(), Some("0.42.1"));
        assert_eq!(state.cli_package_manager_latest_version, None);
        assert_eq!(state.cli_status, CliStatus::UpToDate);
        assert!(!npm_install_log.exists());
        assert!(!curl_call_log.exists());
        Ok(())
    }

    #[test]
    fn failing_standalone_cli_update_reports_standalone_installer_error() -> Result<()> {
        let _env_guard = env_lock();
        let temp = tempdir()?;
        let paths = test_runtime_paths(temp.path());
        paths.ensure_dirs()?;

        let home = temp.path().join("home");
        let tool_bin = temp.path().join("tool-bin");
        let install_dir = home.join(".local/bin");
        let codex_home = home.join(".codex");
        fs::create_dir_all(&tool_bin)?;

        let initial_release =
            write_standalone_codex_release(&codex_home, "0.42.0", "x86_64-unknown-linux-musl")?;
        let visible_codex = link_standalone_cli(&codex_home, &install_dir, &initial_release)?;
        let npm_install_log = temp.path().join("npm-install.log");
        let curl_call_log = temp.path().join("curl-call.log");
        write_fake_latest_npm(&tool_bin, "0.42.1", &npm_install_log)?;
        write_failing_standalone_installer_curl(&tool_bin, &curl_call_log)?;

        let _restore_env = EnvRestoreGuard::capture(&[
            "HOME",
            "PATH",
            "NVM_DIR",
            "CODEX_CLI_PATH",
            "CODEX_UPDATE_MANAGER_SKIP_SYSTEM_CLI_LOOKUP",
        ]);
        std::env::set_var("HOME", &home);
        set_test_path_with_tool_bin(&tool_bin)?;
        std::env::remove_var("NVM_DIR");
        std::env::remove_var("CODEX_CLI_PATH");
        std::env::set_var("CODEX_UPDATE_MANAGER_SKIP_SYSTEM_CLI_LOOKUP", "1");

        let mut state = PersistedState::new(true);
        state.cli_path = Some(visible_codex.clone());
        let error = preflight(&mut state, &paths, Some(visible_codex), false)
            .expect_err("standalone installer failure should bubble up");

        assert!(error
            .to_string()
            .contains("standalone Codex CLI installer failed"));
        assert!(curl_call_log.exists());
        assert!(!npm_install_log.exists());
        Ok(())
    }

    #[test]
    fn preflight_repairs_verified_npm_cli_without_missing_install_permission() -> Result<()> {
        let _env_guard = env_lock();
        let temp = tempdir()?;
        let paths = test_runtime_paths(temp.path());
        paths.ensure_dirs()?;

        let prefix = temp.path().join("npm-prefix");
        let fixture = write_npm_cli_install(
            &prefix,
            "#!/bin/sh\necho 'Missing optional dependency @openai/codex-linux-x64. Reinstall Codex: npm install -g @openai/codex' >&2\nexit 1\n",
        )?;
        let repair_log = temp.path().join("npm-repair.log");
        write_executable_script(
            &fixture.npm_program,
            r#"#!/bin/sh
if [ "$1" = "view" ] && [ "$2" = "@openai/codex" ] && [ "$3" = "version" ]; then
  echo '0.42.1'
  exit 0
fi
if [ "$1" = "install" ] && [ "$2" = "--include=optional" ] && [ "$#" = "2" ]; then
  printf 'cwd=%s\n' "$PWD" > "$NPM_REPAIR_LOG"
  for arg in "$@"; do printf 'arg=%s\n' "$arg" >> "$NPM_REPAIR_LOG"; done
  printf '%s\n' '#!/bin/sh' 'echo "codex-cli v0.42.1"' > "$FAKE_CODEX_ENTRYPOINT"
  exit 0
fi
exit 1
"#,
        )?;
        let decoy_bin = temp.path().join("decoy-bin");
        fs::create_dir_all(&decoy_bin)?;
        write_executable_script(
            &decoy_bin.join("codex"),
            "#!/bin/sh\necho 'codex-cli v0.42.1'\n",
        )?;
        let decoy_npm_log = temp.path().join("decoy-npm.log");
        write_executable_script(
            &decoy_bin.join("npm"),
            "#!/bin/sh\necho called > \"$DECOY_NPM_LOG\"\nexit 91\n",
        )?;

        let _restore_env = configure_cli_test_env(temp.path(), [decoy_bin, prefix.join("bin")])?;
        std::env::set_var("DECOY_NPM_LOG", &decoy_npm_log);
        std::env::set_var("FAKE_CODEX_ENTRYPOINT", &fixture.entrypoint);
        std::env::set_var("NPM_REPAIR_LOG", &repair_log);

        let mut state = PersistedState::new(true);
        state.cli_path = Some(fixture.visible_cli.clone());
        let outcome = preflight(&mut state, &paths, Some(fixture.visible_cli.clone()), false)?;

        assert!(outcome.updated);
        assert_eq!(outcome.cli_path, fixture.visible_cli);
        assert_eq!(outcome.installed_version, "0.42.1");
        assert_eq!(state.cli_status, CliStatus::UpToDate);
        assert_eq!(state.cli_error_message, None);
        assert_eq!(
            fs::read_to_string(repair_log)?,
            format!(
                "cwd={}\narg=install\narg=--include=optional\n",
                fixture.package_root.display()
            )
        );
        assert!(!decoy_npm_log.exists());
        Ok(())
    }

    #[test]
    fn optional_dependency_repair_match_is_specific_to_linux_platform_packages() {
        let linux_error = anyhow::anyhow!(
            "Error: Missing optional dependency @openai/codex-linux-x64. Reinstall Codex: npm install -g @openai/codex"
        );
        assert_eq!(
            missing_platform_optional_dependency(&linux_error).as_deref(),
            Some("@openai/codex-linux-x64")
        );
        for message in [
            "Codex CLI configuration is invalid",
            "Missing optional dependency @openai/codex-darwin-arm64",
        ] {
            assert_eq!(
                missing_platform_optional_dependency(&anyhow::anyhow!(message)),
                None
            );
        }
    }

    #[test]
    fn preflight_does_not_repair_unknown_executable() -> Result<()> {
        let _env_guard = env_lock();
        let temp = tempdir()?;
        let paths = test_runtime_paths(temp.path());
        paths.ensure_dirs()?;

        let bin_dir = temp.path().join("bin");
        fs::create_dir_all(&bin_dir)?;
        let codex_path = bin_dir.join("codex");
        write_executable_script(
            &codex_path,
            "#!/bin/sh\necho 'Missing optional dependency @openai/codex-linux-x64. Reinstall Codex: npm install -g @openai/codex' >&2\nexit 1\n",
        )?;
        let npm_log = temp.path().join("npm.log");
        write_executable_script(
            &bin_dir.join("npm"),
            "#!/bin/sh\necho called > \"$NPM_LOG\"\nexit 0\n",
        )?;

        let _restore_env = configure_cli_test_env(temp.path(), [bin_dir])?;
        std::env::set_var("NPM_LOG", &npm_log);

        let mut state = PersistedState::new(true);
        let error = preflight(&mut state, &paths, Some(codex_path.clone()), true)
            .expect_err("an unknown executable must not trigger npm repair");

        assert!(error.to_string().contains("Missing optional dependency"));
        assert_eq!(
            npm_cli_install(&codex_path, "@openai/codex-linux-x64"),
            None
        );
        assert!(!npm_log.exists());
        Ok(())
    }

    #[test]
    fn failed_npm_repair_persists_failed_status() -> Result<()> {
        let _env_guard = env_lock();
        let temp = tempdir()?;
        let paths = test_runtime_paths(temp.path());
        paths.ensure_dirs()?;

        let prefix = temp.path().join("npm-prefix");
        let fixture = write_npm_cli_install(
            &prefix,
            "#!/bin/sh\necho 'Missing optional dependency @openai/codex-linux-x64. Reinstall Codex: npm install -g @openai/codex' >&2\nexit 1\n",
        )?;
        write_executable_script(
            &fixture.npm_program,
            "#!/bin/sh\necho 'repair failed' >&2\nexit 42\n",
        )?;

        let _restore_env = configure_cli_test_env(temp.path(), [prefix.join("bin")])?;

        let mut state = PersistedState::new(true);
        let error = preflight(&mut state, &paths, Some(fixture.visible_cli.clone()), false)
            .expect_err("a failed in-place npm repair should bubble up");

        assert!(format!("{error:#}").contains("repair failed"));
        assert_eq!(state.cli_status, CliStatus::Failed);
        assert!(state
            .cli_error_message
            .as_deref()
            .is_some_and(|message| message.contains("repair failed")));
        let persisted = PersistedState::load_or_default(&paths.state_file, true)?;
        assert_eq!(persisted.cli_status, CliStatus::Failed);
        assert_eq!(persisted.cli_error_message, state.cli_error_message);
        Ok(())
    }

    #[test]
    fn npm_cli_detection_rejects_bun_and_pnpm_metadata() -> Result<()> {
        let temp = tempdir()?;
        assert!(path_is_system_managed_location(Path::new("/")));
        for (index, marker) in ["lib/bun.lock", "lib/node_modules/.modules.yaml"]
            .into_iter()
            .enumerate()
        {
            let prefix = temp.path().join(format!("non-npm-prefix-{index}"));
            let fixture = write_npm_cli_install(&prefix, "#!/bin/sh\nexit 1\n")?;
            fs::write(prefix.join(marker), "")?;
            assert_eq!(
                npm_cli_install(&fixture.visible_cli, "@openai/codex-linux-x64"),
                None
            );
        }
        Ok(())
    }

    #[test]
    fn reconcile_if_present_upgrades_outdated_cli() -> Result<()> {
        let _env_guard = env_lock();
        let _restore_fnm_env =
            EnvRestoreGuard::capture(&["XDG_DATA_HOME", "FNM_DIR", "FNM_MULTISHELL_PATH"]);
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
            "#!/bin/sh\nif [ \"$1\" = \"view\" ] && [ \"$2\" = \"@openai/codex\" ] && [ \"$3\" = \"version\" ]; then\n  echo '0.42.1'\n  exit 0\nfi\nif [ \"$1\" = \"install\" ] && [ \"$2\" = \"-g\" ] && [ \"$3\" = \"--include=optional\" ]; then\n  printf '%s\\n' '#!/bin/sh' 'if [ \"$1\" = \"--version\" ] || [ \"$1\" = \"version\" ]; then' \"  echo 'codex-cli v0.42.1'\" '  exit 0' 'fi' 'exit 1' > \"$FAKE_CODEX_PATH\"\n  exit 0\nfi\nexit 1\n",
        )?;

        let original_home = std::env::var_os("HOME");
        let original_path = std::env::var_os("PATH");
        let original_nvm_dir = std::env::var_os("NVM_DIR");
        std::env::set_var("HOME", temp.path());
        std::env::set_var("PATH", std::env::join_paths([bin_dir.clone()])?);
        std::env::remove_var("NVM_DIR");
        std::env::remove_var("XDG_DATA_HOME");
        std::env::remove_var("FNM_DIR");
        std::env::remove_var("FNM_MULTISHELL_PATH");
        std::env::set_var("FAKE_CODEX_PATH", &codex_path);

        assert_eq!(npm_program(), npm_path);

        let mut state = PersistedState::new(true);
        state.cli_path = Some(codex_path.clone());

        assert_eq!(classify_cli_install(&codex_path), CliInstallKind::Npm);

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
        assert_eq!(state.cli_official_latest_version.as_deref(), Some("0.42.1"));
        assert_eq!(state.cli_package_manager_latest_version, None);
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
if [ "$1" = "install" ] && [ "$2" = "-g" ] && [ "$3" = "--include=optional" ]; then
  exit 0
fi
exit 1
"#,
        )?;

        let _restore_env = EnvRestoreGuard::capture(&[
            "HOME",
            "PATH",
            "NVM_DIR",
            "XDG_DATA_HOME",
            "FNM_DIR",
            "FNM_MULTISHELL_PATH",
            "CODEX_CLI_PATH",
        ]);
        std::env::set_var("HOME", &home);
        std::env::set_var("PATH", std::env::join_paths([npm_bin, system_bin])?);
        std::env::remove_var("NVM_DIR");
        std::env::remove_var("XDG_DATA_HOME");
        std::env::remove_var("FNM_DIR");
        std::env::remove_var("FNM_MULTISHELL_PATH");
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
        assert_eq!(state.cli_official_latest_version.as_deref(), Some("0.42.1"));
        assert_eq!(state.cli_package_manager_latest_version, None);
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

        let _restore_env = EnvRestoreGuard::capture(&[
            "HOME",
            "PATH",
            "NVM_DIR",
            "XDG_DATA_HOME",
            "FNM_DIR",
            "FNM_MULTISHELL_PATH",
        ]);
        std::env::set_var("HOME", temp.path());
        std::env::set_var("PATH", std::env::join_paths([bin_dir.clone()])?);
        std::env::remove_var("NVM_DIR");
        std::env::remove_var("XDG_DATA_HOME");
        std::env::remove_var("FNM_DIR");
        std::env::remove_var("FNM_MULTISHELL_PATH");

        assert_eq!(npm_program(), npm_path);

        let mut state = PersistedState::new(true);
        state.cli_path = Some(codex_path.clone());

        let updated = reconcile_if_present(&mut state, &paths)?;

        assert!(!updated);
        assert_eq!(state.cli_path.as_deref(), Some(codex_path.as_path()));
        assert_eq!(state.cli_installed_version.as_deref(), Some("0.43.0"));
        assert_eq!(state.cli_official_latest_version.as_deref(), Some("0.42.1"));
        assert_eq!(state.cli_package_manager_latest_version, None);
        assert_eq!(state.cli_status, CliStatus::UpToDate);
        assert_eq!(read_installed_version(&codex_path)?, "0.43.0");
        Ok(())
    }
}
