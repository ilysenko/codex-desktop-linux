//! Rebuilds native Linux packages from a downloaded upstream DMG.

use crate::{
    config::{RuntimeConfig, RuntimePaths},
    install::PackageKind,
    state::{ArtifactPaths, PersistedState, UpdateStatus},
};
use anyhow::{Context, Result};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::{
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    time::SystemTime,
};
use tokio::process::Command;
use tracing::{info, warn};

const REQUIRED_BUNDLE_FILES: [(&str, &str); 6] = [
    ("install.sh", "install.sh"),
    ("scripts/build-deb.sh", "scripts/build-deb.sh"),
    (
        "scripts/patch-linux-window-ui.js",
        "scripts/patch-linux-window-ui.js",
    ),
    (
        "scripts/lib/package-common.sh",
        "scripts/lib/package-common.sh",
    ),
    ("packaging/linux", "packaging/linux"),
    ("assets/codex.png", "assets/codex.png"),
];
const OPTIONAL_BUNDLE_FILES: [(&str, &str); 2] = [
    ("scripts/build-rpm.sh", "scripts/build-rpm.sh"),
    ("scripts/build-pacman.sh", "scripts/build-pacman.sh"),
];
const PACMAN_PACKAGE_SUFFIXES: &[&str] = &[
    ".pkg.tar.zst",
    ".pkg.tar.xz",
    ".pkg.tar.gz",
    ".pkg.tar.bz2",
    ".pkg.tar.lz",
    ".pkg.tar.lz4",
    ".pkg.tar.lz5",
];
const MAX_RETAINED_WORKSPACES: usize = 2;

#[derive(Debug, Clone, PartialEq, Eq)]
/// Paths to the temporary workspace and generated package produced by a rebuild.
pub struct BuildArtifacts {
    pub workspace_dir: PathBuf,
    pub package_path: PathBuf,
}

/// Rebuilds a Linux package from the downloaded upstream DMG.
pub async fn build_update(
    config: &RuntimeConfig,
    state: &mut PersistedState,
    paths: &RuntimePaths,
    candidate_version: &str,
    dmg_path: &Path,
) -> Result<BuildArtifacts> {
    let workspace = BuilderWorkspace::prepare(&config.workspace_root, candidate_version)?;
    let build_path = build_command_path();

    state.status = UpdateStatus::PreparingWorkspace;
    state.artifact_paths.workspace_dir = Some(workspace.workspace_dir.clone());
    state.save(&paths.state_file)?;

    copy_builder_bundle(&config.builder_bundle_root, &workspace.bundle_dir)?;
    ensure_executable(
        &workspace.bundle_dir.join("install.sh"),
        "builder install script",
    )?;

    state.status = UpdateStatus::PatchingApp;
    state.save(&paths.state_file)?;
    run_and_log(
        Command::new(workspace.bundle_dir.join("install.sh"))
            .arg(dmg_path)
            .env("CODEX_INSTALL_DIR", &workspace.app_dir)
            .env("PATH", &build_path)
            .current_dir(&workspace.bundle_dir),
        &workspace.install_log,
    )
    .await
    .context("install.sh failed during local rebuild")?;

    state.status = UpdateStatus::BuildingPackage;
    state.save(&paths.state_file)?;

    let build_script = package_build_script(&workspace.bundle_dir);
    ensure_executable(&build_script, "native package build script")?;
    run_and_log(
        Command::new(&build_script)
            .env("PACKAGE_VERSION", candidate_version)
            .env("APP_DIR_OVERRIDE", &workspace.app_dir)
            .env("DIST_DIR_OVERRIDE", &workspace.dist_dir)
            .env("UPDATER_BINARY_SOURCE", std::env::current_exe()?)
            .env(
                "UPDATER_SERVICE_SOURCE",
                workspace
                    .bundle_dir
                    .join("packaging/linux/codex-update-manager.service"),
            )
            .env("PATH", &build_path)
            .current_dir(&workspace.bundle_dir),
        &workspace.build_log,
    )
    .await
    .with_context(|| format!("{} failed during local rebuild", build_script.display()))?;

    let package_path = find_package_in(&workspace.dist_dir)?;
    state.status = UpdateStatus::ReadyToInstall;
    state.artifact_paths = ArtifactPaths {
        dmg_path: Some(dmg_path.to_path_buf()),
        workspace_dir: Some(workspace.workspace_dir.clone()),
        package_path: Some(package_path.clone()),
    };
    state.save(&paths.state_file)?;
    info!(candidate_version, package = %package_path.display(), "local update build ready");
    if let Err(error) = prune_old_workspaces(
        &config.workspace_root,
        &workspace.workspace_dir,
        MAX_RETAINED_WORKSPACES,
    ) {
        warn!(?error, "failed to prune old updater workspaces");
    }

    Ok(BuildArtifacts {
        workspace_dir: workspace.workspace_dir,
        package_path,
    })
}

