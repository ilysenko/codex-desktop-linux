# External App-Server Attachment

This optional Linux feature attaches Desktop to an existing local app-server. Enable it locally by listing `external-app-server-attachment` in the ignored `linux-features/features.json`. It conflicts with `shared-app-server-socket`; enable only one.

## Attachment descriptor

Unless either `CODEX_LINUX_APP_SERVER_BRIDGE_ATTACH_ONLY` or `CODEX_LINUX_APP_SERVER_BRIDGE_SOCKET` is already present, the launcher reads:

```text
${XDG_CONFIG_HOME:-$HOME/.config}/${CODEX_LINUX_APP_ID:-codex-desktop}/app-server-attachment.json
```

The descriptor must have exactly this JSON schema:

```json
{
  "schemaVersion": 1,
  "socketPath": "/absolute/normalized/path/app-server.sock",
  "transport": "unix"
}
```

The descriptor must be a regular `0600` file owned by the current Linux UID. Its immediate parent must be a real directory owned by that UID and not writable by group or other users. The socket path must be absolute, normalized, and free of C0 control characters.

The selected socket must have a canonical, symlink-free parent owned by the current user, with owner read and execute access and no group or other write access. The endpoint itself must be a real Unix socket owned by the current user, with owner read and write access and no group or other permissions. Any failed trust check stops attachment without fallback.

Explicit environment values take precedence and bypass descriptor reading. An absent descriptor emits no routing and allows ordinary startup. A present but invalid descriptor fails the hook with one safe diagnostic and emits no routing. A valid descriptor selects strict attach-only mode: if the external endpoint cannot be trusted or reached, Desktop fails instead of falling back to another transport.

Desktop never starts, stops, locks, reclaims, unlinks, or otherwise mutates the external socket or app-server. The external supervisor remains the sole lifecycle owner.
