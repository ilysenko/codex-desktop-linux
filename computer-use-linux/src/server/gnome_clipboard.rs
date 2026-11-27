use super::*;
use crate::remote_desktop::{
    is_non_fatal_clipboard_error, press_keycode_chord, start_portal_keyboard_clipboard_session,
    ClipboardSelection, PortalClipboardSession,
};

pub(super) fn atspi_outcome_allows_clipboard_fallback(insert: &Result<FocusedTextInsert>) -> bool {
    matches!(
        insert,
        Ok(FocusedTextInsert::NotEditable(_))
            | Ok(FocusedTextInsert::EditFailed {
                may_have_changed: false,
                ..
            })
            | Err(_)
    )
}

fn validate_gnome_clipboard_paste_shortcut(
    shortcut: KdeClipboardPasteShortcut,
) -> std::result::Result<KdeClipboardPasteShortcut, String> {
    match shortcut {
        KdeClipboardPasteShortcut::ShiftInsert => Err(
            "GNOME portal clipboard paste does not support xterm/rxvt-family terminals: Shift+Insert reads PRIMARY selection, while org.freedesktop.portal.Clipboard only sets CLIPBOARD. No text was pasted."
                .to_string(),
        ),
        supported => Ok(supported),
    }
}

enum ClipboardRestoreOutcome {
    Restored,
    SkippedNotOwner,
    Failed(anyhow::Error),
}

struct GnomeClipboardPasteOutcome {
    result: std::result::Result<String, String>,
    retire_session: bool,
}

fn format_replace_failure(
    replace_error: &anyhow::Error,
    restore: ClipboardRestoreOutcome,
) -> String {
    match restore {
        ClipboardRestoreOutcome::Restored => format!(
            "GNOME clipboard replacement failed ambiguously and the previous contents were restored; text was not replayed: {replace_error:#}"
        ),
        ClipboardRestoreOutcome::SkippedNotOwner => format!(
            "GNOME clipboard replacement failed ambiguously and clipboard ownership was not confirmed, so previous contents were not restored; text was not replayed: {replace_error:#}"
        ),
        ClipboardRestoreOutcome::Failed(restore_error) => format!(
            "GNOME clipboard replacement failed ambiguously; restoring the previous contents also failed, and text was not replayed: {replace_error:#}; restore failed: {restore_error:#}"
        ),
    }
}

fn format_paste_outcome(
    paste_result: std::result::Result<(), String>,
    restore: ClipboardRestoreOutcome,
) -> std::result::Result<String, String> {
    match (paste_result, restore) {
        (Ok(()), ClipboardRestoreOutcome::Restored) => {
            Ok("Action pasted through the GNOME portal clipboard.".to_string())
        }
        (Ok(()), ClipboardRestoreOutcome::SkippedNotOwner) => Ok(
            "Action pasted through the GNOME portal clipboard. A newer clipboard owner was left unchanged."
                .to_string(),
        ),
        (Ok(()), ClipboardRestoreOutcome::Failed(error)) => Ok(format!(
            "Action pasted through the GNOME portal clipboard. Warning: previous clipboard contents could not be restored: {error:#}"
        )),
        (Err(error), ClipboardRestoreOutcome::Restored) => Err(format!(
            "{error}; previous clipboard contents were restored; text was not replayed"
        )),
        (Err(error), ClipboardRestoreOutcome::SkippedNotOwner) => Err(format!(
            "{error}; a newer clipboard owner was left unchanged; text was not replayed"
        )),
        (Err(error), ClipboardRestoreOutcome::Failed(restore_error)) => Err(format!(
            "{error}; previous clipboard contents could not be restored: {restore_error:#}; text was not replayed"
        )),
    }
}

