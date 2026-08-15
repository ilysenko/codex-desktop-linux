use anyhow::{bail, Context, Result};
use chrono::Utc;
use codex_computer_use_linux::{atspi_tree, diagnostics::DoctorReport, screenshot, windowing};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
};

use crate::browser_observation;

use crate::{
    backends::{
        available_recorders, recording_backend_catalog, recording_backend_observation,
        RecordingBackend,
    },
    manifest::{
        write_manifest, ACCESSIBILITY_DIR_NAME, AUDIO_DIR_NAME, BROWSER_DIR_NAME,
        DIAGNOSTICS_FILE_NAME, INPUT_CAPTURE_DIR_NAME, SCREENSHOTS_DIR_NAME, TIMELINE_FILE_NAME,
        TRANSCRIPTS_DIR_NAME, X11_DIR_NAME,
    },
    timeline::{append_timeline_record, TimelineEvent},
    RecordingBundleManifest,
};

#[derive(Debug, Clone)]
pub struct RecordStartOptions {
    pub session_dir: PathBuf,
    pub app_id: Option<String>,
    pub window_id: Option<String>,
    pub goal: Option<String>,
    pub include_screenshot: bool,
    pub include_accessibility: bool,
    pub include_audio: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct RecordStartReport {
    pub ok: bool,
    pub command: &'static str,
    pub session_dir: PathBuf,
    pub manifest: RecordingBundleManifest,
    pub backend_catalog: Vec<RecordingBackend>,
    pub warnings: Vec<String>,
}

pub async fn start_session(options: RecordStartOptions) -> Result<RecordStartReport> {
    crate::secure_fs::create_new_private_dir(&options.session_dir)?;
    for dir in [
        SCREENSHOTS_DIR_NAME,
        ACCESSIBILITY_DIR_NAME,
        BROWSER_DIR_NAME,
        TRANSCRIPTS_DIR_NAME,
        AUDIO_DIR_NAME,
        INPUT_CAPTURE_DIR_NAME,
        X11_DIR_NAME,
    ] {
        crate::secure_fs::create_private_dir_all(&options.session_dir.join(dir))
            .with_context(|| format!("failed to create bundle directory {dir}"))?;
    }
    crate::secure_fs::write_private_file(&options.session_dir.join(TIMELINE_FILE_NAME), "")
        .with_context(|| "failed to initialize timeline")?;
    crate::secure_fs::write_private_file(
        &options
            .session_dir
            .join(crate::manifest::EVENT_STREAM_EVENTS_FILE_NAME),
        "",
    )
    .with_context(|| "failed to initialize event-stream events")?;

    codex_computer_use_linux::diagnostics::hydrate_session_bus_env();
    let diagnostics = codex_computer_use_linux::diagnostics::doctor_report();
    let backend_catalog = recording_backend_catalog(&diagnostics);
    crate::secure_fs::write_private_file(
        &options.session_dir.join(DIAGNOSTICS_FILE_NAME),
        format!("{}\n", serde_json::to_string_pretty(&diagnostics)?),
    )
    .with_context(|| "failed to write diagnostics snapshot")?;

    let mut manifest =
        RecordingBundleManifest::new(session_id(&options.session_dir), now_timestamp());
    manifest.goal = options.goal.clone();
    manifest.target.app_id = options.app_id.clone();
    manifest.target.window_id = options.window_id.clone();
    manifest.backend_catalog = backend_catalog.clone();
    manifest.recorders = available_recorders(&manifest.backend_catalog);

    write_manifest(&options.session_dir, &manifest)?;
    append_timeline_record(
        &options.session_dir,
        TimelineEvent::SessionStarted {
            goal: options.goal.clone(),
        },
    )?;
    append_timeline_record(
        &options.session_dir,
        recording_backend_observation(&diagnostics),
    )?;
    for event in capture_startup_provider_evidence(
        &options.session_dir,
        &diagnostics,
        &manifest.backend_catalog,
        options.app_id.as_deref(),
        options.window_id.as_deref(),
    )? {
        append_timeline_record(&options.session_dir, event)?;
    }

    let mut warnings = Vec::new();
    if options.include_screenshot {
        match capture_initial_screenshot(&options.session_dir).await {
            Ok(Some(event)) => {
                append_timeline_record(&options.session_dir, event)?;
            }
            Ok(None) => {}
            Err(error) => {
                let message = error.to_string();
                warnings.push(message.clone());
                append_timeline_record(
                    &options.session_dir,
                    TimelineEvent::Diagnostic {
                        level: "warn".to_string(),
                        message,
                    },
                )?;
            }
        }
    }

    if options.include_accessibility {
        match capture_initial_accessibility(&options.session_dir, options.app_id.as_deref()).await {
            Ok(Some(event)) => {
                append_timeline_record(&options.session_dir, event)?;
            }
            Ok(None) => {}
            Err(error) => {
                let message = error.to_string();
                warnings.push(message.clone());
                append_timeline_record(
                    &options.session_dir,
                    TimelineEvent::Diagnostic {
                        level: "warn".to_string(),
                        message,
                    },
                )?;
            }
        }
    }

    if options.include_audio {
        match crate::audio::start_audio_capture(&options.session_dir) {
            Ok(report) => {
                if !report.ok && report.status != "disabled" {
                    if let Some(message) = report.message.clone() {
                        warnings.push(message);
                    }
                }
                append_timeline_record(
                    &options.session_dir,
                    crate::audio::audio_timeline_event(&report),
                )?;
            }
            Err(error) => {
                let message = error.to_string();
                warnings.push(message.clone());
                append_timeline_record(
                    &options.session_dir,
                    TimelineEvent::Diagnostic {
                        level: "warn".to_string(),
                        message,
                    },
                )?;
            }
        }
    }

    if let Err(error) =
        crate::runtime_status::write_active_status(&options.session_dir, options.goal.clone())
    {
        let message = format!("failed to update recording status: {error}");
        warnings.push(message.clone());
        append_timeline_record(
            &options.session_dir,
            TimelineEvent::Diagnostic {
                level: "warn".to_string(),
                message,
            },
        )?;
    }

    if !warnings.is_empty() {
        manifest.warnings = warnings.clone();
        write_manifest(&options.session_dir, &manifest)?;
    }

    Ok(RecordStartReport {
        ok: true,
        command: "record.start",
        session_dir: options.session_dir,
        manifest,
        backend_catalog,
        warnings,
    })
}

pub fn mark_session(bundle_dir: &Path, note: &str) -> Result<crate::timeline::TimelineRecord> {
    let _lock = crate::secure_fs::lock_directory(bundle_dir, ".recording.lock")?;
    ensure_bundle_open(bundle_dir)?;
    let record = append_timeline_record(
        bundle_dir,
        TimelineEvent::UserMarker {
            note: note.to_string(),
        },
    )?;
    let _ = crate::runtime_status::update_active_status_for(Some(bundle_dir), "mark");
    Ok(record)
}

pub fn record_speech_context(
    bundle_dir: &Path,
    transcript: &str,
    source: Option<String>,
) -> Result<crate::timeline::TimelineRecord> {
    let _lock = crate::secure_fs::lock_directory(bundle_dir, ".recording.lock")?;
    ensure_bundle_open(bundle_dir)?;
    let transcripts_dir = bundle_dir.join(TRANSCRIPTS_DIR_NAME);
    crate::secure_fs::create_private_dir_all(&transcripts_dir)
        .with_context(|| format!("failed to create {}", transcripts_dir.display()))?;
    let relative = format!(
        "{TRANSCRIPTS_DIR_NAME}/{:04}.txt",
        next_artifact_index(&transcripts_dir)?
    );
    crate::secure_fs::write_private_file(&bundle_dir.join(&relative), format!("{transcript}\n"))
        .with_context(|| format!("failed to write transcript {relative}"))?;
    let record = append_timeline_record(
        bundle_dir,
        TimelineEvent::SpeechContext {
            transcript: transcript.to_string(),
            file: Some(relative),
            source,
        },
    )?;
    let _ = crate::runtime_status::update_active_status_for(Some(bundle_dir), "speech_context");
    Ok(record)
}

pub fn record_browser_trace(
    bundle_dir: &Path,
    trace: Value,
    url: Option<String>,
    title: Option<String>,
    source: Option<String>,
) -> Result<crate::timeline::TimelineRecord> {
    let _lock = crate::secure_fs::lock_directory(bundle_dir, ".recording.lock")?;
    ensure_bundle_open(bundle_dir)?;
    let browser_dir = bundle_dir.join(BROWSER_DIR_NAME);
    crate::secure_fs::create_private_dir_all(&browser_dir)
        .with_context(|| format!("failed to create {}", browser_dir.display()))?;
    let relative = format!(
        "{BROWSER_DIR_NAME}/{:04}-trace.json",
        next_artifact_index(&browser_dir)?
    );
    crate::secure_fs::write_private_file(
        &bundle_dir.join(&relative),
        format!("{}\n", serde_json::to_string_pretty(&trace)?),
    )
    .with_context(|| format!("failed to write browser trace {relative}"))?;
    let record = append_timeline_record(
        bundle_dir,
        TimelineEvent::BrowserTrace {
            file: relative,
            url,
            title,
            source,
        },
    )?;
    let _ = crate::runtime_status::update_active_status_for(Some(bundle_dir), "browser_trace");
    Ok(record)
}

pub async fn record_desktop_snapshot(
    bundle_dir: &Path,
    source: Option<String>,
) -> Result<crate::timeline::TimelineRecord> {
    let recorded_at = now_timestamp();
    let windows = windowing::list_windows()
        .await
        .with_context(|| "failed to list desktop windows")?;
    record_desktop_snapshot_from_windows(bundle_dir, recorded_at, source, windows)
}

fn record_desktop_snapshot_from_windows(
    bundle_dir: &Path,
    recorded_at: String,
    source: Option<String>,
    windows: Vec<windowing::WindowInfo>,
) -> Result<crate::timeline::TimelineRecord> {
    let _lock = crate::secure_fs::lock_directory(bundle_dir, ".recording.lock")?;
    ensure_bundle_open(bundle_dir)?;
    let x11_dir = bundle_dir.join(X11_DIR_NAME);
    crate::secure_fs::create_private_dir_all(&x11_dir)
        .with_context(|| format!("failed to create {}", x11_dir.display()))?;
    let focused_window = windows.iter().find(|window| window.focused).cloned();
    let visible_windows = windows
        .into_iter()
        .filter(|window| !window.hidden)
        .collect::<Vec<_>>();
    let window_count = visible_windows.len();
    let browser_observations = browser_observation::observations_from_windows(&visible_windows);
    let focused_browser_observation = browser_observations
        .iter()
        .find(|observation| observation.focused)
        .or_else(|| browser_observations.first());
    let browser_observation_count = browser_observations.len();
    let relative = format!(
        "{X11_DIR_NAME}/{:04}-desktop-snapshot.json",
        next_artifact_index(&x11_dir)?
    );
    crate::secure_fs::write_private_file(
        &bundle_dir.join(&relative),
        format!(
            "{}\n",
            serde_json::to_string_pretty(&json!({
                "schema_version": 1,
                "provider": "window-metadata",
                "captured_at": recorded_at,
                "source": source.as_deref(),
                "windows": &visible_windows,
                "focused_window": focused_window.as_ref(),
                "window_count": window_count,
                "browser_observations": &browser_observations,
                "browser_observation_count": browser_observation_count,
                "focused_browser_observation": focused_browser_observation,
            }))?
        ),
    )
    .with_context(|| format!("failed to write desktop snapshot {relative}"))?;
    let record = append_timeline_record(
        bundle_dir,
        TimelineEvent::DesktopSnapshot {
            file: relative,
            window_count,
            browser_observation_count,
            focused_window_title: focused_window
                .as_ref()
                .and_then(|window| window.title.clone()),
            focused_window_app_id: focused_window
                .as_ref()
                .and_then(|window| window.app_id.clone()),
            focused_window_wm_class: focused_window
                .as_ref()
                .and_then(|window| window.wm_class.clone()),
            focused_browser_name: focused_browser_observation
                .map(|observation| observation.browser.clone()),
            focused_browser_title: focused_browser_observation
                .and_then(|observation| observation.title.clone()),
            focused_browser_url: focused_browser_observation
                .and_then(|observation| observation.url.clone()),
            focused_browser_domain: focused_browser_observation
                .and_then(|observation| observation.domain.clone()),
            focused_browser_url_source: focused_browser_observation
                .and_then(|observation| observation.url_source.clone()),
            source,
        },
    )?;
    let _ = crate::runtime_status::update_active_status_for(Some(bundle_dir), "desktop_snapshot");
    Ok(record)
}

pub fn stop_session(bundle_dir: &Path) -> Result<crate::timeline::TimelineRecord> {
    if crate::runtime_status::expired_status_for(bundle_dir) {
        return expire_session(bundle_dir);
    }
    finalize_session(
        bundle_dir,
        "recording_controls_stopped",
        TimelineEvent::SessionStopped,
        crate::runtime_status::write_stopped_status,
    )
}

pub fn cancel_session(
    bundle_dir: &Path,
    discarded: bool,
) -> Result<crate::timeline::TimelineRecord> {
    if crate::runtime_status::expired_status_for(bundle_dir) {
        return expire_session(bundle_dir);
    }
    let end_reason = if discarded {
        "recording_controls_cancelled_discarded"
    } else {
        "recording_controls_cancelled"
    };
    finalize_session(
        bundle_dir,
        end_reason,
        TimelineEvent::SessionCancelled { discarded },
        |session_dir| crate::runtime_status::write_canceled_status(session_dir, discarded),
    )
}

pub fn expire_session(bundle_dir: &Path) -> Result<crate::timeline::TimelineRecord> {
    finalize_session(
        bundle_dir,
        "max_duration",
        TimelineEvent::SessionExpired,
        crate::runtime_status::write_expired_status,
    )
}

pub(crate) fn stop_owned_skysight_for_session(bundle_dir: &Path, source: &str) -> Result<()> {
    let manifest = crate::manifest::read_manifest(bundle_dir)?;
    stop_owned_skysight_for_session_id(&manifest.session_id, source)
}

fn stop_owned_skysight_for_session_id(session_id: &str, source: &str) -> Result<()> {
    let owner = format!("recording-session:{session_id}");
    let paths = crate::skysight::SkysightPaths::from_env();
    let _ = crate::skysight::stop_skysight_if_owned(&paths, &owner, source)?;
    Ok(())
}

fn skysight_cleanup_source(end_reason: &str) -> &'static str {
    match end_reason {
        "recording_controls_stopped" => "event-stream-stop",
        "recording_controls_cancelled" | "recording_controls_cancelled_discarded" => {
            "event-stream-cancel"
        }
        "max_duration" => "event-stream-expiry",
        _ => "recording-session-end",
    }
}

