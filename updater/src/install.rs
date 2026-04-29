//! Installation helpers for privileged and non-privileged package application.

use anyhow::{Context, Result};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

const PACKAGE_NAME: &str = "codex-desktop";
const INSTALLED_UPDATER_BINARY: &str = "/usr/bin/codex-update-manager";
const APT_CANDIDATES: &[&str] = &["/usr/bin/apt", "/bin/apt"];
const DNF_CANDIDATES: &[&str] = &["/usr/bin/dnf", "/bin/dnf", "/usr/bin/dnf5", "/bin/dnf5"];
const DPKG_CANDIDATES: &[&str] = &["/usr/bin/dpkg", "/bin/dpkg"];
const DPKG_DEB_CANDIDATES: &[&str] = &["/usr/bin/dpkg-deb", "/bin/dpkg-deb"];
const DPKG_QUERY_CANDIDATES: &[&str] = &["/usr/bin/dpkg-query", "/bin/dpkg-query"];
const RPM_CANDIDATES: &[&str] = &["/usr/bin/rpm", "/bin/rpm"];
const ZYPPER_CANDIDATES: &[&str] = &["/usr/bin/zypper", "/bin/zypper"];
const PACMAN_CANDIDATES: &[&str] = &["/usr/bin/pacman", "/bin/pacman"];
const VERCMP_CANDIDATES: &[&str] = &["/usr/bin/vercmp", "/bin/vercmp"];
const PACMAN_PACKAGE_SUFFIXES: &[&str] = &[
    ".pkg.tar.zst",
    ".pkg.tar.xz",
    ".pkg.tar.gz",
    ".pkg.tar.bz2",
    ".pkg.tar.lz",
    ".pkg.tar.lz4",
    ".pkg.tar.lz5",
];

/// The native package format in use on the current system.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PackageKind {
    Deb,
    Rpm,
    Pacman,
}

impl PackageKind {
    pub fn detect() -> Self {
        detect_package_kind(
            program_exists(PACMAN_CANDIDATES, "pacman"),
            program_exists(DPKG_CANDIDATES, "dpkg"),
            program_exists(RPM_CANDIDATES, "rpm"),
            installed_pacman_version() != "unknown",
            installed_deb_version() != "unknown",
            installed_rpm_version() != "unknown",
            os_release_fields(),
        )
    }

    pub fn from_path(path: &Path) -> Self {
        let file_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("");
        if is_pacman_package_file_name(file_name) {
            return Self::Pacman;
        }

        match path.extension().and_then(|e| e.to_str()) {
            Some("rpm") => Self::Rpm,
            _ => Self::Deb,
        }
    }
}

fn detect_package_kind(
    has_pacman: bool,
    has_dpkg: bool,
    has_rpm: bool,
    pacman_installed: bool,
    deb_installed: bool,
    rpm_installed: bool,
    os_release: Option<(String, String)>,
) -> PackageKind {
    if pacman_installed {
        return PackageKind::Pacman;
    }
    if deb_installed {
        return PackageKind::Deb;
    }
    if rpm_installed {
        return PackageKind::Rpm;
    }

    if let Some((id, id_like)) = os_release {
        let fields = [id.as_str(), id_like.as_str()];
        if os_release_matches(
            &fields,
            &["arch", "archlinux", "manjaro", "endeavouros", "artix"],
        ) {
            return PackageKind::Pacman;
        }
        if os_release_matches(
            &fields,
            &[
                "debian",
                "ubuntu",
                "linuxmint",
                "pop",
                "elementary",
                "zorin",
            ],
        ) {
            return PackageKind::Deb;
        }
        if os_release_matches(
            &fields,
            &[
                "fedora",
                "rhel",
                "centos",
                "rocky",
                "almalinux",
                "ol",
                "sles",
                "suse",
                "opensuse",
            ],
        ) {
            return PackageKind::Rpm;
        }
    }

    if has_dpkg {
        PackageKind::Deb
    } else if has_rpm {
        PackageKind::Rpm
    } else if has_pacman {
        PackageKind::Pacman
    } else {
        PackageKind::Deb
    }
}

