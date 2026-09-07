//! Updater orchestration for the signed official Linux package.

use crate::{
    builder, cache_cleanup,
    cli::{Cli, Commands},
    config::{RuntimeConfig, RuntimePaths},
    install, install_rollback, liveness, logging, notify, restart, rollback,
    state::{PersistedState, UpdateStatus},
    upstream,
};
use anyhow::{Context, Result};
use chrono::Utc;
use std::{fs::{self, OpenOptions}, path::Path, time::Duration};
use tokio::time;
use tracing::{error, info};

// Nonzero so `Restart=on-failure` relaunches the daemon on the new binary.
const BINARY_REPLACED_RESTART_EXIT_CODE: i32 = 12;

pub async fn run(cli: Cli) -> Result<()> {
    if let Some(result) = run_privileged_command(&cli.command) {
        return result;
    }
    let paths = RuntimePaths::detect()?;
    paths.ensure_dirs()?;
    logging::init(&paths.log_file)?;
    let config = RuntimeConfig::load_or_default(&paths)?;
    let mut state = PersistedState::load_or_default(&paths.state_file, config.auto_install_on_app_exit)?;
    state.installed_version = install::installed_package_version();
    state.save_updater(&paths.state_file)?;

    match cli.command {
        Commands::Daemon => daemon(&config, &mut state, &paths).await,
        Commands::CheckNow => check(&config, &mut state, &paths).await,
        Commands::Status { json } => status(&state, json),
        Commands::Diagnose { json } => diagnose(&config, &state, &paths, json),
        Commands::InstallReady => install_ready(&config, &mut state, &paths, true).await,
        Commands::Rollback => rollback::run(&config, &mut state, &paths).await,
        Commands::InstallDeb { .. }
        | Commands::InstallRpm { .. }
        | Commands::InstallPacman { .. }
        | Commands::InstallRollbackDeb { .. }
        | Commands::InstallRollbackRpm { .. }
        | Commands::InstallRollbackPacman { .. } => unreachable!(),
    }
}

fn run_privileged_command(command: &Commands) -> Option<Result<()>> {
    match command {
        Commands::InstallDeb { path } => Some(install::install_deb(path)),
        Commands::InstallRpm { path } => Some(install::install_rpm(path)),
        Commands::InstallPacman { path } => Some(install::install_pacman(path)),
        Commands::InstallRollbackDeb { path } => Some(install_rollback::install_deb(path)),
        Commands::InstallRollbackRpm { path } => Some(install_rollback::install_rpm(path)),
        Commands::InstallRollbackPacman { path } => Some(install_rollback::install_pacman(path)),
        _ => None,
    }
}

async fn daemon(config: &RuntimeConfig, state: &mut PersistedState, paths: &RuntimePaths) -> Result<()> {
    time::sleep(config.initial_check_delay_duration()).await;
    if let Err(error) = check(config, state, paths).await {
        error!(?error, "initial update check failed");
    }
    let mut checks = time::interval(config.check_interval_duration());
    let mut reconcile = time::interval(Duration::from_secs(15));
    checks.tick().await;
    reconcile.tick().await;
    loop {
        if let Some(installed_binary) = restart::replacement_binary() {
            info!(
                installed_binary = %installed_binary.display(),
                "updater binary was replaced on disk; exiting so systemd restarts the daemon"
            );
            std::process::exit(BINARY_REPLACED_RESTART_EXIT_CODE);
        }

        tokio::select! {
            _ = checks.tick() => if let Err(error) = check(config, state, paths).await { error!(?error, "periodic update check failed"); },
            _ = reconcile.tick() => if state.status == UpdateStatus::WaitingForAppExit && !liveness::is_app_running(config)? {
                if let Err(error) = install_ready(config, state, paths, false).await { error!(?error, "deferred install failed"); }
            },
            signal = tokio::signal::ctrl_c() => { signal?; break; }
        }
    }
    Ok(())
}

