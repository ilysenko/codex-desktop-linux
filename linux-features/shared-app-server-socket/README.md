# Shared App-Server Socket

This opt-in feature makes the Codex app-server used by Desktop available on a
user-private Unix socket. It does not implement, inspect, filter, or translate
the app-server protocol.

From an SSH client's point of view, this behaves like an ordinary Codex SSH
app-server connection. The remote `codex app-server proxy` command still
provides the same stdio/WebSocket byte stream and the same app-server methods,
notifications, approvals, and thread authority. The only difference is that the
proxy attaches to Desktop's existing authority instead of starting a separate
app-server with a separate thread namespace.

Desktop owns one selected Codex CLI child running `app-server --listen
unix://PATH`. Desktop connects through the CLI's stock `app-server proxy --sock
PATH` byte tunnel and its existing WebSocket transport. Other local clients use
the same stock proxy command to attach to the Unix socket and receive the normal
WebSocket `/rpc` byte stream. Closing Desktop stops the authority.

The launcher uses the official CLI bundled in `resources/codex` by default.
An explicit `CODEX_CLI_PATH` remains supported and is preserved by the feature
hook.

The default socket is scoped by Linux app id under `XDG_RUNTIME_DIR`, preventing
side-by-side Desktop instances from sharing an authority accidentally. Override
it with `CODEX_LINUX_APP_SERVER_BRIDGE_SOCKET` when a stable path is required.
The Codex app-server creates the socket with user-only permissions. A shell
wrapper may route bare `codex app-server proxy` SSH sessions to this path.
Keep the socket in a directory accessible only to the owning user. It is a local
control endpoint and must not be exposed directly over TCP or forwarded as a
network service.

Authority startup is serialized by an owner-only lock next to the socket. The
lock records the owning Linux process identity, so a later Desktop launch can
reclaim it only when that exact process no longer exists. An existing socket is
probed before recovery: connectable endpoints and live or unverifiable owners
still fail closed, while an unbound socket inode from the dead owner is removed
only if its filesystem identity is unchanged.
Legacy locks without owner metadata remain protected for 15 seconds, longer
than the authority startup timeout, before they can be reclaimed when no socket
exists.

The launcher also cleans up a live authority orphaned by a terminated Desktop
process. Cleanup is limited to a same-user `codex app-server --listen unix://PATH`
process serving the exact locked socket after direct PID 1 adoption or adoption
by a verified same-user `systemd --user` manager whose own parent is PID 1. Once
the authority is ready, its PID and process-start identity are recorded in the
ownership lock. The lock owner, socket inode, listener identity, command line,
and process start identities are rechecked before signaling it. Unknown
listeners, live Desktop owners, changed identities, and pathnames with multiple
live listener inodes remain untouched. The same cleanup runs after Electron exits
and before a later cold start.

## SSH setup

Use a stable socket path when the Desktop instance will be reached over SSH:

```bash
export CODEX_LINUX_APP_SERVER_BRIDGE_SOCKET="$HOME/.codex/app-server-control/app-server-control.sock"
codex-desktop
```

Then place a small `codex` wrapper earlier in the SSH user's `PATH`. Set
`real_codex` to the actual CLI executable, not to the wrapper itself:

```bash
#!/usr/bin/env bash
set -eu

real_codex="/absolute/path/to/real/codex"
desktop_socket="$HOME/.codex/app-server-control/app-server-control.sock"

if [ "$#" -eq 2 ] && [ "$1" = "app-server" ] && [ "$2" = "proxy" ]; then
    exec "$real_codex" app-server proxy --sock "$desktop_socket"
fi

exec "$real_codex" "$@"
```

The upstream SSH transport normally starts its own authority before invoking
the proxy. Configure the **remote account's login-shell environment** to skip
that bootstrap when this wrapper is used:

```bash
export CODEX_SSH_SKIP_APP_SERVER_BOOT=true
```

Put that export in the startup file read by the account's SSH login shell (for
example `~/.profile` when that is the active login profile). This is remote
account configuration; setting it only in the local Desktop launcher does not
propagate it through SSH. Use it only for an account whose wrapper is dedicated
to this Desktop-owned socket.

Make the wrapper executable and verify that non-interactive SSH resolves it:

```bash
chmod 0755 "$HOME/.local/bin/codex"
ssh host 'command -v codex'
ssh host 'printf "%s\n" "$CODEX_SSH_SKIP_APP_SERVER_BOOT"'
```

Codex SSH clients can then connect normally; no client-side protocol option or
special method allowlist is required. Only the exact two-argument proxy command
is redirected. Interactive CLI commands and all other subcommands continue to
use the real CLI normally. `CODEX_CLI_PATH` used to launch Desktop must also
point to the real CLI so Desktop cannot recursively invoke the wrapper.

Enable the feature in the ignored `linux-features/features.json` file:

```json
{
  "enabled": ["shared-app-server-socket"]
}
```

Then rebuild and launch the app. The feature is disabled by default and does
not run independently of Desktop.

Run focused tests with:

```bash
node --test linux-features/shared-app-server-socket/test.js
```

Set `CODEX_CLI_PATH` to include the stock authority/socket/proxy lifecycle test:

```bash
CODEX_CLI_PATH="/absolute/path/to/real/codex" node --test linux-features/shared-app-server-socket/test.js
```

The feature depends on upstream's current local transport factory, WebSocket
adapter, and `app-server proxy` command. Bundle drift causes the optional patch
to warn and skip instead of modifying an unknown surface.
