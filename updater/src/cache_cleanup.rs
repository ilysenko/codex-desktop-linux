//! Conservative cache cleanup for content-addressed official packages and
//! per-candidate build workspaces.

use crate::state::PersistedState;
use anyhow::Result;
use std::{collections::BTreeSet, fs, path::Path, path::PathBuf};

pub fn prune(cache_root: &Path, workspace_root: &Path, state: &PersistedState) -> Result<usize> {
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
    let mut removed = prune_workspaces(workspace_root, state)?;
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
/// in-flight install transaction keep their workspace alive.
fn prune_workspaces(workspace_root: &Path, state: &PersistedState) -> Result<usize> {
    let workspace_root = workspace_root.join("workspaces");
    // Never follow a symlinked workspace root: recursive removal must stay
    // inside the explicitly selected workspace tree.
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

        let removed = prune(&root, &root, &state).expect("prune");

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

        prune(&root, &root, &state).expect("prune");

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

        prune(&root, &root, &PersistedState::default()).expect("prune");

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

        prune(&root, &root, &state).expect("prune");

        assert!(!root.join("workspaces/1.0").exists());
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn custom_workspace_root_keeps_references_and_uses_the_original_package_cache() -> Result<()> {
        use crate::config::{RuntimeConfig, RuntimePaths};

        let root = tempfile::tempdir()?;
        let paths = RuntimePaths {
            config_file: root.path().join("config/config.toml"),
            state_file: root.path().join("state/state.json"),
            log_file: root.path().join("state/service.log"),
            cache_dir: root.path().join("cache"),
            state_dir: root.path().join("state"),
            config_dir: root.path().join("config"),
        };
        paths.ensure_dirs()?;
        let config = RuntimeConfig {
            workspace_root: root.path().join("custom-builds"),
            ..RuntimeConfig::default_with_paths(&paths)
        };
        fs::write(&paths.config_file, toml::to_string(&config)?)?;
        let config = RuntimeConfig::load_or_default(&paths)?;
        let custom = &config.workspace_root;
        let stale = workspace(custom, "stale");
        let active = workspace(custom, "active");
        let built = workspace(custom, "built");
        let rollback = workspace(custom, "rollback");
        let installing = workspace(custom, "installing");
        let unselected = workspace(&paths.cache_dir, "unselected");
        let downloads = paths.cache_dir.join("packages");
        fs::create_dir_all(&downloads)?;
        let upstream = downloads.join("current.deb");
        let stale_download = downloads.join("stale.deb");
        let other_format = downloads.join("unrelated.rpm");
        let custom_download = custom.join("packages/untouched.deb");
        fs::create_dir_all(custom_download.parent().unwrap())?;
        for path in [&upstream, &stale_download, &other_format, &custom_download] {
            fs::write(path, b"fixture")?;
        }
        let mut state = PersistedState::default();
        state.artifact_paths.workspace_dir = Some(custom.join("workspaces/active"));
        state.artifact_paths.upstream_package_path = Some(upstream.clone());
        state.artifact_paths.package_path = Some(built.clone());
        state.artifact_paths.rollback_package_path = Some(rollback.clone());
        state.install_transaction = Some(InstallTransaction {
            package_path: installing.clone(),
            package_sha256: None,
            package_command: None,
            started_at: Utc::now(),
            operation: InstallOperation::Update,
        });

        assert_eq!(prune(&paths.cache_dir, custom, &state)?, 2);
        assert!(!stale.exists());
        assert!(!stale_download.exists());
        for retained in [
            active,
            built,
            rollback,
            installing,
            unselected,
            upstream,
            other_format,
            custom_download,
        ] {
            assert!(retained.is_file(), "must retain {}", retained.display());
        }
        assert_eq!(prune(&paths.cache_dir, custom, &state)?, 0);
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn custom_root_keeps_lexical_and_canonical_references_and_ignores_symlink_entries() -> Result<()>
    {
        let root = tempfile::tempdir()?;
        let cache = root.path().join("cache");
        let custom = root.path().join("custom");
        let lexical = workspace(&custom, "lexical");
        let canonical = workspace(&custom, "canonical");
        workspace(&custom, "stale");
        let alias = root.path().join("reference-alias");
        std::os::unix::fs::symlink(custom.join("workspaces/canonical"), &alias)?;
        let outside = root.path().join("outside");
        fs::create_dir_all(outside.join("unrelated/nested"))?;
        let linked_entry = custom.join("workspaces/linked");
        std::os::unix::fs::symlink(&outside, &linked_entry)?;
        let mut state = PersistedState::default();
        // A missing descendant still protects the lexical workspace path.
        state.artifact_paths.workspace_dir =
            Some(custom.join("workspaces/lexical/not-yet-created"));
        state.artifact_paths.package_path = Some(alias.join("dist/codex-desktop-canonical.rpm"));

        assert_eq!(prune(&cache, &custom, &state)?, 1);
        assert!(lexical.is_file());
        assert!(canonical.is_file());
        assert!(fs::symlink_metadata(&linked_entry)?
            .file_type()
            .is_symlink());
        assert!(outside.join("unrelated/nested").is_dir());
        assert_eq!(prune(&cache, &custom, &state)?, 0);

        fs::remove_dir_all(custom.join("workspaces"))?;
        std::os::unix::fs::symlink(&outside, custom.join("workspaces"))?;
        assert_eq!(prune(&cache, &custom, &PersistedState::default())?, 0);
        assert!(outside.join("unrelated/nested").is_dir());
        Ok(())
    }

    #[test]
    fn missing_or_non_directory_workspace_roots_are_ignored_without_creation() -> Result<()> {
        let root = tempfile::tempdir()?;
        let cache = root.path().join("cache");
        let custom = root.path().join("custom");
        for _ in 0..2 {
            assert_eq!(prune(&cache, &custom, &PersistedState::default())?, 0);
            assert!(!custom.exists());
        }
        fs::create_dir_all(&custom)?;
        fs::write(custom.join("workspaces"), b"not a directory")?;
        assert_eq!(prune(&cache, &custom, &PersistedState::default())?, 0);
        assert!(custom.join("workspaces").is_file());
        Ok(())
    }
}
