use crate::windows::WindowInfo;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    path::PathBuf,
};

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
pub struct TerminalWindowContext {
    pub tty: String,
    pub root_process: TerminalProcess,
    pub active_process: Option<TerminalProcess>,
    pub process_count: usize,
    pub confidence: String,
    pub match_reason: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
pub struct TerminalProcess {
    pub pid: u32,
    pub command_name: String,
    pub command_line: String,
    pub cwd: Option<String>,
}

#[derive(Debug, Clone)]
struct ProcessInfo {
    pid: u32,
    ppid: u32,
    start_ticks: u64,
    command_name: String,
    command_line: String,
    cwd: Option<String>,
    tty_paths: Vec<String>,
}

pub fn enrich_terminal_windows(windows: &mut [WindowInfo]) {
    let processes = read_process_table();
    if processes.is_empty() {
        return;
    }
    enrich_terminal_windows_with_processes(windows, &processes);
}

fn enrich_terminal_windows_with_processes(windows: &mut [WindowInfo], processes: &[ProcessInfo]) {
    let mut windows_by_terminal_pid: BTreeMap<u32, Vec<usize>> = BTreeMap::new();
    for (index, window) in windows.iter().enumerate() {
        if !looks_like_terminal_window(window) {
            continue;
        }
        if let Some(pid) = window.pid {
            windows_by_terminal_pid.entry(pid).or_default().push(index);
        }
    }

    if windows_by_terminal_pid.is_empty() {
        return;
    }

    let by_pid = processes
        .iter()
        .map(|process| (process.pid, process))
        .collect::<HashMap<_, _>>();

    for (terminal_pid, mut window_indexes) in windows_by_terminal_pid {
        let mut sessions = terminal_sessions_for_pid(terminal_pid, processes, &by_pid);
        if sessions.is_empty() {
            continue;
        }

        window_indexes.sort_by_key(|index| windows[*index].window_id);
        sessions.sort_by_key(|session| session.root_start_ticks);

        let confidence = if window_indexes.len() == 1 && sessions.len() == 1 {
            Some((
                "high",
                "Only one terminal window and one PTY session share the terminal app PID.",
            ))
        } else if window_indexes.len() == sessions.len() {
            Some((
                "heuristic",
                "Matched terminal windows to PTY sessions by shared terminal app PID and creation order.",
            ))
        } else {
            None
        };

        let Some((confidence, reason)) = confidence else {
            continue;
        };

        for (window_index, session) in window_indexes.into_iter().zip(sessions) {
            windows[window_index].terminal = Some(TerminalWindowContext {
                tty: session.tty,
                root_process: process_summary(&session.root_process),
                active_process: session.active_process.as_ref().map(process_summary),
                process_count: session.process_count,
                confidence: confidence.to_string(),
                match_reason: reason.to_string(),
            });
        }
    }
}

#[derive(Debug, Clone)]
struct TerminalSession {
    tty: String,
    root_process: ProcessInfo,
    active_process: Option<ProcessInfo>,
    process_count: usize,
    root_start_ticks: u64,
}

fn terminal_sessions_for_pid(
    terminal_pid: u32,
    processes: &[ProcessInfo],
    by_pid: &HashMap<u32, &ProcessInfo>,
) -> Vec<TerminalSession> {
    let mut grouped: BTreeMap<String, Vec<ProcessInfo>> = BTreeMap::new();
    for process in processes {
        if process.pid == terminal_pid || !is_descendant_of(process.pid, terminal_pid, by_pid) {
            continue;
        }
        for tty in &process.tty_paths {
            grouped
                .entry(tty.clone())
                .or_default()
                .push(process.clone());
        }
    }

    grouped
        .into_iter()
        .filter_map(|(tty, mut processes)| {
            processes.sort_by_key(|process| {
                (
                    process_depth(process.pid, terminal_pid, by_pid),
                    process.start_ticks,
                    process.pid,
                )
            });
            let root_process = processes.first()?.clone();
            let active_process = active_terminal_process(&processes);
            Some(TerminalSession {
                tty,
                root_start_ticks: root_process.start_ticks,
                process_count: processes.len(),
                root_process,
                active_process,
            })
        })
        .collect()
}

fn active_terminal_process(processes: &[ProcessInfo]) -> Option<ProcessInfo> {
    let same_tty_parents = processes
        .iter()
        .map(|process| process.ppid)
        .collect::<HashSet<_>>();
    processes
        .iter()
        .filter(|process| !same_tty_parents.contains(&process.pid))
        .max_by_key(|process| (process.start_ticks, process.pid))
        .cloned()
        .or_else(|| {
            processes
                .iter()
                .max_by_key(|process| (process.start_ticks, process.pid))
                .cloned()
        })
}

fn process_summary(process: &ProcessInfo) -> TerminalProcess {
    TerminalProcess {
        pid: process.pid,
        command_name: process.command_name.clone(),
        command_line: process.command_line.clone(),
        cwd: process.cwd.clone(),
    }
}

fn is_descendant_of(pid: u32, ancestor_pid: u32, by_pid: &HashMap<u32, &ProcessInfo>) -> bool {
    let mut current = pid;
    for _ in 0..128 {
        let Some(process) = by_pid.get(&current) else {
            return false;
        };
        if process.ppid == ancestor_pid {
            return true;
        }
        if process.ppid == 0 || process.ppid == current {
            return false;
        }
        current = process.ppid;
    }
    false
}

fn process_depth(pid: u32, ancestor_pid: u32, by_pid: &HashMap<u32, &ProcessInfo>) -> usize {
    let mut current = pid;
    for depth in 0..128 {
        let Some(process) = by_pid.get(&current) else {
            return usize::MAX;
        };
        if process.ppid == ancestor_pid {
            return depth;
        }
        if process.ppid == 0 || process.ppid == current {
            return usize::MAX;
        }
        current = process.ppid;
    }
    usize::MAX
}

fn looks_like_terminal_window(window: &WindowInfo) -> bool {
    uses_terminal_paste_shortcut(window)
        || window.title.as_deref().is_some_and(|title| {
            let title = title.to_ascii_lowercase();
            TERMINAL_TITLE_HINTS
                .iter()
                .any(|needle| title.contains(needle))
        })
}

pub(crate) fn uses_terminal_paste_shortcut(window: &WindowInfo) -> bool {
    window.terminal.is_some()
        || [window.app_id.as_deref(), window.wm_class.as_deref()]
            .into_iter()
            .flatten()
            .any(terminal_identity_matches)
}

fn terminal_identity_matches(value: &str) -> bool {
    let identity = value.trim().to_ascii_lowercase();
    let identity = identity.strip_suffix(".desktop").unwrap_or(&identity);
    TERMINAL_IDENTITIES.contains(&identity)
}

const TERMINAL_IDENTITIES: &[&str] = &[
    "alacritty",
    "com.gexperts.tilix",
    "com.mitchellh.ghostty",
    "com.system76.cosmicterm",
    "foot",
    "gnome-terminal",
    "gnome-terminal-server",
    "io.elementary.terminal",
    "kitty",
    "kgx",
    "konsole",
    "lxterminal",
    "mate-terminal",
    "org.codeberg.dnkl.foot",
    "org.gnome.console",
    "org.gnome.ptyxis",
    "org.gnome.terminal",
    "org.kde.konsole",
    "org.kde.yakuake",
    "org.lxqt.qterminal",
    "org.wezfurlong.wezterm",
    "ptyxis",
    "qterminal",
    "rxvt",
    "rxvt-unicode",
    "sakura",
    "terminator",
    "tilix",
    "urxvt",
    "uxterm",
    "wezterm",
    "wezterm-gui",
    "xfce4-terminal",
    "xterm",
    "yakuake",
];

const TERMINAL_TITLE_HINTS: &[&str] = &[
    "alacritty",
    "ghostty",
    "gnome terminal",
    "konsole",
    "kitty",
    "ptyxis",
    "wezterm",
    "xterm",
];

fn read_process_table() -> Vec<ProcessInfo> {
    let Ok(entries) = fs::read_dir("/proc") else {
        return Vec::new();
    };

    entries
        .flatten()
        .filter_map(|entry| {
            let pid = entry.file_name().to_string_lossy().parse::<u32>().ok()?;
            read_process_info(pid)
        })
        .collect()
}

fn read_process_info(pid: u32) -> Option<ProcessInfo> {
    let (ppid, start_ticks) = parse_stat(pid)?;
    let command_name = fs::read_to_string(format!("/proc/{pid}/comm"))
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| pid.to_string());
    let command_line = read_command_line(pid).unwrap_or_else(|| command_name.clone());
    let cwd = fs::read_link(format!("/proc/{pid}/cwd"))
        .ok()
        .map(path_to_string);
    let tty_paths = read_tty_paths(pid);

