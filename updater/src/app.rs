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

const UNKNOWN_INSTALL_RECOVERY_MESSAGE: &str = "Package transaction owner could not be classified safely after the recovery grace period; automatic recovery stopped. Confirm no package manager is running, then explicitly retry the interrupted update or rollback";

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
            check(&config, &mut state, &paths, false, true).await
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
            if !prepare_explicit_mutation_state(&config, &mut state, &paths)? {
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
            if !prepare_explicit_mutation_state(&config, &mut state, &paths)? {
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
            if let Err(error) = check(config, state, paths, true, false).await {
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
                        if let Err(error) = check(config, state, paths, true, false).await {
                            error!(?error, "periodic update check failed");
                        }
                    }
                }
            },
            _ = reconcile.tick() => {
                if let Some(_lock) = MutationLock::try_acquire(&paths.state_dir.join("check.lock"))? {
                    if daemon_replacement_gate(config, state, paths)? {
                        if let Err(error) = reconcile_pending_install(config, state, paths).await {
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

async fn reconcile_pending_install(
    config: &RuntimeConfig,
    state: &mut PersistedState,
    paths: &RuntimePaths,
) -> Result<()> {
    match state.status {
        UpdateStatus::WaitingForAppExit if !liveness::is_app_running(config)? => {
            install_ready(config, state, paths, false, true).await?;
        }
        UpdateStatus::ReadyToInstall
            if state.install_auth_retry_is_blocked()
                && (config.auto_install_on_app_exit || state.install_after_app_exit_requested)
                && liveness::is_app_running(config)? =>
        {
            state.clear_install_auth_retry_block();
            state.status = UpdateStatus::WaitingForAppExit;
            state.waiting_for_app_exit_auto_install =
                !state.install_after_app_exit_requested && config.auto_install_on_app_exit;
            state.save_updater(&paths.state_file)?;
        }
        _ => {}
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
    prepare_mutation_state_with_policy(config, state, paths, false)
}

fn prepare_explicit_mutation_state(
    config: &RuntimeConfig,
    state: &mut PersistedState,
    paths: &RuntimePaths,
) -> Result<bool> {
    prepare_mutation_state_with_policy(config, state, paths, true)
}

fn prepare_mutation_state_with_policy(
    config: &RuntimeConfig,
    state: &mut PersistedState,
    paths: &RuntimePaths,
    allow_manual_recovery: bool,
) -> Result<bool> {
    *state = PersistedState::load_or_default(&paths.state_file, config.auto_install_on_app_exit)?;

    if state.manual_recovery_required && !allow_manual_recovery {
        warn!("manual recovery confirmation is required before automatic updater work");
        return Ok(false);
    }

    if state.status != UpdateStatus::Installing {
        state.installed_version = install::installed_package_version();
        state.save_updater(&paths.state_file)?;
        return Ok(true);
    }

    match state.install_transaction.clone() {
        Some(transaction) => {
            let owner_state = install_transaction::owner_state(&transaction);
            match owner_state {
                install_transaction::OwnerState::Running => Ok(false),
                install_transaction::OwnerState::Unknown => {
                    if !install_transaction::grace_expired(&transaction) {
                        warn!(
                            "package transaction owner cannot be classified safely; deferring recovery"
                        );
                        return Ok(false);
                    }
                    state.mark_manual_recovery_required(UNKNOWN_INSTALL_RECOVERY_MESSAGE);
                    state.save_updater(&paths.state_file)?;
                    if allow_manual_recovery {
                        // This explicit install-ready/rollback invocation is
                        // the user's confirmation that no package manager is
                        // still running. The transaction has been cleared, so
                        // the requested operation can proceed immediately.
                        Ok(true)
                    } else {
                        Ok(false)
                    }
                }
                install_transaction::OwnerState::NotStarted
                | install_transaction::OwnerState::Exited
                    if !install_transaction::grace_expired(&transaction) =>
                {
                    Ok(false)
                }
                install_transaction::OwnerState::NotStarted
                | install_transaction::OwnerState::Exited => {
                    recover_abandoned_install(state, paths)?;
                    Ok(true)
                }
            }
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
            let upstream_identity_proven = state
                .artifact_paths
                .package_candidate_sha256
                .as_deref()
                .zip(state.upstream_package_sha256.as_deref())
                .is_some_and(|(package_candidate, candidate)| package_candidate == candidate);
            state.installed_version = installed_version;
            state.installed_upstream_version = upstream_identity_proven
                .then(|| state.candidate_version.clone())
                .flatten();
            state.installed_upstream_sha256 = upstream_identity_proven
                .then(|| state.upstream_package_sha256.clone())
                .flatten();
            state
                .last_known_good_version
                .get_or_insert_with(|| state.installed_version.clone());
            state.candidate_version = None;
            state.candidate_architecture = None;
            state.candidate_repository_path = None;
            state.artifact_paths.package_path = Some(transaction.package_path.clone());
            if !upstream_identity_proven {
                state.artifact_paths.package_candidate_sha256 = None;
            }
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
            state.artifact_paths.package_candidate_sha256 = None;
            state.artifact_paths.rollback_package_path = Some(transaction.package_path);
            state.last_known_good_version = Some(state.installed_version.clone());
        }
    }

    state.status = UpdateStatus::Installed;
    state.manual_recovery_required = false;
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
    retry_failed_candidate: bool,
) -> Result<()> {
    recover_interrupted_check(state);
    let previous_state = state.clone();
    let previous_status = state.status.clone();
    let previous_sha256 = state.upstream_package_sha256.clone();
    let previous_error = state.error_message.clone();
    let previous_waiting_auto_install = state.waiting_for_app_exit_auto_install;
    state.installed_version = install::installed_package_version();
    mark_check_started(state);
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
        Err(error) => return fail_check(config, state, paths, previous_state.clone(), error),
    };
    state.last_successful_check_at = Some(Utc::now());
    let _ = cache_cleanup::prune(&paths.cache_dir, state);

    let same_failed_candidate = previous_status == UpdateStatus::Failed
        && previous_sha256.as_deref() == Some(metadata.sha256.as_str());
    let failed_candidate_has_package = previous_state
        .artifact_paths
        .package_path
        .as_ref()
        .is_some_and(|path| path.is_file() && package_matches_candidate(&previous_state));
    let already_installed = state.installed_upstream_version.as_deref()
        == Some(metadata.version.as_str())
        && state.installed_upstream_sha256.as_deref() == Some(metadata.sha256.as_str())
        && state.candidate_version.is_none();
    if already_installed
        || preserves_failed_candidate(
            same_failed_candidate,
            retry_failed_candidate,
            failed_candidate_has_package,
        )
    {
        state.status = if same_failed_candidate {
            UpdateStatus::Failed
        } else {
            UpdateStatus::Idle
        };
        if same_failed_candidate {
            state.error_message = previous_error;
        }
        if already_installed {
            state.clear_install_auth_retry_block();
            state.install_after_app_exit_requested = false;
        }
        state.save_updater(&paths.state_file)?;
        return Ok(());
    }

    if same_pending_candidate(&previous_state, &metadata.version, &metadata.sha256) {
        state.status = previous_status;
        state.error_message = previous_error;
        state.waiting_for_app_exit_auto_install = previous_waiting_auto_install;
        return install_ready(config, state, paths, false, restart_on_replacement).await;
    }

    rollback::record_current_package_as_known_good(state);
    state.candidate_version = Some(metadata.version.clone());
    state.candidate_architecture = Some(metadata.architecture.clone());
    state.candidate_repository_path = Some(metadata.repository_path.clone());
    state.upstream_package_sha256 = Some(metadata.sha256.clone());
    state.artifact_paths.package_path = None;
    state.artifact_paths.package_candidate_sha256 = None;
    state.clear_install_auth_retry_block();
    state.install_after_app_exit_requested = false;
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
        Err(error) => return fail_update(config, state, paths, &previous_state, error),
    };
    state.artifact_paths.upstream_package_path = Some(upstream_package.clone());
    if let Err(error) =
        builder::build_update(config, state, paths, &metadata.version, &upstream_package).await
    {
        return fail_update(config, state, paths, &previous_state, error);
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

fn preserves_failed_candidate(
    same_failed_candidate: bool,
    retry_failed_candidate: bool,
    failed_candidate_has_package: bool,
) -> bool {
    same_failed_candidate && (!retry_failed_candidate || failed_candidate_has_package)
}

fn package_matches_candidate(state: &PersistedState) -> bool {
    state
        .upstream_package_sha256
        .as_deref()
        .is_some_and(|candidate_sha256| {
            state.artifact_paths.package_candidate_sha256.as_deref() == Some(candidate_sha256)
        })
}

fn mark_check_started(state: &mut PersistedState) {
    if !state.install_auth_retry_is_blocked() {
        state.status = UpdateStatus::CheckingUpstream;
        state.error_message = None;
    }
    state.last_check_at = Some(Utc::now());
}

fn recover_interrupted_check(state: &mut PersistedState) {
    if state.status == UpdateStatus::CheckingUpstream && state.install_auth_retry_is_blocked() {
        state.status = UpdateStatus::ReadyToInstall;
    }
}

fn same_pending_candidate(state: &PersistedState, version: &str, sha256: &str) -> bool {
    state.candidate_version.as_deref() == Some(version)
        && state.upstream_package_sha256.as_deref() == Some(sha256)
        && package_matches_candidate(state)
        && matches!(
            state.status,
            UpdateStatus::ReadyToInstall | UpdateStatus::WaitingForAppExit
        )
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
    if !package_matches_candidate(state) {
        let retry_unbound_candidate = state.artifact_paths.package_candidate_sha256.is_none();
        let recovery = if retry_unbound_candidate {
            "it will be rebuilt on the next check"
        } else {
            "run check-now to rebuild"
        };
        let message = format!(
            "rebuilt package is not bound to candidate {}; {recovery}",
            state.candidate_version.as_deref().unwrap_or("unknown"),
        );
        state.mark_failed(&message);
        if retry_unbound_candidate {
            state.candidate_version = None;
            state.candidate_architecture = None;
            state.candidate_repository_path = None;
            state.upstream_package_sha256 = None;
        }
        state.artifact_paths.package_path = None;
        state.artifact_paths.package_candidate_sha256 = None;
        state.save_updater(&paths.state_file)?;
        anyhow::bail!(message);
    }
    anyhow::ensure!(
        package.is_file(),
        "rebuilt package is missing: {}",
        package.display()
    );
    if explicit_retry {
        // An explicit install-ready command is the user's confirmation that
        // any previously ambiguous package transaction has been checked.
        state.manual_recovery_required = false;
    }
    let auth_retry_blocked = state.install_auth_retry_is_blocked();
    let install_after_app_exit_requested = state.install_after_app_exit_requested;
    if liveness::is_app_running(config)? {
        if !explicit_retry && !install_after_app_exit_requested && !config.auto_install_on_app_exit
        {
            state.status = UpdateStatus::ReadyToInstall;
            state.waiting_for_app_exit_auto_install = false;
            state.save_updater(&paths.state_file)?;
            return Ok(());
        }
        state.clear_install_auth_retry_block();
        state.status = UpdateStatus::WaitingForAppExit;
        state.install_after_app_exit_requested = explicit_retry || install_after_app_exit_requested;
        state.waiting_for_app_exit_auto_install =
            !state.install_after_app_exit_requested && config.auto_install_on_app_exit;
        state.save_updater(&paths.state_file)?;
        println!("Update is ready; close ChatGPT Community to install it.");
        return Ok(());
    }
    if !explicit_retry && auth_retry_blocked {
        state.status = UpdateStatus::ReadyToInstall;
        state.waiting_for_app_exit_auto_install = false;
        state.save_updater(&paths.state_file)?;
        return Ok(());
    }
    if !explicit_retry && !install_after_app_exit_requested && !config.auto_install_on_app_exit {
        state.status = UpdateStatus::ReadyToInstall;
        state.save_updater(&paths.state_file)?;
        return Ok(());
    }

    let explicit_install = explicit_retry || install_after_app_exit_requested;
    state.clear_install_auth_retry_block();
    state.install_after_app_exit_requested = false;
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
        if pkexec_authentication_was_not_obtained(&output.status) {
            let mut message = format!("privileged install exited with status {}", output.status);
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stderr = stderr.trim();
            if !stderr.is_empty() {
                message.push_str(": ");
                message.push_str(stderr);
            }
            let error = anyhow::anyhow!(message);
            state.install_transaction = None;
            state.status = UpdateStatus::ReadyToInstall;
            state.waiting_for_app_exit_auto_install = false;
            state.error_message = Some(format!("{error:#}"));
            state.block_install_auth_retry();
            state.install_after_app_exit_requested = explicit_install;
            state.save_updater(&paths.state_file)?;
            return Err(error);
        }
        // The launch gate has already been released, so a nonzero exit cannot
        // prove that the package manager made no changes. Keep the durable
        // Installing transaction intact and let ownership-aware reconciliation
        // determine whether the package completed, partially applied, or failed.
        anyhow::bail!(
            "privileged install exited unsuccessfully after package mutation may have started: {}",
            String::from_utf8_lossy(&output.stderr).trim()
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
    state.clear_install_auth_retry_block();
    state.install_after_app_exit_requested = false;
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

fn pkexec_authentication_was_not_obtained(status: &std::process::ExitStatus) -> bool {
    matches!(status.code(), Some(126 | 127))
}

fn fail_check<T>(
    config: &RuntimeConfig,
    state: &mut PersistedState,
    paths: &RuntimePaths,
    mut previous_state: PersistedState,
    error: anyhow::Error,
) -> Result<T> {
    if matches!(
        previous_state.status,
        UpdateStatus::ReadyToInstall | UpdateStatus::WaitingForAppExit
    ) {
        previous_state.last_check_at = state.last_check_at;
        *state = previous_state;
        state.save_updater(&paths.state_file)?;
        return Err(error);
    }
    fail_update(config, state, paths, &previous_state, error)
}

fn fail<T>(state: &mut PersistedState, paths: &RuntimePaths, error: anyhow::Error) -> Result<T> {
    state.mark_failed(format!("{error:#}"));
    state.save_updater(&paths.state_file)?;
    Err(error)
}

fn fail_update<T>(
    config: &RuntimeConfig,
    state: &mut PersistedState,
    paths: &RuntimePaths,
    previous: &PersistedState,
    error: anyhow::Error,
) -> Result<T> {
    fail_update_with(config, state, paths, previous, error, |summary, body| {
        let _ = notify::send(summary, body);
    })
}

/// Persist a failed check before notifying. Repeat failures for the same
/// candidate stay silent; a new candidate or a recovered updater notifies.
fn fail_update_with<T>(
    config: &RuntimeConfig,
    state: &mut PersistedState,
    paths: &RuntimePaths,
    previous: &PersistedState,
    error: anyhow::Error,
    send: impl FnOnce(&str, &str),
) -> Result<T> {
    let notification = should_notify_failure(config, state, previous).then(|| {
        format!(
            "Update check failed{}: {}. Run codex-update-manager diagnose.",
            state
                .candidate_version
                .as_deref()
                .map(|version| format!(" for {version}"))
                .unwrap_or_default(),
            error
        )
    });
    let result = fail(state, paths, error);
    if let Some(body) = notification {
        send("codex-desktop update failed", &body);
    }
    result
}

fn should_notify_failure(
    config: &RuntimeConfig,
    current: &PersistedState,
    previous: &PersistedState,
) -> bool {
    config.notifications
        && (previous.status != UpdateStatus::Failed
            || previous.upstream_package_sha256 != current.upstream_package_sha256)
}

fn status(state: &PersistedState, json: bool) -> Result<()> {
    if json {
        println!("{}", serde_json::to_string_pretty(state)?);
    } else {
        println!("status: {:?}", state.status);
        println!(
            "manual_recovery_required: {}",
            state.manual_recovery_required
        );
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
        "manualRecoveryRequired": state.manual_recovery_required,
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

    #[test]
    fn explicit_check_retries_the_same_failed_candidate() {
        assert!(preserves_failed_candidate(true, false, false));
        assert!(!preserves_failed_candidate(true, true, false));
        assert!(preserves_failed_candidate(true, true, true));
        assert!(!preserves_failed_candidate(false, false, false));
    }

    #[test]
    fn explicit_check_retries_when_package_belongs_to_an_older_candidate() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let package = dir.path().join("older-candidate.deb");
        fs::write(&package, b"older candidate")?;

        let mut state = ready_state(package);
        state.status = UpdateStatus::Failed;
        state.upstream_package_sha256 = Some("new-candidate-sha256".into());
        state.artifact_paths.package_candidate_sha256 = Some("older-candidate-sha256".into());

        let failed_candidate_has_package = state
            .artifact_paths
            .package_path
            .as_ref()
            .is_some_and(|path| path.is_file() && package_matches_candidate(&state));
        assert!(!failed_candidate_has_package);
        assert!(!preserves_failed_candidate(
            true,
            true,
            failed_candidate_has_package
        ));
        Ok(())
    }

    #[test]
    fn install_ready_rejects_package_bound_to_an_older_candidate() -> Result<()> {
        let _env_guard = crate::test_util::env_lock();
        let _restore_env = crate::test_util::EnvRestoreGuard::capture(&[
            "CODEX_UPDATE_MANAGER_TEST_PKEXEC_PATH",
            "CODEX_UPDATE_MANAGER_TEST_PKEXEC_COUNT",
            "CODEX_UPDATE_MANAGER_TEST_PKEXEC_EXIT",
        ]);
        let temp = tempfile::tempdir()?;
        let paths = fixture_paths(temp.path());
        paths.ensure_dirs()?;
        let package = temp.path().join("older-candidate.deb");
        fs::write(&package, b"older candidate")?;
        let fake_pkexec = write_fake_pkexec(temp.path())?;
        let invocation_count = temp.path().join("pkexec-count");
        env::set_var("CODEX_UPDATE_MANAGER_TEST_PKEXEC_PATH", fake_pkexec);
        env::set_var("CODEX_UPDATE_MANAGER_TEST_PKEXEC_COUNT", &invocation_count);
        env::set_var("CODEX_UPDATE_MANAGER_TEST_PKEXEC_EXIT", "0");

        let mut config = RuntimeConfig::default_with_paths(&paths);
        config.auto_install_on_app_exit = false;
        config.notifications = false;
        config.app_executable_path = temp.path().join("not-running");
        let mut state = ready_state(package);
        state.status = UpdateStatus::Failed;
        state.upstream_package_sha256 = Some("new-candidate-sha256".into());
        state.artifact_paths.package_candidate_sha256 = Some("older-candidate-sha256".into());

        let runtime = tokio::runtime::Runtime::new()?;
        let error = runtime
            .block_on(install_ready_with_launcher(
                &config,
                &mut state,
                &paths,
                true,
                false,
                Path::new("/bin/sh"),
            ))
            .expect_err("an artifact from another candidate must be rejected");

        assert!(error.to_string().contains("not bound to candidate"));
        assert_eq!(state.status, UpdateStatus::Failed);
        assert_eq!(
            state.candidate_version.as_deref(),
            Some("2026.09.10.120000")
        );
        assert_eq!(
            state.upstream_package_sha256.as_deref(),
            Some("new-candidate-sha256")
        );
        assert!(state.artifact_paths.package_path.is_none());
        assert!(state.artifact_paths.package_candidate_sha256.is_none());
        assert!(
            !invocation_count.exists(),
            "stale artifact must not launch pkexec"
        );
        Ok(())
    }

    #[test]
    fn schema_three_pending_candidates_without_binding_are_rebuilt() -> Result<()> {
        for status in [
            UpdateStatus::ReadyToInstall,
            UpdateStatus::WaitingForAppExit,
        ] {
            let temp = tempfile::tempdir()?;
            let paths = fixture_paths(temp.path());
            paths.ensure_dirs()?;
            let package = temp.path().join("legacy-candidate.deb");
            fs::write(&package, b"legacy candidate")?;

            let mut legacy = PersistedState::new(true);
            legacy.schema_version = 3;
            legacy.status = status;
            legacy.candidate_version = Some("2026.09.10.120000".into());
            legacy.upstream_package_sha256 = Some("legacy-candidate-sha256".into());
            legacy.artifact_paths.package_path = Some(package);

            let mut raw = serde_json::to_value(legacy)?;
            raw.get_mut("artifact_paths")
                .and_then(serde_json::Value::as_object_mut)
                .expect("artifact paths object")
                .remove("package_candidate_sha256");
            fs::write(&paths.state_file, serde_json::to_vec_pretty(&raw)?)?;

            let loaded = PersistedState::load_or_default(&paths.state_file, true)?;
            assert_eq!(loaded.schema_version, 4);
            assert!(loaded.artifact_paths.package_candidate_sha256.is_none());
            assert!(!same_pending_candidate(
                &loaded,
                "2026.09.10.120000",
                "legacy-candidate-sha256"
            ));
        }
        Ok(())
    }

    #[test]
    fn schema_three_pending_candidates_retry_after_metadata_failure_and_reconcile() -> Result<()> {
        let runtime = tokio::runtime::Runtime::new()?;
        for pending_status in [
            UpdateStatus::ReadyToInstall,
            UpdateStatus::WaitingForAppExit,
        ] {
            let temp = tempfile::tempdir()?;
            let paths = fixture_paths(temp.path());
            paths.ensure_dirs()?;
            let package = temp.path().join("legacy-candidate.deb");
            fs::write(&package, b"legacy candidate")?;

            let mut legacy = PersistedState::new(true);
            legacy.schema_version = 3;
            legacy.status = pending_status.clone();
            legacy.candidate_version = Some("2026.09.10.120000".into());
            legacy.candidate_architecture = Some("amd64".into());
            legacy.candidate_repository_path = Some("pool/chatgpt.deb".into());
            legacy.upstream_package_sha256 = Some("legacy-candidate-sha256".into());
            legacy.artifact_paths.package_path = Some(package);
            legacy.waiting_for_app_exit_auto_install =
                pending_status == UpdateStatus::WaitingForAppExit;

            let mut raw = serde_json::to_value(legacy)?;
            raw.get_mut("artifact_paths")
                .and_then(serde_json::Value::as_object_mut)
                .expect("artifact paths object")
                .remove("package_candidate_sha256");
            fs::write(&paths.state_file, serde_json::to_vec_pretty(&raw)?)?;

            let mut state = PersistedState::load_or_default(&paths.state_file, true)?;
            let previous = state.clone();
            mark_check_started(&mut state);
            let config = RuntimeConfig::default_with_paths(&paths);
            fail_check::<()>(
                &config,
                &mut state,
                &paths,
                previous,
                anyhow::anyhow!("transient metadata failure"),
            )
            .expect_err("metadata failure should be reported");
            assert_eq!(state.status, pending_status);

            let mut config = RuntimeConfig::default_with_paths(&paths);
            config.app_executable_path = temp.path().join("not-running");
            let reconcile =
                runtime.block_on(reconcile_pending_install(&config, &mut state, &paths));
            if pending_status == UpdateStatus::WaitingForAppExit {
                let error = reconcile.expect_err("unbound waiting artifact must be rejected");
                assert!(error.to_string().contains("not bound to candidate"));
                assert_eq!(state.status, UpdateStatus::Failed);
                assert!(state.candidate_version.is_none());
                assert!(state.candidate_architecture.is_none());
                assert!(state.candidate_repository_path.is_none());
                assert!(state.upstream_package_sha256.is_none());
            } else {
                reconcile?;
            }

            let persisted = PersistedState::load_or_default(&paths.state_file, true)?;
            let same_failed_candidate = persisted.status == UpdateStatus::Failed
                && persisted.upstream_package_sha256.as_deref() == Some("legacy-candidate-sha256");
            let failed_candidate_has_package = persisted
                .artifact_paths
                .package_path
                .as_ref()
                .is_some_and(|path| path.is_file() && package_matches_candidate(&persisted));
            assert!(!preserves_failed_candidate(
                same_failed_candidate,
                false,
                failed_candidate_has_package
            ));
            assert!(!same_pending_candidate(
                &persisted,
                "2026.09.10.120000",
                "legacy-candidate-sha256"
            ));
        }
        Ok(())
    }

    fn stale_identity() -> ProcessIdentity {
        ProcessIdentity {
            pid: std::process::id(),
            start_time_ticks: 0,
            boot_id: Some("stale-boot".into()),
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

    fn ready_state(package: PathBuf) -> PersistedState {
        let mut state = PersistedState::new(true);
        state.candidate_version = Some("2026.09.10.120000".into());
        state.upstream_package_sha256 = Some("candidate-sha256".into());
        state.artifact_paths.package_path = Some(package);
        state.artifact_paths.package_candidate_sha256 = state.upstream_package_sha256.clone();
        state.status = UpdateStatus::ReadyToInstall;
        state
    }

    fn write_fake_pkexec(root: &Path) -> Result<PathBuf> {
        let path = root.join("pkexec");
        fs::write(
            &path,
            "#!/bin/sh\nprintf x >> \"$CODEX_UPDATE_MANAGER_TEST_PKEXEC_COUNT\"\nexit \"$CODEX_UPDATE_MANAGER_TEST_PKEXEC_EXIT\"\n",
        )?;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700))?;
        Ok(path)
    }

    fn abandoned_state(package: PathBuf, installed_version: &str) -> Result<PersistedState> {
        let package_sha256 = install_transaction::package_sha256(&package)?;
        let mut state = PersistedState::new(true);
        state.status = UpdateStatus::Installing;
        state.installed_version = installed_version.into();
        state.candidate_version = Some("candidate-upstream".into());
        state.upstream_package_sha256 = Some("candidate-upstream-sha".into());
        state.install_transaction = Some(InstallTransaction {
            package_path: package,
            package_sha256: Some(package_sha256),
            package_command: Some(stale_identity()),
            started_at: Utc::now()
                - chrono::Duration::seconds(
                    install_transaction::ABANDONED_INSTALL_GRACE.as_secs() as i64 + 1,
                ),
            operation: InstallOperation::Update,
        });
        Ok(state)
    }

    fn write_fake_rpm_recovery_command(
        root: &Path,
        verification_succeeds: bool,
    ) -> Result<PathBuf> {
        let path = root.join("rpm-recovery-fixture");
        let verification = if verification_succeeds {
            "exit 0"
        } else {
            "exit 1"
        };
        let script = r#"#!/bin/sh
set -eu
if [ "$1" = "-V" ]; then
  [ "$2" = "--noscripts" ]
  __VERIFY__
fi
if [ "$1" = "-q" ] || [ "$1" = "-qp" ]; then
  if [ "$3" = "%{NAME}" ]; then
    printf 'codex-desktop\n'
  elif [ "$3" = "%{VERSION}-%{RELEASE}" ]; then
    printf '2026.09.06-1.fc42\n'
  else
    printf 'codex-desktop\t2026.09.06-1.fc42\tx86_64\n'
  fi
  exit 0
fi
exit 90
"#
        .replace("__VERIFY__", verification);
        fs::write(&path, script)?;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700))?;
        Ok(path)
    }

    fn write_fake_pacman_recovery_command(
        root: &Path,
        verification_succeeds: bool,
    ) -> Result<PathBuf> {
        let path = root.join("pacman-recovery-fixture");
        let verification = if verification_succeeds {
            "exit 0"
        } else {
            "exit 1"
        };
        let script = r#"#!/bin/sh
set -eu
if [ "$1" = "-Q" ] && [ "$2" = "codex-desktop" ]; then
  printf 'codex-desktop 2026.09.06-1\n'
  exit 0
fi
if [ "$1" = "-Qip" ] || [ "$1" = "-Qi" ]; then
  printf 'Name            : codex-desktop\n'
  printf 'Version         : 2026.09.06-1\n'
  printf 'Architecture    : x86_64\n'
  exit 0
fi
if [ "$1" = "-Qkk" ]; then
  __VERIFY__
fi
exit 90
"#
        .replace("__VERIFY__", verification);
        fs::write(&path, script)?;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700))?;
        Ok(path)
    }

    #[test]
    fn pkexec_authentication_failures_are_retryable() -> Result<()> {
        for code in [126, 127] {
            let status = Command::new("/bin/sh")
                .arg("-c")
                .arg(format!("exit {code}"))
                .status()?;
            assert!(pkexec_authentication_was_not_obtained(&status));
        }

        let status = Command::new("/bin/sh").arg("-c").arg("exit 1").status()?;
        assert!(!pkexec_authentication_was_not_obtained(&status));
        Ok(())
    }

    #[test]
    fn auth_cancel_retries_only_after_another_app_exit() -> Result<()> {
        let _env_guard = crate::test_util::env_lock();
        let _restore_env = crate::test_util::EnvRestoreGuard::capture(&[
            "CODEX_UPDATE_MANAGER_TEST_PKEXEC_PATH",
            "CODEX_UPDATE_MANAGER_TEST_PKEXEC_COUNT",
            "CODEX_UPDATE_MANAGER_TEST_PKEXEC_EXIT",
        ]);
        let runtime = tokio::runtime::Runtime::new()?;
        let temp = tempfile::tempdir()?;
        let paths = fixture_paths(temp.path());
        paths.ensure_dirs()?;
        let package = temp.path().join("codex-desktop.deb");
        fs::write(&package, b"package")?;
        let fake_pkexec = write_fake_pkexec(temp.path())?;
        let invocation_count = temp.path().join("pkexec-count");
        env::set_var("CODEX_UPDATE_MANAGER_TEST_PKEXEC_PATH", fake_pkexec);
        env::set_var("CODEX_UPDATE_MANAGER_TEST_PKEXEC_COUNT", &invocation_count);
        env::set_var("CODEX_UPDATE_MANAGER_TEST_PKEXEC_EXIT", "126");

        let mut config = RuntimeConfig::default_with_paths(&paths);
        config.auto_install_on_app_exit = false;
        config.notifications = false;
        config.app_executable_path = temp.path().join("not-running");
        let mut state = ready_state(package);

        let error = runtime
            .block_on(install_ready_with_launcher(
                &config,
                &mut state,
                &paths,
                true,
                false,
                Path::new("/bin/sh"),
            ))
            .expect_err("authentication cancellation should be reported");
        assert!(error.to_string().contains("status exit status: 126"));
        assert_eq!(state.status, UpdateStatus::ReadyToInstall);
        assert!(state.install_transaction.is_none());
        assert!(state.install_auth_retry_is_blocked());
        assert!(state.install_after_app_exit_requested);
        assert_eq!(fs::read_to_string(&invocation_count)?, "x");

        let mut daemon_state = PersistedState::new(false);
        assert!(prepare_mutation_state(&config, &mut daemon_state, &paths)?);
        runtime.block_on(reconcile_pending_install(
            &config,
            &mut daemon_state,
            &paths,
        ))?;
        state = daemon_state;
        assert_eq!(state.status, UpdateStatus::ReadyToInstall);
        assert!(state.install_auth_retry_is_blocked());
        assert!(state.install_after_app_exit_requested);
        assert_eq!(fs::read_to_string(&invocation_count)?, "x");

        runtime
            .block_on(install_ready_with_launcher(
                &config,
                &mut state,
                &paths,
                true,
                false,
                Path::new("/bin/sh"),
            ))
            .expect_err("an explicit retry should bypass the authentication block");
        assert_eq!(state.status, UpdateStatus::ReadyToInstall);
        assert!(state.install_transaction.is_none());
        assert!(state.install_auth_retry_is_blocked());
        assert!(state.install_after_app_exit_requested);
        assert_eq!(fs::read_to_string(&invocation_count)?, "xx");

        config.app_executable_path = env::current_exe()?;
        runtime.block_on(reconcile_pending_install(&config, &mut state, &paths))?;
        assert_eq!(state.status, UpdateStatus::WaitingForAppExit);
        assert!(!state.install_auth_retry_is_blocked());
        assert!(state.install_after_app_exit_requested);
        assert_eq!(fs::read_to_string(&invocation_count)?, "xx");

        runtime.block_on(install_ready_with_launcher(
            &config,
            &mut state,
            &paths,
            false,
            false,
            Path::new("/bin/sh"),
        ))?;
        assert_eq!(state.status, UpdateStatus::WaitingForAppExit);
        assert!(!state.waiting_for_app_exit_auto_install);
        assert_eq!(fs::read_to_string(&invocation_count)?, "xx");

        config.app_executable_path = temp.path().join("not-running");
        runtime
            .block_on(reconcile_pending_install(&config, &mut state, &paths))
            .expect_err("the next app exit should permit one retry");
        assert_eq!(state.status, UpdateStatus::ReadyToInstall);
        assert!(state.install_transaction.is_none());
        assert!(state.install_auth_retry_is_blocked());
        assert!(state.install_after_app_exit_requested);
        assert_eq!(fs::read_to_string(&invocation_count)?, "xxx");
        Ok(())
    }

    #[test]
    fn non_authentication_install_failure_preserves_recovery_transaction() -> Result<()> {
        let _env_guard = crate::test_util::env_lock();
        let _restore_env = crate::test_util::EnvRestoreGuard::capture(&[
            "CODEX_UPDATE_MANAGER_TEST_PKEXEC_PATH",
            "CODEX_UPDATE_MANAGER_TEST_PKEXEC_COUNT",
            "CODEX_UPDATE_MANAGER_TEST_PKEXEC_EXIT",
        ]);
        let runtime = tokio::runtime::Runtime::new()?;
        let temp = tempfile::tempdir()?;
        let paths = fixture_paths(temp.path());
        paths.ensure_dirs()?;
        let package = temp.path().join("codex-desktop.deb");
        fs::write(&package, b"package")?;
        env::set_var(
            "CODEX_UPDATE_MANAGER_TEST_PKEXEC_PATH",
            write_fake_pkexec(temp.path())?,
        );
        env::set_var(
            "CODEX_UPDATE_MANAGER_TEST_PKEXEC_COUNT",
            temp.path().join("pkexec-count"),
        );
        env::set_var("CODEX_UPDATE_MANAGER_TEST_PKEXEC_EXIT", "1");

        let mut config = RuntimeConfig::default_with_paths(&paths);
        config.notifications = false;
        config.app_executable_path = temp.path().join("not-running");
        let mut state = ready_state(package);

        runtime
            .block_on(install_ready_with_launcher(
                &config,
                &mut state,
                &paths,
                true,
                false,
                Path::new("/bin/sh"),
            ))
            .expect_err("ordinary post-gate install failure should remain recoverable");
        assert_eq!(state.status, UpdateStatus::Installing);
        assert!(state.install_transaction.is_some());
        assert!(!state.install_auth_retry_is_blocked());
        assert!(!state.install_after_app_exit_requested);
        Ok(())
    }

    #[test]
    fn failed_check_preserves_pending_auth_retry_state() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let paths = fixture_paths(temp.path());
        paths.ensure_dirs()?;
        let package = temp.path().join("codex-desktop.deb");
        fs::write(&package, b"package")?;

        let mut previous = ready_state(package);
        previous.error_message = Some("authentication was not obtained".into());
        previous.block_install_auth_retry();
        let mut checking = previous.clone();
        checking.status = UpdateStatus::CheckingUpstream;
        checking.last_check_at = Some(Utc::now());

        fail_check::<()>(
            &RuntimeConfig::default_with_paths(&paths),
            &mut checking,
            &paths,
            previous,
            anyhow::anyhow!("temporary repository failure"),
        )
        .expect_err("the check error should still be reported");

        assert_eq!(checking.status, UpdateStatus::ReadyToInstall);
        assert!(checking.install_auth_retry_is_blocked());
        assert_eq!(
            checking.error_message.as_deref(),
            Some("authentication was not obtained")
        );
        assert!(checking.last_check_at.is_some());
        let loaded = PersistedState::load_or_default(&paths.state_file, true)?;
        assert!(loaded.install_auth_retry_is_blocked());
        Ok(())
    }

    #[test]
    fn failure_transition_notifies_once_per_candidate() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let paths = fixture_paths(temp.path());
        paths.ensure_dirs()?;
        let mut config = RuntimeConfig::default_with_paths(&paths);
        config.notifications = true;
        let mut notifications = Vec::new();

        let previous = PersistedState::new(true);
        let mut checking = previous.clone();
        checking.status = UpdateStatus::DownloadingPackage;
        checking.candidate_version = Some("2026.09.18.2691531945".into());
        checking.upstream_package_sha256 = Some("first-sha".into());
        fail_update_with::<()>(
            &config,
            &mut checking,
            &paths,
            &previous,
            anyhow::anyhow!("build failed"),
            |_, body| notifications.push(body.to_owned()),
        )
        .expect_err("build failure should be reported");
        assert_eq!(checking.status, UpdateStatus::Failed);
        assert_eq!(
            PersistedState::load_or_default(&paths.state_file, true)?.status,
            UpdateStatus::Failed
        );
        assert_eq!(notifications.len(), 1);
        assert!(notifications[0].contains("build failed"));

        let failed = checking.clone();
        fail_update_with::<()>(
            &config,
            &mut checking,
            &paths,
            &failed,
            anyhow::anyhow!("build failed again"),
            |_, body| notifications.push(body.to_owned()),
        )
        .expect_err("repeat failure should be reported");
        assert_eq!(notifications.len(), 1, "same candidate stays silent");

        let previous = checking.clone();
        checking.status = UpdateStatus::DownloadingPackage;
        checking.candidate_version = Some("2026.09.20.100000".into());
        checking.upstream_package_sha256 = Some("second-sha".into());
        fail_update_with::<()>(
            &config,
            &mut checking,
            &paths,
            &previous,
            anyhow::anyhow!("new candidate failed"),
            |_, body| notifications.push(body.to_owned()),
        )
        .expect_err("new candidate failure should be reported");
        assert_eq!(notifications.len(), 2);
        assert!(notifications[1].contains("2026.09.20.100000"));

        let mut recovered = checking.clone();
        recovered.status = UpdateStatus::Idle;
        fail_update_with::<()>(
            &config,
            &mut checking,
            &paths,
            &recovered,
            anyhow::anyhow!("failure after recovery"),
            |_, body| notifications.push(body.to_owned()),
        )
        .expect_err("failure after recovery should be reported");
        assert_eq!(notifications.len(), 3);

        config.notifications = false;
        fail_update_with::<()>(
            &config,
            &mut checking,
            &paths,
            &recovered,
            anyhow::anyhow!("notifications disabled"),
            |_, body| notifications.push(body.to_owned()),
        )
        .expect_err("failure should be reported even with notifications disabled");
        assert_eq!(notifications.len(), 3);
        Ok(())
    }

    #[test]
    fn interrupted_check_keeps_auth_retry_suppressed() {
        let mut state = ready_state(Path::new("/tmp/codex-desktop.deb").to_path_buf());
        state.block_install_auth_retry();
        state.status = UpdateStatus::CheckingUpstream;
        state.error_message = None;

        recover_interrupted_check(&mut state);
        let previous_status = state.status.clone();
        mark_check_started(&mut state);

        assert_eq!(previous_status, UpdateStatus::ReadyToInstall);
        assert!(same_pending_candidate(
            &state,
            "2026.09.10.120000",
            "candidate-sha256"
        ));
        assert_eq!(state.status, UpdateStatus::ReadyToInstall);
        assert!(state.install_auth_retry_is_blocked());
        assert!(state.last_check_at.is_some());
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
    fn legacy_install_owner_migrates_to_manual_recovery() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let paths = fixture_paths(dir.path());
        paths.ensure_dirs()?;
        let config = RuntimeConfig::default_with_paths(&paths);
        let current = install_transaction::test_current_process_identity()?;

        let mut state = PersistedState::new(true);
        state.schema_version = 2;
        state.status = UpdateStatus::Installing;
        state.install_transaction = Some(InstallTransaction {
            package_path: dir.path().join("candidate.deb"),
            package_sha256: Some("fixture".into()),
            package_command: Some(ProcessIdentity {
                pid: current.pid,
                start_time_ticks: current.start_time_ticks,
                // This models a persisted owner from before boot identity was
                // available, which cannot be classified safely now.
                boot_id: None,
            }),
            started_at: Utc::now()
                - chrono::Duration::seconds(
                    install_transaction::ABANDONED_INSTALL_GRACE.as_secs() as i64 + 1,
                ),
            operation: InstallOperation::Update,
        });
        state.save_updater(&paths.state_file)?;

        assert!(!prepare_mutation_state(&config, &mut state, &paths)?);
        assert_eq!(state.schema_version, 4);
        assert_eq!(state.status, UpdateStatus::Failed);
        assert!(state.manual_recovery_required);
        assert!(state.install_transaction.is_none());
        assert!(state
            .error_message
            .as_deref()
            .is_some_and(|message| message.contains("reboot-safe process identity")));

        assert!(prepare_explicit_mutation_state(
            &config, &mut state, &paths
        )?);
        assert!(state.manual_recovery_required);
        Ok(())
    }

    #[test]
    fn unknown_install_owner_becomes_manual_after_recovery_grace() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let paths = fixture_paths(dir.path());
        paths.ensure_dirs()?;
        let config = RuntimeConfig::default_with_paths(&paths);
        let current = install_transaction::test_current_process_identity()?;
        let mut state = PersistedState::new(true);
        state.status = UpdateStatus::Installing;
        state.install_transaction = Some(InstallTransaction {
            package_path: dir.path().join("candidate.deb"),
            package_sha256: Some("fixture".into()),
            package_command: Some(ProcessIdentity {
                // This value cannot be represented by pid_t on Linux. The
                // resulting classification is deliberately Unknown, rather
                // than treating an unreadable owner as definitely exited.
                pid: u32::MAX,
                start_time_ticks: current.start_time_ticks,
                boot_id: current.boot_id,
            }),
            started_at: Utc::now()
                - chrono::Duration::seconds(
                    install_transaction::ABANDONED_INSTALL_GRACE.as_secs() as i64 + 1,
                ),
            operation: InstallOperation::Update,
        });
        state.save_updater(&paths.state_file)?;

        assert!(!prepare_mutation_state(&config, &mut state, &paths)?);
        assert_eq!(state.status, UpdateStatus::Failed);
        assert!(state.manual_recovery_required);
        assert!(state.install_transaction.is_none());
        assert!(state
            .error_message
            .as_deref()
            .is_some_and(|message| message.contains("could not be classified safely")));
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

    #[test]
    fn abandoned_rpm_install_reconciles_after_verified_payload() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let paths = fixture_paths(dir.path());
        paths.ensure_dirs()?;
        let package = dir.path().join("codex-desktop.rpm");
        fs::write(&package, b"rpm fixture")?;
        let fake_rpm = write_fake_rpm_recovery_command(dir.path(), true)?;
        let _package_manager_paths = install::test_program_path_overrides(Some(&fake_rpm), None);

        let config = RuntimeConfig::default_with_paths(&paths);
        let mut state = abandoned_state(package, "2026.09.05-1.fc42")?;
        state.save_updater(&paths.state_file)?;

        assert!(prepare_mutation_state(&config, &mut state, &paths)?);
        assert_eq!(state.status, UpdateStatus::Installed);
        assert_eq!(state.installed_version, "2026.09.06-1.fc42");
        assert!(state.install_transaction.is_none());
        Ok(())
    }

    #[test]
    fn abandoned_rpm_install_rejects_unverified_payload() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let paths = fixture_paths(dir.path());
        paths.ensure_dirs()?;
        let package = dir.path().join("codex-desktop.rpm");
        fs::write(&package, b"rpm fixture")?;
        let fake_rpm = write_fake_rpm_recovery_command(dir.path(), false)?;
        let _package_manager_paths = install::test_program_path_overrides(Some(&fake_rpm), None);

        let config = RuntimeConfig::default_with_paths(&paths);
        let mut state = abandoned_state(package, "2026.09.05-1.fc42")?;
        state.save_updater(&paths.state_file)?;

        assert!(prepare_mutation_state(&config, &mut state, &paths)?);
        assert_eq!(state.status, UpdateStatus::Failed);
        assert!(state.install_transaction.is_none());
        Ok(())
    }

    #[test]
    fn abandoned_pacman_install_reconciles_after_verified_payload() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let paths = fixture_paths(dir.path());
        paths.ensure_dirs()?;
        let package = dir
            .path()
            .join("codex-desktop-2026.09.06-1-x86_64.pkg.tar.zst");
        fs::write(&package, b"pacman fixture")?;
        let fake_pacman = write_fake_pacman_recovery_command(dir.path(), true)?;
        let _package_manager_paths = install::test_program_path_overrides(None, Some(&fake_pacman));

        let config = RuntimeConfig::default_with_paths(&paths);
        let mut state = abandoned_state(package, "2026.09.05-1")?;
        state.save_updater(&paths.state_file)?;

        assert!(prepare_mutation_state(&config, &mut state, &paths)?);
        assert_eq!(state.status, UpdateStatus::Installed);
        assert_eq!(state.installed_version, "2026.09.06-1");
        assert!(state.install_transaction.is_none());
        Ok(())
    }

    #[test]
    fn abandoned_pacman_install_rejects_unverified_payload() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let paths = fixture_paths(dir.path());
        paths.ensure_dirs()?;
        let package = dir
            .path()
            .join("codex-desktop-2026.09.06-1-x86_64.pkg.tar.zst");
        fs::write(&package, b"pacman fixture")?;
        let fake_pacman = write_fake_pacman_recovery_command(dir.path(), false)?;
        let _package_manager_paths = install::test_program_path_overrides(None, Some(&fake_pacman));

        let config = RuntimeConfig::default_with_paths(&paths);
        let mut state = abandoned_state(package, "2026.09.05-1")?;
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
        state.upstream_package_sha256 = Some("fixture-sha256".into());
        state.artifact_paths.package_path = Some(package);
        state.artifact_paths.package_candidate_sha256 = state.upstream_package_sha256.clone();
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

    #[tokio::test]
    async fn nonzero_exit_after_gate_release_preserves_install_recovery_evidence() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let paths = fixture_paths(dir.path());
        paths.ensure_dirs()?;
        let mut config = RuntimeConfig::default_with_paths(&paths);
        config.app_executable_path = dir.path().join("app-not-running");

        let package = dir.path().join("candidate.deb");
        fs::write(&package, b"fixture package")?;

        let launcher = dir.path().join("released-then-fails");
        fs::write(
            &launcher,
            "#!/bin/sh\nIFS= read -r state || exit 125\n[ \"$state\" = go ] || exit 125\nexit 42\n",
        )?;
        fs::set_permissions(&launcher, fs::Permissions::from_mode(0o755))?;

        let mut state = PersistedState::new(true);
        state.status = UpdateStatus::ReadyToInstall;
        state.candidate_version = Some("fixture".into());
        state.upstream_package_sha256 = Some("fixture-sha256".into());
        state.artifact_paths.package_path = Some(package);
        state.artifact_paths.package_candidate_sha256 = state.upstream_package_sha256.clone();
        state.save_updater(&paths.state_file)?;

        let result =
            install_ready_with_launcher(&config, &mut state, &paths, true, false, &launcher).await;

        assert!(
            result.is_err(),
            "forced post-release command failure must surface"
        );
        let persisted =
            PersistedState::load_or_default(&paths.state_file, config.auto_install_on_app_exit)?;
        assert_eq!(
            persisted.status,
            UpdateStatus::Installing,
            "once the gate is released, a nonzero package-command exit cannot prove that mutation did not occur"
        );
        assert!(
            persisted.install_transaction.is_some(),
            "post-release failure must preserve durable recovery evidence"
        );
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
        state.artifact_paths.package_candidate_sha256 = Some("new-sha".into());
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
    fn schema_three_install_recovery_does_not_invent_upstream_identity() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let paths = fixture_paths(dir.path());
        paths.ensure_dirs()?;
        let state_path = paths.state_file.clone();
        let workspace = dir.path().join("workspaces/new-upstream");
        let package = workspace.join("dist/legacy-candidate.deb");
        fs::create_dir_all(package.parent().expect("package parent"))?;
        fs::write(&package, b"legacy candidate")?;

        let mut legacy = PersistedState::new(true);
        legacy.schema_version = 3;
        legacy.status = UpdateStatus::Installing;
        legacy.installed_version = "old-local".into();
        legacy.candidate_version = Some("new-upstream".into());
        legacy.upstream_package_sha256 = Some("unproven-candidate-sha".into());
        legacy.artifact_paths.package_path = Some(package.clone());
        legacy.install_transaction = Some(InstallTransaction {
            package_path: package.clone(),
            package_sha256: Some("verified-package-sha".into()),
            package_command: Some(stale_identity()),
            started_at: Utc::now(),
            operation: InstallOperation::Update,
        });
        let mut raw = serde_json::to_value(legacy)?;
        raw.get_mut("artifact_paths")
            .and_then(serde_json::Value::as_object_mut)
            .expect("artifact paths object")
            .remove("package_candidate_sha256");
        fs::write(&state_path, serde_json::to_vec_pretty(&raw)?)?;

        let mut loaded = PersistedState::load_or_default(&state_path, true)?;
        let transaction = loaded
            .install_transaction
            .clone()
            .expect("legacy installing transaction");
        apply_reconciled_install(&mut loaded, transaction, "installed-local".into());

        assert_eq!(loaded.status, UpdateStatus::Installed);
        assert_eq!(loaded.installed_version, "installed-local");
        assert_eq!(loaded.installed_upstream_version, None);
        assert_eq!(loaded.installed_upstream_sha256, None);
        assert_eq!(loaded.artifact_paths.package_candidate_sha256, None);
        assert_eq!(loaded.candidate_version, None);
        assert_eq!(
            loaded.upstream_package_sha256.as_deref(),
            Some("unproven-candidate-sha")
        );

        rollback::record_current_package_as_known_good(&mut loaded);
        assert_eq!(
            loaded.artifact_paths.rollback_package_path,
            Some(package.clone())
        );
        rollback::preserve_before_workspace_cleanup(&mut loaded, &paths, &workspace)?;
        let retained = loaded
            .artifact_paths
            .rollback_package_path
            .clone()
            .expect("retained rollback package");
        fs::remove_dir_all(&workspace)?;
        assert!(!package.exists());
        assert!(retained.is_file());
        assert_eq!(fs::read(&retained)?, b"legacy candidate");
        Ok(())
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
                state.artifact_paths.package_candidate_sha256 =
                    state.upstream_package_sha256.clone();
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
            install::resolve_updater_binary_for_build(&restarted_exe),
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
