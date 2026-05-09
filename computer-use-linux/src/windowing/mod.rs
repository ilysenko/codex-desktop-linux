pub mod backends;
pub mod registry;
pub mod target;
pub mod types;

#[allow(unused_imports)]
pub use registry::{
    COSMIC_WAYLAND_BACKEND, GNOME_SHELL_EXTENSION_BACKEND, GNOME_SHELL_INTROSPECT_BACKEND,
    HYPRLAND_BACKEND, I3_BACKEND, KWIN_BACKEND, WINDOW_PERMISSION_HINT,
};
#[allow(unused_imports)]
pub use target::{
    focus_window_target, focused_window, list_windows, resolve_window_target,
    window_permission_hint,
};
#[allow(unused_imports)]
pub use types::{WindowBounds, WindowFocusResult, WindowInfo, WindowTarget};

#[cfg(test)]
mod tests {
    use super::backends::gnome::window_from_properties;
    use super::backends::hyprland::{parse_hyprland_clients, HYPRLAND_BACKEND};
    use super::backends::i3::{parse_i3_tree, parse_xprop_pid, I3_BACKEND};
    use super::backends::kwin::{
        kwin_activate_script_source, kwin_window_id_from_uuid, parse_kwin_windows, KWIN_BACKEND,
    };
    use super::registry::{
        descriptors, list_note, COSMIC_WAYLAND_BACKEND, GNOME_SHELL_EXTENSION_BACKEND,
        GNOME_SHELL_INTROSPECT_BACKEND,
    };
    use super::target::ensure_backend_can_focus_target;
    use super::*;
    use crate::terminal::{TerminalProcess, TerminalWindowContext};
    use std::collections::HashMap;
    use zbus::zvariant::OwnedValue;
    use zbus::zvariant::Value;

    fn owned_value(value: Value<'_>) -> OwnedValue {
        OwnedValue::try_from(value).unwrap()
    }

    #[test]
    fn registry_keeps_stable_backend_order() {
        let ids = descriptors()
            .iter()
            .map(|descriptor| descriptor.id)
            .collect::<Vec<_>>();

        assert_eq!(
            ids,
            vec![
                GNOME_SHELL_EXTENSION_BACKEND,
                GNOME_SHELL_INTROSPECT_BACKEND,
                COSMIC_WAYLAND_BACKEND,
                KWIN_BACKEND,
                HYPRLAND_BACKEND,
                I3_BACKEND,
            ]
        );
    }

    #[test]
    fn registry_serves_backend_list_notes() {
        assert!(list_note(COSMIC_WAYLAND_BACKEND).contains("COSMIC Wayland helper"));
        assert!(list_note("missing-backend").contains("GNOME Shell Introspect"));
    }

    fn window(window_id: u64, title: &str, app_id: &str, wm_class: &str) -> WindowInfo {
        WindowInfo {
            window_id,
            title: Some(title.to_string()),
            app_id: Some(app_id.to_string()),
            wm_class: Some(wm_class.to_string()),
            pid: Some(window_id as u32 + 1000),
            bounds: Some(WindowBounds {
                x: None,
                y: None,
                width: 800,
                height: 600,
            }),
            workspace: None,
            focused: false,
            hidden: false,
            client_type: Some("wayland".to_string()),
            backend: GNOME_SHELL_INTROSPECT_BACKEND.to_string(),
            terminal: None,
        }
    }

    fn terminal_window(
        window_id: u64,
        title: &str,
        tty: &str,
        active_pid: u32,
        active_command: &str,
        active_cwd: &str,
    ) -> WindowInfo {
        let mut window = window(
            window_id,
            title,
            "com.mitchellh.ghostty.desktop",
            "com.mitchellh.ghostty",
        );
        window.terminal = Some(TerminalWindowContext {
            tty: tty.to_string(),
            root_process: TerminalProcess {
                pid: active_pid - 1,
                command_name: "zsh".to_string(),
                command_line: "zsh --login".to_string(),
                cwd: Some("/home/avifenesh".to_string()),
            },
            active_process: Some(TerminalProcess {
                pid: active_pid,
                command_name: active_command.to_string(),
                command_line: format!("{active_command} resume 123"),
                cwd: Some(active_cwd.to_string()),
            }),
            process_count: 2,
            confidence: "heuristic".to_string(),
            match_reason: "test".to_string(),
        });
        window
    }

