//! Signed OpenAI APT metadata resolution and content-addressed package cache.

use anyhow::{Context, Result};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
};
use tokio::process::Command;

const SYSTEM_NODE: &str = "/usr/bin/node";

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PackageMetadata {
    pub package: String,
    pub version: String,
    pub architecture: String,
    pub repository_path: String,
    pub sha256: String,
    pub size: u64,
    pub repository: String,
    pub path: Option<PathBuf>,
}

pub async fn resolve_metadata(
    builder_root: &Path,
    repository: &str,
    cache: &Path,
) -> Result<PackageMetadata> {
    run_verifier(builder_root, repository, cache, true, None).await
}

pub async fn download_verified_package(
    builder_root: &Path,
    repository: &str,
    cache: &Path,
    expected: &PackageMetadata,
) -> Result<PathBuf> {
    fs::create_dir_all(cache)?;
    let destination = cache.join(format!(
        "chatgpt-{}-{}-{}.deb",
        expected.version, expected.architecture, expected.sha256
    ));
    if destination.is_file() && verify_cached_file(&destination, expected)? {
        return Ok(destination);
    }

    let resolved = run_verifier(
        builder_root,
        repository,
        cache,
        false,
        Some(&expected.architecture),
    )
    .await?;
    anyhow::ensure!(
        same_identity(&resolved, expected),
        "signed package metadata changed while downloading"
    );
    let source = resolved
        .path
        .as_ref()
        .context("verifier returned no package path")?;
    fs::rename(source, &destination)
        .or_else(|_| fs::copy(source, &destination).map(|_| ()))
        .with_context(|| format!("Failed to publish {}", destination.display()))?;
    anyhow::ensure!(
        verify_cached_file(&destination, expected)?,
        "published package failed SHA256/size verification"
    );
    if let Some(run_dir) = source.parent() {
        let is_verifier_run = run_dir
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("metadata-"));
        if is_verifier_run {
            let _ = fs::remove_dir_all(run_dir);
        }
    }
    Ok(destination)
}

fn same_identity(left: &PackageMetadata, right: &PackageMetadata) -> bool {
    left.package == right.package
        && left.version == right.version
        && left.architecture == right.architecture
        && left.repository_path == right.repository_path
        && left.sha256 == right.sha256
        && left.size == right.size
        && left.repository == right.repository
}

async fn run_verifier(
    builder_root: &Path,
    repository: &str,
    cache: &Path,
    metadata_only: bool,
    architecture: Option<&str>,
) -> Result<PackageMetadata> {
    let run_dir = cache.join(format!(
        "metadata-{}-{}",
        std::process::id(),
        if metadata_only { "probe" } else { "download" }
    ));
    if run_dir.exists() {
        fs::remove_dir_all(&run_dir)?;
    }
    fs::create_dir_all(&run_dir)?;
    let metadata_path = run_dir.join("package.json");
    ensure_supported_node().await?;
    let mut command = Command::new(SYSTEM_NODE);
    command
        .arg(builder_root.join("scripts/lib/upstream-linux-package.js"))
        .args([
            "--output-dir",
            run_dir.to_str().context("non-UTF8 cache path")?,
        ])
        .args([
            "--metadata",
            metadata_path.to_str().context("non-UTF8 metadata path")?,
        ])
        .args([
            "--key-base64",
            builder_root
                .join("assets/openai-codex-linux-repository-key.gpg.base64")
                .to_str()
                .context("non-UTF8 key path")?,
        ])
        .args(["--repository", repository]);
    if let Some(architecture) = architecture {
        command.args(["--arch", architecture]);
    }
    if metadata_only {
        command.arg("--metadata-only");
    }
    let output = command
        .output()
        .await
        .context("Failed to start signed package verifier")?;
    anyhow::ensure!(
        output.status.success(),
        "signed package verifier failed: {}",
        String::from_utf8_lossy(&output.stderr).trim()
    );
    let metadata: PackageMetadata = serde_json::from_slice(&fs::read(&metadata_path)?)?;
    anyhow::ensure!(
        metadata.package == "chatgpt",
        "signed index selected an unexpected package"
    );
    if metadata_only {
        let _ = fs::remove_dir_all(&run_dir);
    }
    Ok(metadata)
}

async fn ensure_supported_node() -> Result<()> {
    let output = Command::new(SYSTEM_NODE)
        .arg("--version")
        .output()
        .await
        .context("Node.js 24 or newer is required by the update manager")?;
    anyhow::ensure!(output.status.success(), "Node.js version check failed");
    let version = String::from_utf8_lossy(&output.stdout);
    let major = parse_node_major(&version).context("Node.js returned an invalid version")?;
    anyhow::ensure!(major >= 24, "Node.js 24 or newer is required by the update manager; found {}", version.trim());
    Ok(())
}

fn parse_node_major(version: &str) -> Option<u32> {
    version.trim().strip_prefix('v')?.split('.').next()?.parse().ok()
}

fn verify_cached_file(path: &Path, expected: &PackageMetadata) -> Result<bool> {
    if fs::metadata(path)?.len() != expected.size {
        return Ok(false);
    }
    let bytes = fs::read(path)?;
    let actual = Sha256::digest(&bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Ok(actual == expected.sha256)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_version_gate_requires_current_lts_or_newer() {
        assert_eq!(SYSTEM_NODE, "/usr/bin/node");
        assert_eq!(parse_node_major("v24.20.0\n"), Some(24));
        assert_eq!(parse_node_major("v26.8.1"), Some(26));
        assert_eq!(parse_node_major("v22.19.0"), Some(22));
        assert_eq!(parse_node_major("12.22.9"), None);
    }

    #[test]
    fn cache_identity_contains_version_architecture_and_sha() {
        let metadata = PackageMetadata {
            package: "chatgpt".into(),
            version: "26.1".into(),
            architecture: "amd64".into(),
            repository_path: "pool/chatgpt.deb".into(),
            sha256: "a".repeat(64),
            size: 1,
            repository: "https://example.invalid".into(),
            path: None,
        };
        let name = format!(
            "chatgpt-{}-{}-{}.deb",
            metadata.version, metadata.architecture, metadata.sha256
        );
        assert!(name.contains("26.1-amd64"));
        assert!(name.ends_with(".deb"));
    }
}
