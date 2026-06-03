//! Wrapper-repo update detection.
//!
//! Beyond tracking the upstream Codex DMG, the updater can detect when the
//! *wrapper* itself (this repository — new Linux features, patches, fixes) has
//! advanced. Detection is git-based and leaves the user's working tree and
//! current branch untouched: it inspects the builder bundle checkout, queries
//! the remote head with `git ls-remote`, and may fetch candidate objects into
//! the local object store / `FETCH_HEAD` so ancestry and changelog data can be
//! read. The actual rebuild reuses the existing DMG rebuild path against the
//! refreshed checkout.
//!
//! When the builder bundle is a frozen packaged copy (no `.git`), the wrapper
//! axis degrades gracefully: detection reports "not a git checkout" and the
//! caller leaves wrapper updates to a normal package upgrade.

use anyhow::Result;
use serde_json::Value;
use std::{
    io::Read,
    os::unix::process::CommandExt,
    path::{Path, PathBuf},
    process::{Command, ExitStatus, Output, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

use crate::changelog;

const GIT_COMMAND_TIMEOUT: Duration = Duration::from_secs(20);
const GIT_POLL_INTERVAL: Duration = Duration::from_millis(50);
const GIT_STDOUT_DRAIN_TIMEOUT: Duration = Duration::from_secs(1);
const SIGKILL: i32 = 9;

unsafe extern "C" {
    fn kill(pid: i32, sig: i32) -> i32;
}

/// Identity of a wrapper checkout: its current commit and best-effort version.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WrapperVersion {
    /// Full commit SHA of the checkout's `HEAD`.
    pub commit: String,
    /// Semver read from `updater/Cargo.toml`, when available.
    pub version: Option<String>,
}

/// Result of comparing the local checkout against the remote head.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WrapperUpdate {
    pub installed_commit: String,
    pub installed_version: Option<String>,
    pub candidate_commit: String,
    pub candidate_version: Option<String>,
    /// Curated CHANGELOG sections newer than installed, or a git commit-subject
    /// list when the changelog can't be mapped.
    pub changelog: String,
}

/// Outcome of comparing the installed wrapper build against the tracked remote.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WrapperDetectionState {
    /// Installed commit matches the tracked head.
    Aligned,
    /// A genuinely newer tracked commit is available.
    UpdateAvailable,
    /// Installed build appears to be local/ahead; applying would downgrade it.
    DevMode,
    /// Detection could not reach or inspect the remote state.
    UnknownOffline,
}

fn guarded_git_ssh_command() -> String {
    let base = std::env::var("GIT_SSH_COMMAND")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "ssh".to_string());
    format!("{base} -oBatchMode=yes -oStrictHostKeyChecking=yes")
}

fn git_command(repo: &Path, args: &[&str]) -> Command {
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(repo)
        .args(args)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", "true")
        .env("SSH_ASKPASS", "true")
        .env("GCM_INTERACTIVE", "never")
        .env("GIT_SSH_COMMAND", guarded_git_ssh_command());
    command.process_group(0);
    command
}

fn kill_child_process_group(child: &mut std::process::Child) {
    let pgid = child.id() as i32;
    // `git_command` starts git in its own process group so stalled ssh/http
    // helpers do not survive a timeout.
    // SAFETY: `kill` is called with a negative process-group id derived from
    // the child process we just spawned into its own group, and SIGKILL has no
    // Rust-side aliasing or memory-safety preconditions.
    unsafe {
        let _ = kill(-pgid, SIGKILL);
    }
    let _ = child.kill();
}

