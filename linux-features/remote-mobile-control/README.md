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

## Gentoo local ebuild

Gentoo accepts this feature in the generated local ebuild after it is explicitly
listed in `linux-features/features.json`. Use the existing `make bootstrap-native`
or `make install-native` workflow; `make gentoo` generates the package without
installing it after the app has been built. The feature remains disabled by
default.

The device-key store needs `flock`, supplied by the feature's
`sys-apps/util-linux` runtime dependency. The cold-start hook is a declarative
resource, so Gentoo validates its presence and executable mode and preserves
that mode in the packaged payload. The feature adds no bootstrap or Portage
build/merge dependency. Portage continues to own native updates with
`PACKAGE_WITH_UPDATER=0`.

This ebuild uses the existing Desktop-owned app-server path and does not install
or enable an OpenRC or systemd remote-control service. Package builds have been
audited on amd64 OpenRC; phone pairing and account-side enrollment still require
separate runtime validation. Gentoo ARM64 and systemd runtime environments have
not been tested.

What it changes:

- Replaces the upstream native `remote-control-device-key.node` addon with a
  Linux JavaScript ECDSA P-256 key store. The current native signing base,
  Remote subclass, serialization domain, nonce and digest validators stay
  unchanged. The Linux addon is accepted through the same native addon schema
  before the Remote instance returns it from `getAddon()`.
- Adds the bare `Remote-control client key material missing` 403 detail to the
  upstream re-enrollment predicate, which only recognizes the prefixed form.
- Lets the remote-control Connections UI render on Linux before outbound
  loading is enabled or when an endpoint is unavailable, while retaining the
  native access-required refusal. Account authorization, enrollment, MFA and
  the actual connection list remain native.
- Keeps the `Control other devices` settings tab reachable on Linux so this
  desktop can authorize outbound control of another enrolled device.
- Lets the outbound Remote environment loader proceed on Linux after calling
  the original rollout hook once with its original gate ID. Other platforms
  return the original hook result without coercion; native hook failures still
  propagate before the platform lookup.
- Refreshes the remote Connections settings state every 5 seconds and
  immediately after focus, visibility, online, or resume signals.
- Extends the current upstream event-discovery queue to buffer late
  `turn/started`, `item/started`, `item/completed`, and `turn/completed` notifications for an unknown conversation, hydrates that
  conversation once, and replays the queue in order after hydration. A
  completed item is also restored when its local started state was absent.
  The upstream request queue, notification timestamps, automation capability,
  turn merge policy, retry, and discard lifecycle remain intact.
- Keeps the current abortable Remote status subscriptions and their disposable
  cleanup; skips the initial status RPC for Linux Remote SSH and outbound-control
  hosts while preserving local-host reads and notification delivery.
- Recovers stale remote terminal status when `waitingOnUserInput` remains active
  after the matching input request has already cleared.
- Keeps local Linux Remote turns on `summary = "none"` unless a turn explicitly
  requests a reasoning summary, preventing Desktop's rollout gate from adding
  repeated English reasoning titles to the mobile transcript. Outside local
  Linux durable turns, it preserves upstream Aeon and rollout summary overrides.
- Preserves the official Chrome Browser Use client. Upstream now routes browser
  RPCs through its browser service and owns backend eligibility and preferences;
  the retired client allowlist workaround is no longer staged.
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
- Validates native Remote settings, host setup and Connections copy without
  rewriting it. The current Linux platform path selects upstream PC messages;
  macOS-only locked Computer Use stays behind its native macOS and capability
  guards. Pairing instructions describe the other computer and retain native
  Mac/PC labels. Existing message IDs, localized formatting, interpolation
  values and selected Connections search records remain unchanged. Missing,
  ambiguous or drifted selected branches and links fail closed. A successful
  first or repeated qualification reports `already-applied` with no ASAR byte
  changes and no injected copy marker.
