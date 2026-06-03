//! Rebuilds native Linux packages from a downloaded upstream DMG.

use crate::{
    codex_cli,
    config::{RuntimeConfig, RuntimePaths},
    install::PackageKind,
    state::{ArtifactPaths, PersistedState, UpdateStatus},
};
use anyhow::{Context, Result};
use std::{
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
};
use tokio::process::Command;
use tracing::info;

const REQUIRED_BUNDLE_FILES: [(&str, &str); 19] = [
    ("Cargo.toml", "Cargo.toml"),
    ("Cargo.lock", "Cargo.lock"),
    ("computer-use-linux", "computer-use-linux"),
    ("read-aloud-linux", "read-aloud-linux"),
    ("updater", "updater"),
    (
        "plugins/openai-bundled/plugins/computer-use",
        "plugins/openai-bundled/plugins/computer-use",
    ),
    (
        "plugins/openai-bundled/plugins/read-aloud",
        "plugins/openai-bundled/plugins/read-aloud",
    ),
    ("install.sh", "install.sh"),
    ("launcher/start.sh.template", "launcher/start.sh.template"),
    ("launcher/webview-server.py", "launcher/webview-server.py"),
    ("scripts/build-deb.sh", "scripts/build-deb.sh"),
    (
        "scripts/patch-linux-window-ui.js",
        "scripts/patch-linux-window-ui.js",
    ),
    (
        "scripts/app-server-schema-guard.js",
        "scripts/app-server-schema-guard.js",
    ),
    ("scripts/patches", "scripts/patches"),
    ("scripts/lib", "scripts/lib"),
    ("scripts/ci", "scripts/ci"),
    ("packaging/linux", "packaging/linux"),
    ("assets/codex.png", "assets/codex.png"),
    ("linux-features", "linux-features"),
];
const OPTIONAL_BUNDLE_FILES: [(&str, &str); 5] = [
    ("CHANGELOG.md", "CHANGELOG.md"),
    (
        ".codex-linux/source-info.json",
        ".codex-linux/source-info.json",
    ),
    ("scripts/build-rpm.sh", "scripts/build-rpm.sh"),
    ("scripts/build-pacman.sh", "scripts/build-pacman.sh"),
    (
        "scripts/rebuild-candidate.sh",
        "scripts/rebuild-candidate.sh",
    ),
];
const PACMAN_PACKAGE_SUFFIXES: &[&str] = &[
    ".pkg.tar.zst",
    ".pkg.tar.xz",
    ".pkg.tar.gz",
    ".pkg.tar.bz2",
    ".pkg.tar.lz",
    ".pkg.tar.lz4",
    ".pkg.tar.lz5",
];

#[derive(Debug, Clone, PartialEq, Eq)]
/// Paths to the temporary workspace and generated package produced by a rebuild.
pub struct BuildArtifacts {
    pub workspace_dir: PathBuf,
    pub package_path: PathBuf,
}

/// Rebuilds a Linux package from the downloaded upstream DMG.
pub async fn build_update(
    config: &RuntimeConfig,
    state: &mut PersistedState,
    paths: &RuntimePaths,
    candidate_version: &str,
    dmg_path: &Path,
) -> Result<BuildArtifacts> {
    build_update_from(
        &config.builder_bundle_root,
        config,
        state,
        paths,
        candidate_version,
        dmg_path,
    )
    .await
}

/// Rebuilds a Linux package using an explicit wrapper/builder source tree.
pub async fn build_update_from(
    bundle_source: &Path,
    config: &RuntimeConfig,
    state: &mut PersistedState,
    paths: &RuntimePaths,
    candidate_version: &str,
    dmg_path: &Path,
) -> Result<BuildArtifacts> {
    let workspace = BuilderWorkspace::prepare(&config.workspace_root, candidate_version)?;
    let build_path = build_command_path(&config.builder_bundle_root);
    let managed_node_source = if config.builder_bundle_root.join("node-runtime").exists() {
        config.builder_bundle_root.join("node-runtime")
    } else {
        bundle_source.join("node-runtime")
    };

    state.status = UpdateStatus::PreparingWorkspace;
    state.artifact_paths.workspace_dir = Some(workspace.workspace_dir.clone());
    state.save(&paths.state_file)?;

    copy_builder_bundle(bundle_source, &workspace.bundle_dir)?;

    state.status = UpdateStatus::PatchingApp;
    state.save(&paths.state_file)?;
    let mut install = Command::new(workspace.bundle_dir.join("install.sh"));
    install
        .arg(dmg_path)
        .env("CODEX_INSTALL_DIR", &workspace.app_dir)
        .env(
            "CODEX_PATCH_REPORT_JSON",
            workspace.reports_dir.join("patch-report.json"),
        )
        .env(
            "CODEX_REBUILD_REPORT_JSON",
            workspace.reports_dir.join("rebuild-report.json"),
        )
        .env("CODEX_MANAGED_NODE_SOURCE", managed_node_source)
        .env("PATH", &build_path)
        .current_dir(&workspace.bundle_dir);
    // Honor the user's saved feature selection (the in-app Update feature picker
    // writes it to a stable per-user path) so the rebuild stages exactly those
    // features. Only set it when the file actually exists; an absent path would
    // make linux-features.js see an empty enabled set and stage nothing.
    if let Some(feature_config) = crate::config::effective_feature_config_path(config) {
        install.env("CODEX_LINUX_FEATURES_CONFIG", &feature_config);
    }
    run_and_log(&mut install, &workspace.install_log)
        .await
        .context("install.sh failed during local rebuild")?;

    let schema_guard_node = schema_guard_node_program(&config.builder_bundle_root);
    run_app_server_schema_guard(state, paths, &workspace, &build_path, &schema_guard_node)
        .await
        .context("app-server schema guard failed during local rebuild")?;

    state.status = UpdateStatus::BuildingPackage;
    state.save(&paths.state_file)?;

    let build_script = package_build_script(&workspace.bundle_dir);
    run_and_log(
        Command::new(&build_script)
            .env("PACKAGE_VERSION", candidate_version)
            .env("APP_DIR_OVERRIDE", &workspace.app_dir)
            .env("DIST_DIR_OVERRIDE", &workspace.dist_dir)
            .env("UPDATER_BINARY_SOURCE", std::env::current_exe()?)
            .env(
                "UPDATER_SERVICE_SOURCE",
                workspace
                    .bundle_dir
                    .join("packaging/linux/codex-update-manager.service"),
            )
            .env("PATH", &build_path)
            .current_dir(&workspace.bundle_dir),
        &workspace.build_log,
    )
    .await
    .with_context(|| format!("{} failed during local rebuild", build_script.display()))?;

    let package_path = find_package_in(&workspace.dist_dir)?;
    state.status = UpdateStatus::ReadyToInstall;
    state.artifact_paths = ArtifactPaths {
        dmg_path: Some(dmg_path.to_path_buf()),
        workspace_dir: Some(workspace.workspace_dir.clone()),
        package_path: Some(package_path.clone()),
        rollback_package_path: state.artifact_paths.rollback_package_path.clone(),
    };
    state.save(&paths.state_file)?;
    info!(candidate_version, package = %package_path.display(), "local update build ready");

    Ok(BuildArtifacts {
        workspace_dir: workspace.workspace_dir,
        package_path,
    })
}

