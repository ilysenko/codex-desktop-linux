# Desktop Environment Matrix

This matrix tracks Linux Computer Use window-control parity by desktop session.
It separates implemented support from research targets so the package does not
claim a backend that has not been tested.

| Environment | Window listing | Exact focus | Input path | Status |
|---|---|---|---|---|
| GNOME Wayland | GNOME Shell Introspect or Codex GNOME Shell extension | Codex GNOME Shell extension | abs_pointer, portal, ydotool | Implemented |
| KDE Plasma / KWin | KWin DBus scripting | KWin DBus scripting | abs_pointer, portal, ydotool | Implemented |
| COSMIC Wayland | Bundled COSMIC helper | Bundled COSMIC helper | abs_pointer, portal, ydotool | Implemented |
| Hyprland | `hyprctl` | `hyprctl` | abs_pointer, portal, ydotool | Implemented |
| i3 | `i3-msg` plus `xprop` for PIDs | `i3-msg` | abs_pointer, ydotool | Implemented |
| Sway | Not yet implemented | Not yet implemented | abs_pointer, portal, ydotool where available | Research target |
| Generic X11 | Best-effort global input only | Not verified | ydotool | Unsupported for targeted window input |

## Current Validation

- `codex-computer-use-linux doctor` reports the active backends and preferred
  input/window/screenshot paths.
- Parser and targeting fixtures live in the Rust test suite under
  `computer-use-linux/src/windowing/`.
- `codex-desktop-doctor` includes the Computer Use doctor summary without
  printing window titles, application names, screenshots, or accessibility tree
  contents.

## Next Safe Expansion

Sway support should start with a fixture parser for `swaymsg -t get_tree`, then
add an activation path only if it can focus an exact window id without relying
on title matching. Until then, Sway remains a research target rather than a
claimed parity backend.
