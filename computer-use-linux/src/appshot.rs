use crate::atspi_tree::{snapshot_tree, AccessibilityNode};
use crate::screenshot::{capture_screenshot_without_cli_fallback, ScreenshotCapture};
use crate::windows::{focused_window, WindowBounds, WindowInfo};
use anyhow::{Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use image::{DynamicImage, ImageFormat};
use serde::Serialize;
use std::io::Cursor;

const MAX_APP_FILTER_CHARS: usize = 256;
const MAX_AX_TEXT_CHARS: usize = 60_000;
const MAX_FIELD_CHARS: usize = 500;
const SNAPSHOT_NODE_LIMIT: usize = 220;
const SNAPSHOT_DEPTH_LIMIT: u32 = 12;

#[derive(Debug, Clone, Serialize)]
pub struct AppshotCapture {
    pub focused_window: Option<WindowInfo>,
    pub focused_window_error: Option<String>,
    pub screenshot: Option<ScreenshotCapture>,
    pub screenshot_error: Option<String>,
    pub accessibility_nodes: Vec<AccessibilityNode>,
    pub accessibility_error: Option<String>,
    pub accessibility_text: String,
}

pub async fn capture_appshot(app_filter: Option<&str>) -> AppshotCapture {
    let (focused_window, focused_window_error) = match focused_window().await {
        Ok(window) => (window, None),
        Err(error) => (None, Some(format!("{error:#}"))),
    };

    let (screenshot, screenshot_error) = match focused_window.as_ref() {
        Some(window) => match capture_screenshot_without_cli_fallback().await {
            Ok(capture) => match crop_capture_to_window(capture, window) {
                Ok(capture) => (Some(capture), None),
                Err(error) => (None, Some(format!("{error:#}"))),
            },
            Err(error) => (None, Some(format!("{error:#}"))),
        },
        None => (
            None,
            Some(
                focused_window_error
                    .as_deref()
                    .map(|error| format!("focused window unavailable; refusing full-screen AppShot screenshot: {error}"))
                    .unwrap_or_else(|| {
                        "focused window unavailable; refusing full-screen AppShot screenshot"
                            .to_string()
                    }),
            ),
        ),
    };

    let selector = accessibility_selector(app_filter, focused_window.as_ref());
    let (accessibility_nodes, accessibility_error) = if selector.app_filter.is_none()
        && selector.target_pid.is_none()
    {
        (
            Vec::new(),
            Some("no focused window or app filter was available for AT-SPI capture".to_string()),
        )
    } else {
        match snapshot_tree(
            selector.app_filter.as_deref(),
            selector.target_pid,
            SNAPSHOT_NODE_LIMIT,
            SNAPSHOT_DEPTH_LIMIT,
        )
        .await
        {
            Ok(nodes) => (nodes, None),
            Err(error) => (Vec::new(), Some(format!("{error:#}"))),
        }
    };

    let accessibility_text = appshot_accessibility_text(
        focused_window.as_ref(),
        &accessibility_nodes,
        accessibility_error.as_deref(),
    );

    AppshotCapture {
        focused_window,
        focused_window_error,
        screenshot,
        screenshot_error,
        accessibility_nodes,
        accessibility_error,
        accessibility_text,
    }
}

fn crop_capture_to_window(
    capture: ScreenshotCapture,
    focused_window: &WindowInfo,
) -> Result<ScreenshotCapture> {
    let Some(bounds) = focused_window.bounds.as_ref() else {
        anyhow::bail!("focused window bounds unavailable; refusing full-screen AppShot screenshot");
    };
    crop_capture_to_bounds(&capture, bounds)
}

fn crop_capture_to_bounds(
    capture: &ScreenshotCapture,
    bounds: &WindowBounds,
) -> Result<ScreenshotCapture> {
    let Some((x, y, width, height)) = crop_rect(capture.width, capture.height, bounds) else {
        anyhow::bail!(
            "focused window bounds did not intersect screenshot; refusing full-screen AppShot screenshot"
        );
    };

    if x == 0 && y == 0 && width == capture.width && height == capture.height {
        return Ok(capture.clone());
    }

    let image = decode_png_data_url(&capture.data_url)?;
    let cropped = image.crop_imm(x, y, width, height);
    let mut bytes = Cursor::new(Vec::new());
    cropped
        .write_to(&mut bytes, ImageFormat::Png)
        .context("failed to encode cropped screenshot PNG")?;
    let encoded = STANDARD.encode(bytes.into_inner());

    Ok(ScreenshotCapture {
        mime_type: "image/png".to_string(),
        data_url: format!("data:image/png;base64,{encoded}"),
        source: format!("{}:window-crop", capture.source),
        width,
        height,
    })
}

fn decode_png_data_url(data_url: &str) -> Result<DynamicImage> {
    let encoded = data_url
        .strip_prefix("data:image/png;base64,")
        .context("screenshot data URL was not a PNG data URL")?;
    let bytes = STANDARD
        .decode(encoded)
        .context("failed to decode screenshot data URL")?;
    image::load_from_memory_with_format(&bytes, ImageFormat::Png)
        .context("failed to decode screenshot PNG")
}

fn crop_rect(
    image_width: u32,
    image_height: u32,
    bounds: &WindowBounds,
) -> Option<(u32, u32, u32, u32)> {
    let x = bounds.x.unwrap_or(0).max(0) as u32;
    let y = bounds.y.unwrap_or(0).max(0) as u32;
    if x >= image_width || y >= image_height {
        return None;
    }

    let width = bounds.width.min(image_width - x);
    let height = bounds.height.min(image_height - y);
    if width == 0 || height == 0 {
        return None;
    }

    Some((x, y, width, height))
}

struct AccessibilitySelector {
    app_filter: Option<String>,
    target_pid: Option<u32>,
}

fn accessibility_selector(
    app_filter: Option<&str>,
    focused_window: Option<&WindowInfo>,
) -> AccessibilitySelector {
    let explicit_filter = app_filter
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(truncate_filter);
    let explicit_pid = explicit_filter
        .as_deref()
        .and_then(|value| value.strip_prefix("pid:"))
        .and_then(|value| value.parse::<u32>().ok());
    let app_filter = explicit_filter
        .filter(|value| !value.starts_with("pid:") && !value.starts_with("window:"))
        .or_else(|| {
            focused_window.and_then(|window| {
                first_non_empty([
                    window.app_id.as_deref(),
                    window.wm_class.as_deref(),
                    window.title.as_deref(),
                ])
                .map(truncate_filter)
            })
        });

    AccessibilitySelector {
        app_filter,
        target_pid: explicit_pid.or_else(|| focused_window.and_then(|window| window.pid)),
    }
}

pub fn appshot_accessibility_text(
    focused_window: Option<&WindowInfo>,
    nodes: &[AccessibilityNode],
    accessibility_error: Option<&str>,
) -> String {
    let mut output = String::new();
    output.push_str("Linux AppShot accessibility snapshot\n");
    if let Some(window) = focused_window {
        if let Some(app_name) =
            first_non_empty([window.app_id.as_deref(), window.wm_class.as_deref()])
        {
            push_capped_line(
                &mut output,
                &format!("Application: {}", normalize_field(app_name)),
            );
        }
        if let Some(title) = window
            .title
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            let app_name = first_non_empty([window.app_id.as_deref(), window.wm_class.as_deref()])
                .map(normalize_field)
                .unwrap_or_else(|| "Linux app".to_string());
            push_capped_line(
                &mut output,
                &format!(
                    "Window: \"{}\", App: {}",
                    normalize_field(title).replace('"', "'"),
                    app_name
                ),
            );
        }
        if let Some(pid) = window.pid {
            push_capped_line(&mut output, &format!("Process ID: {pid}"));
        }
    }
    if let Some(error) = accessibility_error.filter(|value| !value.trim().is_empty()) {
        push_capped_line(
            &mut output,
            &format!("Accessibility error: {}", normalize_field(error)),
        );
    }
    if nodes.is_empty() {
        push_capped_line(&mut output, "No accessible UI elements were captured.");
        return output;
    }

    output.push('\n');
    output.push_str("Elements:\n");
    for node in nodes {
        if output.len() >= MAX_AX_TEXT_CHARS {
            output.push_str("...\n");
            break;
        }
        push_capped_line(&mut output, &node_line(node));
    }

    output
}

