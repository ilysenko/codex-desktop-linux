//! Upstream DMG metadata and download helpers.

use anyhow::{anyhow, Context, Result};
use chrono::{DateTime, Utc};
use futures_util::StreamExt;
use reqwest::{header, Client};
use sha2::{Digest, Sha256};
use std::time::Duration;
use std::{
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};
use tokio::{fs::OpenOptions, io::AsyncWriteExt};

const HTTP_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const HTTP_READ_TIMEOUT: Duration = Duration::from_secs(60);
const DOWNLOAD_TEMP_PREFIX: &str = ".Codex.dmg.download-";
static DOWNLOAD_TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

struct DownloadTempFile {
    path: PathBuf,
}

impl DownloadTempFile {
    fn commit(mut self) {
        self.path = PathBuf::new();
    }
}

impl Drop for DownloadTempFile {
    fn drop(&mut self) {
        if !self.path.as_os_str().is_empty() {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

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

/// Builds the HTTP client shared by upstream metadata and DMG requests.
pub fn http_client() -> Result<Client> {
    Client::builder()
        .connect_timeout(HTTP_CONNECT_TIMEOUT)
        .read_timeout(HTTP_READ_TIMEOUT)
        .build()
        .context("Failed to build upstream HTTP client")
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
    let (temp, mut file) = create_download_temp(destination_dir).await?;

    let mut hasher = Sha256::new();
    let mut stream = response.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.with_context(|| format!("Failed downloading {dmg_url}"))?;
        file.write_all(&chunk)
            .await
            .with_context(|| format!("Failed writing {}", temp.path.display()))?;
        hasher.update(&chunk);
    }

    file.flush()
        .await
        .with_context(|| format!("Failed flushing {}", temp.path.display()))?;
    file.sync_all()
        .await
        .with_context(|| format!("Failed syncing {}", temp.path.display()))?;
    drop(file);

    let sha256 = hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let candidate_version = derive_candidate_version(&sha256, version_timestamp)?;

    tokio::fs::rename(&temp.path, &destination)
        .await
        .with_context(|| {
            format!(
                "Failed to atomically replace {} with completed download",
                destination.display()
            )
        })?;
    temp.commit();

    Ok(DownloadedDmg {
        path: destination,
        sha256,
        candidate_version,
    })
}

async fn create_download_temp(
    destination_dir: &Path,
) -> Result<(DownloadTempFile, tokio::fs::File)> {
    loop {
        let id = DOWNLOAD_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = destination_dir.join(format!(
            "{DOWNLOAD_TEMP_PREFIX}{}-{id}.tmp",
            std::process::id()
        ));
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .await
        {
            Ok(file) => return Ok((DownloadTempFile { path }, file)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(error).with_context(|| format!("Failed to create {}", path.display()))
            }
        }
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
    use std::{
        io::{Read, Write},
        net::TcpListener,
        thread,
        time::Duration,
    };
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
        std::fs::write(temp.path().join("Codex.dmg"), b"old-valid-cache")?;
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
        assert_eq!(std::fs::read(&downloaded.path)?, body);
        assert_no_download_temps(temp.path())?;
        Ok(())
    }

    #[tokio::test]
    async fn http_error_preserves_existing_dmg() -> Result<()> {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/Codex.dmg"))
            .respond_with(ResponseTemplate::new(503))
            .mount(&server)
            .await;

        let temp = tempdir()?;
        let destination = temp.path().join("Codex.dmg");
        std::fs::write(&destination, b"old-valid-cache")?;
        let error = download_dmg(
            &Client::builder().build()?,
            &format!("{}/Codex.dmg", server.uri()),
            temp.path(),
            Utc::now(),
        )
        .await
        .expect_err("error response should fail");

        assert!(error.to_string().contains("returned an error status"));
        assert_eq!(std::fs::read(destination)?, b"old-valid-cache");
        assert_no_download_temps(temp.path())?;
        Ok(())
    }

    #[tokio::test]
    async fn interrupted_body_preserves_existing_dmg_and_cleans_temp() -> Result<()> {
        let listener = TcpListener::bind("127.0.0.1:0")?;
        let address = listener.local_addr()?;
        let server = thread::spawn(move || -> std::io::Result<()> {
            let (mut connection, _) = listener.accept()?;
            let mut request = [0_u8; 1024];
            let mut request_len = 0;
            while request_len < request.len() {
                let read = connection.read(&mut request[request_len..])?;
                if read == 0 {
                    break;
                }
                request_len += read;
                if request[..request_len]
                    .windows(4)
                    .any(|window| window == b"\r\n\r\n")
                {
                    break;
                }
            }
            connection.write_all(
                b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\n",
            )?;
            connection.flush()?;
            thread::sleep(Duration::from_millis(100));
            connection.write_all(b"partial")?;
            connection.flush()?;
            thread::sleep(Duration::from_millis(100));
            Ok(())
        });

        let temp = tempdir()?;
        let destination = temp.path().join("Codex.dmg");
        std::fs::write(&destination, b"old-valid-cache")?;
        let result = download_dmg(
            &Client::builder().build()?,
            &format!("http://{address}/Codex.dmg"),
            temp.path(),
            Utc::now(),
        )
        .await;
        server.join().expect("test server thread panicked")?;

        assert!(result.is_err(), "truncated body should fail");
        assert_eq!(std::fs::read(destination)?, b"old-valid-cache");
        assert_no_download_temps(temp.path())?;
        Ok(())
    }

    fn assert_no_download_temps(directory: &Path) -> Result<()> {
        let leftovers = std::fs::read_dir(directory)?
            .filter_map(|entry| entry.ok())
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(DOWNLOAD_TEMP_PREFIX)
            })
            .collect::<Vec<_>>();
        assert!(leftovers.is_empty(), "temporary downloads remain");
        Ok(())
    }

    #[test]
    fn derive_candidate_version_rejects_short_hashes() {
        let error = derive_candidate_version("short", Utc::now()).expect_err("hash should fail");
        assert!(error.to_string().contains("sha256 is too short"));
    }
}
