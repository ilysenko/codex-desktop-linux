//! Command-line interface definition for the updater binary.

use clap::{Parser, Subcommand};
use std::path::PathBuf;

#[derive(Debug, Parser)]
#[command(name = "codex-update-manager")]
#[command(about = "Local update manager for ChatGPT Desktop on Linux")]
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
    /// Check whether a newer wrapper release (this repo's own Linux
    /// features/fixes) is available, and record its changelog.
    CheckWrapper {
        #[arg(long, default_value_t = false)]
        json: bool,
    },
    /// Apply the recorded wrapper update candidate for the running install.
    ApplyWrapperUpdate,
    /// Show a GUI checklist of optional Linux features and save the selection to
    /// the per-user feature config, so the next wrapper rebuild honors it.
    /// Invoked by the in-app Update button at click time (display still alive).
    PickFeatures {
        #[arg(long, default_value_t = false)]
        json: bool,
    },
    CliPreflight {
        #[arg(long)]
        cli_path: Option<PathBuf>,
        #[arg(long)]
        print_path: bool,
        #[arg(long, default_value_t = false)]
        allow_install_missing: bool,
    },
    /// Reinstall a removed standalone CLI tree with a permission-safe installer
    /// child. This command never overwrites an existing standalone tree.
    RecoverStandaloneCli {
        #[arg(long)]
        codex_home: Option<PathBuf>,
        #[arg(long)]
        install_dir: Option<PathBuf>,
        #[arg(long)]
        print_path: bool,
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
    /// Print read-only post-update/runtime diagnostics for support and smoke checks.
    Diagnose {
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
