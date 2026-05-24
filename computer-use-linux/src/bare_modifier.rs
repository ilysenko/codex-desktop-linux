use anyhow::{bail, Context, Result};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum EventKind {
    Press,
    Release,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum TriggerMode {
    Press,
    Release,
}

#[derive(Debug)]
struct KeyPair {
    canonical: &'static str,
    left_symbols: &'static [&'static str],
    right_symbols: &'static [&'static str],
    fallback_left: u16,
    fallback_right: u16,
}

#[derive(Debug)]
struct MonitorState {
    left_down: bool,
    right_down: bool,
    armed: bool,
    trigger_mode: TriggerMode,
}

pub fn run<I>(args: I) -> Result<()>
where
    I: IntoIterator<Item = String>,
{
    let (key, trigger_mode) = parse_args(args)?;
    let pair =
        key_pair(&key).with_context(|| format!("unsupported bare modifier hotkey '{key}'"))?;
    let (left_code, right_code) = resolve_keycodes(pair)?;
    monitor_xinput(left_code, right_code, trigger_mode)
}

fn parse_args<I>(args: I) -> Result<(String, TriggerMode)>
where
    I: IntoIterator<Item = String>,
{
    let mut key = None;
    let mut trigger_mode = TriggerMode::Press;
    let mut args = args.into_iter();

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--key" => {
                key = args.next();
                if key.is_none() {
                    bail!("--key requires a value");
                }
            }
            "--immediate" => trigger_mode = TriggerMode::Press,
            "--trigger-on-release" => trigger_mode = TriggerMode::Release,
            _ if key.is_none() && !arg.starts_with('-') => key = Some(arg),
            _ => bail!("unknown bare modifier monitor argument '{arg}'"),
        }
    }

    let key = key.context("missing --key")?;
    Ok((key, trigger_mode))
}

fn key_pair(key: &str) -> Option<&'static KeyPair> {
    let normalized = normalize_key(key);
    KEY_PAIRS.iter().find(|pair| {
        normalize_key(pair.canonical) == normalized
            || pair
                .aliases()
                .iter()
                .any(|alias| normalize_key(alias) == normalized)
    })
}

fn normalize_key(key: &str) -> String {
    key.chars()
        .filter(|ch| !ch.is_ascii_whitespace() && *ch != '-' && *ch != '_')
        .flat_map(char::to_lowercase)
        .collect()
}

fn resolve_keycodes(pair: &KeyPair) -> Result<(u16, u16)> {
    let xmodmap = read_xmodmap_keycodes().unwrap_or_default();
    let left = find_keysym_code(&xmodmap, pair.left_symbols).unwrap_or(pair.fallback_left);
    let right = find_keysym_code(&xmodmap, pair.right_symbols).unwrap_or(pair.fallback_right);
    if left == right {
        bail!(
            "left and right {} keys resolved to the same keycode",
            pair.canonical
        );
    }
    Ok((left, right))
}

fn read_xmodmap_keycodes() -> Result<HashMap<String, u16>> {
    let output = Command::new("xmodmap")
        .arg("-pke")
        .output()
        .context("failed to run xmodmap")?;
    if !output.status.success() {
        bail!("xmodmap -pke failed");
    }
    Ok(parse_xmodmap(&String::from_utf8_lossy(&output.stdout)))
}

fn parse_xmodmap(output: &str) -> HashMap<String, u16> {
    let mut keycodes = HashMap::new();
    for line in output.lines() {
        let Some((prefix, symbols)) = line.split_once('=') else {
            continue;
        };
        let mut prefix_parts = prefix.split_whitespace();
        if prefix_parts.next() != Some("keycode") {
            continue;
        }
        let Some(code) = prefix_parts
            .next()
            .and_then(|part| part.parse::<u16>().ok())
        else {
            continue;
        };
        for symbol in symbols.split_whitespace() {
            keycodes.entry(symbol.to_string()).or_insert(code);
        }
    }
    keycodes
}

fn find_keysym_code(keycodes: &HashMap<String, u16>, symbols: &[&str]) -> Option<u16> {
    symbols
        .iter()
        .find_map(|symbol| keycodes.get(*symbol).copied())
}

