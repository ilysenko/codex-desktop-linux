//! Rebuilds native Linux packages from a downloaded upstream DMG.

use crate::{
    config::{RuntimeConfig, RuntimePaths},
    install::PackageKind,
    state::{ArtifactPaths, PersistedState, UpdateStatus},
};
use anyhow::{Context, Result};
use std::{
    ffi::OsString,
    fs,
    path::{Component, Path, PathBuf},
};
use tokio::process::Command;
use tracing::info;

const UPDATE_BUILDER_MANIFEST: &str = ".codex-linux/update-builder-manifest.txt";

const REQUIRED_BUNDLE_FILES: [(&str, &str); 19] = [
    ("Cargo.toml", "Cargo.toml"),
    ("Cargo.lock", "Cargo.lock"),
    ("computer-use-linux", "computer-use-linux"),
    ("read-aloud-linux", "read-aloud-linux"),
    ("record-replay-linux", "record-replay-linux"),
    ("updater", "updater"),
    (
        "plugins/openai-bundled/plugins/computer-use",
        "plugins/openai-bundled/plugins/computer-use",
    ),
    (
        "plugins/openai-bundled/plugins/read-aloud",
        "plugins/openai-bundled/plugins/read-aloud",
    ),
    ("install.sh", "install.sh"),
    ("launcher/start.sh.template", "launcher/start.sh.template"),
    ("launcher/webview-server.py", "launcher/webview-server.py"),
    ("scripts/build-deb.sh", "scripts/build-deb.sh"),
    (
        "scripts/patch-linux-window-ui.js",
        "scripts/patch-linux-window-ui.js",
    ),
    ("scripts/patches", "scripts/patches"),
    ("scripts/lib", "scripts/lib"),
    ("packaging/linux", "packaging/linux"),
    ("assets/codex.png", "assets/codex.png"),
    ("assets/codex-linux.png", "assets/codex-linux.png"),
    ("linux-features", "linux-features"),
];
const OPTIONAL_BUNDLE_FILES: [(&str, &str); 5] = [
    ("CHANGELOG.md", "CHANGELOG.md"),
    (
        ".codex-linux/source-info.json",
        ".codex-linux/source-info.json",
    ),
    ("scripts/build-rpm.sh", "scripts/build-rpm.sh"),
    ("scripts/build-pacman.sh", "scripts/build-pacman.sh"),
    (
        "scripts/rebuild-candidate.sh",
        "scripts/rebuild-candidate.sh",
    ),
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
    build_update_from(
        &config.builder_bundle_root,
        config,
        state,
        paths,
        candidate_version,
        dmg_path,
    )
    .await
}

