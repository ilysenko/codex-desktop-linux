pub mod audio;
pub mod backends;
mod browser_observation;
pub mod draft_prompt;
pub mod event_stream;
pub mod manifest;
pub mod mcp;
mod ocr;
mod process_identity;
mod process_reaper;
pub mod recorder;
pub mod runtime_status;
mod secure_fs;
pub mod skill;
pub mod skysight;
pub mod timeline;

use anyhow::Result;
use clap::{Args, Parser, Subcommand, ValueEnum};
use serde_json::Value;
use std::path::PathBuf;

#[cfg(test)]
pub(crate) mod test_support {
    use std::sync::{Mutex, MutexGuard, OnceLock};

    pub(crate) fn env_guard() -> MutexGuard<'static, ()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(())).lock().unwrap()
    }
}

pub use audio::{available_audio_recorders, AudioCaptureReport};
pub use backends::{
    available_recorders, recording_backend_catalog, recording_backend_catalog_from_signals,
    recording_backend_observation, recording_backend_observation_from_signals, RecordingBackend,
    RecordingBackendSignals, RecordingBackendStatus,
};
pub use draft_prompt::{
    bundle_draft_prompt, validate_draft_prompt, DraftPromptValidation, DraftPromptValidationError,
    DraftPromptValidationReport,
};
pub use manifest::{
    validate_bundle_dir, BundleValidationError, BundleValidationReport, FileShape,
    RecordingBundleManifest,
};
pub use recorder::{
    cancel_session, expire_session, mark_session, record_browser_trace, record_desktop_snapshot,
    record_speech_context, start_session, stop_session, RecordStartOptions,
};
pub use runtime_status::{
    read_runtime_status, refresh_runtime_status, status_path, update_active_status,
    update_active_status_for, write_active_status, write_stopped_status, RecordingRuntimeState,
    RecordingRuntimeStatus,
};
pub use skill::{
    import_skill, inspect_skill, ImportMode, ImportTarget, SkillCapability, SkillImportOptions,
    SkillImportReport, SkillInspection, SkillStatus,
};
pub use skysight::{
    capture_skysight_snapshot, list_skysight_exclusions, pause_skysight, resume_skysight,
    run_skysight_daemon, skysight_status, start_skysight, stop_skysight, stop_skysight_if_owned,
    update_skysight_exclusion, SkysightExclusion, SkysightExclusionUpdate, SkysightPaths,
    SkysightStartOptions, SkysightStatus,
};
pub use timeline::{
    append_timeline_record, parse_timeline_line, read_timeline, TimelineEvent, TimelineParseError,
    TimelineRecord, TimelineValidationError, TimelineValidationReport,
};

#[derive(Debug, Parser)]
#[command(name = "codex-record-replay-linux")]
#[command(about = "Linux Record & Replay demo-to-skill compiler helpers.")]
pub struct Cli {
    #[command(subcommand)]
    pub command: Commands,
}

#[derive(Debug, Subcommand)]
pub enum Commands {
    /// Run the Record & Replay event-stream MCP server.
    Mcp,
    /// Official-shaped helper namespace used by the bundled plugin.
    #[command(name = "event-stream")]
    EventStream {
        #[command(subcommand)]
        command: EventStreamCommand,
    },
    /// Report Linux Record & Replay capability readiness.
    Doctor,
    /// Report the current shared recording status for app UI surfaces.
    Status,
    /// Manage recording lifecycle commands.
    Record {
        #[command(subcommand)]
        command: RecordCommand,
    },
    /// Work with recording bundles.
    Bundle {
        #[command(subcommand)]
        command: BundleCommand,
    },
    /// Inspect and import generated skills.
    Skill {
        #[command(subcommand)]
        command: SkillCommand,
    },
    /// Manage Linux Skysight recent-activity memory.
    Skysight {
        #[command(subcommand)]
        command: SkysightCommand,
    },
}

#[derive(Debug, Subcommand)]
pub enum EventStreamCommand {
    /// Run the Record & Replay event-stream MCP server.
    Mcp,
}

