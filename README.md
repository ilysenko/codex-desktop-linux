<h1 align="center">ChatGPT Community for Linux</h1>

<p align="center">
  <a href="https://github.com/ilysenko/codex-desktop-linux/actions/workflows/ci.yml"><img src="https://github.com/ilysenko/codex-desktop-linux/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/ilysenko/codex-desktop-linux/actions/workflows/upstream-build-app.yml"><img src="https://github.com/ilysenko/codex-desktop-linux/actions/workflows/upstream-build-app.yml/badge.svg" alt="Official Linux package build"></a>
  <a href="https://discord.gg/skCB3DXqgw"><img src="https://img.shields.io/badge/Discord-Join%20the%20community-5865F2?logo=discord&logoColor=white" alt="Join the Discord community"></a>
</p>

<p align="center">
  English | <a href="README.zh-CN.md">简体中文</a>
</p>

`codex-desktop` is an unofficial, community-maintained distribution of
OpenAI's official Linux ChatGPT desktop application. It verifies and
repackages the signed upstream Linux payload, adds disabled-by-default Linux
features, and produces deb, RPM, pacman, AppImage, and Nix outputs.

The custom application appears in desktop menus as **ChatGPT Community** and
uses an icon marked with a blue `C`. Its package, command, and installation
identity remain `codex-desktop` and `/opt/codex-desktop`, so it is easy to
distinguish from OpenAI's separate **ChatGPT** package.

OpenAI's signed Linux `.deb` is the only upstream source. The official
Electron runtime, native modules, bundled `codex` and `rg`, code-mode host,
plugins, libraries, locales, and Owl metadata are reused directly. With no
ASAR-changing feature enabled, `resources/app.asar` remains byte-for-byte
identical to the official package.

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#uninstall">Uninstall</a> ·
  <a href="#feature-matrix">Features</a> ·
  <a href="#updates">Updates</a> ·
  <a href="#build-package-and-run">Build</a> ·
  <a href="#troubleshooting">Troubleshooting</a> ·
  <a href="#project-documentation">Docs</a> ·
  <a href="https://discord.gg/skCB3DXqgw">Discord</a>
</p>

Before contributing, read [CONTRIBUTING.md](CONTRIBUTING.md). Maintainers and
coding agents should also read [AGENTS.md](AGENTS.md).

## Install

Clone the repository before building a native package or AppImage:

```bash
git clone https://github.com/ilysenko/codex-desktop-linux.git
cd codex-desktop-linux
```

| Platform | Recommended command | Result |
|---|---|---|
| Debian, Ubuntu, Pop!_OS, Mint, Elementary | `make bootstrap-native` | Builds and installs a `.deb` |
| Raspberry Pi 5, 64-bit OS | `make bootstrap-native` | Builds the official `arm64` payload; see [Pi notes](docs/raspberry-pi-5.md) |
| Fedora | `make bootstrap-native` | Builds and installs an RPM |
| openSUSE | `make bootstrap-native` | Builds and installs an RPM |
| Arch, Manjaro, EndeavourOS | `make bootstrap-native` | Builds and installs a pacman package |
| NixOS or another Nix system | `nix run github:ilysenko/codex-desktop-linux` | Builds and runs the flake output; see [Nix](docs/nix.md) |
| Atomic desktops or another distribution | `make build-app && make appimage` | Produces a local AppImage without the native updater |

The recommended native installation is:

```bash
make bootstrap-native
```

This installs build dependencies, resolves the current package through
OpenAI's signed stable APT metadata, builds `codex-app/`, creates the native
package for the detected distribution, and installs the newest artifact from
`dist/`.

If the dependencies are already installed, use:

```bash
make install-native
```

To choose optional features before installing:

```bash
make setup-native
make install-native
```

`make setup-native` only writes the local feature selection. It does not build
or install the application. See [Native setup](docs/native-setup.md) for the
guided flow, non-interactive settings, updater selection, and cleanup.

### Use an already downloaded official package

Normally the build resolves `amd64` or `arm64` from the signed stable index.
You can instead provide a local package that you already trust:

```bash
UPSTREAM_DEB=/path/to/chatgpt_<version>_<arch>.deb make build-app
```

The local package is still checked for package name, architecture, control
metadata, payload completeness, and SHA-256 recording. Because signed
repository discovery is skipped, the caller is responsible for its origin.
Old `.dmg`, `DMG=`, and `CODEX_DMG_*` inputs are intentionally unsupported.

