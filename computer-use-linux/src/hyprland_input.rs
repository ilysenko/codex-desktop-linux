//! Background keyboard input for Hyprland.
//!
//! Hyprland's `send_key_state` dispatcher delivers key events to a named
//! window without focusing it, so text can reach a window on a hidden
//! workspace while the user keeps working. The dispatcher resolves `key` to a
//! physical key and applies only the modifiers it is given: shifted symbols
//! (`!`, `_`, capitals) need an explicit SHIFT plus the unshifted key name,
//! and keysym names that only exist on a shifted level are silently dropped.
//! Text is therefore mapped through a US layout table, and anything the table
//! cannot express is refused rather than dropped.

use std::env;

pub const BACKGROUND_ENV: &str = "COMPUTER_USE_LINUX_HYPRLAND_BACKGROUND";

/// One key press: Hyprland modifier mask (e.g. `"CTRL SHIFT"`, or empty) and
/// an xkb key name on the unshifted level of a US layout.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyPress {
    pub mods: String,
    pub key: String,
}

impl KeyPress {
    fn new(mods: &str, key: &str) -> Self {
        Self {
            mods: mods.to_string(),
            key: key.to_string(),
        }
    }
}

/// Opt-in for Hyprland background mode: targeted keyboard input and
/// window capture that never focus or raise the target.
pub fn background_enabled() -> bool {
    env::var(BACKGROUND_ENV).ok().as_deref() == Some("1")
}

/// Maps literal text to key presses. Errors name the first unsupported
/// character so no partial text is sent.
pub fn text_to_key_presses(text: &str) -> Result<Vec<KeyPress>, String> {
    text.chars()
        .map(|ch| {
            char_to_key_press(ch).ok_or_else(|| {
                format!(
                    "Literal text was not sent: Hyprland background input supports printable US-layout ASCII, tab and newline; {ch:?} is unsupported."
                )
            })
        })
        .collect()
}

fn char_to_key_press(ch: char) -> Option<KeyPress> {
    if ch.is_ascii_lowercase() || ch.is_ascii_digit() {
        return Some(KeyPress::new("", &ch.to_string()));
    }
    if ch.is_ascii_uppercase() {
        return Some(KeyPress::new("SHIFT", &ch.to_ascii_lowercase().to_string()));
    }
    let (mods, key) = match ch {
        ' ' => ("", "space"),
        '\n' => ("", "Return"),
        '\t' => ("", "Tab"),
        '-' => ("", "minus"),
        '=' => ("", "equal"),
        '[' => ("", "bracketleft"),
        ']' => ("", "bracketright"),
        '\\' => ("", "backslash"),
        ';' => ("", "semicolon"),
        '\'' => ("", "apostrophe"),
        '`' => ("", "grave"),
        ',' => ("", "comma"),
        '.' => ("", "period"),
        '/' => ("", "slash"),
        '!' => ("SHIFT", "1"),
        '@' => ("SHIFT", "2"),
        '#' => ("SHIFT", "3"),
        '$' => ("SHIFT", "4"),
        '%' => ("SHIFT", "5"),
        '^' => ("SHIFT", "6"),
        '&' => ("SHIFT", "7"),
        '*' => ("SHIFT", "8"),
        '(' => ("SHIFT", "9"),
        ')' => ("SHIFT", "0"),
        '_' => ("SHIFT", "minus"),
        '+' => ("SHIFT", "equal"),
        '{' => ("SHIFT", "bracketleft"),
        '}' => ("SHIFT", "bracketright"),
        '|' => ("SHIFT", "backslash"),
        ':' => ("SHIFT", "semicolon"),
        '"' => ("SHIFT", "apostrophe"),
        '~' => ("SHIFT", "grave"),
        '<' => ("SHIFT", "comma"),
        '>' => ("SHIFT", "period"),
        '?' => ("SHIFT", "slash"),
        _ => return None,
    };
    Some(KeyPress::new(mods, key))
}

/// Parses the `press_key` grammar (`Ctrl+Shift+T`, `Enter`, `a`) into one
/// key press. Hyphens and spaces inside a part are ignored, matching the
/// tool's documented grammar.
pub fn chord_to_key_press(chord: &str) -> Option<KeyPress> {
    let mut mods: Vec<&str> = Vec::new();
    let mut key: Option<String> = None;
    for raw in chord.split('+') {
        let part: String = raw
            .chars()
            .filter(|c| *c != '-' && *c != ' ')
            .collect::<String>()
            .to_ascii_lowercase();
        if part.is_empty() {
            return None;
        }
        let modifier = match part.as_str() {
            "ctrl" | "control" => Some("CTRL"),
            "alt" | "option" => Some("ALT"),
            "shift" => Some("SHIFT"),
            "meta" | "super" | "cmd" | "command" => Some("SUPER"),
            _ => None,
        };
        if let Some(modifier) = modifier {
            if key.is_some() {
                return None;
            }
            if !mods.contains(&modifier) {
                mods.push(modifier);
            }
            continue;
        }
        if key.is_some() {
            return None;
        }
        key = Some(named_key(&part)?);
    }
    let key = key.or_else(|| {
        // A lone modifier ("Super") is a key press in its own right.
        let last = mods.pop()?;
        Some(
            match last {
                "CTRL" => "Control_L",
                "ALT" => "Alt_L",
                "SHIFT" => "Shift_L",
                _ => "Super_L",
            }
            .to_string(),
        )
    })?;
    Some(KeyPress {
        mods: mods.join(" "),
        key,
    })
}

