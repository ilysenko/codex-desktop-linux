use anyhow::{Context, Result};
use rmcp::{
    handler::server::wrapper::{Json, Parameters},
    schemars::JsonSchema,
    tool, tool_handler, tool_router, ServerHandler, ServiceExt,
};
use serde::{Deserialize, Serialize};
use std::{
    env, fs,
    io::{self, Read, Write},
    os::unix::{fs::PermissionsExt, process::CommandExt},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
};

const SETTINGS_KOKORO_PYTHON: &str = "codex-linux-read-aloud-kokoro-python";
const SETTINGS_KOKORO_MODEL: &str = "codex-linux-read-aloud-kokoro-model";
const SETTINGS_KOKORO_VOICES: &str = "codex-linux-read-aloud-kokoro-voices";
const SETTINGS_KOKORO_SPEED: &str = "codex-linux-read-aloud-kokoro-speed";
const DEFAULT_KOKORO_VOICE: &str = "bm_george";
const DEFAULT_KOKORO_LANG: &str = "en-us";
const DEFAULT_KOKORO_SPEED: f32 = 1.05;
const MIN_KOKORO_SPEED: f32 = 0.70;
const MAX_KOKORO_SPEED: f32 = 1.40;
const DEFAULT_MAX_CHARS: usize = 12_000;

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    match env::args().nth(1).as_deref() {
        Some("mcp") => serve_mcp().await,
        Some("doctor") => {
            println!("{}", serde_json::to_string_pretty(&doctor_report(None))?);
            Ok(())
        }
        Some("speak") => {
            let mut text = env::args().skip(2).collect::<Vec<_>>().join(" ");
            if text.trim().is_empty() {
                io::stdin()
                    .read_to_string(&mut text)
                    .context("failed to read text from stdin")?;
            }
            let server = ReadAloudLinux::default();
            let output = server.read_aloud_inner(ReadAloudParams {
                text,
                interrupt: Some(true),
                max_chars: None,
                pace: None,
                voice: None,
            });
            println!("{}", serde_json::to_string_pretty(&output)?);
            Ok(())
        }
        Some("--help") | Some("-h") => {
            print_help();
            Ok(())
        }
        Some(command) => {
            anyhow::bail!("unknown command '{command}'. Expected one of: mcp, doctor, speak")
        }
        None => {
            print_help();
            Ok(())
        }
    }
}

fn print_help() {
    println!(
        "codex-read-aloud-linux\n\nUsage:\n  codex-read-aloud-linux mcp\n  codex-read-aloud-linux doctor\n  codex-read-aloud-linux speak [TEXT]\n\nThe MCP server exposes doctor, read_aloud, and stop."
    );
}

#[derive(Clone, Default)]
struct ReadAloudLinux {
    active: Arc<Mutex<Option<ActiveSpeech>>>,
}

#[derive(Debug, Clone)]
struct ActiveSpeech {
    process_group_id: u32,
    backend: String,
}

#[tool_router]
impl ReadAloudLinux {
    #[tool(
        name = "doctor",
        description = "Report Linux Read Aloud readiness, including Kokoro model paths and native fallback state."
    )]
    fn doctor(&self) -> Json<DoctorReport> {
        let active_backend = self
            .active
            .lock()
            .ok()
            .and_then(|guard| guard.as_ref().map(|active| active.backend.clone()));
        Json(doctor_report(active_backend))
    }

    #[tool(
        name = "read_aloud",
        description = "Read the provided text aloud on Linux. Call this only when the user explicitly asks to listen to a response or is in an explicit voice mode."
    )]
    fn read_aloud(&self, Parameters(params): Parameters<ReadAloudParams>) -> Json<ReadAloudOutput> {
        Json(self.read_aloud_inner(params))
    }

    #[tool(
        name = "stop",
        description = "Stop the current Read Aloud playback started by this MCP server."
    )]
    fn stop(&self) -> Json<StopOutput> {
        Json(self.stop_inner())
    }
}

#[tool_handler(
    name = "codex-read-aloud-linux",
    version = "0.1.0",
    instructions = "Use Read Aloud only after the user explicitly asks to hear text or enters an explicit voice/conversation mode. Call doctor before first use in a session when setup is uncertain. Use read_aloud with interrupt=true when the user asks to read a newer answer or steer an active spoken response. Call stop when the user asks to stop speaking."
)]
impl ServerHandler for ReadAloudLinux {}