pub fn ranked_recorders(diagnostics: &DoctorReport) -> Vec<String> {
    let catalog = recording_backend_catalog(diagnostics);
    available_recorders(&catalog)
}

async fn capture_initial_screenshot(bundle_dir: &Path) -> Result<Option<TimelineEvent>> {
    let raw = screenshot::capture_screenshot_raw().await?;
    let extension = if raw.mime_type == "image/jpeg" {
        "jpg"
    } else {
        "png"
    };
    let relative = format!("{SCREENSHOTS_DIR_NAME}/0000.{extension}");
    crate::secure_fs::write_private_file(&bundle_dir.join(&relative), raw.bytes)
        .with_context(|| format!("failed to write screenshot {relative}"))?;
    Ok(Some(TimelineEvent::Screenshot {
        file: relative,
        source: Some(raw.source),
    }))
}

async fn capture_initial_accessibility(
    bundle_dir: &Path,
    app_id: Option<&str>,
) -> Result<Option<TimelineEvent>> {
    let nodes = atspi_tree::snapshot_tree(app_id, None, 120, 12).await?;
    let relative = format!("{ACCESSIBILITY_DIR_NAME}/0000.json");
    crate::secure_fs::write_private_file(
        &bundle_dir.join(&relative),
        format!("{}\n", serde_json::to_string_pretty(&nodes)?),
    )
    .with_context(|| format!("failed to write accessibility snapshot {relative}"))?;
    Ok(Some(TimelineEvent::AccessibilitySnapshot {
        file: relative,
        count: nodes.len(),
    }))
}