    #[test]
    fn target_reports_when_any_selector_is_present() {
        assert!(!WindowTarget::default().has_target());
        assert!(WindowTarget {
            title: Some("Ghostty".to_string()),
            ..Default::default()
        }
        .has_target());
        assert!(WindowTarget {
            tty: Some("/dev/pts/1".to_string()),
            ..Default::default()
        }
        .has_target());
    }

    #[test]
    fn title_pid_and_window_id_targets_require_exact_focus() {
        assert!(WindowTarget {
            title: Some("Ghostty".to_string()),
            ..Default::default()
        }
        .requires_exact_focus());
        assert!(WindowTarget {
            pid: Some(123),
            ..Default::default()
        }
        .requires_exact_focus());
        assert!(WindowTarget {
            window_id: Some(123),
            ..Default::default()
        }
        .requires_exact_focus());
        assert!(WindowTarget {
            terminal_command: Some("codex".to_string()),
            ..Default::default()
        }
        .requires_exact_focus());
        assert!(!WindowTarget {
            app_id: Some("com.mitchellh.ghostty.desktop".to_string()),
            ..Default::default()
        }
        .requires_exact_focus());
    }

    #[test]
    fn exact_targets_require_extension_activation_backend() {
        let window = window(
            2,
            "Ghostty",
            "com.mitchellh.ghostty.desktop",
            "com.mitchellh.ghostty",
        );

        let error = ensure_backend_can_focus_target(
            &WindowTarget {
                terminal_command: Some("codex".to_string()),
                ..Default::default()
            },
            &window,
        )
        .unwrap_err()
        .to_string();

        assert!(error.contains("Exact window targeting requires"));
    }

    #[test]
    fn app_targets_can_use_app_level_focus_backend() {
        let window = window(
            2,
            "Ghostty",
            "com.mitchellh.ghostty.desktop",
            "com.mitchellh.ghostty",
        );

        ensure_backend_can_focus_target(
            &WindowTarget {
                app_id: Some("com.mitchellh.ghostty.desktop".to_string()),
                ..Default::default()
            },
            &window,
        )
        .unwrap();
    }

    #[test]
    fn cosmic_backend_can_exact_focus_targets() {
        let mut window = window(2, "Codex", "codex-desktop", "codex-desktop");
        window.backend = COSMIC_WAYLAND_BACKEND.to_string();

        ensure_backend_can_focus_target(
            &WindowTarget {
                title: Some("Codex".to_string()),
                ..Default::default()
            },
            &window,
        )
        .unwrap();
    }

    #[test]
    fn i3_backend_can_exact_focus_targets() {
        let mut window = window(2, "Codex", "codex-desktop", "codex-desktop");
        window.backend = I3_BACKEND.to_string();

        ensure_backend_can_focus_target(
            &WindowTarget {
                title: Some("Codex".to_string()),
                ..Default::default()
            },
            &window,
        )
        .unwrap();
    }

    #[test]
    fn resolves_target_by_window_id_first() {
        let windows = vec![
            window(1, "Codex", "codex.desktop", "Codex"),
            window(2, "Ghostty", "com.mitchellh.ghostty.desktop", "Ghostty"),
        ];

        let matched = resolve_window_target(
            &windows,
            &WindowTarget {
                window_id: Some(2),
                title: Some("Codex".to_string()),
                ..Default::default()
            },
        )
        .unwrap();

        assert_eq!(matched.window_id, 2);
    }

    #[test]
    fn pid_target_reports_ambiguous_matches() {
        let mut first = window(1, "Ghostty One", "com.mitchellh.ghostty.desktop", "Ghostty");
        let mut second = window(2, "Ghostty Two", "com.mitchellh.ghostty.desktop", "Ghostty");
        first.pid = Some(300);
        second.pid = Some(300);

        let error = resolve_window_target(
            &[first, second],
            &WindowTarget {
                pid: Some(300),
                ..Default::default()
            },
        )
        .unwrap_err()
        .to_string();

        assert!(error.contains("pid 300 matched multiple windows"));
    }

    #[test]
    fn resolves_target_by_title_substring_case_insensitive() {
        let windows = vec![window(
            2,
            "avifenesh@host: ~/projects/codex",
            "com.mitchellh.ghostty.desktop",
            "Ghostty",
        )];

        let matched = resolve_window_target(
            &windows,
            &WindowTarget {
                title: Some("PROJECTS/CODEX".to_string()),
                ..Default::default()
            },
        )
        .unwrap();

        assert_eq!(matched.window_id, 2);
    }

