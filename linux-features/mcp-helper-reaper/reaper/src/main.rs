use anyhow::{bail, Context, Result};
use clap::{ArgGroup, Parser};
use codex_mcp_helper_reaper::{
    all_processes, codex_home_for_parent, discover_config_paths, escalate_orphan_helpers,
    escalate_stale_helpers, is_codex_process, load_config_server_specs,
    load_plugin_cache_server_specs, plan_orphan_reap, plan_reap, read_proc, same_process,
    sleep_duration, terminate_orphan_helpers, terminate_stale_helpers, ProcInfo, ServerSpec,
};
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::time::Duration;

#[derive(Debug, Parser)]
#[command(
    about = "Reap stale duplicate and orphaned MCP helper generations for Codex parent processes.",
    group(
        ArgGroup::new("target")
            .required(true)
            .args(["codex_parent", "all_codex_parents"]),
    )
)]
struct Args {
    /// Reap duplicate direct helper children under this Codex parent PID.
    #[arg(long, value_name = "PID")]
    codex_parent: Option<i32>,

    /// Scan all visible live Codex parent processes independently.
    #[arg(long)]
    all_codex_parents: bool,

    /// Installed Codex Desktop app directory for bundled helper matching.
    #[arg(long, value_name = "PATH")]
    app_dir: Option<PathBuf>,

    /// Override CODEX_HOME when loading config.toml and plugin cache specs.
    #[arg(long, value_name = "PATH")]
    codex_home: Option<PathBuf>,

    /// Extra Codex config.toml path to load before discovered configs.
    #[arg(long = "config", value_name = "PATH")]
    configs: Vec<PathBuf>,

    /// Also reap configured or app-scoped helper roots adopted by init/user systemd.
    #[arg(long)]
    include_orphans: bool,

    /// Seconds to wait before the first cleanup pass.
    #[arg(long, default_value_t = 0)]
    delay: u64,

    /// Number of cleanup passes to run.
    #[arg(long, default_value_t = 1)]
    passes: u32,

    /// Seconds between cleanup passes.
    #[arg(long, default_value_t = 2)]
    interval: u64,

    /// Seconds to wait after SIGTERM before SIGKILL escalation.
    #[arg(long, default_value_t = 2)]
    term_timeout: u64,

    /// Print candidates without signaling processes.
    #[arg(long)]
    dry_run: bool,

    /// Suppress normal status output.
    #[arg(long)]
    quiet: bool,
}

fn main() {
    if let Err(error) = run(Args::parse()) {
        eprintln!("codex-mcp-helper-reaper: {error:#}");
        std::process::exit(1);
    }
}

fn run(args: Args) -> Result<()> {
    if args.passes == 0 {
        return Ok(());
    }

    let expected_parent = match args.codex_parent {
        Some(pid) => {
            let parent =
                read_proc(pid).with_context(|| format!("Codex parent pid {pid} is not live"))?;
            if !is_codex_process(&parent) {
                bail!("refusing non-Codex parent pid {pid}");
            }
            Some(parent)
        }
        None => None,
    };

    if args.delay > 0 {
        sleep_duration(Duration::from_secs(args.delay));
    }

    for pass in 0..args.passes {
        let processes = all_processes();
        let targets = if let Some(parent) = &expected_parent {
            if !same_process(parent) {
                return Ok(());
            }
            vec![read_proc(parent.pid).unwrap_or_else(|| parent.clone())]
        } else {
            discover_codex_parents(&processes)
        };

        let mut orphan_specs = Vec::new();
        let mut seen_specs = BTreeSet::new();
        for parent in targets {
            let specs = load_server_specs(&parent, &args)?;
            push_specs_dedup(&mut orphan_specs, &mut seen_specs, specs.clone());
            reap_for_parent(&args, &parent, &processes, &specs)?;
        }

        if args.include_orphans {
            push_specs_dedup(
                &mut orphan_specs,
                &mut seen_specs,
                load_orphan_server_specs(&args, &processes),
            );
            reap_orphans(&args, &processes, &orphan_specs)?;
        }

        if pass + 1 < args.passes {
            sleep_duration(Duration::from_secs(args.interval));
        }
    }

    Ok(())
}

