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

    match cli.command {
        Commands::Daemon => daemon(&config, &mut state, &paths).await,
        Commands::CheckNow => check(&config, &mut state, &paths).await,
        Commands::Status { json } => status(&state, json),
        Commands::Diagnose { json } => diagnose(&config, &state, &paths, json),
        Commands::InstallReady => run_install_ready(&config, &mut state, &paths).await,
        Commands::Rollback => run_rollback(&config, &mut state, &paths).await,
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
            _ = reconcile.tick() => if let Err(error) = reconcile_pending_install(config, state, paths).await {
                error!(?error, "deferred install failed");
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
    let _lock = match CheckLock::try_acquire(&paths.state_dir.join("check.lock"))? {
        Some(lock) => lock,
        None => return Ok(()),
    };
    reload_state(config, state, paths)?;
    match state.status {
        UpdateStatus::WaitingForAppExit if !liveness::is_app_running(config)? => {
            install_ready_locked(config, state, paths, false).await?;
        }
        UpdateStatus::ReadyToInstall
            if state.install_auth_retry_is_blocked()
                && (config.auto_install_on_app_exit
                    || state.install_after_app_exit_requested)
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

async fn run_install_ready(
    config: &RuntimeConfig,
    state: &mut PersistedState,
    paths: &RuntimePaths,
) -> Result<()> {
    let _lock = loop {
        match CheckLock::try_acquire(&paths.state_dir.join("check.lock"))? {
            Some(lock) => break lock,
            None => time::sleep(Duration::from_millis(50)).await,
        }
    };
    reload_state(config, state, paths)?;
    install_ready_locked(config, state, paths, true).await
}

async fn run_rollback(
    config: &RuntimeConfig,
    state: &mut PersistedState,
    paths: &RuntimePaths,
) -> Result<()> {
    let _lock = loop {
        match CheckLock::try_acquire(&paths.state_dir.join("check.lock"))? {
            Some(lock) => break lock,
            None => time::sleep(Duration::from_millis(50)).await,
        }
    };
    reload_state(config, state, paths)?;
    rollback::run(config, state, paths).await
}

fn reload_state(
    config: &RuntimeConfig,
    state: &mut PersistedState,
    paths: &RuntimePaths,
) -> Result<()> {
    *state = PersistedState::load_or_default(
        &paths.state_file,
        config.auto_install_on_app_exit,
    )?;
    Ok(())
}

async fn check(config: &RuntimeConfig, state: &mut PersistedState, paths: &RuntimePaths) -> Result<()> {
    let _lock = match CheckLock::try_acquire(&paths.state_dir.join("check.lock"))? {
        Some(lock) => lock,
        None => { info!("another update check is active"); return Ok(()); }
    };
    reload_state(config, state, paths)?;
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
    let metadata = match upstream::resolve_metadata(&config.builder_bundle_root, &config.repository_url, &package_cache).await {
        Ok(value) => value,
        Err(error) => return fail_check(state, paths, previous_state, error),
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
        if already_installed { state.clear_install_auth_retry_block(); }
        state.save_updater(&paths.state_file)?;
        return Ok(());
    }

    if same_pending_candidate(&previous_state, &metadata.version, &metadata.sha256) {
        state.status = previous_status;
        state.error_message = previous_error;
        state.waiting_for_app_exit_auto_install = previous_waiting_auto_install;
        return install_ready_locked(config, state, paths, false).await;
    }

    rollback::record_current_package_as_known_good(state);
    state.candidate_version = Some(metadata.version.clone());
    state.candidate_architecture = Some(metadata.architecture.clone());
    state.candidate_repository_path = Some(metadata.repository_path.clone());
    state.upstream_package_sha256 = Some(metadata.sha256.clone());
    state.clear_install_auth_retry_block();
    state.install_after_app_exit_requested = false;
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
    install_ready_locked(config, state, paths, false).await
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
        && matches!(
            state.status,
            UpdateStatus::ReadyToInstall | UpdateStatus::WaitingForAppExit
        )
}

async fn install_ready_locked(
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
    let auth_retry_blocked = state.install_auth_retry_is_blocked();
    let install_after_app_exit_requested = state.install_after_app_exit_requested;
    if liveness::is_app_running(config)? {
        if !explicit_retry
            && !install_after_app_exit_requested
            && !config.auto_install_on_app_exit
        {
            state.status = UpdateStatus::ReadyToInstall;
            state.waiting_for_app_exit_auto_install = false;
            state.save_updater(&paths.state_file)?;
            return Ok(());
        }
        state.clear_install_auth_retry_block();
        state.status = UpdateStatus::WaitingForAppExit;
        state.install_after_app_exit_requested =
            explicit_retry || install_after_app_exit_requested;
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
    if !explicit_retry
        && !install_after_app_exit_requested
        && !config.auto_install_on_app_exit
    {
        state.status = UpdateStatus::ReadyToInstall;
        state.save_updater(&paths.state_file)?;
        return Ok(());
    }

    let explicit_install = explicit_retry || install_after_app_exit_requested;
    state.clear_install_auth_retry_block();
    state.install_after_app_exit_requested = false;
    state.status = UpdateStatus::Installing;
    state.error_message = None;
    state.save_updater(&paths.state_file)?;
    let current_exe = std::env::current_exe()?;
    let output = install::pkexec_command(&current_exe, &package)
        .output()
        .context("Failed to launch privileged package install")?;
    if !output.status.success() {
        let mut message = format!("privileged install exited with status {}", output.status);
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stderr = stderr.trim();
        if !stderr.is_empty() {
            message.push_str(": ");
            message.push_str(stderr);
        }
        let error = anyhow::anyhow!(message);
        if pkexec_authentication_was_not_obtained(&output.status) {
            state.status = UpdateStatus::ReadyToInstall;
            state.waiting_for_app_exit_auto_install = false;
            state.error_message = Some(format!("{error:#}"));
            state.block_install_auth_retry();
            state.install_after_app_exit_requested = explicit_install;
            state.save_updater(&paths.state_file)?;
            return Err(error);
        }
        return fail(state, paths, error);
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
    state.clear_install_auth_retry_block();
    state.install_after_app_exit_requested = false;
    state.save_updater(&paths.state_file)?;
    let _ = cache_cleanup::prune(&paths.cache_dir, state);
    if config.notifications {
        let _ = notify::send("codex-desktop updated", &format!("Installed {}.", state.installed_version));
    }
    Ok(())
}

fn pkexec_authentication_was_not_obtained(status: &std::process::ExitStatus) -> bool {
    matches!(status.code(), Some(126 | 127))
}

fn fail_check<T>(
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
    fail(state, paths, error)
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::{os::unix::fs::PermissionsExt, path::PathBuf};

    fn test_paths(root: &Path) -> RuntimePaths {
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
    fn auth_cancel_retries_only_after_another_app_exit() -> Result<()> {
        let _env_guard = crate::test_util::env_lock();
        let _restore_env = crate::test_util::EnvRestoreGuard::capture(&[
            "CODEX_UPDATE_MANAGER_TEST_PKEXEC_PATH",
            "CODEX_UPDATE_MANAGER_TEST_PKEXEC_COUNT",
            "CODEX_UPDATE_MANAGER_TEST_PKEXEC_EXIT",
        ]);
        let runtime = tokio::runtime::Runtime::new()?;
        let temp = tempfile::tempdir()?;
        let paths = test_paths(temp.path());
        paths.ensure_dirs()?;
        let package = temp.path().join("codex-desktop.deb");
        fs::write(&package, b"package")?;
        let fake_pkexec = write_fake_pkexec(temp.path())?;
        let invocation_count = temp.path().join("pkexec-count");
        std::env::set_var("CODEX_UPDATE_MANAGER_TEST_PKEXEC_PATH", fake_pkexec);
        std::env::set_var("CODEX_UPDATE_MANAGER_TEST_PKEXEC_COUNT", &invocation_count);
        std::env::set_var("CODEX_UPDATE_MANAGER_TEST_PKEXEC_EXIT", "126");

        let mut config = RuntimeConfig::default_with_paths(&paths);
        config.auto_install_on_app_exit = false;
        config.notifications = false;
        config.app_executable_path = temp.path().join("not-running");
        let mut state = ready_state(package);
        let mut daemon_state = PersistedState::new(false);

        let error = runtime
            .block_on(install_ready_locked(&config, &mut state, &paths, true))
            .expect_err("authentication cancellation should be reported");
        assert!(error.to_string().contains("status exit status: 126"));
        assert_eq!(state.status, UpdateStatus::ReadyToInstall);
        assert!(state.install_auth_retry_is_blocked());
        assert!(state.install_after_app_exit_requested);
        assert_eq!(fs::read_to_string(&invocation_count)?, "x");

        runtime.block_on(reconcile_pending_install(&config, &mut daemon_state, &paths))?;
        state = daemon_state;
        assert_eq!(state.status, UpdateStatus::ReadyToInstall);
        assert!(state.install_auth_retry_is_blocked());
        assert!(state.install_after_app_exit_requested);
        assert_eq!(fs::read_to_string(&invocation_count)?, "x");

        runtime
            .block_on(install_ready_locked(&config, &mut state, &paths, true))
            .expect_err("an explicit retry should bypass the authentication block");
        assert_eq!(state.status, UpdateStatus::ReadyToInstall);
        assert!(state.install_auth_retry_is_blocked());
        assert!(state.install_after_app_exit_requested);
        assert_eq!(fs::read_to_string(&invocation_count)?, "xx");

        config.app_executable_path = std::env::current_exe()?;
        runtime.block_on(reconcile_pending_install(&config, &mut state, &paths))?;
        assert_eq!(state.status, UpdateStatus::WaitingForAppExit);
        assert!(!state.install_auth_retry_is_blocked());
        assert!(state.install_after_app_exit_requested);
        assert_eq!(fs::read_to_string(&invocation_count)?, "xx");

        runtime.block_on(install_ready_locked(&config, &mut state, &paths, false))?;
        assert_eq!(state.status, UpdateStatus::WaitingForAppExit);
        assert!(!state.waiting_for_app_exit_auto_install);
        assert_eq!(fs::read_to_string(&invocation_count)?, "xx");

        config.app_executable_path = temp.path().join("not-running");
        runtime
            .block_on(reconcile_pending_install(&config, &mut state, &paths))
            .expect_err("the next app exit should permit one retry");
        assert_eq!(state.status, UpdateStatus::ReadyToInstall);
        assert!(state.install_auth_retry_is_blocked());
        assert!(state.install_after_app_exit_requested);
        assert_eq!(fs::read_to_string(&invocation_count)?, "xxx");
        Ok(())
    }

    #[test]
    fn non_authentication_install_failure_is_terminal() -> Result<()> {
        let _env_guard = crate::test_util::env_lock();
        let _restore_env = crate::test_util::EnvRestoreGuard::capture(&[
            "CODEX_UPDATE_MANAGER_TEST_PKEXEC_PATH",
            "CODEX_UPDATE_MANAGER_TEST_PKEXEC_COUNT",
            "CODEX_UPDATE_MANAGER_TEST_PKEXEC_EXIT",
        ]);
        let runtime = tokio::runtime::Runtime::new()?;
        let temp = tempfile::tempdir()?;
        let paths = test_paths(temp.path());
        paths.ensure_dirs()?;
        let package = temp.path().join("codex-desktop.deb");
        fs::write(&package, b"package")?;
        std::env::set_var(
            "CODEX_UPDATE_MANAGER_TEST_PKEXEC_PATH",
            write_fake_pkexec(temp.path())?,
        );
        std::env::set_var(
            "CODEX_UPDATE_MANAGER_TEST_PKEXEC_COUNT",
            temp.path().join("pkexec-count"),
        );
        std::env::set_var("CODEX_UPDATE_MANAGER_TEST_PKEXEC_EXIT", "1");

        let mut config = RuntimeConfig::default_with_paths(&paths);
        config.notifications = false;
        config.app_executable_path = temp.path().join("not-running");
        let mut state = ready_state(package);

        runtime
            .block_on(install_ready_locked(&config, &mut state, &paths, true))
            .expect_err("ordinary install failures should remain terminal");
        assert_eq!(state.status, UpdateStatus::Failed);
        assert!(!state.install_auth_retry_is_blocked());
        assert!(!state.install_after_app_exit_requested);
        Ok(())
    }

    #[test]
    fn failed_check_preserves_pending_auth_retry_state() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let paths = test_paths(temp.path());
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
}
