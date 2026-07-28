use super::*;
use std::{
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
};

fn write_executable(path: &Path, contents: &str) -> Result<()> {
    std::fs::write(path, contents)?;
    let mut permissions = std::fs::metadata(path)?.permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(path, permissions)?;
    Ok(())
}

fn secure_tree(path: &Path) -> Result<()> {
    let metadata = std::fs::symlink_metadata(path)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Ok(());
    }
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))?;
    for entry in std::fs::read_dir(path)? {
        secure_tree(&entry?.path())?;
    }
    Ok(())
}

struct CliRepairProcessFixture {
    root: PathBuf,
    paths: RuntimePaths,
    bin_dir: PathBuf,
    active_package: PathBuf,
    stale_directory: PathBuf,
    cli_path: PathBuf,
    install_log: PathBuf,
    install_started: PathBuf,
    install_release: PathBuf,
    install_overlap: PathBuf,
    owner_dir: PathBuf,
}

impl CliRepairProcessFixture {
    fn env(&self) -> Vec<(&'static str, &Path)> {
        vec![
            ("PATH", &self.bin_dir),
            ("CODEX_UPDATE_MANAGER_TEST_CLI_PATH", &self.cli_path),
            ("CODEX_UPDATE_MANAGER_SKIP_SYSTEM_CLI_LOOKUP", &self.root),
            ("NPM_ACTIVE_PACKAGE", &self.active_package),
            ("NPM_RETIREMENT_PATH", &self.stale_directory),
            ("NPM_MANAGED_CLI", &self.cli_path),
            ("NPM_INSTALL_LOG", &self.install_log),
            ("NPM_INSTALL_STARTED", &self.install_started),
            ("NPM_INSTALL_RELEASE", &self.install_release),
            ("NPM_INSTALL_OVERLAP", &self.install_overlap),
            ("NPM_OWNER_DIR", &self.owner_dir),
        ]
    }
}

fn prepare_fixture(root: &Path) -> Result<CliRepairProcessFixture> {
    let paths = process_test_paths(root);
    paths.ensure_dirs()?;
    let home = root.join("home");
    let bin_dir = root.join("cli-bin");
    let prefix = home.join(".codex-cli-npm");
    let managed_bin = prefix.join("bin");
    let active_package = prefix.join("lib/node_modules/@openai/codex");
    let stale_directory = prefix
        .join("lib/node_modules/@openai")
        .join(".codex-cqYkmGXr");
    std::fs::create_dir_all(&active_package)?;
    std::fs::create_dir_all(&stale_directory)?;
    std::fs::create_dir_all(&bin_dir)?;
    std::fs::create_dir_all(&managed_bin)?;

    let mut config = test_config(root);
    config.workspace_root = paths.cache_dir.clone();
    std::fs::write(&paths.config_file, toml::to_string(&config)?)?;

    let cli_path = managed_bin.join("codex");
    write_executable(
        &cli_path,
        "#!/bin/sh\nif [ \"$1\" = \"--version\" ] || [ \"$1\" = \"version\" ]; then\n  echo 'codex-cli v0.42.0'\n  exit 0\nfi\nexit 1\n",
    )?;
    write_executable(&bin_dir.join("node"), "#!/bin/sh\nexit 0\n")?;
    write_executable(
        &bin_dir.join("npm"),
        r#"#!/bin/sh
if [ "$1" = "view" ]; then
  echo '0.42.1'
  exit 0
fi
if [ "$1" = "install" ]; then
  printf '%s\n' "$$" >> "$NPM_INSTALL_LOG"
  if /bin/mkdir "$NPM_OWNER_DIR" 2>/dev/null; then
    /bin/touch "$NPM_INSTALL_STARTED"
    while [ ! -e "$NPM_INSTALL_RELEASE" ]; do
      /bin/sleep 0.01
    done
  else
    /bin/touch "$NPM_INSTALL_OVERLAP"
  fi
  if [ "${NPM_INSTALL_RESULT:-stale}" = "success" ]; then
    printf '%s\n' '#!/bin/sh' 'echo "codex-cli v0.42.1"' > "$NPM_MANAGED_CLI"
    /bin/chmod 755 "$NPM_MANAGED_CLI"
    exit 0
  fi
  printf '%s\n' \
    'npm error code ENOTEMPTY' \
    'npm error syscall rename' \
    "npm error path $NPM_ACTIVE_PACKAGE" \
    "npm error dest $NPM_RETIREMENT_PATH" >&2
  exit 217
fi
exit 1
"#,
    )?;
    secure_tree(&home)?;

    let mut state = PersistedState::new(true);
    state.cli_path = Some(cli_path.clone());
    state.cli_install_channel = Some(crate::state::CliInstallChannel::Npm);
    state.save(&paths.state_file)?;
    Ok(CliRepairProcessFixture {
        root: root.to_path_buf(),
        paths,
        bin_dir,
        active_package,
        stale_directory,
        cli_path,
        install_log: root.join("npm-install.log"),
        install_started: root.join("npm-install.started"),
        install_release: root.join("npm-install.release"),
        install_overlap: root.join("npm-install.overlap"),
        owner_dir: root.join("npm-install.owner"),
    })
}

