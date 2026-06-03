//! Applies a pending wrapper (repo) update for the current install type.
//!
//! Invoked by the optional `codex-wrapper-updater` Linux feature when it sees a
//! pending apply marker. Detection (see [`crate::wrapper`]) only records that a
//! newer wrapper build exists; this module performs the actual rebuild + install:
//!
//! - **User-local** installs reuse `~/.local/bin/codex-desktop-update`, which
//!   pulls the managed checkout and re-runs `install.sh` in place as the user
//!   (no privilege escalation).
//! - **Packaged** installs fetch the wrapper source into a managed clone, build
//!   a fresh native package from the cached DMG, and install it with `pkexec`.
//!   When the build toolchain (cargo / node / a DMG extractor) is missing, this
//!   sends a desktop notification and returns an error so the feature marker can
//!   remain in place for a later retry.

use anyhow::{Context, Result};
use std::{
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Command,
};
use tracing::{info, warn};

use crate::{
    builder,
    config::{RuntimeConfig, RuntimePaths},
    install, notify,
    state::{PersistedState, UpdateStatus},
    upstream, wrapper,
};

/// How the running app was installed, which determines how a wrapper update is
/// applied.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum InstallType {
    /// Native package under `/opt/codex-desktop` with a system package record.
    Packaged,
    /// `install.sh` install under the user's home (`~/.local/...`).
    UserLocal,
}

fn detect_install_type(config: &RuntimeConfig) -> InstallType {
    // The launcher knows which install is actually running and exports its app
    // directory. Prefer that authoritative hint: an app dir under /opt is the
    // packaged install; anything else (e.g. ~/.local/opt) is user-local. This
    // disambiguates machines that have both a .deb and a user-local install.
    if let Some(app_dir) = std::env::var_os("CODEX_LINUX_APP_DIR") {
        let app_dir = PathBuf::from(app_dir);
        if app_dir.starts_with("/opt/") {
            return InstallType::Packaged;
        }
        return InstallType::UserLocal;
    }

    // Fallback when no launcher hint is present: a packaged builder bundle plus
    // an installed system package indicates the packaged install.
    let packaged_bundle = Path::new("/opt/codex-desktop/update-builder");
    if config.builder_bundle_root == packaged_bundle && install::is_primary_package_installed() {
        InstallType::Packaged
    } else {
        InstallType::UserLocal
    }
}

/// Applies a pending wrapper update. No-ops when wrapper tracking is disabled.
pub async fn run_apply_wrapper_update(
    config: &RuntimeConfig,
    state: &mut PersistedState,
    paths: &RuntimePaths,
) -> Result<()> {
    if !config.enable_wrapper_updates {
        println!("Wrapper update tracking is disabled; nothing to apply.");
        return Ok(());
    }

    if state.wrapper_dev_mode == Some(true) {
        warn!("wrapper apply refused because installed wrapper appears ahead of upstream");
        println!("Wrapper is a local/dev build ahead of upstream; not applying (would downgrade).");
        return Ok(());
    }

    if state.candidate_wrapper_commit.as_deref().is_none() {
        println!("No wrapper update candidate is ready; nothing to apply.");
        return Ok(());
    }

    let candidate_commit = state.candidate_wrapper_commit.clone();
    let result = match detect_install_type(config) {
        InstallType::UserLocal => {
            apply_user_local(config, paths, candidate_commit.as_deref()).await
        }
        InstallType::Packaged => {
            apply_packaged(config, state, paths, candidate_commit.as_deref()).await
        }
    };

    match result {
        Ok(()) => {
            state.installed_version = install::installed_package_version();
            state.candidate_version = None;
            state.status = UpdateStatus::Installed;
            state.error_message = None;
            state.notified_events.clear();
            state.artifact_paths.workspace_dir = None;
            state.artifact_paths.package_path = None;
            refresh_installed_wrapper_state(config, state);
            state.clear_wrapper_update_candidate();
            state.save(&paths.state_file)?;
            let _ = notify::send(
                "Codex Desktop Linux updated",
                "The newer Linux wrapper build has been installed.",
            );
            Ok(())
        }
        Err(error) => {
            warn!(?error, "wrapper update apply failed");
            Err(error)
        }
    }
}

