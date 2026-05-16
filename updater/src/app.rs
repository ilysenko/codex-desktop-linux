//! Application entrypoints and orchestration for the local updater daemon.

use crate::{
    builder,
    cli::{Cli, Commands},
    codex_cli,
    config::{RuntimeConfig, RuntimePaths},
    install, install_rollback, liveness, logging, notify, rollback,
    state::{CliStatus, PersistedState, UpdateStatus},
    upstream,
};
use anyhow::{Context, Result};
use chrono::{Duration as ChronoDuration, Utc};
use fs4::fs_std::FileExt;
use reqwest::Client;
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

/// Runs the updater command-line entrypoint.
pub async fn run(cli: Cli) -> Result<()> {
    let paths = RuntimePaths::detect()?;
    paths.ensure_dirs()?;
    logging::init(&paths.log_file)?;

    let config = RuntimeConfig::load_or_default(&paths)?;
    let mut state =
        PersistedState::load_or_default(&paths.state_file, config.auto_install_on_app_exit)?;
    let original_state = state.clone();
    state.installed_version = install::installed_package_version();
    persist_if_changed(&paths, &state, &original_state)?;

    match cli.command {
        Commands::Daemon => run_daemon(&config, &mut state, &paths).await,
        Commands::CheckNow { if_stale } => {
            run_check_now(&config, &mut state, &paths, if_stale).await
        }
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
        Commands::Status { json } => run_status(&mut state, &paths, json),
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

fn sync_runtime_state(config: &RuntimeConfig, state: &mut PersistedState) {
    state.auto_install_on_app_exit = config.auto_install_on_app_exit;
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

fn set_status(
    state: &mut PersistedState,
    paths: &RuntimePaths,
    status: UpdateStatus,
) -> Result<()> {
    state.status = status;
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

    match file.try_lock_exclusive() {
        Ok(true) => {}
        Ok(false) => {
            info!("skipping upstream check because another check is already active");
            return Ok(None);
        }
        Err(error) => {
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

async fn run_daemon(
    config: &RuntimeConfig,
    state: &mut PersistedState,
    paths: &RuntimePaths,
) -> Result<()> {
    sync_and_persist(config, state, paths)?;
    recover_interrupted_install(state, paths)?;
    codex_cli::reconcile_if_present(state, paths)?;
    maybe_notify_cli_missing(state, paths, config.notifications)?;
    maybe_notify_installed(state, paths, config.notifications)?;
    if packaged_runtime_removed(config) {
        info!("packaged app files are gone; stopping updater daemon");
        return Ok(());
    }
    info!("daemon initialized");

    time::sleep(Duration::from_secs(config.initial_check_delay_seconds)).await;
    if let Err(error) = run_check_cycle(config, state, paths).await {
        error!(?error, "initial check failed");
    }
    if let Err(error) = reconcile_pending_install(config, state, paths).await {
        error!(?error, "initial reconciliation failed");
    }

    let mut check_interval =
        time::interval(Duration::from_secs(config.check_interval_hours * 3600));
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
                if let Err(error) = run_check_cycle(config, state, paths).await {
                    error!(?error, "periodic check failed");
                }
            }
            _ = reconcile_interval.tick() => {
                if let Err(error) = reconcile_pending_install(config, state, paths).await {
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
    codex_cli::reconcile_if_present(state, paths)?;
    maybe_notify_cli_missing(state, paths, config.notifications)?;
    maybe_notify_installed(state, paths, config.notifications)?;
    if if_stale && upstream_check_is_fresh(config, state) {
        info!("skipping check-now because the last successful upstream check is still fresh");
        return reconcile_pending_install(config, state, paths).await;
    }
    run_check_cycle(config, state, paths).await?;
    reconcile_pending_install(config, state, paths).await
}

fn upstream_check_is_fresh(config: &RuntimeConfig, state: &PersistedState) -> bool {
    let Some(last_successful_check_at) = state.last_successful_check_at else {
        return false;
    };

    let freshness_window = ChronoDuration::hours(config.check_interval_hours as i64);
    Utc::now().signed_duration_since(last_successful_check_at) < freshness_window
}

fn run_status(state: &mut PersistedState, paths: &RuntimePaths, json: bool) -> Result<()> {
    codex_cli::reconcile_if_present(state, paths)?;
    complete_pending_install_if_already_installed(state, paths)?;

    if json {
        println!("{}", serde_json::to_string_pretty(state)?);
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
            "cli_latest_version: {}",
            state.cli_latest_version.as_deref().unwrap_or("unknown")
        );
        println!(
            "cli_error: {}",
            state.cli_error_message.as_deref().unwrap_or("none")
        );
    }

    Ok(())
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

    if !has_graphical_session() {
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

fn run_kdialog_prompt() -> Result<bool> {
    let status = Command::new("kdialog")
        .args([
            "--title",
            "Codex Desktop",
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
            "--title=Codex Desktop",
            "--text=Codex CLI is not installed. Install it now?",
        ])
        .status()
        .context("Failed to launch zenity")?;
    Ok(status.success())
}

fn run_actionable_notification_prompt() -> Result<bool> {
    match notify::send_actionable(
        "Codex CLI not installed",
        "Codex Desktop needs the Codex CLI. Choose Install now to let Codex Desktop install it.",
        &[("install", "Install now"), ("dismiss", "Dismiss")],
    )? {
        notify::ActionResponse::Invoked(action) if action == "install" => Ok(true),
        _ => Ok(false),
    }
}

async fn run_check_cycle(
    config: &RuntimeConfig,
    state: &mut PersistedState,
    paths: &RuntimePaths,
) -> Result<()> {
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

    let retrying_failed_update = state.status == UpdateStatus::Failed;

    let Some(_check_lock) = try_acquire_check_lock(paths)? else {
        return Ok(());
    };

    let client = Client::builder().build()?;

    sync_runtime_state(config, state);
    state.status = UpdateStatus::CheckingUpstream;
    state.last_check_at = Some(Utc::now());
    state.error_message = None;
    persist_state(paths, state)?;

    let result: Result<()> = async {
        let metadata = upstream::fetch_remote_metadata(&client, &config.dmg_url).await?;
        let previous_headers_fingerprint = state.remote_headers_fingerprint.clone();
        state.remote_headers_fingerprint = Some(metadata.headers_fingerprint.clone());
        state.last_successful_check_at = Some(Utc::now());

        if previous_headers_fingerprint.as_deref() == Some(metadata.headers_fingerprint.as_str())
            && state.dmg_sha256.is_some()
            && !retrying_failed_update
        {
            set_status(state, paths, UpdateStatus::Idle)?;
            info!("upstream fingerprint unchanged; skipping download");
            return Ok(());
        }

        set_status(state, paths, UpdateStatus::DownloadingDmg)?;

        let downloads_dir = config.workspace_root.join("downloads");
        let downloaded =
            upstream::download_dmg(&client, &config.dmg_url, &downloads_dir, Utc::now()).await?;

        if state
            .rollback_blocked_candidate_version
            .as_deref()
            .is_some_and(|blocked| {
                installed_version_matches_candidate(blocked, &downloaded.candidate_version)
            })
        {
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

        if state.dmg_sha256.as_deref() == Some(downloaded.sha256.as_str())
            && !retrying_failed_update
        {
            state.status = UpdateStatus::Idle;
            state.artifact_paths.dmg_path = Some(downloaded.path);
            persist_state(paths, state)?;
            info!("downloaded DMG hash matches current cached DMG; no update detected");
            return Ok(());
        }

        rollback::record_current_package_as_known_good(state);
        state.status = UpdateStatus::UpdateDetected;
        state.candidate_version = Some(downloaded.candidate_version);
        state.dmg_sha256 = Some(downloaded.sha256);
        state.artifact_paths.dmg_path = Some(downloaded.path.clone());
        state.notified_events.clear();
        state.save(&paths.state_file)?;

        maybe_notify(
            state,
            paths,
            config.notifications,
            "update_detected",
            "New Codex Desktop update detected",
            "Preparing a local Linux package from the new upstream DMG.",
        )?;

        let candidate_version = state
            .candidate_version
            .clone()
            .expect("candidate version should be set before local build");
        builder::build_update(config, state, paths, &candidate_version, &downloaded.path).await?;
        maybe_notify_update_ready(state, paths, config.notifications)?;
        Ok(())
    }
    .await;

    if let Err(error) = result {
        mark_failed_and_persist(state, paths, error.to_string())?;
        let _ = notify_failure(config, state, paths, &error);
        return Err(error);
    }

    Ok(())
}

async fn reconcile_pending_install(
    config: &RuntimeConfig,
    state: &mut PersistedState,
    paths: &RuntimePaths,
) -> Result<()> {
    sync_runtime_state(config, state);
    recover_interrupted_install(state, paths)?;
    if complete_pending_install_if_already_installed(state, paths)? {
        let _ = maybe_notify_installed(state, paths, config.notifications);
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
                maybe_notify(
                    state,
                    paths,
                    config.notifications,
                    "ready_to_install",
                    "Codex Desktop update ready",
                    "Open Codex Desktop and choose Update to install the ready update.",
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

            if liveness::is_app_running(config)? {
                clear_install_auth_required_event(state, paths)?;
                maybe_notify(
                    state,
                    paths,
                    config.notifications,
                    "waiting_for_app_exit",
                    "Codex Desktop update ready",
                    "The update will install after you close Codex Desktop.",
                )?;
                return Ok(());
            }

            if install_auth_retry_is_blocked(state) {
                return Ok(());
            }

            trigger_install(state, paths, &package_path).await?;
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

    if complete_pending_install_if_already_installed(state, paths)? {
        let _ = maybe_notify_installed(state, paths, config.notifications);
        println!("Codex Desktop update is already installed or superseded.");
        return Ok(());
    }

    match state.status {
        UpdateStatus::ReadyToInstall | UpdateStatus::WaitingForAppExit => {}
        UpdateStatus::Installing => {
            maybe_send_notification(
                config.notifications,
                "Codex update already installing",
                "Codex Desktop is already applying the ready update.",
            );
            println!("Codex Desktop update is already installing.");
            return Ok(());
        }
        _ => {
            maybe_send_notification(
                config.notifications,
                "No Codex update ready",
                "There is no rebuilt Codex Desktop update waiting to install.",
            );
            println!("No Codex Desktop update is ready to install.");
            return Ok(());
        }
    }

    let Some(package_path) = state.artifact_paths.package_path.clone() else {
        mark_failed_and_persist(state, paths, "No ready update package is recorded")?;
        maybe_send_notification(
            config.notifications,
            "Codex update failed",
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
            "Codex update failed",
            "The rebuilt package is missing. Check the updater log for details.",
        );
        println!(
            "Ready update package is missing: {}",
            package_path.display()
        );
        return Ok(());
    }

    if liveness::is_app_running(config)? {
        clear_install_auth_required_event(state, paths)?;
        set_status(state, paths, UpdateStatus::WaitingForAppExit)?;
        maybe_send_notification(
            config.notifications,
            "Codex Desktop update ready",
            "Close Codex Desktop to install the ready update.",
        );
        println!("Codex Desktop is running. Close it to install the ready update.");
        return Ok(());
    }

    clear_install_auth_required_event(state, paths)?;
    trigger_install(state, paths, &package_path).await
}

fn complete_pending_install_if_already_installed(
    state: &mut PersistedState,
    paths: &RuntimePaths,
) -> Result<bool> {
    if !matches!(
        state.status,
        UpdateStatus::ReadyToInstall | UpdateStatus::WaitingForAppExit
    ) {
        return Ok(false);
    }

    let Some(candidate_version) = state.candidate_version.clone().filter(|candidate| {
        installed_version_satisfies_candidate(&state.installed_version, candidate)
    }) else {
        return Ok(false);
    };

    let candidate_is_installed =
        installed_version_matches_candidate(&state.installed_version, &candidate_version);

    state.status = UpdateStatus::Installed;
    state.candidate_version = None;
    if !candidate_is_installed {
        state.artifact_paths.package_path = None;
    }
    state.error_message = None;
    state.notified_events.clear();
    persist_state(paths, state)?;
    info!("recovered pending install state because the candidate version is already installed or superseded");
    Ok(true)
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
        state.candidate_version = None;
        if !candidate_is_installed {
            state.artifact_paths.package_path = None;
        }
        state.error_message = None;
        state.notified_events.clear();
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
    state.error_message =
        Some("Previous install attempt was interrupted before completion".to_string());
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
        "Codex Desktop needs the Codex CLI. Open the app to retry the automatic install flow, or install it manually with npm.",
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
        "Codex Desktop updated",
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
        if let Err(error) = notify::send(
            "Codex Desktop update ready",
            "A rebuilt Linux package is ready. Open Codex Desktop and choose Update to install it.",
        ) {
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
    package_path: &Path,
) -> Result<()> {
    state.status = UpdateStatus::Installing;
    state.error_message = None;
    persist_state(paths, state)?;

    let _ = notify::send(
        "Installing Codex Desktop update",
        "Applying the locally rebuilt Linux package.",
    );

    let current_exe = std::env::current_exe().context("Failed to resolve updater binary path")?;
    let output = install::pkexec_command(&current_exe, package_path)
        .output()
        .context("Failed to launch pkexec for update installation")?;
    let status = output.status;

    if status.success() {
        state.status = UpdateStatus::Installed;
        state.installed_version = install::installed_package_version();
        state.candidate_version = None;
        state.rollback_blocked_candidate_version = None;
        state.error_message = None;
        state.notified_events.clear();
        persist_state(paths, state)?;
        let _ = maybe_notify_installed(state, paths, true);
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
        "Codex update failed",
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
    state.error_message = Some(message);

    if let Some(event_key) = install_auth_required_event_key(state) {
        if state.notified_events.insert(event_key) {
            let _ = notify::send(
                "Codex update needs permission",
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
        "Codex update failed",
        &body,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

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
        };

        let mut state = PersistedState::new(true);
        assert!(!upstream_check_is_fresh(&config, &state));

        state.last_successful_check_at = Some(Utc::now() - ChronoDuration::hours(1));
        assert!(upstream_check_is_fresh(&config, &state));

        state.last_successful_check_at = Some(Utc::now() - ChronoDuration::hours(7));
        assert!(!upstream_check_is_fresh(&config, &state));
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

    #[tokio::test]
    async fn ready_update_waits_for_explicit_install_ready() -> Result<()> {
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
            auto_install_on_app_exit: true,
            notifications: false,
            workspace_root: temp.path().join("cache"),
            builder_bundle_root: temp.path().join("builder"),
            app_executable_path: temp.path().join("not-running-electron"),
        };

        let mut state = PersistedState::new(true);
        state.status = UpdateStatus::ReadyToInstall;
        state.candidate_version = Some("2999.03.25.010203+deadbeef".to_string());
        state.artifact_paths.package_path = Some(package_path);

        reconcile_pending_install(&config, &mut state, &paths).await?;

        assert_eq!(state.status, UpdateStatus::ReadyToInstall);
        assert_eq!(state.error_message, None);
        Ok(())
    }

    #[tokio::test]
    async fn install_ready_waits_when_app_is_running() -> Result<()> {
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
        };

        let mut state = PersistedState::new(false);
        state.status = UpdateStatus::ReadyToInstall;
        state.candidate_version = Some("2999.03.25.010203+deadbeef".to_string());
        state.artifact_paths.package_path = Some(package_path);
        state
            .notified_events
            .insert("install_auth_required:2999.03.25.010203+deadbeef".to_string());

        run_install_ready(&config, &mut state, &paths).await?;

        assert_eq!(state.status, UpdateStatus::WaitingForAppExit);
        assert!(!install_auth_retry_is_blocked(&state));
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

        let original_display = std::env::var_os("DISPLAY");
        let original_wayland_display = std::env::var_os("WAYLAND_DISPLAY");
        let original_dbus_session_bus_address = std::env::var_os("DBUS_SESSION_BUS_ADDRESS");
        let original_xdg_runtime_dir = std::env::var_os("XDG_RUNTIME_DIR");
        let original_path = std::env::var_os("PATH");
        let original_home = std::env::var_os("HOME");
        let original_nvm_dir = std::env::var_os("NVM_DIR");
        let original_skip_system_cli_lookup =
            std::env::var_os("CODEX_UPDATE_MANAGER_SKIP_SYSTEM_CLI_LOOKUP");

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

        if let Some(value) = original_display {
            std::env::set_var("DISPLAY", value);
        } else {
            std::env::remove_var("DISPLAY");
        }
        if let Some(value) = original_wayland_display {
            std::env::set_var("WAYLAND_DISPLAY", value);
        } else {
            std::env::remove_var("WAYLAND_DISPLAY");
        }
        if let Some(value) = original_dbus_session_bus_address {
            std::env::set_var("DBUS_SESSION_BUS_ADDRESS", value);
        } else {
            std::env::remove_var("DBUS_SESSION_BUS_ADDRESS");
        }
        if let Some(value) = original_xdg_runtime_dir {
            std::env::set_var("XDG_RUNTIME_DIR", value);
        } else {
            std::env::remove_var("XDG_RUNTIME_DIR");
        }
        if let Some(value) = original_path {
            std::env::set_var("PATH", value);
        } else {
            std::env::remove_var("PATH");
        }
        if let Some(value) = original_home {
            std::env::set_var("HOME", value);
        } else {
            std::env::remove_var("HOME");
        }
        if let Some(value) = original_nvm_dir {
            std::env::set_var("NVM_DIR", value);
        } else {
            std::env::remove_var("NVM_DIR");
        }
        if let Some(value) = original_skip_system_cli_lookup {
            std::env::set_var("CODEX_UPDATE_MANAGER_SKIP_SYSTEM_CLI_LOOKUP", value);
        } else {
            std::env::remove_var("CODEX_UPDATE_MANAGER_SKIP_SYSTEM_CLI_LOOKUP");
        }

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
        state.error_message = Some("authentication was not obtained".to_string());
        state
            .notified_events
            .insert("install_auth_required:2026.04.28.082247+abcdef12".to_string());

        assert!(complete_pending_install_if_already_installed(
            &mut state, &paths
        )?);

        assert_eq!(state.status, UpdateStatus::Installed);
        assert_eq!(state.candidate_version, None);
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

        assert!(complete_pending_install_if_already_installed(
            &mut state, &paths
        )?);

        assert_eq!(state.status, UpdateStatus::Installed);
        assert_eq!(state.candidate_version, None);
        assert_eq!(state.artifact_paths.package_path, None);
        assert_eq!(state.error_message, None);
        crate::rollback::record_current_package_as_known_good(&mut state);
        assert_eq!(state.artifact_paths.rollback_package_path, None);
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

        let result = run_status(&mut state, &paths, true);

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

        let mut state = PersistedState::new(true);
        state.cli_path = Some(codex_path);
        let result = run_status(&mut state, &paths, true);

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
        assert_eq!(state.cli_status, CliStatus::Updating);
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
        state.artifact_paths.package_path = Some(package_path);

        recover_interrupted_install(&mut state, &paths)?;

        assert_eq!(state.status, UpdateStatus::Installed);
        assert_eq!(state.candidate_version, None);
        assert_eq!(state.artifact_paths.package_path, None);
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
            "Codex Desktop update ready",
            "An update is ready to install.",
        )?;
        let notified_count = state.notified_events.len();
        maybe_notify(
            &mut state,
            &paths,
            false,
            "ready_to_install",
            "Codex Desktop update ready",
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
