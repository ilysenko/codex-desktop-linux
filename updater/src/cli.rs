//! Command-line interface definition for the updater binary.

use clap::{Parser, Subcommand};
use std::path::PathBuf;

#[derive(Debug, Parser)]
#[command(name = "codex-update-manager")]
#[command(about = "Local update manager for Codex Desktop on Linux")]
pub struct Cli {
    #[command(subcommand)]
    pub command: Commands,
}

#[derive(Debug, Subcommand)]
/// Top-level commands supported by the updater binary.
pub enum Commands {
    Daemon,
    CheckNow {
        #[arg(long, default_value_t = false)]
        if_stale: bool,
    },
    CliPreflight {
        #[arg(long)]
        cli_path: Option<PathBuf>,
        #[arg(long)]
        print_path: bool,
        #[arg(long, default_value_t = false)]
        allow_install_missing: bool,
    },
    PromptInstallCli {
        #[arg(long)]
        cli_path: Option<PathBuf>,
        #[arg(long)]
        print_path: bool,
    },
    Status {
        #[arg(long)]
        json: bool,
    },
    /// Print available optional Linux features and the current update selection.
    Features {
        #[arg(long)]
        json: bool,
    },
    /// Show a native feature-selection prompt for the next update rebuild.
    PromptFeatures {
        #[arg(long)]
        json: bool,
    },
    /// Install the already rebuilt update package, if one is ready.
    InstallReady,
    /// Roll back to the last retained known-good package.
    Rollback,
    /// Install a Debian package (.deb) with elevated privileges.
    InstallDeb {
        #[arg(long)]
        path: PathBuf,
    },
    /// Install an RPM package (.rpm) with elevated privileges.
    InstallRpm {
        #[arg(long)]
        path: PathBuf,
    },
    /// Install a pacman package (.pkg.tar.zst) with elevated privileges.
    InstallPacman {
        #[arg(long)]
        path: PathBuf,
    },
    /// Install a Debian package as an explicit rollback with elevated privileges.
    InstallRollbackDeb {
        #[arg(long)]
        path: PathBuf,
    },
    /// Install an RPM package as an explicit rollback with elevated privileges.
    InstallRollbackRpm {
        #[arg(long)]
        path: PathBuf,
    },
    /// Install a pacman package as an explicit rollback with elevated privileges.
    InstallRollbackPacman {
        #[arg(long)]
        path: PathBuf,
    },
}
