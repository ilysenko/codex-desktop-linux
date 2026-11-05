//! Every subcommand prints its help on `-h`/`--help` and refuses unknown
//! flags before it touches the desktop. The embedded Chrome native-messaging
//! host validates its command line the same way before it binds its socket.
//!
//! Each run gets a private sandbox: recording stand-ins for the desktop
//! commands first on PATH, a D-Bus address with no bus behind it, display and
//! compositor variables that point nowhere, and private HOME and XDG
//! directories. A call to any stand-in, or a file written in the sandbox,
//! counts as a side effect.
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
    time::{Duration, Instant},
};

// Places the Chrome host's socket directory under the Unix path limit.
#[allow(dead_code)]
#[path = "../src/test_sockets.rs"]
mod test_sockets;

const BINARY: &str = env!("CARGO_BIN_EXE_codex-computer-use-linux");
const CHROME_HOST: &str = env!("CARGO_BIN_EXE_codex-chrome-extension-host");
/// The origin Chrome passes a native-messaging host on Linux.
const EXTENSION_ORIGIN: &str = "chrome-extension://abcdefghijklmnopabcdefghijklmnop/";
const SUBCOMMANDS: &[&str] = &[
    "mcp",
    "doctor",
    "setup",
    "guard-accessibility",
    "setup-window-targeting",
    "apps",
    "state",
    "screenshot",
    "windows",
    "abs-test",
];
const RECORDED_COMMANDS: &[&str] = &[
    "busctl",
    "cosmic-screenshot",
    "dbus-send",
    "dconf",
    "gdbus",
    "gnome-extensions",
    "gnome-screenshot",
    "grim",
    "gsettings",
    "hyprctl",
    "i3-msg",
    "import",
    "kdotool",
    "kreadconfig5",
    "kreadconfig6",
    "kwriteconfig5",
    "kwriteconfig6",
    "niri",
    "notify-send",
    "qdbus",
    "qdbus6",
    "spectacle",
    "swaymsg",
    "systemctl",
    "wmctrl",
    "wtype",
    "xdotool",
    "xdpyinfo",
    "xprop",
    "xwd",
    "xwininfo",
    "ydotool",
    "ydotoold",
];
// The old CLI ran `guard-accessibility --help` as the guard, which never
// exits. A run that outlives this is killed and fails the test.
const DEADLINE: Duration = Duration::from_secs(20);
const SANDBOX_DIRS: &[&str] = &["home", "config", "data", "cache", "state", "runtime"];

struct Sandbox {
    root: PathBuf,
    /// The Chrome host's socket directory. Creating it counts as a side
    /// effect.
    chrome_socket_dir: PathBuf,
}

impl Sandbox {
    fn new(label: &str) -> Self {
        let root = Path::new(env!("CARGO_TARGET_TMPDIR"))
            .join(format!("cli-flags-{label}-{}", getrandom::u64().unwrap()));
        let bin = root.join("bin");
        fs::create_dir_all(&bin).unwrap();
        for dir in SANDBOX_DIRS {
            fs::create_dir_all(root.join(dir)).unwrap();
        }
        fs::set_permissions(root.join("runtime"), fs::Permissions::from_mode(0o700)).unwrap();
        let log = root.join("calls.log");
        for name in RECORDED_COMMANDS {
            let script = bin.join(name);
            fs::write(
                &script,
                format!(
                    "#!/bin/sh\nprintf '%s %s\\n' \"${{0##*/}}\" \"$*\" >> '{}'\nexit 1\n",
                    log.display()
                ),
            )
            .unwrap();
            fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
        }
        Self {
            chrome_socket_dir: root.join("runtime").join("browser-use"),
            root,
        }
    }

    /// A sandbox for the Chrome host. The sandbox path can be too long for a
    /// socket, so its socket directory goes where the fixture helper puts it.
    fn for_chrome_host(label: &str) -> Self {
        let mut sandbox = Self::new(label);
        sandbox.chrome_socket_dir = test_sockets::socket_fixture(
            &format!("cul-chrome-host-{}", getrandom::u64().unwrap()),
            "extension-4194304-1793849097374809876.sock",
        );
        sandbox
    }

    /// The run's output, or why it failed to finish.
    fn run(&self, arguments: &[&str]) -> Result<Output, String> {
        self.run_binary(BINARY, arguments)
    }