### Before you install

- Only the latest signed stable OpenAI Linux package is supported, on `amd64`
  and `arm64`.
- Build tools require Node.js 20 or newer, npm, Python 3, curl, `gpgv`,
  `dpkg-deb`, tar, make, and a C/C++ toolchain. Rust is used for the updater and
  enabled native feature helpers. `make bootstrap-native` installs or guides
  you through these requirements.
- The official `chatgpt` and custom `codex-desktop` packages may coexist, but
  both intentionally use the upstream `Codex` user profile. Do not run them at
  the same time; the upstream single-instance lock may route the second launch
  into the process that is already running.
- AppImage never adds `--no-sandbox` automatically. If your distribution
  disables unprivileged user namespaces, use the native package or follow the
  sandbox guidance in [Troubleshooting](docs/troubleshooting.md).

## Uninstall

First close both **ChatGPT Community** and the official **ChatGPT** application.
Then remove the native package with the package manager that installed it:

```bash
# Debian / Ubuntu
sudo apt remove codex-desktop

# Fedora
sudo dnf remove codex-desktop

# openSUSE
sudo zypper remove codex-desktop

# Arch / Manjaro
sudo pacman -R codex-desktop
```

Native package removal disables the user update service. If a service from an
older or manual installation remains, remove it explicitly:

```bash
systemctl --user disable --now codex-update-manager.service
systemctl --user daemon-reload
```

For AppImage, delete the AppImage file you built. For a repository-only app,
delete only the generated tree inside the checkout:

```bash
rm -rf -- ./codex-app
```

For Nix, remove the package from your profile, Home Manager configuration, or
NixOS module and rebuild that profile or system.

Package removal preserves user data. To remove only Community wrapper and
updater state, inspect and then delete the following directories:

```text
~/.config/codex-desktop
~/.local/state/codex-desktop
~/.cache/codex-desktop
~/.config/codex-update-manager
~/.local/state/codex-update-manager
~/.cache/codex-update-manager
```

If `remote-mobile-control` was enabled, revoke paired devices before removing
its private device keys. Do not remove `~/.codex` unless you intentionally want
to delete the shared Codex profile, configuration, plugins, and project state
used by both official and Community applications.

## Feature matrix

### Core distribution

| Capability | Default | How it is provided |
|---|---|---|
| Official ChatGPT Linux runtime | Always | Copied from the verified official `.deb` data payload |
| Signed source verification | Always | Pinned repository key → `InRelease` → `Packages` SHA-256 → package SHA-256 |
| Byte-identical baseline ASAR | Always | The ASAR is not unpacked when no enabled feature needs it |
| Native deb, RPM, and pacman packages | Manual build | `make deb`, `make rpm`, or `make pacman` |
| AppImage | Manual build | `make appimage`; no automatic sandbox bypass or bundled updater |
| Nix flake | Manual build | `nix run github:ilysenko/codex-desktop-linux` |
| Transactional update manager | Native packages | Included unless built with `PACKAGE_WITH_UPDATER=0` |
| Official Browser and Chrome integrations | Upstream | Reused from the official Linux package; no legacy port layer |
| Optional Linux feature framework | Disabled | Configure with `make setup-native` |
| Distinct desktop identity | Always | **ChatGPT Community**, blue `C` icon, `codex-desktop` package identity |

### Optional Linux features

Every feature below is disabled by default. Its adjacent README describes
requirements, known limitations, configuration, and tests.

