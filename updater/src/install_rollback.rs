//! Explicit rollback package installation helpers.

use crate::install::{resolve_updater_binary, stable_validated_package, PackageKind};
use anyhow::{Context, Result};
use std::{
    path::{Path, PathBuf},
    process::Command,
};

const APT_CANDIDATES: &[&str] = &["/usr/bin/apt", "/bin/apt"];
const DNF_CANDIDATES: &[&str] = &["/usr/bin/dnf", "/bin/dnf", "/usr/bin/dnf5", "/bin/dnf5"];
const DPKG_CANDIDATES: &[&str] = &["/usr/bin/dpkg", "/bin/dpkg"];
const RPM_CANDIDATES: &[&str] = &["/usr/bin/rpm", "/bin/rpm"];
const ZYPPER_CANDIDATES: &[&str] = &["/usr/bin/zypper", "/bin/zypper"];
const PACMAN_CANDIDATES: &[&str] = &["/usr/bin/pacman", "/bin/pacman"];

pub fn install_deb(path: &Path) -> Result<()> {
    let stable = stable_validated_package(path).with_context(|| {
        format!(
            "Failed to stabilize Debian rollback package {}",
            path.display()
        )
    })?;

    if program_exists(APT_CANDIDATES, "apt") {
        let mut command = apt_command(stable.path())?;
        run_install(&mut command).context("apt rollback install failed")?;
        return Ok(());
    }

    let mut command = dpkg_command(stable.path());
    run_install(&mut command).context("dpkg rollback install failed")
}

pub fn install_rpm(path: &Path) -> Result<()> {
    let stable = stable_validated_package(path).with_context(|| {
        format!(
            "Failed to stabilize RPM rollback package {}",
            path.display()
        )
    })?;

    if program_exists(DNF_CANDIDATES, "dnf") || program_exists(DNF_CANDIDATES, "dnf5") {
        let mut command = dnf_command(stable.path())?;
        run_install(&mut command).context("dnf rollback install failed")?;
        return Ok(());
    }

    if program_exists(ZYPPER_CANDIDATES, "zypper") {
        let mut command = zypper_command(stable.path())?;
        run_install(&mut command).context("zypper rollback install failed")?;
        return Ok(());
    }

    let mut command = rpm_command(stable.path());
    run_install(&mut command).context("rpm rollback install failed")
}

pub fn install_pacman(path: &Path) -> Result<()> {
    let stable = stable_validated_package(path).with_context(|| {
        format!(
            "Failed to stabilize pacman rollback package {}",
            path.display()
        )
    })?;

    let mut command = pacman_command(stable.path());
    run_install(&mut command).context("pacman rollback install failed")
}

pub fn pkexec_command(current_exe: &Path, package_path: &Path) -> Command {
    let updater_binary = resolve_updater_binary(current_exe);
    let subcommand = match PackageKind::from_path(package_path) {
        PackageKind::Rpm => "install-rollback-rpm",
        PackageKind::Deb => "install-rollback-deb",
        PackageKind::Pacman => "install-rollback-pacman",
    };
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
        .context("Failed to execute rollback installation command")?;
    anyhow::ensure!(
        status.success(),
        "rollback installation command exited with {status}"
    );
    Ok(())
}

fn apt_command(path: &Path) -> Result<Command> {
    let parent = package_parent(path, "apt rollback")?;
    let file_name = package_file_name(path, "apt rollback")?;
    let mut command = Command::new(program_path(APT_CANDIDATES, "apt"));
    command
        .current_dir(parent)
        .args(["install", "-y", "--allow-downgrades"])
        .arg(format!("./{file_name}"));
    Ok(command)
}

fn dpkg_command(path: &Path) -> Command {
    let mut command = Command::new(program_path(DPKG_CANDIDATES, "dpkg"));
    command.arg("-i").arg("--").arg(path.as_os_str());
    command
}

fn dnf_command(path: &Path) -> Result<Command> {
    command_in_parent(&program_path(DNF_CANDIDATES, "dnf"), path, "downgrade")
}

