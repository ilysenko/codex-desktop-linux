# Dock Icon

Optional current-DMG support for the upstream Appearance setting that switches
between the official ChatGPT and Codex app icons.

The feature stages the original PNG resources from the upstream macOS bundle
and applies the selected icon to Linux Electron windows and the system tray.
The selection remains owned by the upstream `dockIconPreference` setting. The
Codex option follows the system light or dark appearance, matching the macOS
behavior.

This changes the icon of running app windows. A desktop environment may keep
using the icon declared by its pinned `.desktop` launcher for a fixed launcher
entry.

Enable it in `linux-features/features.json`:

```json
{
  "enabled": [
    "dock-icon"
  ]
}
```

Run the feature tests with:

```bash
node --test linux-features/dock-icon/test.js
```