impl ComputerUseLinux {
    pub(super) async fn type_text_through_gnome_clipboard(
        &self,
        text: &str,
        portal_target: &WindowTarget,
        focus: Option<WindowFocusResult>,
        received: Option<serde_json::Value>,
        input_guard: InputOperationGuard,
        refusal: String,
    ) -> ActionOutput {
        let initial_shortcut = kde_clipboard_paste_shortcut(portal_target, focus.as_ref()).await;
        if let Err(message) = validate_gnome_clipboard_paste_shortcut(initial_shortcut) {
            return action_result_with_focus("type_text", Err(message), received, focus);
        }

        // Start the portal session (up to 120s on first-time user consent) and
        // re-verify window focus before entering the cancellation-safe paste
        // task so cancelling the tool call while a consent dialog is open
        // never pastes cancelled text.
        let clipboard_guard = Arc::clone(&self.kde_clipboard_lock).lock_owned().await;
        let mut slot_guard = Arc::clone(&self.portal_clipboard_session)
            .lock_owned()
            .await;
        let need_new = match slot_guard.as_ref() {
            Some(existing) if existing.is_valid() => false,
            Some(_) => {
                if let Some(mut old) = slot_guard.take() {
                    if old.can_keep_alive_as_owner() {
                        old.keep_alive_until_replaced();
                    } else {
                        old.close().await;
                    }
                }
                true
            }
            None => true,
        };
        if need_new {
            let session = match start_portal_keyboard_clipboard_session().await {
                Ok(session) => session,
                Err(error) => {
                    return action_result_with_focus(
                        "type_text",
                        Err(format!(
                            "{refusal} GNOME clipboard paste could not start: {error:#}"
                        )),
                        received,
                        focus,
                    );
                }
            };
            *slot_guard = Some(session);
        }

        // Always re-focus before pasting in case a first-time consent dialog
        // or slow AT-SPI probe allowed focus to move.
        let focus = match self.focus_target_for_input(portal_target).await {
            Ok(refreshed) => refreshed,
            Err(error) => {
                return action_result_with_focus("type_text", Err(error), received, focus);
            }
        };
        let paste_shortcut = match validate_gnome_clipboard_paste_shortcut(
            kde_clipboard_paste_shortcut(portal_target, focus.as_ref()).await,
        ) {
            Ok(shortcut) => shortcut,
            Err(message) => {
                return action_result_with_focus("type_text", Err(message), received, focus);
            }
        };

        let text = text.to_string();
        let portal_operation_guard = input_guard.clone();
        // Once clipboard mutation begins, run through restore even if this
        // call is cancelled, holding input, clipboard, and session locks until
        // restoration completes.
        let (guards, guarded_result) =
            run_cancellation_safe_guarded((input_guard, clipboard_guard), async move {
                let mut slot = slot_guard;
                let session = slot
                    .as_mut()
                    .expect("portal clipboard session was just populated");
                let outcome = run_gnome_clipboard_paste_text(
                    session,
                    &text,
                    paste_shortcut,
                    portal_operation_guard,
                )
                .await;

                if outcome.retire_session || !session.is_valid() {
                    if let Some(mut retired) = slot.take() {
                        // If a failed paste still restored a non-empty clipboard
                        // onto this session, keep serving transfers until another
                        // owner takes over instead of dropping the restored data.
                        if retired.can_keep_alive_as_owner() {
                            retired.keep_alive_until_replaced();
                        } else {
                            retired.close().await;
                        }
                    }
                }

                outcome.result
            })
            .await;
        let Some((_input_guard, _clipboard_guard)) = guards else {
            return action_result_with_focus(
                "type_text",
                Err(guarded_result.unwrap_err()),
                received,
                focus,
            );
        };
        match guarded_result.expect("guarded task returned its guards") {
            Ok(message) => {
                let notes = self.input_landing_notes(focus.as_ref(), true).await;
                with_notes(
                    successful_action_with_focus("type_text", &message, received, focus),
                    notes,
                )
            }
            Err(message) => action_result_with_focus("type_text", Err(message), received, focus),
        }
    }
}

async fn run_gnome_clipboard_paste_text(
    session: &mut PortalClipboardSession,
    text: &str,
    paste_shortcut: KdeClipboardPasteShortcut,
    operation_guard: InputOperationGuard,
) -> GnomeClipboardPasteOutcome {
    let previous = match session.read_current_selection().await {
        Ok(previous) => previous,
        Err(error) => {
            return GnomeClipboardPasteOutcome {
                result: Err(format!(
                    "GNOME clipboard paste was not used; the current clipboard could not be preserved: {error:#}"
                )),
                retire_session: !is_non_fatal_clipboard_error(&error) || !session.is_valid(),
            };
        }
    };
    if let Err(error) = session
        .replace_selection(ClipboardSelection::text(text))
        .await
    {
        let restore = restore_gnome_clipboard(session, &previous).await;
        return GnomeClipboardPasteOutcome {
            result: Err(format_replace_failure(&error, restore)),
            retire_session: true,
        };
    }

    let (modifiers, keycode) = kde_clipboard_paste_chord(paste_shortcut);
    let paste_result = press_keycode_chord(session.keyboard(), modifiers, keycode, operation_guard)
        .await
        .map_err(|error| format!("{error:#}"));

    if paste_result.is_err() {
        // Wait for KeyboardReleaseGuard's release cleanup before touching the
        // clipboard so cleanup can never race with or close a restored owner.
        session.wait_for_keyboard_cleanup().await;
        if session.was_closed_by_keyboard_cleanup() {
            return GnomeClipboardPasteOutcome {
                result: format_paste_outcome(
                    paste_result,
                    ClipboardRestoreOutcome::Failed(anyhow::anyhow!(
                        "portal session closed during stuck-key release cleanup"
                    )),
                ),
                retire_session: true,
            };
        }
    }

    sleep(kde_clipboard_restore_delay(text)).await;

    let restore = restore_gnome_clipboard(session, &previous).await;
    let retire_session = paste_result.is_err()
        || matches!(restore, ClipboardRestoreOutcome::Failed(_))
        || !session.is_valid();
    GnomeClipboardPasteOutcome {
        result: format_paste_outcome(paste_result, restore),
        retire_session,
    }
}