#[derive(Debug, Clone)]
struct BuilderWorkspace {
    workspace_dir: PathBuf,
    bundle_dir: PathBuf,
    dist_dir: PathBuf,
    app_dir: PathBuf,
    install_log: PathBuf,
    build_log: PathBuf,
}

impl BuilderWorkspace {
    fn prepare(workspace_root: &Path, candidate_version: &str) -> Result<Self> {
        let workspace_dir = workspace_root.join("workspaces").join(candidate_version);
        let bundle_dir = workspace_dir.join("builder");
        let dist_dir = workspace_dir.join("dist");
        let app_dir = workspace_dir.join("codex-app");
        let logs_dir = workspace_dir.join("logs");
        let install_log = logs_dir.join("install.log");
        let build_log = logs_dir.join("build-package.log");

        if workspace_dir.exists() {
            fs::remove_dir_all(&workspace_dir)
                .with_context(|| format!("Failed to remove {}", workspace_dir.display()))?;
        }

        fs::create_dir_all(&logs_dir)
            .with_context(|| format!("Failed to create {}", logs_dir.display()))?;

        Ok(Self {
            workspace_dir,
            bundle_dir,
            dist_dir,
            app_dir,
            install_log,
            build_log,
        })
    }
}

/// Returns the path to the native-package build script appropriate for the running system.
fn package_build_script(bundle_dir: &Path) -> PathBuf {
    match PackageKind::detect() {
        PackageKind::Rpm => bundle_dir.join("scripts/build-rpm.sh"),
        PackageKind::Pacman => bundle_dir.join("scripts/build-pacman.sh"),
        PackageKind::Deb => bundle_dir.join("scripts/build-deb.sh"),
    }
}

fn copy_builder_bundle(source_root: &Path, destination_root: &Path) -> Result<()> {
    for (source, destination) in REQUIRED_BUNDLE_FILES {
        copy_entry(
            &source_root.join(source),
            &destination_root.join(destination),
            false,
        )?;
    }

    for (source, destination) in OPTIONAL_BUNDLE_FILES {
        copy_entry(
            &source_root.join(source),
            &destination_root.join(destination),
            true,
        )?;
    }

    Ok(())
}

fn copy_entry(source: &Path, destination: &Path, optional: bool) -> Result<()> {
    if !source.exists() {
        if optional {
            return Ok(());
        }
        anyhow::bail!(
            "Required builder bundle path is missing: {}",
            source.display()
        );
    }

    if source.is_dir() {
        copy_dir_recursive(source, destination)?;
    } else {
        copy_path(source, destination)?;
    }

    Ok(())
}

fn copy_path(source: &Path, destination: &Path) -> Result<()> {
    let parent = destination
        .parent()
        .context("Destination path has no parent directory")?;
    fs::create_dir_all(parent).with_context(|| format!("Failed to create {}", parent.display()))?;
    fs::copy(source, destination).with_context(|| {
        format!(
            "Failed to copy {} to {}",
            source.display(),
            destination.display()
        )
    })?;
    let metadata =
        fs::metadata(source).with_context(|| format!("Failed to stat {}", source.display()))?;
    fs::set_permissions(destination, metadata.permissions())
        .with_context(|| format!("Failed to set permissions on {}", destination.display()))?;
    Ok(())
}

