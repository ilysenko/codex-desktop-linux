use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::{
    fs,
    os::unix::fs::{symlink, PermissionsExt},
    path::{Path, PathBuf},
    process::{Child, Command, Output, Stdio},
    thread,
    time::{Duration, Instant},
};
use tempfile::TempDir;

const WAIT_TIMEOUT: Duration = Duration::from_secs(15);

struct Fixture {
    _temp: TempDir,
    root: PathBuf,
    home: PathBuf,
    config_home: PathBuf,
    state_home: PathBuf,
    cache_home: PathBuf,
    cli_path: PathBuf,
    active_package: PathBuf,
    stale_directory: PathBuf,
    latest_version: PathBuf,
    install_mode: PathBuf,
    install_log: PathBuf,
    install_started: PathBuf,
    install_release: PathBuf,
    install_overlap: PathBuf,
    install_owner: PathBuf,
    background_process_group: PathBuf,
    npm_supervisor_pid: PathBuf,
    view_started: PathBuf,
    view_release: PathBuf,
}

impl Fixture {
    fn new() -> Result<Self> {
        let temp = tempfile::tempdir()?;
        let root = temp.path().to_path_buf();
        let home = root.join("home");
        let config_home = root.join("xdg-config");
        let state_home = root.join("xdg-state");
        let cache_home = root.join("xdg-cache");
        let prefix = home.join(".codex-cli-npm");
        let package_root = prefix.join("lib/node_modules/@openai/codex");
        let cli_entrypoint = package_root.join("bin/codex.js");
        let cli_path = prefix.join("bin/codex");
        let stale_directory = prefix
            .join("lib/node_modules/@openai")
            .join(".codex-cqYkmGXr");
        let npm_path = prefix.join("bin/npm");
        let node_path = prefix.join("bin/node");
        let latest_version = root.join("npm-latest-version");
        let install_mode = root.join("npm-install-mode");
        let install_log = root.join("npm-install.log");
        let install_started = root.join("npm-install.started");
        let install_release = root.join("npm-install.release");
        let install_overlap = root.join("npm-install.overlap");
        let install_owner = root.join("npm-install.owner");
        let background_process_group = root.join("npm-background-process-group");
        let npm_supervisor_pid = root.join("npm-supervisor.pid");
        let view_started = root.join("npm-view.started");
        let view_release = root.join("npm-view.release");
        let app_executable = root.join("app/electron");

        fs::create_dir_all(cli_entrypoint.parent().context("CLI entrypoint parent")?)?;
        fs::create_dir_all(cli_path.parent().context("CLI path parent")?)?;
        fs::create_dir_all(config_home.join("codex-update-manager"))?;
        fs::create_dir_all(state_home.join("codex-update-manager"))?;
        fs::create_dir_all(cache_home.join("codex-update-manager"))?;
        fs::create_dir_all(app_executable.parent().context("app executable parent")?)?;

        write_executable(&cli_entrypoint, &cli_script("0.42.0"))?;
        symlink(
            Path::new("../lib/node_modules/@openai/codex/bin/codex.js"),
            &cli_path,
        )?;
        write_executable(&node_path, "#!/bin/sh\nexit 0\n")?;
        write_executable(
            &npm_path,
            r#"#!/bin/sh
		if [ "$1" = "view" ]; then
			  if [ "${NPM_VIEW_MODE:-success}" = "delayed-failure" ]; then
		    /bin/touch "$NPM_VIEW_STARTED"
	    while [ ! -e "$NPM_VIEW_RELEASE" ]; do
	      /bin/sleep 0.01
	    done
	    printf 'registry unavailable\n' >&2
	    exit 43
	  fi
	  /bin/cat "$NPM_LATEST_VERSION"
  exit 0
fi
if [ "$1" = "install" ]; then
  printf '%s\n' "$$" >> "$NPM_INSTALL_LOG"
  printf '%s\n' "$PPID" > "$NPM_SUPERVISOR_PID"
  previous_group="$(/bin/cat "$NPM_BACKGROUND_PROCESS_GROUP" 2>/dev/null || true)"
  if [ -n "$previous_group" ] && /bin/kill -0 -- "-$previous_group" 2>/dev/null; then
    /bin/touch "$NPM_INSTALL_OVERLAP"
    exit 99
  fi
  if ! /bin/mkdir "$NPM_INSTALL_OWNER" 2>/dev/null; then
    owner_pid="$(/bin/cat "$NPM_INSTALL_OWNER/pid" 2>/dev/null || true)"
    if [ -n "$owner_pid" ] && /bin/kill -0 "$owner_pid" 2>/dev/null; then
      /bin/touch "$NPM_INSTALL_OVERLAP"
      exit 99
    fi
    /bin/rm -f "$NPM_INSTALL_OWNER/pid"
    /bin/rmdir "$NPM_INSTALL_OWNER"
    /bin/mkdir "$NPM_INSTALL_OWNER"
  fi
  if [ -d "$NPM_INSTALL_OWNER" ]; then
    printf '%s\n' "$$" > "$NPM_INSTALL_OWNER/pid"
    trap '/bin/rm -f "$NPM_INSTALL_OWNER/pid"; /bin/rmdir "$NPM_INSTALL_OWNER"' EXIT
    /bin/touch "$NPM_INSTALL_STARTED"
    if [ "$(/bin/cat "$NPM_INSTALL_MODE")" = "background-descendant" ] ||
       [ "$(/bin/cat "$NPM_INSTALL_MODE")" = "background-descendant-hang" ]; then
      /bin/sh -c 'trap "exit 0" TERM; while :; do /bin/sleep 1; done' \
        >/dev/null 2>&1 &
      printf '%s\n' "$PPID" > "$NPM_BACKGROUND_PROCESS_GROUP"
      if [ "$(/bin/cat "$NPM_INSTALL_MODE")" = "background-descendant" ]; then
        exit 0
      fi
    fi
    while [ ! -e "$NPM_INSTALL_RELEASE" ]; do
      /bin/sleep 0.01
    done
  fi
	  if [ "$(/bin/cat "$NPM_INSTALL_MODE")" = "stale" ]; then
    /bin/mkdir -p "$NPM_RETIREMENT_PATH"
    printf '%s\n' \
      'npm error code ENOTEMPTY' \
      'npm error syscall rename' \
      "npm error path $NPM_ACTIVE_PACKAGE" \
      "npm error dest $NPM_RETIREMENT_PATH" >&2
	    exit 217
	  fi
	  printf '%s\n' '#!/bin/sh' "echo 'codex-cli v0.42.1'" > "$NPM_MANAGED_CLI"
	  /bin/chmod 755 "$NPM_MANAGED_CLI"
	  exit 0
fi
exit 1
"#,
        )?;
        fs::write(&latest_version, b"0.42.0\n")?;
        fs::write(&install_mode, b"success\n")?;
        write_executable(&app_executable, "#!/bin/sh\nexit 0\n")?;
        fs::write(
            package_root.join("package.json"),
            serde_json::to_vec_pretty(&json!({
                "name": "@openai/codex",
                "bin": {"codex": "bin/codex.js"},
                "optionalDependencies": {
                    "@openai/codex-linux-x64": "0.42.1"
                }
            }))?,
        )?;
        secure_directory_tree(&home)?;

        let config = format!(
            "dmg_url = \"http://127.0.0.1:9/Codex.dmg\"\n\
             initial_check_delay_seconds = 3600\n\
             check_interval_hours = 24\n\
             auto_install_on_app_exit = false\n\
             notifications = false\n\
             workspace_root = \"{}\"\n\
             builder_bundle_root = \"{}\"\n\
             app_executable_path = \"{}\"\n\
             enable_wrapper_updates = false\n\
             wrapper_remote = \"\"\n\
             wrapper_branch = \"main\"\n",
            toml_path(&cache_home.join("codex-update-manager")),
            toml_path(&root),
            toml_path(&app_executable),
        );
        fs::write(config_home.join("codex-update-manager/config.toml"), config)?;

        let fixture = Self {
            _temp: temp,
            root,
            home,
            config_home,
            state_home,
            cache_home,
            cli_path,
            active_package: package_root,
            stale_directory,
            latest_version,
            install_mode,
            install_log,
            install_started,
            install_release,
            install_overlap,
            install_owner,
            background_process_group,
            npm_supervisor_pid,
            view_started,
            view_release,
        };
        let output = fixture
            .command()
            .args(["cli-preflight", "--cli-path"])
            .arg(&fixture.cli_path)
            .output()?;
        ensure_success("fixture CLI preflight", &output)?;
        fixture.update_state(|state| {
            state["remote_headers_fingerprint"] = json!("must-survive-cli-race");
            state["cli_last_check_at"] = Value::Null;
            state["cli_official_latest_version"] = Value::Null;
        })?;
        fs::write(&fixture.latest_version, b"0.42.1\n")?;
        fs::write(&fixture.install_mode, b"stale\n")?;
        Ok(fixture)
    }

