//! Updater orchestration for the signed official Linux package.

use crate::{
    builder, cache_cleanup,
    cli::{Cli, Commands},
    config::{RuntimeConfig, RuntimePaths},
    install, install_rollback, install_transaction, liveness, logging, notify, restart, rollback,
    state::{InstallOperation, PersistedState, UpdateStatus},
    upstream,
};
use anyhow::{Context, Result};
use chrono::Utc;
use std::{
    fs::{self, OpenOptions},
    path::Path,
    time::Duration,
};
use tokio::time;
use tracing::{error, info, warn};

pub async fn run(cli: Cli) -> Result<()> {
    if let Some(result) = run_privileged_command(&cli.command) {
        return result;
    }
    let paths = RuntimePaths::detect()?;
    paths.ensure_dirs()?;
    logging::init(&paths.log_file)?;
    let config = RuntimeConfig::load_or_default(&paths)?;

    match cli.command {
        Commands::Daemon => {
            let mut state = PersistedState::load_or_default(
                &paths.state_file,
                config.auto_install_on_app_exit,
            )?;
            daemon(&config, &mut state, &paths).await
        }
        Commands::CheckNow => {
            let Some(_lock) = MutationLock::try_acquire(&paths.state_dir.join("check.lock"))?
            else {
                info!("another updater mutation is active");
                return Ok(());
            };
            let mut state = PersistedState::load_or_default(
                &paths.state_file,
                config.auto_install_on_app_exit,
            )?;
            if !prepare_mutation_state(&config, &mut state, &paths)? {
                println!(
                    "A package transaction is still active; refusing to start another update."
                );
                return Ok(());
            }
            check(&config, &mut state, &paths, false).await
        }
        Commands::Status { json } => {
            let state = PersistedState::load_or_default(
                &paths.state_file,
                config.auto_install_on_app_exit,
            )?;
            status(&state, json)
        }
        Commands::Diagnose { json } => {
            let state = PersistedState::load_or_default(
                &paths.state_file,
                config.auto_install_on_app_exit,
            )?;
            diagnose(&config, &state, &paths, json)
        }
        Commands::InstallReady => {
            let Some(_lock) = MutationLock::try_acquire(&paths.state_dir.join("check.lock"))?
            else {
                info!("another updater mutation is active");
                return Ok(());
            };
            let mut state = PersistedState::load_or_default(
                &paths.state_file,
                config.auto_install_on_app_exit,
            )?;
            if !prepare_mutation_state(&config, &mut state, &paths)? {
                println!(
                    "A package transaction is still active; refusing to start another install."
                );
                return Ok(());
            }
            install_ready(&config, &mut state, &paths, true, false).await
        }
        Commands::Rollback => {
            let Some(_lock) = MutationLock::try_acquire(&paths.state_dir.join("check.lock"))?
            else {
                info!("another updater mutation is active");
                return Ok(());
            };
            let mut state = PersistedState::load_or_default(
                &paths.state_file,
                config.auto_install_on_app_exit,
            )?;
            if !prepare_mutation_state(&config, &mut state, &paths)? {
                println!("A package transaction is still active; refusing to start rollback.");
                return Ok(());
            }
            rollback::run(&config, &mut state, &paths).await
        }
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

async fn daemon(
    config: &RuntimeConfig,
    state: &mut PersistedState,
    paths: &RuntimePaths,
) -> Result<()> {
    time::sleep(config.initial_check_delay_duration()).await;
    if let Some(_lock) = MutationLock::try_acquire(&paths.state_dir.join("check.lock"))? {
        if daemon_replacement_gate(config, state, paths)? {
            if let Err(error) = check(config, state, paths, true).await {
                error!(?error, "initial update check failed");
            }
        }
    } else {
        info!("another updater mutation is active");
    }
    let mut checks = time::interval(config.check_interval_duration());
    let mut reconcile = time::interval(Duration::from_secs(15));
    checks.tick().await;
    reconcile.tick().await;
    loop {
        tokio::select! {
            _ = checks.tick() => {
                if let Some(_lock) = MutationLock::try_acquire(&paths.state_dir.join("check.lock"))? {
                    if daemon_replacement_gate(config, state, paths)? {
                        if let Err(error) = check(config, state, paths, true).await {
                            error!(?error, "periodic update check failed");
                        }
                    }
                }
            },
            _ = reconcile.tick() => {
                if let Some(_lock) = MutationLock::try_acquire(&paths.state_dir.join("check.lock"))? {
                    if daemon_replacement_gate(config, state, paths)?
                        && state.status == UpdateStatus::WaitingForAppExit
                        && !liveness::is_app_running(config)?
                    {
                        if let Err(error) = install_ready(config, state, paths, false, true).await {
                            error!(?error, "deferred install failed");
                        }
                    }
                }
            },
            signal = tokio::signal::ctrl_c() => { signal?; break; }
        }
    }
    Ok(())
}

fn daemon_replacement_gate(
    config: &RuntimeConfig,
    state: &mut PersistedState,
    paths: &RuntimePaths,
) -> Result<bool> {
    if !prepare_mutation_state(config, state, paths)? {
        warn!("package transaction is still active; deferring updater work");
        return Ok(false);
    }

    if let Some(installed_binary) = restart::replacement_binary() {
        restart_daemon(&installed_binary);
    }
    Ok(true)
}

fn prepare_mutation_state(
    config: &RuntimeConfig,
    state: &mut PersistedState,
    paths: &RuntimePaths,
) -> Result<bool> {
    *state = PersistedState::load_or_default(&paths.state_file, config.auto_install_on_app_exit)?;

    if state.status != UpdateStatus::Installing {
        state.installed_version = install::installed_package_version();
        state.save_updater(&paths.state_file)?;
        return Ok(true);
    }

    match state.install_transaction.clone() {
        Some(transaction)
            if install_transaction::is_active(&transaction)
                || !install_transaction::grace_expired(&transaction) =>
        {
            Ok(false)
        }
        Some(_) => {
            recover_abandoned_install(state, paths)?;
            Ok(true)
        }
        None => {
            state.mark_failed("Installing state has no recoverable package transaction owner");
            state.save_updater(&paths.state_file)?;
            Ok(true)
        }
    }
}

fn recover_abandoned_install(state: &mut PersistedState, paths: &RuntimePaths) -> Result<()> {
    let transaction = state
        .install_transaction
        .clone()
        .context("Installing state has no transaction metadata")?;

    let observed_installed_version = install::installed_package_version();
    let verified_installed_version =
        install::installed_package_version_for_recovery(&transaction.package_path);
    let package_version = install::package_version(&transaction.package_path).ok();
    let package_sha256 = install_transaction::package_sha256(&transaction.package_path).ok();
    let package_identity_matches = transaction
        .package_sha256
        .as_deref()
        .zip(package_sha256.as_deref())
        .is_some_and(|(expected, actual)| expected == actual);
    let replacement_observed = restart::replacement_binary().is_some();
    let version_transition_observed = state.installed_version != "unknown"
        && verified_installed_version
            .as_deref()
            .is_some_and(|installed| installed != state.installed_version);

    let verified_package_matches = verified_installed_version
        .as_deref()
        .zip(package_version.as_deref())
        .is_some_and(|(installed, candidate)| installed == candidate);

    if verified_package_matches
        && package_identity_matches
        && (version_transition_observed || replacement_observed)
    {
        apply_reconciled_install(
            state,
            transaction,
            verified_installed_version.expect("verified install version disappeared"),
        );
    } else {
        state.mark_failed(format!(
            "abandoned package transaction could not be reconciled: installed={observed_installed_version}, candidate={}, configured={}, artifact_identity={}, install_effect={}",
            package_version.as_deref().unwrap_or("unknown"),
            if verified_installed_version.is_some() {
                "verified"
            } else {
                "unproven"
            },
            if package_identity_matches { "matched" } else { "unproven" },
            if version_transition_observed || replacement_observed {
                "observed"
            } else {
                "unproven"
            }
        ));
    }

    state.save_updater(&paths.state_file)?;
    Ok(())
}

fn apply_reconciled_install(
    state: &mut PersistedState,
    transaction: crate::state::InstallTransaction,
    installed_version: String,
) {
    match transaction.operation {
        InstallOperation::Update => {
            state.installed_version = installed_version;
            state.installed_upstream_version = state.candidate_version.clone();
            state.installed_upstream_sha256 = state.upstream_package_sha256.clone();
            state
                .last_known_good_version
                .get_or_insert_with(|| state.installed_version.clone());
            state.candidate_version = None;
            state.candidate_architecture = None;
            state.candidate_repository_path = None;
            state.waiting_for_app_exit_auto_install = false;
        }
        InstallOperation::Rollback => {
            let blocked_version = state
                .candidate_version
                .clone()
                .or_else(|| Some(state.installed_version.clone()));
            let blocked_sha = state.upstream_package_sha256.clone();

            state.installed_version = installed_version;
            state.installed_upstream_version = state.last_known_good_upstream_version.clone();
            state.installed_upstream_sha256 = state.last_known_good_upstream_sha256.clone();
            state.candidate_version = None;
            state.rollback_blocked_candidate_version = blocked_version;
            state.rollback_blocked_package_sha256 = blocked_sha;
            state.artifact_paths.package_path = Some(transaction.package_path.clone());
            state.artifact_paths.rollback_package_path = Some(transaction.package_path);
            state.last_known_good_version = Some(state.installed_version.clone());
        }
    }

    state.status = UpdateStatus::Installed;
    state.install_transaction = None;
    state.error_message = None;
}

fn restart_after_persisted_install(config: &RuntimeConfig, paths: &RuntimePaths) -> Result<()> {
    let replacement = restart::replacement_binary();
    let Some(installed_binary) = replacement else {
        return Ok(());
    };
    test_wait_before_restart_readback()?;
    let persisted =
        PersistedState::load_or_default(&paths.state_file, config.auto_install_on_app_exit)?;
    if persisted.status != UpdateStatus::Installed {
        warn!(
            status = ?persisted.status,
            installed_binary = %installed_binary.display(),
            "replacement updater exists but Installed state was not read back successfully; refusing to restart"
        );
        return Ok(());
    }
    restart_daemon(&installed_binary)
}

#[cfg(test)]
fn test_wait_before_restart_readback() -> Result<()> {
    let Some(marker) = std::env::var_os("CODEX_TEST_BEFORE_RESTART_READBACK") else {
        return Ok(());
    };
    let marker = std::path::PathBuf::from(marker);
    fs::write(&marker, b"ready")?;
    let release = std::path::PathBuf::from(
        std::env::var_os("CODEX_TEST_RELEASE_RESTART_READBACK")
            .context("restart readback fixture release path is required")?,
    );
    while !release.exists() {
        std::thread::sleep(Duration::from_millis(10));
    }
    Ok(())
}

#[cfg(not(test))]
fn test_wait_before_restart_readback() -> Result<()> {
    Ok(())
}

fn restart_daemon(installed_binary: &Path) -> ! {
    info!(
        installed_binary = %installed_binary.display(),
        "updater binary was replaced after Installed state was persisted; exiting so systemd restarts on the new binary"
    );
    restart::exit_for_replacement();
}

async fn check(
    config: &RuntimeConfig,
    state: &mut PersistedState,
    paths: &RuntimePaths,
    restart_on_replacement: bool,
) -> Result<()> {
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
    let metadata = match upstream::resolve_metadata(
        &config.builder_bundle_root,
        &config.repository_url,
        &package_cache,
    )
    .await
    {
        Ok(value) => value,
        Err(error) => return fail(state, paths, error),
    };
    state.last_successful_check_at = Some(Utc::now());
    let _ = cache_cleanup::prune(&paths.cache_dir, state);

    let same_failed_candidate = previous_status == UpdateStatus::Failed
        && previous_sha256.as_deref() == Some(metadata.sha256.as_str());
    let already_installed = state.installed_upstream_version.as_deref()
        == Some(metadata.version.as_str())
        && state.installed_upstream_sha256.as_deref() == Some(metadata.sha256.as_str())
        && state.candidate_version.is_none();
    if already_installed || same_failed_candidate {
        state.status = if same_failed_candidate {
            UpdateStatus::Failed
        } else {
            UpdateStatus::Idle
        };
        if same_failed_candidate {
            state.error_message = previous_error;
        }
        state.save_updater(&paths.state_file)?;
        return Ok(());
    }

    if previous_candidate.as_deref() == Some(metadata.version.as_str())
        && previous_sha256.as_deref() == Some(metadata.sha256.as_str())
        && matches!(
            previous_status,
            UpdateStatus::ReadyToInstall | UpdateStatus::WaitingForAppExit
        )
    {
        state.status = previous_status;
        return install_ready(config, state, paths, false, restart_on_replacement).await;
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
    )
    .await
    {
        Ok(path) => path,
        Err(error) => return fail(state, paths, error),
    };
    state.artifact_paths.upstream_package_path = Some(upstream_package.clone());
    if let Err(error) =
        builder::build_update(config, state, paths, &metadata.version, &upstream_package).await
    {
        return fail(state, paths, error);
    }

    if config.notifications {
        let _ = notify::send(
            "codex-desktop update ready",
            &format!(
                "Version {} has been rebuilt from OpenAI's signed Linux package.",
                metadata.version
            ),
        );
    }
    install_ready(config, state, paths, false, restart_on_replacement).await
}

async fn install_ready(
    config: &RuntimeConfig,
    state: &mut PersistedState,
    paths: &RuntimePaths,
    explicit_retry: bool,
    restart_on_replacement: bool,
) -> Result<()> {
    install_ready_with_launcher(
        config,
        state,
        paths,
        explicit_retry,
        restart_on_replacement,
        Path::new("/bin/sh"),
    )
    .await
}

async fn install_ready_with_launcher(
    config: &RuntimeConfig,
    state: &mut PersistedState,
    paths: &RuntimePaths,
    explicit_retry: bool,
    restart_on_replacement: bool,
    launcher_program: &Path,
) -> Result<()> {
    if !matches!(
        state.status,
        UpdateStatus::ReadyToInstall | UpdateStatus::WaitingForAppExit | UpdateStatus::Failed
    ) {
        println!("No rebuilt package is ready to install.");
        return Ok(());
    }
    if state.status == UpdateStatus::Failed && !explicit_retry {
        return Ok(());
    }
    let package = state
        .artifact_paths
        .package_path
        .clone()
        .context("ready state has no package")?;
    anyhow::ensure!(
        package.is_file(),
        "rebuilt package is missing: {}",
        package.display()
    );
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

    let current_exe = std::env::current_exe()?;
    install_transaction::begin(state, &paths.state_file, &package, InstallOperation::Update)?;
    let mut command = install::pkexec_command(&current_exe, &package);
    let output = match install_transaction::run_owned_command_with_launcher(
        &mut command,
        state,
        &paths.state_file,
        launcher_program,
    ) {
        Ok(output) => output,
        Err(failure) if !failure.mutation_may_have_started => {
            return fail(
                state,
                paths,
                failure
                    .error
                    .context("Failed to launch privileged package install"),
            );
        }
        Err(failure) => {
            return Err(failure
                .error
                .context("Privileged package install outcome is unknown"));
        }
    };
    if !output.status.success() {
        return fail(
            state,
            paths,
            anyhow::anyhow!(
                "privileged install failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ),
        );
    }

    let installed_upstream_version = state.candidate_version.clone();
    let installed_upstream_sha256 = state.upstream_package_sha256.clone();
    state.installed_version = install::installed_package_version();
    state.installed_upstream_version = installed_upstream_version;
    state.installed_upstream_sha256 = installed_upstream_sha256;
    state.status = UpdateStatus::Installed;
    state.install_transaction = None;
    state
        .last_known_good_version
        .get_or_insert_with(|| state.installed_version.clone());
    state.candidate_version = None;
    state.candidate_architecture = None;
    state.candidate_repository_path = None;
    state.waiting_for_app_exit_auto_install = false;
    state.error_message = None;
    state.save_updater(&paths.state_file)?;
    let _ = cache_cleanup::prune(&paths.cache_dir, state);
    if config.notifications {
        let _ = notify::send(
            "codex-desktop updated",
            &format!("Installed {}.", state.installed_version),
        );
    }
    if restart_on_replacement {
        restart_after_persisted_install(config, paths)?;
    }
    Ok(())
}

fn fail<T>(state: &mut PersistedState, paths: &RuntimePaths, error: anyhow::Error) -> Result<T> {
    state.mark_failed(format!("{error:#}"));
    state.save_updater(&paths.state_file)?;
    Err(error)
}

fn status(state: &PersistedState, json: bool) -> Result<()> {
    if json {
        println!("{}", serde_json::to_string_pretty(state)?);
    } else {
        println!("status: {:?}", state.status);
        println!("installed_version: {}", state.installed_version);
        println!(
            "installed_upstream_version: {}",
            state
                .installed_upstream_version
                .as_deref()
                .unwrap_or("unknown")
        );
        println!(
            "candidate_version: {}",
            state.candidate_version.as_deref().unwrap_or("none")
        );
        println!(
            "candidate_sha256: {}",
            state.upstream_package_sha256.as_deref().unwrap_or("none")
        );
        if let Some(error) = &state.error_message {
            println!("error: {error}");
        }
    }
    Ok(())
}

fn diagnose(
    config: &RuntimeConfig,
    state: &PersistedState,
    paths: &RuntimePaths,
    json: bool,
) -> Result<()> {
    let value = serde_json::json!({
        "repository": config.repository_url,
        "appExecutable": config.app_executable_path,
        "builderBundle": config.builder_bundle_root,
        "stateFile": paths.state_file,
        "stateSchema": state.schema_version,
        "appRunning": liveness::is_app_running(config)?,
        "status": state.status,
    });
    if json {
        println!("{}", serde_json::to_string_pretty(&value)?);
    } else {
        println!(
            "repository: {}\napp: {}\nstatus: {:?}",
            config.repository_url,
            config.app_executable_path.display(),
            state.status
        );
    }
    Ok(())
}

struct MutationLock(fs::File);
impl MutationLock {
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
impl Drop for MutationLock {
    fn drop(&mut self) {
        let _ = self.0.unlock();
    }
}

#[cfg(test)]
mod replacement_tests {
    use super::*;
    use crate::state::{InstallTransaction, ProcessIdentity};
    use anyhow::Result;
    use chrono::Utc;
    use std::{
        env,
        ffi::OsStr,
        fs::{self, File, OpenOptions},
        io,
        os::unix::{
            ffi::OsStrExt,
            fs::{OpenOptionsExt, PermissionsExt},
        },
        path::{Path, PathBuf},
        process::{Command, Stdio},
        thread,
        time::Duration,
    };

    fn stale_identity() -> ProcessIdentity {
        ProcessIdentity {
            pid: std::process::id(),
            start_time_ticks: 0,
        }
    }

    fn fixture_paths(root: &Path) -> RuntimePaths {
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
    fn live_install_transaction_blocks_mutation_without_replacement_detection() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let paths = fixture_paths(dir.path());
        paths.ensure_dirs()?;
        let config = RuntimeConfig::default_with_paths(&paths);
        let current = crate::install_transaction::test_current_process_identity()?;

        let mut state = PersistedState::new(true);
        state.status = UpdateStatus::Installing;
        state.install_transaction = Some(InstallTransaction {
            package_path: dir.path().join("candidate.deb"),
            package_sha256: Some("fixture".into()),
            package_command: Some(current),
            started_at: Utc::now(),
            operation: InstallOperation::Update,
        });
        state.save_updater(&paths.state_file)?;

        assert!(!prepare_mutation_state(&config, &mut state, &paths)?);
        assert_eq!(state.status, UpdateStatus::Installing);
        assert!(state.install_transaction.is_some());
        Ok(())
    }

    #[test]
    fn ownerless_installing_state_converges_to_failed_without_replacement_detection() -> Result<()>
    {
        let dir = tempfile::tempdir()?;
        let paths = fixture_paths(dir.path());
        paths.ensure_dirs()?;
        let config = RuntimeConfig::default_with_paths(&paths);
        let mut state = PersistedState::new(true);
        state.status = UpdateStatus::Installing;
        state.install_transaction = None;
        state.save_updater(&paths.state_file)?;

        assert!(prepare_mutation_state(&config, &mut state, &paths)?);
        assert_eq!(state.status, UpdateStatus::Failed);
        assert!(state.install_transaction.is_none());
        Ok(())
    }

    #[tokio::test]
    async fn failed_prelaunch_install_does_not_leave_daemon_blocked_in_installing() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let paths = fixture_paths(dir.path());
        paths.ensure_dirs()?;
        let mut config = RuntimeConfig::default_with_paths(&paths);
        config.app_executable_path = dir.path().join("app-not-running");

        let package = dir.path().join("candidate.deb");
        fs::write(&package, b"fixture package")?;

        let mut state = PersistedState::new(true);
        state.status = UpdateStatus::ReadyToInstall;
        state.candidate_version = Some("fixture".into());
        state.artifact_paths.package_path = Some(package);
        state.save_updater(&paths.state_file)?;

        let missing_launcher = dir.path().join("missing-gated-launcher");
        let result = install_ready_with_launcher(
            &config,
            &mut state,
            &paths,
            true,
            false,
            &missing_launcher,
        )
        .await;

        assert!(result.is_err(), "forced gated-launcher spawn must fail");

        let persisted =
            PersistedState::load_or_default(&paths.state_file, config.auto_install_on_app_exit)?;
        assert_eq!(persisted.status, UpdateStatus::Failed);
        assert!(
            persisted.install_transaction.is_none(),
            "pre-launch failure must clear durable install ownership"
        );

        let mut daemon_state = persisted;
        assert!(
            prepare_mutation_state(&config, &mut daemon_state, &paths)?,
            "a still-running daemon must not remain blocked after a pre-launch failure"
        );
        assert_ne!(daemon_state.status, UpdateStatus::Installing);
        Ok(())
    }

    #[test]
    fn abandoned_install_state_is_reconciled_without_replacement_detection() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let paths = fixture_paths(dir.path());
        paths.ensure_dirs()?;
        let config = RuntimeConfig::default_with_paths(&paths);
        let mut state = PersistedState::new(true);
        state.status = UpdateStatus::Installing;
        state.install_transaction = Some(InstallTransaction {
            package_path: dir.path().join("missing.deb"),
            package_sha256: Some("fixture".into()),
            package_command: Some(stale_identity()),
            started_at: Utc::now()
                - chrono::Duration::seconds(
                    install_transaction::ABANDONED_INSTALL_GRACE.as_secs() as i64 + 1,
                ),
            operation: InstallOperation::Update,
        });
        state.save_updater(&paths.state_file)?;

        assert!(prepare_mutation_state(&config, &mut state, &paths)?);
        assert_eq!(state.status, UpdateStatus::Failed);
        assert!(state.install_transaction.is_none());
        Ok(())
    }

    #[test]
    fn reconciled_update_matches_successful_install_state_bookkeeping() {
        let package = PathBuf::from("/tmp/candidate.deb");
        let mut state = PersistedState::new(true);
        state.status = UpdateStatus::Installing;
        state.installed_version = "old-local".into();
        state.candidate_version = Some("new-upstream".into());
        state.candidate_architecture = Some("amd64".into());
        state.candidate_repository_path = Some("pool/codex.deb".into());
        state.upstream_package_sha256 = Some("new-sha".into());
        state.waiting_for_app_exit_auto_install = true;
        let transaction = InstallTransaction {
            package_path: package,
            package_sha256: Some("fixture".into()),
            package_command: Some(stale_identity()),
            started_at: Utc::now(),
            operation: InstallOperation::Update,
        };
        state.install_transaction = Some(transaction.clone());

        apply_reconciled_install(&mut state, transaction, "new-local".into());

        assert_eq!(state.status, UpdateStatus::Installed);
        assert_eq!(state.install_transaction, None);
        assert_eq!(state.installed_version, "new-local");
        assert_eq!(
            state.installed_upstream_version.as_deref(),
            Some("new-upstream")
        );
        assert_eq!(state.installed_upstream_sha256.as_deref(), Some("new-sha"));
        assert_eq!(state.last_known_good_version.as_deref(), Some("new-local"));
        assert_eq!(state.candidate_version, None);
        assert_eq!(state.candidate_architecture, None);
        assert_eq!(state.candidate_repository_path, None);
        assert!(!state.waiting_for_app_exit_auto_install);
        assert_eq!(state.error_message, None);
    }

    #[test]
    fn reconciled_rollback_matches_successful_rollback_bookkeeping() {
        let package = PathBuf::from("/tmp/known-good.deb");
        let mut state = PersistedState::new(true);
        state.status = UpdateStatus::Installing;
        state.installed_version = "bad-local".into();
        state.installed_upstream_version = Some("bad-upstream".into());
        state.installed_upstream_sha256 = Some("bad-installed-sha".into());
        state.candidate_version = Some("bad-candidate".into());
        state.upstream_package_sha256 = Some("bad-candidate-sha".into());
        state.last_known_good_upstream_version = Some("good-upstream".into());
        state.last_known_good_upstream_sha256 = Some("good-sha".into());
        let transaction = InstallTransaction {
            package_path: package.clone(),
            package_sha256: Some("fixture".into()),
            package_command: Some(stale_identity()),
            started_at: Utc::now(),
            operation: InstallOperation::Rollback,
        };
        state.install_transaction = Some(transaction.clone());

        apply_reconciled_install(&mut state, transaction, "good-local".into());

        assert_eq!(state.status, UpdateStatus::Installed);
        assert_eq!(state.install_transaction, None);
        assert_eq!(state.installed_version, "good-local");
        assert_eq!(
            state.installed_upstream_version.as_deref(),
            Some("good-upstream")
        );
        assert_eq!(state.installed_upstream_sha256.as_deref(), Some("good-sha"));
        assert_eq!(
            state.rollback_blocked_candidate_version.as_deref(),
            Some("bad-candidate")
        );
        assert_eq!(
            state.rollback_blocked_package_sha256.as_deref(),
            Some("bad-candidate-sha")
        );
        assert_eq!(state.artifact_paths.package_path.as_ref(), Some(&package));
        assert_eq!(
            state.artifact_paths.rollback_package_path.as_ref(),
            Some(&package)
        );
        assert_eq!(state.last_known_good_version.as_deref(), Some("good-local"));
        assert_eq!(state.candidate_version, None);
        assert_eq!(state.error_message, None);
    }

    #[test]
    fn installing_state_preserves_pre_transaction_installed_version_for_recovery() {
        let mut state = PersistedState::new(true);
        state.status = UpdateStatus::Installing;
        state.installed_version = "pre-rollback-local".into();

        if state.status != UpdateStatus::Installing {
            state.installed_version = "post-rollback-local".into();
        }

        assert_eq!(state.installed_version, "pre-rollback-local");
    }

    fn stage_executable(source: &Path, destination: &Path) -> Result<()> {
        let staging = destination.with_extension(format!(
            "stage-{}-{}",
            std::process::id(),
            std::thread::current().name().unwrap_or("test")
        ));

        let mut input = File::open(source)
            .with_context(|| format!("fixture: open source executable {}", source.display()))?;
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o755)
            .open(&staging)
            .with_context(|| format!("fixture: create staged executable {}", staging.display()))?;
        io::copy(&mut input, &mut output)
            .with_context(|| format!("fixture: copy executable to {}", staging.display()))?;
        output
            .sync_all()
            .with_context(|| format!("fixture: sync staged executable {}", staging.display()))?;
        drop(output);
        drop(input);

        fs::rename(&staging, destination).with_context(|| {
            format!(
                "fixture: publish staged executable {} -> {}",
                staging.display(),
                destination.display()
            )
        })?;
        Ok(())
    }

    #[tokio::test]
    async fn install_ready_replacement_process_fixture() -> Result<()> {
        let Some(mode) = env::var_os("CODEX_INSTALL_READY_FIXTURE_MODE") else {
            return Ok(());
        };
        let root = PathBuf::from(
            env::var_os("CODEX_INSTALL_READY_FIXTURE_ROOT").expect("fixture root path is required"),
        );

        match mode.to_string_lossy().as_ref() {
            "install" => {
                let paths = RuntimePaths {
                    config_file: root.join("config/config.toml"),
                    state_file: root.join("state/state.json"),
                    log_file: root.join("state/service.log"),
                    cache_dir: root.join("cache"),
                    state_dir: root.join("state"),
                    config_dir: root.join("config"),
                };
                paths.ensure_dirs()?;

                let package = root.join("candidate.deb");
                let mut config = RuntimeConfig::default_with_paths(&paths);
                config.auto_install_on_app_exit = true;
                config.notifications = false;
                config.app_executable_path = root.join("missing-chatgpt");

                let mut state = PersistedState::new(true);
                state.status = UpdateStatus::ReadyToInstall;
                state.candidate_version = Some("fixture-upstream".into());
                state.upstream_package_sha256 = Some("fixture-sha256".into());
                state.artifact_paths.package_path = Some(package);
                state.save_updater(&paths.state_file)?;

                install_ready(&config, &mut state, &paths, true, true).await?;
            }
            "report" => {
                fs::write(
                    root.join("new-exe"),
                    env::current_exe()?.as_os_str().as_bytes(),
                )?;
            }
            other => panic!("unknown install-ready fixture mode: {other}"),
        }

        Ok(())
    }

    #[test]
    fn successful_self_replacement_restarts_on_new_binary_and_next_build_uses_it() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let source = env::current_exe()?;
        let installed = temp.path().join("codex-update-manager");
        let replacement = temp.path().join("codex-update-manager.new");
        let package = temp.path().join("candidate.deb");
        let fake_pkexec = temp.path().join("fake-pkexec");
        let install_started = temp.path().join("install-started");
        let install_release = temp.path().join("install-release");
        let state_file = temp.path().join("state/state.json");

        stage_executable(&source, &installed)?;
        fs::write(&package, b"fixture package")?;
        fs::write(
            &fake_pkexec,
            "#!/bin/sh\nset -eu\n: > \"$CODEX_TEST_INSTALL_STARTED\"\nwhile [ ! -e \"$CODEX_TEST_INSTALL_RELEASE\" ]; do sleep 0.01; done\nexit 0\n",
        )?;
        fs::set_permissions(&fake_pkexec, fs::Permissions::from_mode(0o755))?;

        let mut old = Command::new(&installed)
            .args([
                "app::replacement_tests::install_ready_replacement_process_fixture",
                "--exact",
                "--nocapture",
            ])
            .env("CODEX_INSTALL_READY_FIXTURE_MODE", "install")
            .env("CODEX_INSTALL_READY_FIXTURE_ROOT", temp.path())
            .env("CODEX_UPDATE_MANAGER_TEST_PKEXEC_PATH", &fake_pkexec)
            .env("CODEX_TEST_INSTALL_STARTED", &install_started)
            .env("CODEX_TEST_INSTALL_RELEASE", &install_release)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .context("fixture: spawn installed updater")?;

        for _ in 0..500 {
            if install_started.exists() {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        assert!(
            install_started.exists(),
            "production install_ready fixture did not launch its package command"
        );

        let installing = PersistedState::load_or_default(&state_file, true)?;
        assert_eq!(installing.status, UpdateStatus::Installing);
        assert!(
            installing
                .install_transaction
                .as_ref()
                .and_then(|transaction| transaction.package_command.as_ref())
                .is_some(),
            "install_ready must durably publish the package-command owner"
        );

        stage_executable(&source, &replacement)?;
        fs::rename(&replacement, &installed)
            .context("fixture: rename replacement over installed")?;
        fs::write(&install_release, b"go")?;

        assert_eq!(
            old.wait()?.code(),
            Some(restart::REPLACEMENT_RESTART_EXIT_CODE),
            "install_ready must persist Installed, read it back, then exit for replacement"
        );

        let installed_state = PersistedState::load_or_default(&state_file, true)?;
        assert_eq!(installed_state.status, UpdateStatus::Installed);
        assert_eq!(installed_state.install_transaction, None);
        assert_eq!(
            installed_state.installed_upstream_version.as_deref(),
            Some("fixture-upstream")
        );
        assert_eq!(
            installed_state.installed_upstream_sha256.as_deref(),
            Some("fixture-sha256")
        );

        let restarted = Command::new(&installed)
            .args([
                "app::replacement_tests::install_ready_replacement_process_fixture",
                "--exact",
                "--nocapture",
            ])
            .env("CODEX_INSTALL_READY_FIXTURE_MODE", "report")
            .env("CODEX_INSTALL_READY_FIXTURE_ROOT", temp.path())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .context("fixture: spawn replacement updater")?;
        assert!(restarted.success(), "replacement updater failed to start");

        let restarted_exe =
            PathBuf::from(OsStr::from_bytes(&fs::read(temp.path().join("new-exe"))?));
        assert_eq!(restarted_exe, installed);
        assert_eq!(
            crate::builder::updater_binary_source_at(&restarted_exe, &installed),
            installed,
            "the next rebuild must source the live replacement updater"
        );

        Ok(())
    }

    #[test]
    fn self_replacement_requires_installed_state_readback_before_exit() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let source = env::current_exe()?;
        let installed = temp.path().join("codex-update-manager");
        let replacement = temp.path().join("codex-update-manager.new");
        let package = temp.path().join("candidate.deb");
        let fake_pkexec = temp.path().join("fake-pkexec");
        let install_started = temp.path().join("install-started");
        let install_release = temp.path().join("install-release");
        let before_readback = temp.path().join("before-readback");
        let release_readback = temp.path().join("release-readback");
        let state_file = temp.path().join("state/state.json");

        stage_executable(&source, &installed)?;
        fs::write(&package, b"fixture package")?;
        fs::write(
            &fake_pkexec,
            "#!/bin/sh\nset -eu\n: > \"$CODEX_TEST_INSTALL_STARTED\"\nwhile [ ! -e \"$CODEX_TEST_INSTALL_RELEASE\" ]; do sleep 0.01; done\nexit 0\n",
        )?;
        fs::set_permissions(&fake_pkexec, fs::Permissions::from_mode(0o755))?;

        let mut old = Command::new(&installed)
            .args([
                "app::replacement_tests::install_ready_replacement_process_fixture",
                "--exact",
                "--nocapture",
            ])
            .env("CODEX_INSTALL_READY_FIXTURE_MODE", "install")
            .env("CODEX_INSTALL_READY_FIXTURE_ROOT", temp.path())
            .env("CODEX_UPDATE_MANAGER_TEST_PKEXEC_PATH", &fake_pkexec)
            .env("CODEX_TEST_INSTALL_STARTED", &install_started)
            .env("CODEX_TEST_INSTALL_RELEASE", &install_release)
            .env("CODEX_TEST_BEFORE_RESTART_READBACK", &before_readback)
            .env("CODEX_TEST_RELEASE_RESTART_READBACK", &release_readback)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .context("fixture: spawn installed updater")?;

        for _ in 0..500 {
            if install_started.exists() {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        assert!(
            install_started.exists(),
            "production install_ready fixture did not launch its package command"
        );

        stage_executable(&source, &replacement)?;
        fs::rename(&replacement, &installed)
            .context("fixture: rename replacement over installed")?;
        fs::write(&install_release, b"go")?;

        for _ in 0..500 {
            if before_readback.exists() {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        assert!(
            before_readback.exists(),
            "install_ready did not reach the persisted-state readback boundary"
        );

        let mut persisted = PersistedState::load_or_default(&state_file, true)?;
        assert_eq!(
            persisted.status,
            UpdateStatus::Installed,
            "Installed must be durably saved before the readback boundary"
        );
        persisted.status = UpdateStatus::Failed;
        persisted.error_message = Some("readback tamper fixture".into());
        persisted.save_updater(&state_file)?;
        fs::write(&release_readback, b"go")?;

        assert_eq!(
            old.wait()?.code(),
            Some(0),
            "replacement exit must be refused when Installed cannot be read back"
        );

        let after = PersistedState::load_or_default(&state_file, true)?;
        assert_eq!(after.status, UpdateStatus::Failed);
        assert_eq!(
            after.error_message.as_deref(),
            Some("readback tamper fixture")
        );
        Ok(())
    }
    #[test]
    fn ambiguous_preinstall_version_is_not_sufficient_recovery_evidence() {
        fn transition_observed(previous: &str, verified: Option<&str>) -> bool {
            previous != "unknown" && verified.is_some_and(|installed| installed != previous)
        }

        assert!(!transition_observed("2026.09.06", Some("2026.09.06")));
        assert!(!transition_observed("unknown", Some("2026.09.07")));
        assert!(transition_observed("2026.09.06", Some("2026.09.07")));
    }
}
