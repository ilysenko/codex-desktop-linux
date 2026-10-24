//! Conservative cache cleanup for content-addressed official packages and
//! per-candidate build workspaces.

use crate::state::PersistedState;
use anyhow::Result;
use std::{collections::BTreeSet, fs, path::Path, path::PathBuf};

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
    let mut removed = prune_workspaces(cache_root, state)?;
    let package_dir = cache_root.join("packages");
    if !package_dir.is_dir() {
        return Ok(removed);
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
    Ok(removed)
}

/// Removes build workspaces that no persisted path still points into. The
/// active workspace, the rebuilt package, the rollback package, and any
/// in-flight install transaction keep their workspace alive, so this leaves
/// at most the current candidate plus one rollback build on disk.
fn prune_workspaces(cache_root: &Path, state: &PersistedState) -> Result<usize> {
    let workspace_root = cache_root.join("workspaces");
    // Never follow a symlinked workspace root: recursive removal must stay
    // inside the updater's own cache.
    match fs::symlink_metadata(&workspace_root) {
        Ok(meta) if meta.file_type().is_dir() => {}
        _ => return Ok(0),
    }
    let mut referenced: Vec<PathBuf> = Vec::new();
    for path in [
        state.artifact_paths.workspace_dir.as_ref(),
        state.artifact_paths.package_path.as_ref(),
        state.artifact_paths.rollback_package_path.as_ref(),
        state.install_transaction.as_ref().map(|t| &t.package_path),
    ]
    .into_iter()
    .flatten()
    {
        referenced.push(path.clone());
        if let Ok(canonical) = path.canonicalize() {
            referenced.push(canonical);
        }
    }
    let mut removed = 0;
    for entry in fs::read_dir(&workspace_root)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let dir = entry.path();
        let canonical = dir.canonicalize().unwrap_or_else(|_| dir.clone());
        let in_use = referenced
            .iter()
            .any(|path| path.starts_with(&dir) || path.starts_with(&canonical));
        if !in_use {
            fs::remove_dir_all(&dir)?;
            removed += 1;
        }
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{InstallOperation, InstallTransaction};
    use chrono::Utc;

    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("codex-cache-cleanup-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("workspaces")).expect("scratch");
        dir
    }

    fn workspace(root: &Path, version: &str) -> PathBuf {
        let dist = root.join("workspaces").join(version).join("dist");
        fs::create_dir_all(&dist).expect("workspace");
        let package = dist.join(format!("codex-desktop-{version}.rpm"));
        fs::write(&package, b"rpm").expect("package");
        package
    }

    #[test]
    fn keeps_current_and_rollback_workspaces_only() {
        let root = scratch("keep");
        workspace(&root, "1.0");
        let rollback = workspace(&root, "2.0");
        workspace(&root, "3.0");
        let current = workspace(&root, "4.0");
        let mut state = PersistedState::default();
        state.artifact_paths.workspace_dir = Some(root.join("workspaces/4.0"));
        state.artifact_paths.package_path = Some(current);
        state.artifact_paths.rollback_package_path = Some(rollback);

        let removed = prune(&root, &state).expect("prune");

        assert_eq!(removed, 2);
        let mut left: Vec<_> = fs::read_dir(root.join("workspaces"))
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        left.sort();
        assert_eq!(left, ["2.0", "4.0"]);
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn keeps_active_build_and_install_transaction_workspaces() {
        let root = scratch("active");
        let installing = workspace(&root, "1.0");
        fs::create_dir_all(root.join("workspaces/2.0/codex-app")).expect("build");
        workspace(&root, "old");
        let mut state = PersistedState::default();
        state.artifact_paths.workspace_dir = Some(root.join("workspaces/2.0"));
        state.install_transaction = Some(InstallTransaction {
            package_path: installing,
            package_sha256: None,
            package_command: None,
            started_at: Utc::now(),
            operation: InstallOperation::Update,
        });

        prune(&root, &state).expect("prune");

        assert!(root.join("workspaces/1.0").is_dir());
        assert!(root.join("workspaces/2.0").is_dir());
        assert!(!root.join("workspaces/old").exists());
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[cfg(unix)]
    #[test]
    fn ignores_symlinked_workspace_root() {
        let root = scratch("symlink-root");
        let outside = scratch("symlink-target");
        fs::create_dir_all(outside.join("unrelated")).expect("outside");
        fs::remove_dir_all(root.join("workspaces")).expect("unlink");
        std::os::unix::fs::symlink(&outside, root.join("workspaces")).expect("symlink");

        prune(&root, &PersistedState::default()).expect("prune");

        assert!(outside.join("unrelated").is_dir());
        fs::remove_dir_all(root).expect("cleanup");
        fs::remove_dir_all(outside).expect("cleanup");
    }

    #[test]
    fn removes_workspaces_nothing_references() {
        let root = scratch("missing");
        workspace(&root, "1.0");
        let mut state = PersistedState::default();
        state.artifact_paths.rollback_package_path =
            Some(root.join("workspaces/gone/dist/codex-desktop-gone.rpm"));

        prune(&root, &state).expect("prune");

        assert!(!root.join("workspaces/1.0").exists());
        fs::remove_dir_all(root).expect("cleanup");
    }
}
