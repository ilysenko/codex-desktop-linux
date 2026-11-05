//! `setup-window-targeting` asks for a new login only when GNOME Shell would
//! run something new after one.
//!
//! Each run gets a private HOME with an installed copy of the extension,
//! stand-ins for `gsettings` and `gnome-extensions` first on PATH, and a
//! private D-Bus daemon where a fake GNOME Shell serves the extension's
//! window list. Nothing reaches the desktop session running the tests.
use std::{
    fs,
    io::{BufRead, BufReader},
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
};

const BINARY: &str = env!("CARGO_BIN_EXE_codex-computer-use-linux");
// The default build identity, as in scripts/gnome_indicator_test.py. A build
// with CUL_* identity overrides skips the test (see src/identity.rs).
const UUID: &str = "codex-window-control@openai.com";
const IDENTITY_OVERRIDES: [Option<&str>; 3] = [
    option_env!("CUL_GNOME_EXTENSION_UUID"),
    option_env!("CUL_DBUS_SERVICE"),
    option_env!("CUL_DBUS_OBJECT_PATH"),
];
const SERVICE: &str = "com.openai.Codex.WindowControl";
const OBJECT_PATH: &str = "/com/openai/Codex/WindowControl";
const METADATA_JSON: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/gnome-shell-extension/metadata.json"
));
const EXTENSION_JS: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/gnome-shell-extension/extension.js"
));

const PRIVATE_BUS_CONFIG: &str = "<busconfig><type>session</type><listen>unix:tmpdir=/tmp</listen><policy context=\"default\"><allow own=\"*\"/><allow send_destination=\"*\"/><allow receive_sender=\"*\"/></policy></busconfig>";

struct FakeExtension;

#[zbus::interface(name = "com.openai.Codex.WindowControl")]
impl FakeExtension {
    fn list_windows(&self) -> String {
        "[]".to_string()
    }
}

struct PrivateBus(Child);

impl Drop for PrivateBus {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

struct Home(PathBuf);

impl Drop for Home {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

struct Scratch(PathBuf);

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

impl Home {
    /// A private HOME whose enabled extension copy has these two files.
    fn with_installed(label: &str, metadata: &str, extension: &str) -> Self {
        let root = Path::new(env!("CARGO_TARGET_TMPDIR"))
            .join(format!("setup-{label}-{}", getrandom::u64().unwrap()));
        let installed = root
            .join("home/.local/share/gnome-shell/extensions")
            .join(UUID);
        fs::create_dir_all(&installed).unwrap();
        fs::write(installed.join("metadata.json"), metadata).unwrap();
        fs::write(installed.join("extension.js"), extension).unwrap();
        let bin = root.join("bin");
        fs::create_dir_all(&bin).unwrap();
        for dir in ["config", "data", "cache", "state", "runtime"] {
            fs::create_dir_all(root.join(dir)).unwrap();
        }
        fs::set_permissions(root.join("runtime"), fs::Permissions::from_mode(0o700)).unwrap();
        let stand_ins = [
            (
                "gsettings",
                format!(
                    "if [ \"$*\" = 'get org.gnome.shell enabled-extensions' ]; then echo \"['{UUID}']\"; exit 0; fi\nexit 1"
                ),
            ),
            (
                "gnome-extensions",
                format!("[ \"$*\" = 'enable {UUID}' ]"),
            ),
            ("systemctl", "exit 1".to_string()),
            ("gdbus", "exit 1".to_string()),
        ];
        for (name, body) in stand_ins {
            let script = bin.join(name);
            fs::write(&script, format!("#!/bin/sh\n{body}\n")).unwrap();
            fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
        }
        Self(root)
    }

    fn installed(&self, file: &str) -> String {
        fs::read_to_string(
            self.0
                .join("home/.local/share/gnome-shell/extensions")
                .join(UUID)
                .join(file),
        )
        .unwrap()
    }

