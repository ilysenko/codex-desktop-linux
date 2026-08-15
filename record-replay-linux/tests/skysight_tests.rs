use codex_record_replay_linux::{
    capture_skysight_snapshot, list_skysight_exclusions, pause_skysight, resume_skysight,
    skysight_status, stop_skysight, stop_skysight_if_owned, update_skysight_exclusion,
    SkysightExclusionUpdate, SkysightPaths,
};
use serde_json::Value;
use std::{
    collections::BTreeSet,
    env, fs,
    os::unix::fs::PermissionsExt,
    path::Path,
    sync::{Mutex, OnceLock},
};

fn env_guard() -> std::sync::MutexGuard<'static, ()> {
    static ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    ENV_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap()
}

fn restore_env(key: &str, value: Option<std::ffi::OsString>) {
    match value {
        Some(value) => env::set_var(key, value),
        None => env::remove_var(key),
    }
}

fn write_running_status(paths: &SkysightPaths, owner: &str, source: &str) {
    let mut status = skysight_status(paths).unwrap();
    status.state = "running".to_string();
    status.is_running = true;
    status.owner = Some(owner.to_string());
    status.source = Some(source.to_string());
    fs::write(
        &paths.status_path,
        format!("{}\n", serde_json::to_string_pretty(&status).unwrap()),
    )
    .unwrap();
}

#[test]
fn skysight_owned_stop_records_owner_and_initiating_source() {
    let temp = tempfile::tempdir().unwrap();
    let paths = SkysightPaths::new(temp.path().join("runtime"), temp.path().join("resources"));
    write_running_status(&paths, "recording-session:fixture", "event-stream-start");

    let stopped = stop_skysight_if_owned(&paths, "recording-session:fixture", "event-stream-stop")
        .unwrap()
        .expect("matching session owner should be stopped");

    assert!(!stopped.is_running);
    assert_eq!(stopped.owner.as_deref(), Some("recording-session:fixture"));
    assert_eq!(stopped.source.as_deref(), Some("event-stream-stop"));
    assert!(paths.stop_request_path.is_file());
}

#[test]
fn skysight_owned_stop_does_not_stop_manual_continuous_capture() {
    let temp = tempfile::tempdir().unwrap();
    let paths = SkysightPaths::new(temp.path().join("runtime"), temp.path().join("resources"));
    write_running_status(&paths, "manual-continuous", "chronicle-tray");

    let stopped =
        stop_skysight_if_owned(&paths, "recording-session:fixture", "event-stream-stop").unwrap();

    assert!(stopped.is_none());
    assert!(!paths.stop_request_path.exists());
}

