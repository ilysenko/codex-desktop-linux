//! Read-only diagnostics for installed Codex Desktop Linux runtimes.

use crate::{
    config::{self, RuntimeConfig, RuntimePaths},
    liveness,
    state::PersistedState,
};
use anyhow::Result;
use serde::Serialize;
use std::{
    env, fs,
    path::{Path, PathBuf},
    time::Duration,
};

const DEFAULT_WEBVIEW_PORT: u16 = 5175;
const SIDE_BY_SIDE_WEBVIEW_PORT: u16 = 5176;
const WEBVIEW_TIMEOUT: Duration = Duration::from_secs(2);

type WebviewProbe = (String, bool, Option<u16>, Option<String>);

#[derive(Debug, Serialize)]
struct DiagnosticsReport {
    schema: &'static str,
    ok: bool,
    warnings: Vec<String>,
    update: UpdateDiagnostics,
    app: AppDiagnostics,
    webview: WebviewDiagnostics,
    warm_start: WarmStartDiagnostics,
    metadata: MetadataDiagnostics,
    paths: PathDiagnostics,
}

#[derive(Debug, Serialize)]
struct UpdateDiagnostics {
    status: String,
    installed_version: String,
    candidate_version: Option<String>,
    last_known_good_version: Option<String>,
    update_error: Option<String>,
    cli_status: String,
}

#[derive(Debug, Serialize)]
struct AppDiagnostics {
    executable_path: PathBuf,
    executable_exists: bool,
    running: bool,
    running_error: Option<String>,
    pid_file: PidFileDiagnostics,
}

#[derive(Debug, Serialize)]
struct PidFileDiagnostics {
    path: PathBuf,
    exists: bool,
    pid: Option<u32>,
    process_alive: Option<bool>,
}

#[derive(Debug, Serialize)]
struct WebviewDiagnostics {
    url: String,
    ok: bool,
    status: Option<u16>,
    error: Option<String>,
    pid_file: PidFileDiagnostics,
}

#[derive(Debug, Serialize)]
struct WarmStartDiagnostics {
    socket_path: PathBuf,
    socket_exists: bool,
}

#[derive(Debug, Serialize)]
struct MetadataDiagnostics {
    build_info_path: Option<PathBuf>,
    build_info_exists: bool,
    source_info_path: Option<PathBuf>,
    source_info_exists: bool,
}

#[derive(Debug, Serialize)]
struct PathDiagnostics {
    config_file: PathBuf,
    state_file: PathBuf,
    log_file: PathBuf,
    cache_dir: PathBuf,
    state_dir: PathBuf,
    builder_bundle_root: PathBuf,
}

/// Runs the diagnostics command.
pub async fn run(
    config: &RuntimeConfig,
    state: &PersistedState,
    paths: &RuntimePaths,
    json: bool,
) -> Result<()> {
    let report = collect(config, state, paths).await?;
    if json {
        println!("{}", serde_json::to_string_pretty(&report)?);
    } else {
        print_text(&report);
    }
    Ok(())
}

async fn collect(
    config: &RuntimeConfig,
    state: &PersistedState,
    paths: &RuntimePaths,
) -> Result<DiagnosticsReport> {
    let webview = check_webview(webview_url()).await;
    collect_with_webview(config, state, paths, webview)
}