    fn command(&self) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_codex-update-manager"));
        command
            .env("HOME", &self.home)
            .env("XDG_CONFIG_HOME", &self.config_home)
            .env("XDG_STATE_HOME", &self.state_home)
            .env("XDG_CACHE_HOME", &self.cache_home)
            .env(
                "CODEX_LINUX_SETTINGS_FILE",
                self.root.join("missing-settings.json"),
            )
            .env("CODEX_CLI_PATH", &self.cli_path)
            .env(
                "PATH",
                format!(
                    "{}:/usr/bin:/bin",
                    self.cli_path
                        .parent()
                        .expect("CLI path should have a parent")
                        .display()
                ),
            )
            .env("NPM_ACTIVE_PACKAGE", &self.active_package)
            .env("NPM_RETIREMENT_PATH", &self.stale_directory)
            .env("NPM_LATEST_VERSION", &self.latest_version)
            .env("NPM_INSTALL_MODE", &self.install_mode)
            .env("NPM_INSTALL_LOG", &self.install_log)
            .env("NPM_MANAGED_CLI", &self.cli_path)
            .env("NPM_INSTALL_STARTED", &self.install_started)
            .env("NPM_INSTALL_RELEASE", &self.install_release)
            .env("NPM_INSTALL_OVERLAP", &self.install_overlap)
            .env("NPM_INSTALL_OWNER", &self.install_owner)
            .env(
                "NPM_BACKGROUND_PROCESS_GROUP",
                &self.background_process_group,
            )
            .env("NPM_SUPERVISOR_PID", &self.npm_supervisor_pid)
            .env("NPM_VIEW_STARTED", &self.view_started)
            .env("NPM_VIEW_RELEASE", &self.view_release)
            .env_remove("FNM_DIR")
            .env_remove("FNM_MULTISHELL_PATH")
            .env_remove("HOMEBREW_PREFIX")
            .env_remove("NVM_DIR")
            .env_remove("XDG_DATA_HOME")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        command
    }

    fn state_path(&self) -> PathBuf {
        self.state_home.join("codex-update-manager/state.json")
    }

    fn log_path(&self) -> PathBuf {
        self.state_home.join("codex-update-manager/service.log")
    }

    fn update_state(&self, update: impl FnOnce(&mut Value)) -> Result<()> {
        let path = self.state_path();
        let mut state: Value = serde_json::from_slice(&fs::read(&path)?)?;
        update(&mut state);
        fs::write(path, serde_json::to_vec_pretty(&state)?)?;
        Ok(())
    }

    fn state(&self) -> Result<Value> {
        Ok(serde_json::from_slice(&fs::read(self.state_path())?)?)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        if let Ok(process_group) = fs::read_to_string(&self.background_process_group) {
            if let Ok(process_group) = process_group.trim().parse::<i32>() {
                unsafe {
                    libc::kill(-process_group, libc::SIGKILL);
                }
            }
        }
        let pid_path = self.install_owner.join("pid");
        let Ok(pid) = fs::read_to_string(pid_path) else {
            return;
        };
        let Ok(pid) = pid.trim().parse::<i32>() else {
            return;
        };
        unsafe {
            libc::kill(-pid, libc::SIGKILL);
            libc::kill(pid, libc::SIGKILL);
        }
    }
}

