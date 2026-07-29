//! CLI discovery and prelaunch update checks for the user-installed Codex CLI.

use crate::{
    cli_management,
    config::RuntimePaths,
    npm_cli_repair,
    state::{CliInstallChannel, CliStatus, PersistedState},
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
    os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd},
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt},
    os::unix::process::{CommandExt, ExitStatusExt},
    path::{Path, PathBuf},
    process::{Command, ExitStatus, Output, Stdio},
    sync::mpsc::{self, Receiver, RecvTimeoutError},
    thread,
    time::{Duration as StdDuration, Instant},
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
const BOUNDED_COMMAND_TERMINATION_GRACE: StdDuration = StdDuration::from_millis(500);
const BOUNDED_COMMAND_OUTPUT_DRAIN_TIMEOUT: StdDuration = StdDuration::from_secs(1);
const NPM_SUPERVISOR_EXIT_GRACE: StdDuration = StdDuration::from_secs(2);
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

#[derive(Debug, Clone, PartialEq, Eq)]
enum CliUpdateOutcome {
    Updated(Option<ManagedCliInstall>),
    RepairRequired,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CliRepairOutcome {
    pub installed_version: String,
    pub quarantine_paths: Vec<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ManagedCliInstall {
    cli_path: PathBuf,
    installed_version: String,
}

enum OptionalDependencyRepairOutcome {
    Functional(String),
    RepairRequired,
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
    let mut routine_baseline = state.clone();
    let requested_path = explicit_cli_path.as_deref();
    let (selected_cli_path, installed_missing_cli) = match resolve_cli_path(requested_path) {
        Some(path) => (path, false),
        None if allow_install_missing => {
            match install_missing_cli(state, paths, &mut routine_baseline, requested_path) {
                Ok(result) => result,
                Err(error) => {
                    persist_cli_failure(state, paths, &error, &mut routine_baseline)?;
                    return Err(error);
                }
            }
        }
        None => anyhow::bail!("Codex CLI not found in PATH or known install locations"),
    };
    let cli_path = match stable_cli_launch_path(&selected_cli_path) {
        Ok(path) => path,
        Err(resolution_error) => {
            let error = cli_launch_path_error(&selected_cli_path, resolution_error);
            state.cli_path = Some(selected_cli_path);
            state.cli_install_channel = None;
            state.cli_installed_version = None;
            state.cli_package_manager_latest_version = None;
            state.cli_last_verified_at = None;
            persist_cli_failure(state, paths, &error, &mut routine_baseline)?;
            return Err(error);
        }
    };
    let path_env = command_path_env();
    let managed_cli = cli_management::detect_system_package_managed_cli(&cli_path, &path_env);
    let stored_cli_path = state.cli_path.clone();
    let stored_cli_install_channel = state.cli_install_channel.clone();
    let cli_install_kind = classify_cli_install(
        &selected_cli_path,
        &cli_path,
        stored_cli_path.as_deref(),
        stored_cli_install_channel.as_ref(),
    );
    let cli_install_channel = Some(cli_install_kind.channel());
    let mut repaired_npm_install = None;
    let installed_version = match read_installed_version_bounded(&cli_path, version_timeout) {
        Ok(version) => version,
        Err(probe_error) => {
            let Some(missing_dependency) = missing_platform_optional_dependency(&probe_error)
            else {
                persist_new_cli_probe_failure(
                    installed_missing_cli,
                    state,
                    paths,
                    &probe_error,
                    &mut routine_baseline,
                )?;
                return Err(probe_error);
            };
            if managed_cli.is_some() {
                persist_new_cli_probe_failure(
                    installed_missing_cli,
                    state,
                    paths,
                    &probe_error,
                    &mut routine_baseline,
                )?;
                return Err(probe_error);
            }
            let Some(npm_install) = npm_cli_install(&cli_path, &missing_dependency) else {
                persist_new_cli_probe_failure(
                    installed_missing_cli,
                    state,
                    paths,
                    &probe_error,
                    &mut routine_baseline,
                )?;
                return Err(probe_error);
            };

            warn!(
                ?probe_error,
                "repairing Codex CLI with missing platform optional dependency"
            );
            state.cli_path = Some(cli_path.clone());
            state.cli_install_channel = cli_install_channel.clone();
            state.cli_installed_version = None;
            state.cli_package_manager_latest_version = None;
            state.cli_last_verified_at = None;
            state.cli_status = CliStatus::Updating;
            state.cli_error_message = None;
            if persist_routine_state(paths, state, &mut routine_baseline)? {
                return Err(anyhow!(
                    "Codex CLI repair is already pending. Run `codex-update-manager diagnose` for details and repair instructions."
                ));
            }

            let repaired_version = match repair_npm_optional_dependency(
                &npm_install,
                paths,
                &cli_path,
                version_timeout,
            ) {
                Ok(OptionalDependencyRepairOutcome::Functional(version)) => Ok(version),
                Ok(OptionalDependencyRepairOutcome::RepairRequired) => {
                    set_cli_repair_required(state);
                    persist_routine_state(paths, state, &mut routine_baseline)?;
                    return Err(anyhow!(
                        "Codex CLI repair is already pending. Run `codex-update-manager diagnose` for details and repair instructions."
                    ));
                }
                Err(error) => Err(error),
            }
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
                    persist_cli_failure(state, paths, &error, &mut routine_baseline)?;
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
    state.cli_install_channel = if managed_cli.is_some() {
        None
    } else {
        cli_install_channel.clone()
    };
    state.cli_installed_version = Some(installed_version.clone());
    state.cli_package_manager_latest_version = package_manager_version_status
        .as_ref()
        .map(|status| status.latest_version.clone());
    state.cli_last_verified_at = Some(Utc::now());
    if persist_routine_state(paths, state, &mut routine_baseline)? {
        return Ok(preflight_outcome_from_current_state(
            state,
            cli_path,
            installed_version,
        ));
    }

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
        if persist_routine_state(paths, state, &mut routine_baseline)? {
            return Ok(preflight_outcome_from_current_state(
                state,
                cli_path,
                installed_version,
            ));
        }
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
    if persist_routine_state(paths, state, &mut routine_baseline)? {
        return Ok(preflight_outcome_from_current_state(
            state,
            cli_path,
            installed_version,
        ));
    }

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
                if persist_routine_state(paths, state, &mut routine_baseline)? {
                    return Ok(preflight_outcome_from_current_state(
                        state,
                        cli_path,
                        installed_version,
                    ));
                }
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
        if persist_routine_state(paths, state, &mut routine_baseline)? {
            return Ok(preflight_outcome_from_current_state(
                state,
                cli_path,
                installed_version,
            ));
        }
        return Ok(preflight_outcome_from_state(
            cli_path,
            installed_version,
            state,
            repaired,
        ));
    }

    if matches!(cli_install_kind, CliInstallKind::Homebrew)
        && state.cli_status != CliStatus::UpToDate
    {
        state.cli_status = CliStatus::UpdateRequired;
        state.cli_error_message = Some(format!(
            "This Codex CLI appears to be installed through Homebrew at {}. Update it with Homebrew; ChatGPT Desktop will not replace it with an npm-managed install.",
            cli_path.display()
        ));
        if persist_routine_state(paths, state, &mut routine_baseline)? {
            return Ok(preflight_outcome_from_current_state(
                state,
                cli_path,
                installed_version,
            ));
        }
        return Ok(preflight_outcome_from_state(
            cli_path,
            installed_version,
            state,
            false,
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
            if persist_routine_state(paths, state, &mut routine_baseline)? {
                return Ok(preflight_outcome_from_current_state(
                    state,
                    cli_path,
                    installed_version,
                ));
            }
            return Ok(preflight_outcome_from_state(
                cli_path,
                installed_version,
                state,
                repaired,
            ));
        }
    };
    if state.cli_status == CliStatus::UpToDate {
        if persist_routine_state(paths, state, &mut routine_baseline)? {
            return Ok(preflight_outcome_from_current_state(
                state,
                cli_path,
                installed_version,
            ));
        }
        return Ok(preflight_outcome_from_state(
            cli_path,
            installed_version,
            state,
            repaired,
        ));
    }
    if repaired {
        if persist_routine_state(paths, state, &mut routine_baseline)? {
            return Ok(preflight_outcome_from_current_state(
                state,
                cli_path,
                installed_version,
            ));
        }
        return Ok(preflight_outcome_from_state(
            cli_path,
            installed_version,
            state,
            true,
        ));
    }

    if persist_routine_state(paths, state, &mut routine_baseline)? {
        return Ok(preflight_outcome_from_current_state(
            state,
            cli_path,
            installed_version,
        ));
    }
    info!(
        installed_version,
        latest_version, "Codex CLI is outdated; attempting prelaunch upgrade"
    );

    state.cli_status = CliStatus::Updating;
    if persist_routine_state(paths, state, &mut routine_baseline)? {
        return Ok(preflight_outcome_from_current_state(
            state,
            cli_path,
            installed_version,
        ));
    }
    let managed_install =
        match update_existing_cli(&cli_install_kind, &latest_version, state, paths) {
            Ok(CliUpdateOutcome::Updated(managed_install)) => managed_install,
            Ok(CliUpdateOutcome::RepairRequired) => {
                set_cli_repair_required(state);
                persist_routine_state(paths, state, &mut routine_baseline)?;
                return Ok(preflight_outcome_from_current_state(
                    state,
                    cli_path,
                    installed_version,
                ));
            }
            Err(error) => {
                persist_cli_failure(state, paths, &error, &mut routine_baseline)?;
                return Err(error);
            }
        };
    routine_baseline = state.clone();

    let (refreshed_path, refreshed_version) = if let Some(managed_install) = managed_install {
        (managed_install.cli_path, managed_install.installed_version)
    } else if let Some(updated_cli) = resolve_cli_path_with_version(requested_path, &latest_version)
    {
        updated_cli
    } else {
        let fallback_path = resolve_cli_path(requested_path)
            .or_else(|| resolve_cli_path(None))
            .ok_or_else(|| anyhow!("Codex CLI disappeared after the automatic upgrade attempt"))?;
        let fallback_launch_path = canonical_cli_launch_path(&fallback_path)?;
        let fallback_version = read_installed_version(&fallback_launch_path)?;
        (fallback_launch_path, fallback_version)
    };
    state.cli_path = Some(refreshed_path.clone());
    state.cli_install_channel = Some(cli_install_kind.channel());
    state.cli_installed_version = Some(refreshed_version.clone());

    if refreshed_version != latest_version {
        let message = format!(
            "Codex CLI upgrade finished but the installed version is still {refreshed_version} instead of {latest_version}"
        );
        state.cli_status = CliStatus::Failed;
        state.cli_error_message = Some(message.clone());
        if persist_routine_state(paths, state, &mut routine_baseline)? {
            return Ok(preflight_outcome_from_current_state(
                state,
                refreshed_path,
                refreshed_version,
            ));
        }
        anyhow::bail!(message);
    }

    state.cli_status = CliStatus::UpToDate;
    state.cli_error_message = None;
    if persist_routine_state(paths, state, &mut routine_baseline)? {
        return Ok(preflight_outcome_from_current_state(
            state,
            refreshed_path,
            refreshed_version,
        ));
    }
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
    let selected_cli_path = match resolve_cli_path(requested_path.as_deref()) {
        Some(path) => path,
        None => {
            mark_cli_missing(state);
            return persist_if_changed(paths, state, &original_state);
        }
    };
    let cli_path = match stable_cli_launch_path(&selected_cli_path) {
        Ok(path) => path,
        Err(resolution_error) => {
            let error = cli_launch_path_error(&selected_cli_path, resolution_error);
            state.cli_path = Some(selected_cli_path);
            state.cli_install_channel = None;
            state.cli_installed_version = None;
            state.cli_package_manager_latest_version = None;
            state.cli_last_verified_at = None;
            state.cli_status = CliStatus::Failed;
            state.cli_error_message = Some(format!("{error:#}"));
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

    let stored_cli_path = state.cli_path.clone();
    let stored_cli_install_channel = state.cli_install_channel.clone();
    state.cli_path = Some(cli_path.clone());
    state.cli_install_channel = if managed_cli.is_some() {
        None
    } else {
        Some(
            classify_cli_install(
                &selected_cli_path,
                &cli_path,
                stored_cli_path.as_deref(),
                stored_cli_install_channel.as_ref(),
            )
            .channel(),
        )
    };
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
    let mut routine_baseline = state.clone();
    let requested_path = requested_cli_path(state);
    let selected_cli_path = match resolve_cli_path(requested_path.as_deref()) {
        Some(path) => path,
        None => {
            mark_cli_missing(state);
            persist_routine_state(paths, state, &mut routine_baseline)?;
            return Ok(());
        }
    };
    let cli_path = match stable_cli_launch_path(&selected_cli_path) {
        Ok(path) => path,
        Err(resolution_error) => {
            let error = cli_launch_path_error(&selected_cli_path, resolution_error);
            state.cli_path = Some(selected_cli_path);
            state.cli_install_channel = None;
            state.cli_installed_version = None;
            state.cli_package_manager_latest_version = None;
            state.cli_last_verified_at = None;
            state.cli_status = CliStatus::Failed;
            state.cli_error_message = Some(format!(
                "Could not read the installed {CLI_PACKAGE_NAME} version: {error:#}"
            ));
            persist_routine_state(paths, state, &mut routine_baseline)?;
            warn!(?error, "unable to trust selected Codex CLI");
            return Ok(());
        }
    };
    let path_env = command_path_env();
    let managed_cli = cli_management::detect_system_package_managed_cli(&cli_path, &path_env);
    let package_manager_version_status =
        current_package_manager_version_status(managed_cli.as_ref(), &path_env);
    let stored_cli_path = state.cli_path.clone();
    let stored_cli_install_channel = state.cli_install_channel.clone();

    let cached_installed_version = state.cli_installed_version.clone();
    let installed_version = match read_installed_version(&cli_path) {
        Ok(version) => version,
        Err(error) => {
            state.cli_path = Some(cli_path.clone());
            state.cli_install_channel = if managed_cli.is_some() {
                None
            } else {
                Some(
                    classify_cli_install(
                        &selected_cli_path,
                        &cli_path,
                        stored_cli_path.as_deref(),
                        stored_cli_install_channel.as_ref(),
                    )
                    .channel(),
                )
            };
            state.cli_installed_version = None;
            state.cli_package_manager_latest_version = None;
            state.cli_last_verified_at = None;
            state.cli_status = CliStatus::Failed;
            state.cli_error_message = Some(format!(
                "Could not read the installed {CLI_PACKAGE_NAME} version: {error}"
            ));
            persist_routine_state(paths, state, &mut routine_baseline)?;
            warn!(?error, "unable to read installed Codex CLI version");
            return Ok(());
        }
    };

    state.cli_path = Some(cli_path.clone());
    state.cli_install_channel = if managed_cli.is_some() {
        None
    } else {
        Some(
            classify_cli_install(
                &selected_cli_path,
                &cli_path,
                stored_cli_path.as_deref(),
                stored_cli_install_channel.as_ref(),
            )
            .channel(),
        )
    };
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
        persist_routine_state(paths, state, &mut routine_baseline)?;
        return Ok(());
    }

    state.cli_last_check_at = Some(Utc::now());
    state.cli_error_message = None;
    state.cli_status = CliStatus::Checking;
    if persist_routine_state(paths, state, &mut routine_baseline)? {
        return Ok(());
    }

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

    persist_routine_state(paths, state, &mut routine_baseline).map(|_| ())
}

pub fn reconcile_if_present(state: &mut PersistedState, paths: &RuntimePaths) -> Result<bool> {
    let requested_path = requested_cli_path(state);
    if resolve_cli_path(requested_path.as_deref()).is_none() {
        refresh_status(state, paths)?;
        return Ok(false);
    }

    Ok(preflight(state, paths, requested_path, false)?.updated)
}

fn persist_state(paths: &RuntimePaths, state: &mut PersistedState) -> Result<()> {
    state.save_cli(&paths.state_file)
}

fn persist_routine_state(
    paths: &RuntimePaths,
    state: &mut PersistedState,
    baseline: &mut PersistedState,
) -> Result<bool> {
    let _install_lock = npm_cli_repair::acquire_install_lock(paths)?;
    let repair_pending = npm_cli_repair::load(paths)?.is_some();
    if repair_pending {
        set_cli_repair_required(state);
        state.save_cli_status(&paths.state_file)?;
        *baseline = state.clone();
        return Ok(true);
    }
    let persisted = state.save_cli_if_unchanged(&paths.state_file, baseline)?;
    if persisted {
        *baseline = state.clone();
    }
    Ok(!persisted)
}

fn persist_cli_failure(
    state: &mut PersistedState,
    paths: &RuntimePaths,
    error: &anyhow::Error,
    baseline: &mut PersistedState,
) -> Result<()> {
    state.cli_status = CliStatus::Failed;
    state.cli_error_message = Some(format!("{error:#}"));
    persist_routine_state(paths, state, baseline).map(|_| ())
}

fn set_cli_repair_required(state: &mut PersistedState) {
    state.cli_status = CliStatus::UpdateRequired;
    state.cli_error_message = Some(
        "A stale npm retirement directory is blocking the Codex CLI update. The existing functional CLI remains in use. Run `codex-update-manager diagnose` for details and repair instructions."
            .to_string(),
    );
}

fn persist_new_cli_probe_failure(
    installed_missing_cli: bool,
    state: &mut PersistedState,
    paths: &RuntimePaths,
    error: &anyhow::Error,
    baseline: &mut PersistedState,
) -> Result<()> {
    if installed_missing_cli {
        persist_cli_failure(state, paths, error, baseline)?;
    }
    Ok(())
}

#[cfg(test)]
fn persist_if_changed(
    paths: &RuntimePaths,
    state: &mut PersistedState,
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
            let launch_path = canonical_cli_launch_path(&path).ok()?;
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
    if let Some(homebrew_prefix) = std::env::var_os("HOMEBREW_PREFIX").map(PathBuf::from) {
        candidates.push(homebrew_prefix.join("bin/codex"));
    }
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
        candidates.push(home.join(".linuxbrew/bin/codex"));
        candidates.push(home.join(".local/bin/codex"));
    }
    if include_system_cli_locations() {
        candidates.push(PathBuf::from("/home/linuxbrew/.linuxbrew/bin/codex"));
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
    state.cli_install_channel = None;
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

fn preflight_outcome_from_current_state(
    state: &PersistedState,
    fallback_path: PathBuf,
    fallback_version: String,
) -> PreflightOutcome {
    preflight_outcome_from_state(
        state.cli_path.clone().unwrap_or(fallback_path),
        state
            .cli_installed_version
            .clone()
            .unwrap_or(fallback_version),
        state,
        false,
    )
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
    let launch_path = canonical_cli_launch_path(cli_path)?;
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
    let launch_path = canonical_cli_launch_path(cli_path)?;
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
    let output = run_bounded_command_output(npm, path_env, None, &args, timeout, false, None)?;

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
    let npm_program = canonical_cli_launch_path(&toolchain_bin.join("npm")).ok()?;
    canonical_cli_launch_path(&toolchain_bin.join("node")).ok()?;

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

fn repair_npm_optional_dependency(
    install: &NpmCliInstall,
    paths: &RuntimePaths,
    cli_path: &Path,
    version_timeout: StdDuration,
) -> Result<OptionalDependencyRepairOutcome> {
    let install_lock = npm_cli_repair::acquire_install_lock(paths)?;
    if npm_cli_repair::load(paths)?.is_some() {
        return Ok(OptionalDependencyRepairOutcome::RepairRequired);
    }
    if let Ok(version) = read_installed_version_bounded(cli_path, version_timeout) {
        return Ok(OptionalDependencyRepairOutcome::Functional(version));
    }
    repair_npm_optional_dependency_with_timeout(
        install,
        NPM_REPAIR_INSTALL_TIMEOUT,
        Some(&install_lock),
    )?;
    read_installed_version_bounded(cli_path, version_timeout)
        .map(OptionalDependencyRepairOutcome::Functional)
}

fn repair_npm_optional_dependency_with_timeout(
    install: &NpmCliInstall,
    timeout: StdDuration,
    install_lock: Option<&npm_cli_repair::InstallLock>,
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
        install_lock,
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
    let output = run_bounded_command_output(program, path_env, None, args, timeout, false, None)?;
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
    install_lock: Option<&npm_cli_repair::InstallLock>,
) -> Result<Output> {
    let supervised = install_lock.is_some() && !cfg!(test);
    let mut command = if supervised {
        let timeout_millis = u64::try_from(timeout.as_millis())
            .context("bounded npm timeout does not fit in milliseconds")?;
        let mut command = Command::new("/proc/self/exe");
        command
            .arg("run-npm-supervisor")
            .arg("--owner-pid")
            .arg(std::process::id().to_string())
            .arg("--timeout-millis")
            .arg(timeout_millis.to_string())
            .arg("--install-lock-fd")
            .arg(
                install_lock
                    .expect("supervised npm commands require the install lock")
                    .raw_fd()
                    .to_string(),
            )
            .arg(program)
            .arg("--")
            .args(args);
        command
    } else {
        let mut command = Command::new(program);
        command.args(args);
        command
    };
    command
        .env("PATH", path_env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(current_dir) = current_dir {
        command.current_dir(current_dir);
    }
    if safe_umask {
        apply_safe_child_umask(&mut command);
    }
    if let Some(install_lock) = install_lock {
        install_lock.inherit_with(&mut command);
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
    let parent_timeout = if supervised {
        timeout.saturating_add(NPM_SUPERVISOR_EXIT_GRACE)
    } else {
        timeout
    };

    loop {
        if supervised {
            match child_has_exited_without_reaping(&child) {
                Ok(true) => {
                    terminate_process_group_members(process_group, child.id() as i32);
                    let status = child.wait().with_context(|| {
                        format!(
                            "Failed to reap npm supervisor for {} {}",
                            program.display(),
                            format_command_args(args)
                        )
                    })?;
                    return Ok(collect_bounded_output(
                        status,
                        process_group,
                        &stdout_rx,
                        &stderr_rx,
                    ));
                }
                Ok(false) => {}
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
        } else {
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
        }

        if started.elapsed() >= parent_timeout {
            terminate_process_group(&mut child, process_group);
            let _ = child.wait();
            let _ = receive_bounded_output(&stdout_rx, process_group);
            let _ = receive_bounded_output(&stderr_rx, process_group);
            anyhow::bail!(
                "{} {} timed out after {} seconds",
                program.display(),
                format_command_args(args),
                parent_timeout.as_secs_f64()
            );
        }

        thread::sleep(
            BOUNDED_COMMAND_POLL_INTERVAL.min(parent_timeout.saturating_sub(started.elapsed())),
        );
    }
}

pub(crate) fn run_npm_supervisor(
    owner_pid: u32,
    timeout_millis: u64,
    install_lock_fd: RawFd,
    program: &Path,
    args: &[OsString],
) -> Result<()> {
    anyhow::ensure!(owner_pid != 0, "npm supervisor owner PID is invalid");
    anyhow::ensure!(
        program.is_absolute(),
        "npm supervisor program must be an absolute path"
    );
    let timeout = StdDuration::from_millis(timeout_millis);
    anyhow::ensure!(
        !timeout.is_zero(),
        "npm supervisor timeout must be positive"
    );
    anyhow::ensure!(
        current_parent_pid() == owner_pid,
        "npm supervisor owner exited before npm started"
    );
    set_close_on_exec(install_lock_fd).context("Failed to isolate the CLI install lock")?;

    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    if cfg!(test) {
        // Unit tests invoke the supervisor inside the shared test runner rather
        // than through the production process-group boundary.
        command.process_group(0);
    }
    let supervisor_pid = std::process::id();
    unsafe {
        command.pre_exec(move || {
            if libc::prctl(libc::PR_SET_PDEATHSIG, SIGKILL) == -1 {
                return Err(std::io::Error::last_os_error());
            }
            if libc::getppid() as u32 != supervisor_pid {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "npm supervisor exited before npm started",
                ));
            }
            Ok(())
        });
    }
    let mut child = command
        .spawn()
        .with_context(|| format!("Failed to spawn supervised npm {}", program.display()))?;
    let supervisor_pid = std::process::id() as i32;
    let process_group = if cfg!(test) {
        child.id() as i32
    } else {
        supervisor_pid
    };
    let started = Instant::now();

    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                terminate_process_group_members(process_group, supervisor_pid);
                if status.success() {
                    return Ok(());
                }
                exit_with_status(status);
            }
            Ok(None) => {}
            Err(error) => {
                terminate_process_group_members(process_group, supervisor_pid);
                let _ = child.kill();
                let _ = child.wait();
                return Err(error).with_context(|| {
                    format!(
                        "Failed while waiting for supervised npm {}",
                        program.display()
                    )
                });
            }
        }

        if current_parent_pid() != owner_pid {
            terminate_process_group_members(process_group, supervisor_pid);
            let _ = child.kill();
            let _ = child.wait();
            anyhow::bail!("updater parent exited while npm was running");
        }
        if started.elapsed() >= timeout {
            terminate_process_group_members(process_group, supervisor_pid);
            let _ = child.kill();
            let _ = child.wait();
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

fn set_close_on_exec(fd: RawFd) -> Result<()> {
    anyhow::ensure!(fd >= 0, "npm supervisor install lock descriptor is invalid");
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
    if flags == -1 {
        return Err(std::io::Error::last_os_error())
            .context("Failed to inspect the inherited install lock descriptor");
    }
    if unsafe { libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) } == -1 {
        return Err(std::io::Error::last_os_error())
            .context("Failed to protect the inherited install lock descriptor");
    }
    Ok(())
}

fn current_parent_pid() -> u32 {
    unsafe { libc::getppid() as u32 }
}

fn child_has_exited_without_reaping(child: &std::process::Child) -> std::io::Result<bool> {
    let mut info = std::mem::MaybeUninit::<libc::siginfo_t>::zeroed();
    let result = unsafe {
        libc::waitid(
            libc::P_PID,
            child.id(),
            info.as_mut_ptr(),
            libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
        )
    };
    if result == -1 {
        return Err(std::io::Error::last_os_error());
    }
    let info = unsafe { info.assume_init() };
    Ok(unsafe { info.si_pid() } != 0)
}

fn exit_with_status(status: ExitStatus) -> ! {
    let code = status
        .code()
        .or_else(|| status.signal().map(|signal| 128 + signal))
        .unwrap_or(1);
    std::process::exit(code);
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

fn terminate_process_group_members(process_group: i32, excluded_pid: i32) {
    if !signal_process_group_members(process_group, excluded_pid, SIGTERM) {
        return;
    }

    let deadline = Instant::now() + BOUNDED_COMMAND_TERMINATION_GRACE;
    while Instant::now() < deadline {
        if !process_group_has_members(process_group, excluded_pid) {
            return;
        }
        thread::sleep(BOUNDED_COMMAND_POLL_INTERVAL.min(deadline - Instant::now()));
    }
    signal_process_group(process_group, SIGKILL);
}

fn signal_process_group_members(process_group: i32, excluded_pid: i32, signal: i32) -> bool {
    let members = match process_group_member_pidfds(process_group, excluded_pid) {
        Ok(members) => members,
        Err(_) => {
            signal_process_group(process_group, SIGKILL);
            return true;
        }
    };
    for member in &members {
        let result = unsafe {
            libc::syscall(
                libc::SYS_pidfd_send_signal,
                member.as_raw_fd(),
                signal,
                std::ptr::null::<libc::siginfo_t>(),
                0,
            )
        };
        if result == -1 && std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH) {
            signal_process_group(process_group, SIGKILL);
            return true;
        }
    }
    !members.is_empty()
}

fn process_group_has_members(process_group: i32, excluded_pid: i32) -> bool {
    process_group_member_pidfds(process_group, excluded_pid)
        .map(|members| !members.is_empty())
        .unwrap_or(true)
}

fn process_group_member_pidfds(
    process_group: i32,
    excluded_pid: i32,
) -> std::io::Result<Vec<OwnedFd>> {
    let mut members = Vec::new();
    for entry in fs::read_dir("/proc")? {
        let entry = entry?;
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|name| name.parse::<i32>().ok())
        else {
            continue;
        };
        if pid == excluded_pid || process_group_for_pid(pid)? != Some(process_group) {
            continue;
        }
        let pidfd = {
            let raw_fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) as i32 };
            if raw_fd == -1 {
                let error = std::io::Error::last_os_error();
                if error.raw_os_error() == Some(libc::ESRCH) {
                    continue;
                }
                return Err(error);
            }
            unsafe { OwnedFd::from_raw_fd(raw_fd) }
        };
        if process_group_for_pid(pid)? == Some(process_group) {
            members.push(pidfd);
        }
    }
    Ok(members)
}

fn process_group_for_pid(pid: i32) -> std::io::Result<Option<i32>> {
    let process_group = unsafe { libc::getpgid(pid) };
    if process_group >= 0 {
        return Ok(Some(process_group));
    }
    let error = std::io::Error::last_os_error();
    match error.raw_os_error() {
        Some(libc::ESRCH | libc::EPERM) => Ok(None),
        _ => Err(error),
    }
}

fn signal_process_group(process_group: i32, signal: i32) {
    // SAFETY: callers target a dedicated process group while its leader is
    // alive or deliberately unreaped. The fail-closed member cleanup path may
    // also terminate its own supervisor, ensuring the lock cannot be released
    // while an untracked npm descendant remains.
    unsafe {
        let _ = kill(-process_group, signal);
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum CliInstallKind {
    Standalone(StandaloneCliInstall),
    Homebrew,
    Npm,
}

impl CliInstallKind {
    fn channel(&self) -> CliInstallChannel {
        match self {
            CliInstallKind::Standalone(_) => CliInstallChannel::Standalone,
            CliInstallKind::Homebrew => CliInstallChannel::Homebrew,
            CliInstallKind::Npm => CliInstallChannel::Npm,
        }
    }
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

fn update_existing_cli(
    install_kind: &CliInstallKind,
    latest_version: &str,
    state: &mut PersistedState,
    paths: &RuntimePaths,
) -> Result<CliUpdateOutcome> {
    match install_kind {
        CliInstallKind::Standalone(install) => {
            update_standalone_cli(install, latest_version)?;
            Ok(CliUpdateOutcome::Updated(None))
        }
        CliInstallKind::Homebrew => {
            anyhow::bail!("Homebrew-managed Codex CLI installs must be updated with Homebrew")
        }
        CliInstallKind::Npm => install_latest_cli(latest_version, state, paths),
    }
}

fn classify_cli_install(
    selected_cli_path: &Path,
    launch_path: &Path,
    stored_cli_path: Option<&Path>,
    stored_cli_install_channel: Option<&CliInstallChannel>,
) -> CliInstallKind {
    if let Some(install) =
        standalone_cli_install(selected_cli_path).or_else(|| standalone_cli_install(launch_path))
    {
        return CliInstallKind::Standalone(install);
    }
    let stored_homebrew_launch_path = stored_cli_install_channel
        == Some(&CliInstallChannel::Homebrew)
        && stored_cli_path == Some(launch_path);
    if homebrew_cli_install(selected_cli_path)
        || homebrew_cli_install(launch_path)
        || stored_homebrew_launch_path
    {
        return CliInstallKind::Homebrew;
    }
    CliInstallKind::Npm
}

fn homebrew_cli_install(cli_path: &Path) -> bool {
    let canonical_path = fs::canonicalize(cli_path).ok();
    let homebrew_prefix = std::env::var_os("HOMEBREW_PREFIX")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);

    homebrew_prefix.as_deref().is_some_and(|prefix| {
        cli_path.starts_with(prefix)
            || canonical_path
                .as_deref()
                .is_some_and(|path| path.starts_with(prefix))
    }) || path_has_component(cli_path, ".linuxbrew")
        || canonical_path
            .as_deref()
            .is_some_and(|path| path_has_component(path, ".linuxbrew"))
}

fn path_has_component(path: &Path, name: &str) -> bool {
    path.components()
        .any(|component| component.as_os_str() == OsStr::new(name))
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
        })?;
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
    canonical_cli_launch_path(cli_path)
}

fn canonical_cli_launch_path(cli_path: &Path) -> Result<PathBuf> {
    let canonical_cli = fs::canonicalize(cli_path)
        .with_context(|| format!("Failed to resolve Codex CLI path {}", cli_path.display()))?;
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
    Ok(canonical_cli)
}

fn cli_launch_path_error(cli_path: &Path, resolution_error: anyhow::Error) -> anyhow::Error {
    resolution_error.context(format!(
        "Could not resolve the selected Codex CLI at {} to an executable file",
        cli_path.display()
    ))
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
    canonical_cli_launch_path(&standalone_visible_cli(&install)).map(|_| ())
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
    canonical_cli_launch_path(&standalone_visible_cli(&install)).map(|_| ())
}

/// Reinstall a standalone CLI after the caller has removed a rejected tree.
/// The official installer runs with a child-only safe umask and the result is
/// checked before a canonical launch target is returned.
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
    let visible_cli = standalone_visible_cli(&install);
    canonical_cli_launch_path(&visible_cli).with_context(|| {
        format!(
            "Standalone Codex CLI recovery completed but did not produce an executable at {}",
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

fn standalone_visible_cli(install: &StandaloneCliInstall) -> PathBuf {
    install
        .install_dir
        .as_deref()
        .map(|directory| directory.join("codex"))
        .unwrap_or_else(|| install.standalone_root().join("current/bin/codex"))
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
    anyhow::ensure!(
        metadata.is_dir() && !metadata.file_type().is_symlink(),
        "Standalone Codex CLI recovery ancestor {} is not a regular directory",
        existing_parent.display()
    );
    Ok(())
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
                "Standalone recovery path {} is not a usable directory",
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
    anyhow::ensure!(
        metadata.is_dir() && !metadata.file_type().is_symlink(),
        "Standalone Codex CLI install ancestor {} is not a regular directory",
        existing_parent.display()
    );
    Ok(())
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

fn install_latest_cli(
    latest_version: &str,
    state: &mut PersistedState,
    paths: &RuntimePaths,
) -> Result<CliUpdateOutcome> {
    let install_lock = npm_cli_repair::acquire_install_lock(paths)?;
    install_latest_cli_locked(latest_version, state, paths, &install_lock)
}

fn install_latest_cli_locked(
    latest_version: &str,
    state: &mut PersistedState,
    paths: &RuntimePaths,
    install_lock: &npm_cli_repair::InstallLock,
) -> Result<CliUpdateOutcome> {
    let (npm, path_env) = npm_program()?;
    let package_spec = format!("{CLI_PACKAGE_NAME}@{latest_version}");
    let local_prefix = npm_cli_repair::managed_prefix();
    prepare_safe_npm_prefix(&local_prefix)?;
    if npm_cli_repair::load(paths)?.is_some() {
        set_cli_repair_required(state);
        state.save_cli_status(&paths.state_file)?;
        return Ok(CliUpdateOutcome::RepairRequired);
    }
    match current_managed_install(latest_version) {
        Ok(Some(install)) => {
            record_managed_install(state, latest_version, &install);
            persist_state(paths, state)?;
            return Ok(CliUpdateOutcome::Updated(Some(install)));
        }
        Ok(None) => {}
        Err(error) => {
            return Err(error).context("Failed to validate the existing managed Codex CLI");
        }
    }
    let local_args = vec![
        OsString::from("install"),
        OsString::from("-g"),
        OsString::from("--include=optional"),
        OsString::from("--prefix"),
        local_prefix.as_os_str().to_os_string(),
        OsString::from(&package_spec),
    ];
    let first_output = run_bounded_command_output(
        &npm,
        &path_env,
        None,
        &local_args,
        NPM_REPAIR_INSTALL_TIMEOUT,
        true,
        Some(install_lock),
    )?;
    if first_output.status.success() {
        let install = current_managed_install(latest_version)?.with_context(|| {
            format!("npm completed but managed Codex CLI {latest_version} could not be resolved")
        })?;
        record_managed_install(state, latest_version, &install);
        persist_state(paths, state)?;
        return Ok(CliUpdateOutcome::Updated(Some(install)));
    }

    if npm_cli_repair::detect_and_persist(paths, &local_prefix, &first_output)?.is_some() {
        set_cli_repair_required(state);
        state.save_cli_status(&paths.state_file)?;
        return Ok(CliUpdateOutcome::RepairRequired);
    }

    ensure_npm_command_success(&npm, &local_args, first_output)
        .with_context(|| format!("npm install into {} failed", local_prefix.display()))?;
    unreachable!("failed npm output should have returned an error")
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
    anyhow::ensure!(
        metadata.is_dir() && !metadata.file_type().is_symlink(),
        "Dedicated npm prefix {} is not a directory",
        prefix.display()
    );
    let euid = unsafe { libc::geteuid() };
    anyhow::ensure!(
        metadata.uid() == euid,
        "Dedicated npm prefix {} is not owned by the current user",
        prefix.display()
    );

    let mode = metadata.permissions().mode();
    if mode & 0o022 != 0 {
        fs::set_permissions(prefix, fs::Permissions::from_mode(mode & !0o022))
            .with_context(|| format!("Failed to secure npm prefix {}", prefix.display()))?;
    }
    Ok(())
}

pub fn repair_cli(state: &mut PersistedState, paths: &RuntimePaths) -> Result<CliRepairOutcome> {
    let install_lock = npm_cli_repair::acquire_install_lock(paths)?;
    let mut journal = npm_cli_repair::load(paths)?
        .context("No Codex CLI repair is pending. Run `codex-update-manager diagnose` first.")?;
    let initial_snapshot = npm_cli_repair::validate_journal(&journal)?;
    let (npm, path_env) = match npm_program() {
        Ok(command) => command,
        Err(error) => {
            return Err(cli_repair_failure_error(
                state,
                paths,
                &mut journal,
                &initial_snapshot,
                &format!("Failed to resolve npm for Codex CLI repair: {error:#}"),
            ));
        }
    };
    let latest_version =
        match read_latest_version_with_npm_bounded(&npm, &path_env, NPM_REPAIR_REGISTRY_TIMEOUT) {
            Ok(version) => version,
            Err(error) => {
                return Err(cli_repair_failure_error(
                    state,
                    paths,
                    &mut journal,
                    &initial_snapshot,
                    &format!("Failed to resolve the latest Codex CLI version: {error:#}"),
                ));
            }
        };
    let snapshot = match npm_cli_repair::quarantine(paths, &mut journal) {
        Ok(snapshot) => snapshot,
        Err(error) => {
            let fallback_snapshot = npm_cli_repair::journal_snapshot(&journal)
                .unwrap_or_else(|_| initial_snapshot.clone());
            return Err(cli_repair_failure_error(
                state,
                paths,
                &mut journal,
                &fallback_snapshot,
                &format!("Failed to quarantine the stale npm directory: {error:#}"),
            ));
        }
    };

    if let Some(install) = match current_managed_install(&latest_version) {
        Ok(install) => install,
        Err(error) => {
            warn!(
                ?error,
                "managed Codex CLI probe failed during explicit repair"
            );
            None
        }
    } {
        return complete_cli_repair(
            state,
            paths,
            &mut journal,
            snapshot,
            &latest_version,
            install,
        );
    }

    let package_spec = format!("{CLI_PACKAGE_NAME}@{latest_version}");
    let args = vec![
        OsString::from("install"),
        OsString::from("-g"),
        OsString::from("--include=optional"),
        OsString::from("--prefix"),
        npm_cli_repair::managed_prefix().as_os_str().to_os_string(),
        OsString::from(&package_spec),
    ];
    let output = match run_bounded_command_output(
        &npm,
        &path_env,
        None,
        &args,
        NPM_REPAIR_INSTALL_TIMEOUT,
        true,
        Some(&install_lock),
    ) {
        Ok(output) => output,
        Err(error) => {
            return Err(cli_repair_failure_error(
                state,
                paths,
                &mut journal,
                &snapshot,
                &format!("{error:#}"),
            ));
        }
    };
    if !output.status.success() {
        let error = format!(
            "{} {} failed with {}{}",
            npm.display(),
            format_command_args(&args),
            output.status,
            format_command_output(&output)
        );
        return Err(cli_repair_failure_error(
            state,
            paths,
            &mut journal,
            &snapshot,
            &error,
        ));
    }

    let install = match current_managed_install(&latest_version) {
        Ok(Some(install)) => install,
        Ok(None) => {
            return Err(cli_repair_failure_error(
                state,
                paths,
                &mut journal,
                &snapshot,
                &format!(
                    "npm completed but Codex CLI {latest_version} could not be resolved after repair"
                ),
            ));
        }
        Err(error) => {
            return Err(cli_repair_failure_error(
                state,
                paths,
                &mut journal,
                &snapshot,
                &format!(
                    "npm completed but the repaired Codex CLI could not be validated: {error:#}"
                ),
            ));
        }
    };

    complete_cli_repair(
        state,
        paths,
        &mut journal,
        snapshot,
        &latest_version,
        install,
    )
}

fn complete_cli_repair(
    state: &mut PersistedState,
    paths: &RuntimePaths,
    journal: &mut npm_cli_repair::RepairJournal,
    snapshot: npm_cli_repair::RepairSnapshot,
    latest_version: &str,
    install: ManagedCliInstall,
) -> Result<CliRepairOutcome> {
    record_managed_install(state, latest_version, &install);
    if let Err(error) = persist_state(paths, state) {
        return Err(cli_repair_failure_error(
            state,
            paths,
            journal,
            &snapshot,
            &format!("Failed to persist repaired Codex CLI state: {error:#}"),
        ));
    }
    if let Err(error) = npm_cli_repair::clear(paths) {
        return Err(cli_repair_failure_error(
            state,
            paths,
            journal,
            &snapshot,
            &format!("Failed to clear the completed Codex CLI repair journal: {error:#}"),
        ));
    }

    Ok(CliRepairOutcome {
        installed_version: install.installed_version,
        quarantine_paths: snapshot.quarantine_paths,
    })
}

fn cli_repair_failure_error(
    state: &mut PersistedState,
    paths: &RuntimePaths,
    journal: &mut npm_cli_repair::RepairJournal,
    fallback_snapshot: &npm_cli_repair::RepairSnapshot,
    error: &str,
) -> anyhow::Error {
    let mut persistence_errors = Vec::new();
    let snapshot = match npm_cli_repair::record_failure(paths, journal, error) {
        Ok(snapshot) => snapshot,
        Err(persist_error) => {
            persistence_errors.push(format!(
                "failed to persist the Codex CLI repair journal: {persist_error:#}"
            ));
            fallback_snapshot.clone()
        }
    };
    let repair_message = repair_failure_message(error, &snapshot);
    state.cli_status = CliStatus::Failed;
    state.cli_error_message = Some(format!(
        "{} Run `codex-update-manager diagnose` before retrying `codex-update-manager repair-cli`.",
        repair_message
    ));
    if let Err(persist_error) = persist_state(paths, state) {
        persistence_errors.push(format!(
            "failed to persist updater CLI failure state: {persist_error:#}"
        ));
    }
    if persistence_errors.is_empty() {
        anyhow!(repair_message)
    } else {
        anyhow!("{repair_message}. {}", persistence_errors.join("; "))
    }
}

fn repair_failure_message(error: &str, snapshot: &npm_cli_repair::RepairSnapshot) -> String {
    let mut quarantine_paths = snapshot.quarantine_paths.clone();
    if let Some(path) = snapshot.planned_quarantine_path.as_ref() {
        if fs::symlink_metadata(path).is_ok() && !quarantine_paths.iter().any(|item| item == path) {
            quarantine_paths.push(path.clone());
        }
    }
    if quarantine_paths.is_empty() {
        return format!("{error}. No quarantine was created by this attempt");
    }
    let paths = quarantine_paths
        .iter()
        .map(|path| path.display().to_string())
        .collect::<Vec<_>>()
        .join(", ");
    format!("{error}. Quarantines preserved at {paths}")
}

fn current_managed_install(expected_version: &str) -> Result<Option<ManagedCliInstall>> {
    let requested_path = npm_cli_repair::managed_cli_path();
    if !is_executable(&requested_path) {
        return Ok(None);
    }
    let cli_path = canonical_cli_launch_path(&requested_path)?;
    let installed_version =
        read_installed_version_bounded(&cli_path, CLI_PREFLIGHT_VERSION_TIMEOUT)?;
    Ok(
        installed_cli_version_satisfies_latest(&installed_version, expected_version).then_some(
            ManagedCliInstall {
                cli_path,
                installed_version,
            },
        ),
    )
}

fn record_managed_install(
    state: &mut PersistedState,
    latest_version: &str,
    install: &ManagedCliInstall,
) {
    state.cli_path = Some(install.cli_path.clone());
    state.cli_install_channel = Some(CliInstallChannel::Npm);
    state.cli_installed_version = Some(install.installed_version.clone());
    state.cli_official_latest_version = Some(latest_version.to_string());
    state.cli_package_manager_latest_version = None;
    state.cli_status = CliStatus::UpToDate;
    state.cli_last_check_at = Some(Utc::now());
    state.cli_last_verified_at = Some(Utc::now());
    state.cli_error_message = None;
}

fn install_missing_cli(
    state: &mut PersistedState,
    paths: &RuntimePaths,
    baseline: &mut PersistedState,
    requested_path: Option<&Path>,
) -> Result<(PathBuf, bool)> {
    install_missing_cli_with_registry_timeout(
        state,
        paths,
        baseline,
        requested_path,
        NPM_REPAIR_REGISTRY_TIMEOUT,
    )
}

fn install_missing_cli_with_registry_timeout(
    state: &mut PersistedState,
    paths: &RuntimePaths,
    baseline: &mut PersistedState,
    requested_path: Option<&Path>,
    registry_timeout: StdDuration,
) -> Result<(PathBuf, bool)> {
    let install_lock = npm_cli_repair::acquire_install_lock(paths)?;
    state.reload_cli(&paths.state_file)?;
    *baseline = state.clone();
    let persisted_path = state.cli_path.clone();
    if let Some(path) =
        resolve_cli_path(requested_path).or_else(|| resolve_cli_path(persisted_path.as_deref()))
    {
        return Ok((path, false));
    }
    if npm_cli_repair::load(paths)?.is_some() {
        set_cli_repair_required(state);
        state.save_cli_status(&paths.state_file)?;
        *baseline = state.clone();
        anyhow::bail!(
            "Codex CLI installation is blocked by stale npm state. Run `codex-update-manager diagnose` for details and repair instructions."
        );
    }
    state.cli_status = CliStatus::Updating;
    persist_state(paths, state)?;
    *baseline = state.clone();

    let (npm, path_env) = npm_program()?;
    let latest_version = read_latest_version_with_npm_bounded(&npm, &path_env, registry_timeout)?;
    state.cli_official_latest_version = Some(latest_version.clone());
    state.cli_package_manager_latest_version = None;
    persist_state(paths, state)?;
    *baseline = state.clone();

    info!(
        latest_version,
        "Codex CLI is missing; attempting automatic installation"
    );
    let managed_install = match install_latest_cli_locked(
        &latest_version,
        state,
        paths,
        &install_lock,
    )? {
        CliUpdateOutcome::Updated(Some(install)) => install,
        CliUpdateOutcome::Updated(None) => {
            anyhow::bail!("Managed npm install did not return a Codex CLI path")
        }
        CliUpdateOutcome::RepairRequired => {
            set_cli_repair_required(state);
            state.save_cli_status(&paths.state_file)?;
            anyhow::bail!(
                "Codex CLI installation is blocked by stale npm state. Run `codex-update-manager diagnose` for details and repair instructions."
            );
        }
    };
    *baseline = state.clone();

    Ok((managed_install.cli_path, true))
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
    let npm = if npm.is_absolute() {
        npm
    } else {
        std::env::current_dir()
            .context("Failed to resolve the current directory for npm")?
            .join(npm)
    };
    canonical_cli_launch_path(&npm).context("npm executable is not usable")?;
    let toolchain_bin = npm
        .parent()
        .context("npm executable has no parent directory")?;
    canonical_cli_launch_path(&toolchain_bin.join("node"))
        .context("node executable beside npm is not usable")?;
    let fallback = command_path_env();
    let mut entries = vec![toolchain_bin.to_path_buf()];
    entries.extend(std::env::split_paths(&fallback).filter(|entry| entry != toolchain_bin));
    let path_env = std::env::join_paths(entries).unwrap_or(fallback);
    Ok((npm, path_env))
}

fn ensure_npm_command_success(npm: &Path, args: &[OsString], output: Output) -> Result<()> {
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
        state::{CliInstallChannel, CliStatus, PersistedState},
        test_util::{env_lock, EnvRestoreGuard},
    };
    use chrono::Utc;
    use std::{
        fs,
        os::fd::AsRawFd,
        os::unix::{fs::PermissionsExt, process::ExitStatusExt},
        path::Path,
    };
    use tempfile::tempdir;

    struct CurrentDirectoryGuard(PathBuf);

    impl CurrentDirectoryGuard {
        fn set(path: &Path) -> Result<Self> {
            let original = std::env::current_dir().context("current test directory")?;
            std::env::set_current_dir(path).context("set current test directory")?;
            Ok(Self(original))
        }
    }

    impl Drop for CurrentDirectoryGuard {
        fn drop(&mut self) {
            std::env::set_current_dir(&self.0).expect("restore current test directory");
        }
    }

    fn npm_enotempty_output(source: &Path, destination: &Path, legacy_prefix: bool) -> Output {
        let prefix = if legacy_prefix {
            "npm ERR!"
        } else {
            "npm error"
        };
        Output {
            status: ExitStatus::from_raw(217 << 8),
            stdout: Vec::new(),
            stderr: format!(
                "{prefix} code ENOTEMPTY\n{prefix} syscall rename\n{prefix} path {}\n{prefix} dest {}\n{prefix} errno -39\n",
                source.display(),
                destination.display()
            )
            .into_bytes(),
        }
    }

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

    fn secure_test_directory_tree(path: &Path) -> Result<()> {
        let metadata = fs::symlink_metadata(path)?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Ok(());
        }
        fs::set_permissions(path, fs::Permissions::from_mode(0o755))?;
        for entry in fs::read_dir(path)? {
            secure_test_directory_tree(&entry?.path())?;
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
            "HOMEBREW_PREFIX",
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
        std::env::remove_var("HOMEBREW_PREFIX");
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
    fn preflight_reports_homebrew_cli_update_without_running_npm_install() -> Result<()> {
        let _env_guard = env_lock();
        let temp = tempdir()?;
        let paths = test_runtime_paths(temp.path());
        paths.ensure_dirs()?;

        let home = temp.path().join("home");
        let tool_bin = temp.path().join("tool-bin");
        let brew_bin = home.join(".linuxbrew/bin");
        fs::create_dir_all(&home)?;
        fs::create_dir_all(&brew_bin)?;
        fs::create_dir_all(&tool_bin)?;

        let codex_path = brew_bin.join("codex");
        write_executable_script(
            &codex_path,
            "#!/bin/sh\nif [ \"$1\" = \"--version\" ] || [ \"$1\" = \"version\" ]; then\n  echo 'codex-cli v0.42.0'\n  exit 0\nfi\nexit 1\n",
        )?;

        let npm_install_log = temp.path().join("npm-install.log");
        write_fake_latest_npm(&tool_bin, "0.42.1", &npm_install_log)?;
        let _restore_env = configure_cli_test_env(&home, [tool_bin])?;

        let mut state = PersistedState::new(true);
        let outcome = preflight(&mut state, &paths, Some(codex_path.clone()), false)?;

        assert!(!outcome.updated);
        assert_eq!(outcome.cli_path, codex_path);
        assert_eq!(outcome.installed_version, "0.42.0");
        assert_eq!(outcome.official_latest_version.as_deref(), Some("0.42.1"));
        assert_eq!(outcome.package_manager_latest_version, None);
        assert_eq!(state.cli_status, CliStatus::UpdateRequired);
        let message = state
            .cli_error_message
            .as_deref()
            .expect("Homebrew CLI should set update guidance");
        assert!(message.contains("Homebrew"));
        assert!(message.contains("will not replace it with an npm-managed install"));
        assert!(!npm_install_log.exists());
        Ok(())
    }

    #[test]
    fn preflight_preserves_homebrew_channel_for_cached_canonical_path() -> Result<()> {
        let _env_guard = env_lock();
        let temp = tempdir()?;
        let paths = test_runtime_paths(temp.path());
        paths.ensure_dirs()?;

        let home = temp.path().join("home");
        let tool_bin = temp.path().join("tool-bin");
        let brew_prefix = temp.path().join("custom-homebrew");
        let brew_bin = brew_prefix.join("bin");
        let canonical_bin = temp
            .path()
            .join("canonical-brew-cellar/openai-codex/0.42.0/bin");
        fs::create_dir_all(&home)?;
        fs::create_dir_all(&brew_bin)?;
        fs::create_dir_all(&canonical_bin)?;
        fs::create_dir_all(&tool_bin)?;
        for directory in [
            temp.path(),
            home.as_path(),
            brew_prefix.as_path(),
            brew_bin.as_path(),
            canonical_bin.as_path(),
            tool_bin.as_path(),
        ] {
            fs::set_permissions(directory, fs::Permissions::from_mode(0o755))?;
        }

        let canonical_codex = canonical_bin.join("codex");
        write_executable_script(
            &canonical_codex,
            "#!/bin/sh\nif [ \"$1\" = \"--version\" ] || [ \"$1\" = \"version\" ]; then\n  echo 'codex-cli v0.42.0'\n  exit 0\nfi\nexit 1\n",
        )?;
        let visible_codex = brew_bin.join("codex");
        std::os::unix::fs::symlink(&canonical_codex, &visible_codex)?;

        let npm_install_log = temp.path().join("npm-install.log");
        write_fake_latest_npm(&tool_bin, "0.42.1", &npm_install_log)?;
        let _restore_env = configure_cli_test_env(&home, [tool_bin.clone()])?;
        std::env::set_var("HOMEBREW_PREFIX", &brew_prefix);

        let mut state = PersistedState::new(true);
        let first = preflight(&mut state, &paths, Some(visible_codex.clone()), false)?;

        assert_eq!(first.cli_path, canonical_codex);
        assert_eq!(state.cli_install_channel, Some(CliInstallChannel::Homebrew));
        assert!(!npm_install_log.exists());

        std::env::remove_var("HOMEBREW_PREFIX");
        state.cli_last_check_at = None;
        let cached_cli_path = state.cli_path.clone();
        let second = preflight(&mut state, &paths, cached_cli_path, false)?;

        assert!(!second.updated);
        assert_eq!(state.cli_status, CliStatus::UpdateRequired);
        assert_eq!(state.cli_install_channel, Some(CliInstallChannel::Homebrew));
        assert!(state
            .cli_error_message
            .as_deref()
            .unwrap_or_default()
            .contains("will not replace it with an npm-managed install"));
        assert!(!npm_install_log.exists());
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
    fn group_writable_standalone_cli_is_accepted_by_preflight() -> Result<()> {
        let _env_guard = env_lock();
        let temp = tempdir()?;
        let paths = test_runtime_paths(temp.path());
        paths.ensure_dirs()?;

        let home = temp.path().join("home");
        let install_dir = home.join(".local/bin");
        let codex_home = home.join(".codex");

        let initial_release =
            write_standalone_codex_release(&codex_home, "0.42.0", "x86_64-unknown-linux-musl")?;
        let probe_marker = temp.path().join("group-writable-cli-executed");
        let cli = initial_release.join("bin/codex");
        write_executable_script(
            &cli,
            &format!(
                "#!/bin/sh\n: > '{}'\necho 'codex-cli v0.42.0'\n",
                probe_marker.display()
            ),
        )?;
        let mut permissions = fs::metadata(&cli)?.permissions();
        permissions.set_mode(0o775);
        fs::set_permissions(&cli, permissions)?;

        let visible_codex = link_standalone_cli(&codex_home, &install_dir, &initial_release)?;
        let _restore_env = configure_cli_test_env(&home, [install_dir])?;

        let mut state = PersistedState::new(true);
        state.cli_path = Some(visible_codex.clone());
        state.cli_installed_version = Some("0.42.0".to_string());
        state.cli_official_latest_version = Some("0.42.0".to_string());
        state.cli_last_check_at = Some(Utc::now());

        let outcome = preflight(&mut state, &paths, Some(visible_codex), false)?;

        assert_eq!(outcome.installed_version, "0.42.0");
        assert_eq!(state.cli_status, CliStatus::UpToDate);
        assert!(probe_marker.exists());
        Ok(())
    }

    #[test]
    fn existing_standalone_tree_does_not_reclassify_an_external_cli() -> Result<()> {
        let _env_guard = env_lock();
        let temp = tempdir()?;
        let home = temp.path().join("home");
        fs::create_dir_all(home.join(".codex/packages/standalone"))?;
        let external_cli = temp.path().join("npm/bin/codex");
        fs::create_dir_all(
            external_cli
                .parent()
                .context("external CLI has no parent")?,
        )?;
        write_executable_script(&external_cli, "#!/bin/sh\necho 'codex-cli v0.42.0'\n")?;

        let _restore_env = EnvRestoreGuard::capture(&["HOME"]);
        std::env::set_var("HOME", &home);

        assert_eq!(
            classify_cli_install(&external_cli, &external_cli, None, None),
            CliInstallKind::Npm
        );
        Ok(())
    }

    #[test]
    fn group_writable_standalone_cli_ancestor_is_accepted_by_preflight() -> Result<()> {
        let _env_guard = env_lock();
        let temp = tempdir()?;
        let paths = test_runtime_paths(temp.path());
        paths.ensure_dirs()?;

        let home = temp.path().join("home");
        let install_dir = home.join(".local/bin");
        let codex_home = home.join(".codex");
        let initial_release =
            write_standalone_codex_release(&codex_home, "0.42.0", "x86_64-unknown-linux-musl")?;
        let execution_marker = temp.path().join("group-writable-ancestor-cli-executed");
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
        state.cli_installed_version = Some("0.42.0".to_string());
        state.cli_official_latest_version = Some("0.42.0".to_string());
        state.cli_last_check_at = Some(Utc::now());

        let outcome = preflight(&mut state, &paths, Some(visible_codex), false)?;

        assert_eq!(outcome.installed_version, "0.42.0");
        assert_eq!(state.cli_status, CliStatus::UpToDate);
        assert!(execution_marker.exists());
        Ok(())
    }

    #[test]
    fn canonical_cli_launch_path_follows_visible_symlink_replacement() -> Result<()> {
        let _env_guard = env_lock();
        let temp = tempdir()?;
        fs::set_permissions(temp.path(), fs::Permissions::from_mode(0o755))?;
        let home = temp.path().join("home");
        let install_dir = home.join(".local/bin");
        let codex_home = home.join(".codex");
        let release = write_standalone_codex_release(&codex_home, "0.42.0", "test-target")?;
        let visible_codex = link_standalone_cli(&codex_home, &install_dir, &release)?;
        let launch_path = canonical_cli_launch_path(&visible_codex)?;
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

        let replacement_launch_path = canonical_cli_launch_path(&visible_codex)?;
        assert_eq!(replacement_launch_path, fs::canonicalize(&replacement)?);
        assert_eq!(read_installed_version(&replacement_launch_path)?, "9.9.9");
        assert!(replacement_marker.exists());
        Ok(())
    }

    #[test]
    fn canonical_cli_launch_path_accepts_external_standalone_current_symlink() -> Result<()> {
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

        let launch_path = canonical_cli_launch_path(&visible_codex)?;
        assert_eq!(launch_path, fs::canonicalize(external_dir.join("codex"))?);
        assert_eq!(read_installed_version(&launch_path)?, "9.9.9");
        assert!(external_marker.exists());
        Ok(())
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
    fn dedicated_npm_prefix_hardens_existing_owned_directory() -> Result<()> {
        let temp = tempdir()?;
        fs::set_permissions(temp.path(), fs::Permissions::from_mode(0o755))?;
        let prefix = temp.path().join(".codex-cli-npm");
        fs::create_dir(&prefix)?;
        fs::set_permissions(&prefix, fs::Permissions::from_mode(0o775))?;

        prepare_safe_npm_prefix(&prefix)?;

        assert_eq!(fs::metadata(prefix)?.permissions().mode() & 0o777, 0o755);
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
    fn standalone_recovery_under_umask_0002_produces_an_executable_launch_target() -> Result<()> {
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
        assert_eq!(
            canonical_cli_launch_path(&install_dir.join("codex"))?,
            fs::canonicalize(release_dir.join("bin/codex"))?
        );
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
    fn standalone_update_allows_group_writable_install_directory() -> Result<()> {
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

        update_standalone_cli_with_umask_override(
            &StandaloneCliInstall {
                codex_home,
                install_dir: Some(install_dir),
            },
            "0.42.1",
            0o002,
        )
        .expect_err("the failing test downloader must still report its download error");
        assert!(
            curl_call_log.exists(),
            "installer download should start even when the visible-command directory is group-writable"
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
    fn refresh_status_accepts_group_writable_standalone_cli() -> Result<()> {
        let _env_guard = env_lock();
        let temp = tempdir()?;
        let paths = test_runtime_paths(temp.path());
        paths.ensure_dirs()?;

        let home = temp.path().join("home");
        let install_dir = home.join(".local/bin");
        let codex_home = home.join(".codex");
        let initial_release =
            write_standalone_codex_release(&codex_home, "0.42.0", "x86_64-unknown-linux-musl")?;
        let probe_marker = temp.path().join("refresh-executed-group-writable-cli");
        let cli = initial_release.join("bin/codex");
        write_executable_script(
            &cli,
            &format!(
                "#!/bin/sh\n: > '{}'\necho 'codex-cli v0.42.0'\n",
                probe_marker.display()
            ),
        )?;
        let mut permissions = fs::metadata(&cli)?.permissions();
        permissions.set_mode(0o775);
        fs::set_permissions(&cli, permissions)?;
        let visible_codex = link_standalone_cli(&codex_home, &install_dir, &initial_release)?;
        let _restore_env = configure_cli_test_env(&home, [install_dir])?;

        let mut state = PersistedState::new(true);
        state.cli_path = Some(visible_codex);
        refresh_status(&mut state, &paths)?;

        assert_eq!(state.cli_status, CliStatus::Unknown);
        assert_eq!(state.cli_installed_version.as_deref(), Some("0.42.0"));
        assert!(probe_marker.exists());
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

        let visible_launch_path = canonical_cli_launch_path(&visible_codex)?;
        assert_eq!(
            classify_cli_install(&visible_codex, &visible_launch_path, None, None),
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
    fn pending_explicit_repair_blocks_optional_dependency_npm_mutation() -> Result<()> {
        let _env_guard = env_lock();
        let temp = tempdir()?;
        let paths = test_runtime_paths(temp.path());
        paths.ensure_dirs()?;
        let prefix = temp.path().join("npm-prefix");
        let fixture = write_npm_cli_install(
            &prefix,
            "#!/bin/sh\necho 'Missing optional dependency @openai/codex-linux-x64. Reinstall Codex: npm install -g @openai/codex' >&2\nexit 1\n",
        )?;
        let npm_log = temp.path().join("npm.log");
        write_executable_script(
            &fixture.npm_program,
            "#!/bin/sh\necho called > \"$NPM_LOG\"\nexit 0\n",
        )?;
        let _restore_env = configure_cli_test_env(temp.path(), [prefix.join("bin")])?;
        std::env::set_var("NPM_LOG", &npm_log);
        npm_cli_repair::write_detected_for_test(&paths, ".codex-cqYkmGXr")?;

        let mut state = PersistedState::new(true);
        let error = preflight(&mut state, &paths, Some(fixture.visible_cli), false)
            .expect_err("pending explicit repair must block automatic npm mutation");

        assert!(error.to_string().contains("codex-update-manager diagnose"));
        assert_eq!(state.cli_status, CliStatus::UpdateRequired);
        assert!(!npm_log.exists());
        assert!(npm_cli_repair::load(&paths)?.is_some());
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
        let error = repair_npm_optional_dependency_with_timeout(
            &install,
            StdDuration::from_millis(100),
            None,
        )
        .expect_err("a hanging npm repair must time out");

        assert!(error.to_string().contains("timed out"));
        assert!(started.elapsed() < StdDuration::from_secs(3));
        assert!(child_pid.exists(), "the nested npm child must have started");
        assert_eq!(fs::read_to_string(child_marker)?, "terminated");
        Ok(())
    }

    #[test]
    fn npm_supervisor_owns_timeout_and_process_group_cleanup() -> Result<()> {
        let _env_guard = env_lock();
        let temp = tempdir()?;
        let npm_program = temp.path().join("npm");
        let child_marker = temp.path().join("child-terminated");
        write_executable_script(
            &npm_program,
            r#"#!/bin/sh
sh -c 'trap '\''printf terminated > "$NPM_CHILD_MARKER"; exit 0'\'' TERM; while :; do sleep 1; done' &
wait
"#,
        )?;
        let _restore_env = EnvRestoreGuard::capture(&["NPM_CHILD_MARKER"]);
        std::env::set_var("NPM_CHILD_MARKER", &child_marker);
        let install_lock = fs::File::create(temp.path().join("install.lock"))?;

        let started = Instant::now();
        let error = run_npm_supervisor(
            current_parent_pid(),
            100,
            install_lock.as_raw_fd(),
            &npm_program,
            &[OsString::from("install")],
        )
        .expect_err("the npm supervisor must enforce its own timeout");

        assert!(error.to_string().contains("timed out"));
        assert!(started.elapsed() < StdDuration::from_secs(3));
        assert_eq!(fs::read_to_string(child_marker)?, "terminated");
        Ok(())
    }

    #[test]
    fn npm_supervisor_rejects_a_stale_owner_before_spawning() -> Result<()> {
        let _env_guard = env_lock();
        let temp = tempdir()?;
        let npm_program = temp.path().join("npm");
        let started = temp.path().join("started");
        write_executable_script(
            &npm_program,
            "#!/bin/sh\nprintf started > \"$NPM_STARTED\"\n",
        )?;
        let _restore_env = EnvRestoreGuard::capture(&["NPM_STARTED"]);
        std::env::set_var("NPM_STARTED", &started);
        let install_lock = fs::File::create(temp.path().join("install.lock"))?;

        let error = run_npm_supervisor(
            u32::MAX,
            100,
            install_lock.as_raw_fd(),
            &npm_program,
            &[OsString::from("install")],
        )
        .expect_err("a supervisor with a stale owner must not start npm");

        assert!(error.to_string().contains("owner exited"));
        assert!(!started.exists());
        Ok(())
    }

    #[test]
    fn npm_supervisor_keeps_the_install_lock_out_of_npm() -> Result<()> {
        let _env_guard = env_lock();
        let temp = tempdir()?;
        let npm_program = temp.path().join("npm");
        let inherited_marker = temp.path().join("lock-inherited");
        write_executable_script(
            &npm_program,
            "#!/bin/sh\nif [ -e \"/proc/self/fd/$NPM_INSTALL_LOCK_FD\" ]; then\n  printf inherited > \"$NPM_LOCK_INHERITED_MARKER\"\n  exit 88\nfi\nexit 0\n",
        )?;
        let install_lock = fs::File::create(temp.path().join("install.lock"))?;
        let initial_flags = unsafe { libc::fcntl(install_lock.as_raw_fd(), libc::F_GETFD) };
        anyhow::ensure!(
            initial_flags != -1,
            "failed to inspect the test install lock descriptor"
        );
        anyhow::ensure!(
            unsafe {
                libc::fcntl(
                    install_lock.as_raw_fd(),
                    libc::F_SETFD,
                    initial_flags & !libc::FD_CLOEXEC,
                )
            } != -1,
            "failed to make the test install lock descriptor inheritable"
        );
        let _restore_env =
            EnvRestoreGuard::capture(&["NPM_INSTALL_LOCK_FD", "NPM_LOCK_INHERITED_MARKER"]);
        std::env::set_var("NPM_INSTALL_LOCK_FD", install_lock.as_raw_fd().to_string());
        std::env::set_var("NPM_LOCK_INHERITED_MARKER", &inherited_marker);

        run_npm_supervisor(
            current_parent_pid(),
            1_000,
            install_lock.as_raw_fd(),
            &npm_program,
            &[OsString::from("install")],
        )?;

        assert!(!inherited_marker.exists());
        let final_flags = unsafe { libc::fcntl(install_lock.as_raw_fd(), libc::F_GETFD) };
        anyhow::ensure!(
            final_flags != -1,
            "failed to re-inspect the test install lock descriptor"
        );
        assert_ne!(final_flags & libc::FD_CLOEXEC, 0);
        Ok(())
    }

    #[test]
    fn npm_program_absolutizes_a_relative_path_entry_without_resolving_symlinks() -> Result<()> {
        let _env_guard = env_lock();
        let temp = tempdir()?;
        let path_bin = temp.path().join("path-bin");
        fs::create_dir_all(&path_bin)?;
        let real_bin = temp.path().join("real-bin");
        fs::create_dir_all(&real_bin)?;
        write_executable_script(&real_bin.join("npm"), "#!/bin/sh\nexit 0\n")?;
        write_executable_script(&real_bin.join("node"), "#!/bin/sh\nexit 0\n")?;
        std::os::unix::fs::symlink(real_bin.join("npm"), path_bin.join("npm"))?;
        std::os::unix::fs::symlink(real_bin.join("node"), path_bin.join("node"))?;
        let _current_directory = CurrentDirectoryGuard::set(temp.path())?;
        let _restore_env = EnvRestoreGuard::capture(&[
            "HOME",
            "PATH",
            "NVM_DIR",
            "XDG_DATA_HOME",
            "FNM_DIR",
            "FNM_MULTISHELL_PATH",
        ]);
        std::env::set_var("HOME", temp.path());
        std::env::set_var("PATH", std::env::join_paths([PathBuf::from("path-bin")])?);
        std::env::remove_var("NVM_DIR");
        std::env::remove_var("XDG_DATA_HOME");
        std::env::remove_var("FNM_DIR");
        std::env::remove_var("FNM_MULTISHELL_PATH");

        assert_eq!(npm_program()?.0, path_bin.join("npm"));
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
    fn pending_repair_blocks_missing_cli_registry_and_install_transitions() -> Result<()> {
        let _env_guard = env_lock();
        let temp = tempdir()?;
        let paths = test_runtime_paths(temp.path());
        paths.ensure_dirs()?;

        let bin_dir = temp.path().join("bin");
        let npm_log = temp.path().join("npm.log");
        fs::create_dir_all(&bin_dir)?;
        write_executable_script(
            &bin_dir.join("npm"),
            &format!(
                "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"{}\"\nexit 42\n",
                npm_log.display()
            ),
        )?;
        let _restore_env = configure_cli_test_env(temp.path(), [bin_dir])?;
        npm_cli_repair::write_detected_for_test(&paths, ".codex-cqYkmGXr")?;

        let winner_path = temp.path().join("winner/codex");
        let mut winner = PersistedState::new(true);
        winner.cli_path = Some(winner_path.clone());
        winner.cli_installed_version = Some("0.42.1".to_string());
        winner.remote_headers_fingerprint = Some("must-survive-pending-repair".to_string());
        winner.save(&paths.state_file)?;

        let mut state = PersistedState::new(true);
        state.cli_path = Some(temp.path().join("stale/codex"));
        state.cli_installed_version = Some("0.42.0".to_string());
        preflight(&mut state, &paths, None, true)
            .expect_err("pending repair must block a missing CLI installation");

        assert!(!npm_log.exists());
        assert_eq!(state.cli_status, CliStatus::UpdateRequired);
        assert_eq!(state.cli_path.as_deref(), Some(winner_path.as_path()));
        assert_eq!(state.cli_installed_version.as_deref(), Some("0.42.1"));
        assert!(state
            .cli_error_message
            .as_deref()
            .is_some_and(|message| message.contains("codex-update-manager diagnose")));
        let persisted = PersistedState::load_or_default(&paths.state_file, true)?;
        assert_eq!(persisted.cli_status, CliStatus::UpdateRequired);
        assert_eq!(persisted.cli_path.as_deref(), Some(winner_path.as_path()));
        assert_eq!(persisted.cli_installed_version.as_deref(), Some("0.42.1"));
        assert_eq!(
            persisted.remote_headers_fingerprint.as_deref(),
            Some("must-survive-pending-repair")
        );
        assert_eq!(persisted.cli_error_message, state.cli_error_message);
        Ok(())
    }

    #[test]
    fn pending_repair_during_cli_update_preserves_newer_cli_identity() -> Result<()> {
        let _env_guard = env_lock();
        let temp = tempdir()?;
        let paths = test_runtime_paths(temp.path());
        paths.ensure_dirs()?;

        let bin_dir = temp.path().join("bin");
        let npm_log = temp.path().join("npm.log");
        fs::create_dir_all(&bin_dir)?;
        write_executable_script(
            &bin_dir.join("npm"),
            &format!(
                "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"{}\"\nexit 42\n",
                npm_log.display()
            ),
        )?;
        let _restore_env = configure_cli_test_env(temp.path(), [bin_dir])?;
        npm_cli_repair::write_detected_for_test(&paths, ".codex-cqYkmGXr")?;

        let winner_path = temp.path().join("winner/codex");
        let mut winner = PersistedState::new(true);
        winner.cli_path = Some(winner_path.clone());
        winner.cli_installed_version = Some("0.42.1".to_string());
        winner.remote_headers_fingerprint = Some("must-survive-update-repair".to_string());
        winner.save(&paths.state_file)?;

        let mut state = PersistedState::new(true);
        state.cli_path = Some(temp.path().join("stale/codex"));
        state.cli_installed_version = Some("0.42.0".to_string());
        let outcome = install_latest_cli("0.42.1", &mut state, &paths)?;

        assert!(matches!(outcome, CliUpdateOutcome::RepairRequired));
        assert!(!npm_log.exists());
        assert_eq!(state.cli_status, CliStatus::UpdateRequired);
        assert_eq!(state.cli_path.as_deref(), Some(winner_path.as_path()));
        assert_eq!(state.cli_installed_version.as_deref(), Some("0.42.1"));
        let persisted = PersistedState::load_or_default(&paths.state_file, true)?;
        assert_eq!(persisted.cli_path.as_deref(), Some(winner_path.as_path()));
        assert_eq!(persisted.cli_installed_version.as_deref(), Some("0.42.1"));
        assert_eq!(
            persisted.remote_headers_fingerprint.as_deref(),
            Some("must-survive-update-repair")
        );
        Ok(())
    }

    #[test]
    fn missing_cli_registry_timeout_releases_the_install_lock() -> Result<()> {
        let _env_guard = env_lock();
        let temp = tempdir()?;
        let paths = test_runtime_paths(temp.path());
        paths.ensure_dirs()?;

        let bin_dir = temp.path().join("bin");
        fs::create_dir_all(&bin_dir)?;
        write_executable_script(
            &bin_dir.join("npm"),
            "#!/bin/sh\nif [ \"$1\" = \"view\" ]; then\n  while :; do sleep 1; done\nfi\nexit 42\n",
        )?;
        let _restore_env = configure_cli_test_env(temp.path(), [bin_dir])?;

        let mut state = PersistedState::new(true);
        let mut baseline = state.clone();
        let started = Instant::now();
        let error = install_missing_cli_with_registry_timeout(
            &mut state,
            &paths,
            &mut baseline,
            None,
            StdDuration::from_millis(100),
        )
        .expect_err("a hanging missing-CLI registry lookup must time out");

        assert!(error.to_string().contains("timed out"));
        assert!(started.elapsed() < StdDuration::from_secs(3));
        let _lock = npm_cli_repair::acquire_install_lock(&paths)?;
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
        let managed_codex_path = temp.path().join(".codex-cli-npm/bin/codex");
        fs::create_dir_all(
            managed_codex_path
                .parent()
                .context("managed CLI should have a parent")?,
        )?;
        write_executable_script(
            &bin_dir.join("npm"),
            "#!/bin/sh\nif [ \"$1\" = \"view\" ]; then\n  echo '0.42.1'\n  exit 0\nfi\nif [ \"$1\" = \"install\" ]; then\n  printf '%s\\n' '#!/bin/sh' \"echo 'version probe failed' >&2\" 'exit 43' > \"$FAKE_CODEX_PATH\"\n  /bin/chmod 0755 \"$FAKE_CODEX_PATH\"\n  exit 0\nfi\nexit 1\n",
        )?;

        let _restore_env = configure_cli_test_env(temp.path(), [bin_dir])?;
        std::env::set_var("FAKE_CODEX_PATH", &managed_codex_path);

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
        let _restore_env = EnvRestoreGuard::capture(&[
            "HOME",
            "PATH",
            "NVM_DIR",
            "XDG_DATA_HOME",
            "FNM_DIR",
            "FNM_MULTISHELL_PATH",
            "FAKE_CODEX_PATH",
        ]);
        let temp = tempdir()?;
        let paths = test_runtime_paths(temp.path());
        paths.ensure_dirs()?;

        let bin_dir = temp.path().join("bin");
        fs::create_dir_all(&bin_dir)?;

        let codex_path = bin_dir.join("codex");
        let managed_codex_path = temp.path().join(".codex-cli-npm/bin/codex");
        fs::create_dir_all(
            managed_codex_path
                .parent()
                .context("managed CLI should have a parent")?,
        )?;
        write_executable_script(
            &codex_path,
            "#!/bin/sh\nif [ \"$1\" = \"--version\" ] || [ \"$1\" = \"version\" ]; then\n  echo 'codex-cli v0.42.0'\n  exit 0\nfi\nexit 1\n",
        )?;

        let npm_path = bin_dir.join("npm");
        write_executable_script(
            &npm_path,
            "#!/bin/sh\nif [ \"$1\" = \"view\" ] && [ \"$2\" = \"@openai/codex\" ] && [ \"$3\" = \"version\" ]; then\n  echo '0.42.1'\n  exit 0\nfi\nif [ \"$1\" = \"install\" ] && [ \"$2\" = \"-g\" ] && [ \"$3\" = \"--include=optional\" ]; then\n  printf '%s\\n' '#!/bin/sh' 'if [ \"$1\" = \"--version\" ] || [ \"$1\" = \"version\" ]; then' \"  echo 'codex-cli v0.42.1'\" '  exit 0' 'fi' 'exit 1' > \"$FAKE_CODEX_PATH\"\n  /bin/chmod 0755 \"$FAKE_CODEX_PATH\"\n  exit 0\nfi\nexit 1\n",
        )?;

        std::env::set_var("HOME", temp.path());
        std::env::set_var("PATH", std::env::join_paths([bin_dir.clone()])?);
        std::env::remove_var("NVM_DIR");
        std::env::remove_var("XDG_DATA_HOME");
        std::env::remove_var("FNM_DIR");
        std::env::remove_var("FNM_MULTISHELL_PATH");
        std::env::set_var("FAKE_CODEX_PATH", &managed_codex_path);

        assert_eq!(npm_program()?.0, npm_path);

        let mut state = PersistedState::new(true);
        state.cli_path = Some(codex_path.clone());

        assert_eq!(
            classify_cli_install(&codex_path, &codex_path, None, None),
            CliInstallKind::Npm
        );

        let updated = reconcile_if_present(&mut state, &paths)?;

        assert!(updated);
        assert_eq!(
            state.cli_path.as_deref(),
            Some(managed_codex_path.as_path())
        );
        assert_eq!(state.cli_installed_version.as_deref(), Some("0.42.1"));
        assert_eq!(state.cli_official_latest_version.as_deref(), Some("0.42.1"));
        assert_eq!(state.cli_package_manager_latest_version, None);
        assert_eq!(state.cli_status, CliStatus::UpToDate);
        assert_eq!(read_installed_version(&managed_codex_path)?, "0.42.1");
        Ok(())
    }

    #[test]
    fn reconcile_if_present_detects_stale_npm_without_mutating_it() -> Result<()> {
        let _env_guard = env_lock();
        let _restore_env = EnvRestoreGuard::capture(&[
            "HOME",
            "PATH",
            "NVM_DIR",
            "XDG_DATA_HOME",
            "FNM_DIR",
            "FNM_MULTISHELL_PATH",
            "CODEX_CLI_PATH",
            "CODEX_UPDATE_MANAGER_SKIP_SYSTEM_CLI_LOOKUP",
            "FAKE_CODEX_PATH",
            "NPM_ACTIVE_PACKAGE",
            "NPM_INSTALL_RESULT",
            "NPM_INSTALL_LOG",
            "NPM_MANAGED_CLI",
            "NPM_MANAGED_CLI_DIR",
            "NPM_RETIREMENT_PATH",
            "NPM_VIEW_RESULT",
        ]);
        let temp = tempdir()?;
        let paths = test_runtime_paths(temp.path());
        paths.ensure_dirs()?;

        let home = temp.path().join("home");
        let bin_dir = temp.path().join("bin");
        let local_prefix = home.join(".codex-cli-npm");
        let managed_bin = local_prefix.join("bin");
        let active_package = local_prefix.join("lib/node_modules/@openai/codex");
        let retirement_path = local_prefix
            .join("lib/node_modules/@openai")
            .join(".codex-cqYkmGXr");
        let install_log = temp.path().join("npm-install.log");
        fs::create_dir_all(&active_package)?;
        fs::write(active_package.join("package.json"), "{}\n")?;
        fs::create_dir_all(&retirement_path)?;
        fs::write(retirement_path.join("package.json"), "{}\n")?;
        secure_test_directory_tree(&local_prefix)?;
        fs::create_dir_all(&bin_dir)?;
        fs::create_dir_all(&managed_bin)?;

        let codex_path = managed_bin.join("codex");
        write_executable_script(
            &codex_path,
            "#!/bin/sh\nif [ \"$1\" = \"--version\" ] || [ \"$1\" = \"version\" ]; then\n  echo 'codex-cli v0.42.0'\n  exit 0\nfi\nexit 1\n",
        )?;
        let npm_path = bin_dir.join("npm");
        write_executable_script(
            &npm_path,
            r#"#!/bin/sh
if [ "$1" = "view" ] && [ "$2" = "@openai/codex" ] && [ "$3" = "version" ]; then
  echo '0.42.1'
  exit 0
fi
if [ "$1" = "install" ] && [ "$2" = "-g" ] && [ "$3" = "--include=optional" ]; then
  printf 'attempt\n' >> "$NPM_INSTALL_LOG"
  if [ -d "$NPM_RETIREMENT_PATH" ]; then
    printf '%s\n' \
      'npm error code ENOTEMPTY' \
      'npm error syscall rename' \
      "npm error path $NPM_ACTIVE_PACKAGE" \
      "npm error dest $NPM_RETIREMENT_PATH" \
      'npm error errno -39' \
      "npm error ENOTEMPTY: directory not empty, rename '$NPM_ACTIVE_PACKAGE' -> '$NPM_RETIREMENT_PATH'" >&2
    exit 217
  fi
  printf '%s\n' '#!/bin/sh' 'if [ "$1" = "--version" ] || [ "$1" = "version" ]; then' "  echo 'codex-cli v0.42.1'" '  exit 0' 'fi' 'exit 1' > "$FAKE_CODEX_PATH"
  exit 0
fi
exit 1
"#,
        )?;

        std::env::set_var("HOME", &home);
        std::env::set_var("PATH", std::env::join_paths([bin_dir, managed_bin])?);
        std::env::remove_var("NVM_DIR");
        std::env::remove_var("XDG_DATA_HOME");
        std::env::remove_var("FNM_DIR");
        std::env::remove_var("FNM_MULTISHELL_PATH");
        std::env::remove_var("CODEX_CLI_PATH");
        std::env::set_var("CODEX_UPDATE_MANAGER_SKIP_SYSTEM_CLI_LOOKUP", "1");
        std::env::set_var("FAKE_CODEX_PATH", &codex_path);
        std::env::set_var("NPM_ACTIVE_PACKAGE", &active_package);
        std::env::set_var("NPM_INSTALL_LOG", &install_log);
        std::env::set_var("NPM_RETIREMENT_PATH", &retirement_path);

        let mut state = PersistedState::new(true);
        state.cli_path = Some(codex_path.clone());

        let updated = reconcile_if_present(&mut state, &paths)?;

        assert!(!updated);
        assert_eq!(state.cli_status, CliStatus::UpdateRequired);
        assert_eq!(state.cli_installed_version.as_deref(), Some("0.42.0"));
        assert_eq!(fs::read_to_string(&install_log)?, "attempt\n");
        assert!(retirement_path.exists());
        assert!(state
            .cli_error_message
            .as_deref()
            .is_some_and(|message| message.contains("codex-update-manager diagnose")));

        let updated = reconcile_if_present(&mut state, &paths)?;
        assert!(!updated);
        assert_eq!(fs::read_to_string(&install_log)?, "attempt\n");
        assert!(retirement_path.exists());

        let outcome = repair_cli(&mut state, &paths)?;
        assert_eq!(outcome.installed_version, "0.42.1");
        assert_eq!(outcome.quarantine_paths.len(), 1);
        assert!(outcome.quarantine_paths[0].exists());
        assert!(!retirement_path.exists());
        assert_eq!(fs::read_to_string(&install_log)?, "attempt\nattempt\n");
        assert_eq!(state.cli_status, CliStatus::UpToDate);
        assert!(npm_cli_repair::load(&paths)?.is_none());
        Ok(())
    }

    #[test]
    fn explicit_repair_runs_npm_once_and_preserves_failed_quarantine() -> Result<()> {
        let _env_guard = env_lock();
        let _restore_env = EnvRestoreGuard::capture(&[
            "HOME",
            "PATH",
            "NVM_DIR",
            "XDG_DATA_HOME",
            "FNM_DIR",
            "FNM_MULTISHELL_PATH",
            "CODEX_CLI_PATH",
            "CODEX_UPDATE_MANAGER_SKIP_SYSTEM_CLI_LOOKUP",
            "NPM_ACTIVE_PACKAGE",
            "NPM_INSTALL_RESULT",
            "NPM_INSTALL_LOG",
            "NPM_MANAGED_CLI",
            "NPM_MANAGED_CLI_DIR",
            "NPM_RETIREMENT_PATH",
        ]);
        let temp = tempdir()?;
        let paths = test_runtime_paths(temp.path());
        paths.ensure_dirs()?;
        let home = temp.path().join("home");
        let bin_dir = temp.path().join("bin");
        let prefix = home.join(".codex-cli-npm");
        let source = prefix.join("lib/node_modules/@openai/codex");
        let destination = prefix
            .join("lib/node_modules/@openai")
            .join(".codex-cqYkmGXr");
        let managed_cli = prefix.join("bin/codex");
        let install_log = temp.path().join("npm-install.log");
        fs::create_dir_all(&source)?;
        fs::create_dir_all(&destination)?;
        secure_test_directory_tree(&prefix)?;
        fs::set_permissions(&home, fs::Permissions::from_mode(0o755))?;
        fs::create_dir_all(&bin_dir)?;
        write_executable_script(
            &bin_dir.join("npm"),
            r#"#!/bin/sh
if [ "$1" = "view" ]; then
  if [ "${NPM_VIEW_RESULT:-success}" = "failure" ]; then
    printf 'registry unavailable\n' >&2
    exit 43
  fi
  echo '0.42.1'
  exit 0
fi
if [ "$1" = "install" ]; then
  printf 'attempt\n' >> "$NPM_INSTALL_LOG"
  if [ "${NPM_INSTALL_RESULT:-failure}" = "invalid" ]; then
    /bin/mkdir -p "$NPM_MANAGED_CLI_DIR"
    printf '%s\n' '#!/bin/sh' 'exit 1' > "$NPM_MANAGED_CLI"
    /bin/chmod 755 "$NPM_MANAGED_CLI"
    exit 0
  fi
  /bin/mkdir -p "$NPM_RETIREMENT_PATH"
  printf 'retry failed\n' >&2
  exit 42
fi
exit 1
"#,
        )?;
        write_executable_script(&bin_dir.join("node"), "#!/bin/sh\nexit 0\n")?;

        std::env::set_var("HOME", &home);
        std::env::set_var("PATH", std::env::join_paths([bin_dir])?);
        std::env::remove_var("NVM_DIR");
        std::env::remove_var("XDG_DATA_HOME");
        std::env::remove_var("FNM_DIR");
        std::env::remove_var("FNM_MULTISHELL_PATH");
        std::env::remove_var("CODEX_CLI_PATH");
        std::env::set_var("CODEX_UPDATE_MANAGER_SKIP_SYSTEM_CLI_LOOKUP", "1");
        std::env::set_var("NPM_ACTIVE_PACKAGE", &source);
        std::env::set_var("NPM_INSTALL_LOG", &install_log);
        std::env::set_var("NPM_MANAGED_CLI", &managed_cli);
        std::env::set_var(
            "NPM_MANAGED_CLI_DIR",
            managed_cli.parent().context("managed CLI has no parent")?,
        );
        std::env::set_var("NPM_RETIREMENT_PATH", &destination);

        let mut state = PersistedState::new(true);
        state.save(&paths.state_file)?;
        npm_cli_repair::detect_and_persist(
            &paths,
            &prefix,
            &npm_enotempty_output(&source, &destination, false),
        )?
        .context("stale npm output should be detected")?;

        let error = repair_cli(&mut state, &paths).expect_err("the retry failure must be returned");

        assert!(format!("{error:#}").contains("retry failed"));
        assert!(format!("{error:#}").contains("Quarantines preserved"));
        assert_eq!(fs::read_to_string(&install_log)?, "attempt\n");
        assert!(destination.exists());
        let repair = npm_cli_repair::snapshot(&paths)?.context("repair should remain pending")?;
        assert_eq!(repair.quarantine_paths.len(), 1);
        assert!(repair.quarantine_paths[0].exists());
        assert!(repair
            .last_error
            .as_deref()
            .is_some_and(|message| message.contains("retry failed")));

        std::env::set_var("NPM_VIEW_RESULT", "failure");
        let error =
            repair_cli(&mut state, &paths).expect_err("the registry failure must be returned");

        assert!(format!("{error:#}").contains("registry unavailable"));
        assert!(format!("{error:#}").contains("Quarantines preserved"));
        assert_eq!(fs::read_to_string(&install_log)?, "attempt\n");
        assert!(destination.exists());
        let repair = npm_cli_repair::snapshot(&paths)?.context("repair should remain pending")?;
        assert_eq!(repair.quarantine_paths.len(), 1);
        assert!(repair
            .last_error
            .as_deref()
            .is_some_and(|message| message.contains("registry unavailable")));
        std::env::remove_var("NPM_VIEW_RESULT");

        repair_cli(&mut state, &paths).expect_err("the second retry failure must be returned");

        assert_eq!(fs::read_to_string(install_log)?, "attempt\nattempt\n");
        assert!(destination.exists());
        let repair = npm_cli_repair::snapshot(&paths)?.context("repair should remain pending")?;
        assert_eq!(repair.quarantine_paths.len(), 2);
        assert!(repair.quarantine_paths.iter().all(|path| path.exists()));

        std::env::set_var("NPM_INSTALL_RESULT", "invalid");
        let error =
            repair_cli(&mut state, &paths).expect_err("an invalid repaired CLI must be reported");

        assert!(format!("{error:#}").contains("could not be validated"));
        assert!(format!("{error:#}").contains("Quarantines preserved"));
        assert_eq!(state.cli_status, CliStatus::Failed);
        let repair = npm_cli_repair::snapshot(&paths)?.context("repair should remain pending")?;
        assert_eq!(repair.quarantine_paths.len(), 3);
        assert!(repair
            .last_error
            .as_deref()
            .is_some_and(|message| message.contains("could not be validated")));
        Ok(())
    }

    #[test]
    fn preflight_switches_system_cli_to_managed_prefix_after_upgrade() -> Result<()> {
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
        let managed_codex = home.join(".codex-cli-npm/bin/codex");
        fs::create_dir_all(
            managed_codex
                .parent()
                .context("managed CLI should have a parent")?,
        )?;
        write_executable_script(
            &npm_path,
            r#"#!/bin/sh
if [ "$1" = "view" ] && [ "$2" = "@openai/codex" ] && [ "$3" = "version" ]; then
  echo '0.42.1'
  exit 0
fi
if [ "$1" = "install" ] && [ "$2" = "-g" ] && [ "$3" = "--include=optional" ]; then
  printf '%s\n' '#!/bin/sh' 'echo "codex-cli v0.42.1"' > "$FAKE_CODEX_PATH"
  /bin/chmod 0755 "$FAKE_CODEX_PATH"
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
            "FAKE_CODEX_PATH",
        ]);
        std::env::set_var("HOME", &home);
        std::env::set_var("PATH", std::env::join_paths([npm_bin, system_bin])?);
        std::env::remove_var("NVM_DIR");
        std::env::remove_var("XDG_DATA_HOME");
        std::env::remove_var("FNM_DIR");
        std::env::remove_var("FNM_MULTISHELL_PATH");
        std::env::remove_var("CODEX_CLI_PATH");
        std::env::set_var("FAKE_CODEX_PATH", &managed_codex);

        let mut state = PersistedState::new(true);
        state.cli_path = Some(system_codex.clone());

        assert_eq!(
            resolve_cli_path_with_version(Some(&system_codex), "0.42.1"),
            Some((user_codex.clone(), "0.42.1".to_string()))
        );

        let outcome = preflight(&mut state, &paths, Some(system_codex.clone()), false)?;

        assert!(outcome.updated);
        assert_eq!(outcome.cli_path, managed_codex);
        assert_eq!(outcome.installed_version, "0.42.1");
        assert_eq!(state.cli_path.as_deref(), Some(managed_codex.as_path()));
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
