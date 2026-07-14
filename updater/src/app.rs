//! Application entrypoints and orchestration for the local updater daemon.

use crate::{
    builder, cache_cleanup,
    cli::{Cli, Commands},
    codex_cli,
    config::{RuntimeConfig, RuntimePaths},
    diagnostics, feature_picker, install, install_rollback, liveness, logging, notify, rollback,
    state::{CliStatus, PersistedState, UpdateStatus},
    upstream, wrapper, wrapper_apply,
};
use anyhow::{Context, Result};
use chrono::{Duration as ChronoDuration, Utc};
use serde::Deserialize;
use std::{
    ffi::OsString,
    fs::{self, OpenOptions},
    io::{Seek, SeekFrom, Write},
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Command,
};
use tokio::time::{self, Duration};
use tracing::{error, info, warn};

const RECONCILE_INTERVAL_SECONDS: u64 = 15;
const CLI_MISSING_NOTIFICATION_EVENT: &str = "cli_missing";
const CLI_MISSING_PROMPT_DISMISS_TTL: ChronoDuration = ChronoDuration::minutes(10);
const PROMPT_INSTALL_CLI_CANCELLED_EXIT_CODE: i32 = 10;
const PROMPT_INSTALL_CLI_NO_BACKEND_EXIT_CODE: i32 = 11;
const POLKIT_AUTH_AGENT_PROCESS_TOKENS: &[&str] = &[
    "budgie-polkit",
    "cinnamon-polkit",
    "cosmic-osd",
    "gnome-shell",
    "hyprpolkitagent",
    "io.elementary.desktop.agent-polkit",
    "lxpolkit",
    "lxqt-policykit-agent",
    "mate-polkit",
    "polkit-agent",
    "polkit-dde-agent",
    "polkit-gnome-authentication-agent",
    "polkit-kde-authentication-agent",
    "soteria",
    "ukui-polkit",
    "xfce-polkit",
];

/// Runs the updater command-line entrypoint.
pub async fn run(cli: Cli) -> Result<()> {
    let paths = RuntimePaths::detect()?;
    if let Commands::Diagnose { json } = &cli.command {
        return run_diagnose_command(&paths, *json).await;
    }

    paths.ensure_dirs()?;
    logging::init(&paths.log_file)?;

    let mut config = RuntimeConfig::load_or_default(&paths)?;
    if let Some(enabled) = crate::config::settings_wrapper_updates_override() {
        config.enable_wrapper_updates = enabled;
    }
    let mut state =
        PersistedState::load_or_default(&paths.state_file, effective_auto_install(&config))?;
    let original_state = state.clone();
    state.installed_version = install::installed_package_version();
    persist_if_changed(&paths, &state, &original_state)?;

    match cli.command {
        Commands::Daemon => run_daemon(&config, &mut state, &paths).await,
        Commands::CheckNow { if_stale } => {
            run_check_now(&config, &mut state, &paths, if_stale).await
        }
        Commands::CheckWrapper { json } => run_check_wrapper(&config, &mut state, &paths, json),
        Commands::ApplyWrapperUpdate => {
            wrapper_apply::run_apply_wrapper_update(&config, &mut state, &paths).await
        }
        Commands::PickFeatures { json } => feature_picker::run_pick_features(&config, &paths, json),
        Commands::CliPreflight {
            cli_path,
            print_path,
            allow_install_missing,
        } => run_cli_preflight(
            &mut state,
            &paths,
            cli_path,
            print_path,
            allow_install_missing,
        ),
        Commands::PromptInstallCli {
            cli_path,
            print_path,
        } => run_prompt_install_cli(&mut state, &paths, cli_path, print_path),
        Commands::Status { json } => run_status(&config, &mut state, &paths, json),
        Commands::Diagnose { .. } => unreachable!("diagnose is handled before runtime writes"),
        Commands::InstallReady => run_install_ready(&config, &mut state, &paths).await,
        Commands::Rollback => rollback::run(&config, &mut state, &paths).await,
        Commands::InstallDeb { path } => install::install_deb(&path),
        Commands::InstallRpm { path } => install::install_rpm(&path),
        Commands::InstallPacman { path } => install::install_pacman(&path),
        Commands::InstallRollbackDeb { path } => install_rollback::install_deb(&path),
        Commands::InstallRollbackRpm { path } => install_rollback::install_rpm(&path),
        Commands::InstallRollbackPacman { path } => install_rollback::install_pacman(&path),
    }
}

async fn run_diagnose_command(paths: &RuntimePaths, json: bool) -> Result<()> {
    let mut config = RuntimeConfig::load_or_default(paths)?;
    if let Some(enabled) = crate::config::settings_wrapper_updates_override() {
        config.enable_wrapper_updates = enabled;
    }
    let mut state =
        PersistedState::load_or_default(&paths.state_file, effective_auto_install(&config))?;
    state.installed_version = install::installed_package_version();
    diagnostics::run(&config, &state, paths, json).await
}

fn persist_state(paths: &RuntimePaths, state: &PersistedState) -> Result<()> {
    state.save(&paths.state_file)
}

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

fn effective_auto_install(config: &RuntimeConfig) -> bool {
    crate::config::settings_auto_install_override().unwrap_or(config.auto_install_on_app_exit)
}

fn sync_runtime_state(config: &RuntimeConfig, state: &mut PersistedState) {
    state.auto_install_on_app_exit = effective_auto_install(config);
    if state.status != UpdateStatus::WaitingForAppExit {
        state.waiting_for_app_exit_auto_install = false;
    }
    state.installed_version = install::installed_package_version();
}

fn sync_and_persist(
    config: &RuntimeConfig,
    state: &mut PersistedState,
    paths: &RuntimePaths,
) -> Result<()> {
    let original_state = state.clone();
    sync_runtime_state(config, state);
    persist_if_changed(paths, state, &original_state)
}

fn reload_state_from_disk(
    config: &RuntimeConfig,
    state: &mut PersistedState,
    paths: &RuntimePaths,
) -> Result<()> {
    let previous_status = state.status.clone();
    let previous_candidate_version = state.candidate_version.clone();
    let previous_waiting_auto_install = state.waiting_for_app_exit_auto_install;

    let loaded =
        PersistedState::load_or_default(&paths.state_file, effective_auto_install(config))?;
    let mut refreshed = loaded.clone();
    sync_runtime_state(config, &mut refreshed);
    persist_if_changed(paths, &refreshed, &loaded)?;

    if previous_status != refreshed.status
        || previous_candidate_version != refreshed.candidate_version
        || previous_waiting_auto_install != refreshed.waiting_for_app_exit_auto_install
    {
        info!(
            previous_status = ?previous_status,
            status = ?refreshed.status,
            previous_candidate_version = previous_candidate_version.as_deref(),
            candidate_version = refreshed.candidate_version.as_deref(),
            previous_waiting_auto_install,
            waiting_auto_install = refreshed.waiting_for_app_exit_auto_install,
            "reloaded updater state from disk"
        );
    }

    *state = refreshed;
    Ok(())
}

fn normalize_workspace_dir_and_persist(
    state: &mut PersistedState,
    paths: &RuntimePaths,
) -> Result<()> {
    let original_state = state.clone();
    cache_cleanup::normalize_artifact_workspace_dir(&paths.cache_dir, state);
    persist_if_changed(paths, state, &original_state)
}

fn maybe_prune_workspace_cache(workspace_root: &Path, state: &PersistedState) {
    match cache_cleanup::prune_unreferenced_workspaces(workspace_root, state) {
        Ok(summary) if summary.pruned_workspaces > 0 => {
            info!(
                pruned_workspaces = summary.pruned_workspaces,
                workspace_root = %workspace_root.display(),
                "pruned unreferenced updater workspaces"
            );
        }
        Ok(_) => {}
        Err(error) => {
            warn!(
                ?error,
                workspace_root = %workspace_root.display(),
                "failed to prune unreferenced updater workspaces"
            );
        }
    }
}

fn maybe_prune_generated_artifacts(config: &RuntimeConfig) {
    match cache_cleanup::prune_generated_artifacts(
        &config.generated_artifact_cleanup,
        &config.builder_bundle_root,
    ) {
        Ok(summary) if summary.pruned_paths > 0 => {
            info!(
                inspected_roots = summary.inspected_roots,
                pruned_paths = summary.pruned_paths,
                bytes_removed = summary.bytes_removed,
                "pruned generated wrapper artifacts"
            );
        }
        Ok(_) => {}
        Err(error) => {
            warn!(?error, "failed to prune generated wrapper artifacts");
        }
    }
}

fn maybe_prune_caches(config: &RuntimeConfig, state: &PersistedState) {
    maybe_prune_workspace_cache(&config.workspace_root, state);
    match cache_cleanup::prune_dmg_cache(&config.workspace_root, state) {
        Ok(summary) if summary.pruned_dmgs > 0 || summary.pruned_temps > 0 => {
            info!(
                pruned_dmgs = summary.pruned_dmgs,
                pruned_temps = summary.pruned_temps,
                "pruned updater DMG cache"
            );
        }
        Ok(summary) if summary.skipped_locked => {
            info!("skipping DMG cache cleanup while another updater flow holds its lease");
        }
        Ok(_) => {}
        Err(error) => warn!(?error, "failed to prune updater DMG cache"),
    }
    maybe_prune_generated_artifacts(config);
}

fn clear_wrapper_update_candidate_and_persist(
    state: &mut PersistedState,
    paths: &RuntimePaths,
) -> Result<()> {
    let original_state = state.clone();
    state.clear_wrapper_update_candidate();
    persist_if_changed(paths, state, &original_state)
}

fn refresh_installed_wrapper_state(config: &RuntimeConfig, state: &mut PersistedState) {
    if let Some(installed) = wrapper::installed_wrapper_from_metadata(
        &config.app_executable_path,
        &config.builder_bundle_root,
    ) {
        state.installed_wrapper_version = installed.version;
        state.installed_wrapper_commit = Some(installed.commit);
    } else {
        state.installed_wrapper_version = None;
        state.installed_wrapper_commit = None;
    }
}

fn clear_stale_wrapper_update_and_persist(
    config: &RuntimeConfig,
    state: &mut PersistedState,
    paths: &RuntimePaths,
) -> Result<()> {
    let original_state = state.clone();
    refresh_installed_wrapper_state(config, state);
    state.clear_wrapper_update_candidate();
    persist_if_changed(paths, state, &original_state)
}

fn set_status(
    state: &mut PersistedState,
    paths: &RuntimePaths,
    status: UpdateStatus,
) -> Result<()> {
    state.status = status;
    if state.status != UpdateStatus::WaitingForAppExit {
        state.waiting_for_app_exit_auto_install = false;
    }
    persist_state(paths, state)
}

fn set_waiting_for_app_exit(
    state: &mut PersistedState,
    paths: &RuntimePaths,
    auto_install: bool,
) -> Result<()> {
    state.waiting_for_app_exit_auto_install = auto_install;
    state.status = UpdateStatus::WaitingForAppExit;
    persist_state(paths, state)
}

fn mark_failed_and_persist(
    state: &mut PersistedState,
    paths: &RuntimePaths,
    message: impl Into<String>,
) -> Result<()> {
    state.mark_failed(message);
    persist_state(paths, state)
}

fn packaged_runtime_removed(config: &RuntimeConfig) -> bool {
    config.builder_bundle_root == Path::new("/opt/codex-desktop/update-builder")
        && !config.app_executable_path.exists()
        && !install::is_primary_package_installed()
}

fn summarize_command_output(output: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(output);
    let text = text.trim();
    if text.is_empty() {
        return None;
    }

    let mut lines = text.lines().rev().take(3).collect::<Vec<_>>();
    lines.reverse();
    Some(lines.join(" | "))
}

struct CheckLock {
    _file: fs::File,
}

fn try_acquire_check_lock(paths: &RuntimePaths) -> Result<Option<CheckLock>> {
    let lock_path = paths.state_dir.join("check.lock");
    let mut file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&lock_path)
        .with_context(|| format!("Failed to open {}", lock_path.display()))?;

    match file.try_lock() {
        Ok(()) => {}
        Err(fs::TryLockError::WouldBlock) => {
            info!("skipping upstream check because another check is already active");
            return Ok(None);
        }
        Err(fs::TryLockError::Error(error)) => {
            return Err(error).with_context(|| format!("Failed to lock {}", lock_path.display()));
        }
    }

    file.set_len(0)
        .with_context(|| format!("Failed to truncate {}", lock_path.display()))?;
    file.seek(SeekFrom::Start(0))
        .with_context(|| format!("Failed to seek {}", lock_path.display()))?;
    writeln!(file, "{}", std::process::id())
        .with_context(|| format!("Failed to write {}", lock_path.display()))?;

    Ok(Some(CheckLock { _file: file }))
}

fn update_install_is_pending(status: &UpdateStatus) -> bool {
    matches!(
        status,
        UpdateStatus::ReadyToInstall | UpdateStatus::WaitingForAppExit | UpdateStatus::Installing
    )
}

// Failed attempts and transient states persisted before fallible download or
// build work must retry after the next checker acquires the check lock. A
// still-running checker continues to own that lock and prevents duplicate work.
fn update_check_should_retry(status: &UpdateStatus) -> bool {
    matches!(
        status,
        UpdateStatus::Failed
            | UpdateStatus::DownloadingDmg
            | UpdateStatus::UpdateDetected
            | UpdateStatus::PreparingWorkspace
            | UpdateStatus::PatchingApp
            | UpdateStatus::BuildingPackage
    )
}