async fn restore_gnome_clipboard(
    session: &mut PortalClipboardSession,
    previous: &ClipboardSelection,
) -> ClipboardRestoreOutcome {
    if session.was_closed_by_keyboard_cleanup() {
        return ClipboardRestoreOutcome::Failed(anyhow::anyhow!(
            "portal session closed during stuck-key release cleanup"
        ));
    }
    session.sync_owner_state().await;
    if !session.selection_still_owned() {
        return ClipboardRestoreOutcome::SkippedNotOwner;
    }
    match session.replace_selection(previous.clone()).await {
        Ok(()) => ClipboardRestoreOutcome::Restored,
        Err(error) => ClipboardRestoreOutcome::Failed(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clipboard_fallback_only_follows_no_edit_atspi_outcomes() {
        assert!(atspi_outcome_allows_clipboard_fallback(&Ok(
            FocusedTextInsert::NotEditable("no AT-SPI window".to_string())
        )));
        assert!(atspi_outcome_allows_clipboard_fallback(&Ok(
            FocusedTextInsert::EditFailed {
                reason: "rejected before mutation".to_string(),
                may_have_changed: false,
            }
        )));
        assert!(atspi_outcome_allows_clipboard_fallback(&Err(
            anyhow::anyhow!("AT-SPI bus unavailable")
        )));

        assert!(!atspi_outcome_allows_clipboard_fallback(&Ok(
            FocusedTextInsert::PasswordField
        )));
        assert!(!atspi_outcome_allows_clipboard_fallback(&Ok(
            FocusedTextInsert::PasswordUnverifiable
        )));
        assert!(!atspi_outcome_allows_clipboard_fallback(&Ok(
            FocusedTextInsert::ReadbackFailed
        )));
        assert!(!atspi_outcome_allows_clipboard_fallback(&Ok(
            FocusedTextInsert::ReadbackTimedOut
        )));
        assert!(!atspi_outcome_allows_clipboard_fallback(&Ok(
            FocusedTextInsert::Mismatch {
                expected_count: 4,
                read_count: 2,
                read_text: "ab".to_string(),
                read_truncated: false,
            }
        )));
        assert!(!atspi_outcome_allows_clipboard_fallback(&Ok(
            FocusedTextInsert::EditFailed {
                reason: "insert timed out".to_string(),
                may_have_changed: true,
            }
        )));
        assert!(!atspi_outcome_allows_clipboard_fallback(&Ok(
            FocusedTextInsert::Verified {
                role: "text".to_string(),
                replaced_selection: false,
                caret_after_text: true,
            }
        )));
    }

    #[test]
    fn gnome_clipboard_rejects_xterm_family_shift_insert() {
        for wm_class in [
            "xterm",
            "UXTerm",
            "rxvt",
            "urxvt",
            "rxvt-unicode",
            "koi8rxterm",
        ] {
            let window = WindowInfo {
                window_id: 1,
                title: Some("user@host".to_string()),
                app_id: None,
                wm_class: Some(wm_class.to_string()),
                pid: Some(100),
                bounds: None,
                workspace: None,
                focused: true,
                hidden: false,
                client_type: None,
                backend: "gnome".to_string(),
                terminal: None,
            };
            let terminal = kde_clipboard_terminal_shortcut(&WindowTarget::default(), Some(&window));
            let shortcut = kde_clipboard_shortcut_for_focus(terminal, None);
            let error = validate_gnome_clipboard_paste_shortcut(shortcut)
                .expect_err("xterm-family terminals must not use Shift+Insert on GNOME portal");
            assert!(error.contains("PRIMARY"), "{wm_class}: {error}");
        }
        assert_eq!(
            validate_gnome_clipboard_paste_shortcut(KdeClipboardPasteShortcut::Standard),
            Ok(KdeClipboardPasteShortcut::Standard)
        );
        assert_eq!(
            validate_gnome_clipboard_paste_shortcut(KdeClipboardPasteShortcut::CtrlShiftV),
            Ok(KdeClipboardPasteShortcut::CtrlShiftV)
        );
    }

    #[test]
    fn restore_messages_distinguish_restored_skipped_and_failed() {
        let replace_err = anyhow::anyhow!("SetSelection timed out");
        let restored = format_replace_failure(&replace_err, ClipboardRestoreOutcome::Restored);
        assert!(
            restored.contains("previous contents were restored"),
            "{restored}"
        );
        let skipped =
            format_replace_failure(&replace_err, ClipboardRestoreOutcome::SkippedNotOwner);
        assert!(
            skipped.contains("previous contents were not restored"),
            "{skipped}"
        );
        assert!(!skipped.contains("contents were restored"), "{skipped}");
        let failed = format_replace_failure(
            &replace_err,
            ClipboardRestoreOutcome::Failed(anyhow::anyhow!("bus closed")),
        );
        assert!(failed.contains("restore failed: bus closed"), "{failed}");

        let paste_err_skipped = format_paste_outcome(
            Err("chord failed".to_string()),
            ClipboardRestoreOutcome::SkippedNotOwner,
        )
        .unwrap_err();
        assert!(
            paste_err_skipped.contains("newer clipboard owner was left unchanged"),
            "{paste_err_skipped}"
        );
        assert!(
            !paste_err_skipped.contains("contents were restored"),
            "{paste_err_skipped}"
        );

        let paste_err_restored = format_paste_outcome(
            Err("chord failed".to_string()),
            ClipboardRestoreOutcome::Restored,
        )
        .unwrap_err();
        assert!(
            paste_err_restored.contains("previous clipboard contents were restored"),
            "{paste_err_restored}"
        );

        let paste_err_failed = format_paste_outcome(
            Err("chord failed".to_string()),
            ClipboardRestoreOutcome::Failed(anyhow::anyhow!(
                "portal session closed during stuck-key release cleanup"
            )),
        )
        .unwrap_err();
        assert!(
            paste_err_failed.contains("previous clipboard contents could not be restored"),
            "{paste_err_failed}"
        );
        assert!(
            paste_err_failed.contains("stuck-key release cleanup"),
            "{paste_err_failed}"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn live_portal_clipboard_paste_restores_rich_clipboard() {
        if std::env::var_os("CUL_LIVE_PORTAL_TEST").is_none() {
            return;
        }
        let expect_empty = std::env::var_os("CUL_LIVE_PORTAL_TEST_EMPTY").is_some();
        let lock = Arc::new(tokio::sync::Mutex::new(()));
        let mut session = start_portal_keyboard_clipboard_session().await.unwrap();
        let first = run_gnome_clipboard_paste_text(
            &mut session,
            "你好！这是一段测试文字。",
            KdeClipboardPasteShortcut::Standard,
            InputOperationGuard::new(Arc::clone(&lock).lock_owned().await),
        )
        .await
        .result
        .unwrap();
        assert!(first.contains("pasted through the GNOME portal clipboard"));

        // Second paste reuses the same portal clipboard session without re-reading its own selection.
        let second = run_gnome_clipboard_paste_text(
            &mut session,
            "第二段",
            KdeClipboardPasteShortcut::Standard,
            InputOperationGuard::new(Arc::clone(&lock).lock_owned().await),
        )
        .await
        .result
        .unwrap();
        assert!(second.contains("pasted through the GNOME portal clipboard"));

        if expect_empty {
            let types = tokio::process::Command::new("wl-paste")
                .arg("--list-types")
                .output()
                .await
                .unwrap();
            assert!(
                !types.status.success() || types.stdout.is_empty(),
                "expected empty clipboard, got: {}",
                String::from_utf8_lossy(&types.stdout)
            );
        } else {
            let restored = tokio::process::Command::new("wl-paste")
                .args(["--no-newline", "--type", "text/html"])
                .output()
                .await
                .unwrap();
            assert!(
                restored.status.success(),
                "wl-paste failed: {}",
                String::from_utf8_lossy(&restored.stderr)
            );
            assert_eq!(restored.stdout, b"<b>previous clipboard</b>");
        }
        session.close().await;
    }
}
