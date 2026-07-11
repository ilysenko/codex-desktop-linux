//! Runtime configuration loading and XDG path discovery for the updater.

use anyhow::{Context, Result};
use chrono::Duration as ChronoDuration;
use directories::BaseDirs;
use serde::{Deserialize, Serialize};
use std::{
    ffi::OsString,
    fs::{self, File, Metadata, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    process,
    sync::atomic::{AtomicU64, Ordering},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tracing::warn;

const SERVICE_NAME: &str = "codex-update-manager";
const SECONDS_PER_HOUR: u64 = 60 * 60;
const DEFAULT_CHECK_INTERVAL_HOURS: u64 = 6;
const SETTINGS_LOCK_TIMEOUT: Duration = Duration::from_secs(2);
const SETTINGS_LOCK_RETRY_INTERVAL: Duration = Duration::from_millis(25);
const SETTINGS_LOCK_STALE_AFTER: Duration = Duration::from_secs(30);
const SETTINGS_RECOVERY_CLAIM_TTL: Duration = Duration::from_secs(1);
static SETTINGS_WRITE_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
/// Optional cleanup for generated wrapper checkout artifacts such as `dist/`
/// and `target/`. Disabled by default; when enabled, cleanup only runs if the
/// filesystem containing a configured root is below `min_free_bytes`.
pub struct GeneratedArtifactCleanupConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_generated_artifact_cleanup_min_free_bytes")]
    pub min_free_bytes: u64,
    #[serde(default)]
    pub roots: Vec<PathBuf>,
    #[serde(default = "default_generated_artifact_cleanup_entries")]
    pub entries: Vec<PathBuf>,
}

impl Default for GeneratedArtifactCleanupConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            min_free_bytes: default_generated_artifact_cleanup_min_free_bytes(),
            roots: Vec::new(),
            entries: default_generated_artifact_cleanup_entries(),
        }
    }
}

fn default_generated_artifact_cleanup_min_free_bytes() -> u64 {
    10 * 1024 * 1024 * 1024
}