#[derive(Debug, Clone)]
struct BuilderWorkspace {
    workspace_dir: PathBuf,
    bundle_dir: PathBuf,
    dist_dir: PathBuf,
    app_dir: PathBuf,
    reports_dir: PathBuf,
    install_log: PathBuf,
    schema_guard_log: PathBuf,
    build_log: PathBuf,
}

impl BuilderWorkspace {
    fn prepare(workspace_root: &Path, candidate_version: &str) -> Result<Self> {
        let workspace_dir = workspace_root.join("workspaces").join(candidate_version);
        let bundle_dir = workspace_dir.join("builder");
        let dist_dir = workspace_dir.join("dist");
        let app_dir = workspace_dir.join("codex-app");
        let logs_dir = workspace_dir.join("logs");
        let reports_dir = workspace_dir.join("reports");
        let install_log = logs_dir.join("install.log");
        let schema_guard_log = logs_dir.join("app-server-schema-guard.log");
        let build_log = logs_dir.join("build-package.log");

        if workspace_dir.exists() {
            fs::remove_dir_all(&workspace_dir)
                .with_context(|| format!("Failed to remove {}", workspace_dir.display()))?;
        }

        fs::create_dir_all(&logs_dir)
            .with_context(|| format!("Failed to create {}", logs_dir.display()))?;
        fs::create_dir_all(&reports_dir)
            .with_context(|| format!("Failed to create {}", reports_dir.display()))?;

        Ok(Self {
            workspace_dir,
            bundle_dir,
            dist_dir,
            app_dir,
            reports_dir,
            install_log,
            schema_guard_log,
            build_log,
        })
    }
}

fn schema_guard_cli_path(state: &PersistedState) -> Result<PathBuf> {
    codex_cli::resolve_cli_path(state.cli_path.as_deref())
        .context("Codex CLI is required to validate app-server schema during local rebuild")
}

fn schema_guard_node_program(builder_bundle_root: &Path) -> PathBuf {
    let managed_node = builder_bundle_root.join("node-runtime/bin/node");
    if managed_node.is_file() {
        managed_node
    } else {
        PathBuf::from("node")
    }
}

async fn run_app_server_schema_guard(
    state: &mut PersistedState,
    paths: &RuntimePaths,
    workspace: &BuilderWorkspace,
    build_path: &OsString,
    node_program: &Path,
) -> Result<()> {
    let cli_path = schema_guard_cli_path(state)?;
    state.cli_path = Some(cli_path.clone());
    state.save(&paths.state_file)?;

    run_and_log(
        Command::new(node_program)
            .arg(
                workspace
                    .bundle_dir
                    .join("scripts/app-server-schema-guard.js"),
            )
            .arg("--codex-bin")
            .arg(&cli_path)
            .arg("--json")
            .env("PATH", build_path)
            .current_dir(&workspace.bundle_dir),
        &workspace.schema_guard_log,
    )
    .await
}

/// Returns the path to the native-package build script appropriate for the running system.
fn package_build_script(bundle_dir: &Path) -> PathBuf {
    match PackageKind::detect() {
        PackageKind::Rpm => bundle_dir.join("scripts/build-rpm.sh"),
        PackageKind::Pacman => bundle_dir.join("scripts/build-pacman.sh"),
        PackageKind::Deb => bundle_dir.join("scripts/build-deb.sh"),
    }
}

fn copy_builder_bundle(source_root: &Path, destination_root: &Path) -> Result<()> {
    for (source, destination) in REQUIRED_BUNDLE_FILES {
        copy_entry(
            &source_root.join(source),
            &destination_root.join(destination),
            false,
        )?;
    }

    for (source, destination) in OPTIONAL_BUNDLE_FILES {
        copy_entry(
            &source_root.join(source),
            &destination_root.join(destination),
            true,
        )?;
    }

    Ok(())
}

fn copy_entry(source: &Path, destination: &Path, optional: bool) -> Result<()> {
    if !source.exists() {
        if optional {
            return Ok(());
        }
        anyhow::bail!(
            "Required builder bundle path is missing: {}",
            source.display()
        );
    }

    if source.is_dir() {
        copy_dir_recursive(source, destination)?;
    } else {
        copy_path(source, destination)?;
    }

    Ok(())
}

