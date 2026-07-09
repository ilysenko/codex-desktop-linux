//! Desktop notification helpers used by the updater daemon.

use anyhow::Result;
use notify_rust::{Hint, Timeout};
use std::path::{Path, PathBuf};

const APP_NAME: &str = "ChatGPT Desktop";
const DESKTOP_ENTRY: &str = "chatgpt-desktop";
const PACKAGED_BUNDLE_ICON_PATH: &str = "/opt/chatgpt-desktop/.codex-linux/chatgpt-desktop.png";
const SYSTEM_ICON_PATH: &str = "/usr/share/icons/hicolor/256x256/apps/chatgpt-desktop.png";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ActionResponse {
    Invoked(String),
    Closed,
}

/// Sends a desktop notification through the host notification service.
pub fn send(summary: &str, body: &str) -> Result<()> {
    let notification = base_notification(summary, body);
    notification.show()?;
    Ok(())
}

pub fn send_actionable(
    summary: &str,
    body: &str,
    actions: &[(&str, &str)],
) -> Result<ActionResponse> {
    let mut notification = base_notification(summary, body);
    notification
        .hint(Hint::Resident(true))
        .timeout(Timeout::Milliseconds(20000));
    for (action_id, label) in actions {
        notification.action(action_id, label);
    }

    let selected_action = std::sync::Arc::new(std::sync::Mutex::new(ActionResponse::Closed));
    let selected_action_clone = selected_action.clone();
    notification.show()?.wait_for_action(move |action| {
        let next_action = if action == "__closed" {
            ActionResponse::Closed
        } else {
            ActionResponse::Invoked(action.to_string())
        };
        if let Ok(mut selected_action) = selected_action_clone.lock() {
            *selected_action = next_action;
        }
    });

    Ok(selected_action
        .lock()
        .map(|action| action.clone())
        .unwrap_or(ActionResponse::Closed))
}

fn base_notification(summary: &str, body: &str) -> notify_rust::Notification {
    let icon_path = resolve_icon_path();

    let mut notification = notify_rust::Notification::new();
    notification
        .summary(summary)
        .body(body)
        .appname(APP_NAME)
        .hint(Hint::DesktopEntry(DESKTOP_ENTRY.to_owned()));

    if let Some(icon_path) = icon_path.as_deref() {
        let icon_uri = path_to_file_uri(icon_path);
        notification.icon(&icon_uri);
        notification.image_path(&icon_uri);
    } else {
        notification.icon(DESKTOP_ENTRY);
    }

    notification
}

fn resolve_icon_path() -> Option<PathBuf> {
    resolve_icon_path_from_candidates(bundled_icon_candidates())
}

fn bundled_icon_candidates() -> Vec<PathBuf> {
    let mut candidates = vec![
        PathBuf::from(PACKAGED_BUNDLE_ICON_PATH),
        PathBuf::from(SYSTEM_ICON_PATH),
    ];

    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(repo_icon) = repo_icon_from_exe(&current_exe) {
            candidates.push(repo_icon);
        }
    }

    candidates
}

fn resolve_icon_path_from_candidates<I>(candidates: I) -> Option<PathBuf>
where
    I: IntoIterator<Item = PathBuf>,
{
    candidates.into_iter().find(|path| path.is_file())
}

fn repo_icon_from_exe(current_exe: &Path) -> Option<PathBuf> {
    let target_dir = current_exe.parent()?.parent()?;
    Some(target_dir.parent()?.join("assets/codex.png"))
}

fn path_to_file_uri(path: &Path) -> String {
    let path = path.as_os_str().as_encoded_bytes();
    let mut uri = String::from("file://");

    for &byte in path {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b'/' => {
                uri.push(byte as char)
            }
            _ => uri.push_str(&format!("%{byte:02X}")),
        }
    }

    uri
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::ffi::OsStrExt;
    use tempfile::tempdir;

    #[test]
    fn resolve_icon_path_prefers_first_existing_candidate() {
        let tempdir = tempdir().expect("tempdir");
        let preferred = tempdir.path().join("preferred.png");
        let fallback = tempdir.path().join("fallback.png");

        std::fs::write(&preferred, b"preferred").expect("write preferred icon");
        std::fs::write(&fallback, b"fallback").expect("write fallback icon");

        let resolved = resolve_icon_path_from_candidates(vec![preferred.clone(), fallback]);

        assert_eq!(resolved, Some(preferred));
    }

    #[test]
    fn resolve_icon_path_skips_missing_candidates() {
        let tempdir = tempdir().expect("tempdir");
        let missing = tempdir.path().join("missing.png");
        let fallback = tempdir.path().join("fallback.png");
        std::fs::write(&fallback, b"fallback").expect("write fallback icon");

        let resolved = resolve_icon_path_from_candidates(vec![missing, fallback.clone()]);

        assert_eq!(resolved, Some(fallback));
    }

    #[test]
    fn resolve_icon_path_returns_none_when_no_candidates_exist() {
        let tempdir = tempdir().expect("tempdir");
        let missing = tempdir.path().join("missing.png");

        let resolved = resolve_icon_path_from_candidates(vec![missing]);

        assert_eq!(resolved, None);
    }

    #[test]
    fn file_uri_escapes_spaces_and_non_ascii_bytes() {
        let path = Path::new(std::ffi::OsStr::from_bytes(b"/tmp/codex icon-\xC3\xB1.png"));

        let uri = path_to_file_uri(path);

        assert_eq!(uri, "file:///tmp/codex%20icon-%C3%B1.png");
    }
}