#[derive(Debug, Subcommand)]
pub enum SkysightCommand {
    /// Run the Skysight MCP tools on the event-stream server.
    Mcp,
    /// Start the Linux Skysight background daemon.
    Start(SkysightStartArgs),
    /// Print current Linux Skysight status and resource paths.
    Status,
    /// Stop the Linux Skysight background daemon.
    Stop,
    /// Pause the Linux Skysight background daemon without deleting memory resources.
    Pause(SkysightPauseArgs),
    /// Resume the Linux Skysight background daemon after a pause.
    Resume,
    /// Capture one Skysight snapshot without starting a daemon.
    Snapshot(SkysightSnapshotArgs),
    /// Run the foreground Skysight daemon loop.
    Daemon(SkysightStartArgs),
    /// Add, update, or remove an app/domain exclusion.
    UpdateExclusion(SkysightExclusionArgs),
    /// List app/domain exclusions.
    ListExclusions,
}

#[derive(Debug, Subcommand)]
pub enum RecordCommand {
    /// Start a recording session and initialize the bundle layout.
    Start(RecordStartArgs),
    /// Add an intentional user marker to the recording timeline.
    Mark(RecordMarkArgs),
    /// Add spoken user context to the recording timeline.
    Speech(RecordSpeechArgs),
    /// Add a browser/CDP-style trace artifact to the recording timeline.
    BrowserTrace(RecordBrowserTraceArgs),
    /// Capture focused desktop window metadata as semantic workflow evidence.
    DesktopSnapshot(RecordDesktopSnapshotArgs),
    /// Stop a recording session and append the stop marker.
    Stop(SessionDirArgs),
    /// Cancel a recording session and mark whether the bundle was discarded.
    Cancel(SessionCancelArgs),
}

#[derive(Debug, Args)]
pub struct RecordStartArgs {
    #[arg(long)]
    pub session_dir: PathBuf,
    #[arg(long)]
    pub app_id: Option<String>,
    #[arg(long)]
    pub window_id: Option<String>,
    #[arg(long)]
    pub goal: Option<String>,
    #[arg(long)]
    pub no_screenshot: bool,
    #[arg(long)]
    pub no_accessibility: bool,
    #[arg(
        long,
        help = "Capture native Linux audio evidence when CODEX_RECORD_REPLAY_AUDIO is enabled"
    )]
    pub audio: bool,
    #[arg(long, help = "Do not capture native Linux audio evidence")]
    pub no_audio: bool,
}

#[derive(Debug, Args)]
pub struct SkysightStartArgs {
    #[arg(long, default_value_t = 60)]
    pub interval_seconds: u64,
    #[arg(long, value_enum)]
    pub summary_agent: Option<SkysightSummaryAgentArg>,
    /// Initiating surface for this explicit continuous capture start.
    #[arg(long)]
    pub source: Option<String>,
    /// Capture owner, such as manual-continuous or recording-session:<id>.
    #[arg(long)]
    pub owner: Option<String>,
}

#[derive(Debug, Clone, Copy, ValueEnum)]
pub enum SkysightSummaryAgentArg {
    Enabled,
    Disabled,
}

impl SkysightSummaryAgentArg {
    fn as_bool(self) -> bool {
        matches!(self, Self::Enabled)
    }
}

#[derive(Debug, Args)]
pub struct SkysightSnapshotArgs {
    #[arg(long)]
    pub source: Option<String>,
}

#[derive(Debug, Args)]
pub struct SkysightPauseArgs {
    #[arg(long)]
    pub reason: Option<String>,
}

#[derive(Debug, Args)]
pub struct SkysightExclusionArgs {
    #[arg(long)]
    pub kind: String,
    #[arg(long)]
    pub value: String,
    #[arg(long)]
    pub reason: Option<String>,
    #[arg(long)]
    pub remove: bool,
}

#[derive(Debug, Args)]
pub struct RecordMarkArgs {
    #[arg(long)]
    pub session_dir: PathBuf,
    #[arg(long)]
    pub note: String,
}

