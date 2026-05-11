//! Upstream installer metadata and download helpers.

use crate::config::{ReleaseTrack, RuntimeConfig};
use anyhow::{anyhow, Context, Result};
use chrono::{DateTime, Utc};
use futures_util::StreamExt;
use reqwest::{header, Client, Url};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use tokio::{fs::File, io::AsyncWriteExt};

#[derive(Debug, Clone, PartialEq, Eq)]
/// Selected HTTP metadata used to detect upstream DMG changes.
pub struct RemoteMetadata {
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub content_length: Option<u64>,
    pub headers_fingerprint: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
/// Result of downloading the current upstream DMG snapshot.
pub struct DownloadedDmg {
    pub path: PathBuf,
    pub sha256: String,
    pub candidate_version: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
/// Resolved upstream installer source for the selected release track.
pub struct ResolvedInstaller {
    pub download_url: String,
    pub file_name: String,
    pub metadata: RemoteMetadata,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct AppcastRelease {
    version: String,
    url: String,
}

pub async fn resolve_installer(
    client: &Client,
    config: &RuntimeConfig,
) -> Result<ResolvedInstaller> {
    match config.release_track {
        ReleaseTrack::Stable => {
            let metadata = fetch_remote_metadata(client, &config.dmg_url).await?;
            Ok(ResolvedInstaller {
                download_url: config.dmg_url.clone(),
                file_name: "Codex.dmg".to_string(),
                metadata,
            })
        }
        ReleaseTrack::Preview => resolve_appcast_installer(client, &config.beta_appcast_url).await,
    }
}

async fn resolve_appcast_installer(
    client: &Client,
    appcast_url: &str,
) -> Result<ResolvedInstaller> {
    let appcast = client
        .get(appcast_url)
        .send()
        .await
        .with_context(|| format!("Failed GET request for {appcast_url}"))?
        .error_for_status()
        .with_context(|| format!("GET request for {appcast_url} returned an error status"))?
        .text()
        .await
        .with_context(|| format!("Failed reading appcast body from {appcast_url}"))?;
    let release = parse_first_appcast_release(&appcast)
        .with_context(|| format!("Failed to resolve preview appcast"))?;
    validate_appcast_release_url(appcast_url, &release.url)?;
    let mut metadata = fetch_remote_metadata(client, &release.url).await?;
    metadata.headers_fingerprint = format!(
        "track=preview|appcast=beta|appcast_url={}|version={}|url={}|{}",
        appcast_url, release.version, release.url, metadata.headers_fingerprint
    );

    Ok(ResolvedInstaller {
        download_url: release.url,
        file_name: format!(
            "Codex-{}-{}.zip",
            track_title(ReleaseTrack::Preview),
            sanitize_file_component(&release.version)
        ),
        metadata,
    })
}

/// Fetches the upstream DMG headers used to detect candidate updates.
pub async fn fetch_remote_metadata(client: &Client, dmg_url: &str) -> Result<RemoteMetadata> {
    let response = client
        .head(dmg_url)
        .send()
        .await
        .with_context(|| format!("Failed HEAD request for {dmg_url}"))?
        .error_for_status()
        .with_context(|| format!("HEAD request for {dmg_url} returned an error status"))?;

    let etag = response
        .headers()
        .get(header::ETAG)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let last_modified = response
        .headers()
        .get(header::LAST_MODIFIED)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let content_length = response
        .headers()
        .get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok());