fn prepare_upstream_check(state: &mut PersistedState, paths: &RuntimePaths) -> Result<bool> {
    let retrying_update = update_check_should_retry(&state.status);

    // Keep a retryable status durable until the metadata request completes. If
    // the updater exits while that request is in flight, the next run must not
    // mistake the interrupted rebuild for an ordinary unchanged-upstream check.
    if !retrying_update {
        state.status = UpdateStatus::CheckingUpstream;
    }
    state.last_check_at = Some(Utc::now());
    state.error_message = None;
    persist_state(paths, state)?;

    Ok(retrying_update)
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
enum PendingInstallRecovery {
    NoChange,
    CandidateInstalled,
    SupersededByInstalledVersion,
}

impl PendingInstallRecovery {
    fn completed(self) -> bool {
        !matches!(self, Self::NoChange)
    }

    fn should_notify_installed(self) -> bool {
        matches!(self, Self::CandidateInstalled)
    }
}

async fn run_daemon(
    config: &RuntimeConfig,
    state: &mut PersistedState,
    paths: &RuntimePaths,
) -> Result<()> {
    sync_and_persist(config, state, paths)?;
    recover_interrupted_install(state, paths)?;
    complete_current_dmg_update_if_already_installed(config, state, paths)?;
    codex_cli::reconcile_if_present(state, paths)?;
    normalize_workspace_dir_and_persist(state, paths)?;
    maybe_prune_caches(config, state);
    maybe_notify_cli_missing(state, paths, config.notifications)?;
    if packaged_runtime_removed(config) {
        info!("packaged app files are gone; stopping updater daemon");
        return Ok(());
    }
    info!("daemon initialized");

    time::sleep(config.initial_check_delay_duration()).await;
    if let Err(error) = run_check_cycle_from_disk(config, state, paths).await {
        error!(?error, "initial check failed");
    }
    if let Err(error) = reconcile_pending_install_from_disk(config, state, paths).await {
        error!(?error, "initial reconciliation failed");
    }

    let mut check_interval = time::interval(config.check_interval_duration()?);
    let mut reconcile_interval = time::interval(Duration::from_secs(RECONCILE_INTERVAL_SECONDS));
    check_interval.tick().await;
    reconcile_interval.tick().await;
    loop {
        if packaged_runtime_removed(config) {
            info!("packaged app files are gone; stopping updater daemon");
            break;
        }

        tokio::select! {
            _ = check_interval.tick() => {
                if let Err(error) = run_check_cycle_from_disk(config, state, paths).await {
                    error!(?error, "periodic check failed");
                }
            }
            _ = reconcile_interval.tick() => {
                if let Err(error) = reconcile_pending_install_from_disk(config, state, paths).await {
                    error!(?error, "pending install reconciliation failed");
                }
            }
            signal = tokio::signal::ctrl_c() => {
                signal?;
                info!("daemon received shutdown signal");
                break;
            }
        }
    }

    Ok(())
}

async fn run_check_now(
    config: &RuntimeConfig,
    state: &mut PersistedState,
    paths: &RuntimePaths,
    if_stale: bool,
) -> Result<()> {
    sync_and_persist(config, state, paths)?;
    recover_interrupted_install(state, paths)?;
    complete_current_dmg_update_if_already_installed(config, state, paths)?;
    codex_cli::reconcile_if_present(state, paths)?;
    normalize_workspace_dir_and_persist(state, paths)?;
    maybe_prune_caches(config, state);
    maybe_notify_cli_missing(state, paths, config.notifications)?;
    if if_stale
        && !update_check_should_retry(&state.status)
        && upstream_check_is_fresh(config, state)
    {
        if let Err(error) = detect_and_record_wrapper_update(config, state, paths) {
            warn!(
                ?error,
                "wrapper update detection failed during fresh check-now"
            );
        }
        info!("skipping check-now because the last successful upstream check is still fresh");
        return reconcile_pending_install(config, state, paths).await;
    }
    run_check_cycle(config, state, paths).await?;
    reconcile_pending_install(config, state, paths).await
}

/// Detects a newer wrapper release and records it into state. Returns
/// `Ok(true)` when an update was found and recorded. No-ops (returning
/// `Ok(false)`) when wrapper tracking is disabled, the builder bundle is not a
/// git checkout, or no newer commit is available. Never mutates the checkout.
fn detect_and_record_wrapper_update(
    config: &RuntimeConfig,
    state: &mut PersistedState,
    paths: &RuntimePaths,
) -> Result<bool> {
    if !config.enable_wrapper_updates {
        clear_wrapper_update_candidate_and_persist(state, paths)?;
        return Ok(false);
    }

    let Some(installed) = wrapper::installed_wrapper_from_metadata(
        &config.app_executable_path,
        &config.builder_bundle_root,
    ) else {
        clear_stale_wrapper_update_and_persist(config, state, paths)?;
        return Ok(false);
    };

    use wrapper::WrapperDetectionState::*;

    let detection = match wrapper::detect_state_from_bundle_root(
        &config.builder_bundle_root,
        &installed,
        &config.wrapper_remote,
        &config.wrapper_branch,
    ) {
        Ok(result) => result,
        Err(error) => {
            warn!(?error, "wrapper update detection failed");
            let original_state = state.clone();
            state.installed_wrapper_version = installed.version;
            state.installed_wrapper_commit = Some(installed.commit);
            persist_if_changed(paths, state, &original_state)?;
            return Ok(false);
        }
    };

    let original_state = state.clone();
    state.installed_wrapper_version = installed.version.clone();
    state.installed_wrapper_commit = Some(installed.commit.clone());

    match detection {
        (UpdateAvailable, Some(update)) => {
            state.wrapper_dev_mode = Some(false);
            state.installed_wrapper_version = update.installed_version.clone();
            state.installed_wrapper_commit = Some(update.installed_commit.clone());
            state.candidate_wrapper_version = update.candidate_version.clone();
            state.candidate_wrapper_commit = Some(update.candidate_commit.clone());
            state.wrapper_changelog = Some(update.changelog.clone());
            persist_if_changed(paths, state, &original_state)?;

            let change_count = update
                .changelog
                .lines()
                .filter(|l| !l.trim().is_empty())
                .count();
            maybe_notify(
                state,
                paths,
                config.notifications,
                &format!("wrapper_update:{}", update.candidate_commit),
                "ChatGPT Desktop wrapper update available",
                &format!(
                    "A newer Linux wrapper build is available ({change_count} change(s)). Rebuild to apply."
                ),
            )?;

            Ok(true)
        }
        (DevMode, _) => {
            state.clear_wrapper_update_candidate();
            state.wrapper_dev_mode = Some(true);
            persist_if_changed(paths, state, &original_state)?;
            Ok(false)
        }
        (Aligned, _) => {
            state.clear_wrapper_update_candidate();
            state.wrapper_dev_mode = Some(false);
            persist_if_changed(paths, state, &original_state)?;
            Ok(false)
        }
        (UnknownOffline, _) | (UpdateAvailable, None) => {
            state.clear_wrapper_update_candidate();
            persist_if_changed(paths, state, &original_state)?;
            Ok(false)
        }
    }
}

fn run_check_wrapper(
    config: &RuntimeConfig,
    state: &mut PersistedState,
    paths: &RuntimePaths,
    json: bool,
) -> Result<()> {
    if !config.enable_wrapper_updates {
        clear_wrapper_update_candidate_and_persist(state, paths)?;
        if json {
            println!("{}", serde_json::json!({ "enabled": false }));
        } else {
            println!(
                "Wrapper update tracking is disabled (set enable_wrapper_updates = true in config.toml)."
            );
        }
        return Ok(());
    }

    let found = detect_and_record_wrapper_update(config, state, paths)?;

    if json {
        println!("{}", serde_json::to_string_pretty(state)?);
    } else if found {
        println!(
            "wrapper update available: {} -> {}",
            state
                .installed_wrapper_commit
                .as_deref()
                .unwrap_or("unknown"),
            state
                .candidate_wrapper_commit
                .as_deref()
                .unwrap_or("unknown")
        );
        if let Some(changelog) = state.wrapper_changelog.as_deref() {
            println!("\n{changelog}");
        }
    } else if state.wrapper_dev_mode == Some(true) {
        println!("wrapper is a local/dev build ahead of upstream; updates are disabled.");
    } else {
        println!("wrapper is up to date (or not a git checkout).");
    }

    Ok(())
}

fn upstream_check_is_fresh(config: &RuntimeConfig, state: &PersistedState) -> bool {
    let Some(last_successful_check_at) = state.last_successful_check_at else {
        return false;
    };

    let Ok(freshness_window) = config.check_interval_chrono_duration() else {
        return false;
    };
    Utc::now().signed_duration_since(last_successful_check_at) < freshness_window
}

fn run_status(
    config: &RuntimeConfig,
    state: &mut PersistedState,
    paths: &RuntimePaths,
    json: bool,
) -> Result<()> {
    codex_cli::reconcile_if_present(state, paths)?;
    complete_current_dmg_update_if_already_installed(config, state, paths)?;
    let _ = complete_pending_install_if_already_installed(state, paths)?;
    normalize_workspace_dir_and_persist(state, paths)?;
    if !config.enable_wrapper_updates {
        clear_wrapper_update_candidate_and_persist(state, paths)?;
    }

    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&status_json_value(state)?)?
        );
    } else {
        println!("status: {:?}", state.status);
        println!("installed_version: {}", state.installed_version);
        println!(
            "candidate_version: {}",
            state.candidate_version.as_deref().unwrap_or("none")
        );
        println!(
            "last_known_good_version: {}",
            state.last_known_good_version.as_deref().unwrap_or("none")
        );
        println!(
            "rollback_blocked_candidate_version: {}",
            state
                .rollback_blocked_candidate_version
                .as_deref()
                .unwrap_or("none")
        );
        println!("{}", update_error_status_line(state));
        println!("cli_status: {:?}", state.cli_status);
        println!(
            "cli_installed_version: {}",
            state.cli_installed_version.as_deref().unwrap_or("unknown")
        );
        println!(
            "cli_official_latest_version: {}",
            state
                .cli_official_latest_version
                .as_deref()
                .unwrap_or("unknown")
        );
        println!(
            "cli_package_manager_latest_version: {}",
            state
                .cli_package_manager_latest_version
                .as_deref()
                .unwrap_or("unknown")
        );
        println!(
            "cli_error: {}",
            state.cli_error_message.as_deref().unwrap_or("none")
        );
    }

    Ok(())
}

fn status_json_value(state: &PersistedState) -> Result<serde_json::Value> {
    let mut value = serde_json::to_value(state)?;
    if let Some(object) = value.as_object_mut() {
        object.insert(
            "cli_latest_version".to_string(),
            serde_json::to_value(&state.cli_official_latest_version)?,
        );
    }
    Ok(value)
}

fn update_error_status_line(state: &PersistedState) -> String {
    format!(
        "update_error: {}",
        state.error_message.as_deref().unwrap_or("none")
    )
}

fn run_prompt_install_cli(
    state: &mut PersistedState,
    paths: &RuntimePaths,
    cli_path: Option<PathBuf>,
    print_path: bool,
) -> Result<()> {
    let outcome = prompt_install_cli(state, paths, cli_path)?;
    match outcome {
        PromptInstallCliOutcome::Installed(path) => {
            if print_path {
                println!("{}", path.display());
            }
            std::process::exit(0);
        }
        PromptInstallCliOutcome::Cancelled => {
            std::process::exit(PROMPT_INSTALL_CLI_CANCELLED_EXIT_CODE);
        }
        PromptInstallCliOutcome::NoBackend => {
            std::process::exit(PROMPT_INSTALL_CLI_NO_BACKEND_EXIT_CODE);
        }
    }
}

