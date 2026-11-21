// SPDX-License-Identifier: MIT
//! delivery="background" through the agent's own seat, on real display
//! servers: an X11 XInput 2 master pair on Xvfb, and a sway transient seat on
//! a headless sway. See scripts/agent_seat_test.py.

fn run(mode: &str) {
    let status = std::process::Command::new("/usr/bin/python3")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/scripts/agent_seat_test.py"
        ))
        .arg(env!("CARGO_BIN_EXE_codex-computer-use-linux"))
        .arg(mode)
        .status()
        .expect("run the agent seat fixture");
    assert!(status.success(), "agent seat fixture {mode} failed");
}

#[test]
fn x11_agent_master_types_and_clicks_without_moving_the_user_focus() {
    run("x11");
}

#[test]
fn sway_transient_seat_types_and_clicks_without_moving_seat0() {
    run("sway");
}
