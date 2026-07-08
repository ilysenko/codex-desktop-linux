//! Detects when the resolved Codex CLI is owned by a system package manager.

use std::{
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    process::Command,
};

const PACMAN_CANDIDATES: &[&str] = &["/usr/bin/pacman", "/bin/pacman"];
// Prefer the os-release family signal over enumerating Arch derivatives one by one.
// If a derivative does not advertise `ID_LIKE=arch`, we conservatively skip this path
// until we have distro-specific evidence that the pacman ownership workflow should apply.
const ARCH_LIKE_IDS: &[&str] = &["arch", "archlinux"];
const SYSTEM_CLI_ROOTS: &[&str] = &["/usr/bin", "/bin"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SystemPackageManagedCli {
    ManagedByPacman {
        package_name: String,
        query_path: PathBuf,
    },
    PacmanOwnershipUnknown {
        query_path: PathBuf,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PacmanPackageVersionStatus {
    pub latest_version: String,
    pub update_available: bool,
}

pub fn query_package_manager_version_status(
    managed_cli: &SystemPackageManagedCli,
    path_env: &OsString,
) -> Option<PacmanPackageVersionStatus> {
    let SystemPackageManagedCli::ManagedByPacman { package_name, .. } = managed_cli else {
        return None;
    };
    let pacman = query_pacman_program(path_env)?;
    let latest_version = query_pacman_sync_package_version(&pacman, path_env, package_name)?;
    let upgrade_version = query_pacman_upgrade_version(&pacman, path_env, package_name);
    let update_available = upgrade_version.is_some_and(|version| version == latest_version);
    Some(PacmanPackageVersionStatus {
        latest_version,
        update_available,
    })
}

pub fn detect_system_package_managed_cli(
    cli_path: &Path,
    path_env: &OsString,
) -> Option<SystemPackageManagedCli> {
    #[cfg(test)]
    if let Some(config) = test_detection_config(path_env) {
        return detect_with(cli_path, path_env, &config);
    }

    let config = DetectionConfig::runtime(path_env);
    detect_with(cli_path, path_env, &config)
}

#[derive(Debug, Clone)]
struct DetectionConfig {
    arch_like_host: bool,
    pacman_program: Option<PathBuf>,
    system_roots: Vec<PathBuf>,
}

impl DetectionConfig {
    fn runtime(path_env: &OsString) -> Self {
        Self {
            arch_like_host: arch_like_host(),
            pacman_program: pacman_program(path_env),
            system_roots: SYSTEM_CLI_ROOTS.iter().map(PathBuf::from).collect(),
        }
    }
}

fn detect_with(
    cli_path: &Path,
    path_env: &OsString,
    config: &DetectionConfig,
) -> Option<SystemPackageManagedCli> {
    if !config.arch_like_host {
        return None;
    }

    let query_path = system_cli_query_path(cli_path, &config.system_roots)?;
    let pacman = config.pacman_program.as_deref()?;

    match query_pacman_owner(pacman, path_env, &query_path) {
        Some(package_name) => Some(SystemPackageManagedCli::ManagedByPacman {
            package_name,
            query_path,
        }),
        None => Some(SystemPackageManagedCli::PacmanOwnershipUnknown { query_path }),
    }
}

fn system_cli_query_path(cli_path: &Path, system_roots: &[PathBuf]) -> Option<PathBuf> {
    let mut candidates = vec![cli_path.to_path_buf()];
    if let Ok(canonical_path) = fs::canonicalize(cli_path) {
        if !candidates
            .iter()
            .any(|existing| existing == &canonical_path)
        {
            candidates.push(canonical_path);
        }
    }

    candidates
        .into_iter()
        .find(|candidate| system_roots.iter().any(|root| candidate.starts_with(root)))
}

fn pacman_program(path_env: &OsString) -> Option<PathBuf> {
    PACMAN_CANDIDATES
        .iter()
        .map(PathBuf::from)
        .find(|path| path.is_file())
        .or_else(|| find_in_path("pacman", path_env))
}

fn query_pacman_program(path_env: &OsString) -> Option<PathBuf> {
    #[cfg(test)]
    if let Some(path) = std::env::var_os("CODEX_UPDATE_MANAGER_TEST_PACMAN_PATH") {
        return Some(PathBuf::from(path));
    }

    pacman_program(path_env)
}

fn query_pacman_owner(pacman: &Path, path_env: &OsString, query_path: &Path) -> Option<String> {
    let output = Command::new(pacman)
        .env("PATH", path_env)
        .args(["-Qo", "--"])
        .arg(query_path)
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    parse_pacman_owner(&String::from_utf8_lossy(&output.stdout))
}

fn parse_pacman_owner(raw: &str) -> Option<String> {
    let owned_by = raw.split_once(" is owned by ")?;
    owned_by.1.split_whitespace().next().map(ToOwned::to_owned)
}

fn query_pacman_sync_package_version(
    pacman: &Path,
    path_env: &OsString,
    package_name: &str,
) -> Option<String> {
    let output = Command::new(pacman)
        .env("PATH", path_env)
        .args(["-Si", "--", package_name])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    parse_pacman_info_version(&String::from_utf8_lossy(&output.stdout))
}

fn parse_pacman_info_version(raw: &str) -> Option<String> {
    raw.lines().find_map(|line| {
        let (field, value) = line.split_once(':')?;
        if field.trim() == "Version" {
            let version = value.trim();
            if version.is_empty() {
                None
            } else {
                Some(version.to_string())
            }
        } else {
            None
        }
    })
}

fn query_pacman_upgrade_version(
    pacman: &Path,
    path_env: &OsString,
    package_name: &str,
) -> Option<String> {
    let output = Command::new(pacman)
        .env("PATH", path_env)
        .args(["-Qu", "--", package_name])
        .output()
        .ok()?;

    if !output.status.success() || output.stdout.is_empty() {
        return None;
    }

    parse_pacman_upgrade_version(&String::from_utf8_lossy(&output.stdout))
}

fn parse_pacman_upgrade_version(raw: &str) -> Option<String> {
    raw.lines()
        .find_map(|line| line.split(" -> ").nth(1).map(str::trim))
        .filter(|version| !version.is_empty())
        .map(ToOwned::to_owned)
}

fn find_in_path(name: &str, path_env: &OsString) -> Option<PathBuf> {
    std::env::split_paths(path_env)
        .map(|entry| entry.join(name))
        .find(|candidate| candidate.is_file())
}

fn arch_like_host() -> bool {
    os_release_fields()
        .map(|(id, id_like)| os_release_matches(&[id.as_str(), id_like.as_str()], ARCH_LIKE_IDS))
        .unwrap_or(false)
}

fn os_release_fields() -> Option<(String, String)> {
    let contents = ["/etc/os-release", "/usr/lib/os-release"]
        .into_iter()
        .find_map(|path| fs::read_to_string(path).ok())?;
    let mut id = String::new();
    let mut id_like = String::new();

    for line in contents.lines() {
        if let Some(value) = line.strip_prefix("ID=") {
            id = trim_os_release_value(value).to_ascii_lowercase();
        } else if let Some(value) = line.strip_prefix("ID_LIKE=") {
            id_like = trim_os_release_value(value).to_ascii_lowercase();
        }
    }

    Some((id, id_like))
}

fn trim_os_release_value(value: &str) -> &str {
    value.trim().trim_matches('"').trim_matches('\'')
}

fn os_release_matches(fields: &[&str], expected: &[&str]) -> bool {
    fields.iter().any(|field| {
        field
            .split_whitespace()
            .any(|token| expected.contains(&token))
    })
}

#[cfg(test)]
fn test_detection_config(path_env: &OsString) -> Option<DetectionConfig> {
    let root = std::env::var_os("CODEX_UPDATE_MANAGER_TEST_SYSTEM_CLI_ROOT")?;
    let pacman_program = std::env::var_os("CODEX_UPDATE_MANAGER_TEST_PACMAN_PATH")
        .map(PathBuf::from)
        .or_else(|| pacman_program(path_env));
    let arch_like_host = std::env::var_os("CODEX_UPDATE_MANAGER_TEST_FORCE_ARCH_HOST")
        .is_some_and(|value| !value.is_empty());
    Some(DetectionConfig {
        arch_like_host,
        pacman_program,
        system_roots: vec![PathBuf::from(root)],
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs as unix_fs;
    use tempfile::tempdir;

    fn write_executable_script(path: &Path, contents: &str) {
        fs::write(path, contents).unwrap();
        let mut permissions = fs::metadata(path).unwrap().permissions();
        #[allow(clippy::permissions_set_readonly_false)]
        {
            use std::os::unix::fs::PermissionsExt;
            permissions.set_mode(0o755);
        }
        fs::set_permissions(path, permissions).unwrap();
    }

    #[test]
    fn detects_pacman_managed_cli_through_canonical_path() {
        let temp = tempdir().unwrap();
        let tool_bin = temp.path().join("tool-bin");
        let system_root = temp.path().join("system-root/usr/bin");
        let home_bin = temp.path().join("home-bin");
        fs::create_dir_all(&tool_bin).unwrap();
        fs::create_dir_all(&system_root).unwrap();
        fs::create_dir_all(&home_bin).unwrap();

        let pacman_path = tool_bin.join("pacman");
        write_executable_script(
            &pacman_path,
            "#!/bin/sh\nif [ \"$1\" = \"-Qo\" ] && [ \"$2\" = \"--\" ]; then\n  printf '%s is owned by openai-codex 0.143.0-1\\n' \"$3\"\n  exit 0\nfi\nexit 1\n",
        );

        let system_codex = system_root.join("codex");
        write_executable_script(
            &system_codex,
            "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then\n  echo codex-cli v0.143.0\n  exit 0\nfi\nexit 1\n",
        );

        let visible_codex = home_bin.join("codex");
        unix_fs::symlink(&system_codex, &visible_codex).unwrap();

        let detection = detect_with(
            &visible_codex,
            &std::env::join_paths([tool_bin, PathBuf::from("/usr/bin"), PathBuf::from("/bin")])
                .unwrap(),
            &DetectionConfig {
                arch_like_host: true,
                pacman_program: Some(pacman_path),
                system_roots: vec![system_root],
            },
        );

        assert_eq!(
            detection,
            Some(SystemPackageManagedCli::ManagedByPacman {
                package_name: "openai-codex".to_string(),
                query_path: system_codex,
            })
        );
    }

    #[test]
    fn reports_unknown_pacman_ownership_for_system_path_cli() {
        let temp = tempdir().unwrap();
        let tool_bin = temp.path().join("tool-bin");
        let system_root = temp.path().join("system-root/usr/bin");
        fs::create_dir_all(&tool_bin).unwrap();
        fs::create_dir_all(&system_root).unwrap();

        let pacman_path = tool_bin.join("pacman");
        write_executable_script(
            &pacman_path,
            "#!/bin/sh\nif [ \"$1\" = \"-Qo\" ] && [ \"$2\" = \"--\" ]; then\n  echo 'error: no package owns path' >&2\n  exit 1\nfi\nexit 1\n",
        );

        let system_codex = system_root.join("codex");
        write_executable_script(
            &system_codex,
            "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then\n  echo codex-cli v0.143.0\n  exit 0\nfi\nexit 1\n",
        );

        let detection = detect_with(
            &system_codex,
            &std::env::join_paths([tool_bin, PathBuf::from("/usr/bin"), PathBuf::from("/bin")])
                .unwrap(),
            &DetectionConfig {
                arch_like_host: true,
                pacman_program: Some(pacman_path),
                system_roots: vec![system_root],
            },
        );

        assert_eq!(
            detection,
            Some(SystemPackageManagedCli::PacmanOwnershipUnknown {
                query_path: system_codex,
            })
        );
    }

    #[test]
    fn ignores_non_system_paths_even_on_arch_like_hosts() {
        let temp = tempdir().unwrap();
        let tool_bin = temp.path().join("tool-bin");
        let pacman_path = tool_bin.join("pacman");
        fs::create_dir_all(&tool_bin).unwrap();
        write_executable_script(&pacman_path, "#!/bin/sh\nexit 1\n");

        let local_codex = temp.path().join("local-bin/codex");
        fs::create_dir_all(local_codex.parent().unwrap()).unwrap();
        write_executable_script(
            &local_codex,
            "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then\n  echo codex-cli v0.143.0\n  exit 0\nfi\nexit 1\n",
        );

        let detection = detect_with(
            &local_codex,
            &std::env::join_paths([tool_bin, PathBuf::from("/usr/bin"), PathBuf::from("/bin")])
                .unwrap(),
            &DetectionConfig {
                arch_like_host: true,
                pacman_program: Some(pacman_path),
                system_roots: vec![temp.path().join("system-root/usr/bin")],
            },
        );

        assert_eq!(detection, None);
    }

    #[test]
    fn os_release_matching_prefers_arch_family_tokens_over_derivative_names() {
        assert!(os_release_matches(&["arch", ""], ARCH_LIKE_IDS));
        assert!(os_release_matches(&["artix", "arch"], ARCH_LIKE_IDS));
        assert!(os_release_matches(
            &["manjaro", "arch linux"],
            ARCH_LIKE_IDS
        ));
        assert!(!os_release_matches(&["artix", ""], ARCH_LIKE_IDS));
        assert!(!os_release_matches(&["manjaro", ""], ARCH_LIKE_IDS));
    }

    #[test]
    fn parses_pacman_sync_version_output() {
        assert_eq!(
            parse_pacman_info_version("Repository      : extra\nName            : openai-codex\nVersion         : 0.143.0-2\n"),
            Some("0.143.0-2".to_string())
        );
    }

    #[test]
    fn parses_pacman_upgrade_output() {
        assert_eq!(
            parse_pacman_upgrade_version("openai-codex 0.143.0-1 -> 0.143.0-2\n"),
            Some("0.143.0-2".to_string())
        );
        assert_eq!(parse_pacman_upgrade_version(""), None);
    }
}