#[test]
fn skysight_paths_default_to_chronicle_resources_dir() {
    let _guard = env_guard();
    let old_code_home = env::var_os("CODEX_HOME");
    let old_runtime_dir = env::var_os("CODEX_SKYSIGHT_RUNTIME_DIR");
    let old_resources_dir = env::var_os("CODEX_SKYSIGHT_RESOURCES_DIR");
    let old_memory_extension_dir = env::var_os("CODEX_SKYSIGHT_MEMORY_EXTENSION_DIR");
    let old_chronicle_memory_extension_dir = env::var_os("CODEX_CHRONICLE_MEMORY_EXTENSION_DIR");
    let old_exclusions_path = env::var_os("CODEX_SKYSIGHT_EXCLUSIONS_PATH");

    let temp = tempfile::tempdir().unwrap();
    let code_home = temp.path().join("codex-home");
    let runtime_dir = temp.path().join("runtime");
    env::set_var("CODEX_HOME", &code_home);
    env::set_var("CODEX_SKYSIGHT_RUNTIME_DIR", &runtime_dir);
    env::remove_var("CODEX_SKYSIGHT_RESOURCES_DIR");
    env::remove_var("CODEX_SKYSIGHT_MEMORY_EXTENSION_DIR");
    env::remove_var("CODEX_CHRONICLE_MEMORY_EXTENSION_DIR");
    env::remove_var("CODEX_SKYSIGHT_EXCLUSIONS_PATH");

    let paths = SkysightPaths::from_env();

    assert_eq!(
        paths.resources_dir,
        code_home
            .join("memories")
            .join("extensions")
            .join("chronicle")
            .join("resources")
    );
    assert_eq!(
        paths.exclusions_path,
        code_home
            .join("memories")
            .join("extensions")
            .join("chronicle")
            .join("exclusions.json")
    );
    assert_eq!(paths.runtime_dir, runtime_dir);

    let legacy_exclusions_path = code_home
        .join("memories_extensions")
        .join("chronicle")
        .join("exclusions.json");
    fs::create_dir_all(legacy_exclusions_path.parent().unwrap()).unwrap();
    fs::write(
        &legacy_exclusions_path,
        r#"{"schema_version":1,"rules":[{"kind":"domain","value":"bank.example","reason":"private","updated_at":"2026-07-02T00:00:00Z"}]}"#,
    )
    .unwrap();

    let exclusions = list_skysight_exclusions(&paths).unwrap();
    assert_eq!(exclusions.len(), 1);
    assert_eq!(exclusions[0].kind, "domain");
    assert_eq!(exclusions[0].value, "bank.example");
    assert!(paths.exclusions_path.is_file());
    assert!(legacy_exclusions_path.is_file());

    restore_env("CODEX_HOME", old_code_home);
    restore_env("CODEX_SKYSIGHT_RUNTIME_DIR", old_runtime_dir);
    restore_env("CODEX_SKYSIGHT_RESOURCES_DIR", old_resources_dir);
    restore_env(
        "CODEX_SKYSIGHT_MEMORY_EXTENSION_DIR",
        old_memory_extension_dir,
    );
    restore_env(
        "CODEX_CHRONICLE_MEMORY_EXTENSION_DIR",
        old_chronicle_memory_extension_dir,
    );
    restore_env("CODEX_SKYSIGHT_EXCLUSIONS_PATH", old_exclusions_path);
}

#[test]
fn skysight_migrates_legacy_exclusions_with_daemon_path_overrides() {
    let temp = tempfile::tempdir().unwrap();
    let code_home = temp.path().join("real-code-home");
    let runtime_dir = temp.path().join("runtime");
    let memory_extension_dir = code_home
        .join("memories")
        .join("extensions")
        .join("chronicle");
    let custom_exclusions_path = temp.path().join("daemon").join("exclusions.json");
    let legacy_exclusions_path = code_home
        .join("memories_extensions")
        .join("chronicle")
        .join("exclusions.json");
    fs::create_dir_all(legacy_exclusions_path.parent().unwrap()).unwrap();
    fs::write(
        &legacy_exclusions_path,
        r#"{"schema_version":1,"rules":[{"kind":"app","value":"Secrets","reason":"private","updated_at":"2026-07-02T00:00:00Z"}]}"#,
    )
    .unwrap();

    let mut paths = SkysightPaths::new(runtime_dir, memory_extension_dir.join("resources"));
    paths.memory_extension_dir = memory_extension_dir.clone();
    paths.resources_dir = memory_extension_dir.join("resources");
    paths.exclusions_path = custom_exclusions_path.clone();
    paths.memory_instructions_path = memory_extension_dir.join("SkysightMemoryInstructions.md");
    paths.summarizer_path = memory_extension_dir.join("SkysightSummarizer.md");
    assert_eq!(paths.memory_extension_dir, memory_extension_dir);
    assert_eq!(paths.exclusions_path, custom_exclusions_path);

    let exclusions = list_skysight_exclusions(&paths).unwrap();
    assert_eq!(exclusions.len(), 1);
    assert_eq!(exclusions[0].kind, "app");
    assert_eq!(exclusions[0].value, "Secrets");
    assert!(paths.exclusions_path.is_file());
    assert!(legacy_exclusions_path.is_file());
}

