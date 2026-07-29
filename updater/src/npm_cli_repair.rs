use crate::{
    config::RuntimePaths,
    state::{atomic_write, sync_directory},
};
use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::{
    ffi::{CString, OsStr},
    fs,
    io::{Seek, SeekFrom, Write},
    os::fd::AsRawFd,
    os::unix::ffi::OsStrExt,
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt},
    os::unix::process::CommandExt,
    path::{Component, Path, PathBuf},
    process::{Command, Output},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tracing::info;

const JOURNAL_FILE_NAME: &str = "cli-repair.json";
const LOCK_FILE_NAME: &str = "cli-install.lock";
const LOCK_TIMEOUT: Duration = Duration::from_secs(120);
const LOCK_POLL_INTERVAL: Duration = Duration::from_millis(50);
const QUARANTINE_DIRECTORY_NAME: &str = ".codex-linux-quarantine";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) struct RepairJournal {
    detected_at: DateTime<Utc>,
    retirement_name: String,
    #[serde(default)]
    quarantine_names: Vec<String>,
    stage: RepairStage,
    #[serde(default)]
    last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "stage", rename_all = "snake_case")]
enum RepairStage {
    Detected,
    QuarantinePlanned { quarantine_name: String },
    Quarantined,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RepairPhase {
    Detected,
    QuarantinePlanned,
    Quarantined,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RepairSnapshot {
    pub(crate) detected_at: DateTime<Utc>,
    pub(crate) phase: RepairPhase,
    pub(crate) stale_directory: PathBuf,
    pub(crate) quarantine_paths: Vec<PathBuf>,
    pub(crate) planned_quarantine_path: Option<PathBuf>,
    pub(crate) last_error: Option<String>,
}

#[derive(Debug)]
pub(crate) struct InstallLock {
    _file: fs::File,
}

impl InstallLock {
    pub(crate) fn raw_fd(&self) -> std::os::fd::RawFd {
        self._file.as_raw_fd()
    }

    pub(crate) fn inherit_with(&self, command: &mut Command) {
        let fd = self._file.as_raw_fd();
        unsafe {
            command.pre_exec(move || {
                let flags = libc::fcntl(fd, libc::F_GETFD);
                if flags == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                if libc::fcntl(fd, libc::F_SETFD, flags & !libc::FD_CLOEXEC) == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
}

#[derive(Debug, Clone)]
struct ManagedNpmLayout {
    retirement_name: String,
    prefix: PathBuf,
    scope: PathBuf,
    active_package: PathBuf,
    stale_directory: PathBuf,
    quarantine_root: PathBuf,
}

pub(crate) fn managed_prefix() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".codex-cli-npm")
}

pub(crate) fn managed_cli_path() -> PathBuf {
    managed_prefix().join("bin/codex")
}

pub(crate) fn acquire_install_lock(paths: &RuntimePaths) -> Result<InstallLock> {
    acquire_install_lock_with_timeout(paths, LOCK_TIMEOUT)
}

fn acquire_install_lock_with_timeout(
    paths: &RuntimePaths,
    timeout: Duration,
) -> Result<InstallLock> {
    let lock_path = paths.state_dir.join(LOCK_FILE_NAME);
    let mut file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(&lock_path)
        .with_context(|| format!("Failed to open {}", lock_path.display()))?;
    let metadata = file
        .metadata()
        .with_context(|| format!("Failed to inspect {}", lock_path.display()))?;
    let euid = unsafe { libc::geteuid() };
    anyhow::ensure!(
        metadata.is_file() && metadata.uid() == euid,
        "CLI install lock {} is not a user-owned regular file",
        lock_path.display()
    );
    if metadata.permissions().mode() & 0o077 != 0 {
        file.set_permissions(fs::Permissions::from_mode(0o600))
            .with_context(|| format!("Failed to secure {}", lock_path.display()))?;
    }

    let started = Instant::now();
    let mut reported_wait = false;
    loop {
        match file.try_lock() {
            Ok(()) => break,
            Err(fs::TryLockError::WouldBlock) if started.elapsed() < timeout => {
                if !reported_wait {
                    info!(
                        "Codex CLI install lock is busy; process {} is waiting",
                        std::process::id()
                    );
                    reported_wait = true;
                }
                #[cfg(test)]
                if let Some(path) =
                    std::env::var_os("CODEX_UPDATE_MANAGER_TEST_CLI_INSTALL_LOCK_WAITING")
                {
                    let _ = fs::write(path, b"waiting");
                }
                thread::sleep(LOCK_POLL_INTERVAL);
            }
            Err(fs::TryLockError::WouldBlock) => {
                anyhow::bail!(
                    "Timed out waiting for another Codex CLI install after {} ms",
                    timeout.as_millis()
                );
            }
            Err(fs::TryLockError::Error(error)) => {
                return Err(error)
                    .with_context(|| format!("Failed to lock {}", lock_path.display()));
            }
        }
    }

    file.set_len(0)
        .with_context(|| format!("Failed to truncate {}", lock_path.display()))?;
    file.seek(SeekFrom::Start(0))
        .with_context(|| format!("Failed to seek {}", lock_path.display()))?;
    writeln!(file, "{}", std::process::id())
        .with_context(|| format!("Failed to write {}", lock_path.display()))?;
    Ok(InstallLock { _file: file })
}

pub(crate) fn load(paths: &RuntimePaths) -> Result<Option<RepairJournal>> {
    let journal_path = journal_path(paths);
    let metadata = match fs::symlink_metadata(&journal_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(error)
                .with_context(|| format!("Failed to inspect {}", journal_path.display()));
        }
    };
    anyhow::ensure!(
        metadata.is_file()
            && !metadata.file_type().is_symlink()
            && metadata.uid() == unsafe { libc::geteuid() }
            && metadata.permissions().mode() & 0o022 == 0,
        "Codex CLI repair journal {} is not a secure user-owned file",
        journal_path.display()
    );
    let contents = fs::read_to_string(&journal_path)
        .with_context(|| format!("Failed to read {}", journal_path.display()))?;
    serde_json::from_str(&contents)
        .with_context(|| format!("Failed to parse {}", journal_path.display()))
        .map(Some)
}

pub(crate) fn snapshot(paths: &RuntimePaths) -> Result<Option<RepairSnapshot>> {
    load(paths)?.map(|journal| journal.snapshot()).transpose()
}

pub(crate) fn detect_and_persist(
    paths: &RuntimePaths,
    prefix: &Path,
    output: &Output,
) -> Result<Option<RepairSnapshot>> {
    let Some(journal) = detect(prefix, output) else {
        return Ok(None);
    };
    save(paths, &journal)?;
    journal.snapshot().map(Some)
}

fn detect(prefix: &Path, output: &Output) -> Option<RepairJournal> {
    if output.status.success() || prefix != managed_prefix() {
        return None;
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    if !stderr.lines().any(|line| line.contains("ENOTEMPTY"))
        || !stderr.lines().any(|line| line.contains("syscall rename"))
    {
        return None;
    }

    let source = npm_error_path_field(&stderr, "path")?;
    let destination = npm_error_path_field(&stderr, "dest")?;
    let expected_source = prefix.join("lib/node_modules/@openai/codex");
    let expected_parent = expected_source.parent()?;
    let retirement_name = destination.file_name()?.to_str()?;
    if source != expected_source
        || destination.parent() != Some(expected_parent)
        || !is_retirement_directory_name(retirement_name)
    {
        return None;
    }

    Some(RepairJournal {
        detected_at: Utc::now(),
        retirement_name: retirement_name.to_string(),
        quarantine_names: Vec::new(),
        stage: RepairStage::Detected,
        last_error: None,
    })
}

pub(crate) fn quarantine(
    paths: &RuntimePaths,
    journal: &mut RepairJournal,
) -> Result<RepairSnapshot> {
    validate_journal(journal)?;
    let layout = ManagedNpmLayout::new(&journal.retirement_name)?;

    if matches!(journal.stage, RepairStage::QuarantinePlanned { .. }) {
        reconcile_planned_quarantine(paths, &layout, journal)?;
    }

    if path_exists_without_following(&layout.stale_directory)? {
        layout.validate_stale_directory()?;
        layout.ensure_quarantine_root()?;
        let quarantine_name = layout.allocate_quarantine_name();
        journal.stage = RepairStage::QuarantinePlanned { quarantine_name };
        save(paths, journal)?;
        reconcile_planned_quarantine(paths, &layout, journal)?;
    } else if matches!(journal.stage, RepairStage::Detected) {
        journal.stage = RepairStage::Quarantined;
        save(paths, journal)?;
    }

    let snapshot = journal.snapshot()?;
    for path in &snapshot.quarantine_paths {
        layout.validate_quarantine_path(path)?;
    }
    Ok(snapshot)
}

pub(crate) fn validate_journal(journal: &RepairJournal) -> Result<RepairSnapshot> {
    let snapshot = journal.snapshot()?;
    let layout = ManagedNpmLayout::new(&journal.retirement_name)?;
    layout.validate_prefix()?;

    if matches!(journal.stage, RepairStage::Detected) {
        layout.validate_active_package()?;
    } else {
        layout.validate_existing_install_target()?;
    }

    if path_exists_without_following(&layout.stale_directory)? {
        layout.validate_stale_directory()?;
    }
    for path in &snapshot.quarantine_paths {
        layout.validate_quarantine_path(path)?;
    }
    if let Some(path) = snapshot.planned_quarantine_path.as_deref() {
        if path_exists_without_following(path)? {
            layout.validate_quarantine_path(path)?;
        }
    }
    Ok(snapshot)
}

pub(crate) fn journal_snapshot(journal: &RepairJournal) -> Result<RepairSnapshot> {
    journal.snapshot()
}

fn reconcile_planned_quarantine(
    paths: &RuntimePaths,
    layout: &ManagedNpmLayout,
    journal: &mut RepairJournal,
) -> Result<()> {
    let RepairStage::QuarantinePlanned { quarantine_name } = &journal.stage else {
        return Ok(());
    };
    let quarantine_name = quarantine_name.clone();
    layout.ensure_quarantine_root()?;
    let quarantine_path = layout.quarantine_path(&quarantine_name)?;
    let stale_exists = path_exists_without_following(&layout.stale_directory)?;
    let quarantine_exists = path_exists_without_following(&quarantine_path)?;
    match (stale_exists, quarantine_exists) {
        (true, false) => {
            layout.validate_stale_directory()?;
            rename_noreplace(&layout.stale_directory, &quarantine_path).with_context(|| {
                format!(
                    "Failed to quarantine stale npm directory {} at {}",
                    layout.stale_directory.display(),
                    quarantine_path.display()
                )
            })?;
        }
        (false, true) => {}
        (true, true) => {
            layout.validate_stale_directory()?;
        }
        (false, false) => {
            journal.stage = RepairStage::Quarantined;
            save(paths, journal)?;
            return Ok(());
        }
    }
    layout.validate_quarantine_path(&quarantine_path)?;
    if !journal
        .quarantine_names
        .iter()
        .any(|name| name == &quarantine_name)
    {
        journal.quarantine_names.push(quarantine_name);
    }
    journal.stage = RepairStage::Quarantined;
    save(paths, journal)
}

pub(crate) fn record_failure(
    paths: &RuntimePaths,
    journal: &mut RepairJournal,
    error: &str,
) -> Result<RepairSnapshot> {
    journal.last_error = Some(error.to_string());
    save(paths, journal)?;
    journal.snapshot()
}

pub(crate) fn clear(paths: &RuntimePaths) -> Result<()> {
    let path = journal_path(paths);
    match fs::remove_file(&path) {
        Ok(()) => sync_directory(&paths.state_dir),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).with_context(|| format!("Failed to remove {}", path.display())),
    }
}

fn save(paths: &RuntimePaths, journal: &RepairJournal) -> Result<()> {
    let contents = serde_json::to_vec_pretty(journal)?;
    atomic_write(&journal_path(paths), &contents)
}

fn journal_path(paths: &RuntimePaths) -> PathBuf {
    paths.state_dir.join(JOURNAL_FILE_NAME)
}

#[cfg(test)]
pub(crate) fn write_detected_for_test(paths: &RuntimePaths, retirement_name: &str) -> Result<()> {
    anyhow::ensure!(
        is_retirement_directory_name(retirement_name),
        "invalid test retirement name"
    );
    save(
        paths,
        &RepairJournal {
            detected_at: Utc::now(),
            retirement_name: retirement_name.to_string(),
            quarantine_names: Vec::new(),
            stage: RepairStage::Detected,
            last_error: None,
        },
    )
}

impl RepairJournal {
    fn snapshot(&self) -> Result<RepairSnapshot> {
        let layout = ManagedNpmLayout::new(&self.retirement_name)?;
        let (phase, planned_quarantine_path) = match &self.stage {
            RepairStage::Detected => (RepairPhase::Detected, None),
            RepairStage::QuarantinePlanned { quarantine_name } => (
                RepairPhase::QuarantinePlanned,
                Some(layout.quarantine_path(quarantine_name)?),
            ),
            RepairStage::Quarantined => (RepairPhase::Quarantined, None),
        };
        let quarantine_paths = self
            .quarantine_names
            .iter()
            .map(|name| layout.quarantine_path(name))
            .collect::<Result<Vec<_>>>()?;
        Ok(RepairSnapshot {
            detected_at: self.detected_at,
            phase,
            stale_directory: layout.stale_directory,
            quarantine_paths,
            planned_quarantine_path,
            last_error: self.last_error.clone(),
        })
    }
}

impl ManagedNpmLayout {
    fn new(retirement_name: &str) -> Result<Self> {
        anyhow::ensure!(
            is_retirement_directory_name(retirement_name),
            "Invalid npm retirement directory name {retirement_name}"
        );
        let prefix = managed_prefix();
        let scope = prefix.join("lib/node_modules/@openai");
        Ok(Self {
            retirement_name: retirement_name.to_string(),
            active_package: scope.join("codex"),
            stale_directory: scope.join(retirement_name),
            quarantine_root: scope.join(QUARANTINE_DIRECTORY_NAME),
            prefix,
            scope,
        })
    }

    fn validate_prefix(&self) -> Result<()> {
        let home = self
            .prefix
            .parent()
            .context("Managed npm prefix has no home directory")?;
        validate_owned_directory(home)?;
        validate_owned_directory(&self.prefix)
    }

    fn validate_active_package(&self) -> Result<()> {
        validate_managed_directory(&self.prefix, &self.active_package)
    }

    fn validate_existing_install_target(&self) -> Result<()> {
        validate_existing_managed_path(&self.prefix, &self.active_package)
    }

    fn validate_stale_directory(&self) -> Result<()> {
        validate_managed_directory(&self.prefix, &self.stale_directory)
    }

    fn ensure_quarantine_root(&self) -> Result<()> {
        validate_managed_directory(&self.prefix, &self.scope)?;
        match fs::symlink_metadata(&self.quarantine_root) {
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                fs::DirBuilder::new()
                    .mode(0o700)
                    .create(&self.quarantine_root)
                    .with_context(|| {
                        format!(
                            "Failed to create npm quarantine {}",
                            self.quarantine_root.display()
                        )
                    })?;
                sync_directory(&self.scope)?;
            }
            Err(error) => {
                return Err(error).with_context(|| {
                    format!(
                        "Failed to inspect npm quarantine {}",
                        self.quarantine_root.display()
                    )
                });
            }
        }
        validate_managed_directory(&self.prefix, &self.quarantine_root)
    }

    fn validate_quarantine_path(&self, path: &Path) -> Result<()> {
        anyhow::ensure!(
            path.parent() == Some(self.quarantine_root.as_path()),
            "Persisted npm quarantine path {} is invalid",
            path.display()
        );
        validate_managed_directory(&self.prefix, path)
    }

    fn quarantine_path(&self, name: &str) -> Result<PathBuf> {
        let mut components = Path::new(name).components();
        anyhow::ensure!(
            matches!(components.next(), Some(Component::Normal(_))) && components.next().is_none(),
            "Persisted npm quarantine name {name} is invalid"
        );
        let suffix = name
            .strip_prefix(&format!("{}.", self.retirement_name))
            .context("Persisted npm quarantine name does not match the retirement directory")?;
        let (timestamp, pid) = suffix
            .split_once('.')
            .context("Persisted npm quarantine name has an invalid suffix")?;
        anyhow::ensure!(
            !timestamp.is_empty()
                && timestamp.bytes().all(|byte| byte.is_ascii_digit())
                && !pid.is_empty()
                && pid.bytes().all(|byte| byte.is_ascii_digit()),
            "Persisted npm quarantine name {name} has an invalid suffix"
        );
        Ok(self.quarantine_root.join(name))
    }

    fn allocate_quarantine_name(&self) -> String {
        let stale_name = self
            .stale_directory
            .file_name()
            .and_then(OsStr::to_str)
            .expect("validated retirement name should remain UTF-8");
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        format!("{stale_name}.{timestamp}.{}", std::process::id())
    }
}

fn npm_error_path_field(stderr: &str, field: &str) -> Option<PathBuf> {
    stderr.lines().find_map(|line| {
        let payload = line
            .trim()
            .strip_prefix("npm error ")
            .or_else(|| line.trim().strip_prefix("npm ERR! "))?;
        payload
            .strip_prefix(field)?
            .strip_prefix(char::is_whitespace)
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
    })
}

fn is_retirement_directory_name(name: &str) -> bool {
    name.strip_prefix(".codex-").is_some_and(|suffix| {
        suffix.len() == 8 && suffix.chars().all(|ch| ch.is_ascii_alphanumeric())
    })
}

fn validate_owned_directory(path: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(path)
        .with_context(|| format!("Failed to inspect managed npm path {}", path.display()))?;
    anyhow::ensure!(
        metadata.is_dir()
            && !metadata.file_type().is_symlink()
            && metadata.uid() == unsafe { libc::geteuid() }
            && metadata.permissions().mode() & 0o022 == 0,
        "Managed npm path {} is not a secure user-owned directory",
        path.display()
    );
    Ok(())
}

fn validate_managed_directory(prefix: &Path, path: &Path) -> Result<()> {
    let relative = path.strip_prefix(prefix).with_context(|| {
        format!(
            "Managed npm path {} is outside {}",
            path.display(),
            prefix.display()
        )
    })?;
    anyhow::ensure!(
        !relative.as_os_str().is_empty(),
        "Managed npm operation cannot target the prefix root"
    );

    let mut current = prefix.to_path_buf();
    for component in relative.components() {
        anyhow::ensure!(
            matches!(component, Component::Normal(_)),
            "Managed npm path {} contains an unsafe component",
            path.display()
        );
        current.push(component.as_os_str());
        validate_owned_directory(&current)?;
    }
    Ok(())
}

fn validate_existing_managed_path(prefix: &Path, path: &Path) -> Result<()> {
    let relative = path.strip_prefix(prefix).with_context(|| {
        format!(
            "Managed npm path {} is outside {}",
            path.display(),
            prefix.display()
        )
    })?;
    anyhow::ensure!(
        !relative.as_os_str().is_empty(),
        "Managed npm operation cannot target the prefix root"
    );

    let mut current = prefix.to_path_buf();
    for component in relative.components() {
        anyhow::ensure!(
            matches!(component, Component::Normal(_)),
            "Managed npm path {} contains an unsafe component",
            path.display()
        );
        current.push(component.as_os_str());
        match fs::symlink_metadata(&current) {
            Ok(_) => validate_owned_directory(&current)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(error) => {
                return Err(error).with_context(|| {
                    format!("Failed to inspect managed npm path {}", current.display())
                });
            }
        }
    }
    Ok(())
}

fn path_exists_without_following(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error).with_context(|| format!("Failed to inspect {}", path.display())),
    }
}