#[derive(Debug, Args)]
pub struct RecordSpeechArgs {
    #[arg(long)]
    pub session_dir: PathBuf,
    #[arg(long)]
    pub text: String,
    #[arg(long)]
    pub source: Option<String>,
}

#[derive(Debug, Args)]
pub struct RecordBrowserTraceArgs {
    #[arg(long)]
    pub session_dir: PathBuf,
    #[arg(long)]
    pub trace_json: Option<String>,
    #[arg(long, value_name = "FILE")]
    pub trace_file: Option<PathBuf>,
    #[arg(long)]
    pub url: Option<String>,
    #[arg(long)]
    pub title: Option<String>,
    #[arg(long)]
    pub source: Option<String>,
}

#[derive(Debug, Args)]
pub struct RecordDesktopSnapshotArgs {
    #[arg(long)]
    pub session_dir: PathBuf,
    #[arg(long)]
    pub source: Option<String>,
}

#[derive(Debug, Args)]
pub struct SessionDirArgs {
    #[arg(long)]
    pub session_dir: PathBuf,
}

#[derive(Debug, Args)]
pub struct SessionCancelArgs {
    #[arg(long)]
    pub session_dir: PathBuf,
    #[arg(long)]
    pub discarded: bool,
}

#[derive(Debug, Subcommand)]
pub enum BundleCommand {
    /// Validate an existing recording bundle.
    Validate(SessionBundleArgs),
    /// Print the draft-skill prompt for a recording bundle.
    DraftPrompt(SessionBundleArgs),
}

#[derive(Debug, Args)]
pub struct SessionBundleArgs {
    #[arg(long, value_name = "DIR")]
    pub bundle: PathBuf,
}

#[derive(Debug, Subcommand)]
pub enum SkillCommand {
    /// Inspect a skill directory without executing skill-owned files.
    Inspect(SkillPathArgs),
    /// Copy or symlink a skill directory into a Codex skill root.
    Import(SkillImportArgs),
}

#[derive(Debug, Args)]
pub struct SkillPathArgs {
    #[arg(long, value_name = "DIR")]
    pub source: PathBuf,
}

#[derive(Debug, Args)]
pub struct SkillImportArgs {
    #[arg(long, value_name = "DIR")]
    pub source: PathBuf,
    #[arg(long, value_enum, default_value_t = ImportTargetArg::User)]
    pub target: ImportTargetArg,
    #[arg(long)]
    pub target_dir: Option<PathBuf>,
    #[arg(long, value_enum, default_value_t = ImportModeArg::Copy)]
    pub mode: ImportModeArg,
    #[arg(long)]
    pub dry_run: bool,
    #[arg(long)]
    pub allow_unsupported: bool,
}

#[derive(Debug, Clone, Copy, ValueEnum)]
pub enum ImportTargetArg {
    User,
    Repo,
    Explicit,
}

impl From<ImportTargetArg> for ImportTarget {
    fn from(value: ImportTargetArg) -> Self {
        match value {
            ImportTargetArg::User => Self::User,
            ImportTargetArg::Repo => Self::Repo,
            ImportTargetArg::Explicit => Self::Explicit,
        }
    }
}

#[derive(Debug, Clone, Copy, ValueEnum)]
pub enum ImportModeArg {
    Copy,
    Symlink,
}

impl From<ImportModeArg> for ImportMode {
    fn from(value: ImportModeArg) -> Self {
        match value {
            ImportModeArg::Copy => Self::Copy,
            ImportModeArg::Symlink => Self::Symlink,
        }
    }
}

