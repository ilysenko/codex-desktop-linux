//! Rebuild the custom native package from a verified official `.deb`.

use crate::{
    config::{effective_feature_config_path, RuntimeConfig, RuntimePaths},
    install::PackageKind,
    state::{ArtifactPaths, PersistedState, UpdateStatus},
};
use anyhow::{Context, Result};
use chrono::Utc;
use std::{fs, path::{Path, PathBuf}};
use tokio::{fs as async_fs, io::{AsyncBufReadExt, BufReader}, process::Command};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BuildArtifacts {
    pub workspace_dir: PathBuf,
    pub package_path: PathBuf,
}

const REQUIRED_BUNDLE_ENTRIES: &[&str] = &[
    "install.sh",
    "launcher",
    "scripts/build-deb.sh",
    "scripts/build-rpm.sh",
    "scripts/build-pacman.sh",
    "scripts/patch-linux-window-ui.js",
    "scripts/lib",
    "scripts/patches",
    "packaging/linux",
    "assets",
    "linux-features",
];

const OPTIONAL_BUNDLE_ENTRIES: &[&str] = &[
    "target",
    "global-dictation-linux",
    "plugins",
];

pub async fn build_update(
    config: &RuntimeConfig,
    state: &mut PersistedState,
    paths: &RuntimePaths,
    candidate_version: &str,
    upstream_package: &Path,
) -> Result<BuildArtifacts> {
    let workspace = config.workspace_root.join("workspaces").join(safe_component(candidate_version));
    if workspace.exists() {
        fs::remove_dir_all(&workspace)?;
    }
    let bundle = workspace.join("builder");
    let app = workspace.join("codex-app");
    let dist = workspace.join("dist");
    let logs = workspace.join("logs");
    fs::create_dir_all(&logs)?;

    state.status = UpdateStatus::PreparingWorkspace;
    state.artifact_paths.workspace_dir = Some(workspace.clone());
    state.save_updater(&paths.state_file)?;
    copy_builder_bundle(&config.builder_bundle_root, &bundle)?;

    state.status = UpdateStatus::PatchingApp;
    state.save_updater(&paths.state_file)?;
    let mut install = Command::new(bundle.join("install.sh"));
    install
        .arg(upstream_package)
        .env("CODEX_INSTALL_TRANSACTION_ACTIVE", "1")
        .env("CODEX_INSTALL_DIR", &app)
        .env("CODEX_PATCH_REPORT_JSON", workspace.join("reports/patch-report.json"))
        .current_dir(&bundle);
    if let Some(config_path) = effective_feature_config_path(config) {
        install.env("CODEX_LINUX_FEATURES_CONFIG", config_path);
    }
    run_logged(&mut install, &logs.join("install.log")).await?;

    state.status = UpdateStatus::BuildingPackage;
    state.save_updater(&paths.state_file)?;
    let script = match PackageKind::detect() {
        PackageKind::Deb => "scripts/build-deb.sh",
        PackageKind::Rpm => "scripts/build-rpm.sh",
        PackageKind::Pacman => "scripts/build-pacman.sh",
    };
    let mut package = Command::new(bundle.join(script));
    package
        .env("PACKAGE_VERSION", package_version())
        .env("APP_DIR_OVERRIDE", &app)
        .env("DIST_DIR_OVERRIDE", &dist)
        .env("UPDATER_BINARY_SOURCE", std::env::current_exe()?)
        .env("UPDATER_SERVICE_SOURCE", bundle.join("packaging/linux/codex-update-manager.service"))
        .current_dir(&bundle);
    if let Some(config_path) = effective_feature_config_path(config) {
        package.env("CODEX_LINUX_FEATURES_CONFIG", config_path);
    }
    run_logged(&mut package, &logs.join("package.log")).await?;

    let package_path = find_package(&dist)?;
    state.status = UpdateStatus::ReadyToInstall;
    state.artifact_paths = ArtifactPaths {
        upstream_package_path: Some(upstream_package.to_path_buf()),
        workspace_dir: Some(workspace.clone()),
        package_path: Some(package_path.clone()),
        rollback_package_path: state.artifact_paths.rollback_package_path.clone(),
    };
    state.save_updater(&paths.state_file)?;
    Ok(BuildArtifacts { workspace_dir: workspace, package_path })
}

fn package_version() -> String {
    Utc::now().format("%Y.%m.%d.%H%M%S").to_string()
}

