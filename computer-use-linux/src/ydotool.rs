use std::{process::Command, sync::OnceLock};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CliGeneration {
    RawEvents,
    LegacyNamed,
}

const UNSUPPORTED_MESSAGE: &str = "unsupported legacy ydotool CLI; Computer Use requires ydotool 1.0 or newer with raw key events and absolute mouse movement";

pub(crate) fn ensure_supported() -> Result<String, String> {
    static RESULT: OnceLock<Result<String, String>> = OnceLock::new();
    RESULT.get_or_init(probe).clone()
}

fn probe() -> Result<String, String> {
    let mut output_text = String::new();
    for argument in ["help", "--help"] {
        let output = Command::new("ydotool")
            .arg(argument)
            .output()
            .map_err(|error| format!("failed to run ydotool: {error}"))?;
        output_text.push_str(&String::from_utf8_lossy(&output.stdout));
        output_text.push_str(&String::from_utf8_lossy(&output.stderr));
        if let Some(generation) = classify_help(&output_text) {
            return match generation {
                CliGeneration::RawEvents => Ok("compatible raw-event CLI detected".to_string()),
                CliGeneration::LegacyNamed => Err(UNSUPPORTED_MESSAGE.to_string()),
            };
        }
    }
    Err("unrecognized ydotool CLI; Computer Use requires ydotool 1.0 or newer".to_string())
}

pub(crate) fn classify_help(help: &str) -> Option<CliGeneration> {
    let commands = help
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>();
    if commands.contains(&"debug") && commands.contains(&"stdin") {
        Some(CliGeneration::RawEvents)
    } else if commands.contains(&"recorder") {
        Some(CliGeneration::LegacyNamed)
    } else {
        None
    }
}

pub(crate) fn cli_error(stderr: &[u8]) -> Option<String> {
    let detail = String::from_utf8_lossy(stderr).trim().to_string();
    let normalized = detail.to_ascii_lowercase();
    [
        "unrecognised option",
        "unrecognized option",
        "unknown option",
        "invalid option",
        "unknown command",
    ]
    .iter()
    .any(|needle| normalized.contains(needle))
    .then_some(detail)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_legacy_named_cli_from_ubuntu_ydotool() {
        let help = "Usage: ydotool <cmd> <args>\nAvailable commands:\n  type\n  recorder\n  mousemove\n  key\n  click\n";

        assert_eq!(classify_help(help), Some(CliGeneration::LegacyNamed));
    }

    #[test]
    fn classifies_raw_event_cli_from_current_ydotool() {
        let help = "Usage: ydotool <cmd> <args>\nAvailable commands:\n  click\n  mousemove\n  type\n  key\n  debug\n  stdin\n";

        assert_eq!(classify_help(help), Some(CliGeneration::RawEvents));
    }

    #[test]
    fn rejects_unknown_cli_shape() {
        assert_eq!(classify_help("Usage: ydotool <cmd>"), None);
    }

    #[test]
    fn recognizes_cli_errors_even_when_exit_status_is_success() {
        assert_eq!(
            cli_error(b"error: unrecognised option '--absolute'\n"),
            Some("error: unrecognised option '--absolute'".to_string())
        );
    }

    #[test]
    fn ignores_non_error_stderr() {
        assert_eq!(cli_error(b"ydotoold socket ready\n"), None);
    }
}
