//! Cleanup helpers for updater-managed build workspaces and opt-in generated
//! wrapper checkout artifacts.

use crate::config::GeneratedArtifactCleanupConfig;
use crate::state::{PersistedState, UpdateStatus};
use anyhow::{bail, Context, Result};
use std::{
    collections::BTreeSet,
    ffi::CString,
    fs, mem,
    os::unix::ffi::OsStrExt,
    path::{Component, Path, PathBuf},
};

const HEAVY_WORKSPACE_DIRS: &[&str] = &["builder", "chatgpt-app", "dist"];

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct CleanupSummary {
    pub pruned_workspaces: usize,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct GeneratedArtifactCleanupSummary {
    pub inspected_roots: usize,
    pub skipped_roots: usize,
    pub pruned_paths: usize,
    pub bytes_removed: u64,
}

pub fn prune_unreferenced_workspaces(
    workspace_root: &Path,
    state: &PersistedState,
) -> Result<CleanupSummary> {
    let workspaces_root = workspace_root.join("workspaces");
    if !workspaces_root.is_dir() {
        return Ok(CleanupSummary::default());
    }

    let protected = protected_workspaces(workspace_root, state);
    let mut summary = CleanupSummary::default();

    for entry in fs::read_dir(&workspaces_root)
        .with_context(|| format!("Failed to read {}", workspaces_root.display()))?
    {
        let entry = entry?;
        let workspace_dir = entry.path();
        if !entry.file_type()?.is_dir() || protected.contains(&workspace_dir) {
            continue;
        }

        let mut pruned = false;
        for heavy_dir in HEAVY_WORKSPACE_DIRS {
            let target = workspace_dir.join(heavy_dir);
            if target.exists() {
                fs::remove_dir_all(&target)
                    .with_context(|| format!("Failed to remove {}", target.display()))?;
                pruned = true;
            }
        }

        if directory_is_empty(&workspace_dir)? {
            fs::remove_dir(&workspace_dir)
                .with_context(|| format!("Failed to remove {}", workspace_dir.display()))?;
            pruned = true;
        }

        if pruned {
            summary.pruned_workspaces += 1;
        }
    }

    Ok(summary)
}

pub fn prune_generated_artifacts(
    cleanup: &GeneratedArtifactCleanupConfig,
    default_root: &Path,
) -> Result<GeneratedArtifactCleanupSummary> {
    if !cleanup.enabled {
        return Ok(GeneratedArtifactCleanupSummary::default());
    }

    let entries = cleanup_entries(cleanup)?;
    let mut summary = GeneratedArtifactCleanupSummary::default();
    for root in cleanup_roots(cleanup, default_root) {
        if !root.is_dir() {
            summary.skipped_roots += 1;
            continue;
        }
        if !looks_like_wrapper_root(&root) {
            summary.skipped_roots += 1;
            continue;
        }

        summary.inspected_roots += 1;
        let available_bytes = available_disk_bytes(&root)
            .with_context(|| format!("Failed to read free space for {}", root.display()))?;
        if cleanup.min_free_bytes > 0 && available_bytes >= cleanup.min_free_bytes {
            summary.skipped_roots += 1;
            continue;
        }

        for entry in &entries {
            let target = root.join(entry);
            if !target.exists() && fs::symlink_metadata(&target).is_err() {
                continue;
            }

            let bytes = path_size(&target).unwrap_or(0);
            remove_path(&target)
                .with_context(|| format!("Failed to remove {}", target.display()))?;
            summary.pruned_paths += 1;
            summary.bytes_removed = summary.bytes_removed.saturating_add(bytes);
        }
    }

    Ok(summary)
}

pub fn derive_workspace_dir(
    workspace_root: &Path,
    artifact_path: Option<&Path>,
) -> Option<PathBuf> {
    let artifact_path = artifact_path?;
    let workspaces_root = workspace_root.join("workspaces");
    if let Ok(relative) = artifact_path.strip_prefix(&workspaces_root) {
        if let Some(component) = relative.components().next() {
            return Some(workspaces_root.join(component.as_os_str()));
        }
    }

    derive_workspace_dir_from_any_workspaces_ancestor(artifact_path)
}

pub fn normalize_artifact_workspace_dir(workspace_root: &Path, state: &mut PersistedState) {
    state.artifact_paths.workspace_dir = state
        .artifact_paths
        .package_path
        .as_deref()
        .and_then(|path| derive_workspace_dir(workspace_root, Some(path)))
        .or_else(|| {
            state
                .artifact_paths
                .rollback_package_path
                .as_deref()
                .and_then(|path| derive_workspace_dir(workspace_root, Some(path)))
        })
        .or_else(|| {
            should_protect_explicit_workspace_dir(&state.status)
                .then(|| state.artifact_paths.workspace_dir.clone())
                .flatten()
        });
}

fn protected_workspaces(workspace_root: &Path, state: &PersistedState) -> BTreeSet<PathBuf> {
    let mut protected = BTreeSet::new();

    for artifact_path in [
        state.artifact_paths.package_path.as_deref(),
        state.artifact_paths.rollback_package_path.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        if let Some(workspace_dir) = derive_workspace_dir(workspace_root, Some(artifact_path)) {
            protected.insert(workspace_dir);
        }
    }

    if should_protect_explicit_workspace_dir(&state.status) {
        if let Some(workspace_dir) = state.artifact_paths.workspace_dir.clone() {
            protected.insert(workspace_dir);
        }
    }

    protected
}

fn should_protect_explicit_workspace_dir(status: &UpdateStatus) -> bool {
    matches!(
        status,
        UpdateStatus::PreparingWorkspace
            | UpdateStatus::PatchingApp
            | UpdateStatus::BuildingPackage
            | UpdateStatus::Failed
    )
}

fn derive_workspace_dir_from_any_workspaces_ancestor(path: &Path) -> Option<PathBuf> {
    let mut child = path.to_path_buf();
    for ancestor in path.ancestors() {
        if ancestor
            .file_name()
            .is_some_and(|name| name == "workspaces")
        {
            return Some(child);
        }
        child = ancestor.to_path_buf();
    }
    None
}

fn directory_is_empty(path: &Path) -> Result<bool> {
    Ok(fs::read_dir(path)
        .with_context(|| format!("Failed to read {}", path.display()))?
        .next()
        .is_none())
}

fn cleanup_roots(
    cleanup: &GeneratedArtifactCleanupConfig,
    default_root: &Path,
) -> BTreeSet<PathBuf> {
    if cleanup.roots.is_empty() {
        BTreeSet::from([default_root.to_path_buf()])
    } else {
        cleanup.roots.iter().cloned().collect()
    }
}

fn cleanup_entries(cleanup: &GeneratedArtifactCleanupConfig) -> Result<Vec<PathBuf>> {
    let mut entries = Vec::new();
    for entry in &cleanup.entries {
        if entry.as_os_str().is_empty() || entry.is_absolute() {
            bail!("generated artifact cleanup entries must be relative top-level names");
        }
        let mut components = entry.components();
        if !matches!(components.next(), Some(Component::Normal(_))) || components.next().is_some() {
            bail!("generated artifact cleanup entries must be relative top-level names");
        }
        entries.push(entry.clone());
    }
    Ok(entries)
}

fn looks_like_wrapper_root(root: &Path) -> bool {
    root.join("install.sh").is_file()
        && root.join("scripts/build-deb.sh").is_file()
        && root.join("scripts/build-pacman.sh").is_file()
}

fn available_disk_bytes(path: &Path) -> Result<u64> {
    let c_path = CString::new(path.as_os_str().as_bytes())
        .with_context(|| format!("Path contains interior NUL: {}", path.display()))?;
    let mut stat: libc::statvfs = unsafe { mem::zeroed() };
    let result = unsafe { libc::statvfs(c_path.as_ptr(), &mut stat) };
    if result != 0 {
        return Err(std::io::Error::last_os_error())
            .with_context(|| format!("statvfs failed for {}", path.display()));
    }

    Ok((stat.f_bavail as u64).saturating_mul(stat.f_frsize as u64))
}

fn path_size(path: &Path) -> Result<u64> {
    let metadata =
        fs::symlink_metadata(path).with_context(|| format!("Failed to stat {}", path.display()))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Ok(metadata.len());
    }

    let mut total = metadata.len();
    for entry in fs::read_dir(path).with_context(|| format!("Failed to read {}", path.display()))? {
        let entry = entry?;
        total = total.saturating_add(path_size(&entry.path())?);
    }
    Ok(total)
}

