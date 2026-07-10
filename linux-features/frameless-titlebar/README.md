# Frameless Titlebar

This optional feature hides the Linux Electron titlebar overlay controls and
removes the native menu chrome from the main Codex window. It is intended for
compositors or window managers where compositor-managed decorations already
provide the expected window controls, such as Hyprland setups. It is also a
useful diagnostic switch for GNOME/X11 titlebar right-click lockups, because it
removes the Linux Window Controls Overlay path from the main window.

The default build leaves the existing Linux titlebar overlay behavior in place.
Enable this only when the built-in Codex titlebar/buttons visually conflict
with your desktop environment.

Enable it by copying `linux-features/features.example.json` to
`linux-features/features.json` and listing the feature id:

```json
{
  "enabled": [
    "frameless-titlebar"
  ]
}
```

Then rerun `./install.sh` or the native package build flow so the ASAR patches
are regenerated with this feature enabled.

## Testing

Run the feature's unit tests from the repository root:

```bash
node --test linux-features/frameless-titlebar/test.js
```

For a manual check, enable the feature as above, rebuild, and launch the app:

- The primary window should show no Electron-drawn titlebar overlay buttons
  (minimize/maximize/close in the top-right corner) and no menu bar.
- Window move, resize, and close/minimize/maximize should work through your
  compositor's bindings (for example Hyprland's `bindm` mouse binds and
  `killactive`/`fullscreen` dispatchers).
- Changing the system dark/light theme must not crash the app or repaint a
  titlebar strip in the primary window; the patch removes its Linux
  `setTitleBarOverlay` calls while preserving the Quick Chat overlay.
- On GNOME/X11, right-click the same titlebar area that previously locked input
  and verify whether clicks outside the window recover normally. If the issue
  still reproduces, disable the feature again and report the distro, GNOME
  version, session type, and installed `.codex-linux/linux-features-staged.json`.

## Known risks

This removes Codex's Electron-provided Linux titlebar buttons.
Window movement, resize, and close/minimize/maximize controls then depend on
your compositor or desktop environment.
