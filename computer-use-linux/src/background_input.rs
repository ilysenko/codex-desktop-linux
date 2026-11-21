// SPDX-License-Identifier: MIT
//! Keyboard delivery that leaves the user's keyboard focus where it is.
//!
//! `type_text` and `press_key` with `delivery: "background"` never focus a
//! window. What the call names picks the route: an AT-SPI element (text goes
//! in through EditableText, a key that means an action runs that action), a
//! browser tab over a DevTools port the user opened (see `devtools`), or a
//! terminal whose program runs in tmux. This module holds the key mapping for
//! every route and the terminal route itself.

use crate::hyprland_input::KeyPress;
use anyhow::{anyhow, Context, Result};
use std::{
    collections::BTreeSet,
    fs,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::process::Command;

const TMUX_TIMEOUT: Duration = Duration::from_secs(5);
const LEGACY_TIOCSTI: &str = "/proc/sys/dev/tty/legacy_tiocsti";

/// A `press_key` chord in the shared grammar, as the background routes see it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Chord {
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
    pub meta: bool,
    /// The X keysym name on the unshifted level: `Return`, `space`, `a`,
    /// `F5`, or `Control_L` for a lone modifier.
    pub key: String,
}

impl Chord {
    pub(crate) fn from_key_press(press: &KeyPress) -> Self {
        let has = |name: &str| press.mods.split_whitespace().any(|part| part == name);
        Self {
            ctrl: has("CTRL"),
            alt: has("ALT"),
            shift: has("SHIFT"),
            meta: has("SUPER"),
            key: press.key.clone(),
        }
    }

    fn has_modifiers(&self) -> bool {
        self.ctrl || self.alt || self.shift || self.meta
    }

    fn is_lone_modifier(&self) -> bool {
        matches!(
            self.key.as_str(),
            "Control_L" | "Alt_L" | "Shift_L" | "Super_L"
        )
    }

    fn is_enter(&self) -> bool {
        matches!(self.key.as_str(), "Return" | "KP_Enter")
    }

    /// One lowercase ASCII letter or digit.
    fn character(&self) -> Option<char> {
        let mut chars = self.key.chars();
        let ch = chars.next()?;
        (chars.next().is_none() && (ch.is_ascii_lowercase() || ch.is_ascii_digit())).then_some(ch)
    }
}

/// Roles whose Enter and space both mean "press".
const PRESS_ROLES: &[&str] = &[
    "push button",
    "button",
    "menu item",
    "check menu item",
    "radio menu item",
];
/// Roles that space toggles. Enter on them differs between toolkits (GTK
/// toggles, a web page may submit the form), so only space maps.
const TOGGLE_ROLES: &[&str] = &["check box", "radio button", "toggle button", "switch"];
/// Single-line text roles that Enter activates.
const ENTRY_ROLES: &[&str] = &["entry", "text", "password text", "search box"];

/// The AT-SPI action a key means on an element, or why it means none. Only
/// keys whose effect does not depend on the toolkit map: Enter and space on
/// a button or menu item, space on a check box, radio button or toggle,
/// Enter on a link, and Enter on a single-line field with an `activate`
/// action. `actions` are the element's action names.
pub(crate) fn element_key_action(
    chord: &Chord,
    role: &str,
    states: &[String],
    actions: &[String],
) -> std::result::Result<String, String> {
    let role = role.trim().to_ascii_lowercase();
    if chord.has_modifiers() || chord.is_lone_modifier() {
        return Err(format!(
            "a chord with modifiers has no AT-SPI action on a {role}; background press_key on an element maps only Enter, KP_Enter and space"
        ));
    }
    let enter = chord.is_enter();
    let space = chord.key == "space";
    if !enter && !space {
        return Err(format!(
            "{} has no AT-SPI action on a {role}; background press_key on an element maps only Enter, KP_Enter and space",
            chord.key
        ));
    }
    let has_state = |name: &str| states.iter().any(|state| state.eq_ignore_ascii_case(name));
    let candidates: &[&str] = if PRESS_ROLES.contains(&role.as_str()) {
        &["click", "press", "activate"]
    } else if role == "link" && enter {
        &["jump", "click", "press", "activate"]
    } else if TOGGLE_ROLES.contains(&role.as_str()) && space {
        &["toggle", "click", "press", "check", "uncheck", "activate"]
    } else if ENTRY_ROLES.contains(&role.as_str()) && enter {
        if !has_state("single-line") || has_state("multi-line") {
            return Err(format!(
                "Enter in a {role} that is not marked single-line could insert a line break instead of submitting, so it has no mapped action"
            ));
        }
        &["activate"]
    } else {
        let key = if enter { "Enter" } else { "space" };
        return Err(format!(
            "{key} on a {role} has no unambiguous AT-SPI action; background press_key maps Enter and space on buttons and menu items, space on check boxes, radio buttons and toggles, Enter on links, and Enter on single-line fields with an activate action"
        ));
    };
    candidates
        .iter()
        .find_map(|candidate| {
            actions
                .iter()
                .find(|action| action.trim().eq_ignore_ascii_case(candidate))
        })
        .cloned()
        .ok_or_else(|| {
            format!(
                "the {role} exposes none of the actions this key means ({}); its actions: {}",
                candidates.join(", "),
                if actions.is_empty() {
                    "none".to_string()
                } else {
                    actions.join(", ")
                }
            )
        })
}

/// The tmux `send-keys` name of a chord.
pub(crate) fn tmux_key(chord: &Chord) -> std::result::Result<String, String> {
    if chord.meta {
        return Err("tmux has no Super modifier".to_string());
    }
    if chord.is_lone_modifier() {
        return Err("a lone modifier sends nothing to a terminal".to_string());
    }
    let mut shift = chord.shift;
    let base = if let Some(ch) = chord.character() {
        if shift && ch.is_ascii_digit() {
            return Err(
                "Shift with a digit depends on the keyboard layout; type the symbol with type_text"
                    .to_string(),
            );
        }
        if shift {
            shift = false;
            ch.to_ascii_uppercase().to_string()
        } else {
            ch.to_string()
        }
    } else {
        match chord.key.as_str() {
            "Return" => "Enter",
            "KP_Enter" => "KPEnter",
            "Escape" => "Escape",
            "Tab" if shift && !chord.ctrl && !chord.alt => {
                shift = false;
                "BTab"
            }
            "Tab" => "Tab",
            "BackSpace" => "BSpace",
            "Delete" => "DC",
            "space" => "Space",
            "Home" => "Home",
            "End" => "End",
            "Prior" => "PPage",
            "Next" => "NPage",
            "Left" => "Left",
            "Right" => "Right",
            "Up" => "Up",
            "Down" => "Down",
            key if is_function_key(key) => key,
            other => return Err(format!("{other} has no tmux key name")),
        }
        .to_string()
    };
    let mut name = String::new();
    if chord.ctrl {
        name.push_str("C-");
    }
    if chord.alt {
        name.push_str("M-");
    }
    if shift {
        name.push_str("S-");
    }
    name.push_str(&base);
    Ok(name)
}

fn is_function_key(key: &str) -> bool {
    key.strip_prefix('F')
        .and_then(|n| n.parse::<u8>().ok())
        .is_some_and(|n| (1..=12).contains(&n))
}

