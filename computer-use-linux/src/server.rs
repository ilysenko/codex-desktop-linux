use crate::atspi_tree::{
    focused_element_summary, list_accessible_apps, perform_action as invoke_accessibility_action,
    set_element_value, snapshot_tree, AccessibilityAction, AccessibilityNode, AccessibleAppSummary,
    Bounds, FocusedElementSummary, ValueSetInvocation,
};
use crate::diagnostics::{doctor_report, setup_accessibility_report, DoctorReport, SetupReport};
use crate::gnome_extension::{setup_window_targeting_report, WindowTargetingSetupReport};
use crate::remote_desktop::{
    click as portal_click, drag as portal_drag, keysyms_for_text, press_keycode_chord,
    scroll as portal_scroll, start_portal_keyboard_session, start_portal_pointer_session,
    type_text_with_keysyms, PointerButton, PortalKeyboardSession, PortalPointerSession,
    ScrollDirection,
};
use crate::screenshot::{
    capture_screenshot_raw, prepare_screenshot_payload, RawScreenshotCapture, ScreenshotCapture,
    ScreenshotOutputFormat, ScreenshotPayloadOptions,
};
use crate::windowing::registry;
use crate::windows::{
    focus_window_target, focused_window, list_windows, resolve_window_target,
    window_permission_hint, WindowFocusResult, WindowInfo, WindowTarget,
    GNOME_SHELL_INTROSPECT_BACKEND,
};
use crate::ydotool;
use anyhow::Result;
use rmcp::{
    handler::server::wrapper::{Json, Parameters},
    model::{CallToolResult, Content},
    schemars::JsonSchema,
    tool, tool_handler, tool_router, ErrorData, ServerHandler, ServiceExt,
};
use serde::{Deserialize, Serialize};
use std::{
    env, fs,
    future::Future,
    os::unix::{
        ffi::OsStrExt,
        fs::{FileTypeExt, MetadataExt},
        net::{UnixDatagram, UnixStream},
    },
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    net::UnixStream as TokioUnixStream,
    process::{Child as TokioChild, Command as TokioCommand},
    time::{sleep, timeout},
};
use zbus::{Connection as ZbusConnection, Proxy as ZbusProxy};

const YDOTOOL_TIMEOUT: Duration = Duration::from_secs(10);
const YDOTOOL_TYPE_CHARS_PER_SECOND: u64 = 20;
const KDE_CLIPBOARD_DBUS_TIMEOUT: Duration = Duration::from_secs(3);
const KDE_KLIPPER_SERVICE: &str = "org.kde.klipper";
const KDE_KLIPPER_PATH: &str = "/klipper";
const KDE_KLIPPER_INTERFACE: &str = "org.kde.klipper.klipper";
const AVATAR_CURSOR_SOCKET_NAME: &str = "computer-use-cursor.sock";
const AVATAR_CURSOR_SOCKET_MAX_BYTES: usize = 100;
const AVATAR_CURSOR_NOTIFY_TIMEOUT: Duration = Duration::from_millis(100);

#[derive(Clone, Default)]
pub struct ComputerUseLinux {
    last_nodes: Arc<Mutex<Vec<AccessibilityNode>>>,
    portal_pointer_session: Arc<Mutex<Option<PortalPointerSession>>>,
    portal_keyboard_session: Arc<Mutex<Option<PortalKeyboardSession>>>,
    /// Lazily-created uinput absolute pointer (preferred coordinate backend).
    abs_pointer: Arc<Mutex<Option<crate::abs_pointer::AbsPointer>>>,
    portal_keyboard_init_lock: Arc<tokio::sync::Mutex<()>>,
    kde_clipboard_lock: Arc<tokio::sync::Mutex<()>>,
    /// Cached logical desktop size (union of monitors) from the most recent
    /// full-frame capture; used for off-screen window/coordinate warnings.
    desktop_size: Arc<Mutex<Option<(u32, u32)>>>,
}