fn default_generated_artifact_cleanup_entries() -> Vec<PathBuf> {
    ["codex-app", "codex-app-next", "dist", "dist-next", "target"]
        .into_iter()
        .map(PathBuf::from)
        .collect()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
/// Runtime configuration values that control how the updater behaves on Linux.
pub struct RuntimeConfig {
    pub dmg_url: String,
    pub initial_check_delay_seconds: u64,
    pub check_interval_hours: u64,
    pub auto_install_on_app_exit: bool,
    pub notifications: bool,
    pub workspace_root: PathBuf,
    pub builder_bundle_root: PathBuf,
    pub app_executable_path: PathBuf,
    /// Opt-in tracking of newer *wrapper* releases (this repo's own Linux
    /// features/fixes), in addition to the upstream Codex DMG. Off by default
    /// so existing installs keep their current DMG-only behavior.
    #[serde(default)]
    pub enable_wrapper_updates: bool,
    /// Git remote (name or URL) used to detect wrapper updates. Empty means
    /// "use the builder checkout's configured `origin`".
    #[serde(default)]
    pub wrapper_remote: String,
    /// Branch to track for wrapper updates.
    #[serde(default = "default_wrapper_branch")]
    pub wrapper_branch: String,
    /// Optional cleanup for generated wrapper checkout artifacts. This is
    /// intentionally opt-in so users keep manual build output unless they
    /// configure cleanup.
    #[serde(default)]
    pub generated_artifact_cleanup: GeneratedArtifactCleanupConfig,
}

fn default_wrapper_branch() -> String {
    "main".to_string()
}

#[derive(Debug, Clone)]
/// Resolved XDG filesystem locations used by the updater at runtime.
pub struct RuntimePaths {
    pub config_file: PathBuf,
    pub state_file: PathBuf,
    pub log_file: PathBuf,
    pub cache_dir: PathBuf,
    pub state_dir: PathBuf,
    pub config_dir: PathBuf,
}

impl RuntimePaths {
    /// Resolves updater paths from the current user's XDG base directories.
    pub fn from_base_dirs(base_dirs: &BaseDirs) -> Self {
        let config_dir = base_dirs.config_dir().join(SERVICE_NAME);
        let state_root = base_dirs
            .state_dir()
            .unwrap_or_else(|| base_dirs.data_local_dir());
        let state_dir = state_root.join(SERVICE_NAME);
        let cache_dir = base_dirs.cache_dir().join(SERVICE_NAME);

        Self {
            config_file: config_dir.join("config.toml"),
            state_file: state_dir.join("state.json"),
            log_file: state_dir.join("service.log"),
            cache_dir,
            state_dir,
            config_dir,
        }
    }

    /// Detects updater paths for the current machine.
    pub fn detect() -> Result<Self> {
        let base_dirs = BaseDirs::new().context("Could not resolve XDG base directories")?;
        Ok(Self::from_base_dirs(&base_dirs))
    }

    /// Creates the runtime directories needed by the updater.
    pub fn ensure_dirs(&self) -> Result<()> {
        fs::create_dir_all(&self.config_dir)
            .with_context(|| format!("Failed to create {}", self.config_dir.display()))?;
        fs::create_dir_all(&self.state_dir)
            .with_context(|| format!("Failed to create {}", self.state_dir.display()))?;
        fs::create_dir_all(&self.cache_dir)
            .with_context(|| format!("Failed to create {}", self.cache_dir.display()))?;
        Ok(())
    }
}

impl RuntimeConfig {
    /// Builds the default runtime configuration for the resolved paths.
    pub fn default_with_paths(paths: &RuntimePaths) -> Self {
        let packaged_bundle_root = PathBuf::from("/opt/codex-desktop/update-builder");
        let builder_bundle_root = if packaged_bundle_root.exists() {
            packaged_bundle_root
        } else {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .expect("updater crate should live inside the repository root")
                .to_path_buf()
        };

        let config = Self {
            dmg_url: "https://persistent.oaistatic.com/codex-app-prod/ChatGPT.dmg".to_string(),
            initial_check_delay_seconds: 30,
            check_interval_hours: DEFAULT_CHECK_INTERVAL_HOURS,
            auto_install_on_app_exit: true,
            notifications: true,
            workspace_root: paths.cache_dir.clone(),
            builder_bundle_root,
            app_executable_path: PathBuf::from("/opt/codex-desktop/electron"),
            enable_wrapper_updates: false,
            wrapper_remote: String::new(),
            wrapper_branch: default_wrapper_branch(),
            generated_artifact_cleanup: GeneratedArtifactCleanupConfig::default(),
        };
        config
            .validate()
            .expect("default runtime configuration must be valid");
        config
    }

    /// Loads the runtime configuration from disk, or returns defaults if missing.
    pub fn load_or_default(paths: &RuntimePaths) -> Result<Self> {
        if !paths.config_file.exists() {
            return Ok(Self::default_with_paths(paths));
        }

        let content = fs::read_to_string(&paths.config_file)
            .with_context(|| format!("Failed to read {}", paths.config_file.display()))?;
        let mut config = toml::from_str::<Self>(&content)
            .with_context(|| format!("Failed to parse {}", paths.config_file.display()))?;
        if config.check_interval_hours == 0 {
            warn!(
                config_path = %paths.config_file.display(),
                configured_hours = 0,
                default_hours = DEFAULT_CHECK_INTERVAL_HOURS,
                "invalid check_interval_hours; using default"
            );
            config.check_interval_hours = DEFAULT_CHECK_INTERVAL_HOURS;
        }
        config
            .validate()
            .with_context(|| format!("Invalid configuration {}", paths.config_file.display()))?;
        Ok(config)
    }

    fn validate(&self) -> Result<()> {
        let interval = self.check_interval_duration()?;
        self.check_interval_chrono_duration()?;
        Instant::now()
            .checked_add(interval)
            .context("check_interval_hours exceeds the platform timer range")?;
        let _ = self.initial_check_delay_duration();
        Ok(())
    }

    pub(crate) fn initial_check_delay_duration(&self) -> Duration {
        Duration::from_secs(self.initial_check_delay_seconds)
    }

    pub(crate) fn check_interval_duration(&self) -> Result<Duration> {
        let seconds = self
            .check_interval_hours
            .checked_mul(SECONDS_PER_HOUR)
            .context("check_interval_hours overflows seconds")?;
        Ok(Duration::from_secs(seconds))
    }

    pub(crate) fn check_interval_chrono_duration(&self) -> Result<ChronoDuration> {
        let hours = i64::try_from(self.check_interval_hours)
            .context("check_interval_hours exceeds the Chrono hour range")?;
        ChronoDuration::try_hours(hours)
            .context("check_interval_hours exceeds the Chrono duration range")
    }
}

const APP_SETTINGS_FILE: &str = "settings.json";
pub(crate) const DEFAULT_APP_ID: &str = "codex-desktop";
const AUTO_INSTALL_SETTING_KEY: &str = "codex-linux-auto-update-on-exit";
const WRAPPER_UPDATES_SETTING_KEY: &str = "codex-linux-wrapper-updates-enabled";

/// Resolves the ChatGPT Desktop app id the same way the Linux launcher and main
/// bundle do: `CODEX_LINUX_APP_ID`, then `CODEX_APP_ID`, then `codex-desktop`.
/// Invalid ids fall back to the default so a malformed env value can never point
/// the lookup at an attacker-controlled path.
pub(crate) fn resolve_app_id() -> String {
    for var in ["CODEX_LINUX_APP_ID", "CODEX_APP_ID"] {
        if let Ok(value) = std::env::var(var) {
            if valid_app_id(&value) {
                return value;
            }
        }
    }
    DEFAULT_APP_ID.to_string()
}

pub(crate) fn valid_app_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

pub(crate) fn resolve_launch_instance_id() -> Option<String> {
    std::env::var("CODEX_LINUX_INSTANCE_ID")
        .ok()
        .filter(|value| valid_app_id(value))
}

pub(crate) fn resolve_app_state_dir() -> Result<PathBuf> {
    let base_dirs = BaseDirs::new().context("Could not resolve XDG base directories")?;
    let state_root = base_dirs
        .state_dir()
        .unwrap_or_else(|| base_dirs.data_local_dir());
    let app_state_dir = state_root.join(resolve_app_id());
    Ok(match resolve_launch_instance_id() {
        Some(instance) => app_state_dir.join("instances").join(instance),
        None => app_state_dir,
    })
}

/// Resolves the app `settings.json` path mirroring the launcher
/// (`launcher/start.sh.template`) and the main-bundle persistence helper
/// (`scripts/patches/launch-actions.js`): honor `CODEX_LINUX_SETTINGS_FILE`
/// first, then `XDG_CONFIG_HOME`, then `$HOME/.config`, joined with the app id.
fn app_settings_path() -> Option<PathBuf> {
    if let Ok(explicit) = std::env::var("CODEX_LINUX_SETTINGS_FILE") {
        if !explicit.is_empty() {
            return Some(PathBuf::from(explicit));
        }
    }

    let config_home = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")))?;

    Some(config_home.join(resolve_app_id()).join(APP_SETTINGS_FILE))
}

/// Coerces a settings.json value into a boolean the same way the launcher's
/// `linux_setting_enabled` helper does: real booleans pass through, numbers are
/// truthy when non-zero, and strings are falsey only for `0/false/no/off`.
fn coerce_setting_bool(value: &serde_json::Value) -> Option<bool> {
    match value {
        serde_json::Value::Bool(flag) => Some(*flag),
        serde_json::Value::Number(number) => number.as_f64().map(|n| n != 0.0),
        serde_json::Value::String(text) => {
            let normalized = text.trim().to_ascii_lowercase();
            Some(!matches!(normalized.as_str(), "0" | "false" | "no" | "off"))
        }
        _ => None,
    }
}

/// Reads a boolean app setting from `settings.json`. Returns `Some(true|false)`
/// only when the toggle key is present and coercible; any missing file, parse
/// error, or absent key yields `None` so callers fall back to config/defaults.
fn settings_bool_override(key: &str) -> Option<bool> {
    let path = app_settings_path()?;
    let content = fs::read_to_string(&path).ok()?;
    let parsed = serde_json::from_str::<serde_json::Value>(&content).ok()?;
    let object = parsed.as_object()?;
    coerce_setting_bool(object.get(key)?)
}

/// Reads the user's auto-install-on-exit preference from the app settings.
pub fn settings_auto_install_override() -> Option<bool> {
    settings_bool_override(AUTO_INSTALL_SETTING_KEY)
}

/// Reads the user's opt-in wrapper update tracking preference from app settings.
pub fn settings_wrapper_updates_override() -> Option<bool> {
    settings_bool_override(WRAPPER_UPDATES_SETTING_KEY)
}

const FEATURE_CONFIG_FILE: &str = "linux-features.json";
const BUNDLED_FEATURE_CONFIG_FILE: &str = "features.json";
const FEATURE_PICKER_ON_UPDATE_SETTING_KEY: &str = "codex-linux-feature-picker-on-update";

/// Resolves the stable per-user feature-config path
/// (`<config>/<appId>/linux-features.json`), alongside `settings.json`. The
/// wrapper-update feature picker writes the chosen `{"enabled":[...]}` here, and
/// the rebuild points `CODEX_LINUX_FEATURES_CONFIG` at it. Deliberately outside
/// any wrapper-src checkout so a fresh clone cannot clobber it.
pub fn feature_config_path() -> Option<PathBuf> {
    let settings = app_settings_path()?;
    let dir = settings.parent()?;
    Some(dir.join(FEATURE_CONFIG_FILE))
}

/// Returns the feature config that should drive a rebuild. A saved per-user
/// picker selection wins; otherwise preserve the currently installed/bundled
/// feature selection from the builder bundle.
pub fn effective_feature_config_path(config: &RuntimeConfig) -> Option<PathBuf> {
    feature_config_path()
        .filter(|path| path.is_file())
        .or_else(|| {
            let bundled = config
                .builder_bundle_root
                .join("linux-features")
                .join(BUNDLED_FEATURE_CONFIG_FILE);
            bundled.is_file().then_some(bundled)
        })
}

/// Reads the user's "ask which features to enable on update" preference (the
/// in-app Update-button feature picker). Absent ⇒ `None` ⇒ caller defaults to
/// asking.
pub fn settings_feature_picker_on_update_override() -> Option<bool> {
    settings_bool_override(FEATURE_PICKER_ON_UPDATE_SETTING_KEY)
}

/// Persists the "Ask which features to enable on update" preference to the app
/// `settings.json`, merging into the existing object (preserving every other
/// key). Used to honor the picker's "Don't ask again" row. Never panics; returns
/// the IO/serialization error so the caller can log-and-continue.
pub fn write_feature_picker_on_update(value: bool) -> Result<()> {
    write_settings_bool(FEATURE_PICKER_ON_UPDATE_SETTING_KEY, value)
}

/// Read-modify-writes a boolean key into the app `settings.json`, preserving all
/// other keys. Creates the file (and parent dir) when absent. A malformed
/// existing file is replaced with a fresh object rather than failing.
fn write_settings_bool(key: &str, value: bool) -> Result<()> {
    let path = app_settings_path().context("could not resolve settings.json path")?;
    write_settings_bool_at_path(
        &path,
        key,
        value,
        SETTINGS_LOCK_TIMEOUT,
        SETTINGS_LOCK_STALE_AFTER,
    )
}

fn write_settings_bool_at_path(
    path: &Path,
    key: &str,
    value: bool,
    lock_timeout: Duration,
    stale_after: Duration,
) -> Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).with_context(|| format!("Failed to create {}", dir.display()))?;
    }
    let _lock = SettingsFileLock::acquire(path, lock_timeout, stale_after)?;
    let mut object = fs::read_to_string(path)
        .ok()
        .and_then(|content| serde_json::from_str::<serde_json::Value>(&content).ok())
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    object.insert(key.to_string(), serde_json::Value::Bool(value));
    let serialized = serde_json::to_string_pretty(&serde_json::Value::Object(object))
        .context("Failed to serialize settings.json")?;
    atomic_write_settings(path, format!("{serialized}\n").as_bytes())?;
    Ok(())
}