fn discover_codex_parents(processes: &BTreeMap<i32, ProcInfo>) -> Vec<ProcInfo> {
    let self_pid = std::process::id() as i32;
    processes
        .values()
        .filter(|process| process.pid != self_pid)
        .filter(|process| is_codex_process(process))
        .cloned()
        .collect()
}

fn reap_for_parent(
    args: &Args,
    parent: &ProcInfo,
    processes: &BTreeMap<i32, ProcInfo>,
    specs: &[ServerSpec],
) -> Result<()> {
    let candidates = plan_reap(parent.pid, processes, specs, args.app_dir.as_deref());
    if candidates.is_empty() {
        return Ok(());
    }

    terminate_stale_helpers(&candidates, processes, args.dry_run, args.quiet);
    if args.dry_run {
        return Ok(());
    }

    sleep_duration(Duration::from_secs(args.term_timeout));
    let current_processes = all_processes();
    escalate_stale_helpers(&candidates, processes, &current_processes, args.quiet);
    Ok(())
}

fn reap_orphans(
    args: &Args,
    processes: &BTreeMap<i32, ProcInfo>,
    specs: &[ServerSpec],
) -> Result<()> {
    let candidates = plan_orphan_reap(processes, specs, args.app_dir.as_deref());
    if candidates.is_empty() {
        return Ok(());
    }

    terminate_orphan_helpers(&candidates, processes, args.dry_run, args.quiet);
    if args.dry_run {
        return Ok(());
    }

    sleep_duration(Duration::from_secs(args.term_timeout));
    let current_processes = all_processes();
    escalate_orphan_helpers(&candidates, processes, &current_processes, args.quiet);
    Ok(())
}

fn load_server_specs(parent: &ProcInfo, args: &Args) -> Result<Vec<ServerSpec>> {
    let mut specs = Vec::new();
    for path in discover_config_paths(parent, args.codex_home.as_deref(), &args.configs) {
        if !path.is_file() {
            continue;
        }
        match load_config_server_specs(&path) {
            Ok(mut loaded) => specs.append(&mut loaded),
            Err(error) => eprintln!("codex-mcp-helper-reaper: {error:#}"),
        }
    }

    let codex_home = codex_home_for_parent(parent, args.codex_home.as_deref());
    specs.extend(load_plugin_cache_server_specs(&codex_home));
    Ok(specs)
}

fn load_orphan_server_specs(args: &Args, processes: &BTreeMap<i32, ProcInfo>) -> Vec<ServerSpec> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default();
    let codex_home = args
        .codex_home
        .clone()
        .or_else(|| std::env::var_os("CODEX_HOME").map(PathBuf::from))
        .unwrap_or_else(|| home.join(".codex"));

    let mut paths = Vec::new();
    paths.extend(args.configs.iter().cloned());
    paths.push(codex_home.join("config.toml"));
    for process in processes.values() {
        if process.cwd.as_os_str().is_empty()
            || !process.cwd.is_absolute()
            || is_codex_process(process)
        {
            continue;
        }
        let mut cwd = process.cwd.as_path();
        loop {
            paths.push(cwd.join(".codex/config.toml"));
            if cwd == home || cwd.parent().is_none() {
                break;
            }
            cwd = cwd.parent().expect("checked parent exists");
        }
    }

    let mut specs = Vec::new();
    let mut seen_paths = BTreeSet::new();
    for path in paths {
        if !seen_paths.insert(path.clone()) || !path.is_file() {
            continue;
        }
        match load_config_server_specs(&path) {
            Ok(mut loaded) => specs.append(&mut loaded),
            Err(error) => eprintln!("codex-mcp-helper-reaper: {error:#}"),
        }
    }
    specs.extend(load_plugin_cache_server_specs(&codex_home));
    specs
}

fn push_specs_dedup(
    target: &mut Vec<ServerSpec>,
    seen: &mut BTreeSet<String>,
    specs: Vec<ServerSpec>,
) {
    for spec in specs {
        let key = format!(
            "{}\0{}\0{}\0{}",
            spec.name,
            spec.command,
            spec.args.join("\0"),
            spec.cwd
                .as_ref()
                .map(|path| path.display().to_string())
                .unwrap_or_default()
        );
        if seen.insert(key) {
            target.push(spec);
        }
    }
}
