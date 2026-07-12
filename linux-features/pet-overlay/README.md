# Pet Overlay

This optional Linux feature makes the Codex avatar window behave more like a
desktop pet overlay on compositors that support the required window hints. It
is disabled by default and lives entirely under `linux-features/`.

It does not install a custom pet, change the default pet, modify the pet
selector, or patch an already built `app.asar`. It only patches the avatar
overlay window behavior during the normal install or package build pipeline.

Enable it by copying `linux-features/features.example.json` to
`linux-features/features.json` and listing the feature id:

```json
{
  "enabled": [
    "pet-overlay"
  ]
}
```

Feature settings can be overridden in the gitignored `features.json` file:

```json
{
  "enabled": [
    "pet-overlay"
  ],
  "settings": {
    "pet-overlay": {
      "petOverlay": {
        "gravity": "bottom-right",
        "margin": 24,
        "allWorkspaces": true,
        "alwaysOnTop": true,
        "skipTaskbar": true,
        "lockPosition": false,
        "mode": "interactive",
        "hyprland": true,
        "niri": true
      }
    }
  }
}
```

`lockPosition: false` preserves manual pet moves when the existing window
position is visible. Set it to `true` only when you want the mascot pinned to
the configured screen corner on every layout pass.

## Options

| Key | Values | Default | Meaning |
| --- | --- | --- | --- |
| `gravity` | `bottom-right`, `bottom-left`, `top-right`, `top-left` | `bottom-right` | Screen corner used when `lockPosition` is enabled. |
| `margin` | `0` to `512` | `24` | Pixel gap from the selected screen edges. |
| `allWorkspaces` | `true` or `false` | `true` | Calls Electron `setVisibleOnAllWorkspaces` where supported. |
| `alwaysOnTop` | `true` or `false` | `true` | Calls Electron `setAlwaysOnTop`. |
| `skipTaskbar` | `true` or `false` | `true` | Keeps the pet out of task switchers where supported. |
| `lockPosition` | `true` or `false` | `false` | Pins to `gravity` when true; otherwise keeps a visible manual position. |
| `mode` | `interactive` or `passive` | `interactive` | `passive` makes the pet window non-focusable. |
| `hyprland` | `true` or `false` | `true` | Uses `hyprctl` only in detected Hyprland sessions. |
| `niri` | `true` or `false` | `true` | Uses `niri msg` only in detected Niri sessions. |

Runtime overrides are also supported after restart:

```bash
CODEX_PET_OVERLAY_MARGIN=16
CODEX_PET_OVERLAY_GRAVITY=bottom-left
CODEX_PET_OVERLAY_MODE=passive
CODEX_PET_OVERLAY_LOCK_POSITION=1
CODEX_PET_OVERLAY_HYPRLAND=0
CODEX_PET_OVERLAY_NIRI=0
```

The feature keeps GPU compositing enabled by default so the transparent overlay
can render correctly. An explicit user value takes precedence: launching with
`CODEX_ELECTRON_DISABLE_GPU_COMPOSITING=1` still enables the documented Wayland
stability workaround if the main window flickers or leaves stale frame trails.

The legacy `CODEX_PET_LINUX_*` names from the prototype are still accepted for
local compatibility.

## Hyprland Notes

When `hyprland` is enabled, the feature reads `hyprctl clients -j`, selects
only an unambiguous floating window with the exact `Codex Pet Overlay` title,
the current process ID, and matching geometry, then applies targeted
compositor actions to the matched `address:0x...` selector. When position
locking is enabled, it also uses Hyprland's native window movement dispatch so
the computed position is respected on Wayland.

Workspace pinning and top-order changes follow `allWorkspaces` and
`alwaysOnTop`; disabling either setting actively removes the corresponding
Electron hint and stops issuing that Hyprland action.

Hyprland command failures are ignored so launching Codex does not depend on
`hyprctl` being present.

## Niri Notes

When `niri` is enabled, the feature reads `niri msg --json windows`, selects
only an unambiguous window with the exact `Codex Pet Overlay` title and the
current process ID, then targets that numeric window id with
`move-window-to-floating` and `move-floating-window`. Movement uses the
output-local coordinates of the Electron working area, not global desktop
coordinates. The actions are skipped if the window is ambiguous, foreign,
malformed, stale, or if `niri` is unavailable.

Live drag movement uses a separate single-flight transport. At most one Niri
action is active at a time, pending pointer positions replace each other, and
only the latest target is sent after the active action completes. A tiled Pet
is moved to the floating layout before its first position action. On release,
the final target is drained before the overlay bounds are persisted, preventing
late compositor callbacks from snapping the Pet back to an older position.
Discovery and action recovery are bounded for each drag, and callbacks are
scoped to the current overlay window and drag generation.

The runtime keeps the first presentation non-focusable while using
`showInactive()`, then restores focusability for interactive mode so inline
replies can still receive focus. For the cleanest first compositor frame on
Niri, you can also add a window rule that matches the pet overlay:

```kdl
window-rule {
    match title="^Codex Pet Overlay$"
    open-floating true
    open-focused false
}
```

The runtime IPC path still applies after launch, so manual unlocked placement
and locked gravity can continue to sync through the same opt-in feature.

## Testing

Run the feature unit tests from the repository root:

```bash
node --test linux-features/pet-overlay/test.js
```

For a manual check, enable the feature, rebuild, and launch the app:

- The pet overlay should remain transparent.
- Selecting a different pet should update the open overlay without restarting Codex.
- On Hyprland, the pet should have no visible compositor border or shadow.
- On Niri, the pet should open floating, avoid initial focus, and move by
  targeted window id.
- On Niri with `lockPosition: false`, rapidly reverse a horizontal drag; the
  pet should follow the latest pointer target without delayed overshoot or a
  snap-back after release.
- The pet should remain above normal windows and visible across workspaces where
  the compositor honors those hints.
- With `lockPosition: false`, dragging the pet should not snap it back on the
  next click, tab switch, or overlay layout update.
- With `lockPosition: true`, the mascot should stay at the configured corner.

## Known Risks

Wayland compositors may reject app-driven positioning, all-workspace visibility,
or z-order changes. Hyprland and Niri support is best-effort and deliberately
scoped to a single unambiguous matched avatar window.
