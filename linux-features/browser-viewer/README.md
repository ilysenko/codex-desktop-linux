# Browser Viewer

Optional Linux feature that unlocks the native side-panel browser and its
`Ctrl+Shift+B` hotkey in extracted Codex Desktop bundles.

The loader reads enabled feature ids from the root config at
`linux-features/features.json`, then loads this feature's manifest from
`linux-features/browser-viewer/feature.json`.

To enable it locally, create the root config if needed:

```bash
cp linux-features/features.example.json linux-features/features.json
```

Then list `browser-viewer` in `linux-features/features.json`:

```json
{
  "enabled": [
    "browser-viewer"
  ]
}
```

This feature patches the browser sidebar availability bundle so the Statsig
gate and the `in_app_browser` experiment both resolve enabled at runtime.

Run the Linux window patch tests with:

```bash
node --test scripts/patch-linux-window-ui.test.js
```

To validate it against an extracted app bundle, enable `browser-viewer` in the
Linux features config and run:

```bash
node scripts/patch-linux-window-ui.js /path/to/extracted/app.asar
```

Known risk: the patch depends on specific minified browser availability bundle
shapes. If upstream changes those blocks, the patch warns and leaves the bundle
unchanged instead of forcing a broken replacement.