fn node_line(node: &AccessibilityNode) -> String {
    let indent = "  ".repeat(node.depth.min(12) as usize);
    let mut parts = vec![node.role.clone()];
    if let Some(name) = node.name.as_deref().map(normalize_field) {
        parts.push(format!("name=\"{}\"", name.replace('"', "'")));
    }
    if let Some(description) = node.description.as_deref().map(normalize_field) {
        parts.push(format!("description=\"{}\"", description.replace('"', "'")));
    }
    if let Some(text) = node
        .text
        .as_ref()
        .and_then(|text| text.content.as_deref())
        .map(normalize_field)
    {
        parts.push(format!("text=\"{}\"", text.replace('"', "'")));
    }
    if let Some(value) = node
        .value
        .as_ref()
        .and_then(|value| value.text.as_deref())
        .map(normalize_field)
    {
        parts.push(format!("value=\"{}\"", value.replace('"', "'")));
    }
    if let Some(bounds) = node.bounds.as_ref() {
        parts.push(format!(
            "bounds={}x{}+{}+{}",
            bounds.width, bounds.height, bounds.x, bounds.y
        ));
    }
    if !node.states.is_empty() {
        parts.push(format!("states={}", node.states.join(",")));
    }

    format!("{indent}- {}", parts.join(" "))
}

