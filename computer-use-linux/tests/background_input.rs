// SPDX-License-Identifier: MIT
//! delivery="background" for type_text and press_key, against real fixtures:
//! a GTK app over AT-SPI, tmux and GNU screen, and a headless Chrome over
//! DevTools. See scripts/background_input_test.py.

fn run(mode: &str) {
    let status = std::process::Command::new("/usr/bin/python3")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/scripts/background_input_test.py"
        ))
        .arg(env!("CARGO_BIN_EXE_codex-computer-use-linux"))
        .arg(mode)
        .status()
        .expect("run the background input fixture");
    assert!(status.success(), "background input fixture {mode} failed");
}

#[test]
fn background_text_and_keys_reach_an_atspi_element_without_focus() {
    run("atspi");
}

#[test]
fn background_text_and_keys_reach_a_terminal_program_by_its_tty() {
    run("terminal");
}

#[test]
fn background_text_and_keys_reach_a_browser_tab_over_devtools() {
    run("devtools");
}