fn collect_with_webview(
    config: &RuntimeConfig,
    state: &PersistedState,
    paths: &RuntimePaths,
    webview: WebviewProbe,
) -> Result<DiagnosticsReport> {
    let running = liveness::is_app_running(config);
    let app_running = running.as_ref().copied().unwrap_or(false);
    let app_state_dir = config::resolve_app_state_dir()?;
    let app_pid_file = app_state_dir.join("app.pid");
    let webview_pid_file = app_state_dir.join("webview.pid");
    let metadata = metadata_diagnostics(config);
    let app = AppDiagnostics {
        executable_path: config.app_executable_path.clone(),
        executable_exists: config.app_executable_path.exists(),
        running: app_running,
        running_error: running.err().map(|error| error.to_string()),
        pid_file: pid_file_diagnostics(&app_pid_file),
    };
    let report_without_warnings = DiagnosticsReport {
        schema: "codex-update-manager/diagnostics/v1",
        ok: false,
        warnings: Vec::new(),
        update: UpdateDiagnostics {
            status: format!("{:?}", state.status),
            installed_version: state.installed_version.clone(),
            candidate_version: state.candidate_version.clone(),
            last_known_good_version: state.last_known_good_version.clone(),
            update_error: state.error_message.clone(),
            cli_status: format!("{:?}", state.cli_status),
        },
        app,
        webview: WebviewDiagnostics {
            url: webview.0,
            ok: webview.1,
            status: webview.2,
            error: webview.3,
            pid_file: pid_file_diagnostics(&webview_pid_file),
        },
        warm_start: WarmStartDiagnostics {
            socket_path: launch_action_socket_path()?,
            socket_exists: false,
        },
        metadata,
        paths: PathDiagnostics {
            config_file: paths.config_file.clone(),
            state_file: paths.state_file.clone(),
            log_file: paths.log_file.clone(),
            cache_dir: paths.cache_dir.clone(),
            state_dir: paths.state_dir.clone(),
            builder_bundle_root: config.builder_bundle_root.clone(),
        },
    };

    let mut report = DiagnosticsReport {
        warm_start: WarmStartDiagnostics {
            socket_exists: report_without_warnings.warm_start.socket_path.exists(),
            ..report_without_warnings.warm_start
        },
        ..report_without_warnings
    };
    report.warnings = diagnostics_warnings(&report);
    report.ok = report.warnings.is_empty();
    Ok(report)
}

fn print_text(report: &DiagnosticsReport) {
    println!(
        "diagnostics: {}",
        if report.ok { "ok" } else { "attention" }
    );
    for warning in &report.warnings {
        println!("warning: {warning}");
    }
    println!(
        "update: status={} installed={} candidate={} error={}",
        report.update.status,
        report.update.installed_version,
        report.update.candidate_version.as_deref().unwrap_or("none"),
        report.update.update_error.as_deref().unwrap_or("none")
    );
    println!(
        "app: executable={} exists={} running={}",
        report.app.executable_path.display(),
        report.app.executable_exists,
        report.app.running
    );
    println!(
        "app_pid: path={} pid={} alive={}",
        report.app.pid_file.path.display(),
        optional_pid(report.app.pid_file.pid),
        optional_bool(report.app.pid_file.process_alive)
    );
    println!(
        "webview: url={} ok={} status={} error={}",
        report.webview.url,
        report.webview.ok,
        report
            .webview
            .status
            .map(|value| value.to_string())
            .unwrap_or_else(|| "none".to_string()),
        report.webview.error.as_deref().unwrap_or("none")
    );
    println!(
        "webview_pid: path={} pid={} alive={}",
        report.webview.pid_file.path.display(),
        optional_pid(report.webview.pid_file.pid),
        optional_bool(report.webview.pid_file.process_alive)
    );
    println!(
        "warm_start: socket={} exists={}",
        report.warm_start.socket_path.display(),
        report.warm_start.socket_exists
    );
    println!(
        "metadata: build_info={} exists={} source_info={} exists={}",
        optional_path(report.metadata.build_info_path.as_ref()),
        report.metadata.build_info_exists,
        optional_path(report.metadata.source_info_path.as_ref()),
        report.metadata.source_info_exists
    );
}

fn diagnostics_warnings(report: &DiagnosticsReport) -> Vec<String> {
    let mut warnings = Vec::new();
    if !report.app.executable_exists {
        warnings.push("app executable is missing".to_string());
    }
    if report.update.update_error.is_some() {
        warnings.push("updater state has an update error".to_string());
    }
    if report.app.running && !report.webview.ok {
        warnings.push("app is running but webview did not respond".to_string());
    }
    if report.app.running && report.app.pid_file.pid.is_none() {
        warnings.push("app is running but app.pid is missing or invalid".to_string());
    }
    if report.app.running
        && report.webview.pid_file.exists
        && report.webview.pid_file.process_alive == Some(false)
    {
        warnings.push("webview.pid points to a dead process".to_string());
    }
    if !report.metadata.build_info_exists {
        warnings.push("Linux build-info metadata is missing".to_string());
    }
    warnings
}

