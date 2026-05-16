# Experimental Remote Mobile Control

This feature is disabled by default. It patches the upstream Codex Desktop main
bundle so Linux can try the mobile remote-control host flow that upstream
currently limits to macOS.

Enable it by adding the feature id to `linux-features/features.json` before
building:

```json
{
  "enabled": [
    "remote-mobile-control"
  ]
}
```

What it changes:

- Replaces the macOS-only `remote-control-device-key.node` requirement with a
  Linux JavaScript ECDSA P-256 key provider.
- Lets the remote-control Connections UI render on Linux when upstream marks
  the feature unavailable or withholds the remote-control visibility rollout.
- Persists the private key material at
  `~/.config/codex-desktop/remote-control-device-keys-v1.json` with `0600`
  file permissions.
- Preserves `remote_control = true` / `features.remote_control = true` in the
  local Codex config instead of letting upstream strip it before app-server
  startup.
- Updates remote-control settings and Codex mobile setup copy so the Linux flow
  is not described as Mac-only.

KDE Plasma smoke check:

Mobile control depends on the Linux Computer Use backend once the host is
enrolled. On Plasma/Wayland, verify that the KWin backend is ready after
building or installing the package:

```bash
./codex-app/resources/plugins/openai-bundled/plugins/computer-use/bin/codex-computer-use-linux doctor
./codex-app/resources/plugins/openai-bundled/plugins/computer-use/bin/codex-computer-use-linux windows
```

The doctor report should show the KWin window backend, XDG Desktop Portal, and
input checks as ready. The windows report should return `"backend": "kwin"` with
a non-empty `windows` list.

Known risks:

- This is not equivalent to macOS Secure Enclave-backed storage. Private key
  material is file-backed and protected by ordinary user file permissions.
- OpenAI may still reject Linux host enrollment server-side. This feature only
  removes local macOS-only blockers in the repackaged app.
- Treat this as experimental account-level remote-control plumbing.

Run the feature tests with:

```bash
node --test linux-features/remote-mobile-control/test.js
```