#[tool_router]
impl ComputerUseLinux {
    #[tool(
        name = "doctor",
        description = "Report Linux Computer Use desktop integration readiness.",
        annotations(
            read_only_hint = true,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = false
        )
    )]
    fn doctor(&self) -> Json<DoctorReport> {
        Json(doctor_report())
    }

    #[tool(
        name = "setup_accessibility",
        description = "Enable GNOME accessibility through gsettings so Linux Computer Use can read AT-SPI trees.",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = false
        )
    )]
    fn setup_accessibility(&self) -> Json<SetupReport> {
        Json(setup_accessibility_report())
    }

    #[tool(
        name = "setup_window_targeting",
        description = "Install and enable the optional GNOME Shell extension used for exact window list/focus targeting when GNOME blocks native introspection.",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = false
        )
    )]
    async fn setup_window_targeting(&self) -> Json<WindowTargetingSetupReport> {
        Json(setup_window_targeting_report().await)
    }

    #[tool(
        name = "list_apps",
        description = "List running Linux desktop app candidates visible to the Computer Use backend.",
        annotations(
            read_only_hint = true,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = true
        )
    )]
    async fn list_apps(&self) -> Json<ListAppsOutput> {
        let (accessible_apps, accessibility_error) = match list_accessible_apps(50).await {
            Ok(apps) => (apps, None),
            Err(error) => (Vec::new(), Some(format!("{error:#}"))),
        };

        Json(ListAppsOutput {
            apps: list_process_apps(),
            accessible_apps,
            accessibility_error,
            note: "Linux Computer Use lists process candidates plus AT-SPI application roots when accessibility is enabled.".to_string(),
        })
    }

    #[tool(
        name = "list_windows",
        description = "List compositor windows with title, app id, class, focus state, client type, and known bounds.",
        annotations(
            read_only_hint = true,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = true
        )
    )]
    async fn list_windows(&self) -> Json<ListWindowsOutput> {
        Json(window_list_output().await)
    }

    #[tool(
        name = "focused_window",
        description = "Return the compositor window that currently has keyboard focus.",
        annotations(
            read_only_hint = true,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = true
        )
    )]
    async fn focused_window(&self) -> Json<FocusedWindowOutput> {
        match focused_window().await {
            Ok(window) => {
                let backend = window_backend(window.as_ref().into_iter());
                Json(FocusedWindowOutput {
                    backend,
                    focused_window: window,
                    error: None,
                    permissions_hint: None,
                    message:
                        "Focused window query completed through the available compositor window backend."
                            .to_string(),
                })
            }
            Err(error) => {
                let error = format!("{error:#}");
                Json(FocusedWindowOutput {
                    backend: GNOME_SHELL_INTROSPECT_BACKEND.to_string(),
                    focused_window: None,
                    permissions_hint: window_permission_hint(&error),
                    error: Some(error),
                    message: "Focused window query failed; targeted keyboard input is unavailable until window introspection works.".to_string(),
                })
            }
        }
    }

    #[tool(
        name = "activate_window",
        description = "Focus a Linux desktop window by window_id, pid, app_id, wm_class, title, or terminal selectors when the compositor permits it.",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = true
        )
    )]
    async fn activate_window(
        &self,
        Parameters(params): Parameters<ActivateWindowParams>,
    ) -> Json<ActivateWindowOutput> {
        let target = params.into_target();
        let received = Some(serde_json::json!(target.clone()));
        match focus_window_target(&target).await {
            Ok(focus) => {
                let ok = focus_satisfies_target(&focus, &target);
                Json(ActivateWindowOutput {
                    ok,
                    implemented: true,
                    backend: focus.backend.clone(),
                    focus: Some(focus),
                    error: None,
                    permissions_hint: None,
                    received,
                })
            }
            Err(error) => {
                let error = format!("{error:#}");
                Json(ActivateWindowOutput {
                    ok: false,
                    implemented: true,
                    backend: GNOME_SHELL_INTROSPECT_BACKEND.to_string(),
                    focus: None,
                    permissions_hint: window_permission_hint(&error),
                    error: Some(error),
                    received,
                })
            }
        }
    }

    #[tool(
        name = "get_app_state",
        description = "Start an app use session if needed, then get a size-bounded screenshot and accessibility state for a Linux app. Screenshot results include coordinate_width, coordinate_height, scale, format, and quality when the returned image is downscaled or compressed; callers can request jpeg/quality for compression before resizing.",
        annotations(
            read_only_hint = true,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = true
        )
    )]
    async fn get_app_state(
        &self,
        Parameters(params): Parameters<GetAppStateParams>,
    ) -> Json<GetAppStateOutput> {
        let verbose = params.verbose.unwrap_or(false);
        let diagnostics = doctor_report();
        let (window_context, window_error, window_permissions_hint) =
            self.resolve_window_context(&params).await;
        let max_nodes = params.max_nodes.unwrap_or(120).clamp(1, 500);
        let max_depth = params.max_depth.unwrap_or(12).min(12);
        let include_screenshot = params.include_screenshot.unwrap_or(true);
        let screenshot_options = params.screenshot_options();
        let app_filter = self
            .resolve_accessibility_app_filter(&params, window_context.as_ref())
            .await;
        let (screenshot, screenshot_error) = if include_screenshot {
            match capture_screenshot_raw()
                .await
                .and_then(|raw| prepare_screenshot_payload(raw, screenshot_options))
            {
                Ok(capture) => (Some(capture), None),
                Err(error) => (None, Some(format!("{error:#}"))),
            }
        } else {
            (None, None)
        };
        let (accessibility_tree, accessibility_tree_raw_count, accessibility_error) =
            if diagnostics.readiness.can_build_accessibility_tree {
                let target_pid = window_context.as_ref().and_then(|window| window.pid);
                match snapshot_tree(app_filter.as_deref(), target_pid, max_nodes, max_depth).await {
                    Ok(nodes) => {
                        let raw_count = nodes.len();
                        (compact_accessibility_tree(nodes), raw_count, None)
                    }
                    Err(error) => (Vec::new(), 0, Some(format!("{error:#}"))),
                }
            } else {
                (
                    Vec::new(),
                    0,
                    Some(
                        "GNOME accessibility is disabled; call setup_accessibility first."
                            .to_string(),
                    ),
                )
            };
        if accessibility_error.is_none() {
            self.cache_nodes(&accessibility_tree);
        } else {
            self.clear_cached_nodes();
        }
        let mut message = if let Some(error) = &accessibility_error {
            format!("MCP registration is working, but AT-SPI tree extraction failed: {error}")
        } else if let Some(capture) = &screenshot {
            format!(
                "MCP registration, screenshot capture, and AT-SPI tree extraction are working. Captured {} accessibility nodes (compacted from {}) and a screenshot through {}.",
                accessibility_tree.len(),
                accessibility_tree_raw_count,
                capture.source
            )
        } else if let Some(error) = &screenshot_error {
            format!(
                "MCP registration and AT-SPI tree extraction are working. Captured {} accessibility nodes (compacted from {}). Screenshot capture failed: {error}",
                accessibility_tree.len(),
                accessibility_tree_raw_count,
            )
        } else {
            format!(
                "MCP registration and AT-SPI tree extraction are working. Captured {} accessibility nodes (compacted from {}). Screenshot capture was not requested.",
                accessibility_tree.len(),
                accessibility_tree_raw_count,
            )
        };
        if let Some(window) = &window_context {
            message.push_str(&format!(
                " Window target resolved to window_id {}.",
                window.window_id
            ));
        } else if let Some(error) = &window_error {
            message.push_str(&format!(" Window target resolution failed: {error}"));
        }

        // Full diagnostics are huge (portal/process dumps); emit them only on
        // request. The compact readiness block always travels, and failures get
        // a pointer to verbose=true instead of an automatic dump.
        let readiness = diagnostics.readiness.clone();
        let include_full = verbose;
        if !include_full
            && (accessibility_error.is_some()
                || screenshot_error.is_some()
                || window_error.is_some())
        {
            message.push_str(" Pass verbose=true for full diagnostics.");
        }
        Json(GetAppStateOutput {
            app_name_or_bundle_identifier: params.app_name_or_bundle_identifier,
            window_context,
            window_error,
            window_permissions_hint,
            backend: "linux-atspi".to_string(),
            screenshot,
            screenshot_error,
            accessibility_tree,
            accessibility_tree_raw_count,
            accessibility_error,
            readiness,
            diagnostics: include_full.then_some(diagnostics),
            message,
        })
    }

    #[tool(
        name = "screenshot",
        description = "Capture the screen and return it as a viewable, size-bounded image. Optionally target a window (window_id/pid/wm_class/title/app_id): the window is raised to the front and the image is cropped before any resize. Returns the image plus a short caption with returned dimensions, coordinate dimensions, scale, format, quality, source, and crop bounds; callers can request jpeg/quality for compression before resizing.",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = false,
            open_world_hint = true
        )
    )]
    async fn screenshot(
        &self,
        Parameters(params): Parameters<ScreenshotParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let target = params.window_target();

        // When targeting a window, raise it first (so it isn't occluded) and
        // resolve its bounds so we can crop to just that window.
        let mut crop: Option<crate::windowing::WindowBounds> = None;
        let mut window_label: Option<String> = None;
        if let Some(target) = &target {
            if params.raise_window.unwrap_or(true) {
                let _ = focus_window_target(target).await;
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
            if !params.full_screen.unwrap_or(false) {
                if let Ok(windows) = list_windows().await {
                    if let Ok(window) = resolve_window_target(&windows, target) {
                        crop = window.bounds.clone();
                        window_label = window.title.clone();
                    }
                }
            }
        }

        let raw_capture = capture_screenshot_raw()
            .await
            .map_err(|e| ErrorData::internal_error(format!("screenshot failed: {e}"), None))?;
        self.cache_desktop_size(raw_capture.width, raw_capture.height);

        // Warn when the target window extends past the visible desktop: the
        // portal only captures on-screen pixels, so the crop silently loses the
        // off-screen region while coordinate metadata still claims full size.
        let off_screen_note = match crop.as_ref() {
            Some(bounds) => self.off_screen_note_for_bounds(bounds).await,
            None => None,
        };

        let (capture, cropped) = match crop.as_ref().and_then(window_crop_rect) {
            Some((x, y, w, h)) => match crop_png(&raw_capture.bytes, x, y, w, h) {
                Ok((bytes, cw, ch)) => (
                    RawScreenshotCapture {
                        mime_type: raw_capture.mime_type.clone(),
                        bytes,
                        source: raw_capture.source.clone(),
                        width: cw,
                        height: ch,
                    },
                    true,
                ),
                // If cropping fails, fall back to the full frame rather than erroring.
                Err(_) => (raw_capture, false),
            },
            None => (raw_capture, false),
        };
        let capture =
            prepare_screenshot_payload(capture, params.screenshot_options()).map_err(|e| {
                ErrorData::internal_error(format!("screenshot resize failed: {e}"), None)
            })?;

        let mut caption = serde_json::json!({
            "width": capture.width,
            "height": capture.height,
            "coordinate_width": capture.coordinate_width,
            "coordinate_height": capture.coordinate_height,
            "scale": capture.scale,
            "resized": capture.resized,
            "bytes": capture.bytes,
            "original_bytes": capture.original_bytes,
            "max_bytes": capture.max_bytes,
            "format": capture.format,
            "quality": capture.quality,
            "source": capture.source,
            "cropped_to_window": cropped,
            "window_title": window_label,
        });
        if let Some(note) = off_screen_note {
            caption["window_off_screen"] = serde_json::json!(true);
            caption["off_screen_note"] = serde_json::json!(note);
        }
        Ok(CallToolResult::success(vec![
            Content::image(data_url_payload(&capture.data_url), capture.mime_type),
            Content::text(caption.to_string()),
        ]))
    }

    /// Lazily create the uinput absolute pointer, sizing its ABS range to the
    /// logical desktop (the portal screenshot dimensions). Returns `false` if it
    /// can't be created or is disabled via `CU_DISABLE_ABS_POINTER` (or the
    /// Codex embedded-build alias).
    async fn ensure_abs_pointer(&self) -> bool {
        if env_flag_enabled_any(&[
            "CU_DISABLE_ABS_POINTER",
            "CODEX_COMPUTER_USE_DISABLE_ABS_POINTER",
        ]) {
            return false;
        }
        if self
            .abs_pointer
            .lock()
            .map(|g| g.is_some())
            .unwrap_or(false)
        {
            return true;
        }
        let Ok(cap) = capture_screenshot_raw().await else {
            return false;
        };
        self.cache_desktop_size(cap.width, cap.height);
        match tokio::task::spawn_blocking(move || {
            crate::abs_pointer::AbsPointer::create(cap.width as i32, cap.height as i32)
        })
        .await
        {
            Ok(Ok(pointer)) => {
                if let Ok(mut guard) = self.abs_pointer.lock() {
                    *guard = Some(pointer);
                    return true;
                }
                false
            }
            _ => false,
        }
    }

    /// Try a coordinate click through the absolute uinput pointer. `Some(ok)` if
    /// the backend was used; `None` to fall through to portal / ydotool.
    async fn try_abs_click(
        &self,
        x: i32,
        y: i32,
        button: Option<&str>,
        count: u32,
    ) -> Option<bool> {
        if !self.ensure_abs_pointer().await {
            return None;
        }
        let btn = crate::abs_pointer::PointerButton::from_name(button);
        let abs_pointer = Arc::clone(&self.abs_pointer);
        tokio::task::spawn_blocking(move || {
            let mut guard = abs_pointer.lock().ok()?;
            let pointer = guard.as_mut()?;
            Some(pointer.click(x, y, btn, count).is_ok())
        })
        .await
        .ok()
        .flatten()
    }

    #[tool(
        name = "click",
        description = "Click an element by index, semantic selector, or desktop coordinate pixels from screenshot metadata.",
        annotations(
            read_only_hint = false,
            destructive_hint = true,
            idempotent_hint = false,
            open_world_hint = true
        )
    )]
    async fn click(&self, Parameters(mut params): Parameters<ClickParams>) -> Json<ActionOutput> {
        let received = Some(serde_json::json!(params.clone()));
        // Raise the target window first (if specified) so the click lands on the
        // intended app rather than whatever is stacked on top at that pixel.
        let window_target = params.window_target();
        if params.relative == Some(true) && window_target.is_none() {
            return Json(ActionOutput {
                ok: false,
                implemented: true,
                action: "click".to_string(),
                message: "Relative coordinate clicks require a window target.".to_string(),
                received,
            });
        }
        if let Some(target) = window_target {
            let focus = match self.focus_target_for_input(&target).await {
                Ok(focus) => focus,
                Err(message) => {
                    return Json(ActionOutput {
                        ok: false,
                        implemented: true,
                        action: "click".to_string(),
                        message,
                        received,
                    });
                }
            };
            tokio::time::sleep(Duration::from_millis(120)).await;
            // Window-relative coordinates: translate by the window's top-left so
            // the agent can click the pixel it saw in a window-cropped screenshot.
            if params.relative == Some(true) {
                let Some(focus) = focus.as_ref() else {
                    return Json(ActionOutput {
                        ok: false,
                        implemented: true,
                        action: "click".to_string(),
                        message: "Relative coordinate clicks require verified target-window focus."
                            .to_string(),
                        received,
                    });
                };
                if let Err(message) = apply_window_relative_click_coordinates(&mut params, focus) {
                    return Json(ActionOutput {
                        ok: false,
                        implemented: true,
                        action: "click".to_string(),
                        message,
                        received,
                    });
                }
            }
        }
        let target = match self.resolve_click_target(&params) {
            Ok(target) => target,
            Err(message) => {
                return Json(ActionOutput {
                    ok: false,
                    implemented: true,
                    action: "click".to_string(),
                    message,
                    received,
                });
            }
        };
        if let ClickTarget::PrimaryAction {
            object_ref,
            action_name,
            action_index,
        } = target
        {
            let action_index = action_index.to_string();
            return match invoke_accessibility_action(&object_ref, Some(&action_index)).await {
                Ok(invocation) => Json(ActionOutput {
                    ok: invocation.ok,
                    implemented: true,
                    action: "click".to_string(),
                    message: if invocation.ok {
                        format!(
                            "No clickable bounds were cached, so I invoked the primary AT-SPI action{}.",
                            action_name
                                .as_deref()
                                .filter(|name| !name.is_empty())
                                .map(|name| format!(" ({name})"))
                                .unwrap_or_default()
                        )
                    } else {
                        format!(
                            "The primary AT-SPI action{} returned false.",
                            action_name
                                .as_deref()
                                .filter(|name| !name.is_empty())
                                .map(|name| format!(" ({name})"))
                                .unwrap_or_default()
                        )
                    },
                    received,
                }),
                Err(error) => Json(ActionOutput {
                    ok: false,
                    implemented: true,
                    action: "click".to_string(),
                    message: error.to_string(),
                    received,
                }),
            };
        }
        let ClickTarget::Coordinates(x, y) = target else {
            unreachable!("click target must resolve to coordinates or an AT-SPI action");
        };
        let button = mouse_button_code(params.button.as_deref());
        let click_count = params.click_count.unwrap_or(1).clamp(1, 10).to_string();
        // Preferred backend: the uinput absolute pointer. Unlike ydotool's
        // relative-only device (faked `--absolute` via pin-to-corner + relative
        // move, which acceleration + fractional scaling distort) and unlike the
        // portal (per-monitor coordinate scaling + an approval dialog), the
        // absolute pointer lands exactly at the screenshot pixel.
        // Off-screen coordinates "succeed" at the uinput layer while landing on
        // no visible pixel — surface that instead of a silent no-op.
        let off_screen_note = self.off_screen_note_for_point(x, y).await;
        if self
            .try_abs_click(
                x,
                y,
                params.button.as_deref(),
                params.click_count.unwrap_or(1).clamp(1, 10),
            )
            .await
            == Some(true)
        {
            return Json(with_notes(
                pointer_action_result(ActionOutput {
                    ok: true,
                    implemented: true,
                    action: "click".to_string(),
                    message: "Action sent through the uinput absolute pointer.".to_string(),
                    received,
                }),
                off_screen_note.clone(),
            ));
        }
        if let Some(session) = self.cached_portal_pointer_session() {
            match portal_click(
                &session,
                x,
                y,
                PointerButton::from_name(params.button.as_deref()),
                params.click_count.unwrap_or(1).clamp(1, 10),
            )
            .await
            {
                Ok(()) => {
                    return Json(with_notes(
                        pointer_action_result(ActionOutput {
                            ok: true,
                            implemented: true,
                            action: "click".to_string(),
                            message: "Action sent through the remote desktop portal.".to_string(),
                            received,
                        }),
                        off_screen_note.clone(),
                    ));
                }
                Err(_) => self.clear_portal_pointer_session(),
            }
        } else if self.should_prefer_portal_pointer_backend() {
            match self.ensure_portal_pointer_session().await {
                Ok(Some(session)) => match portal_click(
                    &session,
                    x,
                    y,
                    PointerButton::from_name(params.button.as_deref()),
                    params.click_count.unwrap_or(1).clamp(1, 10),
                )
                .await
                {
                    Ok(()) => {
                        return Json(with_notes(
                            pointer_action_result(ActionOutput {
                                ok: true,
                                implemented: true,
                                action: "click".to_string(),
                                message: "Action sent through the remote desktop portal."
                                    .to_string(),
                                received,
                            }),
                            off_screen_note.clone(),
                        ));
                    }
                    Err(_) => self.clear_portal_pointer_session(),
                },
                Ok(None) => {}
                Err(_) => {}
            }
        }
        let result = run_ydotool_sequence(&[
            absolute_mousemove_args(x, y),
            vec![
                "click".to_string(),
                "--repeat".to_string(),
                click_count,
                button,
            ],
        ])
        .await;
        Json(with_notes(
            pointer_action_result(action_result("click", result, received)),
            off_screen_note,
        ))
    }

    #[tool(
        name = "perform_action",
        description = "Invoke an accessibility action exposed by an element selected by index, identifier, or semantic selector. Defaults to the primary action unless action is provided.",
        annotations(
            read_only_hint = false,
            destructive_hint = true,
            idempotent_hint = false,
            open_world_hint = true
        )
    )]
    async fn perform_action(
        &self,
        Parameters(params): Parameters<ActionParams>,
    ) -> Json<ActionOutput> {
        let requested_action = requested_or_primary_action(params.action.as_deref());
        self.perform_element_action(&params, Some(requested_action))
            .await
    }

    #[tool(
        name = "set_value",
        description = "Set the value of a settable accessibility element selected by index, identifier, or semantic selector.",
        annotations(
            read_only_hint = false,
            destructive_hint = true,
            idempotent_hint = false,
            open_world_hint = true
        )
    )]
    async fn set_value(
        &self,
        Parameters(params): Parameters<SetValueParams>,
    ) -> Json<ActionOutput> {
        let received = Some(serde_json::json!(params.clone()));
        let object_ref = match self.resolve_object_ref(
            params.element_index,
            params.element_identifier.as_deref(),
            &params.selector(),
            ElementResolvePurpose::SetValue,
        ) {
            Ok(object_ref) => object_ref,
            Err(message) => {
                return Json(ActionOutput {
                    ok: false,
                    implemented: true,
                    action: "set_value".to_string(),
                    message,
                    received,
                });
            }
        };

        match set_element_value(&object_ref, &params.value).await {
            Ok(ValueSetInvocation::Numeric { value }) => Json(ActionOutput {
                ok: true,
                implemented: true,
                action: "set_value".to_string(),
                message: format!("AT-SPI numeric value set to {value}."),
                received,
            }),
            Ok(ValueSetInvocation::EditableText) => Json(ActionOutput {
                ok: true,
                implemented: true,
                action: "set_value".to_string(),
                message: "AT-SPI editable text contents set.".to_string(),
                received,
            }),
            Err(error) => Json(ActionOutput {
                ok: false,
                implemented: true,
                action: "set_value".to_string(),
                message: error.to_string(),
                received,
            }),
        }
    }

    #[tool(
        name = "scroll",
        description = "Scroll an element in a direction by a number of pages. With a window target and no x/y/element_index, scrolls at the centre of the targeted window.",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = false,
            open_world_hint = true
        )
    )]
    async fn scroll(&self, Parameters(mut params): Parameters<ScrollParams>) -> Json<ActionOutput> {
        let received = Some(serde_json::json!(params.clone()));
        let units = ((params.pages.unwrap_or(1.0).abs().max(0.1) * 5.0).round() as i32).max(1);
        // Raise/focus the target window first (parity with click) so wheel
        // events land on the intended app.
        let window_target = params.window_target();
        if params.relative == Some(true) && window_target.is_none() {
            return Json(ActionOutput {
                ok: false,
                implemented: true,
                action: "scroll".to_string(),
                message: "Relative scroll coordinates require a window target.".to_string(),
                received,
            });
        }
        if let Some(target) = window_target {
            let focus = match self.focus_target_for_input(&target).await {
                Ok(focus) => focus,
                Err(message) => {
                    return Json(ActionOutput {
                        ok: false,
                        implemented: true,
                        action: "scroll".to_string(),
                        message,
                        received,
                    });
                }
            };
            tokio::time::sleep(Duration::from_millis(120)).await;
            if params.relative == Some(true) {
                let Some(focus) = focus.as_ref() else {
                    return Json(ActionOutput {
                        ok: false,
                        implemented: true,
                        action: "scroll".to_string(),
                        message:
                            "Relative scroll coordinates require verified target-window focus."
                                .to_string(),
                        received,
                    });
                };
                if let Err(message) = apply_window_relative_scroll_coordinates(&mut params, focus) {
                    return Json(ActionOutput {
                        ok: false,
                        implemented: true,
                        action: "scroll".to_string(),
                        message,
                        received,
                    });
                }
            } else if params.x.is_none() && params.y.is_none() && params.element_index.is_none() {
                // A window target without a point would otherwise scroll
                // whatever happens to sit under the pointer: focusing does not
                // move the cursor, and the wheel path never repositions it.
                // Default to the centre of the resolved target window.
                let Some(focus) = focus.as_ref() else {
                    return Json(ActionOutput {
                        ok: false,
                        implemented: true,
                        action: "scroll".to_string(),
                        message: "Window-targeted scroll requires verified target-window focus."
                            .to_string(),
                        received,
                    });
                };
                if let Err(message) = apply_window_center_scroll_point(&mut params, focus) {
                    return Json(ActionOutput {
                        ok: false,
                        implemented: true,
                        action: "scroll".to_string(),
                        message,
                        received,
                    });
                }
            }
        }
        let target_point =
            match self.resolve_optional_target_point(params.x, params.y, params.element_index) {
                Ok(point) => point,
                Err(message) => {
                    return Json(ActionOutput {
                        ok: false,
                        implemented: true,
                        action: "scroll".to_string(),
                        message,
                        received,
                    });
                }
            };
        let direction = match params.direction.to_ascii_lowercase().as_str() {
            "up" => ScrollDirection::Up,
            "down" => ScrollDirection::Down,
            "left" => ScrollDirection::Left,
            "right" => ScrollDirection::Right,
            _ => {
                return Json(ActionOutput {
                    ok: false,
                    implemented: true,
                    action: "scroll".to_string(),
                    message: "Unsupported scroll direction; expected up, down, left, or right."
                        .to_string(),
                    received,
                });
            }
        };
        let off_screen_note = match target_point {
            Some((x, y)) => self.off_screen_note_for_point(x, y).await,
            None => None,
        };

        if let Some(session) = self.cached_portal_pointer_session() {
            match portal_scroll(&session, target_point, direction, units).await {
                Ok(()) => {
                    return Json(with_notes(
                        pointer_action_result(ActionOutput {
                            ok: true,
                            implemented: true,
                            action: "scroll".to_string(),
                            message: "Action sent through the remote desktop portal.".to_string(),
                            received,
                        }),
                        off_screen_note.clone(),
                    ));
                }
                Err(_) => self.clear_portal_pointer_session(),
            }
        } else if self.should_prefer_portal_pointer_backend() {
            match self.ensure_portal_pointer_session().await {
                Ok(Some(session)) => {
                    match portal_scroll(&session, target_point, direction, units).await {
                        Ok(()) => {
                            return Json(with_notes(
                                pointer_action_result(ActionOutput {
                                    ok: true,
                                    implemented: true,
                                    action: "scroll".to_string(),
                                    message: "Action sent through the remote desktop portal."
                                        .to_string(),
                                    received,
                                }),
                                off_screen_note.clone(),
                            ));
                        }
                        Err(_) => self.clear_portal_pointer_session(),
                    }
                }
                Ok(None) => {}
                Err(_) => {}
            }
        }
        let (dx, dy) = match params.direction.to_ascii_lowercase().as_str() {
            "up" => (0, units),
            "down" => (0, -units),
            "left" => (units, 0),
            "right" => (-units, 0),
            _ => {
                return Json(ActionOutput {
                    ok: false,
                    implemented: true,
                    action: "scroll".to_string(),
                    message: "Unsupported scroll direction; expected up, down, left, or right."
                        .to_string(),
                    received,
                });
            }
        };
        let mut sequence = Vec::new();
        if let Some((x, y)) = target_point {
            sequence.push(absolute_mousemove_args(x, y));
        }
        sequence.push(wheel_mousemove_args(dx, dy));
        let result = run_ydotool_sequence(&sequence).await;
        Json(with_notes(
            pointer_action_result(action_result("scroll", result, received)),
            off_screen_note,
        ))
    }

    #[tool(
        name = "drag",
        description = "Drag from one point to another using pixel coordinates.",
        annotations(
            read_only_hint = false,
            destructive_hint = true,
            idempotent_hint = false,
            open_world_hint = true
        )
    )]
    async fn drag(&self, Parameters(params): Parameters<DragParams>) -> Json<ActionOutput> {
        let received = Some(serde_json::json!(params));
        // Preferred backend: the uinput absolute pointer (accurate landing).
        if self.ensure_abs_pointer().await {
            let abs_pointer = Arc::clone(&self.abs_pointer);
            let dragged = tokio::task::spawn_blocking(move || {
                if let Ok(mut guard) = abs_pointer.lock() {
                    guard.as_mut().map(|p| {
                        p.drag(
                            (params.start_x, params.start_y),
                            (params.end_x, params.end_y),
                            crate::abs_pointer::PointerButton::Left,
                        )
                        .is_ok()
                    })
                } else {
                    None
                }
            })
            .await
            .ok()
            .flatten();
            if dragged == Some(true) {
                return Json(pointer_action_result(ActionOutput {
                    ok: true,
                    implemented: true,
                    action: "drag".to_string(),
                    message: "Action sent through the uinput absolute pointer.".to_string(),
                    received,
                }));
            }
        }
        if let Some(session) = self.cached_portal_pointer_session() {
            match portal_drag(
                &session,
                params.start_x,
                params.start_y,
                params.end_x,
                params.end_y,
            )
            .await
            {
                Ok(()) => {
                    return Json(pointer_action_result(ActionOutput {
                        ok: true,
                        implemented: true,
                        action: "drag".to_string(),
                        message: "Action sent through the remote desktop portal.".to_string(),
                        received,
                    }));
                }
                Err(_) => self.clear_portal_pointer_session(),
            }
        } else if self.should_prefer_portal_pointer_backend() {
            match self.ensure_portal_pointer_session().await {
                Ok(Some(session)) => match portal_drag(
                    &session,
                    params.start_x,
                    params.start_y,
                    params.end_x,
                    params.end_y,
                )
                .await
                {
                    Ok(()) => {
                        return Json(pointer_action_result(ActionOutput {
                            ok: true,
                            implemented: true,
                            action: "drag".to_string(),
                            message: "Action sent through the remote desktop portal.".to_string(),
                            received,
                        }));
                    }
                    Err(_) => self.clear_portal_pointer_session(),
                },
                Ok(None) => {}
                Err(_) => {}
            }
        }
        let result = run_ydotool_sequence(&[
            absolute_mousemove_args(params.start_x, params.start_y),
            vec!["click".to_string(), "0x40".to_string()],
            absolute_mousemove_args(params.end_x, params.end_y),
            vec!["click".to_string(), "0x80".to_string()],
        ])
        .await;
        Json(pointer_action_result(action_result(
            "drag", result, received,
        )))
    }

    #[tool(
        name = "press_key",
        description = "Press a key or key-combination on the keyboard, optionally after focusing a target window or terminal selector. Key grammar (case-insensitive; hyphens/spaces ignored): combos join with '+', e.g. Ctrl+L or Ctrl+Shift+T. Modifiers: ctrl/control, alt/option, shift, meta/super/cmd/command. Named keys: enter/return, escape/esc, tab, backspace, delete/del, space, home, end, pageup, pagedown, arrowleft/left, arrowright/right, arrowup/up, arrowdown/down, f1-f12. Plus single US letters a-z and digits 0-9. Anything else returns an error (never silently dropped). Note: compositor-level shortcuts (e.g. Super+Up) may be consumed by GNOME before reaching the app.",
        annotations(
            read_only_hint = false,
            destructive_hint = true,
            idempotent_hint = false,
            open_world_hint = true
        )
    )]
    async fn press_key(
        &self,
        Parameters(params): Parameters<PressKeyParams>,
    ) -> Json<ActionOutput> {
        let received = Some(serde_json::json!(params.clone()));
        let focus = match self.focus_target_for_input(&params.window_target()).await {
            Ok(focus) => focus,
            Err(message) => {
                return Json(ActionOutput {
                    ok: false,
                    implemented: true,
                    action: "press_key".to_string(),
                    message,
                    received,
                });
            }
        };
        let Some(key_events) = key_sequence(&params.key) else {
            return Json(ActionOutput {
                ok: false,
                implemented: true,
                action: "press_key".to_string(),
                message: "Unsupported key. Use names like Enter, Escape, Tab, ArrowLeft, Super, Ctrl+L, or a single US keyboard letter/digit.".to_string(),
                received,
            });
        };
        let mut args = vec!["key".to_string()];
        args.extend(key_events);
        let result = run_ydotool(&args).await.map(|output| vec![output]);
        let mut output = action_result_with_focus("press_key", result, received, focus.clone());
        if output.ok && focus.is_some() {
            let notes = self.input_landing_notes(focus.as_ref(), false).await;
            output = with_notes(output, notes);
        }
        Json(output)
    }

    #[tool(
        name = "type_text",
        description = "Type literal text using keyboard input, optionally after focusing a target window or terminal selector.",
        annotations(
            read_only_hint = false,
            destructive_hint = true,
            idempotent_hint = false,
            open_world_hint = true
        )
    )]
    async fn type_text(
        &self,
        Parameters(params): Parameters<TypeTextParams>,
    ) -> Json<ActionOutput> {
        let received = Some(serde_json::json!(params.clone()));
        let focus = match self.focus_target_for_input(&params.window_target()).await {
            Ok(focus) => focus,
            Err(message) => {
                return Json(ActionOutput {
                    ok: false,
                    implemented: true,
                    action: "type_text".to_string(),
                    message,
                    received,
                });
            }
        };
        if self.should_prefer_kde_clipboard_text_backend() {
            match self.ensure_portal_keyboard_session().await {
                Ok(Some(session)) => {
                    let _clipboard_guard = self.kde_clipboard_lock.lock().await;
                    match run_kde_clipboard_paste_text(&session, &params.text).await {
                        Ok(message) => {
                            let notes = self.input_landing_notes(focus.as_ref(), true).await;
                            return Json(with_notes(
                                successful_action_with_focus(
                                    "type_text",
                                    &message,
                                    received,
                                    focus,
                                ),
                                notes,
                            ));
                        }
                        Err(error) => {
                            if error.clear_portal_keyboard_session {
                                self.clear_portal_keyboard_session();
                            }
                            if !error.can_fallback_to_ydotool {
                                return Json(action_result_with_focus(
                                    "type_text",
                                    Err(error.message),
                                    received,
                                    focus,
                                ));
                            }
                        }
                    }
                }
                Ok(None) => {}
                Err(_) => {}
            }
        }
        if self.should_prefer_portal_keyboard_backend() {
            if let Ok(keysyms) = keysyms_for_text(&params.text) {
                match self.ensure_portal_keyboard_session().await {
                    Ok(Some(session)) => match type_text_with_keysyms(&session, &keysyms).await {
                        Ok(()) => {
                            let notes = self.input_landing_notes(focus.as_ref(), true).await;
                            return Json(with_notes(
                                successful_action_with_focus(
                                    "type_text",
                                    "Action sent through the remote desktop portal.",
                                    received,
                                    focus,
                                ),
                                notes,
                            ));
                        }
                        Err(error) => {
                            self.clear_portal_keyboard_session();
                            return Json(action_result_with_focus(
                                "type_text",
                                Err(format!("{error:#}")),
                                received,
                                focus,
                            ));
                        }
                    },
                    Ok(None) => {}
                    Err(_) => {}
                }
            }
        }
        let result = run_ydotool_type_text(&params.text)
            .await
            .map(|output| vec![output]);
        let mut output = action_result_with_focus("type_text", result, received, focus.clone());
        if output.ok && focus.is_some() {
            let notes = self.input_landing_notes(focus.as_ref(), true).await;
            output = with_notes(output, notes);
        }
        Json(output)
    }

    #[tool(
        name = "move_window",
        description = "Move a window to a new desktop position (frame top-left in desktop coordinates). Useful to recover windows that are partially off-screen. Requires the computer-use-linux GNOME Shell extension.",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = true
        )
    )]
    async fn move_window(
        &self,
        Parameters(params): Parameters<MoveWindowParams>,
    ) -> Json<WindowGeometryOutput> {
        let received = Some(serde_json::json!(params.clone()));
        let target = params.target.clone().into_target();
        self.window_geometry_op(received, &target, |window_id| async move {
            crate::windowing::backends::gnome::move_extension_window(window_id, params.x, params.y)
                .await
        })
        .await
    }

    #[tool(
        name = "resize_window",
        description = "Resize a window to a new frame width/height in desktop pixels, unmaximizing it first if needed. Useful to fit a window fully on-screen. Requires the computer-use-linux GNOME Shell extension.",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = true
        )
    )]
    async fn resize_window(
        &self,
        Parameters(params): Parameters<ResizeWindowParams>,
    ) -> Json<WindowGeometryOutput> {
        let received = Some(serde_json::json!(params.clone()));
        let target = params.target.clone().into_target();
        self.window_geometry_op(received, &target, |window_id| async move {
            crate::windowing::backends::gnome::resize_extension_window(
                window_id,
                params.width,
                params.height,
            )
            .await
        })
        .await
    }
}