fn capture_startup_provider_evidence(
    bundle_dir: &Path,
    diagnostics: &DoctorReport,
    backend_catalog: &[RecordingBackend],
    app_id: Option<&str>,
    window_id: Option<&str>,
) -> Result<Vec<TimelineEvent>> {
    let browser = backend_by_id(backend_catalog, "browser-trace");
    let input_capture = backend_by_id(backend_catalog, "input-capture-libei");
    let window_metadata = backend_by_id(backend_catalog, "window-metadata");
    let x11 = backend_by_id(backend_catalog, "x11-recording");

    Ok(vec![
        write_provider_evidence(
            bundle_dir,
            BROWSER_DIR_NAME,
            "browser-trace",
            "0000-readiness.json",
            browser,
            Some("startup".to_string()),
            json!({
                "schema_version": 1,
                "provider": "browser-trace",
                "captured_at": now_timestamp(),
                "backend": browser,
                "cdp": {
                    "status": "ready_for_trace_ingest",
                    "entrypoint": "record browser-trace",
                    "notes": [
                        "Browser traces are semantic evidence for skill drafting.",
                        "Replay remains skill-driven; traces are not coordinate macros."
                    ],
                },
            }),
        )?,
        write_provider_evidence(
            bundle_dir,
            INPUT_CAPTURE_DIR_NAME,
            "input-capture-libei",
            "0000-readiness.json",
            input_capture,
            Some("computer-use-doctor".to_string()),
            json!({
                "schema_version": 1,
                "provider": "input-capture-libei",
                "captured_at": now_timestamp(),
                "backend": input_capture,
                "portal_input_capture": diagnostics.portals.input_capture,
                "session": {
                    "xdg_session_type": diagnostics.platform.xdg_session_type,
                    "xdg_current_desktop": diagnostics.platform.xdg_current_desktop,
                },
                "input_capabilities": diagnostics.capabilities.input,
                "preferred_input": diagnostics.capabilities.preferred.input,
                "notes": [
                    "InputCapture/libei readiness is captured for tester diagnostics.",
                    "This bundle does not replay raw captured input events."
                ],
            }),
        )?,
        write_provider_evidence(
            bundle_dir,
            X11_DIR_NAME,
            "x11-recording",
            "0000-session.json",
            x11,
            Some("computer-use-doctor".to_string()),
            json!({
                "schema_version": 1,
                "provider": "x11-recording",
                "captured_at": now_timestamp(),
                "backend": x11,
                "session": {
                    "xdg_session_type": diagnostics.platform.xdg_session_type,
                    "xdg_current_desktop": diagnostics.platform.xdg_current_desktop,
                    "display": diagnostics.platform.display,
                    "xauthority_present": diagnostics.platform.xauthority.is_some(),
                },
                "window_capabilities": diagnostics.capabilities.window_control,
                "windowing_readiness": {
                    "can_query_windows": diagnostics.readiness.can_query_windows,
                    "can_focus_apps": diagnostics.readiness.can_focus_apps,
                    "can_focus_windows": diagnostics.readiness.can_focus_windows,
                },
                "notes": [
                    "X11 evidence records session/window metadata for Linux-specific drafting.",
                    "Replay remains semantic through skills and Computer Use."
                ],
            }),
        )?,
        write_provider_evidence(
            bundle_dir,
            X11_DIR_NAME,
            "window-metadata",
            "0001-window-metadata.json",
            window_metadata,
            Some("computer-use-doctor".to_string()),
            json!({
                "schema_version": 1,
                "provider": "window-metadata",
                "captured_at": now_timestamp(),
                "backend": window_metadata,
                "target": {
                    "requested_app_id": app_id,
                    "requested_window_id": window_id,
                },
                "windowing_readiness": {
                    "can_list_windows": diagnostics.windowing.can_list_windows,
                    "can_query_windows": diagnostics.readiness.can_query_windows,
                    "can_focus_apps": diagnostics.readiness.can_focus_apps,
                    "can_focus_windows": diagnostics.readiness.can_focus_windows,
                },
                "window_capabilities": diagnostics.capabilities.window_control,
                "notes": [
                    "Window and app metadata is captured as evidence for skill drafting.",
                    "Replay should target semantic app/window selectors through Computer Use."
                ],
            }),
        )?,
    ])
}