fn os_release_fields() -> Option<(String, String)> {
    let contents = fs::read_to_string("/etc/os-release").ok()?;
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

/// Returns the currently installed package version when available.
pub fn installed_package_version() -> String {
    match PackageKind::detect() {
        PackageKind::Deb => installed_deb_version(),
        PackageKind::Rpm => installed_rpm_version(),
        PackageKind::Pacman => installed_pacman_version(),
    }
}

/// Returns whether the primary native package still appears to be installed.
pub fn is_primary_package_installed() -> bool {
    installed_package_version() != "unknown"
}

fn installed_deb_version() -> String {
    installed_version_from_command(
        &program_path(DPKG_QUERY_CANDIDATES, "dpkg-query"),
        &["-W", "-f=${Version}", PACKAGE_NAME],
    )
}

fn installed_rpm_version() -> String {
    installed_version_from_command(
        &program_path(RPM_CANDIDATES, "rpm"),
        &["-q", "--queryformat", "%{VERSION}-%{RELEASE}", PACKAGE_NAME],
    )
}

fn installed_pacman_version() -> String {
    match Command::new(program_path(PACMAN_CANDIDATES, "pacman"))
        .args(["-Q", PACKAGE_NAME])
        .output()
    {
        Ok(output) if output.status.success() => parse_pacman_installed_version(output.stdout),
        _ => "unknown".to_string(),
    }
}

/// Installs a rebuilt Debian package on the local machine.
pub fn install_deb(path: &Path) -> Result<()> {
    anyhow::ensure!(
        path.exists(),
        "Debian package not found: {}",
        path.display()
    );
    ensure_upgrade_path(path)?;

    if program_exists(APT_CANDIDATES, "apt") {
        let mut command = apt_install_command(path)?;
        run_install(&mut command).context("apt install failed")?;
        return Ok(());
    }

    let mut command = dpkg_install_command(path);
    run_install(&mut command).context("dpkg -i failed")
}

/// Installs a rebuilt RPM package on the local machine.
pub fn install_rpm(path: &Path) -> Result<()> {
    anyhow::ensure!(path.exists(), "RPM package not found: {}", path.display());
    ensure_upgrade_path_rpm(path)?;

    if program_exists(DNF_CANDIDATES, "dnf") || program_exists(DNF_CANDIDATES, "dnf5") {
        let mut command = dnf_install_command(path)?;
        run_install(&mut command).context("dnf install failed")?;
        return Ok(());
    }

    if program_exists(ZYPPER_CANDIDATES, "zypper") {
        let mut command = zypper_install_command(path)?;
        run_install(&mut command).context("zypper install failed")?;
        return Ok(());
    }

    let mut command = rpm_install_command(path);
    run_install(&mut command).context("rpm -Uvh failed")
}

/// Installs a rebuilt pacman package on the local machine.
pub fn install_pacman(path: &Path) -> Result<()> {
    anyhow::ensure!(
        path.exists(),
        "Pacman package not found: {}",
        path.display()
    );
    ensure_upgrade_path_pacman(path)?;

    let mut command = pacman_install_command(path);
    run_install(&mut command).context("pacman -U failed")
}

/// Returns the updater binary and install subcommand used for a privileged package install.
pub fn privileged_install_command_parts(
    current_exe: &Path,
    package_path: &Path,
) -> (PathBuf, &'static str) {
    let updater_binary = updater_binary_for_privileged_install(current_exe);
    let subcommand = match PackageKind::from_path(package_path) {
        PackageKind::Rpm => "install-rpm",
        PackageKind::Deb => "install-deb",
        PackageKind::Pacman => "install-pacman",
    };
    (updater_binary, subcommand)
}

/// Builds the `pkexec` command used for privileged package installation.
#[cfg(test)]
pub fn pkexec_command(current_exe: &Path, package_path: &Path) -> Command {
    let (updater_binary, subcommand) = privileged_install_command_parts(current_exe, package_path);
    let mut command = Command::new("pkexec");
    command
        .arg("--disable-internal-agent")
        .arg(updater_binary)
        .arg(subcommand)
        .arg("--path")
        .arg(package_path);
    command
}

fn run_install(command: &mut Command) -> Result<()> {
    let status = command
        .status()
        .context("Failed to execute installation command")?;
    anyhow::ensure!(
        status.success(),
        "installation command exited with {status}"
    );
    Ok(())
}

fn installed_version_from_command(program: &Path, args: &[&str]) -> String {
    match Command::new(program).args(args).output() {
        Ok(output) if output.status.success() => parse_installed_version(output.stdout),
        _ => "unknown".to_string(),
    }
}

fn parse_installed_version(stdout: Vec<u8>) -> String {
    let version = String::from_utf8_lossy(&stdout).trim().to_string();
    if version.is_empty() {
        "unknown".to_string()
    } else {
        version
    }
}

fn parse_pacman_installed_version(stdout: Vec<u8>) -> String {
    let text = String::from_utf8_lossy(&stdout);
    let version = text
        .split_whitespace()
        .nth(1)
        .unwrap_or("")
        .trim()
        .to_string();
    if version.is_empty() {
        "unknown".to_string()
    } else {
        version
    }
}

fn ensure_upgrade_path(path: &Path) -> Result<()> {
    let installed = installed_package_version();
    if installed == "unknown" {
        return Ok(());
    }

    let candidate = deb_package_version(path)?;
    anyhow::ensure!(
        is_version_newer(&candidate, &installed)?,
        "Refusing to install non-newer package version {candidate} over installed version {installed}"
    );
    Ok(())
}

fn ensure_upgrade_path_pacman(path: &Path) -> Result<()> {
    let installed = installed_pacman_version();
    if installed == "unknown" {
        return Ok(());
    }

    let candidate = pacman_package_version(path)?;
    anyhow::ensure!(
        is_version_newer_pacman(&candidate, &installed)?,
        "Refusing to install non-newer package version {candidate} over installed version {installed}"
    );
    Ok(())
}

fn ensure_upgrade_path_rpm(path: &Path) -> Result<()> {
    let installed = installed_rpm_version();
    if installed == "unknown" {
        return Ok(());
    }

    let candidate = rpm_package_version(path)?;
    anyhow::ensure!(
        generated_package_version_is_newer(&candidate, &installed),
        "Refusing to install non-newer package version {candidate} over installed version {installed}"
    );
    Ok(())
}

fn apt_install_command(path: &Path) -> Result<Command> {
    install_command_in_parent(&program_path(APT_CANDIDATES, "apt"), path)
}

fn dpkg_install_command(path: &Path) -> Command {
    let mut command = Command::new(program_path(DPKG_CANDIDATES, "dpkg"));
    command.arg("-i").arg(path.as_os_str());
    command
}

fn dnf_install_command(path: &Path) -> Result<Command> {
    install_command_in_parent(&program_path(DNF_CANDIDATES, "dnf"), path)
}

fn zypper_install_command(path: &Path) -> Result<Command> {
    let program = program_path(ZYPPER_CANDIDATES, "zypper");
    let parent = path
        .parent()
        .with_context(|| "zypper package path has no parent directory")?;
    let file_name = path
        .file_name()
        .with_context(|| "zypper package path has no file name")?
        .to_string_lossy()
        .into_owned();

    let mut command = Command::new(program);
    command
        .current_dir(parent)
        .args(["--non-interactive", "--no-gpg-checks", "install", "-y"])
        .arg(format!("./{file_name}"));
    Ok(command)
}

fn install_command_in_parent(program: &Path, path: &Path) -> Result<Command> {
    let program_name = program
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("package manager");
    let parent = path
        .parent()
        .with_context(|| format!("{program_name} package path has no parent directory"))?;
    let file_name = path
        .file_name()
        .with_context(|| format!("{program_name} package path has no file name"))?
        .to_string_lossy()
        .into_owned();

    let mut command = Command::new(program);
    command
        .current_dir(parent)
        .arg("install")
        .arg("-y")
        .arg(format!("./{file_name}"));
    Ok(command)
}

fn rpm_install_command(path: &Path) -> Command {
    let mut command = Command::new(program_path(RPM_CANDIDATES, "rpm"));
    command.args(["-Uvh"]).arg(path.as_os_str());
    command
}

fn pacman_install_command(path: &Path) -> Command {
    let mut command = Command::new(program_path(PACMAN_CANDIDATES, "pacman"));
    command.args(["-U", "--noconfirm"]).arg(path.as_os_str());
    command
}

fn updater_binary_for_privileged_install(current_exe: &Path) -> PathBuf {
    let installed = PathBuf::from(INSTALLED_UPDATER_BINARY);
    if installed.is_file() {
        installed
    } else {
        current_exe.to_path_buf()
    }
}

fn deb_package_version(path: &Path) -> Result<String> {
    let output = Command::new(program_path(DPKG_DEB_CANDIDATES, "dpkg-deb"))
        .arg("-f")
        .arg(path)
        .arg("Version")
        .output()
        .context("Failed to inspect Debian package metadata")?;

    anyhow::ensure!(
        output.status.success(),
        "dpkg-deb could not read the package version from {}",
        path.display()
    );

    let version = String::from_utf8(output.stdout)
        .context("dpkg-deb returned a non-UTF8 package version")?
        .trim()
        .to_string();
    anyhow::ensure!(
        !version.is_empty(),
        "dpkg-deb returned an empty package version for {}",
        path.display()
    );
    Ok(version)
}

fn rpm_package_version(path: &Path) -> Result<String> {
    let output = Command::new(program_path(RPM_CANDIDATES, "rpm"))
        .arg("-qp")
        .arg("--queryformat")
        .arg("%{VERSION}-%{RELEASE}")
        .arg(path)
        .output()
        .context("Failed to inspect RPM package metadata")?;

    anyhow::ensure!(
        output.status.success(),
        "rpm could not read the package version from {}",
        path.display()
    );

    let version = String::from_utf8(output.stdout)
        .context("rpm returned a non-UTF8 package version")?
        .trim()
        .to_string();
    anyhow::ensure!(
        !version.is_empty(),
        "rpm returned an empty package version for {}",
        path.display()
    );
    Ok(version)
}

fn is_version_newer(candidate: &str, installed: &str) -> Result<bool> {
    let status = Command::new(program_path(DPKG_CANDIDATES, "dpkg"))
        .args(["--compare-versions", candidate, "gt", installed])
        .status()
        .context("Failed to compare Debian package versions")?;
    Ok(status.success())
}

fn pacman_package_version(path: &Path) -> Result<String> {
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .context("Package path has no file name")?;

    let stripped = strip_pacman_package_suffix(file_name)
        .with_context(|| format!("Not a valid pacman package filename: {file_name}"))?;
    let prefix = format!("{PACKAGE_NAME}-");
    let without_name = stripped
        .strip_prefix(&prefix)
        .with_context(|| format!("Pacman package filename does not start with {prefix}"))?;
    let (version_release, _arch) = without_name
        .rsplit_once('-')
        .context("Pacman package filename is missing an architecture suffix")?;
    anyhow::ensure!(
        !version_release.is_empty(),
        "Could not parse package version from {file_name}"
    );
    Ok(version_release.to_string())
}

fn is_version_newer_pacman(candidate: &str, installed: &str) -> Result<bool> {
    let output = Command::new(program_path(VERCMP_CANDIDATES, "vercmp"))
        .args([candidate, installed])
        .output()
        .context("Failed to compare pacman package versions")?;
    anyhow::ensure!(
        output.status.success(),
        "vercmp exited with status {}",
        output.status
    );

    let comparison = String::from_utf8(output.stdout)
        .context("vercmp returned a non-UTF8 response")?
        .trim()
        .parse::<i32>()
        .context("vercmp returned an invalid comparison value")?;
    Ok(comparison > 0)
}

fn generated_package_version_is_newer(candidate: &str, installed: &str) -> bool {
    matches!(
        compare_generated_package_versions(candidate, installed),
        Some(std::cmp::Ordering::Greater)
    )
}

fn compare_generated_package_versions(left: &str, right: &str) -> Option<std::cmp::Ordering> {
    let left = parse_generated_package_version(left)?;
    let right = parse_generated_package_version(right)?;
    Some(left.cmp(&right))
}

fn parse_generated_package_version(version: &str) -> Option<Vec<u32>> {
    let without_metadata = version
        .split_once('+')
        .map(|(prefix, _)| prefix)
        .unwrap_or(version);
    let base = without_metadata
        .split_once('-')
        .map(|(prefix, _)| prefix)
        .unwrap_or(without_metadata);
    let mut parts = Vec::new();

    for segment in base.split('.') {
        parts.push(segment.parse().ok()?);
    }

    if parts.len() < 3 || !(2000..=2100).contains(&parts[0]) {
        return None;
    }

    Some(parts)
}

fn strip_pacman_package_suffix(file_name: &str) -> Option<&str> {
    let lower = file_name.to_ascii_lowercase();
    PACMAN_PACKAGE_SUFFIXES.iter().find_map(|suffix| {
        lower
            .strip_suffix(suffix)
            .map(|_| &file_name[..file_name.len() - suffix.len()])
    })
}

fn is_pacman_package_file_name(file_name: &str) -> bool {
    strip_pacman_package_suffix(file_name).is_some()
}

fn program_exists(candidates: &[&str], fallback: &str) -> bool {
    candidates.iter().any(|path| Path::new(path).is_file()) || command_exists(fallback)
}

fn program_path(candidates: &[&str], fallback: &str) -> PathBuf {
    candidates
        .iter()
        .map(PathBuf::from)
        .find(|path| path.is_file())
        .unwrap_or_else(|| PathBuf::from(fallback))
}

fn command_exists(name: &str) -> bool {
    std::env::var_os("PATH")
        .map(|path| {
            std::env::split_paths(&path).any(|entry| {
                let candidate: PathBuf = entry.join(name);
                candidate.is_file()
            })
        })
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use anyhow::Result;

    #[test]
    fn builds_pkexec_command_for_privileged_deb_install() {
        let command = pkexec_command(
            Path::new("/usr/bin/codex-update-manager"),
            Path::new("/tmp/update.deb"),
        );
        let args: Vec<_> = command
            .get_args()
            .map(|value| value.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            args,
            vec![
                "--disable-internal-agent",
                "/usr/bin/codex-update-manager",
                "install-deb",
                "--path",
                "/tmp/update.deb"
            ]
        );
    }

    #[test]
    fn builds_pkexec_command_for_privileged_rpm_install() {
        let command = pkexec_command(
            Path::new("/usr/bin/codex-update-manager"),
            Path::new("/tmp/update.rpm"),
        );
        let args: Vec<_> = command
            .get_args()
            .map(|value| value.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            args,
            vec![
                "--disable-internal-agent",
                "/usr/bin/codex-update-manager",
                "install-rpm",
                "--path",
                "/tmp/update.rpm"
            ]
        );
    }

    #[test]
    fn prefers_installed_updater_path_for_pkexec() {
        let selected =
            updater_binary_for_privileged_install(Path::new("/tmp/codex-update-manager-old"));
        let expected = if Path::new("/usr/bin/codex-update-manager").is_file() {
            PathBuf::from("/usr/bin/codex-update-manager")
        } else {
            PathBuf::from("/tmp/codex-update-manager-old")
        };
        assert_eq!(selected, expected);
    }

    #[test]
    fn builds_local_apt_install_command() -> Result<()> {
        let command = apt_install_command(Path::new("/tmp/build/codex.deb"))?;
        assert!(command.get_program().to_string_lossy().ends_with("apt"));
        assert_eq!(
            command
                .get_args()
                .map(|value| value.to_string_lossy().into_owned())
                .collect::<Vec<_>>(),
            vec!["install", "-y", "./codex.deb"]
        );
        Ok(())
    }

    #[test]
    fn builds_local_dnf_install_command() -> Result<()> {
        let command = dnf_install_command(Path::new("/tmp/build/codex.rpm"))?;
        let program = command.get_program().to_string_lossy();
        assert!(program.ends_with("dnf") || program.ends_with("dnf5"));
        assert_eq!(
            command
                .get_args()
                .map(|value| value.to_string_lossy().into_owned())
                .collect::<Vec<_>>(),
            vec!["install", "-y", "./codex.rpm"]
        );
        Ok(())
    }

    #[test]
    fn builds_local_zypper_install_command() -> Result<()> {
        let command = zypper_install_command(Path::new("/tmp/build/codex.rpm"))?;
        assert!(command.get_program().to_string_lossy().ends_with("zypper"));
        assert_eq!(
            command
                .get_args()
                .map(|value| value.to_string_lossy().into_owned())
                .collect::<Vec<_>>(),
            vec![
                "--non-interactive",
                "--no-gpg-checks",
                "install",
                "-y",
                "./codex.rpm"
            ]
        );
        Ok(())
    }

    #[test]
    fn package_kind_from_path_detects_rpm() {
        assert_eq!(
            PackageKind::from_path(Path::new("/tmp/codex.rpm")),
            PackageKind::Rpm
        );
    }

    #[test]
    fn package_kind_from_path_detects_deb() {
        assert_eq!(
            PackageKind::from_path(Path::new("/tmp/codex.deb")),
            PackageKind::Deb
        );
    }

    #[test]
    fn package_kind_from_path_detects_pacman_zst() {
        assert_eq!(
            PackageKind::from_path(Path::new(
                "/tmp/codex-desktop-2026.03.30-1-x86_64.pkg.tar.zst"
            )),
            PackageKind::Pacman
        );
    }

    #[test]
    fn package_kind_from_path_detects_pacman_xz() {
        assert_eq!(
            PackageKind::from_path(Path::new(
                "/tmp/codex-desktop-2026.03.30-1-x86_64.pkg.tar.xz"
            )),
            PackageKind::Pacman
        );
    }

    #[test]
    fn detection_prefers_installed_pacman_package_even_if_rpm_exists() {
        assert_eq!(
            detect_package_kind(
                true,
                false,
                true,
                true,
                false,
                false,
                Some(("arch".to_string(), "".to_string())),
            ),
            PackageKind::Pacman
        );
    }

    #[test]
    fn detection_uses_arch_os_release_when_nothing_is_installed() {
        assert_eq!(
            detect_package_kind(
                true,
                false,
                true,
                false,
                false,
                false,
                Some(("arch".to_string(), "".to_string())),
            ),
            PackageKind::Pacman
        );
    }

    #[test]
    fn detection_uses_debian_os_release_before_rpm_command_presence() {
        assert_eq!(
            detect_package_kind(
                false,
                true,
                true,
                false,
                false,
                false,
                Some(("ubuntu".to_string(), "debian".to_string())),
            ),
            PackageKind::Deb
        );
    }

    #[test]
    fn detection_uses_rpm_os_release_before_pacman_command_presence() {
        assert_eq!(
            detect_package_kind(
                true,
                false,
                true,
                false,
                false,
                false,
                Some(("fedora".to_string(), "rhel".to_string())),
            ),
            PackageKind::Rpm
        );
    }

    #[test]
    fn trims_quoted_os_release_values() {
        assert_eq!(trim_os_release_value("\"arch\""), "arch");
        assert_eq!(trim_os_release_value("'debian ubuntu'"), "debian ubuntu");
    }

    #[test]
    fn matches_expected_os_release_tokens() {
        assert!(os_release_matches(&["ubuntu debian", ""], &["debian"]));
        assert!(!os_release_matches(&["ubuntu", ""], &["fedora"]));
    }

    #[test]
    fn builds_pkexec_command_for_privileged_pacman_install() {
        let command = pkexec_command(
            Path::new("/usr/bin/codex-update-manager"),
            Path::new("/tmp/update.pkg.tar.zst"),
        );
        let args: Vec<_> = command
            .get_args()
            .map(|value| value.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            args,
            vec![
                "--disable-internal-agent",
                "/usr/bin/codex-update-manager",
                "install-pacman",
                "--path",
                "/tmp/update.pkg.tar.zst"
            ]
        );
    }

    #[test]
    fn compares_debian_versions_using_dpkg_rules() -> Result<()> {
        if !program_exists(DPKG_CANDIDATES, "dpkg") {
            return Ok(());
        }

        assert!(is_version_newer(
            "2026.03.24.220000+88f07cd3",
            "2026.03.24.120000+afed8a8e"
        )?);
        assert!(!is_version_newer(
            "2026.03.24.120000+88f07cd3",
            "2026.03.24.120000+afed8a8e"
        )?);
        Ok(())
    }

    #[test]
    fn compares_generated_package_versions_by_timestamp() {
        assert!(generated_package_version_is_newer(
            "2026.04.28.140000-abcdef12.fc43",
            "2026.04.28.082247-12345678.fc43"
        ));
        assert!(!generated_package_version_is_newer(
            "2026.04.28.082247-12345678.fc43",
            "2026.04.28.140000-abcdef12.fc43"
        ));
        assert!(!generated_package_version_is_newer(
            "2026.04.28.140000-abcdef12.fc43",
            "2026.04.28.140000-abcdef12.fc43"
        ));
    }

    #[test]
    fn generated_package_version_comparison_rejects_non_generated_versions() {
        assert_eq!(
            compare_generated_package_versions("0.4.2", "2026.04.28.082247-12345678.fc43"),
            None
        );
        assert!(!generated_package_version_is_newer(
            "0.4.2",
            "2026.04.28.082247-12345678.fc43"
        ));
    }

    #[test]
    fn install_commands_require_a_file_name() {
        let deb_error = apt_install_command(Path::new("/")).expect_err("root is not a package");
        let rpm_error = dnf_install_command(Path::new("/")).expect_err("root is not a package");
        let zypper_error =
            zypper_install_command(Path::new("/")).expect_err("root is not a package");

        assert!(deb_error.to_string().contains("apt package path has no"));
        assert!(rpm_error.to_string().contains("dnf package path has no"));
        assert!(zypper_error
            .to_string()
            .contains("zypper package path has no"));
    }

    #[test]
    fn empty_installed_version_output_is_reported_as_unknown() {
        assert_eq!(parse_installed_version(Vec::new()), "unknown");
    }

    #[test]
    fn parses_pacman_installed_version_output() {
        assert_eq!(
            parse_pacman_installed_version(b"codex-desktop 2026.04.02.120000-1\n".to_vec()),
            "2026.04.02.120000-1"
        );
    }

    #[test]
    fn parses_pacman_package_version_from_filename() -> Result<()> {
        assert_eq!(
            pacman_package_version(Path::new(
                "/tmp/codex-desktop-2026.04.02.120000-1-x86_64.pkg.tar.zst"
            ))?,
            "2026.04.02.120000-1"
        );
        Ok(())
    }
}
