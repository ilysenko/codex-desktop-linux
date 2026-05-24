mod abs_pointer;
mod appshot;
mod atspi_tree;
mod bare_modifier;
mod cosmic_helper;
mod diagnostics;
mod gnome_extension;
mod identity;
mod remote_desktop;
mod screenshot;
mod server;
mod terminal;
mod windowing;
mod windows;

use anyhow::{Context, Result};

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    diagnostics::hydrate_session_bus_env();

    match std::env::args().nth(1).as_deref() {
        Some("mcp") => server::serve_mcp().await,
        Some("doctor") => {
            let report = diagnostics::doctor_report();
            println!(
                "{}",
                serde_json::to_string_pretty(&report)
                    .context("failed to serialize doctor report")?
            );
            Ok(())
        }
        Some("setup") => {
            let report = diagnostics::setup_accessibility_report();
            println!(
                "{}",
                serde_json::to_string_pretty(&report)
                    .context("failed to serialize setup report")?
            );
            Ok(())
        }
        Some("apps") => {
            let apps = atspi_tree::list_accessible_apps(50).await?;
            println!(
                "{}",
                serde_json::to_string_pretty(&apps)
                    .context("failed to serialize accessible apps")?
            );
            Ok(())
        }
        Some("state") => {
            let app_name_or_bundle_identifier = std::env::args().nth(2);
            let nodes =
                atspi_tree::snapshot_tree(app_name_or_bundle_identifier.as_deref(), None, 120, 12)
                    .await?;
            println!(
                "{}",
                serde_json::to_string_pretty(&nodes)
                    .context("failed to serialize accessibility tree")?
            );
            Ok(())
        }
        // Hidden dev command: empirically test the absolute pointer.
        // `abs-test X Y` moves to logical (X,Y) and left-clicks, sizing the
        // device to the live screenshot dimensions.
        Some("abs-test") => {
            let x: i32 = std::env::args()
                .nth(2)
                .and_then(|s| s.parse().ok())
                .unwrap_or(0);
            let y: i32 = std::env::args()
                .nth(3)
                .and_then(|s| s.parse().ok())
                .unwrap_or(0);
            let cap = screenshot::capture_screenshot().await?;
            eprintln!("desktop logical size: {}x{}", cap.width, cap.height);
            let mut p = abs_pointer::AbsPointer::create(cap.width as i32, cap.height as i32)?;
            p.click(x, y, abs_pointer::PointerButton::Left, 1)?;
            println!(
                "{}",
                serde_json::json!({"ok": true, "x": x, "y": y, "w": cap.width, "h": cap.height})
            );
            Ok(())
        }
        Some("screenshot") => {
            let capture = screenshot::capture_screenshot().await?;
            println!(
                "{}",
                serde_json::to_string_pretty(&serde_json::json!({
                    "mime_type": capture.mime_type,
                    "source": capture.source,
                    "data_url_length": capture.data_url.len()
                }))
                .context("failed to serialize screenshot report")?
            );
            Ok(())
        }
        Some("focused-window") => {
            let report = match windows::focused_window().await {
                Ok(window) => {
                    let backend = window
                        .as_ref()
                        .map(|window| window.backend.as_str())
                        .unwrap_or(windows::GNOME_SHELL_INTROSPECT_BACKEND);
                    serde_json::json!({
                        "backend": backend,
                        "focused_window": window,
                        "error": null,
                        "permissions_hint": null,
                    })
                }
                Err(error) => {
                    let error = format!("{error:#}");
                    serde_json::json!({
                        "backend": "unavailable",
                        "focused_window": null,
                        "error": error,
                        "permissions_hint": windows::window_permission_hint(&error),
                    })
                }
            };
            println!("{}", serde_json::to_string_pretty(&report)?);
            Ok(())
        }
        Some("appshot") => {
            let app_filter = std::env::args().nth(2);
            let capture = appshot::capture_appshot(app_filter.as_deref()).await;
            println!(
                "{}",
                serde_json::to_string_pretty(&capture)
                    .context("failed to serialize AppShot capture")?
            );
            Ok(())
        }
        Some("bare-modifier-monitor") => bare_modifier::run(std::env::args().skip(2)),
        Some("windows") => {
            let report = match windows::list_windows().await {
                Ok(windows) => {
                    let backend = windows
                        .first()
                        .map(|window| window.backend.as_str())
                        .unwrap_or(windows::GNOME_SHELL_INTROSPECT_BACKEND);
                    serde_json::json!({
                        "backend": backend,
                        "windows": windows,
                        "error": null,
                        "permissions_hint": null,
                    })
                }
                Err(error) => {
                    let error = format!("{error:#}");
                    serde_json::json!({
                        "backend": "unavailable",
                        "windows": [],
                        "error": error,
                        "permissions_hint": windows::window_permission_hint(&error),
                    })
                }
            };
            println!("{}", serde_json::to_string_pretty(&report)?);
            Ok(())
        }
        Some("setup-window-targeting") => {
            let report = gnome_extension::setup_window_targeting_report().await;
            println!(
                "{}",
                serde_json::to_string_pretty(&report)
                    .context("failed to serialize window targeting setup report")?
            );
            Ok(())
        }
        Some("--help") | Some("-h") => {
            print_help();
            Ok(())
        }
        Some(command) => {
            anyhow::bail!(
                "unknown command '{command}'. Expected one of: mcp, doctor, setup, apps, state, screenshot, focused-window, appshot, bare-modifier-monitor, windows, setup-window-targeting"
            );
        }
        None => {
            print_help();
            Ok(())
        }
    }
}

fn print_help() {
    println!(
        "codex-computer-use-linux\n\nUsage:\n  codex-computer-use-linux mcp\n  codex-computer-use-linux doctor\n  codex-computer-use-linux setup\n  codex-computer-use-linux setup-window-targeting\n  codex-computer-use-linux apps\n  codex-computer-use-linux state [APP_NAME]\n  codex-computer-use-linux screenshot\n  codex-computer-use-linux focused-window\n  codex-computer-use-linux appshot [APP_NAME|pid:PID]\n  codex-computer-use-linux bare-modifier-monitor --key DoubleShift [--immediate]\n  codex-computer-use-linux windows"
    );
}