async fn check(config: &RuntimeConfig, state: &mut PersistedState, paths: &RuntimePaths) -> Result<()> {
    let _lock = match CheckLock::try_acquire(&paths.state_dir.join("check.lock"))? {
        Some(lock) => lock,
        None => { info!("another update check is active"); return Ok(()); }
    };
    let previous_status = state.status.clone();
    let previous_candidate = state.candidate_version.clone();
    let previous_sha256 = state.upstream_package_sha256.clone();
    let previous_error = state.error_message.clone();
    state.installed_version = install::installed_package_version();
    state.status = UpdateStatus::CheckingUpstream;
    state.last_check_at = Some(Utc::now());
    state.error_message = None;
    state.save_updater(&paths.state_file)?;

    let package_cache = paths.cache_dir.join("packages");
    let metadata = match upstream::resolve_metadata(&config.builder_bundle_root, &config.repository_url, &package_cache).await {
        Ok(value) => value,
        Err(error) => return fail(state, paths, error),
    };
    state.last_successful_check_at = Some(Utc::now());
    let _ = cache_cleanup::prune(&paths.cache_dir, state);

    let same_failed_candidate = previous_status == UpdateStatus::Failed
        && previous_sha256.as_deref() == Some(metadata.sha256.as_str());
    let already_installed = state.installed_upstream_version.as_deref() == Some(metadata.version.as_str())
        && state.installed_upstream_sha256.as_deref() == Some(metadata.sha256.as_str())
        && state.candidate_version.is_none();
    if already_installed || same_failed_candidate {
        state.status = if same_failed_candidate { UpdateStatus::Failed } else { UpdateStatus::Idle };
        if same_failed_candidate { state.error_message = previous_error; }
        state.save_updater(&paths.state_file)?;
        return Ok(());
    }

    if previous_candidate.as_deref() == Some(metadata.version.as_str())
        && previous_sha256.as_deref() == Some(metadata.sha256.as_str())
        && matches!(previous_status, UpdateStatus::ReadyToInstall | UpdateStatus::WaitingForAppExit)
    {
        state.status = previous_status;
        return install_ready(config, state, paths, false).await;
    }

    rollback::record_current_package_as_known_good(state);
    state.candidate_version = Some(metadata.version.clone());
    state.candidate_architecture = Some(metadata.architecture.clone());
    state.candidate_repository_path = Some(metadata.repository_path.clone());
    state.upstream_package_sha256 = Some(metadata.sha256.clone());
    state.status = UpdateStatus::DownloadingPackage;
    state.save_updater(&paths.state_file)?;

    let upstream_package = match upstream::download_verified_package(
        &config.builder_bundle_root,
        &config.repository_url,
        &package_cache,
        &metadata,
    ).await {
        Ok(path) => path,
        Err(error) => return fail(state, paths, error),
    };
    state.artifact_paths.upstream_package_path = Some(upstream_package.clone());
    if let Err(error) = builder::build_update(config, state, paths, &metadata.version, &upstream_package).await {
        return fail(state, paths, error);
    }

    if config.notifications {
        let _ = notify::send("codex-desktop update ready", &format!("Version {} has been rebuilt from OpenAI's signed Linux package.", metadata.version));
    }
    install_ready(config, state, paths, false).await
}

