use anyhow::{Context, Result};
use serde_json::Value as JsonValue;
use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsStr;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProcInfo {
    pub pid: i32,
    pub ppid: i32,
    pub start_time: u64,
    pub comm: String,
    pub argv: Vec<String>,
    pub cwd: PathBuf,
    pub env_keys: BTreeSet<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ServerSpec {
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OrphanReapCandidate {
    pub stale_pid: i32,
    pub signature: String,
}

pub fn plan_orphan_reap(
    processes: &BTreeMap<i32, ProcInfo>,
    server_specs: &[ServerSpec],
    app_dir: Option<&Path>,
) -> Vec<OrphanReapCandidate> {
    let mut candidates = Vec::new();
    for process in processes.values() {
        if !is_orphan_helper_root(process, processes, server_specs, app_dir) {
            continue;
        }
        let Some(signature) = helper_signature_for_orphan(process, server_specs, app_dir) else {
            continue;
        };
        candidates.push(OrphanReapCandidate {
            stale_pid: process.pid,
            signature,
        });
    }
    candidates.sort_by(|left, right| {
        left.signature
            .cmp(&right.signature)
            .then(left.stale_pid.cmp(&right.stale_pid))
    });
    candidates
}

pub fn load_config_server_specs(path: &Path) -> Result<Vec<ServerSpec>> {
    let source = std::fs::read_to_string(path)
        .with_context(|| format!("read Codex config {}", path.display()))?;
    let value: toml::Value = toml::from_str(&source)
        .with_context(|| format!("parse Codex config {}", path.display()))?;
    let Some(servers) = value.get("mcp_servers").and_then(toml::Value::as_table) else {
        return Ok(Vec::new());
    };

    let mut specs = Vec::new();
    for (name, server) in servers {
        let Some(table) = server.as_table() else {
            continue;
        };
        let Some(command) = table.get("command").and_then(toml::Value::as_str) else {
            continue;
        };
        let args = table
            .get("args")
            .and_then(toml::Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(toml::Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        let cwd = table
            .get("cwd")
            .and_then(toml::Value::as_str)
            .map(|cwd| normalize_path(Path::new(cwd)));
        specs.push(ServerSpec {
            name: name.to_string(),
            command: command.to_string(),
            args,
            cwd,
        });
    }
    specs.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(specs)
}

pub fn load_plugin_server_specs(plugin_dir: &Path) -> Result<Vec<ServerSpec>> {
    let manifest = plugin_dir.join(".mcp.json");
    let source = std::fs::read_to_string(&manifest)
        .with_context(|| format!("read plugin MCP manifest {}", manifest.display()))?;
    let value: JsonValue = serde_json::from_str(&source)
        .with_context(|| format!("parse plugin MCP manifest {}", manifest.display()))?;
    let Some(servers) = value.get("mcpServers").and_then(JsonValue::as_object) else {
        return Ok(Vec::new());
    };

    let mut specs = Vec::new();
    for (name, server) in servers {
        let Some(command) = server.get("command").and_then(JsonValue::as_str) else {
            continue;
        };
        let args = server
            .get("args")
            .and_then(JsonValue::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(JsonValue::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        let cwd = server
            .get("cwd")
            .and_then(JsonValue::as_str)
            .map(|cwd| {
                let path = Path::new(cwd);
                if path.is_absolute() {
                    normalize_path(path)
                } else {
                    normalize_path(&plugin_dir.join(path))
                }
            })
            .or_else(|| Some(normalize_path(plugin_dir)));
        specs.push(ServerSpec {
            name: name.to_string(),
            command: command.to_string(),
            args,
            cwd,
        });
    }
    specs.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(specs)
}

pub fn descendant_pids(root_pid: i32, processes: &BTreeMap<i32, ProcInfo>) -> Vec<i32> {
    let mut children: BTreeMap<i32, Vec<i32>> = BTreeMap::new();
    for process in processes.values() {
        children.entry(process.ppid).or_default().push(process.pid);
    }
    for child_list in children.values_mut() {
        child_list.sort_unstable();
    }

    let mut result = Vec::new();
    let mut stack = children.get(&root_pid).cloned().unwrap_or_default();
    stack.reverse();
    while let Some(pid) = stack.pop() {
        result.push(pid);
        if let Some(grandchildren) = children.get(&pid) {
            for child in grandchildren.iter().rev() {
                stack.push(*child);
            }
        }
    }
    result
}

pub fn read_proc(pid: i32) -> Option<ProcInfo> {
    let proc_dir = PathBuf::from("/proc").join(pid.to_string());
    let stat = std::fs::read_to_string(proc_dir.join("stat")).ok()?;
    let cmdline = std::fs::read(proc_dir.join("cmdline")).ok()?;
    let comm = std::fs::read_to_string(proc_dir.join("comm"))
        .map(|value| value.trim().to_string())
        .unwrap_or_default();

    let end = stat.rfind(')')?;
    let fields: Vec<&str> = stat.get(end + 2..)?.split_whitespace().collect();
    let ppid = fields.get(1)?.parse().ok()?;
    let start_time = fields.get(19)?.parse().ok()?;
    let argv = cmdline
        .split(|byte| *byte == b'\0')
        .filter(|part| !part.is_empty())
        .map(|part| String::from_utf8_lossy(part).into_owned())
        .collect();
    let cwd = std::fs::read_link(proc_dir.join("cwd")).unwrap_or_default();

    let env_keys = read_environ(pid).into_keys().collect();

    Some(ProcInfo {
        pid,
        ppid,
        start_time,
        comm,
        argv,
        cwd,
        env_keys,
    })
}

pub fn all_processes() -> BTreeMap<i32, ProcInfo> {
    let mut processes = BTreeMap::new();
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return processes;
    };
    for entry in entries.flatten() {
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        let Ok(pid) = name.parse::<i32>() else {
            continue;
        };
        if let Some(process) = read_proc(pid) {
            processes.insert(pid, process);
        }
    }
    processes
}

pub fn is_codex_process(process: &ProcInfo) -> bool {
    if is_self(process) {
        return false;
    }
    // codex-linux-sandbox wraps ordinary tool commands and codex-mcp-helper-reaper
    // is this reaper; neither owns MCP helpers, so exclude them from parent
    // discovery like the sibling node_repl reaper does.
    if is_codex_non_owner_process(process) {
        return false;
    }
    let argv0 = process.argv.first().map(String::as_str).unwrap_or_default();
    let name = Path::new(argv0)
        .file_name()
        .and_then(OsStr::to_str)
        .unwrap_or(argv0);
    process.comm == "codex" || name == "codex" || name.starts_with("codex-")
}

fn is_codex_non_owner_process(process: &ProcInfo) -> bool {
    let argv0 = process.argv.first().map(String::as_str).unwrap_or_default();
    let name = Path::new(argv0)
        .file_name()
        .and_then(OsStr::to_str)
        .unwrap_or(argv0);
    matches!(name, "codex-linux-sandbox" | "codex-mcp-helper-reaper")
        || matches!(process.comm.as_str(), "codex-linux-san" | "codex-mcp-helpe")
}

pub fn same_process(expected: &ProcInfo) -> bool {
    read_proc(expected.pid)
        .map(|current| current.ppid == expected.ppid && current.start_time == expected.start_time)
        .unwrap_or(false)
}

pub fn read_environ(pid: i32) -> BTreeMap<String, String> {
    let mut env = BTreeMap::new();
    let Ok(raw) = std::fs::read(PathBuf::from("/proc").join(pid.to_string()).join("environ"))
    else {
        return env;
    };
    for item in raw.split(|byte| *byte == b'\0') {
        if item.is_empty() {
            continue;
        }
        let Some(eq) = item.iter().position(|byte| *byte == b'=') else {
            continue;
        };
        let key = String::from_utf8_lossy(&item[..eq]).into_owned();
        let value = String::from_utf8_lossy(&item[eq + 1..]).into_owned();
        env.insert(key, value);
    }
    env
}

pub fn codex_home_for_parent(parent: &ProcInfo, codex_home: Option<&Path>) -> PathBuf {
    let env = read_environ(parent.pid);
    let home = env.get("HOME").map(PathBuf::from).unwrap_or_else(|| {
        std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_default()
    });
    codex_home
        .map(PathBuf::from)
        .or_else(|| env.get("CODEX_HOME").map(PathBuf::from))
        .unwrap_or_else(|| home.join(".codex"))
}

pub fn discover_config_paths(
    parent: &ProcInfo,
    codex_home: Option<&Path>,
    extra: &[PathBuf],
) -> Vec<PathBuf> {
    let env = read_environ(parent.pid);
    let home = env.get("HOME").map(PathBuf::from).unwrap_or_else(|| {
        std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_default()
    });
    let codex_home = codex_home_for_parent(parent, codex_home);

    let mut paths = Vec::new();
    paths.extend(extra.iter().cloned());
    paths.push(codex_home.join("config.toml"));

    let mut cwd = parent.cwd.as_path();
    loop {
        paths.push(cwd.join(".codex/config.toml"));
        if cwd == home || cwd.parent().is_none() {
            break;
        }
        cwd = cwd.parent().expect("checked parent exists");
    }

    dedupe_paths(paths)
}

pub fn load_plugin_cache_server_specs(codex_home: &Path) -> Vec<ServerSpec> {
    let root = codex_home.join("plugins/cache");
    let mut specs = Vec::new();
    collect_plugin_specs(&root, 0, &mut specs);
    specs
}

pub fn terminate_orphan_helpers(
    candidates: &[OrphanReapCandidate],
    processes: &BTreeMap<i32, ProcInfo>,
    dry_run: bool,
    quiet: bool,
) {
    for candidate in candidates {
        log(
            quiet,
            &format!(
                "{} orphaned MCP helper pid={} signature={}",
                if dry_run { "would reap" } else { "reaping" },
                candidate.stale_pid,
                candidate.signature
            ),
        );
        if dry_run {
            continue;
        }
        signal_tree(candidate.stale_pid, libc::SIGTERM, processes);
    }
}

pub fn escalate_orphan_helpers(
    candidates: &[OrphanReapCandidate],
    original_processes: &BTreeMap<i32, ProcInfo>,
    current_processes: &BTreeMap<i32, ProcInfo>,
    quiet: bool,
) {
    for candidate in candidates {
        let Some(original) = original_processes.get(&candidate.stale_pid) else {
            continue;
        };
        let Some(current) = current_processes.get(&candidate.stale_pid) else {
            continue;
        };
        if current.ppid != original.ppid || current.start_time != original.start_time {
            continue;
        }
        log(
            quiet,
            &format!(
                "SIGKILL orphaned MCP helper pid={} signature={}",
                candidate.stale_pid, candidate.signature
            ),
        );
        signal_tree(candidate.stale_pid, libc::SIGKILL, current_processes);
    }
}

pub fn sleep_duration(duration: Duration) {
    std::thread::sleep(duration);
}

fn collect_plugin_specs(dir: &Path, depth: usize, specs: &mut Vec<ServerSpec>) {
    if depth > 6 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.file_name() == Some(OsStr::new(".mcp.json")) {
            if let Some(plugin_dir) = path.parent() {
                match load_plugin_server_specs(plugin_dir) {
                    Ok(mut loaded) => specs.append(&mut loaded),
                    Err(error) => eprintln!("codex-mcp-helper-reaper: {error:#}"),
                }
            }
            continue;
        }
        if entry
            .file_type()
            .map(|file_type| file_type.is_dir())
            .unwrap_or(false)
        {
            collect_plugin_specs(&path, depth + 1, specs);
        }
    }
}

fn signal_tree(root_pid: i32, signal: i32, processes: &BTreeMap<i32, ProcInfo>) {
    signal_tree_with(
        root_pid,
        signal,
        processes,
        same_process,
        |pid, signal| unsafe {
            libc::kill(pid, signal);
        },
    );
}

fn signal_tree_with<IdentityMatches, SendSignal>(
    root_pid: i32,
    signal: i32,
    processes: &BTreeMap<i32, ProcInfo>,
    mut identity_matches: IdentityMatches,
    mut send_signal: SendSignal,
) where
    IdentityMatches: FnMut(&ProcInfo) -> bool,
    SendSignal: FnMut(i32, i32),
{
    let mut pids = descendant_pids(root_pid, processes);
    pids.reverse();
    pids.push(root_pid);
    for pid in pids {
        let Some(expected) = processes.get(&pid) else {
            continue;
        };
        if !identity_matches(expected) {
            continue;
        }
        send_signal(pid, signal);
    }
}

fn log(quiet: bool, message: &str) {
    if !quiet {
        println!("codex-mcp-helper-reaper: {message}");
    }
}

fn dedupe_paths(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut seen = BTreeSet::new();
    let mut result = Vec::new();
    for path in paths {
        let path = normalize_path(&path);
        if seen.insert(path.clone()) {
            result.push(path);
        }
    }
    result
}

fn helper_signature_for_orphan(
    process: &ProcInfo,
    server_specs: &[ServerSpec],
    app_dir: Option<&Path>,
) -> Option<String> {
    if process.argv.is_empty()
        || is_shell_command(process)
        || is_self(process)
        || is_codex_non_owner_process(process)
    {
        return None;
    }
    let matching_specs = server_specs
        .iter()
        .filter(|spec| configured_server_matches(process, spec))
        .take(2)
        .collect::<Vec<_>>();
    if matching_specs.len() == 1 {
        let spec = matching_specs[0];
        return Some(format!(
            "config:{}\0{}\0{}\0{}",
            spec.name,
            spec.command,
            spec.args.join("\0"),
            normalize_path(&process.cwd).display()
        ));
    }
    if matching_specs.len() > 1 {
        return None;
    }
    let mcp_convention = looks_like_mcp_convention(process);
    if looks_like_app_helper(process, app_dir) && mcp_convention {
        return Some(format!("argv:{}", process.argv.join("\0")));
    }
    None
}

fn configured_server_matches(process: &ProcInfo, spec: &ServerSpec) -> bool {
    if let Some(cwd) = &spec.cwd {
        if normalize_path(&process.cwd) != normalize_path(cwd) {
            return false;
        }
    }

    let command_name = Path::new(&spec.command)
        .file_name()
        .and_then(OsStr::to_str)
        .unwrap_or(&spec.command);
    let argv0 = process.argv.first().map(String::as_str).unwrap_or_default();
    let argv0_name = Path::new(argv0)
        .file_name()
        .and_then(OsStr::to_str)
        .unwrap_or(argv0);

    let direct_command_match =
        if spec.command.contains('/') {
            let expected = command_path_for_spec(spec);
            process
                .argv
                .iter()
                .take(4)
                .any(|arg| command_arg_matches_expected(process, arg, &expected))
        } else {
            argv0 == spec.command
                || argv0_name == command_name
                || process.argv.iter().take(5).any(|arg| {
                    Path::new(arg).file_name().and_then(OsStr::to_str) == Some(command_name)
                })
        };

    direct_command_match && args_contain_subsequence(&process.argv, &spec.args)
}

fn command_path_for_spec(spec: &ServerSpec) -> PathBuf {
    let command = Path::new(&spec.command);
    if command.is_absolute() {
        normalize_path(command)
    } else if let Some(cwd) = &spec.cwd {
        normalize_path(&cwd.join(command))
    } else {
        normalize_path(command)
    }
}

fn command_path_for_arg(process: &ProcInfo, arg: &str) -> PathBuf {
    command_path_for_arg_path(&process.cwd, Path::new(arg))
}

fn command_arg_matches_expected(process: &ProcInfo, arg: &str, expected: &Path) -> bool {
    let actual = command_path_for_arg(process, arg);
    actual == expected || same_directory_sidecar_command(expected, &actual)
}

fn same_directory_sidecar_command(expected: &Path, actual: &Path) -> bool {
    if expected.parent() != actual.parent() {
        return false;
    }
    let Some(expected_name) = expected.file_name().and_then(OsStr::to_str) else {
        return false;
    };
    let Some(actual_name) = actual.file_name().and_then(OsStr::to_str) else {
        return false;
    };
    let Some(suffix) = actual_name.strip_prefix(expected_name) else {
        return false;
    };
    matches!(
        suffix.as_bytes().first(),
        Some(b'-') | Some(b'_') | Some(b'.')
    )
}

fn command_path_for_arg_path(cwd: &Path, path: &Path) -> PathBuf {
    if path.is_absolute() {
        normalize_path(path)
    } else {
        normalize_path(&cwd.join(path))
    }
}

fn args_contain_subsequence(argv: &[String], needle: &[String]) -> bool {
    if needle.is_empty() {
        return true;
    }
    if needle.len() > argv.len() {
        return false;
    }
    argv.windows(needle.len()).any(|window| window == needle)
}

fn is_shell_command(process: &ProcInfo) -> bool {
    let argv0 = process.argv.first().map(String::as_str).unwrap_or_default();
    // Login shells rewrite argv0 to "-bash"; strip the leading dash before
    // resolving the shell name so `-bash -c ...` is still recognized.
    let name = Path::new(argv0.strip_prefix('-').unwrap_or(argv0))
        .file_name()
        .and_then(OsStr::to_str)
        .unwrap_or(argv0);
    matches!(name, "bash" | "dash" | "fish" | "sh" | "zsh")
        && process
            .argv
            .iter()
            .skip(1)
            .any(|arg| is_shell_command_flag(arg))
}

/// True for the `-c` command flag in any form Codex's shell tool emits: a bare
/// `-c` or a combined short-option cluster like `-lc` / `-ic` (but never a
/// long option such as `--config`).
fn is_shell_command_flag(arg: &str) -> bool {
    let Some(flags) = arg.strip_prefix('-') else {
        return false;
    };
    !flags.is_empty() && !flags.starts_with('-') && flags.contains('c')
}

fn is_self(process: &ProcInfo) -> bool {
    process
        .argv
        .iter()
        .any(|arg| arg.contains("codex-mcp-helper-reaper") || arg.contains("mcp-helper-reaper"))
}

fn is_orphan_helper_root(
    process: &ProcInfo,
    processes: &BTreeMap<i32, ProcInfo>,
    server_specs: &[ServerSpec],
    app_dir: Option<&Path>,
) -> bool {
    if !has_init_or_user_systemd_parent(process, processes) {
        return false;
    }
    if has_live_codex_ancestor(process, processes) {
        return false;
    }
    if has_helper_ancestor(process, processes, server_specs, app_dir) {
        return false;
    }
    if !has_codex_origin_marker(process) {
        return false;
    }
    helper_signature_for_orphan(process, server_specs, app_dir).is_some()
}

fn has_codex_origin_marker(process: &ProcInfo) -> bool {
    const CODEX_ORIGIN_KEYS: &[&str] = &[
        "CODEX_HOME",
        "CODEX_SESSION_ID",
        "CODEX_THREAD_ID",
        "CODEX_SANDBOX",
        "CODEX_SANDBOX_NETWORK_DISABLED",
        "CODEX_CLI_PATH",
        "CODEX_MANAGED_NODE_PATH",
        "CODEX_INTERNAL_ORIGINATOR_OVERRIDE",
    ];
    process
        .env_keys
        .iter()
        .any(|key| CODEX_ORIGIN_KEYS.contains(&key.as_str()))
}

fn has_init_or_user_systemd_parent(
    process: &ProcInfo,
    processes: &BTreeMap<i32, ProcInfo>,
) -> bool {
    let Some(parent) = processes.get(&process.ppid) else {
        return false;
    };
    if parent.pid == 1 {
        return true;
    }
    parent.ppid == 1 && process_name(parent) == "systemd"
}

fn has_live_codex_ancestor(process: &ProcInfo, processes: &BTreeMap<i32, ProcInfo>) -> bool {
    let mut seen = BTreeSet::new();
    let mut next_pid = process.ppid;
    while next_pid > 0 && seen.insert(next_pid) {
        let Some(parent) = processes.get(&next_pid) else {
            return false;
        };
        if is_codex_process(parent) {
            return true;
        }
        if parent.pid == parent.ppid {
            return false;
        }
        next_pid = parent.ppid;
    }
    false
}

fn has_helper_ancestor(
    process: &ProcInfo,
    processes: &BTreeMap<i32, ProcInfo>,
    server_specs: &[ServerSpec],
    app_dir: Option<&Path>,
) -> bool {
    let mut seen = BTreeSet::new();
    let mut next_pid = process.ppid;
    while next_pid > 0 && seen.insert(next_pid) {
        let Some(parent) = processes.get(&next_pid) else {
            return false;
        };
        if is_codex_process(parent) || has_init_or_user_systemd_parent(parent, processes) {
            return false;
        }
        if helper_signature_for_orphan(parent, server_specs, app_dir).is_some() {
            return true;
        }
        if parent.pid == parent.ppid {
            return false;
        }
        next_pid = parent.ppid;
    }
    false
}

fn process_name(process: &ProcInfo) -> &str {
    let argv0 = process.argv.first().map(String::as_str).unwrap_or_default();
    Path::new(argv0)
        .file_name()
        .and_then(OsStr::to_str)
        .unwrap_or(process.comm.as_str())
}

fn looks_like_mcp_convention(process: &ProcInfo) -> bool {
    process.argv.iter().any(|arg| {
        let lower = arg.to_ascii_lowercase();
        lower == "mcp"
            || lower == "--stdio"
            || lower == "stdio"
            || lower.contains("mcp-server")
            || lower.contains("json-rpc")
            || lower.contains("jsonrpc")
    })
}

fn looks_like_app_helper(process: &ProcInfo, app_dir: Option<&Path>) -> bool {
    let Some(app_dir) = app_dir else {
        return false;
    };
    let app_dir = normalize_path(app_dir);
    normalize_path(&process.cwd).starts_with(&app_dir)
        || process.argv.iter().take(2).map(Path::new).any(|path| {
            let path = if path.is_absolute() {
                normalize_path(path)
            } else {
                normalize_path(&process.cwd.join(path))
            };
            path.starts_with(&app_dir)
        })
}

fn normalize_path(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            Component::Normal(part) => normalized.push(part),
            Component::RootDir | Component::Prefix(_) => normalized.push(component.as_os_str()),
        }
    }
    normalized
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn proc(pid: i32, ppid: i32, start_time: u64, argv: &[&str], cwd: &str) -> ProcInfo {
        ProcInfo {
            pid,
            ppid,
            start_time,
            comm: argv
                .first()
                .and_then(|arg| std::path::Path::new(arg).file_name())
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| "unknown".to_string()),
            argv: argv.iter().map(|arg| (*arg).to_string()).collect(),
            cwd: PathBuf::from(cwd),
            env_keys: BTreeSet::new(),
        }
    }

    fn with_codex_origin(mut process: ProcInfo) -> ProcInfo {
        process.env_keys.insert("CODEX_HOME".to_string());
        process
    }

    #[test]
    fn keeps_duplicate_helpers_under_same_live_codex_parent() {
        let mut processes = BTreeMap::new();
        processes.insert(100, proc(100, 1, 10, &["codex", "resume"], "/repo"));
        processes.insert(
            101,
            proc(101, 100, 20, &["/tmp/example-helper", "serve"], "/repo"),
        );
        processes.insert(
            102,
            proc(102, 100, 30, &["/tmp/example-helper", "serve"], "/repo"),
        );
        let specs = [ServerSpec {
            name: "code-index".to_string(),
            command: "/tmp/example-helper".to_string(),
            args: vec!["serve".to_string()],
            cwd: None,
        }];

        assert!(plan_orphan_reap(&processes, &specs, None).is_empty());
    }

    #[test]
    fn keeps_deleted_mcp_generation_under_live_codex_parent() {
        let mut processes = BTreeMap::new();
        let plugin_dir = "/home/me/.codex/plugins/cache/example/record-and-replay/1.0.0";
        processes.insert(100, proc(100, 1, 10, &["codex", "resume"], "/repo"));
        processes.insert(
            101,
            proc(
                101,
                100,
                20,
                &["./bin/helper", "event-stream", "mcp"],
                &format!("{plugin_dir} (deleted)"),
            ),
        );
        processes.insert(
            102,
            proc(
                102,
                100,
                30,
                &["./bin/helper", "event-stream", "mcp"],
                plugin_dir,
            ),
        );
        let specs = [ServerSpec {
            name: "event-stream".to_string(),
            command: "./bin/helper".to_string(),
            args: vec!["event-stream".to_string(), "mcp".to_string()],
            cwd: Some(PathBuf::from(plugin_dir)),
        }];

        assert!(plan_orphan_reap(&processes, &specs, None).is_empty());
    }

    #[test]
    fn keeps_replaced_app_generation_helper_under_live_codex_parent() {
        let mut processes = BTreeMap::new();
        let old_app =
            "/home/linuxbrew/.linuxbrew/Caskroom/codex-desktop/old/share/codex-desktop/app";
        let new_app =
            "/home/linuxbrew/.linuxbrew/Caskroom/codex-desktop/new/share/codex-desktop/app";
        let old_helper = format!("{old_app}/resources/mcp-helper");
        let new_helper = format!("{new_app}/resources/mcp-helper");
        processes.insert(100, proc(100, 1, 10, &["codex", "resume"], "/repo"));
        processes.insert(101, proc(101, 100, 20, &[old_helper.as_str()], "/repo"));
        processes.insert(102, proc(102, 100, 30, &[new_helper.as_str()], "/repo"));

        assert!(plan_orphan_reap(&processes, &[], Some(Path::new(new_app))).is_empty());
    }

    #[test]
    fn keeps_browser_use_node_repl_helpers_under_live_codex_parent() {
        let mut processes = BTreeMap::new();
        let app_dir = "/opt/codex-desktop";
        let wrapped_node_repl = format!("{app_dir}/resources/node_repl.codex-linux-original");
        let direct_node_repl = format!("{app_dir}/resources/node_repl");
        processes.insert(100, proc(100, 1, 10, &["codex", "app-server"], "/repo"));
        processes.insert(
            101,
            proc(101, 100, 20, &[wrapped_node_repl.as_str()], "/repo"),
        );
        processes.insert(
            102,
            proc(102, 100, 30, &[wrapped_node_repl.as_str()], "/repo"),
        );
        processes.insert(
            103,
            proc(103, 100, 40, &[direct_node_repl.as_str()], "/repo"),
        );

        assert!(plan_orphan_reap(&processes, &[], Some(Path::new(app_dir))).is_empty());
    }

    #[test]
    fn keeps_independent_codex_sessions_independent() {
        let mut processes = BTreeMap::new();
        processes.insert(100, proc(100, 1, 10, &["codex", "resume"], "/repo-a"));
        processes.insert(200, proc(200, 1, 10, &["codex", "resume"], "/repo-b"));
        processes.insert(
            101,
            proc(101, 100, 20, &["/tmp/example-helper", "serve"], "/repo-a"),
        );
        processes.insert(
            201,
            proc(201, 200, 21, &["/tmp/example-helper", "serve"], "/repo-b"),
        );
        let specs = [ServerSpec {
            name: "code-index".to_string(),
            command: "/tmp/example-helper".to_string(),
            args: vec!["serve".to_string()],
            cwd: None,
        }];

        assert!(plan_orphan_reap(&processes, &specs, None).is_empty());
    }

    #[test]
    fn ignores_shell_tool_commands_even_when_they_contain_mcp_words() {
        let mut processes = BTreeMap::new();
        processes.insert(100, proc(100, 1, 10, &["codex", "resume"], "/repo"));
        processes.insert(
            101,
            proc(101, 100, 20, &["bash", "-c", "echo mcp"], "/repo"),
        );
        processes.insert(
            102,
            proc(102, 100, 30, &["bash", "-c", "echo mcp"], "/repo"),
        );

        assert!(plan_orphan_reap(&processes, &[], None).is_empty());
    }

    #[test]
    fn ignores_shell_tool_commands_with_combined_flags() {
        // Codex's shell tool runs commands via `bash -lc "<cmd>"`, a combined
        // short-flag cluster rather than a bare `-c`. Such executions must not
        // be treated as MCP helpers even when the command text contains an
        // MCP-style token like "mcp-server".
        let mut processes = BTreeMap::new();
        processes.insert(100, proc(100, 1, 10, &["codex", "resume"], "/repo"));
        processes.insert(
            101,
            proc(
                101,
                100,
                20,
                &["bash", "-lc", "run-mcp-server --stdio"],
                "/repo",
            ),
        );
        processes.insert(
            102,
            proc(
                102,
                100,
                30,
                &["bash", "-lc", "run-mcp-server --stdio"],
                "/repo",
            ),
        );

        assert!(plan_orphan_reap(&processes, &[], None).is_empty());
    }

    #[test]
    fn matches_uvx_style_configured_server_when_launcher_rewrites_argv0() {
        let mut processes = BTreeMap::new();
        processes.insert(100, proc(100, 1, 10, &["codex", "resume"], "/repo"));
        processes.insert(
            101,
            proc(
                101,
                100,
                20,
                &[
                    "/brew/bin/uv",
                    "tool",
                    "uvx",
                    "--from",
                    "repo",
                    "server",
                    "mcp",
                ],
                "/repo",
            ),
        );
        processes.insert(
            102,
            proc(
                102,
                100,
                30,
                &[
                    "/brew/bin/uv",
                    "tool",
                    "uvx",
                    "--from",
                    "repo",
                    "server",
                    "mcp",
                ],
                "/repo",
            ),
        );
        let specs = [ServerSpec {
            name: "language-tools".to_string(),
            command: "uvx".to_string(),
            args: vec![
                "--from".to_string(),
                "repo".to_string(),
                "server".to_string(),
                "mcp".to_string(),
            ],
            cwd: None,
        }];

        assert!(configured_server_matches(
            processes.get(&101).unwrap(),
            &specs[0]
        ));
    }

    #[test]
    fn matches_configured_absolute_script_launched_by_interpreter() {
        let mut processes = BTreeMap::new();
        processes.insert(100, proc(100, 1, 10, &["codex", "resume"], "/repo"));
        processes.insert(
            101,
            proc(101, 100, 20, &["python3", "/repo/bin/server.py"], "/repo"),
        );
        processes.insert(
            102,
            proc(102, 100, 30, &["python3", "/repo/bin/server.py"], "/repo"),
        );
        let specs = [ServerSpec {
            name: "script-server".to_string(),
            command: "/repo/bin/server.py".to_string(),
            args: Vec::new(),
            cwd: None,
        }];

        assert!(configured_server_matches(
            processes.get(&101).unwrap(),
            &specs[0]
        ));
    }

    #[test]
    fn matches_configured_absolute_wrapper_sidecar_launched_by_interpreter() {
        let mut processes = BTreeMap::new();
        processes.insert(100, proc(100, 1, 10, &["codex", "resume"], "/repo"));
        processes.insert(
            101,
            proc(
                101,
                100,
                20,
                &["python3", "/repo/bin/server-filter.py", "--stdio"],
                "/repo",
            ),
        );
        processes.insert(
            102,
            proc(
                102,
                100,
                30,
                &["python3", "/repo/bin/server-filter.py", "--stdio"],
                "/repo",
            ),
        );
        let specs = [ServerSpec {
            name: "wrapped-server".to_string(),
            command: "/repo/bin/server".to_string(),
            args: Vec::new(),
            cwd: None,
        }];

        assert!(configured_server_matches(
            processes.get(&101).unwrap(),
            &specs[0]
        ));
    }

    #[test]
    fn keeps_same_command_servers_with_different_cwd_independent() {
        let mut processes = BTreeMap::new();
        processes.insert(100, proc(100, 1, 10, &["codex", "resume"], "/repo"));
        processes.insert(101, proc(101, 100, 20, &["uvx", "tool", "mcp"], "/repo-a"));
        processes.insert(102, proc(102, 100, 30, &["uvx", "tool", "mcp"], "/repo-b"));
        let specs = vec![
            ServerSpec {
                name: "repo-a".to_string(),
                command: "uvx".to_string(),
                args: vec!["tool".to_string(), "mcp".to_string()],
                cwd: Some(PathBuf::from("/repo-a")),
            },
            ServerSpec {
                name: "repo-b".to_string(),
                command: "uvx".to_string(),
                args: vec!["tool".to_string(), "mcp".to_string()],
                cwd: Some(PathBuf::from("/repo-b")),
            },
        ];

        let repo_a = helper_signature_for_orphan(processes.get(&101).unwrap(), &specs, None);
        let repo_b = helper_signature_for_orphan(processes.get(&102).unwrap(), &specs, None);
        assert_ne!(repo_a, repo_b);
    }

    #[test]
    fn does_not_treat_the_reaper_as_a_codex_parent() {
        let reaper = proc(
            100,
            1,
            10,
            &["/app/.codex-linux/mcp-helper-reaper/codex-mcp-helper-reaper"],
            "/app",
        );

        assert!(!is_codex_process(&reaper));
    }

    #[test]
    fn does_not_treat_the_tool_sandbox_as_a_codex_parent() {
        // codex-linux-sandbox wraps ordinary tool commands, not MCP helpers.
        // Treating it as a scan parent would expose normal tool children to
        // reaping, so it must be excluded like the sibling node_repl reaper.
        let sandbox = proc(
            100,
            1,
            10,
            &["/usr/bin/codex-linux-sandbox", "--", "grep", "-rn", "mcp"],
            "/repo",
        );

        assert!(!is_codex_process(&sandbox));
    }

    #[test]
    fn excludes_tool_sandbox_by_truncated_comm() {
        // /proc/<pid>/comm is capped at 15 bytes, so "codex-linux-sandbox"
        // appears as "codex-linux-san". Exclusion must survive that
        // truncation even if argv0 is unreadable.
        let mut sandbox = proc(100, 1, 10, &[], "/repo");
        sandbox.comm = "codex-linux-san".to_string();

        assert!(!is_codex_process(&sandbox));
    }

    #[test]
    fn does_not_treat_the_tool_sandbox_as_a_helper_candidate() {
        let mut processes = BTreeMap::new();
        processes.insert(100, proc(100, 1, 10, &["codex", "resume"], "/repo"));
        processes.insert(
            101,
            proc(
                101,
                100,
                20,
                &[
                    "/usr/bin/codex-linux-sandbox",
                    "--",
                    "run-mcp-server",
                    "--stdio",
                ],
                "/repo",
            ),
        );
        processes.insert(
            102,
            proc(
                102,
                100,
                30,
                &[
                    "/usr/bin/codex-linux-sandbox",
                    "--",
                    "run-mcp-server",
                    "--stdio",
                ],
                "/repo",
            ),
        );

        assert!(plan_orphan_reap(&processes, &[], None).is_empty());
    }

    #[test]
    fn loads_codex_toml_mcp_servers() {
        let dir = tempdir().unwrap();
        let config = dir.path().join("config.toml");
        fs::write(
            &config,
            r#"
[mcp_servers.example]
command = "tool"
args = ["serve", "--stdio"]
"#,
        )
        .unwrap();

        let specs = load_config_server_specs(&config).unwrap();

        assert_eq!(
            specs,
            vec![ServerSpec {
                name: "example".to_string(),
                command: "tool".to_string(),
                args: vec!["serve".to_string(), "--stdio".to_string()],
                cwd: None,
            }]
        );
    }

    #[test]
    fn loads_plugin_json_mcp_servers_with_relative_cwd() {
        let dir = tempdir().unwrap();
        let plugin_dir = dir.path().join("plugin");
        fs::create_dir_all(&plugin_dir).unwrap();
        fs::write(
            plugin_dir.join(".mcp.json"),
            r#"
{
  "mcpServers": {
    "event-stream": {
      "command": "./bin/SkyLinuxComputerUseClient",
      "args": ["event-stream", "mcp"],
      "cwd": "."
    }
  }
}
"#,
        )
        .unwrap();

        let specs = load_plugin_server_specs(&plugin_dir).unwrap();

        assert_eq!(
            specs,
            vec![ServerSpec {
                name: "event-stream".to_string(),
                command: "./bin/SkyLinuxComputerUseClient".to_string(),
                args: vec!["event-stream".to_string(), "mcp".to_string()],
                cwd: Some(plugin_dir),
            }]
        );
    }

    #[test]
    fn descendant_pids_returns_entire_stale_helper_tree() {
        let mut processes = BTreeMap::new();
        processes.insert(100, proc(100, 1, 10, &["codex", "resume"], "/repo"));
        processes.insert(101, proc(101, 100, 20, &["uvx", "server", "mcp"], "/repo"));
        processes.insert(102, proc(102, 101, 21, &["python", "server.py"], "/repo"));
        processes.insert(103, proc(103, 102, 22, &["rust-analyzer"], "/repo"));
        processes.insert(104, proc(104, 100, 23, &["other", "mcp"], "/repo"));

        assert_eq!(descendant_pids(101, &processes), vec![102, 103]);
    }

    #[test]
    fn signal_tree_revalidates_each_descendant_identity() {
        let mut processes = BTreeMap::new();
        processes.insert(101, proc(101, 100, 20, &["helper", "--stdio"], "/repo"));
        processes.insert(102, proc(102, 101, 21, &["child-a"], "/repo"));
        processes.insert(103, proc(103, 102, 22, &["grandchild"], "/repo"));
        processes.insert(104, proc(104, 101, 23, &["child-b"], "/repo"));

        let live_pids = BTreeSet::from([101, 103]);
        let mut signaled = Vec::new();
        signal_tree_with(
            101,
            libc::SIGTERM,
            &processes,
            |expected| live_pids.contains(&expected.pid),
            |pid, signal| signaled.push((pid, signal)),
        );

        assert_eq!(signaled, vec![(103, libc::SIGTERM), (101, libc::SIGTERM)]);
    }

    #[test]
    fn reaps_configured_orphan_root_adopted_by_user_systemd() {
        let mut processes = BTreeMap::new();
        processes.insert(1, proc(1, 0, 1, &["/usr/lib/systemd/systemd"], "/"));
        processes.insert(
            10,
            proc(10, 1, 2, &["/usr/lib/systemd/systemd", "--user"], "/"),
        );
        processes.insert(
            101,
            with_codex_origin(proc(
                101,
                10,
                20,
                &["python3", "/repo/bin/server-filter.py", "--stdio"],
                "/repo",
            )),
        );
        processes.insert(
            102,
            proc(102, 101, 21, &["helper-child", "--stdio"], "/repo"),
        );
        let specs = vec![ServerSpec {
            name: "wrapped-server".to_string(),
            command: "/repo/bin/server".to_string(),
            args: Vec::new(),
            cwd: None,
        }];

        assert_eq!(
            plan_orphan_reap(&processes, &specs, None),
            vec![OrphanReapCandidate {
                stale_pid: 101,
                signature: "config:wrapped-server\u{0}/repo/bin/server\u{0}\u{0}/repo".to_string(),
            }]
        );
    }

    #[test]
    fn ignores_configured_orphan_without_codex_origin_marker() {
        let mut processes = BTreeMap::new();
        processes.insert(1, proc(1, 0, 1, &["/usr/lib/systemd/systemd"], "/"));
        processes.insert(
            10,
            proc(10, 1, 2, &["/usr/lib/systemd/systemd", "--user"], "/"),
        );
        processes.insert(
            101,
            proc(
                101,
                10,
                20,
                &["python3", "/repo/bin/server-filter.py", "--stdio"],
                "/repo",
            ),
        );
        let specs = vec![ServerSpec {
            name: "wrapped-server".to_string(),
            command: "/repo/bin/server".to_string(),
            args: Vec::new(),
            cwd: None,
        }];

        assert!(plan_orphan_reap(&processes, &specs, None).is_empty());
    }

    #[test]
    fn keeps_live_helper_tree_under_codex_ancestor() {
        let mut processes = BTreeMap::new();
        processes.insert(1, proc(1, 0, 1, &["/usr/lib/systemd/systemd"], "/"));
        processes.insert(100, proc(100, 1, 10, &["codex", "resume"], "/repo"));
        processes.insert(
            101,
            proc(
                101,
                100,
                20,
                &["python3", "/repo/bin/server-filter.py", "--stdio"],
                "/repo",
            ),
        );
        processes.insert(
            102,
            proc(102, 101, 21, &["helper-child", "--stdio"], "/repo"),
        );
        let specs = vec![ServerSpec {
            name: "wrapped-server".to_string(),
            command: "/repo/bin/server".to_string(),
            args: Vec::new(),
            cwd: None,
        }];

        assert!(plan_orphan_reap(&processes, &specs, None).is_empty());
    }

    #[test]
    fn ignores_configured_helper_under_manual_shell_parent() {
        let mut processes = BTreeMap::new();
        processes.insert(1, proc(1, 0, 1, &["/usr/lib/systemd/systemd"], "/"));
        processes.insert(50, proc(50, 1, 5, &["bash"], "/repo"));
        processes.insert(
            101,
            proc(
                101,
                50,
                20,
                &["python3", "/repo/bin/server-filter.py", "--stdio"],
                "/repo",
            ),
        );
        let specs = vec![ServerSpec {
            name: "wrapped-server".to_string(),
            command: "/repo/bin/server".to_string(),
            args: Vec::new(),
            cwd: None,
        }];

        assert!(plan_orphan_reap(&processes, &specs, None).is_empty());
    }

    #[test]
    fn ignores_bare_mcp_convention_orphan_without_config_or_app_scope() {
        let mut processes = BTreeMap::new();
        processes.insert(1, proc(1, 0, 1, &["/usr/lib/systemd/systemd"], "/"));
        processes.insert(
            10,
            proc(10, 1, 2, &["/usr/lib/systemd/systemd", "--user"], "/"),
        );
        processes.insert(101, proc(101, 10, 20, &["random-tool", "--stdio"], "/repo"));

        assert!(plan_orphan_reap(&processes, &[], None).is_empty());
    }

    #[test]
    fn ignores_app_scoped_orphan_without_mcp_convention() {
        let mut processes = BTreeMap::new();
        processes.insert(1, proc(1, 0, 1, &["/usr/lib/systemd/systemd"], "/"));
        processes.insert(
            10,
            proc(10, 1, 2, &["/usr/lib/systemd/systemd", "--user"], "/"),
        );
        processes.insert(101, proc(101, 10, 20, &["/app/start.sh", "--x11"], "/app"));

        assert!(plan_orphan_reap(&processes, &[], Some(Path::new("/app"))).is_empty());
    }
}
