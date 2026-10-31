use crate::terminal::TerminalWindowContext;
use schemars::JsonSchema;
use serde::{Deserialize, Deserializer, Serialize};

/// Largest integer a JSON client that parses numbers as IEEE-754 doubles
/// (JavaScript's `Number.MAX_SAFE_INTEGER`) carries exactly. Every backend
/// keeps `window_id` at or below it so IDs round-trip through any MCP client.
pub const MAX_WINDOW_ID: u64 = (1 << 53) - 1;

/// Deserialize an optional `window_id` input, rejecting any number a
/// JavaScript client cannot have received exactly from `list_windows`.
/// The input is read as a generic JSON number first, so a rounded ID above
/// `u64::MAX` (which serde_json parses as a float) gets the same prompt.
pub fn deserialize_window_id<'de, D>(deserializer: D) -> Result<Option<u64>, D::Error>
where
    D: Deserializer<'de>,
{
    let Some(number) = Option::<serde_json::Number>::deserialize(deserializer)? else {
        return Ok(None);
    };
    match number.as_u64() {
        Some(window_id) if window_id <= MAX_WINDOW_ID => Ok(Some(window_id)),
        _ => Err(serde::de::Error::custom(format!(
            "window_id {number} is not an integer from 0 to {MAX_WINDOW_ID} (2^53-1), the largest integer JavaScript clients carry exactly. Window IDs from list_windows always fit, so this one is stale or was rounded; re-run list_windows and pass the current window_id."
        ))),
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
pub struct WindowInfo {
    pub window_id: u64,
    pub title: Option<String>,
    pub app_id: Option<String>,
    pub wm_class: Option<String>,
    pub pid: Option<u32>,
    pub bounds: Option<WindowBounds>,
    pub workspace: Option<i32>,
    pub focused: bool,
    pub hidden: bool,
    pub client_type: Option<String>,
    pub backend: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal: Option<TerminalWindowContext>,
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
pub struct WindowBounds {
    pub x: Option<i32>,
    pub y: Option<i32>,
    pub width: u32,
    pub height: u32,
}

pub(crate) fn app_id_leaf(app_id: &str) -> &str {
    let app_id = app_id.trim();
    let app_id = app_id.strip_suffix(".desktop").unwrap_or(app_id);
    app_id.rsplit('.').next().unwrap_or(app_id)
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, JsonSchema)]
pub struct WindowTarget {
    #[serde(default, deserialize_with = "deserialize_window_id")]
    #[schemars(range(max = crate::windowing::types::MAX_WINDOW_ID))]
    pub window_id: Option<u64>,
    #[serde(default)]
    pub pid: Option<u32>,
    #[serde(default)]
    pub tty: Option<String>,
    #[serde(default)]
    pub terminal_pid: Option<u32>,
    #[serde(default)]
    pub terminal_command: Option<String>,
    #[serde(default)]
    pub terminal_cwd: Option<String>,
    #[serde(default)]
    pub app_id: Option<String>,
    #[serde(default)]
    pub wm_class: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct WindowFocusResult {
    pub requested_window: WindowInfo,
    pub focused_window: Option<WindowInfo>,
    pub exact_window_focused: bool,
    pub app_focused: bool,
    pub backend: String,
    pub note: String,
}

impl WindowTarget {
    pub fn has_target(&self) -> bool {
        self.window_id.is_some()
            || self.pid.is_some()
            || self.has_terminal_target()
            || self
                .app_id
                .as_deref()
                .is_some_and(|value| !value.trim().is_empty())
            || self
                .wm_class
                .as_deref()
                .is_some_and(|value| !value.trim().is_empty())
            || self
                .title
                .as_deref()
                .is_some_and(|value| !value.trim().is_empty())
    }

    pub fn requires_exact_focus(&self) -> bool {
        self.window_id.is_some()
            || self.pid.is_some()
            || self.has_terminal_target()
            || self
                .title
                .as_deref()
                .is_some_and(|value| !value.trim().is_empty())
    }

    pub(crate) fn has_terminal_target(&self) -> bool {
        self.terminal_pid.is_some()
            || self
                .tty
                .as_deref()
                .is_some_and(|value| !value.trim().is_empty())
            || self
                .terminal_command
                .as_deref()
                .is_some_and(|value| !value.trim().is_empty())
            || self
                .terminal_cwd
                .as_deref()
                .is_some_and(|value| !value.trim().is_empty())
    }
}