fn remove_path(path: &Path) -> Result<()> {
    let metadata =
        fs::symlink_metadata(path).with_context(|| format!("Failed to stat {}", path.display()))?;
    if metadata.is_dir() && !metadata.file_type().is_symlink() {
        fs::remove_dir_all(path).with_context(|| format!("Failed to remove {}", path.display()))
    } else {
        fs::remove_file(path).with_context(|| format!("Failed to remove {}", path.display()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::GeneratedArtifactCleanupConfig;
    use crate::state::{ArtifactPaths, PersistedState, UpdateStatus};
    use anyhow::Result;
    use std::{fs, path::PathBuf};

    fn create_workspace(root: &std::path::Path, name: &str) -> Result<PathBuf> {
        let workspace = root.join("workspaces").join(name);
        fs::create_dir_all(workspace.join("builder"))?;
        fs::create_dir_all(workspace.join("chatgpt-app"))?;
        fs::create_dir_all(workspace.join("dist"))?;
        fs::create_dir_all(workspace.join("logs"))?;
        fs::create_dir_all(workspace.join("reports"))?;
        fs::write(workspace.join("builder/build.txt"), b"builder")?;
        fs::write(workspace.join("chatgpt-app/app.txt"), b"app")?;
        fs::write(workspace.join("dist/pkg.deb"), b"pkg")?;
        fs::write(workspace.join("logs/install.log"), b"log")?;
        fs::write(workspace.join("reports/rebuild-report.json"), b"{}")?;
        fs::write(workspace.join("metadata.json"), b"{}")?;
        Ok(workspace)
    }

    fn create_wrapper_root(root: &std::path::Path) -> Result<()> {
        fs::create_dir_all(root.join("scripts"))?;
        fs::write(root.join("install.sh"), b"#!/bin/bash\n")?;
        fs::write(root.join("scripts/build-deb.sh"), b"#!/bin/bash\n")?;
        fs::write(root.join("scripts/build-pacman.sh"), b"#!/bin/bash\n")?;
        Ok(())
    }

    #[test]
    fn generated_artifact_cleanup_is_disabled_by_default() -> Result<()> {
        let temp = tempfile::tempdir()?;
        create_wrapper_root(temp.path())?;
        fs::create_dir_all(temp.path().join("dist"))?;
        fs::write(temp.path().join("dist/pkg.deb"), b"pkg")?;

        let summary =
            prune_generated_artifacts(&GeneratedArtifactCleanupConfig::default(), temp.path())?;

        assert_eq!(summary.pruned_paths, 0);
        assert!(temp.path().join("dist/pkg.deb").exists());
        Ok(())
    }

    #[test]
    fn generated_artifact_cleanup_removes_known_artifacts_below_threshold() -> Result<()> {
        let temp = tempfile::tempdir()?;
        create_wrapper_root(temp.path())?;
        fs::create_dir_all(temp.path().join("dist"))?;
        fs::create_dir_all(temp.path().join("target"))?;
        fs::create_dir_all(temp.path().join("chatgpt-app"))?;
        fs::write(temp.path().join("dist/pkg.deb"), b"pkg")?;
        fs::write(temp.path().join("target/build.txt"), b"target")?;
        fs::write(temp.path().join("chatgpt-app/app.txt"), b"app")?;
        fs::write(temp.path().join("ChatGPT.dmg"), b"dmg")?;

        let cleanup = GeneratedArtifactCleanupConfig {
            enabled: true,
            min_free_bytes: u64::MAX,
            roots: Vec::new(),
            entries: GeneratedArtifactCleanupConfig::default().entries,
        };
        let summary = prune_generated_artifacts(&cleanup, temp.path())?;

        assert_eq!(summary.inspected_roots, 1);
        assert_eq!(summary.pruned_paths, 3);
        assert!(summary.bytes_removed > 0);
        assert!(!temp.path().join("dist").exists());
        assert!(!temp.path().join("target").exists());
        assert!(!temp.path().join("chatgpt-app").exists());
        assert!(temp.path().join("ChatGPT.dmg").exists());
        Ok(())
    }

    #[test]
    fn generated_artifact_cleanup_skips_when_free_space_is_sufficient() -> Result<()> {
        let temp = tempfile::tempdir()?;
        create_wrapper_root(temp.path())?;
        fs::create_dir_all(temp.path().join("dist"))?;
        fs::write(temp.path().join("dist/pkg.deb"), b"pkg")?;

        let cleanup = GeneratedArtifactCleanupConfig {
            enabled: true,
            min_free_bytes: 1,
            roots: Vec::new(),
            entries: GeneratedArtifactCleanupConfig::default().entries,
        };
        let summary = prune_generated_artifacts(&cleanup, temp.path())?;

        assert_eq!(summary.pruned_paths, 0);
        assert!(temp.path().join("dist/pkg.deb").exists());
        Ok(())
    }

    #[test]
    fn generated_artifact_cleanup_skips_non_wrapper_roots() -> Result<()> {
        let temp = tempfile::tempdir()?;
        fs::create_dir_all(temp.path().join("dist"))?;
        fs::write(temp.path().join("dist/pkg.deb"), b"pkg")?;

        let cleanup = GeneratedArtifactCleanupConfig {
            enabled: true,
            min_free_bytes: u64::MAX,
            roots: Vec::new(),
            entries: GeneratedArtifactCleanupConfig::default().entries,
        };
        let summary = prune_generated_artifacts(&cleanup, temp.path())?;

        assert_eq!(summary.pruned_paths, 0);
        assert_eq!(summary.skipped_roots, 1);
        assert!(temp.path().join("dist/pkg.deb").exists());
        Ok(())
    }

    #[test]
    fn generated_artifact_cleanup_rejects_unsafe_entries() -> Result<()> {
        let temp = tempfile::tempdir()?;
        create_wrapper_root(temp.path())?;
        for entry in [
            PathBuf::from("../outside"),
            PathBuf::from("dist/pkg.deb"),
            PathBuf::from("/tmp/dist"),
        ] {
            let cleanup = GeneratedArtifactCleanupConfig {
                enabled: true,
                min_free_bytes: u64::MAX,
                roots: Vec::new(),
                entries: vec![entry],
            };

            let error = prune_generated_artifacts(&cleanup, temp.path()).unwrap_err();

            assert!(error.to_string().contains("top-level names"));
        }
        Ok(())
    }

    #[test]
    fn generated_artifact_cleanup_can_remove_configured_files() -> Result<()> {
        let temp = tempfile::tempdir()?;
        create_wrapper_root(temp.path())?;
        fs::write(temp.path().join("ChatGPT.dmg"), b"dmg")?;

        let cleanup = GeneratedArtifactCleanupConfig {
            enabled: true,
            min_free_bytes: u64::MAX,
            roots: Vec::new(),
            entries: vec![PathBuf::from("ChatGPT.dmg")],
        };
        let summary = prune_generated_artifacts(&cleanup, temp.path())?;

        assert_eq!(summary.pruned_paths, 1);
        assert!(!temp.path().join("ChatGPT.dmg").exists());
        Ok(())
    }

    #[test]
    fn referenced_package_workspace_is_not_pruned() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let workspace = create_workspace(temp.path(), "2026.05.19.131017+6d440c71")?;
        let package_path = workspace.join("dist/pkg.deb");

        let mut state = PersistedState::new(true);
        state.artifact_paths.package_path = Some(package_path);

        let summary = prune_unreferenced_workspaces(temp.path(), &state)?;

        assert_eq!(summary.pruned_workspaces, 0);
        assert!(workspace.join("builder").exists());
        assert!(workspace.join("chatgpt-app").exists());
        assert!(workspace.join("dist").exists());
        Ok(())
    }

    #[test]
    fn rollback_workspace_is_not_pruned() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let workspace = create_workspace(temp.path(), "2026.05.18.010207+6d440c71")?;
        let rollback_path = workspace.join("dist/pkg.deb");

        let mut state = PersistedState::new(true);
        state.artifact_paths.rollback_package_path = Some(rollback_path);

        let summary = prune_unreferenced_workspaces(temp.path(), &state)?;

        assert_eq!(summary.pruned_workspaces, 0);
        assert!(workspace.join("builder").exists());
        assert!(workspace.join("chatgpt-app").exists());
        assert!(workspace.join("dist").exists());
        Ok(())
    }

    #[test]
    fn unreferenced_workspace_prunes_heavy_artifacts_and_keeps_debug_files() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let workspace = create_workspace(temp.path(), "2026.05.17.120457+6d440c71")?;
        let state = PersistedState::new(true);

        let summary = prune_unreferenced_workspaces(temp.path(), &state)?;

        assert_eq!(summary.pruned_workspaces, 1);
        assert!(!workspace.join("builder").exists());
        assert!(!workspace.join("chatgpt-app").exists());
        assert!(!workspace.join("dist").exists());
        assert!(workspace.join("logs/install.log").exists());
        assert!(workspace.join("reports/rebuild-report.json").exists());
        assert!(workspace.join("metadata.json").exists());
        Ok(())
    }

    #[test]
    fn empty_workspace_is_removed_after_prune() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let workspace_root = temp.path().join("workspaces");
        let workspace = workspace_root.join("2026.05.16.231927+6d440c71");
        fs::create_dir_all(workspace.join("builder"))?;
        fs::write(workspace.join("builder/build.txt"), b"builder")?;

        let state = PersistedState::new(true);
        let summary = prune_unreferenced_workspaces(temp.path(), &state)?;

        assert_eq!(summary.pruned_workspaces, 1);
        assert!(!workspace.exists());
        Ok(())
    }

    #[test]
    fn active_workspace_dir_is_protected_only_while_build_or_failed() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let workspace = create_workspace(temp.path(), "2026.05.15.233058+5937a9b4")?;
        let mut state = PersistedState::new(true);
        state.status = UpdateStatus::PatchingApp;
        state.artifact_paths.workspace_dir = Some(workspace.clone());

        let summary = prune_unreferenced_workspaces(temp.path(), &state)?;
        assert_eq!(summary.pruned_workspaces, 0);
        assert!(workspace.join("builder").exists());

        state.status = UpdateStatus::Installed;
        let summary = prune_unreferenced_workspaces(temp.path(), &state)?;
        assert_eq!(summary.pruned_workspaces, 1);
        assert!(!workspace.join("builder").exists());
        Ok(())
    }

    #[test]
    fn workspace_dir_is_derived_from_retained_package_path() {
        let workspace_root = PathBuf::from("/cache");
        let package_path =
            workspace_root.join("workspaces/2026.05.04.033705+b0c9ccab/dist/codex.deb");

        let derived = derive_workspace_dir(&workspace_root, Some(package_path.as_path()));

        assert_eq!(
            derived,
            Some(workspace_root.join("workspaces/2026.05.04.033705+b0c9ccab"))
        );
    }

    #[test]
    fn workspace_dir_is_not_derived_for_paths_outside_workspace_root() {
        let workspace_root = PathBuf::from("/cache");
        let package_path = PathBuf::from("/tmp/codex.deb");

        let derived = derive_workspace_dir(&workspace_root, Some(package_path.as_path()));

        assert_eq!(derived, None);
    }

    #[test]
    fn normalize_state_clears_stale_workspace_dir_for_superseded_candidate() {
        let workspace_root = PathBuf::from("/cache");
        let mut state = PersistedState::new(true);
        state.status = UpdateStatus::Installed;
        state.artifact_paths = ArtifactPaths {
            dmg_path: None,
            workspace_dir: Some(workspace_root.join("workspaces/2026.04.28.082247+abcdef12")),
            package_path: None,
            rollback_package_path: None,
        };

        normalize_artifact_workspace_dir(&workspace_root, &mut state);

        assert_eq!(state.artifact_paths.workspace_dir, None);
    }

    #[test]
    fn normalize_state_points_workspace_dir_at_rollback_package_when_available() {
        let workspace_root = PathBuf::from("/cache");
        let rollback_path = workspace_root.join(
            "workspaces/2026.05.01.010203+99999999/dist/chatgpt-desktop-2026.05.01.010203-1-x86_64.pkg.tar.zst",
        );
        let mut state = PersistedState::new(true);
        state.status = UpdateStatus::Installed;
        state.artifact_paths = ArtifactPaths {
            dmg_path: None,
            workspace_dir: None,
            package_path: Some(rollback_path.clone()),
            rollback_package_path: Some(rollback_path),
        };

        normalize_artifact_workspace_dir(&workspace_root, &mut state);

        assert_eq!(
            state.artifact_paths.workspace_dir,
            Some(workspace_root.join("workspaces/2026.05.01.010203+99999999"))
        );
    }
}
