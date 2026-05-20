//! Linux release metadata and package download helpers.

use crate::install::PackageKind;
use anyhow::{anyhow, Context, Result};
use chrono::{DateTime, Utc};
use futures_util::StreamExt;
use reqwest::{header, Client};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    fmt,
    path::{Path, PathBuf},
};
use tokio::{fs::File, io::AsyncWriteExt};

pub const DEFAULT_RELEASES_API_URL: &str =
    "https://api.github.com/repos/ilysenko/codex-desktop-linux/releases";

const USER_AGENT: &str = "codex-update-manager";
const GITHUB_ACCEPT: &str = "application/vnd.github+json";
const PACMAN_SUFFIXES: &[&str] = &[
    ".pkg.tar.zst",
    ".pkg.tar.xz",
    ".pkg.tar.gz",
    ".pkg.tar.bz2",
    ".pkg.tar.lz",
    ".pkg.tar.lz4",
    ".pkg.tar.lz5",
];

#[derive(Debug, Clone, PartialEq, Eq)]
/// Selected release metadata used to detect Linux package updates.
pub struct RemoteMetadata {
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub content_length: Option<u64>,
    pub headers_fingerprint: String,
    pub download_url: String,
    pub asset_name: String,
    pub candidate_version: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
/// Result of downloading the selected Linux release package.
pub struct DownloadedDmg {
    pub path: PathBuf,
    pub sha256: String,
    pub candidate_version: String,
}

#[derive(Debug)]
/// Returned when the Linux repo has not published any releases yet.
pub struct NoPublishedReleases;

impl fmt::Display for NoPublishedReleases {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("no published Codex Desktop Linux releases were found")
    }
}

impl std::error::Error for NoPublishedReleases {}

#[derive(Debug, Deserialize)]
struct GithubRelease {
    id: u64,
    tag_name: String,
    draft: bool,
    prerelease: bool,
    published_at: Option<DateTime<Utc>>,
    assets: Vec<GithubAsset>,
}

#[derive(Debug, Deserialize)]
struct GithubAsset {
    id: u64,
    name: String,
    size: Option<u64>,
    browser_download_url: String,
    updated_at: Option<DateTime<Utc>>,
}

/// Fetches the latest published Linux repo release and package asset for this system.
pub async fn fetch_remote_metadata(
    client: &Client,
    releases_api_url: &str,
    package_kind: PackageKind,
) -> Result<RemoteMetadata> {
    let response = client
        .get(releases_api_url)
        .header(header::ACCEPT, GITHUB_ACCEPT)
        .header(header::USER_AGENT, USER_AGENT)
        .send()
        .await
        .with_context(|| format!("Failed GET request for {releases_api_url}"))?
        .error_for_status()
        .with_context(|| {
            format!("GitHub releases request for {releases_api_url} returned an error status")
        })?;

    let etag = header_string(response.headers(), header::ETAG);
    let last_modified = header_string(response.headers(), header::LAST_MODIFIED);
    let body = response
        .text()
        .await
        .with_context(|| format!("Failed reading GitHub releases body from {releases_api_url}"))?;
    let releases = serde_json::from_str::<Vec<GithubRelease>>(&body).with_context(|| {
        format!("Failed to parse GitHub releases response from {releases_api_url}")
    })?;
    let release = select_latest_release(&releases)?;
    let asset = select_package_asset(release, package_kind)?;
    let candidate_version = candidate_version_from_asset_name(package_kind, &asset.name)
        .or_else(|| candidate_version_from_release_tag(&release.tag_name))
        .with_context(|| format!("Could not derive package version from {}", asset.name))?;
    let asset_updated_at = asset
        .updated_at
        .map(|value| value.to_rfc3339())
        .unwrap_or_default();
    let content_length = asset.size;
    let headers_fingerprint = format!(
        "release_api={releases_api_url}|etag={}|last_modified={}|release_id={}|tag={}|published_at={}|asset_id={}|asset_name={}|asset_size={}|asset_updated_at={asset_updated_at}",
        etag.as_deref().unwrap_or(""),
        last_modified.as_deref().unwrap_or(""),
        release.id,
        release.tag_name,
        release
            .published_at
            .map(|value| value.to_rfc3339())
            .as_deref()
            .unwrap_or(""),
        asset.id,
        asset.name,
        content_length
            .map(|value| value.to_string())
            .as_deref()
            .unwrap_or("")
    );

    Ok(RemoteMetadata {
        etag,
        last_modified,
        content_length,
        headers_fingerprint,
        download_url: asset.browser_download_url.clone(),
        asset_name: asset.name.clone(),
        candidate_version,
    })
}