fn refresh_installed_wrapper_state(config: &RuntimeConfig, state: &mut PersistedState) {
    if let Some(installed) = wrapper::installed_wrapper_from_metadata(
        &config.app_executable_path,
        &config.builder_bundle_root,
    ) {
        state.installed_wrapper_version = installed.version;
        state.installed_wrapper_commit = Some(installed.commit);
    }
}

/// User-local apply. Prefers the contrib `codex-desktop-update` helper (managed
/// checkout pull + in-place `install.sh`) when present; otherwise falls back to
/// fetching the wrapper source and running its `install.sh` directly against the
/// running app dir. Runs as the user, no privilege escalation.
async fn apply_user_local(
    config: &RuntimeConfig,
    paths: &RuntimePaths,
    candidate_commit: Option<&str>,
) -> Result<()> {
    let feature_config = effective_feature_config(config);
    if let Some(helper) = user_local_update_helper() {
        info!(helper = %helper.display(), "applying wrapper update via user-local helper");
        let mut cmd = Command::new(&helper);
        cmd.arg("--quiet");
        // The contrib helper honors a caller-set CODEX_LINUX_FEATURES_CONFIG over
        // its repo-local default, so the in-app picker's selection wins.
        if let Some(config_path) = &feature_config {
            cmd.env("CODEX_LINUX_FEATURES_CONFIG", config_path);
        }
        let status = cmd
            .status()
            .with_context(|| format!("Failed to run {}", helper.display()))?;
        if !status.success() {
            anyhow::bail!("{} exited with status {status}", helper.display());
        }
        return Ok(());
    }

    // Fallback: rebuild in place from a freshly fetched wrapper source.
    let app_dir = user_local_app_dir()
        .context("could not resolve user-local app dir (CODEX_LINUX_APP_DIR)")?;
    let install_root = app_dir
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| app_dir.clone());
    let wrapper_src = ensure_wrapper_source(config, paths, candidate_commit)?;
    let install_sh = wrapper_src.join("install.sh");
    if !install_sh.is_file() {
        anyhow::bail!(
            "wrapper source is missing install.sh at {}",
            install_sh.display()
        );
    }
    info!(app_dir = %app_dir.display(), "rebuilding user-local app in place via install.sh");
    let mut cmd = Command::new(&install_sh);
    cmd.current_dir(&wrapper_src)
        .env("CODEX_INSTALL_ALLOW_RUNNING", "1")
        .env("CODEX_INSTALL_ROOT", &install_root)
        .env("CODEX_INSTALL_DIR", &app_dir);
    if let Some(config_path) = &feature_config {
        cmd.env("CODEX_LINUX_FEATURES_CONFIG", config_path);
    }
    let status = cmd
        .status()
        .with_context(|| format!("Failed to run {}", install_sh.display()))?;
    if !status.success() {
        anyhow::bail!("{} exited with status {status}", install_sh.display());
    }
    Ok(())
}

/// The feature selection to use for this rebuild: saved picker selection first,
/// then the installed builder bundle's preserved feature config.
fn effective_feature_config(config: &RuntimeConfig) -> Option<PathBuf> {
    crate::config::effective_feature_config_path(config)
}

fn user_local_update_helper() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from)?;
    let candidate = home.join(".local/bin/codex-desktop-update");
    if candidate.is_file()
        && candidate
            .metadata()
            .is_ok_and(|metadata| metadata.permissions().mode() & 0o111 != 0)
    {
        Some(candidate)
    } else {
        None
    }
}