#[tool_handler(
    name = "codex-computer-use-linux",
    // NOTE: keep in lockstep with Cargo.toml + package.json on every release.
    // The rmcp tool_handler macro only accepts a string literal here, so this
    // can't be env!("CARGO_PKG_VERSION"); the MCP safety check (CI) fails the
    // build if it drifts from the Cargo version.
    version = "0.3.1-linux-alpha1",
    instructions = "Begin every turn that uses Computer Use by calling get_app_state. If diagnostics report disabled GNOME accessibility, call setup_accessibility before asking the user to retry. Use list_windows/focused_window before targeted keyboard input. If diagnostics report windowing.can_list_windows=false on GNOME, call setup_window_targeting to install the optional GNOME Shell extension backend, then ask the user to log out and back in if the setup report says a shell reload is required. This Linux backend can capture size-bounded screenshots through GNOME Shell, the Codex GNOME Shell extension, or XDG Desktop Portal, read AT-SPI trees with action/value metadata, invoke native AT-SPI actions, set AT-SPI values or editable text, list/focus compositor windows through registered Linux window backends when the session permits it, attach best-effort terminal tty/process metadata to terminal windows, send coordinate or element-targeted click/scroll/drag input through the Wayland remote desktop portal when available, and send layout-safe literal type_text through KDE clipboard integration on Plasma Wayland or through portal keysyms on other Wayland sessions before falling back to ydotool. Screenshot results include width/height for the returned image plus coordinate_width/coordinate_height and scale for desktop coordinate conversion; request more detail with max_width, max_height, max_bytes, format=jpeg, quality, or a smaller target/crop instead of relying on unbounded screenshots. Tools with readOnlyHint=false may mutate local desktop or application state; hosts should require approval for actions that can submit, delete, send, purchase, or overwrite data. For element-targeted actions, prefer element_index from the latest get_app_state result; click, perform_action, and set_value can also use semantic role/name/text/states selectors when the target is unique. type_text and press_key accept optional window_id, pid, app_id, wm_class, title, tty, terminal_pid, terminal_command, or terminal_cwd selectors and refuse targeted input if focus cannot be verified. After targeted keyboard input, results append focused-element feedback from AT-SPI (role, name, editable) and warn when no editable element holds focus — treat that warning as the input not landing. Screenshot, click, and input results warn when the target window or coordinate is partially or fully off-screen; use move_window/resize_window (GNOME Shell extension backend) to bring a window fully on-screen before retrying. scroll accepts the same window targeting and relative coordinates as click. get_app_state returns a compact readiness block by default; pass verbose=true for the full diagnostics dump. Electron apps expose no AT-SPI tree unless launched with --force-renderer-accessibility."
)]
impl ServerHandler for ComputerUseLinux {}