pub async fn command_json(command: Commands) -> Result<Value> {
    match command {
        Commands::Mcp => Ok(serde_json::json!({
            "ok": false,
            "command": "mcp",
            "message": "Run `codex-record-replay-linux mcp` to start the stdio MCP server.",
        })),
        Commands::EventStream { command } => match command {
            EventStreamCommand::Mcp => Ok(serde_json::json!({
                "ok": false,
                "command": "event-stream mcp",
                "message": "Run `SkyLinuxComputerUseClient event-stream mcp` from the bundled plugin to start the stdio MCP server.",
            })),
        },
        Commands::Skysight { command } => {
            let paths = SkysightPaths::from_env();
            match command {
                SkysightCommand::Mcp => Ok(serde_json::json!({
                    "ok": false,
                    "command": "skysight mcp",
                    "message": "Run `SkyLinuxComputerUseClient skysight mcp` to expose Skysight tools on the stdio MCP server.",
                })),
                SkysightCommand::Start(args) => Ok(serde_json::to_value(start_skysight(
                    &paths,
                    SkysightStartOptions {
                        interval_seconds: args.interval_seconds,
                        summary_agent: args.summary_agent.map(SkysightSummaryAgentArg::as_bool),
                        source: args.source,
                        owner: args.owner,
                    },
                )?)?),
                SkysightCommand::Status => Ok(serde_json::to_value(skysight_status(&paths)?)?),
                SkysightCommand::Stop => Ok(serde_json::to_value(stop_skysight(&paths)?)?),
                SkysightCommand::Pause(args) => {
                    Ok(serde_json::to_value(pause_skysight(&paths, args.reason)?)?)
                }
                SkysightCommand::Resume => Ok(serde_json::to_value(resume_skysight(&paths)?)?),
                SkysightCommand::Snapshot(args) => Ok(serde_json::to_value(
                    capture_skysight_snapshot(&paths, args.source.as_deref())?,
                )?),
                SkysightCommand::Daemon(args) => {
                    run_skysight_daemon(
                        &paths,
                        args.interval_seconds,
                        args.summary_agent.map(SkysightSummaryAgentArg::as_bool),
                        args.source,
                        args.owner,
                    )?;
                    Ok(serde_json::to_value(skysight_status(&paths)?)?)
                }
                SkysightCommand::UpdateExclusion(args) => {
                    let exclusions = update_skysight_exclusion(
                        &paths,
                        SkysightExclusionUpdate {
                            kind: args.kind,
                            value: args.value,
                            reason: args.reason,
                            remove: args.remove,
                        },
                    )?;
                    Ok(serde_json::json!({
                        "ok": true,
                        "command": "skysight.update-exclusion",
                        "exclusions": exclusions,
                    }))
                }
                SkysightCommand::ListExclusions => Ok(serde_json::json!({
                    "ok": true,
                    "command": "skysight.list-exclusions",
                    "exclusions": list_skysight_exclusions(&paths)?,
                })),
            }
        }
        Commands::Doctor => {
            codex_computer_use_linux::diagnostics::hydrate_session_bus_env();
            let diagnostics = codex_computer_use_linux::diagnostics::doctor_report();
            let backend_catalog = recording_backend_catalog(&diagnostics);
            Ok(serde_json::json!({
                "ok": true,
                "command": "doctor",
                "schema_version": 1,
                "recorders": available_recorders(&backend_catalog),
                "backend_catalog": backend_catalog,
                "diagnostics": diagnostics,
            }))
        }
        Commands::Status => Ok(serde_json::to_value(refresh_runtime_status())?),
        Commands::Record { command } => match command {
            RecordCommand::Start(args) => {
                let report = start_session(RecordStartOptions {
                    session_dir: args.session_dir,
                    app_id: args.app_id,
                    window_id: args.window_id,
                    goal: args.goal,
                    include_screenshot: !args.no_screenshot,
                    include_accessibility: !args.no_accessibility,
                    include_audio: args.audio && !args.no_audio,
                })
                .await?;
                Ok(serde_json::to_value(report)?)
            }
            RecordCommand::Mark(args) => {
                let record = mark_session(&args.session_dir, &args.note)?;
                Ok(serde_json::json!({
                    "ok": true,
                    "command": "record.mark",
                    "record": record,
                }))
            }
            RecordCommand::Speech(args) => {
                let record = record_speech_context(&args.session_dir, &args.text, args.source)?;
                Ok(serde_json::json!({
                    "ok": true,
                    "command": "record.speech",
                    "record": record,
                }))
            }
            RecordCommand::BrowserTrace(args) => {
                let trace = read_trace_json(args.trace_json, args.trace_file)?;
                let record = record_browser_trace(
                    &args.session_dir,
                    trace,
                    args.url,
                    args.title,
                    args.source.or_else(|| Some("browser-cdp".to_string())),
                )?;
                Ok(serde_json::json!({
                    "ok": true,
                    "command": "record.browser-trace",
                    "record": record,
                }))
            }
            RecordCommand::DesktopSnapshot(args) => {
                let record = record_desktop_snapshot(&args.session_dir, args.source).await?;
                Ok(serde_json::json!({
                    "ok": true,
                    "command": "record.desktop-snapshot",
                    "record": record,
                }))
            }
            RecordCommand::Stop(args) => {
                let record = stop_session(&args.session_dir)?;
                Ok(serde_json::json!({
                    "ok": true,
                    "command": "record.stop",
                    "record": record,
                }))
            }
            RecordCommand::Cancel(args) => {
                let session_dir = args.session_dir;
                let record = cancel_session(&session_dir, args.discarded)?;
                let manifest = crate::manifest::read_manifest(&session_dir).ok();
                let session_id = session_dir
                    .file_name()
                    .and_then(|name| name.to_str())
                    .map(str::to_string)
                    .unwrap_or_else(|| "recording".to_string());
                let session_directory_path = session_dir.clone();
                let events_path = session_dir.join(crate::manifest::EVENT_STREAM_EVENTS_FILE_NAME);
                let metadata_path =
                    session_dir.join(crate::manifest::EVENT_STREAM_SESSION_FILE_NAME);
                Ok(serde_json::json!({
                    "ok": true,
                    "command": "record.cancel",
                    "session_dir": session_dir,
                    "discarded": args.discarded,
                    "record": record,
                    "isRecording": false,
                    "sessionID": session_id,
                    "sessionDirectoryPath": session_directory_path,
                    "eventsPath": events_path,
                    "metadataPath": metadata_path,
                    "suppressedEventsPath": Value::Null,
                    "startedAt": manifest.as_ref().map(|manifest| manifest.started_at.clone()),
                    "endedAt": manifest.as_ref().and_then(|manifest| manifest.ended_at.clone()),
                    "endReason": manifest.as_ref().and_then(|manifest| manifest.end_reason.clone()),
                    "maxDurationSeconds": 30 * 60,
                }))
            }
        },
        Commands::Bundle { command } => match command {
            BundleCommand::Validate(args) => {
                let report = validate_bundle_dir(&args.bundle)?;
                Ok(serde_json::to_value(report)?)
            }
            BundleCommand::DraftPrompt(args) => {
                let prompt = bundle_draft_prompt(&args.bundle)?;
                let validation = validate_draft_prompt(&prompt);
                Ok(serde_json::json!({
                    "ok": validation.is_valid(),
                    "command": "bundle.draft-prompt",
                    "draft_prompt": prompt,
                    "validation": validation,
                }))
            }
        },
        Commands::Skill { command } => match command {
            SkillCommand::Inspect(args) => Ok(serde_json::to_value(inspect_skill(&args.source)?)?),
            SkillCommand::Import(args) => {
                Ok(serde_json::to_value(import_skill(SkillImportOptions {
                    source: args.source,
                    target: args.target.into(),
                    target_dir: args.target_dir,
                    mode: args.mode.into(),
                    dry_run: args.dry_run,
                    allow_unsupported: args.allow_unsupported,
                    overwrite: false,
                })?)?)
            }
        },
    }
}

fn read_trace_json(trace_json: Option<String>, trace_file: Option<PathBuf>) -> Result<Value> {
    match (trace_json, trace_file) {
        (Some(raw), None) => Ok(serde_json::from_str(&raw)?),
        (None, Some(path)) => {
            let raw = std::fs::read_to_string(&path)?;
            Ok(serde_json::from_str(&raw)?)
        }
        (Some(_), Some(_)) => anyhow::bail!("pass either --trace-json or --trace-file, not both"),
        (None, None) => anyhow::bail!("pass --trace-json or --trace-file"),
    }
}
