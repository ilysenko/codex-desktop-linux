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
nix run .#remote-mobile-control
```

Feature-specific Nix outputs are additive. To combine this feature with the
Computer Use UI opt-in:

```bash
nix run .#computer-use-ui-remote-mobile-control
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
- Recovers a completed remote stream item when its matching started item is
  missing from the local turn state.
- Recovers stale remote terminal status when `waitingOnUserInput` remains active
  after the matching input request has already cleared.
- Keeps Chrome Browser Use available to remote/mobile controlled sessions when
  the local Chrome plugin and native host are healthy, and adds a diagnostic
  when the native browser bridge is not exposed to the session.
- Persists the private key material at
  `~/.config/codex-desktop/remote-control-device-keys-v1.json` with `0600`
  file permissions.
- Preserves `remote_control = true` / `features.remote_control = true` in the
  local Codex config instead of letting upstream strip it before app-server
  startup.
- Updates Remote settings and mobile setup copy so the experimental Linux flow
  is not described as Mac-only.
- Stages `.codex-linux/cold-start.d/remote-mobile-control`, a feature-owned
  cold-start hook that provisions the upstream managed standalone daemon runtime
  when it is missing, then starts the managed app-server daemon with
  `remote-control start`.

Remote mobile daemon requirement:

The interactive Codex CLI and the remote-control daemon are separate concerns.
You can keep using a Homebrew-installed `codex` for normal terminal and Desktop
app-server usage. Outside the declarative Nix service described below, this
feature uses the upstream managed standalone daemon runtime at:

```bash
~/.codex/packages/standalone/current/codex
```

If that binary is missing, the feature's cold-start hook runs the upstream
standalone installer with `CODEX_INSTALL_DIR` pointed at a private bin directory
under `~/.codex/packages/standalone/.bin`. That satisfies the managed daemon
layout without changing `CODEX_CLI_PATH`, creating `~/.local/bin/codex`, or
adding PATH blocks to your shell profile.

The hook is launched best-effort in the background by the generic launcher hook
runner. When the system `timeout` command is available, the installer/start path
is capped by
`CODEX_REMOTE_CONTROL_DAEMON_AUTOSTART_TIMEOUT_SECONDS` (default `30`), so
Desktop cold start is not blocked by network, GitHub, or installer stalls.
When `timeout` is unavailable, the hook continues the installer/start path in a
background subprocess. Hook output is written to the launcher log.

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
`codex app-server --remote-control --listen unix://`. It also sets
`CODEX_REMOTE_CONTROL_DAEMON_AUTOSTART_DISABLED=1` so the launcher does not
start a second mutable standalone daemon.

This is compatible with immutable Linux systems such as Bluefin / Universal
Blue because the managed daemon runtime is user-scoped state under
`~/.codex/packages/standalone`. It does not require `dnf`, `rpm-ostree`, host
package layering, or base-OS mutation. The private `.bin` directory is only a
launcher-owned target for the installer symlink; it is not prepended to the
user's persistent shell `PATH`.

Set `CODEX_REMOTE_CONTROL_RUNTIME_AUTO_INSTALL_DISABLED=1` to disable that
runtime provisioning and only use an already-installed standalone runtime.

To force a specific daemon binary without affecting the interactive CLI, set:

```bash
CODEX_REMOTE_CONTROL_CODEX_PATH=/path/to/standalone/codex
```

To keep Desktop using Homebrew while the daemon uses standalone, set
`CODEX_CLI_PATH` to the Brew binary and leave
`CODEX_REMOTE_CONTROL_CODEX_PATH` unset or pointed at the standalone binary.

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

- The Linux key provider is file-backed and protected by ordinary user file
  permissions. It is not equivalent to OS- or hardware-backed non-extractable
  key storage.
- Linux host enrollment or outbound authorization can still fail server-side.
  The official Remote documentation does not list Linux as a supported host
  platform.
- Treat this as experimental account-level remote-control plumbing.

Run the feature tests with:

```bash
node --test linux-features/remote-mobile-control/test.js
```