struct SettingsFileLock {
    path: PathBuf,
    owner: String,
}

impl SettingsFileLock {
    fn acquire(settings_path: &Path, timeout: Duration, stale_after: Duration) -> Result<Self> {
        let path = adjacent_path(settings_path, ".lock");
        let owner = settings_write_owner();
        let deadline = Instant::now() + timeout;

        loop {
            match OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(mut file) => {
                    let write_result = (|| -> Result<()> {
                        file.write_all(format!("{owner}\n").as_bytes())?;
                        file.sync_all()?;
                        Ok(())
                    })();
                    if let Err(error) = write_result {
                        let _ = fs::remove_file(&path);
                        return Err(error).with_context(|| {
                            format!("Failed to initialize settings lock {}", path.display())
                        });
                    }
                    return Ok(Self { path, owner });
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    if recover_stale_settings_lock(&path, &owner, stale_after)? {
                        return Ok(Self { path, owner });
                    }
                    if Instant::now() >= deadline {
                        anyhow::bail!("Timed out waiting for settings lock {}", path.display());
                    }
                    thread::sleep(SETTINGS_LOCK_RETRY_INTERVAL.min(timeout));
                }
                Err(error) => {
                    return Err(error).with_context(|| {
                        format!("Failed to create settings lock {}", path.display())
                    })
                }
            }
        }
    }
}