fn first_non_empty<const N: usize>(values: [Option<&str>; N]) -> Option<&str> {
    values
        .into_iter()
        .flatten()
        .map(str::trim)
        .find(|value| !value.is_empty())
}

fn truncate_filter(value: &str) -> String {
    truncate_chars(value, MAX_APP_FILTER_CHARS)
}

fn normalize_field(value: &str) -> String {
    truncate_chars(&collapse_whitespace(value), MAX_FIELD_CHARS)
}

fn collapse_whitespace(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    let mut iter = value.chars();
    let truncated = iter.by_ref().take(max_chars).collect::<String>();
    if iter.next().is_some() {
        format!("{truncated}...")
    } else {
        truncated
    }
}

fn push_capped_line(output: &mut String, line: &str) {
    if output.len() >= MAX_AX_TEXT_CHARS {
        return;
    }
    let remaining = MAX_AX_TEXT_CHARS - output.len();
    if line.len() < remaining {
        output.push_str(line);
        output.push('\n');
        return;
    }

    let slice = truncate_chars(line, remaining.saturating_sub(4));
    output.push_str(&slice);
    output.push_str("...\n");
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::windows::{WindowBounds, GNOME_SHELL_INTROSPECT_BACKEND};

    fn window() -> WindowInfo {
        WindowInfo {
            window_id: 42,
            title: Some("Codex Desktop".to_string()),
            app_id: Some("codex-desktop".to_string()),
            wm_class: Some("codex-desktop".to_string()),
            pid: Some(1234),
            bounds: Some(WindowBounds {
                x: Some(10),
                y: Some(20),
                width: 800,
                height: 600,
            }),
            workspace: None,
            focused: true,
            hidden: false,
            client_type: Some("wayland".to_string()),
            backend: GNOME_SHELL_INTROSPECT_BACKEND.to_string(),
            terminal: None,
        }
    }

    #[test]
    fn accessibility_selector_prefers_explicit_pid() {
        let selector = accessibility_selector(Some("pid:999"), Some(&window()));

        assert_eq!(selector.app_filter, Some("codex-desktop".to_string()));
        assert_eq!(selector.target_pid, Some(999));
    }

    #[test]
    fn accessibility_text_includes_renderer_window_title_hint() {
        let text = appshot_accessibility_text(Some(&window()), &[], None);

        assert!(text.contains("Application: codex-desktop"));
        assert!(text.contains("Window: \"Codex Desktop\", App: codex-desktop"));
        assert!(text.contains("No accessible UI elements were captured."));
    }

    #[test]
    fn crop_rect_clamps_window_bounds_to_screenshot() {
        let rect = crop_rect(
            100,
            80,
            &WindowBounds {
                x: Some(10),
                y: Some(20),
                width: 200,
                height: 200,
            },
        );

        assert_eq!(rect, Some((10, 20, 90, 60)));
        assert_eq!(
            crop_rect(
                100,
                80,
                &WindowBounds {
                    x: Some(200),
                    y: Some(0),
                    width: 10,
                    height: 10,
                },
            ),
            None
        );
    }

    #[test]
    fn crop_capture_to_window_requires_bounds() {
        let mut window = window();
        window.bounds = None;
        let capture = ScreenshotCapture {
            mime_type: "image/png".to_string(),
            data_url: "data:image/png;base64,".to_string(),
            source: "xdg-desktop-portal".to_string(),
            width: 100,
            height: 100,
        };

        let error = crop_capture_to_window(capture, &window).unwrap_err();

        assert!(error
            .to_string()
            .contains("focused window bounds unavailable"));
    }

    #[test]
    fn crop_capture_to_window_rejects_non_intersecting_bounds() {
        let mut window = window();
        window.bounds = Some(WindowBounds {
            x: Some(200),
            y: Some(200),
            width: 20,
            height: 20,
        });
        let capture = ScreenshotCapture {
            mime_type: "image/png".to_string(),
            data_url: "data:image/png;base64,".to_string(),
            source: "xdg-desktop-portal".to_string(),
            width: 100,
            height: 100,
        };

        let error = crop_capture_to_window(capture, &window).unwrap_err();

        assert!(error.to_string().contains("did not intersect screenshot"));
    }
}
