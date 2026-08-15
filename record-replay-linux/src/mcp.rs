use anyhow::Result;
use rmcp::{
    handler::server::{
        tool::ToolRouter,
        wrapper::{Json, Parameters},
    },
    model::{Implementation, ServerCapabilities, ServerInfo},
    schemars::JsonSchema,
    tool, tool_handler, tool_router, ServerHandler, ServiceExt,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    env,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use crate::{
    available_recorders, bundle_draft_prompt, cancel_session, capture_skysight_snapshot,
    import_skill as import_skill_dir, inspect_skill as inspect_skill_dir, list_skysight_exclusions,
    mark_session, pause_skysight, record_browser_trace, record_desktop_snapshot,
    record_speech_context, recording_backend_catalog, resume_skysight, skysight_status,
    start_session, start_skysight, stop_session, stop_skysight, update_skysight_exclusion,
    validate_bundle_dir, validate_draft_prompt, RecordStartOptions, RecordingRuntimeState,
    SkillImportOptions, SkysightExclusionUpdate, SkysightPaths, SkysightStartOptions,
};

const DEFAULT_MAX_DURATION_SECONDS: u64 = 30 * 60;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum McpMode {
    EventStream,
    Skysight,
}

const SKYSIGHT_TOOL_NAMES: &[&str] = &[
    "doctor",
    "skysight_list_exclusions",
    "skysight_pause",
    "skysight_resume",
    "skysight_snapshot",
    "skysight_start",
    "skysight_status",
    "skysight_stop",
    "skysight_update_exclusion",
];

#[derive(Clone)]
pub struct RecordReplayLinux {
    active_session: Arc<Mutex<Option<PathBuf>>>,
    last_session: Arc<Mutex<Option<PathBuf>>>,
    mode: McpMode,
    tool_router: ToolRouter<Self>,
}

impl Default for RecordReplayLinux {
    fn default() -> Self {
        Self::for_mode(McpMode::EventStream)
    }
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
struct ToolResponse {
    #[serde(flatten)]
    fields: BTreeMap<String, Value>,
}

#[tool_router]
impl RecordReplayLinux {
    #[tool(
        name = "doctor",
        description = "Report Linux Record & Replay readiness, including Computer Use desktop capture diagnostics."
    )]
    fn doctor(&self) -> Json<ToolResponse> {
        codex_computer_use_linux::diagnostics::hydrate_session_bus_env();
        let diagnostics = codex_computer_use_linux::diagnostics::doctor_report();
        let backend_catalog = recording_backend_catalog(&diagnostics);
        tool_json(json!({
            "ok": true,
            "command": "doctor",
            "schema_version": 1,
            "recorders": available_recorders(&backend_catalog),
            "backend_catalog": backend_catalog,
            "diagnostics": diagnostics,
            "active_session_dir": self.active_session_dir(),
            "last_session_dir": self.last_session_dir(),
        }))
    }

    #[tool(
        name = "status",
        description = "Report the current shared Record & Replay runtime status for UI and workflow coordination."
    )]
    fn status(&self) -> Json<ToolResponse> {
        tool_json(self.status_value("status"))
    }

    #[tool(
        name = "event_stream_status",
        description = "Get the current or most recent Record & Replay recording status including paths to metadata and events during the recording."
    )]
    fn event_stream_status(&self) -> Json<ToolResponse> {
        tool_json(self.status_value("event_stream_status"))
    }

    #[tool(
        name = "skysight_start",
        description = "Start Linux Skysight so Codex can answer questions about recent activity."
    )]
    fn skysight_start(
        &self,
        Parameters(params): Parameters<SkysightStartParams>,
    ) -> Json<ToolResponse> {
        let paths = SkysightPaths::from_env();
        match start_skysight(
            &paths,
            SkysightStartOptions {
                interval_seconds: params.interval_seconds.unwrap_or(60),
                summary_agent: params.summary_agent,
                source: params.source,
                owner: params.owner,
            },
        ) {
            Ok(status) => tool_json(json!({
                "ok": true,
                "command": "skysight_start",
                "status": status,
            })),
            Err(error) => error_json("skysight_start", error),
        }
    }

    #[tool(
        name = "skysight_status",
        description = "Get Linux Skysight status and paths to recent activity files."
    )]
    fn skysight_status(&self) -> Json<ToolResponse> {
        let paths = SkysightPaths::from_env();
        match skysight_status(&paths) {
            Ok(status) => tool_json(json!({
                "ok": true,
                "command": "skysight_status",
                "status": status,
            })),
            Err(error) => error_json("skysight_status", error),
        }
    }

    #[tool(
        name = "skysight_stop",
        description = "Stop Linux Skysight and return the current status."
    )]
    fn skysight_stop(&self) -> Json<ToolResponse> {
        let paths = SkysightPaths::from_env();
        match stop_skysight(&paths) {
            Ok(status) => tool_json(json!({
                "ok": true,
                "command": "skysight_stop",
                "status": status,
            })),
            Err(error) => error_json("skysight_stop", error),
        }
    }

    #[tool(
        name = "skysight_pause",
        description = "Pause Linux Skysight without deleting local Chronicle-compatible memory resources."
    )]
    fn skysight_pause(
        &self,
        Parameters(params): Parameters<SkysightPauseParams>,
    ) -> Json<ToolResponse> {
        let paths = SkysightPaths::from_env();
        match pause_skysight(&paths, params.reason) {
            Ok(status) => tool_json(json!({
                "ok": true,
                "command": "skysight_pause",
                "status": status,
            })),
            Err(error) => error_json("skysight_pause", error),
        }
    }

    #[tool(
        name = "skysight_resume",
        description = "Resume Linux Skysight after it has been paused."
    )]
    fn skysight_resume(&self) -> Json<ToolResponse> {
        let paths = SkysightPaths::from_env();
        match resume_skysight(&paths) {
            Ok(status) => tool_json(json!({
                "ok": true,
                "command": "skysight_resume",
                "status": status,
            })),
            Err(error) => error_json("skysight_resume", error),
        }
    }

    #[tool(
        name = "skysight_snapshot",
        description = "Capture one Linux Skysight activity snapshot into local segment and memory resources."
    )]
    fn skysight_snapshot(
        &self,
        Parameters(params): Parameters<SkysightSnapshotParams>,
    ) -> Json<ToolResponse> {
        let paths = SkysightPaths::from_env();
        match capture_skysight_snapshot(&paths, params.source.as_deref()) {
            Ok(status) => tool_json(json!({
                "ok": true,
                "command": "skysight_snapshot",
                "status": status,
            })),
            Err(error) => error_json("skysight_snapshot", error),
        }
    }

    #[tool(
        name = "skysight_update_exclusion",
        description = "Add, update, or remove a Linux Skysight app/domain exclusion."
    )]
    fn skysight_update_exclusion(
        &self,
        Parameters(params): Parameters<SkysightExclusionParams>,
    ) -> Json<ToolResponse> {
        let paths = SkysightPaths::from_env();
        match update_skysight_exclusion(
            &paths,
            SkysightExclusionUpdate {
                kind: params.kind,
                value: params.value,
                reason: params.reason,
                remove: params.remove.unwrap_or(false),
            },
        ) {
            Ok(exclusions) => tool_json(json!({
                "ok": true,
                "command": "skysight_update_exclusion",
                "exclusions": exclusions,
            })),
            Err(error) => error_json("skysight_update_exclusion", error),
        }
    }

    #[tool(
        name = "skysight_list_exclusions",
        description = "List Linux Skysight app/domain exclusions."
    )]
    fn skysight_list_exclusions(&self) -> Json<ToolResponse> {
        let paths = SkysightPaths::from_env();
        match list_skysight_exclusions(&paths) {
            Ok(exclusions) => tool_json(json!({
                "ok": true,
                "command": "skysight_list_exclusions",
                "exclusions": exclusions,
            })),
            Err(error) => error_json("skysight_list_exclusions", error),
        }
    }

    #[tool(
        name = "event_stream_start",
        description = "Start recording the user's actions for up to 30 minutes. If a recording is already active, return that active session instead of starting another one."
    )]
    async fn event_stream_start(
        &self,
        Parameters(params): Parameters<StartParams>,
    ) -> Json<ToolResponse> {
        self.start_recording(params, "event_stream_start").await
    }

    #[tool(
        name = "start",
        description = "Start recording a Linux workflow into an event-stream bundle. If session_dir is omitted, a temporary bundle directory is created."
    )]
    async fn start(&self, Parameters(params): Parameters<StartParams>) -> Json<ToolResponse> {
        self.start_recording(params, "start").await
    }

    async fn start_recording(
        &self,
        params: StartParams,
        command: &'static str,
    ) -> Json<ToolResponse> {
        if let Some(session_dir) = self.persisted_active_session() {
            self.set_active_session(Some(session_dir.clone()));
            self.set_last_session(Some(session_dir));
            let mut value = self.status_value(command);
            if let Value::Object(map) = &mut value {
                map.insert("alreadyActive".to_string(), Value::Bool(true));
            }
            return tool_json(value);
        }

        let session_dir = params
            .session_dir
            .as_deref()
            .map(expand_path)
            .unwrap_or_else(default_session_dir);
        let result = start_session(RecordStartOptions {
            session_dir: session_dir.clone(),
            app_id: params.app_id,
            window_id: params.window_id,
            goal: params.goal,
            include_screenshot: params.include_screenshot.unwrap_or(true),
            include_accessibility: params.include_accessibility.unwrap_or(true),
            include_audio: params.include_audio.unwrap_or(false),
        })
        .await;
        match result {
            Ok(report) => {
                self.set_active_session(Some(session_dir.clone()));
                self.set_last_session(Some(session_dir));
                let mut value = json!(report);
                add_event_stream_fields(&mut value, true, None);
                if let Value::Object(map) = &mut value {
                    map.insert("command".to_string(), Value::String(command.to_string()));
                }
                tool_json(value)
            }
            Err(error) => error_json(command, error),
        }
    }

    #[tool(
        name = "mark",
        description = "Add a user marker note to the active or specified recording bundle."
    )]
    fn mark(&self, Parameters(params): Parameters<MarkParams>) -> Json<ToolResponse> {
        let Some(session_dir) = self.resolve_session(params.session_dir.as_deref(), true) else {
            return message_json(
                "mark",
                "No active recording session. Call start first or pass session_dir.",
            );
        };
        match mark_session(&session_dir, &params.note) {
            Ok(record) => tool_json(json!({
                "ok": true,
                "command": "mark",
                "session_dir": session_dir,
                "record": record,
            })),
            Err(error) => error_json("mark", error),
        }
    }

    #[tool(
        name = "speech_context",
        description = "Add spoken microphone transcript or dictated user context to the active recording bundle."
    )]
    fn speech_context(
        &self,
        Parameters(params): Parameters<SpeechContextParams>,
    ) -> Json<ToolResponse> {
        let Some(session_dir) = self.resolve_session(params.session_dir.as_deref(), true) else {
            return message_json(
                "speech_context",
                "No active recording session. Call start first or pass session_dir.",
            );
        };
        match record_speech_context(
            &session_dir,
            &params.transcript,
            params
                .source
                .or_else(|| Some("microphone-transcript".to_string())),
        ) {
            Ok(record) => tool_json(json!({
                "ok": true,
                "command": "speech_context",
                "session_dir": session_dir,
                "record": record,
            })),
            Err(error) => error_json("speech_context", error),
        }
    }

    #[tool(
        name = "browser_trace",
        description = "Add a browser/CDP-style trace object to the active or specified recording bundle as semantic replay evidence."
    )]
    fn browser_trace(
        &self,
        Parameters(params): Parameters<BrowserTraceParams>,
    ) -> Json<ToolResponse> {
        let Some(session_dir) = self.resolve_session(params.session_dir.as_deref(), true) else {
            return message_json(
                "browser_trace",
                "No active recording session. Call start first or pass session_dir.",
            );
        };
        match record_browser_trace(
            &session_dir,
            params.trace,
            params.url,
            params.title,
            params.source.or_else(|| Some("browser-cdp".to_string())),
        ) {
            Ok(record) => tool_json(json!({
                "ok": true,
                "command": "browser_trace",
                "session_dir": session_dir,
                "record": record,
            })),
            Err(error) => error_json("browser_trace", error),
        }
    }

    #[tool(
        name = "desktop_snapshot",
        description = "Capture current focused desktop window metadata into the active recording bundle as semantic workflow evidence."
    )]
    async fn desktop_snapshot(
        &self,
        Parameters(params): Parameters<DesktopSnapshotParams>,
    ) -> Json<ToolResponse> {
        let Some(session_dir) = self.resolve_session(params.session_dir.as_deref(), true) else {
            return message_json(
                "desktop_snapshot",
                "No active recording session. Call start first or pass session_dir.",
            );
        };
        match record_desktop_snapshot(
            &session_dir,
            params
                .source
                .or_else(|| Some("desktop-window-metadata".to_string())),
        )
        .await
        {
            Ok(record) => tool_json(json!({
                "ok": true,
                "command": "desktop_snapshot",
                "session_dir": session_dir,
                "record": record,
            })),
            Err(error) => error_json("desktop_snapshot", error),
        }
    }

    #[tool(
        name = "stop",
        description = "Stop the active or specified recording bundle and seal its manifest."
    )]
    fn stop(&self, Parameters(params): Parameters<StopParams>) -> Json<ToolResponse> {
        self.stop_recording(params, "stop")
    }

    #[tool(
        name = "event_stream_stop",
        description = "Stop the active event stream recording if one is running and return status including paths to metadata and events during the recording."
    )]
    fn event_stream_stop(&self, Parameters(params): Parameters<StopParams>) -> Json<ToolResponse> {
        self.stop_recording(params, "event_stream_stop")
    }

    #[tool(
        name = "cancel",
        description = "Cancel the active recording bundle. When discarded is set, mark the bundle as discarded."
    )]
    fn cancel(&self, Parameters(params): Parameters<CancelParams>) -> Json<ToolResponse> {
        self.cancel_recording(params, "cancel")
    }

    #[tool(
        name = "event_stream_cancel",
        description = "Cancel the active event stream recording and mark whether the bundle was discarded."
    )]
    fn event_stream_cancel(
        &self,
        Parameters(params): Parameters<CancelParams>,
    ) -> Json<ToolResponse> {
        self.cancel_recording(params, "event_stream_cancel")
    }

    fn stop_recording(&self, params: StopParams, command: &'static str) -> Json<ToolResponse> {
        let Some(session_dir) = self.resolve_session(params.session_dir.as_deref(), true) else {
            return message_json(
                command,
                "No active recording session. Call start first or pass session_dir.",
            );
        };
        match stop_session(&session_dir) {
            Ok(record) => {
                self.set_active_session(None);
                self.set_last_session(Some(session_dir.clone()));
                let manifest = manifest_for(&session_dir);
                tool_json(json!({
                    "ok": true,
                    "command": command,
                    "session_dir": session_dir,
                    "record": record,
                    "isRecording": false,
                    "sessionID": session_id_for(&session_dir),
                    "sessionDirectoryPath": session_dir,
                    "eventsPath": event_stream_events_path(&session_dir),
                    "metadataPath": event_stream_metadata_path(&session_dir),
                    "suppressedEventsPath": event_stream_suppressed_path(&session_dir),
                    "startedAt": manifest.as_ref().map(|manifest| manifest.started_at.clone()),
                    "endedAt": manifest.and_then(|manifest| manifest.ended_at),
                    "endReason": "recording_controls_stopped",
                    "maxDurationSeconds": DEFAULT_MAX_DURATION_SECONDS,
                }))
            }
            Err(error) => error_json(command, error),
        }
    }

    fn cancel_recording(&self, params: CancelParams, command: &'static str) -> Json<ToolResponse> {
        let Some(session_dir) = self.resolve_session(params.session_dir.as_deref(), true) else {
            return message_json(
                command,
                "No active recording session. Call start first or pass session_dir.",
            );
        };
        let discarded = params.discarded;
        match cancel_session(&session_dir, discarded) {
            Ok(record) => {
                self.set_active_session(None);
                self.set_last_session(Some(session_dir.clone()));
                let manifest = manifest_for(&session_dir);
                let end_reason = manifest
                    .as_ref()
                    .and_then(|manifest| manifest.end_reason.clone())
                    .or_else(|| {
                        Some(if discarded {
                            "recording_controls_cancelled_discarded".to_string()
                        } else {
                            "recording_controls_cancelled".to_string()
                        })
                    });
                tool_json(json!({
                    "ok": true,
                    "command": command,
                    "session_dir": session_dir,
                    "discarded": discarded,
                    "record": record,
                    "isRecording": false,
                    "sessionID": session_id_for(&session_dir),
                    "sessionDirectoryPath": session_dir,
                    "eventsPath": event_stream_events_path(&session_dir),
                    "metadataPath": event_stream_metadata_path(&session_dir),
                    "suppressedEventsPath": Value::Null,
                    "startedAt": manifest.as_ref().map(|manifest| manifest.started_at.clone()),
                    "endedAt": manifest.as_ref().and_then(|manifest| manifest.ended_at.clone()),
                    "endReason": end_reason,
                    "maxDurationSeconds": DEFAULT_MAX_DURATION_SECONDS,
                }))
            }
            Err(error) => error_json(command, error),
        }
    }

    #[tool(
        name = "validate_bundle",
        description = "Validate a recording bundle and report missing files, unsafe paths, and timeline issues."
    )]
    fn validate_bundle(&self, Parameters(params): Parameters<BundleParams>) -> Json<ToolResponse> {
        let Some(bundle) = self.resolve_session(params.bundle.as_deref(), false) else {
            return message_json(
                "validate_bundle",
                "No bundle was provided and no previous recording bundle is known.",
            );
        };
        match validate_bundle_dir(&bundle) {
            Ok(report) => tool_json(json!(report)),
            Err(error) => error_json("validate_bundle", error),
        }
    }

    #[tool(
        name = "draft_skill_prompt",
        description = "Create the prompt Codex should use to transform a recording bundle into a reusable SKILL.md."
    )]
    fn draft_skill_prompt(
        &self,
        Parameters(params): Parameters<BundleParams>,
    ) -> Json<ToolResponse> {
        let Some(bundle) = self.resolve_session(params.bundle.as_deref(), false) else {
            return message_json(
                "draft_skill_prompt",
                "No bundle was provided and no previous recording bundle is known.",
            );
        };
        match bundle_draft_prompt(&bundle) {
            Ok(prompt) => {
                let validation = validate_draft_prompt(&prompt);
                tool_json(json!({
                    "ok": validation.is_valid(),
                    "command": "draft_skill_prompt",
                    "bundle": bundle,
                    "draft_prompt": prompt,
                    "validation": validation,
                }))
            }
            Err(error) => error_json("draft_skill_prompt", error),
        }
    }

    #[tool(
        name = "inspect_skill",
        description = "Inspect a generated skill directory for Linux compatibility without executing skill-owned files."
    )]
    fn inspect_skill(&self, Parameters(params): Parameters<SkillPathParams>) -> Json<ToolResponse> {
        match inspect_skill_dir(&expand_path(&params.source)) {
            Ok(report) => tool_json(json!(report)),
            Err(error) => error_json("inspect_skill", error),
        }
    }

    #[tool(
        name = "import_skill",
        description = "Import a generated skill into the user skill directory after compatibility and safety inspection."
    )]
    fn import_skill(
        &self,
        Parameters(params): Parameters<SkillImportParams>,
    ) -> Json<ToolResponse> {
        match import_skill_dir(SkillImportOptions {
            source: expand_path(&params.source),
            target: crate::skill::ImportTarget::User,
            target_dir: None,
            mode: crate::skill::ImportMode::Copy,
            dry_run: params.dry_run.unwrap_or(false),
            allow_unsupported: params.allow_unsupported.unwrap_or(false),
            overwrite: false,
        }) {
            Ok(report) => tool_json(json!(report)),
            Err(error) => error_json("import_skill", error),
        }
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for RecordReplayLinux {
    fn get_info(&self) -> ServerInfo {
        let (name, instructions) = match self.mode {
            McpMode::EventStream => (
                "event-stream",
                "Use Event-stream to record Linux desktop/browser workflows and compile them into reusable Codex skills. Call doctor before first recording when readiness is uncertain. Use skysight_start or skysight_snapshot when recent activity context will help the skill draft. Use start/event_stream_start, let the user perform the workflow, call desktop_snapshot at meaningful app/window changes, call speech_context only for additional transcript text that is explicitly available, call browser_trace when browser/CDP trace evidence is available, optionally call mark for meaningful intent boundaries, call stop/event_stream_stop when the user says they are done, inspect the bundle, draft a skill prompt, create or refine SKILL.md, then import the skill when the user approves. Replay through Codex skills and Computer Use; do not replay raw pointer coordinates as the main architecture.",
            ),
            McpMode::Skysight => (
                "chronicle-skysight",
                "Use Skysight for explicit Linux activity-memory capture. Status and doctor calls are passive. Start continuous capture only when the user requests it, honor exclusions, and use pause, resume, stop, or snapshot to control bounded local evidence.",
            ),
        };
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new(name, env!("CARGO_PKG_VERSION")))
            .with_instructions(instructions)
    }
}

