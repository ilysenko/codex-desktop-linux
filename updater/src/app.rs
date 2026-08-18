//! Updater orchestration for the signed official Linux package.

use crate::{
    builder, cache_cleanup,
    cli::{Cli, Commands},
    config::{RuntimeConfig, RuntimePaths},
    install, install_rollback, liveness, logging, notify, rollback,
    state::{PersistedState, UpdateStatus},
    upstream,
};
use anyhow::{Context, Result};
use chrono::Utc;
use std::{fs::{self, OpenOptions}, path::Path, time::Duration};
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
    let mut state = PersistedState::load_or_default(&paths.state_file, config.auto_install_on_app_exit)?;
    state.installed_version = install::installed_package_version();
    // Only the commands that act on the state recover it; `status` and
    // `diagnose` report what is persisted and must not change the recorded
    // status or drop a candidate. (They still rewrite the file with the
    // refreshed `installed_version`, as they always have.)
    //
    // This is deliberately not serialised against a concurrent updater
    // process. `check.lock` would not help: neither `install_ready` nor the
    // daemon's deferred-install tick holds it, and failing to take it would
    // silently skip the recovery for the life of the process — reinstating the
    // rebuild loop. The predicate is safe unsynchronised because it fires only
    // once the package manager already reports the candidate's own package
    // version.
    if matches!(
        cli.command,
        Commands::Daemon | Commands::CheckNow | Commands::InstallReady | Commands::Rollback
    ) {
        reconcile_interrupted_install(&mut state);
    }
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

/// Records a newly detected upstream release as the pending candidate.
///
/// The previous candidate's package artifact is dropped here. `build_update`
/// only republishes `artifact_paths` once it has produced a package, so a
/// download or build failure would otherwise leave `package_path` pointing at
/// the artifact of the currently installed release while the candidate fields
/// already describe the new one. Every consumer of `package_path` — the
/// `install-ready` retry and the interrupted-install recovery — reads it as the
/// artifact built for the current candidate, so it must be absent until it is.
///
/// The rollback target is captured before the reset, and this runs only for a
/// genuinely new release: `check` returns earlier for a repeated failed
/// candidate and for a candidate that is already built and pending.
fn record_new_candidate(state: &mut PersistedState, metadata: &upstream::PackageMetadata) {
    rollback::record_current_package_as_known_good(state);
    state.candidate_version = Some(metadata.version.clone());
    state.candidate_architecture = Some(metadata.architecture.clone());
    state.candidate_repository_path = Some(metadata.repository_path.clone());
    state.upstream_package_sha256 = Some(metadata.sha256.clone());
    state.artifact_paths.package_path = None;
    state.status = UpdateStatus::DownloadingPackage;
}

/// Recovers the persisted state when a self-upgrade replaced this updater
/// before it could record the install.
///
/// The native package lifecycle stops the updater service while the privileged
/// install is still returning to the daemon that started it, so the `Installed`
/// transition is never persisted and the next check rebuilds the same release.
///
/// The upstream version and SHA-256 cannot decide this: they identify the
/// signed OpenAI input, not the per-user package rebuilt from it, and a package
/// hook restarts every active user's updater. Only the native package version
/// of the artifact this state was installing proves that this candidate is the
/// one now installed.
///
/// `state.installed_version` is the caller's freshly read
/// `install::installed_package_version`, so the comparison is against the
/// package the system reports right now, not a persisted value.
///
/// A reported version is not on its own proof that the package is installed:
/// dpkg answers with the new version from the moment it starts unpacking, so
/// `install::installed_package_is_usable` additionally requires a package state
/// in which the payload is committed. It accepts `half-configured`, because
/// `codex-update-manager.postinst` starts the service from inside the dpkg
/// transaction and the recovering daemon therefore usually runs while the
/// package it is recovering is still being configured.
fn reconcile_interrupted_install(state: &mut PersistedState) {
    reconcile_interrupted_install_with(
        state,
        install::installed_package_is_usable,
        candidate_package_version,
    );
}

/// Reads the native package version of the artifact an interrupted install was
/// applying, reporting `None` when the artifact cannot be inspected.
fn candidate_package_version(path: &Path) -> Option<String> {
    match install::package_file_version(path) {
        Ok(version) => Some(version),
        Err(error) => {
            // The candidate stays pending, so the visible symptom is the
            // rebuild loop this recovery exists to prevent. Say why.
            warn!(
                ?error,
                package = %path.display(),
                "could not inspect the interrupted candidate package"
            );
            None
        }
    }
}