fn safe_component(value: &str) -> String {
    value.chars().map(|c| if c.is_ascii_alphanumeric() || ".+-_".contains(c) { c } else { '_' }).collect()
}

fn copy_builder_bundle(source: &Path, destination: &Path) -> Result<()> {
    fs::create_dir_all(destination)?;
    for relative in REQUIRED_BUNDLE_ENTRIES {
        let from = source.join(relative);
        anyhow::ensure!(from.exists(), "update-builder is missing {relative}");
        copy_path(&from, &destination.join(relative))?;
    }
    for relative in OPTIONAL_BUNDLE_ENTRIES {
        let from = source.join(relative);
        if from.exists() {
            copy_path(&from, &destination.join(relative))?;
        }
    }
    Ok(())
}

fn copy_path(source: &Path, destination: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(source)?;
    anyhow::ensure!(!metadata.file_type().is_symlink(), "update-builder entry cannot be a symlink: {}", source.display());
    if metadata.is_dir() {
        fs::create_dir_all(destination)?;
        for entry in fs::read_dir(source)? {
            let entry = entry?;
            copy_path(&entry.path(), &destination.join(entry.file_name()))?;
        }
    } else {
        if let Some(parent) = destination.parent() { fs::create_dir_all(parent)?; }
        fs::copy(source, destination)?;
        fs::set_permissions(destination, metadata.permissions())?;
    }
    Ok(())
}

async fn run_logged(command: &mut Command, log_path: &Path) -> Result<()> {
    if let Some(parent) = log_path.parent() { async_fs::create_dir_all(parent).await?; }
    command.stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
    let mut child = command.spawn().context("Failed to start update build command")?;
    let stdout = child.stdout.take().context("missing stdout")?;
    let stderr = child.stderr.take().context("missing stderr")?;
    let (out, err) = tokio::join!(read_stream(stdout), read_stream(stderr));
    let mut text = out?;
    text.push_str(&err?);
    async_fs::write(log_path, &text).await?;
    let status = child.wait().await?;
    anyhow::ensure!(status.success(), "update build command failed; see {}", log_path.display());
    Ok(())
}

async fn read_stream<R: tokio::io::AsyncRead + Unpin>(stream: R) -> Result<String> {
    let mut reader = BufReader::new(stream);
    let mut value = String::new();
    while reader.read_line(&mut value).await? != 0 {}
    Ok(value)
}

