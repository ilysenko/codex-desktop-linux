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
    Ok(removed)
}
