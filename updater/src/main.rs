//! Binary entrypoint for the local Codex Desktop update manager.

mod app;
mod builder;
mod cache_cleanup;
mod changelog;
mod cli;
mod codex_cli;
mod config;
mod diagnostics;
mod feature_picker;
mod install;
mod install_rollback;
mod liveness;
mod logging;
mod notify;
mod rollback;
mod state;
#[cfg(test)]
mod test_util;
mod upstream;
mod wrapper;
mod wrapper_apply;

use anyhow::Result;
use clap::Parser;

#[tokio::main]
async fn main() -> Result<()> {
    let cli = cli::Cli::parse();
    app::run(cli).await
}