pub async fn serve_mcp() -> Result<()> {
    ComputerUseLinux::default()
        .serve(rmcp::transport::stdio())
        .await?
        .waiting()
        .await?;
    Ok(())
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
struct ListAppsOutput {
    apps: Vec<AppCandidate>,
    accessible_apps: Vec<AccessibleAppSummary>,
    accessibility_error: Option<String>,
    note: String,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
struct ListWindowsOutput {
    backend: String,
    windows: Vec<WindowInfo>,
    error: Option<String>,
    permissions_hint: Option<String>,
    note: String,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
struct FocusedWindowOutput {
    backend: String,
    focused_window: Option<WindowInfo>,
    error: Option<String>,
    permissions_hint: Option<String>,
    message: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
struct ActivateWindowParams {
    #[serde(default)]
    window_id: Option<u64>,
    #[serde(default)]
    pid: Option<u32>,
    #[serde(default)]
    tty: Option<String>,
    #[serde(default)]
    terminal_pid: Option<u32>,
    #[serde(default)]
    terminal_command: Option<String>,
    #[serde(default)]
    terminal_cwd: Option<String>,
    #[serde(default)]
    app_id: Option<String>,
    #[serde(default)]
    wm_class: Option<String>,
    #[serde(default)]
    title: Option<String>,
}

impl ActivateWindowParams {
    fn into_target(self) -> WindowTarget {
        WindowTarget {
            window_id: self.window_id,
            pid: self.pid,
            tty: self.tty,
            terminal_pid: self.terminal_pid,
            terminal_command: self.terminal_command,
            terminal_cwd: self.terminal_cwd,
            app_id: self.app_id,
            wm_class: self.wm_class,
            title: self.title,
        }
    }
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
struct ActivateWindowOutput {
    ok: bool,
    implemented: bool,
    backend: String,
    focus: Option<WindowFocusResult>,
    error: Option<String>,
    permissions_hint: Option<String>,
    // Echo of the request for debugging. `serde_json::Value` has no fixed JSON
    // schema, which strict MCP clients (Claude Code) reject in `outputSchema` —
    // and one invalid tool fails the whole tool list. Keep it in the runtime
    // response (serde) but omit it from the generated schema.
    #[schemars(skip)]
    received: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
struct MoveWindowParams {
    #[serde(flatten)]
    target: ActivateWindowParams,
    /// New frame-left in desktop coordinates.
    x: i32,
    /// New frame-top in desktop coordinates.
    y: i32,
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
struct ResizeWindowParams {
    #[serde(flatten)]
    target: ActivateWindowParams,
    /// New frame width in desktop pixels.
    width: i32,
    /// New frame height in desktop pixels.
    height: i32,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
struct WindowGeometryOutput {
    ok: bool,
    implemented: bool,
    backend: String,
    /// Post-operation window info (compositor-final geometry).
    window: Option<WindowInfo>,
    message: String,
    permissions_hint: Option<String>,
    #[schemars(skip)]
    received: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
struct AppCandidate {
    name: String,
    pid: u32,
    command: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
struct GetAppStateParams {
    #[serde(default)]
    app_name_or_bundle_identifier: Option<String>,
    #[serde(default)]
    window_id: Option<u64>,
    #[serde(default)]
    pid: Option<u32>,
    #[serde(default)]
    tty: Option<String>,
    #[serde(default)]
    terminal_pid: Option<u32>,
    #[serde(default)]
    terminal_command: Option<String>,
    #[serde(default)]
    terminal_cwd: Option<String>,
    #[serde(default)]
    app_id: Option<String>,
    #[serde(default)]
    wm_class: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    max_nodes: Option<usize>,
    #[serde(default)]
    max_depth: Option<u32>,
    #[serde(default)]
    include_screenshot: Option<bool>,
    /// Maximum returned screenshot width in pixels (default 1920, hard-capped).
    #[serde(default)]
    max_width: Option<u32>,
    /// Maximum returned screenshot height in pixels (default 1920, hard-capped).
    #[serde(default)]
    max_height: Option<u32>,
    /// Maximum returned screenshot image bytes before base64 (default 2 MiB, hard-capped).
    #[serde(default)]
    max_bytes: Option<usize>,
    /// Additional downscale factor from 0.0 to 1.0, applied before max dimensions.
    #[serde(default)]
    scale: Option<f32>,
    /// Output image format (default png). Use jpeg with quality to trade exact pixels for smaller payloads.
    #[serde(default)]
    format: Option<ScreenshotOutputFormat>,
    /// JPEG quality from 1 to 95 (default 80). Ignored for png.
    #[serde(default)]
    #[schemars(range(min = 1, max = 95))]
    quality: Option<u8>,
    /// Include the full diagnostics report (large). Default false: only the
    /// compact readiness block is returned.
    #[serde(default)]
    verbose: Option<bool>,
}

impl GetAppStateParams {
    fn window_target(&self) -> WindowTarget {
        WindowTarget {
            window_id: self.window_id,
            pid: self.pid,
            tty: self.tty.clone(),
            terminal_pid: self.terminal_pid,
            terminal_command: self.terminal_command.clone(),
            terminal_cwd: self.terminal_cwd.clone(),
            app_id: self.app_id.clone(),
            wm_class: self.wm_class.clone(),
            title: self.title.clone(),
        }
    }

    fn screenshot_options(&self) -> ScreenshotPayloadOptions {
        ScreenshotPayloadOptions {
            max_width: self.max_width,
            max_height: self.max_height,
            max_bytes: self.max_bytes,
            scale: self.scale,
            format: self.format,
            quality: self.quality,
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, JsonSchema)]
struct ScreenshotParams {
    #[serde(default)]
    window_id: Option<u64>,
    #[serde(default)]
    pid: Option<u32>,
    #[serde(default)]
    app_id: Option<String>,
    #[serde(default)]
    wm_class: Option<String>,
    #[serde(default)]
    title: Option<String>,
    /// Raise the targeted window before capture (default true). Ignored without
    /// a window target.
    #[serde(default)]
    raise_window: Option<bool>,
    /// Capture the whole desktop even when a window is targeted (default false).
    #[serde(default)]
    full_screen: Option<bool>,
    /// Maximum returned screenshot width in pixels (default 1920, hard-capped).
    #[serde(default)]
    max_width: Option<u32>,
    /// Maximum returned screenshot height in pixels (default 1920, hard-capped).
    #[serde(default)]
    max_height: Option<u32>,
    /// Maximum returned screenshot image bytes before base64 (default 2 MiB, hard-capped).
    #[serde(default)]
    max_bytes: Option<usize>,
    /// Additional downscale factor from 0.0 to 1.0, applied before max dimensions.
    #[serde(default)]
    scale: Option<f32>,
    /// Output image format (default png). Use jpeg with quality to trade exact pixels for smaller payloads.
    #[serde(default)]
    format: Option<ScreenshotOutputFormat>,
    /// JPEG quality from 1 to 95 (default 80). Ignored for png.
    #[serde(default)]
    #[schemars(range(min = 1, max = 95))]
    quality: Option<u8>,
}

impl ScreenshotParams {
    fn window_target(&self) -> Option<WindowTarget> {
        if self.window_id.is_none()
            && self.pid.is_none()
            && self.app_id.is_none()
            && self.wm_class.is_none()
            && self.title.is_none()
        {
            return None;
        }
        Some(WindowTarget {
            window_id: self.window_id,
            pid: self.pid,
            tty: None,
            terminal_pid: None,
            terminal_command: None,
            terminal_cwd: None,
            app_id: self.app_id.clone(),
            wm_class: self.wm_class.clone(),
            title: self.title.clone(),
        })
    }

    fn screenshot_options(&self) -> ScreenshotPayloadOptions {
        ScreenshotPayloadOptions {
            max_width: self.max_width,
            max_height: self.max_height,
            max_bytes: self.max_bytes,
            scale: self.scale,
            format: self.format,
            quality: self.quality,
        }
    }
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
struct GetAppStateOutput {
    app_name_or_bundle_identifier: Option<String>,
    window_context: Option<WindowInfo>,
    window_error: Option<String>,
    window_permissions_hint: Option<String>,
    backend: String,
    screenshot: Option<ScreenshotCapture>,
    screenshot_error: Option<String>,
    accessibility_tree: Vec<AccessibilityNode>,
    accessibility_tree_raw_count: usize,
    accessibility_error: Option<String>,
    /// Compact readiness summary (always present).
    readiness: crate::diagnostics::ReadinessReport,
    /// Full diagnostics; populated only when verbose=true.
    #[serde(skip_serializing_if = "Option::is_none")]
    diagnostics: Option<DoctorReport>,
    message: String,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, JsonSchema)]
struct ClickParams {
    #[serde(default)]
    element_index: Option<u32>,
    #[serde(default)]
    role: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    states: Vec<String>,
    #[serde(default)]
    x: Option<i32>,
    #[serde(default)]
    y: Option<i32>,
    #[serde(default)]
    button: Option<String>,
    #[serde(default)]
    click_count: Option<u32>,
    // Optional window target: when set, the window is raised/focused before the
    // click so a coordinate click reliably lands on the intended app rather than
    // whatever window happens to be stacked on top at that pixel.
    #[serde(default)]
    window_id: Option<u64>,
    #[serde(default)]
    pid: Option<u32>,
    #[serde(default)]
    app_id: Option<String>,
    #[serde(default)]
    wm_class: Option<String>,
    #[serde(default)]
    window_title: Option<String>,
    /// Interpret `x`/`y` as relative to the targeted window's top-left corner
    /// (the same coordinate space as a window-cropped `screenshot`). Requires a
    /// window target; ignored otherwise.
    #[serde(default)]
    relative: Option<bool>,
}

impl ClickParams {
    /// A window target if any window-identifying field was supplied.
    fn window_target(&self) -> Option<WindowTarget> {
        if self.window_id.is_none()
            && self.pid.is_none()
            && self.app_id.is_none()
            && self.wm_class.is_none()
            && self.window_title.is_none()
        {
            return None;
        }
        Some(WindowTarget {
            window_id: self.window_id,
            pid: self.pid,
            tty: None,
            terminal_pid: None,
            terminal_command: None,
            terminal_cwd: None,
            app_id: self.app_id.clone(),
            wm_class: self.wm_class.clone(),
            title: self.window_title.clone(),
        })
    }

    fn selector(&self) -> ElementSelector<'_> {
        ElementSelector {
            role: self.role.as_deref(),
            name: self.name.as_deref(),
            text: self.text.as_deref(),
            states: &self.states,
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, JsonSchema)]
struct ActionParams {
    #[serde(default)]
    element_index: Option<u32>,
    #[serde(default)]
    element_identifier: Option<String>,
    #[serde(default)]
    role: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    states: Vec<String>,
    #[serde(default)]
    action: Option<String>,
}

impl ActionParams {
    fn selector(&self) -> ElementSelector<'_> {
        ElementSelector {
            role: self.role.as_deref(),
            name: self.name.as_deref(),
            text: self.text.as_deref(),
            states: &self.states,
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, JsonSchema)]
struct SetValueParams {
    #[serde(default)]
    element_index: Option<u32>,
    #[serde(default)]
    element_identifier: Option<String>,
    #[serde(default)]
    role: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    states: Vec<String>,
    value: String,
}

impl SetValueParams {
    fn selector(&self) -> ElementSelector<'_> {
        ElementSelector {
            role: self.role.as_deref(),
            name: self.name.as_deref(),
            text: self.text.as_deref(),
            states: &self.states,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
struct ScrollParams {
    #[serde(default)]
    element_index: Option<u32>,
    #[serde(default)]
    x: Option<i32>,
    #[serde(default)]
    y: Option<i32>,
    direction: String,
    #[serde(default)]
    pages: Option<f64>,
    // Optional window target (parity with click): the window is raised/focused
    // before scrolling so the wheel events land on the intended app.
    #[serde(default)]
    window_id: Option<u64>,
    #[serde(default)]
    pid: Option<u32>,
    #[serde(default)]
    app_id: Option<String>,
    #[serde(default)]
    wm_class: Option<String>,
    #[serde(default)]
    window_title: Option<String>,
    /// Interpret `x`/`y` as relative to the targeted window's top-left corner
    /// (the same coordinate space as a window-cropped `screenshot`). Requires a
    /// window target; ignored otherwise.
    #[serde(default)]
    relative: Option<bool>,
}

impl ScrollParams {
    /// A window target if any window-identifying field was supplied.
    fn window_target(&self) -> Option<WindowTarget> {
        if self.window_id.is_none()
            && self.pid.is_none()
            && self.app_id.is_none()
            && self.wm_class.is_none()
            && self.window_title.is_none()
        {
            return None;
        }
        Some(WindowTarget {
            window_id: self.window_id,
            pid: self.pid,
            tty: None,
            terminal_pid: None,
            terminal_command: None,
            terminal_cwd: None,
            app_id: self.app_id.clone(),
            wm_class: self.wm_class.clone(),
            title: self.window_title.clone(),
        })
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
struct DragParams {
    start_x: i32,
    start_y: i32,
    end_x: i32,
    end_y: i32,
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
struct PressKeyParams {
    key: String,
    #[serde(default)]
    window_id: Option<u64>,
    #[serde(default)]
    pid: Option<u32>,
    #[serde(default)]
    tty: Option<String>,
    #[serde(default)]
    terminal_pid: Option<u32>,
    #[serde(default)]
    terminal_command: Option<String>,
    #[serde(default)]
    terminal_cwd: Option<String>,
    #[serde(default)]
    app_id: Option<String>,
    #[serde(default)]
    wm_class: Option<String>,
    #[serde(default)]
    title: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
struct TypeTextParams {
    text: String,
    #[serde(default)]
    window_id: Option<u64>,
    #[serde(default)]
    pid: Option<u32>,
    #[serde(default)]
    tty: Option<String>,
    #[serde(default)]
    terminal_pid: Option<u32>,
    #[serde(default)]
    terminal_command: Option<String>,
    #[serde(default)]
    terminal_cwd: Option<String>,
    #[serde(default)]
    app_id: Option<String>,
    #[serde(default)]
    wm_class: Option<String>,
    #[serde(default)]
    title: Option<String>,
}

impl PressKeyParams {
    fn window_target(&self) -> WindowTarget {
        WindowTarget {
            window_id: self.window_id,
            pid: self.pid,
            tty: self.tty.clone(),
            terminal_pid: self.terminal_pid,
            terminal_command: self.terminal_command.clone(),
            terminal_cwd: self.terminal_cwd.clone(),
            app_id: self.app_id.clone(),
            wm_class: self.wm_class.clone(),
            title: self.title.clone(),
        }
    }
}

impl TypeTextParams {
    fn window_target(&self) -> WindowTarget {
        WindowTarget {
            window_id: self.window_id,
            pid: self.pid,
            tty: self.tty.clone(),
            terminal_pid: self.terminal_pid,
            terminal_command: self.terminal_command.clone(),
            terminal_cwd: self.terminal_cwd.clone(),
            app_id: self.app_id.clone(),
            wm_class: self.wm_class.clone(),
            title: self.title.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
struct ActionOutput {
    ok: bool,
    implemented: bool,
    action: String,
    message: String,
    // See ActivateWindowOutput: kept in the response, omitted from the schema
    // because `serde_json::Value` produces a non-object schema strict MCP
    // clients reject.
    #[schemars(skip)]
    received: Option<serde_json::Value>,
}

impl ComputerUseLinux {
    fn is_wayland_session(&self) -> bool {
        crate::diagnostics::hydrate_session_bus_env();
        env::var("XDG_SESSION_TYPE")
            .ok()
            .is_some_and(|value| value.eq_ignore_ascii_case("wayland"))
    }

    // The Wayland remote-desktop portal is now a *fallback* for input: when a
    // compatible ydotool CLI and working `ydotoold` socket are present we prefer
    // ydotool, because it injects input without a permission prompt. GNOME
    // refuses to persist remote-desktop
    // grants (`org.freedesktop.portal.Error: Remote desktop sessions cannot
    // persist`), so the portal would otherwise re-prompt on every new session.
    // `COMPUTER_USE_LINUX_FORCE_YDOTOOL_*=1` always uses ydotool;
    // `COMPUTER_USE_LINUX_FORCE_PORTAL_*=1` always uses the portal. The
    // `CODEX_COMPUTER_USE_*` names are accepted for the embedded Codex app
    // bundle so downstream can share this source without local string patches.
    fn should_prefer_portal_pointer_backend(&self) -> bool {
        if env_flag_enabled_any(&[
            "COMPUTER_USE_LINUX_FORCE_YDOTOOL_POINTER",
            "CODEX_COMPUTER_USE_FORCE_YDOTOOL_POINTER",
        ]) {
            return false;
        }
        if env_flag_enabled_any(&[
            "COMPUTER_USE_LINUX_FORCE_PORTAL_POINTER",
            "CODEX_COMPUTER_USE_FORCE_PORTAL_POINTER",
        ]) {
            return self.is_wayland_session();
        }
        should_prefer_portal_backend_by_default(
            self.is_wayland_session(),
            ydotool_backend_available(),
        )
    }

    fn should_prefer_portal_keyboard_backend(&self) -> bool {
        if env_flag_enabled_any(&[
            "COMPUTER_USE_LINUX_FORCE_YDOTOOL_KEYBOARD",
            "CODEX_COMPUTER_USE_FORCE_YDOTOOL_KEYBOARD",
        ]) {
            return false;
        }
        if env_flag_enabled_any(&[
            "COMPUTER_USE_LINUX_FORCE_PORTAL_KEYBOARD",
            "CODEX_COMPUTER_USE_FORCE_PORTAL_KEYBOARD",
        ]) {
            return self.is_wayland_session() && !self.is_kde_wayland_session();
        }
        !self.is_kde_wayland_session()
            && should_prefer_portal_backend_by_default(
                self.is_wayland_session(),
                ydotool_backend_available(),
            )
    }

    fn should_prefer_kde_clipboard_text_backend(&self) -> bool {
        !env_flag_enabled_any(&[
            "COMPUTER_USE_LINUX_FORCE_YDOTOOL_KEYBOARD",
            "CODEX_COMPUTER_USE_FORCE_YDOTOOL_KEYBOARD",
        ]) && self.is_kde_wayland_session()
    }

    fn is_kde_wayland_session(&self) -> bool {
        self.is_wayland_session()
            && (env_contains("XDG_CURRENT_DESKTOP", "kde")
                || env_contains("DESKTOP_SESSION", "plasma"))
    }

    fn cached_portal_pointer_session(&self) -> Option<PortalPointerSession> {
        self.portal_pointer_session
            .lock()
            .ok()
            .and_then(|cached| cached.clone())
    }

    fn clear_portal_pointer_session(&self) {
        if let Ok(mut cached) = self.portal_pointer_session.lock() {
            *cached = None;
        }
    }

    fn cached_portal_keyboard_session(&self) -> Option<PortalKeyboardSession> {
        self.portal_keyboard_session
            .lock()
            .ok()
            .and_then(|cached| cached.clone())
    }

    fn clear_portal_keyboard_session(&self) {
        if let Ok(mut cached) = self.portal_keyboard_session.lock() {
            *cached = None;
        }
    }

    async fn ensure_portal_pointer_session(&self) -> Result<Option<PortalPointerSession>> {
        if !self.should_prefer_portal_pointer_backend() {
            return Ok(None);
        }
        if let Some(session) = self.cached_portal_pointer_session() {
            return Ok(Some(session));
        }

        let session = start_portal_pointer_session().await?;
        if let Ok(mut cached) = self.portal_pointer_session.lock() {
            *cached = Some(session.clone());
        }
        Ok(Some(session))
    }

    async fn ensure_portal_keyboard_session(&self) -> Result<Option<PortalKeyboardSession>> {
        if env_flag_enabled_any(&[
            "COMPUTER_USE_LINUX_FORCE_YDOTOOL_KEYBOARD",
            "CODEX_COMPUTER_USE_FORCE_YDOTOOL_KEYBOARD",
        ]) || !self.is_wayland_session()
        {
            return Ok(None);
        }
        if let Some(session) = self.cached_portal_keyboard_session() {
            return Ok(Some(session));
        }

        let _guard = self.portal_keyboard_init_lock.lock().await;
        if let Some(session) = self.cached_portal_keyboard_session() {
            return Ok(Some(session));
        }

        let session = start_portal_keyboard_session().await?;
        if let Ok(mut cached) = self.portal_keyboard_session.lock() {
            *cached = Some(session.clone());
        }
        Ok(Some(session))
    }

    async fn resolve_window_context(
        &self,
        params: &GetAppStateParams,
    ) -> (Option<WindowInfo>, Option<String>, Option<String>) {
        let target = params.window_target();
        if !target.has_target() {
            return (None, None, None);
        }

        match list_windows().await {
            Ok(windows) => match resolve_window_target(&windows, &target) {
                Ok(window) => (Some(window.clone()), None, None),
                Err(error) => (None, Some(format!("{error:#}")), None),
            },
            Err(error) => {
                let error = format!("{error:#}");
                let hint = window_permission_hint(&error);
                (None, Some(error), hint)
            }
        }
    }

    async fn resolve_accessibility_app_filter(
        &self,
        params: &GetAppStateParams,
        window_context: Option<&WindowInfo>,
    ) -> Option<String> {
        if let Some(explicit) = trimmed_nonempty(params.app_name_or_bundle_identifier.as_deref()) {
            return Some(explicit.to_string());
        }

        let target_pid = window_context.and_then(|window| window.pid).or(params.pid);
        let candidates = accessibility_filter_candidates(window_context);

        if let Some(target_pid) = target_pid {
            if let Ok(apps) = list_accessible_apps(200).await {
                if let Some(object_ref) =
                    select_accessibility_object_ref(&apps, target_pid, &candidates)
                {
                    return Some(object_ref);
                }
            }
        }

        candidates.into_iter().next()
    }

    async fn focus_target_for_input(
        &self,
        target: &WindowTarget,
    ) -> std::result::Result<Option<WindowFocusResult>, String> {
        if !target.has_target() {
            return Ok(None);
        }

        let focus = focus_window_target(target).await.map_err(|error| {
            let error = format!("{error:#}");
            if let Some(hint) = window_permission_hint(&error) {
                format!("Did not send input because the target window could not be focused: {error}. {hint}")
            } else {
                format!("Did not send input because the target window could not be focused: {error}")
            }
        })?;

        if focus_satisfies_target(&focus, target) {
            Ok(Some(focus))
        } else {
            let required = if target.requires_exact_focus() {
                "exact target-window focus"
            } else {
                "app-level focus"
            };
            Err(format!(
                "Did not send input because {required} verification failed after activating the target window. Focus result: requested window_id {}, focused window_id {:?}.",
                focus.requested_window.window_id,
                focus.focused_window.as_ref().map(|window| window.window_id)
            ))
        }
    }

    fn cache_desktop_size(&self, width: u32, height: u32) {
        if width == 0 || height == 0 {
            return;
        }
        if let Ok(mut guard) = self.desktop_size.lock() {
            *guard = Some((width, height));
        }
    }

    /// COORDINATE SPACES: window bounds (list_windows / extension frame rects)
    /// and the extension monitor layout are in LOGICAL pixels, while click/
    /// scroll coordinates and screenshot captures are in PHYSICAL capture
    /// pixels. On fractionally-scaled displays the two differ, so each check
    /// below only ever compares values from the same space.
    ///
    /// Logical monitor rectangles from the GNOME Shell extension, for checks
    /// against logical window bounds. None when the extension is unavailable.
    async fn logical_monitor_rects(&self) -> Option<Vec<(i32, i32, i32, i32)>> {
        let monitors = crate::windowing::backends::gnome::extension_monitor_layout()
            .await
            .ok()?;
        (!monitors.is_empty()).then(|| {
            monitors
                .iter()
                .map(|m| (m.x, m.y, m.width, m.height))
                .collect()
        })
    }

    /// Physical capture-space desktop rectangle (union of monitors as captured
    /// by the screenshot pipeline), for checks against click coordinates.
    /// Best-effort; None disables the check.
    async fn capture_space_rect(&self) -> Option<(i32, i32, i32, i32)> {
        let cached = self.desktop_size.lock().ok().and_then(|guard| *guard);
        if let Some((w, h)) = cached {
            return Some((0, 0, w as i32, h as i32));
        }
        // One-time prime: a full-frame capture reveals the desktop size when
        // no prior capture is available.
        let raw = capture_screenshot_raw().await.ok()?;
        self.cache_desktop_size(raw.width, raw.height);
        (raw.width > 0 && raw.height > 0).then_some((0, 0, raw.width as i32, raw.height as i32))
    }

    /// Warn when a targeted window pokes outside every monitor: clicks and
    /// screenshots silently truncate to visible pixels there, which reads as
    /// "success" while landing nowhere.
    async fn off_screen_note_for_bounds(
        &self,
        bounds: &crate::windowing::WindowBounds,
    ) -> Option<String> {
        let (x, y) = bounds.x.zip(bounds.y)?;
        if bounds.width == 0 || bounds.height == 0 {
            return None;
        }
        // Window bounds are logical pixels: prefer the extension's logical
        // monitor layout (same space). The physical capture rect is a safe
        // fallback — on scaled displays it is at least as large as the logical
        // union, so it can only under-warn, never false-positive.
        let rects = match self.logical_monitor_rects().await {
            Some(rects) => rects,
            None => vec![self.capture_space_rect().await?],
        };
        let (w, h) = (bounds.width as i64, bounds.height as i64);
        let window_area = w * h;
        let mut visible_area = 0_i64;
        for (mx, my, mw, mh) in &rects {
            let ix = (x as i64).max(*mx as i64);
            let iy = (y as i64).max(*my as i64);
            let ix2 = (x as i64 + w).min(*mx as i64 + *mw as i64);
            let iy2 = (y as i64 + h).min(*my as i64 + *mh as i64);
            if ix2 > ix && iy2 > iy {
                // Overlapping monitors are rare; treating them as additive keeps
                // this a cheap best-effort heuristic.
                visible_area += (ix2 - ix) * (iy2 - iy);
            }
        }
        let visible_pct = (visible_area.min(window_area) * 100) / window_area.max(1);
        if visible_pct >= 100 {
            return None;
        }
        Some(format!(
            "WARNING: the target window (bounds {x},{y} {w}x{h}) is only ~{visible_pct}% on-screen; off-screen regions are missing from screenshots and unreachable by coordinate input. Use move_window/resize_window to bring it fully on-screen."
        ))
    }

    /// Warn when a click/scroll coordinate is outside the captured desktop.
    /// Click coordinates are physical capture-space pixels, so compare ONLY
    /// against the capture rect — the extension's logical layout is a
    /// different space on scaled displays and would false-positive.
    async fn off_screen_note_for_point(&self, x: i32, y: i32) -> Option<String> {
        let (mx, my, mw, mh) = self.capture_space_rect().await?;
        let visible = x >= mx && y >= my && x < mx.saturating_add(mw) && y < my.saturating_add(mh);
        if visible {
            return None;
        }
        Some(format!(
            "WARNING: coordinate {x},{y} is outside the captured desktop ({mw}x{mh}); the input landed on no visible pixel."
        ))
    }

    /// Post-input feedback: which AT-SPI element holds keyboard focus in the
    /// target app, and whether it is editable. Guards against the blind-typing
    /// trap where verified *window* focus still sends keystrokes nowhere.
    async fn focused_element_feedback(
        &self,
        focus: Option<&WindowFocusResult>,
        expects_editable: bool,
    ) -> Option<String> {
        let focus = focus?;
        let pid = focus
            .focused_window
            .as_ref()
            .and_then(|window| window.pid)
            .or(focus.requested_window.pid);
        match timeout(Duration::from_millis(1500), focused_element_summary(pid)).await {
            Ok(Ok(Some(element))) => Some(describe_focused_element(&element, expects_editable)),
            Ok(Ok(None)) => Some(
                "WARNING: AT-SPI reports no focused element in the target app — the input may have landed nowhere. If this is an Electron app, launch it with --force-renderer-accessibility to expose its UI tree."
                    .to_string(),
            ),
            Ok(Err(error)) => Some(format!(
                "Focused-element feedback unavailable ({}).",
                first_line(&format!("{error:#}"))
            )),
            Err(_) => Some("Focused-element feedback unavailable (AT-SPI probe timed out).".to_string()),
        }
    }

    /// Shared move/resize plumbing: resolve the window target, run the GNOME
    /// Shell extension operation, then re-query bounds to report the result.
    async fn window_geometry_op<F, Fut>(
        &self,
        received: Option<serde_json::Value>,
        target: &WindowTarget,
        op: F,
    ) -> Json<WindowGeometryOutput>
    where
        F: FnOnce(u64) -> Fut,
        Fut: Future<Output = Result<String>>,
    {
        let windows = match list_windows().await {
            Ok(windows) => windows,
            Err(error) => {
                let error = format!("{error:#}");
                return Json(WindowGeometryOutput {
                    ok: false,
                    implemented: true,
                    backend: crate::windowing::GNOME_SHELL_EXTENSION_BACKEND.to_string(),
                    window: None,
                    message: format!("Window listing failed: {error}"),
                    permissions_hint: window_permission_hint(&error),
                    received,
                });
            }
        };
        let window_id = match resolve_window_target(&windows, target) {
            Ok(window) => window.window_id,
            Err(error) => {
                return Json(WindowGeometryOutput {
                    ok: false,
                    implemented: true,
                    backend: crate::windowing::GNOME_SHELL_EXTENSION_BACKEND.to_string(),
                    window: None,
                    message: format!("{error:#}"),
                    permissions_hint: None,
                    received,
                });
            }
        };
        match op(window_id).await {
            Ok(message) => {
                // Re-query so the caller sees the compositor-final geometry
                // (tiling constraints, minimum sizes, etc. may adjust it).
                let window = list_windows().await.ok().and_then(|windows| {
                    windows
                        .into_iter()
                        .find(|window| window.window_id == window_id)
                });
                let mut message = message;
                if let Some(bounds) = window.as_ref().and_then(|window| window.bounds.as_ref()) {
                    if let Some(note) = self.off_screen_note_for_bounds(bounds).await {
                        message = format!("{message} {note}");
                    }
                }
                Json(WindowGeometryOutput {
                    ok: true,
                    implemented: true,
                    backend: crate::windowing::GNOME_SHELL_EXTENSION_BACKEND.to_string(),
                    window,
                    message,
                    permissions_hint: None,
                    received,
                })
            }
            Err(error) => {
                let error = format!("{error:#}");
                Json(WindowGeometryOutput {
                    ok: false,
                    implemented: true,
                    backend: crate::windowing::GNOME_SHELL_EXTENSION_BACKEND.to_string(),
                    window: None,
                    permissions_hint: window_permission_hint(&error),
                    message: error,
                    received,
                })
            }
        }
    }

    /// Notes appended after targeted keyboard input: off-screen window warning
    /// plus focused-element feedback.
    async fn input_landing_notes(
        &self,
        focus: Option<&WindowFocusResult>,
        expects_editable: bool,
    ) -> Vec<String> {
        let mut notes = Vec::new();
        if let Some(focus) = focus {
            let bounds = focus
                .focused_window
                .as_ref()
                .and_then(|window| window.bounds.as_ref())
                .or(focus.requested_window.bounds.as_ref());
            if let Some(bounds) = bounds {
                if let Some(note) = self.off_screen_note_for_bounds(bounds).await {
                    notes.push(note);
                }
            }
        }
        if let Some(note) = self.focused_element_feedback(focus, expects_editable).await {
            notes.push(note);
        }
        notes
    }

    fn cache_nodes(&self, nodes: &[AccessibilityNode]) {
        if let Ok(mut cached) = self.last_nodes.lock() {
            cached.clear();
            cached.extend_from_slice(nodes);
        }
    }

    fn clear_cached_nodes(&self) {
        if let Ok(mut cached) = self.last_nodes.lock() {
            cached.clear();
        }
    }

    fn resolve_optional_target_point(
        &self,
        x: Option<i32>,
        y: Option<i32>,
        element_index: Option<u32>,
    ) -> std::result::Result<Option<(i32, i32)>, String> {
        match (x.zip(y), element_index) {
            (Some(point), _) => Ok(Some(point)),
            (None, Some(index)) => self
                .center_for_cached_node(index)
                .map(Some)
                .ok_or_else(|| {
                    format!(
                        "No clickable bounds cached for element_index {index}. Call get_app_state first and choose a node with positive width and height."
                    )
                }),
            (None, None) => Ok(None),
        }
    }

    fn resolve_click_target(
        &self,
        params: &ClickParams,
    ) -> std::result::Result<ClickTarget, String> {
        if let Some((x, y)) = params.x.zip(params.y) {
            return Ok(ClickTarget::Coordinates(x, y));
        }

        let selector = params.selector();
        let node = self.resolve_cached_node(
            params.element_index,
            &selector,
            ElementResolvePurpose::Click,
        )?;

        if let Some((x, y)) = node.bounds.as_ref().and_then(bounds_center) {
            return Ok(ClickTarget::Coordinates(x, y));
        }

        if !is_plain_left_click(params.button.as_deref(), params.click_count) {
            return Err(format!(
                "No clickable bounds cached for element_index {}. Call get_app_state first and choose a node with positive width and height.",
                node.index
            ));
        }

        let Some(action) = primary_action(node.actions.as_slice()) else {
            return Err(format!(
                "No clickable bounds cached for element_index {}, and the element exposes no primary AT-SPI action.",
                node.index
            ));
        };
        Ok(ClickTarget::PrimaryAction {
            object_ref: node.object_ref.clone(),
            action_name: Some(action.name.clone()),
            action_index: action.index,
        })
    }

    fn center_for_cached_node(&self, element_index: u32) -> Option<(i32, i32)> {
        let cached = self.last_nodes.lock().ok()?;
        let node = cached.iter().find(|node| node.index == element_index)?;
        bounds_center(node.bounds.as_ref()?)
    }

    fn resolve_object_ref(
        &self,
        element_index: Option<u32>,
        element_identifier: Option<&str>,
        selector: &ElementSelector<'_>,
        purpose: ElementResolvePurpose,
    ) -> std::result::Result<String, String> {
        if let Some(element_identifier) = element_identifier
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            return Ok(element_identifier.to_string());
        }

        self.resolve_cached_node(element_index, selector, purpose)
            .map(|node| node.object_ref)
    }

    fn resolve_cached_node(
        &self,
        element_index: Option<u32>,
        selector: &ElementSelector<'_>,
        purpose: ElementResolvePurpose,
    ) -> std::result::Result<AccessibilityNode, String> {
        let cached = self.last_nodes.lock().map_err(|_| {
            "Could not read cached accessibility nodes. Call get_app_state and retry.".to_string()
        })?;

        if let Some(element_index) = element_index {
            return cached
                .iter()
                .find(|node| node.index == element_index)
                .cloned()
                .ok_or_else(|| {
                    format!(
                        "No cached accessibility node for element_index {element_index}. Call get_app_state first."
                    )
                });
        }

        if selector.is_empty() {
            return Err(
                "Pass element_index, element_identifier, or a semantic selector such as role/name/text/states from the latest get_app_state result."
                    .to_string(),
            );
        }

        resolve_semantic_node(cached.as_slice(), selector, purpose)
    }

    async fn perform_element_action(
        &self,
        params: &ActionParams,
        requested_action: Option<&str>,
    ) -> Json<ActionOutput> {
        let received = Some(serde_json::json!(params.clone()));
        let object_ref = match self.resolve_object_ref(
            params.element_index,
            params.element_identifier.as_deref(),
            &params.selector(),
            ElementResolvePurpose::Action,
        ) {
            Ok(object_ref) => object_ref,
            Err(message) => {
                return Json(ActionOutput {
                    ok: false,
                    implemented: true,
                    action: "perform_action".to_string(),
                    message,
                    received,
                });
            }
        };

        match invoke_accessibility_action(&object_ref, requested_action).await {
            Ok(invocation) => Json(ActionOutput {
                ok: invocation.ok,
                implemented: true,
                action: "perform_action".to_string(),
                message: if invocation.ok {
                    format!(
                        "AT-SPI action {} ({}) invoked.",
                        invocation.action_index,
                        invocation
                            .action_name
                            .as_deref()
                            .filter(|name| !name.is_empty())
                            .unwrap_or("unnamed")
                    )
                } else {
                    format!(
                        "AT-SPI action {} ({}) returned false.",
                        invocation.action_index,
                        invocation
                            .action_name
                            .as_deref()
                            .filter(|name| !name.is_empty())
                            .unwrap_or("unnamed")
                    )
                },
                received,
            }),
            Err(error) => Json(ActionOutput {
                ok: false,
                implemented: true,
                action: "perform_action".to_string(),
                message: error.to_string(),
                received,
            }),
        }
    }
}

#[derive(Debug)]
enum ClickTarget {
    Coordinates(i32, i32),
    PrimaryAction {
        object_ref: String,
        action_name: Option<String>,
        action_index: i32,
    },
}

#[derive(Debug, Clone, Copy)]
enum ElementResolvePurpose {
    Click,
    Action,
    SetValue,
}

#[derive(Debug, Clone, Copy, Default)]
struct ElementSelector<'a> {
    role: Option<&'a str>,
    name: Option<&'a str>,
    text: Option<&'a str>,
    states: &'a [String],
}

impl ElementSelector<'_> {
    fn is_empty(&self) -> bool {
        [self.role, self.name, self.text]
            .into_iter()
            .all(|value| value.map(str::trim).is_none_or(str::is_empty))
            && self.states.iter().all(|value| value.trim().is_empty())
    }
}

fn resolve_semantic_node(
    nodes: &[AccessibilityNode],
    selector: &ElementSelector<'_>,
    purpose: ElementResolvePurpose,
) -> std::result::Result<AccessibilityNode, String> {
    let mut matches = nodes
        .iter()
        .filter(|node| node_matches_selector(node, selector))
        .collect::<Vec<_>>();

    if matches.is_empty() {
        return Err(format!(
            "No cached accessibility node matched semantic selector {}. Call get_app_state first or pass element_index.",
            describe_selector(selector)
        ));
    }

    if let Some(node) =
        unique_preferred_node(&matches, |node| node_matches_resolve_purpose(node, purpose))
    {
        return Ok(node.clone());
    }

    let useful_matches = matches
        .iter()
        .copied()
        .filter(|node| node_matches_resolve_purpose(node, purpose))
        .collect::<Vec<_>>();
    if !useful_matches.is_empty() {
        matches = useful_matches;
    }

    if let Some(node) = unique_preferred_node(&matches, node_is_showing) {
        return Ok(node.clone());
    }

    let visible_matches = matches
        .iter()
        .copied()
        .filter(|node| node_is_showing(node))
        .collect::<Vec<_>>();
    if !visible_matches.is_empty() {
        matches = visible_matches;
    }

    if matches.len() == 1 {
        return Ok(matches[0].clone());
    }

    Err(format!(
        "Semantic selector {} matched multiple cached nodes: {}. Pass element_index or add more selector fields.",
        describe_selector(selector),
        describe_matching_nodes(&matches),
    ))
}

fn unique_preferred_node<'a>(
    nodes: &[&'a AccessibilityNode],
    predicate: impl Fn(&AccessibilityNode) -> bool,
) -> Option<&'a AccessibilityNode> {
    let mut matches = nodes.iter().copied().filter(|node| predicate(node));
    let first = matches.next()?;
    matches.next().is_none().then_some(first)
}

fn node_matches_selector(node: &AccessibilityNode, selector: &ElementSelector<'_>) -> bool {
    selector
        .role
        .is_none_or(|role| normalized_contains(Some(node.role.as_str()), role))
        && selector
            .name
            .is_none_or(|name| normalized_contains(node.name.as_deref(), name))
        && selector.text.is_none_or(|text| {
            normalized_contains(
                node.text
                    .as_ref()
                    .and_then(|value| value.content.as_deref()),
                text,
            ) || normalized_contains(node.name.as_deref(), text)
                || normalized_contains(node.description.as_deref(), text)
        })
        && selector
            .states
            .iter()
            .filter(|state| !state.trim().is_empty())
            .all(|state| {
                node.states
                    .iter()
                    .any(|node_state| normalized_equals(node_state, state))
            })
}

fn node_matches_resolve_purpose(node: &AccessibilityNode, purpose: ElementResolvePurpose) -> bool {
    match purpose {
        ElementResolvePurpose::Click => {
            node.bounds.as_ref().and_then(bounds_center).is_some()
                || primary_action_name(&node.actions).is_some()
        }
        ElementResolvePurpose::Action => !node.actions.is_empty(),
        ElementResolvePurpose::SetValue => node.supports_editable_text || node.value.is_some(),
    }
}

fn node_is_showing(node: &AccessibilityNode) -> bool {
    node.states
        .iter()
        .any(|state| normalized_equals(state, "showing"))
        && node
            .states
            .iter()
            .any(|state| normalized_equals(state, "visible"))
}

fn normalized_equals(actual: &str, expected: &str) -> bool {
    normalize_text(actual) == normalize_text(expected)
}

fn normalized_contains(actual: Option<&str>, expected: &str) -> bool {
    let expected = normalize_text(expected);
    !expected.is_empty()
        && actual
            .map(normalize_text)
            .is_some_and(|actual| actual.contains(&expected))
}

fn normalize_text(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn describe_selector(selector: &ElementSelector<'_>) -> String {
    let mut parts = Vec::new();
    if let Some(role) = selector.role.map(str::trim).filter(|role| !role.is_empty()) {
        parts.push(format!("role={role:?}"));
    }
    if let Some(name) = selector.name.map(str::trim).filter(|name| !name.is_empty()) {
        parts.push(format!("name={name:?}"));
    }
    if let Some(text) = selector.text.map(str::trim).filter(|text| !text.is_empty()) {
        parts.push(format!("text={text:?}"));
    }
    let states = selector
        .states
        .iter()
        .map(|state| state.trim())
        .filter(|state| !state.is_empty())
        .collect::<Vec<_>>();
    if !states.is_empty() {
        parts.push(format!("states={states:?}"));
    }
    if parts.is_empty() {
        "<empty>".to_string()
    } else {
        parts.join(", ")
    }
}

fn describe_matching_nodes(nodes: &[&AccessibilityNode]) -> String {
    nodes
        .iter()
        .take(8)
        .map(|node| {
            format!(
                "element_index {} role={:?} name={:?}",
                node.index, node.role, node.name
            )
        })
        .collect::<Vec<_>>()
        .join("; ")
}

fn is_plain_left_click(button: Option<&str>, click_count: Option<u32>) -> bool {
    let button = button.unwrap_or("left");
    let click_count = click_count.unwrap_or(1);
    matches!(button.to_ascii_lowercase().as_str(), "left" | "primary") && click_count == 1
}

fn requested_or_primary_action(action: Option<&str>) -> &str {
    match action.map(str::trim).filter(|value| !value.is_empty()) {
        Some(action) => action,
        None => "0",
    }
}

fn primary_action(actions: &[AccessibilityAction]) -> Option<&AccessibilityAction> {
    actions.first()
}

fn primary_action_name(actions: &[AccessibilityAction]) -> Option<String> {
    primary_action(actions).map(|action| action.name.clone())
}

fn bounds_center(bounds: &Bounds) -> Option<(i32, i32)> {
    if bounds.width <= 0 || bounds.height <= 0 {
        return None;
    }
    if bounds.x <= i32::MIN / 2 || bounds.y <= i32::MIN / 2 {
        return None;
    }
    Some((
        bounds.x.checked_add(bounds.width / 2)?,
        bounds.y.checked_add(bounds.height / 2)?,
    ))
}

fn compact_accessibility_tree(nodes: Vec<AccessibilityNode>) -> Vec<AccessibilityNode> {
    if nodes.is_empty() {
        return nodes;
    }

    let keep = nodes
        .iter()
        .map(should_keep_accessibility_node)
        .collect::<Vec<_>>();
    let mut old_to_new = vec![None; nodes.len()];
    let mut compacted = Vec::new();

    for (old_index, node) in nodes.iter().enumerate() {
        if !keep[old_index] {
            continue;
        }

        let mut compacted_node = node.clone();
        compacted_node.index = compacted.len() as u32;
        compacted_node.parent_index = nearest_kept_parent(&keep, &nodes, old_index);
        old_to_new[old_index] = Some(compacted_node.index);
        compacted.push(compacted_node);
    }

    for node in &mut compacted {
        node.parent_index = node
            .parent_index
            .and_then(|old_parent| old_to_new.get(old_parent as usize).copied().flatten());
    }

    let child_counts = compacted.iter().filter_map(|node| node.parent_index).fold(
        vec![0_i32; compacted.len()],
        |mut counts, parent_index| {
            counts[parent_index as usize] += 1;
            counts
        },
    );

    for (index, node) in compacted.iter_mut().enumerate() {
        node.child_count = child_counts[index];
    }

    compacted
}

fn nearest_kept_parent(
    keep: &[bool],
    nodes: &[AccessibilityNode],
    old_index: usize,
) -> Option<u32> {
    let mut parent = nodes[old_index].parent_index;
    while let Some(parent_index) = parent {
        let parent_usize = parent_index as usize;
        if keep.get(parent_usize).copied().unwrap_or(false) {
            return Some(parent_index);
        }
        parent = nodes.get(parent_usize).and_then(|node| node.parent_index);
    }
    None
}

fn should_keep_accessibility_node(node: &AccessibilityNode) -> bool {
    if node.depth <= 1 {
        return true;
    }

    if is_actionable_accessibility_node(node) || has_meaningful_node_copy(node) {
        return true;
    }

    matches!(
        node.role.as_str(),
        "page tab" | "menu item" | "menu" | "list item" | "tree item"
    ) && !is_sentinel_or_missing_bounds(node.bounds.as_ref())
}

fn is_actionable_accessibility_node(node: &AccessibilityNode) -> bool {
    !node.actions.is_empty() || node.supports_editable_text || node.value.is_some()
}

fn has_meaningful_node_copy(node: &AccessibilityNode) -> bool {
    has_non_empty_text(node.name.as_deref())
        || has_non_empty_text(node.description.as_deref())
        || has_non_empty_text(node.text.as_ref().and_then(|text| text.content.as_deref()))
}

fn has_non_empty_text(value: Option<&str>) -> bool {
    value.map(str::trim).is_some_and(|value| !value.is_empty())
}

fn is_sentinel_or_missing_bounds(bounds: Option<&Bounds>) -> bool {
    bounds.is_none()
}

fn select_accessibility_object_ref(
    apps: &[AccessibleAppSummary],
    target_pid: u32,
    candidates: &[String],
) -> Option<String> {
    let mut pid_matches = apps.iter().filter(|app| app.pid == Some(target_pid));
    let first = pid_matches.next()?;
    let second = pid_matches.next();

    if second.is_none() {
        return Some(first.object_ref.clone());
    }

    let lowered_candidates = candidates
        .iter()
        .map(|candidate| candidate.to_ascii_lowercase())
        .collect::<Vec<_>>();

    apps.iter()
        .filter(|app| app.pid == Some(target_pid))
        .find(|app| {
            let name = app.name.as_deref().unwrap_or_default().to_ascii_lowercase();
            lowered_candidates
                .iter()
                .any(|candidate| !candidate.is_empty() && name.contains(candidate))
        })
        .map(|app| app.object_ref.clone())
        .or_else(|| Some(first.object_ref.clone()))
}

fn accessibility_filter_candidates(window_context: Option<&WindowInfo>) -> Vec<String> {
    let Some(window) = window_context else {
        return Vec::new();
    };

    let mut candidates = Vec::new();
    push_candidate(&mut candidates, window.title.as_deref());
    push_candidate(&mut candidates, window.wm_class.as_deref());

    if let Some(app_id) = trimmed_nonempty(window.app_id.as_deref()) {
        if !app_id.starts_with("window:") {
            push_candidate(&mut candidates, Some(app_id));
            if let Some(stripped) = app_id.strip_suffix(".desktop") {
                push_candidate(&mut candidates, Some(stripped));
                let normalized = stripped.replace(['-', '_', '.'], " ");
                push_candidate(&mut candidates, Some(normalized.as_str()));
            } else {
                let normalized = app_id.replace(['-', '_', '.'], " ");
                push_candidate(&mut candidates, Some(normalized.as_str()));
            }
        }
    }

    candidates
}

fn push_candidate(candidates: &mut Vec<String>, value: Option<&str>) {
    let Some(value) = trimmed_nonempty(value) else {
        return;
    };

    if !candidates.iter().any(|candidate| candidate == value) {
        candidates.push(value.to_string());
    }
}

fn trimmed_nonempty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

fn env_contains(key: &str, needle: &str) -> bool {
    env::var(key)
        .ok()
        .is_some_and(|value| value.to_ascii_lowercase().contains(needle))
}

/// True when an environment variable is set to `"1"` (an explicit on switch).
fn env_flag_enabled(key: &str) -> bool {
    env::var(key).ok().as_deref() == Some("1")
}

fn env_flag_enabled_any(keys: &[&str]) -> bool {
    keys.iter().any(|key| env_flag_enabled(key))
}

/// Return the base64 payload of a `data:` URL (or the original string if bare).
fn data_url_payload(data_url: &str) -> String {
    data_url
        .split_once(',')
        .map(|(_, payload)| payload)
        .unwrap_or(data_url)
        .to_string()
}

/// Convert a window's bounds into a crop rectangle, if it has a usable origin
/// and non-zero size.
fn window_crop_rect(bounds: &crate::windowing::WindowBounds) -> Option<(i32, i32, u32, u32)> {
    let x = bounds.x?;
    let y = bounds.y?;
    if bounds.width == 0 || bounds.height == 0 {
        return None;
    }
    Some((x, y, bounds.width, bounds.height))
}

fn apply_window_relative_click_coordinates(
    params: &mut ClickParams,
    focus: &WindowFocusResult,
) -> std::result::Result<(), String> {
    let (relative_x, relative_y) = params
        .x
        .zip(params.y)
        .ok_or_else(|| "Relative coordinate clicks require both x and y.".to_string())?;
    let bounds = focus
        .focused_window
        .as_ref()
        .and_then(|window| window.bounds.as_ref())
        .or(focus.requested_window.bounds.as_ref())
        .ok_or_else(|| {
            "Relative coordinate clicks require resolved target-window bounds.".to_string()
        })?;
    if bounds.width == 0 || bounds.height == 0 {
        return Err(
            "Relative coordinate clicks require non-empty target-window bounds.".to_string(),
        );
    }
    if relative_x < 0 || relative_y < 0 {
        return Err("Relative click coordinates must be inside target-window bounds.".to_string());
    }
    if relative_x as u32 >= bounds.width || relative_y as u32 >= bounds.height {
        return Err("Relative click coordinates must be inside target-window bounds.".to_string());
    }
    let (origin_x, origin_y) = bounds.x.zip(bounds.y).ok_or_else(|| {
        "Relative coordinate clicks require target-window bounds with an origin.".to_string()
    })?;
    let x = origin_x
        .checked_add(relative_x)
        .ok_or_else(|| "Relative click x coordinate overflowed.".to_string())?;
    let y = origin_y
        .checked_add(relative_y)
        .ok_or_else(|| "Relative click y coordinate overflowed.".to_string())?;
    params.x = Some(x);
    params.y = Some(y);
    Ok(())
}

/// Point a window-targeted scroll at the centre of the resolved window when
/// the caller supplied no coordinates. Without this the wheel events land on
/// whatever is under the current pointer position.
fn apply_window_center_scroll_point(
    params: &mut ScrollParams,
    focus: &WindowFocusResult,
) -> std::result::Result<(), String> {
    let bounds = focus
        .focused_window
        .as_ref()
        .and_then(|window| window.bounds.as_ref())
        .or(focus.requested_window.bounds.as_ref())
        .ok_or_else(|| {
            "Window-targeted scroll requires resolved target-window bounds; pass x/y explicitly."
                .to_string()
        })?;
    if bounds.width == 0 || bounds.height == 0 {
        return Err(
            "Window-targeted scroll requires non-empty target-window bounds; pass x/y explicitly."
                .to_string(),
        );
    }
    let (origin_x, origin_y) = bounds.x.zip(bounds.y).ok_or_else(|| {
        "Window-targeted scroll requires target-window bounds with an origin; pass x/y explicitly."
            .to_string()
    })?;
    params.x = Some(origin_x.saturating_add((bounds.width / 2) as i32));
    params.y = Some(origin_y.saturating_add((bounds.height / 2) as i32));
    Ok(())
}

fn apply_window_relative_scroll_coordinates(
    params: &mut ScrollParams,
    focus: &WindowFocusResult,
) -> std::result::Result<(), String> {
    let (relative_x, relative_y) = params
        .x
        .zip(params.y)
        .ok_or_else(|| "Relative scroll coordinates require both x and y.".to_string())?;
    let bounds = focus
        .focused_window
        .as_ref()
        .and_then(|window| window.bounds.as_ref())
        .or(focus.requested_window.bounds.as_ref())
        .ok_or_else(|| {
            "Relative scroll coordinates require resolved target-window bounds.".to_string()
        })?;
    if bounds.width == 0 || bounds.height == 0 {
        return Err(
            "Relative scroll coordinates require non-empty target-window bounds.".to_string(),
        );
    }
    if relative_x < 0
        || relative_y < 0
        || relative_x as u32 >= bounds.width
        || relative_y as u32 >= bounds.height
    {
        return Err("Relative scroll coordinates must be inside target-window bounds.".to_string());
    }
    let (origin_x, origin_y) = bounds.x.zip(bounds.y).ok_or_else(|| {
        "Relative scroll coordinates require target-window bounds with an origin.".to_string()
    })?;
    params.x = Some(origin_x.saturating_add(relative_x));
    params.y = Some(origin_y.saturating_add(relative_y));
    Ok(())
}

/// Crop a PNG image to `(x, y, w, h)` (clamped to the image), returning the
/// re-encoded PNG and the actual cropped dimensions.
fn crop_png(
    raw: &[u8],
    x: i32,
    y: i32,
    w: u32,
    h: u32,
) -> std::result::Result<(Vec<u8>, u32, u32), String> {
    use std::io::Cursor;
    let img = image::load_from_memory_with_format(raw, image::ImageFormat::Png)
        .map_err(|e| format!("decode png: {e}"))?;
    let (iw, ih) = (img.width(), img.height());
    let x = x.max(0) as u32;
    let y = y.max(0) as u32;
    if x >= iw || y >= ih {
        return Err("crop origin outside image".into());
    }
    let w = w.min(iw - x);
    let h = h.min(ih - y);
    let sub = img.crop_imm(x, y, w, h);
    let mut out = Vec::new();
    sub.write_to(&mut Cursor::new(&mut out), image::ImageFormat::Png)
        .map_err(|e| format!("encode png: {e}"))?;
    Ok((out, w, h))
}

fn action_result(
    action: &str,
    result: std::result::Result<Vec<Output>, String>,
    received: Option<serde_json::Value>,
) -> ActionOutput {
    match result {
        Ok(_) => ActionOutput {
            ok: true,
            implemented: true,
            action: action.to_string(),
            message: "Action sent through ydotool.".to_string(),
            received,
        },
        Err(message) => ActionOutput {
            ok: false,
            implemented: true,
            action: action.to_string(),
            message,
            received,
        },
    }
}

fn valid_runtime_component(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn avatar_cursor_identity_from_cmdline(cmdline: &[u8]) -> (Option<String>, Option<String>) {
    let executable = cmdline.split(|byte| *byte == 0).next().unwrap_or_default();
    if Path::new(std::ffi::OsStr::from_bytes(executable)).file_name()
        != Some(std::ffi::OsStr::new("electron"))
    {
        return (None, None);
    }
    let mut app_id = None;
    let mut instance_id = None;
    for argument in cmdline.split(|byte| *byte == 0) {
        let Ok(argument) = std::str::from_utf8(argument) else {
            continue;
        };
        if let Some(value) = argument.strip_prefix("--app-id=") {
            if valid_runtime_component(value) {
                app_id = Some(value.to_string());
            }
        }
        let Some(value) = argument.strip_prefix("--user-data-dir=") else {
            continue;
        };
        let components = Path::new(value)
            .components()
            .filter_map(|component| component.as_os_str().to_str())
            .collect::<Vec<_>>();
        for window in components.windows(3) {
            if window[0] == "instances"
                && valid_runtime_component(window[1])
                && window[2] == "electron-user-data"
            {
                instance_id = Some(window[1].to_string());
            }
        }
    }
    (app_id, instance_id)
}

fn proc_parent_pid(pid: &str) -> Option<u32> {
    let status = fs::read_to_string(format!("/proc/{pid}/status")).ok()?;
    status
        .lines()
        .find_map(|line| line.strip_prefix("PPid:")?.trim().parse::<u32>().ok())
}

fn avatar_cursor_parent_identity() -> (Option<String>, Option<String>) {
    let mut pid = proc_parent_pid("self");
    for _ in 0..8 {
        let Some(current_pid) = pid.filter(|pid| *pid > 1) else {
            break;
        };
        if let Ok(cmdline) = fs::read(format!("/proc/{current_pid}/cmdline")) {
            let identity = avatar_cursor_identity_from_cmdline(&cmdline);
            if identity.0.is_some() {
                return identity;
            }
        }
        pid = proc_parent_pid(&current_pid.to_string());
    }
    (None, None)
}

fn avatar_cursor_socket_path_from(
    runtime_dir: Option<&str>,
    app_id: Option<&str>,
    legacy_app_id: Option<&str>,
    instance_id: Option<&str>,
) -> Option<PathBuf> {
    let runtime_dir = runtime_dir?.trim();
    let runtime_dir = Path::new(runtime_dir);
    if !runtime_dir.is_absolute() {
        return None;
    }

    let app_id = app_id
        .or(legacy_app_id)
        .map(str::trim)
        .filter(|value| valid_runtime_component(value))
        .unwrap_or("codex-desktop");
    let instance_id = instance_id.map(str::trim).filter(|value| !value.is_empty());
    if instance_id.is_some_and(|value| !valid_runtime_component(value)) {
        return None;
    }

    let mut path = runtime_dir.join(app_id);
    if let Some(instance_id) = instance_id {
        path.push("instances");
        path.push(instance_id);
    }
    path.push(AVATAR_CURSOR_SOCKET_NAME);
    (path.as_os_str().as_bytes().len() <= AVATAR_CURSOR_SOCKET_MAX_BYTES).then_some(path)
}

fn avatar_cursor_socket_path() -> Option<PathBuf> {
    let runtime_dir = env::var("XDG_RUNTIME_DIR").ok();
    let app_id = env::var("CODEX_LINUX_APP_ID").ok();
    let legacy_app_id = env::var("CODEX_APP_ID").ok();
    let instance_id = env::var("CODEX_LINUX_INSTANCE_ID").ok();
    let parent_identity = (app_id.is_none() && legacy_app_id.is_none() || instance_id.is_none())
        .then(avatar_cursor_parent_identity)
        .unwrap_or_default();
    avatar_cursor_socket_path_from(
        runtime_dir.as_deref(),
        app_id.as_deref().or(parent_identity.0.as_deref()),
        legacy_app_id.as_deref(),
        instance_id.as_deref().or(parent_identity.1.as_deref()),
    )
}

async fn send_avatar_cursor_signal(path: &Path) -> bool {
    let Ok(socket_metadata) = fs::symlink_metadata(path) else {
        return false;
    };
    let Some(current_uid) = fs::metadata("/proc/self")
        .ok()
        .map(|metadata| metadata.uid())
    else {
        return false;
    };
    if !socket_metadata.file_type().is_socket()
        || socket_metadata.uid() != current_uid
        || socket_metadata.mode() & 0o077 != 0
    {
        return false;
    }
    let Ok(Ok(mut stream)) =
        timeout(AVATAR_CURSOR_NOTIFY_TIMEOUT, TokioUnixStream::connect(path)).await
    else {
        return false;
    };
    matches!(
        timeout(AVATAR_CURSOR_NOTIFY_TIMEOUT, stream.write_all(b"pointer\n"),).await,
        Ok(Ok(()))
    )
}

fn notify_avatar_cursor() {
    let Some(path) = avatar_cursor_socket_path() else {
        return;
    };
    tokio::spawn(async move {
        let _ = send_avatar_cursor_signal(&path).await;
    });
}

fn pointer_action_result(output: ActionOutput) -> ActionOutput {
    if output.ok {
        notify_avatar_cursor();
    }
    output
}

fn action_result_with_focus(
    action: &str,
    result: std::result::Result<Vec<Output>, String>,
    received: Option<serde_json::Value>,
    focus: Option<WindowFocusResult>,
) -> ActionOutput {
    with_focus_context(action_result(action, result, received), focus)
}

fn successful_action_with_focus(
    action: &str,
    message: &str,
    received: Option<serde_json::Value>,
    focus: Option<WindowFocusResult>,
) -> ActionOutput {
    with_focus_context(
        ActionOutput {
            ok: true,
            implemented: true,
            action: action.to_string(),
            message: message.to_string(),
            received,
        },
        focus,
    )
}

fn with_focus_context(mut output: ActionOutput, focus: Option<WindowFocusResult>) -> ActionOutput {
    if output.ok {
        if let Some(focus) = focus {
            let verification = if focus.exact_window_focused {
                "exact window-focus"
            } else {
                "app-level focus"
            };
            output.message = format!(
                "{} Target window_id {} was focused with {verification} verification before input.",
                output.message, focus.requested_window.window_id,
            );
        }
    }
    output
}

fn describe_focused_element(element: &FocusedElementSummary, expects_editable: bool) -> String {
    let name = element
        .name
        .as_deref()
        .filter(|name| !name.is_empty())
        .map(|name| format!(" \"{name}\""))
        .unwrap_or_default();
    if element.editable {
        format!("Focused element: {}{name} (editable).", element.role)
    } else if expects_editable {
        format!(
            "WARNING: focused element is {}{name}, which is not editable — the typed text likely went nowhere. Click the intended input first or use set_value.",
            element.role
        )
    } else {
        format!("Focused element: {}{name} (not editable).", element.role)
    }
}

fn first_line(text: &str) -> &str {
    text.lines().next().unwrap_or(text)
}

/// Append supplemental notes (off-screen or focused-element feedback) to an
/// action result message without changing ok/implemented semantics.
fn with_notes(mut output: ActionOutput, notes: impl IntoIterator<Item = String>) -> ActionOutput {
    for note in notes {
        output.message = format!("{} {note}", output.message);
    }
    output
}

fn focus_satisfies_target(focus: &WindowFocusResult, target: &WindowTarget) -> bool {
    if target.requires_exact_focus() {
        focus.exact_window_focused
    } else {
        focus.exact_window_focused || focus.app_focused
    }
}

async fn window_list_output() -> ListWindowsOutput {
    match list_windows().await {
        Ok(windows) => {
            let backend = window_backend(windows.iter());
            let note = registry::list_note(&backend);
            ListWindowsOutput {
                backend,
                windows,
                error: None,
                permissions_hint: None,
                note: note.to_string(),
            }
        }
        Err(error) => {
            let error = format!("{error:#}");
            ListWindowsOutput {
                backend: GNOME_SHELL_INTROSPECT_BACKEND.to_string(),
                windows: Vec::new(),
                permissions_hint: window_permission_hint(&error),
                error: Some(error),
                note: "Window listing failed, so targeted keyboard input cannot safely focus or verify a target window."
                    .to_string(),
            }
        }
    }
}

fn window_backend<'a>(windows: impl Iterator<Item = &'a WindowInfo>) -> String {
    windows
        .map(|window| window.backend.clone())
        .next()
        .unwrap_or_else(|| GNOME_SHELL_INTROSPECT_BACKEND.to_string())
}

fn absolute_mousemove_args(x: i32, y: i32) -> Vec<String> {
    vec![
        "mousemove".to_string(),
        "--absolute".to_string(),
        "--".to_string(),
        x.to_string(),
        y.to_string(),
    ]
}

fn wheel_mousemove_args(dx: i32, dy: i32) -> Vec<String> {
    vec![
        "mousemove".to_string(),
        "--wheel".to_string(),
        "--".to_string(),
        dx.to_string(),
        dy.to_string(),
    ]
}

async fn run_ydotool_sequence(
    commands: &[Vec<String>],
) -> std::result::Result<Vec<Output>, String> {
    let mut outputs = Vec::new();
    for (index, args) in commands.iter().enumerate() {
        outputs.push(run_ydotool(args).await?);
        if index + 1 < commands.len() {
            sleep(Duration::from_millis(35)).await;
        }
    }
    Ok(outputs)
}

async fn run_ydotool(args: &[String]) -> std::result::Result<Output, String> {
    ydotool::ensure_supported()?;
    let mut command = TokioCommand::new("ydotool");
    command.args(args);
    if let Some(socket) = ydotool_socket() {
        command.env("YDOTOOL_SOCKET", socket);
    }
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());

    match command.spawn() {
        Ok(child) => match wait_for_ydotool_output(child).await {
            Ok(output) if output.status.success() => {
                if let Some(error) = ydotool::cli_error(&output.stderr) {
                    Err(error)
                } else {
                    Ok(output)
                }
            }
            Ok(output) => Err(ydotool_output_error(output)),
            Err(error) => Err(error),
        },
        Err(error) => Err(format!("failed to run ydotool: {error}")),
    }
}

async fn run_ydotool_type_text(text: &str) -> std::result::Result<Output, String> {
    ydotool::ensure_supported()?;
    let mut command = TokioCommand::new("ydotool");
    command.args(["type", "--file", "-"]);
    if let Some(socket) = ydotool_socket() {
        command.env("YDOTOOL_SOCKET", socket);
    }
    command.stdin(Stdio::piped());
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());

    match command.spawn() {
        Ok(mut child) => {
            if let Some(mut stdin) = child.stdin.take() {
                if let Err(error) = stdin.write_all(text.as_bytes()).await {
                    let _ = child.kill().await;
                    return Err(format!("failed to write text to ydotool stdin: {error}"));
                }
            }
            let output =
                wait_for_ydotool_output_with_timeout(child, ydotool_type_timeout(text)).await?;
            if output.status.success() {
                if let Some(error) = ydotool::cli_error(&output.stderr) {
                    Err(error)
                } else {
                    Ok(output)
                }
            } else {
                Err(ydotool_output_error(output))
            }
        }
        Err(error) => Err(format!("failed to run ydotool: {error}")),
    }
}

async fn wait_for_ydotool_output(child: TokioChild) -> std::result::Result<Output, String> {
    wait_for_ydotool_output_with_timeout(child, YDOTOOL_TIMEOUT).await
}

async fn wait_for_ydotool_output_with_timeout(
    mut child: TokioChild,
    timeout_duration: Duration,
) -> std::result::Result<Output, String> {
    let stdout_reader = read_child_pipe(child.stdout.take());
    let stderr_reader = read_child_pipe(child.stderr.take());
    let status = match timeout(timeout_duration, child.wait()).await {
        Err(_) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            stdout_reader.abort();
            stderr_reader.abort();
            return Err(format!(
                "ydotool timed out after {}s",
                timeout_duration.as_secs()
            ));
        }
        Ok(result) => result.map_err(|error| format!("failed to wait for ydotool: {error}"))?,
    };
    let stdout = stdout_reader.await.unwrap_or_default();
    let stderr = stderr_reader.await.unwrap_or_default();
    Ok(Output {
        status,
        stdout,
        stderr,
    })
}

fn read_child_pipe<R>(pipe: Option<R>) -> tokio::task::JoinHandle<Vec<u8>>
where
    R: AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut output = Vec::new();
        if let Some(mut pipe) = pipe {
            let _ = pipe.read_to_end(&mut output).await;
        }
        output
    })
}

fn ydotool_type_timeout(text: &str) -> Duration {
    let text_seconds = (text.chars().count() as u64).div_ceil(YDOTOOL_TYPE_CHARS_PER_SECOND);
    Duration::from_secs(YDOTOOL_TIMEOUT.as_secs().saturating_add(text_seconds))
}

const EVDEV_KEY_LEFTCTRL: i32 = 29;
const EVDEV_KEY_V: i32 = 47;
const KDE_CLIPBOARD_RESTORE_MIN_DELAY_MS: u64 = 1_500;
const KDE_CLIPBOARD_RESTORE_MAX_DELAY_MS: u64 = 5_000;
const KDE_CLIPBOARD_RESTORE_CHARS_PER_SECOND: u64 = 250;

fn kde_clipboard_restore_delay(text: &str) -> Duration {
    let text_delay_ms = (text.chars().count() as u64)
        .saturating_mul(1_000)
        .div_ceil(KDE_CLIPBOARD_RESTORE_CHARS_PER_SECOND);
    Duration::from_millis(text_delay_ms.clamp(
        KDE_CLIPBOARD_RESTORE_MIN_DELAY_MS,
        KDE_CLIPBOARD_RESTORE_MAX_DELAY_MS,
    ))
}

#[derive(Debug)]
struct KdeClipboardPasteError {
    message: String,
    can_fallback_to_ydotool: bool,
    clear_portal_keyboard_session: bool,
}

impl KdeClipboardPasteError {
    fn before_text_input(message: String) -> Self {
        Self {
            message,
            can_fallback_to_ydotool: true,
            clear_portal_keyboard_session: false,
        }
    }

    fn after_portal_input(message: String) -> Self {
        Self {
            message,
            can_fallback_to_ydotool: false,
            clear_portal_keyboard_session: true,
        }
    }
}

async fn run_kde_clipboard_paste_text(
    session: &PortalKeyboardSession,
    text: &str,
) -> std::result::Result<String, KdeClipboardPasteError> {
    let previous = kde_clipboard_contents()
        .await
        .map_err(KdeClipboardPasteError::before_text_input)?;
    kde_set_clipboard_contents(text)
        .await
        .map_err(KdeClipboardPasteError::before_text_input)?;

    let paste_result = press_keycode_chord(session, &[EVDEV_KEY_LEFTCTRL], EVDEV_KEY_V)
        .await
        .map_err(|error| format!("{error:#}"));

    sleep(kde_clipboard_restore_delay(text)).await;
    let restore_result = kde_set_clipboard_contents(&previous).await;

    match (paste_result, restore_result) {
        (Ok(_), Ok(_)) => Ok("Action pasted through KDE clipboard integration.".to_string()),
        (Err(error), Ok(_)) => Err(KdeClipboardPasteError::after_portal_input(error)),
        (Ok(_), Err(restore_error)) => Ok(format!(
            "Action pasted through KDE clipboard integration. Warning: previous KDE clipboard contents could not be restored: {restore_error}"
        )),
        (Err(error), Err(restore_error)) => Err(KdeClipboardPasteError::after_portal_input(
            format!("{error}; previous KDE clipboard contents could not be restored: {restore_error}"),
        )),
    }
}

async fn kde_clipboard_contents() -> std::result::Result<String, String> {
    let connection = kde_clipboard_connection().await?;
    let proxy = kde_clipboard_proxy(&connection).await?;
    let output: String = kde_clipboard_dbus_operation(
        "getClipboardContents",
        proxy.call("getClipboardContents", &()),
    )
    .await?;
    Ok(output)
}

async fn kde_set_clipboard_contents(text: &str) -> std::result::Result<(), String> {
    let connection = kde_clipboard_connection().await?;
    let proxy = kde_clipboard_proxy(&connection).await?;
    let _: () = kde_clipboard_dbus_operation(
        "setClipboardContents",
        proxy.call("setClipboardContents", &(text)),
    )
    .await?;
    Ok(())
}

async fn kde_clipboard_connection() -> std::result::Result<ZbusConnection, String> {
    ZbusConnection::session()
        .await
        .map_err(|error| format!("failed to connect to session bus for KDE clipboard: {error}"))
}

async fn kde_clipboard_proxy(
    connection: &ZbusConnection,
) -> std::result::Result<ZbusProxy<'_>, String> {
    kde_clipboard_dbus_operation(
        "proxy creation",
        ZbusProxy::new(
            connection,
            KDE_KLIPPER_SERVICE,
            KDE_KLIPPER_PATH,
            KDE_KLIPPER_INTERFACE,
        ),
    )
    .await
}

async fn kde_clipboard_dbus_operation<T, F>(
    operation: &'static str,
    future: F,
) -> std::result::Result<T, String>
where
    F: Future<Output = zbus::Result<T>>,
{
    kde_clipboard_dbus_operation_with_timeout(operation, future, KDE_CLIPBOARD_DBUS_TIMEOUT).await
}

async fn kde_clipboard_dbus_operation_with_timeout<T, F>(
    operation: &'static str,
    future: F,
    timeout_duration: Duration,
) -> std::result::Result<T, String>
where
    F: Future<Output = zbus::Result<T>>,
{
    timeout(timeout_duration, future)
        .await
        .map_err(|_| format!("KDE clipboard {operation} timed out"))?
        .map_err(|error| format!("KDE clipboard {operation} failed: {error}"))
}

fn ydotool_output_error(output: Output) -> String {
    command_output_error("ydotool", output)
}

fn command_output_error(command: &str, output: Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let detail = if stderr.is_empty() { stdout } else { stderr };
    if detail.is_empty() {
        format!("{command} exited with {}", output.status)
    } else {
        detail
    }
}

fn ydotool_socket() -> Option<String> {
    if let Some(socket) = explicit_ydotool_socket() {
        return Some(socket);
    }

    connectable_ydotool_socket_from(fallback_ydotool_socket_candidates())
        .map(|path| path.display().to_string())
}

fn ydotool_backend_available() -> bool {
    ydotool_backend_available_from(
        ydotool_socket_connectable(),
        ydotool::ensure_supported().is_ok(),
    )
}

fn ydotool_socket_connectable() -> bool {
    if let Some(socket) = explicit_ydotool_socket() {
        return ydotool_socket_connects(&PathBuf::from(socket));
    }
    connectable_ydotool_socket_from(fallback_ydotool_socket_candidates()).is_some()
}

fn ydotool_backend_available_from(socket_available: bool, cli_supported: bool) -> bool {
    socket_available && cli_supported
}

fn should_prefer_portal_backend_by_default(is_wayland: bool, ydotool_available: bool) -> bool {
    is_wayland && !ydotool_available
}

fn explicit_ydotool_socket() -> Option<String> {
    if let Ok(socket) = env::var("YDOTOOL_SOCKET") {
        let socket = socket.trim();
        if !socket.is_empty() {
            return Some(socket.to_string());
        }
    }
    None
}

fn fallback_ydotool_socket_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(runtime) = env::var("XDG_RUNTIME_DIR")
        .ok()
        .map(PathBuf::from)
        .or_else(|| user_id().map(|uid| PathBuf::from(format!("/run/user/{uid}"))))
    {
        candidates.push(runtime.join(".ydotool_socket"));
    }
    candidates.push(PathBuf::from("/tmp/.ydotool_socket"));
    candidates
}

fn connectable_ydotool_socket_from(candidates: Vec<PathBuf>) -> Option<PathBuf> {
    candidates.into_iter().find(ydotool_socket_connects)
}

fn ydotool_socket_connects(path: &PathBuf) -> bool {
    UnixStream::connect(path).is_ok()
        || UnixDatagram::unbound()
            .and_then(|socket| socket.connect(path))
            .is_ok()
}

fn mouse_button_code(button: Option<&str>) -> String {
    match button.unwrap_or("left").to_ascii_lowercase().as_str() {
        "right" => "0xC1",
        "middle" => "0xC2",
        "side" => "0xC3",
        "extra" => "0xC4",
        "forward" => "0xC5",
        "back" => "0xC6",
        _ => "0xC0",
    }
    .to_string()
}

fn key_sequence(key: &str) -> Option<Vec<String>> {
    let parts = key
        .split('+')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    let (key_part, modifier_parts) = parts.split_last()?;
    if modifier_parts.is_empty() {
        if let Some(modifier) = modifier_keycode(key_part) {
            return Some(vec![format!("{modifier}:1"), format!("{modifier}:0")]);
        }
    }
    let mut modifiers = Vec::new();
    for part in modifier_parts {
        modifiers.push(modifier_keycode(part)?);
    }
    let keycode = keycode(key_part)?;

    let mut events = Vec::new();
    for modifier in &modifiers {
        events.push(format!("{modifier}:1"));
    }
    events.push(format!("{keycode}:1"));
    events.push(format!("{keycode}:0"));
    for modifier in modifiers.iter().rev() {
        events.push(format!("{modifier}:0"));
    }
    Some(events)
}

fn modifier_keycode(key: &str) -> Option<u16> {
    match normalize_key(key).as_str() {
        "ctrl" | "control" => Some(29),
        "alt" | "option" => Some(56),
        "shift" => Some(42),
        "meta" | "super" | "cmd" | "command" => Some(125),
        _ => None,
    }
}

fn keycode(key: &str) -> Option<u16> {
    match normalize_key(key).as_str() {
        "enter" | "return" => Some(28),
        "escape" | "esc" => Some(1),
        "tab" => Some(15),
        "backspace" => Some(14),
        "delete" | "del" => Some(111),
        "space" => Some(57),
        "home" => Some(102),
        "end" => Some(107),
        "pageup" | "page_up" => Some(104),
        "pagedown" | "page_down" => Some(109),
        "arrowleft" | "left" => Some(105),
        "arrowright" | "right" => Some(106),
        "arrowup" | "up" => Some(103),
        "arrowdown" | "down" => Some(108),
        "f1" => Some(59),
        "f2" => Some(60),
        "f3" => Some(61),
        "f4" => Some(62),
        "f5" => Some(63),
        "f6" => Some(64),
        "f7" => Some(65),
        "f8" => Some(66),
        "f9" => Some(67),
        "f10" => Some(68),
        "f11" => Some(87),
        "f12" => Some(88),
        value if value.len() == 1 => keycode_for_ascii(value.as_bytes()[0] as char),
        _ => None,
    }
}

fn normalize_key(key: &str) -> String {
    key.trim().to_ascii_lowercase().replace(['-', ' '], "")
}

fn keycode_for_ascii(value: char) -> Option<u16> {
    match value {
        'a' => Some(30),
        'b' => Some(48),
        'c' => Some(46),
        'd' => Some(32),
        'e' => Some(18),
        'f' => Some(33),
        'g' => Some(34),
        'h' => Some(35),
        'i' => Some(23),
        'j' => Some(36),
        'k' => Some(37),
        'l' => Some(38),
        'm' => Some(50),
        'n' => Some(49),
        'o' => Some(24),
        'p' => Some(25),
        'q' => Some(16),
        'r' => Some(19),
        's' => Some(31),
        't' => Some(20),
        'u' => Some(22),
        'v' => Some(47),
        'w' => Some(17),
        'x' => Some(45),
        'y' => Some(21),
        'z' => Some(44),
        '1' => Some(2),
        '2' => Some(3),
        '3' => Some(4),
        '4' => Some(5),
        '5' => Some(6),
        '6' => Some(7),
        '7' => Some(8),
        '8' => Some(9),
        '9' => Some(10),
        '0' => Some(11),
        _ => None,
    }
}

fn user_id() -> Option<String> {
    let output = Command::new("id").arg("-u").output().ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .filter(|value| !value.is_empty())
}

fn list_process_apps() -> Vec<AppCandidate> {
    let output = Command::new("ps")
        .args(["-eo", "pid=,comm=,args="])
        .output();
    let Ok(output) = output else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }

    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(parse_process_line)
        .filter(|app| looks_like_desktop_app(&app.name, &app.command))
        .take(50)
        .collect()
}

fn parse_process_line(line: &str) -> Option<AppCandidate> {
    let trimmed = line.trim();
    let mut parts = trimmed.splitn(3, char::is_whitespace);
    let pid = parts.next()?.parse().ok()?;
    let name = parts.next()?.to_string();
    let command = parts.next().unwrap_or("").trim().to_string();
    Some(AppCandidate { name, pid, command })
}

fn looks_like_desktop_app(name: &str, command: &str) -> bool {
    let haystack = format!("{name} {command}").to_ascii_lowercase();
    [
        "codex",
        "electron",
        "chrome",
        "chromium",
        "firefox",
        "brave",
        "code",
        "gnome-terminal",
        "ptyxis",
        "kgx",
        "nautilus",
        "slack",
        "discord",
        "spotify",
        "obsidian",
    ]
    .iter()
    .any(|needle| haystack.contains(needle))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::atspi_tree::{AccessibilityAction, Bounds};
    use crate::windows::{WindowBounds, GNOME_SHELL_EXTENSION_BACKEND};

    struct EnvVarGuard {
        key: &'static str,
        original: Option<std::ffi::OsString>,
    }

    impl EnvVarGuard {
        fn set(key: &'static str, value: &str) -> Self {
            let original = std::env::var_os(key);
            std::env::set_var(key, value);
            Self { key, original }
        }
    }

    impl Drop for EnvVarGuard {
        fn drop(&mut self) {
            match &self.original {
                Some(value) => std::env::set_var(self.key, value),
                None => std::env::remove_var(self.key),
            }
        }
    }

    #[test]
    fn avatar_cursor_socket_path_is_instance_scoped_and_bounded() {
        assert_eq!(
            avatar_cursor_socket_path_from(
                Some("/run/user/1000"),
                Some("codex-desktop"),
                None,
                Some("secondary"),
            ),
            Some(PathBuf::from(
                "/run/user/1000/codex-desktop/instances/secondary/computer-use-cursor.sock",
            )),
        );
        assert_eq!(
            avatar_cursor_socket_path_from(Some("relative"), Some("codex-desktop"), None, None,),
            None,
        );
        assert_eq!(
            avatar_cursor_socket_path_from(
                Some("/run/user/1000"),
                Some("codex-desktop"),
                None,
                Some("../escape"),
            ),
            None,
        );
        assert_eq!(
            avatar_cursor_socket_path_from(
                Some(&format!("/run/user/1000/{}", "x".repeat(100))),
                Some("codex-desktop"),
                None,
                None,
            ),
            None,
        );
    }

    #[test]
    fn avatar_cursor_identity_uses_electron_app_and_instance_arguments() {
        assert_eq!(
            avatar_cursor_identity_from_cmdline(
                b"/opt/codex/electron\0--app-id=codex-cua-lab\0--user-data-dir=/home/user/.local/state/codex-cua-lab/instances/port-5176/electron-user-data\0",
            ),
            (
                Some("codex-cua-lab".to_string()),
                Some("port-5176".to_string()),
            ),
        );
        assert_eq!(
            avatar_cursor_identity_from_cmdline(
                b"/opt/codex/electron\0--app-id=../escape\0--user-data-dir=/tmp/instances/../electron-user-data\0",
            ),
            (None, None),
        );
        assert_eq!(
            avatar_cursor_identity_from_cmdline(b"/bin/bash\0--app-id=codex-desktop\0"),
            (None, None),
        );
        assert_eq!(
            avatar_cursor_identity_from_cmdline(
                b"/opt/codex/electron\0--app-id=codex-desktop\0--user-data-dir=/home/instances/alice/.local/state/codex-desktop/electron-user-data\0",
            ),
            (Some("codex-desktop".to_string()), None),
        );
    }

    #[tokio::test]
    async fn avatar_cursor_signal_uses_the_private_unix_stream_protocol() {
        let root = std::env::temp_dir().join(format!(
            "computer-use-avatar-cursor-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        std::fs::create_dir_all(&root).unwrap();
        let socket = root.join("cursor.sock");
        let listener = tokio::net::UnixListener::bind(&socket).unwrap();
        std::fs::set_permissions(&socket, std::os::unix::fs::PermissionsExt::from_mode(0o600))
            .unwrap();

        assert!(send_avatar_cursor_signal(&socket).await);
        let (mut stream, _) = timeout(Duration::from_secs(1), listener.accept())
            .await
            .unwrap()
            .unwrap();
        let mut payload = [0_u8; 8];
        stream.read_exact(&mut payload).await.unwrap();
        assert_eq!(&payload, b"pointer\n");

        drop(listener);
        let _ = std::fs::remove_dir_all(root);
    }

    fn node(index: u32, bounds: Option<Bounds>) -> AccessibilityNode {
        node_with_actions(index, bounds, Vec::new())
    }

    fn node_with_actions(
        index: u32,
        bounds: Option<Bounds>,
        actions: Vec<AccessibilityAction>,
    ) -> AccessibilityNode {
        AccessibilityNode {
            index,
            parent_index: None,
            depth: 0,
            object_ref: format!(":1.{index}/org/a11y/atspi/accessible/{index}"),
            role: "push button".to_string(),
            name: Some(format!("Button {index}")),
            description: None,
            child_count: 0,
            bounds,
            states: Vec::new(),
            actions,
            value: None,
            text: None,
            supports_editable_text: false,
        }
    }

    fn click_action() -> AccessibilityAction {
        AccessibilityAction {
            index: 0,
            name: "Click".to_string(),
            description: "Clicks the element".to_string(),
            keybinding: String::new(),
        }
    }

    fn solid_png(width: u32, height: u32) -> Vec<u8> {
        let img = image::RgbaImage::from_pixel(width, height, image::Rgba([32, 128, 192, 255]));
        let mut out = Vec::new();
        image::DynamicImage::ImageRgba8(img)
            .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
            .unwrap();
        out
    }

    #[test]
    fn window_crop_happens_before_screenshot_payload_resize() {
        let (cropped, width, height) = crop_png(&solid_png(400, 200), 50, 20, 200, 100).unwrap();
        let capture = prepare_screenshot_payload(
            RawScreenshotCapture {
                mime_type: "image/png".to_string(),
                bytes: cropped,
                source: "test".to_string(),
                width,
                height,
            },
            ScreenshotPayloadOptions {
                max_width: Some(100),
                max_height: Some(100),
                max_bytes: Some(1024 * 1024),
                ..Default::default()
            },
        )
        .unwrap();

        assert_eq!(
            (capture.coordinate_width, capture.coordinate_height),
            (200, 100)
        );
        assert_eq!((capture.width, capture.height), (100, 50));
        assert!(capture.resized);
    }

    fn window_info(
        window_id: u64,
        title: Option<&str>,
        app_id: Option<&str>,
        wm_class: Option<&str>,
        pid: Option<u32>,
    ) -> WindowInfo {
        WindowInfo {
            window_id,
            title: title.map(str::to_string),
            app_id: app_id.map(str::to_string),
            wm_class: wm_class.map(str::to_string),
            pid,
            bounds: Some(WindowBounds {
                x: Some(10),
                y: Some(20),
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

    fn focus_result_with_bounds(bounds: Option<WindowBounds>) -> WindowFocusResult {
        let mut requested_window = window_info(
            42,
            Some("Target"),
            Some("target-app"),
            Some("target-app"),
            Some(4242),
        );
        requested_window.bounds = bounds;
        let mut focused_window = requested_window.clone();
        focused_window.focused = true;
        WindowFocusResult {
            requested_window,
            focused_window: Some(focused_window),
            exact_window_focused: true,
            app_focused: true,
            backend: GNOME_SHELL_EXTENSION_BACKEND.to_string(),
            note: "test focus".to_string(),
        }
    }

    fn window_bounds(x: Option<i32>, y: Option<i32>, width: u32, height: u32) -> WindowBounds {
        WindowBounds {
            x,
            y,
            width,
            height,
        }
    }

    #[test]
    fn relative_click_coordinates_use_verified_window_bounds() {
        let focus = focus_result_with_bounds(Some(window_bounds(Some(100), Some(200), 800, 600)));
        let mut params = ClickParams {
            x: Some(7),
            y: Some(9),
            relative: Some(true),
            ..Default::default()
        };

        apply_window_relative_click_coordinates(&mut params, &focus).unwrap();

        assert_eq!((params.x, params.y), (Some(107), Some(209)));
    }

    #[test]
    fn relative_click_coordinates_prefer_focused_window_bounds() {
        let mut focus =
            focus_result_with_bounds(Some(window_bounds(Some(100), Some(200), 800, 600)));
        let focused_window = focus
            .focused_window
            .as_mut()
            .expect("test focus should include focused window");
        focused_window.bounds = Some(window_bounds(Some(300), Some(400), 800, 600));
        let mut params = ClickParams {
            x: Some(7),
            y: Some(9),
            relative: Some(true),
            ..Default::default()
        };

        apply_window_relative_click_coordinates(&mut params, &focus).unwrap();

        assert_eq!((params.x, params.y), (Some(307), Some(409)));
    }

    #[test]
    fn relative_click_coordinates_require_window_bounds_origin() {
        let focus = focus_result_with_bounds(Some(window_bounds(None, Some(200), 800, 600)));
        let mut params = ClickParams {
            x: Some(7),
            y: Some(9),
            relative: Some(true),
            ..Default::default()
        };

        let error = apply_window_relative_click_coordinates(&mut params, &focus).unwrap_err();

        assert!(error.contains("bounds with an origin"));
        assert_eq!((params.x, params.y), (Some(7), Some(9)));
    }

    #[test]
    fn relative_click_coordinates_require_xy() {
        let focus = focus_result_with_bounds(Some(window_bounds(Some(100), Some(200), 800, 600)));
        let mut params = ClickParams {
            x: Some(7),
            relative: Some(true),
            ..Default::default()
        };

        let error = apply_window_relative_click_coordinates(&mut params, &focus).unwrap_err();

        assert!(error.contains("both x and y"));
        assert_eq!((params.x, params.y), (Some(7), None));
    }

    #[test]
    fn relative_click_coordinates_must_stay_inside_bounds() {
        let focus = focus_result_with_bounds(Some(window_bounds(Some(100), Some(200), 800, 600)));

        for (x, y) in [(-1, 9), (7, -1), (800, 9), (7, 600)] {
            let mut params = ClickParams {
                x: Some(x),
                y: Some(y),
                relative: Some(true),
                ..Default::default()
            };

            let error = apply_window_relative_click_coordinates(&mut params, &focus).unwrap_err();

            assert!(error.contains("inside target-window bounds"));
            assert_eq!((params.x, params.y), (Some(x), Some(y)));
        }
    }

    #[test]
    fn accessibility_filter_candidates_prefer_title_and_skip_synthetic_app_id() {
        let window = window_info(
            42,
            Some("CU ATSPI GTK Test"),
            Some("window:46"),
            Some("cu_atspi_gtk_test.py"),
            Some(2914326),
        );

        let candidates = accessibility_filter_candidates(Some(&window));

        assert_eq!(
            candidates,
            vec![
                "CU ATSPI GTK Test".to_string(),
                "cu_atspi_gtk_test.py".to_string(),
            ]
        );
    }

    #[test]
    fn select_accessibility_object_ref_prefers_exact_pid_match() {
        let apps = vec![
            AccessibleAppSummary {
                object_ref: ":1.31/org/a11y/atspi/accessible/root".to_string(),
                name: Some("electron".to_string()),
                pid: Some(2774076),
                role: "application".to_string(),
                child_count: 1,
                bounds: None,
            },
            AccessibleAppSummary {
                object_ref: ":1.64/org/a11y/atspi/accessible/root".to_string(),
                name: Some("cu_atspi_gtk_test.py".to_string()),
                pid: Some(2914326),
                role: "application".to_string(),
                child_count: 1,
                bounds: None,
            },
        ];

        let object_ref = select_accessibility_object_ref(
            &apps,
            2914326,
            &[
                "CU ATSPI GTK Test".to_string(),
                "cu_atspi_gtk_test.py".to_string(),
            ],
        )
        .unwrap();

        assert_eq!(object_ref, ":1.64/org/a11y/atspi/accessible/root");
    }

    #[test]
    fn compact_accessibility_tree_reparents_actionable_descendants() {
        let nodes = vec![
            AccessibilityNode {
                index: 0,
                parent_index: None,
                depth: 0,
                object_ref: ":1.0/root".to_string(),
                role: "application".to_string(),
                name: Some("demo-app".to_string()),
                description: None,
                child_count: 1,
                bounds: None,
                states: Vec::new(),
                actions: Vec::new(),
                value: None,
                text: None,
                supports_editable_text: false,
            },
            AccessibilityNode {
                index: 1,
                parent_index: Some(0),
                depth: 1,
                object_ref: ":1.1/frame".to_string(),
                role: "frame".to_string(),
                name: Some("Demo Frame".to_string()),
                description: None,
                child_count: 1,
                bounds: None,
                states: Vec::new(),
                actions: Vec::new(),
                value: None,
                text: None,
                supports_editable_text: false,
            },
            AccessibilityNode {
                index: 2,
                parent_index: Some(1),
                depth: 2,
                object_ref: ":1.2/filler".to_string(),
                role: "filler".to_string(),
                name: None,
                description: None,
                child_count: 1,
                bounds: None,
                states: Vec::new(),
                actions: Vec::new(),
                value: None,
                text: None,
                supports_editable_text: false,
            },
            AccessibilityNode {
                index: 3,
                parent_index: Some(2),
                depth: 3,
                object_ref: ":1.3/button".to_string(),
                role: "button".to_string(),
                name: Some("Run".to_string()),
                description: None,
                child_count: 0,
                bounds: Some(Bounds {
                    x: 10,
                    y: 20,
                    width: 100,
                    height: 40,
                }),
                states: Vec::new(),
                actions: vec![AccessibilityAction {
                    index: 0,
                    name: "Click".to_string(),
                    description: "Clicks the button".to_string(),
                    keybinding: String::new(),
                }],
                value: None,
                text: None,
                supports_editable_text: false,
            },
        ];

        let compacted = compact_accessibility_tree(nodes);

        assert_eq!(compacted.len(), 3);
        assert_eq!(compacted[0].role, "application");
        assert_eq!(compacted[1].role, "frame");
        assert_eq!(compacted[2].role, "button");
        assert_eq!(compacted[2].parent_index, Some(1));
        assert_eq!(compacted[1].child_count, 1);
    }

    #[test]
    fn compact_accessibility_tree_drops_structural_noise() {
        let nodes = vec![
            AccessibilityNode {
                index: 0,
                parent_index: None,
                depth: 0,
                object_ref: ":1.0/root".to_string(),
                role: "application".to_string(),
                name: Some("demo-app".to_string()),
                description: None,
                child_count: 2,
                bounds: None,
                states: Vec::new(),
                actions: Vec::new(),
                value: None,
                text: None,
                supports_editable_text: false,
            },
            AccessibilityNode {
                index: 1,
                parent_index: Some(0),
                depth: 1,
                object_ref: ":1.1/frame".to_string(),
                role: "frame".to_string(),
                name: Some("Demo Frame".to_string()),
                description: None,
                child_count: 2,
                bounds: None,
                states: Vec::new(),
                actions: Vec::new(),
                value: None,
                text: None,
                supports_editable_text: false,
            },
            AccessibilityNode {
                index: 2,
                parent_index: Some(1),
                depth: 2,
                object_ref: ":1.2/tab".to_string(),
                role: "page tab".to_string(),
                name: Some("Hidden".to_string()),
                description: None,
                child_count: 0,
                bounds: None,
                states: Vec::new(),
                actions: Vec::new(),
                value: None,
                text: None,
                supports_editable_text: false,
            },
            AccessibilityNode {
                index: 3,
                parent_index: Some(1),
                depth: 2,
                object_ref: ":1.3/separator".to_string(),
                role: "separator".to_string(),
                name: None,
                description: None,
                child_count: 0,
                bounds: None,
                states: Vec::new(),
                actions: Vec::new(),
                value: None,
                text: None,
                supports_editable_text: false,
            },
        ];

        let compacted = compact_accessibility_tree(nodes);

        assert_eq!(compacted.len(), 3);
        assert_eq!(compacted[2].role, "page tab");
        assert_eq!(compacted[2].name.as_deref(), Some("Hidden"));
    }

    #[test]
    fn kde_clipboard_restore_delay_uses_minimum_for_short_text() {
        assert_eq!(
            kde_clipboard_restore_delay("short"),
            Duration::from_millis(KDE_CLIPBOARD_RESTORE_MIN_DELAY_MS)
        );
    }

    #[test]
    fn kde_clipboard_restore_delay_scales_and_caps_long_text() {
        let scaled_text = "x".repeat(1_000);
        assert_eq!(
            kde_clipboard_restore_delay(&scaled_text),
            Duration::from_millis(4_000)
        );

        let capped_text = "x".repeat(10_000);
        assert_eq!(
            kde_clipboard_restore_delay(&capped_text),
            Duration::from_millis(KDE_CLIPBOARD_RESTORE_MAX_DELAY_MS)
        );
    }

    #[tokio::test]
    async fn kde_clipboard_dbus_operation_times_out_when_pending() {
        let error = kde_clipboard_dbus_operation_with_timeout(
            "proxy creation",
            std::future::pending::<zbus::Result<()>>(),
            Duration::from_millis(1),
        )
        .await
        .unwrap_err();

        assert_eq!(error, "KDE clipboard proxy creation timed out");
    }

    #[test]
    fn cached_element_index_resolves_to_bounds_center() {
        let backend = ComputerUseLinux::default();
        backend.cache_nodes(&[node(
            7,
            Some(Bounds {
                x: 10,
                y: 20,
                width: 100,
                height: 40,
            }),
        )]);

        let point = backend
            .resolve_optional_target_point(None, None, Some(7))
            .unwrap()
            .unwrap();

        assert_eq!(point, (60, 40));
    }

    #[test]
    fn coordinate_target_overrides_cached_element_index() {
        let backend = ComputerUseLinux::default();
        backend.cache_nodes(&[node(
            7,
            Some(Bounds {
                x: 10,
                y: 20,
                width: 100,
                height: 40,
            }),
        )]);

        let point = backend
            .resolve_optional_target_point(Some(200), Some(300), Some(7))
            .unwrap()
            .unwrap();

        assert_eq!(point, (200, 300));
    }

    #[test]
    fn cached_element_index_requires_positive_bounds() {
        let backend = ComputerUseLinux::default();
        backend.cache_nodes(&[node(
            7,
            Some(Bounds {
                x: 10,
                y: 20,
                width: 0,
                height: 40,
            }),
        )]);

        let error = backend
            .resolve_optional_target_point(None, None, Some(7))
            .unwrap_err();

        assert!(error.contains("No clickable bounds cached for element_index 7"));
    }

    #[test]
    fn cached_element_index_ignores_sentinel_bounds() {
        let backend = ComputerUseLinux::default();
        backend.cache_nodes(&[node(
            7,
            Some(Bounds {
                x: i32::MIN,
                y: i32::MIN,
                width: 1,
                height: 1,
            }),
        )]);

        let error = backend
            .resolve_optional_target_point(None, None, Some(7))
            .unwrap_err();

        assert!(error.contains("No clickable bounds cached for element_index 7"));
    }

    #[test]
    fn empty_node_cache_clears_stale_element_index() {
        let backend = ComputerUseLinux::default();
        backend.cache_nodes(&[node(
            7,
            Some(Bounds {
                x: 10,
                y: 20,
                width: 100,
                height: 40,
            }),
        )]);
        backend.cache_nodes(&[]);

        let error = backend
            .resolve_optional_target_point(None, None, Some(7))
            .unwrap_err();

        assert!(error.contains("No clickable bounds cached for element_index 7"));
    }

    #[test]
    fn click_target_falls_back_to_primary_action_without_bounds() {
        let backend = ComputerUseLinux::default();
        backend.cache_nodes(&[node_with_actions(
            7,
            None,
            vec![AccessibilityAction {
                index: 0,
                name: "Click".to_string(),
                description: "Clicks the button".to_string(),
                keybinding: String::new(),
            }],
        )]);

        let target = backend
            .resolve_click_target(&ClickParams {
                element_index: Some(7),
                ..Default::default()
            })
            .unwrap();

        match target {
            ClickTarget::PrimaryAction {
                object_ref,
                action_name,
                action_index,
            } => {
                assert_eq!(object_ref, ":1.7/org/a11y/atspi/accessible/7");
                assert_eq!(action_name.as_deref(), Some("Click"));
                assert_eq!(action_index, 0);
            }
            ClickTarget::Coordinates(_, _) => {
                panic!("expected AT-SPI primary-action fallback")
            }
        }
    }

    #[test]
    fn click_target_falls_back_to_primary_action_with_sentinel_bounds() {
        let backend = ComputerUseLinux::default();
        backend.cache_nodes(&[node_with_actions(
            7,
            Some(Bounds {
                x: i32::MIN,
                y: i32::MIN,
                width: 1,
                height: 1,
            }),
            vec![AccessibilityAction {
                index: 0,
                name: "Click".to_string(),
                description: "Clicks the button".to_string(),
                keybinding: String::new(),
            }],
        )]);

        let target = backend
            .resolve_click_target(&ClickParams {
                element_index: Some(7),
                ..Default::default()
            })
            .unwrap();

        match target {
            ClickTarget::PrimaryAction {
                object_ref,
                action_name,
                action_index,
            } => {
                assert_eq!(object_ref, ":1.7/org/a11y/atspi/accessible/7");
                assert_eq!(action_name.as_deref(), Some("Click"));
                assert_eq!(action_index, 0);
            }
            ClickTarget::Coordinates(_, _) => {
                panic!("expected AT-SPI primary-action fallback")
            }
        }
    }

    #[test]
    fn click_target_requires_bounds_for_non_plain_clicks() {
        let backend = ComputerUseLinux::default();
        backend.cache_nodes(&[node_with_actions(
            7,
            None,
            vec![AccessibilityAction {
                index: 0,
                name: "Click".to_string(),
                description: "Clicks the button".to_string(),
                keybinding: String::new(),
            }],
        )]);

        let error = backend
            .resolve_click_target(&ClickParams {
                element_index: Some(7),
                button: Some("right".to_string()),
                ..Default::default()
            })
            .unwrap_err();

        assert!(error.contains("No clickable bounds cached for element_index 7"));
    }

    #[test]
    fn absolute_mousemove_uses_coordinate_separator() {
        assert_eq!(
            absolute_mousemove_args(200, 300),
            vec![
                "mousemove".to_string(),
                "--absolute".to_string(),
                "--".to_string(),
                "200".to_string(),
                "300".to_string(),
            ]
        );
    }

    #[test]
    fn wheel_mousemove_uses_coordinate_separator_for_negative_values() {
        assert_eq!(
            wheel_mousemove_args(0, -3),
            vec![
                "mousemove".to_string(),
                "--wheel".to_string(),
                "--".to_string(),
                "0".to_string(),
                "-3".to_string(),
            ]
        );
    }

    #[test]
    fn pointer_actions_keep_pixel_coordinates_for_ydotool_absolute_moves() {
        assert_eq!(
            absolute_mousemove_args(1550, 930),
            vec![
                "mousemove".to_string(),
                "--absolute".to_string(),
                "--".to_string(),
                "1550".to_string(),
                "930".to_string(),
            ]
        );
    }

    #[test]
    fn legacy_ydotool_socket_does_not_suppress_portal_fallback() {
        let legacy_ydotool_available = ydotool_backend_available_from(true, false);
        let current_ydotool_available = ydotool_backend_available_from(true, true);

        assert!(should_prefer_portal_backend_by_default(
            true,
            legacy_ydotool_available
        ));
        assert!(!should_prefer_portal_backend_by_default(
            true,
            current_ydotool_available
        ));
        assert!(!should_prefer_portal_backend_by_default(
            false,
            legacy_ydotool_available
        ));
    }

    #[test]
    fn key_sequence_presses_modifiers_around_key() {
        assert_eq!(
            key_sequence("Ctrl+Shift+P"),
            Some(vec![
                "29:1".to_string(),
                "42:1".to_string(),
                "25:1".to_string(),
                "25:0".to_string(),
                "42:0".to_string(),
                "29:0".to_string(),
            ])
        );
    }

    #[test]
    fn key_sequence_presses_bare_modifier() {
        assert_eq!(
            key_sequence("Super"),
            Some(vec!["125:1".to_string(), "125:0".to_string()])
        );
    }

    #[test]
    fn key_sequence_keeps_shortcuts_and_navigation_on_raw_events() {
        assert_eq!(
            key_sequence("Ctrl+L"),
            Some(vec![
                "29:1".to_string(),
                "38:1".to_string(),
                "38:0".to_string(),
                "29:0".to_string(),
            ])
        );
        assert_eq!(
            key_sequence("ArrowLeft"),
            Some(vec!["105:1".to_string(), "105:0".to_string()])
        );
        assert_eq!(
            key_sequence("Escape"),
            Some(vec!["1:1".to_string(), "1:0".to_string()])
        );
        assert_eq!(
            key_sequence("Enter"),
            Some(vec!["28:1".to_string(), "28:0".to_string()])
        );
    }

    #[test]
    fn ydotool_type_timeout_scales_with_text_length() {
        assert_eq!(ydotool_type_timeout("").as_secs(), 10);
        assert_eq!(ydotool_type_timeout("x").as_secs(), 11);
        assert_eq!(ydotool_type_timeout(&"x".repeat(200)).as_secs(), 20);
        assert_eq!(ydotool_type_timeout(&"x".repeat(500)).as_secs(), 35);
    }

    #[tokio::test]
    async fn ydotool_wait_drains_output_before_exit() {
        let mut command = tokio::process::Command::new("sh");
        command.args(["-c", "yes noisy | head -c 200000 >&2; exit 7"]);
        command.stdout(Stdio::piped());
        command.stderr(Stdio::piped());

        let output = wait_for_ydotool_output_with_timeout(
            command.spawn().expect("spawn noisy child"),
            Duration::from_secs(5),
        )
        .await
        .expect("child should exit before timeout");

        assert_eq!(output.status.code(), Some(7));
        assert!(output.stderr.len() >= 100_000);
    }

    #[test]
    fn ydotool_socket_selection_skips_unconnectable_candidates() {
        let dir =
            std::env::temp_dir().join(format!("codex-computer-use-server-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create temp server dir");
        let stale_socket = dir.join("stale.sock");
        std::fs::write(&stale_socket, b"not a socket").expect("write stale socket placeholder");
        let usable_socket = dir.join("usable.sock");
        let listener =
            std::os::unix::net::UnixListener::bind(&usable_socket).expect("bind usable socket");

        let selected = connectable_ydotool_socket_from(vec![stale_socket, usable_socket.clone()])
            .expect("usable socket should be selected");

        assert_eq!(selected, usable_socket);
        drop(listener);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ydotool_socket_selection_accepts_datagram_socket() {
        let dir = std::env::temp_dir().join(format!(
            "codex-computer-use-server-dgram-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create temp server dir");
        let stale_socket = dir.join("stale.sock");
        std::fs::write(&stale_socket, b"not a socket").expect("write stale socket placeholder");
        let usable_socket = dir.join("usable.sock");
        let datagram =
            std::os::unix::net::UnixDatagram::bind(&usable_socket).expect("bind usable socket");

        let selected = connectable_ydotool_socket_from(vec![stale_socket, usable_socket.clone()])
            .expect("usable socket should be selected");

        assert_eq!(selected, usable_socket);
        drop(datagram);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn perform_action_defaults_to_primary_action_index() {
        assert_eq!(requested_or_primary_action(None), "0");
        assert_eq!(requested_or_primary_action(Some("   ")), "0");
        assert_eq!(
            requested_or_primary_action(Some(" show-menu ")),
            "show-menu"
        );
    }

    #[test]
    fn explicit_ydotool_socket_is_used_without_connectability_probe() {
        let _guard = EnvVarGuard::set("YDOTOOL_SOCKET", " /does/not/exist.sock ");

        let selected = explicit_ydotool_socket();

        assert_eq!(selected.as_deref(), Some("/does/not/exist.sock"));
    }

    #[test]
    fn element_identifier_overrides_cached_object_ref() {
        let backend = ComputerUseLinux::default();
        backend.cache_nodes(&[node(7, None)]);

        let object_ref = backend
            .resolve_object_ref(
                Some(7),
                Some(":1.99/org/a11y/atspi/accessible/3"),
                &ElementSelector::default(),
                ElementResolvePurpose::Action,
            )
            .unwrap();

        assert_eq!(object_ref, ":1.99/org/a11y/atspi/accessible/3");
    }

    #[test]
    fn element_index_resolves_to_cached_object_ref() {
        let backend = ComputerUseLinux::default();
        backend.cache_nodes(&[node(7, None)]);

        let object_ref = backend
            .resolve_object_ref(
                Some(7),
                None,
                &ElementSelector::default(),
                ElementResolvePurpose::Action,
            )
            .unwrap();

        assert_eq!(object_ref, ":1.7/org/a11y/atspi/accessible/7");
    }

    #[test]
    fn semantic_selector_resolves_unique_cached_node_by_role_and_name() {
        let backend = ComputerUseLinux::default();
        let mut search_entry = node(7, None);
        search_entry.role = "entry".to_string();
        search_entry.name = Some("Search files".to_string());
        search_entry.supports_editable_text = true;
        backend.cache_nodes(&[search_entry]);

        let object_ref = backend
            .resolve_object_ref(
                None,
                None,
                &ElementSelector {
                    role: Some("entry"),
                    name: Some("search"),
                    ..Default::default()
                },
                ElementResolvePurpose::SetValue,
            )
            .unwrap();

        assert_eq!(object_ref, ":1.7/org/a11y/atspi/accessible/7");
    }

    #[test]
    fn semantic_selector_prefers_actionable_match() {
        let backend = ComputerUseLinux::default();
        let mut label = node(4, None);
        label.role = "label".to_string();
        label.name = Some("Close".to_string());
        let mut button = node_with_actions(7, None, vec![click_action()]);
        button.role = "push button".to_string();
        button.name = Some("Close".to_string());
        backend.cache_nodes(&[label, button]);

        let object_ref = backend
            .resolve_object_ref(
                None,
                None,
                &ElementSelector {
                    name: Some("close"),
                    ..Default::default()
                },
                ElementResolvePurpose::Action,
            )
            .unwrap();

        assert_eq!(object_ref, ":1.7/org/a11y/atspi/accessible/7");
    }

    #[test]
    fn semantic_selector_prefers_editable_match() {
        let backend = ComputerUseLinux::default();
        let mut label = node(4, None);
        label.role = "label".to_string();
        label.name = Some("Search".to_string());
        let mut entry = node(7, None);
        entry.role = "entry".to_string();
        entry.name = Some("Search".to_string());
        entry.supports_editable_text = true;
        backend.cache_nodes(&[label, entry]);

        let object_ref = backend
            .resolve_object_ref(
                None,
                None,
                &ElementSelector {
                    name: Some("search"),
                    ..Default::default()
                },
                ElementResolvePurpose::SetValue,
            )
            .unwrap();

        assert_eq!(object_ref, ":1.7/org/a11y/atspi/accessible/7");
    }

    #[test]
    fn semantic_selector_reports_ambiguous_matches() {
        let backend = ComputerUseLinux::default();
        let mut first = node_with_actions(7, None, vec![click_action()]);
        first.name = Some("Close".to_string());
        let mut second = node_with_actions(9, None, vec![click_action()]);
        second.name = Some("Close".to_string());
        backend.cache_nodes(&[first, second]);

        let error = backend
            .resolve_object_ref(
                None,
                None,
                &ElementSelector {
                    name: Some("close"),
                    ..Default::default()
                },
                ElementResolvePurpose::Action,
            )
            .unwrap_err();

        assert!(error.contains("matched multiple cached nodes"));
        assert!(error.contains("element_index 7"));
        assert!(error.contains("element_index 9"));
    }

    #[test]
    fn semantic_click_selector_resolves_coordinates() {
        let backend = ComputerUseLinux::default();
        let mut button = node_with_actions(
            7,
            Some(Bounds {
                x: 10,
                y: 20,
                width: 100,
                height: 40,
            }),
            vec![click_action()],
        );
        button.name = Some("Run".to_string());
        backend.cache_nodes(&[button]);

        let target = backend
            .resolve_click_target(&ClickParams {
                role: Some("button".to_string()),
                name: Some("run".to_string()),
                ..Default::default()
            })
            .unwrap();

        assert!(matches!(target, ClickTarget::Coordinates(60, 40)));
    }

    #[test]
    fn describe_focused_element_editable() {
        let element = FocusedElementSummary {
            role: "text".to_string(),
            name: Some("Message".to_string()),
            editable: true,
            states: vec!["focused".to_string()],
        };
        let described = describe_focused_element(&element, true);
        assert!(described.contains("editable"));
        assert!(!described.contains("WARNING"));
    }

    #[test]
    fn describe_focused_element_warns_on_non_editable_when_typing() {
        let element = FocusedElementSummary {
            role: "push button".to_string(),
            name: Some("OK".to_string()),
            editable: false,
            states: vec!["focused".to_string()],
        };
        let described = describe_focused_element(&element, true);
        assert!(described.contains("WARNING"));
        assert!(described.contains("not editable"));
    }

    #[test]
    fn describe_focused_element_no_warning_for_press_key() {
        let element = FocusedElementSummary {
            role: "push button".to_string(),
            name: None,
            editable: false,
            states: vec![],
        };
        let described = describe_focused_element(&element, false);
        assert!(!described.contains("WARNING"));
    }

    #[test]
    fn relative_scroll_translates_coordinates() {
        let mut params = ScrollParams {
            element_index: None,
            x: Some(10),
            y: Some(20),
            direction: "down".to_string(),
            pages: None,
            window_id: Some(1),
            pid: None,
            app_id: None,
            wm_class: None,
            window_title: None,
            relative: Some(true),
        };
        let focus = WindowFocusResult {
            requested_window: window_with_bounds(1, 100, 200, 800, 600),
            focused_window: None,
            app_focused: true,
            exact_window_focused: true,
            backend: "test".to_string(),
            note: String::new(),
        };
        apply_window_relative_scroll_coordinates(&mut params, &focus).unwrap();
        assert_eq!(params.x, Some(110));
        assert_eq!(params.y, Some(220));
    }

    #[test]
    fn window_targeted_scroll_defaults_to_window_center() {
        let mut params = ScrollParams {
            element_index: None,
            x: None,
            y: None,
            direction: "down".to_string(),
            pages: None,
            window_id: Some(1),
            pid: None,
            app_id: None,
            wm_class: None,
            window_title: None,
            relative: None,
        };
        let focus = WindowFocusResult {
            requested_window: window_with_bounds(1, 100, 200, 800, 600),
            focused_window: None,
            app_focused: true,
            exact_window_focused: true,
            backend: "test".to_string(),
            note: String::new(),
        };
        apply_window_center_scroll_point(&mut params, &focus).unwrap();
        assert_eq!(params.x, Some(500));
        assert_eq!(params.y, Some(500));
    }

    #[test]
    fn window_targeted_scroll_without_bounds_errors() {
        let mut params = ScrollParams {
            element_index: None,
            x: None,
            y: None,
            direction: "down".to_string(),
            pages: None,
            window_id: Some(1),
            pid: None,
            app_id: None,
            wm_class: None,
            window_title: None,
            relative: None,
        };
        let mut window = window_with_bounds(1, 0, 0, 1, 1);
        window.bounds = None;
        let focus = WindowFocusResult {
            requested_window: window,
            focused_window: None,
            app_focused: true,
            exact_window_focused: true,
            backend: "test".to_string(),
            note: String::new(),
        };
        let error = apply_window_center_scroll_point(&mut params, &focus).unwrap_err();
        assert!(error.contains("pass x/y explicitly"));
        assert_eq!(params.x, None);
        assert_eq!(params.y, None);
    }

    #[test]
    fn relative_scroll_rejects_out_of_bounds() {
        let mut params = ScrollParams {
            element_index: None,
            x: Some(801),
            y: Some(20),
            direction: "down".to_string(),
            pages: None,
            window_id: Some(1),
            pid: None,
            app_id: None,
            wm_class: None,
            window_title: None,
            relative: Some(true),
        };
        let focus = WindowFocusResult {
            requested_window: window_with_bounds(1, 100, 200, 800, 600),
            focused_window: None,
            app_focused: true,
            exact_window_focused: true,
            backend: "test".to_string(),
            note: String::new(),
        };
        assert!(apply_window_relative_scroll_coordinates(&mut params, &focus).is_err());
    }

    fn window_with_bounds(id: u64, x: i32, y: i32, width: u32, height: u32) -> WindowInfo {
        WindowInfo {
            window_id: id,
            title: None,
            app_id: None,
            wm_class: None,
            pid: None,
            bounds: Some(crate::windowing::WindowBounds {
                x: Some(x),
                y: Some(y),
                width,
                height,
            }),
            workspace: None,
            focused: true,
            hidden: false,
            client_type: None,
            backend: "test".to_string(),
            terminal: None,
        }
    }
}