struct ManagedChild {
    child: Option<Child>,
    name: &'static str,
}

impl ManagedChild {
    fn spawn(mut command: Command, name: &'static str) -> Result<Self> {
        let child = command
            .spawn()
            .with_context(|| format!("failed to spawn {name}"))?;
        Ok(Self {
            child: Some(child),
            name,
        })
    }

    fn assert_running(&mut self) -> Result<()> {
        anyhow::ensure!(
            self.child
                .as_mut()
                .context("child already consumed")?
                .try_wait()?
                .is_none(),
            "{} exited before the install lock was released",
            self.name
        );
        Ok(())
    }

    fn pid(&self) -> Result<u32> {
        Ok(self.child.as_ref().context("child already consumed")?.id())
    }

    fn kill_parent_only(&mut self) -> Result<()> {
        let child = self.child.as_mut().context("child already consumed")?;
        child.kill()?;
        child.wait()?;
        self.child.take();
        Ok(())
    }

    fn wait(mut self) -> Result<Output> {
        let deadline = Instant::now() + WAIT_TIMEOUT;
        loop {
            if self
                .child
                .as_mut()
                .context("child already consumed")?
                .try_wait()?
                .is_some()
            {
                let child = self.child.take().context("child already consumed")?;
                return child.wait_with_output().map_err(Into::into);
            }
            anyhow::ensure!(
                Instant::now() < deadline,
                "{} did not exit before the timeout",
                self.name
            );
            thread::sleep(Duration::from_millis(20));
        }
    }

