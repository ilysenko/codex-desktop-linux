# Open Target Discovery

Optional Linux open-target integration for Codex Desktop.

When enabled, this feature augments the upstream open-target menu with:

- a Terminal target discovered from `xdg-terminal-exec`, common terminal commands, or `.desktop` entries marked as terminal emulators
- Linux IDE/editor targets from known command-line launchers and dynamic `.desktop` discovery, including XDG, Flatpak, Snap, and JetBrains Toolbox-style entries
- a richer File Manager target that prefers installed file managers and can reveal files in Dolphin or Nautilus before falling back to Electron `shell.openPath`

The feature is disabled by default. Enable it locally by copying `linux-features/features.example.json` to `linux-features/features.json` and listing:

```json
{
  "enabled": [
    "open-target-discovery"
  ]
}
```

Use this feature for Zed and other Linux editor targets.

Run the feature tests with:

```bash
node --test linux-features/open-target-discovery/test.js
```
