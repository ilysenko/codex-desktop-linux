pub mod backends;
pub mod registry;
pub mod target;
pub mod types;
pub(crate) mod wayland_session;

#[allow(unused_imports)]
pub use registry::{
    COSMIC_WAYLAND_BACKEND, GNOME_SHELL_EXTENSION_BACKEND, GNOME_SHELL_INTROSPECT_BACKEND,
    HYPRLAND_BACKEND, I3_BACKEND, KWIN_BACKEND, LABWC_BACKEND, NIRI_BACKEND, UNAVAILABLE_BACKEND,
    WINDOW_PERMISSION_HINT, WLR_FOREIGN_TOPLEVEL_BACKEND, X11_BACKEND,
};
#[allow(unused_imports)]
pub use target::{
    focus_window_target, focused_window, focused_window_with_backend, list_windows,
    resolve_window_target, window_permission_hint,
};
#[allow(unused_imports)]
pub(crate) use types::app_id_leaf;
#[allow(unused_imports)]
pub use types::{WindowBounds, WindowFocusResult, WindowInfo, WindowTarget};

#[cfg(test)]
mod tests {
    use super::backends::gnome::window_from_properties;
    use super::backends::hyprland::{parse_hyprland_clients, HYPRLAND_BACKEND};
    use super::backends::i3::{
        choose_socket, i3_focus_command, ipc_program_from, parse_i3_tree, parse_xprop_pid,
        windows_needing_xprop_pid, I3_BACKEND, SWAY_CONTAINER_ID_BASE,
    };
    use crate::remote_desktop::LogicalMonitor;