    fn terminate(&mut self) -> Result<()> {
        let Some(child) = self.child.as_mut() else {
            return Ok(());
        };
        child.kill()?;
        child.wait()?;
        self.child.take();
        Ok(())
    }
}

impl Drop for ManagedChild {
    fn drop(&mut self) {
        if let Some(child) = self.child.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[test]
fn actual_cli_preflight_status_and_daemon_share_the_npm_install_lock() -> Result<()> {
    let fixture = Fixture::new()?;

    let mut preflight_command = fixture.command();
    preflight_command
        .args(["cli-preflight", "--cli-path"])
        .arg(&fixture.cli_path);
    let mut preflight = ManagedChild::spawn(preflight_command, "cli-preflight")?;
    wait_for_path(&fixture.install_started, "first npm install")?;

    fixture.update_state(expire_cli_registry_check)?;
    let mut status_command = fixture.command();
    status_command.args(["status", "--json"]);
    let mut status = ManagedChild::spawn(status_command, "status")?;
    wait_for_text(
        &fixture.log_path(),
        &format!("process {} is waiting", status.pid()?),
        "status install-lock wait",
    )?;
    status.assert_running()?;

    fixture.update_state(expire_cli_registry_check)?;
    let mut daemon_command = fixture.command();
    daemon_command.arg("daemon");
    let mut daemon = ManagedChild::spawn(daemon_command, "daemon")?;

    wait_for_text(
        &fixture.log_path(),
        &format!("process {} is waiting", daemon.pid()?),
        "daemon install-lock wait",
    )?;
    preflight.assert_running()?;
    status.assert_running()?;
    daemon.assert_running()?;
    assert_eq!(install_count(&fixture.install_log)?, 1);
    assert!(!fixture.install_overlap.exists());

    fs::write(&fixture.install_release, b"continue")?;
    ensure_success("cli-preflight", &preflight.wait()?)?;
    ensure_success("status", &status.wait()?)?;
    wait_for_state(&fixture, |state| {
        state["cli_status"] == "update_required" && state["cli_installed_version"] == "0.42.0"
    })?;
    daemon.terminate()?;

    assert_eq!(install_count(&fixture.install_log)?, 1);
    assert!(!fixture.install_overlap.exists());
    assert!(fixture.stale_directory.exists());
    assert!(fixture
        .state_home
        .join("codex-update-manager/cli-repair.json")
        .exists());
    let state = fixture.state()?;
    assert_eq!(state["remote_headers_fingerprint"], "must-survive-cli-race");
    assert_eq!(state["cli_status"], "update_required");
    assert_eq!(state["cli_installed_version"], "0.42.0");
    assert!(state["cli_error_message"]
        .as_str()
        .is_some_and(|message| message.contains("codex-update-manager diagnose")));
    Ok(())
}

#[test]
fn late_registry_failure_cannot_overwrite_a_completed_repair() -> Result<()> {
    let fixture = Fixture::new()?;

    let mut status_command = fixture.command();
    status_command
        .args(["status", "--json"])
        .env("NPM_VIEW_MODE", "delayed-failure");
    let status = ManagedChild::spawn(status_command, "delayed status")?;
    wait_for_path(&fixture.view_started, "delayed npm registry lookup")?;

    fixture.update_state(expire_cli_registry_check)?;
    fs::write(&fixture.install_release, b"continue")?;
    let mut preflight_command = fixture.command();
    preflight_command
        .args(["cli-preflight", "--cli-path"])
        .arg(&fixture.cli_path);
    ensure_success(
        "stale-detecting cli-preflight",
        &preflight_command.output()?,
    )?;
    wait_for_state(&fixture, |state| {
        state["cli_status"] == "update_required"
            && state["cli_error_message"]
                .as_str()
                .is_some_and(|message| message.contains("codex-update-manager diagnose"))
    })?;

    fs::write(&fixture.install_mode, b"success\n")?;
    let mut repair_command = fixture.command();
    repair_command.arg("repair-cli");
    ensure_success("explicit repair", &repair_command.output()?)?;
    wait_for_state(&fixture, |state| {
        state["cli_status"] == "up_to_date" && state["cli_installed_version"] == "0.42.1"
    })?;
    assert!(!fixture
        .state_home
        .join("codex-update-manager/cli-repair.json")
        .exists());

    fs::write(&fixture.view_release, b"continue")?;
    ensure_success("delayed status", &status.wait()?)?;

    let state = fixture.state()?;
    assert_eq!(state["cli_status"], "up_to_date");
    assert_eq!(state["cli_installed_version"], "0.42.1");
    assert!(state["cli_error_message"].is_null());
    assert!(!fixture
        .state_home
        .join("codex-update-manager/cli-repair.json")
        .exists());
    assert_eq!(install_count(&fixture.install_log)?, 2);
    Ok(())
}

#[test]
fn orphaned_npm_process_group_is_bounded_and_releases_the_install_lock() -> Result<()> {
    let fixture = Fixture::new()?;

    let mut preflight_command = fixture.command();
    preflight_command
        .args(["cli-preflight", "--cli-path"])
        .arg(&fixture.cli_path);
    let mut preflight = ManagedChild::spawn(preflight_command, "cli-preflight")?;
    wait_for_path(&fixture.install_started, "first npm install")?;
    let orphan_process_group =
        wait_for_nonempty_file(&fixture.npm_supervisor_pid, "npm supervisor pid")?
            .trim()
            .parse::<i32>()?;
    preflight.kill_parent_only()?;
    wait_for_process_group_exit(orphan_process_group, "orphaned npm install")?;
    fs::remove_file(&fixture.install_started)?;

    fixture.update_state(expire_cli_registry_check)?;
    let mut status_command = fixture.command();
    status_command.args(["status", "--json"]);
    let mut status = ManagedChild::spawn(status_command, "status")?;
    wait_for_path(&fixture.install_started, "replacement npm install")?;
    status.assert_running()?;
    assert_eq!(install_count(&fixture.install_log)?, 2);
    assert!(!fixture.install_overlap.exists());

    fs::write(&fixture.install_release, b"continue")?;
    ensure_success("status", &status.wait()?)?;

    assert!(!fixture.install_overlap.exists());
    Ok(())
}

#[test]
fn completed_npm_leader_cleans_background_group_and_releases_the_install_lock() -> Result<()> {
    let fixture = Fixture::new()?;
    fs::write(&fixture.install_mode, b"background-descendant\n")?;

    let mut first_status_command = fixture.command();
    first_status_command.args(["status", "--json"]);
    let first_status = ManagedChild::spawn(first_status_command, "first status")?;
    wait_for_path(
        &fixture.background_process_group,
        "background npm process group",
    )?;
    let background_process_group = wait_for_nonempty_file(
        &fixture.background_process_group,
        "background npm process group value",
    )?
    .trim()
    .parse::<i32>()?;
    let first_output = first_status.wait()?;
    assert!(!first_output.status.success());
    assert!(String::from_utf8_lossy(&first_output.stderr)
        .contains("npm completed but managed Codex CLI 0.42.1 could not be resolved"));
    wait_for_process_group_exit(background_process_group, "background npm descendant")?;
    fs::remove_file(&fixture.background_process_group)?;

    fs::remove_file(&fixture.install_started)?;
    fixture.update_state(expire_cli_registry_check)?;
    fs::write(&fixture.install_mode, b"success\n")?;
    let mut replacement_status_command = fixture.command();
    replacement_status_command.args(["status", "--json"]);
    let mut replacement_status =
        ManagedChild::spawn(replacement_status_command, "replacement status")?;
    wait_for_path(&fixture.install_started, "replacement npm install")?;
    replacement_status.assert_running()?;
    assert_eq!(install_count(&fixture.install_log)?, 2);
    assert!(!fixture.install_overlap.exists());

    fs::write(&fixture.install_release, b"continue")?;
    ensure_success("replacement status", &replacement_status.wait()?)?;

    assert!(!fixture.install_overlap.exists());
    Ok(())
}

#[test]
fn killed_npm_supervisor_cleans_descendants_before_lock_release() -> Result<()> {
    let fixture = Fixture::new()?;
    fs::write(&fixture.install_mode, b"background-descendant-hang\n")?;

    let mut preflight_command = fixture.command();
    preflight_command
        .args(["cli-preflight", "--cli-path"])
        .arg(&fixture.cli_path);
    let preflight = ManagedChild::spawn(preflight_command, "cli-preflight")?;
    wait_for_path(&fixture.install_started, "first npm install")?;
    wait_for_path(
        &fixture.background_process_group,
        "background npm process group",
    )?;
    wait_for_path(&fixture.npm_supervisor_pid, "npm supervisor pid")?;

    let background_process_group = wait_for_nonempty_file(
        &fixture.background_process_group,
        "background npm process group value",
    )?
    .trim()
    .parse::<i32>()?;
    let supervisor_pid =
        wait_for_nonempty_file(&fixture.npm_supervisor_pid, "npm supervisor pid value")?
            .trim()
            .parse::<i32>()?;
    anyhow::ensure!(
        Command::new("/bin/kill")
            .args(["-0", "--", &format!("-{background_process_group}")])
            .status()?
            .success(),
        "overlap oracle did not recognize live npm group {background_process_group}"
    );
    anyhow::ensure!(
        unsafe { libc::kill(supervisor_pid, libc::SIGKILL) } == 0,
        "failed to kill npm supervisor {supervisor_pid}"
    );

    fs::remove_file(&fixture.install_started)?;
    fixture.update_state(expire_cli_registry_check)?;
    fs::write(&fixture.install_mode, b"success\n")?;
    let mut status_command = fixture.command();
    status_command.args(["status", "--json"]);
    let status = ManagedChild::spawn(status_command, "status")?;

    wait_for_process_group_exit(background_process_group, "npm group after supervisor death")?;
    fs::remove_file(&fixture.background_process_group)?;
    let first = preflight.wait()?;
    anyhow::ensure!(
        !first.status.success(),
        "cli-preflight unexpectedly succeeded after its npm supervisor was killed"
    );
    wait_for_path(&fixture.install_started, "replacement npm install")?;
    assert_eq!(install_count(&fixture.install_log)?, 2);
    assert!(!fixture.install_overlap.exists());

    fs::write(&fixture.install_release, b"continue")?;
    ensure_success("status", &status.wait()?)?;
    assert!(!fixture.install_overlap.exists());
    Ok(())
}

fn cli_script(version: &str) -> String {
    format!("#!/bin/sh\necho 'codex-cli v{version}'\n")
}

fn expire_cli_registry_check(state: &mut Value) {
    state["cli_last_check_at"] = Value::Null;
    state["cli_official_latest_version"] = Value::Null;
}

fn write_executable(path: &Path, contents: &str) -> Result<()> {
    fs::write(path, contents)?;
    let mut permissions = fs::metadata(path)?.permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(path, permissions)?;
    Ok(())
}

fn secure_directory_tree(path: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Ok(());
    }
    fs::set_permissions(path, fs::Permissions::from_mode(0o755))?;
    for entry in fs::read_dir(path)? {
        secure_directory_tree(&entry?.path())?;
    }
    Ok(())
}

fn toml_path(path: &Path) -> String {
    path.display()
        .to_string()
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
}

fn wait_for_path(path: &Path, description: &str) -> Result<()> {
    let deadline = Instant::now() + WAIT_TIMEOUT;
    while !path.exists() {
        anyhow::ensure!(
            Instant::now() < deadline,
            "timed out waiting for {description}: {}",
            path.display()
        );
        thread::sleep(Duration::from_millis(20));
    }
    Ok(())
}

fn wait_for_nonempty_file(path: &Path, description: &str) -> Result<String> {
    let deadline = Instant::now() + WAIT_TIMEOUT;
    loop {
        if let Ok(value) = fs::read_to_string(path) {
            if !value.trim().is_empty() {
                return Ok(value);
            }
        }
        anyhow::ensure!(
            Instant::now() < deadline,
            "timed out waiting for {description} at {}",
            path.display()
        );
        thread::sleep(Duration::from_millis(20));
    }
}

fn wait_for_process_group_exit(process_group: i32, description: &str) -> Result<()> {
    let deadline = Instant::now() + WAIT_TIMEOUT;
    loop {
        let exists = unsafe { libc::kill(-process_group, 0) } == 0;
        if !exists {
            return Ok(());
        }
        anyhow::ensure!(
            Instant::now() < deadline,
            "timed out waiting for {description} process group {process_group} to exit"
        );
        thread::sleep(Duration::from_millis(20));
    }
}

fn wait_for_state(fixture: &Fixture, predicate: impl Fn(&Value) -> bool) -> Result<()> {
    let deadline = Instant::now() + WAIT_TIMEOUT;
    loop {
        if fixture.state().is_ok_and(|state| predicate(&state)) {
            return Ok(());
        }
        anyhow::ensure!(
            Instant::now() < deadline,
            "timed out waiting for persisted CLI state"
        );
        thread::sleep(Duration::from_millis(20));
    }
}

fn wait_for_text(path: &Path, needle: &str, description: &str) -> Result<()> {
    let deadline = Instant::now() + WAIT_TIMEOUT;
    loop {
        if fs::read_to_string(path).is_ok_and(|contents| contents.contains(needle)) {
            return Ok(());
        }
        anyhow::ensure!(
            Instant::now() < deadline,
            "timed out waiting for {description}: {}",
            path.display()
        );
        thread::sleep(Duration::from_millis(20));
    }
}

fn install_count(path: &Path) -> Result<usize> {
    Ok(fs::read_to_string(path)?.lines().count())
}

fn ensure_success(name: &str, output: &Output) -> Result<()> {
    anyhow::ensure!(
        output.status.success(),
        "{name} failed with {}: stdout={} stderr={}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(())
}