    #[test]
    fn resolves_terminal_target_by_tty() {
        let windows = vec![
            terminal_window(1, "Claude", "/dev/pts/0", 101, "claude", "/tmp"),
            terminal_window(2, "Codex", "/dev/pts/1", 201, "codex", "/home/avifenesh"),
        ];

        let matched = resolve_window_target(
            &windows,
            &WindowTarget {
                tty: Some("pts/1".to_string()),
                ..Default::default()
            },
        )
        .unwrap();

        assert_eq!(matched.window_id, 2);
    }

    #[test]
    fn resolves_terminal_target_by_active_command() {
        let windows = vec![
            terminal_window(1, "Claude", "/dev/pts/0", 101, "claude", "/tmp"),
            terminal_window(2, "Codex", "/dev/pts/1", 201, "codex", "/home/avifenesh"),
        ];

        let matched = resolve_window_target(
            &windows,
            &WindowTarget {
                terminal_command: Some("codex resume".to_string()),
                ..Default::default()
            },
        )
        .unwrap();

        assert_eq!(matched.window_id, 2);
    }

    #[test]
    fn resolves_terminal_target_by_cwd_suffix() {
        let windows = vec![
            terminal_window(1, "Home", "/dev/pts/0", 101, "zsh", "/home/avifenesh"),
            terminal_window(
                2,
                "Project",
                "/dev/pts/1",
                201,
                "codex",
                "/home/avifenesh/projects/codex-desktop-linux",
            ),
        ];

        let matched = resolve_window_target(
            &windows,
            &WindowTarget {
                terminal_cwd: Some("projects/codex-desktop-linux".to_string()),
                ..Default::default()
            },
        )
        .unwrap();

        assert_eq!(matched.window_id, 2);
    }

    #[test]
    fn terminal_cwd_does_not_match_arbitrary_substrings() {
        let windows = vec![terminal_window(
            1,
            "Project",
            "/dev/pts/1",
            201,
            "codex",
            "/home/avifenesh/projects/codex-desktop-linux",
        )];

        let error = resolve_window_target(
            &windows,
            &WindowTarget {
                terminal_cwd: Some("fenesh/proj".to_string()),
                ..Default::default()
            },
        )
        .unwrap_err()
        .to_string();

        assert!(error.contains("No window matched terminal target"));
    }

    #[test]
    fn terminal_target_reports_ambiguous_matches() {
        let windows = vec![
            terminal_window(1, "One", "/dev/pts/0", 101, "zsh", "/home/avifenesh"),
            terminal_window(2, "Two", "/dev/pts/1", 201, "zsh", "/home/avifenesh"),
        ];

        let error = resolve_window_target(
            &windows,
            &WindowTarget {
                terminal_command: Some("zsh".to_string()),
                ..Default::default()
            },
        )
        .unwrap_err()
        .to_string();

        assert!(error.contains("matched multiple windows"));
    }

    #[test]
    fn maps_access_denied_errors_to_permission_hint() {
        let hint = window_permission_hint(
            "GDBus.Error:org.freedesktop.DBus.Error.AccessDenied: GetWindows is not allowed",
        );

        assert_eq!(hint.as_deref(), Some(WINDOW_PERMISSION_HINT));
    }

    #[test]
    fn parses_hyprland_clients_as_window_info() {
        let clients_json = r#"[
          {
            "address": "0x559952b6db60",
            "mapped": true,
            "hidden": false,
            "at": [10, 48],
            "size": [1900, 1022],
            "workspace": {"id": 2, "name": "2"},
            "class": "brave-browser",
            "title": "Repo - Brave",
            "pid": 24134,
            "xwayland": false,
            "focusHistoryID": 1
          },
          {
            "address": "0x559952be43d0",
            "mapped": true,
            "hidden": false,
            "at": [10, 48],
            "size": [1900, 1022],
            "workspace": {"id": 1, "name": "1"},
            "class": "codex-desktop",
            "title": "Codex",
            "pid": 68986,
            "xwayland": false,
            "focusHistoryID": 0
          },
          {
            "address": "0x559952c99aa0",
            "mapped": true,
            "hidden": false,
            "at": [0, 0],
            "size": [400, 300],
            "workspace": {"id": 3, "name": "3"},
            "class": "transient",
            "title": "Transient",
            "pid": -1,
            "xwayland": false,
            "focusHistoryID": 2
          }
        ]"#;