fn copy_path(source: &Path, destination: &Path) -> Result<()> {
    let parent = destination
        .parent()
        .context("Destination path has no parent directory")?;
    fs::create_dir_all(parent).with_context(|| format!("Failed to create {}", parent.display()))?;
    fs::copy(source, destination).with_context(|| {
        format!(
            "Failed to copy {} to {}",
            source.display(),
            destination.display()
        )
    })?;
    let metadata =
        fs::metadata(source).with_context(|| format!("Failed to stat {}", source.display()))?;
    fs::set_permissions(destination, metadata.permissions())
        .with_context(|| format!("Failed to set permissions on {}", destination.display()))?;
    Ok(())
}

fn copy_dir_recursive(source: &Path, destination: &Path) -> Result<()> {
    fs::create_dir_all(destination)
        .with_context(|| format!("Failed to create {}", destination.display()))?;

    for entry in
        fs::read_dir(source).with_context(|| format!("Failed to read {}", source.display()))?
    {
        let entry = entry?;
        let entry_path = entry.path();
        let destination_path = destination.join(entry.file_name());

        if entry.file_type()?.is_dir() {
            copy_dir_recursive(&entry_path, &destination_path)?;
        } else {
            copy_path(&entry_path, &destination_path)?;
        }
    }

    Ok(())
}

/// Find a native package file inside `dist_dir`.
fn find_package_in(dist_dir: &Path) -> Result<PathBuf> {
    for entry in
        fs::read_dir(dist_dir).with_context(|| format!("Failed to read {}", dist_dir.display()))?
    {
        let entry = entry?;
        let path = entry.path();
        if is_native_package_file(&path) {
            return Ok(path);
        }
    }

    anyhow::bail!(
        "No native package (.deb, .rpm, or .pkg.tar.*) found in {}",
        dist_dir.display()
    )
}

fn is_native_package_file(path: &Path) -> bool {
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    name.ends_with(".deb")
        || name.ends_with(".rpm")
        || PACMAN_PACKAGE_SUFFIXES
            .iter()
            .any(|suffix| name.ends_with(suffix))
}

fn build_command_path(builder_bundle_root: &Path) -> OsString {
    let mut entries = managed_node_bin_dirs(builder_bundle_root);
    entries.extend(preferred_node_bin_dirs());
    entries.extend(preferred_rust_bin_dirs());
    entries.extend(std::env::split_paths(
        &std::env::var_os("PATH").unwrap_or_default(),
    ));
    entries.extend(system_bin_dirs());
    std::env::join_paths(entries).unwrap_or_else(|_| std::env::var_os("PATH").unwrap_or_default())
}

fn managed_node_bin_dirs(builder_bundle_root: &Path) -> Vec<PathBuf> {
    let bin_dir = builder_bundle_root.join("node-runtime/bin");
    if is_node_toolchain_dir(&bin_dir) {
        vec![bin_dir]
    } else {
        Vec::new()
    }
}

fn system_bin_dirs() -> Vec<PathBuf> {
    [
        "/usr/local/sbin",
        "/usr/local/bin",
        "/usr/sbin",
        "/usr/bin",
        "/sbin",
        "/bin",
    ]
    .into_iter()
    .map(PathBuf::from)
    .collect()
}

fn preferred_node_bin_dirs() -> Vec<PathBuf> {
    let nvm_root = std::env::var_os("NVM_DIR")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".nvm")));

    let Some(nvm_root) = nvm_root else {
        return Vec::new();
    };

    collect_nvm_bin_dirs(&nvm_root)
}

fn preferred_rust_bin_dirs() -> Vec<PathBuf> {
    let Some(home) = std::env::var_os("HOME") else {
        return Vec::new();
    };

    let cargo_bin = PathBuf::from(home).join(".cargo/bin");
    if cargo_bin.join("cargo").is_file() {
        vec![cargo_bin]
    } else {
        Vec::new()
    }
}

fn collect_nvm_bin_dirs(nvm_root: &Path) -> Vec<PathBuf> {
    let mut directories = Vec::new();
    let mut seen = std::collections::BTreeSet::new();

    let current_bin = nvm_root.join("versions/node/current/bin");
    if is_node_toolchain_dir(&current_bin) {
        seen.insert(current_bin.clone());
        directories.push(current_bin);
    }

    let versions_root = nvm_root.join("versions/node");
    if let Ok(entries) = fs::read_dir(&versions_root) {
        let mut version_bins = entries
            .filter_map(|entry| entry.ok().map(|item| item.path().join("bin")))
            .filter(|path| is_node_toolchain_dir(path))
            .collect::<Vec<_>>();
        version_bins.sort();
        version_bins.reverse();

        for path in version_bins {
            if seen.insert(path.clone()) {
                directories.push(path);
            }
        }
    }

    directories
}

fn is_node_toolchain_dir(path: &Path) -> bool {
    ["node", "npm", "npx"]
        .into_iter()
        .all(|binary| path.join(binary).is_file())
}

async fn run_and_log(command: &mut Command, log_path: &Path) -> Result<()> {
    let output = command
        .output()
        .await
        .context("Failed to spawn external command")?;

    let mut combined = Vec::new();
    combined.extend_from_slice(&output.stdout);
    combined.extend_from_slice(&output.stderr);
    fs::write(log_path, redact_command_log(&combined))
        .with_context(|| format!("Failed to write {}", log_path.display()))?;

    if !output.status.success() {
        anyhow::bail!(
            "Command failed with status {:?}; see {}",
            output.status.code(),
            log_path.display()
        );
    }

    Ok(())
}

fn redact_command_log(bytes: &[u8]) -> Vec<u8> {
    let text = String::from_utf8_lossy(bytes);
    let without_pem = redact_pem_blocks(&text);
    let without_bearer = redact_after_prefix(
        &redact_after_prefix(&without_pem, "Bearer ", "Bearer <redacted>"),
        "bearer ",
        "bearer <redacted>",
    );
    let without_api_keys = redact_prefixed_token(&without_bearer, "sk-", "sk-<redacted>");
    redact_sensitive_fields(&without_api_keys).into_bytes()
}