/// Downloads the selected Linux release package and hashes its contents.
pub async fn download_dmg(
    client: &Client,
    download_url: &str,
    asset_name: &str,
    destination_dir: &Path,
    version_timestamp: DateTime<Utc>,
    candidate_version: &str,
) -> Result<DownloadedDmg> {
    tokio::fs::create_dir_all(destination_dir)
        .await
        .with_context(|| format!("Failed to create {}", destination_dir.display()))?;

    let destination = destination_dir.join(safe_asset_file_name(asset_name));
    let mut file = File::create(&destination)
        .await
        .with_context(|| format!("Failed to create {}", destination.display()))?;

    let response = client
        .get(download_url)
        .header(header::USER_AGENT, USER_AGENT)
        .send()
        .await
        .with_context(|| format!("Failed GET request for {download_url}"))?
        .error_for_status()
        .with_context(|| format!("GET request for {download_url} returned an error status"))?;

    let mut hasher = Sha256::new();
    let mut stream = response.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.with_context(|| format!("Failed downloading {download_url}"))?;
        file.write_all(&chunk)
            .await
            .with_context(|| format!("Failed writing {}", destination.display()))?;
        hasher.update(&chunk);
    }

    file.flush()
        .await
        .with_context(|| format!("Failed flushing {}", destination.display()))?;

    let sha256 = hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let candidate_version = if candidate_version.is_empty() {
        derive_candidate_version(&sha256, version_timestamp)?
    } else {
        candidate_version.to_string()
    };

    Ok(DownloadedDmg {
        path: destination,
        sha256,
        candidate_version,
    })
}

/// Derives a local package version from a package hash and download timestamp.
pub fn derive_candidate_version(sha256: &str, timestamp: DateTime<Utc>) -> Result<String> {
    let short_hash = sha256
        .get(0..8)
        .ok_or_else(|| anyhow!("sha256 is too short to derive candidate version"))?;
    Ok(format!(
        "{}+{}",
        timestamp.format("%Y.%m.%d.%H%M%S"),
        short_hash
    ))
}

fn header_string(headers: &header::HeaderMap, name: header::HeaderName) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
}

fn select_latest_release(releases: &[GithubRelease]) -> Result<&GithubRelease> {
    let mut releases = releases
        .iter()
        .filter(|release| !release.draft)
        .collect::<Vec<_>>();
    if releases.is_empty() {
        return Err(NoPublishedReleases.into());
    }

    releases.sort_by_key(|release| release.published_at);
    releases.reverse();
    Ok(releases
        .iter()
        .copied()
        .find(|release| !release.prerelease)
        .or_else(|| releases.first().copied())
        .expect("non-empty releases should have first element"))
}

fn select_package_asset(
    release: &GithubRelease,
    package_kind: PackageKind,
) -> Result<&GithubAsset> {
    release
        .assets
        .iter()
        .find(|asset| {
            asset_matches_package_kind(&asset.name, package_kind)
                && asset_arch_is_compatible(&asset.name)
        })
        .ok_or_else(|| {
            let assets = release
                .assets
                .iter()
                .map(|asset| asset.name.as_str())
                .collect::<Vec<_>>()
                .join(", ");
            anyhow!(
                "Release {} has no matching {} package for {}; available assets: {}",
                release.tag_name,
                package_kind_label(package_kind),
                std::env::consts::ARCH,
                if assets.is_empty() { "none" } else { &assets }
            )
        })
}

fn asset_matches_package_kind(name: &str, package_kind: PackageKind) -> bool {
    let name = name.to_ascii_lowercase();
    match package_kind {
        PackageKind::Deb => name.ends_with(".deb"),
        PackageKind::Rpm => name.ends_with(".rpm"),
        PackageKind::Pacman => PACMAN_SUFFIXES.iter().any(|suffix| name.ends_with(suffix)),
    }
}