/// The running user-local app directory, from the launcher's `CODEX_LINUX_APP_DIR`.
fn user_local_app_dir() -> Option<PathBuf> {
    std::env::var_os("CODEX_LINUX_APP_DIR")
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
}

/// Packaged apply: fetch fresh wrapper source, rebuild a native package from the
/// cached DMG, and install it with pkexec.
async fn apply_packaged(
    config: &RuntimeConfig,
    state: &mut PersistedState,
    paths: &RuntimePaths,
    candidate_commit: Option<&str>,
) -> Result<()> {
    if let Some(missing) = missing_build_dependency() {
        let body = format!(
            "A newer Codex Desktop Linux build is available, but '{missing}' is needed to rebuild it. Install the build tools or update the package manually."
        );
        let _ = notify::send("Codex Desktop Linux update available", &body);
        println!("{body}");
        anyhow::bail!("missing build dependency for wrapper update: {missing}");
    }

    let wrapper_src = ensure_wrapper_source(config, paths, candidate_commit)?;
    let dmg_path = cached_or_downloaded_dmg(config, state, paths).await?;

    // The package version must remain monotonic (timestamp+dmghash), so derive
    // it from the cached DMG the same way the DMG path does.
    let candidate_version = derive_package_version(&dmg_path)?;

    let artifacts = builder::build_update_from(
        &wrapper_src,
        config,
        state,
        paths,
        &candidate_version,
        &dmg_path,
    )
    .await
    .context("wrapper package rebuild failed")?;

    let current_exe = std::env::current_exe().context("Failed to resolve updater binary path")?;
    let output = install::pkexec_command(&current_exe, &artifacts.package_path)
        .output()
        .context("Failed to launch pkexec for wrapper update installation")?;
    if !output.status.success() {
        anyhow::bail!(
            "privileged wrapper install exited with status {}",
            output.status
        );
    }

    state.installed_version = install::installed_package_version();
    let _ = state.save(&paths.state_file);
    Ok(())
}

/// Clones or refreshes a managed wrapper checkout under the workspace cache and
/// returns its path. Never touches the user's working tree.
pub(crate) fn ensure_wrapper_source(
    config: &RuntimeConfig,
    paths: &RuntimePaths,
    candidate_commit: Option<&str>,
) -> Result<PathBuf> {
    let remote = wrapper::resolve_remote(&config.wrapper_remote, &config.builder_bundle_root);
    let branch = if config.wrapper_branch.trim().is_empty() {
        "main"
    } else {
        config.wrapper_branch.trim()
    };
    let dest = paths.cache_dir.join("wrapper-src");

    if dest.join(".git").is_dir() {
        run_git(&[
            "-C",
            &dest.to_string_lossy(),
            "fetch",
            "--depth",
            "1",
            "--quiet",
            &remote,
            branch,
        ])?;
        run_git(&[
            "-C",
            &dest.to_string_lossy(),
            "reset",
            "--hard",
            "--quiet",
            candidate_commit.unwrap_or("FETCH_HEAD"),
        ])?;
        run_git(&["-C", &dest.to_string_lossy(), "clean", "-fdx", "--quiet"])?;
    } else {
        std::fs::create_dir_all(&paths.cache_dir)
            .with_context(|| format!("Failed to create {}", paths.cache_dir.display()))?;
        let _ = std::fs::remove_dir_all(&dest);
        run_git(&[
            "clone",
            "--depth",
            "1",
            "--branch",
            branch,
            "--single-branch",
            "--quiet",
            &remote,
            &dest.to_string_lossy(),
        ])?;
        if let Some(commit) = candidate_commit {
            run_git(&[
                "-C",
                &dest.to_string_lossy(),
                "reset",
                "--hard",
                "--quiet",
                commit,
            ])?;
        }
    }

    Ok(dest)
}

fn run_git(args: &[&str]) -> Result<()> {
    let status = Command::new("git")
        .args(args)
        .status()
        .context("Failed to run git for wrapper source")?;
    if !status.success() {
        anyhow::bail!("git {:?} exited with status {status}", args);
    }
    Ok(())
}

