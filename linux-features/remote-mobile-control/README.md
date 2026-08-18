# Experimental Remote Mobile Control

This feature is disabled by default. OpenAI currently documents Remote hosts on
macOS and Windows, with control from ChatGPT on iOS or Android and, when the
rollout is available, from another Mac or Windows device. This feature adapts
the upstream host and outbound-control flows for experimental Linux use; it
does not make Linux an officially supported Remote host.

See the [official Remote documentation](https://learn.chatgpt.com/docs/remote-connections)
for account, workspace, mobile app, and rollout requirements.

Enable it by adding the feature id to `linux-features/features.json` before
building:

```json
{
  "enabled": [
    "remote-mobile-control"
  ]
}
```

For the Nix flake build, use the declarative app variant instead because the
git-ignored `features.json` file is not part of the flake source:

```bash
nix run .#codex-desktop-remote-mobile-control
```

Feature-specific Nix outputs are additive. To combine this feature with the
Computer Use UI opt-in:

```bash
nix run .#codex-desktop-computer-use-ui-remote-mobile-control
```

What it changes:

- Replaces the upstream native `remote-control-device-key.node` path with a
  Linux JavaScript ECDSA P-256 key provider.
- Lets the remote-control Connections UI render on Linux when upstream marks
  the feature unavailable or withholds the remote-control visibility rollout.
- Keeps the `Control other devices` settings tab reachable on Linux so this
  desktop can authorize outbound control of another enrolled device.
- Refreshes the remote Connections settings state every 5 seconds and
  immediately after focus, visibility, online, or resume signals.
- Buffers late `turn/started`, `item/started`, `item/completed`, and
  `turn/completed` notifications for an unknown conversation, hydrates that
  conversation once, and replays the queue in order after hydration. A
  completed item is also restored when its local started state was absent.
- Recovers stale remote terminal status when `waitingOnUserInput` remains active
  after the matching input request has already cleared.
- Keeps local Linux Remote turns on `summary = "none"` unless a turn explicitly
  requests a reasoning summary, preventing Desktop's rollout gate from adding
  repeated English reasoning titles to the mobile transcript.
- Keeps Chrome Browser Use available to remote/mobile controlled sessions when
  the local Chrome plugin and native host are healthy, and adds a diagnostic
  when the native browser bridge is not exposed to the session.
- Persists the private key material at
  `~/.config/codex-desktop/remote-control-device-keys/remote-control-device-keys-v1.json`
  with `0600` file permissions inside a dedicated `0700` directory. Updates are
  serialized with a safely resolved `flock`/`sh` helper, including migrations
  triggered by reading or signing a key. A replacement fsyncs its temporary
  file before an atomic rename; the rename is the commit point and is followed
  by a best-effort directory fsync. If that final fsync fails, the committed
  replacement remains in use and a warning reports that crash durability was
  not confirmed. Unsafe ownership, permissions, file types, schema, or size
  are rejected. An existing key file at the previous location is moved into the
  private directory on first use.
- Encrypts private key material with Electron `safeStorage` when the Linux
  desktop exposes GNOME Secret Service/libsecret or KWallet. The hardened JSON
  store keeps only public metadata and a base64 ciphertext in that mode.
- Records the selected storage backend (`gnome_libsecret`, `kwallet`,
  `kwallet5`, or `kwallet6`) in the key metadata. Electron's `basic_text`
  backend is deliberately not treated as a keychain because it does not provide
  OS-protected storage.
- If no usable keychain is available, creation falls back to the existing
  file-backed PEM protected by `0600` permissions and emits a warning. This is
  a compatibility fallback, not equivalent protection to a desktop keychain or
  macOS Secure Enclave.
- Existing file-backed PEM records migrate to `safeStorage` on first read when
  a usable backend is available. Encryption and pre-rename write failures leave
  the original file intact; a post-rename directory-fsync warning does not roll
  back the already committed replacement.
- Preserves `remote_control = true` / `features.remote_control = true` in the
  local Codex config instead of letting upstream strip it before app-server
  startup.
- Starts the native Desktop app-server with `--remote-control`, or starts
  `codex app-server proxy` when a declarative service owns the control socket.
  The proxy forwards the complete Desktop RPC stream instead of splitting
  enablement, pairing, status, and conversation RPCs between two processes.
- Updates Remote settings and mobile setup copy so the experimental Linux flow
  is not described as Mac-only.
- Stages `.codex-linux/cold-start.d/remote-mobile-control`, a feature-owned
  cold-start hook that starts the app-server daemon with `remote-control start`
  through the official Codex executable bundled in the Linux package. It does
  not download or install another CLI. It also stages a single-instance
  requirement marker.

## Control topology boundaries

This feature touches three different control paths. They must stay independent:

- `mobile-host`: a mobile client controls this Linux installation. This owns the
  local remote-control runtime, host enablement, and mobile conversation state.
- `outbound-control`: this Desktop controls an enrolled remote-control host. This
  owns client enrollment, connection discovery, and the `Control other devices`
  flow.
- `remote-ssh`: this Desktop manages a Remote SSH host. It shares part of the
  Connections UI but not remote-control enrollment or status RPCs.
- `shared-boundary`: code that selects or isolates two or more paths. A boundary
  patch must not enable one topology as a side effect of another.

The current patch ownership is explicit below. The test suite requires every
feature descriptor to appear exactly once in this table.

| Descriptor | Primary responsibility | Contract |
| --- | --- | --- |
| `linux-remote-control-device-key` | `outbound-control` | Provides the client key used to enroll this Desktop against another remote-control host. |
| `linux-remote-control-client-revocation-recovery` | `outbound-control` | Clears revoked client material before re-enrollment. |
| `linux-remote-mobile-app-server-remote-control` | `mobile-host` | Starts a native Desktop-owned app-server or proxies Desktop RPCs to a declarative owner. |
| `linux-remote-control-load-gate` | `outbound-control` | Allows remote-control environments to load in Connections. |
| `linux-remote-control-feature-sync` | `shared-boundary` | Enables `remote_control` only for the local host and excludes Remote SSH hosts. |
| `linux-remote-control-visibility` | `outbound-control` | Exposes remote-control Connections UI when the server permits it. |
| `linux-remote-control-copy` | `shared-boundary` | Rewrites Linux copy shared by host setup and outbound Connections. |
| `linux-remote-control-settings-ux` | `shared-boundary` | Composes outbound remote-control and Remote SSH actions in the shared settings bundle. |
| `linux-remote-control-client-revoke-setup-reset` | `mobile-host` | Resets this host's mobile setup state only after the last external controller is removed. |
| `linux-remote-connections-refresh` | `shared-boundary` | Refreshes the shared Connections list without starting or enabling any host runtime. |
| `linux-remote-mobile-reasoning-summary-none` | `mobile-host` | Prevents inherited or rollout-forced reasoning summaries from polluting this host's mobile transcript. |
| `linux-remote-mobile-conversation-hydration` | `mobile-host` | Normalizes active thread runtime state, hydrates and replays late unknown-conversation notifications in order, and restores completed items missing local started state. |
| `linux-remote-terminal-status-recovery` | `mobile-host` | Reconciles stale mobile terminal state with actual pending requests. |
| `linux-remote-control-status-read-guard` | `shared-boundary` | Sends `remoteControl/status/read` only to the local host, never Remote SSH or remote-control environment hosts. |
| `linux-remote-control-status-wait` | `shared-boundary` | Gives the selected host a Linux-specific connection convergence window without changing host ownership. |
| `linux-remote-control-enable-for-host-params` | `shared-boundary` | Uses the current enable/disable RPC parameter contract without choosing which host is targeted. |
| `linux-remote-control-enablement-bridge` | `shared-boundary` | Loads outbound clients and auto-connects the remote-control environment owned by this Desktop without overwriting saved choices for other hosts. |
| `linux-remote-mobile-active-status` | `mobile-host` | Derives mobile active state from the local thread runtime. |

Remote SSH behavior is nested inside the shared settings descriptor rather than
registered as a separate descriptor. `applyLinuxRemoteControlSshInstallActionPatch`
keeps the install action visible, and
`applyLinuxRemoteControlSshInstallReleasePatch` selects the requested Codex
release for install or update. Both remain `remote-ssh` responsibilities;
neither function enables remote-control on the SSH host.

Feature-owned surfaces outside the descriptor array are also topology-scoped:

| Surface | Primary responsibility | Contract |
| --- | --- | --- |
| `stage.sh` | `mobile-host` | Stages the host marker, single-instance requirement, cold-start hook, and optional Chrome bridge patch. |
| `cold-start-hook.sh` | `mobile-host` | Elects one local remote-control runtime owner and starts only the bundled official Codex fallback. |
| `applyLinuxRemoteMobileChromeBridgePatch` | `mobile-host` | Keeps local Browser Use available to an authorized mobile-controlled session. |
| Nix `codex-remote-control.service` | `mobile-host` | Replaces the bundled-process fallback with one declarative local app-server owner. |
| `applyLinuxRemoteControlSshInstallActionPatch` | `remote-ssh` | Keeps the existing Remote SSH install action available. |
| `applyLinuxRemoteControlSshInstallReleasePatch` | `remote-ssh` | Sends an explicit Codex release only to the Remote SSH install/update action. |

The app-server has exactly one Remote Control owner in either supported
topology:

```text
Native: Desktop -> codex app-server --remote-control
Nix:    Desktop -> codex app-server proxy --sock <owner socket>
               -> Unix control socket -> systemd app-server --remote-control
```

The packaged single-instance marker is enforced only in the native topology,
where a second Desktop would create a second Remote Control owner. In the Nix
topology, multiple Desktop instances may proxy to the same declarative owner.
The selected CLI must provide `codex app-server proxy`; this path is validated
with Codex CLI 0.147.0 and follows the repository's current-CLI policy.

The main RPC boundaries are:

- local host: `remoteControl/enable`, `remoteControl/disable`,
  `remoteControl/pairing/start`, `remoteControl/status/read`, and
  `remoteControl/status/changed`;
- outbound Connections: `set-remote-control-connections-enabled`,
  `refresh-remote-control-connections`, and
  `set-remote-connection-auto-connect`;
- shared host routing: `set-experimental-feature-enablement-for-host`,
  `refresh-remote-connections`, and `get-global-state` for the local
  installation identity used by auto-connect;
- Remote SSH: the existing `install-codex` action and its release parameter.

Remote mobile daemon requirement:

The hook uses `$CODEX_LINUX_APP_DIR/resources/codex`, which comes directly from
the verified official Linux package. It never downloads a second CLI, creates a
`~/.local/bin/codex` link, or changes the user's shell `PATH`. The hook is
launched best-effort in the background by the generic launcher hook runner.
When the system `timeout` command is available, the start path is capped by
`CODEX_REMOTE_CONTROL_DAEMON_AUTOSTART_TIMEOUT_SECONDS` (default `30`), so
Desktop cold start is not blocked by a stalled daemon. When `timeout` is
unavailable, the hook continues the start path in a background subprocess. Hook
output is written to the launcher log.

On NixOS, prefer the flake's Home Manager module instead of the launcher hook:

```nix
{
  imports = [
    inputs.codex-desktop-linux.homeManagerModules.default
  ];

  programs.codexDesktopLinux = {
    enable = true;
    computerUseUi.enable = true;
    remoteMobileControl.enable = true;
    remoteControl.enable = true;
  };
}
```

The module installs the remote-mobile package variant and manages
`codex-remote-control.service` as a user systemd unit running
`codex app-server --remote-control --listen unix://`. It sets
`CODEX_REMOTE_CONTROL_APP_SERVER_MODE=proxy`, so the app-server child spawned
by Desktop runs `codex app-server proxy` and forwards its complete stdio RPC
stream to the service's Unix control socket. The companion
`CODEX_REMOTE_CONTROL_APP_SERVER_PROXY_SOCKET` value keeps the proxy aligned
with the service when `codexHome` or `listen` is customized. Only `unix://` and
absolute `unix:///path` listeners are supported. The module also sets
`CODEX_REMOTE_CONTROL_DAEMON_AUTOSTART_DISABLED=1` by default so the launcher
does not start a second bundled daemon process.

If the service or socket is unavailable, the Desktop proxy fails visibly; it
does not fall back to launching another Desktop-owned app-server. Fix the user
service or its shared CLI state instead of creating a competing owner.

At cold start, an active, enabled, or otherwise installed systemd user unit is
the remote-control runtime owner. Without that unit, the launcher defers to an
explicit autostart disablement, then to a valid Desktop app-server marker, and
uses the bundled official Codex runtime only as the final fallback. The selected
owner is written to the launcher log.

To test a specific daemon binary without changing the interactive CLI, set:

```bash
CODEX_REMOTE_CONTROL_CODEX_PATH=/path/to/codex
```

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
  material is protected by the desktop keychain when available; the
  `file_0600` fallback is protected only by ordinary user file permissions.
- OpenAI may still reject Linux host enrollment or outbound authorization
  server-side. This feature only removes local macOS-only blockers in the
  repackaged app.
- Treat this as experimental account-level remote-control plumbing.

Keychain diagnostics:

- Inspect the `storageBackend` and `detectedBackend` fields in
  `remote-control-device-keys-v1.json` without sharing the private values.
- `storageBackend` set to `gnome_libsecret` or `kwallet*` means the private key
  is stored as Electron `safeStorage` ciphertext.
- `storageBackend` set to `file_0600` means the session had no usable keychain,
  selected `basic_text`, or was running without Electron safe storage. The
  launcher log contains a warning with the detected backend but never logs key
  material, ciphertext, signatures, or tokens.

Run the feature tests with:

```bash
node --test linux-features/remote-mobile-control/test.js
```