pub fn tool_names(mode: McpMode) -> Vec<String> {
    RecordReplayLinux::router_for_mode(mode)
        .list_all()
        .into_iter()
        .map(|tool| tool.name.into_owned())
        .collect()
}

pub async fn serve_event_stream_mcp() -> Result<()> {
    serve_mcp_mode(McpMode::EventStream).await
}

pub async fn serve_skysight_mcp() -> Result<()> {
    serve_mcp_mode(McpMode::Skysight).await
}

async fn serve_mcp_mode(mode: McpMode) -> Result<()> {
    let service = RecordReplayLinux::for_mode(mode);
    let cleanup_service = service.clone();
    let server_result: Result<()> = async move {
        service
            .serve(rmcp::transport::stdio())
            .await?
            .waiting()
            .await?;
        Ok(())
    }
    .await;
    let cleanup_result = if mode == McpMode::EventStream {
        cleanup_service.stop_owned_skysight_for_active_session("event-stream-shutdown")
    } else {
        Ok(())
    };
    server_result?;
    cleanup_result?;
    Ok(())
}

impl RecordReplayLinux {
    fn for_mode(mode: McpMode) -> Self {
        Self {
            active_session: Arc::new(Mutex::new(None)),
            last_session: Arc::new(Mutex::new(None)),
            mode,
            tool_router: Self::router_for_mode(mode),
        }
    }