fn run_cli_preflight(
    state: &mut PersistedState,
    paths: &RuntimePaths,
    cli_path: Option<std::path::PathBuf>,
    print_path: bool,
    allow_install_missing: bool,
) -> Result<()> {
    let outcome = codex_cli::preflight(state, paths, cli_path, allow_install_missing)?;
    if print_path {
        println!("{}", outcome.cli_path.display());
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum PromptInstallCliOutcome {
    Installed(PathBuf),
    Cancelled,
    NoBackend,
}

fn prompt_install_cli(
    state: &mut PersistedState,
    paths: &RuntimePaths,
    cli_path: Option<PathBuf>,
) -> Result<PromptInstallCliOutcome> {
    if let Some(path) = cli_path
        .as_deref()
        .and_then(|path| codex_cli::resolve_cli_path(Some(path)))
        .or_else(|| {
            state
                .cli_path
                .as_deref()
                .and_then(|path| codex_cli::resolve_cli_path(Some(path)))
        })
        .or_else(|| codex_cli::resolve_cli_path(None))
    {
        return Ok(PromptInstallCliOutcome::Installed(path));
    }

    if recently_dismissed_cli_prompt(state) {
        return Ok(PromptInstallCliOutcome::Cancelled);
    }

    if !has_interactive_graphical_session() {
        return Ok(PromptInstallCliOutcome::NoBackend);
    }

    let consent = if prefers_kdialog() && command_in_path("kdialog").is_some() {
        run_kdialog_prompt()?
    } else if command_in_path("zenity").is_some() {
        run_zenity_prompt()?
    } else if command_in_path("kdialog").is_some() {
        run_kdialog_prompt()?
    } else {
        run_actionable_notification_prompt()?
    };

    if !consent {
        state.cli_prompt_dismissed_at = Some(Utc::now());
        persist_state(paths, state)?;
        return Ok(PromptInstallCliOutcome::Cancelled);
    }

    state.cli_prompt_dismissed_at = None;
    let outcome = codex_cli::preflight(state, paths, cli_path, true)?;
    Ok(PromptInstallCliOutcome::Installed(outcome.cli_path))
}

fn recently_dismissed_cli_prompt(state: &PersistedState) -> bool {
    state.cli_prompt_dismissed_at.is_some_and(|dismissed_at| {
        Utc::now().signed_duration_since(dismissed_at) < CLI_MISSING_PROMPT_DISMISS_TTL
    })
}

fn has_interactive_graphical_session() -> bool {
    let has_display =
        std::env::var_os("DISPLAY").is_some() || std::env::var_os("WAYLAND_DISPLAY").is_some();
    let has_dbus = std::env::var_os("DBUS_SESSION_BUS_ADDRESS").is_some()
        || std::env::var_os("XDG_RUNTIME_DIR").is_some();
    has_display && has_dbus
}

fn has_user_session_bus_for_polkit() -> bool {
    std::env::var_os("DBUS_SESSION_BUS_ADDRESS").is_some()
        || std::env::var_os("XDG_RUNTIME_DIR").is_some()
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

fn run_kdialog_prompt() -> Result<bool> {
    let status = Command::new("kdialog")
        .args([
            "--title",
            "ChatGPT Desktop",
            "--yesno",
            "Codex CLI is not installed. Install it now?",
        ])
        .status()
        .context("Failed to launch kdialog")?;
    Ok(status.success())
}

fn run_zenity_prompt() -> Result<bool> {
    let status = Command::new("zenity")
        .args([
            "--question",
            "--title=ChatGPT Desktop",
            "--text=Codex CLI is not installed. Install it now?",
        ])
        .status()
        .context("Failed to launch zenity")?;
    Ok(status.success())
}

fn run_actionable_notification_prompt() -> Result<bool> {
    match notify::send_actionable(
        "Codex CLI not installed",
        "ChatGPT Desktop needs the Codex CLI. Choose Install now to let ChatGPT Desktop install it.",
        &[("install", "Install now"), ("dismiss", "Dismiss")],
    )? {
        notify::ActionResponse::Invoked(action) if action == "install" => Ok(true),
        _ => Ok(false),
    }
}

async fn run_check_cycle_from_disk(
    config: &RuntimeConfig,
    state: &mut PersistedState,
    paths: &RuntimePaths,
) -> Result<()> {
    reload_state_from_disk(config, state, paths)?;
    run_check_cycle(config, state, paths).await
}

async fn run_check_cycle(
    config: &RuntimeConfig,
    state: &mut PersistedState,
    paths: &RuntimePaths,
) -> Result<()> {
    // Keep wrapper state fresh even while a DMG package is pending; otherwise
    // `status --json` could keep advertising stale wrapper candidates.
    if let Err(error) = detect_and_record_wrapper_update(config, state, paths) {
        warn!(?error, "wrapper update detection failed during check cycle");
    }

    if update_install_is_pending(&state.status) {
        info!("skipping upstream check because an update is already pending");
        return Ok(());
    }

    if let Err(error) = codex_cli::reconcile_if_present(state, paths) {
        warn!(
            ?error,
            "unable to reconcile Codex CLI before checking upstream packages"
        );
    }

    let Some(_check_lock) = try_acquire_check_lock(paths)? else {
        return Ok(());
    };

    let client = upstream::http_client()?;

    sync_runtime_state(config, state);
    let retrying_update = prepare_upstream_check(state, paths)?;

    let result: Result<()> = async {
        let metadata = upstream::fetch_remote_metadata(&client, &config.dmg_url).await?;
        let previous_headers_fingerprint = state.remote_headers_fingerprint.clone();
        state.remote_headers_fingerprint = Some(metadata.headers_fingerprint.clone());
        state.last_successful_check_at = Some(Utc::now());

        if previous_headers_fingerprint.as_deref() == Some(metadata.headers_fingerprint.as_str())
            && state.dmg_sha256.is_some()
            && !retrying_update
        {
            set_status(state, paths, UpdateStatus::Idle)?;
            info!("upstream fingerprint unchanged; skipping download");
            return Ok(());
        }

        set_status(state, paths, UpdateStatus::DownloadingDmg)?;

        let downloads_dir = config.workspace_root.join("downloads");
        let downloaded =
            upstream::download_dmg(&client, &config.dmg_url, &downloads_dir, Utc::now()).await?;

        if installed_upstream_dmg_matches(config, &downloaded.sha256) {
            clear_dmg_update_candidate(
                state,
                paths,
                Some(downloaded.path),
                Some(downloaded.sha256),
            )?;
            info!("downloaded DMG hash matches installed app; no update detected");
            return Ok(());
        }

        if rollback_blocks_candidate(state, &downloaded.sha256, &downloaded.candidate_version) {
            state.status = UpdateStatus::Idle;
            state.error_message = Some(format!(
                "Candidate {} was rolled back and will not be reinstalled automatically",
                downloaded.candidate_version
            ));
            persist_state(paths, state)?;
            info!(
                candidate_version = %downloaded.candidate_version,
                "skipping candidate blocked by rollback"
            );
            return Ok(());
        }

        if state.dmg_sha256.as_deref() == Some(downloaded.sha256.as_str()) && !retrying_update {
            state.status = UpdateStatus::Idle;
            state.artifact_paths.dmg_path = Some(downloaded.path);
            persist_state(paths, state)?;
            info!("downloaded DMG hash matches current cached DMG; no update detected");
            return Ok(());
        }

        rollback::record_current_package_as_known_good(state);
        state.status = UpdateStatus::UpdateDetected;
        state.candidate_version = Some(downloaded.candidate_version.clone());
        state.dmg_sha256 = Some(downloaded.sha256.clone());
        state.artifact_paths.dmg_path = Some(downloaded.path.clone());
        state.notified_events.clear();
        state.save(&paths.state_file)?;

        maybe_notify(
            state,
            paths,
            config.notifications,
            "update_detected",
            "New ChatGPT Desktop update detected",
            "Preparing a local Linux package from the new upstream DMG.",
        )?;

        let candidate_version = state
            .candidate_version
            .clone()
            .expect("candidate version should be set before local build");
        builder::build_update(config, state, paths, &candidate_version, &downloaded.path).await?;
        drop(downloaded);
        maybe_notify_update_ready(state, paths, config.notifications)?;
        Ok(())
    }
    .await;

    // Every check outcome, including an early no-update return, releases its
    // DMG lease before bounded cache cleanup runs here.
    maybe_prune_caches(config, state);
    if let Err(error) = result {
        mark_failed_and_persist(state, paths, error.to_string())?;
        let _ = notify_failure(config, state, paths, &error);
        return Err(error);
    }

    Ok(())
}

async fn reconcile_pending_install_from_disk(
    config: &RuntimeConfig,
    state: &mut PersistedState,
    paths: &RuntimePaths,
) -> Result<()> {
    reload_state_from_disk(config, state, paths)?;
    reconcile_pending_install(config, state, paths).await
}

async fn reconcile_pending_install(
    config: &RuntimeConfig,
    state: &mut PersistedState,
    paths: &RuntimePaths,
) -> Result<()> {
    sync_runtime_state(config, state);
    recover_interrupted_install(state, paths)?;
    let pending_recovery = complete_pending_install_if_already_installed(state, paths)?;
    if pending_recovery.completed() {
        if pending_recovery.should_notify_installed() {
            let _ = maybe_notify_installed(state, paths, config.notifications);
        }
        return Ok(());
    }

    match state.status {
        UpdateStatus::ReadyToInstall => {
            let Some(package_path) = state.artifact_paths.package_path.clone() else {
                return Ok(());
            };

            if !package_path.exists() {
                mark_failed_and_persist(
                    state,
                    paths,
                    format!(
                        "Pending package artifact is missing: {}",
                        package_path.display()
                    ),
                )?;
                return Ok(());
            }

            if state.auto_install_on_app_exit && liveness::is_app_running(config)? {
                if !graphical_polkit_auth_agent_is_likely_available() {
                    defer_install_for_manual_auth(state, paths, &package_path)?;
                    maybe_notify_manual_install_required(state, paths, config.notifications)?;
                    return Ok(());
                }
                clear_install_auth_required_event(state, paths)?;
                set_waiting_for_app_exit(state, paths, true)?;
                maybe_notify(
                    state,
                    paths,
                    config.notifications,
                    "ready_to_install",
                    "ChatGPT Desktop update ready",
                    "Close ChatGPT Desktop to install the ready update.",
                )?;
                return Ok(());
            }

            set_status(state, paths, UpdateStatus::ReadyToInstall)?;
        }
        UpdateStatus::WaitingForAppExit => {
            let Some(package_path) = state.artifact_paths.package_path.clone() else {
                return Ok(());
            };

            if !package_path.exists() {
                mark_failed_and_persist(
                    state,
                    paths,
                    format!(
                        "Pending package artifact is missing: {}",
                        package_path.display()
                    ),
                )?;
                return Ok(());
            }

            if state.waiting_for_app_exit_auto_install && !state.auto_install_on_app_exit {
                set_status(state, paths, UpdateStatus::ReadyToInstall)?;
                return Ok(());
            }

            if liveness::is_app_running(config)? {
                if !graphical_polkit_auth_agent_is_likely_available() {
                    defer_install_for_manual_auth(state, paths, &package_path)?;
                    maybe_notify_manual_install_required(state, paths, config.notifications)?;
                    return Ok(());
                }
                clear_install_auth_required_event(state, paths)?;
                maybe_notify(
                    state,
                    paths,
                    config.notifications,
                    "waiting_for_app_exit",
                    "ChatGPT Desktop update ready",
                    "The update will install after you close ChatGPT Desktop.",
                )?;
                return Ok(());
            }

            if install_auth_retry_is_blocked(state) {
                return Ok(());
            }

            if !graphical_polkit_auth_agent_is_likely_available() {
                defer_install_for_manual_auth(state, paths, &package_path)?;
                maybe_notify_manual_install_required(state, paths, config.notifications)?;
                return Ok(());
            }

            trigger_install(state, paths, &config.workspace_root, &package_path).await?;
        }
        _ => {}
    }

    Ok(())
}

async fn run_install_ready(
    config: &RuntimeConfig,
    state: &mut PersistedState,
    paths: &RuntimePaths,
) -> Result<()> {
    sync_and_persist(config, state, paths)?;
    recover_interrupted_install(state, paths)?;

    if complete_current_dmg_update_if_already_installed(config, state, paths)? {
        println!("ChatGPT Desktop is already up to date.");
        return Ok(());
    }

    let pending_recovery = complete_pending_install_if_already_installed(state, paths)?;
    if pending_recovery.completed() {
        if pending_recovery.should_notify_installed() {
            let _ = maybe_notify_installed(state, paths, config.notifications);
        }
        println!("ChatGPT Desktop update is already installed or superseded.");
        return Ok(());
    }

    match state.status {
        UpdateStatus::ReadyToInstall | UpdateStatus::WaitingForAppExit => {}
        UpdateStatus::Installing => {
            maybe_send_notification(
                config.notifications,
                "ChatGPT Desktop update already installing",
                "ChatGPT Desktop is already applying the ready update.",
            );
            println!("ChatGPT Desktop update is already installing.");
            return Ok(());
        }
        _ => {
            maybe_send_notification(
                config.notifications,
                "No ChatGPT Desktop update ready",
                "There is no rebuilt ChatGPT Desktop update waiting to install.",
            );
            println!("No update is ready to install.");
            return Ok(());
        }
    }

    let Some(package_path) = state.artifact_paths.package_path.clone() else {
        mark_failed_and_persist(state, paths, "No ready update package is recorded")?;
        maybe_send_notification(
            config.notifications,
            "ChatGPT Desktop update failed",
            "The updater has no package path recorded for the ready update.",
        );
        println!("No ready update package is recorded.");
        return Ok(());
    };

    if !package_path.exists() {
        mark_failed_and_persist(
            state,
            paths,
            format!(
                "Pending package artifact is missing: {}",
                package_path.display()
            ),
        )?;
        maybe_send_notification(
            config.notifications,
            "ChatGPT Desktop update failed",
            "The rebuilt package is missing. Check the updater log for details.",
        );
        println!(
            "Ready update package is missing: {}",
            package_path.display()
        );
        return Ok(());
    }

    if liveness::is_app_running(config)? {
        if !graphical_polkit_auth_agent_is_likely_available() {
            defer_install_for_manual_auth(state, paths, &package_path)?;
            maybe_send_manual_install_required_notification(config.notifications);
            print_manual_install_required(&package_path);
            return Ok(());
        }
        clear_install_auth_required_event(state, paths)?;
        set_waiting_for_app_exit(state, paths, false)?;
        maybe_send_notification(
            config.notifications,
            "ChatGPT Desktop update ready",
            "Close ChatGPT Desktop to install the ready update.",
        );
        println!("ChatGPT Desktop is running. Close it to install the ready update.");
        return Ok(());
    }

    clear_install_auth_required_event(state, paths)?;
    state.waiting_for_app_exit_auto_install = false;
    if !graphical_polkit_auth_agent_is_likely_available() {
        defer_install_for_manual_auth(state, paths, &package_path)?;
        maybe_send_manual_install_required_notification(config.notifications);
        print_manual_install_required(&package_path);
        return Ok(());
    }
    trigger_install(state, paths, &config.workspace_root, &package_path).await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstalledBuildInfo {
    upstream_dmg: Option<InstalledUpstreamDmg>,
}

#[derive(Debug, Deserialize)]
struct InstalledUpstreamDmg {
    sha256: Option<String>,
}

fn complete_current_dmg_update_if_already_installed(
    config: &RuntimeConfig,
    state: &mut PersistedState,
    paths: &RuntimePaths,
) -> Result<bool> {
    if !dmg_update_state_can_be_cleared_as_current(&state.status) {
        return Ok(false);
    }

    if state.candidate_version.is_none() {
        return Ok(false);
    }

    let Some(candidate_sha256) = state.dmg_sha256.clone() else {
        return Ok(false);
    };

    if !installed_upstream_dmg_matches(config, &candidate_sha256) {
        return Ok(false);
    }

    clear_dmg_update_candidate(state, paths, None, Some(candidate_sha256))?;
    info!("recovered DMG update state because the candidate DMG is already installed");
    Ok(true)
}

fn dmg_update_state_can_be_cleared_as_current(status: &UpdateStatus) -> bool {
    matches!(
        status,
        UpdateStatus::UpdateDetected
            | UpdateStatus::DownloadingDmg
            | UpdateStatus::PreparingWorkspace
            | UpdateStatus::PatchingApp
            | UpdateStatus::BuildingPackage
            | UpdateStatus::ReadyToInstall
            | UpdateStatus::WaitingForAppExit
            | UpdateStatus::Installing
            | UpdateStatus::Failed
    )
}

fn clear_dmg_update_candidate(
    state: &mut PersistedState,
    paths: &RuntimePaths,
    dmg_path: Option<PathBuf>,
    sha256: Option<String>,
) -> Result<()> {
    state.status = UpdateStatus::Idle;
    state.waiting_for_app_exit_auto_install = false;
    state.candidate_version = None;
    if let Some(sha256) = sha256 {
        state.dmg_sha256 = Some(sha256);
    }
    if let Some(dmg_path) = dmg_path {
        state.artifact_paths.dmg_path = Some(dmg_path);
    }
    state.artifact_paths.package_path = None;
    state.error_message = None;
    state.notified_events.clear();
    cache_cleanup::normalize_artifact_workspace_dir(&paths.cache_dir, state);
    persist_state(paths, state)
}

fn installed_upstream_dmg_matches(config: &RuntimeConfig, sha256: &str) -> bool {
    installed_upstream_dmg_sha256(config).as_deref() == Some(sha256)
}

fn installed_upstream_dmg_sha256(config: &RuntimeConfig) -> Option<String> {
    installed_build_info_paths(config)
        .into_iter()
        .find_map(|path| upstream_dmg_sha256_from_build_info(&path))
}

fn installed_build_info_paths(config: &RuntimeConfig) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(app_root) = config.app_executable_path.parent() {
        paths.push(app_root.join(".codex-linux/build-info.json"));
        paths.push(app_root.join("resources/codex-linux-build-info.json"));
    }
    paths
}

fn upstream_dmg_sha256_from_build_info(path: &Path) -> Option<String> {
    let content = fs::read_to_string(path).ok()?;
    let build_info = serde_json::from_str::<InstalledBuildInfo>(&content).ok()?;
    build_info
        .upstream_dmg?
        .sha256
        .filter(|value| !value.is_empty())
}

fn complete_pending_install_if_already_installed(
    state: &mut PersistedState,
    paths: &RuntimePaths,
) -> Result<PendingInstallRecovery> {
    if !matches!(
        state.status,
        UpdateStatus::ReadyToInstall | UpdateStatus::WaitingForAppExit
    ) {
        return Ok(PendingInstallRecovery::NoChange);
    }

    let Some(candidate_version) = state.candidate_version.clone().filter(|candidate| {
        installed_version_satisfies_candidate(&state.installed_version, candidate)
    }) else {
        return Ok(PendingInstallRecovery::NoChange);
    };

    let candidate_is_installed =
        installed_version_matches_candidate(&state.installed_version, &candidate_version);
    let recovery = if candidate_is_installed {
        PendingInstallRecovery::CandidateInstalled
    } else {
        PendingInstallRecovery::SupersededByInstalledVersion
    };

    state.status = UpdateStatus::Installed;
    state.waiting_for_app_exit_auto_install = false;
    state.candidate_version = None;
    clear_rollback_blocked_candidate(state);
    if !candidate_is_installed {
        state.artifact_paths.package_path = None;
    }
    state.error_message = None;
    state.notified_events.clear();
    cache_cleanup::normalize_artifact_workspace_dir(&paths.cache_dir, state);
    persist_state(paths, state)?;
    info!("recovered pending install state because the candidate version is already installed or superseded");
    Ok(recovery)
}

fn recover_interrupted_install(state: &mut PersistedState, paths: &RuntimePaths) -> Result<()> {
    if state.status != UpdateStatus::Installing {
        return Ok(());
    }

    if let Some(candidate_version) = state.candidate_version.clone().filter(|candidate| {
        installed_version_satisfies_candidate(&state.installed_version, candidate)
    }) {
        let candidate_is_installed =
            installed_version_matches_candidate(&state.installed_version, &candidate_version);

        state.status = UpdateStatus::Installed;
        state.waiting_for_app_exit_auto_install = false;
        state.candidate_version = None;
        clear_rollback_blocked_candidate(state);
        if !candidate_is_installed {
            state.artifact_paths.package_path = None;
        }
        state.error_message = None;
        state.notified_events.clear();
        cache_cleanup::normalize_artifact_workspace_dir(&paths.cache_dir, state);
        persist_state(paths, state)?;
        info!("recovered interrupted install state because the candidate version is already installed");
        return Ok(());
    }

    let Some(package_path) = state.artifact_paths.package_path.clone() else {
        mark_failed_and_persist(
            state,
            paths,
            "Previous install attempt was interrupted and no package artifact is recorded",
        )?;
        return Ok(());
    };

    if !package_path.exists() {
        mark_failed_and_persist(
            state,
            paths,
            format!(
                "Previous install attempt was interrupted and the package artifact is missing: {}",
                package_path.display()
            ),
        )?;
        return Ok(());
    }

    state.status = UpdateStatus::ReadyToInstall;
    state.waiting_for_app_exit_auto_install = false;
    state.error_message =
        Some("Previous install attempt was interrupted before completion".to_string());
    cache_cleanup::normalize_artifact_workspace_dir(&paths.cache_dir, state);
    persist_state(paths, state)?;
    info!(package = %package_path.display(), "recovered interrupted install state back to ready_to_install");
    Ok(())
}

fn installed_version_satisfies_candidate(installed: &str, candidate: &str) -> bool {
    if installed == "unknown" {
        return false;
    }

    match compare_generated_versions(installed, candidate) {
        Some(std::cmp::Ordering::Less) => false,
        Some(_) => true,
        None => installed == candidate,
    }
}

fn installed_version_matches_candidate(installed: &str, candidate: &str) -> bool {
    if installed == "unknown" {
        return false;
    }

    match compare_generated_versions(installed, candidate) {
        Some(std::cmp::Ordering::Equal) => true,
        Some(_) => false,
        None => installed == candidate,
    }
}

fn rollback_blocks_candidate(
    state: &PersistedState,
    candidate_sha256: &str,
    candidate_version: &str,
) -> bool {
    match state.rollback_blocked_dmg_sha256.as_deref() {
        Some(blocked_sha256) => blocked_sha256 == candidate_sha256,
        None => state
            .rollback_blocked_candidate_version
            .as_deref()
            .is_some_and(|blocked| installed_version_matches_candidate(blocked, candidate_version)),
    }
}

fn clear_rollback_blocked_candidate(state: &mut PersistedState) {
    state.rollback_blocked_candidate_version = None;
    state.rollback_blocked_dmg_sha256 = None;
}

fn compare_generated_versions(left: &str, right: &str) -> Option<std::cmp::Ordering> {
    let left = parse_generated_version(left)?;
    let right = parse_generated_version(right)?;
    Some(left.cmp(&right))
}

fn parse_generated_version(version: &str) -> Option<Vec<u32>> {
    let without_metadata = version
        .split_once('+')
        .map(|(prefix, _)| prefix)
        .unwrap_or(version);
    let base = without_metadata
        .split_once('-')
        .map(|(prefix, _)| prefix)
        .unwrap_or(without_metadata);
    let mut parts = Vec::new();
    for segment in base.split('.') {
        parts.push(segment.parse::<u32>().ok()?);
    }
    if parts.len() != 4 {
        return None;
    }
    Some(parts)
}

fn maybe_notify(
    state: &mut PersistedState,
    paths: &RuntimePaths,
    enabled: bool,
    event_name: &str,
    summary: &str,
    body: &str,
) -> Result<()> {
    let version = state
        .candidate_version
        .as_deref()
        .unwrap_or(&state.installed_version);
    let event_key = format!("{event_name}:{version}");
    maybe_notify_with_event_key(state, paths, enabled, &event_key, summary, body)
}

fn maybe_notify_with_event_key(
    state: &mut PersistedState,
    paths: &RuntimePaths,
    enabled: bool,
    event_key: &str,
    summary: &str,
    body: &str,
) -> Result<()> {
    if !state.notified_events.insert(event_key.to_string()) {
        return Ok(());
    }

    if enabled {
        if let Err(error) = notify::send(summary, body) {
            warn!(?error, "failed to send desktop notification");
        }
    }

    persist_state(paths, state)?;
    Ok(())
}

fn clear_notification_event(
    state: &mut PersistedState,
    paths: &RuntimePaths,
    event_key: &str,
) -> Result<()> {
    if state.notified_events.remove(event_key) {
        persist_state(paths, state)?;
    }

    Ok(())
}

fn cli_is_missing(state: &PersistedState) -> bool {
    state.cli_status == CliStatus::NotInstalled
}

fn maybe_notify_cli_missing(
    state: &mut PersistedState,
    paths: &RuntimePaths,
    enabled: bool,
) -> Result<()> {
    if !cli_is_missing(state) {
        return clear_notification_event(state, paths, CLI_MISSING_NOTIFICATION_EVENT);
    }

    maybe_notify_with_event_key(
        state,
        paths,
        enabled,
        CLI_MISSING_NOTIFICATION_EVENT,
        "Codex CLI not installed",
        "ChatGPT Desktop needs the Codex CLI. Open the app to retry the automatic install flow, or install it manually with npm.",
    )
}

fn maybe_notify_installed(
    state: &mut PersistedState,
    paths: &RuntimePaths,
    enabled: bool,
) -> Result<()> {
    if state.status != UpdateStatus::Installed {
        return Ok(());
    }

    maybe_notify(
        state,
        paths,
        enabled,
        "installed",
        "ChatGPT Desktop updated",
        "The new package is installed and will be used the next time you open the app.",
    )
}

fn maybe_notify_update_ready(
    state: &mut PersistedState,
    paths: &RuntimePaths,
    enabled: bool,
) -> Result<()> {
    let version = state
        .candidate_version
        .as_deref()
        .unwrap_or(&state.installed_version);
    let event_key = format!("ready_to_install:{version}");
    if !state.notified_events.insert(event_key) {
        return Ok(());
    }

    if enabled {
        let body = if state.auto_install_on_app_exit {
            "A rebuilt Linux package is ready. Close ChatGPT Desktop to install it, or open ChatGPT Desktop and choose Update."
        } else {
            "A rebuilt Linux package is ready. Open ChatGPT Desktop and choose Update to install it."
        };
        if let Err(error) = notify::send("ChatGPT Desktop update ready", body) {
            warn!(?error, "failed to send update-ready notification");
        }
    }

    persist_state(paths, state)?;
    Ok(())
}

fn maybe_send_notification(enabled: bool, summary: &str, body: &str) {
    if enabled {
        let _ = notify::send(summary, body);
    }
}

async fn trigger_install(
    state: &mut PersistedState,
    paths: &RuntimePaths,
    workspace_root: &Path,
    package_path: &Path,
) -> Result<()> {
    state.status = UpdateStatus::Installing;
    state.waiting_for_app_exit_auto_install = false;
    state.error_message = None;
    persist_state(paths, state)?;

    let _ = notify::send(
        "Installing ChatGPT Desktop update",
        "Applying the locally rebuilt Linux package.",
    );

    let current_exe = std::env::current_exe().context("Failed to resolve updater binary path")?;
    let output = install::pkexec_command(&current_exe, package_path)
        .output()
        .context("Failed to launch pkexec for update installation")?;
    let status = output.status;

    if status.success() {
        state.status = UpdateStatus::Installed;
        state.waiting_for_app_exit_auto_install = false;
        state.installed_version = install::installed_package_version();
        state.candidate_version = None;
        clear_rollback_blocked_candidate(state);
        state.error_message = None;
        state.notified_events.clear();
        cache_cleanup::normalize_artifact_workspace_dir(workspace_root, state);
        persist_state(paths, state)?;
        let _ = maybe_notify_installed(state, paths, true);
        maybe_prune_workspace_cache(workspace_root, state);
        return Ok(());
    }

    let stdout = summarize_command_output(&output.stdout);
    let stderr = summarize_command_output(&output.stderr);
    error!(
        status = %status,
        stdout = stdout.as_deref().unwrap_or(""),
        stderr = stderr.as_deref().unwrap_or(""),
        "privileged install failed"
    );

    let mut message = format!("Privileged install exited with status {status}");
    if let Some(stderr) = stderr {
        message.push_str(": ");
        message.push_str(&stderr);
    }

    let error = anyhow::anyhow!(message);
    if pkexec_authentication_was_not_obtained(&status) {
        defer_install_until_next_app_exit(state, paths, error.to_string())?;
        return Err(error);
    }

    mark_failed_and_persist(state, paths, error.to_string())?;
    let _ = notify::send(
        "ChatGPT Desktop update failed",
        "The package could not be installed. Check the updater log for details.",
    );
    Err(error)
}

fn pkexec_authentication_was_not_obtained(status: &std::process::ExitStatus) -> bool {
    matches!(status.code(), Some(126 | 127))
}

fn install_auth_required_event_key(state: &PersistedState) -> Option<String> {
    state
        .candidate_version
        .as_deref()
        .map(|candidate| format!("install_auth_required:{candidate}"))
}

fn install_auth_retry_is_blocked(state: &PersistedState) -> bool {
    install_auth_required_event_key(state)
        .as_ref()
        .is_some_and(|event_key| state.notified_events.contains(event_key))
}

fn manual_install_required_message(package_path: &Path) -> String {
    format!(
        "No graphical polkit authentication agent is available for pkexec. Run this from a terminal after closing ChatGPT Desktop: {}",
        manual_install_command(package_path)
    )
}

fn manual_install_command(package_path: &Path) -> String {
    let subcommand = match install::PackageKind::from_path(package_path) {
        install::PackageKind::Deb => "install-deb",
        install::PackageKind::Rpm => "install-rpm",
        install::PackageKind::Pacman => "install-pacman",
    };
    format!(
        "sudo /usr/bin/codex-update-manager {subcommand} --path {}",
        shell_quote_path(package_path)
    )
}

fn shell_quote_path(path: &Path) -> String {
    let value = path.to_string_lossy();
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn print_manual_install_required(package_path: &Path) {
    println!("Manual install required: no graphical polkit authentication agent is available.");
    println!("Run this from a terminal after closing ChatGPT Desktop:");
    println!("{}", manual_install_command(package_path));
}

fn defer_install_for_manual_auth(
    state: &mut PersistedState,
    paths: &RuntimePaths,
    package_path: &Path,
) -> Result<()> {
    state.status = UpdateStatus::ReadyToInstall;
    state.waiting_for_app_exit_auto_install = false;
    state.error_message = Some(manual_install_required_message(package_path));
    persist_state(paths, state)
}

fn maybe_notify_manual_install_required(
    state: &mut PersistedState,
    paths: &RuntimePaths,
    enabled: bool,
) -> Result<()> {
    maybe_notify(
        state,
        paths,
        enabled,
        "manual_install_required",
        "ChatGPT Desktop update needs manual install",
        "No graphical authentication agent was found for pkexec. Run codex-update-manager status for details.",
    )
}

fn maybe_send_manual_install_required_notification(enabled: bool) {
    maybe_send_notification(
        enabled,
        "ChatGPT Desktop update needs manual install",
        "No graphical authentication agent was found for pkexec. Run codex-update-manager status for details.",
    );
}

fn graphical_polkit_auth_agent_is_likely_available() -> bool {
    if std::env::var_os("CODEX_UPDATE_MANAGER_ASSUME_NO_POLKIT_AGENT").is_some() {
        return false;
    }
    if std::env::var_os("CODEX_UPDATE_MANAGER_ASSUME_POLKIT_AGENT").is_some() {
        return true;
    }
    if !has_user_session_bus_for_polkit() {
        return false;
    }
    polkit_auth_agent_process_is_running()
}

fn polkit_auth_agent_process_is_running() -> bool {
    let Ok(entries) = fs::read_dir("/proc") else {
        return true;
    };

    for entry in entries.flatten() {
        let file_name = entry.file_name();
        if !file_name
            .to_string_lossy()
            .chars()
            .all(|character| character.is_ascii_digit())
        {
            continue;
        }
        let process_dir = entry.path();
        let mut process_text = String::new();
        if let Ok(comm) = fs::read_to_string(process_dir.join("comm")) {
            process_text.push_str(&comm);
            process_text.push('\n');
        }
        if let Ok(cmdline) = fs::read(process_dir.join("cmdline")) {
            process_text.push_str(&String::from_utf8_lossy(&cmdline).replace('\0', " "));
        }
        if process_text_matches_polkit_auth_agent(&process_text) {
            return true;
        }
    }

    false
}

fn process_text_matches_polkit_auth_agent(process_text: &str) -> bool {
    let normalized = process_text.to_ascii_lowercase();
    if normalized.contains("polkitd") || normalized.contains("polkit-agent-helper") {
        return false;
    }
    POLKIT_AUTH_AGENT_PROCESS_TOKENS
        .iter()
        .any(|token| normalized.contains(token))
}

fn clear_install_auth_required_event(
    state: &mut PersistedState,
    paths: &RuntimePaths,
) -> Result<()> {
    let Some(event_key) = install_auth_required_event_key(state) else {
        return Ok(());
    };

    if state.notified_events.remove(&event_key) {
        persist_state(paths, state)?;
    }

    Ok(())
}

fn defer_install_until_next_app_exit(
    state: &mut PersistedState,
    paths: &RuntimePaths,
    message: String,
) -> Result<()> {
    state.status = UpdateStatus::ReadyToInstall;
    state.waiting_for_app_exit_auto_install = false;
    state.error_message = Some(message);

    if let Some(event_key) = install_auth_required_event_key(state) {
        if state.notified_events.insert(event_key) {
            let _ = notify::send(
                "ChatGPT Desktop update needs permission",
                "The ready update will retry after the next app close. Approve the system authentication dialog to install it.",
            );
        }
    }

    persist_state(paths, state)
}

fn notify_failure(
    config: &RuntimeConfig,
    state: &mut PersistedState,
    paths: &RuntimePaths,
    error: &anyhow::Error,
) -> Result<()> {
    let body = format!("The local rebuild failed: {error}");
    maybe_notify(
        state,
        paths,
        config.notifications,
        "build_failed",
        "ChatGPT Desktop update failed",
        &body,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::{
        matchers::{method, path},
        Mock, MockServer, ResponseTemplate,
    };

    fn test_paths(root: &std::path::Path) -> RuntimePaths {
        RuntimePaths {
            config_file: root.join("config/config.toml"),
            state_file: root.join("state/state.json"),
            log_file: root.join("state/service.log"),
            cache_dir: root.join("cache"),
            state_dir: root.join("state"),
            config_dir: root.join("config"),
        }
    }

    fn test_config(root: &std::path::Path) -> RuntimeConfig {
        RuntimeConfig {
            dmg_url: "https://example.com/Codex.dmg".to_string(),
            initial_check_delay_seconds: 1,
            check_interval_hours: 6,
            auto_install_on_app_exit: true,
            notifications: false,
            workspace_root: root.join("cache"),
            builder_bundle_root: root.join("builder"),
            app_executable_path: root.join("not-running-electron"),
            enable_wrapper_updates: false,
            wrapper_remote: String::new(),
            wrapper_branch: "main".to_string(),
            generated_artifact_cleanup: Default::default(),
        }
    }

    fn write_installed_build_info(config: &RuntimeConfig, sha256: &str) -> Result<()> {
        let app_root = config
            .app_executable_path
            .parent()
            .expect("test app executable should have parent");
        std::fs::create_dir_all(app_root.join(".codex-linux"))?;
        std::fs::write(
            app_root.join(".codex-linux/build-info.json"),
            format!(
                r#"{{
  "upstreamDmg": {{
    "sha256": "{sha256}"
  }}
}}
"#
            ),
        )?;
        Ok(())
    }

    #[test]
    fn upstream_check_freshness_respects_configured_interval() {
        let config = RuntimeConfig {
            dmg_url: "https://example.com/Codex.dmg".to_string(),
            initial_check_delay_seconds: 1,
            check_interval_hours: 6,
            auto_install_on_app_exit: true,
            notifications: false,
            workspace_root: std::path::PathBuf::from("/tmp/cache"),
            builder_bundle_root: std::path::PathBuf::from("/tmp/builder"),
            app_executable_path: std::path::PathBuf::from("/tmp/electron"),
            enable_wrapper_updates: false,
            wrapper_remote: String::new(),
            wrapper_branch: "main".to_string(),
            generated_artifact_cleanup: Default::default(),
        };

        let mut state = PersistedState::new(true);
        assert!(!upstream_check_is_fresh(&config, &state));

        state.last_successful_check_at = Some(Utc::now() - ChronoDuration::hours(1));
        assert!(upstream_check_is_fresh(&config, &state));

        state.last_successful_check_at = Some(Utc::now() - ChronoDuration::hours(7));
        assert!(!upstream_check_is_fresh(&config, &state));
    }

    #[test]
    fn interrupted_preinstall_states_retry_the_update_check() {
        for status in [
            UpdateStatus::Failed,
            UpdateStatus::DownloadingDmg,
            UpdateStatus::UpdateDetected,
            UpdateStatus::PreparingWorkspace,
            UpdateStatus::PatchingApp,
            UpdateStatus::BuildingPackage,
        ] {
            assert!(update_check_should_retry(&status), "status: {status:?}");
        }

        for status in [
            UpdateStatus::Idle,
            UpdateStatus::CheckingUpstream,
            UpdateStatus::ReadyToInstall,
            UpdateStatus::WaitingForAppExit,
            UpdateStatus::Installing,
            UpdateStatus::Installed,
        ] {
            assert!(!update_check_should_retry(&status), "status: {status:?}");
        }
    }

    #[test]
    fn upstream_check_setup_preserves_persisted_retry_intent() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let paths = test_paths(temp.path());
        paths.ensure_dirs()?;

        for status in [
            UpdateStatus::Failed,
            UpdateStatus::DownloadingDmg,
            UpdateStatus::UpdateDetected,
            UpdateStatus::PreparingWorkspace,
            UpdateStatus::PatchingApp,
            UpdateStatus::BuildingPackage,
        ] {
            let mut state = PersistedState::new(true);
            state.status = status.clone();
            state.error_message = Some("previous failure".to_string());

            assert!(prepare_upstream_check(&mut state, &paths)?);
            assert_eq!(state.status, status);
            assert!(state.last_check_at.is_some());
            assert_eq!(state.error_message, None);

            let persisted = PersistedState::load_or_default(&paths.state_file, true)?;
            assert_eq!(persisted.status, status);
        }

        let mut fresh_state = PersistedState::new(true);
        assert!(!prepare_upstream_check(&mut fresh_state, &paths)?);
        assert_eq!(fresh_state.status, UpdateStatus::CheckingUpstream);
        let persisted = PersistedState::load_or_default(&paths.state_file, true)?;
        assert_eq!(persisted.status, UpdateStatus::CheckingUpstream);
        Ok(())
    }

    #[test]
    fn disabled_wrapper_tracking_clears_stale_candidate() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let paths = test_paths(temp.path());
        paths.ensure_dirs()?;
        let config = test_config(temp.path());

        let mut state = PersistedState::new(true);
        state.installed_wrapper_commit = Some("installed".to_string());
        state.candidate_wrapper_commit = Some("stale".to_string());
        state.candidate_wrapper_version = Some("0.9.0".to_string());
        state.wrapper_changelog = Some("old changelog".to_string());
        state.wrapper_dev_mode = Some(true);

        let found = detect_and_record_wrapper_update(&config, &mut state, &paths)?;

        assert!(!found);
        assert_eq!(state.installed_wrapper_commit.as_deref(), Some("installed"));
        assert_eq!(state.candidate_wrapper_commit, None);
        assert_eq!(state.candidate_wrapper_version, None);
        assert_eq!(state.wrapper_changelog, None);
        assert_eq!(state.wrapper_dev_mode, None);

        let persisted = PersistedState::load_or_default(&paths.state_file, true)?;
        assert_eq!(persisted.candidate_wrapper_commit, None);
        assert_eq!(persisted.wrapper_changelog, None);
        assert_eq!(persisted.wrapper_dev_mode, None);
        Ok(())
    }

    #[test]
    fn no_wrapper_update_clears_stale_candidate() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let paths = test_paths(temp.path());
        paths.ensure_dirs()?;
        let mut config = test_config(temp.path());
        config.enable_wrapper_updates = true;
        std::fs::create_dir_all(&config.builder_bundle_root)?;

        let mut state = PersistedState::new(true);
        state.installed_wrapper_commit = Some("old-installed".to_string());
        state.candidate_wrapper_commit = Some("stale".to_string());
        state.candidate_wrapper_version = Some("0.9.0".to_string());
        state.wrapper_changelog = Some("old changelog".to_string());
        state.wrapper_dev_mode = Some(true);

        let found = detect_and_record_wrapper_update(&config, &mut state, &paths)?;

        assert!(!found);
        assert_eq!(state.installed_wrapper_commit, None);
        assert_eq!(state.installed_wrapper_version, None);
        assert_eq!(state.candidate_wrapper_commit, None);
        assert_eq!(state.candidate_wrapper_version, None);
        assert_eq!(state.wrapper_changelog, None);
        assert_eq!(state.wrapper_dev_mode, None);

        let persisted = PersistedState::load_or_default(&paths.state_file, true)?;
        assert_eq!(persisted.installed_wrapper_commit, None);
        assert_eq!(persisted.candidate_wrapper_commit, None);
        assert_eq!(persisted.wrapper_changelog, None);
        assert_eq!(persisted.wrapper_dev_mode, None);
        Ok(())
    }

    #[test]
    fn unknown_wrapper_detection_clears_stale_candidate_but_records_installed_metadata(
    ) -> Result<()> {
        let temp = tempfile::tempdir()?;
        let paths = test_paths(temp.path());
        paths.ensure_dirs()?;
        let mut config = test_config(temp.path());
        config.enable_wrapper_updates = true;
        std::fs::create_dir_all(config.builder_bundle_root.join(".codex-linux"))?;
        std::fs::write(
            config
                .builder_bundle_root
                .join(".codex-linux/source-info.json"),
            r#"{
  "commit": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "version": "0.8.1"
}
"#,
        )?;

        let mut state = PersistedState::new(true);
        state.candidate_wrapper_commit = Some("stale".to_string());
        state.candidate_wrapper_version = Some("0.9.0".to_string());
        state.wrapper_changelog = Some("old changelog".to_string());
        state.wrapper_dev_mode = Some(true);

        let found = detect_and_record_wrapper_update(&config, &mut state, &paths)?;

        assert!(!found);
        assert_eq!(
            state.installed_wrapper_commit.as_deref(),
            Some("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
        );
        assert_eq!(state.installed_wrapper_version.as_deref(), Some("0.8.1"));
        assert_eq!(state.candidate_wrapper_commit, None);
        assert_eq!(state.candidate_wrapper_version, None);
        assert_eq!(state.wrapper_changelog, None);
        assert_eq!(state.wrapper_dev_mode, None);
        Ok(())
    }

    #[tokio::test]
    async fn pending_dmg_update_still_clears_stale_wrapper_candidate() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let paths = test_paths(temp.path());
        paths.ensure_dirs()?;
        let config = test_config(temp.path());

        let mut state = PersistedState::new(true);
        state.status = UpdateStatus::ReadyToInstall;
        state.candidate_wrapper_commit = Some("stale".to_string());
        state.candidate_wrapper_version = Some("0.9.0".to_string());
        state.wrapper_changelog = Some("old changelog".to_string());
        state.wrapper_dev_mode = Some(true);

        run_check_cycle(&config, &mut state, &paths).await?;

        assert_eq!(state.status, UpdateStatus::ReadyToInstall);
        assert_eq!(state.candidate_wrapper_commit, None);
        assert_eq!(state.candidate_wrapper_version, None);
        assert_eq!(state.wrapper_changelog, None);
        assert_eq!(state.wrapper_dev_mode, None);
        let persisted = PersistedState::load_or_default(&paths.state_file, true)?;
        assert_eq!(persisted.candidate_wrapper_commit, None);
        assert_eq!(persisted.wrapper_changelog, None);
        assert_eq!(persisted.wrapper_dev_mode, None);
        Ok(())
    }

    #[test]
    fn fresh_check_now_still_clears_stale_wrapper_candidate() -> Result<()> {
        let _env_guard = crate::test_util::env_lock();
        let runtime = tokio::runtime::Runtime::new()?;
        let temp = tempfile::tempdir()?;
        let paths = test_paths(temp.path());
        paths.ensure_dirs()?;
        let config = test_config(temp.path());
        let _restore_env = crate::test_util::EnvRestoreGuard::capture(&[
            "HOME",
            "PATH",
            "NVM_DIR",
            "XDG_CONFIG_HOME",
            "CODEX_CLI_PATH",
            "CODEX_UPDATE_MANAGER_SKIP_SYSTEM_CLI_LOOKUP",
        ]);
        std::env::set_var("HOME", temp.path());
        std::env::set_var("PATH", temp.path().join("missing-bin"));
        std::env::remove_var("NVM_DIR");
        std::env::remove_var("XDG_CONFIG_HOME");
        std::env::remove_var("CODEX_CLI_PATH");
        std::env::set_var("CODEX_UPDATE_MANAGER_SKIP_SYSTEM_CLI_LOOKUP", "1");

        let mut state = PersistedState::new(true);
        state.last_successful_check_at = Some(Utc::now());
        state.candidate_wrapper_commit = Some("stale".to_string());
        state.candidate_wrapper_version = Some("0.9.0".to_string());
        state.wrapper_changelog = Some("old changelog".to_string());
        state.wrapper_dev_mode = Some(true);

        runtime.block_on(run_check_now(&config, &mut state, &paths, true))?;

        assert_eq!(state.status, UpdateStatus::Idle);
        assert_eq!(state.candidate_wrapper_commit, None);
        assert_eq!(state.candidate_wrapper_version, None);
        assert_eq!(state.wrapper_changelog, None);
        assert_eq!(state.wrapper_dev_mode, None);
        let persisted = PersistedState::load_or_default(&paths.state_file, true)?;
        assert_eq!(persisted.candidate_wrapper_commit, None);
        assert_eq!(persisted.wrapper_changelog, None);
        assert_eq!(persisted.wrapper_dev_mode, None);
        Ok(())
    }

    #[test]
    fn plain_status_reports_update_error() {
        let mut state = PersistedState::new(true);
        state.status = UpdateStatus::Failed;
        state.error_message = Some("install.sh failed during local rebuild".to_string());

        assert_eq!(
            update_error_status_line(&state),
            "update_error: install.sh failed during local rebuild"
        );

        state.error_message = None;
        assert_eq!(update_error_status_line(&state), "update_error: none");
    }

    #[tokio::test]
    async fn failed_state_with_existing_deb_stays_failed() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let paths = RuntimePaths {
            config_file: temp.path().join("config/config.toml"),
            state_file: temp.path().join("state/state.json"),
            log_file: temp.path().join("state/service.log"),
            cache_dir: temp.path().join("cache"),
            state_dir: temp.path().join("state"),
            config_dir: temp.path().join("config"),
        };
        paths.ensure_dirs()?;

        let package_path = temp.path().join("dist/codex.deb");
        std::fs::create_dir_all(
            package_path
                .parent()
                .expect("package path should have parent"),
        )?;
        std::fs::write(&package_path, b"deb")?;

        let config = RuntimeConfig {
            dmg_url: "https://example.com/Codex.dmg".to_string(),
            initial_check_delay_seconds: 1,
            check_interval_hours: 6,
            auto_install_on_app_exit: false,
            notifications: false,
            workspace_root: temp.path().join("cache"),
            builder_bundle_root: temp.path().join("builder"),
            app_executable_path: temp.path().join("not-running-electron"),
            enable_wrapper_updates: false,
            wrapper_remote: String::new(),
            wrapper_branch: "main".to_string(),
            generated_artifact_cleanup: Default::default(),
        };

        let mut state = PersistedState::new(false);
        state.status = UpdateStatus::Failed;
        state.candidate_version = Some("2999.03.25.010203+deadbeef".to_string());
        state.error_message = Some("previous failure".to_string());
        state.artifact_paths.package_path = Some(package_path);

        reconcile_pending_install(&config, &mut state, &paths).await?;

        assert_eq!(state.status, UpdateStatus::Failed);
        assert_eq!(state.error_message.as_deref(), Some("previous failure"));
        Ok(())
    }

    #[tokio::test]
    async fn run_check_cycle_skips_when_update_is_already_pending() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let paths = RuntimePaths {
            config_file: temp.path().join("config/config.toml"),
            state_file: temp.path().join("state/state.json"),
            log_file: temp.path().join("state/service.log"),
            cache_dir: temp.path().join("cache"),
            state_dir: temp.path().join("state"),
            config_dir: temp.path().join("config"),
        };
        paths.ensure_dirs()?;

        let config = RuntimeConfig {
            dmg_url: "https://invalid.example/Codex.dmg".to_string(),
            initial_check_delay_seconds: 1,
            check_interval_hours: 6,
            auto_install_on_app_exit: true,
            notifications: false,
            workspace_root: temp.path().join("cache"),
            builder_bundle_root: temp.path().join("builder"),
            app_executable_path: temp.path().join("not-running-electron"),
            enable_wrapper_updates: false,
            wrapper_remote: String::new(),
            wrapper_branch: "main".to_string(),
            generated_artifact_cleanup: Default::default(),
        };

        for status in [
            UpdateStatus::ReadyToInstall,
            UpdateStatus::WaitingForAppExit,
            UpdateStatus::Installing,
        ] {
            let mut state = PersistedState::new(true);
            state.status = status.clone();

            run_check_cycle(&config, &mut state, &paths).await?;

            assert_eq!(state.status, status);
            assert_eq!(state.last_check_at, None);
        }

        Ok(())
    }

    #[tokio::test]
    async fn daemon_check_cycle_reloads_pending_state_written_by_another_process() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let paths = test_paths(temp.path());
        paths.ensure_dirs()?;
        let mut config = test_config(temp.path());
        config.dmg_url = "https://invalid.example/Codex.dmg".to_string();

        let mut on_disk = PersistedState::new(true);
        on_disk.status = UpdateStatus::WaitingForAppExit;
        on_disk.candidate_version = Some("2999.03.25.010203+deadbeef".to_string());
        on_disk.waiting_for_app_exit_auto_install = true;
        on_disk.save(&paths.state_file)?;

        let mut stale_daemon_state = PersistedState::new(true);
        stale_daemon_state.status = UpdateStatus::Idle;

        run_check_cycle_from_disk(&config, &mut stale_daemon_state, &paths).await?;

        assert_eq!(stale_daemon_state.status, UpdateStatus::WaitingForAppExit);
        assert!(stale_daemon_state.waiting_for_app_exit_auto_install);
        assert_eq!(stale_daemon_state.last_check_at, None);
        Ok(())
    }

    #[tokio::test]
    async fn run_check_cycle_ignores_downloaded_dmg_already_installed() -> Result<()> {
        let server = MockServer::start().await;
        let body = b"codex-dmg-test-payload";
        let sha256 = "678cd508ffe0071e217020a7a4eecbebe25362c022ac78c13a5ae87b7a3a0c92";

        Mock::given(method("HEAD"))
            .and(path("/Codex.dmg"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("ETag", "\"same-dmg\"")
                    .insert_header("Content-Length", body.len().to_string()),
            )
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/Codex.dmg"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(body.to_vec()))
            .mount(&server)
            .await;

        let temp = tempfile::tempdir()?;
        let paths = test_paths(temp.path());
        paths.ensure_dirs()?;
        let mut config = test_config(temp.path());
        config.dmg_url = format!("{}/Codex.dmg", server.uri());
        write_installed_build_info(&config, sha256)?;

        let mut state = PersistedState::new(true);
        run_check_cycle(&config, &mut state, &paths).await?;

        let expected_dmg_path = config
            .workspace_root
            .join(format!("downloads/Codex-{sha256}.dmg"));
        assert_eq!(state.status, UpdateStatus::Idle);
        assert_eq!(state.candidate_version, None);
        assert_eq!(state.dmg_sha256.as_deref(), Some(sha256));
        assert_eq!(
            state.artifact_paths.dmg_path.as_deref(),
            Some(expected_dmg_path.as_path())
        );
        assert_eq!(state.artifact_paths.package_path, None);
        assert_eq!(state.artifact_paths.workspace_dir, None);
        assert_eq!(state.error_message, None);
        assert!(state.last_successful_check_at.is_some());
        Ok(())
    }

    #[tokio::test]
    async fn interrupted_download_with_cached_hash_reaches_build_path() -> Result<()> {
        let server = MockServer::start().await;
        let body = b"codex-dmg-test-payload";
        let sha256 = "678cd508ffe0071e217020a7a4eecbebe25362c022ac78c13a5ae87b7a3a0c92";
        let headers_fingerprint = format!(
            "etag=\"same-dmg\"|last_modified=|content_length={}",
            body.len()
        );

        Mock::given(method("HEAD"))
            .and(path("/Codex.dmg"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("ETag", "\"same-dmg\"")
                    .insert_header("Content-Length", body.len().to_string()),
            )
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/Codex.dmg"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(body.to_vec()))
            .expect(1)
            .mount(&server)
            .await;

        let temp = tempfile::tempdir()?;
        let paths = test_paths(temp.path());
        paths.ensure_dirs()?;
        let mut config = test_config(temp.path());
        config.dmg_url = format!("{}/Codex.dmg", server.uri());
        write_installed_build_info(
            &config,
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        )?;

        let mut state = PersistedState::new(true);
        state.status = UpdateStatus::DownloadingDmg;
        state.remote_headers_fingerprint = Some(headers_fingerprint);
        state.dmg_sha256 = Some(sha256.to_string());

        let error = run_check_cycle(&config, &mut state, &paths)
            .await
            .expect_err("retry should reach the intentionally missing builder bundle");
        server.verify().await;

        assert!(error
            .to_string()
            .contains("Required builder bundle path is missing"));
        assert_eq!(state.status, UpdateStatus::Failed);
        assert!(state.candidate_version.is_some());
        assert_eq!(state.dmg_sha256.as_deref(), Some(sha256));
        assert!(state.artifact_paths.workspace_dir.is_some());
        assert!(state
            .error_message
            .as_deref()
            .is_some_and(|message| message.contains("Required builder bundle path is missing")));
        assert!(state.last_successful_check_at.is_some());
        Ok(())
    }

    #[test]
    fn check_lock_file_without_kernel_lock_does_not_block_acquire() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let paths = RuntimePaths {
            config_file: temp.path().join("config/config.toml"),
            state_file: temp.path().join("state/state.json"),
            log_file: temp.path().join("state/service.log"),
            cache_dir: temp.path().join("cache"),
            state_dir: temp.path().join("state"),
            config_dir: temp.path().join("config"),
        };
        paths.ensure_dirs()?;
        let lock_path = paths.state_dir.join("check.lock");
        std::fs::write(&lock_path, b"stale-pid")?;

        let lock = try_acquire_check_lock(&paths)?;

        assert!(lock.is_some());
        assert_eq!(
            std::fs::read_to_string(&lock_path)?.trim(),
            std::process::id().to_string()
        );
        Ok(())
    }

    #[test]
    fn held_check_lock_blocks_second_acquire_until_drop() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let paths = RuntimePaths {
            config_file: temp.path().join("config/config.toml"),
            state_file: temp.path().join("state/state.json"),
            log_file: temp.path().join("state/service.log"),
            cache_dir: temp.path().join("cache"),
            state_dir: temp.path().join("state"),
            config_dir: temp.path().join("config"),
        };
        paths.ensure_dirs()?;

        let first_lock =
            try_acquire_check_lock(&paths)?.expect("first lock acquisition should succeed");
        let second_lock = try_acquire_check_lock(&paths)?;

        assert!(second_lock.is_none());
        drop(second_lock);
        drop(first_lock);

        let mut reacquired_lock = None;
        for _ in 0..20 {
            reacquired_lock = try_acquire_check_lock(&paths)?;
            if reacquired_lock.is_some() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }

        assert!(reacquired_lock.is_some());
        Ok(())
    }

    #[test]
    fn std_file_try_lock_reports_would_block_for_second_holder() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let lock_path = temp.path().join("check.lock");
        let first_file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&lock_path)?;
        let second_file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&lock_path)?;

        first_file.try_lock()?;
        let second_attempt = second_file.try_lock();

        assert!(matches!(
            second_attempt,
            Err(std::fs::TryLockError::WouldBlock)
        ));
        first_file.unlock()?;
        Ok(())
    }

    #[tokio::test]
    async fn missing_pending_package_marks_state_failed() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let paths = RuntimePaths {
            config_file: temp.path().join("config/config.toml"),
            state_file: temp.path().join("state/state.json"),
            log_file: temp.path().join("state/service.log"),
            cache_dir: temp.path().join("cache"),
            state_dir: temp.path().join("state"),
            config_dir: temp.path().join("config"),
        };
        paths.ensure_dirs()?;

        let config = RuntimeConfig {
            dmg_url: "https://example.com/Codex.dmg".to_string(),
            initial_check_delay_seconds: 1,
            check_interval_hours: 6,
            auto_install_on_app_exit: true,
            notifications: false,
            workspace_root: temp.path().join("cache"),
            builder_bundle_root: temp.path().join("builder"),
            app_executable_path: temp.path().join("not-running-electron"),
            enable_wrapper_updates: false,
            wrapper_remote: String::new(),
            wrapper_branch: "main".to_string(),
            generated_artifact_cleanup: Default::default(),
        };

        let mut state = PersistedState::new(true);
        state.status = UpdateStatus::ReadyToInstall;
        state.candidate_version = Some("2999.03.25.010203+deadbeef".to_string());
        state.artifact_paths.package_path = Some(temp.path().join("missing/codex.deb"));

        reconcile_pending_install(&config, &mut state, &paths).await?;

        assert_eq!(state.status, UpdateStatus::Failed);
        assert!(state
            .error_message
            .as_deref()
            .is_some_and(|message| message.contains("Pending package artifact is missing")));
        Ok(())
    }

    #[test]
    fn ready_update_waits_for_explicit_install_ready_when_auto_install_is_off() -> Result<()> {
        let _env_guard = crate::test_util::env_lock();
        let runtime = tokio::runtime::Runtime::new()?;
        let temp = tempfile::tempdir()?;
        let paths = RuntimePaths {
            config_file: temp.path().join("config/config.toml"),
            state_file: temp.path().join("state/state.json"),
            log_file: temp.path().join("state/service.log"),
            cache_dir: temp.path().join("cache"),
            state_dir: temp.path().join("state"),
            config_dir: temp.path().join("config"),
        };
        paths.ensure_dirs()?;
        let settings_path = temp.path().join("settings.json");
        let previous_settings_file = std::env::var_os("CODEX_LINUX_SETTINGS_FILE");
        std::env::set_var("CODEX_LINUX_SETTINGS_FILE", &settings_path);
        std::fs::write(
            &settings_path,
            r#"{"codex-linux-auto-update-on-exit": false}"#,
        )?;

        let package_path = temp.path().join("dist/codex.deb");
        std::fs::create_dir_all(
            package_path
                .parent()
                .expect("package path should have parent"),
        )?;
        std::fs::write(&package_path, b"deb")?;

        let config = RuntimeConfig {
            dmg_url: "https://example.com/Codex.dmg".to_string(),
            initial_check_delay_seconds: 1,
            check_interval_hours: 6,
            auto_install_on_app_exit: false,
            notifications: false,
            workspace_root: temp.path().join("cache"),
            builder_bundle_root: temp.path().join("builder"),
            app_executable_path: temp.path().join("not-running-electron"),
            enable_wrapper_updates: false,
            wrapper_remote: String::new(),
            wrapper_branch: "main".to_string(),
            generated_artifact_cleanup: Default::default(),
        };

        let mut state = PersistedState::new(false);
        state.status = UpdateStatus::ReadyToInstall;
        state.candidate_version = Some("2999.03.25.010203+deadbeef".to_string());
        state.artifact_paths.package_path = Some(package_path);

        let result = runtime.block_on(reconcile_pending_install(&config, &mut state, &paths));

        if let Some(value) = previous_settings_file {
            std::env::set_var("CODEX_LINUX_SETTINGS_FILE", value);
        } else {
            std::env::remove_var("CODEX_LINUX_SETTINGS_FILE");
        }

        result?;
        assert_eq!(state.status, UpdateStatus::ReadyToInstall);
        assert_eq!(state.error_message, None);
        Ok(())
    }

    #[test]
    fn ready_update_auto_install_waits_for_app_exit_when_app_is_running() -> Result<()> {
        let _env_guard = crate::test_util::env_lock();
        let runtime = tokio::runtime::Runtime::new()?;
        let temp = tempfile::tempdir()?;
        let paths = RuntimePaths {
            config_file: temp.path().join("config/config.toml"),
            state_file: temp.path().join("state/state.json"),
            log_file: temp.path().join("state/service.log"),
            cache_dir: temp.path().join("cache"),
            state_dir: temp.path().join("state"),
            config_dir: temp.path().join("config"),
        };
        paths.ensure_dirs()?;
        let settings_path = temp.path().join("settings.json");
        let previous_settings_file = std::env::var_os("CODEX_LINUX_SETTINGS_FILE");
        let previous_assume_agent = std::env::var_os("CODEX_UPDATE_MANAGER_ASSUME_POLKIT_AGENT");
        std::env::set_var("CODEX_LINUX_SETTINGS_FILE", &settings_path);
        std::env::set_var("CODEX_UPDATE_MANAGER_ASSUME_POLKIT_AGENT", "1");
        std::fs::write(
            &settings_path,
            r#"{"codex-linux-auto-update-on-exit": true}"#,
        )?;

        let package_path = temp.path().join("dist/codex.deb");
        std::fs::create_dir_all(
            package_path
                .parent()
                .expect("package path should have parent"),
        )?;
        std::fs::write(&package_path, b"deb")?;

        let config = RuntimeConfig {
            dmg_url: "https://example.com/Codex.dmg".to_string(),
            initial_check_delay_seconds: 1,
            check_interval_hours: 6,
            auto_install_on_app_exit: true,
            notifications: false,
            workspace_root: temp.path().join("cache"),
            builder_bundle_root: temp.path().join("builder"),
            app_executable_path: std::env::current_exe()?,
            enable_wrapper_updates: false,
            wrapper_remote: String::new(),
            wrapper_branch: "main".to_string(),
            generated_artifact_cleanup: Default::default(),
        };

        let mut state = PersistedState::new(true);
        state.status = UpdateStatus::ReadyToInstall;
        state.candidate_version = Some("2999.03.25.010203+deadbeef".to_string());
        state.artifact_paths.package_path = Some(package_path);
        state
            .notified_events
            .insert("install_auth_required:2999.03.25.010203+deadbeef".to_string());

        let result = runtime.block_on(reconcile_pending_install(&config, &mut state, &paths));

        if let Some(value) = previous_settings_file {
            std::env::set_var("CODEX_LINUX_SETTINGS_FILE", value);
        } else {
            std::env::remove_var("CODEX_LINUX_SETTINGS_FILE");
        }
        if let Some(value) = previous_assume_agent {
            std::env::set_var("CODEX_UPDATE_MANAGER_ASSUME_POLKIT_AGENT", value);
        } else {
            std::env::remove_var("CODEX_UPDATE_MANAGER_ASSUME_POLKIT_AGENT");
        }

        result?;
        assert_eq!(state.status, UpdateStatus::WaitingForAppExit);
        assert!(state.waiting_for_app_exit_auto_install);
        assert!(!install_auth_retry_is_blocked(&state));
        Ok(())
    }

    #[test]
    fn daemon_reconcile_reloads_waiting_state_written_by_another_process() -> Result<()> {
        let _env_guard = crate::test_util::env_lock();
        let _restore_env = crate::test_util::EnvRestoreGuard::capture(&[
            "CODEX_UPDATE_MANAGER_ASSUME_NO_POLKIT_AGENT",
            "CODEX_LINUX_SETTINGS_FILE",
        ]);
        let runtime = tokio::runtime::Runtime::new()?;
        std::env::set_var("CODEX_UPDATE_MANAGER_ASSUME_NO_POLKIT_AGENT", "1");

        let temp = tempfile::tempdir()?;
        std::env::set_var(
            "CODEX_LINUX_SETTINGS_FILE",
            temp.path().join("isolated-settings.json"),
        );
        let paths = test_paths(temp.path());
        paths.ensure_dirs()?;
        let config = test_config(temp.path());

        let package_path = temp.path().join("dist/codex.deb");
        std::fs::create_dir_all(
            package_path
                .parent()
                .expect("package path should have parent"),
        )?;
        std::fs::write(&package_path, b"deb")?;

        let mut on_disk = PersistedState::new(true);
        on_disk.status = UpdateStatus::WaitingForAppExit;
        on_disk.candidate_version = Some("2999.03.25.010203+deadbeef".to_string());
        on_disk.waiting_for_app_exit_auto_install = true;
        on_disk.artifact_paths.package_path = Some(package_path);
        on_disk.save(&paths.state_file)?;

        let mut stale_daemon_state = PersistedState::new(true);
        stale_daemon_state.status = UpdateStatus::Idle;

        let result = runtime.block_on(reconcile_pending_install_from_disk(
            &config,
            &mut stale_daemon_state,
            &paths,
        ));

        result?;
        assert_eq!(stale_daemon_state.status, UpdateStatus::ReadyToInstall);
        assert!(!stale_daemon_state.waiting_for_app_exit_auto_install);
        assert!(stale_daemon_state
            .error_message
            .as_deref()
            .unwrap_or_default()
            .contains("No graphical polkit authentication agent"));

        let persisted = PersistedState::load_or_default(&paths.state_file, true)?;
        assert_eq!(persisted.status, UpdateStatus::ReadyToInstall);
        assert!(!persisted.waiting_for_app_exit_auto_install);
        Ok(())
    }

    #[test]
    fn waiting_for_app_exit_auto_install_cancelled_when_setting_turns_off() -> Result<()> {
        let _env_guard = crate::test_util::env_lock();
        let runtime = tokio::runtime::Runtime::new()?;
        let temp = tempfile::tempdir()?;
        let paths = RuntimePaths {
            config_file: temp.path().join("config/config.toml"),
            state_file: temp.path().join("state/state.json"),
            log_file: temp.path().join("state/service.log"),
            cache_dir: temp.path().join("cache"),
            state_dir: temp.path().join("state"),
            config_dir: temp.path().join("config"),
        };
        paths.ensure_dirs()?;
        let settings_path = temp.path().join("settings.json");
        let previous_settings_file = std::env::var_os("CODEX_LINUX_SETTINGS_FILE");
        std::env::set_var("CODEX_LINUX_SETTINGS_FILE", &settings_path);
        std::fs::write(
            &settings_path,
            r#"{"codex-linux-auto-update-on-exit": false}"#,
        )?;

        let package_path = temp.path().join("dist/codex.deb");
        std::fs::create_dir_all(
            package_path
                .parent()
                .expect("package path should have parent"),
        )?;
        std::fs::write(&package_path, b"deb")?;

        let config = RuntimeConfig {
            dmg_url: "https://example.com/Codex.dmg".to_string(),
            initial_check_delay_seconds: 1,
            check_interval_hours: 6,
            auto_install_on_app_exit: true,
            notifications: false,
            workspace_root: temp.path().join("cache"),
            builder_bundle_root: temp.path().join("builder"),
            app_executable_path: std::env::current_exe()?,
            enable_wrapper_updates: false,
            wrapper_remote: String::new(),
            wrapper_branch: "main".to_string(),
            generated_artifact_cleanup: Default::default(),
        };

        let mut state = PersistedState::new(true);
        state.status = UpdateStatus::WaitingForAppExit;
        state.waiting_for_app_exit_auto_install = true;
        state.candidate_version = Some("2999.03.25.010203+deadbeef".to_string());
        state.artifact_paths.package_path = Some(package_path);

        let result = runtime.block_on(reconcile_pending_install(&config, &mut state, &paths));

        if let Some(value) = previous_settings_file {
            std::env::set_var("CODEX_LINUX_SETTINGS_FILE", value);
        } else {
            std::env::remove_var("CODEX_LINUX_SETTINGS_FILE");
        }

        result?;
        assert_eq!(state.status, UpdateStatus::ReadyToInstall);
        assert!(!state.auto_install_on_app_exit);
        assert!(!state.waiting_for_app_exit_auto_install);
        assert_eq!(state.error_message, None);
        assert!(state.artifact_paths.package_path.is_some());
        Ok(())
    }

    #[test]
    fn waiting_for_app_exit_manual_install_survives_auto_toggle_off() -> Result<()> {
        let _env_guard = crate::test_util::env_lock();
        let runtime = tokio::runtime::Runtime::new()?;
        let temp = tempfile::tempdir()?;
        let paths = RuntimePaths {
            config_file: temp.path().join("config/config.toml"),
            state_file: temp.path().join("state/state.json"),
            log_file: temp.path().join("state/service.log"),
            cache_dir: temp.path().join("cache"),
            state_dir: temp.path().join("state"),
            config_dir: temp.path().join("config"),
        };
        paths.ensure_dirs()?;
        let settings_path = temp.path().join("settings.json");
        let previous_settings_file = std::env::var_os("CODEX_LINUX_SETTINGS_FILE");
        let previous_assume_agent = std::env::var_os("CODEX_UPDATE_MANAGER_ASSUME_POLKIT_AGENT");
        std::env::set_var("CODEX_LINUX_SETTINGS_FILE", &settings_path);
        std::env::set_var("CODEX_UPDATE_MANAGER_ASSUME_POLKIT_AGENT", "1");
        std::fs::write(
            &settings_path,
            r#"{"codex-linux-auto-update-on-exit": false}"#,
        )?;

        let package_path = temp.path().join("dist/codex.deb");
        std::fs::create_dir_all(
            package_path
                .parent()
                .expect("package path should have parent"),
        )?;
        std::fs::write(&package_path, b"deb")?;

        let config = RuntimeConfig {
            dmg_url: "https://example.com/Codex.dmg".to_string(),
            initial_check_delay_seconds: 1,
            check_interval_hours: 6,
            auto_install_on_app_exit: true,
            notifications: false,
            workspace_root: temp.path().join("cache"),
            builder_bundle_root: temp.path().join("builder"),
            app_executable_path: std::env::current_exe()?,
            enable_wrapper_updates: false,
            wrapper_remote: String::new(),
            wrapper_branch: "main".to_string(),
            generated_artifact_cleanup: Default::default(),
        };

        let mut state = PersistedState::new(false);
        state.status = UpdateStatus::WaitingForAppExit;
        state.waiting_for_app_exit_auto_install = false;
        state.candidate_version = Some("2999.03.25.010203+deadbeef".to_string());
        state.artifact_paths.package_path = Some(package_path);

        let result = runtime.block_on(reconcile_pending_install(&config, &mut state, &paths));

        if let Some(value) = previous_settings_file {
            std::env::set_var("CODEX_LINUX_SETTINGS_FILE", value);
        } else {
            std::env::remove_var("CODEX_LINUX_SETTINGS_FILE");
        }
        if let Some(value) = previous_assume_agent {
            std::env::set_var("CODEX_UPDATE_MANAGER_ASSUME_POLKIT_AGENT", value);
        } else {
            std::env::remove_var("CODEX_UPDATE_MANAGER_ASSUME_POLKIT_AGENT");
        }

        result?;
        assert_eq!(state.status, UpdateStatus::WaitingForAppExit);
        assert!(!state.auto_install_on_app_exit);
        assert!(!state.waiting_for_app_exit_auto_install);
        assert_eq!(state.error_message, None);
        Ok(())
    }

    #[test]
    fn reconcile_reloads_auto_install_setting_override() -> Result<()> {
        let _env_guard = crate::test_util::env_lock();
        let runtime = tokio::runtime::Runtime::new()?;
        let temp = tempfile::tempdir()?;
        let paths = RuntimePaths {
            config_file: temp.path().join("config/config.toml"),
            state_file: temp.path().join("state/state.json"),
            log_file: temp.path().join("state/service.log"),
            cache_dir: temp.path().join("cache"),
            state_dir: temp.path().join("state"),
            config_dir: temp.path().join("config"),
        };
        paths.ensure_dirs()?;
        let settings_path = temp.path().join("settings.json");

        let previous_settings_file = std::env::var_os("CODEX_LINUX_SETTINGS_FILE");
        std::env::set_var("CODEX_LINUX_SETTINGS_FILE", &settings_path);

        let config = RuntimeConfig {
            dmg_url: "https://example.com/Codex.dmg".to_string(),
            initial_check_delay_seconds: 1,
            check_interval_hours: 6,
            auto_install_on_app_exit: true,
            notifications: false,
            workspace_root: temp.path().join("cache"),
            builder_bundle_root: temp.path().join("builder"),
            app_executable_path: temp.path().join("not-running-electron"),
            enable_wrapper_updates: false,
            wrapper_remote: String::new(),
            wrapper_branch: "main".to_string(),
            generated_artifact_cleanup: Default::default(),
        };

        let mut state = PersistedState::new(true);

        std::fs::write(
            &settings_path,
            r#"{"codex-linux-auto-update-on-exit": false}"#,
        )?;
        let first_result = runtime.block_on(reconcile_pending_install(&config, &mut state, &paths));
        assert!(!state.auto_install_on_app_exit);

        std::fs::write(
            &settings_path,
            r#"{"codex-linux-auto-update-on-exit": true}"#,
        )?;
        let second_result =
            runtime.block_on(reconcile_pending_install(&config, &mut state, &paths));

        if let Some(value) = previous_settings_file {
            std::env::set_var("CODEX_LINUX_SETTINGS_FILE", value);
        } else {
            std::env::remove_var("CODEX_LINUX_SETTINGS_FILE");
        }

        first_result?;
        second_result?;
        assert!(state.auto_install_on_app_exit);
        Ok(())
    }

    #[test]
    fn install_ready_waits_when_app_is_running() -> Result<()> {
        let _env_guard = crate::test_util::env_lock();
        let runtime = tokio::runtime::Runtime::new()?;
        let previous_assume_agent = std::env::var_os("CODEX_UPDATE_MANAGER_ASSUME_POLKIT_AGENT");
        std::env::set_var("CODEX_UPDATE_MANAGER_ASSUME_POLKIT_AGENT", "1");
        let temp = tempfile::tempdir()?;
        let paths = RuntimePaths {
            config_file: temp.path().join("config/config.toml"),
            state_file: temp.path().join("state/state.json"),
            log_file: temp.path().join("state/service.log"),
            cache_dir: temp.path().join("cache"),
            state_dir: temp.path().join("state"),
            config_dir: temp.path().join("config"),
        };
        paths.ensure_dirs()?;

        let package_path = temp.path().join("dist/codex.deb");
        std::fs::create_dir_all(
            package_path
                .parent()
                .expect("package path should have parent"),
        )?;
        std::fs::write(&package_path, b"deb")?;

        let config = RuntimeConfig {
            dmg_url: "https://example.com/Codex.dmg".to_string(),
            initial_check_delay_seconds: 1,
            check_interval_hours: 6,
            auto_install_on_app_exit: false,
            notifications: false,
            workspace_root: temp.path().join("cache"),
            builder_bundle_root: temp.path().join("builder"),
            app_executable_path: std::env::current_exe()?,
            enable_wrapper_updates: false,
            wrapper_remote: String::new(),
            wrapper_branch: "main".to_string(),
            generated_artifact_cleanup: Default::default(),
        };

        let mut state = PersistedState::new(false);
        state.status = UpdateStatus::ReadyToInstall;
        state.candidate_version = Some("2999.03.25.010203+deadbeef".to_string());
        state.artifact_paths.package_path = Some(package_path);
        state
            .notified_events
            .insert("install_auth_required:2999.03.25.010203+deadbeef".to_string());

        let result = runtime.block_on(run_install_ready(&config, &mut state, &paths));

        if let Some(value) = previous_assume_agent {
            std::env::set_var("CODEX_UPDATE_MANAGER_ASSUME_POLKIT_AGENT", value);
        } else {
            std::env::remove_var("CODEX_UPDATE_MANAGER_ASSUME_POLKIT_AGENT");
        }

        result?;

        assert_eq!(state.status, UpdateStatus::WaitingForAppExit);
        assert!(!state.waiting_for_app_exit_auto_install);
        assert!(!install_auth_retry_is_blocked(&state));
        Ok(())
    }

    #[test]
    fn install_ready_stays_open_when_no_polkit_agent_is_available() -> Result<()> {
        let _env_guard = crate::test_util::env_lock();
        let runtime = tokio::runtime::Runtime::new()?;
        let previous_no_agent = std::env::var_os("CODEX_UPDATE_MANAGER_ASSUME_NO_POLKIT_AGENT");
        std::env::set_var("CODEX_UPDATE_MANAGER_ASSUME_NO_POLKIT_AGENT", "1");
        let temp = tempfile::tempdir()?;
        let paths = RuntimePaths {
            config_file: temp.path().join("config/config.toml"),
            state_file: temp.path().join("state/state.json"),
            log_file: temp.path().join("state/service.log"),
            cache_dir: temp.path().join("cache"),
            state_dir: temp.path().join("state"),
            config_dir: temp.path().join("config"),
        };
        paths.ensure_dirs()?;

        let package_path = temp.path().join("dist/codex desktop.pkg.tar.zst");
        std::fs::create_dir_all(
            package_path
                .parent()
                .expect("package path should have parent"),
        )?;
        std::fs::write(&package_path, b"pkg")?;

        let config = RuntimeConfig {
            dmg_url: "https://example.com/Codex.dmg".to_string(),
            initial_check_delay_seconds: 1,
            check_interval_hours: 6,
            auto_install_on_app_exit: false,
            notifications: false,
            workspace_root: temp.path().join("cache"),
            builder_bundle_root: temp.path().join("builder"),
            app_executable_path: std::env::current_exe()?,
            enable_wrapper_updates: false,
            wrapper_remote: String::new(),
            wrapper_branch: "main".to_string(),
            generated_artifact_cleanup: Default::default(),
        };

        let mut state = PersistedState::new(false);
        state.status = UpdateStatus::ReadyToInstall;
        state.candidate_version = Some("2999.03.25.010203+deadbeef".to_string());
        state.artifact_paths.package_path = Some(package_path);

        let result = runtime.block_on(run_install_ready(&config, &mut state, &paths));

        if let Some(value) = previous_no_agent {
            std::env::set_var("CODEX_UPDATE_MANAGER_ASSUME_NO_POLKIT_AGENT", value);
        } else {
            std::env::remove_var("CODEX_UPDATE_MANAGER_ASSUME_NO_POLKIT_AGENT");
        }

        result?;
        assert_eq!(state.status, UpdateStatus::ReadyToInstall);
        assert!(!state.waiting_for_app_exit_auto_install);
        let message = state.error_message.as_deref().unwrap_or("");
        assert!(message.contains("No graphical polkit authentication agent"));
        assert!(message.contains("sudo /usr/bin/codex-update-manager install-pacman"));
        assert!(message.contains("codex desktop.pkg.tar.zst'"));
        Ok(())
    }

    #[tokio::test]
    async fn install_ready_marks_missing_artifact_failed() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let paths = RuntimePaths {
            config_file: temp.path().join("config/config.toml"),
            state_file: temp.path().join("state/state.json"),
            log_file: temp.path().join("state/service.log"),
            cache_dir: temp.path().join("cache"),
            state_dir: temp.path().join("state"),
            config_dir: temp.path().join("config"),
        };
        paths.ensure_dirs()?;

        let config = RuntimeConfig {
            dmg_url: "https://example.com/Codex.dmg".to_string(),
            initial_check_delay_seconds: 1,
            check_interval_hours: 6,
            auto_install_on_app_exit: false,
            notifications: false,
            workspace_root: temp.path().join("cache"),
            builder_bundle_root: temp.path().join("builder"),
            app_executable_path: temp.path().join("not-running-electron"),
            enable_wrapper_updates: false,
            wrapper_remote: String::new(),
            wrapper_branch: "main".to_string(),
            generated_artifact_cleanup: Default::default(),
        };

        let mut state = PersistedState::new(false);
        state.status = UpdateStatus::ReadyToInstall;
        state.candidate_version = Some("2999.03.25.010203+deadbeef".to_string());
        state.artifact_paths.package_path = Some(temp.path().join("missing/codex.deb"));

        run_install_ready(&config, &mut state, &paths).await?;

        assert_eq!(state.status, UpdateStatus::Failed);
        assert!(state
            .error_message
            .as_deref()
            .is_some_and(|message| message.contains("Pending package artifact is missing")));
        Ok(())
    }

    #[test]
    fn pkexec_authentication_failures_are_retryable() -> Result<()> {
        for code in [126, 127] {
            let status = std::process::Command::new("/bin/sh")
                .arg("-c")
                .arg(format!("exit {code}"))
                .status()?;
            assert!(pkexec_authentication_was_not_obtained(&status));
        }

        let status = std::process::Command::new("/bin/sh")
            .arg("-c")
            .arg("exit 1")
            .status()?;
        assert!(!pkexec_authentication_was_not_obtained(&status));
        Ok(())
    }

    #[test]
    fn polkit_agent_process_matching_ignores_daemon_and_matches_agents() {
        assert!(process_text_matches_polkit_auth_agent(
            "/usr/lib/polkit-kde-authentication-agent-1"
        ));
        assert!(process_text_matches_polkit_auth_agent(
            "/usr/lib/polkit-gnome-authentication-agent-1"
        ));
        assert!(process_text_matches_polkit_auth_agent("cosmic-osd"));
        assert!(process_text_matches_polkit_auth_agent(
            "gnome-shell --wayland"
        ));
        assert!(!process_text_matches_polkit_auth_agent(
            "/usr/lib/polkit-1/polkitd --no-debug"
        ));
        assert!(!process_text_matches_polkit_auth_agent(
            "/usr/bin/ssh-agent -D"
        ));
    }

    #[test]
    fn user_session_bus_for_polkit_allows_user_service_env_without_display() {
        let _env_guard = crate::test_util::env_lock();
        let _restore_env = crate::test_util::EnvRestoreGuard::capture(&[
            "DISPLAY",
            "WAYLAND_DISPLAY",
            "DBUS_SESSION_BUS_ADDRESS",
            "XDG_RUNTIME_DIR",
        ]);

        std::env::remove_var("DISPLAY");
        std::env::remove_var("WAYLAND_DISPLAY");
        std::env::set_var("DBUS_SESSION_BUS_ADDRESS", "unix:path=/run/user/1000/bus");
        std::env::set_var("XDG_RUNTIME_DIR", "/run/user/1000");

        assert!(has_user_session_bus_for_polkit());
    }

    #[test]
    fn manual_install_command_selects_package_kind_and_quotes_path() {
        assert_eq!(
            manual_install_command(Path::new("/tmp/codex update.pkg.tar.zst")),
            "sudo /usr/bin/codex-update-manager install-pacman --path '/tmp/codex update.pkg.tar.zst'"
        );
        assert_eq!(
            manual_install_command(Path::new("/tmp/codex'update.deb")),
            "sudo /usr/bin/codex-update-manager install-deb --path '/tmp/codex'\\''update.deb'"
        );
    }

    #[test]
    fn command_lookup_requires_executable_file() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let candidate = temp.path().join("zenity");
        std::fs::write(&candidate, b"#!/bin/sh\n")?;

        let mut permissions = std::fs::metadata(&candidate)?.permissions();
        permissions.set_mode(0o644);
        std::fs::set_permissions(&candidate, permissions)?;

        assert!(!is_executable_file(&candidate));

        let mut permissions = std::fs::metadata(&candidate)?.permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&candidate, permissions)?;

        assert!(is_executable_file(&candidate));
        Ok(())
    }

    #[test]
    fn prompt_install_cli_does_not_treat_non_executable_file_as_installed() -> Result<()> {
        let _env_guard = crate::test_util::env_lock();
        let temp = tempfile::tempdir()?;
        let paths = RuntimePaths {
            config_file: temp.path().join("config/config.toml"),
            state_file: temp.path().join("state/state.json"),
            log_file: temp.path().join("state/service.log"),
            cache_dir: temp.path().join("cache"),
            state_dir: temp.path().join("state"),
            config_dir: temp.path().join("config"),
        };
        paths.ensure_dirs()?;

        let _restore_env = crate::test_util::EnvRestoreGuard::capture(&[
            "DISPLAY",
            "WAYLAND_DISPLAY",
            "DBUS_SESSION_BUS_ADDRESS",
            "XDG_RUNTIME_DIR",
            "PATH",
            "HOME",
            "NVM_DIR",
            "CODEX_UPDATE_MANAGER_SKIP_SYSTEM_CLI_LOOKUP",
        ]);

        std::env::remove_var("DISPLAY");
        std::env::remove_var("WAYLAND_DISPLAY");
        std::env::remove_var("DBUS_SESSION_BUS_ADDRESS");
        std::env::remove_var("XDG_RUNTIME_DIR");
        std::env::set_var("PATH", temp.path().join("missing-bin"));
        std::env::set_var("HOME", temp.path());
        std::env::remove_var("NVM_DIR");
        std::env::set_var("CODEX_UPDATE_MANAGER_SKIP_SYSTEM_CLI_LOOKUP", "1");

        let invalid_cli_path = temp.path().join("codex.txt");
        std::fs::write(&invalid_cli_path, b"not executable")?;

        let mut state = PersistedState::new(true);
        state.cli_path = Some(invalid_cli_path);

        let outcome = prompt_install_cli(&mut state, &paths, None)?;

        assert_eq!(outcome, PromptInstallCliOutcome::NoBackend);
        Ok(())
    }

    #[test]
    fn install_auth_retry_block_is_scoped_to_candidate() {
        let mut state = PersistedState::new(true);
        state.candidate_version = Some("2026.04.28.082247+abcdef12".to_string());

        assert!(!install_auth_retry_is_blocked(&state));

        state
            .notified_events
            .insert("install_auth_required:2026.04.28.082247+abcdef12".to_string());
        assert!(install_auth_retry_is_blocked(&state));

        state.candidate_version = Some("2026.04.29.010203+abcdef12".to_string());
        assert!(!install_auth_retry_is_blocked(&state));
    }

    #[test]
    fn clear_install_auth_required_event_keeps_unrelated_notifications() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let paths = RuntimePaths {
            config_file: temp.path().join("config/config.toml"),
            state_file: temp.path().join("state/state.json"),
            log_file: temp.path().join("state/service.log"),
            cache_dir: temp.path().join("cache"),
            state_dir: temp.path().join("state"),
            config_dir: temp.path().join("config"),
        };
        paths.ensure_dirs()?;

        let mut state = PersistedState::new(true);
        state.candidate_version = Some("2026.04.28.082247+abcdef12".to_string());
        state
            .notified_events
            .insert("install_auth_required:2026.04.28.082247+abcdef12".to_string());
        state
            .notified_events
            .insert("installed:2026.04.25.054929+12345678".to_string());

        clear_install_auth_required_event(&mut state, &paths)?;

        assert!(!install_auth_retry_is_blocked(&state));
        assert!(state
            .notified_events
            .contains("installed:2026.04.25.054929+12345678"));
        Ok(())
    }

    #[test]
    fn in_progress_same_dmg_update_is_cleared_as_current() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let paths = test_paths(temp.path());
        paths.ensure_dirs()?;
        let config = test_config(temp.path());
        let sha256 = "51eeeba58394c4747cbc9d9fee7aa613500253fedd7ad5b114f48dfcb89a6cbb";
        write_installed_build_info(&config, sha256)?;

        let package_path = temp
            .path()
            .join("cache/workspaces/2026.06.12.120204+51eeeba5/dist/codex.pkg.tar.zst");

        let mut state = PersistedState::new(true);
        state.status = UpdateStatus::PatchingApp;
        state.installed_version = "2026.06.12.094134-1".to_string();
        state.candidate_version = Some("2026.06.12.120204+51eeeba5".to_string());
        state.dmg_sha256 = Some(sha256.to_string());
        state.artifact_paths.package_path = Some(package_path);
        state.artifact_paths.workspace_dir = Some(
            temp.path()
                .join("cache/workspaces/2026.06.12.120204+51eeeba5"),
        );
        state.error_message = Some("interrupted rebuild".to_string());
        state
            .notified_events
            .insert("update_detected:2026.06.12.120204+51eeeba5".to_string());

        assert!(complete_current_dmg_update_if_already_installed(
            &config, &mut state, &paths
        )?);

        assert_eq!(state.status, UpdateStatus::Idle);
        assert_eq!(state.candidate_version, None);
        assert_eq!(state.dmg_sha256.as_deref(), Some(sha256));
        assert_eq!(state.artifact_paths.package_path, None);
        assert_eq!(state.artifact_paths.workspace_dir, None);
        assert_eq!(state.error_message, None);
        assert!(state.notified_events.is_empty());
        Ok(())
    }

    #[test]
    fn in_progress_different_dmg_update_is_not_cleared() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let paths = test_paths(temp.path());
        paths.ensure_dirs()?;
        let config = test_config(temp.path());
        write_installed_build_info(
            &config,
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        )?;

        let mut state = PersistedState::new(true);
        state.status = UpdateStatus::PatchingApp;
        state.candidate_version = Some("2026.06.12.120204+51eeeba5".to_string());
        state.dmg_sha256 =
            Some("51eeeba58394c4747cbc9d9fee7aa613500253fedd7ad5b114f48dfcb89a6cbb".to_string());
        state
            .notified_events
            .insert("update_detected:2026.06.12.120204+51eeeba5".to_string());

        assert!(!complete_current_dmg_update_if_already_installed(
            &config, &mut state, &paths
        )?);

        assert_eq!(state.status, UpdateStatus::PatchingApp);
        assert_eq!(
            state.candidate_version.as_deref(),
            Some("2026.06.12.120204+51eeeba5")
        );
        assert!(state
            .notified_events
            .contains("update_detected:2026.06.12.120204+51eeeba5"));
        Ok(())
    }

    #[test]
    fn same_dmg_recovery_keeps_ready_wrapper_update_package() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let paths = test_paths(temp.path());
        paths.ensure_dirs()?;
        let config = test_config(temp.path());
        let sha256 = "51eeeba58394c4747cbc9d9fee7aa613500253fedd7ad5b114f48dfcb89a6cbb";
        write_installed_build_info(&config, sha256)?;

        let package_path = temp.path().join("dist/codex-desktop-wrapper.deb");
        let workspace_dir = temp
            .path()
            .join("cache/workspaces/2026.06.12.120204+51eeeba5");
        let wrapper_commit = "b".repeat(40);

        let mut state = PersistedState::new(true);
        state.status = UpdateStatus::ReadyToInstall;
        state.dmg_sha256 = Some(sha256.to_string());
        state.candidate_wrapper_commit = Some(wrapper_commit.clone());
        state.candidate_wrapper_version = Some("0.9.0".to_string());
        state.artifact_paths.package_path = Some(package_path.clone());
        state.artifact_paths.workspace_dir = Some(workspace_dir.clone());

        assert!(!complete_current_dmg_update_if_already_installed(
            &config, &mut state, &paths
        )?);

        assert_eq!(state.status, UpdateStatus::ReadyToInstall);
        assert_eq!(state.candidate_version, None);
        assert_eq!(state.dmg_sha256.as_deref(), Some(sha256));
        assert_eq!(
            state.candidate_wrapper_commit.as_deref(),
            Some(wrapper_commit.as_str())
        );
        assert_eq!(state.candidate_wrapper_version.as_deref(), Some("0.9.0"));
        assert_eq!(state.artifact_paths.package_path, Some(package_path));
        assert_eq!(state.artifact_paths.workspace_dir, Some(workspace_dir));
        Ok(())
    }

    #[test]
    fn pending_install_becomes_installed_when_candidate_is_already_present() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let paths = RuntimePaths {
            config_file: temp.path().join("config/config.toml"),
            state_file: temp.path().join("state/state.json"),
            log_file: temp.path().join("state/service.log"),
            cache_dir: temp.path().join("cache"),
            state_dir: temp.path().join("state"),
            config_dir: temp.path().join("config"),
        };
        paths.ensure_dirs()?;

        let mut state = PersistedState::new(true);
        state.status = UpdateStatus::ReadyToInstall;
        state.installed_version = "2026.04.28.082247-abcdef12.fc43".to_string();
        state.candidate_version = Some("2026.04.28.082247+abcdef12".to_string());
        state.rollback_blocked_candidate_version = Some("2026.04.20.120000".to_string());
        state.rollback_blocked_dmg_sha256 = Some("rolled-back-dmg-sha256".to_string());
        state.error_message = Some("authentication was not obtained".to_string());
        state
            .notified_events
            .insert("install_auth_required:2026.04.28.082247+abcdef12".to_string());

        assert_eq!(
            complete_pending_install_if_already_installed(&mut state, &paths)?,
            PendingInstallRecovery::CandidateInstalled
        );

        assert_eq!(state.status, UpdateStatus::Installed);
        assert_eq!(state.candidate_version, None);
        assert_eq!(state.rollback_blocked_candidate_version, None);
        assert_eq!(state.rollback_blocked_dmg_sha256, None);
        assert_eq!(state.error_message, None);
        assert!(state.notified_events.is_empty());
        Ok(())
    }

    #[test]
    fn pending_install_is_cleared_when_installed_version_is_newer() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let paths = RuntimePaths {
            config_file: temp.path().join("config/config.toml"),
            state_file: temp.path().join("state/state.json"),
            log_file: temp.path().join("state/service.log"),
            cache_dir: temp.path().join("cache"),
            state_dir: temp.path().join("state"),
            config_dir: temp.path().join("config"),
        };
        paths.ensure_dirs()?;

        let mut state = PersistedState::new(true);
        state.status = UpdateStatus::ReadyToInstall;
        state.installed_version = "2026.05.01.010203-99999999.fc43".to_string();
        state.candidate_version = Some("2026.04.28.082247+abcdef12".to_string());
        state.error_message = Some("authentication was not obtained".to_string());
        let superseded_package_path = temp.path().join("superseded.deb");
        std::fs::write(&superseded_package_path, b"deb")?;
        state.artifact_paths.package_path = Some(superseded_package_path);
        state.artifact_paths.workspace_dir = Some(
            temp.path()
                .join("cache/workspaces/2026.04.28.082247+abcdef12"),
        );

        assert_eq!(
            complete_pending_install_if_already_installed(&mut state, &paths)?,
            PendingInstallRecovery::SupersededByInstalledVersion
        );

        assert_eq!(state.status, UpdateStatus::Installed);
        assert_eq!(state.candidate_version, None);
        assert_eq!(state.artifact_paths.package_path, None);
        assert_eq!(state.artifact_paths.workspace_dir, None);
        assert_eq!(state.error_message, None);
        crate::rollback::record_current_package_as_known_good(&mut state);
        assert_eq!(state.artifact_paths.rollback_package_path, None);
        Ok(())
    }

    #[test]
    fn matching_pending_install_recovery_records_installed_notification_event() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let paths = test_paths(temp.path());
        paths.ensure_dirs()?;

        let mut state = PersistedState::new(true);
        state.status = UpdateStatus::ReadyToInstall;
        state.installed_version = "2026.04.28.082247-abcdef12.fc43".to_string();
        state.candidate_version = Some("2026.04.28.082247+abcdef12".to_string());

        let recovery = complete_pending_install_if_already_installed(&mut state, &paths)?;
        if recovery.should_notify_installed() {
            maybe_notify_installed(&mut state, &paths, false)?;
        }

        assert_eq!(state.status, UpdateStatus::Installed);
        assert_eq!(state.candidate_version, None);
        assert!(state
            .notified_events
            .contains("installed:2026.04.28.082247-abcdef12.fc43"));
        Ok(())
    }

    #[test]
    fn superseded_pending_install_recovery_skips_installed_notification_event() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let paths = test_paths(temp.path());
        paths.ensure_dirs()?;

        let package_path = temp.path().join("superseded.pkg.tar.zst");
        std::fs::write(&package_path, b"package")?;

        let mut state = PersistedState::new(true);
        state.status = UpdateStatus::ReadyToInstall;
        state.installed_version = "2026.06.24.051729-1".to_string();
        state.candidate_version = Some("2026.06.24.050316+4bb552bf".to_string());
        state.artifact_paths.package_path = Some(package_path);
        state
            .notified_events
            .insert("ready_to_install:2026.06.24.050316+4bb552bf".to_string());

        let recovery = complete_pending_install_if_already_installed(&mut state, &paths)?;
        if recovery.should_notify_installed() {
            maybe_notify_installed(&mut state, &paths, false)?;
        }

        assert_eq!(state.status, UpdateStatus::Installed);
        assert_eq!(state.candidate_version, None);
        assert!(!state
            .notified_events
            .iter()
            .any(|event| event.starts_with("installed:")));
        Ok(())
    }

    #[test]
    fn status_clears_superseded_ready_update() -> Result<()> {
        let _env_guard = crate::test_util::env_lock();
        let temp = tempfile::tempdir()?;
        let paths = RuntimePaths {
            config_file: temp.path().join("config/config.toml"),
            state_file: temp.path().join("state/state.json"),
            log_file: temp.path().join("state/service.log"),
            cache_dir: temp.path().join("cache"),
            state_dir: temp.path().join("state"),
            config_dir: temp.path().join("config"),
        };
        paths.ensure_dirs()?;

        let mut state = PersistedState::new(true);
        state.status = UpdateStatus::ReadyToInstall;
        state.installed_version = "2026.05.01.010203".to_string();
        state.candidate_version = Some("2026.04.28.082247+abcdef12".to_string());
        let superseded_package_path = temp.path().join("superseded-status.deb");
        std::fs::write(&superseded_package_path, b"deb")?;
        state.artifact_paths.package_path = Some(superseded_package_path);
        state.artifact_paths.workspace_dir = Some(
            temp.path()
                .join("cache/workspaces/2026.04.28.082247+abcdef12"),
        );

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

        let config = test_config(temp.path());
        let result = run_status(&config, &mut state, &paths, true);

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

        result?;

        assert_eq!(state.status, UpdateStatus::Installed);
        assert_eq!(state.candidate_version, None);
        assert_eq!(state.artifact_paths.package_path, None);
        assert_eq!(state.artifact_paths.workspace_dir, None);
        Ok(())
    }

    #[test]
    fn status_preserves_cli_reconciliation_failure() -> Result<()> {
        let _env_guard = crate::test_util::env_lock();
        let temp = tempfile::tempdir()?;
        let paths = RuntimePaths {
            config_file: temp.path().join("config/config.toml"),
            state_file: temp.path().join("state/state.json"),
            log_file: temp.path().join("state/service.log"),
            cache_dir: temp.path().join("cache"),
            state_dir: temp.path().join("state"),
            config_dir: temp.path().join("config"),
        };
        paths.ensure_dirs()?;

        let bin_dir = temp.path().join("bin");
        fs::create_dir_all(&bin_dir)?;
        let codex_path = bin_dir.join("codex");
        fs::write(
            &codex_path,
            "#!/bin/sh\nif [ \"$1\" = \"--version\" ] || [ \"$1\" = \"version\" ]; then\n  echo 'codex-cli v0.42.0'\n  exit 0\nfi\nexit 1\n",
        )?;
        let mut permissions = fs::metadata(&codex_path)?.permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&codex_path, permissions)?;

        let npm_path = bin_dir.join("npm");
        fs::write(
            &npm_path,
            "#!/bin/sh\nif [ \"$1\" = \"view\" ] && [ \"$2\" = \"@openai/codex\" ] && [ \"$3\" = \"version\" ]; then\n  echo '0.42.1'\n  exit 0\nfi\nexit 1\n",
        )?;
        let mut permissions = fs::metadata(&npm_path)?.permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&npm_path, permissions)?;

        let original_home = std::env::var_os("HOME");
        let original_path = std::env::var_os("PATH");
        let original_nvm_dir = std::env::var_os("NVM_DIR");
        let original_codex_cli_path = std::env::var_os("CODEX_CLI_PATH");
        let original_skip_system_cli_lookup =
            std::env::var_os("CODEX_UPDATE_MANAGER_SKIP_SYSTEM_CLI_LOOKUP");
        std::env::set_var("HOME", temp.path());
        std::env::set_var("PATH", std::env::join_paths([bin_dir])?);
        std::env::remove_var("NVM_DIR");
        std::env::remove_var("CODEX_CLI_PATH");
        std::env::set_var("CODEX_UPDATE_MANAGER_SKIP_SYSTEM_CLI_LOOKUP", "1");

        let config = test_config(temp.path());
        let mut state = PersistedState::new(true);
        state.cli_path = Some(codex_path);
        let result = run_status(&config, &mut state, &paths, true);

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

        assert!(result.is_err());
        assert_eq!(state.cli_status, CliStatus::Failed);
        assert!(state
            .cli_error_message
            .as_deref()
            .is_some_and(|message| message.contains("npm")));
        Ok(())
    }

    #[test]
    fn status_json_keeps_legacy_cli_latest_version_alias() -> Result<()> {
        let mut state = PersistedState::new(true);
        state.cli_official_latest_version = Some("0.42.1".to_string());
        state.cli_package_manager_latest_version = Some("0.42.0-1".to_string());

        let value = status_json_value(&state)?;

        assert_eq!(value["cli_latest_version"], "0.42.1");
        assert_eq!(value["cli_official_latest_version"], "0.42.1");
        assert_eq!(value["cli_package_manager_latest_version"], "0.42.0-1");
        Ok(())
    }

    #[test]
    fn generated_versions_compare_by_timestamp_segments() {
        assert_eq!(
            compare_generated_versions("2026.04.01.035152", "2026.03.27.025604+1086e799"),
            Some(std::cmp::Ordering::Greater)
        );
    }

    #[test]
    fn generated_versions_ignore_package_release_suffixes() {
        assert_eq!(
            compare_generated_versions(
                "2026.04.25.054929-90dd7716x11.fc43",
                "2026.04.25.054929+90dd7716",
            ),
            Some(std::cmp::Ordering::Equal)
        );
    }

    #[test]
    fn generated_version_comparison_rejects_non_generated_versions() {
        assert_eq!(compare_generated_versions("0.34.1", "0.35.0"), None);
    }

    #[test]
    fn rollback_blocks_same_dmg_hash_at_a_different_timestamp() {
        let mut state = PersistedState::new(true);
        state.rollback_blocked_candidate_version = Some("2026.05.04.131500+badcafe0".to_string());
        state.rollback_blocked_dmg_sha256 = Some("same-full-sha256".to_string());

        assert!(rollback_blocks_candidate(
            &state,
            "same-full-sha256",
            "2026.05.05.090000+badcafe0"
        ));
    }

    #[test]
    fn rollback_hash_mismatch_is_not_overridden_by_legacy_version_match() {
        let mut state = PersistedState::new(true);
        state.rollback_blocked_candidate_version = Some("2026.05.04.131500".to_string());
        state.rollback_blocked_dmg_sha256 = Some("rolled-back-sha256".to_string());

        assert!(!rollback_blocks_candidate(
            &state,
            "different-sha256",
            "2026.05.04.131500+different"
        ));
    }

    #[test]
    fn rollback_legacy_version_fallback_applies_only_without_recorded_hash() {
        let mut state = PersistedState::new(true);
        state.rollback_blocked_candidate_version = Some("2026.05.04.131500".to_string());

        assert!(rollback_blocks_candidate(
            &state,
            "unrecorded-sha256",
            "2026.05.04.131500+newhash00"
        ));
    }

    #[test]
    fn successful_install_clears_both_rollback_block_identifiers() {
        let mut state = PersistedState::new(true);
        state.rollback_blocked_candidate_version = Some("2026.05.04.131500".to_string());
        state.rollback_blocked_dmg_sha256 = Some("rolled-back-sha256".to_string());

        clear_rollback_blocked_candidate(&mut state);

        assert_eq!(state.rollback_blocked_candidate_version, None);
        assert_eq!(state.rollback_blocked_dmg_sha256, None);
    }

    #[tokio::test]
    async fn interrupted_install_becomes_installed_when_candidate_is_already_present() -> Result<()>
    {
        let temp = tempfile::tempdir()?;
        let paths = RuntimePaths {
            config_file: temp.path().join("config/config.toml"),
            state_file: temp.path().join("state/state.json"),
            log_file: temp.path().join("state/service.log"),
            cache_dir: temp.path().join("cache"),
            state_dir: temp.path().join("state"),
            config_dir: temp.path().join("config"),
        };
        paths.ensure_dirs()?;

        let package_path = temp.path().join("dist/codex.deb");
        std::fs::create_dir_all(
            package_path
                .parent()
                .expect("package path should have parent"),
        )?;
        std::fs::write(&package_path, b"deb")?;

        let mut state = PersistedState::new(true);
        state.status = UpdateStatus::Installing;
        state.installed_version = "2026.04.01.035152".to_string();
        state.candidate_version = Some("2026.03.27.025604+1086e799".to_string());
        state.rollback_blocked_candidate_version = Some("2026.03.20.120000".to_string());
        state.rollback_blocked_dmg_sha256 = Some("rolled-back-dmg-sha256".to_string());
        state.artifact_paths.package_path = Some(package_path);
        state.artifact_paths.workspace_dir = Some(
            temp.path()
                .join("cache/workspaces/2026.03.27.025604+1086e799"),
        );

        recover_interrupted_install(&mut state, &paths)?;

        assert_eq!(state.status, UpdateStatus::Installed);
        assert_eq!(state.candidate_version, None);
        assert_eq!(state.rollback_blocked_candidate_version, None);
        assert_eq!(state.rollback_blocked_dmg_sha256, None);
        assert_eq!(state.artifact_paths.package_path, None);
        assert_eq!(state.artifact_paths.workspace_dir, None);
        assert_eq!(state.error_message, None);
        Ok(())
    }

    #[tokio::test]
    async fn interrupted_install_returns_to_ready_when_package_still_exists() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let paths = RuntimePaths {
            config_file: temp.path().join("config/config.toml"),
            state_file: temp.path().join("state/state.json"),
            log_file: temp.path().join("state/service.log"),
            cache_dir: temp.path().join("cache"),
            state_dir: temp.path().join("state"),
            config_dir: temp.path().join("config"),
        };
        paths.ensure_dirs()?;

        let package_path = temp.path().join("dist/codex.deb");
        std::fs::create_dir_all(
            package_path
                .parent()
                .expect("package path should have parent"),
        )?;
        std::fs::write(&package_path, b"deb")?;

        let mut state = PersistedState::new(true);
        state.status = UpdateStatus::Installing;
        state.installed_version = "2026.03.24.120000".to_string();
        state.candidate_version = Some("2026.03.27.025604+1086e799".to_string());
        state.artifact_paths.package_path = Some(package_path);

        recover_interrupted_install(&mut state, &paths)?;

        assert_eq!(state.status, UpdateStatus::ReadyToInstall);
        assert!(state
            .error_message
            .as_deref()
            .is_some_and(|message| message.contains("interrupted")));
        Ok(())
    }

    #[test]
    fn notification_events_are_deduplicated() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let paths = RuntimePaths {
            config_file: temp.path().join("config/config.toml"),
            state_file: temp.path().join("state/state.json"),
            log_file: temp.path().join("state/service.log"),
            cache_dir: temp.path().join("cache"),
            state_dir: temp.path().join("state"),
            config_dir: temp.path().join("config"),
        };
        paths.ensure_dirs()?;

        let mut state = PersistedState::new(true);
        state.candidate_version = Some("2026.03.24+abcd1234".to_string());
        maybe_notify(
            &mut state,
            &paths,
            false,
            "ready_to_install",
            "ChatGPT Desktop update ready",
            "An update is ready to install.",
        )?;
        let notified_count = state.notified_events.len();
        maybe_notify(
            &mut state,
            &paths,
            false,
            "ready_to_install",
            "ChatGPT Desktop update ready",
            "An update is ready to install.",
        )?;

        assert_eq!(state.notified_events.len(), notified_count);
        Ok(())
    }

    #[test]
    fn installed_notifications_are_deduplicated_after_recovery() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let paths = RuntimePaths {
            config_file: temp.path().join("config/config.toml"),
            state_file: temp.path().join("state/state.json"),
            log_file: temp.path().join("state/service.log"),
            cache_dir: temp.path().join("cache"),
            state_dir: temp.path().join("state"),
            config_dir: temp.path().join("config"),
        };
        paths.ensure_dirs()?;

        let mut state = PersistedState::new(true);
        state.status = UpdateStatus::Installed;
        state.installed_version = "2026.04.16.120000".to_string();

        maybe_notify_installed(&mut state, &paths, false)?;
        let notified_count = state.notified_events.len();
        maybe_notify_installed(&mut state, &paths, false)?;

        assert_eq!(state.notified_events.len(), notified_count);
        assert!(state
            .notified_events
            .contains("installed:2026.04.16.120000"));
        Ok(())
    }

    #[test]
    fn cli_missing_notifications_are_deduplicated() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let paths = RuntimePaths {
            config_file: temp.path().join("config/config.toml"),
            state_file: temp.path().join("state/state.json"),
            log_file: temp.path().join("state/service.log"),
            cache_dir: temp.path().join("cache"),
            state_dir: temp.path().join("state"),
            config_dir: temp.path().join("config"),
        };
        paths.ensure_dirs()?;

        let mut state = PersistedState::new(true);
        state.cli_status = CliStatus::NotInstalled;
        state.cli_error_message = Some(
            "Codex CLI is required but not currently installed. Open the app to retry the automatic install flow, or install it manually with npm.".to_string(),
        );

        maybe_notify_cli_missing(&mut state, &paths, false)?;
        let notified_count = state.notified_events.len();
        maybe_notify_cli_missing(&mut state, &paths, false)?;

        assert_eq!(state.notified_events.len(), notified_count);
        assert!(state.notified_events.contains("cli_missing"));
        Ok(())
    }

    #[test]
    fn cli_missing_notification_marker_is_cleared_after_recovery() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let paths = RuntimePaths {
            config_file: temp.path().join("config/config.toml"),
            state_file: temp.path().join("state/state.json"),
            log_file: temp.path().join("state/service.log"),
            cache_dir: temp.path().join("cache"),
            state_dir: temp.path().join("state"),
            config_dir: temp.path().join("config"),
        };
        paths.ensure_dirs()?;

        let mut state = PersistedState::new(true);
        state.notified_events.insert("cli_missing".to_string());
        state.cli_path = Some(temp.path().join("codex"));
        state.cli_installed_version = Some("0.42.0".to_string());
        state.cli_error_message = None;

        maybe_notify_cli_missing(&mut state, &paths, false)?;

        assert!(!state.notified_events.contains("cli_missing"));
        Ok(())
    }
}