/// The bytes a terminal sends for a chord, for TIOCSTI. Function keys and
/// Super depend on the terminal's own settings and are refused.
pub(crate) fn tty_key_bytes(chord: &Chord) -> std::result::Result<Vec<u8>, String> {
    if chord.meta || chord.is_lone_modifier() {
        return Err("Super and lone modifiers send nothing a terminal can read".to_string());
    }
    let mut bytes = if let Some(ch) = chord.character() {
        if chord.ctrl {
            if !ch.is_ascii_lowercase() {
                return Err("Ctrl with a digit has no fixed terminal byte".to_string());
            }
            vec![(ch as u8) & 0x1f]
        } else if chord.shift {
            if ch.is_ascii_digit() {
                return Err(
                    "Shift with a digit depends on the keyboard layout; type the symbol with type_text"
                        .to_string(),
                );
            }
            vec![ch.to_ascii_uppercase() as u8]
        } else {
            vec![ch as u8]
        }
    } else {
        if chord.ctrl || (chord.shift && chord.key != "Tab") {
            return Err(format!(
                "{} with Ctrl or Shift has no fixed terminal sequence",
                chord.key
            ));
        }
        match chord.key.as_str() {
            "Return" | "KP_Enter" => b"\r".to_vec(),
            "Tab" if chord.shift => b"\x1b[Z".to_vec(),
            "Tab" => b"\t".to_vec(),
            "Escape" => b"\x1b".to_vec(),
            "BackSpace" => b"\x7f".to_vec(),
            "Delete" => b"\x1b[3~".to_vec(),
            "space" => b" ".to_vec(),
            "Home" => b"\x1b[H".to_vec(),
            "End" => b"\x1b[F".to_vec(),
            "Prior" => b"\x1b[5~".to_vec(),
            "Next" => b"\x1b[6~".to_vec(),
            "Up" => b"\x1b[A".to_vec(),
            "Down" => b"\x1b[B".to_vec(),
            "Right" => b"\x1b[C".to_vec(),
            "Left" => b"\x1b[D".to_vec(),
            other => return Err(format!("{other} has no fixed terminal sequence")),
        }
    };
    if chord.alt {
        bytes.insert(0, 0x1b);
    }
    Ok(bytes)
}

/// The background routes this environment can use, for doctor. Terminal
/// routes need their tool on PATH; whether a given terminal uses one is
/// decided per call.
pub(crate) fn available_routes(at_spi: bool) -> Vec<String> {
    let in_path = |name: &str| {
        std::env::var_os("PATH")
            .is_some_and(|path| std::env::split_paths(&path).any(|dir| dir.join(name).is_file()))
    };
    let mut routes = Vec::new();
    if at_spi {
        routes.push("at_spi");
    }
    if crate::devtools::configured_port().is_ok() {
        routes.push("devtools");
    }
    if in_path("kitten") || in_path("kitty") {
        routes.push("kitty");
    }
    for tool in ["wezterm", "tmux", "screen"] {
        if in_path(tool) {
            routes.push(tool);
        }
    }
    if legacy_tiocsti_enabled() == Some(true) && has_cap_sys_admin() {
        routes.push("tiocsti");
    }
    let hyprland = std::env::var("XDG_CURRENT_DESKTOP").is_ok_and(|desktop| {
        desktop
            .split(':')
            .any(|part| part.eq_ignore_ascii_case("hyprland"))
    });
    if hyprland && crate::hyprland_input::background_enabled() {
        routes.push("hyprland");
    }
    if crate::agent_seat::availability().is_ok() {
        routes.push("seat");
    }
    routes.into_iter().map(str::to_string).collect()
}

/// `/dev/pts/N` for a tty selector: `/dev/pts/N`, `pts/N` or `N`.
pub(crate) fn tty_path(tty: &str) -> std::result::Result<PathBuf, String> {
    let tty = tty.trim();
    let number = tty
        .strip_prefix("/dev/pts/")
        .or_else(|| tty.strip_prefix("pts/"))
        .unwrap_or(tty);
    if number.is_empty() || !number.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(format!(
            "tty {tty:?} is not a pseudo-terminal: pass /dev/pts/N, pts/N or N"
        ));
    }
    Ok(PathBuf::from(format!("/dev/pts/{number}")))
}

/// The pseudo-terminal a process reads from: its stdin, when that is a pts.
pub(crate) fn process_tty(pid: u32) -> Option<PathBuf> {
    let (_, tty, _) = read_process(pid)?;
    let path = pts_path(tty?)?;
    // The pts must be this namespace's: the process holds it open.
    process_holds_tty(pid, &path).then_some(path)
}

/// `/dev/pts/N` for Unix98 pty device numbers (majors 136 to 143).
fn pts_path((major, minor): TtyNumbers) -> Option<PathBuf> {
    (136..=143)
        .contains(&major)
        .then(|| PathBuf::from(format!("/dev/pts/{}", (major - 136) * 256 + minor)))
}

/// The pts number of a `/dev/pts/N` path.
fn pts_number(tty: &Path) -> Option<u32> {
    tty.to_str()?.strip_prefix("/dev/pts/")?.parse().ok()
}

/// Whether one of the process's standard fds is this very tty: the same
/// device on the same devpts instance, so a container's pts with the same
/// number does not count.
fn process_holds_tty(pid: u32, tty: &Path) -> bool {
    let Ok(want) = fs::metadata(tty) else {
        return false;
    };
    (0..3).any(|fd| {
        fs::metadata(format!("/proc/{pid}/fd/{fd}"))
            .is_ok_and(|have| have.dev() == want.dev() && have.rdev() == want.rdev())
    })
}

fn same_mount_namespace(pid: u32) -> bool {
    match (
        fs::read_link(format!("/proc/{pid}/ns/mnt")),
        fs::read_link("/proc/self/ns/mnt"),
    ) {
        (Ok(theirs), Ok(ours)) => theirs == ours,
        _ => false,
    }
}

/// A tmux pane that background input reaches.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TmuxPane {
    pub socket: PathBuf,
    pub pane_id: String,
    /// The tty was a tmux client's, and the pane is that client's active one.
    pub through_client: bool,
}

/// The tmux pane that owns `tty`: a pane whose own tty it is, or the active
/// pane of the tmux client attached on it. Servers are found through the
/// processes on the tty: a pane's programs carry `TMUX` with the socket, and a
/// client names its socket with `-S`/`-L` or uses the default one.
async fn tmux_pane_for_processes(tty: &Path, processes: &[TtyProcess]) -> Option<TmuxPane> {
    let sockets = tmux_sockets(processes);
    let tty_name = tty.to_string_lossy().to_string();
    for socket in &sockets {
        if let Some(pane) = find_line(
            socket,
            &["list-panes", "-a", "-F", "#{pane_tty}\t#{pane_id}"],
            &tty_name,
        )
        .await
        {
            return Some(TmuxPane {
                socket: socket.clone(),
                pane_id: pane,
                through_client: false,
            });
        }
        if let Some(pane) = find_line(
            socket,
            &["list-clients", "-F", "#{client_tty}\t#{pane_id}"],
            &tty_name,
        )
        .await
        {
            return Some(TmuxPane {
                socket: socket.clone(),
                pane_id: pane,
                through_client: true,
            });
        }
    }
    None
}

async fn find_line(socket: &Path, args: &[&str], tty: &str) -> Option<String> {
    let output = tmux(socket, args).await.ok()?;
    parse_tty_table(&output, tty)
}

/// The value after a tab on the line whose first field is `tty`.
fn parse_tty_table(output: &str, tty: &str) -> Option<String> {
    output.lines().find_map(|line| {
        let (first, value) = line.split_once('\t')?;
        (first == tty && !value.trim().is_empty()).then(|| value.trim().to_string())
    })
}

fn tmux_sockets(processes: &[TtyProcess]) -> Vec<PathBuf> {
    let mut sockets = BTreeSet::new();
    for process in processes {
        let pid = process.pid;
        let environ = &process.environ;
        if let Some(socket) = environ_value(environ, "TMUX")
            .and_then(|value| value.split(',').next().map(str::to_string))
            .filter(|socket| !socket.is_empty())
        {
            sockets.insert(PathBuf::from(socket));
        }
        // A client renames itself "tmux: client".
        if process.comm == "tmux" || process.comm == "tmux: client" {
            let tmpdir = environ_value(environ, "TMUX_TMPDIR");
            if let Some(socket) = tmux_client_socket(&process.args, tmpdir.as_deref(), uid_of(pid))
            {
                sockets.insert(socket);
            }
        }
    }
    sockets
        .into_iter()
        .filter(|socket| socket.exists())
        .collect()
}

