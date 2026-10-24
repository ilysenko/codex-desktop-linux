# Pet Overlay

This optional Linux feature improves Mini's desktop-pet window placement,
dragging and compositor integration. It is disabled by default and applies
during the normal install or package build pipeline. The application's pet
selection and artwork remain unchanged.

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
        "kwin": true,
        "niri": true
      }
    }
  }
}
```

Selecting `pet-overlay` requires a Rust toolchain with Cargo to build its
bundled helper on all desktop session types, including X11. Before running
`./install.sh` or a direct package build, prepare the enabled native helpers:

```bash
make build-native-feature-helpers
./install.sh
```

`make install-native` performs this preparation automatically. A prebuilt
helper can also be supplied with `CODEX_PET_KWIN_SOURCE=/path/to/codex-pet-kwin`.

`lockPosition: false` preserves manual pet moves when the existing window
position is visible. In this default unlocked mode the overlay is frameless
and the mascot has its own renderer gesture. On native Plasma Wayland,
dragging the mascot moves the whole overlay through KWin; other sessions
reposition the mascot within the view. The application publishes input
regions for the mascot and tray controls. Set
`lockPosition` to `true` only when you want the mascot pinned to the configured
screen corner on every layout pass.

On native Wayland, the drawing surface is bounded by logical display
dimensions. Plasma uses the stable canvas described below; other Wayland
sessions clip the canvas to the current display. The Mini shortcut can open
the editor on its first use after startup through the hidden-window focus
handshake.

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
| `kwin` | `true` or `false` | `true` | Uses KWin scripting only in detected KDE Plasma sessions. |
| `niri` | `true` or `false` | `true` | Uses `niri msg` only in detected Niri sessions. |

Runtime overrides are also supported after restart:

```bash
CODEX_PET_OVERLAY_MARGIN=16
CODEX_PET_OVERLAY_GRAVITY=bottom-left
CODEX_PET_OVERLAY_MODE=passive
CODEX_PET_OVERLAY_LOCK_POSITION=1
CODEX_PET_OVERLAY_HYPRLAND=0
CODEX_PET_OVERLAY_KWIN=0
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

### Pointer proximity

Chromium cannot report a global cursor position on Wayland, so the upstream
pointer-proximity tracking never sees a pointer leaving the visible mascot and
the transparent overlay surface keeps accepting clicks. On Hyprland the
compositor owns the real cursor position, so the feature polls
`hyprctl cursorpos` and refreshes the overlay client's real rectangle from
`hyprctl clients -j`.

The poll only supplies data. Upstream's own proximity tracking stays the single
publisher, so its guards (native layout, notch or pet controls) and its own
enter and exit distances still decide when the pet controls expand. Inside that
tracking method the compositor cursor and window rectangle replace the Electron
values, because Wayland does not keep the Electron content bounds in sync with
the compositor placement; when the compositor cannot be queried the Electron
values are used unchanged.

Polling starts with the overlay window and stops when that window closes.
`hyprctl` failures and unreadable client records are ignored, so upstream's
tracking stays in charge when the compositor cannot be queried.

## KDE Plasma Notes

When `kwin` is enabled, the feature applies above-window, all-desktop,
task-switcher and border hints through KWin's session-bus scripting interface.
Scripts target a single window with the exact `Codex Pet Overlay` title and
current process ID. The runtime uses `qdbus6` or `qdbus`; native Wayland
geometry queries also require `busctl`.

### Native Wayland presentation

Electron's global window coordinates and activation requests are advisory on
Wayland. The native KWin integration addresses the resulting Mini failures:

| Symptom | Handling |
| --- | --- |
| The mascot is clipped or changes position as the drawing area changes. | Keep a stable transparent canvas and move the whole window while retaining the mascot's local grab point. |
| Repeated drags jump back or leave the mascot beyond a screen edge. | Give the renderer-to-KWin bridge ownership of each gesture, enforce the application's edge limits and read the final compositor position. |
| A saved position is replaced during initial placement. | Track programmatic placement separately from user movement and restore the application's saved anchor. |
| Mini briefly appears in the compositor's initial position before reaching its saved position. | Arm KWin placement before mapping the surface, then apply its saved position in the window-added handler. |
| The shortcut opens the editor only after Mini has been shown manually. | Complete the hidden-window focus handshake with cancellable timers; visible windows keep their frame-based scheduling. |
| The editor opens while keyboard input stays in another window. | Activate the matching KWin window when Mini enters keyboard-input mode. |
| Controls disappear while the pointer moves from the mascot to a button. | Track proximity through KWin's actual cursor position and window geometry using the renderer's control rectangles. |
| Dragging the mascot activates the application. | Keep a scoped KWin pointer session that restores the previous active window; release it for explicit editor interaction. |
| Releasing a drag opens the mascot's conversation. | Confirm movement through KWin before running the renderer's click action. |

The canvas fits within the smallest connected display's logical working
dimensions. Its size and the mascot's local position stay fixed throughout a
drag and its settling updates. KWin moves this window with the mascot and
notifications inside it. The visible display intersection feeds the
application's adaptive notification placement; a tray can change sides after
release near an edge. The application continues to publish input regions for
the mascot, editor and controls so transparent space passes clicks through.
The tray frame is limited to the visible canvas and the renderer fits its
scrollable contents to that space. Display changes update the canvas outside
an active drag.

Initial presentation waits for KWin's window-added and focus handlers to be
armed. The window-added handler applies the requested geometry when Mini's
surface appears. Hiding, closing or replacing Mini cancels that pending
presentation. A 1.5-second deadline shows the window and logs a warning if
the handlers cannot be prepared. Updated layout targets replace a pending
placement before the surface is mapped.

