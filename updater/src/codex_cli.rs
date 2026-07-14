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
    io::{Read, Write},
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt},
    os::unix::process::CommandExt,
    path::{Path, PathBuf},
    process::{Command, ExitStatus, Output, Stdio},
    sync::mpsc::{self, Receiver, RecvTimeoutError},
    thread,
    time::{Duration as StdDuration, Instant, SystemTime, UNIX_EPOCH},
};
use tracing::{info, warn};

const CLI_PACKAGE_NAME: &str = "@openai/codex";
const STANDALONE_INSTALLER_URL: &str = "https://chatgpt.com/codex/install.sh";
const CLI_NOT_INSTALLED_MESSAGE: &str =
    "Codex CLI is required but not currently installed. Open the app to retry the automatic install flow, or install it manually with npm optional dependencies enabled.";
const CLI_VERSION_CHECK_TTL: Duration = Duration::hours(1);
const NPM_REPAIR_INSTALL_TIMEOUT: StdDuration = StdDuration::from_secs(90);
const NPM_REPAIR_REGISTRY_TIMEOUT: StdDuration = StdDuration::from_secs(20);
const CLI_PREFLIGHT_VERSION_TIMEOUT: StdDuration = StdDuration::from_secs(5);
const BOUNDED_COMMAND_POLL_INTERVAL: StdDuration = StdDuration::from_millis(50);
const STANDALONE_PROVENANCE_FILE: &str = ".codex-standalone-provenance";
const BOUNDED_COMMAND_TERMINATION_GRACE: StdDuration = StdDuration::from_millis(500);
const BOUNDED_COMMAND_OUTPUT_DRAIN_TIMEOUT: StdDuration = StdDuration::from_secs(1);
const BOUNDED_COMMAND_OUTPUT_LIMIT: usize = 64 * 1024;
const SIGTERM: i32 = 15;
const SIGKILL: i32 = 9;
#[cfg(test)]
const CLI_INSTALLED_VERSION_TTL: Duration = Duration::hours(1);

unsafe extern "C" {
    fn kill(pid: i32, sig: i32) -> i32;
}

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
    preflight_with_version_timeout(
        state,
        paths,
        explicit_cli_path,
        allow_install_missing,
        CLI_PREFLIGHT_VERSION_TIMEOUT,
    )
}

