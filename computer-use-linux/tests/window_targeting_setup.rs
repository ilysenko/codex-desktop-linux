//! `setup-window-targeting` asks for a new login only when GNOME Shell would
//! run something new after one.
//!
//! Each run gets a private HOME and XDG_DATA_HOME with an installed copy of
//! the extension, stand-ins for `gsettings` and `gnome-extensions` first on
//! PATH, and a private D-Bus daemon where a fake GNOME Shell serves the
//! extension's window list. Nothing reaches the desktop session running the
//! tests.
use std::{
    collections::HashMap,
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex},
};
use zbus::zvariant::{OwnedValue, Str};

#[path = "../src/test_sockets.rs"]
#[allow(dead_code)]
mod test_sockets;

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

struct FakeExtension;

#[zbus::interface(name = "com.openai.Codex.WindowControl")]
impl FakeExtension {
    fn list_windows(&self) -> String {
        "[]".to_string()
    }
}

/// GNOME Shell's extension list: the per-user copy `loaded` names, or none.
struct FakeShellExtensions {
    loaded: Arc<Mutex<Option<PathBuf>>>,
}

#[zbus::interface(name = "org.gnome.Shell.Extensions")]
impl FakeShellExtensions {
    fn get_extension_info(&self, uuid: &str) -> HashMap<String, OwnedValue> {
        let loaded = self.loaded.lock().unwrap().clone();
        let Some(path) = loaded.filter(|_| uuid == UUID) else {
            return HashMap::new();
        };
        // ExtensionType.PER_USER; the Shell sends numbers as doubles.
        HashMap::from([
            (
                "path".to_string(),
                OwnedValue::from(Str::from(path.to_string_lossy().into_owned())),
            ),
            ("type".to_string(), OwnedValue::from(2.0_f64)),
        ])
    }
}

struct Home {
    root: PathBuf,
    /// XDG_DATA_HOME as setup sees it: `data`, or empty.
    data_home: PathBuf,
    /// The copy GNOME Shell loads, which setup must update.
    installed: PathBuf,
}

impl Drop for Home {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

/// Where GNOME Shell looks for user extensions.
#[derive(Clone, Copy)]
enum DataHome {
    /// XDG_DATA_HOME is set to a directory outside HOME.
    Set,
    /// XDG_DATA_HOME is empty, so HOME/.local/share applies.
    Empty,
    /// XDG_DATA_HOME is empty for setup, but GNOME Shell loaded its copy
    /// from `data`: the Shell runs with another XDG_DATA_HOME.
    Shell,
}

impl Home {
    /// A private HOME whose enabled extension copy has these two files.
    fn with_installed(label: &str, data_home: DataHome, metadata: &str, extension: &str) -> Self {
        let root = Path::new(env!("CARGO_TARGET_TMPDIR"))
            .join(format!("setup-{label}-{}", getrandom::u64().unwrap()));
        let (data_home, data_dir) = match data_home {
            DataHome::Set => (root.join("data"), root.join("data")),
            DataHome::Empty => (PathBuf::new(), root.join("home/.local/share")),
            DataHome::Shell => (PathBuf::new(), root.join("data")),
        };
        let installed = data_dir.join("gnome-shell/extensions").join(UUID);
        fs::create_dir_all(&installed).unwrap();
        fs::write(installed.join("metadata.json"), metadata).unwrap();
        fs::write(installed.join("extension.js"), extension).unwrap();
        let bin = root.join("bin");
        fs::create_dir_all(&bin).unwrap();
        for dir in ["home", "config", "data", "cache", "state", "runtime"] {
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
        Self {
            root,
            data_home,
            installed,
        }
    }

    fn installed(&self, file: &str) -> String {
        fs::read_to_string(self.installed.join(file)).unwrap()
    }

    /// Runs setup and checks that it wrote to the copy GNOME Shell loads,
    /// and to no other.
    async fn setup(&self, bus_address: &str) -> serde_json::Value {
        let dir = |name: &str| self.root.join(name);
        let output = tokio::process::Command::new(BINARY)
            .arg("setup-window-targeting")
            .env_clear()
            .env("PATH", dir("bin"))
            .env("HOME", dir("home"))
            .env("XDG_CONFIG_HOME", dir("config"))
            .env("XDG_DATA_HOME", &self.data_home)
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
        let report: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(
            report["extension_dir"],
            self.installed.display().to_string(),
            "{report:#}"
        );
        for other in ["data", "home/.local/share"] {
            let copy = dir(other).join("gnome-shell/extensions").join(UUID);
            assert!(
                copy == self.installed || !copy.exists(),
                "setup wrote {}, which GNOME Shell does not load",
                copy.display()
            );
        }
        report
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
    let bus = test_sockets::PrivateBus::start("cul-setup-bus");
    let address = bus.address();
    // The server serves the window list only when GNOME Shell owns the
    // extension's bus name.
    let loaded = Arc::new(Mutex::new(None));
    let _shell = zbus::connection::Builder::address(address)
        .unwrap()
        .name("org.gnome.Shell")
        .unwrap()
        .name(SERVICE)
        .unwrap()
        .serve_at(OBJECT_PATH, FakeExtension)
        .unwrap()
        .serve_at(
            "/org/gnome/Shell",
            FakeShellExtensions {
                loaded: loaded.clone(),
            },
        )
        .unwrap()
        .build()
        .await
        .unwrap();

    // The 0.7.45 upgrade: metadata.json gained url, extension.js did not change.
    let display_only = Home::with_installed(
        "display",
        DataHome::Set,
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

    for data_home in [DataHome::Set, DataHome::Empty] {
        let up_to_date = Home::with_installed("current", data_home, METADATA_JSON, EXTENSION_JS);
        let report = up_to_date.setup(address).await;
        assert_eq!(report["requires_shell_reload"], false, "{report:#}");
        assert_eq!(
            report["message"],
            "Codex GNOME Shell extension is active and window targeting is available.",
            "{report:#}"
        );
    }

    // Setup updates the copy GNOME Shell reports, not the one its own
    // environment names.
    let shell_copy = Home::with_installed(
        "shell",
        DataHome::Shell,
        METADATA_JSON,
        "// an older extension",
    );
    *loaded.lock().unwrap() = Some(shell_copy.installed.clone());
    let report = shell_copy.setup(address).await;
    *loaded.lock().unwrap() = None;
    assert_eq!(report["requires_shell_reload"], true, "{report:#}");
    assert_eq!(shell_copy.installed("extension.js"), EXTENSION_JS);

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
        let home = Home::with_installed(label, DataHome::Set, &metadata, &extension);
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
