pub mod abs_pointer;
mod accessibility_guard;
mod agent_seat;
pub mod atspi_tree;
mod background_input;
mod cli;
mod command_runner;
mod devtools;
mod diagnostics_cache;
mod ei_input;
mod http_listen;
mod hyprland_input;
pub mod indicator;
mod keyboard_keymap;
mod pixelflux;
mod pointer_path;

pub mod cosmic_helper;
pub mod diagnostics;
pub mod gnome_extension;
pub mod identity;
pub mod remote_desktop;
pub mod screenshot;
mod screenshot_file;
pub mod server;
pub mod terminal;
#[cfg(test)]
mod test_sockets;
pub(crate) mod tree_encoding;
pub(crate) mod tree_spill;
mod virtual_pen;
pub mod windowing;
pub mod windows;
mod wlr_outputs;
mod x11_display;
pub(crate) mod ydotool;

#[doc(hidden)]
pub async fn run_cli_from_env() -> anyhow::Result<()> {
    cli::run_from_env().await
}