fn copy_dir_recursive(source: &Path, destination: &Path) -> Result<()> {
    fs::create_dir_all(destination)
        .with_context(|| format!("Failed to create {}", destination.display()))?;

    for entry in
        fs::read_dir(source).with_context(|| format!("Failed to read {}", source.display()))?
    {
        let entry = entry?;
        let entry_path = entry.path();
        let destination_path = destination.join(entry.file_name());

        if entry.file_type()?.is_dir() {
            copy_dir_recursive(&entry_path, &destination_path)?;
        } else {
            copy_path(&entry_path, &destination_path)?;
        }
    }

    Ok(())
}

/// Find a native package file inside `dist_dir`.
fn find_package_in(dist_dir: &Path) -> Result<PathBuf> {
    for entry in
        fs::read_dir(dist_dir).with_context(|| format!("Failed to read {}", dist_dir.display()))?
    {
        let entry = entry?;
        let path = entry.path();
        if is_native_package_file(&path) {
            return Ok(path);
        }
    }

    anyhow::bail!(
        "No native package (.deb, .rpm, or .pkg.tar.*) found in {}",
        dist_dir.display()
    )
}

fn prune_old_workspaces(
    workspace_root: &Path,
    keep_workspace: &Path,
    max_retained: usize,
) -> Result<()> {
    if max_retained == 0 {
        return Ok(());
    }

    let workspaces_dir = workspace_root.join("workspaces");
    if !workspaces_dir.exists() {
        return Ok(());
    }

    let keep_workspace = keep_workspace
        .canonicalize()
        .unwrap_or_else(|_| keep_workspace.to_path_buf());
    let mut candidates = Vec::new();
    for entry in fs::read_dir(&workspaces_dir)
        .with_context(|| format!("Failed to read {}", workspaces_dir.display()))?
    {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }

        let path = entry.path();
        let canonical_path = path.canonicalize().unwrap_or_else(|_| path.clone());
        if canonical_path == keep_workspace {
            continue;
        }

        let modified = entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .unwrap_or(SystemTime::UNIX_EPOCH);
        candidates.push((modified, path));
    }

    candidates.sort_by(|left, right| right.0.cmp(&left.0));
    for (_, path) in candidates.into_iter().skip(max_retained.saturating_sub(1)) {
        fs::remove_dir_all(&path).with_context(|| {
            format!("Failed to remove old updater workspace {}", path.display())
        })?;
        info!(workspace = %path.display(), "removed old updater workspace");
    }

    Ok(())
}

fn is_native_package_file(path: &Path) -> bool {
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    name.ends_with(".deb")
        || name.ends_with(".rpm")
        || PACMAN_PACKAGE_SUFFIXES
            .iter()
            .any(|suffix| name.ends_with(suffix))
}

fn build_command_path() -> OsString {
    let mut entries = preferred_node_bin_dirs();
    entries.extend(std::env::split_paths(
        &std::env::var_os("PATH").unwrap_or_default(),
    ));
    std::env::join_paths(entries).unwrap_or_else(|_| std::env::var_os("PATH").unwrap_or_default())
}

fn preferred_node_bin_dirs() -> Vec<PathBuf> {
    let nvm_root = std::env::var_os("NVM_DIR")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".nvm")));

    let Some(nvm_root) = nvm_root else {
        return Vec::new();
    };

    collect_nvm_bin_dirs(&nvm_root)
}