    fn router_for_mode(mode: McpMode) -> ToolRouter<Self> {
        let mut router = Self::tool_router();
        if mode == McpMode::Skysight {
            router
                .map
                .retain(|name, _route| SKYSIGHT_TOOL_NAMES.contains(&name.as_ref()));
        }
        router
    }

    fn status_value(&self, command: &'static str) -> Value {
        let status = crate::refresh_runtime_status();
        let session_dir = status
            .session_dir
            .clone()
            .or_else(|| self.active_session_dir())
            .or_else(|| self.last_session_dir());
        let state = status.state.clone();
        let is_recording = matches!(state, RecordingRuntimeState::Active);
        let manifest = session_dir.as_deref().and_then(manifest_for);
        let started_at = manifest
            .as_ref()
            .map(|manifest| manifest.started_at.clone())
            .or_else(|| status.started_at.as_ref().map(|value| value.to_rfc3339()));
        let ended_at = manifest
            .as_ref()
            .and_then(|manifest| manifest.ended_at.clone());
        let end_reason = manifest
            .as_ref()
            .and_then(|manifest| manifest.end_reason.clone())
            .or_else(|| status.end_reason.clone())
            .or_else(|| event_stream_end_reason(&status.state).map(str::to_string));

        json!({
            "ok": true,
            "command": command,
            "schema_version": 1,
            "state": state,
            "isRecording": is_recording,
            "session_dir": session_dir,
            "sessionID": session_dir.as_deref().map(session_id_for),
            "sessionDirectoryPath": session_dir,
            "eventsPath": session_dir.as_deref().map(event_stream_events_path),
            "metadataPath": session_dir.as_deref().map(event_stream_metadata_path),
            "suppressedEventsPath": session_dir.as_deref().map(event_stream_suppressed_path),
            "startedAt": started_at,
            "endedAt": ended_at,
            "endReason": end_reason,
            "maxDurationSeconds": status.max_duration_seconds,
            "runtimeStatus": status,
        })
    }