impl Drop for SettingsFileLock {
    fn drop(&mut self) {
        remove_owned_settings_lock(&self.path, &self.owner);
    }
}

fn remove_owned_settings_lock(path: &Path, owner: &str) {
    let Ok((mut file, _)) = open_regular_settings_lock(path, false) else {
        return;
    };
    let Ok(contents) = read_settings_lock(&mut file) else {
        return;
    };
    if contents.lines().next() == Some(owner) {
        let _ = fs::remove_file(path);
    }
}

fn recover_stale_settings_lock(
    path: &Path,
    claim_owner: &str,
    stale_after: Duration,
) -> Result<bool> {
    recover_stale_settings_lock_with_hook(path, claim_owner, stale_after, || {})
}

fn recover_stale_settings_lock_with_hook<F>(
    path: &Path,
    claim_owner: &str,
    stale_after: Duration,
    before_takeover: F,
) -> Result<bool>
where
    F: FnOnce(),
{
    let (mut file, opened_metadata) = match open_regular_settings_lock(path, true) {
        Ok(opened) => opened,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => {
            return Err(error)
                .with_context(|| format!("Failed to open settings lock {}", path.display()))
        }
    };
    let mut snapshot = read_settings_lock(&mut file)
        .with_context(|| format!("Failed to read settings lock {}", path.display()))?;
    let owner = snapshot.lines().next().unwrap_or_default().to_owned();
    let is_stale = opened_metadata
        .modified()
        .ok()
        .and_then(|modified| modified.elapsed().ok())
        .is_some_and(|age| age > stale_after);
    if !is_stale || settings_owner_is_alive(&owner) {
        return Ok(false);
    }

    let now_millis = unix_time_millis();
    let claim_expires = now_millis + SETTINGS_RECOVERY_CLAIM_TTL.as_millis();
    let claim = format!("recover:{claim_owner}:{claim_expires}");
    let prefix = if snapshot.ends_with('\n') { "" } else { "\n" };
    file.write_all(format!("{prefix}{claim}\n").as_bytes())?;
    file.sync_all()?;

    let (mut current_file, current_metadata) = match open_regular_settings_lock(path, false) {
        Ok(opened) => opened,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => {
            return Err(error)
                .with_context(|| format!("Failed to reopen settings lock {}", path.display()))
        }
    };
    if !same_settings_lock(&opened_metadata, &current_metadata) {
        return Ok(false);
    }
    snapshot = read_settings_lock(&mut current_file)?;
    if !snapshot.ends_with('\n') || snapshot.lines().next().unwrap_or_default() != owner {
        return Ok(false);
    }
    let first_live_claim = snapshot
        .lines()
        .skip(1)
        .find_map(|line| live_recovery_claim_owner(line, now_millis));
    if first_live_claim != Some(claim_owner) {
        return Ok(false);
    }

    before_takeover();
    file.set_len(0)?;
    file.seek(SeekFrom::Start(0))?;
    file.write_all(format!("{claim_owner}\n").as_bytes())?;
    file.sync_all()?;

    let (mut current_file, current_metadata) = match open_regular_settings_lock(path, false) {
        Ok(opened) => opened,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => {
            return Err(error)
                .with_context(|| format!("Failed to verify settings lock {}", path.display()))
        }
    };
    if !same_settings_lock(&opened_metadata, &current_metadata) {
        return Ok(false);
    }
    let current_owner = read_settings_lock(&mut current_file)?;
    Ok(current_owner.lines().next() == Some(claim_owner))
}

fn open_regular_settings_lock(path: &Path, writable: bool) -> std::io::Result<(File, Metadata)> {
    if !fs::symlink_metadata(path)?.file_type().is_file() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "settings lock is not a regular file",
        ));
    }
    let mut options = OpenOptions::new();
    options.read(true);
    if writable {
        options.write(true).append(true);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let file = options.open(path)?;
    let metadata = file.metadata()?;
    if !metadata.file_type().is_file() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "settings lock is not a regular file",
        ));
    }
    Ok((file, metadata))
}

fn read_settings_lock(file: &mut File) -> std::io::Result<String> {
    let mut contents = String::new();
    file.seek(SeekFrom::Start(0))?;
    file.read_to_string(&mut contents)?;
    Ok(contents)
}

fn same_settings_lock(left: &Metadata, right: &Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        left.dev() == right.dev() && left.ino() == right.ino()
    }
    #[cfg(not(unix))]
    {
        left.len() == right.len() && left.modified().ok() == right.modified().ok()
    }
}

fn live_recovery_claim_owner(record: &str, now_millis: u128) -> Option<&str> {
    let claim = record.strip_prefix("recover:")?;
    let (owner, expires) = claim.rsplit_once(':')?;
    let expires = expires.parse::<u128>().ok()?;
    (expires > now_millis && settings_owner_is_alive(owner)).then_some(owner)
}

fn unix_time_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn settings_owner_is_alive(owner: &str) -> bool {
    let Some(pid) = owner
        .split_once('-')
        .and_then(|(pid, _)| pid.parse::<u32>().ok())
        .filter(|pid| *pid != 0)
    else {
        return false;
    };

    #[cfg(target_os = "linux")]
    {
        Path::new("/proc").join(pid.to_string()).exists()
    }
    #[cfg(not(target_os = "linux"))]
    {
        pid == process::id()
    }
}