/// Returns the cached DMG path, downloading it if no usable cache exists.
async fn cached_or_downloaded_dmg(
    config: &RuntimeConfig,
    state: &mut PersistedState,
    paths: &RuntimePaths,
) -> Result<PathBuf> {
    if let Some(dmg) = state.artifact_paths.dmg_path.clone() {
        if dmg.exists() {
            return Ok(dmg);
        }
    }

    let client = reqwest::Client::builder().build()?;
    let downloads_dir = config.workspace_root.join("downloads");
    let downloaded =
        upstream::download_dmg(&client, &config.dmg_url, &downloads_dir, chrono::Utc::now())
            .await
            .context("Failed to download upstream DMG for wrapper rebuild")?;
    state.artifact_paths.dmg_path = Some(downloaded.path.clone());
    let _ = state.save(&paths.state_file);
    Ok(downloaded.path)
}

/// Derives a monotonic package version (`YYYY.MM.DD.HHMMSS+<sha8>`) from the DMG
/// contents, matching the DMG update path's scheme.
fn derive_package_version(dmg_path: &Path) -> Result<String> {
    use sha2::{Digest, Sha256};
    let bytes = std::fs::read(dmg_path)
        .with_context(|| format!("Failed to read {}", dmg_path.display()))?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    let sha = hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    upstream::derive_candidate_version(&sha, chrono::Utc::now())
}

/// Returns the first missing build dependency needed for a packaged rebuild, or
/// `None` when the toolchain is present.
fn missing_build_dependency() -> Option<&'static str> {
    // install.sh needs a DMG extractor (7z/7zz) and the package build runs cargo
    // for the updater; node is provided by the bundled managed runtime.
    for (tool, label) in [("cargo", "cargo"), ("7zz", "7zz")] {
        if which(tool).is_none() {
            // 7z is an acceptable alternative to 7zz.
            if tool == "7zz" && which("7z").is_some() {
                continue;
            }
            return Some(label);
        }
    }
    None
}

fn which(tool: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(tool);
        if candidate.is_file()
            && candidate
                .metadata()
                .is_ok_and(|metadata| metadata.permissions().mode() & 0o111 != 0)
        {
            return Some(candidate);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

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

    fn test_config(root: &Path) -> RuntimeConfig {
        RuntimeConfig {
            dmg_url: "https://example.com/Codex.dmg".to_string(),
            initial_check_delay_seconds: 1,
            check_interval_hours: 6,
            auto_install_on_app_exit: true,
            notifications: false,
            workspace_root: root.join("cache"),
            builder_bundle_root: root.join("builder"),
            app_executable_path: root.join("not-running-electron"),
            enable_wrapper_updates: true,
            wrapper_remote: String::new(),
            wrapper_branch: "main".to_string(),
        }
    }

    #[tokio::test]
    async fn dev_mode_candidate_is_a_noop_to_avoid_downgrade() {
        let root = tempdir().unwrap();
        let config = test_config(root.path());
        let paths = test_paths(root.path());
        let mut state = PersistedState::new(true);
        state.wrapper_dev_mode = Some(true);
        state.candidate_wrapper_commit = Some("a".repeat(40));
        state.candidate_wrapper_version = Some("0.9.0".to_string());

        run_apply_wrapper_update(&config, &mut state, &paths)
            .await
            .expect("dev-mode apply should silently skip");

        assert_eq!(state.status, UpdateStatus::Idle);
        assert_eq!(state.wrapper_dev_mode, Some(true));
        let expected_commit = "a".repeat(40);
        assert_eq!(
            state.candidate_wrapper_commit.as_deref(),
            Some(expected_commit.as_str())
        );
        assert_eq!(state.candidate_wrapper_version.as_deref(), Some("0.9.0"));
    }
}
