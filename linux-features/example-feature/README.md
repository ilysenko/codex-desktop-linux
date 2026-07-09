# Example Linux Feature

This is a disabled-by-default example that documents the `linux-features`
contract. It is intentionally harmless and does not patch the real Codex bundle.

To try it locally, copy `linux-features/features.example.json` to
`linux-features/features.json` and add:

```json
{
  "enabled": [
    "example-feature"
  ]
}
```

The example feature declares `entrypoints.patchDescriptors` in `feature.json`.
Its `patch.js` exports `descriptors` that replace a synthetic marker used only
in tests. The example `stage.sh` is a no-op hook that prints a short message.