| Feature ID | Purpose | Documentation |
|---|---|---|
| `agent-workspace` | Agent-workspace settings and bridge for hidden desktop environments | [Docs](linux-features/agent-workspace/README.md) |
| `api-key-model-visibility` | Show models reported by API-key authenticated compatible providers | [Docs](linux-features/api-key-model-visibility/README.md) |
| `api-key-service-tier` | Fast/service-tier UI for API-key authenticated compatible providers | [Docs](linux-features/api-key-service-tier/README.md) |
| `appshots` | Capture and crop the focused Linux window from the composer | [Docs](linux-features/appshots/README.md) |
| `authenticated-proxy` | Username/password support for HTTP proxies | [Docs](linux-features/authenticated-proxy/README.md) |
| `automation-extensions` | Multi-time schedules and eager `automation_update` exposure | [Docs](linux-features/automation-extensions/README.md) |
| `codex-micro` | Work Louder Codex Micro hotplug and hidraw policy using upstream `node-hid` | [Docs](linux-features/codex-micro/README.md) |
| `computer-use-linux` | Linux desktop-control UI and native MCP backend | [Docs](linux-features/computer-use-linux/README.md) |
| `copilot-reasoning-effort` | Persistent reasoning-effort defaults for Copilot-auth sessions | [Docs](linux-features/copilot-reasoning-effort/README.md) |
| `directory-only-working-tree-watch` | Bounded Watchbound working-tree watching | [Docs](linux-features/directory-only-working-tree-watch/README.md) |
| `frameless-titlebar` | Hide official Linux overlay buttons for compositor-managed decorations | [Docs](linux-features/frameless-titlebar/README.md) |
| `global-dictation` | X11 and XDG portal global dictation hotkeys | [Docs](linux-features/global-dictation/README.md) |
| `linux-performance-workarounds` | Measured renderer workarounds for affected systems | [Docs](linux-features/linux-performance-workarounds/README.md) |
| `mcp-helper-reaper` | Reap orphaned MCP helpers without touching live sessions | [Docs](linux-features/mcp-helper-reaper/README.md) |
| `node-repl-reaper` | Reap Browser Use `node_repl` helpers leaked after owner exit | [Docs](linux-features/node-repl-reaper/README.md) |
| `omarchy-theme` | Load CSS generated from the current Omarchy theme | [Docs](linux-features/omarchy-theme/README.md) |
| `persistent-status-panel` | Keep the `/status` panel across thread switches and restarts | [Docs](linux-features/persistent-status-panel/README.md) |
| `pet-overlay` | Linux avatar-overlay placement and compositor hints | [Docs](linux-features/pet-overlay/README.md) |
| `project-group-last-updated-sort` | Apply Last updated ordering to project groups and tasks | [Docs](linux-features/project-group-last-updated-sort/README.md) |
| `project-task-sort` | Restore Created ordering for alternate Projects tasks | [Docs](linux-features/project-task-sort/README.md) |
| `read-aloud` | Add Linux read-aloud controls to assistant responses | [Docs](linux-features/read-aloud/README.md) |
| `read-aloud-mcp` | Let the agent speak through the Linux Read Aloud backend | [Docs](linux-features/read-aloud-mcp/README.md) |
| `record-and-replay` | Record a Linux demonstration and turn it into a reusable skill | [Docs](linux-features/record-and-replay/README.md) |
| `remote-control-ui` | Expose experimental remote-control settings on Linux | [Docs](linux-features/remote-control-ui/README.md) |
| `remote-mobile-control` | Experimental Linux remote-host and outbound-control flows | [Docs](linux-features/remote-mobile-control/README.md) |
| `shallow-repository-watches` | Avoid recursive main-thread walks for transient repository previews | [Docs](linux-features/shallow-repository-watches/README.md) |
| `shared-app-server-socket` | Share one protocol-transparent Unix app-server socket | [Docs](linux-features/shared-app-server-socket/README.md) |
| `thorium-chrome-plugin` | Add Thorium to the official bundled Chrome integration | [Docs](linux-features/thorium-chrome-plugin/README.md) |
| `ui-tweaks` | Optional visual and interaction customizations | [Docs](linux-features/ui-tweaks/README.md) |

Account rollouts and server-side ChatGPT features remain controlled by OpenAI.
Rebuilding this project does not unlock an account rollout.

## Configure optional features

The recommended editor is the setup wizard:

```bash
make setup-native
```

For manual configuration, copy the example to the gitignored local file:

```bash
cp linux-features/features.example.json linux-features/features.json
```

```json
{
  "enabled": [
    "read-aloud",
    "ui-tweaks"
  ]
}
```

Then rebuild and install:

```bash
make install-native
```

Private features may live under the gitignored
`linux-features/local/<feature-id>/` tree and use the same manifest contract.
Known retired IDs are ignored to migrate old local configs; arbitrary unknown
IDs and misspellings remain errors. See [the feature framework README](linux-features/README.md)
and [feature architecture](docs/linux-features-architecture.md).

## Updates

Native packages include `codex-update-manager` by default. Its user service
polls the same signed APT metadata, caches official packages by
version/architecture/SHA-256, reconstructs the selected native package with the
currently enabled features, and waits for the application to exit before
promotion. The immediately previous managed package remains available for
rollback.

