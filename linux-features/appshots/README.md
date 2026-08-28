# Linux AppShots

`linux-features/appshots` exposes the upstream AppShots composer entry on
Linux. It attaches a selected window screenshot plus best-effort AT-SPI text to
the composer.

This feature is disabled by default. Enable it before building:

```json
{
  "enabled": [
    "appshots"
  ]
}
```

The feature is self-contained. It patches only the optional AppShots webview
availability gate and the Electron main-process AppShots handlers. Upstream no
longer ships the AppShots hotkey settings surface, so the feature does not
patch or expose a Linux hotkey selector. It does not add AppShots-specific code
to `computer-use-linux`, core patch modules, default patch flow, or packaged
runtime hooks.

For window metadata and AT-SPI text, the feature shells out to the bundled
Linux Computer Use backend's existing `windows` and `state` commands. For the
screenshot, it uses an available desktop screenshot CLI such as `grim`,
`spectacle`, `gnome-screenshot`, `maim`, `scrot`, or ImageMagick `import`, then
crops the image to the focused window bounds in Electron.

Privacy and correctness constraints:

- The feature may briefly create a full-screen temporary screenshot before
  cropping it to the focused window.
- Opening the composer menu focuses ChatGPT. On Hyprland, the feature offers a
  generic window attachment and opens an installed Hyprland share picker after
  the user activates it. It prefers `hyprland-preview-share-picker`, falls back
  to `hyprland-share-picker`, and accepts an explicit executable through
  `CODEX_LINUX_APPSHOT_PICKER`; these use the picker protocol shipped by
  `xdg-desktop-portal-hyprland`. The preview picker is a Wayland layer-shell
  overlay rather than a tiled Hyprland client. For that preview picker only,
  AppShots opens its window page using a temporary derived config, preserving
  and never modifying the user's picker config. Legacy and explicitly supplied
  custom pickers receive no preview-only command-line arguments and retain
  their own default page. AppShots also forces the picker to use native GTK and
  Qt Wayland backends so a launcher-level X11 compatibility setting cannot turn
  that layer-shell overlay into a tiled XWayland client. Because ordinary
  screenshot CLIs can only read the visible
  workspace, the selected window is activated briefly. Its identity, focus,
  visibility, and stable bounds are verified before and after pixel capture,
  and ChatGPT restoration is verified before any attachment is delivered. The
  feature resolves the active Hyprland instance from the runtime directory when
  the Electron environment does not inherit `HYPRLAND_INSTANCE_SIGNATURE`. On
  EWMH-compatible X11 window managers, the feature selects the topmost external
  window in stacking order. Both paths skip ChatGPT and desktop portal windows.
  Other backends fail closed when they cannot provide a safe target.
- Capture fails closed when no selected window or usable bounds are available.
- Capture fails closed when no screenshot tool is available or the crop does not
  intersect the captured image. The portal picker also exposes Output and
  Region pages, but this window-attachment integration accepts only an explicit
  Window selection and fails closed for the other result types.
- Window pixels and best-effort accessibility text are collected concurrently.
  ChatGPT is restored as soon as both inputs have been acquired, before the PNG
  and metadata are sent back to the composer. Capture transactions are
  serialized so two requests cannot race compositor focus or exchange targets.
- Global hotkeys remain disabled on Linux because the current upstream package
  no longer includes the AppShots hotkey settings surface.
- Previously saved `Alt + Alt` and `Shift + Shift` choices are backed by a feature-local
  `bare-modifier-monitor` helper staged into `resources/native/`. It requires
  the left and right modifier keycodes, so tapping only one physical modifier
  twice does not trigger AppShots. It reads one root XInput2 event stream and
  stops that listener when its Electron parent exits. It uses `xinput` and
  `xmodmap`, so it is expected to work on X11 sessions and fail closed elsewhere.
- On Wayland, the feature stages an Electron args hook that enables
  `GlobalShortcutsPortal`; X11-only bare-modifier shortcuts still fail closed.

Run the feature self-test:

```bash
node --test linux-features/appshots/test.js
```

To test in the app, enable the feature, rebuild the dev app, open a chat, open
the composer attachment/context menu, and use the AppShot entry.
