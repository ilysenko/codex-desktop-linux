# Wayland/X11 composer input dead — root-cause investigation (issue #569)

Date: 2026-06-26
Investigated live on: Ubuntu 25.10, GNOME, Wayland session (Electron 42.1.0 /
Chromium 148, Codex 26.623.31921).

## Symptom

App opens, UI is clickable (model selector, "Full Access" dropdown, buttons all
work), but the **main composer text input cannot be focused or typed into**.
User observation that cracked the case: *clicking the Codex window does not give
it keyboard focus — keystrokes keep going to the previously-focused window (the
terminal). The window "looks like a modal" / never focuses.*

## How it was diagnosed (empirical, not guesswork)

The installed app was launched with Chrome DevTools Protocol enabled:

```
./codex-app/start.sh -- --remote-debugging-port=9222 --remote-allow-origins=*
```

and inspected over CDP (see `scratchpad/cdp*.py`). Then the real X11 window was
inspected with `xprop` / `xwininfo` (works because under XWayland the Electron
window is a real X11 window).

### Finding 1 — the editor/DOM is completely healthy
Via CDP `Runtime.evaluate` on the page:
- `document.activeElement` is already `DIV.ProseMirror`.
- `.ProseMirror` has `contenteditable="true"`, `isContentEditable=true`,
  `-webkit-user-modify: read-write`, `pointer-events: auto`, not
  disabled/readonly, `-webkit-app-region: no-drag`.

➡️ The "app renders the composer non-editable / focus-blocked" theory is
**false**. The composer is fully editable and is the active element.

### Finding 2 — the renderer never has focus
- `document.hasFocus()` === **false** while the window is visible.
- Main-process logs confirm it: `rendererWindowFocused=false`.

### Finding 3 — forcing renderer focus shows a caret but does NOT enable typing
Via CDP `Emulation.setFocusEmulationEnabled({enabled:true})`:
- `document.hasFocus()` flips to **true**, `.ProseMirror` gains the
  `ProseMirror-focused` class, a caret appears.
