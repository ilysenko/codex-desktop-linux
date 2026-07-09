use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::{
    fmt, fs,
    path::{Path, PathBuf},
};

pub const MANIFEST_FILE_NAME: &str = "manifest.json";
pub const TIMELINE_FILE_NAME: &str = "timeline.jsonl";
pub const EVENT_STREAM_SESSION_FILE_NAME: &str = "session.json";
pub const EVENT_STREAM_EVENTS_FILE_NAME: &str = "events.jsonl";
pub const EVENT_STREAM_SUPPRESSED_FILE_NAME: &str = "suppressed.jsonl";
pub const SCREENSHOTS_DIR_NAME: &str = "screenshots";
pub const ACCESSIBILITY_DIR_NAME: &str = "accessibility";
pub const BROWSER_DIR_NAME: &str = "browser";
pub const TRANSCRIPTS_DIR_NAME: &str = "transcripts";
pub const AUDIO_DIR_NAME: &str = "audio";
pub const INPUT_CAPTURE_DIR_NAME: &str = "input-capture";
pub const X11_DIR_NAME: &str = "x11";
pub const DIAGNOSTICS_FILE_NAME: &str = "diagnostics.json";
pub const DRAFT_PROMPT_FILE_NAME: &str = "draft-prompt.md";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileShape {
    #[serde(default = "default_timeline")]
    pub timeline: String,
    #[serde(default = "default_screenshots")]
    pub screenshots: String,
    #[serde(default = "default_accessibility")]
    pub accessibility: String,
    #[serde(default = "default_browser")]
    pub browser: String,
    #[serde(default = "default_transcripts")]
    pub transcripts: String,
    #[serde(default = "default_audio")]
    pub audio: String,
    #[serde(default = "default_input_capture")]
    pub input_capture: String,
    #[serde(default = "default_x11")]
    pub x11: String,
    #[serde(default = "default_diagnostics")]
    pub diagnostics: String,
    #[serde(default = "default_draft_prompt")]
    pub draft_prompt: String,
}

impl Default for FileShape {
    fn default() -> Self {
        Self {
            timeline: default_timeline(),
            screenshots: default_screenshots(),
            accessibility: default_accessibility(),
            browser: default_browser(),
            transcripts: default_transcripts(),
            audio: default_audio(),
            input_capture: default_input_capture(),
            x11: default_x11(),
            diagnostics: default_diagnostics(),
            draft_prompt: default_draft_prompt(),
        }
    }
}