    fn set_active_session(&self, session_dir: Option<PathBuf>) {
        if let Ok(mut guard) = self.active_session.lock() {
            *guard = session_dir;
        }
    }

    fn set_last_session(&self, session_dir: Option<PathBuf>) {
        if let Ok(mut guard) = self.last_session.lock() {
            *guard = session_dir;
        }
    }

    fn active_session_dir(&self) -> Option<PathBuf> {
        self.active_session
            .lock()
            .ok()
            .and_then(|guard| guard.clone())
    }

    fn last_session_dir(&self) -> Option<PathBuf> {
        self.last_session
            .lock()
            .ok()
            .and_then(|guard| guard.clone())
    }

    fn stop_owned_skysight_for_active_session(&self, source: &str) -> Result<()> {
        if let Some(session_dir) = self.active_session_dir() {
            crate::recorder::stop_owned_skysight_for_session(&session_dir, source)?;
        }
        Ok(())
    }

    fn resolve_session(&self, explicit: Option<&str>, active_first: bool) -> Option<PathBuf> {
        if let Some(value) = explicit.and_then(non_empty) {
            return Some(expand_path(value));
        }
        if active_first {
            if let Some(path) = self.persisted_active_session() {
                return Some(path);
            }
        }
        if !active_first {
            let status = crate::read_runtime_status();
            if let Some(path) = status.session_dir {
                return Some(path);
            }
            if let Some(path) = self.active_session_dir() {
                return Some(path);
            }
        }
        if let Some(path) = self.last_session_dir() {
            return Some(path);
        }
        None
    }

