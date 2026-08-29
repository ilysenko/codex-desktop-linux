//! Conservative cache cleanup for content-addressed official packages.

use crate::state::PersistedState;
use anyhow::Result;
use std::{collections::BTreeSet, fs, path::Path};

pub fn prune(cache_root: &Path, state: &PersistedState) -> Result<usize> {
    let mut retained = BTreeSet::new();
    for path in [
        state.artifact_paths.upstream_package_path.as_ref(),
        state.artifact_paths.package_path.as_ref(),
        state.artifact_paths.rollback_package_path.as_ref(),
    ]
    .into_iter()
    .flatten()
    {
        if let Ok(path) = path.canonicalize() {
            retained.insert(path);
        }
    }
    let mut removed = 0;
    let package_dir = cache_root.join("packages");
    if !package_dir.is_dir() {
        return Ok(0);
    }
    for entry in fs::read_dir(package_dir)? {
        let path = entry?.path();
        if path.is_file()
            && path.extension().and_then(|v| v.to_str()) == Some("deb")
            && !retained.contains(&path.canonicalize()?)
        {
            fs::remove_file(path)?;
            removed += 1;
        }
    }

    let workspace_dir = cache_root.join("workspaces");
    if !workspace_dir.is_dir() {
        return Ok(removed);
    }
    let retained_workspace = state
        .artifact_paths
        .workspace_dir
        .as_ref()
        .and_then(|path| path.canonicalize().ok());
    for entry in fs::read_dir(workspace_dir)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let path = entry.path();
        let canonical = path.canonicalize()?;
        let contains_retained_artifact = retained
            .iter()
            .any(|artifact| artifact.starts_with(&canonical));
        if retained_workspace.as_ref() == Some(&canonical) || contains_retained_artifact {
            continue;
        }
        fs::remove_dir_all(path)?;
        removed += 1;
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::PersistedState;

    #[test]
    fn prune_removes_only_unreferenced_packages_and_workspaces() -> Result<()> {
        let cache = tempfile::tempdir()?;
        let packages = cache.path().join("packages");
        let workspaces = cache.path().join("workspaces");
        fs::create_dir_all(&packages)?;
        fs::create_dir_all(&workspaces)?;

        let current_deb = packages.join("current.deb");
        let stale_deb = packages.join("stale.deb");
        fs::write(&current_deb, "current")?;
        fs::write(&stale_deb, "stale")?;

        let current_workspace = workspaces.join("current");
        let rollback_workspace = workspaces.join("rollback");
        let stale_workspace = workspaces.join("stale");
        fs::create_dir_all(current_workspace.join("dist"))?;
        fs::create_dir_all(rollback_workspace.join("dist"))?;
        fs::create_dir_all(&stale_workspace)?;
        let current_package = current_workspace.join("dist/current.pkg.tar.zst");
        let rollback_package = rollback_workspace.join("dist/rollback.pkg.tar.zst");
        fs::write(&current_package, "current")?;
        fs::write(&rollback_package, "rollback")?;
        fs::write(stale_workspace.join("build.log"), "stale")?;

        #[cfg(unix)]
        {
            let external = tempfile::tempdir()?;
            std::os::unix::fs::symlink(external.path(), workspaces.join("external-link"))?;

            let mut state = PersistedState::default();
            state.artifact_paths.upstream_package_path = Some(current_deb.clone());
            state.artifact_paths.workspace_dir = Some(current_workspace.clone());
            state.artifact_paths.package_path = Some(current_package);
            state.artifact_paths.rollback_package_path = Some(rollback_package);

            assert_eq!(prune(cache.path(), &state)?, 2);
            assert!(current_deb.exists());
            assert!(!stale_deb.exists());
            assert!(current_workspace.exists());
            assert!(rollback_workspace.exists());
            assert!(!stale_workspace.exists());
            assert!(workspaces.join("external-link").is_symlink());
            assert!(external.path().exists());
        }

        Ok(())
    }
}