#[test]
fn skysight_snapshot_creates_segment_directory_and_rollup_resources() {
    let temp = tempfile::tempdir().unwrap();
    let paths = SkysightPaths::new(temp.path().join("runtime"), temp.path().join("resources"));

    let status = capture_skysight_snapshot(&paths, Some("test")).unwrap();

    assert!(status.ok);
    assert_eq!(status.state, "stopped");
    assert!(!status.is_running);
    assert!(status.pid.is_none());
    assert_eq!(status.end_reason.as_deref(), Some("snapshot-only"));
    assert!(status.next_capture_at.is_none());
    assert!(status.status_path.is_file());
    assert!(status.memory_extension_dir.ends_with("resources"));
    let segment_dir = status
        .current_segment_events_path
        .as_ref()
        .and_then(|path| path.parent())
        .unwrap();
    assert!(segment_dir.is_dir());
    let events_path = segment_dir.join("events.jsonl");
    let metadata_path = segment_dir.join("metadata.json");
    let diagnostics_artifact_path = segment_dir.join("artifacts").join("diagnostics.json");
    assert!(events_path.is_file());
    assert!(metadata_path.is_file());
    assert!(diagnostics_artifact_path.is_file());
    assert!(status
        .current_segment_metadata_path
        .as_ref()
        .is_some_and(|path| path.is_file()));
    assert!(status
        .last_10min_resource
        .as_ref()
        .is_some_and(|path| path.is_file()));
    assert!(status
        .last_6h_resource
        .as_ref()
        .is_some_and(|path| path.is_file()));
    assert!(status
        .last_10min_resource
        .as_ref()
        .and_then(|path| path.file_name())
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.contains("-10min-")));
    assert!(status
        .last_6h_resource
        .as_ref()
        .and_then(|path| path.file_name())
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.contains("-6h-")));
    assert_eq!(status.exclusions_count, 0);
    assert!(!status.capture_capability_notes.is_empty());
    assert!(status
        .ocr_backend
        .as_deref()
        .is_some_and(|backend| matches!(backend, "rapidocr-python" | "tesseract-cli" | "auto")));
    assert_eq!(status.ocr_language.as_deref(), Some("eng"));
    assert!(status
        .ocr_status
        .as_deref()
        .is_some_and(|state| matches!(state, "available" | "backend_unavailable" | "disabled")));
    assert!(!status.summarizer_capability_notes.is_empty());

    let events = read_jsonl(&events_path);
    let kinds = events
        .iter()
        .filter_map(|event| event.get("kind").and_then(Value::as_str))
        .collect::<BTreeSet<_>>();
    assert!(events.len() >= 4);
    assert!(kinds.contains("diagnostics"));
    assert!(kinds.contains("provider_readiness"));
    assert!(kinds.contains("diagnostics_artifact"));
    assert!(kinds.iter().any(|kind| {
        matches!(
            *kind,
            "window_metadata"
                | "browser_observation"
                | "screenshot"
                | "accessibility_snapshot"
                | "accessibility_apps"
                | "capture_error"
                | "suppressed_evidence"
        )
    }));

    let metadata: Value =
        serde_json::from_str(&std::fs::read_to_string(&metadata_path).unwrap()).unwrap();
    assert!(metadata["event_count"].as_u64().unwrap() >= 4);
    assert!(metadata["artifact_count"].as_u64().unwrap() >= 1);
    assert_eq!(metadata["summary_level"], "10min");

    let resource = std::fs::read_to_string(status.last_10min_resource.as_ref().unwrap()).unwrap();
    assert!(resource.contains("# Skysight Activity Summary"));
    assert!(resource.contains("[skysight memory]"));
    assert!(resource.contains("covers `"));
    assert!(resource.contains("Event kinds captured"));
    assert!(resource.contains("Evidence artifacts in window"));
    assert!(resource.contains("Browser observations"));
    assert!(resource.contains("OCR evidence"));
    assert!(resource.contains("Diagnostics summary"));
    assert!(resource.contains("Capture capabilities"));
    assert!(status
        .capture_capability_notes
        .iter()
        .any(|note| note.contains("windowing")));
    assert!(status
        .capture_capability_notes
        .iter()
        .any(|note| note.contains("browser-window")));
    assert!(status
        .capture_capability_notes
        .iter()
        .any(|note| note.contains("screenshot")));
    assert!(status
        .capture_capability_notes
        .iter()
        .any(|note| note.contains("at-spi")));

    let rollup = std::fs::read_to_string(status.last_6h_resource.as_ref().unwrap()).unwrap();
    assert!(rollup.contains("# Skysight Chronicle Rollup"));
    assert!(rollup.contains("[skysight memory]"));

    let current = skysight_status(&paths).unwrap();
    assert_eq!(current.state, "stopped");
    assert!(!current.is_running);
    assert_eq!(current.last_10min_resource, status.last_10min_resource);
    assert_eq!(current.last_6h_resource, status.last_6h_resource);

    let second = capture_skysight_snapshot(&paths, Some("test-second")).unwrap();
    assert_ne!(second.last_10min_resource, status.last_10min_resource);
    assert_eq!(second.last_6h_resource, status.last_6h_resource);

    let stopped = stop_skysight(&paths).unwrap();
    assert_eq!(stopped.state, "stopped");
    assert!(!stopped.is_running);
}