fn run_git(repo: &Path, args: &[&str]) -> Option<Output> {
    let mut command = git_command(repo, args);
    command.stdout(Stdio::piped());
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(_) => return None,
    };
    let mut stdout = child.stdout.take()?;
    let (stdout_tx, stdout_rx) = mpsc::channel();
    thread::spawn(move || {
        let mut buffer = Vec::new();
        let _ = stdout_tx.send(stdout.read_to_end(&mut buffer).map(|_| buffer).ok());
    });
    let started = Instant::now();
    loop {
        if let Some(status) = child.try_wait().ok()? {
            let stdout = stdout_rx
                .recv_timeout(GIT_STDOUT_DRAIN_TIMEOUT)
                .ok()
                .flatten()
                .unwrap_or_default();
            return Some(Output {
                status,
                stdout,
                stderr: Vec::new(),
            });
        }
        if started.elapsed() >= GIT_COMMAND_TIMEOUT {
            kill_child_process_group(&mut child);
            let _ = child.wait();
            let _ = stdout_rx.recv_timeout(GIT_STDOUT_DRAIN_TIMEOUT);
            return None;
        }
        thread::sleep(GIT_POLL_INTERVAL);
    }
}

fn git_status(repo: &Path, args: &[&str]) -> Option<ExitStatus> {
    run_git(repo, args).map(|output| output.status)
}

/// Runs a bounded, non-interactive, read-only git command in `repo`, returning
/// trimmed stdout on success.
fn git_capture(repo: &Path, args: &[&str]) -> Option<String> {
    let output = run_git(repo, args)?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

/// True when `repo` is a git working tree.
pub fn is_git_checkout(repo: &Path) -> bool {
    git_capture(repo, &["rev-parse", "--is-inside-work-tree"])
        .map(|value| value == "true")
        .unwrap_or(false)
}

/// Reads the `version = "x.y.z"` value from Cargo.toml content.
fn parse_wrapper_version(content: &str) -> Option<String> {
    for line in content.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("version") {
            let rest = rest.trim_start();
            if let Some(rest) = rest.strip_prefix('=') {
                let value = rest.trim().trim_matches('"');
                if !value.is_empty() {
                    return Some(value.to_string());
                }
            }
        }
    }
    None
}

/// Reads the `version = "x.y.z"` value from `updater/Cargo.toml` in the
/// checkout. Best-effort: returns `None` when the file or field is missing.
#[cfg(test)]
fn read_wrapper_version(repo: &Path) -> Option<String> {
    let cargo_toml = repo.join("updater").join("Cargo.toml");
    let content = std::fs::read_to_string(cargo_toml).ok()?;
    parse_wrapper_version(&content)
}

fn metadata_source(value: &Value) -> Option<&Value> {
    value
        .get("source")
        .filter(|source| source.is_object())
        .or_else(|| if value.is_object() { Some(value) } else { None })
}

fn string_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key)?.as_str()?.trim().split('\0').next()
}

fn wrapper_version_from_metadata_file(path: &Path) -> Option<WrapperVersion> {
    let content = std::fs::read_to_string(path).ok()?;
    let value = serde_json::from_str::<Value>(&content).ok()?;
    let source = metadata_source(&value)?;
    let commit = string_field(source, "commit")?;
    if commit.is_empty() {
        return None;
    }
    let version = string_field(source, "version")
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    Some(WrapperVersion {
        commit: commit.to_string(),
        version,
    })
}

fn app_root_from_executable(app_executable_path: &Path) -> Option<PathBuf> {
    app_executable_path.parent().map(Path::to_path_buf)
}

fn installed_metadata_paths(
    app_executable_path: &Path,
    builder_bundle_root: &Path,
) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(app_root) = app_root_from_executable(app_executable_path) {
        paths.push(app_root.join(".codex-linux/build-info.json"));
        paths.push(app_root.join("resources/codex-linux-build-info.json"));
        paths.push(app_root.join(".codex-linux/source-info.json"));
    }
    paths.push(builder_bundle_root.join(".codex-linux/source-info.json"));
    paths
}