fn uid_of(pid: u32) -> u32 {
    fs::metadata(format!("/proc/{pid}"))
        .map(|metadata| metadata.uid())
        // SAFETY: getuid cannot fail.
        .unwrap_or_else(|_| unsafe { libc::getuid() })
}

/// The controlling tty of a `/proc/<pid>/stat` line as (major, minor).
fn stat_tty(stat: &str) -> Option<(u32, u32)> {
    let after = &stat[stat.rfind(')')? + 1..];
    let tty_nr: u32 = after.split_whitespace().nth(4)?.parse().ok()?;
    if tty_nr == 0 {
        return None;
    }
    let major = (tty_nr >> 8) & 0xfff;
    let minor = (tty_nr & 0xff) | ((tty_nr >> 12) & 0xfff00);
    Some((major, minor))
}

fn environ_value(environ: &[u8], name: &str) -> Option<String> {
    environ.split(|byte| *byte == 0).find_map(|entry| {
        let entry = std::str::from_utf8(entry).ok()?;
        let (key, value) = entry.split_once('=')?;
        (key == name).then(|| value.to_string())
    })
}

/// The server socket a tmux client command line connects to, as tmux picks
/// it: `-S path`, else `-L name` (default `default`) under
/// `$TMUX_TMPDIR/tmux-UID`, where an unset `TMUX_TMPDIR` means /tmp.
fn tmux_client_socket(args: &[String], tmpdir: Option<&str>, uid: u32) -> Option<PathBuf> {
    let mut path = None;
    let mut name = None;
    let mut iter = args.iter().skip(1);
    while let Some(arg) = iter.next() {
        if !arg.starts_with('-') || arg == "--" {
            break;
        }
        // Flags cluster as in getopt: -2uS path, -Lname.
        let flags = &arg[1..];
        for (index, flag) in flags.char_indices() {
            if flag == 'S' || flag == 'L' || flag == 'f' || flag == 'c' || flag == 'T' {
                let rest = &flags[index + 1..];
                let value = if rest.is_empty() {
                    iter.next().cloned()
                } else {
                    Some(rest.to_string())
                };
                match flag {
                    'S' => path = value,
                    'L' => name = value,
                    _ => {}
                }
                break;
            }
        }
    }
    if let Some(path) = path {
        return Some(PathBuf::from(path));
    }
    let dir = tmpdir.filter(|dir| !dir.is_empty()).unwrap_or("/tmp");
    Some(PathBuf::from(format!(
        "{}/tmux-{uid}/{}",
        dir.trim_end_matches('/'),
        name.unwrap_or_else(|| "default".to_string())
    )))
}