#[test]
fn skysight_status_reports_fake_tesseract_ocr_readiness() {
    let _guard = env_guard();
    let old_ocr = env::var_os("CODEX_SKYSIGHT_OCR");
    let old_backend = env::var_os("CODEX_SKYSIGHT_OCR_BACKEND");
    let old_tesseract = env::var_os("CODEX_SKYSIGHT_TESSERACT_PATH");
    let old_lang = env::var_os("CODEX_SKYSIGHT_OCR_LANG");

    let temp = tempfile::tempdir().unwrap();
    let fake_tesseract = temp.path().join("fake-tesseract");
    write_fake_tesseract(&fake_tesseract, "version-only");
    env::set_var("CODEX_SKYSIGHT_OCR", "enabled");
    env::set_var("CODEX_SKYSIGHT_OCR_BACKEND", "tesseract");
    env::set_var("CODEX_SKYSIGHT_TESSERACT_PATH", &fake_tesseract);
    env::set_var("CODEX_SKYSIGHT_OCR_LANG", "eng");

    let paths = SkysightPaths::new(temp.path().join("runtime"), temp.path().join("resources"));
    let status = skysight_status(&paths).unwrap();
    let value = serde_json::to_value(status).unwrap();

    assert_eq!(value["ocr_enabled"], true);
    assert_eq!(value["ocr_available"], true);
    assert_eq!(value["ocr_mode"], "enabled");
    assert_eq!(value["ocr_status"], "available");
    assert_eq!(value["ocr_backend"], "tesseract-cli");
    assert_eq!(value["ocr_language"], "eng");
    assert!(value["ocr_backend_version"]
        .as_str()
        .is_some_and(|version| version.contains("tesseract")));

    restore_env("CODEX_SKYSIGHT_OCR", old_ocr);
    restore_env("CODEX_SKYSIGHT_OCR_BACKEND", old_backend);
    restore_env("CODEX_SKYSIGHT_TESSERACT_PATH", old_tesseract);
    restore_env("CODEX_SKYSIGHT_OCR_LANG", old_lang);
}

#[test]
fn skysight_pause_and_resume_gate_snapshot_capture() {
    let temp = tempfile::tempdir().unwrap();
    let paths = SkysightPaths::new(temp.path().join("runtime"), temp.path().join("resources"));

    let paused = pause_skysight(&paths, Some("focus on review".to_string())).unwrap();
    assert_eq!(paused.state, "paused");
    assert!(!paused.is_running);
    assert!(paused.paused);
    assert_eq!(paused.pause_reason.as_deref(), Some("focus on review"));

    let snapshot_while_paused = capture_skysight_snapshot(&paths, Some("paused")).unwrap();
    assert_eq!(snapshot_while_paused.state, "paused");
    assert!(!snapshot_while_paused.is_running);
    assert!(snapshot_while_paused.current_segment_events_path.is_none());
    assert!(snapshot_while_paused.last_10min_resource.is_none());
    assert!(snapshot_while_paused.last_6h_resource.is_none());

    let resumed = resume_skysight(&paths).unwrap();
    assert_eq!(resumed.state, "stopped");
    assert!(!resumed.is_running);
    assert!(!resumed.paused);
    assert!(resumed.pause_reason.is_none());

    let snapshot = capture_skysight_snapshot(&paths, Some("resume")).unwrap();
    assert_eq!(snapshot.state, "stopped");
    assert!(!snapshot.is_running);
    assert!(snapshot
        .current_segment_events_path
        .as_ref()
        .is_some_and(|path| path.is_file()));
}