fn write_provider_evidence(
    bundle_dir: &Path,
    dir_name: &str,
    provider: &str,
    file_name: &str,
    backend: Option<&RecordingBackend>,
    source: Option<String>,
    data: Value,
) -> Result<TimelineEvent> {
    let provider_dir = bundle_dir.join(dir_name);
    crate::secure_fs::create_private_dir_all(&provider_dir)
        .with_context(|| format!("failed to create {}", provider_dir.display()))?;
    let relative = format!("{dir_name}/{file_name}");
    crate::secure_fs::write_private_file(
        &bundle_dir.join(&relative),
        format!("{}\n", serde_json::to_string_pretty(&data)?),
    )
    .with_context(|| format!("failed to write provider evidence {relative}"))?;
    Ok(TimelineEvent::ProviderEvidence {
        provider: provider.to_string(),
        file: relative,
        status: backend_status_label(backend),
        source,
    })
}

fn backend_by_id<'a>(
    backend_catalog: &'a [RecordingBackend],
    id: &str,
) -> Option<&'a RecordingBackend> {
    backend_catalog.iter().find(|backend| backend.id == id)
}

fn backend_status_label(backend: Option<&RecordingBackend>) -> String {
    match backend.map(|backend| backend.status) {
        Some(crate::RecordingBackendStatus::Available) => "available".to_string(),
        Some(crate::RecordingBackendStatus::Missing) => "missing".to_string(),
        None => "unknown".to_string(),
    }
}