fn zypper_command(path: &Path) -> Result<Command> {
    let parent = package_parent(path, "zypper rollback")?;
    let file_name = package_file_name(path, "zypper rollback")?;
    let mut command = Command::new(program_path(ZYPPER_CANDIDATES, "zypper"));
    command
        .current_dir(parent)
        .args([
            "--non-interactive",
            "--no-gpg-checks",
            "install",
            "--oldpackage",
            "-y",
        ])
        .arg(format!("./{file_name}"));
    Ok(command)
}

fn rpm_command(path: &Path) -> Command {
    let mut command = Command::new(program_path(RPM_CANDIDATES, "rpm"));
    command
        .args(["-Uvh", "--oldpackage", "--"])
        .arg(path.as_os_str());
    command
}

fn pacman_command(path: &Path) -> Command {
    let mut command = Command::new(program_path(PACMAN_CANDIDATES, "pacman"));
    command
        .args(["-U", "--noconfirm", "--"])
        .arg(path.as_os_str());
    command
}

fn command_in_parent(program: &Path, path: &Path, verb: &str) -> Result<Command> {
    let program_name = program
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("package manager");
    let parent = package_parent(path, program_name)?;
    let file_name = package_file_name(path, program_name)?;

    let mut command = Command::new(program);
    command
        .current_dir(parent)
        .arg(verb)
        .arg("-y")
        .arg(format!("./{file_name}"));
    Ok(command)
}

fn package_parent<'a>(path: &'a Path, label: &str) -> Result<&'a Path> {
    path.parent()
        .with_context(|| format!("{label} package path has no parent directory"))
}

fn package_file_name(path: &Path, label: &str) -> Result<String> {
    Ok(path
        .file_name()
        .with_context(|| format!("{label} package path has no file name"))?
        .to_string_lossy()
        .into_owned())
}

fn program_path(candidates: &[&str], fallback: &str) -> PathBuf {
    candidates
        .iter()
        .map(PathBuf::from)
        .find(|path| path.is_file())
        .unwrap_or_else(|| PathBuf::from(fallback))
}

fn program_exists(candidates: &[&str], name: &str) -> bool {
    candidates.iter().map(Path::new).any(|path| path.is_file()) || command_exists(name)
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

    #[test]
    fn builds_local_apt_rollback_command() -> Result<()> {
        let command = apt_command(Path::new("/tmp/build/codex.deb"))?;
        assert!(command.get_program().to_string_lossy().ends_with("apt"));
        assert_eq!(
            command
                .get_args()
                .map(|value| value.to_string_lossy().into_owned())
                .collect::<Vec<_>>(),
            vec!["install", "-y", "--allow-downgrades", "./codex.deb"]
        );
        Ok(())
    }

    #[test]
    fn builds_local_dnf_rollback_command() -> Result<()> {
        let command = dnf_command(Path::new("/tmp/build/codex.rpm"))?;
        let program = command.get_program().to_string_lossy();
        assert!(program.ends_with("dnf") || program.ends_with("dnf5"));
        assert_eq!(
            command
                .get_args()
                .map(|value| value.to_string_lossy().into_owned())
                .collect::<Vec<_>>(),
            vec!["downgrade", "-y", "./codex.rpm"]
        );
        Ok(())
    }

    #[test]
    fn builds_local_zypper_rollback_command() -> Result<()> {
        let command = zypper_command(Path::new("/tmp/build/codex.rpm"))?;
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
                "--oldpackage",
                "-y",
                "./codex.rpm"
            ]
        );
        Ok(())
    }

    #[test]
    fn direct_rollback_commands_stop_option_parsing() {
        assert_eq!(
            command_args(dpkg_command(Path::new("-evil.deb"))),
            vec!["-i", "--", "-evil.deb"]
        );
        assert_eq!(
            command_args(rpm_command(Path::new("-evil.rpm"))),
            vec!["-Uvh", "--oldpackage", "--", "-evil.rpm"]
        );
        assert_eq!(
            command_args(pacman_command(Path::new("-evil.pkg.tar.zst"))),
            vec!["-U", "--noconfirm", "--", "-evil.pkg.tar.zst"]
        );
    }

    fn command_args(command: Command) -> Vec<String> {
        command
            .get_args()
            .map(|value| value.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn builds_pkexec_command_for_privileged_rollback() {
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
                "install-rollback-rpm",
                "--path",
                "/tmp/update.rpm"
            ]
        );
    }
}