fn rename_noreplace(source: &Path, destination: &Path) -> std::io::Result<()> {
    let source_parent = source.parent().map(Path::to_path_buf);
    let destination_parent = destination.parent().map(Path::to_path_buf);
    let source = CString::new(source.as_os_str().as_bytes())
        .map_err(|_| std::io::Error::from_raw_os_error(libc::EINVAL))?;
    let destination = CString::new(destination.as_os_str().as_bytes())
        .map_err(|_| std::io::Error::from_raw_os_error(libc::EINVAL))?;
    let result = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            source.as_ptr(),
            libc::AT_FDCWD,
            destination.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if result == 0 {
        if let Some(parent) = source_parent.as_deref() {
            sync_directory(parent).map_err(std::io::Error::other)?;
        }
        if destination_parent != source_parent {
            if let Some(parent) = destination_parent.as_deref() {
                sync_directory(parent).map_err(std::io::Error::other)?;
            }
        }
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{os::unix::fs::PermissionsExt, process::ExitStatus};
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

    fn output_with_prefix(source: &Path, destination: &Path, prefix: &str) -> Output {
        use std::os::unix::process::ExitStatusExt;
        Output {
            status: ExitStatus::from_raw(217 << 8),
            stdout: Vec::new(),
            stderr: format!(
                "{prefix} code ENOTEMPTY\n{prefix} syscall rename\n{prefix} path {}\n{prefix} dest {}\n",
                source.display(),
                destination.display()
            )
            .into_bytes(),
        }
    }

    fn output(source: &Path, destination: &Path) -> Output {
        output_with_prefix(source, destination, "npm error")
    }

    fn secure_tree(root: &Path) -> Result<()> {
        let metadata = fs::symlink_metadata(root)?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Ok(());
        }
        fs::set_permissions(root, fs::Permissions::from_mode(0o755))?;
        for entry in fs::read_dir(root)? {
            secure_tree(&entry?.path())?;
        }
        Ok(())
    }

    #[test]
    fn detection_persists_without_mutating_stale_directory() -> Result<()> {
        let _guard = crate::test_util::env_lock();
        let _restore_env = crate::test_util::EnvRestoreGuard::capture(&["HOME"]);
        let temp = tempdir()?;
        let home = temp.path().join("home");
        let paths = test_paths(temp.path());
        fs::create_dir_all(&paths.state_dir)?;
        let prefix = home.join(".codex-cli-npm");
        let active = prefix.join("lib/node_modules/@openai/codex");
        let stale = prefix.join("lib/node_modules/@openai/.codex-cqYkmGXr");
        fs::create_dir_all(&active)?;
        fs::create_dir_all(&stale)?;
        std::env::set_var("HOME", &home);

        let snapshot = detect_and_persist(&paths, &prefix, &output(&active, &stale))?
            .context("stale condition should be detected")?;

        assert_eq!(snapshot.stale_directory, stale);
        assert!(stale.exists());
        assert!(journal_path(&paths).exists());
        Ok(())
    }

    #[test]
    fn detection_rejects_untrusted_shapes_without_persisting() -> Result<()> {
        let _guard = crate::test_util::env_lock();
        let _restore_env = crate::test_util::EnvRestoreGuard::capture(&["HOME"]);
        let temp = tempdir()?;
        let home = temp.path().join("home");
        let paths = test_paths(temp.path());
        fs::create_dir_all(&paths.state_dir)?;
        let prefix = home.join(".codex-cli-npm");
        let active = prefix.join("lib/node_modules/@openai/codex");
        let scope = active.parent().context("test package has no scope")?;
        let outside = temp.path().join(".codex-cqYkmGXr");
        let malformed = scope.join(".codex-not-a-retirement-hash");
        let valid = scope.join(".codex-cqYkmGXr");
        let wrong_source = scope.join("another-package");
        fs::create_dir_all(&active)?;
        fs::create_dir_all(&outside)?;
        fs::create_dir_all(&malformed)?;
        fs::create_dir_all(&valid)?;
        std::env::set_var("HOME", &home);

        assert!(detect_and_persist(&paths, &prefix, &output(&active, &outside))?.is_none());
        assert!(detect_and_persist(&paths, &prefix, &output(&active, &malformed))?.is_none());
        assert!(detect_and_persist(&paths, &prefix, &output(&wrong_source, &valid))?.is_none());
        assert!(detect_and_persist(
            &paths,
            &temp.path().join("other-prefix"),
            &output(&active, &valid)
        )?
        .is_none());
        assert!(!journal_path(&paths).exists());
        assert!(outside.exists());
        assert!(malformed.exists());
        assert!(valid.exists());
        Ok(())
    }

    #[test]
    fn detection_accepts_legacy_npm_error_prefix_without_mutating() -> Result<()> {
        let _guard = crate::test_util::env_lock();
        let _restore_env = crate::test_util::EnvRestoreGuard::capture(&["HOME"]);
        let temp = tempdir()?;
        let home = temp.path().join("home");
        let paths = test_paths(temp.path());
        fs::create_dir_all(&paths.state_dir)?;
        let prefix = home.join(".codex-cli-npm");
        let active = prefix.join("lib/node_modules/@openai/codex");
        let stale = prefix.join("lib/node_modules/@openai/.codex-cqYkmGXr");
        fs::create_dir_all(&active)?;
        fs::create_dir_all(&stale)?;
        std::env::set_var("HOME", &home);

        let snapshot = detect_and_persist(
            &paths,
            &prefix,
            &output_with_prefix(&active, &stale, "npm ERR!"),
        )?
        .context("legacy npm stderr should be detected")?;

        assert_eq!(snapshot.stale_directory, stale);
        assert!(stale.exists());
        Ok(())
    }

    #[test]
    fn planned_quarantine_recovers_after_rename_before_stage_commit() -> Result<()> {
        let _guard = crate::test_util::env_lock();
        let _restore_env = crate::test_util::EnvRestoreGuard::capture(&["HOME"]);
        let temp = tempdir()?;
        let home = temp.path().join("home");
        let paths = test_paths(temp.path());
        fs::create_dir_all(&paths.state_dir)?;
        let prefix = home.join(".codex-cli-npm");
        let active = prefix.join("lib/node_modules/@openai/codex");
        let stale = prefix.join("lib/node_modules/@openai/.codex-cqYkmGXr");
        fs::create_dir_all(&active)?;
        fs::create_dir_all(&stale)?;
        secure_tree(&home)?;
        std::env::set_var("HOME", &home);
        let mut journal = detect(&prefix, &output(&active, &stale)).context("missing repair")?;
        let layout = ManagedNpmLayout::new(&journal.retirement_name)?;
        layout.ensure_quarantine_root()?;
        let quarantine_name = layout.allocate_quarantine_name();
        let quarantine_path = layout.quarantine_root.join(&quarantine_name);
        journal.stage = RepairStage::QuarantinePlanned { quarantine_name };
        save(&paths, &journal)?;
        let planned = snapshot(&paths)?.context("planned repair should be visible")?;
        assert_eq!(planned.phase, RepairPhase::QuarantinePlanned);
        assert_eq!(
            planned.planned_quarantine_path.as_deref(),
            Some(quarantine_path.as_path())
        );
        rename_noreplace(&stale, &quarantine_path)?;

        let mut journal = load(&paths)?.context("missing journal")?;
        let snapshot = quarantine(&paths, &mut journal)?;

        assert!(matches!(journal.stage, RepairStage::Quarantined));
        assert_eq!(snapshot.quarantine_paths, vec![quarantine_path.clone()]);
        assert!(quarantine_path.exists());
        Ok(())
    }

    #[test]
    fn planned_quarantine_moves_a_recreated_stale_directory_again() -> Result<()> {
        let _guard = crate::test_util::env_lock();
        let _restore_env = crate::test_util::EnvRestoreGuard::capture(&["HOME"]);
        let temp = tempdir()?;
        let home = temp.path().join("home");
        let paths = test_paths(temp.path());
        fs::create_dir_all(&paths.state_dir)?;
        let prefix = home.join(".codex-cli-npm");
        let active = prefix.join("lib/node_modules/@openai/codex");
        let stale = prefix.join("lib/node_modules/@openai/.codex-cqYkmGXr");
        fs::create_dir_all(&active)?;
        fs::create_dir_all(&stale)?;
        secure_tree(&home)?;
        std::env::set_var("HOME", &home);
        let mut journal = detect(&prefix, &output(&active, &stale)).context("missing repair")?;
        let layout = ManagedNpmLayout::new(&journal.retirement_name)?;
        layout.ensure_quarantine_root()?;
        let quarantine_name = layout.allocate_quarantine_name();
        let first_quarantine = layout.quarantine_root.join(&quarantine_name);
        fs::create_dir_all(&first_quarantine)?;
        secure_tree(&first_quarantine)?;
        journal.stage = RepairStage::QuarantinePlanned { quarantine_name };
        save(&paths, &journal)?;

        let snapshot = quarantine(&paths, &mut journal)?;

        assert!(matches!(journal.stage, RepairStage::Quarantined));
        assert_eq!(snapshot.quarantine_paths.len(), 2);
        assert_eq!(snapshot.quarantine_paths[0], first_quarantine);
        assert!(snapshot.quarantine_paths.iter().all(|path| path.exists()));
        assert!(!stale.exists());
        Ok(())
    }

    #[test]
    fn quarantine_handles_an_already_absent_stale_directory() -> Result<()> {
        let _guard = crate::test_util::env_lock();
        let _restore_env = crate::test_util::EnvRestoreGuard::capture(&["HOME"]);
        let temp = tempdir()?;
        let home = temp.path().join("home");
        let paths = test_paths(temp.path());
        fs::create_dir_all(&paths.state_dir)?;
        let active = home.join(".codex-cli-npm/lib/node_modules/@openai/codex");
        fs::create_dir_all(&active)?;
        secure_tree(&home)?;
        std::env::set_var("HOME", &home);
        write_detected_for_test(&paths, ".codex-cqYkmGXr")?;

        let mut journal = load(&paths)?.context("missing repair journal")?;
        let snapshot = quarantine(&paths, &mut journal)?;

        assert!(matches!(journal.stage, RepairStage::Quarantined));
        assert!(snapshot.quarantine_paths.is_empty());
        Ok(())
    }

    #[test]
    fn quarantine_rejects_a_stale_directory_symlink() -> Result<()> {
        let _guard = crate::test_util::env_lock();
        let _restore_env = crate::test_util::EnvRestoreGuard::capture(&["HOME"]);
        let temp = tempdir()?;
        let home = temp.path().join("home");
        let paths = test_paths(temp.path());
        fs::create_dir_all(&paths.state_dir)?;
        let scope = home.join(".codex-cli-npm/lib/node_modules/@openai");
        let active = scope.join("codex");
        let stale = scope.join(".codex-cqYkmGXr");
        let target = temp.path().join("must-survive");
        fs::create_dir_all(&active)?;
        fs::create_dir_all(&target)?;
        std::os::unix::fs::symlink(&target, &stale)?;
        secure_tree(&home)?;
        std::env::set_var("HOME", &home);
        write_detected_for_test(&paths, ".codex-cqYkmGXr")?;

        let mut journal = load(&paths)?.context("missing repair journal")?;
        quarantine(&paths, &mut journal).expect_err("quarantine must reject a retirement symlink");

        assert!(stale.is_symlink());
        assert!(target.exists());
        Ok(())
    }

    #[test]
    fn planned_quarantine_rejects_an_untrusted_persisted_name_before_rename() -> Result<()> {
        let _guard = crate::test_util::env_lock();
        let _restore_env = crate::test_util::EnvRestoreGuard::capture(&["HOME"]);
        let temp = tempdir()?;
        let home = temp.path().join("home");
        let paths = test_paths(temp.path());
        fs::create_dir_all(&paths.state_dir)?;
        let prefix = home.join(".codex-cli-npm");
        let scope = prefix.join("lib/node_modules/@openai");
        let active = scope.join("codex");
        let stale = scope.join(".codex-cqYkmGXr");
        let escaped = scope.join("escaped");
        fs::create_dir_all(&active)?;
        fs::create_dir_all(&stale)?;
        secure_tree(&home)?;
        std::env::set_var("HOME", &home);
        let mut journal = detect(&prefix, &output(&active, &stale)).context("missing repair")?;
        journal.stage = RepairStage::QuarantinePlanned {
            quarantine_name: "../escaped".to_string(),
        };
        save(&paths, &journal)?;

        quarantine(&paths, &mut journal)
            .expect_err("repair must reject an untrusted persisted quarantine name");

        assert!(stale.exists());
        assert!(!escaped.exists());
        Ok(())
    }

    #[test]
    fn historical_quarantine_names_are_validated_before_a_new_rename() -> Result<()> {
        let _guard = crate::test_util::env_lock();
        let _restore_env = crate::test_util::EnvRestoreGuard::capture(&["HOME"]);
        let temp = tempdir()?;
        let home = temp.path().join("home");
        let paths = test_paths(temp.path());
        fs::create_dir_all(&paths.state_dir)?;
        let prefix = home.join(".codex-cli-npm");
        let scope = prefix.join("lib/node_modules/@openai");
        let active = scope.join("codex");
        let stale = scope.join(".codex-cqYkmGXr");
        let escaped = scope.join("escaped");
        fs::create_dir_all(&active)?;
        fs::create_dir_all(&stale)?;
        secure_tree(&home)?;
        std::env::set_var("HOME", &home);
        let mut journal = detect(&prefix, &output(&active, &stale)).context("missing repair")?;
        journal.quarantine_names.push("../escaped".to_string());
        journal.stage = RepairStage::Quarantined;
        save(&paths, &journal)?;

        quarantine(&paths, &mut journal)
            .expect_err("repair must reject an untrusted historical quarantine name");

        assert!(stale.exists());
        assert!(!escaped.exists());
        assert!(!scope.join(QUARANTINE_DIRECTORY_NAME).exists());
        Ok(())
    }

    #[test]
    fn retry_revalidates_a_recreated_active_package() -> Result<()> {
        let _guard = crate::test_util::env_lock();
        let _restore_env = crate::test_util::EnvRestoreGuard::capture(&["HOME"]);
        let temp = tempdir()?;
        let home = temp.path().join("home");
        let paths = test_paths(temp.path());
        fs::create_dir_all(&paths.state_dir)?;
        let scope = home.join(".codex-cli-npm/lib/node_modules/@openai");
        let active = scope.join("codex");
        let stale = scope.join(".codex-cqYkmGXr");
        let target = temp.path().join("must-survive");
        fs::create_dir_all(&scope)?;
        fs::create_dir_all(&stale)?;
        fs::create_dir_all(&target)?;
        secure_tree(&home)?;
        std::os::unix::fs::symlink(&target, &active)?;
        std::env::set_var("HOME", &home);
        write_detected_for_test(&paths, ".codex-cqYkmGXr")?;
        let mut journal = load(&paths)?.context("missing repair journal")?;
        journal.stage = RepairStage::Quarantined;
        save(&paths, &journal)?;

        quarantine(&paths, &mut journal).expect_err("repair retry must reject an active symlink");

        assert!(active.is_symlink());
        assert!(stale.exists());
        assert!(target.exists());
        Ok(())
    }

    #[test]
    fn retry_revalidates_existing_install_ancestors() -> Result<()> {
        let _guard = crate::test_util::env_lock();
        let _restore_env = crate::test_util::EnvRestoreGuard::capture(&["HOME"]);
        let temp = tempdir()?;
        let home = temp.path().join("home");
        let paths = test_paths(temp.path());
        fs::create_dir_all(&paths.state_dir)?;
        let modules = home.join(".codex-cli-npm/lib/node_modules");
        let scope = modules.join("@openai");
        let target = temp.path().join("must-survive");
        fs::create_dir_all(&modules)?;
        fs::create_dir_all(&target)?;
        secure_tree(&home)?;
        std::os::unix::fs::symlink(&target, &scope)?;
        std::env::set_var("HOME", &home);
        write_detected_for_test(&paths, ".codex-cqYkmGXr")?;
        let mut journal = load(&paths)?.context("missing repair journal")?;
        journal.stage = RepairStage::Quarantined;
        save(&paths, &journal)?;

        quarantine(&paths, &mut journal).expect_err("repair retry must reject an ancestor symlink");

        assert!(scope.is_symlink());
        assert!(target.exists());
        Ok(())
    }

    #[test]
    fn install_lock_rejects_symlinks_and_times_out() -> Result<()> {
        let temp = tempdir()?;
        let paths = test_paths(temp.path());
        fs::create_dir_all(&paths.state_dir)?;
        let first = acquire_install_lock_with_timeout(&paths, Duration::from_millis(100))?;
        let error = acquire_install_lock_with_timeout(&paths, Duration::from_millis(75))
            .expect_err("second lock must time out");
        assert!(error.to_string().contains("Timed out waiting"));
        drop(first);

        fs::remove_file(paths.state_dir.join(LOCK_FILE_NAME))?;
        let target = temp.path().join("must-survive");
        fs::write(&target, "unchanged\n")?;
        std::os::unix::fs::symlink(&target, paths.state_dir.join(LOCK_FILE_NAME))?;
        acquire_install_lock_with_timeout(&paths, Duration::from_millis(100))
            .expect_err("lock must reject symlinks");
        assert_eq!(fs::read_to_string(target)?, "unchanged\n");
        Ok(())
    }
}