fn atomic_write_settings(path: &Path, contents: &[u8]) -> Result<()> {
    let owner = settings_write_owner();
    let temp_path = adjacent_path(path, &format!(".tmp.{owner}"));
    let result = (|| -> Result<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)
            .with_context(|| format!("Failed to create {}", temp_path.display()))?;
        file.write_all(contents)
            .with_context(|| format!("Failed to write {}", temp_path.display()))?;
        file.sync_all()
            .with_context(|| format!("Failed to sync {}", temp_path.display()))?;
        drop(file);
        fs::rename(&temp_path, path).with_context(|| {
            format!(
                "Failed to atomically replace {} with {}",
                path.display(),
                temp_path.display()
            )
        })?;
        sync_settings_parent(path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    result
}

fn sync_settings_parent(path: &Path) -> Result<()> {
    #[cfg(not(unix))]
    {
        let _ = path;
        return Ok(());
    }
    #[cfg(unix)]
    {
        let Some(parent) = path.parent() else {
            return Ok(());
        };
        File::open(parent)
            .and_then(|directory| directory.sync_all())
            .with_context(|| format!("Failed to sync settings directory {}", parent.display()))
    }
}

fn adjacent_path(path: &Path, suffix: &str) -> PathBuf {
    let mut value = OsString::from(path.as_os_str());
    value.push(suffix);
    PathBuf::from(value)
}

fn settings_write_owner() -> String {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let counter = SETTINGS_WRITE_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{}-{timestamp}-{counter}", process::id())
}

#[cfg(test)]
mod tests {
    use super::*;
    use anyhow::Result;
    use std::path::Path;
    use std::sync::{Arc, Barrier};
    use tempfile::tempdir;

    fn test_paths(root: &Path) -> RuntimePaths {
        RuntimePaths {
            config_file: root.join("config/config.toml"),
            state_file: root.join("state/state.json"),
            log_file: root.join("state/service.log"),
            cache_dir: root.join("cache"),
            state_dir: root.join("state"),
            config_dir: root.join("config"),
        }
    }

    fn runtime_config_toml(initial_delay: u64, check_interval: u64) -> String {
        format!(
            r#"
dmg_url = "https://example.com/Codex.dmg"
initial_check_delay_seconds = {initial_delay}
check_interval_hours = {check_interval}
auto_install_on_app_exit = false
notifications = false
workspace_root = "/tmp/codex-workspaces"
builder_bundle_root = "/tmp/codex-builder"
app_executable_path = "/opt/codex-desktop/electron"
"#
        )
    }

    /// Writes `settings.json` content to a tempfile, points
    /// `CODEX_LINUX_SETTINGS_FILE` at it, and returns the override result.
    /// `None` content means "do not create the file" (missing-file case).
    fn override_with_settings(content: Option<&str>, key: &str) -> Option<bool> {
        let _guard = crate::test_util::env_lock();
        let temp = tempdir().expect("tempdir");
        let settings_path = temp.path().join("settings.json");
        if let Some(body) = content {
            std::fs::write(&settings_path, body).expect("write settings");
        }
        std::env::set_var("CODEX_LINUX_SETTINGS_FILE", &settings_path);
        let result = settings_bool_override(key);
        std::env::remove_var("CODEX_LINUX_SETTINGS_FILE");
        result
    }

    #[test]
    fn settings_override_reads_explicit_bool() {
        assert_eq!(
            override_with_settings(
                Some(r#"{"codex-linux-auto-update-on-exit": false}"#),
                AUTO_INSTALL_SETTING_KEY
            ),
            Some(false)
        );
        assert_eq!(
            override_with_settings(
                Some(r#"{"codex-linux-auto-update-on-exit": true}"#),
                AUTO_INSTALL_SETTING_KEY
            ),
            Some(true)
        );
    }

    #[test]
    fn settings_override_coerces_string_and_number() {
        assert_eq!(
            override_with_settings(
                Some(r#"{"codex-linux-auto-update-on-exit": "off"}"#),
                AUTO_INSTALL_SETTING_KEY
            ),
            Some(false)
        );
        assert_eq!(
            override_with_settings(
                Some(r#"{"codex-linux-auto-update-on-exit": "on"}"#),
                AUTO_INSTALL_SETTING_KEY
            ),
            Some(true)
        );
        assert_eq!(
            override_with_settings(
                Some(r#"{"codex-linux-auto-update-on-exit": 0}"#),
                AUTO_INSTALL_SETTING_KEY
            ),
            Some(false)
        );
        assert_eq!(
            override_with_settings(
                Some(r#"{"codex-linux-auto-update-on-exit": 1}"#),
                AUTO_INSTALL_SETTING_KEY
            ),
            Some(true)
        );
    }

    #[test]
    fn settings_override_absent_yields_none() {
        // Missing file, malformed JSON, non-object, and absent key all fall back.
        assert_eq!(override_with_settings(None, AUTO_INSTALL_SETTING_KEY), None);
        assert_eq!(
            override_with_settings(Some("not json{"), AUTO_INSTALL_SETTING_KEY),
            None
        );
        assert_eq!(
            override_with_settings(Some("[1,2,3]"), AUTO_INSTALL_SETTING_KEY),
            None
        );
        assert_eq!(
            override_with_settings(Some(r#"{"other-key": true}"#), AUTO_INSTALL_SETTING_KEY),
            None
        );
    }

    #[test]
    fn wrapper_settings_override_reads_explicit_bool() {
        assert_eq!(
            override_with_settings(
                Some(r#"{"codex-linux-wrapper-updates-enabled": true}"#),
                WRAPPER_UPDATES_SETTING_KEY
            ),
            Some(true)
        );
        assert_eq!(
            override_with_settings(
                Some(r#"{"codex-linux-wrapper-updates-enabled": false}"#),
                WRAPPER_UPDATES_SETTING_KEY
            ),
            Some(false)
        );
    }

    #[test]
    fn settings_write_atomically_merges_and_cleans_sidecars() -> Result<()> {
        let temp = tempdir()?;
        let path = temp.path().join("settings.json");
        fs::write(&path, r#"{"preserved":"value"}"#)?;

        write_settings_bool_at_path(
            &path,
            "new-setting",
            true,
            Duration::from_millis(100),
            SETTINGS_LOCK_STALE_AFTER,
        )?;

        let settings: serde_json::Value = serde_json::from_str(&fs::read_to_string(&path)?)?;
        assert_eq!(settings["preserved"], "value");
        assert_eq!(settings["new-setting"], true);
        assert!(!adjacent_path(&path, ".lock").exists());
        assert!(fs::read_dir(temp.path())?
            .filter_map(|entry| entry.ok())
            .all(|entry| !entry.file_name().to_string_lossy().contains(".tmp.")));
        Ok(())
    }

    #[test]
    fn settings_write_recovers_stale_lock() -> Result<()> {
        let temp = tempdir()?;
        let path = temp.path().join("settings.json");
        let lock_path = adjacent_path(&path, ".lock");
        fs::write(&lock_path, "0-stale-owner\n")?;
        thread::sleep(Duration::from_millis(2));

        write_settings_bool_at_path(
            &path,
            "recovered",
            true,
            Duration::from_millis(100),
            Duration::ZERO,
        )?;

        let settings: serde_json::Value = serde_json::from_str(&fs::read_to_string(&path)?)?;
        assert_eq!(settings["recovered"], true);
        assert!(!lock_path.exists());
        Ok(())
    }

    #[test]
    fn settings_write_recovers_empty_stale_lock() -> Result<()> {
        let temp = tempdir()?;
        let path = temp.path().join("settings.json");
        let lock_path = adjacent_path(&path, ".lock");
        fs::write(&lock_path, "")?;
        thread::sleep(Duration::from_millis(2));

        write_settings_bool_at_path(
            &path,
            "recovered-empty-lock",
            true,
            Duration::from_millis(100),
            Duration::ZERO,
        )?;

        let settings: serde_json::Value = serde_json::from_str(&fs::read_to_string(&path)?)?;
        assert_eq!(settings["recovered-empty-lock"], true);
        assert!(!lock_path.exists());
        Ok(())
    }

    #[test]
    fn stale_recovery_does_not_replace_a_new_lock_inode() -> Result<()> {
        let temp = tempdir()?;
        let path = temp.path().join("settings.json");
        let lock_path = adjacent_path(&path, ".lock");
        let replacement_path = adjacent_path(&path, ".replacement-lock");
        fs::write(&lock_path, "0-stale-owner\n")?;
        thread::sleep(Duration::from_millis(2));
        let claim_owner = settings_write_owner();

        let recovered = recover_stale_settings_lock_with_hook(
            &lock_path,
            &claim_owner,
            Duration::ZERO,
            || {
                fs::write(&replacement_path, "replacement-owner\n").unwrap();
                fs::rename(&replacement_path, &lock_path).unwrap();
            },
        )?;

        assert!(!recovered);
        assert_eq!(fs::read_to_string(&lock_path)?, "replacement-owner\n");
        Ok(())
    }

    #[test]
    fn settings_write_rejects_non_regular_lock() -> Result<()> {
        let temp = tempdir()?;
        let path = temp.path().join("settings.json");
        let lock_path = adjacent_path(&path, ".lock");
        fs::create_dir(&lock_path)?;

        let error = write_settings_bool_at_path(
            &path,
            "blocked",
            true,
            Duration::from_millis(100),
            Duration::ZERO,
        )
        .expect_err("directory lock must be rejected");

        assert!(error.to_string().contains("Failed to open settings lock"));
        assert!(lock_path.is_dir());
        assert!(!path.exists());
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn settings_write_rejects_lock_symlink_without_following_it() -> Result<()> {
        use std::os::unix::fs::symlink;

        let temp = tempdir()?;
        let path = temp.path().join("settings.json");
        let lock_path = adjacent_path(&path, ".lock");
        let symlink_target = temp.path().join("unrelated.txt");
        fs::write(&symlink_target, "do not modify\n")?;
        symlink(&symlink_target, &lock_path)?;

        let error = write_settings_bool_at_path(
            &path,
            "blocked",
            true,
            Duration::from_millis(100),
            Duration::ZERO,
        )
        .expect_err("symlink lock must be rejected");

        assert!(error.to_string().contains("Failed to open settings lock"));
        assert_eq!(fs::read_to_string(&symlink_target)?, "do not modify\n");
        assert!(fs::symlink_metadata(&lock_path)?.file_type().is_symlink());
        assert!(!path.exists());
        Ok(())
    }

    #[test]
    fn competing_stale_recoverers_do_not_remove_replacement_lock() -> Result<()> {
        let temp = tempdir()?;
        let path = Arc::new(temp.path().join("settings.json"));
        let lock_path = adjacent_path(&path, ".lock");
        fs::write(&lock_path, "0-stale-owner\n")?;
        thread::sleep(Duration::from_millis(2));
        let barrier = Arc::new(Barrier::new(3));
        let mut handles = Vec::new();

        for key in ["first", "second"] {
            let path = Arc::clone(&path);
            let barrier = Arc::clone(&barrier);
            handles.push(thread::spawn(move || {
                barrier.wait();
                write_settings_bool_at_path(
                    &path,
                    key,
                    true,
                    Duration::from_secs(1),
                    Duration::ZERO,
                )
            }));
        }
        barrier.wait();
        for handle in handles {
            handle.join().expect("settings writer panicked")?;
        }

        let settings: serde_json::Value = serde_json::from_str(&fs::read_to_string(&*path)?)?;
        assert_eq!(settings["first"], true);
        assert_eq!(settings["second"], true);
        assert!(!lock_path.exists());
        Ok(())
    }

    #[test]
    fn settings_write_timeout_preserves_foreign_lock_and_cleans_temps() -> Result<()> {
        let temp = tempdir()?;
        let path = temp.path().join("settings.json");
        let lock_path = adjacent_path(&path, ".lock");
        fs::write(&lock_path, "active-owner")?;

        let error = write_settings_bool_at_path(
            &path,
            "blocked",
            true,
            Duration::from_millis(30),
            Duration::from_secs(60),
        )
        .expect_err("active lock should time out");

        assert!(error
            .to_string()
            .contains("Timed out waiting for settings lock"));
        assert_eq!(fs::read_to_string(&lock_path)?, "active-owner");
        assert!(!path.exists());
        assert!(fs::read_dir(temp.path())?
            .filter_map(|entry| entry.ok())
            .all(|entry| !entry.file_name().to_string_lossy().contains(".tmp.")));
        Ok(())
    }

    #[test]
    fn settings_write_skips_crashed_recovery_claim() -> Result<()> {
        let temp = tempdir()?;
        let path = temp.path().join("settings.json");
        let lock_path = adjacent_path(&path, ".lock");
        fs::write(&lock_path, "0-stale-owner\nrecover:0-crashed-claim\n")?;
        thread::sleep(Duration::from_millis(2));

        write_settings_bool_at_path(
            &path,
            "recovered-after-crash",
            true,
            Duration::from_secs(1),
            Duration::ZERO,
        )?;

        let settings: serde_json::Value = serde_json::from_str(&fs::read_to_string(&path)?)?;
        assert_eq!(settings["recovered-after-crash"], true);
        assert!(!lock_path.exists());
        Ok(())
    }

    #[test]
    fn settings_lock_release_does_not_remove_replacement_owner() -> Result<()> {
        let temp = tempdir()?;
        let path = temp.path().join("settings.json");
        let lock = SettingsFileLock::acquire(
            &path,
            Duration::from_millis(100),
            SETTINGS_LOCK_STALE_AFTER,
        )?;
        fs::write(&lock.path, "replacement-owner")?;

        drop(lock);

        assert_eq!(
            fs::read_to_string(adjacent_path(&path, ".lock"))?,
            "replacement-owner"
        );
        Ok(())
    }

    #[test]
    fn competing_settings_writes_are_serialized() -> Result<()> {
        let temp = tempdir()?;
        let path = Arc::new(temp.path().join("settings.json"));
        let barrier = Arc::new(Barrier::new(3));
        let mut workers = Vec::new();
        for (key, value) in [("first", true), ("second", false)] {
            let path = Arc::clone(&path);
            let barrier = Arc::clone(&barrier);
            workers.push(thread::spawn(move || {
                barrier.wait();
                write_settings_bool_at_path(
                    &path,
                    key,
                    value,
                    Duration::from_secs(1),
                    SETTINGS_LOCK_STALE_AFTER,
                )
            }));
        }
        barrier.wait();
        for worker in workers {
            worker.join().expect("settings writer panicked")?;
        }

        let settings: serde_json::Value = serde_json::from_str(&fs::read_to_string(&*path)?)?;
        assert_eq!(settings["first"], true);
        assert_eq!(settings["second"], false);
        Ok(())
    }

    #[test]
    fn effective_feature_config_prefers_saved_picker_config_then_builder_config() -> Result<()> {
        let _guard = crate::test_util::env_lock();
        let temp = tempdir()?;
        let settings_dir = temp.path().join("settings");
        let settings_file = settings_dir.join("settings.json");
        let saved_feature_config = settings_dir.join("linux-features.json");
        let builder_feature_config = temp.path().join("builder/linux-features/features.json");

        fs::create_dir_all(builder_feature_config.parent().unwrap())?;
        fs::write(
            &builder_feature_config,
            r#"{"enabled":["codex-wrapper-updater"]}"#,
        )?;
        std::env::set_var("CODEX_LINUX_SETTINGS_FILE", &settings_file);

        let paths = RuntimePaths {
            config_file: temp.path().join("config/config.toml"),
            state_file: temp.path().join("state/state.json"),
            log_file: temp.path().join("state/service.log"),
            cache_dir: temp.path().join("cache"),
            state_dir: temp.path().join("state"),
            config_dir: temp.path().join("config"),
        };
        let mut config = RuntimeConfig::default_with_paths(&paths);
        config.builder_bundle_root = temp.path().join("builder");

        assert_eq!(
            effective_feature_config_path(&config),
            Some(builder_feature_config.clone())
        );

        fs::create_dir_all(&settings_dir)?;
        fs::write(&saved_feature_config, r#"{"enabled":["read-aloud"]}"#)?;
        assert_eq!(
            effective_feature_config_path(&config),
            Some(saved_feature_config)
        );

        std::env::remove_var("CODEX_LINUX_SETTINGS_FILE");
        Ok(())
    }

    #[test]
    fn loads_default_when_config_is_missing() -> Result<()> {
        let temp = tempdir()?;
        let paths = RuntimePaths {
            config_file: temp.path().join("config/config.toml"),
            state_file: temp.path().join("state/state.json"),
            log_file: temp.path().join("state/service.log"),
            cache_dir: temp.path().join("cache"),
            state_dir: temp.path().join("state"),
            config_dir: temp.path().join("config"),
        };

        let config = RuntimeConfig::load_or_default(&paths)?;
        assert_eq!(config.initial_check_delay_seconds, 30);
        assert!(config.auto_install_on_app_exit);
        assert_eq!(config.workspace_root, paths.cache_dir);
        assert!(config.builder_bundle_root.is_absolute());
        assert!(!config.generated_artifact_cleanup.enabled);
        assert_eq!(
            config.generated_artifact_cleanup.min_free_bytes,
            10 * 1024 * 1024 * 1024
        );
        assert_eq!(
            config.generated_artifact_cleanup.entries,
            vec![
                PathBuf::from("codex-app"),
                PathBuf::from("codex-app-next"),
                PathBuf::from("dist"),
                PathBuf::from("dist-next"),
                PathBuf::from("target"),
            ]
        );
        Ok(())
    }

    #[test]
    fn parses_runtime_config_from_disk() -> Result<()> {
        let temp = tempdir()?;
        let paths = RuntimePaths {
            config_file: temp.path().join("config/config.toml"),
            state_file: temp.path().join("state/state.json"),
            log_file: temp.path().join("state/service.log"),
            cache_dir: temp.path().join("cache"),
            state_dir: temp.path().join("state"),
            config_dir: temp.path().join("config"),
        };
        fs::create_dir_all(&paths.config_dir)?;
        fs::write(
            &paths.config_file,
            r#"
dmg_url = "https://example.com/Codex.dmg"
initial_check_delay_seconds = 5
check_interval_hours = 12
auto_install_on_app_exit = false
notifications = false
workspace_root = "/tmp/codex-workspaces"
builder_bundle_root = "/tmp/codex-builder"
app_executable_path = "/opt/codex-desktop/electron"

[generated_artifact_cleanup]
enabled = true
min_free_bytes = 2147483648
roots = ["/home/mohit/Github/codex-desktop-linux"]
entries = ["dist", "target", "Codex.dmg"]
"#,
        )?;

        let config = RuntimeConfig::load_or_default(&paths)?;
        assert_eq!(config.dmg_url, "https://example.com/Codex.dmg");
        assert_eq!(config.initial_check_delay_seconds, 5);
        assert_eq!(config.check_interval_hours, 12);
        assert_eq!(
            config.initial_check_delay_duration(),
            Duration::from_secs(5)
        );
        assert_eq!(
            config.check_interval_duration()?,
            Duration::from_secs(12 * SECONDS_PER_HOUR)
        );
        assert_eq!(
            config.check_interval_chrono_duration()?,
            ChronoDuration::hours(12)
        );
        assert!(!config.auto_install_on_app_exit);
        assert!(!config.notifications);
        assert_eq!(
            config.workspace_root,
            PathBuf::from("/tmp/codex-workspaces")
        );
        assert_eq!(
            config.builder_bundle_root,
            PathBuf::from("/tmp/codex-builder")
        );
        assert_eq!(
            config.app_executable_path,
            PathBuf::from("/opt/codex-desktop/electron")
        );
        assert!(config.generated_artifact_cleanup.enabled);
        assert_eq!(config.generated_artifact_cleanup.min_free_bytes, 2147483648);
        assert_eq!(
            config.generated_artifact_cleanup.roots,
            vec![PathBuf::from("/home/mohit/Github/codex-desktop-linux")]
        );
        assert_eq!(
            config.generated_artifact_cleanup.entries,
            vec![
                PathBuf::from("dist"),
                PathBuf::from("target"),
                PathBuf::from("Codex.dmg"),
            ]
        );
        Ok(())
    }

    #[test]
    fn zero_check_interval_warns_and_falls_back_to_default() -> Result<()> {
        let temp = tempdir()?;
        let paths = test_paths(temp.path());
        fs::create_dir_all(&paths.config_dir)?;
        fs::write(&paths.config_file, runtime_config_toml(5, 0))?;

        #[derive(Clone)]
        struct BufferWriter(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);
        impl std::io::Write for BufferWriter {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                self.0
                    .lock()
                    .expect("log buffer lock")
                    .extend_from_slice(bytes);
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }

        let output = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let writer = BufferWriter(output.clone());
        let subscriber = tracing_subscriber::fmt()
            .without_time()
            .with_ansi(false)
            .with_writer(move || writer.clone())
            .finish();
        let config = tracing::subscriber::with_default(subscriber, || {
            RuntimeConfig::load_or_default(&paths)
        })?;
        let message = String::from_utf8(output.lock().expect("log buffer lock").clone())?;

        assert_eq!(config.check_interval_hours, DEFAULT_CHECK_INTERVAL_HOURS);
        assert!(message.contains(&paths.config_file.display().to_string()));
        assert!(message.contains("invalid check_interval_hours; using default"));
        assert!(message.contains("default_hours=6"));
        Ok(())
    }

    #[test]
    fn rejects_check_interval_that_overflows_seconds() -> Result<()> {
        let temp = tempdir()?;
        let paths = test_paths(temp.path());
        fs::create_dir_all(&paths.config_dir)?;
        fs::write(
            &paths.config_file,
            runtime_config_toml(5, u64::MAX / SECONDS_PER_HOUR + 1),
        )?;

        let error =
            RuntimeConfig::load_or_default(&paths).expect_err("overflowing interval should fail");
        let message = format!("{error:#}");

        assert!(message.contains(&paths.config_file.display().to_string()));
        assert!(message.contains("check_interval_hours overflows seconds"));
        Ok(())
    }

    #[test]
    fn rejects_check_interval_outside_chrono_range() -> Result<()> {
        let temp = tempdir()?;
        let paths = test_paths(temp.path());
        fs::create_dir_all(&paths.config_dir)?;
        let chrono_millisecond_overflow_hours = (i64::MAX as u64) / (SECONDS_PER_HOUR * 1000) + 1;
        fs::write(
            &paths.config_file,
            runtime_config_toml(5, chrono_millisecond_overflow_hours),
        )?;

        let error = RuntimeConfig::load_or_default(&paths)
            .expect_err("interval outside Chrono range should fail");
        let message = format!("{error:#}");

        assert!(message.contains(&paths.config_file.display().to_string()));
        assert!(message.contains("check_interval_hours exceeds the Chrono duration range"));
        Ok(())
    }

    #[test]
    fn parse_errors_include_config_path() -> Result<()> {
        let temp = tempdir()?;
        let paths = test_paths(temp.path());
        fs::create_dir_all(&paths.config_dir)?;
        fs::write(&paths.config_file, "check_interval_hours = [")?;

        let error = RuntimeConfig::load_or_default(&paths).expect_err("invalid TOML should fail");
        let message = format!("{error:#}");

        assert!(message.contains("Failed to parse"));
        assert!(message.contains(&paths.config_file.display().to_string()));
        Ok(())
    }

    #[test]
    fn initial_check_delay_conversion_accepts_extreme_u64() -> Result<()> {
        let temp = tempdir()?;
        let paths = test_paths(temp.path());
        let mut config = RuntimeConfig::default_with_paths(&paths);
        config.initial_check_delay_seconds = u64::MAX;

        config.validate()?;

        assert_eq!(
            config.initial_check_delay_duration(),
            Duration::from_secs(u64::MAX)
        );
        Ok(())
    }
}