/// Resolves the installed wrapper identity from installed app metadata. This
/// intentionally avoids using the builder checkout's current `HEAD`, because a
/// dev/local builder may have moved since the installed app was produced.
pub fn installed_wrapper_from_metadata(
    app_executable_path: &Path,
    builder_bundle_root: &Path,
) -> Option<WrapperVersion> {
    installed_metadata_paths(app_executable_path, builder_bundle_root)
        .into_iter()
        .find_map(|path| wrapper_version_from_metadata_file(&path))
}

/// Reads the wrapper version from `updater/Cargo.toml` at a specific commit.
fn read_wrapper_version_at_commit(repo: &Path, commit: &str) -> Option<String> {
    let content = git_capture(repo, &["show", &format!("{commit}:updater/Cargo.toml")])?;
    parse_wrapper_version(&content)
}

/// Resolves the installed wrapper identity from a checkout.
#[cfg(test)]
pub fn installed_wrapper(repo: &Path) -> Option<WrapperVersion> {
    let commit = git_capture(repo, &["rev-parse", "HEAD"])?;
    Some(WrapperVersion {
        commit,
        version: read_wrapper_version(repo),
    })
}

/// Resolves the wrapper repo origin URL from the checkout.
fn origin_url(repo: &Path) -> Option<String> {
    git_capture(repo, &["remote", "get-url", "origin"])
}

/// Resolves the configured wrapper remote into either an explicit URL/name or
/// the builder checkout's origin URL.
pub fn resolve_remote(config_remote: &str, bundle_root: &Path) -> String {
    let trimmed = config_remote.trim();
    if !trimmed.is_empty() {
        return trimmed.to_string();
    }
    origin_url(bundle_root).unwrap_or_else(|| "origin".to_string())
}

/// Queries the remote head commit for `branch` via `git ls-remote`.
///
/// `remote` may be a configured remote name (`origin`) or an explicit URL. When
/// no remote is configured this falls back to the checkout's origin URL.
pub fn fetch_remote_head(repo: &Path, remote: &str, branch: &str) -> Option<String> {
    let resolved_remote = if remote.is_empty() {
        origin_url(repo)?
    } else {
        remote.to_string()
    };
    let output = git_capture(repo, &["ls-remote", &resolved_remote, branch])?;
    // ls-remote prints "<sha>\t<ref>"; take the first whitespace-delimited field.
    output
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().next())
        .map(str::to_string)
}

/// Fetches the candidate branch into the local object store WITHOUT touching
/// the working tree or current branch. This makes the candidate commit and its
/// `CHANGELOG.md` blob available to `git show` / `git log`. Read-only with
/// respect to the user's checked-out files.
fn fetch_objects(repo: &Path, remote: &str, branch: &str) -> bool {
    let resolved_remote = if remote.is_empty() {
        match origin_url(repo) {
            Some(url) => url,
            None => return false,
        }
    } else {
        remote.to_string()
    };
    // `git fetch <remote> <branch>` updates FETCH_HEAD and objects only.
    git_status(repo, &["fetch", "--quiet", &resolved_remote, branch])
        .is_some_and(|status| status.success())
}

/// True when `ancestor` is reachable from `descendant`.
fn commit_is_ancestor(repo: &Path, ancestor: &str, descendant: &str) -> Option<bool> {
    let status = git_status(repo, &["merge-base", "--is-ancestor", ancestor, descendant])?;

    if status.success() {
        Some(true)
    } else if status.code() == Some(1) {
        Some(false)
    } else {
        None
    }
}

/// Reads `CHANGELOG.md` at a specific commit from the object store (the
/// candidate's changelog, which reflects the new version's entries).
fn changelog_at_commit(repo: &Path, commit: &str) -> Option<String> {
    git_capture(repo, &["show", &format!("{commit}:CHANGELOG.md")])
}