    Some(ProcessInfo {
        pid,
        ppid,
        start_ticks,
        command_name,
        command_line,
        cwd,
        tty_paths,
    })
}

fn parse_stat(pid: u32) -> Option<(u32, u64)> {
    let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    parse_stat_contents(&stat)
}

fn parse_stat_contents(stat: &str) -> Option<(u32, u64)> {
    let close_paren = stat.rfind(')')?;
    let fields = stat
        .get(close_paren + 2..)?
        .split_whitespace()
        .collect::<Vec<_>>();
    let ppid = fields.get(1)?.parse().ok()?;
    let start_ticks = fields.get(19)?.parse().ok()?;
    Some((ppid, start_ticks))
}

fn read_command_line(pid: u32) -> Option<String> {
    let bytes = fs::read(format!("/proc/{pid}/cmdline")).ok()?;
    let parts = bytes
        .split(|byte| *byte == 0)
        .filter(|part| !part.is_empty())
        .map(|part| String::from_utf8_lossy(part).into_owned())
        .collect::<Vec<_>>();
    (!parts.is_empty()).then(|| parts.join(" "))
}

fn read_tty_paths(pid: u32) -> Vec<String> {
    let Ok(entries) = fs::read_dir(format!("/proc/{pid}/fd")) else {
        return Vec::new();
    };
    let mut paths = entries
        .flatten()
        .filter_map(|entry| fs::read_link(entry.path()).ok())
        .filter_map(|path| {
            let value = path_to_string(path);
            value.starts_with("/dev/pts/").then_some(value)
        })
        .collect::<Vec<_>>();
    paths.sort();
    paths.dedup();
    paths
}