async fn check_webview(url: String) -> (String, bool, Option<u16>, Option<String>) {
    let client = reqwest::Client::new();
    let request = client.get(&url).timeout(WEBVIEW_TIMEOUT);
    match request.send().await {
        Ok(response) => {
            let status = response.status().as_u16();
            (url, response.status().is_success(), Some(status), None)
        }
        Err(error) => (url, false, None, Some(error.to_string())),
    }
}

fn webview_url() -> String {
    let port = webview_port();
    format!("http://127.0.0.1:{port}/")
}

fn webview_port() -> u16 {
    env::var("CODEX_WEBVIEW_PORT")
        .ok()
        .and_then(|value| parse_tcp_port(&value))
        .or_else(|| {
            env::var("CODEX_LINUX_WEBVIEW_PORT")
                .ok()
                .and_then(|value| parse_tcp_port(&value))
        })
        .unwrap_or_else(default_webview_port)
}

fn default_webview_port() -> u16 {
    if config::resolve_app_id() == config::DEFAULT_APP_ID {
        DEFAULT_WEBVIEW_PORT
    } else {
        SIDE_BY_SIDE_WEBVIEW_PORT
    }
}

fn parse_tcp_port(value: &str) -> Option<u16> {
    let port = value.parse::<u32>().ok()?;
    if (1..=u16::MAX as u32).contains(&port) {
        Some(port as u16)
    } else {
        None
    }
}

fn pid_file_diagnostics(path: &Path) -> PidFileDiagnostics {
    let pid = read_pid(path);
    PidFileDiagnostics {
        path: path.to_path_buf(),
        exists: path.exists(),
        pid,
        process_alive: pid.map(process_alive),
    }
}

fn read_pid(path: &Path) -> Option<u32> {
    fs::read_to_string(path).ok()?.trim().parse::<u32>().ok()
}

fn process_alive(pid: u32) -> bool {
    Path::new("/proc").join(pid.to_string()).exists()
}

fn metadata_diagnostics(config: &RuntimeConfig) -> MetadataDiagnostics {
    let build_info_path = first_existing_or_first(build_info_paths(config));
    let source_info_path = first_existing_or_first(source_info_paths(config));
    MetadataDiagnostics {
        build_info_exists: build_info_path.as_ref().is_some_and(|path| path.exists()),
        source_info_exists: source_info_path.as_ref().is_some_and(|path| path.exists()),
        build_info_path,
        source_info_path,
    }
}

fn build_info_paths(config: &RuntimeConfig) -> Vec<PathBuf> {
    config
        .app_executable_path
        .parent()
        .map(|app_root| {
            vec![
                app_root.join(".codex-linux/build-info.json"),
                app_root.join("resources/codex-linux-build-info.json"),
            ]
        })
        .unwrap_or_default()
}

fn source_info_paths(config: &RuntimeConfig) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(app_root) = config.app_executable_path.parent() {
        paths.push(app_root.join(".codex-linux/source-info.json"));
    }
    paths.push(
        config
            .builder_bundle_root
            .join(".codex-linux/source-info.json"),
    );
    paths
}

fn first_existing_or_first(paths: Vec<PathBuf>) -> Option<PathBuf> {
    paths
        .iter()
        .find(|path| path.exists())
        .cloned()
        .or_else(|| paths.into_iter().next())
}