        let windows = parse_hyprland_clients(clients_json).unwrap();

        assert_eq!(windows.len(), 3);
        assert_eq!(windows[0].window_id, 0x559952b6db60);
        assert_eq!(windows[0].app_id.as_deref(), Some("brave-browser"));
        assert_eq!(windows[0].wm_class.as_deref(), Some("brave-browser"));
        assert_eq!(windows[0].title.as_deref(), Some("Repo - Brave"));
        assert_eq!(windows[0].pid, Some(24134));
        assert_eq!(windows[0].bounds.as_ref().unwrap().x, Some(10));
        assert_eq!(windows[0].bounds.as_ref().unwrap().height, 1022);
        assert_eq!(windows[0].workspace, Some(2));
        assert!(!windows[0].focused);
        assert_eq!(windows[0].client_type.as_deref(), Some("wayland"));
        assert_eq!(windows[0].backend, HYPRLAND_BACKEND);
        assert!(windows[1].focused);
        assert_eq!(windows[2].pid, None);
    }

    #[test]
    fn parses_i3_tree_as_window_info() {
        let tree_json = r#"{
          "type": "root",
          "focused": false,
          "window": null,
          "nodes": [
            {
              "type": "output",
              "focused": false,
              "window": null,
              "nodes": [
                {
                  "type": "dockarea",
                  "focused": false,
                  "window": null,
                  "nodes": [
                    {
                      "type": "con",
                      "focused": false,
                      "window": 25165826,
                      "window_type": "unknown",
                      "name": "polybar",
                      "window_properties": {
                        "class": "Polybar",
                        "instance": "polybar",
                        "title": "polybar"
                      },
                      "rect": {"x": 0, "y": 0, "width": 2560, "height": 40}
                    }
                  ]
                },
                {
                  "type": "workspace",
                  "num": 2,
                  "focused": false,
                  "window": null,
                  "nodes": [
                    {
                      "type": "con",
                      "focused": true,
                      "window": 67108868,
                      "window_type": "normal",
                      "name": "Codex",
                      "window_properties": {
                        "class": "Codex",
                        "instance": "codex",
                        "title": "Codex"
                      },
                      "rect": {"x": 0, "y": 782, "width": 2560, "height": 1440}
                    }
                  ],
                  "floating_nodes": [
                    {
                      "type": "con",
                      "focused": false,
                      "window": 73400323,
                      "window_type": "dialog",
                      "name": "Save File",
                      "window_properties": {
                        "class": "zenity",
                        "instance": "zenity",
                        "title": "Save File"
                      },
                      "geometry": {"x": 100, "y": 120, "width": 600, "height": 400}
                    }
                  ]
                }
              ]
            }
          ]
        }"#;

        let windows = parse_i3_tree(tree_json).unwrap();

        assert_eq!(windows.len(), 2);
        assert_eq!(windows[0].window_id, 67108868);
        assert_eq!(windows[0].title.as_deref(), Some("Codex"));
        assert_eq!(windows[0].app_id.as_deref(), Some("codex"));
        assert_eq!(windows[0].wm_class.as_deref(), Some("Codex"));
        assert_eq!(windows[0].workspace, Some(2));
        assert!(windows[0].focused);
        assert_eq!(windows[0].client_type.as_deref(), Some("x11"));
        assert_eq!(windows[0].backend, I3_BACKEND);
        assert_eq!(windows[0].bounds.as_ref().unwrap().x, Some(0));
        assert_eq!(windows[1].title.as_deref(), Some("Save File"));
        assert_eq!(windows[1].bounds.as_ref().unwrap().width, 600);
    }

    #[test]
    fn parses_xprop_pid() {
        assert_eq!(
            parse_xprop_pid("_NET_WM_PID(CARDINAL) = 19313\n"),
            Some(19313)
        );
        assert_eq!(parse_xprop_pid("_NET_WM_PID:  not found.\n"), None);
    }

    #[test]
    fn parses_kwin_windows_as_window_info() {
        let uuid = "b4dfacf8-a559-43c9-8b1f-ecd5cfd78359";
        let windows_json = r#"{
          "backend": "kwin",
          "windows": [
            {
              "uuid": "{b4dfacf8-a559-43c9-8b1f-ecd5cfd78359}",
              "caption": "Codex",
              "desktopFile": "codex-desktop",
              "resourceClass": "codex-desktop",
              "resourceName": "codex",
              "pid": 68986,
              "x": 10,
              "y": 48,
              "width": 1200,
              "height": 800,
              "workspace": 1,
              "minimized": false,
              "active": true,
              "clientType": "wayland",
              "normalWindow": true,
              "desktopWindow": false,
              "dock": false
            },
            {
              "uuid": "{11111111-2222-3333-4444-555555555555}",
              "caption": "Desktop",
              "desktopWindow": true
            }
          ]
        }"#;

        let windows = parse_kwin_windows(windows_json).unwrap();

        assert_eq!(windows.len(), 1);
        assert_eq!(windows[0].window_id, kwin_window_id_from_uuid(uuid));
        assert_eq!(windows[0].title.as_deref(), Some("Codex"));
        assert_eq!(windows[0].app_id.as_deref(), Some("codex-desktop"));
        assert_eq!(windows[0].wm_class.as_deref(), Some("codex-desktop"));
        assert_eq!(windows[0].pid, Some(68986));
        assert_eq!(windows[0].bounds.as_ref().unwrap().x, Some(10));
        assert_eq!(windows[0].bounds.as_ref().unwrap().height, 800);
        assert_eq!(windows[0].workspace, Some(1));
        assert!(windows[0].focused);
        assert!(!windows[0].hidden);
        assert_eq!(windows[0].client_type.as_deref(), Some("wayland"));
        assert_eq!(windows[0].backend, KWIN_BACKEND);
    }

    #[test]
    fn kwin_window_ids_are_stable_across_uuid_formats() {
        let bare = "b4dfacf8-a559-43c9-8b1f-ecd5cfd78359";
        let braced_upper = "{B4DFACF8-A559-43C9-8B1F-ECD5CFD78359}";

        assert_eq!(
            kwin_window_id_from_uuid(bare),
            kwin_window_id_from_uuid(braced_upper)
        );
    }

    #[test]
    fn kwin_activation_script_focuses_window_directly() {
        let script = kwin_activate_script_source(
            ":1.234",
            "/com/openai/Codex/KWinWindowQuery/test",
            "codex_kwin_window_query_test",
            "{B4DFACF8-A559-43C9-8B1F-ECD5CFD78359}",
        )
        .unwrap();

        assert!(script.contains(r#"var targetUuid = "b4dfacf8-a559-43c9-8b1f-ecd5cfd78359";"#));
        assert!(script.contains("targetWindow.minimized = false;"));
        assert!(script.contains("workspace.activeWindow = targetWindow;"));
        assert!(script.contains(r#""ReceiveResult""#));
        assert!(!script.contains("WindowsRunner"));
    }

    #[test]
    fn hyprland_backend_can_exact_focus_targets() {
        let mut window = window(2, "Codex", "codex-desktop", "codex-desktop");
        window.backend = HYPRLAND_BACKEND.to_string();

        ensure_backend_can_focus_target(
            &WindowTarget {
                title: Some("Codex".to_string()),
                ..Default::default()
            },
            &window,
        )
        .unwrap();
    }

    #[test]
    fn kwin_backend_can_exact_focus_targets() {
        let mut window = window(2, "Codex", "codex-desktop", "codex-desktop");
        window.backend = KWIN_BACKEND.to_string();

        ensure_backend_can_focus_target(
            &WindowTarget {
                title: Some("Codex".to_string()),
                ..Default::default()
            },
            &window,
        )
        .unwrap();
    }

    #[test]
    fn extracts_known_window_properties() {
        let properties = HashMap::from([
            ("title".to_string(), owned_value(Value::from("Ghostty"))),
            (
                "app-id".to_string(),
                owned_value(Value::from("com.mitchellh.ghostty.desktop")),
            ),
            ("wm-class".to_string(), owned_value(Value::from("Ghostty"))),
            ("client-type".to_string(), owned_value(Value::from(0_u32))),
            ("is-hidden".to_string(), owned_value(Value::from(false))),
            ("has-focus".to_string(), owned_value(Value::from(true))),
            ("width".to_string(), owned_value(Value::from(1200_u32))),
            ("height".to_string(), owned_value(Value::from(800_u32))),
        ]);

        let info = window_from_properties(42, &properties);

        assert_eq!(info.window_id, 42);
        assert_eq!(info.title.as_deref(), Some("Ghostty"));
        assert!(info.focused);
        assert_eq!(info.client_type.as_deref(), Some("wayland"));
        assert_eq!(info.bounds.unwrap().width, 1200);
    }
}