fn named_key(part: &str) -> Option<String> {
    let name = match part {
        "enter" | "return" => "Return",
        "escape" | "esc" => "Escape",
        "tab" => "Tab",
        "backspace" => "BackSpace",
        "delete" | "del" => "Delete",
        "space" => "space",
        "home" => "Home",
        "end" => "End",
        "pageup" => "Prior",
        "pagedown" => "Next",
        "arrowleft" | "left" => "Left",
        "arrowright" | "right" => "Right",
        "arrowup" | "up" => "Up",
        "arrowdown" | "down" => "Down",
        _ => {
            if let Some(n) = part.strip_prefix('f') {
                if let Ok(n) = n.parse::<u8>() {
                    if (1..=12).contains(&n) {
                        return Some(format!("F{n}"));
                    }
                }
            }
            if part.len() == 1 {
                let ch = part.chars().next()?;
                if ch.is_ascii_lowercase() || ch.is_ascii_digit() {
                    return Some(part.to_string());
                }
            }
            return None;
        }
    };
    Some(name.to_string())
}

/// True when `hyprctl devices -j` reports a US layout on the main keyboard.
/// The text table assumes US key positions.
pub fn keymap_is_us(devices_json: &[u8]) -> bool {
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(devices_json) else {
        return false;
    };
    let Some(keyboards) = value.get("keyboards").and_then(|k| k.as_array()) else {
        return false;
    };
    let keymap_of = |keyboard: &serde_json::Value| {
        keyboard
            .get("active_keymap")
            .and_then(|k| k.as_str())
            .map(str::to_string)
    };
    let main = keyboards
        .iter()
        .find(|keyboard| keyboard.get("main").and_then(|m| m.as_bool()) == Some(true))
        .or_else(|| keyboards.first());
    main.and_then(keymap_of)
        .is_some_and(|keymap| keymap.contains("(US)") || keymap == "English")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kp(mods: &str, key: &str) -> KeyPress {
        KeyPress::new(mods, key)
    }

    #[test]
    fn maps_text_with_shift_levels() {
        assert_eq!(
            text_to_key_presses("aZ!_ 1\n").unwrap(),
            vec![
                kp("", "a"),
                kp("SHIFT", "z"),
                kp("SHIFT", "1"),
                kp("SHIFT", "minus"),
                kp("", "space"),
                kp("", "1"),
                kp("", "Return"),
            ]
        );
    }

    #[test]
    fn refuses_unmappable_text_whole() {
        let error = text_to_key_presses("café").unwrap_err();
        assert!(error.contains("'é'"), "{error}");
    }

    #[test]
    fn parses_chords() {
        assert_eq!(chord_to_key_press("Ctrl+L"), Some(kp("CTRL", "l")));
        assert_eq!(
            chord_to_key_press("ctrl + shift + t"),
            Some(kp("CTRL SHIFT", "t"))
        );
        assert_eq!(chord_to_key_press("Enter"), Some(kp("", "Return")));
        assert_eq!(chord_to_key_press("Page-Down"), Some(kp("", "Next")));
        assert_eq!(chord_to_key_press("F12"), Some(kp("", "F12")));
        assert_eq!(chord_to_key_press("Super"), Some(kp("", "Super_L")));
        assert_eq!(
            chord_to_key_press("Ctrl+Shift"),
            Some(kp("CTRL", "Shift_L"))
        );
        assert_eq!(chord_to_key_press("Ctrl+L+K"), None);
        assert_eq!(chord_to_key_press("Ctrl+é"), None);
        assert_eq!(chord_to_key_press("Ctrl++"), None);
    }

    #[test]
    fn detects_us_keymap() {
        let us = br#"{"keyboards":[{"name":"a","active_keymap":"German","main":false},{"name":"b","active_keymap":"English (US)","main":true}]}"#;
        let de = br#"{"keyboards":[{"name":"b","active_keymap":"German","main":true}]}"#;
        assert!(keymap_is_us(us));
        assert!(!keymap_is_us(de));
        assert!(!keymap_is_us(b"not json"));
    }
}
