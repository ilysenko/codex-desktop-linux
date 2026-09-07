//! Binary entrypoint for the local ChatGPT Community update manager.

mod app;
mod builder;
mod cache_cleanup;
mod cli;
mod config;
mod install;
mod install_rollback;
mod liveness;
mod logging;
mod notify;
mod restart;
mod rollback;
mod state;
#[cfg(test)]
mod test_util;
mod upstream;

use anyhow::Result;
use clap::Parser;

#[tokio::main]
async fn main() -> Result<()> {
    let cli = cli::Cli::parse();
    app::run(cli).await
}
