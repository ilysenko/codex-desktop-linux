// SPDX-License-Identifier: MIT
//! delivery="background" click, drag and scroll through the GNOME virtual pen
//! and touchscreen, on a real GNOME Shell that owns a real seat. Opt-in: see
//! scripts/virtual_pen_test.py.

#[test]
fn gnome_pen_clicks_drags_and_scrolls_without_moving_the_user_pointer() {
    let status = std::process::Command::new("/usr/bin/python3")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/scripts/virtual_pen_test.py"
        ))
        .arg(env!("CARGO_BIN_EXE_codex-computer-use-linux"))
        .status()
        .expect("run the virtual pen fixture");
    assert!(status.success(), "virtual pen fixture failed");
}