async fn tmux(socket: &Path, args: &[&str]) -> Result<String> {
    let mut command = Command::new("tmux");
    command.arg("-S").arg(socket).args(args);
    let output =
        crate::command_runner::output_with_timeout(command, "run tmux", TMUX_TIMEOUT).await?;
    if !output.status.success() {
        return Err(anyhow!(
            "tmux {} failed: {}",
            args.first().copied().unwrap_or_default(),
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Paste `text` into the pane as typed input. The text goes through a named
/// tmux buffer on stdin, never a process argument, and the buffer is deleted
/// after the paste. tmux turns each line feed into Enter.
pub(crate) async fn tmux_send_text(pane: &TmuxPane, text: &str) -> Result<()> {
    let buffer = format!("cul-{:016x}", getrandom::u64().unwrap_or_default());
    let mut command = Command::new("tmux");
    command
        .arg("-S")
        .arg(&pane.socket)
        .args(["load-buffer", "-b", &buffer, "-"]);
    let output = crate::command_runner::output_with_stdin(
        command,
        "run tmux load-buffer",
        TMUX_TIMEOUT,
        text.as_bytes().to_vec(),
    )
    .await?;
    if !output.status.success() {
        return Err(anyhow!(
            "tmux load-buffer failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    if let Err(error) = tmux(
        &pane.socket,
        &["paste-buffer", "-d", "-b", &buffer, "-t", &pane.pane_id],
    )
    .await
    {
        let _ = tmux(&pane.socket, &["delete-buffer", "-b", &buffer]).await;
        return Err(error);
    }
    Ok(())
}

pub(crate) async fn tmux_send_key(pane: &TmuxPane, key: &str) -> Result<()> {
    tmux(&pane.socket, &["send-keys", "-t", &pane.pane_id, key])
        .await
        .map(|_| ())
}

/// `dev.tty.legacy_tiocsti`: `Some(true)` when the kernel still lets a
/// process push input into a tty with TIOCSTI.
pub(crate) fn legacy_tiocsti_enabled() -> Option<bool> {
    parse_legacy_tiocsti(&fs::read_to_string(LEGACY_TIOCSTI).ok()?)
}

/// The server's own controlling tty, where TIOCSTI needs no capability.
fn own_controlling_tty() -> Option<TtyNumbers> {
    stat_tty(&fs::read_to_string("/proc/self/stat").ok()?)
}

/// Whether `pid` is `ancestor` or one of its descendants.
pub(crate) fn is_same_or_descendant(pid: u32, ancestor: u32) -> bool {
    let mut current = pid;
    for _ in 0..64 {
        if current == ancestor {
            return true;
        }
        match read_process(current) {
            Some((parent, _, _)) if parent > 1 && parent != current => current = parent,
            _ => return false,
        }
    }
    false
}

/// Whether this process has CAP_SYS_ADMIN in its effective set.
fn has_cap_sys_admin() -> bool {
    fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|status| effective_caps(&status))
        .is_some_and(|caps| caps & (1 << 21) != 0)
}

fn effective_caps(status: &str) -> Option<u64> {
    status
        .lines()
        .find_map(|line| u64::from_str_radix(line.strip_prefix("CapEff:")?.trim(), 16).ok())
}

fn parse_legacy_tiocsti(value: &str) -> Option<bool> {
    match value.trim() {
        "0" => Some(false),
        "1" => Some(true),
        _ => None,
    }
}

/// Push `bytes` into the tty's input queue with TIOCSTI, one byte per call.
/// The kernel allows it only on the caller's controlling tty or with
/// CAP_SYS_ADMIN, so the error names both.
pub(crate) fn tiocsti_send(tty: &Path, bytes: &[u8]) -> std::result::Result<(), String> {
    use std::os::unix::{fs::OpenOptionsExt, io::AsRawFd};
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .custom_flags(libc::O_NOCTTY | libc::O_NONBLOCK)
        .open(tty)
        .map_err(|error| format!("cannot open {}: {error}", tty.display()))?;
    for (index, byte) in bytes.iter().enumerate() {
        // SAFETY: TIOCSTI reads one byte from a valid pointer.
        let result = unsafe { libc::ioctl(file.as_raw_fd(), libc::TIOCSTI, byte as *const u8) };
        if result != 0 {
            let error = std::io::Error::last_os_error();
            let sent = if index == 0 {
                "nothing was sent".to_string()
            } else {
                format!("{index} of {} bytes were sent", bytes.len())
            };
            if error.raw_os_error() == Some(libc::EPERM) {
                return Err(format!(
                    "the kernel refused TIOCSTI on {} ({error}): it allows it only on the caller's own controlling terminal or with CAP_SYS_ADMIN; {sent}",
                    tty.display()
                ));
            }
            return Err(format!(
                "TIOCSTI on {} failed: {error}; {sent}",
                tty.display()
            ));
        }
    }
    Ok(())
}

/// A process whose controlling terminal is the target tty.
#[derive(Debug, Clone)]
struct TtyProcess {
    pid: u32,
    comm: String,
    args: Vec<String>,
    environ: Vec<u8>,
}

fn tty_numbers(tty: &Path) -> Result<(u32, u32)> {
    let rdev = fs::metadata(tty)
        .with_context(|| format!("cannot read {}", tty.display()))?
        .rdev();
    Ok((libc::major(rdev), libc::minor(rdev)))
}

/// A tty's (major, minor) device numbers.
type TtyNumbers = (u32, u32);

/// A process's parent pid, controlling tty and command name.
fn read_process(pid: u32) -> Option<(u32, Option<TtyNumbers>, String)> {
    let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let comm = stat[stat.find('(')? + 1..stat.rfind(')')?].to_string();
    let ppid = stat[stat.rfind(')')? + 1..]
        .split_whitespace()
        .nth(1)?
        .parse()
        .ok()?;
    Some((ppid, stat_tty(&stat), comm))
}

fn all_pids() -> Vec<u32> {
    fs::read_dir("/proc")
        .map(|entries| {
            entries
                .flatten()
                .filter_map(|entry| entry.file_name().to_str()?.parse().ok())
                .collect()
        })
        .unwrap_or_default()
}

fn process_args(pid: u32) -> Vec<String> {
    fs::read(format!("/proc/{pid}/cmdline"))
        .unwrap_or_default()
        .split(|byte| *byte == 0)
        .filter(|arg| !arg.is_empty())
        .map(|arg| String::from_utf8_lossy(arg).to_string())
        .collect()
}

fn processes_on_tty(tty: &Path, major: u32, minor: u32) -> Vec<TtyProcess> {
    all_pids()
        .into_iter()
        .filter_map(|pid| {
            let (_, ctty, comm) = read_process(pid)?;
            (ctty == Some((major, minor)) && process_holds_tty(pid, tty)).then(|| TtyProcess {
                pid,
                comm,
                args: process_args(pid),
                environ: fs::read(format!("/proc/{pid}/environ")).unwrap_or_default(),
            })
        })
        .collect()
}

/// The terminal emulator holding the tty's pty master: its pid, name, and the
/// master's fd number in it. Found through `fdinfo`'s `tty-index`.
fn pty_master_holder(index: u32) -> Option<(u32, String, i32)> {
    all_pids().into_iter().find_map(|pid| {
        // A tty-index is per devpts instance; another mount namespace may
        // have its own pts with the same number.
        if !same_mount_namespace(pid) {
            return None;
        }
        let fds = fs::read_dir(format!("/proc/{pid}/fd")).ok()?;
        for fd in fds.flatten() {
            let Ok(target) = fs::read_link(fd.path()) else {
                continue;
            };
            if !matches!(target.to_str(), Some("/dev/ptmx" | "/dev/pts/ptmx")) {
                continue;
            }
            let number = fd.file_name().to_str()?.parse::<i32>().ok()?;
            let info =
                fs::read_to_string(format!("/proc/{pid}/fdinfo/{number}")).unwrap_or_default();
            if fdinfo_tty_index(&info) == Some(index) {
                let comm = read_process(pid)
                    .map(|(_, _, comm)| comm)
                    .unwrap_or_default();
                return Some((pid, comm, number));
            }
        }
        None
    })
}

fn fdinfo_tty_index(info: &str) -> Option<u32> {
    info.lines().find_map(|line| {
        line.strip_prefix("tty-index:")
            .and_then(|value| value.trim().parse().ok())
    })
}

/// How background input reaches the program on a tty, best first.
#[derive(Debug)]
pub(crate) enum TerminalChannel {
    /// kitty remote control over its `listen_on` socket.
    Kitty {
        socket: String,
        window_id: u64,
    },
    /// `wezterm cli` over the mux socket.
    Wezterm {
        socket: String,
        pane_id: u64,
    },
    Tmux(TmuxPane),
    /// A GNU screen session; `window` is the screen window on the tty, or
    /// `None` for the session's current window when the tty is a client.
    Screen {
        session: String,
        window: Option<String>,
    },
    /// TIOCSTI, where `dev.tty.legacy_tiocsti` is 1.
    Tiocsti,
    /// A copy of the emulator's pty master through `pidfd_getfd`, where
    /// ptrace rules allow it.
    PtyMaster {
        holder: u32,
        fd: std::os::fd::OwnedFd,
    },
}

impl TerminalChannel {
    pub(crate) fn describe(&self) -> String {
        match self {
            TerminalChannel::Kitty { window_id, .. } => {
                format!("kitty remote control (window id {window_id})")
            }
            TerminalChannel::Wezterm { pane_id, .. } => format!("wezterm cli (pane {pane_id})"),
            TerminalChannel::Tmux(pane) => format!(
                "tmux (pane {}{})",
                pane.pane_id,
                if pane.through_client {
                    ", the active pane of the client on this tty"
                } else {
                    ""
                }
            ),
            TerminalChannel::Screen { session, window } => match window {
                Some(window) => format!("GNU screen (session {session}, window {window})"),
                None => format!("GNU screen (session {session}, its current window)"),
            },
            TerminalChannel::Tiocsti => "TIOCSTI".to_string(),
            TerminalChannel::PtyMaster { holder, .. } => {
                format!("the pty master of pid {holder} (pidfd_getfd)")
            }
        }
    }
}

/// What the terminal probe found: a channel, or what was found on the way,
/// for the refusal.
#[derive(Debug, Default)]
pub(crate) struct TerminalProbe {
    pub channel: Option<TerminalChannel>,
    /// The emulator holding the pty master, by name and pid.
    pub emulator: Option<(String, u32)>,
    /// Why channels that looked possible were not usable.
    pub notes: Vec<String>,
}

impl TerminalProbe {
    pub(crate) fn refusal(&self, tty: &Path) -> String {
        let mut message = format!(
            "nothing reaches the program on {} without focusing its window",
            tty.display()
        );
        if let Some((name, pid)) = &self.emulator {
            message.push_str(&format!(" (its terminal is {name}, pid {pid})"));
        }
        message.push_str(": ");
        message.push_str(&self.notes.join("; "));
        message.push_str(
            ". A route opens with kitty remote control (allow_remote_control yes and listen_on), wezterm, or the program running in tmux or GNU screen",
        );
        message
    }
}

/// Find how to reach the program on `tty` without focus. Channels, in order:
/// the emulator's remote control (kitty, wezterm), tmux, GNU screen,
/// TIOCSTI, and the emulator's pty master. Writing to the pts itself would
/// only print on the screen, so it is never a channel.
pub(crate) async fn probe_terminal(tty: &Path) -> Result<TerminalProbe> {
    let (major, minor) = tty_numbers(tty)?;
    let processes = processes_on_tty(tty, major, minor);
    let holder = pts_number(tty).and_then(pty_master_holder);
    let mut probe = TerminalProbe {
        emulator: holder.as_ref().map(|(pid, name, _)| (name.clone(), *pid)),
        ..TerminalProbe::default()
    };
    let env = |name: &str| {
        processes
            .iter()
            .find_map(|process| environ_value(&process.environ, name).filter(|v| !v.is_empty()))
    };
    let emulator_name = holder
        .as_ref()
        .map(|(_, name, _)| name.to_ascii_lowercase())
        .unwrap_or_default();

    // kitty exports KITTY_LISTEN_ON to its children when listen_on is set.
    let kitty_window = env("KITTY_WINDOW_ID").and_then(|id| id.parse::<u64>().ok());
    if let Some(socket) = env("KITTY_LISTEN_ON") {
        match kitty_window_for_tty(&socket, tty, major, minor).await {
            Ok(Some(window_id)) => {
                probe.channel = Some(TerminalChannel::Kitty { socket, window_id });
                return Ok(probe);
            }
            Ok(None) => probe
                .notes
                .push("kitty remote control lists no window on this tty".to_string()),
            Err(error) => probe.notes.push(format!(
                "kitty remote control failed ({error:#}); set allow_remote_control yes in kitty.conf"
            )),
        }
    } else if kitty_window.is_some() || emulator_name.contains("kitty") {
        probe.notes.push(
            "kitty runs this terminal without a remote-control socket; set allow_remote_control yes and listen_on (for example unix:@kitty) in kitty.conf, then open a new kitty".to_string(),
        );
    }

    if let Some(socket) = env("WEZTERM_UNIX_SOCKET") {
        match wezterm_pane_for_tty(&socket, tty).await {
            Ok(Some(pane_id)) => {
                probe.channel = Some(TerminalChannel::Wezterm { socket, pane_id });
                return Ok(probe);
            }
            Ok(None) => probe
                .notes
                .push("wezterm cli lists no pane on this tty".to_string()),
            Err(error) => probe.notes.push(format!("wezterm cli failed ({error:#})")),
        }
    }

    if emulator_name.contains("ghostty") {
        probe
            .notes
            .push("Ghostty has no command that sends input to a terminal on Linux".to_string());
    } else if emulator_name.contains("konsole") {
        probe
            .notes
            .push("Konsole's D-Bus input route is not supported yet".to_string());
    } else if emulator_name.contains("gnome-terminal") || emulator_name.contains("ptyxis") {
        probe.notes.push(format!(
            "{emulator_name} has no command that sends input to a terminal"
        ));
    }

    match tmux_pane_for_processes(tty, &processes).await {
        Some(pane) => {
            probe.channel = Some(TerminalChannel::Tmux(pane));
            return Ok(probe);
        }
        None => probe
            .notes
            .push("no tmux pane or client is on it".to_string()),
    }

    if let Some(channel) = screen_channel(&processes) {
        probe.channel = Some(channel);
        return Ok(probe);
    }
    if processes
        .iter()
        .any(|process| environ_value(&process.environ, "STY").is_some())
    {
        probe.notes.push(
            "it is inside GNU screen, whose window numbers cannot be tied to a tty; pass the tty of the terminal the screen client runs in".to_string(),
        );
    }

    match legacy_tiocsti_enabled() {
        // The server is never on the target's controlling tty, and on any
        // other tty the kernel allows TIOCSTI only with CAP_SYS_ADMIN.
        Some(true) if has_cap_sys_admin() || own_controlling_tty() == Some((major, minor)) => {
            probe.channel = Some(TerminalChannel::Tiocsti);
            return Ok(probe);
        }
        Some(true) => probe.notes.push(
            "TIOCSTI into another terminal needs CAP_SYS_ADMIN, which this server does not have"
                .to_string(),
        ),
        Some(false) => probe
            .notes
            .push("the kernel disables TIOCSTI (dev.tty.legacy_tiocsti = 0)".to_string()),
        None => probe
            .notes
            .push("dev.tty.legacy_tiocsti could not be read".to_string()),
    }

    if let Some((pid, name, fd)) = holder {
        match pidfd_getfd(pid, fd) {
            Ok(fd) => {
                probe.channel = Some(TerminalChannel::PtyMaster { holder: pid, fd });
                return Ok(probe);
            }
            Err(error) => probe.notes.push(format!(
                "the kernel does not let this process take {name}'s pty master ({error}; ptrace rules such as kernel.yama.ptrace_scope decide)"
            )),
        }
    } else {
        probe
            .notes
            .push("no process holding the pty master was found".to_string());
    }
    Ok(probe)
}

async fn run_tool(
    program: &str,
    args: &[&str],
    envs: &[(&str, &str)],
    input: Option<&[u8]>,
) -> Result<String> {
    let mut command = Command::new(program);
    command.args(args);
    for (key, value) in envs {
        command.env(key, value);
    }
    let action = format!("run {program}");
    let output = match input {
        Some(input) => {
            crate::command_runner::output_with_stdin(command, &action, TMUX_TIMEOUT, input.to_vec())
                .await?
        }
        None => crate::command_runner::output_with_timeout(command, &action, TMUX_TIMEOUT).await?,
    };
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        return Err(anyhow!(
            "{program} {} failed: {}",
            args.iter()
                .find(|arg| !arg.starts_with('-') && !arg.contains('/') && !arg.contains('@'))
                .copied()
                .unwrap_or_default(),
            if stderr.is_empty() { stdout } else { stderr }
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// The kitty client: `kitten` when installed, else `kitty`.
fn kitty_client() -> (&'static str, &'static [&'static str]) {
    let in_path = |name: &str| {
        std::env::var_os("PATH")
            .is_some_and(|path| std::env::split_paths(&path).any(|dir| dir.join(name).is_file()))
    };
    if in_path("kitten") {
        ("kitten", &["@"])
    } else {
        ("kitty", &["@"])
    }
}

async fn kitty(socket: &str, args: &[&str], input: Option<&[u8]>) -> Result<String> {
    let (program, prefix) = kitty_client();
    let mut all = prefix.to_vec();
    all.extend(["--to", socket]);
    all.extend_from_slice(args);
    run_tool(program, &all, &[], input).await
}

/// The kitty window whose shell runs on the tty, from `kitty @ ls`.
async fn kitty_window_for_tty(
    socket: &str,
    tty: &Path,
    major: u32,
    minor: u32,
) -> Result<Option<u64>> {
    let listing = kitty(socket, &["ls"], None).await?;
    let value: serde_json::Value =
        serde_json::from_str(&listing).context("kitty @ ls returned unreadable JSON")?;
    Ok(kitty_window_in_listing(&value, |pid| {
        read_process(pid).and_then(|(_, tty, _)| tty) == Some((major, minor))
            || process_tty(pid).as_deref() == Some(tty)
    }))
}

fn kitty_window_in_listing(value: &serde_json::Value, on_tty: impl Fn(u32) -> bool) -> Option<u64> {
    let empty = Vec::new();
    for os_window in value.as_array().unwrap_or(&empty) {
        for tab in os_window["tabs"].as_array().unwrap_or(&empty) {
            for window in tab["windows"].as_array().unwrap_or(&empty) {
                let mut pids = window["foreground_processes"]
                    .as_array()
                    .unwrap_or(&empty)
                    .iter()
                    .filter_map(|process| process["pid"].as_u64())
                    .collect::<Vec<_>>();
                pids.extend(window["pid"].as_u64());
                if pids.into_iter().any(|pid| on_tty(pid as u32)) {
                    return window["id"].as_u64();
                }
            }
        }
    }
    None
}

async fn wezterm_pane_for_tty(socket: &str, tty: &Path) -> Result<Option<u64>> {
    let listing = run_tool(
        "wezterm",
        &["cli", "list", "--format", "json"],
        &[("WEZTERM_UNIX_SOCKET", socket)],
        None,
    )
    .await?;
    let value: serde_json::Value =
        serde_json::from_str(&listing).context("wezterm cli list returned unreadable JSON")?;
    Ok(wezterm_pane_in_listing(&value, &tty.to_string_lossy()))
}

fn wezterm_pane_in_listing(value: &serde_json::Value, tty: &str) -> Option<u64> {
    value.as_array()?.iter().find_map(|pane| {
        (pane["tty_name"].as_str() == Some(tty))
            .then(|| pane["pane_id"].as_u64())
            .flatten()
    })
}

/// A GNU screen window on the tty (its programs carry `STY` and `WINDOW`),
/// or a screen client whose server it started.
fn screen_channel(processes: &[TtyProcess]) -> Option<TerminalChannel> {
    // STY and WINDOW are inherited, so a terminal started inside a screen
    // window carries them too. The tty is a screen window only when the
    // session's own SCREEN process holds its pty master.
    // A screen window's own tty is refused: screen's window numbers can be
    // swapped without updating WINDOW in the programs, so the number cannot
    // be trusted to name this tty. Its client's tty is used instead.
    let clients = processes
        .iter()
        .filter(|process| process.comm == "screen")
        .map(|process| process.pid)
        .collect::<Vec<_>>();
    if clients.is_empty() {
        return None;
    }
    // The server a client started is its child; it names itself SCREEN in
    // its arguments (its comm stays screen).
    let (server, client) = all_pids().into_iter().find_map(|pid| {
        let (ppid, _, _) = read_process(pid)?;
        let server = process_args(pid)
            .first()
            .is_some_and(|arg0| arg0 == "SCREEN");
        (server && clients.contains(&ppid)).then_some((pid, ppid))
    })?;
    // A remote command goes to one of the session's displays, and screen
    // does not say which. Use the session only when no other client could
    // be attached to it.
    let name = screen_session_name(&process_args(server));
    let other = all_pids().into_iter().any(|pid| {
        pid != client
            && pid != server
            && read_process(pid).is_some_and(|(_, _, comm)| comm == "screen")
            && screen_client_may_attach(&process_args(pid), server, name.as_deref())
    });
    (!other).then(|| TerminalChannel::Screen {
        session: server.to_string(),
        window: None,
    })
}

/// The -S name a screen server was started with.
fn screen_session_name(args: &[String]) -> Option<String> {
    let index = args.iter().position(|arg| arg == "-S")?;
    args.get(index + 1).cloned()
}

/// Whether a screen client's command line could attach it to the session
/// of server (named name): it reattaches (-r, -R, -x, -d, -D) to that
/// session, or to whichever one there is. A server process is not a
/// client, and a client that started its own server names none of these.
fn screen_client_may_attach(args: &[String], server: u32, name: Option<&str>) -> bool {
    if args.first().is_some_and(|arg0| arg0 == "SCREEN") {
        return false;
    }
    let attach = args.iter().position(|arg| {
        arg.starts_with('-')
            && !arg.starts_with("--")
            && arg[1..].chars().any(|flag| "rRxdD".contains(flag))
    });
    let Some(index) = attach else {
        return false;
    };
    match args.get(index + 1).filter(|arg| !arg.starts_with('-')) {
        None => true,
        Some(target) => {
            let pid = server.to_string();
            target == &pid
                || target.starts_with(&format!("{pid}."))
                || name.is_some_and(|name| target == name || target.ends_with(&format!(".{name}")))
        }
    }
}

fn pidfd_getfd(pid: u32, fd: i32) -> std::result::Result<std::os::fd::OwnedFd, std::io::Error> {
    use std::os::fd::FromRawFd;
    // SAFETY: plain syscalls on integers; each returned fd is owned once.
    unsafe {
        let pidfd = libc::syscall(libc::SYS_pidfd_open, pid as libc::pid_t, 0);
        if pidfd < 0 {
            return Err(std::io::Error::last_os_error());
        }
        let pidfd = std::os::fd::OwnedFd::from_raw_fd(pidfd as i32);
        use std::os::fd::AsRawFd;
        let copy = libc::syscall(libc::SYS_pidfd_getfd, pidfd.as_raw_fd(), fd, 0);
        if copy < 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(std::os::fd::OwnedFd::from_raw_fd(copy as i32))
    }
}

/// The kitty `send-key` name of a chord.
pub(crate) fn kitty_key(chord: &Chord) -> std::result::Result<String, String> {
    if chord.is_lone_modifier() {
        return Err("a lone modifier sends nothing to a terminal".to_string());
    }
    let base = if let Some(ch) = chord.character() {
        ch.to_string()
    } else {
        match chord.key.as_str() {
            "Return" => "enter",
            "KP_Enter" => "kp_enter",
            "Escape" => "escape",
            "Tab" => "tab",
            "BackSpace" => "backspace",
            "Delete" => "delete",
            "space" => "space",
            "Home" => "home",
            "End" => "end",
            "Prior" => "page_up",
            "Next" => "page_down",
            "Left" => "left",
            "Right" => "right",
            "Up" => "up",
            "Down" => "down",
            key if is_function_key(key) => return Ok(kitty_mods(chord) + &key.to_ascii_lowercase()),
            other => return Err(format!("{other} has no kitty key name")),
        }
        .to_string()
    };
    Ok(kitty_mods(chord) + &base)
}

fn kitty_mods(chord: &Chord) -> String {
    let mut mods = String::new();
    for (on, name) in [
        (chord.ctrl, "ctrl+"),
        (chord.alt, "alt+"),
        (chord.shift, "shift+"),
        (chord.meta, "super+"),
    ] {
        if on {
            mods.push_str(name);
        }
    }
    mods
}

/// Send text to the program on `tty` through `channel`. Text never goes in
/// a process argument: kitty, wezterm and tmux read it on stdin, screen from
/// a private file.
pub(crate) async fn terminal_send_text(
    channel: &TerminalChannel,
    tty: &Path,
    text: &str,
) -> Result<()> {
    match channel {
        TerminalChannel::Kitty { socket, window_id } => kitty(
            socket,
            &[
                "send-text",
                "--match",
                &format!("id:{window_id}"),
                "--stdin",
            ],
            Some(text.as_bytes()),
        )
        .await
        .map(|_| ()),
        TerminalChannel::Wezterm { socket, pane_id } => run_tool(
            "wezterm",
            &[
                "cli",
                "send-text",
                "--no-paste",
                "--pane-id",
                &pane_id.to_string(),
            ],
            &[("WEZTERM_UNIX_SOCKET", socket)],
            Some(text.as_bytes()),
        )
        .await
        .map(|_| ()),
        TerminalChannel::Tmux(pane) => tmux_send_text(pane, text).await,
        TerminalChannel::Screen { session, window } => {
            screen_paste(session, window.as_deref(), text.as_bytes()).await
        }
        TerminalChannel::Tiocsti => {
            tiocsti_send(tty, text.as_bytes()).map_err(|error| anyhow!(error))
        }
        TerminalChannel::PtyMaster { fd, .. } => write_master(fd, text.as_bytes()).await,
    }
}

/// Whether `channel` has a name or byte sequence for `chord`. Checked before
/// sending: a key the channel cannot express has no background route.
pub(crate) fn terminal_key_supported(
    channel: &TerminalChannel,
    chord: &Chord,
) -> std::result::Result<(), String> {
    match channel {
        TerminalChannel::Kitty { .. } => kitty_key(chord).map(drop),
        TerminalChannel::Tmux(_) => tmux_key(chord).map(drop),
        _ => tty_key_bytes(chord).map(drop),
    }
}

/// Send a chord to the program on `tty` through `channel`. Returns the name
/// the channel took it as.
pub(crate) async fn terminal_send_key(
    channel: &TerminalChannel,
    tty: &Path,
    chord: &Chord,
) -> std::result::Result<String, String> {
    let failed = |error: anyhow::Error| format!("{error:#}");
    match channel {
        TerminalChannel::Kitty { socket, window_id } => {
            let name = kitty_key(chord)?;
            kitty(
                socket,
                &["send-key", "--match", &format!("id:{window_id}"), &name],
                None,
            )
            .await
            .map_err(failed)?;
            Ok(name)
        }
        TerminalChannel::Tmux(pane) => {
            let name = tmux_key(chord)?;
            tmux_send_key(pane, &name).await.map_err(failed)?;
            Ok(name)
        }
        other => {
            let bytes = tty_key_bytes(chord)?;
            match other {
                TerminalChannel::Wezterm { socket, pane_id } => run_tool(
                    "wezterm",
                    &[
                        "cli",
                        "send-text",
                        "--no-paste",
                        "--pane-id",
                        &pane_id.to_string(),
                    ],
                    &[("WEZTERM_UNIX_SOCKET", socket)],
                    Some(&bytes),
                )
                .await
                .map(|_| ())
                .map_err(failed)?,
                TerminalChannel::Screen { session, window } => {
                    screen_paste(session, window.as_deref(), &bytes)
                        .await
                        .map_err(failed)?
                }
                TerminalChannel::Tiocsti => tiocsti_send(tty, &bytes)?,
                TerminalChannel::PtyMaster { fd, .. } => {
                    write_master(fd, &bytes).await.map_err(failed)?
                }
                TerminalChannel::Kitty { .. } | TerminalChannel::Tmux(_) => unreachable!(),
            }
            Ok(format!("{bytes:?}"))
        }
    }
}

/// Write to a copied pty master. The copy shares the terminal's open file
/// description, so its blocking mode is left alone: each byte waits for
/// room with poll, and the write gives up after two seconds, so a program
/// that stops reading cannot hold the input lock. Runs off the async
/// workers.
async fn write_master(fd: &std::os::fd::OwnedFd, bytes: &[u8]) -> Result<()> {
    let fd = fd.try_clone()?;
    let bytes = bytes.to_vec();
    tokio::task::spawn_blocking(move || write_master_blocking(&fd, &bytes))
        .await
        .context("the pty master writer stopped")?
}

fn write_master_blocking(fd: &std::os::fd::OwnedFd, bytes: &[u8]) -> Result<()> {
    use std::os::fd::AsRawFd;
    let raw = fd.as_raw_fd();
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    let stopped = |sent: usize, why: String| {
        anyhow!(
            "writing to the pty master stopped after {sent} of {} bytes: {why}",
            bytes.len()
        )
    };
    let mut sent = 0;
    while sent < bytes.len() {
        let left = deadline.saturating_duration_since(std::time::Instant::now());
        if left.is_zero() {
            return Err(stopped(sent, "the program is not reading".to_string()));
        }
        let mut poll = libc::pollfd {
            fd: raw,
            events: libc::POLLOUT,
            revents: 0,
        };
        // SAFETY: one valid pollfd.
        let ready = unsafe { libc::poll(&mut poll, 1, left.as_millis().max(1) as i32) };
        if ready < 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::EINTR) {
                continue;
            }
            return Err(stopped(sent, error.to_string()));
        }
        if ready == 0 || poll.revents & libc::POLLOUT == 0 {
            if poll.revents & (libc::POLLERR | libc::POLLHUP) != 0 {
                return Err(stopped(sent, "the terminal closed".to_string()));
            }
            continue;
        }
        // One byte per wakeup: room for at least one is what POLLOUT means.
        // SAFETY: the byte is in bounds.
        let written = unsafe { libc::write(raw, bytes[sent..].as_ptr().cast(), 1) };
        if written == 1 {
            sent += 1;
            continue;
        }
        let error = std::io::Error::last_os_error();
        if !matches!(error.raw_os_error(), Some(libc::EAGAIN | libc::EINTR)) {
            return Err(stopped(sent, error.to_string()));
        }
    }
    Ok(())
}

/// Paste bytes into a screen window through a private file and screen's
/// paste buffer.
/// The screen register background input pastes through.
/// Written as `^_` (0x1F) in commands: a control-character register no
/// one stores text or macros in.
const SCREEN_REGISTER: &str = "^_";

/// A path quoted for screen's command parser.
fn screen_quote(path: &str) -> String {
    format!("'{}'", path.replace('\\', "\\\\").replace('\'', "\\'"))
}

async fn screen_paste(session: &str, window: Option<&str>, bytes: &[u8]) -> Result<()> {
    use std::os::unix::fs::OpenOptionsExt;
    let dir = std::env::var_os("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .filter(|dir| dir.is_dir())
        .unwrap_or_else(std::env::temp_dir);
    let path = dir.join(format!(
        "cul-screen-{:016x}",
        getrandom::u64().unwrap_or_default()
    ));
    {
        use std::io::Write;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)
            .context("cannot create the screen paste file")?;
        file.write_all(bytes)?;
    }
    let path_text = path.to_string_lossy().to_string();
    let mut base = vec!["-S", session];
    if let Some(window) = window {
        base.extend(["-p", window]);
    }
    // One eval reads the file into a private register, pastes it and clears
    // it, so a failed read pastes nothing and no text stays in screen. -X
    // returns before screen runs the command; the -Q round trip after it
    // returns only once screen has, so the file can go.
    let read = format!("readreg {SCREEN_REGISTER} {}", screen_quote(&path_text));
    let paste = format!("paste {SCREEN_REGISTER}");
    let clear = format!("register {SCREEN_REGISTER} ''");
    let result = async {
        let mut eval = base.clone();
        eval.extend(["-X", "eval", &read, &paste, &clear]);
        run_tool("screen", &eval, &[], None).await?;
        run_tool("screen", &["-S", session, "-Q", "info"], &[], None).await
    }
    .await;
    let _ = fs::remove_file(&path);
    result.map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chord(key: &str) -> Chord {
        let press = crate::hyprland_input::chord_to_key_press(key).unwrap();
        Chord::from_key_press(&press)
    }

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn element_keys_map_only_unambiguous_actions() {
        let click = strings(&["click"]);
        assert_eq!(
            element_key_action(&chord("Enter"), "push button", &[], &click).unwrap(),
            "click"
        );
        assert_eq!(
            element_key_action(&chord("space"), "push button", &[], &click).unwrap(),
            "click"
        );
        assert_eq!(
            element_key_action(&chord("KP_Enter"), "menu item", &[], &click).unwrap(),
            "click"
        );
        assert_eq!(
            element_key_action(&chord("space"), "check box", &[], &click).unwrap(),
            "click"
        );
        assert!(element_key_action(&chord("Enter"), "check box", &[], &click).is_err());
        assert_eq!(
            element_key_action(&chord("Return"), "link", &[], &strings(&["jump"])).unwrap(),
            "jump"
        );
        assert!(element_key_action(&chord("space"), "link", &[], &strings(&["jump"])).is_err());
        let single = strings(&["editable", "single-line"]);
        let activate = strings(&["activate"]);
        assert_eq!(
            element_key_action(&chord("Enter"), "text", &single, &activate).unwrap(),
            "activate"
        );
        assert!(element_key_action(
            &chord("Enter"),
            "text",
            &strings(&["multi-line"]),
            &activate
        )
        .is_err());
        assert!(element_key_action(&chord("Enter"), "text", &single, &[]).is_err());
        assert!(element_key_action(&chord("Tab"), "push button", &[], &click).is_err());
        assert!(element_key_action(&chord("Ctrl+Enter"), "push button", &[], &click).is_err());
        assert!(element_key_action(&chord("a"), "push button", &[], &click).is_err());
        assert!(element_key_action(&chord("Enter"), "panel", &[], &click).is_err());
    }

    #[test]
    fn tmux_names_follow_tmux_key_syntax() {
        assert_eq!(tmux_key(&chord("Enter")).unwrap(), "Enter");
        assert_eq!(tmux_key(&chord("KP_Enter")).unwrap(), "KPEnter");
        assert_eq!(tmux_key(&chord("Ctrl+C")).unwrap(), "C-c");
        assert_eq!(tmux_key(&chord("Shift+a")).unwrap(), "A");
        assert_eq!(tmux_key(&chord("Shift+Tab")).unwrap(), "BTab");
        assert_eq!(tmux_key(&chord("Alt+Left")).unwrap(), "M-Left");
        assert_eq!(tmux_key(&chord("Shift+Up")).unwrap(), "S-Up");
        assert_eq!(tmux_key(&chord("PageDown")).unwrap(), "NPage");
        assert_eq!(tmux_key(&chord("Backspace")).unwrap(), "BSpace");
        assert_eq!(tmux_key(&chord("F5")).unwrap(), "F5");
        assert!(tmux_key(&chord("Super+a")).is_err());
        assert!(tmux_key(&chord("Shift+1")).is_err());
        assert!(tmux_key(&chord("Ctrl")).is_err());
    }

    #[test]
    fn tty_bytes_cover_fixed_sequences_only() {
        assert_eq!(tty_key_bytes(&chord("Enter")).unwrap(), b"\r");
        assert_eq!(tty_key_bytes(&chord("Ctrl+C")).unwrap(), [3]);
        assert_eq!(tty_key_bytes(&chord("Alt+b")).unwrap(), b"\x1bb");
        assert_eq!(tty_key_bytes(&chord("Up")).unwrap(), b"\x1b[A");
        assert_eq!(tty_key_bytes(&chord("Shift+Tab")).unwrap(), b"\x1b[Z");
        assert!(tty_key_bytes(&chord("F1")).is_err());
        assert!(tty_key_bytes(&chord("Ctrl+Up")).is_err());
    }

    #[test]
    fn tty_selectors_normalize_to_pts_paths() {
        for tty in ["/dev/pts/7", "pts/7", "7", " 7 "] {
            assert_eq!(tty_path(tty).unwrap(), PathBuf::from("/dev/pts/7"));
        }
        for tty in ["", "/dev/tty1", "pts/x", "../7"] {
            assert!(tty_path(tty).is_err(), "{tty}");
        }
    }

    #[test]
    fn tmux_client_socket_follows_tmux_option_parsing() {
        let args = |values: &[&str]| strings(values);
        assert_eq!(
            tmux_client_socket(&args(&["tmux", "attach"]), None, 1000),
            Some(PathBuf::from("/tmp/tmux-1000/default"))
        );
        assert_eq!(
            tmux_client_socket(&args(&["tmux", "-L", "work", "a"]), Some("/run/x/"), 1000),
            Some(PathBuf::from("/run/x/tmux-1000/work"))
        );
        assert_eq!(
            tmux_client_socket(&args(&["tmux", "-2uS", "/s/sock", "attach"]), None, 1),
            Some(PathBuf::from("/s/sock"))
        );
        assert_eq!(
            tmux_client_socket(&args(&["tmux", "-Lname"]), None, 1),
            Some(PathBuf::from("/tmp/tmux-1/name"))
        );
        assert_eq!(
            tmux_client_socket(&args(&["tmux", "new", "-S", "/not/a/socket"]), None, 1),
            Some(PathBuf::from("/tmp/tmux-1/default"))
        );
    }

    #[test]
    fn stat_tty_decodes_the_kernel_encoding() {
        // pts/17: major 136, minor 17.
        let tty_nr = (136 << 8) | 17;
        let stat = format!("42 (a b) S 1 42 42 {tty_nr} 42 0");
        assert_eq!(stat_tty(&stat), Some((136, 17)));
        // minor 300 spills into the high bits.
        let tty_nr = (136 << 8) | (300 & 0xff) | ((300 & 0xfff00) << 12);
        let stat = format!("42 (x) S 1 42 42 {tty_nr} 42 0");
        assert_eq!(stat_tty(&stat), Some((136, 300)));
        assert_eq!(stat_tty("42 (x) S 1 42 42 0 42 0"), None);
    }

    #[test]
    fn kitty_keys_follow_kitty_key_names() {
        assert_eq!(kitty_key(&chord("Enter")).unwrap(), "enter");
        assert_eq!(kitty_key(&chord("Ctrl+C")).unwrap(), "ctrl+c");
        assert_eq!(
            kitty_key(&chord("Ctrl+Shift+PageUp")).unwrap(),
            "ctrl+shift+page_up"
        );
        assert_eq!(kitty_key(&chord("F7")).unwrap(), "f7");
        assert!(kitty_key(&chord("Shift")).is_err());
    }

    #[test]
    fn listings_map_a_tty_to_a_window_or_pane() {
        let kitty = serde_json::json!([{"tabs": [{"windows": [
            {"id": 1, "pid": 10, "foreground_processes": [{"pid": 11}]},
            {"id": 2, "pid": 20, "foreground_processes": [{"pid": 21}, {"pid": 22}]}
        ]}]}]);
        assert_eq!(kitty_window_in_listing(&kitty, |pid| pid == 22), Some(2));
        assert_eq!(kitty_window_in_listing(&kitty, |pid| pid == 10), Some(1));
        assert_eq!(kitty_window_in_listing(&kitty, |_| false), None);
        let wezterm = serde_json::json!([
            {"pane_id": 0, "tty_name": "/dev/pts/3"},
            {"pane_id": 4, "tty_name": "/dev/pts/12"}
        ]);
        assert_eq!(wezterm_pane_in_listing(&wezterm, "/dev/pts/12"), Some(4));
        assert_eq!(wezterm_pane_in_listing(&wezterm, "/dev/pts/1"), None);
        assert_eq!(
            fdinfo_tty_index("pos:\t0\nflags:\t02\ntty-index:\t17\n"),
            Some(17)
        );
        assert_eq!(fdinfo_tty_index("pos:\t0\n"), None);
    }

    #[test]
    fn pty_numbers_caps_and_screen_names_parse() {
        assert_eq!(pts_path((136, 5)), Some(PathBuf::from("/dev/pts/5")));
        assert_eq!(pts_path((137, 2)), Some(PathBuf::from("/dev/pts/258")));
        assert_eq!(pts_path((4, 1)), None);
        assert_eq!(pts_number(Path::new("/dev/pts/12")), Some(12));
        assert_eq!(
            effective_caps("Name:\tx\nCapEff:\t0000000000200000\n"),
            Some(1 << 21)
        );
        assert_eq!(screen_quote("/run/a b/f"), "'/run/a b/f'");
    }

    #[test]
    fn pty_master_writes_reach_the_slave_and_stop_when_it_is_full() {
        use std::io::Read;
        use std::os::fd::FromRawFd;
        let (mut master, mut slave) = (0, 0);
        // SAFETY: openpty fills two fds, owned below.
        let result = unsafe {
            libc::openpty(
                &mut master,
                &mut slave,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null(),
            )
        };
        assert_eq!(result, 0);
        // SAFETY: each fd is owned once.
        let master = unsafe { std::os::fd::OwnedFd::from_raw_fd(master) };
        let mut slave = unsafe { fs::File::from_raw_fd(slave) };
        write_master_blocking(&master, b"hi\n").unwrap();
        let mut read = [0u8; 16];
        let count = slave.read(&mut read).unwrap();
        assert_eq!(&read[..count], b"hi\n");
        // SAFETY: fcntl on an owned fd.
        let flags = unsafe { libc::fcntl(std::os::fd::AsRawFd::as_raw_fd(&master), libc::F_GETFL) };
        assert_eq!(
            flags & libc::O_NONBLOCK,
            0,
            "the shared description stays blocking"
        );
        // Nobody reads the slave: in raw mode its buffer fills (canonical
        // mode drops what does not fit instead), and the write stops at
        // the deadline.
        // SAFETY: termios calls on an owned fd with a zeroed struct.
        unsafe {
            let fd = std::os::fd::AsRawFd::as_raw_fd(&slave);
            let mut termios: libc::termios = std::mem::zeroed();
            assert_eq!(libc::tcgetattr(fd, &mut termios), 0);
            libc::cfmakeraw(&mut termios);
            assert_eq!(libc::tcsetattr(fd, libc::TCSANOW, &termios), 0);
        }
        let flood = vec![b'x'; 1 << 20];
        let error = write_master_blocking(&master, &flood)
            .unwrap_err()
            .to_string();
        assert!(error.contains("not reading"), "{error}");
    }

    #[test]
    fn screen_clients_that_may_share_a_session_are_found() {
        let args = |values: &[&str]| strings(values);
        assert!(screen_client_may_attach(
            &args(&["screen", "-x"]),
            42,
            Some("t")
        ));
        assert!(screen_client_may_attach(
            &args(&["screen", "-x", "t"]),
            42,
            Some("t")
        ));
        assert!(screen_client_may_attach(
            &args(&["screen", "-dr", "42.t"]),
            42,
            Some("t")
        ));
        assert!(!screen_client_may_attach(
            &args(&["screen", "-r", "other"]),
            42,
            Some("t")
        ));
        assert!(!screen_client_may_attach(
            &args(&["screen", "-S", "u", "sh"]),
            42,
            Some("t")
        ));
        assert!(!screen_client_may_attach(
            &args(&["SCREEN", "-S", "t"]),
            42,
            Some("t")
        ));
        assert_eq!(
            screen_session_name(&args(&["SCREEN", "-S", "t", "sh"])).as_deref(),
            Some("t")
        );
    }

    #[test]
    fn tty_tables_match_whole_fields() {
        let table = "/dev/pts/1\t%0\n/dev/pts/12\t%3\n";
        assert_eq!(parse_tty_table(table, "/dev/pts/12").as_deref(), Some("%3"));
        assert_eq!(parse_tty_table(table, "/dev/pts/2"), None);
        assert_eq!(parse_legacy_tiocsti("0\n"), Some(false));
        assert_eq!(parse_legacy_tiocsti("1"), Some(true));
        assert_eq!(parse_legacy_tiocsti(""), None);
    }
}
