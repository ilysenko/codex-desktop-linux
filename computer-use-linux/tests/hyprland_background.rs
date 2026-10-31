// SPDX-License-Identifier: MIT

#[test]
fn hyprland_background_mode_never_focuses_the_target() {
    let status = std::process::Command::new("/usr/bin/python3")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/scripts/hyprland_background_test.py"
        ))
        .arg(env!("CARGO_BIN_EXE_codex-computer-use-linux"))
        .status()
        .expect("run private Hyprland background fixture");
    assert!(status.success());
}