    async fn setup(&self, bus_address: &str) -> serde_json::Value {
        let dir = |name: &str| self.0.join(name);
        let output = tokio::process::Command::new(BINARY)
            .arg("setup-window-targeting")
            .env_clear()
            .env("PATH", dir("bin"))
            .env("HOME", dir("home"))
            .env("XDG_CONFIG_HOME", dir("config"))
            .env("XDG_DATA_HOME", dir("data"))
            .env("XDG_CACHE_HOME", dir("cache"))
            .env("XDG_STATE_HOME", dir("state"))
            .env("XDG_RUNTIME_DIR", dir("runtime"))
            // Every key session discovery fills when it is empty, so nothing
            // is borrowed from the desktop session running the tests.
            .env("DBUS_SESSION_BUS_ADDRESS", bus_address)
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
            .stdin(Stdio::null())
            .output()
            .await
            .unwrap();
        assert!(
            output.status.success(),
            "setup-window-targeting failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice(&output.stdout).unwrap()
    }
}

fn metadata_with(edit: impl FnOnce(&mut serde_json::Map<String, serde_json::Value>)) -> String {
    let mut fields = serde_json::from_str(METADATA_JSON).unwrap();
    edit(&mut fields);
    serde_json::to_string_pretty(&fields).unwrap()
}

#[tokio::test]
async fn reload_is_required_only_for_changes_gnome_shell_runs() {
    if IDENTITY_OVERRIDES.iter().any(Option::is_some) {
        eprintln!("skipped: the fixture serves the default extension identity only");
        return;
    }
    if Path::new("/usr/share/gnome-shell/extensions")
        .join(UUID)
        .join("metadata.json")
        .is_file()
    {
        eprintln!("skipped: a system copy of {UUID} replaces the user copy this test installs");
        return;
    }
    // No service directories, so nothing on this bus can activate a real
    // desktop service.
    let bus_dir = Scratch(
        Path::new(env!("CARGO_TARGET_TMPDIR"))
            .join(format!("setup-bus-{}", getrandom::u64().unwrap())),
    );
    fs::create_dir_all(&bus_dir.0).unwrap();
    let config = bus_dir.0.join("bus.conf");
    fs::write(&config, PRIVATE_BUS_CONFIG).unwrap();
    let mut bus = PrivateBus(
        Command::new("dbus-daemon")
            .arg(format!("--config-file={}", config.display()))
            .args(["--nofork", "--nopidfile", "--print-address=1"])
            .env_clear()
            .stdout(Stdio::piped())
            .spawn()
            .unwrap(),
    );
    let mut address = String::new();
    BufReader::new(bus.0.stdout.take().unwrap())
        .read_line(&mut address)
        .unwrap();
    let address = address.trim();
    // The server serves the window list only when GNOME Shell owns the
    // extension's bus name.
    let _shell = zbus::connection::Builder::address(address)
        .unwrap()
        .name("org.gnome.Shell")
        .unwrap()
        .name(SERVICE)
        .unwrap()
        .serve_at(OBJECT_PATH, FakeExtension)
        .unwrap()
        .build()
        .await
        .unwrap();

    // The 0.7.45 upgrade: metadata.json gained url, extension.js did not change.
    let display_only = Home::with_installed(
        "display",
        &metadata_with(|fields| {
            fields.remove("url");
            fields.insert("description".into(), "An older description.".into());
        }),
        EXTENSION_JS,
    );
    let report = display_only.setup(address).await;
    assert_eq!(
        report["windows_error"],
        serde_json::Value::Null,
        "{report:#}"
    );
    assert_eq!(report["requires_shell_reload"], false, "{report:#}");
    assert!(
        report["message"]
            .as_str()
            .unwrap()
            .ends_with("Only its display metadata changed, which needs no reload."),
        "{report:#}"
    );
    assert_eq!(display_only.installed("metadata.json"), METADATA_JSON);

    let up_to_date = Home::with_installed("current", METADATA_JSON, EXTENSION_JS);
    let report = up_to_date.setup(address).await;
    assert_eq!(report["requires_shell_reload"], false, "{report:#}");
    assert_eq!(
        report["message"],
        "Codex GNOME Shell extension is active and window targeting is available.",
        "{report:#}"
    );

    let reload_cases = [
        (
            "code",
            METADATA_JSON.to_string(),
            "// an older extension".to_string(),
        ),
        (
            "shell-version",
            metadata_with(|fields| {
                fields.insert("shell-version".into(), serde_json::json!(["45"]));
            }),
            EXTENSION_JS.to_string(),
        ),
        ("broken", "{".to_string(), EXTENSION_JS.to_string()),
    ];
    for (label, metadata, extension) in reload_cases {
        let home = Home::with_installed(label, &metadata, &extension);
        let report = home.setup(address).await;
        assert_eq!(
            report["windows_error"],
            serde_json::Value::Null,
            "{label}: {report:#}"
        );
        assert_eq!(report["requires_shell_reload"], true, "{label}: {report:#}");
        assert!(
            report["message"]
                .as_str()
                .unwrap()
                .contains("GNOME Shell must reload"),
            "{label}: {report:#}"
        );
        assert_eq!(home.installed("metadata.json"), METADATA_JSON);
        assert_eq!(home.installed("extension.js"), EXTENSION_JS);
    }
}