fn redact_sensitive_fields(input: &str) -> String {
    const FIELDS: &[&str] = &[
        "pairingCode",
        "pairing_code",
        "accountId",
        "account_id",
        "accountUserId",
        "account_user_id",
        "accessToken",
        "access_token",
        "apiKey",
        "api_key",
        "authToken",
        "auth_token",
        "authorization",
        "browserProfile",
        "browser_profile",
        "browserProfilePath",
        "browser_profile_path",
        "conversationId",
        "conversation_id",
        "cookie",
        "cookies",
        "deviceKey",
        "device_key",
        "email",
        "idToken",
        "id_token",
        "clientId",
        "client_id",
        "clientSecret",
        "client_secret",
        "installationId",
        "installation_id",
        "environmentId",
        "environment_id",
        "keyId",
        "key_id",
        "password",
        "privateKey",
        "private_key",
        "privateKeyPkcs8Pem",
        "private_key_pkcs8_pem",
        "profilePath",
        "profile_path",
        "refreshToken",
        "refresh_token",
        "remoteControlToken",
        "remote_control_token",
        "secret",
        "sensitive",
        "stepUpToken",
        "step_up_token",
        "tabTitle",
        "tabUrl",
        "threadId",
        "thread_id",
        "conversationText",
        "threadPreview",
        "token",
        "screenshot",
    ];
    let mut output = redact_url_tokens(input);
    for field in FIELDS {
        output = redact_named_field(&output, field);
    }
    output
}

fn redact_url_tokens(input: &str) -> String {
    let with_https = redact_after_prefix(input, "https://", "<url-redacted>");
    redact_after_prefix(&with_https, "http://", "<url-redacted>")
}

fn redact_named_field(input: &str, field: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut search_start = 0;

    while let Some(relative_index) = input[search_start..].find(field) {
        let field_start = search_start + relative_index;
        if let Some((value_start, value_end)) = field_value_span(input, field, field_start) {
            output.push_str(&input[search_start..value_start]);
            output.push_str("<redacted>");
            search_start = value_end;
        } else {
            let field_end = field_start + field.len();
            output.push_str(&input[search_start..field_end]);
            search_start = field_end;
        }
    }

    output.push_str(&input[search_start..]);
    output
}

fn field_value_span(input: &str, field: &str, field_start: usize) -> Option<(usize, usize)> {
    let field_end = field_start + field.len();
    let previous = input[..field_start].chars().next_back();
    let next = input[field_end..].chars().next();

    let delimiter_start = if matches!(previous, Some('"') | Some('\'')) && next == previous {
        field_end + next?.len_utf8()
    } else {
        if previous.is_some_and(is_identifier_char) || next.is_some_and(is_identifier_char) {
            return None;
        }
        field_end
    };

    let delimiter_index = skip_whitespace(input, delimiter_start);
    let delimiter = input[delimiter_index..].chars().next()?;
    if !matches!(delimiter, ':' | '=') {
        return None;
    }

    let value_start = skip_whitespace(input, delimiter_index + delimiter.len_utf8());
    let value_char = input[value_start..].chars().next()?;
    if matches!(value_char, '"' | '\'') {
        let content_start = value_start + value_char.len_utf8();
        return find_closing_quote(input, content_start, value_char)
            .map(|content_end| (content_start, content_end));
    }
    if value_char == '{' {
        return find_balanced_value(input, value_start, '{', '}')
            .map(|value_end| (value_start, value_end));
    }
    if value_char == '[' {
        return find_balanced_value(input, value_start, '[', ']')
            .map(|value_end| (value_start, value_end));
    }

    let value_end = input[value_start..]
        .find(|ch: char| {
            ch.is_whitespace() || matches!(ch, '"' | '\'' | ',' | ';' | ')' | '}' | ']')
        })
        .map(|end| value_start + end)
        .unwrap_or(input.len());
    (value_end > value_start).then_some((value_start, value_end))
}

fn is_identifier_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-')
}

fn skip_whitespace(input: &str, start: usize) -> usize {
    let mut index = start;
    for ch in input[start..].chars() {
        if !ch.is_whitespace() {
            break;
        }
        index += ch.len_utf8();
    }
    index
}

fn find_closing_quote(input: &str, start: usize, quote: char) -> Option<usize> {
    let mut escaped = false;
    for (offset, ch) in input[start..].char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if ch == '\\' {
            escaped = true;
            continue;
        }
        if ch == quote {
            return Some(start + offset);
        }
    }
    None
}

fn find_balanced_value(input: &str, start: usize, open: char, close: char) -> Option<usize> {
    let mut depth = 0usize;
    let mut quoted = None;
    let mut escaped = false;
    for (offset, ch) in input[start..].char_indices() {
        if let Some(quote) = quoted {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == quote {
                quoted = None;
            }
            continue;
        }

        if matches!(ch, '"' | '\'') {
            quoted = Some(ch);
        } else if ch == open {
            depth += 1;
        } else if ch == close {
            depth = depth.saturating_sub(1);
            if depth == 0 {
                return Some(start + offset + ch.len_utf8());
            }
        }
    }
    None
}

fn redact_pem_blocks(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(start) = rest.find("-----BEGIN ") {
        output.push_str(&rest[..start]);
        output.push_str("<pem-redacted>");
        let after_begin = &rest[start + "-----BEGIN ".len()..];
        let Some(end_relative) = after_begin.find("-----END ") else {
            rest = "";
            break;
        };
        let after_end = &after_begin[end_relative + "-----END ".len()..];
        let Some(end_marker_relative) = after_end.find("-----") else {
            rest = "";
            break;
        };
        rest = &after_end[end_marker_relative + "-----".len()..];
    }
    output.push_str(rest);
    output
}

fn redact_after_prefix(input: &str, prefix: &str, replacement: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(index) = rest.find(prefix) {
        output.push_str(&rest[..index]);
        output.push_str(replacement);
        let token_start = index + prefix.len();
        let token_end = rest[token_start..]
            .find(|ch: char| ch.is_whitespace() || matches!(ch, '"' | '\'' | ',' | ';' | ')'))
            .map(|end| token_start + end)
            .unwrap_or(rest.len());
        rest = &rest[token_end..];
    }
    output.push_str(rest);
    output
}