pub fn now_timestamp() -> String {
    Utc::now().to_rfc3339()
}

fn session_id(session_dir: &Path) -> String {
    session_dir
        .file_name()
        .and_then(|name| name.to_str())
        .map(sanitize_id)
        .filter(|id| !id.is_empty())
        .unwrap_or_else(|| format!("recording-{}", Utc::now().timestamp()))
}

fn sanitize_id(value: &str) -> String {
    value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string()
}

fn next_artifact_index(dir: &Path) -> Result<usize> {
    let mut max_index = None;
    for entry in fs::read_dir(dir).with_context(|| format!("failed to read {}", dir.display()))? {
        let entry = entry?;
        let path = entry.path();
        let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) else {
            continue;
        };
        let numeric_prefix = stem.split('-').next().unwrap_or(stem);
        if let Ok(index) = numeric_prefix.parse::<usize>() {
            max_index = Some(max_index.map_or(index, |current: usize| current.max(index)));
        }
    }
    Ok(max_index.map_or(0, |index| index + 1))
}

fn finalize_session(
    bundle_dir: &Path,
    end_reason: &'static str,
    event: TimelineEvent,
    update_status: impl FnOnce(&Path) -> Result<crate::runtime_status::RecordingRuntimeStatus>,
) -> Result<crate::timeline::TimelineRecord> {
    let _lock = crate::secure_fs::lock_directory(bundle_dir, ".recording.lock")?;
    let mut manifest = crate::manifest::read_manifest(bundle_dir)?;
    if let Some(existing_reason) = manifest.end_reason.as_deref() {
        bail!("recording bundle is already sealed: {existing_reason}");
    }
    manifest.ended_at = Some(now_timestamp());
    manifest.end_reason = Some(end_reason.to_string());
    write_manifest(bundle_dir, &manifest)?;
    match crate::audio::stop_audio_capture(bundle_dir, end_reason) {
        Ok(Some(report)) => {
            append_timeline_record(bundle_dir, crate::audio::audio_timeline_event(&report))?;
        }
        Ok(None) => {}
        Err(error) => {
            append_timeline_record(
                bundle_dir,
                TimelineEvent::Diagnostic {
                    level: "warn".to_string(),
                    message: format!("failed to stop audio capture: {error}"),
                },
            )?;
        }
    }
    let record = append_timeline_record(bundle_dir, event)?;
    if let Err(error) = stop_owned_skysight_for_session_id(
        &manifest.session_id,
        skysight_cleanup_source(end_reason),
    ) {
        let _ = append_timeline_record(
            bundle_dir,
            TimelineEvent::Diagnostic {
                level: "warn".to_string(),
                message: format!("failed to stop session-owned Skysight capture: {error}"),
            },
        );
    }
    let _ = update_status(bundle_dir);
    Ok(record)
}