    fn persisted_active_session(&self) -> Option<PathBuf> {
        let status = crate::refresh_runtime_status();
        if !matches!(status.state, RecordingRuntimeState::Active) {
            return None;
        }
        status
            .session_dir
            .filter(|path| path.join(crate::manifest::MANIFEST_FILE_NAME).is_file())
    }
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
struct StartParams {
    /// Optional destination bundle directory. Defaults to a temporary event-stream directory.
    session_dir: Option<String>,
    /// Optional desktop app id or accessibility app name to bias initial capture.
    app_id: Option<String>,
    /// Optional compositor/window identifier to bias initial capture.
    window_id: Option<String>,
    /// User-visible goal for the workflow being recorded.
    goal: Option<String>,
    /// Capture an initial screenshot. Defaults to true.
    include_screenshot: Option<bool>,
    /// Capture an initial AT-SPI accessibility snapshot. Defaults to true.
    include_accessibility: Option<bool>,
    /// Capture native Linux audio evidence when explicitly requested and CODEX_RECORD_REPLAY_AUDIO is enabled.
    include_audio: Option<bool>,
}

#[derive(Debug, Clone, Default, Deserialize, JsonSchema)]
struct SkysightStartParams {
    /// Seconds between daemon snapshots. Defaults to 60.
    interval_seconds: Option<u64>,
    /// Enable or disable the Chronicle summary agent for this running Skysight daemon.
    #[serde(alias = "summaryAgent")]
    summary_agent: Option<bool>,
    /// Initiating surface for this explicit continuous capture start.
    source: Option<String>,
    /// Capture owner, such as manual-continuous or recording-session:<id>.
    owner: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, JsonSchema)]
struct SkysightSnapshotParams {
    /// Optional snapshot source label.
    source: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, JsonSchema)]