```bash
codex-update-manager status
codex-update-manager status --json
codex-update-manager check-now
codex-update-manager diagnose
codex-update-manager install-ready
codex-update-manager rollback
```

```bash
systemctl --user enable --now codex-update-manager.service
systemctl --user status codex-update-manager.service
journalctl --user -u codex-update-manager.service
```

Build a manual-update package without the service:

```bash
PACKAGE_WITH_UPDATER=0 make package
make install
```

AppImage and repository-only generated apps do not include the native package
updater. Full behavior and recovery steps are documented in
[Updater](docs/updater.md).

## Build, package, and run

```bash
# Build the local application tree and run it without installing a package
make build-app
make run-app

# Build and install the package format detected for this distribution
make package
make install

# Build a specific output
make deb
make rpm
make pacman
make appimage
```

Builds are transactional: a candidate is verified before it replaces the
working tree. Enabled ASAR-feature drift rejects a candidate; disabled features
are not probed. Package scripts consume the generated `codex-app/` tree. See
[Build and packaging](docs/build-and-packaging.md) for prerequisites, variables,
output layout, parallelism, and payload inspection.

## Troubleshooting

| Problem | First check |
|---|---|
| Official and Community launches interfere | Fully exit every `ChatGPT` process; both apps share the upstream profile |
| Browser/Chrome extension cannot connect after migration | Exit ChatGPT and Chrome completely, then follow the narrow cache repair in [Troubleshooting](docs/troubleshooting.md#browser-or-chrome-plugin-is-visible-but-cannot-connect) |
| Signature or package verification fails | Do not bypass it; check time, network, `gpgv`, architecture, and disk space |
| App does not launch | Run `/opt/codex-desktop/start.sh --diagnose` |
| App uses XWayland or needs persistent Electron flags | Put one flag per line in `~/.config/codex-desktop/electron-flags.conf`; for example, `--ozone-platform=wayland` |
| AppImage reports a sandbox error | Enable user namespaces or install a native package; `--no-sandbox` is not added automatically |
| Enabled feature drifts after an upstream release | Disable that feature to confirm the clean baseline and attach its patch report to an issue |
| Updater waits for application exit | Close official and Community processes, then inspect `codex-update-manager status --json` |
| Old `codex-app.backup-*` reports permission errors | Inspect the exact path and follow the root-owned backup procedure; never delete a wildcard blindly |

Full guide: [Troubleshooting](docs/troubleshooting.md).

## Project documentation

- Getting started: [Native setup](docs/native-setup.md), [Build and packaging](docs/build-and-packaging.md), [Nix](docs/nix.md), [Raspberry Pi 5](docs/raspberry-pi-5.md)
- Runtime and maintenance: [Architecture](docs/architecture.md), [Updater](docs/updater.md), [Troubleshooting](docs/troubleshooting.md)
- Extensions: [Feature framework](linux-features/README.md), [Feature architecture](docs/linux-features-architecture.md), [Linux Computer Use](docs/linux-computer-use.md), [Record and Replay](docs/record-and-replay-linux.md), [Chronicle / Skysight](docs/linux-chronicle-skysight.md)
- Contributors: [Contributing](CONTRIBUTING.md), [Agent instructions](AGENTS.md), [Repository map](docs/agents/repository-map.md), [Validation playbook](docs/agents/validation-playbook.md), [Generated/runtime notes](docs/agents/generated-and-runtime-notes.md)
- Project operations: [GitHub CLI auth](docs/github-cli-auth.md), [Label governance](docs/label-governance.md)

Historical macOS DMG conversion, downloaded Electron replacement, native-module
rebuild, local webview server, and custom warm-start documents are intentionally
not active documentation: the official Linux package now owns those runtime
responsibilities.

## Disclaimer

This is an unofficial community project and is not affiliated with OpenAI.
ChatGPT, OpenAI services, trademarks, upstream application code, binaries, and
assets remain the property of OpenAI or their respective owners.

The repository downloads and repackages the official Linux payload locally; it
does not grant rights to OpenAI software or services. Use of ChatGPT remains
subject to OpenAI's applicable terms and server-side feature availability.

The MIT license applies only to this repository's wrapper source, packaging,
documentation, and community-owned extensions.

## License

[MIT](LICENSE)