- Declaratively stages `.codex-linux/cold-start.d/remote-mobile-control`, a
  feature-owned cold-start hook that starts the app-server daemon with `remote-control start`
  through the official Codex executable bundled in the Linux package. It does
  not download or install another CLI. Upstream retains its single-instance
  lifecycle.

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
| `linux-remote-control-feature-sync` | `shared-boundary` | Enables `remote_control` in the main-process experimental feature sync only for the local app server and excludes Remote SSH, WSL, and cloud hosts. |
| `linux-remote-control-visibility` | `outbound-control` | Opens the Linux Connections view for pre-enable/unavailable states while retaining native access-required denial and actual account/enrollment/list data. |
| `linux-remote-control-copy` | `shared-boundary` | Qualifies native Linux PC branches, macOS capability guards, other-computer pairing copy, formatter forwarding and selected Connections search data without rewriting text. |
| `linux-remote-control-settings-ux` | `shared-boundary` | Adapts outbound-control visibility while preserving native copy and the retired upstream SSH installer. |
| `linux-remote-control-client-revoke-setup-reset` | `mobile-host` | Resets this host's mobile setup state (the `codex-mobile-has-connected-device` application state) only after the last external controller is removed. |
| `linux-remote-connections-refresh` | `shared-boundary` | Refreshes the shared Connections list without starting or enabling any host runtime. |
| `linux-remote-mobile-reasoning-summary-none` | `mobile-host` | Prevents inherited or rollout-forced reasoning summaries from polluting this host's mobile transcript. |
| `linux-remote-mobile-conversation-hydration` | `mobile-host` | Extends upstream's hydration queue to recover unknown local conversations from ordered turn and item notifications. |
| `linux-remote-terminal-status-recovery` | `mobile-host` | Reconciles stale mobile terminal state with actual pending requests. |
| `linux-remote-control-status-read-guard` | `shared-boundary` | Sends `remoteControl/status/read` only to the local host, never Remote SSH or remote-control environment hosts. |
| `linux-remote-control-status-wait` | `shared-boundary` | Gives the selected host a Linux-specific connection convergence window without changing host ownership. |
| `linux-remote-control-enable-for-host-params` | `shared-boundary` | Qualifies the native selected-host client, status mapper and public fallback caller, then emits parameterless enable/disable requests without changing host choice. |
| `linux-remote-control-enablement-bridge` | `shared-boundary` | Qualifies the native gate hook, live component and late service facade, then enables the current outbound service on Linux while retaining service-owned auto-connect choices. |
| `linux-remote-control-auto-connect-contract` | `outbound-control` | Validates the unique upstream service and settings caller that preserve an explicit auto-connect choice. |
| `linux-remote-mobile-active-status` | `mobile-host` | Derives mobile active state from the local thread runtime. |

The device-key descriptor prepares the complete routed main-process inventory
before the webview pass. It requires the live startup-to-host graph, the native
signing base and Remote subclass, their actual addon schema, and the device-key
construction in that host's constructor. Opaque text, unrelated constructors,
shadowed provider/schema names, duplicate or damaged carriers, and partial own
artifacts are errors when the feature is enabled. Preparation retains an exact
native inverse and requires canonical replay before a single transactional
write. Existing key-store encryption, permissions, locking and migration
strategies are unchanged.

The feature-sync descriptor also prepares the complete main-process inventory
before the ordinary webview pass. It qualifies the live startup/constructor
connection-registry and published-assignment wiring, complete native sync owner,
allowlist, compression schema and actual equality-getter/import bindings. The
small helper lives at the qualified factory root and requires an uncaptured Node
`process` global. Its existing behavior adds `remote_control: true` only to a
clone of the supplied enablement for a Linux literal `local` host; other hosts
and platforms retain the original enablement object. Native assignment readiness,
per-record generations, current connection-map identity, disconnected resets,
propagation/enrollment acknowledgements, prewarm cleanup and error handling stay
intact. A complete physical inventory, exact native inverse and canonical replay
are required before a transactional write; a matching request string alone is
insufficient.