struct SkysightPauseParams {
    /// Optional user-visible reason for pausing activity memory.
    reason: Option<String>,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
struct SkysightExclusionParams {
    /// Exclusion kind, such as app or domain.
    kind: String,
    /// App name, bundle id, window title fragment, or domain to exclude.
    value: String,
    /// Optional reason shown in local diagnostics.
    reason: Option<String>,
    /// Remove the matching exclusion instead of adding/updating it.
    remove: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
struct MarkParams {
    /// Optional bundle directory. Defaults to the active recording session.
    session_dir: Option<String>,
    /// Human intent marker to add to the event stream.
    note: String,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
struct SpeechContextParams {
    /// Optional bundle directory. Defaults to the active recording session.
    session_dir: Option<String>,
    /// Transcript or dictated guidance captured while the user demonstrates the workflow.
    transcript: String,
    /// Transcript source, such as microphone, dictation, chat, or manual note.
    source: Option<String>,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
struct BrowserTraceParams {
    /// Optional bundle directory. Defaults to the active recording session.
    session_dir: Option<String>,
    /// Browser/CDP trace payload captured by the caller.
    trace: Value,
    /// Optional current URL for the trace.
    url: Option<String>,
    /// Optional page title for the trace.
    title: Option<String>,
    /// Trace source, such as chrome-cdp, browser-plugin, or manual-debug.
    source: Option<String>,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
struct DesktopSnapshotParams {
    /// Optional bundle directory. Defaults to the active recording session.
    session_dir: Option<String>,
    /// Snapshot source, such as hud, mcp, or workflow-checkpoint.
    source: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, JsonSchema)]
struct StopParams {
    /// Optional bundle directory. Defaults to the active recording session.
    session_dir: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, JsonSchema)]
struct CancelParams {
    /// Optional bundle directory. Defaults to the active recording session.
    session_dir: Option<String>,
    /// Mark the bundle as discarded when canceling it.
    #[serde(default)]
    discarded: bool,
}

#[derive(Debug, Clone, Default, Deserialize, JsonSchema)]
struct BundleParams {
    /// Optional bundle directory. Defaults to the last active recording session.
    bundle: Option<String>,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
struct SkillPathParams {
    /// Skill directory containing SKILL.md.
    source: String,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
struct SkillImportParams {
    /// Skill directory containing SKILL.md.
    source: String,
    /// Validate and report destination without writing files.
    dry_run: Option<bool>,
    /// Allow importing skills classified as unsupported on Linux.
    allow_unsupported: Option<bool>,
}

fn tool_json(value: Value) -> Json<ToolResponse> {
    let fields = match value {
        Value::Object(map) => map.into_iter().collect(),
        other => BTreeMap::from([("value".to_string(), other)]),
    };
    Json(ToolResponse { fields })
}

fn error_json(command: &str, error: anyhow::Error) -> Json<ToolResponse> {
    tool_json(json!({
        "ok": false,
        "command": command,
        "message": error.to_string(),
    }))
}

fn message_json(command: &str, message: impl Into<String>) -> Json<ToolResponse> {
    tool_json(json!({
        "ok": false,
        "command": command,
        "message": message.into(),
    }))
}

fn default_session_dir() -> PathBuf {
    crate::runtime_status::runtime_root()
        .join("event_stream")
        .join(format!(
            "{}-{}",
            chrono::Utc::now().format("%Y%m%dT%H%M%S%.3fZ"),
            std::process::id()
        ))
}

fn expand_path(value: &str) -> PathBuf {
    let trimmed = value.trim();
    if trimmed == "~" {
        return home_dir();
    }
    if let Some(rest) = trimmed.strip_prefix("~/") {
        return home_dir().join(rest);
    }
    Path::new(trimmed).to_path_buf()
}

fn home_dir() -> PathBuf {
    env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn non_empty(value: &str) -> Option<&str> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then_some(trimmed)
}

fn add_event_stream_fields(value: &mut Value, is_recording: bool, end_reason: Option<&str>) {
    let Some(session_dir) = value
        .get("session_dir")
        .and_then(Value::as_str)
        .map(PathBuf::from)
    else {
        return;
    };
    let manifest = manifest_for(&session_dir);

    if let Value::Object(map) = value {
        map.insert("isRecording".to_string(), json!(is_recording));
        map.insert("sessionID".to_string(), json!(session_id_for(&session_dir)));
        map.insert("sessionDirectoryPath".to_string(), json!(session_dir));
        map.insert(
            "eventsPath".to_string(),
            json!(event_stream_events_path(&session_dir)),
        );
        map.insert(
            "metadataPath".to_string(),
            json!(event_stream_metadata_path(&session_dir)),
        );
        map.insert(
            "suppressedEventsPath".to_string(),
            json!(event_stream_suppressed_path(&session_dir)),
        );
        map.insert(
            "startedAt".to_string(),
            json!(manifest
                .as_ref()
                .map(|manifest| manifest.started_at.clone())),
        );
        map.insert(
            "endedAt".to_string(),
            json!(manifest
                .as_ref()
                .and_then(|manifest| manifest.ended_at.clone())),
        );
        map.insert("endReason".to_string(), json!(end_reason));
        map.insert(
            "maxDurationSeconds".to_string(),
            json!(DEFAULT_MAX_DURATION_SECONDS),
        );
    }
}

fn manifest_for(session_dir: &Path) -> Option<crate::RecordingBundleManifest> {
    crate::manifest::read_manifest(session_dir).ok()
}

fn session_id_for(session_dir: &Path) -> String {
    manifest_for(session_dir)
        .map(|manifest| manifest.session_id)
        .or_else(|| {
            session_dir
                .file_name()
                .and_then(|name| name.to_str())
                .map(str::to_string)
        })
        .unwrap_or_else(|| "recording".to_string())
}

fn event_stream_events_path(session_dir: &Path) -> PathBuf {
    session_dir.join(crate::manifest::EVENT_STREAM_EVENTS_FILE_NAME)
}

fn event_stream_metadata_path(session_dir: &Path) -> PathBuf {
    session_dir.join(crate::manifest::EVENT_STREAM_SESSION_FILE_NAME)
}

fn event_stream_suppressed_path(session_dir: &Path) -> PathBuf {
    session_dir.join(crate::manifest::EVENT_STREAM_SUPPRESSED_FILE_NAME)
}

fn event_stream_end_reason(state: &RecordingRuntimeState) -> Option<&'static str> {
    match state {
        RecordingRuntimeState::Stopped => Some("recording_controls_stopped"),
        RecordingRuntimeState::Canceled => Some("recording_controls_cancelled"),
        RecordingRuntimeState::Expired => Some("max_duration"),
        RecordingRuntimeState::Active | RecordingRuntimeState::Idle => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env_guard() -> std::sync::MutexGuard<'static, ()> {
        crate::test_support::env_guard()
    }