#[test]
fn concurrent_cli_preflight_status_and_daemon_serialize_npm_install_subprocesses() -> Result<()> {
    let _env_guard = crate::test_util::env_lock();
    let temp = tempfile::tempdir()?;
    let fixture = prepare_fixture(temp.path())?;
    let status_lock_waiting = temp.path().join("status-cli-install-lock.waiting");
    let daemon_lock_waiting = temp.path().join("daemon-cli-install-lock.waiting");
    let common_env = fixture.env();

    let first = spawn_process_test_child(
        temp.path(),
        "cli-preflight",
        &common_env,
        &[&fixture.install_release],
    )?;
    wait_for_process_test_path(&fixture.install_started, "first npm install")?;

    let mut persisted = PersistedState::load_or_default(&fixture.paths.state_file, true)?;
    persisted.cli_last_check_at = None;
    persisted.remote_headers_fingerprint = Some("must-survive-cli-race".to_string());
    persisted.save(&fixture.paths.state_file)?;

    let mut daemon_env = common_env.clone();
    daemon_env.push((
        "CODEX_UPDATE_MANAGER_TEST_CLI_INSTALL_LOCK_WAITING",
        &daemon_lock_waiting,
    ));
    let daemon =
        spawn_process_test_child(temp.path(), "daemon-startup-maintenance", &daemon_env, &[])?;
    wait_for_process_test_path(&daemon_lock_waiting, "daemon CLI install lock wait")?;

    let mut persisted = PersistedState::load_or_default(&fixture.paths.state_file, true)?;
    persisted.cli_last_check_at = None;
    persisted.save(&fixture.paths.state_file)?;
    let mut status_env = common_env.clone();
    status_env.push((
        "CODEX_UPDATE_MANAGER_TEST_CLI_INSTALL_LOCK_WAITING",
        &status_lock_waiting,
    ));
    let status = spawn_process_test_child(temp.path(), "cli-status", &status_env, &[])?;
    wait_for_process_test_path(&status_lock_waiting, "status CLI install lock wait")?;

    assert_eq!(
        std::fs::read_to_string(&fixture.install_log)?
            .lines()
            .count(),
        1
    );
    assert!(!fixture.install_overlap.exists());

    std::fs::write(&fixture.install_release, b"continue")?;
    first.wait()?;
    status.wait()?;
    daemon.wait()?;

    assert_eq!(
        std::fs::read_to_string(&fixture.install_log)?
            .lines()
            .count(),
        1
    );
    assert!(!fixture.install_overlap.exists());
    assert!(fixture.stale_directory.exists());
    let persisted = PersistedState::load_or_default(&fixture.paths.state_file, true)?;
    assert!(crate::npm_cli_repair::load(&fixture.paths)?.is_some());
    assert!(persisted
        .cli_error_message
        .as_deref()
        .is_some_and(|message| message.contains("codex-update-manager diagnose")));
    assert_eq!(
        persisted.remote_headers_fingerprint.as_deref(),
        Some("must-survive-cli-race")
    );
    Ok(())
}

#[test]
fn waiting_status_revalidates_successful_cli_install_before_running_npm() -> Result<()> {
    let _env_guard = crate::test_util::env_lock();
    let temp = tempfile::tempdir()?;
    let fixture = prepare_fixture(temp.path())?;
    let lock_waiting = temp.path().join("cli-install-lock.waiting");
    let mut common_env = fixture.env();
    common_env.push(("NPM_INSTALL_RESULT", Path::new("success")));

    let first = spawn_process_test_child(
        temp.path(),
        "cli-preflight",
        &common_env,
        &[&fixture.install_release],
    )?;
    wait_for_process_test_path(&fixture.install_started, "first successful npm install")?;

    let mut persisted = PersistedState::load_or_default(&fixture.paths.state_file, true)?;
    persisted.cli_last_check_at = None;
    persisted.remote_headers_fingerprint = Some("must-survive-success-race".to_string());
    persisted.save(&fixture.paths.state_file)?;

    let mut second_env = common_env.clone();
    second_env.push((
        "CODEX_UPDATE_MANAGER_TEST_CLI_INSTALL_LOCK_WAITING",
        &lock_waiting,
    ));
    let second = spawn_process_test_child(temp.path(), "cli-status", &second_env, &[])?;
    wait_for_process_test_path(&lock_waiting, "status CLI install lock wait")?;

    std::fs::write(&fixture.install_release, b"continue")?;
    first.wait()?;
    second.wait()?;

    assert_eq!(
        std::fs::read_to_string(&fixture.install_log)?
            .lines()
            .count(),
        1
    );
    assert!(!fixture.install_overlap.exists());
    assert!(crate::npm_cli_repair::load(&fixture.paths)?.is_none());
    let persisted = PersistedState::load_or_default(&fixture.paths.state_file, true)?;
    assert_eq!(persisted.cli_status, CliStatus::UpToDate);
    assert_eq!(persisted.cli_installed_version.as_deref(), Some("0.42.1"));
    assert_eq!(
        persisted.remote_headers_fingerprint.as_deref(),
        Some("must-survive-success-race")
    );
    Ok(())
}