    let headers_fingerprint = format!(
        "etag={}|last_modified={}|content_length={}",
        etag.as_deref().unwrap_or(""),
        last_modified.as_deref().unwrap_or(""),
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
    })
}

/// Downloads the upstream installer and derives a package version from its hash.
pub async fn download_installer(
    client: &Client,
    installer_url: &str,
    destination_dir: &Path,
    version_timestamp: DateTime<Utc>,
    file_name: &str,
) -> Result<DownloadedDmg> {
    tokio::fs::create_dir_all(destination_dir)
        .await
        .with_context(|| format!("Failed to create {}", destination_dir.display()))?;

    let destination = destination_dir.join(file_name);
    let mut file = File::create(&destination)
        .await
        .with_context(|| format!("Failed to create {}", destination.display()))?;

    let response = client
        .get(installer_url)
        .send()
        .await
        .with_context(|| format!("Failed GET request for {installer_url}"))?
        .error_for_status()
        .with_context(|| format!("GET request for {installer_url} returned an error status"))?;

    let mut hasher = Sha256::new();
    let mut stream = response.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.with_context(|| format!("Failed downloading {installer_url}"))?;
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
    let candidate_version = derive_candidate_version(&sha256, version_timestamp)?;

    Ok(DownloadedDmg {
        path: destination,
        sha256,
        candidate_version,
    })
}

/// Downloads the upstream DMG and derives a package version from its hash.
#[cfg(test)]
pub async fn download_dmg(
    client: &Client,
    dmg_url: &str,
    destination_dir: &Path,
    version_timestamp: DateTime<Utc>,
) -> Result<DownloadedDmg> {
    download_installer(
        client,
        dmg_url,
        destination_dir,
        version_timestamp,
        "Codex.dmg",
    )
    .await
}

fn parse_first_appcast_release(appcast: &str) -> Result<AppcastRelease> {
    let item = slice_between(appcast, "<item", "</item>")
        .ok_or_else(|| anyhow!("No releases found in appcast"))?;
    let version = element_text(item, "sparkle:shortVersionString")
        .or_else(|| element_text(item, "title"))
        .ok_or_else(|| anyhow!("Appcast item missing version"))?;
    let enclosure = slice_between(item, "<enclosure", ">")
        .ok_or_else(|| anyhow!("Appcast item missing enclosure"))?;
    let url =
        attr_value(enclosure, "url").ok_or_else(|| anyhow!("Appcast enclosure missing URL"))?;
    Ok(AppcastRelease { version, url })
}

fn validate_appcast_release_url(appcast_url: &str, release_url: &str) -> Result<()> {
    let appcast = Url::parse(appcast_url)
        .with_context(|| format!("Failed to parse appcast URL: {appcast_url}"))?;
    let release = Url::parse(release_url)
        .with_context(|| format!("Failed to parse appcast enclosure URL: {release_url}"))?;

    match release.scheme() {
        "http" | "https" => {}
        scheme => {
            return Err(anyhow!(
                "Appcast enclosure URL must use HTTP(S), got {scheme}"
            ))
        }
    }
    if appcast.scheme() == "https" && release.scheme() != "https" {
        return Err(anyhow!("Appcast enclosure URL must use HTTPS"));
    }
    if appcast.host_str() == Some("persistent.oaistatic.com")
        && release.host_str() != appcast.host_str()
    {
        return Err(anyhow!(
            "Appcast enclosure URL must use host {}",
            appcast.host_str().unwrap_or_default()
        ));
    }
    Ok(())
}

fn slice_between<'a>(source: &'a str, start: &str, end: &str) -> Option<&'a str> {
    let start_index = source.find(start)?;
    let after_start = &source[start_index..];
    let end_index = after_start.find(end)?;
    Some(&after_start[..end_index + end.len()])
}

fn element_text(source: &str, name: &str) -> Option<String> {
    let open = format!("<{name}>");
    let close = format!("</{name}>");
    let start = source.find(&open)? + open.len();
    let end = source[start..].find(&close)? + start;
    Some(xml_unescape(&source[start..end]))
}

fn attr_value(source: &str, name: &str) -> Option<String> {
    let pattern = format!("{name}=");
    let start = source.find(&pattern)? + pattern.len();
    let quote = source[start..].chars().next()?;
    if quote != '"' && quote != '\'' {
        return None;
    }
    let value_start = start + quote.len_utf8();
    let value_end = source[value_start..].find(quote)? + value_start;
    Some(xml_unescape(&source[value_start..value_end]))
}

fn xml_unescape(value: &str) -> String {
    value
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
}

fn track_title(release_track: ReleaseTrack) -> &'static str {
    match release_track {
        ReleaseTrack::Stable => "Stable",
        ReleaseTrack::Preview => "Preview",
    }
}

fn sanitize_file_component(value: &str) -> String {
    let sanitized = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '.' || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();
    if sanitized.is_empty() {
        "latest".to_string()
    } else {
        sanitized
    }
}