fn preflight_with_version_timeout(
    state: &mut PersistedState,
    paths: &RuntimePaths,
    explicit_cli_path: Option<PathBuf>,
    allow_install_missing: bool,
    version_timeout: StdDuration,
) -> Result<PreflightOutcome> {
    let requested_path = explicit_cli_path.as_deref();
    let (selected_cli_path, installed_missing_cli) = match resolve_cli_path(requested_path) {
        Some(path) => (path, false),
        None if allow_install_missing => match install_missing_cli(state, paths, requested_path) {
            Ok(path) => (path, true),
            Err(error) => {
                persist_cli_failure(state, paths, &error)?;
                return Err(error);
            }
        },
        None => anyhow::bail!("Codex CLI not found in PATH or known install locations"),
    };
    let cli_path = match stable_cli_launch_path(&selected_cli_path) {
        Ok(path) => path,
        Err(trust_error) => {
            let error = cli_trust_error(&selected_cli_path, trust_error);
            persist_cli_failure(state, paths, &error)?;
            return Err(error);
        }
    };
    let path_env = command_path_env();
    let managed_cli = cli_management::detect_system_package_managed_cli(&cli_path, &path_env);
    let mut repaired_npm_install = None;
    let installed_version = match read_installed_version_bounded(&cli_path, version_timeout) {
        Ok(version) => version,
        Err(probe_error) => {
            let Some(missing_dependency) = missing_platform_optional_dependency(&probe_error)
            else {
                persist_new_cli_probe_failure(installed_missing_cli, state, paths, &probe_error)?;
                return Err(probe_error);
            };
            if managed_cli.is_some() {
                persist_new_cli_probe_failure(installed_missing_cli, state, paths, &probe_error)?;
                return Err(probe_error);
            }
            let Some(npm_install) = npm_cli_install(&cli_path, &missing_dependency) else {
                persist_new_cli_probe_failure(installed_missing_cli, state, paths, &probe_error)?;
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
                .and_then(|()| {
                    read_installed_version_bounded(&cli_path, version_timeout)
                })
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

    let latest_version_result =
        repaired_npm_install
            .as_ref()
            .map_or_else(read_latest_version, |install| {
                read_latest_version_with_npm_bounded(
                    &install.npm_program,
                    &install.command_path_env(),
                    NPM_REPAIR_REGISTRY_TIMEOUT,
                )
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
    if let Err(error) = update_existing_cli(&selected_cli_path, &latest_version) {
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
        let fallback_launch_path = stable_cli_launch_path(&fallback_path)?;
        let fallback_version = read_installed_version(&fallback_launch_path)?;
        (fallback_launch_path, fallback_version)
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

fn persist_new_cli_probe_failure(
    installed_missing_cli: bool,
    state: &mut PersistedState,
    paths: &RuntimePaths,
    error: &anyhow::Error,
) -> Result<()> {
    if installed_missing_cli {
        persist_cli_failure(state, paths, error)?;
    }
    Ok(())
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
        .find_map(|path| {
            let launch_path = stable_cli_launch_path(&path).ok()?;
            match read_installed_version(&launch_path) {
                Ok(version)
                    if installed_cli_version_satisfies_latest(&version, expected_version) =>
                {
                    Some((launch_path, version))
                }
                _ => None,
            }
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
        candidates.push(home.join(".codex-cli-npm/bin/codex"));
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
                        "This Codex CLI is managed by pacman package '{package_name}', but ChatGPT Desktop could not determine the latest version currently available through pacman. This install will not be auto-updated through npm; check pacman directly."
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
                        "ChatGPT Desktop resolved Codex CLI to {}, but pacman -Qo {} could not determine which package owns it. The official {CLI_PACKAGE_NAME} upstream is {official_latest}; this install will not be auto-updated through npm, so inspect the CLI source and decide how to update it.",
                        cli_path.display(),
                        query_path.display()
                    ));
                }
                None => {
                    state.cli_status = CliStatus::Unknown;
                    state.cli_error_message = Some(format!(
                        "ChatGPT Desktop resolved Codex CLI to {}, but pacman -Qo {} could not determine which package owns it, and the official {CLI_PACKAGE_NAME} version could not be checked. This install will not be auto-updated through npm; inspect the CLI source and decide how to update it.",
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
    let launch_path = stable_cli_launch_path(cli_path)?;
    let primary = run_command(&launch_path, ["--version"])?;
    if let Some(version) = extract_version(&primary) {
        return Ok(version);
    }

    let fallback = run_command(&launch_path, ["version"])?;
    extract_version(&fallback).ok_or_else(|| {
        anyhow!(
            "Codex CLI returned an unparseable version string: {}",
            fallback.trim()
        )
    })
}

fn read_installed_version_bounded(cli_path: &Path, timeout: StdDuration) -> Result<String> {
    let launch_path = stable_cli_launch_path(cli_path)?;
    let primary = run_bounded_command(
        &launch_path,
        &command_path_env(),
        &[OsString::from("--version")],
        timeout,
    )?;
    if let Some(version) = extract_version(&primary) {
        return Ok(version);
    }

    let fallback = run_bounded_command(
        &launch_path,
        &command_path_env(),
        &[OsString::from("version")],
        timeout,
    )?;
    extract_version(&fallback).ok_or_else(|| {
        anyhow!(
            "Codex CLI returned an unparseable version string: {}",
            fallback.trim()
        )
    })
}

fn missing_platform_optional_dependency(error: &anyhow::Error) -> Option<String> {
    const ERROR_PREFIX: &str = "Missing optional dependency";
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
    let (npm, path_env) = npm_program()?;
    read_latest_version_with_npm(&npm, &path_env)
}

fn read_latest_version_with_npm(npm: &Path, path_env: &OsString) -> Result<String> {
    let output = Command::new(npm)
        .env("PATH", path_env)
        .args(["view", CLI_PACKAGE_NAME, "version"])
        .output()
        .with_context(|| format!("Failed to spawn {}", npm.display()))?;

    parse_latest_version_output(npm, &output)
}

fn read_latest_version_with_npm_bounded(
    npm: &Path,
    path_env: &OsString,
    timeout: StdDuration,
) -> Result<String> {
    let args = [
        OsString::from("view"),
        OsString::from(CLI_PACKAGE_NAME),
        OsString::from("version"),
    ];
    let output = run_bounded_command_output(npm, path_env, None, &args, timeout, false)?;

    parse_latest_version_output(npm, &output)
}

fn parse_latest_version_output(npm: &Path, output: &Output) -> Result<String> {
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
    toolchain_bin: PathBuf,
}

impl NpmCliInstall {
    fn command_path_env(&self) -> OsString {
        let fallback = command_path_env();
        let toolchain_bin = &self.toolchain_bin;
        let mut entries = vec![toolchain_bin.clone()];
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
    let visible_symlink = cli_path.file_name()? == OsStr::new("codex")
        && fs::symlink_metadata(cli_path)
            .ok()?
            .file_type()
            .is_symlink();
    if visible_symlink
        && fs::canonicalize(cli_path.parent()?).ok()? != fs::canonicalize(&toolchain_bin).ok()?
    {
        return None;
    }
    if !visible_symlink && cli_path != entrypoint {
        return None;
    }
    let npm_program = validate_cli_target(&toolchain_bin.join("npm")).ok()?;
    validate_cli_target(&toolchain_bin.join("node")).ok()?;

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
        toolchain_bin,
    })
}

fn path_is_system_managed_location(path: &Path) -> bool {
    path == Path::new("/")
        || ["/usr", "/bin", "/sbin", "/opt", "/nix", "/snap"]
            .into_iter()
            .any(|root| path.starts_with(root))
}

fn repair_npm_optional_dependency(install: &NpmCliInstall) -> Result<()> {
    repair_npm_optional_dependency_with_timeout(install, NPM_REPAIR_INSTALL_TIMEOUT)
}

fn repair_npm_optional_dependency_with_timeout(
    install: &NpmCliInstall,
    timeout: StdDuration,
) -> Result<()> {
    let args = [
        OsString::from("install"),
        OsString::from("--include=optional"),
    ];
    let output = run_bounded_command_output(
        &install.npm_program,
        &install.command_path_env(),
        Some(&install.package_root),
        &args,
        timeout,
        true,
    )?;

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

fn run_bounded_command(
    program: &Path,
    path_env: &OsString,
    args: &[OsString],
    timeout: StdDuration,
) -> Result<String> {
    let output = run_bounded_command_output(program, path_env, None, args, timeout, false)?;
    if !output.status.success() {
        anyhow::bail!(
            "{} exited with {}{}",
            program.display(),
            output.status,
            format_command_output(&output)
        );
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn run_bounded_command_output(
    program: &Path,
    path_env: &OsString,
    current_dir: Option<&Path>,
    args: &[OsString],
    timeout: StdDuration,
    safe_umask: bool,
) -> Result<Output> {
    let mut command = Command::new(program);
    command
        .env("PATH", path_env)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(current_dir) = current_dir {
        command.current_dir(current_dir);
    }
    if safe_umask {
        apply_safe_child_umask(&mut command);
    }
    command.process_group(0);

    let mut child = command
        .spawn()
        .with_context(|| format!("Failed to spawn {}", program.display()))?;
    let process_group = child.id() as i32;
    let stdout = child
        .stdout
        .take()
        .context("bounded npm command did not expose stdout")?;
    let stderr = child
        .stderr
        .take()
        .context("bounded npm command did not expose stderr")?;
    let stdout_rx = spawn_bounded_output_reader(stdout);
    let stderr_rx = spawn_bounded_output_reader(stderr);
    let started = Instant::now();

    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                return Ok(collect_bounded_output(
                    status,
                    process_group,
                    &stdout_rx,
                    &stderr_rx,
                ));
            }
            Ok(None) => {}
            Err(error) => {
                terminate_process_group(&mut child, process_group);
                let _ = child.wait();
                anyhow::bail!(
                    "Failed while waiting for {} {}: {error}",
                    program.display(),
                    format_command_args(args)
                );
            }
        }

        if started.elapsed() >= timeout {
            terminate_process_group(&mut child, process_group);
            let _ = child.wait();
            let _ = receive_bounded_output(&stdout_rx, process_group);
            let _ = receive_bounded_output(&stderr_rx, process_group);
            anyhow::bail!(
                "{} {} timed out after {} seconds",
                program.display(),
                format_command_args(args),
                timeout.as_secs_f64()
            );
        }

        thread::sleep(BOUNDED_COMMAND_POLL_INTERVAL.min(timeout.saturating_sub(started.elapsed())));
    }
}

fn spawn_bounded_output_reader<R>(mut reader: R) -> Receiver<Vec<u8>>
where
    R: Read + Send + 'static,
{
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut retained = Vec::new();
        let mut chunk = [0_u8; 8192];
        loop {
            match reader.read(&mut chunk) {
                Ok(0) => break,
                Ok(read) => {
                    let remaining = BOUNDED_COMMAND_OUTPUT_LIMIT.saturating_sub(retained.len());
                    retained.extend_from_slice(&chunk[..read.min(remaining)]);
                }
                Err(_) => break,
            }
        }
        let _ = tx.send(retained);
    });
    rx
}

fn collect_bounded_output(
    status: ExitStatus,
    process_group: i32,
    stdout_rx: &Receiver<Vec<u8>>,
    stderr_rx: &Receiver<Vec<u8>>,
) -> Output {
    Output {
        status,
        stdout: receive_bounded_output(stdout_rx, process_group),
        stderr: receive_bounded_output(stderr_rx, process_group),
    }
}

fn receive_bounded_output(receiver: &Receiver<Vec<u8>>, process_group: i32) -> Vec<u8> {
    match receiver.recv_timeout(BOUNDED_COMMAND_OUTPUT_DRAIN_TIMEOUT) {
        Ok(output) => output,
        Err(RecvTimeoutError::Disconnected) => Vec::new(),
        Err(RecvTimeoutError::Timeout) => {
            signal_process_group(process_group, SIGKILL);
            receiver
                .recv_timeout(BOUNDED_COMMAND_OUTPUT_DRAIN_TIMEOUT)
                .unwrap_or_default()
        }
    }
}

fn terminate_process_group(child: &mut std::process::Child, process_group: i32) {
    signal_process_group(process_group, SIGTERM);
    thread::sleep(BOUNDED_COMMAND_TERMINATION_GRACE);
    signal_process_group(process_group, SIGKILL);
    let _ = child.kill();
}

fn signal_process_group(process_group: i32, signal: i32) {
    // SAFETY: the process was spawned into a dedicated group whose id is the
    // child pid. Timeout cleanup signals it before reaping the child; after a
    // successful parent exit this is called only if a descendant still holds a
    // captured output pipe open.
    unsafe {
        let _ = kill(-process_group, signal);
    }
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

impl StandaloneCliInstall {
    fn standalone_root(&self) -> PathBuf {
        self.codex_home.join("packages/standalone")
    }
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
        .or_else(|| standalone_home_from_path(cli_path))
        .or_else(|| {
            unresolved_symlink_target(cli_path)
                .as_deref()
                .and_then(standalone_home_from_path)
        })
        .or_else(existing_default_standalone_home)?;
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

fn existing_default_standalone_home() -> Option<PathBuf> {
    #[cfg(test)]
    std::env::var_os("CODEX_UPDATE_MANAGER_TEST_STANDALONE_PROVENANCE")?;

    let codex_home = default_codex_home().ok()?;
    fs::symlink_metadata(codex_home.join("packages/standalone"))
        .ok()
        .map(|_| codex_home)
}

fn unresolved_symlink_target(path: &Path) -> Option<PathBuf> {
    let target = fs::read_link(path).ok()?;
    if target.is_absolute() {
        Some(target)
    } else {
        Some(path.parent()?.join(target))
    }
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

fn stable_cli_launch_path(cli_path: &Path) -> Result<PathBuf> {
    let detected_install = standalone_cli_install(cli_path);
    let recorded_home = read_standalone_provenance()?;
    let should_record = recorded_home.is_none() && detected_install.is_some();
    let install = match (detected_install, recorded_home) {
        (None, None) => return validate_cli_identity(cli_path),
        (Some(install), None) => install,
        (detected, Some(codex_home)) => {
            if let Some(ref detected) = detected {
                anyhow::ensure!(
                    detected.codex_home == codex_home,
                    "Selected Codex CLI provenance {} conflicts with recorded standalone home {}",
                    detected.codex_home.display(),
                    codex_home.display()
                );
            }
            StandaloneCliInstall {
                codex_home,
                install_dir: detected
                    .and_then(|install| install.install_dir)
                    .or_else(|| {
                        cli_path
                            .parent()
                            .filter(|parent| !parent.as_os_str().is_empty())
                            .map(Path::to_path_buf)
                    }),
            }
        }
    };

    let validate_selection = || -> Result<PathBuf> {
        let canonical_cli = fs::canonicalize(cli_path)
            .with_context(|| format!("Failed to resolve Codex CLI path {}", cli_path.display()))?;
        validate_standalone_cli_tree(&install)?;
        let canonical_root = fs::canonicalize(install.standalone_root()).with_context(|| {
            format!(
                "Failed to resolve managed standalone Codex CLI root {}",
                install.standalone_root().display()
            )
        })?;
        anyhow::ensure!(
            canonical_cli.starts_with(&canonical_root),
            "Managed standalone Codex CLI path {} resolves outside its trusted root",
            cli_path.display()
        );
        validate_cli_target(cli_path)
    };
    let mut launch_path = validate_selection()?;
    if should_record {
        record_standalone_provenance(&install.codex_home, cli_path)?;
        launch_path = validate_selection()?;
    }
    Ok(launch_path)
}

fn trusted_owner(uid: u32, euid: u32) -> bool {
    uid == euid || uid == 0
}

fn cli_trust_error(cli_path: &Path, trust_error: anyhow::Error) -> anyhow::Error {
    trust_error.context(format!(
        "Refusing to execute the untrusted Codex CLI at {}; for a rejected managed standalone install, stop active Codex installers, remove its standalone tree, then run the official Codex installer through codex-update-manager recover-standalone-cli",
        cli_path.display()
    ))
}

fn validate_standalone_cli_tree(install: &StandaloneCliInstall) -> Result<()> {
    let standalone_root = install.standalone_root();
    let root_metadata = fs::symlink_metadata(&standalone_root).with_context(|| {
        format!(
            "Managed standalone Codex CLI root {} is missing",
            standalone_root.display()
        )
    })?;
    anyhow::ensure!(
        root_metadata.is_dir() && !root_metadata.file_type().is_symlink(),
        "Managed standalone Codex CLI root {} is not a trusted directory",
        standalone_root.display()
    );
    let canonical_root = fs::canonicalize(&standalone_root).with_context(|| {
        format!(
            "Failed to resolve managed standalone Codex CLI root {}",
            standalone_root.display()
        )
    })?;
    validate_standalone_parent_chain(&canonical_root)?;

    let mut pending = vec![standalone_root];
    while let Some(path) = pending.pop() {
        let metadata = fs::symlink_metadata(&path).with_context(|| {
            format!(
                "Failed to inspect managed standalone Codex CLI path {}",
                path.display()
            )
        })?;

        if metadata.file_type().is_symlink() {
            let target = fs::canonicalize(&path).with_context(|| {
                format!(
                    "Managed standalone Codex CLI contains a broken symlink at {}",
                    path.display()
                )
            })?;
            anyhow::ensure!(
                target.starts_with(&canonical_root),
                "Managed standalone Codex CLI contains an external symlink at {}",
                path.display()
            );
            continue;
        }

        anyhow::ensure!(
            metadata.is_dir() || metadata.is_file(),
            "Managed standalone Codex CLI contains an unsupported file type at {}",
            path.display()
        );
        let euid = unsafe { libc::geteuid() };
        anyhow::ensure!(
            trusted_owner(metadata.uid(), euid),
            "Managed standalone Codex CLI path {} is owned by untrusted uid {}",
            path.display(),
            metadata.uid()
        );
        anyhow::ensure!(
            metadata.permissions().mode() & 0o022 == 0,
            "Managed standalone Codex CLI path {} is group/world-writable and therefore untrusted",
            path.display()
        );

        if metadata.is_dir() {
            let entries = fs::read_dir(&path).with_context(|| {
                format!(
                    "Failed to enumerate managed standalone Codex CLI directory {}",
                    path.display()
                )
            })?;
            for entry in entries {
                pending.push(entry?.path());
            }
        }
    }

    Ok(())
}

fn validate_standalone_parent_chain(path: &Path) -> Result<()> {
    validate_trusted_parent_chain(path, "Managed standalone Codex CLI")
}

fn standalone_provenance_path() -> Result<PathBuf> {
    let home = std::env::var_os("HOME").context("HOME is not set")?;
    let canonical_home = fs::canonicalize(&home).with_context(|| {
        format!(
            "Failed to resolve HOME for standalone CLI provenance: {}",
            Path::new(&home).display()
        )
    })?;
    Ok(canonical_home.join(STANDALONE_PROVENANCE_FILE))
}

fn read_standalone_provenance() -> Result<Option<PathBuf>> {
    #[cfg(test)]
    if std::env::var_os("CODEX_UPDATE_MANAGER_TEST_STANDALONE_PROVENANCE").is_none() {
        return Ok(None);
    }

    let path = standalone_provenance_path()?;
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error).context("Failed to inspect standalone CLI provenance"),
    };
    let euid = unsafe { libc::geteuid() };
    anyhow::ensure!(
        metadata.is_file() && !metadata.file_type().is_symlink(),
        "Standalone Codex CLI provenance {} is not a regular file",
        path.display()
    );
    anyhow::ensure!(
        trusted_owner(metadata.uid(), euid) && metadata.permissions().mode() & 0o022 == 0,
        "Standalone Codex CLI provenance {} is not trusted",
        path.display()
    );
    validate_trusted_parent_chain(&path, "Standalone Codex CLI provenance")?;
    let value = fs::read_to_string(&path)?;
    let codex_home = PathBuf::from(value.trim());
    anyhow::ensure!(
        codex_home.is_absolute(),
        "Standalone Codex CLI provenance {} is invalid",
        path.display()
    );
    Ok(Some(codex_home))
}

fn record_standalone_provenance(codex_home: &Path, cli_path: &Path) -> Result<()> {
    #[cfg(test)]
    if std::env::var_os("CODEX_UPDATE_MANAGER_TEST_STANDALONE_PROVENANCE").is_none() {
        return Ok(());
    }

    let path = standalone_provenance_path()?;
    let entry_metadata = fs::symlink_metadata(cli_path)
        .with_context(|| format!("Failed to inspect Codex CLI entry {}", cli_path.display()))?;
    let euid = unsafe { libc::geteuid() };
    anyhow::ensure!(
        trusted_owner(entry_metadata.uid(), euid),
        "Selected Codex CLI entry {} is owned by untrusted uid {}",
        cli_path.display(),
        entry_metadata.uid()
    );
    validate_trusted_parent_chain(&path, "Standalone Codex CLI provenance")?;
    let temp_path = path.with_file_name(format!(
        ".{STANDALONE_PROVENANCE_FILE}.{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temp_path)
        .context("Failed to create standalone CLI provenance")?;
    let write_result = (|| -> Result<()> {
        writeln!(file, "{}", codex_home.display())?;
        file.sync_all()?;
        fs::rename(&temp_path, &path)?;
        fs::File::open(path.parent().context("Provenance path has no parent")?)?.sync_all()?;
        Ok(())
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    write_result
}

fn validate_cli_target(cli_path: &Path) -> Result<PathBuf> {
    let canonical_cli = validate_cli_identity(cli_path)?;
    let lexical_cli = absolute_lexical_cli_path(cli_path)?;
    validate_trusted_parent_chain(&lexical_cli, "Selected Codex CLI")?;
    Ok(canonical_cli)
}

fn absolute_lexical_cli_path(cli_path: &Path) -> Result<PathBuf> {
    if cli_path.is_absolute() {
        return Ok(cli_path.to_path_buf());
    }
    Ok(std::env::current_dir()
        .context("Failed to resolve the current directory for Codex CLI validation")?
        .join(cli_path))
}

fn validate_cli_identity(cli_path: &Path) -> Result<PathBuf> {
    let lexical_cli = absolute_lexical_cli_path(cli_path)?;
    let entry_metadata = fs::symlink_metadata(&lexical_cli).with_context(|| {
        format!(
            "Failed to inspect Codex CLI entry {}",
            lexical_cli.display()
        )
    })?;
    let euid = unsafe { libc::geteuid() };
    anyhow::ensure!(
        trusted_owner(entry_metadata.uid(), euid),
        "Selected Codex CLI entry {} is owned by untrusted uid {}",
        lexical_cli.display(),
        entry_metadata.uid()
    );
    let canonical_cli = fs::canonicalize(&lexical_cli)
        .with_context(|| format!("Failed to resolve Codex CLI path {}", lexical_cli.display()))?;
    let target_metadata = fs::metadata(&canonical_cli).with_context(|| {
        format!(
            "Failed to inspect Codex CLI target {}",
            canonical_cli.display()
        )
    })?;
    anyhow::ensure!(
        target_metadata.is_file() && is_executable(&canonical_cli),
        "Selected Codex CLI target {} is not an executable file",
        canonical_cli.display()
    );
    anyhow::ensure!(
        trusted_owner(target_metadata.uid(), euid),
        "Selected Codex CLI target {} is owned by untrusted uid {}",
        canonical_cli.display(),
        target_metadata.uid()
    );
    anyhow::ensure!(
        target_metadata.permissions().mode() & 0o022 == 0,
        "Selected Codex CLI target {} is group/world-writable and therefore untrusted",
        canonical_cli.display()
    );
    validate_trusted_parent_chain(&canonical_cli, "Selected Codex CLI target")?;
    Ok(canonical_cli)
}

fn validate_trusted_parent_chain(path: &Path, subject: &str) -> Result<()> {
    let euid = unsafe { libc::geteuid() };
    for parent in path.ancestors().skip(1) {
        let metadata = fs::symlink_metadata(parent).with_context(|| {
            format!(
                "Failed to inspect managed standalone Codex CLI ancestor {}",
                parent.display()
            )
        })?;
        anyhow::ensure!(
            metadata.is_dir() && !metadata.file_type().is_symlink(),
            "{subject} ancestor {} is not a trusted directory",
            parent.display()
        );
        anyhow::ensure!(
            trusted_owner(metadata.uid(), euid),
            "{subject} ancestor {} is owned by untrusted uid {}",
            parent.display(),
            metadata.uid()
        );

        let mode = metadata.permissions().mode();
        let root_owned_sticky_directory =
            metadata.uid() == 0 && mode & libc::S_ISVTX != 0 && mode & 0o002 != 0;
        anyhow::ensure!(
            mode & 0o022 == 0 || root_owned_sticky_directory,
            "{subject} ancestor {} is group/world-writable and therefore untrusted",
            parent.display()
        );
    }

    Ok(())
}

fn update_standalone_cli(install: &StandaloneCliInstall, latest_version: &str) -> Result<()> {
    let install = standalone_install_with_effective_dir(install)?;
    validate_standalone_installer_directory(install.install_dir.as_deref().unwrap())?;
    let tool_path = trusted_standalone_installer_path()?;
    let downloader = standalone_installer_downloader(&tool_path)?;
    let installer_script = downloader.download_installer(&tool_path)?;
    run_standalone_cli_installer(
        &install,
        Some(latest_version),
        &installer_script,
        None,
        &tool_path,
    )?;
    validate_standalone_cli_tree(&install)
}

#[cfg(test)]
fn update_standalone_cli_with_umask_override(
    install: &StandaloneCliInstall,
    latest_version: &str,
    inherited_umask: u32,
) -> Result<()> {
    let install = standalone_install_with_effective_dir(install)?;
    validate_standalone_installer_directory(install.install_dir.as_deref().unwrap())?;
    let tool_path = command_path_env();
    let downloader = standalone_installer_downloader(&tool_path)?;
    let installer_script = downloader.download_installer(&tool_path)?;
    run_standalone_cli_installer(
        &install,
        Some(latest_version),
        &installer_script,
        Some(inherited_umask),
        &tool_path,
    )?;
    validate_standalone_cli_tree(&install)
}

/// Reinstall a standalone CLI after the caller has removed a rejected tree.
/// The official installer runs with a child-only safe umask and the result is
/// validated before a stable launch target is returned.
pub fn recover_standalone_cli(
    codex_home: Option<PathBuf>,
    install_dir: Option<PathBuf>,
) -> Result<PathBuf> {
    let tool_path = trusted_standalone_installer_path()?;
    recover_standalone_cli_with_options(codex_home, install_dir, None, &tool_path)
}

#[cfg(test)]
fn recover_standalone_cli_with_umask_override(
    codex_home: Option<PathBuf>,
    install_dir: Option<PathBuf>,
    inherited_umask_override: Option<u32>,
) -> Result<PathBuf> {
    let tool_path = command_path_env();
    recover_standalone_cli_with_options(
        codex_home,
        install_dir,
        inherited_umask_override,
        &tool_path,
    )
}

fn recover_standalone_cli_with_options(
    codex_home: Option<PathBuf>,
    install_dir: Option<PathBuf>,
    inherited_umask_override: Option<u32>,
    tool_path: &OsStr,
) -> Result<PathBuf> {
    let codex_home = codex_home.map_or_else(default_codex_home, Ok)?;
    validate_absolute_recovery_path(&codex_home, "Codex home")?;
    if let Some(install_dir) = install_dir.as_deref() {
        validate_absolute_recovery_path(install_dir, "standalone install directory")?;
    }
    let install = standalone_install_with_effective_dir(&StandaloneCliInstall {
        codex_home,
        install_dir,
    })?;
    let standalone_root = install.standalone_root();
    match fs::symlink_metadata(&standalone_root) {
        Ok(_) => anyhow::bail!(
            "Refusing to overwrite existing standalone Codex CLI tree {}; stop active Codex installers and remove this rejected tree before retrying recovery",
            standalone_root.display()
        ),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(error).with_context(|| {
                format!(
                    "Failed to inspect standalone Codex CLI recovery path {}",
                    standalone_root.display()
                )
            });
        }
    }
    prepare_standalone_recovery_parent(&install.codex_home)?;
    secure_standalone_recovery_directory_chain(install.install_dir.as_deref().unwrap())?;
    validate_standalone_installer_directory(install.install_dir.as_deref().unwrap())?;

    let downloader = standalone_installer_downloader(tool_path)?;
    let installer_script = downloader.download_installer(tool_path)?;
    run_standalone_cli_installer(
        &install,
        None,
        &installer_script,
        inherited_umask_override,
        tool_path,
    )?;
    validate_standalone_cli_tree(&install)?;

    let visible_cli = install
        .install_dir
        .as_deref()
        .map(|directory| directory.join("codex"))
        .unwrap_or_else(|| standalone_root.join("current/bin/codex"));
    stable_cli_launch_path(&visible_cli).with_context(|| {
        format!(
            "Standalone Codex CLI recovery completed but did not produce a trusted executable at {}",
            visible_cli.display()
        )
    })
}

fn standalone_install_with_effective_dir(
    install: &StandaloneCliInstall,
) -> Result<StandaloneCliInstall> {
    let install_dir = install
        .install_dir
        .clone()
        .map_or_else(default_standalone_install_dir, Ok)?;
    validate_absolute_recovery_path(&install.codex_home, "Codex home")?;
    validate_absolute_recovery_path(&install_dir, "standalone install directory")?;
    Ok(StandaloneCliInstall {
        codex_home: install.codex_home.clone(),
        install_dir: Some(install_dir),
    })
}

fn default_standalone_install_dir() -> Result<PathBuf> {
    let home = std::env::var_os("HOME")
        .filter(|value| !value.is_empty())
        .context("HOME is required to resolve the standalone Codex CLI install directory")?;
    Ok(PathBuf::from(home).join(".local/bin"))
}

fn validate_absolute_recovery_path(path: &Path, label: &str) -> Result<()> {
    anyhow::ensure!(path.is_absolute(), "{label} must be an absolute path");
    anyhow::ensure!(
        !path.components().any(|component| matches!(
            component,
            std::path::Component::CurDir | std::path::Component::ParentDir
        )),
        "{label} must not contain . or .. components"
    );
    Ok(())
}

fn prepare_standalone_recovery_parent(codex_home: &Path) -> Result<()> {
    let packages_dir = codex_home.join("packages");
    secure_standalone_recovery_directory_chain(&packages_dir)?;
    let existing_parent = packages_dir
        .ancestors()
        .find(|candidate| fs::symlink_metadata(candidate).is_ok())
        .context("Standalone Codex CLI recovery path has no existing parent")?;
    let metadata = fs::symlink_metadata(existing_parent).with_context(|| {
        format!(
            "Failed to inspect standalone Codex CLI recovery ancestor {}",
            existing_parent.display()
        )
    })?;
    let euid = unsafe { libc::geteuid() };
    anyhow::ensure!(
        metadata.is_dir() && !metadata.file_type().is_symlink(),
        "Standalone Codex CLI recovery ancestor {} is not a trusted directory",
        existing_parent.display()
    );
    anyhow::ensure!(
        metadata.uid() == euid || metadata.uid() == 0,
        "Standalone Codex CLI recovery ancestor {} is owned by untrusted uid {}",
        existing_parent.display(),
        metadata.uid()
    );
    let mode = metadata.permissions().mode();
    let root_owned_sticky_directory =
        metadata.uid() == 0 && mode & libc::S_ISVTX != 0 && mode & 0o002 != 0;
    anyhow::ensure!(
        mode & 0o022 == 0 || root_owned_sticky_directory,
        "Standalone Codex CLI recovery ancestor {} is group/world-writable; secure it before retrying recovery",
        existing_parent.display()
    );
    let canonical_parent = fs::canonicalize(existing_parent).with_context(|| {
        format!(
            "Failed to resolve standalone Codex CLI recovery ancestor {}",
            existing_parent.display()
        )
    })?;
    validate_standalone_parent_chain(&canonical_parent)
}

fn secure_standalone_recovery_directory_chain(target: &Path) -> Result<()> {
    validate_absolute_recovery_path(target, "standalone recovery directory")?;
    let home = std::env::var_os("HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);

    if let Some(home) = home.as_deref().filter(|home| target.starts_with(home)) {
        let relative = target.strip_prefix(home).unwrap();
        let mut current = home.to_path_buf();
        for component in relative.components() {
            current.push(component.as_os_str());
            match fs::symlink_metadata(&current) {
                Ok(_) => secure_owned_recovery_directory(&current)?,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
                Err(error) => {
                    return Err(error).with_context(|| {
                        format!(
                            "Failed to inspect standalone recovery directory {}",
                            current.display()
                        )
                    });
                }
            }
        }
    } else if fs::symlink_metadata(target).is_ok() {
        secure_owned_recovery_directory(target)?;
    }

    Ok(())
}

fn secure_owned_recovery_directory(path: &Path) -> Result<()> {
    let directory = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_CLOEXEC | libc::O_DIRECTORY | libc::O_NOFOLLOW)
        .open(path)
        .with_context(|| {
            format!(
                "Standalone recovery path {} is not a trusted directory",
                path.display()
            )
        })?;
    let metadata = directory.metadata()?;
    let euid = unsafe { libc::geteuid() };
    anyhow::ensure!(
        metadata.uid() == euid,
        "Standalone recovery directory {} is not owned by the current user",
        path.display()
    );
    let mode = metadata.permissions().mode();
    if mode & 0o022 != 0 {
        directory
            .set_permissions(fs::Permissions::from_mode(mode & !0o022))
            .with_context(|| {
                format!(
                    "Failed to remove group/world write access from standalone recovery directory {}",
                    path.display()
                )
            })?;
    }
    Ok(())
}

fn validate_standalone_installer_directory(path: &Path) -> Result<()> {
    let existing_parent = path
        .ancestors()
        .find(|candidate| fs::symlink_metadata(candidate).is_ok())
        .context("Standalone Codex CLI install directory has no existing parent")?;
    let metadata = fs::symlink_metadata(existing_parent).with_context(|| {
        format!(
            "Failed to inspect standalone Codex CLI install ancestor {}",
            existing_parent.display()
        )
    })?;
    let euid = unsafe { libc::geteuid() };
    anyhow::ensure!(
        metadata.is_dir() && !metadata.file_type().is_symlink(),
        "Standalone Codex CLI install ancestor {} is not a trusted directory",
        existing_parent.display()
    );
    anyhow::ensure!(
        metadata.uid() == euid || metadata.uid() == 0,
        "Standalone Codex CLI install ancestor {} is owned by untrusted uid {}",
        existing_parent.display(),
        metadata.uid()
    );
    let mode = metadata.permissions().mode();
    let root_owned_sticky_directory =
        metadata.uid() == 0 && mode & libc::S_ISVTX != 0 && mode & 0o002 != 0;
    anyhow::ensure!(
        mode & 0o022 == 0 || root_owned_sticky_directory,
        "Standalone Codex CLI install ancestor {} is group/world-writable and therefore untrusted",
        existing_parent.display()
    );
    let canonical_parent = fs::canonicalize(existing_parent).with_context(|| {
        format!(
            "Failed to resolve standalone Codex CLI install ancestor {}",
            existing_parent.display()
        )
    })?;
    validate_standalone_parent_chain(&canonical_parent)
}

fn default_codex_home() -> Result<PathBuf> {
    if let Some(codex_home) = std::env::var_os("CODEX_HOME").filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(codex_home));
    }
    let home = std::env::var_os("HOME")
        .filter(|value| !value.is_empty())
        .context("HOME or CODEX_HOME is required to recover the standalone Codex CLI")?;
    Ok(PathBuf::from(home).join(".codex"))
}

fn run_standalone_cli_installer(
    install: &StandaloneCliInstall,
    latest_version: Option<&str>,
    installer_script: &[u8],
    inherited_umask_override: Option<u32>,
    tool_path: &OsStr,
) -> Result<()> {
    let shell = resolved_program_in_path("sh", tool_path)
        .context("A trusted sh executable is required to run the standalone Codex CLI installer")?;
    let mut command = Command::new(&shell);
    command
        .arg("-s")
        .env("PATH", tool_path)
        .env("CODEX_NON_INTERACTIVE", "1")
        .env("CODEX_HOME", &install.codex_home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(latest_version) = latest_version {
        command.env("CODEX_RELEASE", latest_version);
    }
    if let Some(install_dir) = &install.install_dir {
        command.env("CODEX_INSTALL_DIR", install_dir);
    }
    // SAFETY: `umask` is async-signal-safe and this hook only changes the
    // installer child's mask. OR-ing write restrictions preserves stricter
    // user policies while preventing new managed files from being created
    // group/world-writable.
    unsafe {
        command.pre_exec(move || {
            if let Some(mask) = inherited_umask_override {
                libc::umask(mask as libc::mode_t);
            }
            let inherited = libc::umask(0);
            libc::umask(inherited | 0o022);
            Ok(())
        });
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
            .write_all(installer_script)
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
    fn download_installer(&self, tool_path: &OsStr) -> Result<Vec<u8>> {
        let output = match self {
            Self::Curl(program) => Command::new(program)
                .env("PATH", tool_path)
                .args(["-fsSL", STANDALONE_INSTALLER_URL])
                .output()
                .with_context(|| {
                    format!(
                        "Failed to spawn standalone Codex CLI installer downloader {}",
                        program.display()
                    )
                })?,
            Self::Wget(program) => Command::new(program)
                .env("PATH", tool_path)
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

fn standalone_installer_downloader(path_env: &OsStr) -> Result<StandaloneInstallerDownloader> {
    if let Some(path) = resolved_program_in_path("curl", path_env) {
        return Ok(StandaloneInstallerDownloader::Curl(path));
    }
    if let Some(path) = resolved_program_in_path("wget", path_env) {
        return Ok(StandaloneInstallerDownloader::Wget(path));
    }

    anyhow::bail!(
        "curl or wget is required to run the standalone Codex CLI installer from {STANDALONE_INSTALLER_URL}"
    );
}

fn resolved_program_in_path(name: &str, path_env: &OsStr) -> Option<PathBuf> {
    find_in_path(name, &path_env.to_os_string()).map(resolved_program_path)
}

fn trusted_standalone_installer_path() -> Result<OsString> {
    #[cfg(test)]
    if let Some(path) = std::env::var_os("CODEX_UPDATE_MANAGER_TEST_STANDALONE_TOOL_PATH")
        .filter(|value| !value.is_empty())
    {
        return Ok(path);
    }

    const CANDIDATES: &[&str] = &[
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
        "/run/current-system/sw/bin",
    ];

    let mut directories = Vec::new();
    for candidate in CANDIDATES {
        let candidate = Path::new(candidate);
        let canonical = match fs::canonicalize(candidate) {
            Ok(path) => path,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(error).with_context(|| {
                    format!(
                        "Failed to resolve trusted standalone installer tool directory {}",
                        candidate.display()
                    )
                });
            }
        };
        validate_trusted_system_directory(&canonical)?;
        if !directories.iter().any(|existing| existing == &canonical) {
            directories.push(canonical);
        }
    }

    let path_env = std::env::join_paths(directories)
        .context("Failed to construct trusted standalone installer tool PATH")?;
    let shell = resolved_program_in_path("sh", &path_env)
        .context("No trusted system sh executable is available for standalone CLI recovery")?;
    validate_trusted_system_program(&shell)?;
    let downloader = resolved_program_in_path("curl", &path_env)
        .or_else(|| resolved_program_in_path("wget", &path_env))
        .context(
            "No trusted system curl or wget executable is available for standalone CLI recovery",
        )?;
    validate_trusted_system_program(&downloader)?;
    Ok(path_env)
}

fn validate_trusted_system_program(path: &Path) -> Result<()> {
    let metadata = fs::metadata(path).with_context(|| {
        format!(
            "Failed to inspect trusted standalone installer tool {}",
            path.display()
        )
    })?;
    anyhow::ensure!(
        metadata.is_file() && metadata.uid() == 0 && metadata.permissions().mode() & 0o022 == 0,
        "Standalone installer tool {} is not a root-owned, non-writable regular file",
        path.display()
    );
    anyhow::ensure!(
        metadata.permissions().mode() & 0o111 != 0,
        "Standalone installer tool {} is not executable",
        path.display()
    );
    if let Some(parent) = path.parent() {
        validate_trusted_system_directory(parent)?;
    }
    Ok(())
}

fn validate_trusted_system_directory(path: &Path) -> Result<()> {
    for directory in path.ancestors() {
        let metadata = fs::symlink_metadata(directory).with_context(|| {
            format!(
                "Failed to inspect trusted standalone installer tool ancestor {}",
                directory.display()
            )
        })?;
        anyhow::ensure!(
            metadata.is_dir() && !metadata.file_type().is_symlink() && metadata.uid() == 0,
            "Standalone installer tool ancestor {} is not a root-owned directory",
            directory.display()
        );
        let mode = metadata.permissions().mode();
        let root_owned_sticky_directory = mode & libc::S_ISVTX != 0;
        anyhow::ensure!(
            mode & 0o022 == 0 || root_owned_sticky_directory,
            "Standalone installer tool ancestor {} is group/world-writable and therefore untrusted",
            directory.display()
        );
    }
    Ok(())
}

fn resolved_program_path(path: PathBuf) -> PathBuf {
    fs::canonicalize(&path).unwrap_or(path)
}

fn install_latest_cli(latest_version: &str) -> Result<()> {
    let (npm, path_env) = npm_program()?;
    let package_spec = format!("{CLI_PACKAGE_NAME}@{latest_version}");
    let local_prefix = local_npm_prefix();
    prepare_safe_npm_prefix(&local_prefix)?;
    let local_args = vec![
        OsString::from("install"),
        OsString::from("-g"),
        OsString::from("--include=optional"),
        OsString::from("--prefix"),
        local_prefix.as_os_str().to_os_string(),
        OsString::from(&package_spec),
    ];
    run_npm_command(&npm, &path_env, &local_args)
        .with_context(|| format!("npm install into {} failed", local_prefix.display()))
}

fn prepare_safe_npm_prefix(prefix: &Path) -> Result<()> {
    match fs::symlink_metadata(prefix) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::DirBuilder::new()
                .mode(0o700)
                .create(prefix)
                .with_context(|| format!("Failed to create npm prefix {}", prefix.display()))?;
        }
        Err(error) => return Err(error).context("Failed to inspect dedicated npm prefix"),
    }
    let metadata = fs::symlink_metadata(prefix)?;
    let euid = unsafe { libc::geteuid() };
    anyhow::ensure!(
        metadata.is_dir()
            && !metadata.file_type().is_symlink()
            && trusted_owner(metadata.uid(), euid)
            && metadata.permissions().mode() & 0o022 == 0,
        "Dedicated npm prefix {} is not a trusted directory",
        prefix.display()
    );
    validate_trusted_parent_chain(prefix, "Dedicated npm prefix")
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

fn npm_program() -> Result<(PathBuf, OsString)> {
    let npm = find_in_path("npm", &command_path_env()).context("npm was not found in PATH")?;
    validate_cli_target(&npm).context("npm executable failed its trust check")?;
    let toolchain_bin = npm
        .parent()
        .context("npm executable has no parent directory")?;
    validate_cli_target(&toolchain_bin.join("node"))
        .context("node executable beside npm failed its trust check")?;
    let fallback = command_path_env();
    let mut entries = vec![toolchain_bin.to_path_buf()];
    entries.extend(std::env::split_paths(&fallback).filter(|entry| entry != toolchain_bin));
    let path_env = std::env::join_paths(entries).unwrap_or(fallback);
    Ok((npm, path_env))
}

fn local_npm_prefix() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".codex-cli-npm")
}

fn run_npm_command(npm: &Path, path_env: &OsString, args: &[OsString]) -> Result<()> {
    let mut command = Command::new(npm);
    command.env("PATH", path_env).args(args);
    apply_safe_child_umask(&mut command);
    let output = command
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

fn apply_safe_child_umask(command: &mut Command) {
    unsafe {
        command.pre_exec(|| {
            let inherited = libc::umask(0);
            libc::umask(inherited | 0o022);
            Ok(())
        });
    }
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
        let temp_root = std::env::temp_dir();
        for directory in path.parent().into_iter().flat_map(Path::ancestors) {
            if directory == temp_root || !directory.starts_with(&temp_root) {
                break;
            }
            if directory.is_dir() {
                fs::set_permissions(directory, fs::Permissions::from_mode(0o755))?;
            }
        }
        fs::write(path, contents)?;
        let mut permissions = fs::metadata(path)?.permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(path, permissions)?;
        if path.file_name() == Some(OsStr::new("npm")) {
            let node = path.with_file_name("node");
            if !node.exists() {
                fs::write(&node, "#!/bin/sh\nexec /bin/sh \"$@\"\n")?;
                fs::set_permissions(node, fs::Permissions::from_mode(0o755))?;
            }
        }
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
        let node_program = toolchain_bin.join("node");

        fs::create_dir_all(
            entrypoint
                .parent()
                .context("npm CLI entrypoint has no parent")?,
        )?;
        fs::create_dir_all(&toolchain_bin)?;
        if let Some(test_root) = prefix.parent() {
            fs::set_permissions(test_root, fs::Permissions::from_mode(0o755))?;
        }
        for directory in entrypoint
            .parent()
            .into_iter()
            .flat_map(Path::ancestors)
            .take_while(|directory| directory.starts_with(prefix))
            .chain(std::iter::once(toolchain_bin.as_path()))
        {
            fs::set_permissions(directory, fs::Permissions::from_mode(0o755))?;
        }
        write_executable_script(&node_program, "#!/bin/sh\nexec /bin/sh \"$@\"\n")?;
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
            "NPM_CHILD_MARKER",
            "NPM_CHILD_PID",
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
        for ancestor in codex_home.ancestors().skip(1).take(2) {
            fs::set_permissions(ancestor, fs::Permissions::from_mode(0o755))?;
        }
        for directory in [
            codex_home.to_path_buf(),
            codex_home.join("packages"),
            codex_home.join("packages/standalone"),
            codex_home.join("packages/standalone/releases"),
            release_dir.clone(),
            release_bin.clone(),
        ] {
            fs::set_permissions(directory, fs::Permissions::from_mode(0o755))?;
        }
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
        let home = codex_home
            .parent()
            .context("test standalone Codex home has no parent")?;
        for directory in install_dir
            .ancestors()
            .take_while(|directory| directory.starts_with(home))
        {
            fs::set_permissions(directory, fs::Permissions::from_mode(0o755))?;
        }

        let current_link = standalone_root.join("current");
        let _ = fs::remove_file(&current_link);
        std::os::unix::fs::symlink(release_dir, &current_link)?;

        let visible_codex = install_dir.join("codex");
        let _ = fs::remove_file(&visible_codex);
        std::os::unix::fs::symlink(current_link.join("bin/codex"), &visible_codex)?;

        Ok(visible_codex)
    }

    fn link_test_system_tool(tool_bin: &Path, name: &str) -> Result<()> {
        let target = std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
            .filter(|directory| directory.is_absolute())
            .map(|directory| directory.join(name))
            .find(|candidate| is_executable(candidate))
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
release="${CODEX_RELEASE:-0.42.2}"
release_dir="$CODEX_HOME/packages/standalone/releases/$release-test-target"
mkdir -p "$release_dir/bin" "$CODEX_INSTALL_DIR"
cat > "$release_dir/bin/codex" <<CODEX_BIN
#!/bin/sh
if [ "\$1" = "--version" ] || [ "\$1" = "version" ]; then
  echo 'codex-cli v$release'
  exit 0
fi
exit 1
CODEX_BIN
chmod 0755 "$release_dir/bin/codex"
ln -sfn "$release_dir" "$CODEX_HOME/packages/standalone/current"
ln -sfn "$CODEX_HOME/packages/standalone/current/bin/codex" "$CODEX_INSTALL_DIR/codex"
"$CODEX_INSTALL_DIR/codex" --version >/dev/null
SCRIPT
  exit 0
fi
exit 1
"#,
        )
    }

    fn write_umask_recording_standalone_installer_curl(tool_bin: &Path) -> Result<()> {
        write_executable_script(
            &tool_bin.join("curl"),
            r#"#!/bin/sh
if [ "$1" = "-fsSL" ]; then
  cat <<'SCRIPT'
#!/bin/sh
set -eu
release="${CODEX_RELEASE:-0.42.2}"
release_dir="$CODEX_HOME/packages/standalone/releases/$release-test-target"
mkdir -p "$release_dir/bin" "$CODEX_INSTALL_DIR"
umask > "$INSTALLER_UMASK_LOG"
: > "$release_dir/created-by-installer"
sh -c 'umask > "$CHILD_UMASK_LOG"; : > "$CHILD_CREATED_FILE"'
cat > "$release_dir/bin/codex" <<CODEX_BIN
#!/bin/sh
echo 'codex-cli v$release'
CODEX_BIN
chmod 0755 "$release_dir/bin/codex"
ln -sfn "$release_dir" "$CODEX_HOME/packages/standalone/current"
ln -sfn "$CODEX_HOME/packages/standalone/current/bin/codex" "$CODEX_INSTALL_DIR/codex"
"$CODEX_INSTALL_DIR/codex" --version >/dev/null
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
    fn untrusted_standalone_cli_is_rejected_before_execution() -> Result<()> {
        let _env_guard = env_lock();
        let temp = tempdir()?;
        let paths = test_runtime_paths(temp.path());
        paths.ensure_dirs()?;

        let home = temp.path().join("home");
        let install_dir = home.join(".local/bin");
        let codex_home = home.join(".codex");

        let initial_release =
            write_standalone_codex_release(&codex_home, "0.42.0", "x86_64-unknown-linux-musl")?;
        let tamper_marker = temp.path().join("tampered-cli-executed");
        let tampered_cli = initial_release.join("bin/codex");
        write_executable_script(
            &tampered_cli,
            &format!(
                "#!/bin/sh\n: > '{}'\necho 'codex-cli v0.42.0'\n",
                tamper_marker.display()
            ),
        )?;
        let mut permissions = fs::metadata(&tampered_cli)?.permissions();
        permissions.set_mode(0o775);
        fs::set_permissions(&tampered_cli, permissions)?;

        let visible_codex = link_standalone_cli(&codex_home, &install_dir, &initial_release)?;
        let _restore_env = configure_cli_test_env(&home, [install_dir])?;

        let mut state = PersistedState::new(true);
        state.cli_path = Some(visible_codex.clone());
        let error = preflight(&mut state, &paths, Some(visible_codex), false)
            .expect_err("an untrusted managed CLI must be rejected");

        assert!(error.to_string().contains("official Codex installer"));
        assert_eq!(state.cli_status, CliStatus::Failed);
        assert!(state
            .cli_error_message
            .as_deref()
            .unwrap_or_default()
            .contains("group/world-writable"));
        assert!(
            !tamper_marker.exists(),
            "the untrusted managed CLI must not execute before rejection"
        );
        Ok(())
    }

    #[test]
    fn untrusted_standalone_cli_ancestor_is_rejected_before_execution() -> Result<()> {
        let _env_guard = env_lock();
        let temp = tempdir()?;
        let paths = test_runtime_paths(temp.path());
        paths.ensure_dirs()?;

        let home = temp.path().join("home");
        let install_dir = home.join(".local/bin");
        let codex_home = home.join(".codex");
        let initial_release =
            write_standalone_codex_release(&codex_home, "0.42.0", "x86_64-unknown-linux-musl")?;
        let execution_marker = temp.path().join("unsafe-ancestor-cli-executed");
        write_executable_script(
            &initial_release.join("bin/codex"),
            &format!(
                "#!/bin/sh\n: > '{}'\necho 'codex-cli v0.42.0'\n",
                execution_marker.display()
            ),
        )?;
        fs::set_permissions(
            codex_home.join("packages"),
            fs::Permissions::from_mode(0o775),
        )?;
        let visible_codex = link_standalone_cli(&codex_home, &install_dir, &initial_release)?;
        let _restore_env = configure_cli_test_env(&home, [install_dir])?;

        let mut state = PersistedState::new(true);
        state.cli_path = Some(visible_codex.clone());
        let error = preflight(&mut state, &paths, Some(visible_codex), false)
            .expect_err("an unsafe managed CLI ancestor must be rejected");

        assert!(error.to_string().contains("official Codex installer"));
        assert_eq!(state.cli_status, CliStatus::Failed);
        assert!(state
            .cli_error_message
            .as_deref()
            .unwrap_or_default()
            .contains("ancestor"));
        assert!(!execution_marker.exists());
        Ok(())
    }

    #[test]
    fn standalone_launch_path_remains_stable_after_visible_symlink_replacement() -> Result<()> {
        let _env_guard = env_lock();
        let temp = tempdir()?;
        fs::set_permissions(temp.path(), fs::Permissions::from_mode(0o755))?;
        let home = temp.path().join("home");
        let install_dir = home.join(".local/bin");
        let codex_home = home.join(".codex");
        let release = write_standalone_codex_release(&codex_home, "0.42.0", "test-target")?;
        let visible_codex = link_standalone_cli(&codex_home, &install_dir, &release)?;

        let _restore_env = EnvRestoreGuard::capture(&[
            "HOME",
            "CODEX_HOME",
            "CODEX_UPDATE_MANAGER_TEST_STANDALONE_PROVENANCE",
        ]);
        std::env::set_var("HOME", &home);
        std::env::remove_var("CODEX_HOME");
        std::env::set_var("CODEX_UPDATE_MANAGER_TEST_STANDALONE_PROVENANCE", "1");
        assert_eq!(
            stable_cli_launch_path(&visible_codex)?,
            release.join("bin/codex")
        );

        let launch_path = stable_cli_launch_path(&visible_codex)?;
        assert_eq!(launch_path, fs::canonicalize(release.join("bin/codex"))?);

        let replacement_marker = temp.path().join("replacement-executed");
        let replacement = temp.path().join("replacement-codex");
        write_executable_script(
            &replacement,
            &format!(
                "#!/bin/sh\n: > '{}'\necho 'codex-cli v9.9.9'\n",
                replacement_marker.display()
            ),
        )?;
        fs::remove_file(&visible_codex)?;
        std::os::unix::fs::symlink(&replacement, &visible_codex)?;

        assert_eq!(read_installed_version(&launch_path)?, "0.42.0");
        assert!(
            !replacement_marker.exists(),
            "replacing the visible symlink must not redirect the verified launch target"
        );
        Ok(())
    }

    #[test]
    fn cli_launch_path_rejects_unsafe_visible_replacement_before_validation() -> Result<()> {
        let _env_guard = env_lock();
        let temp = tempdir()?;
        fs::set_permissions(temp.path(), fs::Permissions::from_mode(0o755))?;
        let home = temp.path().join("home");
        let install_dir = home.join(".local/bin");
        let codex_home = home.join(".codex");
        let release = write_standalone_codex_release(&codex_home, "0.42.0", "test-target")?;
        let visible_codex = link_standalone_cli(&codex_home, &install_dir, &release)?;

        let _restore_env = EnvRestoreGuard::capture(&[
            "HOME",
            "CODEX_HOME",
            "CODEX_UPDATE_MANAGER_TEST_STANDALONE_PROVENANCE",
        ]);
        std::env::set_var("HOME", &home);
        std::env::remove_var("CODEX_HOME");
        std::env::set_var("CODEX_UPDATE_MANAGER_TEST_STANDALONE_PROVENANCE", "1");
        assert_eq!(
            stable_cli_launch_path(&visible_codex)?,
            release.join("bin/codex")
        );

        let replacement_marker = temp.path().join("pre-validation-replacement-executed");
        let replacement = temp.path().join("replacement-codex");
        write_executable_script(
            &replacement,
            &format!(
                "#!/bin/sh\n: > '{}'\necho 'codex-cli v9.9.9'\n",
                replacement_marker.display()
            ),
        )?;
        fs::set_permissions(&install_dir, fs::Permissions::from_mode(0o775))?;
        fs::set_permissions(&replacement, fs::Permissions::from_mode(0o755))?;
        fs::remove_file(&visible_codex)?;
        std::os::unix::fs::symlink(&replacement, &visible_codex)?;
        fs::rename(
            codex_home.join("packages/standalone"),
            codex_home.join("packages/standalone-rejected"),
        )?;

        let error = stable_cli_launch_path(&visible_codex)
            .expect_err("an unsafe entry replacement must fail before execution");
        assert!(error.to_string().contains("root") && error.to_string().contains("missing"));
        assert!(!replacement_marker.exists());
        Ok(())
    }

    #[test]
    fn invalid_standalone_does_not_record_provenance() -> Result<()> {
        let _env_guard = env_lock();
        let temp = tempdir()?;
        fs::set_permissions(temp.path(), fs::Permissions::from_mode(0o755))?;
        let home = temp.path().join("home");
        let install_dir = home.join("custom-bin");
        let codex_home = home.join("custom-codex-home");
        let release = write_standalone_codex_release(&codex_home, "0.42.0", "test-target")?;
        let visible_codex = link_standalone_cli(&codex_home, &install_dir, &release)?;
        fs::set_permissions(release.join("bin/codex"), fs::Permissions::from_mode(0o775))?;

        let _restore_env = EnvRestoreGuard::capture(&[
            "HOME",
            "CODEX_HOME",
            "CODEX_UPDATE_MANAGER_TEST_STANDALONE_PROVENANCE",
        ]);
        std::env::set_var("HOME", &home);
        std::env::set_var("CODEX_HOME", &codex_home);
        std::env::set_var("CODEX_UPDATE_MANAGER_TEST_STANDALONE_PROVENANCE", "1");

        stable_cli_launch_path(&visible_codex)
            .expect_err("an invalid standalone tree must be rejected");
        assert!(!home.join(STANDALONE_PROVENANCE_FILE).exists());
        Ok(())
    }

    #[test]
    fn cli_trust_accepts_only_current_or_root_owner() {
        let euid = unsafe { libc::geteuid() };
        assert!(trusted_owner(euid, euid));
        assert!(trusted_owner(0, euid));
        let untrusted_uid = if euid == 1 { 2 } else { 1 };
        assert!(!trusted_owner(untrusted_uid, euid));
    }

    #[test]
    fn dedicated_npm_prefix_is_created_private() -> Result<()> {
        let temp = tempdir()?;
        fs::set_permissions(temp.path(), fs::Permissions::from_mode(0o755))?;
        let prefix = temp.path().join(".codex-cli-npm");
        prepare_safe_npm_prefix(&prefix)?;
        assert_eq!(fs::metadata(prefix)?.permissions().mode() & 0o777, 0o700);
        Ok(())
    }

    #[test]
    fn standalone_launch_path_rejects_external_current_symlink_without_execution() -> Result<()> {
        let _env_guard = env_lock();
        let temp = tempdir()?;
        fs::set_permissions(temp.path(), fs::Permissions::from_mode(0o755))?;
        let home = temp.path().join("home");
        let install_dir = home.join(".local/bin");
        let codex_home = home.join(".codex");
        let release = write_standalone_codex_release(&codex_home, "0.42.0", "test-target")?;
        let visible_codex = link_standalone_cli(&codex_home, &install_dir, &release)?;

        let external_marker = temp.path().join("external-executed");
        let external_dir = temp.path().join("external/bin");
        fs::create_dir_all(&external_dir)?;
        write_executable_script(
            &external_dir.join("codex"),
            &format!(
                "#!/bin/sh\n: > '{}'\necho 'codex-cli v9.9.9'\n",
                external_marker.display()
            ),
        )?;
        let current = codex_home.join("packages/standalone/current");
        fs::remove_file(&current)?;
        std::os::unix::fs::symlink(temp.path().join("external"), &current)?;

        let error = stable_cli_launch_path(&visible_codex)
            .expect_err("an external current symlink must be rejected");
        assert!(error.to_string().contains("external symlink"));
        assert!(!external_marker.exists());
        Ok(())
    }

    #[test]
    fn preflight_trust_failure_is_persisted_without_version_probe() -> Result<()> {
        let _env_guard = env_lock();
        let temp = tempdir()?;
        let paths = test_runtime_paths(temp.path());
        paths.ensure_dirs()?;
        let home = temp.path().join("home");
        let install_dir = home.join(".local/bin");
        let codex_home = home.join(".codex");
        let release = write_standalone_codex_release(&codex_home, "0.42.0", "test-target")?;
        let probe_marker = temp.path().join("version-probed");
        let cli = release.join("bin/codex");
        write_executable_script(
            &cli,
            &format!(
                "#!/bin/sh\n: > '{}'\necho 'codex-cli v0.42.0'\n",
                probe_marker.display()
            ),
        )?;
        fs::set_permissions(&cli, fs::Permissions::from_mode(0o775))?;
        let visible_codex = link_standalone_cli(&codex_home, &install_dir, &release)?;
        let _restore_env = configure_cli_test_env(&home, [install_dir])?;

        let mut state = PersistedState::new(true);
        let error = preflight(&mut state, &paths, Some(visible_codex.clone()), false)
            .expect_err("the updater preflight trust gate must fail closed");
        assert!(error.to_string().contains("recover-standalone-cli"));
        assert_eq!(state.cli_status, CliStatus::Failed);
        assert!(!probe_marker.exists());
        Ok(())
    }

    #[test]
    fn standalone_installer_scopes_umask_and_preserves_stricter_policies() -> Result<()> {
        let _env_guard = env_lock();
        let temp = tempdir()?;
        fs::set_permissions(temp.path(), fs::Permissions::from_mode(0o755))?;
        let tool_bin = temp.path().join("tool-bin");
        fs::create_dir_all(&tool_bin)?;
        write_umask_recording_standalone_installer_curl(&tool_bin)?;

        let _restore_env = EnvRestoreGuard::capture(&[
            "HOME",
            "PATH",
            "INSTALLER_UMASK_LOG",
            "CHILD_UMASK_LOG",
            "CHILD_CREATED_FILE",
        ]);
        std::env::set_var("HOME", temp.path().join("home"));
        set_test_path_with_tool_bin(&tool_bin)?;
        let read_unrelated_child_umask = || -> Result<String> {
            let output = Command::new(tool_bin.join("sh"))
                .arg("-c")
                .arg("umask")
                .output()?;
            anyhow::ensure!(output.status.success(), "failed to read child umask");
            Ok(String::from_utf8(output.stdout)?.trim().to_string())
        };
        let ambient_child_umask = read_unrelated_child_umask()?;

        for (inherited_umask, expected_umask) in
            [(0o002_u32, 0o022_u32), (0o027, 0o027), (0o077, 0o077)]
        {
            let case_root = temp.path().join(format!("mask-{inherited_umask:04o}"));
            let codex_home = case_root.join(".codex");
            let install_dir = case_root.join("bin");
            let release_dir = codex_home
                .join("packages/standalone/releases")
                .join("0.42.1-test-target");
            let installer_umask_log = case_root.join("installer-umask.log");
            let child_umask_log = case_root.join("child-umask.log");
            let child_created_file = release_dir.join("created-by-child");
            fs::create_dir_all(&case_root)?;
            fs::set_permissions(&case_root, fs::Permissions::from_mode(0o755))?;
            std::env::set_var("INSTALLER_UMASK_LOG", &installer_umask_log);
            std::env::set_var("CHILD_UMASK_LOG", &child_umask_log);
            std::env::set_var("CHILD_CREATED_FILE", &child_created_file);

            let install = StandaloneCliInstall {
                codex_home,
                install_dir: Some(install_dir),
            };
            update_standalone_cli_with_umask_override(&install, "0.42.1", inherited_umask)?;
            assert_eq!(read_unrelated_child_umask()?, ambient_child_umask);

            let parse_umask = |path: &Path| -> Result<u32> {
                let raw = fs::read_to_string(path)?;
                u32::from_str_radix(raw.trim(), 8)
                    .with_context(|| format!("invalid umask recorded in {}", path.display()))
            };
            assert_eq!(parse_umask(&installer_umask_log)?, expected_umask);
            assert_eq!(parse_umask(&child_umask_log)?, expected_umask);
            assert_eq!(
                fs::metadata(&release_dir)?.permissions().mode() & 0o777,
                0o777 & !expected_umask
            );
            for created_file in [release_dir.join("created-by-installer"), child_created_file] {
                assert_eq!(
                    fs::metadata(created_file)?.permissions().mode() & 0o777,
                    0o666 & !expected_umask
                );
            }
        }

        Ok(())
    }

    #[test]
    fn standalone_recovery_under_umask_0002_produces_a_trusted_launch_target() -> Result<()> {
        let _env_guard = env_lock();
        let temp = tempdir()?;
        fs::set_permissions(temp.path(), fs::Permissions::from_mode(0o755))?;
        let tool_bin = temp.path().join("tool-bin");
        let case_root = temp.path().join("recovery");
        let home = case_root.join("home");
        let codex_home = home.join(".codex");
        let install_dir = home.join(".local/bin");
        let release_dir = codex_home
            .join("packages/standalone/releases")
            .join("0.42.2-test-target");
        let installer_umask_log = case_root.join("installer-umask.log");
        let child_umask_log = case_root.join("child-umask.log");
        let child_created_file = release_dir.join("created-by-child");
        let malicious_curl_marker = case_root.join("malicious-curl-executed");
        let malicious_shell_marker = case_root.join("malicious-shell-executed");
        fs::create_dir_all(&tool_bin)?;
        fs::create_dir_all(&install_dir)?;
        fs::set_permissions(&case_root, fs::Permissions::from_mode(0o755))?;
        fs::set_permissions(&home, fs::Permissions::from_mode(0o755))?;
        fs::create_dir_all(codex_home.join("packages"))?;
        for path in [
            codex_home.clone(),
            codex_home.join("packages"),
            home.join(".local"),
            install_dir.clone(),
        ] {
            fs::set_permissions(path, fs::Permissions::from_mode(0o775))?;
        }
        write_executable_script(
            &install_dir.join("curl"),
            &format!(
                "#!/bin/sh\n: > '{}'\nexit 99\n",
                malicious_curl_marker.display()
            ),
        )?;
        write_executable_script(
            &install_dir.join("sh"),
            &format!(
                "#!/bin/sh\n: > '{}'\nexit 99\n",
                malicious_shell_marker.display()
            ),
        )?;
        write_umask_recording_standalone_installer_curl(&tool_bin)?;

        let _restore_env = EnvRestoreGuard::capture(&[
            "HOME",
            "PATH",
            "INSTALLER_UMASK_LOG",
            "CHILD_UMASK_LOG",
            "CHILD_CREATED_FILE",
        ]);
        std::env::set_var("HOME", &home);
        set_test_path_with_tool_bin(&tool_bin)?;
        std::env::set_var(
            "PATH",
            std::env::join_paths([install_dir.clone(), tool_bin.clone()])?,
        );
        std::env::set_var("INSTALLER_UMASK_LOG", &installer_umask_log);
        std::env::set_var("CHILD_UMASK_LOG", &child_umask_log);
        std::env::set_var("CHILD_CREATED_FILE", &child_created_file);

        let trusted_test_path = std::env::join_paths([tool_bin])?;
        let launch_path = recover_standalone_cli_with_options(
            Some(codex_home.clone()),
            Some(install_dir.clone()),
            Some(0o002),
            &trusted_test_path,
        )?;

        assert_eq!(
            launch_path,
            fs::canonicalize(release_dir.join("bin/codex"))?
        );
        assert_eq!(fs::read_to_string(&installer_umask_log)?.trim(), "0022");
        assert_eq!(fs::read_to_string(&child_umask_log)?.trim(), "0022");
        for path in [
            codex_home.clone(),
            codex_home.join("packages"),
            home.join(".local"),
            install_dir.clone(),
        ] {
            assert_eq!(
                fs::metadata(&path)?.permissions().mode() & 0o022,
                0,
                "recovery must secure installer-created directory {}",
                path.display()
            );
        }
        validate_standalone_cli_tree(&StandaloneCliInstall {
            codex_home,
            install_dir: Some(install_dir),
        })?;
        for path in [release_dir.join("created-by-installer"), child_created_file] {
            assert_eq!(fs::metadata(path)?.permissions().mode() & 0o022, 0);
        }
        assert!(
            !malicious_curl_marker.exists() && !malicious_shell_marker.exists(),
            "recovery must not execute tools planted in a formerly writable install directory"
        );
        Ok(())
    }

    #[test]
    fn trusted_standalone_installer_path_ignores_inherited_user_tools() -> Result<()> {
        let _env_guard = env_lock();
        let temp = tempdir()?;
        let user_bin = temp.path().join("home/.local/bin");
        let marker = temp.path().join("user-tool-executed");
        fs::create_dir_all(&user_bin)?;
        for name in ["curl", "wget", "sh"] {
            write_executable_script(
                &user_bin.join(name),
                &format!("#!/bin/sh\n: > '{}'\nexit 99\n", marker.display()),
            )?;
        }

        let _restore_env =
            EnvRestoreGuard::capture(&["PATH", "CODEX_UPDATE_MANAGER_TEST_STANDALONE_TOOL_PATH"]);
        std::env::set_var("PATH", std::env::join_paths([user_bin.clone()])?);
        std::env::remove_var("CODEX_UPDATE_MANAGER_TEST_STANDALONE_TOOL_PATH");
        let trusted_path = trusted_standalone_installer_path()?;

        assert!(
            std::env::split_paths(&trusted_path).all(|entry| entry != user_bin),
            "trusted recovery PATH must not inherit user-writable command directories"
        );
        for name in ["curl", "sh"] {
            let selected = resolved_program_in_path(name, &trusted_path)
                .with_context(|| format!("trusted recovery PATH is missing {name}"))?;
            assert!(!selected.starts_with(temp.path()));
        }
        assert!(!marker.exists());
        Ok(())
    }

    #[test]
    fn standalone_update_rejects_unsafe_install_directory_before_download() -> Result<()> {
        let _env_guard = env_lock();
        let temp = tempdir()?;
        fs::set_permissions(temp.path(), fs::Permissions::from_mode(0o755))?;
        let home = temp.path().join("home");
        let codex_home = home.join(".codex");
        let install_dir = home.join(".local/bin");
        let tool_bin = temp.path().join("tool-bin");
        let curl_call_log = temp.path().join("curl-called.log");
        fs::create_dir_all(&install_dir)?;
        fs::create_dir_all(&tool_bin)?;
        fs::set_permissions(&home, fs::Permissions::from_mode(0o755))?;
        fs::set_permissions(home.join(".local"), fs::Permissions::from_mode(0o755))?;
        fs::set_permissions(&install_dir, fs::Permissions::from_mode(0o775))?;
        write_failing_standalone_installer_curl(&tool_bin, &curl_call_log)?;

        let _restore_env = EnvRestoreGuard::capture(&["HOME", "PATH"]);
        std::env::set_var("HOME", &home);
        set_test_path_with_tool_bin(&tool_bin)?;

        let error = update_standalone_cli_with_umask_override(
            &StandaloneCliInstall {
                codex_home,
                install_dir: Some(install_dir),
            },
            "0.42.1",
            0o002,
        )
        .expect_err("an unsafe install directory must be rejected before download");
        assert!(error.to_string().contains("group/world-writable"));
        assert!(
            !curl_call_log.exists(),
            "installer download must not start through an unsafe visible-command directory"
        );
        Ok(())
    }

    #[test]
    fn standalone_recovery_refuses_to_overwrite_an_existing_tree() -> Result<()> {
        let _env_guard = env_lock();
        let temp = tempdir()?;
        fs::set_permissions(temp.path(), fs::Permissions::from_mode(0o755))?;
        let codex_home = temp.path().join("home/.codex");
        write_standalone_codex_release(&codex_home, "0.42.0", "test-target")?;

        let error = recover_standalone_cli_with_umask_override(
            Some(codex_home),
            Some(temp.path().join("home/.local/bin")),
            Some(0o002),
        )
        .expect_err("recovery must not mutate an existing standalone tree");
        assert!(error.to_string().contains("Refusing to overwrite"));
        assert!(error.to_string().contains("remove this rejected tree"));
        Ok(())
    }

    #[test]
    fn standalone_recovery_rejects_ambiguous_paths_before_downloading() -> Result<()> {
        let _env_guard = env_lock();
        let relative_error = recover_standalone_cli_with_umask_override(
            Some(PathBuf::from("relative/.codex")),
            None,
            Some(0o002),
        )
        .expect_err("relative recovery paths must be rejected");
        assert!(relative_error.to_string().contains("absolute path"));

        let parent_error = recover_standalone_cli_with_umask_override(
            Some(PathBuf::from("/tmp/safe/../unsafe/.codex")),
            None,
            Some(0o002),
        )
        .expect_err("parent traversal in recovery paths must be rejected");
        assert!(parent_error.to_string().contains("must not contain"));
        Ok(())
    }

    #[test]
    fn refresh_status_rejects_untrusted_standalone_cli_without_executing_it() -> Result<()> {
        let _env_guard = env_lock();
        let temp = tempdir()?;
        let paths = test_runtime_paths(temp.path());
        paths.ensure_dirs()?;

        let home = temp.path().join("home");
        let install_dir = home.join(".local/bin");
        let codex_home = home.join(".codex");
        let initial_release =
            write_standalone_codex_release(&codex_home, "0.42.0", "x86_64-unknown-linux-musl")?;
        let tamper_marker = temp.path().join("refresh-executed-tampered-cli");
        let tampered_cli = initial_release.join("bin/codex");
        write_executable_script(
            &tampered_cli,
            &format!(
                "#!/bin/sh\n: > '{}'\necho 'codex-cli v0.42.0'\n",
                tamper_marker.display()
            ),
        )?;
        let mut permissions = fs::metadata(&tampered_cli)?.permissions();
        permissions.set_mode(0o775);
        fs::set_permissions(&tampered_cli, permissions)?;
        let visible_codex = link_standalone_cli(&codex_home, &install_dir, &initial_release)?;
        let _restore_env = configure_cli_test_env(&home, [install_dir])?;

        let mut state = PersistedState::new(true);
        state.cli_path = Some(visible_codex);
        refresh_status(&mut state, &paths)?;

        assert_eq!(state.cli_status, CliStatus::Failed);
        assert_eq!(state.cli_installed_version, None);
        assert!(state
            .cli_error_message
            .as_deref()
            .unwrap_or_default()
            .contains("group/world-writable"));
        assert!(
            !tamper_marker.exists(),
            "status refresh must reject the untrusted managed CLI before execution"
        );
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
            "CODEX_UPDATE_MANAGER_TEST_STANDALONE_TOOL_PATH",
        ]);
        std::env::set_var("HOME", &home);
        set_test_path_with_tool_bin(&tool_bin)?;
        std::env::set_var(
            "CODEX_UPDATE_MANAGER_TEST_STANDALONE_TOOL_PATH",
            std::env::join_paths([tool_bin.clone()])?,
        );
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
        assert_eq!(
            outcome.cli_path,
            fs::canonicalize(codex_home.join("packages/standalone/current/bin/codex"))?
        );
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
        let stable_cli = fs::canonicalize(initial_release.join("bin/codex"))?;
        assert_eq!(state.cli_path.as_deref(), Some(stable_cli.as_path()));
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
            "CODEX_UPDATE_MANAGER_TEST_STANDALONE_TOOL_PATH",
        ]);
        std::env::set_var("HOME", &home);
        set_test_path_with_tool_bin(&tool_bin)?;
        std::env::set_var(
            "CODEX_UPDATE_MANAGER_TEST_STANDALONE_TOOL_PATH",
            std::env::join_paths([tool_bin.clone()])?,
        );
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
    fn initial_cli_version_probe_is_bounded_before_repair() -> Result<()> {
        let _env_guard = env_lock();
        let temp = tempdir()?;
        let paths = test_runtime_paths(temp.path());
        paths.ensure_dirs()?;

        let bin_dir = temp.path().join("bin");
        fs::create_dir_all(&bin_dir)?;
        let codex_path = bin_dir.join("codex");
        write_executable_script(&codex_path, "#!/bin/sh\nwhile :; do sleep 1; done\n")?;
        let _restore_env = configure_cli_test_env(temp.path(), [bin_dir])?;

        let mut state = PersistedState::new(true);
        let started = Instant::now();
        let error = preflight_with_version_timeout(
            &mut state,
            &paths,
            Some(codex_path),
            false,
            StdDuration::from_millis(100),
        )
        .expect_err("the initial CLI probe must not block synchronous preflight");

        assert!(error.to_string().contains("timed out"));
        assert!(started.elapsed() < StdDuration::from_secs(3));
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
            "#!/bin/sh\necho 'Missing optional dependency@openai/codex-linux-x64. Reinstall Codex: npm install -g @openai/codex' >&2\nexit 1\n",
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
        assert_eq!(outcome.cli_path, fixture.entrypoint);
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
        let compact_linux_error = anyhow::anyhow!(
            "Error: Missing optional dependency@openai/codex-linux-arm64. Reinstall Codex"
        );
        assert_eq!(
            missing_platform_optional_dependency(&compact_linux_error).as_deref(),
            Some("@openai/codex-linux-arm64")
        );
        for message in [
            "Codex CLI configuration is invalid",
            "Missing optional dependency @openai/codex-darwin-arm64",
            "Missing optional dependency@openai/codex-linux-x64-evil",
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
    fn hanging_npm_repair_times_out_and_terminates_its_process_group() -> Result<()> {
        let _env_guard = env_lock();
        let temp = tempdir()?;
        let npm_program = temp.path().join("npm");
        let child_marker = temp.path().join("child-terminated");
        let child_pid = temp.path().join("child.pid");
        write_executable_script(
            &npm_program,
            r#"#!/bin/sh
if [ "$1" = "install" ]; then
  sh -c 'trap '\''printf terminated > "$NPM_CHILD_MARKER"; exit 0'\'' TERM; while :; do sleep 1; done' &
  echo "$!" > "$NPM_CHILD_PID"
  wait
fi
exit 1
"#,
        )?;
        let _restore_env = EnvRestoreGuard::capture(&["NPM_CHILD_MARKER", "NPM_CHILD_PID"]);
        std::env::set_var("NPM_CHILD_MARKER", &child_marker);
        std::env::set_var("NPM_CHILD_PID", &child_pid);
        let install = NpmCliInstall {
            package_root: temp.path().to_path_buf(),
            toolchain_bin: npm_program.parent().unwrap().to_path_buf(),
            npm_program,
        };

        let started = Instant::now();
        let error =
            repair_npm_optional_dependency_with_timeout(&install, StdDuration::from_millis(100))
                .expect_err("a hanging npm repair must time out");

        assert!(error.to_string().contains("timed out"));
        assert!(started.elapsed() < StdDuration::from_secs(3));
        assert!(child_pid.exists(), "the nested npm child must have started");
        assert_eq!(fs::read_to_string(child_marker)?, "terminated");
        Ok(())
    }

    #[test]
    fn repaired_cli_registry_lookup_is_bounded() -> Result<()> {
        let _env_guard = env_lock();
        let temp = tempdir()?;
        let npm_program = temp.path().join("npm");
        write_executable_script(&npm_program, "#!/bin/sh\nwhile :; do sleep 1; done\n")?;

        let started = Instant::now();
        let error = read_latest_version_with_npm_bounded(
            &npm_program,
            &command_path_env(),
            StdDuration::from_millis(100),
        )
        .expect_err("a hanging npm registry lookup must time out");

        assert!(error.to_string().contains("timed out"));
        assert!(started.elapsed() < StdDuration::from_secs(3));
        Ok(())
    }

    #[test]
    fn repaired_cli_version_probe_is_bounded() -> Result<()> {
        let _env_guard = env_lock();
        let temp = tempdir()?;
        let cli_program = temp.path().join("codex");
        write_executable_script(&cli_program, "#!/bin/sh\nwhile :; do sleep 1; done\n")?;

        let started = Instant::now();
        let error = read_installed_version_bounded(&cli_program, StdDuration::from_millis(100))
            .expect_err("a hanging repaired CLI version probe must time out");

        assert!(error.to_string().contains("timed out"));
        assert!(started.elapsed() < StdDuration::from_secs(3));
        Ok(())
    }

    #[test]
    fn failed_missing_cli_install_persists_failed_status() -> Result<()> {
        let _env_guard = env_lock();
        let temp = tempdir()?;
        let paths = test_runtime_paths(temp.path());
        paths.ensure_dirs()?;

        let bin_dir = temp.path().join("bin");
        fs::create_dir_all(&bin_dir)?;
        write_executable_script(
            &bin_dir.join("npm"),
            "#!/bin/sh\necho 'registry unavailable' >&2\nexit 42\n",
        )?;

        let _restore_env = configure_cli_test_env(temp.path(), [bin_dir])?;

        let mut state = PersistedState::new(true);
        let error = preflight(&mut state, &paths, None, true)
            .expect_err("a failed missing CLI install should bubble up");

        assert!(format!("{error:#}").contains("registry unavailable"));
        assert_eq!(state.cli_status, CliStatus::Failed);
        assert!(state
            .cli_error_message
            .as_deref()
            .is_some_and(|message| message.contains("registry unavailable")));
        let persisted = PersistedState::load_or_default(&paths.state_file, true)?;
        assert_eq!(persisted.cli_status, CliStatus::Failed);
        assert_eq!(persisted.cli_error_message, state.cli_error_message);
        Ok(())
    }

    #[test]
    fn failed_new_cli_version_probe_persists_failed_status() -> Result<()> {
        let _env_guard = env_lock();
        let _restore_fake_cli_path = EnvRestoreGuard::capture(&["FAKE_CODEX_PATH"]);
        let temp = tempdir()?;
        let paths = test_runtime_paths(temp.path());
        paths.ensure_dirs()?;

        let bin_dir = temp.path().join("bin");
        fs::create_dir_all(&bin_dir)?;
        let codex_path = bin_dir.join("codex");
        write_executable_script(
            &bin_dir.join("npm"),
            "#!/bin/sh\nif [ \"$1\" = \"view\" ]; then\n  echo '0.42.1'\n  exit 0\nfi\nif [ \"$1\" = \"install\" ]; then\n  printf '%s\\n' '#!/bin/sh' \"echo 'version probe failed' >&2\" 'exit 43' > \"$FAKE_CODEX_PATH\"\n  /bin/chmod 0755 \"$FAKE_CODEX_PATH\"\n  exit 0\nfi\nexit 1\n",
        )?;

        let _restore_env = configure_cli_test_env(temp.path(), [bin_dir])?;
        std::env::set_var("FAKE_CODEX_PATH", &codex_path);

        let mut state = PersistedState::new(true);
        let error = preflight(&mut state, &paths, None, true)
            .expect_err("a failed version probe after installation should bubble up");

        assert!(format!("{error:#}").contains("version probe failed"));
        assert_eq!(state.cli_status, CliStatus::Failed);
        assert!(state
            .cli_error_message
            .as_deref()
            .is_some_and(|message| message.contains("version probe failed")));
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

        assert_eq!(npm_program()?.0, npm_path);

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

        assert_eq!(npm_program()?.0, npm_path);

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