fn asset_arch_is_compatible(name: &str) -> bool {
    let normalized = normalize_asset_name(name);
    let known_arches = [
        "amd64", "x86_64", "arm64", "aarch64", "armhf", "armv7", "i386", "i686",
    ];
    let asset_arch = known_arches
        .iter()
        .find(|arch| normalized.contains(&format!("_{arch}_")));
    match asset_arch {
        Some(arch) => current_arch_aliases().contains(arch),
        None => true,
    }
}

fn current_arch_aliases() -> &'static [&'static str] {
    match std::env::consts::ARCH {
        "x86_64" => &["amd64", "x86_64"],
        "aarch64" => &["arm64", "aarch64"],
        "x86" | "i686" => &["i386", "i686"],
        "arm" => &["armhf", "armv7"],
        _ => &[],
    }
}

fn normalize_asset_name(name: &str) -> String {
    let mut normalized = String::with_capacity(name.len() + 2);
    normalized.push('_');
    for character in name.chars() {
        if character.is_ascii_alphanumeric() {
            normalized.push(character.to_ascii_lowercase());
        } else {
            normalized.push('_');
        }
    }
    normalized.push('_');
    normalized
}

fn candidate_version_from_asset_name(
    package_kind: PackageKind,
    asset_name: &str,
) -> Option<String> {
    match package_kind {
        PackageKind::Deb => asset_name
            .strip_suffix(".deb")?
            .split('_')
            .nth(1)
            .filter(|version| !version.is_empty())
            .map(str::to_string),
        PackageKind::Rpm => candidate_version_from_native_asset(asset_name, ".rpm"),
        PackageKind::Pacman => PACMAN_SUFFIXES.iter().find_map(|suffix| {
            asset_name
                .strip_suffix(suffix)
                .and_then(|name| candidate_version_from_native_asset(name, ""))
        }),
    }
}

fn candidate_version_from_native_asset(asset_name: &str, suffix: &str) -> Option<String> {
    let without_suffix = asset_name.strip_suffix(suffix).unwrap_or(asset_name);
    let without_arch = strip_arch_suffix(without_suffix)?;
    without_arch
        .strip_prefix("codex-desktop-")
        .filter(|version| !version.is_empty())
        .map(str::to_string)
}

fn strip_arch_suffix(value: &str) -> Option<&str> {
    for arch in [
        "amd64", "x86_64", "arm64", "aarch64", "armhf", "armv7", "i386", "i686",
    ] {
        for separator in ['.', '-'] {
            if let Some(stripped) = value.strip_suffix(&format!("{separator}{arch}")) {
                return Some(stripped);
            }
        }
    }
    None
}

fn candidate_version_from_release_tag(tag_name: &str) -> Option<String> {
    let tag = tag_name.trim().trim_start_matches('v');
    if tag.is_empty() {
        None
    } else {
        Some(tag.to_string())
    }
}

fn package_kind_label(package_kind: PackageKind) -> &'static str {
    match package_kind {
        PackageKind::Deb => "Debian",
        PackageKind::Rpm => "RPM",
        PackageKind::Pacman => "pacman",
    }
}