The load-gate descriptor prepares an extracted-webview transaction before the
ordinary webview pass. It qualifies the complete current inline `mC` owner,
its published native hook callee, stable factory imports and shared atom/gate
providers. Every physical copy must agree before the transaction writes; a
marker, partial cohort or changed native call is insufficient. Its exact native
inverse removes only this load-gate contribution. The remote-connections entry
and remote-control subview UI transactions accept that precise contribution in
either order, preserve each other's bytes, and repeat unchanged. Their optional
feature folders do not depend on one another.

The visibility descriptor prepares all copies of the published predicate,
state-reading hook and tab selector before one atomic transaction. It proves
the native catalog-state owner and uses the same feature's load-gate inspector
and native-hook validator as read-only dependencies. Its transaction never
applies the load-gate producer's proposed edits. Missing, changed or mixed
peers, orphan markers and stale dependency rows are rejected before writes.

The actual Remote-mobile visibility adapter and the Remote Control UI adapter
share exact native, UI-only, mobile-only and joint contribution forms. Their
registered APIs compose in either order, preserve the other contribution, and
repeat unchanged. Removing either contribution retains the exact other form;
removing both restores native visibility bytes while the independent entry and
load-gate contributions remain intact. Every physical copy follows the same
state. RMC-only and UI-only feature-source closures load and apply without the
disabled sibling folder.

The outbound enablement bridge also prepares its complete webview cohort before
the ordinary webview pass. Its bounded native component, direct parent and
render slot must resolve to unique factory bindings. The published one-to-one
gate, native context/Statsig hook result and every mutable `appServices` facade
copy are read-only dependencies in the same transaction. A bare function or
nearby log string is insufficient. The existing Linux contribution changes only
the final enabled value: native hook order, memo caches, loading delay, effect
dependencies and error reporting stay intact. The effect reads the current
service through the native getter when it runs; the feature never caches a
bootstrap-time service, changes pairing/MFA policy, or issues auto-connect calls.

The revoke setup-reset descriptor prepares a complete webview dependency
transaction before the ordinary webview pass. Its owned callback belongs to the
local client list: the native local-client atom, local query/snapshot, external
client filter, successful revoke row and local settings caller must agree. The
separate host-keyed SSH callback and outbound operations remain native. The
qualifier leaves unrelated local UI copy outside this contract, so translated
labels can coexist with the callback change.

After a successful revoke, the callback keeps the native cache update and
invalidation. Known zero external controllers reset the existing mobile setup
key to `false`; unknown cache data never resets it. The helper reads the live
`appServices.applicationState` getter at callback time and uses the native
await/dispose wrapper for the returned write handle. Missing or failed writers
remain best-effort and cannot turn a successful revoke into an error. The
original mutation error, analytics and toast callbacks stay intact. All physical
provider/facade copies participate as read-only dependencies; partial or modified
own output must pass exact inverse and canonical replay before a write.

The official webview is an rspack build whose app code lives in lazily loaded
`webview/assets/async/<id>.<hash>.js` chunks. Cohort descriptors qualify their
current module owners, physical copies and provider/caller dependencies before
writing. Ordinary webview descriptors select chunks by stable strings (Statsig
gate ids, RPC methods, log messages, i18n ids), never by file name. Modules that
rspack duplicates into several chunks (the visibility owner and the host toggle
request) are patched in every copy.
Injected helpers are declared inside the owning module factory and reach other
modules only through that module's own import bindings.

The current upstream Connections bundle explicitly returns no action for
`install-codex`. The settings descriptor preserves that contract; it does not
reintroduce the retired Remote SSH installer or enable remote-control on an SSH
host.

Feature-owned surfaces outside the descriptor array are also topology-scoped:

| Surface | Primary responsibility | Contract |
| --- | --- | --- |
| `feature.json` resources | `mobile-host` | Declaratively stages and tracks the cold-start hook with its executable mode. |
| `stage.sh` | `mobile-host` | Stages host ownership markers while preserving official single-instance and browser routing. |
| `cold-start-hook.sh` | `mobile-host` | Elects one local remote-control runtime owner and starts only the bundled official Codex fallback. |
| Nix `codex-remote-control.service` | `mobile-host` | Replaces the bundled-process fallback with one declarative local app-server owner. |

The app-server has exactly one Remote Control owner in either supported
topology:

```text
Native: Desktop -> codex app-server --remote-control
Nix:    Desktop -> codex app-server proxy --sock <owner socket>
               -> Unix control socket -> systemd app-server --remote-control
```

Upstream owns Desktop's single-instance lifecycle. In the Nix topology, Desktop
proxies to the same declarative owner. The selected CLI must provide
`codex app-server proxy` and use a control-socket transport compatible with
Desktop's stdio protocol. Validate an explicit CLI override against that
contract.

The main RPC boundaries are:

- local host: `remoteControl/enable`, `remoteControl/disable`,
  `remoteControl/pairing/start`, `remoteControl/status/read`, and
  `remoteControl/status/changed`;
- outbound Connections: the current `remoteConnections` service methods
  `setRemoteControlEnabled`, `refreshRemoteControl`, and `setAutoConnect`;
- shared host routing: `set-experimental-feature-enablement-for-host`
  and `refresh-remote-connections`.

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

When Desktop owns remote-control, the hook cleans stale PID records from both
upstream daemon namespaces under `$CODEX_HOME/app-server-daemon`.
[Codex 0.162.1 selects the names by managed installation path](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/app-server-daemon/src/lib.rs#L334):
`packages/standalone` uses `app-server.pid` and `app-server-updater.pid`; other
locations, including `packages/app-server-daemon`, use `daemon.pid` and
`daemon-updater.pid`. Both namespaces remain valid. Records whose PID is still
alive are preserved.

To test a specific daemon binary without changing the interactive CLI, set:

```bash
CODEX_REMOTE_CONTROL_CODEX_PATH=/path/to/codex
```

KDE Plasma smoke check:

Linux Computer Use is optional for remote chats, prompts, approvals, and result
review. Enable `computer-use-linux` separately only when remote tasks need to
operate desktop applications. For that additional capability on Plasma/Wayland,
verify that the KWin backend is ready after building or installing the package:

```bash
./codex-app/resources/plugins/openai-bundled/plugins/unified-computer-use/bin/codex-computer-use-linux doctor
./codex-app/resources/plugins/openai-bundled/plugins/unified-computer-use/bin/codex-computer-use-linux windows
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
node --test linux-features/remote-mobile-control/*.test.js linux-features/remote-mobile-control/test.js
```

## Catalog subfeatures

The community feature catalog lists these user-facing capabilities separately:

- **Mobile Remote host** (`mobile-host`): Adapt this Linux installation for experimental mobile Remote hosting, subject to account and pairing requirements.
- **Control other devices** (`outbound-control`): Expose outbound Remote enrollment and connection discovery without bypassing account authorization.

These declarations use `enabledWhen: "parent"`: all are included whenever this
feature is built. They add no independent configuration switches and do not
report runtime activation, permissions, external dependencies or backend health.

The per-host enable/disable adapter is prepared as a complete Rspack cohort
before the ordinary webview pass. Every physical request copy and its native
client/status/caller dependencies must qualify together; a partial or damaged
peer is rejected before writes. The adapter preserves the native current-client
and later-notification race checks, response value and errors. Its only request
change is `null` to `void 0`. The separate local Desktop `appServices` branch,
outbound enrollment, permission/MFA policy and native wait lifetime remain
upstream-owned. A bare `sendRequest` substring is not a supported source contract.