fn monitor_xinput(left_code: u16, right_code: u16, trigger_mode: TriggerMode) -> Result<()> {
    let mut child = Command::new("xinput")
        .args(["test-xi2", "--root"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .context("failed to start xinput test-xi2 --root")?;
    let stdout = child.stdout.take().context("xinput stdout unavailable")?;
    println!("ready");
    std::io::stdout().flush().ok();

    let mut state = MonitorState {
        left_down: false,
        right_down: false,
        armed: false,
        trigger_mode,
    };
    let mut pending_event = None;

    for line in BufReader::new(stdout).lines() {
        let line = line?;
        let trimmed = line.trim();
        if trimmed.contains("(RawKeyPress)") {
            pending_event = Some(EventKind::Press);
            continue;
        }
        if trimmed.contains("(RawKeyRelease)") {
            pending_event = Some(EventKind::Release);
            continue;
        }
        if let Some(kind) = pending_event {
            if let Some(code) = parse_detail(trimmed) {
                handle_event(&mut state, kind, code, left_code, right_code);
                pending_event = None;
            }
        }
    }

    let _ = child.kill();
    Ok(())
}

fn parse_detail(line: &str) -> Option<u16> {
    let detail = line.strip_prefix("detail:")?.trim();
    detail.parse().ok()
}

fn handle_event(
    state: &mut MonitorState,
    kind: EventKind,
    code: u16,
    left_code: u16,
    right_code: u16,
) {
    let was_chord_down = state.left_down && state.right_down;

    match kind {
        EventKind::Press if code == left_code => state.left_down = true,
        EventKind::Press if code == right_code => state.right_down = true,
        EventKind::Release if code == left_code => state.left_down = false,
        EventKind::Release if code == right_code => state.right_down = false,
        _ => return,
    }

    let chord_down = state.left_down && state.right_down;
    if chord_down && !state.armed {
        state.armed = true;
        if state.trigger_mode == TriggerMode::Press {
            println!("down");
            std::io::stdout().flush().ok();
        }
    }

    if was_chord_down && !chord_down && state.armed {
        if state.trigger_mode == TriggerMode::Release {
            println!("down");
        }
        println!("up");
        std::io::stdout().flush().ok();
        state.armed = false;
    }
}

impl KeyPair {
    fn aliases(&self) -> &'static [&'static str] {
        match self.canonical {
            "DoubleShift" => &["Shift+Shift", "LeftShift+RightShift"],
            "DoubleAlt" => &[
                "Alt+Alt",
                "Option+Option",
                "DoubleOption",
                "LeftAlt+RightAlt",
                "LeftOption+RightOption",
            ],
            "DoubleSuper" => &[
                "Super+Super",
                "Meta+Meta",
                "Command+Command",
                "DoubleCommand",
                "DoubleMeta",
                "LeftSuper+RightSuper",
                "LeftCommand+RightCommand",
                "LeftMeta+RightMeta",
            ],
            "DoubleControl" => &[
                "Control+Control",
                "Ctrl+Ctrl",
                "DoubleCtrl",
                "LeftControl+RightControl",
                "LeftCtrl+RightCtrl",
            ],
            _ => &[],
        }
    }
}

static KEY_PAIRS: &[KeyPair] = &[
    KeyPair {
        canonical: "DoubleShift",
        left_symbols: &["Shift_L"],
        right_symbols: &["Shift_R"],
        fallback_left: 50,
        fallback_right: 62,
    },
    KeyPair {
        canonical: "DoubleAlt",
        left_symbols: &["Alt_L", "Meta_L"],
        right_symbols: &["Alt_R", "ISO_Level3_Shift", "Meta_R"],
        fallback_left: 64,
        fallback_right: 108,
    },
    KeyPair {
        canonical: "DoubleSuper",
        left_symbols: &["Super_L", "Meta_L", "Hyper_L"],
        right_symbols: &["Super_R", "Meta_R", "Hyper_R"],
        fallback_left: 133,
        fallback_right: 134,
    },
    KeyPair {
        canonical: "DoubleControl",
        left_symbols: &["Control_L"],
        right_symbols: &["Control_R"],
        fallback_left: 37,
        fallback_right: 105,
    },
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_xmodmap_keycodes() {
        let parsed = parse_xmodmap(
            "keycode  50 = Shift_L ISO_Prev_Group Shift_L\nkeycode  62 = Shift_R ISO_Next_Group Shift_R\n",
        );
        assert_eq!(parsed.get("Shift_L"), Some(&50));
        assert_eq!(parsed.get("Shift_R"), Some(&62));
    }

    #[test]
    fn normalizes_modifier_aliases() {
        assert_eq!(key_pair("Shift + Shift").unwrap().canonical, "DoubleShift");
        assert_eq!(key_pair("DoubleOption").unwrap().canonical, "DoubleAlt");
        assert_eq!(
            key_pair("left_meta + right_meta").unwrap().canonical,
            "DoubleSuper"
        );
    }

    #[test]
    fn emits_press_and_release_once_per_chord() {
        let mut state = MonitorState {
            left_down: false,
            right_down: false,
            armed: false,
            trigger_mode: TriggerMode::Press,
        };
        handle_event(&mut state, EventKind::Press, 50, 50, 62);
        assert!(!state.armed);
        handle_event(&mut state, EventKind::Press, 62, 50, 62);
        assert!(state.armed);
        handle_event(&mut state, EventKind::Press, 62, 50, 62);
        assert!(state.armed);
        handle_event(&mut state, EventKind::Release, 50, 50, 62);
        assert!(!state.armed);
    }
}