fn collect_nvm_bin_dirs(nvm_root: &Path) -> Vec<PathBuf> {
    let mut directories = Vec::new();
    let mut seen = std::collections::BTreeSet::new();

    let current_bin = nvm_root.join("versions/node/current/bin");
    if is_node_toolchain_dir(&current_bin) {
        seen.insert(current_bin.clone());
        directories.push(current_bin);
    }

    let versions_root = nvm_root.join("versions/node");
    if let Ok(entries) = fs::read_dir(&versions_root) {
        let mut version_bins = entries
            .filter_map(|entry| entry.ok().map(|item| item.path().join("bin")))
            .filter(|path| is_node_toolchain_dir(path))
            .collect::<Vec<_>>();
        version_bins.sort();
        version_bins.reverse();

        for path in version_bins {
            if seen.insert(path.clone()) {
                directories.push(path);
            }
        }
    }

    directories
}

fn is_node_toolchain_dir(path: &Path) -> bool {
    ["node", "npm", "npx"]
        .into_iter()
        .all(|binary| is_executable(&path.join(binary)))
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    metadata.is_file() && metadata.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    path.is_file()
}

fn ensure_executable(path: &Path, label: &str) -> Result<()> {
    if is_executable(path) {
        return Ok(());
    }

    anyhow::bail!("{label} is missing or not executable: {}", path.display())
}