    fn run_binary(&self, binary: &str, arguments: &[&str]) -> Result<Output, String> {
        let dir = |name: &str| self.root.join(name);
        let mut child = Command::new(binary)
            .args(arguments)
            .env_clear()
            .env("PATH", dir("bin"))
            .env("HOME", dir("home"))
            .env("XDG_CONFIG_HOME", dir("config"))
            .env("XDG_DATA_HOME", dir("data"))
            .env("XDG_CACHE_HOME", dir("cache"))
            .env("XDG_STATE_HOME", dir("state"))
            .env("XDG_RUNTIME_DIR", dir("runtime"))
            .env("GSETTINGS_BACKEND", "memory")
            // Every key session discovery fills when it is empty, so nothing
            // is borrowed from the desktop session running the tests.
            .env(
                "DBUS_SESSION_BUS_ADDRESS",
                format!("unix:path={}", dir("no-bus").display()),
            )
            .env("DISPLAY", ":4271")
            .env("WAYLAND_DISPLAY", "cul-test-no-wayland")
            .env("XAUTHORITY", dir("no-xauthority"))
            .env("XDG_SESSION_TYPE", "wayland")
            .env("XDG_CURRENT_DESKTOP", "GNOME")
            .env("XDG_SESSION_DESKTOP", "gnome")
            .env("DESKTOP_SESSION", "gnome")
            .env("HYPRLAND_INSTANCE_SIGNATURE", "cul-test-no-hyprland")
            .env("NIRI_SOCKET", dir("no-niri"))
            .env("YDOTOOL_SOCKET", dir("no-ydotool"))
            .env("CODEX_BROWSER_USE_SOCKET_DIR", &self.chrome_socket_dir)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let started = Instant::now();
        while child.try_wait().unwrap().is_none() {
            if started.elapsed() > DEADLINE {
                child.kill().unwrap();
                let output = child.wait_with_output().unwrap();
                return Err(format!(
                    "{arguments:?} still ran after {DEADLINE:?}; side effects: {:?}; stderr: {}",
                    self.side_effects(),
                    String::from_utf8_lossy(&output.stderr)
                ));
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        Ok(child.wait_with_output().unwrap())
    }

    /// Commands the run started and files it wrote, if any.
    fn side_effects(&self) -> Vec<String> {
        let mut effects: Vec<String> = fs::read_to_string(self.root.join("calls.log"))
            .unwrap_or_default()
            .lines()
            .map(|line| format!("ran {line}"))
            .collect();
        for dir in SANDBOX_DIRS {
            let mut pending = vec![self.root.join(dir)];
            while let Some(path) = pending.pop() {
                for entry in fs::read_dir(&path).unwrap() {
                    let entry = entry.unwrap().path();
                    if entry.is_dir() {
                        pending.push(entry.clone());
                    }
                    effects.push(format!(
                        "wrote {}",
                        entry.strip_prefix(&self.root).unwrap().display()
                    ));
                }
            }
        }
        if !self.chrome_socket_dir.starts_with(&self.root) && self.chrome_socket_dir.exists() {
            effects.push(format!("created {}", self.chrome_socket_dir.display()));
        }
        effects
    }
}

impl Drop for Sandbox {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
        let _ = fs::remove_dir_all(&self.chrome_socket_dir);
    }
}

/// True when a usage line of `text` is `codex-computer-use-linux NAME`, alone
/// or followed by its arguments and summary. A substring match would let
/// `setup-window-targeting` stand in for `setup`.
fn has_usage_line(text: &str, name: &str) -> bool {
    let usage = format!("codex-computer-use-linux {name}");
    text.lines()
        .map(str::trim)
        .any(|line| line == usage || line.starts_with(&format!("{usage} ")))
}

fn describe(arguments: &[&str], output: &Output, effects: &[String]) -> String {
    format!(
        "{arguments:?}: {}\nside effects: {effects:?}\nstdout: {}\nstderr: {}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
}

#[test]
fn every_subcommand_prints_help_without_side_effects() {
    let mut failures = Vec::new();
    for subcommand in SUBCOMMANDS {
        for flag in ["--help", "-h"] {
            let sandbox = Sandbox::new("help");
            let arguments = [*subcommand, flag];
            let output = match sandbox.run(&arguments) {
                Ok(output) => output,
                Err(failure) => {
                    failures.push(failure);
                    continue;
                }
            };
            let effects = sandbox.side_effects();
            let stdout = String::from_utf8_lossy(&output.stdout);
            if output.status.code() != Some(0)
                || !effects.is_empty()
                || !stdout.contains("Usage:")
                || !has_usage_line(&stdout, subcommand)
            {
                failures.push(describe(&arguments, &output, &effects));
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n\n"));
}

#[test]
fn every_subcommand_refuses_unknown_flags_without_side_effects() {
    let mut failures = Vec::new();
    for subcommand in SUBCOMMANDS {
        let sandbox = Sandbox::new("flag");
        let arguments = [*subcommand, "--cul-no-such-flag"];
        let output = match sandbox.run(&arguments) {
            Ok(output) => output,
            Err(failure) => {
                failures.push(failure);
                continue;
            }
        };
        let effects = sandbox.side_effects();
        let stderr = String::from_utf8_lossy(&output.stderr);
        if output.status.code() != Some(2)
            || !effects.is_empty()
            || !stderr.contains("unknown option '--cul-no-such-flag'")
        {
            failures.push(describe(&arguments, &output, &effects));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n\n"));
}

#[test]
fn top_level_help_lists_every_command_and_bad_lines_exit_2() {
    for arguments in [&[][..], &["--help"][..], &["-h"][..]] {
        let sandbox = Sandbox::new("top");
        let output = sandbox.run(arguments).unwrap();
        let effects = sandbox.side_effects();
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert_eq!(
            output.status.code(),
            Some(0),
            "{}",
            describe(arguments, &output, &effects)
        );
        assert!(
            effects.is_empty(),
            "{}",
            describe(arguments, &output, &effects)
        );
        for subcommand in SUBCOMMANDS.iter().filter(|name| **name != "abs-test") {
            assert!(
                has_usage_line(&stdout, subcommand),
                "usage misses {subcommand}: {stdout}"
            );
        }
    }

    for arguments in [
        &["--cul-no-such-flag"][..],
        &["cul-no-such-command"][..],
        &["state", "one", "two"][..],
        &["doctor", "extra"][..],
        &["abs-test", "10"][..],
        &["abs-test", "ten", "20"][..],
    ] {
        let sandbox = Sandbox::new("bad");
        let output = sandbox.run(arguments).unwrap();
        let effects = sandbox.side_effects();
        assert_eq!(
            output.status.code(),
            Some(2),
            "{}",
            describe(arguments, &output, &effects)
        );
        assert!(
            effects.is_empty(),
            "{}",
            describe(arguments, &output, &effects)
        );
    }
}

#[test]
fn chrome_extension_host_validates_its_command_line_before_it_binds() {
    let mut failures = Vec::new();
    for arguments in [
        &["--help"][..],
        &["-h"][..],
        &[EXTENSION_ORIGIN, "--help"][..],
    ] {
        let sandbox = Sandbox::for_chrome_host("chrome-help");
        let output = match sandbox.run_binary(CHROME_HOST, arguments) {
            Ok(output) => output,
            Err(failure) => {
                failures.push(failure);
                continue;
            }
        };
        let effects = sandbox.side_effects();
        let stdout = String::from_utf8_lossy(&output.stdout);
        if output.status.code() != Some(0)
            || !effects.is_empty()
            || !stdout
                .lines()
                .any(|line| line.trim() == "codex-chrome-extension-host [ORIGIN]")
        {
            failures.push(describe(arguments, &output, &effects));
        }
    }

    for (arguments, message) in [
        (
            &["--cul-no-such-flag"][..],
            "unknown option '--cul-no-such-flag'",
        ),
        (
            &[EXTENSION_ORIGIN, "--cul-no-such-flag"][..],
            "unknown option '--cul-no-such-flag'",
        ),
        (
            &[EXTENSION_ORIGIN, "extra"][..],
            "unexpected argument 'extra'",
        ),
    ] {
        let sandbox = Sandbox::for_chrome_host("chrome-bad");
        let output = match sandbox.run_binary(CHROME_HOST, arguments) {
            Ok(output) => output,
            Err(failure) => {
                failures.push(failure);
                continue;
            }
        };
        let effects = sandbox.side_effects();
        if output.status.code() != Some(2)
            || !effects.is_empty()
            || !String::from_utf8_lossy(&output.stderr).contains(message)
        {
            failures.push(describe(arguments, &output, &effects));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n\n"));

    // Chrome's own launch still runs: the host binds its socket, reads end of
    // input on the closed stdin and exits.
    let sandbox = Sandbox::for_chrome_host("chrome-run");
    let output = sandbox
        .run_binary(CHROME_HOST, &[EXTENSION_ORIGIN])
        .unwrap();
    let listening = format!(
        "listening on {}/extension-",
        sandbox.chrome_socket_dir.display()
    );
    assert!(
        output.status.success() && String::from_utf8_lossy(&output.stderr).contains(&listening),
        "{}",
        describe(&[EXTENSION_ORIGIN], &output, &sandbox.side_effects())
    );
}
