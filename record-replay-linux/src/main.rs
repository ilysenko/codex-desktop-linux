use anyhow::{Context, Result};
use clap::Parser;
use codex_record_replay_linux::{
    command_json, mcp, Cli, Commands, EventStreamCommand, SkysightCommand,
};

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    if matches!(
        &cli.command,
        Commands::Skysight {
            command: SkysightCommand::Mcp,
        }
    ) {
        return mcp::serve_skysight_mcp().await;
    }
    if matches!(
        &cli.command,
        Commands::Mcp
            | Commands::EventStream {
                command: EventStreamCommand::Mcp,
            }
    ) {
        return mcp::serve_mcp().await;
    }

    let response = command_json(cli.command).await?;
    println!(
        "{}",
        serde_json::to_string_pretty(&response).context("failed to render response JSON")?
    );
    Ok(())
}