- BUT real hardware keystrokes still do not enter text (user confirmed: "I saw
  the cursor but couldn't type").

### Finding 4 — the editor accepts input through the browser process
Via CDP:
- `Input.insertText("CDP_INSERT_OK")` → text appears.
- `Input.dispatchKeyEvent` for "KEY9" → text appears.

`Input.dispatchKeyEvent` injects at the Electron **browser-process** level,
bypassing the OS/compositor. It works. So the editor is fine; the break is
between the **OS/compositor and Electron** — real keyboard events never reach
the window.

### Finding 5 (root cause) — the window is override-redirect / unmanaged
`xprop` on the real Codex window (under XWayland):

```
WM_CLASS            = "codex-desktop", "codex-desktop"
WM_NAME             = "Codex"
_NET_WM_WINDOW_TYPE = _NET_WM_WINDOW_TYPE_NORMAL
_NET_WM_STATE       = _NET_WM_STATE_SKIP_PAGER, _NET_WM_STATE_SKIP_TASKBAR
WM_HINTS            = not found            <-- no input hint
Override Redirect State: yes               <-- THE BUG
Map State: IsViewable
```

`Override Redirect State: yes` means the window **bypasses the window manager**.
The WM does not manage it, does not route keyboard focus to it, does not list it
in the taskbar, and clicking it does not activate it. That explains every
symptom at once:
- mouse works (pointer events go to the window under the cursor regardless of WM),
- keyboard goes wherever the WM thinks focus is (the terminal),
- `document.hasFocus()` is permanently false,
- identical breakage on Wayland and X11 (the cause is in window creation, not the
  backend).

### Finding 6 — why the window is override-redirect
The 26.623 upstream bundle builds the primary `BrowserWindow` options as a flat
object with **explicit** (non-spread) keys:

```
show:l, parent:p, focusable:m, ...platformOpts,
backgroundMaterial:bm??void 0, ...appearanceOpts,
minWidth:sz?.width, minHeight:sz?.height, webPreferences:wp
```

When `parent` / `focusable` / `backgroundMaterial` / `minimumSize` are
undefined, these become literal `parent:undefined`, `focusable:undefined`,
`backgroundMaterial:void 0`, `minWidth:undefined` options. Electron/Chromium on
Linux mishandles those explicit-undefined options and creates an **unmanaged
(override-redirect)** window. Confirmed: the installed patched `app.asar`
contains exactly one such options object (`show:l,parent:p,focusable:m,...`).

## The fix — PR #578 ("Fix X11 BrowserWindow option handling")

PR #578 (`fix/x11-browserwindow-options`, Fixes #576) rewrites those options to
**conditional spreads**, so an undefined option is simply absent:

```
show:l,
...p==null?{}:{parent:p},
...m==null?{}:{focusable:m},
...platformOpts,
...bm==null?{}:{backgroundMaterial:bm},
...appearanceOpts,
...sz==null?{}:{minWidth:sz.width,minHeight:sz.height},
webPreferences:wp
```

PR author verified on Zorin OS/X11 that the rebuilt window is **managed by the
WM, exposes WM_STATE, and supports move/minimize/maximize**. That is precisely
the override-redirect → managed transition we need. Once the window is managed it
receives real WM keyboard focus, `document.hasFocus()` becomes true on click, and
real keystrokes reach the (already-healthy) composer.

Implementation: `applyDefinedBrowserWindowOptionsPatch()` in
`scripts/patches/impl/main-process/window.js`.

## Why every earlier attempt failed (and looked plausible)

All earlier hypotheses targeted layers that were not broken:

1. **Avatar-overlay focus-trap patches (#575/#577, commit 77c353d)** — overlay
   was not the cause; the main window itself was unmanaged. No change.
2. **`linux-editable-no-drag` CSS** — composer already had
   `-webkit-app-region: no-drag`; CSS was never the blocker. No change.
3. **Main-process `electron-window-focus-request` → BrowserWindow.focus() /
   webContents.focus()** — you cannot focus an override-redirect window via the
   WM; `.focus()` is a no-op for an unmanaged surface. No change.
4. **Removing Wayland auto `--disable-gpu-compositing`** — unrelated to focus;
   reverted (GPU path adds other problems). No change.
5. **Disabling the Linux titlebar overlay / native-titlebar experiment** — the
   override-redirect comes from the window *options*, not the titlebar style, so
   reverting the titlebar changed nothing. No change.
6. **`Emulation.setFocusEmulationEnabled` (renderer focus emulation)** — fixes
   the *renderer's* focus state (caret appears, `document.hasFocus()`=true) but
   not the *OS-level* keyboard routing, because the window still has no WM
   keyboard focus. Cursor appears, typing still dead.

The unifying reason: real keyboard input is delivered by the window manager to
the focused managed window. An override-redirect window is never given that
focus, so no renderer- or app-level change can make hardware keys arrive.

## Verification checklist after applying #578

1. Rebuild: `./install.sh ./Codex.dmg`.
2. Launch and inspect the window with `xprop` (under XWayland) — expect
   `Override Redirect State: no` and a present `WM_STATE` / `WM_HINTS`.
3. Click the window: `document.hasFocus()` should become true on its own (no
   emulation needed).
4. Type in the composer — text should appear. (Confirmed by user.)

## Reusable diagnostics (in scratchpad)

- `cdp.py '<js>'` — evaluate JS in the live page over CDP.
- `cdp_focus_test.py` — toggle `setFocusEmulationEnabled` and read focus state.
- `cdp_keylog_native.py` — log real keydown events + composer text (no emulation).
- `xprop -id <win> WM_CLASS WM_NAME _NET_WM_WINDOW_TYPE _NET_WM_STATE WM_HINTS` +
  `xwininfo -id <win> | grep -i "override"` — confirm managed vs override-redirect.
</content>
