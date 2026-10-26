pub mod abs_pointer;
mod accessibility_guard;
pub mod atspi_tree;
mod cli;
mod command_runner;
pub mod indicator;
mod keyboard_keymap;

pub mod cosmic_helper;
pub mod diagnostics;
pub mod gnome_extension;
pub mod identity;
pub mod remote_desktop;
pub mod screenshot;
pub mod server;
pub mod terminal;
pub(crate) mod tree_spill;
pub mod windowing;
pub mod windows;
mod x11_display;
pub(crate) mod ydotool;

#[doc(hidden)]
pub async fn run_cli_from_env() -> anyhow::Result<()> {
    cli::run_from_env().await
}