fn redact_prefixed_token(input: &str, prefix: &str, replacement: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(index) = rest.find(prefix) {
        output.push_str(&rest[..index]);
        output.push_str(replacement);
        let token_end = rest[index..]
            .find(|ch: char| ch.is_whitespace() || matches!(ch, '"' | '\'' | ',' | ';' | ')'))
            .map(|end| index + end)
            .unwrap_or(rest.len());
        rest = &rest[token_end..];
    }
    output.push_str(rest);
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::RuntimePaths;
    use anyhow::Result;
    use tempfile::tempdir;

    enum FakePackageOutput {
        Deb,
        Rpm,
        Pacman,
    }

    fn write_fake_build_script(path: &Path, output: FakePackageOutput) -> Result<()> {
        let script_body = match output {
            FakePackageOutput::Deb => {
                r#"#!/bin/bash
set -euo pipefail
mkdir -p "${DIST_DIR_OVERRIDE}"
touch "${DIST_DIR_OVERRIDE}/codex-desktop_${PACKAGE_VERSION}_amd64.deb"
"#
            }
            FakePackageOutput::Rpm => {
                r#"#!/bin/bash
set -euo pipefail
mkdir -p "${DIST_DIR_OVERRIDE}"
touch "${DIST_DIR_OVERRIDE}/codex-desktop-${PACKAGE_VERSION}.x86_64.rpm"
"#
            }
            FakePackageOutput::Pacman => {
                r#"#!/bin/bash
set -euo pipefail
VER="${PACKAGE_VERSION%%+*}"
mkdir -p "${DIST_DIR_OVERRIDE}"
touch "${DIST_DIR_OVERRIDE}/codex-desktop-${VER}-1-x86_64.pkg.tar.zst"
"#
            }
        };

        fs::write(path, script_body)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(0o755))?;
        }
        Ok(())
    }

    fn write_fake_computer_use_bundle(root: &Path) -> Result<()> {
        fs::write(
            root.join("Cargo.toml"),
            b"[workspace]\nmembers = [\"computer-use-linux\", \"read-aloud-linux\", \"updater\"]\n",
        )?;
        fs::write(root.join("Cargo.lock"), b"# fake lock\n")?;
        fs::create_dir_all(root.join("computer-use-linux/src"))?;
        fs::write(
            root.join("computer-use-linux/Cargo.toml"),
            b"[package]\nname = \"codex-computer-use-linux\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
        )?;
        fs::write(
            root.join("computer-use-linux/src/main.rs"),
            b"fn main() {}\n",
        )?;
        fs::create_dir_all(root.join("read-aloud-linux/src"))?;
        fs::write(
            root.join("read-aloud-linux/Cargo.toml"),
            b"[package]\nname = \"codex-read-aloud-linux\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
        )?;
        fs::write(root.join("read-aloud-linux/src/main.rs"), b"fn main() {}\n")?;
        fs::create_dir_all(root.join("updater/src"))?;
        fs::write(
            root.join("updater/Cargo.toml"),
            b"[package]\nname = \"codex-update-manager\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
        )?;
        fs::write(root.join("updater/src/main.rs"), b"fn main() {}\n")?;
        fs::create_dir_all(root.join("plugins/openai-bundled/plugins/computer-use/.codex-plugin"))?;
        fs::write(
            root.join("plugins/openai-bundled/plugins/computer-use/.codex-plugin/plugin.json"),
            b"{\"name\":\"computer-use\",\"version\":\"0.1.0\"}\n",
        )?;
        fs::write(
            root.join("plugins/openai-bundled/plugins/computer-use/.mcp.json"),
            b"{\"mcpServers\":{}}\n",
        )?;
        fs::create_dir_all(root.join("plugins/openai-bundled/plugins/read-aloud/.codex-plugin"))?;
        fs::write(
            root.join("plugins/openai-bundled/plugins/read-aloud/.codex-plugin/plugin.json"),
            b"{\"name\":\"read-aloud\",\"version\":\"0.1.0\"}\n",
        )?;
        fs::write(
            root.join("plugins/openai-bundled/plugins/read-aloud/.mcp.json"),
            b"{\"mcpServers\":{}}\n",
        )?;
        Ok(())
    }

    fn write_fake_linux_features_bundle(root: &Path) -> Result<()> {
        fs::create_dir_all(root.join("linux-features/example-feature"))?;
        fs::write(
            root.join("linux-features/features.example.json"),
            b"{\"enabled\":[]}\n",
        )?;
        fs::write(
            root.join("linux-features/example-feature/feature.json"),
            b"{\"id\":\"example-feature\"}\n",
        )?;
        Ok(())
    }

    #[tokio::test]
    async fn builds_update_with_fake_bundle() -> Result<()> {
        let temp = tempdir()?;
        let bundle_root = temp.path().join("bundle");
        let state_root = temp.path().join("state");
        let cache_root = temp.path().join("cache");
        fs::create_dir_all(bundle_root.join("scripts/lib"))?;
        fs::create_dir_all(bundle_root.join("scripts/ci"))?;
        fs::create_dir_all(bundle_root.join("scripts/patches"))?;
        fs::create_dir_all(bundle_root.join("launcher"))?;
        fs::create_dir_all(bundle_root.join("packaging/linux"))?;
        fs::create_dir_all(bundle_root.join("assets"))?;
        fs::create_dir_all(bundle_root.join(".codex-linux"))?;
        write_fake_computer_use_bundle(&bundle_root)?;
        write_fake_linux_features_bundle(&bundle_root)?;
        fs::write(bundle_root.join("CHANGELOG.md"), b"# Changelog\n")?;
        fs::write(
            bundle_root.join(".codex-linux/source-info.json"),
            b"{\"commit\":\"0123456789012345678901234567890123456789\",\"version\":\"0.8.1\"}\n",
        )?;
        fs::write(
            bundle_root.join("launcher/start.sh.template"),
            b"# fake launcher template\n",
        )?;
        fs::write(
            bundle_root.join("launcher/webview-server.py"),
            b"# fake webview server\n",
        )?;
        fs::write(bundle_root.join("assets/codex.png"), b"png")?;
        fs::write(
            bundle_root.join("packaging/linux/control"),
            "Package: codex",
        )?;
        fs::write(
            bundle_root.join("packaging/linux/codex-desktop.spec"),
            "Name: codex",
        )?;
        fs::write(
            bundle_root.join("packaging/linux/codex-desktop.desktop"),
            "[Desktop Entry]",
        )?;
        fs::write(
            bundle_root.join("packaging/linux/codex-update-manager.service"),
            "[Unit]\nDescription=Codex Update Manager\n",
        )?;
        fs::write(
            bundle_root.join("packaging/linux/codex-update-manager-user-service.sh"),
            "#!/bin/bash\n",
        )?;
        fs::write(
            bundle_root.join("packaging/linux/codex-update-manager.postinst"),
            "#!/bin/sh\nexit 0\n",
        )?;
        fs::write(
            bundle_root.join("packaging/linux/codex-update-manager.prerm"),
            "#!/bin/sh\nexit 0\n",
        )?;
        fs::write(
            bundle_root.join("packaging/linux/codex-update-manager.postrm"),
            "#!/bin/sh\nexit 0\n",
        )?;
        fs::write(
            bundle_root.join("packaging/linux/codex-packaged-runtime.sh"),
            "#!/bin/bash\n",
        )?;
        fs::write(
            bundle_root.join("packaging/linux/PKGBUILD.template"),
            "pkgname=codex\n",
        )?;
        fs::write(
            bundle_root.join("packaging/linux/codex-desktop.install"),
            "post_install() { :; }\n",
        )?;
        fs::write(
            bundle_root.join("install.sh"),
            r#"#!/bin/bash
set -euo pipefail
mkdir -p "${CODEX_INSTALL_DIR}"
echo launcher > "${CODEX_INSTALL_DIR}/start.sh"
chmod +x "${CODEX_INSTALL_DIR}/start.sh"
if [ -n "${CODEX_PATCH_REPORT_JSON:-}" ]; then
  mkdir -p "$(dirname "$CODEX_PATCH_REPORT_JSON")"
  printf '{"patches":[]}\n' > "${CODEX_PATCH_REPORT_JSON}"
fi
if [ -n "${CODEX_REBUILD_REPORT_JSON:-}" ]; then
  mkdir -p "$(dirname "$CODEX_REBUILD_REPORT_JSON")"
  printf '{"appDir":"%s"}\n' "${CODEX_INSTALL_DIR}" > "${CODEX_REBUILD_REPORT_JSON}"
fi
"#,
        )?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(
                bundle_root.join("install.sh"),
                fs::Permissions::from_mode(0o755),
            )?;
        }

        write_fake_build_script(
            &bundle_root.join("scripts/build-deb.sh"),
            FakePackageOutput::Deb,
        )?;
        write_fake_build_script(
            &bundle_root.join("scripts/build-rpm.sh"),
            FakePackageOutput::Rpm,
        )?;
        write_fake_build_script(
            &bundle_root.join("scripts/build-pacman.sh"),
            FakePackageOutput::Pacman,
        )?;
        fs::write(
            bundle_root.join("scripts/rebuild-candidate.sh"),
            b"#!/bin/bash\n",
        )?;
        fs::write(
            bundle_root.join("scripts/patch-linux-window-ui.js"),
            b"console.log('patched');\n",
        )?;
        fs::write(
            bundle_root.join("scripts/app-server-schema-guard.js"),
            b"#!/usr/bin/env node\n",
        )?;
        fs::write(
            bundle_root.join("scripts/patches/registry.js"),
            b"module.exports = {};\n",
        )?;
        fs::write(
            bundle_root.join("scripts/lib/package-common.sh"),
            b"#!/bin/bash\n",
        )?;
        fs::write(
            bundle_root.join("scripts/lib/node-runtime.sh"),
            b"#!/bin/bash\n",
        )?;
        fs::write(
            bundle_root.join("scripts/ci/validate-patch-report.js"),
            b"#!/usr/bin/env node\n",
        )?;

        let paths = RuntimePaths {
            config_file: temp.path().join("config/config.toml"),
            state_file: state_root.join("state.json"),
            log_file: state_root.join("service.log"),
            cache_dir: cache_root.clone(),
            state_dir: state_root.clone(),
            config_dir: temp.path().join("config"),
        };
        paths.ensure_dirs()?;

        let config = RuntimeConfig {
            dmg_url: "https://example.com/Codex.dmg".to_string(),
            initial_check_delay_seconds: 30,
            check_interval_hours: 6,
            auto_install_on_app_exit: true,
            notifications: true,
            workspace_root: cache_root,
            builder_bundle_root: bundle_root,
            app_executable_path: PathBuf::from("/opt/codex-desktop/electron"),
            enable_wrapper_updates: false,
            wrapper_remote: String::new(),
            wrapper_branch: "main".to_string(),
        };
        let dmg_path = temp.path().join("Codex.dmg");
        fs::write(&dmg_path, b"dmg")?;
        let fake_codex = temp.path().join("codex");
        fs::write(&fake_codex, b"#!/bin/sh\necho codex 0.0.0\n")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&fake_codex, fs::Permissions::from_mode(0o755))?;
        }

        let mut state = PersistedState::new(true);
        state.cli_path = Some(fake_codex.clone());
        let artifacts = build_update(
            &config,
            &mut state,
            &paths,
            "2026.03.24+abcd1234",
            &dmg_path,
        )
        .await?;
        assert_eq!(state.status, UpdateStatus::ReadyToInstall);
        assert!(artifacts.workspace_dir.exists());
        assert!(artifacts.package_path.exists());
        assert!(artifacts
            .workspace_dir
            .join("builder/scripts/rebuild-candidate.sh")
            .exists());
        assert!(artifacts
            .workspace_dir
            .join("builder/CHANGELOG.md")
            .exists());
        assert!(artifacts
            .workspace_dir
            .join("builder/.codex-linux/source-info.json")
            .exists());
        assert!(artifacts
            .workspace_dir
            .join("builder/launcher/webview-server.py")
            .exists());
        assert!(artifacts
            .workspace_dir
            .join("builder/scripts/lib/node-runtime.sh")
            .exists());
        assert!(artifacts
            .workspace_dir
            .join("builder/scripts/patches/registry.js")
            .exists());
        assert!(artifacts
            .workspace_dir
            .join("builder/scripts/app-server-schema-guard.js")
            .exists());
        assert!(artifacts
            .workspace_dir
            .join("builder/scripts/ci/validate-patch-report.js")
            .exists());
        assert!(artifacts
            .workspace_dir
            .join("builder/linux-features/features.example.json")
            .exists());
        assert!(artifacts
            .workspace_dir
            .join("reports/patch-report.json")
            .exists());
        assert!(artifacts
            .workspace_dir
            .join("reports/rebuild-report.json")
            .exists());
        assert!(artifacts
            .workspace_dir
            .join("logs/app-server-schema-guard.log")
            .exists());
        assert_eq!(state.cli_path.as_deref(), Some(fake_codex.as_path()));
        assert!(
            is_native_package_file(&artifacts.package_path),
            "expected a native package (.deb, .rpm, or .pkg.tar.zst), got {}",
            artifacts.package_path.display()
        );
        Ok(())
    }

    #[test]
    fn bundle_copy_skips_missing_optional_package_scripts() -> Result<()> {
        let temp = tempdir()?;
        let source_root = temp.path().join("source");
        let destination_root = temp.path().join("destination");

        fs::create_dir_all(source_root.join("scripts/lib"))?;
        fs::create_dir_all(source_root.join("scripts/ci"))?;
        fs::create_dir_all(source_root.join("scripts/patches"))?;
        fs::create_dir_all(source_root.join("launcher"))?;
        fs::create_dir_all(source_root.join("packaging/linux"))?;
        fs::create_dir_all(source_root.join("assets"))?;
        write_fake_computer_use_bundle(&source_root)?;
        write_fake_linux_features_bundle(&source_root)?;
        fs::write(source_root.join("install.sh"), b"#!/bin/bash\n")?;
        fs::write(
            source_root.join("launcher/start.sh.template"),
            b"# fake launcher template\n",
        )?;
        fs::write(
            source_root.join("launcher/webview-server.py"),
            b"# fake webview server\n",
        )?;
        fs::write(source_root.join("scripts/build-deb.sh"), b"#!/bin/bash\n")?;
        fs::write(
            source_root.join("scripts/patch-linux-window-ui.js"),
            b"console.log('patched');\n",
        )?;
        fs::write(
            source_root.join("scripts/app-server-schema-guard.js"),
            b"#!/usr/bin/env node\n",
        )?;
        fs::write(
            source_root.join("scripts/patches/registry.js"),
            b"module.exports = {};\n",
        )?;
        fs::write(
            source_root.join("scripts/lib/package-common.sh"),
            b"#!/bin/bash\n",
        )?;
        fs::write(
            source_root.join("scripts/lib/node-runtime.sh"),
            b"#!/bin/bash\n",
        )?;
        fs::write(
            source_root.join("scripts/ci/validate-patch-report.js"),
            b"#!/usr/bin/env node\n",
        )?;
        fs::write(
            source_root.join("packaging/linux/control"),
            b"Package: codex\n",
        )?;
        fs::write(
            source_root.join("packaging/linux/codex-update-manager.service"),
            b"[Unit]\nDescription=Codex Update Manager\n",
        )?;
        fs::write(source_root.join("assets/codex.png"), b"png")?;

        copy_builder_bundle(&source_root, &destination_root)?;

        assert!(destination_root.join("scripts/build-deb.sh").exists());
        assert!(destination_root
            .join("scripts/patch-linux-window-ui.js")
            .exists());
        assert!(destination_root
            .join("scripts/app-server-schema-guard.js")
            .exists());
        assert!(destination_root.join("launcher/webview-server.py").exists());
        assert!(destination_root
            .join("scripts/patches/registry.js")
            .exists());
        assert!(destination_root.join("computer-use-linux").exists());
        assert!(destination_root.join("read-aloud-linux").exists());
        assert!(destination_root.join("updater").exists());
        assert!(destination_root
            .join("plugins/openai-bundled/plugins/computer-use/.mcp.json")
            .exists());
        assert!(destination_root
            .join("plugins/openai-bundled/plugins/read-aloud/.mcp.json")
            .exists());
        assert!(destination_root
            .join("scripts/lib/node-runtime.sh")
            .exists());
        assert!(destination_root
            .join("scripts/ci/validate-patch-report.js")
            .exists());
        assert!(destination_root
            .join("linux-features/features.example.json")
            .exists());
        assert!(!destination_root.join("scripts/build-rpm.sh").exists());
        assert!(!destination_root.join("scripts/build-pacman.sh").exists());
        Ok(())
    }

    #[test]
    fn returns_error_when_dist_has_no_native_package() -> Result<()> {
        let temp = tempdir()?;
        fs::write(temp.path().join("README.txt"), b"no packages here")?;

        let error = find_package_in(temp.path()).expect_err("package discovery should fail");
        assert!(error
            .to_string()
            .contains("No native package (.deb, .rpm, or .pkg.tar.*)"));
        Ok(())
    }

    #[test]
    fn finds_pacman_package_in_dist_dir() -> Result<()> {
        let temp = tempdir()?;
        let pkg_path = temp
            .path()
            .join("codex-desktop-2026.03.30.120000-1-x86_64.pkg.tar.zst");
        fs::write(&pkg_path, b"pkg")?;

        let found = find_package_in(temp.path())?;
        assert_eq!(found, pkg_path);
        Ok(())
    }

    #[test]
    fn collects_nvm_toolchain_bins_with_current_first() -> Result<()> {
        let temp = tempdir()?;
        let nvm_root = temp.path().join(".nvm");
        let current_bin = nvm_root.join("versions/node/current/bin");
        let version_bin = nvm_root.join("versions/node/v24.2.0/bin");

        fs::create_dir_all(&current_bin)?;
        fs::create_dir_all(&version_bin)?;
        for dir in [&current_bin, &version_bin] {
            for binary in ["node", "npm", "npx"] {
                fs::write(dir.join(binary), b"bin")?;
            }
        }

        let directories = collect_nvm_bin_dirs(&nvm_root);
        assert_eq!(directories.first(), Some(&current_bin));
        assert!(directories.contains(&version_bin));
        Ok(())
    }

    #[test]
    fn build_command_path_includes_system_dirs() {
        let path = build_command_path(Path::new("/tmp/missing-codex-builder"));
        let directories = std::env::split_paths(&path).collect::<Vec<_>>();

        assert!(directories.iter().any(|dir| dir == Path::new("/usr/bin")));
        assert!(directories.iter().any(|dir| dir == Path::new("/bin")));
    }

    #[test]
    fn build_command_path_prefers_packaged_managed_node_runtime() -> Result<()> {
        let temp = tempdir()?;
        let runtime_bin = temp.path().join("node-runtime/bin");
        fs::create_dir_all(&runtime_bin)?;
        for binary in ["node", "npm", "npx"] {
            fs::write(runtime_bin.join(binary), b"bin")?;
        }

        let path = build_command_path(temp.path());
        let directories = std::env::split_paths(&path).collect::<Vec<_>>();
        assert_eq!(directories.first(), Some(&runtime_bin));
        Ok(())
    }

    #[test]
    fn schema_guard_node_program_prefers_packaged_managed_node() -> Result<()> {
        let temp = tempdir()?;
        let managed_node = temp.path().join("node-runtime/bin/node");
        fs::create_dir_all(managed_node.parent().unwrap())?;
        fs::write(&managed_node, b"bin")?;

        assert_eq!(schema_guard_node_program(temp.path()), managed_node);
        assert_eq!(
            schema_guard_node_program(&temp.path().join("missing")),
            PathBuf::from("node")
        );
        Ok(())
    }

    #[test]
    fn command_log_redaction_covers_private_app_state() -> Result<()> {
        let input = br#"schema guard failed Bearer secret-token bearer lower-secret sk-test-secret https://signed.example/path?token=url-fixture {"installationId":"install-fixture","tabUrl":"https://private.example/tab","tabTitle":"private tab fixture", "accountUserId" : "account-user-fixture", "privateKeyPkcs8Pem": "pkcs8-fixture"} deviceKey = "device-key-fixture" threadPreview=private-preview remote_control_token: remote-token-fixture sensitive:{error:"sensitive-fixture"} conversationId='conversation-fixture' stepUpToken = step-up-fixture -----BEGIN PRIVATE KEY----- pem-fixture -----END PRIVATE KEY-----"#;
        let output = String::from_utf8(redact_command_log(input))?;

        assert!(output.contains("Bearer <redacted>"));
        assert!(output.contains("bearer <redacted>"));
        assert!(output.contains("sk-<redacted>"));
        assert!(output.contains("<url-redacted>"));
        assert!(output.contains(r#""installationId":"<redacted>""#));
        assert!(output.contains(r#""tabUrl":"<redacted>""#));
        assert!(output.contains(r#""tabTitle":"<redacted>""#));
        assert!(output.contains(r#""accountUserId" : "<redacted>""#));
        assert!(output.contains(r#""privateKeyPkcs8Pem": "<redacted>""#));
        assert!(output.contains(r#"deviceKey = "<redacted>""#));
        assert!(output.contains("threadPreview=<redacted>"));
        assert!(output.contains("remote_control_token: <redacted>"));
        assert!(output.contains("sensitive:<redacted>"));
        assert!(output.contains("conversationId='<redacted>'"));
        assert!(output.contains("stepUpToken = <redacted>"));
        assert!(output.contains("<pem-redacted>"));
        for forbidden in [
            "secret-token",
            "lower-secret",
            "sk-test-secret",
            "signed.example",
            "install-fixture",
            "private.example",
            "private tab fixture",
            "account-user-fixture",
            "pkcs8-fixture",
            "device-key-fixture",
            "private-preview",
            "remote-token-fixture",
            "sensitive-fixture",
            "conversation-fixture",
            "step-up-fixture",
            "pem-fixture",
        ] {
            assert!(!output.contains(forbidden), "leaked {forbidden}");
        }
        Ok(())
    }

    #[test]
    fn build_command_path_includes_cargo_bin_from_home() -> Result<()> {
        let _env_guard = crate::test_util::env_lock();
        let temp = tempdir()?;
        let home_dir = temp.path().join("home");
        let cargo_bin = home_dir.join(".cargo/bin");
        fs::create_dir_all(&cargo_bin)?;
        fs::write(cargo_bin.join("cargo"), b"bin")?;

        let original_home = std::env::var_os("HOME");
        std::env::set_var("HOME", &home_dir);

        let path = build_command_path(Path::new("/tmp/missing-codex-builder"));

        if let Some(home) = original_home {
            std::env::set_var("HOME", home);
        } else {
            std::env::remove_var("HOME");
        }

        let directories = std::env::split_paths(&path).collect::<Vec<_>>();
        assert!(directories.iter().any(|dir| dir == &cargo_bin));
        Ok(())
    }
}