The native integration keeps one KWin script and one bundled helper for the
application session. Electron sends bounded commands to the helper over inherited
pipes. The helper exposes a private D-Bus object addressed by its unique bus name,
checks the KWin connection owner and session token, and delivers one command at a
time through KWin's asynchronous `callDBus` callback. Commands carry a window
generation, sequence and deadline. Their acknowledgements confirm execution;
a D-Bus method returning successfully alone does not establish readiness.

Initial connection uses KWin's `Scripting.start` once. This API also re-reads
KWin's script configuration and starts other loaded, pending scripts. Already
running scripts are left running. The bridge's private acknowledgement identifies
its own startup. KWin configuration and system packages remain unchanged.

Pointer mode restores the previous eligible active window when Mini receives
activation, including activation before `windowAdded`. Preparing a window arms
placement and pointer mode before mapping. Entering the editor waits for the
pointer-policy acknowledgement before requesting keyboard focus. Hiding or
replacing Mini invalidates pending commands and sends Stop. Stop disables movement
and focus restoration before acknowledging; an already delivered command may
execute before Stop is processed.

A drag retains its original local grab point and the application's per-display
movement limits. Motion runs inside KWin; release waits for EndDrag's actual final
geometry before saving the position. A subsequent gesture waits for the previous
stop. Chromium app regions use `no-drag` so ordinary pointer gestures follow the
same lifecycle after renderer reloads. Geometry boundary queries use `busctl`;
local layout and coordinate consumers reuse cached compositor geometry.

Each renderer gesture has its own identifier. Its release waits for the matching
compositor result before deciding whether to run a click action. KWin remembers
movement beyond the application's four-pixel threshold, including a drag that
returns to its starting point. A missing or stale acknowledgement suppresses the
click action. Release cancels a matching queued gesture before it can start after
a placement or previous-release acknowledgement. With `lockPosition: true`,
ordinary mascot clicks retain their handling while position stays pinned.

Control proximity uses the renderer's existing mascot and control rectangles,
KWin's cursor position and the actual window origin. Only near/far changes cross
D-Bus, including when layout or window geometry changes. Transparent gaps remain
click-through while the control expansion follows the existing hysteresis.

The helper sends an idle transport heartbeat every 500 ms. If communication stops,
the script disconnects its handlers after two seconds. An individual drag also
expires after 30 seconds. A command acknowledgement timeout or queue overflow closes the current
bridge. Input and control proximity return to the application's local handling;
the next show of Mini attempts a fresh bridge connection. Construction failures
are isolated from layout and input publication. Entering the editor waits for a
failed helper to finish teardown before proceeding with local keyboard activation.
On EOF, SIGTERM, SIGINT, SIGHUP or a KWin owner change, the helper unloads only its
own unique script name and checks removal for a bounded interval. Cleanup targets
the original KWin connection. Its files and queued requests are bounded; normal
application exit removes the bridge's temporary directory.

When compositor helpers are unavailable, the mascot uses local movement within
the overlay. Failed final geometry confirmation retains the last saved position
and logs a warning. A gesture handled entirely by the application's local path
keeps its normal release and click behavior. Packages, their update-builder and
Nix carry the prepared helper when `pet-overlay` is selected.
Stationary compositor-confirmed clicks preserve the current snap/free-position
state, including with Alt held; deferred content layout still runs on release.

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
- On native Wayland, opening Mini should show the mascot within the screen;
  its notification tray should also stay visible when expanded.
- With `lockPosition: false`, it should be frameless. Dragging the mascot
  should move the whole overlay on native Plasma Wayland and reposition it
  inside the view in other sessions.
  Tray controls should remain clickable.
- Selecting a different pet should update the open overlay without restarting Codex.
- On Hyprland, the pet should have no visible compositor border or shadow.
- On Hyprland, moving the pointer away from the mascot should collapse the
  controls, and moving it back should expand them again. The pointer position
  used for that decision comes from the compositor, not from Chromium.
- On Niri, the pet should open floating, avoid initial focus, and move by
  targeted window id.
- On KDE Plasma Wayland, the pet should stay above normal windows and follow
  direct pointer drags without requiring a modifier key.
- On native Plasma Wayland, the first mascot drag should preserve its distance
  from the cursor, cross the previous overlay edges, and retain the final
  position after release. Repeat several ordinary left-button drags in the
  center and at each edge. Hiding Mini during a drag should stop the movement.
- Start another drag while a placement request is pending: the new gesture
  should keep its original grab point. Expanding notifications and settling
  the drag should preserve the mascot's local position within its canvas.
- After moving Mini, move the pointer from the mascot to its collapsed
  controls and expand them. The controls should remain available while the
  pointer crosses between them and the mascot. Empty transparent areas should
  allow clicking the window beneath Mini, and the expanded editor should
  accept pointer and keyboard input.
- Keep another application focused, then show and drag the mascot. Both the
  first presentation and mouse release should preserve that application's focus.
  Repeat after opening and leaving Mini's editor.
- Move the mascot, quit and relaunch the app, then open Mini: its position
  should be restored on the first visible frame. Hide it while initial placement
  is pending and confirm it stays hidden. Repeat on a secondary display with a negative origin
  and a different scale, and expand notifications near each screen edge.
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
or z-order changes. Hyprland, KWin, and Niri support is best-effort and
deliberately scoped to a single unambiguous matched avatar window.