async fn serve_mcp() -> Result<()> {
    ReadAloudLinux::default()
        .serve(rmcp::transport::stdio())
        .await?
        .waiting()
        .await?;
    Ok(())
}

impl ReadAloudLinux {
    fn read_aloud_inner(&self, params: ReadAloudParams) -> ReadAloudOutput {
        if env::consts::OS != "linux" {
            return ReadAloudOutput::not_started(
                "not-linux",
                "Read Aloud is only supported on Linux.",
            );
        }

        let max_chars = params
            .max_chars
            .unwrap_or(DEFAULT_MAX_CHARS)
            .clamp(1, 50_000);
        let text = clean_spoken_text(&params.text, max_chars);
        if text.is_empty() {
            return ReadAloudOutput::not_started("empty", "No speakable text was provided.");
        }

        let interrupt = params.interrupt.unwrap_or(true);
        if !interrupt && self.has_active_speech() {
            return ReadAloudOutput::not_started(
                "busy",
                "Read Aloud is already speaking. Retry with interrupt=true or call stop first.",
            );
        }
        if interrupt {
            let _ = self.stop_active();
        }

        match self.select_backend(&params) {
            Ok(backend) => match self.spawn_backend(backend, &text) {
                Ok(output) => output,
                Err(error) => ReadAloudOutput::not_started(
                    "spawn-failed",
                    format!("Failed to start Read Aloud: {error:#}"),
                ),
            },
            Err(output) => output,
        }
    }

    fn stop_inner(&self) -> StopOutput {
        match self.stop_active() {
            Some(active) => StopOutput {
                stopped: true,
                backend: Some(active.backend),
                message: "Stopped active Read Aloud playback.".to_string(),
            },
            None => StopOutput {
                stopped: false,
                backend: None,
                message: "No active Read Aloud playback was tracked by this MCP server."
                    .to_string(),
            },
        }
    }

    fn has_active_speech(&self) -> bool {
        self.active
            .lock()
            .map(|guard| guard.is_some())
            .unwrap_or(false)
    }

    fn stop_active(&self) -> Option<ActiveSpeech> {
        let active = self.active.lock().ok()?.take()?;
        terminate_process_group(active.process_group_id);
        Some(active)
    }

    fn select_backend(
        &self,
        params: &ReadAloudParams,
    ) -> std::result::Result<BackendCommand, ReadAloudOutput> {
        if let Some(command) = env_trimmed("CODEX_LINUX_READ_ALOUD_COMMAND") {
            if command_exists(&command) {
                return Ok(BackendCommand {
                    name: "custom".to_string(),
                    command,
                    args: Vec::new(),
                    envs: Vec::new(),
                    stdin: true,
                    note: "Using CODEX_LINUX_READ_ALOUD_COMMAND.".to_string(),
                });
            }
        }

        let kokoro = kokoro_config(params);
        let missing = kokoro.missing();
        if missing.is_empty() {
            return Ok(BackendCommand {
                name: "kokoro".to_string(),
                command: kokoro.runner.clone(),
                args: Vec::new(),
                envs: vec![
                    (
                        "CODEX_LINUX_READ_ALOUD_KOKORO_PYTHON".to_string(),
                        kokoro.python,
                    ),
                    (
                        "CODEX_LINUX_READ_ALOUD_KOKORO_MODEL".to_string(),
                        kokoro.model,
                    ),
                    (
                        "CODEX_LINUX_READ_ALOUD_KOKORO_VOICES".to_string(),
                        kokoro.voices,
                    ),
                    (
                        "CODEX_LINUX_READ_ALOUD_KOKORO_VOICE".to_string(),
                        kokoro.voice,
                    ),
                    (
                        "CODEX_LINUX_READ_ALOUD_KOKORO_SPEED".to_string(),
                        format!("{:.2}", kokoro.speed),
                    ),
                    (
                        "CODEX_LINUX_READ_ALOUD_KOKORO_LANG".to_string(),
                        kokoro.lang,
                    ),
                ],
                stdin: true,
                note: "Using the staged Kokoro ONNX runner.".to_string(),
            });
        }

        if native_fallback_enabled() {
            if command_exists("spd-say") {
                return Ok(BackendCommand {
                    name: "spd-say".to_string(),
                    command: "spd-say".to_string(),
                    args: spd_say_args(),
                    envs: Vec::new(),
                    stdin: false,
                    note: "Using native spd-say fallback.".to_string(),
                });
            }
            if command_exists("espeak-ng") {
                return Ok(BackendCommand {
                    name: "espeak-ng".to_string(),
                    command: "espeak-ng".to_string(),
                    args: vec![
                        "-v".to_string(),
                        env_trimmed("CODEX_LINUX_READ_ALOUD_VOICE")
                            .unwrap_or_else(|| "en-us".to_string()),
                        "-s".to_string(),
                        env_trimmed("CODEX_LINUX_READ_ALOUD_ESPEAK_RATE")
                            .unwrap_or_else(|| "165".to_string()),
                        "--".to_string(),
                    ],
                    envs: Vec::new(),
                    stdin: false,
                    note: "Using native espeak-ng fallback.".to_string(),
                });
            }
        }

        Err(ReadAloudOutput {
            started: false,
            backend: None,
            reason: Some("kokoro-unavailable".to_string()),
            message: format!(
                "Kokoro is not ready: {}. Run the Read Aloud setup/download flow or provide the paths with CODEX_LINUX_READ_ALOUD_KOKORO_*.",
                missing.join(", ")
            ),
        })
    }