#[test]
fn skysight_status_does_not_treat_running_without_pid_as_alive() {
    let temp = tempfile::tempdir().unwrap();
    let paths = SkysightPaths::new(temp.path().join("runtime"), temp.path().join("resources"));

    capture_skysight_snapshot(&paths, Some("legacy-status")).unwrap();
    let mut status: Value = serde_json::from_str(&fs::read_to_string(&paths.status_path).unwrap())
        .expect("status json should parse");
    status["state"] = Value::String("running".to_string());
    status["is_running"] = Value::Bool(true);
    status.as_object_mut().unwrap().remove("pid");
    fs::write(
        &paths.status_path,
        format!("{}\n", serde_json::to_string_pretty(&status).unwrap()),
    )
    .unwrap();

    let current = skysight_status(&paths).unwrap();
    assert_eq!(current.state, "stopped");
    assert!(!current.is_running);
    assert_eq!(current.end_reason.as_deref(), Some("process-exited"));
}

#[test]
fn skysight_exclusions_roundtrip_without_starting_service() {
    let temp = tempfile::tempdir().unwrap();
    let paths = SkysightPaths::new(temp.path().join("runtime"), temp.path().join("resources"));

    update_skysight_exclusion(
        &paths,
        SkysightExclusionUpdate {
            kind: "app".to_string(),
            value: "Secrets".to_string(),
            reason: Some("private workflow".to_string()),
            remove: false,
        },
    )
    .unwrap();
    update_skysight_exclusion(
        &paths,
        SkysightExclusionUpdate {
            kind: "domain".to_string(),
            value: "bank.example".to_string(),
            reason: None,
            remove: false,
        },
    )
    .unwrap();

    let exclusions = list_skysight_exclusions(&paths).unwrap();
    assert_eq!(exclusions.len(), 2);
    assert!(exclusions
        .iter()
        .any(|rule| rule.kind == "app" && rule.value == "Secrets"));
    assert!(exclusions
        .iter()
        .any(|rule| rule.kind == "domain" && rule.value == "bank.example"));

    update_skysight_exclusion(
        &paths,
        SkysightExclusionUpdate {
            kind: "app".to_string(),
            value: "Secrets".to_string(),
            reason: None,
            remove: true,
        },
    )
    .unwrap();

    let exclusions = list_skysight_exclusions(&paths).unwrap();
    assert_eq!(exclusions.len(), 1);
    assert_eq!(exclusions[0].value, "bank.example");

    let status = skysight_status(&paths).unwrap();
    assert_eq!(status.exclusions_count, 1);
}

fn read_jsonl(path: &std::path::Path) -> Vec<Value> {
    std::fs::read_to_string(path)
        .unwrap()
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

fn write_fake_tesseract(path: &Path, mode: &str) {
    let body = match mode {
        "version-only" => {
            r#"#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "--version" ]]; then
  echo "tesseract 5.3.4"
  exit 0
fi
out="${2}.tsv"
cat > "$out" <<'TSV'
level	page_num	block_num	par_num	line_num	word_num	left	top	width	height	conf	text
5	1	1	1	1	1	10	20	40	12	95	Codex
TSV
"#
        }
        other => panic!("unknown fake tesseract mode {other}"),
    };
    fs::write(path, body).unwrap();
    let mut permissions = fs::metadata(path).unwrap().permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(path, permissions).unwrap();
}