    #[test]
    fn add_event_stream_fields_includes_suppressed_events_path() {
        let temp = tempfile::tempdir().unwrap();
        let session_dir = temp.path().join("session");
        std::fs::create_dir_all(&session_dir).unwrap();
        let mut value = json!({
            "session_dir": session_dir.to_string_lossy().to_string(),
        });

        add_event_stream_fields(&mut value, true, None);

        assert_eq!(
            value["suppressedEventsPath"].as_str(),
            Some(
                session_dir
                    .join("suppressed.jsonl")
                    .to_string_lossy()
                    .as_ref()
            )
        );
    }

    #[test]
    fn status_value_includes_suppressed_events_path() {
        let _guard = env_guard();
        let temp = tempfile::tempdir().unwrap();
        let session_dir = temp.path().join("session");
        let previous = std::env::var_os("CODEX_RECORD_REPLAY_STATUS_PATH");
        let status_path = temp.path().join("status.json");
        std::env::set_var("CODEX_RECORD_REPLAY_STATUS_PATH", &status_path);

        let server = RecordReplayLinux::default();
        server.set_active_session(Some(session_dir.clone()));
        let value = server.status_value("status");

        assert_eq!(
            value["suppressedEventsPath"].as_str(),
            Some(
                session_dir
                    .join("suppressed.jsonl")
                    .to_string_lossy()
                    .as_ref()
            )
        );

        match previous {
            Some(path) => std::env::set_var("CODEX_RECORD_REPLAY_STATUS_PATH", path),
            None => std::env::remove_var("CODEX_RECORD_REPLAY_STATUS_PATH"),
        }
    }

    #[test]
    fn stop_recording_includes_suppressed_events_path() {
        let _guard = env_guard();
        let temp = tempfile::tempdir().unwrap();
        let session_dir = temp.path().join("session");
        std::fs::create_dir_all(&session_dir).unwrap();
        let manifest = crate::manifest::RecordingBundleManifest::new(
            "fixture-session".to_string(),
            "2026-06-30T12:00:00Z".to_string(),
        );
        crate::manifest::write_manifest(&session_dir, &manifest).unwrap();
        std::fs::write(session_dir.join(crate::manifest::TIMELINE_FILE_NAME), "").unwrap();
        let previous = std::env::var_os("CODEX_RECORD_REPLAY_STATUS_PATH");
        let status_path = temp.path().join("status.json");
        std::env::set_var("CODEX_RECORD_REPLAY_STATUS_PATH", &status_path);

        let service = RecordReplayLinux::default();
        let response = service.stop_recording(
            StopParams {
                session_dir: Some(session_dir.to_string_lossy().to_string()),
            },
            "stop",
        );
        let value = response.0.fields;

        assert_eq!(
            value["suppressedEventsPath"].as_str(),
            Some(
                session_dir
                    .join("suppressed.jsonl")
                    .to_string_lossy()
                    .as_ref()
            )
        );

        match previous {
            Some(path) => std::env::set_var("CODEX_RECORD_REPLAY_STATUS_PATH", path),
            None => std::env::remove_var("CODEX_RECORD_REPLAY_STATUS_PATH"),
        }
    }