fn safe_asset_file_name(asset_name: &str) -> String {
    asset_name
        .chars()
        .map(|character| match character {
            '/' | '\\' | '\0' => '_',
            _ => character,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use anyhow::Result;
    use chrono::TimeZone;
    use tempfile::tempdir;
    use wiremock::{
        matchers::{method, path},
        Mock, MockServer, ResponseTemplate,
    };

    #[tokio::test]
    async fn fetches_linux_release_metadata_for_current_package_kind() -> Result<()> {
        let server = MockServer::start().await;
        let releases = format!(
            r#"[
  {{
    "id": 1,
    "tag_name": "v2026.05.19.111111",
    "draft": false,
    "prerelease": false,
    "published_at": "2026-05-19T11:11:11Z",
    "assets": []
  }},
  {{
    "id": 2,
    "tag_name": "v2026.05.20.222222",
    "draft": false,
    "prerelease": false,
    "published_at": "2026-05-20T22:22:22Z",
    "assets": [
      {{
        "id": 21,
        "name": "codex-desktop_2026.05.20.222222+new_amd64.deb",
        "size": 300,
        "browser_download_url": "{}/current.deb",
        "updated_at": "2026-05-20T22:24:00Z"
      }}
    ]
  }}
]"#,
            server.uri()
        );
        Mock::given(method("GET"))
            .and(path("/releases"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("ETag", "\"release-list\"")
                    .set_body_string(releases),
            )
            .mount(&server)
            .await;

        let client = Client::builder().build()?;
        let metadata = fetch_remote_metadata(
            &client,
            &format!("{}/releases", server.uri()),
            PackageKind::Deb,
        )
        .await?;

        assert_eq!(metadata.etag.as_deref(), Some("\"release-list\""));
        assert_eq!(metadata.content_length, Some(300));
        assert_eq!(
            metadata.download_url,
            format!("{}/current.deb", server.uri())
        );
        assert_eq!(
            metadata.asset_name,
            "codex-desktop_2026.05.20.222222+new_amd64.deb"
        );
        assert_eq!(metadata.candidate_version, "2026.05.20.222222+new");
        assert!(metadata.headers_fingerprint.contains("asset_id=21"));
        Ok(())
    }

    #[tokio::test]
    async fn no_published_releases_is_not_a_parse_error() -> Result<()> {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/releases"))
            .respond_with(ResponseTemplate::new(200).set_body_string("[]"))
            .mount(&server)
            .await;

        let client = Client::builder().build()?;
        let error = fetch_remote_metadata(
            &client,
            &format!("{}/releases", server.uri()),
            PackageKind::Deb,
        )
        .await
        .expect_err("empty releases should fail");

        assert!(error.downcast_ref::<NoPublishedReleases>().is_some());
        Ok(())
    }

    #[tokio::test]
    async fn downloads_release_package_and_hashes_contents() -> Result<()> {
        let server = MockServer::start().await;
        let body = b"codex-linux-release-package";
        Mock::given(method("GET"))
            .and(path("/codex-desktop_2026.05.20.222222+new_amd64.deb"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(body.to_vec()))
            .mount(&server)
            .await;

        let client = Client::builder().build()?;
        let temp = tempdir()?;
        let downloaded = download_dmg(
            &client,
            &format!(
                "{}/codex-desktop_2026.05.20.222222+new_amd64.deb",
                server.uri()
            ),
            "codex-desktop_2026.05.20.222222+new_amd64.deb",
            temp.path(),
            Utc.with_ymd_and_hms(2026, 3, 24, 12, 0, 0).unwrap(),
            "2026.05.20.222222+new",
        )
        .await?;

        assert_eq!(
            downloaded.path,
            temp.path()
                .join("codex-desktop_2026.05.20.222222+new_amd64.deb")
        );
        assert_eq!(
            downloaded.sha256,
            "4728cddbf2d004106cfee05e16a5fdcc6db6dbb077876e575fc9cf31932db9b3"
        );
        assert_eq!(downloaded.candidate_version, "2026.05.20.222222+new");
        Ok(())
    }

    #[test]
    fn parses_candidate_versions_from_asset_names() {
        assert_eq!(
            candidate_version_from_asset_name(
                PackageKind::Deb,
                "codex-desktop_2026.05.20.222222+new_amd64.deb"
            )
            .as_deref(),
            Some("2026.05.20.222222+new")
        );
        assert_eq!(
            candidate_version_from_asset_name(
                PackageKind::Rpm,
                "codex-desktop-2026.05.20.222222-new.x86_64.rpm"
            )
            .as_deref(),
            Some("2026.05.20.222222-new")
        );
        assert_eq!(
            candidate_version_from_asset_name(
                PackageKind::Pacman,
                "codex-desktop-2026.05.20.333333+arch-1-x86_64.pkg.tar.zst"
            )
            .as_deref(),
            Some("2026.05.20.333333+arch-1")
        );
    }

    #[test]
    fn derive_candidate_version_rejects_short_hashes() {
        let error = derive_candidate_version("short", Utc::now()).expect_err("hash should fail");
        assert!(error.to_string().contains("sha256 is too short"));
    }
}