fn launch_action_socket_path() -> Result<PathBuf> {
    let app_id = config::resolve_app_id();
    let instance_id = config::resolve_launch_instance_id();
    if let Some(base) = env::var_os("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
    {
        let root = base.join(app_id);
        return Ok(match instance_id {
            Some(instance) => root
                .join("instances")
                .join(instance)
                .join("launch-action.sock"),
            None => root.join("launch-action.sock"),
        });
    }

    Ok(config::resolve_app_state_dir()?.join("launch-action.sock"))
}

fn optional_path(path: Option<&PathBuf>) -> String {
    path.map(|path| path.display().to_string())
        .unwrap_or_else(|| "none".to_string())
}

fn optional_pid(pid: Option<u32>) -> String {
    pid.map(|value| value.to_string())
        .unwrap_or_else(|| "none".to_string())
}

fn optional_bool(value: Option<bool>) -> String {
    value
        .map(|flag| flag.to_string())
        .unwrap_or_else(|| "unknown".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        config::{RuntimeConfig, RuntimePaths},
        state::PersistedState,
        test_util::{env_lock, EnvRestoreGuard},
    };
    use anyhow::Result;

    fn test_paths(root: &Path) -> RuntimePaths {
        RuntimePaths {
            config_file: root.join("config/config.toml"),
            state_file: root.join("state/state.json"),
            log_file: root.join("state/service.log"),
            cache_dir: root.join("cache"),
            state_dir: root.join("state"),
            config_dir: root.join("config"),
        }
    }

    fn test_config(root: &Path) -> RuntimeConfig {
        let paths = test_paths(root);
        let mut config = RuntimeConfig::default_with_paths(&paths);
        config.app_executable_path = root.join("app/electron");
        config.builder_bundle_root = root.join("builder");
        config
    }

    #[test]
    fn app_runtime_paths_follow_app_id_and_instance() -> Result<()> {
        let _env_guard = env_lock();
        let _restore_env = EnvRestoreGuard::capture(&[
            "CODEX_LINUX_APP_ID",
            "CODEX_APP_ID",
            "CODEX_LINUX_INSTANCE_ID",
            "XDG_RUNTIME_DIR",
        ]);
        env::set_var("CODEX_LINUX_APP_ID", "codex-test");
        env::set_var("CODEX_LINUX_INSTANCE_ID", "port-6176");
        env::set_var("XDG_RUNTIME_DIR", "/tmp/codex-runtime-test");

        assert!(config::resolve_app_state_dir()?.ends_with("codex-test/instances/port-6176"));
        assert_eq!(
            launch_action_socket_path()?,
            PathBuf::from(
                "/tmp/codex-runtime-test/codex-test/instances/port-6176/launch-action.sock"
            )
        );
        Ok(())
    }

    #[test]
    fn launch_socket_uses_runtime_dir_and_instance() -> Result<()> {
        let _env_guard = env_lock();
        let _restore_env = EnvRestoreGuard::capture(&[
            "CODEX_LINUX_APP_ID",
            "CODEX_APP_ID",
            "CODEX_LINUX_INSTANCE_ID",
            "XDG_RUNTIME_DIR",
        ]);
        env::set_var("CODEX_LINUX_APP_ID", "codex-test");
        env::set_var("CODEX_LINUX_INSTANCE_ID", "sidecar");
        env::set_var("XDG_RUNTIME_DIR", "/tmp/codex-runtime-test");

        assert_eq!(
            launch_action_socket_path()?,
            PathBuf::from(
                "/tmp/codex-runtime-test/codex-test/instances/sidecar/launch-action.sock"
            )
        );
        Ok(())
    }

    #[test]
    fn webview_port_matches_launcher_precedence() {
        let _env_guard = env_lock();
        let _restore_env = EnvRestoreGuard::capture(&[
            "CODEX_WEBVIEW_PORT",
            "CODEX_LINUX_WEBVIEW_PORT",
            "CODEX_LINUX_APP_ID",
            "CODEX_APP_ID",
        ]);
        env::set_var("CODEX_LINUX_APP_ID", "codex-side");
        env::remove_var("CODEX_WEBVIEW_PORT");
        env::remove_var("CODEX_LINUX_WEBVIEW_PORT");
        assert_eq!(webview_port(), SIDE_BY_SIDE_WEBVIEW_PORT);

        env::set_var("CODEX_LINUX_WEBVIEW_PORT", "6176");
        assert_eq!(webview_port(), 6176);

        env::set_var("CODEX_WEBVIEW_PORT", "6177");
        assert_eq!(webview_port(), 6177);
    }

    #[test]
    fn metadata_prefers_existing_build_info_paths() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let config = test_config(temp.path());
        fs::create_dir_all(temp.path().join("app/resources"))?;
        fs::write(
            temp.path()
                .join("app/resources/codex-linux-build-info.json"),
            "{}",
        )?;

        let metadata = metadata_diagnostics(&config);

        assert_eq!(
            metadata.build_info_path.as_deref(),
            Some(
                temp.path()
                    .join("app/resources/codex-linux-build-info.json")
                    .as_path()
            )
        );
        assert!(metadata.build_info_exists);
        Ok(())
    }

    #[test]
    fn warnings_flag_running_app_with_dead_webview_pid() {
        let temp = tempfile::tempdir().unwrap();
        let config = test_config(temp.path());
        let paths = test_paths(temp.path());
        let report = DiagnosticsReport {
            schema: "codex-update-manager/diagnostics/v1",
            ok: false,
            warnings: Vec::new(),
            update: UpdateDiagnostics {
                status: "Idle".to_string(),
                installed_version: "test".to_string(),
                candidate_version: None,
                last_known_good_version: None,
                update_error: None,
                cli_status: "Unknown".to_string(),
            },
            app: AppDiagnostics {
                executable_path: config.app_executable_path,
                executable_exists: true,
                running: true,
                running_error: None,
                pid_file: PidFileDiagnostics {
                    path: paths.state_dir.join("codex-desktop/app.pid"),
                    exists: true,
                    pid: Some(std::process::id()),
                    process_alive: Some(true),
                },
            },
            webview: WebviewDiagnostics {
                url: "http://127.0.0.1:5175/".to_string(),
                ok: false,
                status: None,
                error: Some("connection refused".to_string()),
                pid_file: PidFileDiagnostics {
                    path: paths.state_dir.join("codex-desktop/webview.pid"),
                    exists: true,
                    pid: Some(u32::MAX),
                    process_alive: Some(false),
                },
            },
            warm_start: WarmStartDiagnostics {
                socket_path: paths.state_dir.join("codex-desktop/launch-action.sock"),
                socket_exists: false,
            },
            metadata: MetadataDiagnostics {
                build_info_path: Some(PathBuf::from("/missing/build-info.json")),
                build_info_exists: true,
                source_info_path: None,
                source_info_exists: false,
            },
            paths: PathDiagnostics {
                config_file: paths.config_file,
                state_file: paths.state_file,
                log_file: paths.log_file,
                cache_dir: paths.cache_dir,
                state_dir: paths.state_dir,
                builder_bundle_root: config.builder_bundle_root,
            },
        };

        let warnings = diagnostics_warnings(&report);

        assert!(warnings
            .iter()
            .any(|item| item == "app is running but webview did not respond"));
        assert!(warnings
            .iter()
            .any(|item| item == "webview.pid points to a dead process"));
    }

    #[test]
    fn collect_marks_missing_metadata_without_failing() -> Result<()> {
        let _env_guard = env_lock();
        let _restore_env = EnvRestoreGuard::capture(&[
            "CODEX_WEBVIEW_PORT",
            "CODEX_LINUX_WEBVIEW_PORT",
            "CODEX_LINUX_APP_ID",
            "CODEX_APP_ID",
            "CODEX_LINUX_INSTANCE_ID",
            "XDG_RUNTIME_DIR",
        ]);
        env::set_var("CODEX_WEBVIEW_PORT", "9");
        env::set_var("CODEX_LINUX_APP_ID", "codex-test");
        env::set_var("XDG_RUNTIME_DIR", "/tmp/codex-runtime-test");
        let temp = tempfile::tempdir()?;
        let paths = test_paths(temp.path());
        paths.ensure_dirs()?;
        let config = test_config(temp.path());
        let state = PersistedState::new(true);
        let webview = (
            webview_url(),
            false,
            None,
            Some("connection refused".to_string()),
        );

        let report = collect_with_webview(&config, &state, &paths, webview)?;

        assert!(!report.ok);
        assert!(report
            .warnings
            .iter()
            .any(|item| item == "app executable is missing"));
        assert!(report
            .warnings
            .iter()
            .any(|item| item == "Linux build-info metadata is missing"));
        Ok(())
    }
}