/// Rebuilds a Linux package using an explicit wrapper/builder source tree.
pub async fn build_update_from(
    bundle_source: &Path,
    config: &RuntimeConfig,
    state: &mut PersistedState,
    paths: &RuntimePaths,
    candidate_version: &str,
    dmg_path: &Path,
) -> Result<BuildArtifacts> {
    let workspace = BuilderWorkspace::prepare(&config.workspace_root, candidate_version)?;
    let build_path = build_command_path(&config.builder_bundle_root);
    let managed_node_source = if config.builder_bundle_root.join("node-runtime").exists() {
        config.builder_bundle_root.join("node-runtime")
    } else {
        bundle_source.join("node-runtime")
    };

    state.status = UpdateStatus::PreparingWorkspace;
    state.artifact_paths.workspace_dir = Some(workspace.workspace_dir.clone());
    state.save(&paths.state_file)?;

    copy_builder_bundle(bundle_source, &workspace.bundle_dir)?;

    state.status = UpdateStatus::PatchingApp;
    state.save(&paths.state_file)?;
    let mut install = Command::new(workspace.bundle_dir.join("install.sh"));
    install
        .arg(dmg_path)
        .env("CODEX_INSTALL_DIR", &workspace.app_dir)
        .env(
            "CODEX_PATCH_REPORT_JSON",
            workspace.reports_dir.join("patch-report.json"),
        )
        .env(
            "CODEX_REBUILD_REPORT_JSON",
            workspace.reports_dir.join("rebuild-report.json"),
        )
        .env("CODEX_MANAGED_NODE_SOURCE", managed_node_source)
        .env("PATH", &build_path)
        .current_dir(&workspace.bundle_dir);
    // Honor the user's saved feature selection (the in-app Update feature picker
    // writes it to a stable per-user path) so the rebuild stages exactly those
    // features. Only set it when the file actually exists; an absent path would
    // make linux-features.js see an empty enabled set and stage nothing.
    if let Some(feature_config) = crate::config::effective_feature_config_path(config) {
        install.env("CODEX_LINUX_FEATURES_CONFIG", &feature_config);
    }
    run_and_log(&mut install, &workspace.install_log)
        .await
        .context("install.sh failed during local rebuild")?;

    state.status = UpdateStatus::BuildingPackage;
    state.save(&paths.state_file)?;

    let build_script = package_build_script(&workspace.bundle_dir);
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
        rollback_package_path: state.artifact_paths.rollback_package_path.clone(),
    };
    state.save(&paths.state_file)?;
    info!(candidate_version, package = %package_path.display(), "local update build ready");

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
    reports_dir: PathBuf,
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
        let reports_dir = workspace_dir.join("reports");
        let install_log = logs_dir.join("install.log");
        let build_log = logs_dir.join("build-package.log");

        if workspace_dir.exists() {
            fs::remove_dir_all(&workspace_dir)
                .with_context(|| format!("Failed to remove {}", workspace_dir.display()))?;
        }

        fs::create_dir_all(&logs_dir)
            .with_context(|| format!("Failed to create {}", logs_dir.display()))?;
        fs::create_dir_all(&reports_dir)
            .with_context(|| format!("Failed to create {}", reports_dir.display()))?;

        Ok(Self {
            workspace_dir,
            bundle_dir,
            dist_dir,
            app_dir,
            reports_dir,
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
    let manifest_path = source_root.join(UPDATE_BUILDER_MANIFEST);
    if manifest_path.exists() {
        return copy_builder_bundle_from_manifest(source_root, destination_root, &manifest_path);
    }

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

fn copy_builder_bundle_from_manifest(
    source_root: &Path,
    destination_root: &Path,
    manifest_path: &Path,
) -> Result<()> {
    let manifest = fs::read_to_string(manifest_path)
        .with_context(|| format!("Failed to read {}", manifest_path.display()))?;

    for (index, line) in manifest.lines().enumerate() {
        let entry = line.trim();
        if entry.is_empty() || entry.starts_with('#') {
            continue;
        }
        let relative_path = Path::new(entry);
        if !is_safe_manifest_relative_path(relative_path) {
            anyhow::bail!(
                "Unsafe update-builder manifest entry at line {}: {}",
                index + 1,
                entry
            );
        }
        copy_entry(
            &source_root.join(relative_path),
            &destination_root.join(relative_path),
            false,
        )?;
    }

    copy_entry(
        manifest_path,
        &destination_root.join(UPDATE_BUILDER_MANIFEST),
        false,
    )?;
    Ok(())
}

fn is_safe_manifest_relative_path(path: &Path) -> bool {
    let mut has_component = false;
    for component in path.components() {
        match component {
            Component::Normal(_) => has_component = true,
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => return false,
        }
    }
    has_component && !path.is_absolute()
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

fn build_command_path(builder_bundle_root: &Path) -> OsString {
    let mut entries = managed_node_bin_dirs(builder_bundle_root);
    entries.extend(preferred_node_bin_dirs());
    entries.extend(preferred_rust_bin_dirs());
    entries.extend(std::env::split_paths(
        &std::env::var_os("PATH").unwrap_or_default(),
    ));
    entries.extend(system_bin_dirs());
    std::env::join_paths(entries).unwrap_or_else(|_| std::env::var_os("PATH").unwrap_or_default())
}

fn managed_node_bin_dirs(builder_bundle_root: &Path) -> Vec<PathBuf> {
    let bin_dir = builder_bundle_root.join("node-runtime/bin");
    if is_node_toolchain_dir(&bin_dir) {
        vec![bin_dir]
    } else {
        Vec::new()
    }
}

fn system_bin_dirs() -> Vec<PathBuf> {
    [
        "/usr/local/sbin",
        "/usr/local/bin",
        "/usr/sbin",
        "/usr/bin",
        "/sbin",
        "/bin",
    ]
    .into_iter()
    .map(PathBuf::from)
    .collect()
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

fn preferred_rust_bin_dirs() -> Vec<PathBuf> {
    let Some(home) = std::env::var_os("HOME") else {
        return Vec::new();
    };

    let cargo_bin = PathBuf::from(home).join(".cargo/bin");
    if cargo_bin.join("cargo").is_file() {
        vec![cargo_bin]
    } else {
        Vec::new()
    }
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
        .all(|binary| path.join(binary).is_file())
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

    const FRESH_PATCH_BUNDLE_FILES: &[&str] = &[
        "scripts/patches/descriptor.js",
        "scripts/patches/engine.js",
        "scripts/patches/runner.js",
        "scripts/patches/lib/assets.js",
        "scripts/patches/lib/minified-js.js",
        "scripts/patches/lib/settings-keys.js",
        "scripts/patches/impl/webview/index.js",
        "scripts/patches/core/all-linux/main-process/lifecycle/patch.js",
        "scripts/patches/core/all-linux/webview/theme-and-sunset/patch.js",
    ];

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

    fn write_fake_computer_use_bundle(root: &Path) -> Result<()> {
        fs::write(
            root.join("Cargo.toml"),
            b"[workspace]\nmembers = [\"computer-use-linux\", \"read-aloud-linux\", \"record-replay-linux\", \"updater\"]\n",
        )?;
        fs::write(root.join("Cargo.lock"), b"# fake lock\n")?;
        fs::create_dir_all(root.join("computer-use-linux/src"))?;
        fs::write(
            root.join("computer-use-linux/Cargo.toml"),
            b"[package]\nname = \"codex-computer-use-linux\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
        )?;
        fs::write(
            root.join("computer-use-linux/src/main.rs"),
            b"fn main() {}\n",
        )?;
        fs::create_dir_all(root.join("read-aloud-linux/src"))?;
        fs::write(
            root.join("read-aloud-linux/Cargo.toml"),
            b"[package]\nname = \"codex-read-aloud-linux\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
        )?;
        fs::write(root.join("read-aloud-linux/src/main.rs"), b"fn main() {}\n")?;
        fs::create_dir_all(root.join("record-replay-linux/src"))?;
        fs::write(
            root.join("record-replay-linux/Cargo.toml"),
            b"[package]\nname = \"codex-record-replay-linux\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
        )?;
        fs::write(
            root.join("record-replay-linux/src/main.rs"),
            b"fn main() {}\n",
        )?;
        fs::create_dir_all(root.join("updater/src"))?;
        fs::write(
            root.join("updater/Cargo.toml"),
            b"[package]\nname = \"codex-update-manager\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
        )?;
        fs::write(root.join("updater/src/main.rs"), b"fn main() {}\n")?;
        fs::create_dir_all(root.join("plugins/openai-bundled/plugins/computer-use/.codex-plugin"))?;
        fs::write(
            root.join("plugins/openai-bundled/plugins/computer-use/.codex-plugin/plugin.json"),
            b"{\"name\":\"computer-use\",\"version\":\"0.1.0\"}\n",
        )?;
        fs::write(
            root.join("plugins/openai-bundled/plugins/computer-use/.mcp.json"),
            b"{\"mcpServers\":{}}\n",
        )?;
        fs::create_dir_all(root.join("plugins/openai-bundled/plugins/read-aloud/.codex-plugin"))?;
        fs::write(
            root.join("plugins/openai-bundled/plugins/read-aloud/.codex-plugin/plugin.json"),
            b"{\"name\":\"read-aloud\",\"version\":\"0.1.0\"}\n",
        )?;
        fs::write(
            root.join("plugins/openai-bundled/plugins/read-aloud/.mcp.json"),
            b"{\"mcpServers\":{}}\n",
        )?;
        Ok(())
    }

    fn write_fake_linux_features_bundle(root: &Path) -> Result<()> {
        fs::create_dir_all(root.join("linux-features/example-feature"))?;
        fs::write(
            root.join("linux-features/features.example.json"),
            b"{\"enabled\":[]}\n",
        )?;
        fs::write(
            root.join("linux-features/example-feature/feature.json"),
            b"{\"id\":\"example-feature\"}\n",
        )?;
        Ok(())
    }

    fn write_fake_patch_bundle(root: &Path) -> Result<()> {
        for relative_path in FRESH_PATCH_BUNDLE_FILES {
            let file_path = root.join(relative_path);
            if let Some(parent) = file_path.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::write(file_path, b"module.exports = {};\n")?;
        }
        Ok(())
    }

    fn assert_fresh_patch_bundle(root: &Path) {
        for relative_path in FRESH_PATCH_BUNDLE_FILES {
            let file_path = root.join(relative_path);
            assert!(
                file_path.exists(),
                "expected fresh patch bundle file {}",
                file_path.display()
            );
        }
        let stale_registry = root
            .join("scripts/patches")
            .join("registry")
            .with_extension("js");
        assert!(
            !stale_registry.exists(),
            "stale patch registry should not be present at {}",
            stale_registry.display()
        );
    }

    #[tokio::test]
    async fn builds_update_with_fake_bundle() -> Result<()> {
        let temp = tempdir()?;
        let bundle_root = temp.path().join("bundle");
        let state_root = temp.path().join("state");
        let cache_root = temp.path().join("cache");
        fs::create_dir_all(bundle_root.join("scripts/lib"))?;
        fs::create_dir_all(bundle_root.join("launcher"))?;
        fs::create_dir_all(bundle_root.join("packaging/linux"))?;
        fs::create_dir_all(bundle_root.join("assets"))?;
        fs::create_dir_all(bundle_root.join(".codex-linux"))?;
        write_fake_computer_use_bundle(&bundle_root)?;
        write_fake_linux_features_bundle(&bundle_root)?;
        write_fake_patch_bundle(&bundle_root)?;
        fs::write(bundle_root.join("CHANGELOG.md"), b"# Changelog\n")?;
        fs::write(
            bundle_root.join(".codex-linux/source-info.json"),
            b"{\"commit\":\"0123456789012345678901234567890123456789\",\"version\":\"0.8.1\"}\n",
        )?;
        fs::write(
            bundle_root.join("launcher/start.sh.template"),
            b"# fake launcher template\n",
        )?;
        fs::write(
            bundle_root.join("launcher/webview-server.py"),
            b"# fake webview server\n",
        )?;
        fs::write(bundle_root.join("assets/codex.png"), b"png")?;
        fs::write(bundle_root.join("assets/codex-linux.png"), b"linux png")?;
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
        fs::write(
            bundle_root.join("packaging/linux/codex-update-manager-user-service.sh"),
            "#!/bin/bash\n",
        )?;
        fs::write(
            bundle_root.join("packaging/linux/codex-update-manager.postinst"),
            "#!/bin/sh\nexit 0\n",
        )?;
        fs::write(
            bundle_root.join("packaging/linux/codex-update-manager.prerm"),
            "#!/bin/sh\nexit 0\n",
        )?;
        fs::write(
            bundle_root.join("packaging/linux/codex-update-manager.postrm"),
            "#!/bin/sh\nexit 0\n",
        )?;
        fs::write(
            bundle_root.join("packaging/linux/codex-packaged-runtime.sh"),
            "#!/bin/bash\n",
        )?;
        fs::write(
            bundle_root.join("packaging/linux/PKGBUILD.template"),
            "pkgname=codex\n",
        )?;
        fs::write(
            bundle_root.join("packaging/linux/codex-desktop.install"),
            "post_install() { :; }\n",
        )?;
        fs::write(
            bundle_root.join("install.sh"),
            r#"#!/bin/bash
set -euo pipefail
mkdir -p "${CODEX_INSTALL_DIR}"
echo launcher > "${CODEX_INSTALL_DIR}/start.sh"
chmod +x "${CODEX_INSTALL_DIR}/start.sh"
if [ -n "${CODEX_PATCH_REPORT_JSON:-}" ]; then
  mkdir -p "$(dirname "$CODEX_PATCH_REPORT_JSON")"
  printf '{"patches":[]}\n' > "${CODEX_PATCH_REPORT_JSON}"
fi
if [ -n "${CODEX_REBUILD_REPORT_JSON:-}" ]; then
  mkdir -p "$(dirname "$CODEX_REBUILD_REPORT_JSON")"
  printf '{"appDir":"%s"}\n' "${CODEX_INSTALL_DIR}" > "${CODEX_REBUILD_REPORT_JSON}"
fi
"#,
        )?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(
                bundle_root.join("install.sh"),
                fs::Permissions::from_mode(0o755),
            )?;
        }

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
            bundle_root.join("scripts/rebuild-candidate.sh"),
            b"#!/bin/bash\n",
        )?;
        fs::write(
            bundle_root.join("scripts/patch-linux-window-ui.js"),
            b"console.log('patched');\n",
        )?;
        fs::write(
            bundle_root.join("scripts/lib/package-common.sh"),
            b"#!/bin/bash\n",
        )?;
        fs::write(
            bundle_root.join("scripts/lib/node-runtime.sh"),
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
            enable_wrapper_updates: false,
            wrapper_remote: String::new(),
            wrapper_branch: "main".to_string(),
            generated_artifact_cleanup: Default::default(),
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
        assert!(artifacts
            .workspace_dir
            .join("builder/scripts/rebuild-candidate.sh")
            .exists());
        assert!(artifacts
            .workspace_dir
            .join("builder/assets/codex-linux.png")
            .exists());
        assert!(artifacts
            .workspace_dir
            .join("builder/record-replay-linux/Cargo.toml")
            .exists());
        assert!(artifacts
            .workspace_dir
            .join("builder/CHANGELOG.md")
            .exists());
        assert!(artifacts
            .workspace_dir
            .join("builder/.codex-linux/source-info.json")
            .exists());
        assert!(artifacts
            .workspace_dir
            .join("builder/launcher/webview-server.py")
            .exists());
        assert!(artifacts
            .workspace_dir
            .join("builder/scripts/lib/node-runtime.sh")
            .exists());
        assert_fresh_patch_bundle(&artifacts.workspace_dir.join("builder"));
        assert!(artifacts
            .workspace_dir
            .join("builder/linux-features/features.example.json")
            .exists());
        assert!(artifacts
            .workspace_dir
            .join("reports/patch-report.json")
            .exists());
        assert!(artifacts
            .workspace_dir
            .join("reports/rebuild-report.json")
            .exists());
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
        fs::create_dir_all(source_root.join("launcher"))?;
        fs::create_dir_all(source_root.join("packaging/linux"))?;
        fs::create_dir_all(source_root.join("assets"))?;
        write_fake_computer_use_bundle(&source_root)?;
        write_fake_linux_features_bundle(&source_root)?;
        write_fake_patch_bundle(&source_root)?;
        fs::write(source_root.join("install.sh"), b"#!/bin/bash\n")?;
        fs::write(
            source_root.join("launcher/start.sh.template"),
            b"# fake launcher template\n",
        )?;
        fs::write(
            source_root.join("launcher/webview-server.py"),
            b"# fake webview server\n",
        )?;
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
            source_root.join("scripts/lib/node-runtime.sh"),
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
        fs::write(source_root.join("assets/codex-linux.png"), b"linux png")?;

        copy_builder_bundle(&source_root, &destination_root)?;

        assert!(destination_root.join("scripts/build-deb.sh").exists());
        assert!(destination_root
            .join("scripts/patch-linux-window-ui.js")
            .exists());
        assert!(destination_root.join("launcher/webview-server.py").exists());
        assert_fresh_patch_bundle(&destination_root);
        assert!(destination_root.join("computer-use-linux").exists());
        assert!(destination_root.join("read-aloud-linux").exists());
        assert!(destination_root.join("record-replay-linux").exists());
        assert!(destination_root.join("updater").exists());
        assert!(destination_root.join("assets/codex-linux.png").exists());
        assert!(destination_root
            .join("plugins/openai-bundled/plugins/computer-use/.mcp.json")
            .exists());
        assert!(destination_root
            .join("plugins/openai-bundled/plugins/read-aloud/.mcp.json")
            .exists());
        assert!(destination_root
            .join("scripts/lib/node-runtime.sh")
            .exists());
        assert!(destination_root
            .join("linux-features/features.example.json")
            .exists());
        assert!(!destination_root.join("scripts/build-rpm.sh").exists());
        assert!(!destination_root.join("scripts/build-pacman.sh").exists());
        Ok(())
    }

    #[test]
    fn bundle_copy_prefers_packaged_update_builder_manifest() -> Result<()> {
        let temp = tempdir()?;
        let source_root = temp.path().join("source");
        let destination_root = temp.path().join("destination");

        fs::create_dir_all(source_root.join(".codex-linux"))?;
        fs::create_dir_all(source_root.join("assets"))?;
        fs::create_dir_all(source_root.join("record-replay-linux"))?;
        fs::create_dir_all(source_root.join("scripts"))?;
        fs::write(source_root.join("assets/codex-linux.png"), b"linux png")?;
        fs::write(
            source_root.join("record-replay-linux/Cargo.toml"),
            b"[package]\nname = \"codex-record-replay-linux\"\n",
        )?;
        fs::write(source_root.join("scripts/build-deb.sh"), b"#!/bin/bash\n")?;
        fs::write(
            source_root.join(UPDATE_BUILDER_MANIFEST),
            b"# generated\nassets/codex-linux.png\nrecord-replay-linux/Cargo.toml\n",
        )?;

        copy_builder_bundle(&source_root, &destination_root)?;

        assert!(destination_root.join("assets/codex-linux.png").exists());
        assert!(destination_root
            .join("record-replay-linux/Cargo.toml")
            .exists());
        assert!(destination_root.join(UPDATE_BUILDER_MANIFEST).exists());
        assert!(!destination_root.join("scripts/build-deb.sh").exists());
        Ok(())
    }

    #[test]
    fn bundle_manifest_rejects_parent_paths() -> Result<()> {
        let temp = tempdir()?;
        let source_root = temp.path().join("source");
        let destination_root = temp.path().join("destination");

        fs::create_dir_all(source_root.join(".codex-linux"))?;
        fs::write(source_root.join(UPDATE_BUILDER_MANIFEST), b"../escape\n")?;

        let error = copy_builder_bundle(&source_root, &destination_root)
            .expect_err("manifest parent path should be rejected");
        assert!(error
            .to_string()
            .contains("Unsafe update-builder manifest entry"));
        Ok(())
    }

    #[test]
    fn bundle_manifest_rejects_absolute_paths() -> Result<()> {
        let temp = tempdir()?;
        let source_root = temp.path().join("source");
        let destination_root = temp.path().join("destination");

        fs::create_dir_all(source_root.join(".codex-linux"))?;
        fs::write(source_root.join(UPDATE_BUILDER_MANIFEST), b"/tmp/escape\n")?;

        let error = copy_builder_bundle(&source_root, &destination_root)
            .expect_err("manifest absolute path should be rejected");
        assert!(error
            .to_string()
            .contains("Unsafe update-builder manifest entry"));
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
                fs::write(dir.join(binary), b"bin")?;
            }
        }

        let directories = collect_nvm_bin_dirs(&nvm_root);
        assert_eq!(directories.first(), Some(&current_bin));
        assert!(directories.contains(&version_bin));
        Ok(())
    }

    #[test]
    fn build_command_path_includes_system_dirs() {
        let path = build_command_path(Path::new("/tmp/missing-codex-builder"));
        let directories = std::env::split_paths(&path).collect::<Vec<_>>();

        assert!(directories.iter().any(|dir| dir == Path::new("/usr/bin")));
        assert!(directories.iter().any(|dir| dir == Path::new("/bin")));
    }

    #[test]
    fn build_command_path_prefers_packaged_managed_node_runtime() -> Result<()> {
        let temp = tempdir()?;
        let runtime_bin = temp.path().join("node-runtime/bin");
        fs::create_dir_all(&runtime_bin)?;
        for binary in ["node", "npm", "npx"] {
            fs::write(runtime_bin.join(binary), b"bin")?;
        }

        let path = build_command_path(temp.path());
        let directories = std::env::split_paths(&path).collect::<Vec<_>>();
        assert_eq!(directories.first(), Some(&runtime_bin));
        Ok(())
    }

    #[test]
    fn build_command_path_includes_cargo_bin_from_home() -> Result<()> {
        let _env_guard = crate::test_util::env_lock();
        let temp = tempdir()?;
        let home_dir = temp.path().join("home");
        let cargo_bin = home_dir.join(".cargo/bin");
        fs::create_dir_all(&cargo_bin)?;
        fs::write(cargo_bin.join("cargo"), b"bin")?;

        let original_home = std::env::var_os("HOME");
        std::env::set_var("HOME", &home_dir);

        let path = build_command_path(Path::new("/tmp/missing-codex-builder"));

        if let Some(home) = original_home {
            std::env::set_var("HOME", home);
        } else {
            std::env::remove_var("HOME");
        }

        let directories = std::env::split_paths(&path).collect::<Vec<_>>();
        assert!(directories.iter().any(|dir| dir == &cargo_bin));
        Ok(())
    }
}
