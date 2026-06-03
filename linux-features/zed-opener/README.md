# Zed Opener

Historically added Zed as an opt-in Linux editor opener in Codex Desktop. Core
Linux patching now enables the same Zed opener by default, and this feature is
kept as a compatibility wrapper for local configs that still list
`zed-opener`.

The loader reads enabled feature ids from the root config at
`linux-features/features.json`, then loads this feature's manifest from
`linux-features/zed-opener/feature.json`.

To enable it locally, create the root config if needed:

```bash
cp linux-features/features.example.json linux-features/features.json
```

Then list `zed-opener` in `linux-features/features.json`:

```json
{
  "enabled": [
    "zed-opener"
  ]
}
```

The Linux opener detects these commands in `PATH`, in order:

- `zed`
- `zeditor`
- `zedit`
- `zed-cli`

Run the feature tests with:

```bash
node --test linux-features/zed-opener/test.js
```

To validate it against an extracted app bundle, enable `zed-opener` in a Linux
features config and run:

```bash
node scripts/patch-linux-window-ui.js /path/to/extracted/app.asar
```

Known risk: the patch depends on the upstream minified Zed opener block. If
that block changes shape, the core patch and compatibility feature fail soft
and leave the bundle unchanged.
