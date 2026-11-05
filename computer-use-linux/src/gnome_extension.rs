use crate::command_runner;
use crate::diagnostics::hydrate_session_bus_env;
use crate::identity;
use crate::windowing::backends::gnome::list_extension_windows;
use crate::windows::{window_permission_hint, WindowInfo};
use schemars::JsonSchema;
use serde::Serialize;
use std::{
    collections::HashMap,
    env,
    ffi::OsString,
    fs, io,
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

pub const UUID: &str = identity::GNOME_EXTENSION_UUID;
const METADATA_JSON: &str = include_str!("../gnome-shell-extension/metadata.json");
const EXTENSION_JS: &str = include_str!("../gnome-shell-extension/extension.js");
const SYSTEM_EXTENSIONS_DIR: &str = "/usr/share/gnome-shell/extensions";
/// metadata.json fields whose values GNOME Shell only displays. The Shell
/// reads metadata.json when it loads an extension and imports extension.js
/// once per session. It requires name and description to be strings and acts
/// on uuid, shell-version, session-modes and version. The Extension base
/// class reads uuid and gettext-domain, and name only as the getLogger
/// prefix, which extension.js does not use. A change to these fields alone
/// needs no reload.
pub(crate) const DISPLAY_ONLY_METADATA: &[&str] =
    &["name", "description", "url", "version-name", "donations"];

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct WindowTargetingSetupReport {
    pub extension_dir: String,
    pub wrote_files: bool,
    pub enable_command: SetupCommandReport,
    pub windows: Vec<WindowInfo>,
    pub windows_error: Option<String>,
    pub permissions_hint: Option<String>,
    pub requires_shell_reload: bool,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct SetupCommandReport {
    pub ok: bool,
    pub detail: String,
}

pub async fn setup_window_targeting_report() -> WindowTargetingSetupReport {
    hydrate_session_bus_env();

    // A per-user copy GNOME Shell loaded names the Shell's own user
    // extension dir. The host may set XDG_DATA_HOME differently, so this
    // process's value is only the fallback.
    let loaded = loaded_extension().await;
    let user_dir = loaded
        .as_ref()
        .filter(|extension| extension.per_user)
        .map(|extension| extension.path.clone())
        .unwrap_or_else(extension_dir);
    let system_dir = Path::new(SYSTEM_EXTENSIONS_DIR).join(UUID);
    let system_installed = system_dir.join("metadata.json").is_file();
    let extension_dir = if system_installed {
        system_dir
    } else {
        user_dir.clone()
    };
    let extension_was_enabled = gnome_extension_enabled();
    let mut wrote_files = false;
    let mut changed_files = false;
    let mut display_metadata_changed = false;
    let mut file_error = None;
    let mut removed_user_copy = false;
    if system_installed {
        // A user copy shadows the packaged system extension.
        match remove_user_copy(&user_dir) {
            Ok(removed) => removed_user_copy = removed,
            Err(error) => file_error = Some(error),
        }
    } else {
        match write_extension_files(&user_dir) {
            Ok(report) => {
                wrote_files = report.wrote_files;
                changed_files = report.changed_files;
                display_metadata_changed = report.display_metadata_changed;
            }
            Err(error) => file_error = Some(error),
        }
    }

    let enable_command = if let Some(error) = &file_error {
        SetupCommandReport {
            ok: false,
            detail: format!("extension file setup failed: {error}"),
        }
    } else {
        run_gnome_extensions_enable()
    };

    let (windows, windows_error, permissions_hint) = match list_extension_windows().await {
        Ok(windows) => (windows, None, None),
        Err(error) => {
            let error = format!("{error:#}");
            let hint = window_permission_hint(&error);
            (Vec::new(), Some(error), hint)
        }
    };

    // Enabling an extension does not replace the object cached by GNOME Shell.
    let system_reload_pending = if system_installed {
        system_extension_requires_shell_reload(
            removed_user_copy,
            loaded.as_ref().map(|extension| extension.path.as_path()),
            &extension_dir,
        )
    } else {
        false
    };
    let requires_shell_reload = system_reload_pending
        || setup_requires_shell_reload(
            windows_error.as_ref(),
            extension_was_enabled,
            changed_files,
        );
    let message = if file_error.is_some() {
        "Could not set up the Codex GNOME Shell extension files.".to_string()
    } else if !enable_command.ok {
        "Codex GNOME Shell extension files are available, but enabling the extension failed. Enable it with gnome-extensions after GNOME Shell sees the new extension."
            .to_string()
    } else if system_reload_pending {
        "GNOME Shell must reload before the Codex GNOME Shell extension is active. Log out and back in so that GNOME Shell loads the system extension."
            .to_string()
    } else if windows_error.is_none() && requires_shell_reload {
        shell_reload_message(extension_was_enabled).to_string()
    } else if windows_error.is_none() && display_metadata_changed {
        "Codex GNOME Shell extension is active and window targeting is available. Only its display metadata changed, which needs no reload."
            .to_string()
    } else if windows_error.is_none() {
        "Codex GNOME Shell extension is active and window targeting is available.".to_string()
    } else {
        "Codex GNOME Shell extension files are available and enable was requested, but GNOME Shell is not serving the window-control DBus API yet. Log out and back in, then retry setup_window_targeting."
            .to_string()
    };

    WindowTargetingSetupReport {
        extension_dir: extension_dir.display().to_string(),
        wrote_files,
        enable_command,
        windows,
        windows_error,
        permissions_hint,
        requires_shell_reload,
        message,
    }
}

struct ExtensionWriteReport {
    wrote_files: bool,
    /// extension.js changed, or a metadata.json field GNOME Shell acts on.
    /// The running Shell keeps the old copy until it loads the extension again.
    changed_files: bool,
    /// metadata.json changed in display-only fields and nothing else did.
    display_metadata_changed: bool,
}

fn write_extension_files(extension_dir: &Path) -> Result<ExtensionWriteReport, String> {
    fs::create_dir_all(extension_dir)
        .map_err(|error| format!("failed to create {}: {error}", extension_dir.display()))?;
    let metadata_json = render_extension_asset(METADATA_JSON);
    let extension_js = render_extension_asset(EXTENSION_JS);
    let installed_metadata = fs::read_to_string(extension_dir.join("metadata.json")).ok();
    let metadata_changed = installed_metadata.as_deref() != Some(metadata_json.as_str());
    let changed_files = file_content_changed(&extension_dir.join("extension.js"), &extension_js)
        || (metadata_changed
            && installed_metadata
                .as_deref()
                .is_none_or(|installed| metadata_needs_reload(installed, &metadata_json)));
    let display_metadata_changed = metadata_changed && !changed_files;

    fs::write(extension_dir.join("metadata.json"), metadata_json).map_err(|error| {
        format!(
            "failed to write {}: {error}",
            extension_dir.join("metadata.json").display()
        )
    })?;
    fs::write(extension_dir.join("extension.js"), extension_js).map_err(|error| {
        format!(
            "failed to write {}: {error}",
            extension_dir.join("extension.js").display()
        )
    })?;
    Ok(ExtensionWriteReport {
        wrote_files: true,
        changed_files,
        display_metadata_changed,
    })
}

/// Whether two metadata.json texts differ outside the display-only fields.
/// Text that is not a JSON object counts as a change.
fn metadata_needs_reload(installed: &str, expected: &str) -> bool {
    let load_fields = |text: &str| match serde_json::from_str(text) {
        Ok(serde_json::Value::Object(mut fields)) => {
            for field in DISPLAY_ONLY_METADATA {
                fields.remove(*field);
            }
            Some(fields)
        }
        _ => None,
    };
    match (load_fields(installed), load_fields(expected)) {
        (Some(installed), Some(expected)) => installed != expected,
        _ => true,
    }
}

fn remove_user_copy(extension_dir: &Path) -> Result<bool, String> {
    match fs::remove_dir_all(extension_dir) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!(
            "failed to remove {}: {error}",
            extension_dir.display()
        )),
    }
}