impl FileShape {
    pub fn entries(&self) -> [(&'static str, &str); 10] {
        [
            ("timeline", self.timeline.as_str()),
            ("screenshots", self.screenshots.as_str()),
            ("accessibility", self.accessibility.as_str()),
            ("browser", self.browser.as_str()),
            ("transcripts", self.transcripts.as_str()),
            ("audio", self.audio.as_str()),
            ("input_capture", self.input_capture.as_str()),
            ("x11", self.x11.as_str()),
            ("diagnostics", self.diagnostics.as_str()),
            ("draft_prompt", self.draft_prompt.as_str()),
        ]
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecordingBundleManifest {
    pub schema_version: u32,
    pub session_id: String,
    pub started_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_reason: Option<String>,
    pub app_name: String,
    pub app_version: String,
    #[serde(default)]
    pub goal: Option<String>,
    #[serde(default)]
    pub target: RecordingTarget,
    #[serde(default)]
    pub files: FileShape,
    #[serde(default)]
    pub recorders: Vec<String>,
    #[serde(default)]
    pub backend_catalog: Vec<crate::RecordingBackend>,
    #[serde(default)]
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecordingTarget {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window_id: Option<String>,
}

impl RecordingBundleManifest {
    pub fn new(session_id: String, started_at: String) -> Self {
        Self {
            schema_version: 1,
            session_id,
            started_at,
            ended_at: None,
            end_reason: None,
            app_name: "chatgpt-desktop-linux".to_string(),
            app_version: env!("CARGO_PKG_VERSION").to_string(),
            goal: None,
            target: RecordingTarget::default(),
            files: FileShape::default(),
            recorders: Vec::new(),
            backend_catalog: Vec::new(),
            warnings: Vec::new(),
        }
    }

    pub fn validate(&self) -> BundleValidationReport {
        let mut report = BundleValidationReport {
            ok: true,
            bundle: None,
            errors: Vec::new(),
            warnings: Vec::new(),
        };

        if self.schema_version != 1 {
            report.errors.push(BundleValidationError::InvalidField {
                field: "schema_version".to_string(),
                reason: "unsupported schema version".to_string(),
            });
        }
        if self.session_id.trim().is_empty() {
            report
                .errors
                .push(BundleValidationError::MissingField("session_id"));
        }
        if self.started_at.trim().is_empty() {
            report
                .errors
                .push(BundleValidationError::MissingField("started_at"));
        }
        if self.app_name.trim().is_empty() {
            report
                .errors
                .push(BundleValidationError::MissingField("app_name"));
        }
        if self.app_version.trim().is_empty() {
            report
                .errors
                .push(BundleValidationError::MissingField("app_version"));
        }

        for (field, rel_path) in self.files.entries() {
            validate_bundle_relative_path(field, rel_path, &mut report);
        }

        report.ok = report.errors.is_empty();
        report
    }
}

pub fn read_manifest(bundle_dir: &Path) -> Result<RecordingBundleManifest> {
    let path = bundle_dir.join(MANIFEST_FILE_NAME);
    let raw = fs::read_to_string(&path)
        .with_context(|| format!("failed to read manifest at {}", path.display()))?;
    serde_json::from_str(&raw).with_context(|| format!("failed to parse {}", path.display()))
}

pub fn write_manifest(bundle_dir: &Path, manifest: &RecordingBundleManifest) -> Result<()> {
    let path = bundle_dir.join(MANIFEST_FILE_NAME);
    let rendered = format!("{}\n", serde_json::to_string_pretty(manifest)?);
    crate::secure_fs::write_private_file(&path, rendered.as_bytes())
        .with_context(|| format!("failed to write manifest at {}", path.display()))?;
    write_event_stream_session(bundle_dir, manifest)
}

pub(crate) fn refresh_event_stream_session(bundle_dir: &Path) -> Result<()> {
    let manifest = read_manifest(bundle_dir)?;
    write_event_stream_session(bundle_dir, &manifest)
}

fn write_event_stream_session(bundle_dir: &Path, manifest: &RecordingBundleManifest) -> Result<()> {
    let event_stream_path = bundle_dir.join(EVENT_STREAM_SESSION_FILE_NAME);
    let mut session = serde_json::to_value(manifest)?;
    session["eventCount"] = serde_json::json!(count_jsonl_lines(
        &bundle_dir.join(EVENT_STREAM_EVENTS_FILE_NAME)
    )?);
    session["suppressedEventCount"] = serde_json::json!(count_jsonl_lines(
        &bundle_dir.join(EVENT_STREAM_SUPPRESSED_FILE_NAME)
    )?);
    crate::secure_fs::write_private_file(
        &event_stream_path,
        format!("{}\n", serde_json::to_string_pretty(&session)?),
    )
    .with_context(|| {
        format!(
            "failed to write event-stream session at {}",
            event_stream_path.display()
        )
    })
}

fn count_jsonl_lines(path: &Path) -> Result<u64> {
    if !path.is_file() {
        return Ok(0);
    }
    let raw =
        fs::read_to_string(path).with_context(|| format!("failed to read {}", path.display()))?;
    Ok(raw.lines().filter(|line| !line.trim().is_empty()).count() as u64)
}

pub fn validate_bundle_dir(bundle_dir: &Path) -> Result<BundleValidationReport> {
    let manifest = read_manifest(bundle_dir)?;
    let mut report = manifest.validate();
    report.bundle = Some(bundle_dir.to_path_buf());

    if !bundle_dir.is_dir() {
        report.errors.push(BundleValidationError::MissingPath {
            path: bundle_dir.to_path_buf(),
            kind: "bundle directory".to_string(),
        });
    }

    for (field, rel_path) in manifest.files.entries() {
        let path = match checked_bundle_path(bundle_dir, field, rel_path) {
            Ok(path) => path,
            Err(error) => {
                report.errors.push(BundleValidationError::InvalidField {
                    field: field.to_string(),
                    reason: error.to_string(),
                });
                continue;
            }
        };
        let expected_dir = matches!(
            field,
            "screenshots"
                | "accessibility"
                | "browser"
                | "transcripts"
                | "audio"
                | "input_capture"
                | "x11"
        );
        if !path.exists() {
            if field != "draft_prompt" {
                report.errors.push(BundleValidationError::MissingPath {
                    path,
                    kind: field.to_string(),
                });
            }
        } else if expected_dir && !path.is_dir() {
            report.errors.push(BundleValidationError::InvalidField {
                field: field.to_string(),
                reason: "expected directory".to_string(),
            });
        } else if !expected_dir && !path.is_file() {
            report.errors.push(BundleValidationError::InvalidField {
                field: field.to_string(),
                reason: "expected file".to_string(),
            });
        }
    }

    if let Ok(timeline_path) = checked_bundle_path(bundle_dir, "timeline", &manifest.files.timeline)
    {
        if timeline_path.exists() {
            let raw = fs::read_to_string(&timeline_path)
                .with_context(|| format!("failed to read {}", timeline_path.display()))?;
            let mut expected_timeline_index = 0u64;
            for (line_index, line) in raw.lines().enumerate() {
                if line.trim().is_empty() {
                    continue;
                }
                match crate::timeline::parse_timeline_line(line) {
                    Ok(record) => {
                        if record.index != expected_timeline_index {
                            report.errors.push(BundleValidationError::InvalidField {
                                field: format!("timeline:{}", line_index + 1),
                                reason: format!(
                                    "expected index {expected_timeline_index}, got {}",
                                    record.index
                                ),
                            });
                        }
                        expected_timeline_index += 1;
                        let timeline_report = record.validate();
                        report
                            .errors
                            .extend(timeline_report.errors.into_iter().map(|error| {
                                BundleValidationError::InvalidField {
                                    field: format!("timeline:{}", line_index + 1),
                                    reason: error.to_string(),
                                }
                            }));
                        report.warnings.extend(timeline_report.warnings);
                    }
                    Err(error) => report.errors.push(BundleValidationError::InvalidField {
                        field: format!("timeline:{}", line_index + 1),
                        reason: error.to_string(),
                    }),
                }
            }
        }
    }

    if let Ok(draft_path) =
        checked_bundle_path(bundle_dir, "draft_prompt", &manifest.files.draft_prompt)
    {
        if draft_path.exists() {
            let raw = fs::read_to_string(&draft_path)
                .with_context(|| format!("failed to read {}", draft_path.display()))?;
            if raw.trim().is_empty() {
                report
                    .warnings
                    .push("draft prompt has not been generated".to_string());
            } else {
                let draft_report = crate::draft_prompt::validate_draft_prompt(&raw);
                report
                    .errors
                    .extend(draft_report.issues.into_iter().map(|error| {
                        BundleValidationError::InvalidField {
                            field: "draft_prompt".to_string(),
                            reason: error.to_string(),
                        }
                    }));
                report.warnings.extend(draft_report.warnings);
            }
        }
    }

    report.ok = report.errors.is_empty();
    Ok(report)
}

pub fn checked_bundle_path(
    bundle_dir: &Path,
    field: &'static str,
    rel_path: &str,
) -> Result<PathBuf> {
    validate_bundle_relative_path_value(field, rel_path)?;
    let path = bundle_dir.join(rel_path);
    ensure_bundle_contained_path(bundle_dir, &path, field)?;
    Ok(path)
}

fn validate_bundle_relative_path(
    field: &'static str,
    rel_path: &str,
    report: &mut BundleValidationReport,
) {
    if let Err(error) = validate_bundle_relative_path_value(field, rel_path) {
        report.errors.push(BundleValidationError::InvalidPath {
            field: field.to_string(),
            value: rel_path.to_string(),
            reason: error.to_string(),
        });
    }
}

fn validate_bundle_relative_path_value(field: &'static str, rel_path: &str) -> Result<()> {
    if rel_path.trim().is_empty() {
        bail!("empty");
    }
    if Path::new(rel_path).is_absolute() {
        bail!("must be relative");
    }
    if rel_path.contains("..") {
        bail!("must not contain ..");
    }
    if rel_path.contains('\\') {
        bail!("must use forward slashes");
    }
    if rel_path == "." {
        bail!("{field} path must name a file or directory");
    }
    Ok(())
}

fn ensure_bundle_contained_path(bundle_dir: &Path, path: &Path, field: &'static str) -> Result<()> {
    let bundle_root = bundle_dir.canonicalize().with_context(|| {
        format!(
            "failed to canonicalize bundle directory {}",
            bundle_dir.display()
        )
    })?;
    if let Ok(metadata) = fs::symlink_metadata(path) {
        if metadata.file_type().is_symlink() {
            bail!("{field} path must not be a symlink");
        }
    }
    if let Some(parent) = path.parent() {
        if parent.exists() {
            let canonical_parent = parent.canonicalize().with_context(|| {
                format!("failed to canonicalize bundle path {}", parent.display())
            })?;
            if !canonical_parent.starts_with(&bundle_root) {
                bail!("{field} path escapes the bundle directory");
            }
        }
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BundleValidationReport {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bundle: Option<PathBuf>,
    pub errors: Vec<BundleValidationError>,
    pub warnings: Vec<String>,
}

impl BundleValidationReport {
    pub fn is_valid(&self) -> bool {
        self.ok && self.errors.is_empty()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub enum BundleValidationError {
    MissingField(&'static str),
    InvalidField {
        field: String,
        reason: String,
    },
    InvalidPath {
        field: String,
        value: String,
        reason: String,
    },
    MissingPath {
        path: PathBuf,
        kind: String,
    },
}

impl fmt::Display for BundleValidationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingField(field) => write!(f, "missing manifest field: {field}"),
            Self::InvalidField { field, reason } => write!(f, "{field} is invalid: {reason}"),
            Self::InvalidPath {
                field,
                value,
                reason,
            } => write!(f, "{field} path '{value}' is invalid: {reason}"),
            Self::MissingPath { path, kind } => write!(f, "missing {kind}: {}", path.display()),
        }
    }
}

fn default_timeline() -> String {
    TIMELINE_FILE_NAME.to_string()
}

fn default_screenshots() -> String {
    SCREENSHOTS_DIR_NAME.to_string()
}

fn default_accessibility() -> String {
    ACCESSIBILITY_DIR_NAME.to_string()
}

fn default_browser() -> String {
    BROWSER_DIR_NAME.to_string()
}

fn default_transcripts() -> String {
    TRANSCRIPTS_DIR_NAME.to_string()
}

fn default_audio() -> String {
    AUDIO_DIR_NAME.to_string()
}

fn default_input_capture() -> String {
    INPUT_CAPTURE_DIR_NAME.to_string()
}

fn default_x11() -> String {
    X11_DIR_NAME.to_string()
}

fn default_diagnostics() -> String {
    DIAGNOSTICS_FILE_NAME.to_string()
}

fn default_draft_prompt() -> String {
    DRAFT_PROMPT_FILE_NAME.to_string()
}
