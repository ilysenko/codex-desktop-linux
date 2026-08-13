# Frameless Titlebar

This optional feature hides Electron-drawn Linux window-control overlay buttons
and the in-app application menu on the primary and Quick Chat Community windows.
The official Linux package still creates those windows with
`titleBarStyle: hidden` plus `titleBarOverlay`, then reapplies the overlay from
`setWindowZoom` and `installApplicationMenuTitleBarOverlaySync`. Official Linux
webview chrome still maps Electron Linux to `application-menu`.

This feature keeps the hidden titlebar style so compositor-managed decorations
remain, stops Linux from receiving the overlay, and remaps Linux webview chrome
to `native`.

Use it on compositors or window managers that already provide move, resize,
minimize, maximize, and close, such as Hyprland. It is also a diagnostic
switch for GNOME/X11 titlebar right-click lockups, because it removes the
Linux Window Controls Overlay path from the main window.

The default build leaves the official Linux overlay buttons in place. Enable
this only when those built-in buttons conflict with your desktop environment.

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
are regenerated with this feature enabled. A reload is not enough: the overlay
is created when the window is constructed.

## What it patches

| Surface | Current official contract | Result on Linux |
|---|---|---|
| Main window options | `win32\|\|linux` hidden titlebar plus `titleBarOverlay` | Linux keeps `titleBarStyle: hidden` and does not receive an overlay |
| Zoom overlay | `setWindowZoom` calls `setTitleBarOverlay` on Linux | Overlay updates stay Windows-only |
| Theme overlay sync | `installApplicationMenuTitleBarOverlaySync` runs on Linux | Theme changes do not restore Linux overlay buttons |
| Webview chrome mapping | Electron Linux uses `application-menu` | Linux uses `native` chrome and hides the in-app menu |

The official Linux webview already uses a 0px inset for both `default` and
`application-menu` layouts. This feature does not rewrite that inset, does not
patch the user-agent layout gate, and does not depend on retired DMG
`codexLinuxUseWindowControlsSafeArea` markers.

Missing, mixed, duplicate, or drifted contracts leave the source
byte-identical and report optional drift. An already-patched official bundle
is recognized as applied and is left unchanged.

## Testing

Run the feature's unit tests from the repository root:

```bash
node --test linux-features/frameless-titlebar/test.js
```

For a manual check, enable the feature as above, rebuild, fully quit every
ChatGPT Community and official ChatGPT process, then launch the app:

- The primary and Quick Chat windows should show no Electron-drawn titlebar
  overlay buttons (minimize/maximize/close in the top-right corner) and no menu
  bar.
- The rightmost app-header control should retain the standard 8px end padding
  instead of touching the window edge or an overlay scrollbar.
- Window move, resize, and close/minimize/maximize should work through your
  compositor's bindings (for example Hyprland's `bindm` mouse binds and
  `killactive`/`fullscreen` dispatchers).
- Changing the system dark/light theme must not crash the app or repaint a
  titlebar strip in either window.
- On GNOME/X11, right-click the same titlebar area that previously locked input
  and verify whether clicks outside the window recover normally. If the issue
  still reproduces, disable the feature again and report the distro, GNOME
  version, session type, and installed `.codex-linux/linux-features-staged.json`.

## Known risks

This removes Codex's Electron-provided Linux titlebar buttons.
Window movement, resize, and close/minimize/maximize controls then depend on
your compositor or desktop environment.