    fn monitor(x: i32, y: i32, width: i32, height: i32, scale: f64) -> LogicalMonitor {
        LogicalMonitor {
            x,
            y,
            width,
            height,
            scale,
        }
    }
    use super::registry::{
        backend_can_exact_focus, descriptors, list_note, COSMIC_WAYLAND_BACKEND,
        GNOME_SHELL_EXTENSION_BACKEND, GNOME_SHELL_INTROSPECT_BACKEND, NIRI_BACKEND,
    };
    use super::target::{ensure_backend_can_focus_target, focused_in};
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
                NIRI_BACKEND,
                I3_BACKEND,
                LABWC_BACKEND,
                WLR_FOREIGN_TOPLEVEL_BACKEND,
                X11_BACKEND,
            ]
        );
    }

    #[test]
    fn niri_backend_can_exact_focus_targets() {
        assert!(backend_can_exact_focus(NIRI_BACKEND));
    }

    #[test]
    fn registry_serves_backend_list_notes() {
        assert!(list_note(COSMIC_WAYLAND_BACKEND).contains("COSMIC Wayland helper"));
        assert!(list_note("missing-backend").contains("GNOME Shell Introspect"));
    }

    #[test]
    fn focused_query_names_the_answering_backend_without_a_focused_window() {
        let mut unfocused = window(1, "Editor", "editor", "editor");
        unfocused.backend = NIRI_BACKEND.to_string();
        let mut focused = unfocused.clone();
        focused.window_id = 2;
        focused.focused = true;

        let (backend, window) = focused_in(vec![unfocused.clone()]);
        assert_eq!(backend, NIRI_BACKEND);
        assert!(window.is_none());

        let (backend, window) = focused_in(vec![unfocused, focused]);
        assert_eq!(backend, NIRI_BACKEND);
        assert_eq!(window.map(|window| window.window_id), Some(2));

        assert_eq!(focused_in(Vec::new()).0, UNAVAILABLE_BACKEND);
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
    fn app_id_alias_matches_reverse_dns_leaf_case_insensitively() {
        let windows = vec![window(1, "KWrite", "org.kde.kwrite", "kwrite")];
        for app_id in ["kwrite", "KWRITE", "org.kde.kwrite"] {
            let matched = resolve_window_target(
                &windows,
                &WindowTarget {
                    app_id: Some(app_id.to_string()),
                    ..Default::default()
                },
            )
            .unwrap();
            assert_eq!(matched.window_id, 1);
        }

        let ghostty = vec![window(
            2,
            "Ghostty",
            "com.mitchellh.ghostty.desktop",
            "Ghostty",
        )];
        assert!(resolve_window_target(
            &ghostty,
            &WindowTarget {
                app_id: Some("ghostty".to_string()),
                ..Default::default()
            },
        )
        .is_ok());
        assert!(resolve_window_target(
            &ghostty,
            &WindowTarget {
                app_id: Some("desktop".to_string()),
                ..Default::default()
            },
        )
        .is_err());
    }

    #[test]
    fn exact_app_id_match_precedes_leaf_aliases() {
        let windows = vec![
            window(1, "Other KWrite", "org.kde.kwrite", "kwrite"),
            window(2, "Exact KWrite", "kwrite", "kwrite"),
        ];

        let matched = resolve_window_target(
            &windows,
            &WindowTarget {
                app_id: Some("kwrite".to_string()),
                ..Default::default()
            },
        )
        .unwrap();

        assert_eq!(matched.window_id, 2);
    }

    #[test]
    fn app_id_alias_rejects_ambiguous_applications() {
        let windows = vec![
            window(1, "KDE KWrite", "org.kde.kwrite", "kwrite"),
            window(2, "Other KWrite", "com.example.kwrite", "kwrite"),
        ];

        let error = resolve_window_target(
            &windows,
            &WindowTarget {
                app_id: Some("kwrite".to_string()),
                ..Default::default()
            },
        )
        .unwrap_err()
        .to_string();

        assert!(error.contains("matched multiple applications"));
        assert!(error.contains("full app_id"));
    }

    #[test]
    fn app_id_alias_allows_multiple_windows_of_one_application() {
        let windows = vec![
            window(1, "First", "org.kde.kwrite", "kwrite"),
            window(2, "Second", "org.kde.kwrite", "kwrite"),
        ];

        let matched = resolve_window_target(
            &windows,
            &WindowTarget {
                app_id: Some("kwrite".to_string()),
                ..Default::default()
            },
        )
        .unwrap();

        assert_eq!(matched.window_id, 1);
    }

    #[test]
    fn window_id_input_rejects_integers_above_javascript_safe_range() {
        // Issue #341: the Firefox ID a JavaScript client received for a KWin
        // window, after rounding. 18446744073709552000 is u64::MAX after
        // JavaScript rounding, which serde_json reads as a float; negative
        // and fractional numbers are not window IDs either.
        for window_id in [
            "17289304398224070000",
            "18446744073709552000",
            "9007199254740992",
            "-1",
            "1.5",
        ] {
            let error =
                serde_json::from_str::<WindowTarget>(&format!(r#"{{"window_id":{window_id}}}"#))
                    .unwrap_err()
                    .to_string();
            assert!(error.contains("0 to 9007199254740991"), "{error}");
            assert!(error.contains("re-run list_windows"), "{error}");
        }

        let max =
            serde_json::from_str::<WindowTarget>(r#"{"window_id":9007199254740991}"#).unwrap();
        assert_eq!(max.window_id, Some(types::MAX_WINDOW_ID));
        let null = serde_json::from_str::<WindowTarget>(r#"{"window_id":null}"#).unwrap();
        assert_eq!(null.window_id, None);
        let missing = serde_json::from_str::<WindowTarget>("{}").unwrap();
        assert_eq!(missing.window_id, None);
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
                      "id": 94163003829504,
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
                      "id": 94163003840832,
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
                      "id": 94163003851200,
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

        let windows = parse_i3_tree(tree_json, None).unwrap();

        assert_eq!(windows.len(), 2);
        assert_eq!(windows[0].window_id, 67108868);
        assert_eq!(windows[0].pid, None);
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
    fn i3_focus_command_uses_decimal_ids() {
        let tree = r#"{
          "id": 1, "type": "root", "nodes": [{
            "id": 4, "type": "workspace", "num": 1, "nodes": [
              {"id": 5, "type": "con", "name": "foot", "app_id": "foot", "pid": 7,
               "shell": "xdg_shell", "window": null},
              {"id": 6, "type": "con", "name": "xterm", "app_id": null, "pid": 8,
               "shell": "xwayland", "window": 4194316}
            ]
          }]
        }"#;
        let windows = parse_i3_tree(tree, None).unwrap();
        // Sway rejects hex ids ("The value for 'id' should be numeric").
        assert_eq!(
            i3_focus_command(windows[0].window_id),
            r#"[id="4194316"] focus"#
        );
        assert_eq!(
            i3_focus_command(windows[1].window_id),
            r#"[con_id="5"] focus"#
        );
    }

    #[test]
    fn sway_container_ids_never_share_a_window_id_with_x11_ids() {
        // Sway container ids and X11 ids count independently, so container
        // 4194316 and X11 window 4194316 can exist at once.
        let tree = r#"{
          "id": 1, "type": "root", "nodes": [{
            "id": 4, "type": "workspace", "num": 1, "nodes": [
              {"id": 4194316, "type": "con", "name": "foot", "app_id": "foot",
               "pid": 7, "shell": "xdg_shell", "window": null},
              {"id": 6, "type": "con", "name": "xterm", "app_id": null, "pid": 8,
               "shell": "xwayland", "window": 4194316}
            ]
          }]
        }"#;
        let windows = parse_i3_tree(tree, None).unwrap();
        let ids = windows.iter().map(|w| w.window_id).collect::<Vec<_>>();
        assert_eq!(ids, vec![4194316, SWAY_CONTAINER_ID_BASE + 4194316]);
        assert_eq!(windows[0].client_type.as_deref(), Some("x11"));
        assert_eq!(windows[1].client_type.as_deref(), Some("wayland"));
        assert!(windows.iter().all(|w| w.window_id <= types::MAX_WINDOW_ID));
        assert_eq!(
            i3_focus_command(windows[1].window_id),
            r#"[con_id="4194316"] focus"#
        );
    }

    #[test]
    fn parses_sway_tree_with_wayland_and_xwayland_windows() {
        // Shaped like `i3-msg -t get_tree` on Sway 1.11 with foot and xterm.
        let tree_json = r#"{
          "id": 1,
          "type": "root",
          "name": "root",
          "window": null,
          "focused": false,
          "nodes": [
            {
              "id": 2,
              "type": "output",
              "name": "__i3",
              "window": null,
              "nodes": [
                {
                  "id": 2147483646,
                  "type": "workspace",
                  "name": "__i3_scratch",
                  "num": null,
                  "window": null,
                  "nodes": [],
                  "floating_nodes": [
                    {
                      "id": 9,
                      "type": "floating_con",
                      "name": "stashed",
                      "pid": 4300,
                      "app_id": "cul-stash",
                      "shell": "xdg_shell",
                      "window": null,
                      "scratchpad_state": "fresh",
                      "visible": false,
                      "nodes": [],
                      "floating_nodes": []
                    }
                  ]
                }
              ]
            },
            {
              "id": 3,
              "type": "output",
              "name": "HEADLESS-1",
              "window": null,
              "nodes": [
                {
                  "id": 4,
                  "type": "workspace",
                  "name": "1",
                  "num": 1,
                  "window": null,
                  "nodes": [
                    {
                      "id": 7,
                      "type": "con",
                      "name": null,
                      "layout": "splitv",
                      "window": null,
                      "nodes": [
                        {
                          "id": 5,
                          "type": "con",
                          "name": "cul-foot",
                          "focused": true,
                          "pid": 4242,
                          "app_id": "cul-foot",
                          "shell": "xdg_shell",
                          "window": null,
                          "scratchpad_state": "none",
                          "visible": true,
                          "rect": {"x": 0, "y": 0, "width": 1280, "height": 360},
                          "nodes": [],
                          "floating_nodes": []
                        },
                        {
                          "id": 6,
                          "type": "con",
                          "name": "xterm",
                          "pid": 4250,
                          "app_id": null,
                          "shell": "xwayland",
                          "window": 4194316,
                          "window_properties": {
                            "class": "XTerm",
                            "instance": "xterm",
                            "title": "xterm"
                          },
                          "visible": true,
                          "rect": {"x": 0, "y": 360, "width": 1280, "height": 360},
                          "nodes": [],
                          "floating_nodes": []
                        }
                      ],
                      "floating_nodes": []
                    }
                  ],
                  "floating_nodes": [
                    {
                      "id": 8,
                      "type": "floating_con",
                      "name": "shown from the scratchpad",
                      "pid": 0,
                      "app_id": null,
                      "shell": "xwayland",
                      "window": 6291458,
                      "window_properties": {"class": "Zenity", "instance": "zenity"},
                      "scratchpad_state": "fresh",
                      "visible": true,
                      "rect": {"x": 100, "y": 100, "width": 400, "height": 300},
                      "nodes": [],
                      "floating_nodes": []
                    }
                  ]
                }
              ]
            }
          ]
        }"#;

        let windows = parse_i3_tree(tree_json, Some(&[monitor(0, 0, 1280, 720, 1.0)])).unwrap();

        assert_eq!(windows.len(), 4);
        let foot = &windows[2];
        assert_eq!(foot.window_id, SWAY_CONTAINER_ID_BASE + 5);
        assert_eq!(foot.title.as_deref(), Some("cul-foot"));
        assert_eq!(foot.app_id.as_deref(), Some("cul-foot"));
        assert_eq!(foot.wm_class, None);
        assert_eq!(foot.pid, Some(4242));
        assert_eq!(foot.workspace, Some(1));
        assert!(foot.focused);
        assert!(!foot.hidden);
        assert_eq!(foot.client_type.as_deref(), Some("wayland"));
        assert_eq!(foot.bounds.as_ref().unwrap().height, 360);
        let stashed = &windows[3];
        assert_eq!(stashed.window_id, SWAY_CONTAINER_ID_BASE + 9);
        assert!(stashed.hidden, "a window under __i3_scratch is not shown");
        let xterm = &windows[0];
        assert_eq!(
            xterm.window_id, 4194316,
            "an Xwayland window keeps its X11 id"
        );
        assert_eq!(xterm.app_id.as_deref(), Some("xterm"));
        assert_eq!(xterm.wm_class.as_deref(), Some("XTerm"));
        assert_eq!(xterm.pid, Some(4250));
        assert!(!xterm.focused);
        assert_eq!(xterm.client_type.as_deref(), Some("x11"));
        assert_eq!(xterm.backend, I3_BACKEND);
        let shown = &windows[1];
        assert_eq!(shown.window_id, 6291458);
        assert_eq!(shown.pid, None, "pid 0 is not a pid");
        assert!(!shown.hidden, "a scratchpad window on a workspace is shown");
        assert_eq!(shown.workspace, Some(1));

        // Only X11 windows without a tree pid are looked up through xprop,
        // by their X11 id.
        let lookups = windows_needing_xprop_pid(&windows);
        assert_eq!(lookups, vec![1]);
        assert_eq!(windows[lookups[0]].window_id, 6291458);
    }

    /// A Sway tree with one Wayland window at layout (1380, 50), 640x360.
    const SWAY_ONE_WINDOW: &str = r#"{
      "id": 1, "type": "root", "nodes": [{
        "id": 4, "type": "workspace", "num": 1, "nodes": [
          {"id": 5, "type": "con", "name": "foot", "app_id": "foot", "pid": 7,
           "shell": "xdg_shell", "window": null,
           "rect": {"x": 1380, "y": 50, "width": 640, "height": 360}}
        ]
      }]
    }"#;

    #[test]
    fn sway_bounds_scale_to_capture_pixels_on_a_uniform_scale() {
        // Two outputs at scale 2, the left one at layout x 1280: the capture
        // starts at layout (1280, 0) and has twice the layout's pixels.
        let outputs = [
            monitor(1280, 0, 1280, 720, 2.0),
            monitor(2560, 0, 1280, 720, 2.0),
        ];
        let windows = parse_i3_tree(SWAY_ONE_WINDOW, Some(&outputs)).unwrap();
        let bounds = windows[0].bounds.as_ref().unwrap();
        assert_eq!((bounds.x, bounds.y), (Some(200), Some(100)));
        assert_eq!((bounds.width, bounds.height), (1280, 720));
    }

    #[test]
    fn sway_bounds_round_outward_and_never_scale_below_one() {
        // Scale 1.25 with a 1-px offset from the origin: edges round outward.
        let windows =
            parse_i3_tree(SWAY_ONE_WINDOW, Some(&[monitor(1379, 49, 1280, 720, 1.25)])).unwrap();
        let bounds = windows[0].bounds.as_ref().unwrap();
        assert_eq!((bounds.x, bounds.y), (Some(1), Some(1)));
        // Right edge (1 + 640) * 1.25 = 801.25 rounds out to 802.
        assert_eq!((bounds.width, bounds.height), (801, 451));
        // grim never captures below scale 1, so scale 0.75 maps as 1.
        let windows =
            parse_i3_tree(SWAY_ONE_WINDOW, Some(&[monitor(0, 0, 1280, 720, 0.75)])).unwrap();
        let bounds = windows[0].bounds.as_ref().unwrap();
        assert_eq!((bounds.x, bounds.width), (Some(1380), 640));
    }

    #[test]
    fn i3_socket_prefers_a_live_env_socket_then_the_runtime_dir() {
        let i3 = Some("/run/i3.sock".to_string());
        let sway = Some("/run/sway.sock".to_string());
        let live = |live: &'static [&'static str]| {
            move |path: &std::path::Path| live.iter().any(|live| path == std::path::Path::new(live))
        };
        let runtime = || Some(std::path::PathBuf::from("/run/user/sway-ipc.1.sock"));
        let none = || None;
        // Both live: I3SOCK wins (a live Sway sets both to one path).
        assert_eq!(
            choose_socket(
                &[i3.clone(), sway.clone()],
                live(&["/run/i3.sock", "/run/sway.sock"]),
                runtime
            ),
            Some("/run/i3.sock".into())
        );
        // A stale I3SOCK does not hide a live SWAYSOCK.
        assert_eq!(
            choose_socket(
                &[i3.clone(), sway.clone()],
                live(&["/run/sway.sock"]),
                runtime
            ),
            Some("/run/sway.sock".into())
        );
        // Neither live: the runtime dir socket, else the first set variable.
        assert_eq!(
            choose_socket(&[i3.clone(), sway.clone()], live(&[]), runtime),
            Some("/run/user/sway-ipc.1.sock".into())
        );
        assert_eq!(
            choose_socket(&[i3.clone(), sway.clone()], live(&[]), none),
            Some("/run/i3.sock".into())
        );
        assert_eq!(choose_socket(&[None, None], live(&[]), none), None);
    }

    #[test]
    fn sway_bounds_are_left_out_when_the_capture_layout_is_unknown() {
        let mixed = [
            monitor(0, 0, 1280, 720, 1.0),
            monitor(1280, 0, 1280, 720, 2.0),
        ];
        let windows = parse_i3_tree(SWAY_ONE_WINDOW, Some(&mixed)).unwrap();
        assert!(
            windows[0].bounds.is_none(),
            "mixed scales have no single pixel space"
        );
        let windows = parse_i3_tree(SWAY_ONE_WINDOW, None).unwrap();
        assert!(windows[0].bounds.is_none(), "no outputs, no mapping");
    }

    #[test]
    fn i3_bounds_stay_x11_pixels() {
        let tree = r#"{
          "id": 1, "type": "root", "nodes": [{
            "id": 4, "type": "workspace", "num": 1, "nodes": [
              {"id": 5, "type": "con", "name": "xterm", "window": 4194316,
               "rect": {"x": 100, "y": 50, "width": 640, "height": 360}}
            ]
          }]
        }"#;
        let windows = parse_i3_tree(tree, Some(&[monitor(0, 0, 1280, 720, 2.0)])).unwrap();
        let bounds = windows[0].bounds.as_ref().unwrap();
        assert_eq!((bounds.x, bounds.width), (Some(100), 640));
    }

    #[test]
    fn i3_backend_uses_swaymsg_only_without_i3_msg() {
        assert_eq!(ipc_program_from(true, true), "i3-msg");
        assert_eq!(ipc_program_from(true, false), "i3-msg");
        assert_eq!(ipc_program_from(false, true), "swaymsg");
        assert_eq!(ipc_program_from(false, false), "i3-msg");
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