    fn spawn_backend(&self, mut backend: BackendCommand, text: &str) -> Result<ReadAloudOutput> {
        if !backend.stdin {
            backend.args.push(text.to_string());
        }

        let mut command = Command::new(&backend.command);
        command
            .args(&backend.args)
            .stdin(if backend.stdin {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        for (key, value) in &backend.envs {
            command.env(key, value);
        }
        for (key, value) in audio_session_envs() {
            command.env(key, value);
        }

        unsafe {
            command.pre_exec(|| {
                if libc::setsid() == -1 {
                    Err(io::Error::last_os_error())
                } else {
                    Ok(())
                }
            });
        }

        let mut child = command
            .spawn()
            .with_context(|| format!("failed to spawn {}", backend.command))?;
        if backend.stdin {
            if let Some(mut stdin) = child.stdin.take() {
                if let Err(error) = stdin.write_all(text.as_bytes()) {
                    terminate_process_group(child.id());
                    return Err(error)
                        .with_context(|| format!("failed to write text to {}", backend.command));
                }
            }
        }

        let process_group_id = child.id();
        let active = ActiveSpeech {
            process_group_id,
            backend: backend.name.clone(),
        };
        if let Ok(mut guard) = self.active.lock() {
            *guard = Some(active);
        }
        self.reap_when_done(child, process_group_id);

        Ok(ReadAloudOutput {
            started: true,
            backend: Some(backend.name),
            reason: None,
            message: backend.note,
        })
    }

    fn reap_when_done(&self, mut child: Child, process_group_id: u32) {
        let active = Arc::clone(&self.active);
        thread::spawn(move || {
            let _ = child.wait();
            if let Ok(mut guard) = active.lock() {
                if guard
                    .as_ref()
                    .map(|entry| entry.process_group_id == process_group_id)
                    .unwrap_or(false)
                {
                    *guard = None;
                }
            }
        });
    }
}

#[derive(Debug, Clone)]
struct BackendCommand {
    name: String,
    command: String,
    args: Vec<String>,
    envs: Vec<(String, String)>,
    stdin: bool,
    note: String,
}

#[derive(Debug, Clone)]
struct KokoroConfig {
    runner: String,
    python: String,
    model: String,
    voices: String,
    voice: String,
    speed: f32,
    lang: String,
}

impl KokoroConfig {
    fn missing(&self) -> Vec<String> {
        let mut missing = Vec::new();
        if !command_exists(&self.runner) {
            missing.push(format!("runner {}", self.runner));
        }
        if !is_executable(Path::new(&self.python)) {
            missing.push(format!("python {}", self.python));
        }
        if !Path::new(&self.model).is_file() {
            missing.push(format!("model {}", self.model));
        }
        if !Path::new(&self.voices).is_file() {
            missing.push(format!("voices {}", self.voices));
        }
        if !command_exists("aplay") {
            missing.push("aplay".to_string());
        }
        missing
    }
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
struct ReadAloudParams {
    /// Text to speak aloud.
    text: String,
    /// Stop any active playback first. Defaults to true.
    interrupt: Option<bool>,
    /// Maximum number of cleaned characters to speak. Defaults to 12000.
    max_chars: Option<usize>,
    /// Kokoro pace override for this utterance. Clamped to 0.70-1.40.
    pace: Option<f32>,
    /// Kokoro voice override for this utterance.
    voice: Option<String>,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
struct ReadAloudOutput {
    started: bool,
    backend: Option<String>,
    reason: Option<String>,
    message: String,
}

impl ReadAloudOutput {
    fn not_started(reason: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            started: false,
            backend: None,
            reason: Some(reason.into()),
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
struct StopOutput {
    stopped: bool,
    backend: Option<String>,
    message: String,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
struct DoctorReport {
    platform: String,
    available: bool,
    preferred_backend: Option<String>,
    active_backend: Option<String>,
    kokoro: KokoroDoctor,
    custom_command: Option<CommandDoctor>,
    native_fallback_enabled: bool,
    native_fallbacks: Vec<CommandDoctor>,
    message: String,
    setup_hint: String,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
struct KokoroDoctor {
    available: bool,
    runner: PathDoctor,
    python: PathDoctor,
    model: PathDoctor,
    voices: PathDoctor,
    aplay: CommandDoctor,
    voice: String,
    speed: f32,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
struct PathDoctor {
    path: String,
    exists: bool,
    executable: bool,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
struct CommandDoctor {
    command: String,
    available: bool,
    resolved_path: Option<String>,
}

fn doctor_report(active_backend: Option<String>) -> DoctorReport {
    let kokoro = kokoro_config(&ReadAloudParams {
        text: String::new(),
        interrupt: None,
        max_chars: None,
        pace: None,
        voice: None,
    });
    let kokoro_doctor = KokoroDoctor {
        available: kokoro.missing().is_empty(),
        runner: path_doctor(&kokoro.runner),
        python: path_doctor(&kokoro.python),
        model: path_doctor(&kokoro.model),
        voices: path_doctor(&kokoro.voices),
        aplay: command_doctor("aplay"),
        voice: kokoro.voice,
        speed: kokoro.speed,
    };

    let custom_command =
        env_trimmed("CODEX_LINUX_READ_ALOUD_COMMAND").map(|command| command_doctor(&command));
    let native_fallback_enabled = native_fallback_enabled();
    let native_fallbacks = ["spd-say", "espeak-ng"]
        .iter()
        .map(|command| command_doctor(command))
        .collect::<Vec<_>>();
    let available = custom_command
        .as_ref()
        .map(|cmd| cmd.available)
        .unwrap_or(false)
        || kokoro_doctor.available
        || (native_fallback_enabled && native_fallbacks.iter().any(|cmd| cmd.available));
    let preferred_backend = if custom_command
        .as_ref()
        .map(|cmd| cmd.available)
        .unwrap_or(false)
    {
        Some("custom".to_string())
    } else if kokoro_doctor.available {
        Some("kokoro".to_string())
    } else if native_fallback_enabled && native_fallbacks.iter().any(|cmd| cmd.available) {
        Some("native".to_string())
    } else {
        None
    };
    let message = if available {
        "Read Aloud has an available speech backend.".to_string()
    } else {
        "Read Aloud is installed but no speech backend is ready.".to_string()
    };

    DoctorReport {
        platform: env::consts::OS.to_string(),
        available,
        preferred_backend,
        active_backend,
        kokoro: kokoro_doctor,
        custom_command,
        native_fallback_enabled,
        native_fallbacks,
        message,
        setup_hint: "Use the Read Aloud settings download flow, run linux-features/read-aloud/install-kokoro-runtime.sh, or set CODEX_LINUX_READ_ALOUD_KOKORO_PYTHON/MODEL/VOICES.".to_string(),
    }
}

fn kokoro_config(params: &ReadAloudParams) -> KokoroConfig {
    let settings = read_settings_json();
    let data_home = xdg_data_home();
    let runner =
        env_trimmed("CODEX_LINUX_READ_ALOUD_KOKORO_RUNNER").unwrap_or_else(default_kokoro_runner);
    let python = env_trimmed("CODEX_LINUX_READ_ALOUD_KOKORO_PYTHON")
        .or_else(|| settings_string(&settings, SETTINGS_KOKORO_PYTHON))
        .unwrap_or_else(|| {
            data_home
                .join("chatgpt-desktop/read-aloud/kokoro-venv/bin/python")
                .display()
                .to_string()
        });
    let model = env_trimmed("CODEX_LINUX_READ_ALOUD_KOKORO_MODEL")
        .or_else(|| settings_string(&settings, SETTINGS_KOKORO_MODEL))
        .unwrap_or_else(|| {
            data_home
                .join("kokoro/kokoro-v1.0.onnx")
                .display()
                .to_string()
        });
    let voices = env_trimmed("CODEX_LINUX_READ_ALOUD_KOKORO_VOICES")
        .or_else(|| settings_string(&settings, SETTINGS_KOKORO_VOICES))
        .unwrap_or_else(|| {
            data_home
                .join("kokoro/voices-v1.0.bin")
                .display()
                .to_string()
        });
    let speed = params
        .pace
        .or_else(|| {
            env_trimmed("CODEX_LINUX_READ_ALOUD_KOKORO_SPEED").and_then(|value| value.parse().ok())
        })
        .or_else(|| {
            settings
                .get(SETTINGS_KOKORO_SPEED)
                .and_then(|value| value.as_f64())
                .map(|value| value as f32)
        })
        .unwrap_or(DEFAULT_KOKORO_SPEED)
        .clamp(MIN_KOKORO_SPEED, MAX_KOKORO_SPEED);
    let voice = params
        .voice
        .as_deref()
        .and_then(non_empty)
        .map(str::to_string)
        .or_else(|| env_trimmed("CODEX_LINUX_READ_ALOUD_KOKORO_VOICE"))
        .unwrap_or_else(|| DEFAULT_KOKORO_VOICE.to_string());
    let lang = env_trimmed("CODEX_LINUX_READ_ALOUD_KOKORO_LANG")
        .unwrap_or_else(|| DEFAULT_KOKORO_LANG.to_string());

    KokoroConfig {
        runner,
        python,
        model,
        voices,
        voice,
        speed,
        lang,
    }
}

fn default_kokoro_runner() -> String {
    if let Ok(exe) = env::current_exe() {
        if let Some(parent) = exe.parent() {
            let bundled = parent.join("kokoro-stdin");
            if bundled.exists() {
                return bundled.display().to_string();
            }
        }
    }
    "kokoro-stdin".to_string()
}

fn read_settings_json() -> serde_json::Map<String, serde_json::Value> {
    let path = env_trimmed("CODEX_LINUX_READ_ALOUD_SETTINGS_JSON")
        .or_else(|| env_trimmed("CODEX_LINUX_SETTINGS_FILE"))
        .map(PathBuf::from)
        .unwrap_or_else(default_settings_path);
    let Ok(source) = fs::read_to_string(path) else {
        return serde_json::Map::new();
    };
    serde_json::from_str::<serde_json::Value>(&source)
        .ok()
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default()
}

fn default_settings_path() -> PathBuf {
    let app_id = env_trimmed("CODEX_LINUX_APP_ID")
        .or_else(|| env_trimmed("CODEX_APP_ID"))
        .filter(|value| is_safe_app_id(value))
        .unwrap_or_else(|| "chatgpt-desktop".to_string());
    xdg_config_home().join(app_id).join("settings.json")
}

fn is_safe_app_id(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn settings_string(
    settings: &serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> Option<String> {
    settings
        .get(key)?
        .as_str()
        .and_then(non_empty)
        .map(str::to_string)
}

fn non_empty(value: &str) -> Option<&str> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

fn clean_spoken_text(text: &str, max_chars: usize) -> String {
    let mut cleaned = String::new();
    let mut in_fence = false;
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("```") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence || trimmed.starts_with("::") {
            continue;
        }
        let line = trimmed
            .trim_start_matches('#')
            .trim_start_matches('>')
            .trim_start_matches("- ")
            .trim_start_matches("* ")
            .replace(['`', '*', '_'], "");
        if !line.trim().is_empty() {
            if !cleaned.is_empty() {
                cleaned.push('\n');
            }
            cleaned.push_str(line.trim());
        }
        if cleaned.len() >= max_chars {
            cleaned = cleaned.chars().take(max_chars).collect();
            break;
        }
    }
    cleaned.trim().to_string()
}

fn path_doctor(path: &str) -> PathDoctor {
    let path_ref = Path::new(path);
    PathDoctor {
        path: path.to_string(),
        exists: path_ref.exists(),
        executable: is_executable(path_ref),
    }
}

fn command_doctor(command: &str) -> CommandDoctor {
    CommandDoctor {
        command: command.to_string(),
        available: command_exists(command),
        resolved_path: resolve_command(command).map(|path| path.display().to_string()),
    }
}

fn command_exists(command: &str) -> bool {
    resolve_command(command).is_some()
}

fn resolve_command(command: &str) -> Option<PathBuf> {
    if command.contains('/') {
        let path = PathBuf::from(command);
        return is_executable(&path).then_some(path);
    }
    env::var_os("PATH").and_then(|path| {
        env::split_paths(&path)
            .map(|dir| dir.join(command))
            .find(|candidate| is_executable(candidate))
    })
}

fn is_executable(path: &Path) -> bool {
    fs::metadata(path)
        .map(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

fn env_trimmed(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .and_then(|value| non_empty(&value).map(str::to_string))
}

fn spd_say_args() -> Vec<String> {
    let mut args = vec![
        "-r".to_string(),
        env_trimmed("CODEX_LINUX_READ_ALOUD_RATE").unwrap_or_else(|| "-10".to_string()),
    ];
    if let Some(voice_type) = env_trimmed("CODEX_LINUX_READ_ALOUD_VOICE_TYPE") {
        args.push("-t".to_string());
        args.push(voice_type);
    }
    if let Some(voice) = env_trimmed("CODEX_LINUX_READ_ALOUD_VOICE") {
        args.push("-y".to_string());
        args.push(voice);
    }
    args.extend(["-l".to_string(), "en".to_string(), "--".to_string()]);
    args
}

fn native_fallback_enabled() -> bool {
    env::var("CODEX_LINUX_READ_ALOUD_NATIVE_FALLBACK")
        .ok()
        .and_then(|value| non_empty(&value).map(|value| value.to_ascii_lowercase()))
        .map(|value| !matches!(value.as_str(), "0" | "false" | "off" | "no"))
        .unwrap_or(true)
}

fn audio_session_envs() -> Vec<(String, String)> {
    if env::var_os("XDG_RUNTIME_DIR").is_some() {
        return Vec::new();
    }
    default_xdg_runtime_dir()
        .map(|path| vec![("XDG_RUNTIME_DIR".to_string(), path.display().to_string())])
        .unwrap_or_default()
}

fn default_xdg_runtime_dir() -> Option<PathBuf> {
    let uid = unsafe { libc::getuid() };
    let runtime_dir = PathBuf::from(format!("/run/user/{uid}"));
    if runtime_dir.join("pipewire-0").exists() || runtime_dir.join("pulse/native").exists() {
        Some(runtime_dir)
    } else {
        None
    }
}

fn xdg_config_home() -> PathBuf {
    env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir().join(".config"))
}

fn xdg_data_home() -> PathBuf {
    env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir().join(".local/share"))
}

fn home_dir() -> PathBuf {
    env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn terminate_process_group(process_group_id: u32) {
    let pgid = -(process_group_id as i32);
    unsafe {
        if libc::kill(pgid, libc::SIGTERM) == -1 {
            let _ = libc::kill(process_group_id as i32, libc::SIGTERM);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn clean_text_skips_code_fences_and_directives() {
        let text = "# Heading\nhello **world**\n```rust\nnope();\n```\n::code-comment{bad}\n- done";
        assert_eq!(clean_spoken_text(text, 100), "Heading\nhello world\ndone");
    }

    #[test]
    fn clean_text_respects_limit() {
        assert_eq!(clean_spoken_text("abcdef", 3), "abc");
    }

    #[test]
    fn non_empty_trims_values() {
        assert_eq!(non_empty("  hi  "), Some("hi"));
        assert_eq!(non_empty("   "), None);
    }

    #[test]
    fn default_runner_falls_back_to_path_lookup() {
        let runner = default_kokoro_runner();
        assert!(!runner.is_empty());
    }

    #[test]
    fn command_resolution_accepts_absolute_executable() {
        assert!(resolve_command("/bin/sh").is_some() || resolve_command("/usr/bin/sh").is_some());
    }

    #[test]
    fn app_id_settings_path_supports_side_by_side_apps() {
        let _guard = ENV_LOCK.lock().unwrap();
        let previous_app_id = env::var_os("CODEX_LINUX_APP_ID");
        let previous_codex_app_id = env::var_os("CODEX_APP_ID");
        env::set_var("CODEX_LINUX_APP_ID", "codex-desktop-5");
        env::set_var("CODEX_APP_ID", "codex-desktop");

        let path = default_settings_path();

        assert!(path.ends_with("codex-desktop-5/settings.json"));
        restore_env("CODEX_LINUX_APP_ID", previous_app_id);
        restore_env("CODEX_APP_ID", previous_codex_app_id);
    }

    #[test]
    fn app_id_settings_path_rejects_unsafe_app_ids() {
        let _guard = ENV_LOCK.lock().unwrap();
        let previous_app_id = env::var_os("CODEX_LINUX_APP_ID");
        let previous_codex_app_id = env::var_os("CODEX_APP_ID");
        env::set_var("CODEX_LINUX_APP_ID", "../bad");
        env::remove_var("CODEX_APP_ID");

        let path = default_settings_path();

        assert!(path.ends_with("chatgpt-desktop/settings.json"));
        restore_env("CODEX_LINUX_APP_ID", previous_app_id);
        restore_env("CODEX_APP_ID", previous_codex_app_id);
    }

    #[test]
    fn audio_session_envs_preserves_existing_runtime_dir() {
        let _guard = ENV_LOCK.lock().unwrap();
        let previous_runtime_dir = env::var_os("XDG_RUNTIME_DIR");
        env::set_var("XDG_RUNTIME_DIR", "/tmp/codex-existing-runtime");

        assert!(audio_session_envs().is_empty());
        restore_env("XDG_RUNTIME_DIR", previous_runtime_dir);
    }

    #[test]
    fn native_fallback_defaults_to_enabled() {
        let _guard = ENV_LOCK.lock().unwrap();
        let previous = env::var_os("CODEX_LINUX_READ_ALOUD_NATIVE_FALLBACK");
        env::remove_var("CODEX_LINUX_READ_ALOUD_NATIVE_FALLBACK");

        assert!(native_fallback_enabled());
        restore_env("CODEX_LINUX_READ_ALOUD_NATIVE_FALLBACK", previous);
    }

    #[test]
    fn native_fallback_can_be_disabled_explicitly() {
        let _guard = ENV_LOCK.lock().unwrap();
        let previous = env::var_os("CODEX_LINUX_READ_ALOUD_NATIVE_FALLBACK");

        for value in ["0", "false", "off", "no"] {
            env::set_var("CODEX_LINUX_READ_ALOUD_NATIVE_FALLBACK", value);
            assert!(
                !native_fallback_enabled(),
                "{value} should disable fallback"
            );
        }
        env::set_var("CODEX_LINUX_READ_ALOUD_NATIVE_FALLBACK", "1");
        assert!(native_fallback_enabled());
        restore_env("CODEX_LINUX_READ_ALOUD_NATIVE_FALLBACK", previous);
    }

    #[test]
    fn spd_say_args_do_not_force_voice_type_by_default() {
        let _guard = ENV_LOCK.lock().unwrap();
        let previous_type = env::var_os("CODEX_LINUX_READ_ALOUD_VOICE_TYPE");
        let previous_voice = env::var_os("CODEX_LINUX_READ_ALOUD_VOICE");
        env::remove_var("CODEX_LINUX_READ_ALOUD_VOICE_TYPE");
        env::remove_var("CODEX_LINUX_READ_ALOUD_VOICE");

        let args = spd_say_args();

        assert!(!args
            .windows(2)
            .any(|pair| pair[0] == "-t" && pair[1] == "female1"));
        assert!(!args.iter().any(|arg| arg == "-t"));
        restore_env("CODEX_LINUX_READ_ALOUD_VOICE_TYPE", previous_type);
        restore_env("CODEX_LINUX_READ_ALOUD_VOICE", previous_voice);
    }

    #[test]
    fn spd_say_args_honor_explicit_voice_type() {
        let _guard = ENV_LOCK.lock().unwrap();
        let previous_type = env::var_os("CODEX_LINUX_READ_ALOUD_VOICE_TYPE");
        env::set_var("CODEX_LINUX_READ_ALOUD_VOICE_TYPE", "male1");

        let args = spd_say_args();

        assert!(args
            .windows(2)
            .any(|pair| pair[0] == "-t" && pair[1] == "male1"));
        restore_env("CODEX_LINUX_READ_ALOUD_VOICE_TYPE", previous_type);
    }

    fn restore_env(name: &str, value: Option<std::ffi::OsString>) {
        match value {
            Some(value) => env::set_var(name, value),
            None => env::remove_var(name),
        }
    }
}