/// The copy of the extension GNOME Shell loaded.
#[derive(Debug, PartialEq)]
struct LoadedExtension {
    path: PathBuf,
    /// The Shell found it in its user extension dir, not a system one.
    per_user: bool,
}

/// `ExtensionType.PER_USER` in GNOME Shell's `js/misc/extensionUtils.js`.
/// `GetExtensionInfo` sends numbers as doubles.
const PER_USER_EXTENSION: f64 = 2.0;

async fn loaded_extension() -> Option<LoadedExtension> {
    tokio::time::timeout(Duration::from_secs(2), async {
        let connection = zbus::Connection::session().await.ok()?;
        loaded_extension_on_connection(&connection)
            .await
            .ok()
            .flatten()
    })
    .await
    .ok()
    .flatten()
}

async fn loaded_extension_on_connection(
    connection: &zbus::Connection,
) -> Result<Option<LoadedExtension>, zbus::Error> {
    let proxy = zbus::Proxy::new(
        connection,
        "org.gnome.Shell",
        "/org/gnome/Shell",
        "org.gnome.Shell.Extensions",
    )
    .await?;
    let info: HashMap<String, zbus::zvariant::OwnedValue> =
        proxy.call("GetExtensionInfo", &(UUID,)).await?;
    let per_user =
        info.get("type").and_then(|value| f64::try_from(value).ok()) == Some(PER_USER_EXTENSION);
    Ok(info
        .get("path")
        .and_then(|value| <&str>::try_from(value).ok())
        .map(|path| LoadedExtension {
            path: PathBuf::from(path),
            per_user,
        }))
}