async fn run_and_log(command: &mut Command, log_path: &Path) -> Result<()> {
    let output = command
        .output()
        .await
        .context("Failed to spawn external command")?;

    let mut combined = Vec::new();
    combined.extend_from_slice(&output.stdout);
    combined.extend_from_slice(&output.stderr);
    fs::write(log_path, &combined)
        .with_context(|| format!("Failed to write {}", log_path.display()))?;

    if !output.status.success() {
        anyhow::bail!(
            "Command failed with status {:?}; see {}",
            output.status.code(),
            log_path.display()
        );
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::RuntimePaths;
    use anyhow::Result;
    use tempfile::tempdir;

    enum FakePackageOutput {
        Deb,
        Rpm,
        Pacman,
    }

    fn write_fake_build_script(path: &Path, output: FakePackageOutput) -> Result<()> {
        let script_body = match output {
            FakePackageOutput::Deb => {
                r#"#!/bin/bash
set -euo pipefail
mkdir -p "${DIST_DIR_OVERRIDE}"
touch "${DIST_DIR_OVERRIDE}/codex-desktop_${PACKAGE_VERSION}_amd64.deb"
"#
            }
            FakePackageOutput::Rpm => {
                r#"#!/bin/bash
set -euo pipefail
mkdir -p "${DIST_DIR_OVERRIDE}"
touch "${DIST_DIR_OVERRIDE}/codex-desktop-${PACKAGE_VERSION}.x86_64.rpm"
"#
            }
            FakePackageOutput::Pacman => {
                r#"#!/bin/bash
set -euo pipefail
VER="${PACKAGE_VERSION%%+*}"
mkdir -p "${DIST_DIR_OVERRIDE}"
touch "${DIST_DIR_OVERRIDE}/codex-desktop-${VER}-1-x86_64.pkg.tar.zst"
"#
            }
        };

        fs::write(path, script_body)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(0o755))?;
        }
        Ok(())
    }

    fn write_executable_file(path: &Path, contents: &[u8]) -> Result<()> {
        fs::write(path, contents)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(0o755))?;
        }
        Ok(())
    }

    #[tokio::test]
    async fn builds_update_with_fake_bundle() -> Result<()> {
        let temp = tempdir()?;
        let bundle_root = temp.path().join("bundle");
        let state_root = temp.path().join("state");
        let cache_root = temp.path().join("cache");
        fs::create_dir_all(bundle_root.join("scripts/lib"))?;
        fs::create_dir_all(bundle_root.join("packaging/linux"))?;
        fs::create_dir_all(bundle_root.join("assets"))?;
        fs::write(bundle_root.join("assets/codex.png"), b"png")?;
        fs::write(
            bundle_root.join("packaging/linux/control"),
            "Package: codex",
        )?;
        fs::write(
            bundle_root.join("packaging/linux/codex-desktop.spec"),
            "Name: codex",
        )?;
        fs::write(
            bundle_root.join("packaging/linux/codex-desktop.desktop"),
            "[Desktop Entry]",
        )?;
        fs::write(
            bundle_root.join("packaging/linux/codex-update-manager.service"),
            "[Unit]\nDescription=Codex Update Manager\n",
        )?;
        write_executable_file(
            &bundle_root.join("install.sh"),
            br#"#!/bin/bash
set -euo pipefail
mkdir -p "${CODEX_INSTALL_DIR}"
echo launcher > "${CODEX_INSTALL_DIR}/start.sh"
chmod +x "${CODEX_INSTALL_DIR}/start.sh"
"#,
        )?;

        write_fake_build_script(
            &bundle_root.join("scripts/build-deb.sh"),
            FakePackageOutput::Deb,
        )?;
        write_fake_build_script(
            &bundle_root.join("scripts/build-rpm.sh"),
            FakePackageOutput::Rpm,
        )?;
        write_fake_build_script(
            &bundle_root.join("scripts/build-pacman.sh"),
            FakePackageOutput::Pacman,
        )?;
        fs::write(
            bundle_root.join("scripts/patch-linux-window-ui.js"),
            b"console.log('patched');\n",
        )?;
        fs::write(
            bundle_root.join("scripts/lib/package-common.sh"),
            b"#!/bin/bash\n",
        )?;

        let paths = RuntimePaths {
            config_file: temp.path().join("config/config.toml"),
            state_file: state_root.join("state.json"),
            log_file: state_root.join("service.log"),
            cache_dir: cache_root.clone(),
            state_dir: state_root.clone(),
            config_dir: temp.path().join("config"),
        };
        paths.ensure_dirs()?;

        let config = RuntimeConfig {
            dmg_url: "https://example.com/Codex.dmg".to_string(),
            initial_check_delay_seconds: 30,
            check_interval_hours: 6,
            auto_install_on_app_exit: true,
            notifications: true,
            workspace_root: cache_root,
            builder_bundle_root: bundle_root,
            app_executable_path: PathBuf::from("/opt/codex-desktop/electron"),
        };
        let dmg_path = temp.path().join("Codex.dmg");
        fs::write(&dmg_path, b"dmg")?;

        let mut state = PersistedState::new(true);
        let artifacts = build_update(
            &config,
            &mut state,
            &paths,
            "2026.03.24+abcd1234",
            &dmg_path,
        )
        .await?;
        assert_eq!(state.status, UpdateStatus::ReadyToInstall);
        assert!(artifacts.workspace_dir.exists());
        assert!(artifacts.package_path.exists());
        assert!(
            is_native_package_file(&artifacts.package_path),
            "expected a native package (.deb, .rpm, or .pkg.tar.zst), got {}",
            artifacts.package_path.display()
        );
        Ok(())
    }

    #[test]
    fn bundle_copy_skips_missing_optional_package_scripts() -> Result<()> {
        let temp = tempdir()?;
        let source_root = temp.path().join("source");
        let destination_root = temp.path().join("destination");

        fs::create_dir_all(source_root.join("scripts/lib"))?;
        fs::create_dir_all(source_root.join("packaging/linux"))?;
        fs::create_dir_all(source_root.join("assets"))?;
        fs::write(source_root.join("install.sh"), b"#!/bin/bash\n")?;
        fs::write(source_root.join("scripts/build-deb.sh"), b"#!/bin/bash\n")?;
        fs::write(
            source_root.join("scripts/patch-linux-window-ui.js"),
            b"console.log('patched');\n",
        )?;
        fs::write(
            source_root.join("scripts/lib/package-common.sh"),
            b"#!/bin/bash\n",
        )?;
        fs::write(
            source_root.join("packaging/linux/control"),
            b"Package: codex\n",
        )?;
        fs::write(
            source_root.join("packaging/linux/codex-update-manager.service"),
            b"[Unit]\nDescription=Codex Update Manager\n",
        )?;
        fs::write(source_root.join("assets/codex.png"), b"png")?;

        copy_builder_bundle(&source_root, &destination_root)?;

        assert!(destination_root.join("scripts/build-deb.sh").exists());
        assert!(destination_root
            .join("scripts/patch-linux-window-ui.js")
            .exists());
        assert!(!destination_root.join("scripts/build-rpm.sh").exists());
        assert!(!destination_root.join("scripts/build-pacman.sh").exists());
        Ok(())
    }

    #[test]
    fn returns_error_when_dist_has_no_native_package() -> Result<()> {
        let temp = tempdir()?;
        fs::write(temp.path().join("README.txt"), b"no packages here")?;

        let error = find_package_in(temp.path()).expect_err("package discovery should fail");
        assert!(error
            .to_string()
            .contains("No native package (.deb, .rpm, or .pkg.tar.*)"));
        Ok(())
    }

    #[test]
    fn prunes_old_workspaces_but_keeps_current() -> Result<()> {
        let temp = tempdir()?;
        let workspace_root = temp.path().join("cache");
        let workspaces_dir = workspace_root.join("workspaces");
        let current = workspaces_dir.join("current");
        let old_a = workspaces_dir.join("old-a");
        let old_b = workspaces_dir.join("old-b");

        for workspace in [&current, &old_a, &old_b] {
            fs::create_dir_all(workspace)?;
            fs::write(workspace.join("marker"), b"workspace")?;
        }

        prune_old_workspaces(&workspace_root, &current, 1)?;

        assert!(current.exists());
        assert!(!old_a.exists());
        assert!(!old_b.exists());
        Ok(())
    }

    #[test]
    fn workspace_pruning_retains_only_configured_count() -> Result<()> {
        let temp = tempdir()?;
        let workspace_root = temp.path().join("cache");
        let workspaces_dir = workspace_root.join("workspaces");
        let current = workspaces_dir.join("current");
        let old_a = workspaces_dir.join("old-a");
        let old_b = workspaces_dir.join("old-b");

        for workspace in [&current, &old_a, &old_b] {
            fs::create_dir_all(workspace)?;
            fs::write(workspace.join("marker"), b"workspace")?;
        }

        prune_old_workspaces(&workspace_root, &current, 2)?;

        let retained_count = fs::read_dir(&workspaces_dir)?.count();
        assert_eq!(retained_count, 2);
        assert!(current.exists());
        Ok(())
    }

    #[test]
    fn finds_pacman_package_in_dist_dir() -> Result<()> {
        let temp = tempdir()?;
        let pkg_path = temp
            .path()
            .join("codex-desktop-2026.03.30.120000-1-x86_64.pkg.tar.zst");
        fs::write(&pkg_path, b"pkg")?;

        let found = find_package_in(temp.path())?;
        assert_eq!(found, pkg_path);
        Ok(())
    }

    #[test]
    fn collects_nvm_toolchain_bins_with_current_first() -> Result<()> {
        let temp = tempdir()?;
        let nvm_root = temp.path().join(".nvm");
        let current_bin = nvm_root.join("versions/node/current/bin");
        let version_bin = nvm_root.join("versions/node/v24.2.0/bin");

        fs::create_dir_all(&current_bin)?;
        fs::create_dir_all(&version_bin)?;
        for dir in [&current_bin, &version_bin] {
            for binary in ["node", "npm", "npx"] {
                write_executable_file(&dir.join(binary), b"bin")?;
            }
        }

        let directories = collect_nvm_bin_dirs(&nvm_root);
        assert_eq!(directories.first(), Some(&current_bin));
        assert!(directories.contains(&version_bin));
        Ok(())
    }

    #[test]
    fn executable_check_requires_execute_permission() -> Result<()> {
        let temp = tempdir()?;
        let script = temp.path().join("script.sh");
        fs::write(&script, b"#!/bin/sh\n")?;

        assert!(!is_executable(&script));
        write_executable_file(&script, b"#!/bin/sh\n")?;
        assert!(is_executable(&script));
        Ok(())
    }
}