fn reconcile_interrupted_install_with(
    state: &mut PersistedState,
    installed_package_is_usable: impl FnOnce() -> bool,
    candidate_package_version: impl FnOnce(&Path) -> Option<String>,
) {
    if state.status != UpdateStatus::Installing || state.installed_version == "unknown" {
        return;
    }
    let (Some(upstream_version), Some(upstream_sha256), Some(package)) = (
        state.candidate_version.clone(),
        state.upstream_package_sha256.clone(),
        state.artifact_paths.package_path.clone(),
    ) else {
        return;
    };
    if candidate_package_version(&package).as_deref() != Some(state.installed_version.as_str()) {
        return;
    }
    if !installed_package_is_usable() {
        // The package manager reports the candidate's version for a payload it
        // has not committed, so the install failed after `prerm` stopped the
        // previous daemon. Keep the candidate so it is installed again.
        warn!(
            installed_version = %state.installed_version,
            "the interrupted candidate is recorded but not installed; keeping it pending"
        );
        return;
    }

    info!(
        installed_version = %state.installed_version,
        %upstream_version,
        "recovered an interrupted self-upgrade"
    );
    state.installed_upstream_version = Some(upstream_version);
    state.installed_upstream_sha256 = Some(upstream_sha256);
    state.status = UpdateStatus::Installed;
    state
        .last_known_good_version
        .get_or_insert_with(|| state.installed_version.clone());
    state.candidate_version = None;
    state.candidate_architecture = None;
    state.candidate_repository_path = None;
    state.waiting_for_app_exit_auto_install = false;
    state.error_message = None;
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

    record_new_candidate(state, &metadata);
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
    // A failed download or build leaves a candidate with no artifact, so this
    // is a routine `install-ready` outcome rather than an unreachable state.
    // An explicit retry of a `Failed` state still has to report the failure it
    // was asked to retry, rather than looking like "no update is pending".
    let Some(package) = state.artifact_paths.package_path.clone() else {
        if state.status == UpdateStatus::Failed {
            let recorded = state.error_message.as_deref();
            let reason = recorded.unwrap_or("no error recorded");
            anyhow::bail!("the last update failed before a package was built: {reason}");
        }
        println!("No rebuilt package is ready to install.");
        return Ok(());
    };
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    const INSTALLED_PACKAGE_VERSION: &str = "2026.08.16.221717+3f9a1c2e";
    const OTHER_PACKAGE_VERSION: &str = "2026.08.16.104402+7b2d5e10";
    const UPSTREAM_VERSION: &str = "26.810.52044";

    fn interrupted_install_state() -> PersistedState {
        let mut state = PersistedState::new(true);
        state.installed_version = INSTALLED_PACKAGE_VERSION.to_string();
        state.candidate_version = Some(UPSTREAM_VERSION.to_string());
        state.candidate_architecture = Some("amd64".to_string());
        state.candidate_repository_path = Some("pool/main/c/chatgpt/package.deb".to_string());
        state.upstream_package_sha256 = Some("a".repeat(64));
        state.artifact_paths.package_path = Some(PathBuf::from("/tmp/codex-desktop.deb"));
        state.status = UpdateStatus::Installing;
        state.waiting_for_app_exit_auto_install = true;
        state.error_message = Some("stale error".to_string());
        state
    }

    fn metadata(version: &str, sha256: &str) -> upstream::PackageMetadata {
        upstream::PackageMetadata {
            package: "chatgpt".to_string(),
            version: version.to_string(),
            architecture: "amd64".to_string(),
            repository_path: "pool/main/c/chatgpt/package.deb".to_string(),
            sha256: sha256.to_string(),
            size: 1,
            repository: "https://example.invalid/repo".to_string(),
            path: None,
        }
    }

    #[test]
    fn a_new_candidate_drops_the_previous_candidates_package_artifact() -> Result<()> {
        // `record_current_package_as_known_good` only retains an artifact that
        // is still on disk, so the rollback assertion needs a real file.
        let temp = tempfile::tempdir()?;
        let installed_artifact = temp.path().join("installed.deb");
        fs::write(&installed_artifact, b"deb")?;
        let mut state = PersistedState::new(true);
        state.installed_version = INSTALLED_PACKAGE_VERSION.to_string();
        state.artifact_paths.package_path = Some(installed_artifact.clone());

        record_new_candidate(&mut state, &metadata("26.811.10000", &"b".repeat(64)));

        // A download or build failure now leaves no artifact to mistake for the
        // new candidate, and the installed one is still the rollback target.
        assert_eq!(state.artifact_paths.package_path, None);
        assert_eq!(
            state.artifact_paths.rollback_package_path,
            Some(installed_artifact)
        );
        assert_eq!(state.candidate_version.as_deref(), Some("26.811.10000"));
        assert_eq!(state.status, UpdateStatus::DownloadingPackage);
        Ok(())
    }

    #[test]
    fn a_failed_build_cannot_be_recovered_as_an_installed_candidate() {
        // The state a failed download or build leaves behind: a pending
        // candidate that never produced an artifact.
        let mut state = interrupted_install_state();
        record_new_candidate(&mut state, &metadata("26.811.10000", &"b".repeat(64)));
        state.status = UpdateStatus::Installing;
        let expected = state.clone();

        reconcile_interrupted_install_with(
            &mut state,
            || panic!("a candidate without an artifact must not query the package manager"),
            |_| panic!("a candidate without an artifact must not be inspected"),
        );

        assert_eq!(state, expected);
    }

    #[test]
    fn recovers_an_install_whose_native_package_is_the_installed_one() {
        let mut state = interrupted_install_state();

        reconcile_interrupted_install_with(
            &mut state,
            || true,
            |path| {
                assert_eq!(path, Path::new("/tmp/codex-desktop.deb"));
                Some(INSTALLED_PACKAGE_VERSION.to_string())
            },
        );

        assert_eq!(state.status, UpdateStatus::Installed);
        assert_eq!(
            state.installed_upstream_version.as_deref(),
            Some(UPSTREAM_VERSION)
        );
        assert_eq!(state.installed_upstream_sha256, Some("a".repeat(64)));
        assert_eq!(
            state.last_known_good_version.as_deref(),
            Some(INSTALLED_PACKAGE_VERSION)
        );
        assert_eq!(state.candidate_version, None);
        assert_eq!(state.candidate_architecture, None);
        assert_eq!(state.candidate_repository_path, None);
        assert!(!state.waiting_for_app_exit_auto_install);
        assert_eq!(state.error_message, None);
    }

    #[test]
    fn preserves_a_candidate_the_package_manager_recorded_but_did_not_install() {
        // dpkg reports the new version from the moment it starts unpacking, and
        // `prerm` has already stopped the daemon by then, so a failed unpack or
        // a failed `postinst` leaves the candidate's version visible for a
        // payload that was never committed.
        let mut state = interrupted_install_state();
        let expected = state.clone();

        reconcile_interrupted_install_with(
            &mut state,
            || false,
            |_| Some(INSTALLED_PACKAGE_VERSION.to_string()),
        );

        assert_eq!(state, expected);
    }

    #[test]
    fn preserves_a_candidate_that_shares_the_upstream_release_but_not_the_native_package() {
        let mut state = interrupted_install_state();
        state.installed_upstream_version = Some(UPSTREAM_VERSION.to_string());
        state.installed_upstream_sha256 = Some("a".repeat(64));
        let expected = state.clone();

        reconcile_interrupted_install_with(
            &mut state,
            || panic!("a differing native package version must not query the package manager"),
            |_| Some(OTHER_PACKAGE_VERSION.to_string()),
        );

        assert_eq!(state, expected);
    }

    #[test]
    fn preserves_the_candidate_when_the_package_artifact_cannot_be_inspected() {
        let mut state = interrupted_install_state();
        let expected = state.clone();

        reconcile_interrupted_install_with(
            &mut state,
            || panic!("an uninspectable artifact must not query the package manager"),
            |_| None,
        );

        assert_eq!(state, expected);
    }

    #[test]
    fn preserves_the_candidate_when_the_state_records_no_package_artifact() {
        let mut state = interrupted_install_state();
        state.artifact_paths.package_path = None;
        let expected = state.clone();

        reconcile_interrupted_install_with(
            &mut state,
            || panic!("a state without a package artifact must not query the package manager"),
            |_| panic!("a state without a package artifact must not be inspected"),
        );

        assert_eq!(state, expected);
    }

    #[test]
    fn preserves_the_candidate_when_the_installed_package_version_is_unknown() {
        let mut state = interrupted_install_state();
        state.installed_version = "unknown".to_string();
        let expected = state.clone();

        reconcile_interrupted_install_with(
            &mut state,
            || panic!("an unknown installed version must not query the package manager"),
            |_| Some("unknown".to_string()),
        );

        assert_eq!(state, expected);
    }

    #[test]
    fn does_not_reconcile_states_other_than_installing() {
        for status in [
            UpdateStatus::Idle,
            UpdateStatus::CheckingUpstream,
            UpdateStatus::UpdateDetected,
            UpdateStatus::DownloadingPackage,
            UpdateStatus::PreparingWorkspace,
            UpdateStatus::PatchingApp,
            UpdateStatus::BuildingPackage,
            UpdateStatus::ReadyToInstall,
            UpdateStatus::WaitingForAppExit,
            UpdateStatus::Installed,
            UpdateStatus::Failed,
        ] {
            let mut state = interrupted_install_state();
            state.status = status.clone();
            let expected = state.clone();

            reconcile_interrupted_install_with(
                &mut state,
                || panic!("{status:?} must not query the package manager"),
                |_| panic!("{status:?} must not inspect the package artifact"),
            );

            assert_eq!(state, expected, "{status:?} must not be reconciled");
        }
    }
}