/// Builds the "what changed" text for an update. Prefers curated CHANGELOG.md
/// sections (from the candidate commit) newer than `installed_version`; falls
/// back to `git log --oneline installed..candidate` commit subjects when the
/// changelog can't be mapped.
fn build_changelog(
    repo: &Path,
    installed_version: Option<&str>,
    installed_commit: &str,
    candidate_commit: &str,
) -> String {
    if let (Some(version), Some(markdown)) = (
        installed_version,
        changelog_at_commit(repo, candidate_commit),
    ) {
        let sections = changelog::parse_changelog(&markdown);
        if let Some(text) = changelog::sections_newer_than(&sections, version) {
            return text;
        }
    }

    // Fallback: raw commit subjects between the two commits.
    let range = format!("{installed_commit}..{candidate_commit}");
    if let Some(log) = git_capture(repo, &["log", "--oneline", "--no-decorate", &range]) {
        if !log.is_empty() {
            return log;
        }
    }

    "Wrapper updated (no changelog details available).".to_string()
}

/// Detects whether the wrapper repo at `repo` has a newer head than the local
/// checkout. Returns `Ok(None)` when up to date, when `repo` is not a git
/// checkout (packaged frozen bundle), or when the remote can't be reached.
/// Never mutates the working tree.
#[cfg(test)]
pub fn detect_wrapper_update(
    repo: &Path,
    remote: &str,
    branch: &str,
) -> Result<Option<WrapperUpdate>> {
    if !is_git_checkout(repo) {
        return Ok(None);
    }

    let Some(installed) = installed_wrapper(repo) else {
        return Ok(None);
    };
    detect_wrapper_update_for_installed(repo, &installed, remote, branch)
}

#[cfg(test)]
pub fn detect_wrapper_update_for_installed(
    repo: &Path,
    installed: &WrapperVersion,
    remote: &str,
    branch: &str,
) -> Result<Option<WrapperUpdate>> {
    let (_state, update) =
        detect_wrapper_update_state_for_installed(repo, installed, remote, branch)?;
    Ok(update)
}

pub fn detect_wrapper_update_state_for_installed(
    repo: &Path,
    installed: &WrapperVersion,
    remote: &str,
    branch: &str,
) -> Result<(WrapperDetectionState, Option<WrapperUpdate>)> {
    use WrapperDetectionState::*;

    if installed.commit.trim().is_empty() {
        return Ok((UnknownOffline, None));
    }

    if !is_git_checkout(repo) {
        return Ok((UnknownOffline, None));
    }

    let Some(candidate_commit) = fetch_remote_head(repo, remote, branch) else {
        return Ok((UnknownOffline, None));
    };

    if candidate_commit == installed.commit {
        return Ok((Aligned, None));
    }

    // Bring the candidate commit + metadata blobs into the local object store
    // so ancestry, version, and changelog can be read. Does not touch the
    // working tree, but it may update FETCH_HEAD and the local object store.
    if !fetch_objects(repo, remote, branch) {
        return Ok((UnknownOffline, None));
    }

    match commit_is_ancestor(repo, &installed.commit, &candidate_commit) {
        Some(true) => {}
        Some(false) | None => return Ok((DevMode, None)),
    }

    let installed_version = installed
        .version
        .clone()
        .or_else(|| read_wrapper_version_at_commit(repo, &installed.commit));
    let changelog = build_changelog(
        repo,
        installed_version.as_deref(),
        &installed.commit,
        &candidate_commit,
    );
    let candidate_version = read_wrapper_version_at_commit(repo, &candidate_commit);

    Ok((
        UpdateAvailable,
        Some(WrapperUpdate {
            installed_commit: installed.commit.clone(),
            installed_version,
            candidate_commit,
            candidate_version,
            changelog,
        }),
    ))
}

/// Convenience for callers that hold a `builder_bundle_root` path.
#[cfg(test)]
pub fn detect_from_bundle_root(
    bundle_root: &Path,
    installed: &WrapperVersion,
    remote: &str,
    branch: &str,
) -> Result<Option<WrapperUpdate>> {
    detect_wrapper_update_for_installed(bundle_root, installed, remote, branch)
}