    #[test]
    fn recording_stop_cleans_session_skysight_but_preserves_manual_continuous_capture() {
        let _guard = env_guard();
        let temp = tempfile::tempdir().unwrap();
        let env_keys = [
            "CODEX_HOME",
            "CODEX_SKYSIGHT_RUNTIME_DIR",
            "CODEX_SKYSIGHT_RESOURCES_DIR",
            "CODEX_SKYSIGHT_EXCLUSIONS_PATH",
            "CODEX_RECORD_REPLAY_STATUS_PATH",
        ];
        let previous = env_keys
            .iter()
            .map(|key| (*key, std::env::var_os(key)))
            .collect::<Vec<_>>();
        std::env::set_var("CODEX_HOME", temp.path().join("codex-home"));
        std::env::set_var(
            "CODEX_SKYSIGHT_RUNTIME_DIR",
            temp.path().join("skysight-runtime"),
        );
        std::env::set_var(
            "CODEX_SKYSIGHT_RESOURCES_DIR",
            temp.path().join("skysight-resources"),
        );
        std::env::set_var(
            "CODEX_SKYSIGHT_EXCLUSIONS_PATH",
            temp.path().join("exclusions.json"),
        );
        std::env::set_var(
            "CODEX_RECORD_REPLAY_STATUS_PATH",
            temp.path().join("record-replay-status.json"),
        );

        let result = (|| {
            let paths = SkysightPaths::from_env();
            let mut initial_status = skysight_status(&paths)?;
            initial_status.state = "running".to_string();
            initial_status.is_running = true;
            initial_status.owner = Some("recording-session:fixture-session".to_string());
            initial_status.source = Some("event-stream-start".to_string());
            std::fs::write(
                &paths.status_path,
                format!("{}\n", serde_json::to_string_pretty(&initial_status)?),
            )?;

            let session_dir = temp.path().join("fixture-session");
            std::fs::create_dir_all(&session_dir)?;
            let manifest = crate::manifest::RecordingBundleManifest::new(
                "fixture-session".to_string(),
                "2026-07-15T12:00:00Z".to_string(),
            );
            crate::manifest::write_manifest(&session_dir, &manifest)?;
            std::fs::write(session_dir.join(crate::manifest::TIMELINE_FILE_NAME), "")?;

            let service = RecordReplayLinux::default();
            let response = service.stop_recording(
                StopParams {
                    session_dir: Some(session_dir.to_string_lossy().to_string()),
                },
                "event_stream_stop",
            );
            assert_eq!(
                response.0.fields.get("ok").and_then(Value::as_bool),
                Some(true)
            );
            assert!(paths.stop_request_path.is_file());

            std::fs::remove_file(&paths.stop_request_path)?;
            let mut manual_status = skysight_status(&paths)?;
            manual_status.state = "running".to_string();
            manual_status.is_running = true;
            manual_status.owner = Some("manual-continuous".to_string());
            manual_status.source = Some("chronicle-tray".to_string());
            std::fs::write(
                &paths.status_path,
                format!("{}\n", serde_json::to_string_pretty(&manual_status)?),
            )?;

            let manual_session_dir = temp.path().join("manual-session");
            std::fs::create_dir_all(&manual_session_dir)?;
            let manual_manifest = crate::manifest::RecordingBundleManifest::new(
                "manual-session".to_string(),
                "2026-07-15T12:00:00Z".to_string(),
            );
            crate::manifest::write_manifest(&manual_session_dir, &manual_manifest)?;
            std::fs::write(
                manual_session_dir.join(crate::manifest::TIMELINE_FILE_NAME),
                "",
            )?;

            let manual_response = service.stop_recording(
                StopParams {
                    session_dir: Some(manual_session_dir.to_string_lossy().to_string()),
                },
                "event_stream_stop",
            );
            assert_eq!(
                manual_response.0.fields.get("ok").and_then(Value::as_bool),
                Some(true)
            );
            assert!(!paths.stop_request_path.exists());

            let mut shutdown_status = skysight_status(&paths)?;
            shutdown_status.state = "running".to_string();
            shutdown_status.is_running = true;
            shutdown_status.owner = Some("recording-session:fixture-session".to_string());
            shutdown_status.source = Some("event-stream-start".to_string());
            std::fs::write(
                &paths.status_path,
                format!("{}\n", serde_json::to_string_pretty(&shutdown_status)?),
            )?;
            service.set_active_session(Some(session_dir.clone()));
            service.stop_owned_skysight_for_active_session("event-stream-shutdown")?;
            assert!(paths.stop_request_path.is_file());
            let stopped = skysight_status(&paths)?;
            assert_eq!(
                stopped.owner.as_deref(),
                Some("recording-session:fixture-session")
            );
            assert_eq!(stopped.source.as_deref(), Some("event-stream-shutdown"));
            Ok::<(), anyhow::Error>(())
        })();

        for (key, value) in previous {
            match value {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
        }
        result.unwrap();
    }

    #[test]
    fn stale_mcp_shutdown_does_not_stop_reconnected_session_skysight() {
        let _guard = env_guard();
        let temp = tempfile::tempdir().unwrap();
        let env_keys = [
            "CODEX_HOME",
            "CODEX_SKYSIGHT_RUNTIME_DIR",
            "CODEX_SKYSIGHT_RESOURCES_DIR",
            "CODEX_SKYSIGHT_EXCLUSIONS_PATH",
            "CODEX_RECORD_REPLAY_STATUS_PATH",
        ];
        let previous = env_keys
            .iter()
            .map(|key| (*key, std::env::var_os(key)))
            .collect::<Vec<_>>();
        std::env::set_var("CODEX_HOME", temp.path().join("codex-home"));
        std::env::set_var(
            "CODEX_SKYSIGHT_RUNTIME_DIR",
            temp.path().join("skysight-runtime"),
        );
        std::env::set_var(
            "CODEX_SKYSIGHT_RESOURCES_DIR",
            temp.path().join("skysight-resources"),
        );
        std::env::set_var(
            "CODEX_SKYSIGHT_EXCLUSIONS_PATH",
            temp.path().join("exclusions.json"),
        );
        std::env::set_var(
            "CODEX_RECORD_REPLAY_STATUS_PATH",
            temp.path().join("record-replay-status.json"),
        );

        let result = (|| {
            let old_session = temp.path().join("old-session");
            let new_session = temp.path().join("new-session");
            for (session_dir, session_id) in
                [(&old_session, "old-session"), (&new_session, "new-session")]
            {
                std::fs::create_dir_all(session_dir)?;
                let manifest = crate::manifest::RecordingBundleManifest::new(
                    session_id.to_string(),
                    "2026-07-15T12:00:00Z".to_string(),
                );
                crate::manifest::write_manifest(session_dir, &manifest)?;
            }

            let stale_service = RecordReplayLinux::default();
            stale_service.set_active_session(Some(old_session));
            crate::runtime_status::write_active_status(&new_session, None)?;

            let paths = SkysightPaths::from_env();
            let mut status = skysight_status(&paths)?;
            status.state = "running".to_string();
            status.is_running = true;
            status.owner = Some("recording-session:new-session".to_string());
            status.source = Some("event-stream-start".to_string());
            std::fs::write(
                &paths.status_path,
                format!("{}\n", serde_json::to_string_pretty(&status)?),
            )?;

            stale_service.stop_owned_skysight_for_active_session("event-stream-shutdown")?;

            assert!(!paths.stop_request_path.exists());
            let current = skysight_status(&paths)?;
            assert_eq!(
                current.owner.as_deref(),
                Some("recording-session:new-session")
            );
            Ok::<(), anyhow::Error>(())
        })();

        for (key, value) in previous {
            match value {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
        }
        result.unwrap();
    }
}