async fn install_ready(
    config: &RuntimeConfig,
    state: &mut PersistedState,
    paths: &RuntimePaths,
    explicit_retry: bool,
) -> Result<()> {
    if !matches!(state.status, UpdateStatus::ReadyToInstall | UpdateStatus::WaitingForAppExit | UpdateStatus::Failed) {
        println!("No rebuilt package is ready to install.");
        return Ok(());
    }
    if state.status == UpdateStatus::Failed && !explicit_retry {
        return Ok(());
    }
    let package = state.artifact_paths.package_path.clone().context("ready state has no package")?;
    anyhow::ensure!(package.is_file(), "rebuilt package is missing: {}", package.display());
    if liveness::is_app_running(config)? {
        state.status = UpdateStatus::WaitingForAppExit;
        state.waiting_for_app_exit_auto_install = config.auto_install_on_app_exit;
        state.save_updater(&paths.state_file)?;
        println!("Update is ready; close ChatGPT Community to install it.");
        return Ok(());
    }
    if !explicit_retry && !config.auto_install_on_app_exit {
        state.status = UpdateStatus::ReadyToInstall;
        state.save_updater(&paths.state_file)?;
        return Ok(());
    }

    state.status = UpdateStatus::Installing;
    state.error_message = None;
    state.save_updater(&paths.state_file)?;
    let current_exe = std::env::current_exe()?;
    let output = install::pkexec_command(&current_exe, &package)
        .output()
        .context("Failed to launch privileged package install")?;
    if !output.status.success() {
        return fail(state, paths, anyhow::anyhow!(
            "privileged install failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }

    let installed_upstream_version = state.candidate_version.clone();
    let installed_upstream_sha256 = state.upstream_package_sha256.clone();
    state.installed_version = install::installed_package_version();
    state.installed_upstream_version = installed_upstream_version;
    state.installed_upstream_sha256 = installed_upstream_sha256;
    state.status = UpdateStatus::Installed;
    state.last_known_good_version.get_or_insert_with(|| state.installed_version.clone());
    state.candidate_version = None;
    state.candidate_architecture = None;
    state.candidate_repository_path = None;
    state.waiting_for_app_exit_auto_install = false;
    state.error_message = None;
    state.save_updater(&paths.state_file)?;
    let _ = cache_cleanup::prune(&paths.cache_dir, state);
    if config.notifications {
        let _ = notify::send("codex-desktop updated", &format!("Installed {}.", state.installed_version));
    }
    Ok(())
}

fn fail<T>(state: &mut PersistedState, paths: &RuntimePaths, error: anyhow::Error) -> Result<T> {
    state.mark_failed(format!("{error:#}"));
    state.save_updater(&paths.state_file)?;
    Err(error)
}

fn status(state: &PersistedState, json: bool) -> Result<()> {
    if json { println!("{}", serde_json::to_string_pretty(state)?); }
    else {
        println!("status: {:?}", state.status);
        println!("installed_version: {}", state.installed_version);
        println!("installed_upstream_version: {}", state.installed_upstream_version.as_deref().unwrap_or("unknown"));
        println!("candidate_version: {}", state.candidate_version.as_deref().unwrap_or("none"));
        println!("candidate_sha256: {}", state.upstream_package_sha256.as_deref().unwrap_or("none"));
        if let Some(error) = &state.error_message { println!("error: {error}"); }
    }
    Ok(())
}

fn diagnose(config: &RuntimeConfig, state: &PersistedState, paths: &RuntimePaths, json: bool) -> Result<()> {
    let value = serde_json::json!({
        "repository": config.repository_url,
        "appExecutable": config.app_executable_path,
        "builderBundle": config.builder_bundle_root,
        "stateFile": paths.state_file,
        "stateSchema": state.schema_version,
        "appRunning": liveness::is_app_running(config)?,
        "status": state.status,
    });
    if json { println!("{}", serde_json::to_string_pretty(&value)?); }
    else { println!("repository: {}\napp: {}\nstatus: {:?}", config.repository_url, config.app_executable_path.display(), state.status); }
    Ok(())
}

struct CheckLock(fs::File);
impl CheckLock {
    fn try_acquire(path: &Path) -> Result<Option<Self>> {
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(path)?;
        match file.try_lock() {
            Ok(()) => Ok(Some(Self(file))),
            Err(fs::TryLockError::WouldBlock) => Ok(None),
            Err(fs::TryLockError::Error(error)) => Err(error.into()),
        }
    }
}
impl Drop for CheckLock { fn drop(&mut self) { let _ = self.0.unlock(); } }