fn path_to_string(path: PathBuf) -> String {
    path.to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::windows::{WindowBounds, GNOME_SHELL_EXTENSION_BACKEND};

    fn terminal_window(window_id: u64, pid: u32) -> WindowInfo {
        WindowInfo {
            window_id,
            title: Some("Ghostty".to_string()),
            app_id: Some("com.mitchellh.ghostty.desktop".to_string()),
            wm_class: Some("com.mitchellh.ghostty".to_string()),
            pid: Some(pid),
            bounds: Some(WindowBounds {
                x: Some(0),
                y: Some(0),
                width: 800,
                height: 600,
            }),
            workspace: Some(0),
            focused: false,
            hidden: false,
            client_type: Some("wayland".to_string()),
            backend: GNOME_SHELL_EXTENSION_BACKEND.to_string(),
            terminal: None,
        }
    }

    fn process(
        pid: u32,
        ppid: u32,
        start_ticks: u64,
        command_name: &str,
        tty: Option<&str>,
    ) -> ProcessInfo {
        ProcessInfo {
            pid,
            ppid,
            start_ticks,
            command_name: command_name.to_string(),
            command_line: command_name.to_string(),
            cwd: Some("/home/user".to_string()),
            tty_paths: tty.into_iter().map(ToOwned::to_owned).collect(),
        }
    }

    #[test]
    fn assigns_terminal_sessions_by_window_and_pty_creation_order() {
        let mut windows = vec![terminal_window(11, 100), terminal_window(12, 100)];
        let processes = vec![
            process(100, 1, 1, "ghostty", None),
            process(200, 100, 10, "sh", Some("/dev/pts/0")),
            process(201, 200, 11, "zsh", Some("/dev/pts/0")),
            process(202, 201, 12, "claude", Some("/dev/pts/0")),
            process(300, 100, 20, "sh", Some("/dev/pts/1")),
            process(301, 300, 21, "zsh", Some("/dev/pts/1")),
            process(302, 301, 22, "codex", Some("/dev/pts/1")),
        ];

        enrich_terminal_windows_with_processes(&mut windows, &processes);

        let first = windows[0].terminal.as_ref().unwrap();
        assert_eq!(first.tty, "/dev/pts/0");
        assert_eq!(
            first.active_process.as_ref().unwrap().command_name,
            "claude"
        );
        assert_eq!(first.confidence, "heuristic");

        let second = windows[1].terminal.as_ref().unwrap();
        assert_eq!(second.tty, "/dev/pts/1");
        assert_eq!(
            second.active_process.as_ref().unwrap().command_name,
            "codex"
        );
    }

    #[test]
    fn leaves_terminal_context_empty_when_window_session_counts_do_not_match() {
        let mut windows = vec![terminal_window(11, 100), terminal_window(12, 100)];
        let processes = vec![
            process(100, 1, 1, "ghostty", None),
            process(200, 100, 10, "sh", Some("/dev/pts/0")),
            process(201, 200, 11, "zsh", Some("/dev/pts/0")),
        ];

        enrich_terminal_windows_with_processes(&mut windows, &processes);

        assert!(windows.iter().all(|window| window.terminal.is_none()));
    }

    #[test]
    fn terminal_paste_identity_matching_is_exact() {
        let mut window = terminal_window(11, 100);
        window.app_id = Some("com.example.footnotes".to_string());
        window.wm_class = Some("kitty-helper".to_string());

        assert!(!uses_terminal_paste_shortcut(&window));
    }

    #[test]
    fn terminal_paste_recognizes_common_terminal_identities() {
        for identity in [
            "org.kde.konsole",
            "org.gnome.Terminal",
            "org.gnome.Ptyxis",
            "kgx",
            "uxterm",
            "xfce4-terminal",
            "org.codeberg.dnkl.foot.desktop",
        ] {
            let mut window = terminal_window(11, 100);
            window.app_id = Some(identity.to_string());
            window.wm_class = None;
            assert!(
                uses_terminal_paste_shortcut(&window),
                "did not recognize {identity}"
            );
        }
    }

    #[test]
    fn terminal_paste_accepts_wm_class_or_enriched_pty_metadata() {
        let mut window = terminal_window(11, 100);
        window.app_id = None;
        window.wm_class = Some("qterminal".to_string());
        assert!(uses_terminal_paste_shortcut(&window));

        window.wm_class = None;
        window.terminal = Some(TerminalWindowContext {
            tty: "/dev/pts/11".to_string(),
            root_process: TerminalProcess {
                pid: 200,
                command_name: "bash".to_string(),
                command_line: "bash".to_string(),
                cwd: Some("/home/user".to_string()),
            },
            active_process: None,
            process_count: 1,
            confidence: "high".to_string(),
            match_reason: "test".to_string(),
        });
        assert!(uses_terminal_paste_shortcut(&window));
    }

    #[test]
    fn parses_proc_stat_with_parenthesized_command() {
        let stat =
            "123 (cmd with spaces) S 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 12345 26";

        assert_eq!(parse_stat_contents(stat), Some((7, 12345)));
    }
}
