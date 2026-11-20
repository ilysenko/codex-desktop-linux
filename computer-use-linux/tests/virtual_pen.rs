// SPDX-License-Identifier: MIT
//! delivery="background" click, drag and scroll through the virtual pen and
//! touchscreen, on a real GNOME Shell and a real KWin that own a real seat.
//! Opt-in: see scripts/virtual_pen_test.py and
//! scripts/virtual_pen_kwin_test.py.

fn fixture(script: &str) {
    let status = std::process::Command::new("/usr/bin/python3")
        .arg(format!("{}/scripts/{script}", env!("CARGO_MANIFEST_DIR")))
        .arg(env!("CARGO_BIN_EXE_codex-computer-use-linux"))
        .status()
        .expect("run the virtual pen fixture");
    assert!(status.success(), "{script} failed");
}

#[test]
fn gnome_pen_clicks_drags_and_scrolls_without_moving_the_user_pointer() {
    fixture("virtual_pen_test.py");
}

#[test]
fn kwin_pen_clicks_drags_and_scrolls_without_moving_the_user_pointer() {
    fixture("virtual_pen_kwin_test.py");
}
