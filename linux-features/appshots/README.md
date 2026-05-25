# Linux AppShots

`linux-features/appshots` exposes the upstream AppShots UI on Linux. It routes
capture requests to the bundled Linux Computer Use backend and attaches the
focused window screenshot plus AT-SPI text to the composer.

This feature is disabled by default. Enable it before building:

```json
{
  "enabled": [
    "appshots"
  ]
}
```

The backend refuses to create an AppShot when it cannot identify focused-window
bounds, when the window bounds do not intersect the screenshot, or when GNOME
Shell / XDG Desktop Portal screenshot capture fails. It does not use the CLI
screenshot fallback used by the standalone `screenshot` command.

Global hotkeys are disabled by default on Linux. After opting into the feature,
use the AppShots settings page to configure a hotkey such as both Shift keys,
both Alt keys, or `Ctrl+Alt+A`.

Backend-only test:

```bash
./codex-app/resources/plugins/openai-bundled/plugins/computer-use/bin/codex-computer-use-linux appshot
```