fn ensure_bundle_open(bundle_dir: &Path) -> Result<()> {
    let manifest = crate::manifest::read_manifest(bundle_dir)?;
    if let Some(reason) = manifest.end_reason.as_deref() {
        bail!("recording bundle is sealed: {reason}");
    }
    let status = crate::runtime_status::read_runtime_status();
    if status.session_dir.as_deref() == Some(bundle_dir)
        && matches!(
            status.state,
            crate::runtime_status::RecordingRuntimeState::Expired
        )
    {
        bail!("recording bundle is expired");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status_env_guard() -> std::sync::MutexGuard<'static, ()> {
        crate::test_support::env_guard()
    }

    fn window(title: &str, app_id: &str, wm_class: &str) -> windowing::WindowInfo {
        windowing::WindowInfo {
            window_id: 42,
            title: Some(title.to_string()),
            app_id: Some(app_id.to_string()),
            wm_class: Some(wm_class.to_string()),
            pid: Some(1234),
            bounds: None,
            workspace: Some(0),
            focused: true,
            hidden: false,
            client_type: Some("wayland".to_string()),
            backend: "test".to_string(),
            terminal: None,
        }
    }

    #[test]
    fn desktop_snapshot_writes_focused_window_bundle_evidence() {
        let _guard = status_env_guard();
        let temp = tempfile::tempdir().unwrap();
        let previous = std::env::var_os("CODEX_RECORD_REPLAY_STATUS_PATH");
        std::env::set_var(
            "CODEX_RECORD_REPLAY_STATUS_PATH",
            temp.path().join("status.json"),
        );
        let root = temp.path().join("bundle");
        crate::secure_fs::create_private_dir_all(&root).unwrap();
        crate::secure_fs::create_private_dir_all(&root.join(X11_DIR_NAME)).unwrap();
        crate::secure_fs::write_private_file(&root.join(TIMELINE_FILE_NAME), "").unwrap();
        write_manifest(
            &root,
            &RecordingBundleManifest::new(
                "desktop-snapshot".to_string(),
                "2026-06-30T12:00:00Z".to_string(),
            ),
        )
        .unwrap();

        let record = record_desktop_snapshot_from_windows(
            &root,
            "2026-06-30T12:01:00Z".to_string(),
            Some("record-replay-hud".to_string()),
            vec![window(
                "Image Studio - Google Chrome",
                "google-chrome",
                "Google-chrome",
            )],
        )
        .unwrap();

        assert!(record.validate().is_valid());
        assert!(matches!(
            &record.event,
            TimelineEvent::DesktopSnapshot {
                file,
                window_count: 1,
                browser_observation_count: 1,
                focused_window_title,
                focused_window_app_id,
                focused_window_wm_class,
                focused_browser_name,
                focused_browser_title,
                focused_browser_url,
                focused_browser_domain,
                focused_browser_url_source,
                source,
            } if file == "x11/0000-desktop-snapshot.json"
                  && focused_window_title.as_deref() == Some("Image Studio - Google Chrome")
                && focused_window_app_id.as_deref() == Some("google-chrome")
                && focused_window_wm_class.as_deref() == Some("Google-chrome")
                && focused_browser_name.as_deref() == Some("Google Chrome")
                && focused_browser_title.as_deref() == Some("Image Studio - Google Chrome")
                && focused_browser_url.is_none()
                && focused_browser_domain.is_none()
                && focused_browser_url_source.is_none()
                && source.as_deref() == Some("record-replay-hud")
        ));
        let artifact = fs::read_to_string(root.join("x11/0000-desktop-snapshot.json")).unwrap();
        assert!(artifact.contains("Image Studio - Google Chrome"));
        assert!(artifact.contains("google-chrome"));
        assert!(!artifact.contains("image-studio.example"));

        match previous {
            Some(path) => std::env::set_var("CODEX_RECORD_REPLAY_STATUS_PATH", path),
            None => std::env::remove_var("CODEX_RECORD_REPLAY_STATUS_PATH"),
        }
    }
}