fn system_extension_requires_shell_reload(
    removed_user_copy: bool,
    loaded_path: Option<&Path>,
    system_dir: &Path,
) -> bool {
    removed_user_copy || loaded_path.is_some_and(|path| path != system_dir)
}

fn file_content_changed(path: &Path, expected: &str) -> bool {
    match fs::read_to_string(path) {
        Ok(current) => current != expected,
        Err(_) => true,
    }
}

fn setup_requires_shell_reload(
    windows_error: Option<&String>,
    extension_was_enabled: Option<bool>,
    changed_files: bool,
) -> bool {
    windows_error.is_some() || extension_was_enabled != Some(false) && changed_files
}

fn shell_reload_message(extension_was_enabled: Option<bool>) -> &'static str {
    if extension_was_enabled == Some(true) {
        "Codex GNOME Shell extension files changed while the extension was already active. Window targeting is available, but GNOME Shell must reload before newly installed DBus methods are served."
    } else {
        "Codex GNOME Shell extension files changed, but the previous extension state could not be determined. GNOME Shell must reload before newly installed DBus methods can be relied on."
    }
}

fn render_extension_asset(asset: &str) -> String {
    asset
        .replace(
            identity::DEFAULT_GNOME_EXTENSION_UUID,
            identity::GNOME_EXTENSION_UUID,
        )
        .replace(identity::DEFAULT_DBUS_SERVICE, identity::DBUS_SERVICE)
        .replace(
            identity::DEFAULT_DBUS_OBJECT_PATH,
            identity::DBUS_OBJECT_PATH,
        )
}

fn run_gnome_extensions_enable() -> SetupCommandReport {
    let mut command = Command::new("gnome-extensions");
    command.args(["enable", UUID]);

    let primary = match run_session_command(&mut command, "enable the GNOME Shell extension") {
        Ok(output) => SetupCommandReport {
            ok: true,
            detail: output_detail(&output.stdout, &output.stderr, "gnome-extensions enable ok"),
        },
        Err(detail) => SetupCommandReport { ok: false, detail },
    };
    if primary.ok {
        return primary;
    }

    let fallback = run_gsettings_enable_fallback();
    if fallback.ok {
        SetupCommandReport {
            ok: true,
            detail: format!(
                "gnome-extensions enable failed: {}; {detail}",
                primary.detail,
                detail = fallback.detail
            ),
        }
    } else {
        SetupCommandReport {
            ok: false,
            detail: format!(
                "gnome-extensions enable failed: {}; gsettings fallback failed: {}",
                primary.detail, fallback.detail
            ),
        }
    }
}

fn run_gsettings_enable_fallback() -> SetupCommandReport {
    let current = match enabled_extensions_value() {
        Ok(current) => current,
        Err(detail) => return SetupCommandReport { ok: false, detail },
    };

    let Some(updated) = enabled_extensions_literal(&current) else {
        return SetupCommandReport {
            ok: false,
            detail: format!("could not parse enabled-extensions value: {current}"),
        };
    };
    if updated == current {
        return SetupCommandReport {
            ok: true,
            detail: format!("{UUID} already present in org.gnome.shell enabled-extensions"),
        };
    }

    let mut set_command = Command::new("gsettings");
    set_command.args(["set", "org.gnome.shell", "enabled-extensions", &updated]);
    match run_session_command(
        &mut set_command,
        "update org.gnome.shell enabled-extensions",
    ) {
        Ok(_) => SetupCommandReport {
            ok: true,
            detail: format!(
                "added {UUID} to org.gnome.shell enabled-extensions for the next GNOME Shell load"
            ),
        },
        Err(detail) => SetupCommandReport { ok: false, detail },
    }
}