/// Derives a local package version from the DMG hash and download timestamp.
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

    fn test_config(server_url: &str, release_track: ReleaseTrack) -> RuntimeConfig {
        RuntimeConfig {
            release_track,
            dmg_url: format!("{server_url}/Codex.dmg"),
            beta_appcast_url: format!("{server_url}/appcast.xml"),
            initial_check_delay_seconds: 30,
            check_interval_hours: 6,
            auto_install_on_app_exit: true,
            notifications: false,
            workspace_root: PathBuf::from("/tmp/codex-workspaces"),
            builder_bundle_root: PathBuf::from("/tmp/codex-builder"),
            app_executable_path: PathBuf::from("/opt/codex-desktop/electron"),
        }
    }

    #[tokio::test]
    async fn fetches_remote_metadata_from_head() -> Result<()> {
        let server = MockServer::start().await;
        Mock::given(method("HEAD"))
            .and(path("/Codex.dmg"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("ETag", "\"abc\"")
                    .insert_header("Last-Modified", "Tue, 25 Mar 2026 00:00:00 GMT")
                    .insert_header("Content-Length", "42"),
            )
            .mount(&server)
            .await;

        let client = Client::builder().build()?;
        let metadata =
            fetch_remote_metadata(&client, &format!("{}/Codex.dmg", server.uri())).await?;
        assert_eq!(metadata.etag.as_deref(), Some("\"abc\""));
        assert_eq!(
            metadata.last_modified.as_deref(),
            Some("Tue, 25 Mar 2026 00:00:00 GMT")
        );
        assert_eq!(metadata.content_length, Some(42));
        assert!(metadata.headers_fingerprint.contains("etag=\"abc\""));
        Ok(())
    }

    #[tokio::test]
    async fn resolves_stable_installer_from_dmg_headers() -> Result<()> {
        let server = MockServer::start().await;
        Mock::given(method("HEAD"))
            .and(path("/Codex.dmg"))
            .respond_with(ResponseTemplate::new(200).insert_header("ETag", "\"stable\""))
            .mount(&server)
            .await;

        let client = Client::builder().build()?;
        let installer =
            resolve_installer(&client, &test_config(&server.uri(), ReleaseTrack::Stable)).await?;

        assert_eq!(
            installer.download_url,
            format!("{}/Codex.dmg", server.uri())
        );
        assert_eq!(installer.file_name, "Codex.dmg");
        assert_eq!(installer.metadata.etag.as_deref(), Some("\"stable\""));
        Ok(())
    }

    #[tokio::test]
    async fn resolves_preview_installer_from_beta_appcast() -> Result<()> {
        let server = MockServer::start().await;
        let appcast = format!(
            r#"<?xml version="1.0" encoding="utf-8"?>
<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" version="2.0">
  <channel>
    <item>
      <title>26.506.31421</title>
      <sparkle:shortVersionString>26.506.31421</sparkle:shortVersionString>
      <enclosure url="{}/Codex-Beta.zip" length="42" />
    </item>
  </channel>
</rss>"#,
            server.uri()
        );
        Mock::given(method("GET"))
            .and(path("/appcast.xml"))
            .respond_with(ResponseTemplate::new(200).set_body_string(appcast))
            .mount(&server)
            .await;
        Mock::given(method("HEAD"))
            .and(path("/Codex-Beta.zip"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("ETag", "\"beta\"")
                    .insert_header("Content-Length", "42"),
            )
            .mount(&server)
            .await;

        let client = Client::builder().build()?;
        let installer =
            resolve_installer(&client, &test_config(&server.uri(), ReleaseTrack::Preview)).await?;

        assert_eq!(
            installer.download_url,
            format!("{}/Codex-Beta.zip", server.uri())
        );
        assert_eq!(installer.file_name, "Codex-Preview-26.506.31421.zip");
        assert!(installer
            .metadata
            .headers_fingerprint
            .contains("track=preview"));
        assert_eq!(installer.metadata.etag.as_deref(), Some("\"beta\""));
        Ok(())
    }

    #[tokio::test]
    async fn preview_resolver_uses_beta_appcast() -> Result<()> {
        let server = MockServer::start().await;
        let appcast = format!(
            r#"<?xml version="1.0" encoding="utf-8"?>
<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" version="2.0">
  <channel>
    <item>
      <title>26.506.31421</title>
      <sparkle:shortVersionString>26.506.31421</sparkle:shortVersionString>
      <enclosure url="{}/Codex-Beta.zip" length="42" />
    </item>
  </channel>
</rss>"#,
            server.uri()
        );
        Mock::given(method("GET"))
            .and(path("/appcast.xml"))
            .respond_with(ResponseTemplate::new(200).set_body_string(appcast))
            .mount(&server)
            .await;
        Mock::given(method("HEAD"))
            .and(path("/Codex-Beta.zip"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("ETag", "\"beta\"")
                    .insert_header("Content-Length", "42"),
            )
            .mount(&server)
            .await;

        let client = Client::builder().build()?;
        let installer =
            resolve_installer(&client, &test_config(&server.uri(), ReleaseTrack::Preview)).await?;

        assert_eq!(
            installer.download_url,
            format!("{}/Codex-Beta.zip", server.uri())
        );
        assert_eq!(installer.file_name, "Codex-Preview-26.506.31421.zip");
        assert!(installer
            .metadata
            .headers_fingerprint
            .contains("appcast=beta"));
        assert_eq!(installer.metadata.etag.as_deref(), Some("\"beta\""));
        Ok(())
    }

    #[test]
    fn parses_current_beta_appcast_shape() -> Result<()> {
        let release = parse_first_appcast_release(
            r#"<?xml version='1.0' encoding='utf-8'?>
<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" version="2.0">
  <channel>
    <title>Codex Updates (Public Beta)</title>
    <item>
      <title>26.506.31421</title>
      <pubDate>Fri, 08 May 2026 22:50:40 +0000</pubDate>
      <sparkle:version>2619</sparkle:version>
      <sparkle:shortVersionString>26.506.31421</sparkle:shortVersionString>
      <sparkle:hardwareRequirements>arm64</sparkle:hardwareRequirements>
      <enclosure url="https://persistent.oaistatic.com/codex-app-beta/Codex%20(Beta)-darwin-arm64-26.506.31421.zip" length="322081362" type="application/octet-stream" sparkle:edSignature="signature" />
      <sparkle:deltas>
        <enclosure url="https://persistent.oaistatic.com/codex-app-beta/Codex%20(Beta)2619-2603-arm64.delta" sparkle:deltaFrom="2603" length="11334418" />
      </sparkle:deltas>
    </item>
  </channel>
</rss>"#,
        )?;

        assert_eq!(release.version, "26.506.31421");
        assert_eq!(
            release.url,
            "https://persistent.oaistatic.com/codex-app-beta/Codex%20(Beta)-darwin-arm64-26.506.31421.zip"
        );
        Ok(())
    }

    #[test]
    fn rejects_cross_host_default_beta_enclosure() {
        let error = validate_appcast_release_url(
            "https://persistent.oaistatic.com/codex-app-beta/appcast.xml",
            "https://example.com/Codex-Beta.zip",
        )
        .expect_err("default beta appcast should not allow cross-host enclosures");
        assert!(error.to_string().contains("must use host"));
    }

    #[test]
    fn rejects_https_appcast_with_http_enclosure() {
        let error = validate_appcast_release_url(
            "https://example.com/appcast.xml",
            "http://example.com/Codex-Beta.zip",
        )
        .expect_err("https appcasts should not allow http enclosures");
        assert!(error.to_string().contains("must use HTTPS"));
    }

    #[tokio::test]
    async fn downloads_dmg_and_hashes_contents() -> Result<()> {
        let server = MockServer::start().await;
        let body = b"codex-dmg-test-payload";
        Mock::given(method("GET"))
            .and(path("/Codex.dmg"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(body.to_vec()))
            .mount(&server)
            .await;

        let client = Client::builder().build()?;
        let temp = tempdir()?;
        let downloaded = download_dmg(
            &client,
            &format!("{}/Codex.dmg", server.uri()),
            temp.path(),
            Utc.with_ymd_and_hms(2026, 3, 24, 12, 0, 0).unwrap(),
        )
        .await?;

        assert_eq!(downloaded.path, temp.path().join("Codex.dmg"));
        assert_eq!(
            downloaded.sha256,
            "678cd508ffe0071e217020a7a4eecbebe25362c022ac78c13a5ae87b7a3a0c92"
        );
        assert_eq!(downloaded.candidate_version, "2026.03.24.120000+678cd508");
        Ok(())
    }

    #[test]
    fn derive_candidate_version_rejects_short_hashes() {
        let error = derive_candidate_version("short", Utc::now()).expect_err("hash should fail");
        assert!(error.to_string().contains("sha256 is too short"));
    }
}
