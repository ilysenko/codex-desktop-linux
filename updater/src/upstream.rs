//! Upstream DMG metadata and download helpers.

use anyhow::{anyhow, Context, Result};
use chrono::{DateTime, Utc};
use futures_util::StreamExt;
use reqwest::{header, Client};
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

/// Downloads the upstream DMG and derives a package version from its hash.
pub async fn download_dmg(
    client: &Client,
    dmg_url: &str,
    destination_dir: &Path,
    version_timestamp: DateTime<Utc>,
) -> Result<DownloadedDmg> {
    tokio::fs::create_dir_all(destination_dir)
        .await
        .with_context(|| format!("Failed to create {}", destination_dir.display()))?;

    let response = client
        .get(dmg_url)
        .send()
        .await
        .with_context(|| format!("Failed GET request for {dmg_url}"))?
        .error_for_status()
        .with_context(|| format!("GET request for {dmg_url} returned an error status"))?;

    let destination = destination_dir.join("Codex.dmg");
    let temporary = tempfile::NamedTempFile::new_in(destination_dir).with_context(|| {
        format!(
            "Failed to create download staging file in {}",
            destination_dir.display()
        )
    })?;
    let (temporary_file, temporary_path) = temporary.into_parts();
    let mut file = File::from_std(temporary_file);

    let mut hasher = Sha256::new();
    let mut stream = response.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.with_context(|| format!("Failed downloading {dmg_url}"))?;
        file.write_all(&chunk)
            .await
            .with_context(|| format!("Failed writing {}", temporary_path.display()))?;
        hasher.update(&chunk);
    }

    file.flush()
        .await
        .with_context(|| format!("Failed flushing {}", temporary_path.display()))?;
    file.sync_all()
        .await
        .with_context(|| format!("Failed syncing {}", temporary_path.display()))?;

    let sha256 = hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let candidate_version = derive_candidate_version(&sha256, version_timestamp)?;

    drop(file);
    temporary_path.persist(&destination).with_context(|| {
        format!(
            "Failed to atomically replace {} with completed download",
            destination.display()
        )
    })?;

    Ok(DownloadedDmg {
        path: destination,
        sha256,
        candidate_version,
    })
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
        tokio::fs::write(temp.path().join("Codex.dmg"), b"old-dmg").await?;
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
        assert_eq!(tokio::fs::read(downloaded.path).await?, body);
        Ok(())
    }

    #[tokio::test]
    async fn failed_download_preserves_cached_dmg() -> Result<()> {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/Codex.dmg"))
            .respond_with(ResponseTemplate::new(503))
            .mount(&server)
            .await;

        let client = Client::builder().build()?;
        let temp = tempdir()?;
        let destination = temp.path().join("Codex.dmg");
        tokio::fs::write(&destination, b"known-good-dmg").await?;

        let error = download_dmg(
            &client,
            &format!("{}/Codex.dmg", server.uri()),
            temp.path(),
            Utc.with_ymd_and_hms(2026, 3, 24, 12, 0, 0).unwrap(),
        )
        .await
        .expect_err("HTTP error should fail the download");

        assert!(error.to_string().contains("returned an error status"));
        assert_eq!(tokio::fs::read(&destination).await?, b"known-good-dmg");
        assert_eq!(std::fs::read_dir(temp.path())?.count(), 1);
        Ok(())
    }

    #[tokio::test]
    async fn interrupted_download_preserves_cached_dmg() -> Result<()> {
        use std::io::{Read, Write};

        let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
        let address = listener.local_addr()?;
        let server = std::thread::spawn(move || -> std::io::Result<()> {
            let (mut stream, _) = listener.accept()?;
            let mut request = [0; 1024];
            let _ = stream.read(&mut request)?;
            stream.write_all(
                b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\npartial",
            )?;
            Ok(())
        });

        let client = Client::builder().build()?;
        let temp = tempdir()?;
        let destination = temp.path().join("Codex.dmg");
        tokio::fs::write(&destination, b"known-good-dmg").await?;

        download_dmg(
            &client,
            &format!("http://{address}/Codex.dmg"),
            temp.path(),
            Utc.with_ymd_and_hms(2026, 3, 24, 12, 0, 0).unwrap(),
        )
        .await
        .expect_err("truncated response should fail the download");
        server.join().expect("test server should not panic")?;

        assert_eq!(tokio::fs::read(&destination).await?, b"known-good-dmg");
        assert_eq!(std::fs::read_dir(temp.path())?.count(), 1);
        Ok(())
    }

    #[test]
    fn derive_candidate_version_rejects_short_hashes() {
        let error = derive_candidate_version("short", Utc::now()).expect_err("hash should fail");
        assert!(error.to_string().contains("sha256 is too short"));
    }
}