fn gnome_extension_enabled() -> Option<bool> {
    enabled_extensions_value()
        .ok()
        .map(|current| enabled_extensions_contains_uuid(&current))
}

fn enabled_extensions_value() -> Result<String, String> {
    let mut command = Command::new("gsettings");
    command.args(["get", "org.gnome.shell", "enabled-extensions"]);
    let output = run_session_command(&mut command, "read org.gnome.shell enabled-extensions")?;
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn enabled_extensions_contains_uuid(current: &str) -> bool {
    let quoted = format!("'{UUID}'");
    current.trim().contains(&quoted)
}

fn enabled_extensions_literal(current: &str) -> Option<String> {
    let trimmed = current.trim();
    if enabled_extensions_contains_uuid(trimmed) {
        return Some(trimmed.to_string());
    }

    let quoted = format!("'{UUID}'");
    let list = if trimmed == "@as []" { "[]" } else { trimmed };
    if list == "[]" {
        return Some(format!("[{quoted}]"));
    }

    let prefix = list.strip_suffix(']')?;
    Some(format!("{prefix}, {quoted}]"))
}

fn add_session_env(command: &mut Command) {
    if let Some(address) = env::var("DBUS_SESSION_BUS_ADDRESS")
        .ok()
        .filter(|value| !value.trim().is_empty())
    {
        command.env("DBUS_SESSION_BUS_ADDRESS", address);
    }
    if let Some(runtime) = env::var("XDG_RUNTIME_DIR")
        .ok()
        .filter(|value| !value.trim().is_empty())
    {
        command.env("XDG_RUNTIME_DIR", runtime);
    }
}

fn run_session_command(
    command: &mut Command,
    action: &str,
) -> Result<std::process::Output, String> {
    add_session_env(command);
    let output =
        command_runner::output_blocking(command, action).map_err(|error| format!("{error:#}"))?;
    if output.status.success() {
        Ok(output)
    } else {
        Err(output_detail(
            &output.stdout,
            &output.stderr,
            &format!("{action} failed with {}", output.status),
        ))
    }
}

fn output_detail(stdout: &[u8], stderr: &[u8], fallback: &str) -> String {
    let stderr = String::from_utf8_lossy(stderr).trim().to_string();
    if !stderr.is_empty() {
        return stderr;
    }
    let stdout = String::from_utf8_lossy(stdout).trim().to_string();
    if !stdout.is_empty() {
        return stdout;
    }
    fallback.to_string()
}

/// The user copy GNOME Shell loads: `extensions/UUID` under
/// `g_get_user_data_dir()/gnome-shell`.
fn extension_dir() -> PathBuf {
    user_extension_dir(env::var_os("XDG_DATA_HOME"), env::var_os("HOME"))
}

/// GLib's user data dir is `XDG_DATA_HOME` when it is set and not empty,
/// else `HOME/.local/share`.
fn user_extension_dir(data_home: Option<OsString>, home: Option<OsString>) -> PathBuf {
    data_home
        .filter(|dir| !dir.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(home.unwrap_or_else(|| ".".into())).join(".local/share"))
        .join("gnome-shell/extensions")
        .join(UUID)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestExtensionDirectory(PathBuf);

    impl TestExtensionDirectory {
        fn new() -> Self {
            let path = env::temp_dir().join(format!(
                "computer-use-linux-extension-test-{}-{}",
                std::process::id(),
                getrandom::u64().unwrap()
            ));
            Self(path)
        }
    }

    impl Drop for TestExtensionDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn enabled_extensions_literal_adds_uuid_to_existing_list() {
        assert_eq!(
            enabled_extensions_literal("['ubuntu-dock@ubuntu.com']").unwrap(),
            format!("['ubuntu-dock@ubuntu.com', '{UUID}']")
        );
    }

    #[test]
    fn enabled_extensions_literal_handles_empty_typed_array() {
        assert_eq!(
            enabled_extensions_literal("@as []").unwrap(),
            format!("['{UUID}']")
        );
    }

    #[test]
    fn enabled_extensions_literal_is_idempotent() {
        let value = format!("['{UUID}']");

        assert_eq!(enabled_extensions_literal(&value).unwrap(), value);
    }

    #[test]
    fn enabled_extensions_contains_uuid_matches_quoted_entry() {
        assert!(enabled_extensions_contains_uuid(&format!(
            "['other@example.com', '{UUID}']"
        )));
        assert!(!enabled_extensions_contains_uuid(&format!(
            "['{UUID}.suffix']"
        )));
    }

    #[test]
    fn session_command_failure_reports_command_stderr() {
        let mut command = Command::new("sh");
        command.args(["-c", "printf 'settings rejected' >&2; exit 23"]);

        let error = run_session_command(&mut command, "update GNOME settings").unwrap_err();

        assert_eq!(error, "settings rejected");
    }

    #[test]
    fn extension_file_write_reports_content_changes() {
        let extension_dir = TestExtensionDirectory::new();

        let first = write_extension_files(&extension_dir.0).unwrap();
        assert!(first.wrote_files);
        assert!(first.changed_files);

        let second = write_extension_files(&extension_dir.0).unwrap();
        assert!(second.wrote_files);
        assert!(!second.changed_files);

        fs::write(extension_dir.0.join("extension.js"), "// stale extension").unwrap();
        let third = write_extension_files(&extension_dir.0).unwrap();
        assert!(third.wrote_files);
        assert!(third.changed_files);
        assert!(!third.display_metadata_changed);
    }

    #[test]
    fn only_display_metadata_changes_skip_the_reload() {
        let expected = render_extension_asset(METADATA_JSON);
        let fields: serde_json::Map<String, serde_json::Value> =
            serde_json::from_str(&expected).unwrap();
        let with = |edit: &dyn Fn(&mut serde_json::Map<String, serde_json::Value>)| {
            let mut edited = fields.clone();
            edit(&mut edited);
            serde_json::to_string(&edited).unwrap()
        };
        // 0.7.43 had no url; key order and layout do not matter either.
        assert!(!metadata_needs_reload(
            &with(&|m| {
                m.remove("url");
            }),
            &expected
        ));
        assert!(!metadata_needs_reload(
            &with(&|m| {
                m.insert("name".into(), "Old name".into());
                m.insert("description".into(), "Old text".into());
                m.insert("version-name".into(), "0.1".into());
            }),
            &expected
        ));
        assert!(metadata_needs_reload(
            &with(&|m| {
                m.insert("shell-version".into(), serde_json::json!(["45"]));
            }),
            &expected
        ));
        assert!(metadata_needs_reload(
            &with(&|m| {
                m.insert("session-modes".into(), serde_json::json!(["user"]));
            }),
            &expected
        ));
        assert!(metadata_needs_reload(
            &with(&|m| {
                m.insert("version".into(), 2.into());
            }),
            &expected
        ));
        assert!(metadata_needs_reload("{", &expected));
        assert!(metadata_needs_reload("[]", &expected));
    }

    #[test]
    fn extension_reads_no_display_metadata() {
        // DISPLAY_ONLY_METADATA holds only while extension.js reads no
        // metadata itself and never logs through getLogger, whose prefix is
        // the name.
        for reader in ["metadata", "getLogger"] {
            assert!(
                !EXTENSION_JS.contains(reader),
                "extension.js uses {reader}; check DISPLAY_ONLY_METADATA"
            );
        }
    }

    #[test]
    fn user_copy_removal_reports_whether_a_copy_existed() {
        let extension_dir = TestExtensionDirectory::new();
        write_extension_files(&extension_dir.0).unwrap();

        assert!(remove_user_copy(&extension_dir.0).unwrap());
        assert!(!extension_dir.0.exists());
        assert!(!remove_user_copy(&extension_dir.0).unwrap());
    }

    #[test]
    fn user_copy_falls_back_to_home_when_xdg_data_home_is_unset_or_empty() {
        let home = || Some(OsString::from("/home/u"));
        let fallback = Path::new("/home/u/.local/share/gnome-shell/extensions").join(UUID);
        assert_eq!(user_extension_dir(None, home()), fallback);
        assert_eq!(user_extension_dir(Some("".into()), home()), fallback);
        assert_eq!(
            user_extension_dir(Some("/data".into()), home()),
            Path::new("/data/gnome-shell/extensions").join(UUID)
        );
    }

    struct FakeShellExtensions {
        path: std::sync::Arc<std::sync::Mutex<PathBuf>>,
    }

    #[zbus::interface(name = "org.gnome.Shell.Extensions")]
    impl FakeShellExtensions {
        fn get_extension_info(&self, uuid: &str) -> HashMap<String, zbus::zvariant::OwnedValue> {
            assert_eq!(uuid, UUID);
            HashMap::from([(
                "path".to_string(),
                zbus::zvariant::OwnedValue::from(zbus::zvariant::Str::from(
                    self.path.lock().unwrap().to_string_lossy().as_ref(),
                )),
            )])
        }
    }

    #[tokio::test]
    async fn system_migration_keeps_reload_warning_until_shell_changes_loaded_path() {
        let bus = crate::test_sockets::PrivateBus::start("cul-ext-bus");
        let user_dir = TestExtensionDirectory::new();
        write_extension_files(&user_dir.0).unwrap();
        let system_dir = Path::new(SYSTEM_EXTENSIONS_DIR).join(UUID);
        let path = std::sync::Arc::new(std::sync::Mutex::new(user_dir.0.clone()));
        let _service = zbus::connection::Builder::address(bus.address())
            .unwrap()
            .name("org.gnome.Shell")
            .unwrap()
            .serve_at(
                "/org/gnome/Shell",
                FakeShellExtensions { path: path.clone() },
            )
            .unwrap()
            .build()
            .await
            .unwrap();
        let client = zbus::connection::Builder::address(bus.address())
            .unwrap()
            .build()
            .await
            .unwrap();

        let removed = remove_user_copy(&user_dir.0).unwrap();
        let loaded = loaded_extension_on_connection(&client)
            .await
            .unwrap()
            .map(|extension| extension.path);
        assert_eq!(loaded.as_deref(), Some(user_dir.0.as_path()));
        assert!(system_extension_requires_shell_reload(
            removed,
            loaded.as_deref(),
            &system_dir
        ));

        let removed = remove_user_copy(&user_dir.0).unwrap();
        assert!(!removed);
        let loaded = loaded_extension_on_connection(&client)
            .await
            .unwrap()
            .map(|extension| extension.path);
        assert!(
            system_extension_requires_shell_reload(removed, loaded.as_deref(), &system_dir),
            "a second setup before Shell restarts must retain the reload warning"
        );

        *path.lock().unwrap() = system_dir.clone();
        let loaded = loaded_extension_on_connection(&client)
            .await
            .unwrap()
            .map(|extension| extension.path);
        assert!(!system_extension_requires_shell_reload(
            false,
            loaded.as_deref(),
            &system_dir
        ));
    }

    #[test]
    fn enabled_stale_extension_requires_shell_reload() {
        assert!(setup_requires_shell_reload(None, Some(true), true));
        assert!(setup_requires_shell_reload(
            Some(&"window API unavailable".to_string()),
            Some(false),
            false
        ));
        assert!(!setup_requires_shell_reload(None, Some(true), false));
        assert!(!setup_requires_shell_reload(None, Some(false), true));
        assert!(setup_requires_shell_reload(None, None, true));
    }

    #[test]
    fn unknown_extension_state_uses_neutral_reload_guidance() {
        assert_eq!(
            shell_reload_message(None),
            "Codex GNOME Shell extension files changed, but the previous extension state could not be determined. GNOME Shell must reload before newly installed DBus methods can be relied on."
        );
    }

    #[test]
    fn rendered_metadata_uses_build_identity() {
        let rendered = render_extension_asset(METADATA_JSON);

        assert!(rendered.contains(&format!("\"uuid\": \"{UUID}\"")));
    }

    #[test]
    fn rendered_extension_uses_build_identity() {
        let rendered = render_extension_asset(EXTENSION_JS);

        assert!(rendered.contains(&format!(
            "const SERVICE_NAME = '{service}'",
            service = identity::DBUS_SERVICE
        )));
        assert!(rendered.contains(&format!(
            "const OBJECT_PATH = '{path}'",
            path = identity::DBUS_OBJECT_PATH
        )));
    }

    #[test]
    fn rendered_extension_exposes_screenshot_capture() {
        let rendered = render_extension_asset(EXTENSION_JS);

        assert!(rendered.contains("<method name=\"CaptureScreenshot\">"));
        assert!(rendered.contains("CaptureScreenshotAsync"));
    }

    #[test]
    fn rendered_extension_canonicalizes_screenshot_paths() {
        let rendered = render_extension_asset(EXTENSION_JS);

        assert!(rendered.contains("GLib.canonicalize_filename(path, null)"));
        assert!(rendered.contains("GLib.path_get_dirname(canonicalPath) !== tmpDir"));
        assert!(rendered.contains("basename.startsWith('computer-use-linux-gnome-extension-')"));
    }
}