#[test]
fn explicit_repair_preserves_concurrent_status_state_and_quarantine() -> Result<()> {
    let _env_guard = crate::test_util::env_lock();
    let _restore_env = crate::test_util::EnvRestoreGuard::capture(&["HOME"]);
    let temp = tempfile::tempdir()?;
    let fixture = prepare_fixture(temp.path())?;
    std::env::set_var("HOME", temp.path().join("home"));
    crate::npm_cli_repair::write_detected_for_test(&fixture.paths, ".codex-cqYkmGXr")?;
    let mut common_env = fixture.env();
    common_env.push(("NPM_INSTALL_RESULT", Path::new("success")));

    let repair = spawn_process_test_child(
        temp.path(),
        "repair-cli",
        &common_env,
        &[&fixture.install_release],
    )?;
    wait_for_process_test_path(&fixture.install_started, "explicit repair npm install")?;
    let quarantine_path = crate::npm_cli_repair::snapshot(&fixture.paths)?
        .and_then(|snapshot| snapshot.quarantine_path)
        .context("repair should persist its quarantine before running npm")?;
    assert!(!fixture.stale_directory.exists());
    assert!(quarantine_path.exists());

    let mut persisted = PersistedState::load_or_default(&fixture.paths.state_file, true)?;
    persisted.remote_headers_fingerprint = Some("must-survive-explicit-repair".to_string());
    persisted.save(&fixture.paths.state_file)?;
    spawn_process_test_child(temp.path(), "cli-status", &common_env, &[])?.wait()?;

    assert_eq!(
        std::fs::read_to_string(&fixture.install_log)?
            .lines()
            .count(),
        1
    );
    assert!(!fixture.install_overlap.exists());
    assert!(crate::npm_cli_repair::load(&fixture.paths)?.is_some());

    std::fs::write(&fixture.install_release, b"continue")?;
    repair.wait()?;

    assert_eq!(
        std::fs::read_to_string(&fixture.install_log)?
            .lines()
            .count(),
        1
    );
    assert!(!fixture.install_overlap.exists());
    assert!(crate::npm_cli_repair::load(&fixture.paths)?.is_none());
    assert!(quarantine_path.exists());
    let persisted = PersistedState::load_or_default(&fixture.paths.state_file, true)?;
    assert_eq!(persisted.cli_status, CliStatus::UpToDate);
    assert_eq!(persisted.cli_installed_version.as_deref(), Some("0.42.1"));
    assert_eq!(
        persisted.remote_headers_fingerprint.as_deref(),
        Some("must-survive-explicit-repair")
    );
    Ok(())
}

#[test]
fn diagnose_subprocess_is_read_only_and_explains_pending_cli_repair() -> Result<()> {
    let _env_guard = crate::test_util::env_lock();
    let absent = tempfile::tempdir()?;
    let child = spawn_process_test_child(absent.path(), "diagnose", &[], &[])?;
    child.wait()?;
    assert!(!absent.path().join("xdg-config").exists());
    assert!(!absent.path().join("xdg-state").exists());
    assert!(!absent.path().join("xdg-cache").exists());

    let pending = tempfile::tempdir()?;
    let paths = process_test_paths(pending.path());
    std::fs::create_dir_all(&paths.state_dir)?;
    crate::npm_cli_repair::write_detected_for_test(&paths, ".codex-cqYkmGXr")?;
    let journal_path = paths.state_dir.join("cli-repair.json");
    let before = std::fs::read(&journal_path)?;

    let mut command = std::process::Command::new(std::env::current_exe()?);
    configure_process_test_command(&mut command, pending.path(), "diagnose");
    let output = command.output()?;

    anyhow::ensure!(
        output.status.success(),
        "diagnose subprocess failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("stale npm retirement directory"));
    assert!(stdout.contains("codex-update-manager repair-cli"));
    assert_eq!(std::fs::read(journal_path)?, before);
    assert!(!paths.log_file.exists());
    assert!(!paths.config_file.exists());
    assert!(!paths.cache_dir.exists());
    Ok(())
}