/// Convenience for callers that need the explicit detection state.
pub fn detect_state_from_bundle_root(
    bundle_root: &Path,
    installed: &WrapperVersion,
    remote: &str,
    branch: &str,
) -> Result<(WrapperDetectionState, Option<WrapperUpdate>)> {
    detect_wrapper_update_state_for_installed(bundle_root, installed, remote, branch)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    use tempfile::tempdir;

    use crate::test_util::env_lock;
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;

    // Resolve git to an absolute path so these tests don't depend on $PATH,
    // which other tests in the binary mutate concurrently.
    fn git_bin() -> PathBuf {
        if let Some(explicit) = std::env::var_os("GIT") {
            return PathBuf::from(explicit);
        }
        for candidate in ["/usr/bin/git", "/bin/git", "/usr/local/bin/git"] {
            if Path::new(candidate).exists() {
                return PathBuf::from(candidate);
            }
        }
        PathBuf::from("git")
    }

    fn git(repo: &Path, args: &[&str]) {
        let output = Command::new(git_bin())
            .arg("-C")
            .arg(repo)
            .args(args)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@example.com")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@example.com")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_SYSTEM", "/dev/null")
            .output()
            .expect("spawn git");
        assert!(
            output.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn git_clone(origin: &Path, dest: &Path) {
        let status = Command::new(git_bin())
            .args(["clone", "-q"])
            .arg(origin)
            .arg(dest)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_SYSTEM", "/dev/null")
            .output()
            .expect("git clone");
        assert!(status.status.success(), "git clone failed");
    }

    fn init_repo(dir: &Path) {
        git(dir, &["init", "-q", "-b", "main"]);
        std::fs::create_dir_all(dir.join("updater")).unwrap();
        std::fs::write(
            dir.join("updater/Cargo.toml"),
            "[package]\nname = \"codex-update-manager\"\nversion = \"0.8.1\"\n",
        )
        .unwrap();
        std::fs::write(dir.join("CHANGELOG.md"), "# Changelog\n").unwrap();
        git(dir, &["add", "-A"]);
        git(dir, &["commit", "-q", "-m", "init"]);
    }

    #[test]
    fn non_git_dir_reports_no_update() {
        let temp = tempdir().unwrap();
        assert!(!is_git_checkout(temp.path()));
        assert_eq!(
            detect_wrapper_update(temp.path(), "origin", "main").unwrap(),
            None
        );
    }

    #[test]
    fn completed_git_does_not_block_on_escaped_stdout_holder() {
        let _g = env_lock();
        let temp = tempdir().unwrap();
        let bin_dir = temp.path().join("bin");
        std::fs::create_dir_all(&bin_dir).unwrap();
        let fake_git = bin_dir.join("git");
        std::fs::write(
            &fake_git,
            r#"#!/bin/sh
pidfile="$0.pid"
setsid sh -c 'echo "$$" > "$1"; sleep 60' sh "$pidfile" &
while [ ! -s "$pidfile" ]; do
  sleep 0.05
done
exit 0
"#,
        )
        .unwrap();
        let mut permissions = std::fs::metadata(&fake_git).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&fake_git, permissions).unwrap();

        let old_path = std::env::var_os("PATH");
        let mut path_entries = vec![bin_dir];
        if let Some(path) = old_path.as_ref() {
            path_entries.extend(std::env::split_paths(path));
        }
        std::env::set_var("PATH", std::env::join_paths(path_entries).unwrap());
        let started = Instant::now();
        let output = run_git(temp.path(), &["rev-parse", "HEAD"]);
        if let Some(path) = old_path {
            std::env::set_var("PATH", path);
        } else {
            std::env::remove_var("PATH");
        }

        if let Ok(pid_text) = std::fs::read_to_string(fake_git.with_file_name("git.pid")) {
            if let Ok(pid) = pid_text.trim().parse::<i32>() {
                // SAFETY: the pid was written by the test child started in a new
                // session/process group. Killing that process group cleans up the
                // escaped stdout holder the test intentionally creates.
                unsafe {
                    let _ = kill(-pid, SIGKILL);
                }
            }
        }

        assert!(output.is_some_and(|output| output.status.success()));
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "run_git waited too long for an escaped stdout holder"
        );
    }

    #[test]
    fn reads_installed_commit_and_version() {
        let _g = env_lock();
        let temp = tempdir().unwrap();
        init_repo(temp.path());
        let installed = installed_wrapper(temp.path()).expect("installed");
        assert_eq!(installed.version.as_deref(), Some("0.8.1"));
        assert_eq!(installed.commit.len(), 40);
    }

    #[test]
    fn detects_newer_head_against_local_remote() {
        let _g = env_lock();
        // origin repo
        let origin = tempdir().unwrap();
        init_repo(origin.path());

        // clone it
        let clone = tempdir().unwrap();
        let clone_path = clone.path().join("checkout");
        git_clone(origin.path(), &clone_path);

        // advance origin with a changelog bump
        std::fs::write(
            origin.path().join("updater/Cargo.toml"),
            "[package]\nname = \"codex-update-manager\"\nversion = \"0.9.0\"\n",
        )
        .unwrap();
        std::fs::write(
            origin.path().join("CHANGELOG.md"),
            "# Changelog\n\n## [0.9.0] - 2026-06-01\n\n### Added\n\n- New wrapper feature.\n",
        )
        .unwrap();
        git(origin.path(), &["add", "-A"]);
        git(origin.path(), &["commit", "-q", "-m", "bump"]);

        // clone still on old head; detect should find the new origin head
        let update = detect_wrapper_update(&clone_path, "origin", "main")
            .unwrap()
            .expect("update detected");
        assert_ne!(update.installed_commit, update.candidate_commit);
        assert_eq!(update.installed_version.as_deref(), Some("0.8.1"));
        assert_eq!(update.candidate_version.as_deref(), Some("0.9.0"));
        let installed = installed_wrapper(&clone_path).expect("installed");
        let (state, state_update) =
            detect_wrapper_update_state_for_installed(&clone_path, &installed, "origin", "main")
                .unwrap();
        assert_eq!(state, WrapperDetectionState::UpdateAvailable);
        assert_eq!(
            state_update.expect("state update").candidate_commit,
            update.candidate_commit
        );
        // The candidate commit's CHANGELOG has a [0.9.0] section, newer than the
        // installed 0.8.1, so the curated changelog is surfaced.
        assert!(
            update.changelog.contains("New wrapper feature."),
            "changelog was: {}",
            update.changelog
        );
    }

    #[test]
    fn up_to_date_clone_reports_no_update() {
        let _g = env_lock();
        let origin = tempdir().unwrap();
        init_repo(origin.path());
        let clone = tempdir().unwrap();
        let clone_path = clone.path().join("checkout");
        git_clone(origin.path(), &clone_path);
        let installed = installed_wrapper(&clone_path).expect("installed");
        let (state, update) =
            detect_wrapper_update_state_for_installed(&clone_path, &installed, "origin", "main")
                .unwrap();
        assert_eq!(state, WrapperDetectionState::Aligned);
        assert_eq!(update, None);
        assert_eq!(
            detect_wrapper_update(&clone_path, "origin", "main").unwrap(),
            None
        );
    }

    #[test]
    fn local_checkout_ahead_of_remote_is_not_an_update() {
        let _g = env_lock();
        let origin = tempdir().unwrap();
        init_repo(origin.path());

        let clone = tempdir().unwrap();
        let clone_path = clone.path().join("checkout");
        git_clone(origin.path(), &clone_path);

        std::fs::write(clone_path.join("local.txt"), "local-only change\n").unwrap();
        git(&clone_path, &["add", "-A"]);
        git(&clone_path, &["commit", "-q", "-m", "local ahead"]);

        let installed = installed_wrapper(&clone_path).expect("installed");
        let (state, update) =
            detect_wrapper_update_state_for_installed(&clone_path, &installed, "origin", "main")
                .unwrap();
        assert_eq!(state, WrapperDetectionState::DevMode);
        assert_eq!(update, None);
        assert_eq!(
            detect_wrapper_update(&clone_path, "origin", "main").unwrap(),
            None
        );
    }

    #[test]
    fn installed_metadata_can_differ_from_builder_checkout_head() {
        let _g = env_lock();
        let origin = tempdir().unwrap();
        init_repo(origin.path());

        let clone = tempdir().unwrap();
        let clone_path = clone.path().join("checkout");
        git_clone(origin.path(), &clone_path);
        let installed = installed_wrapper(&clone_path).expect("installed");

        let app_root = clone.path().join("app");
        std::fs::create_dir_all(app_root.join(".codex-linux")).unwrap();
        std::fs::write(
            app_root.join(".codex-linux/build-info.json"),
            format!(
                r#"{{
  "source": {{
    "commit": "{}",
    "version": "0.8.1"
  }}
}}
"#,
                installed.commit
            ),
        )
        .unwrap();

        std::fs::write(clone_path.join("local.txt"), "local-only change\n").unwrap();
        git(&clone_path, &["add", "-A"]);
        git(&clone_path, &["commit", "-q", "-m", "local ahead"]);

        std::fs::write(
            origin.path().join("updater/Cargo.toml"),
            "[package]\nname = \"codex-update-manager\"\nversion = \"0.9.0\"\n",
        )
        .unwrap();
        std::fs::write(
            origin.path().join("CHANGELOG.md"),
            "# Changelog\n\n## [0.9.0] - 2026-06-01\n\n### Added\n\n- New wrapper feature.\n",
        )
        .unwrap();
        git(origin.path(), &["add", "-A"]);
        git(origin.path(), &["commit", "-q", "-m", "remote bump"]);

        let metadata_identity =
            installed_wrapper_from_metadata(&app_root.join("electron"), &clone_path)
                .expect("metadata identity");
        assert_eq!(metadata_identity.commit, installed.commit);
        assert_ne!(
            metadata_identity.commit,
            installed_wrapper(&clone_path)
                .expect("checkout identity")
                .commit
        );

        let update = detect_from_bundle_root(&clone_path, &metadata_identity, "origin", "main")
            .unwrap()
            .expect("update detected from installed metadata");
        assert_eq!(update.installed_commit, installed.commit);
        assert_eq!(update.installed_version.as_deref(), Some("0.8.1"));
        assert_eq!(update.candidate_version.as_deref(), Some("0.9.0"));
    }

    #[test]
    fn packaged_builder_without_git_uses_source_info_but_reports_no_update() {
        let temp = tempdir().unwrap();
        let builder = temp.path().join("update-builder");
        std::fs::create_dir_all(builder.join(".codex-linux")).unwrap();
        std::fs::write(
            builder.join(".codex-linux/source-info.json"),
            r#"{
  "commit": "0123456789012345678901234567890123456789",
  "version": "0.8.1",
  "provenance": "packaged-update-builder"
}
"#,
        )
        .unwrap();

        let installed =
            installed_wrapper_from_metadata(&temp.path().join("app/electron"), &builder)
                .expect("source-info identity");
        assert_eq!(installed.version.as_deref(), Some("0.8.1"));
        assert_eq!(
            detect_from_bundle_root(&builder, &installed, "origin", "main").unwrap(),
            None
        );
        let (state, update) =
            detect_state_from_bundle_root(&builder, &installed, "origin", "main").unwrap();
        assert_eq!(state, WrapperDetectionState::UnknownOffline);
        assert_eq!(update, None);
    }
}
