# Linux AppShots

`linux-features/appshots` exposes the upstream AppShots composer entry on
Linux. It attaches the focused window screenshot plus best-effort AT-SPI text
to the composer.

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
- Capture fails closed when no focused window or usable bounds are available.
- Capture fails closed when no screenshot tool is available or the crop does not
  intersect the captured image.
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