fn find_package(dist: &Path) -> Result<PathBuf> {
    let mut matches = Vec::new();
    for entry in fs::read_dir(dist).with_context(|| format!("Failed to read {}", dist.display()))? {
        let entry = entry?;
        // Package builders may also emit a `latest` symlink. Count only the
        // actual package files, without following aliases or accepting directories.
        if !entry.file_type()?.is_file() {
            continue;
        }
        let path = entry.path();
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if name.ends_with(".deb")
            || name.ends_with(".rpm")
            || crate::install::is_pacman_package_file_name(name)
        {
            matches.push(path);
        }
    }
    anyhow::ensure!(matches.len() == 1, "expected one rebuilt package, found {}", matches.len());
    Ok(matches.remove(0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;
    use tempfile::tempdir;

    #[test]
    fn find_package_accepts_each_supported_native_format() -> Result<()> {
        for suffix in [
            ".deb",
            ".rpm",
            ".pkg.tar.zst",
            ".pkg.tar.xz",
            ".pkg.tar.gz",
            ".pkg.tar.bz2",
            ".pkg.tar.lz",
            ".pkg.tar.lz4",
            ".pkg.tar.lz5",
        ] {
            let dist = tempdir()?;
            let package = dist.path().join(format!("codex-desktop-1{suffix}"));
            fs::write(&package, b"package fixture")?;
            assert_eq!(find_package(dist.path())?, package);
        }
        Ok(())
    }

    #[test]
    fn find_package_ignores_package_named_directories() -> Result<()> {
        let dist = tempdir()?;
        let package = dist.path().join("codex-desktop-1.deb");
        fs::write(&package, b"package fixture")?;
        for name in ["staging.deb", "staging.rpm", "staging.pkg.tar.zst"] {
            fs::create_dir(dist.path().join(name))?;
        }
        assert_eq!(find_package(dist.path())?, package);
        Ok(())
    }

    #[test]
    fn find_package_ignores_sidecars_and_unrelated_files() -> Result<()> {
        let dist = tempdir()?;
        let package = dist.path().join("codex-desktop-1.pkg.tar.zst");
        fs::write(&package, b"package fixture")?;
        for name in [
            "codex-desktop-1.pkg.tar.zst.sig",
            "codex-desktop-1.pkg.tar.zst.sha256",
            "codex-desktop-1.pkg.tar.zst.part",
            "report.pkg.tar.json",
            "codex-desktop-1.deb.sig",
            "codex-desktop-1.rpm.sig",
            "build.log",
        ] {
            fs::write(dist.path().join(name), b"not a package")?;
        }
        assert_eq!(find_package(dist.path())?, package);
        Ok(())
    }

    #[test]
    fn find_package_rejects_missing_or_symlink_only_packages() -> Result<()> {
        let root = tempdir()?;
        let dist = root.path().join("dist");
        fs::create_dir(&dist)?;
        assert_eq!(
            find_package(&dist).unwrap_err().to_string(),
            "expected one rebuilt package, found 0"
        );

        let outside = root.path().join("outside.pkg.tar.zst");
        fs::write(&outside, b"outside fixture")?;
        symlink(&outside, dist.join("codex-desktop-latest.pkg.tar.zst"))?;
        assert_eq!(
            find_package(&dist).unwrap_err().to_string(),
            "expected one rebuilt package, found 0"
        );
        Ok(())
    }

    #[test]
    fn workspace_component_never_contains_separators() {
        assert_eq!(safe_component("26.1/../../x"), "26.1_.._.._x");
    }

    fn scratch_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "codex-find-package-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos(),
        ));
        fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    #[test]
    #[cfg(unix)]
    fn find_package_ignores_latest_alias_symlink() {
        // build-pacman.sh writes codex-desktop-latest.pkg.tar.zst as a symlink
        // next to the real artifact; it must not count as a second package.
        let dist = scratch_dir("latest-alias");
        let real = dist.join("codex-desktop-2026.09.03.120000-1-x86_64.pkg.tar.zst");
        fs::write(&real, b"package").expect("real package");
        std::os::unix::fs::symlink(
            real.file_name().expect("file name"),
            dist.join("codex-desktop-latest.pkg.tar.zst"),
        )
        .expect("latest symlink");

        let found = find_package(&dist).expect("exactly one real package");
        assert_eq!(found, real);

        fs::remove_dir_all(&dist).expect("cleanup");
    }

    #[test]
    fn find_package_still_rejects_two_real_packages() {
        let dist = scratch_dir("two-real");
        fs::write(dist.join("codex-desktop-2026.09.03.120000-1-x86_64.pkg.tar.zst"), b"a")
            .expect("first package");
        fs::write(dist.join("codex-desktop-2026.09.03.130000-1-x86_64.pkg.tar.zst"), b"b")
            .expect("second package");

        let error = find_package(&dist).expect_err("ambiguous dist must fail");
        assert!(error.to_string().contains("found 2"), "unexpected error: {error}");

        fs::remove_dir_all(&dist).expect("cleanup");
    }

    #[test]
    fn builder_bundle_copies_optional_prebuilt_artifacts_without_requiring_them() {
        let root = std::env::temp_dir().join(format!(
            "codex-builder-bundle-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos(),
        ));
        let source = root.join("source");
        let empty_destination = root.join("empty");
        for relative in REQUIRED_BUNDLE_ENTRIES {
            let path = source.join(relative);
            if relative.contains('.') || relative.ends_with(".sh") || relative.ends_with(".js") {
                fs::create_dir_all(path.parent().expect("required entry parent")).expect("parent");
                fs::write(path, "fixture").expect("required file");
            } else {
                fs::create_dir_all(path).expect("required directory");
            }
        }
        copy_builder_bundle(&source, &empty_destination).expect("feature-free bundle copy");
        assert!(!empty_destination.join("target").exists());
        assert!(!empty_destination.join("global-dictation-linux").exists());

        let helper = source.join("target/release/helper");
        fs::create_dir_all(helper.parent().expect("helper parent")).expect("helper directory");
        fs::write(&helper, "binary").expect("helper");
        let enabled_destination = root.join("enabled");
        copy_builder_bundle(&source, &enabled_destination).expect("feature bundle copy");
        assert_eq!(fs::read_to_string(enabled_destination.join("target/release/helper")).expect("copied helper"), "binary");
        fs::remove_dir_all(root).expect("cleanup");
    }
}
