# Remote Control UI

Opt-in Linux UI patches for upstream `remote_control` and related settings surfaces.

This feature only opens the Linux UI gates. It does not fake backend state such
as connected clients, MFA completion, or remote control environments.

The official webview is an rspack build: the patches find their chunks by the
Statsig gate ids and settings strings they edit, and patch every chunk that
carries its own copy of a shared module (the remote-control visibility owner
and the experimental features filter are duplicated across async chunks).

Enable it locally in `linux-features/features.json` with:

```json
{
  "enabled": [
    "remote-control-ui"
  ]
}
```

Run the feature tests with:

```bash
node --test linux-features/remote-control-ui/test.js
```
