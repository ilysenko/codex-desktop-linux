# Codex Desktop for Linux

Unofficial Linux build wrapper for [OpenAI Codex Desktop](https://openai.com/codex/).
The official Codex app is available for macOS and Windows; this repository
covers Linux by converting the upstream macOS `Codex.dmg` into a runnable Linux
Electron app.

The project builds native `.deb`, `.rpm`, and `.pkg.tar.zst` packages, supports
local AppImage self-builds and Nix, and can install a local update manager that
rebuilds future Linux packages from newer upstream DMGs.

Before opening a pull request, read [CONTRIBUTING.md](CONTRIBUTING.md). For
implementation details, see [AGENTS.md](AGENTS.md).

## Install By Platform

| Platform | Recommended path | Notes |
|---|---|---|
| Debian, Ubuntu, Pop!_OS, Mint, Elementary | `make bootstrap-native` | Builds and installs a `.deb` |
| Fedora | `make bootstrap-native` | Builds and installs an `.rpm` |
| openSUSE | `make bootstrap-native` | Builds and installs an `.rpm` |
| Arch, Manjaro, EndeavourOS | `make bootstrap-native` | Builds and installs a pacman package |
| NixOS / Nix | `nix run github:ilysenko/codex-desktop-linux` | See [Nix docs](docs/nix.md) |
| Atomic desktops / other distros | `make build-app && make appimage` | Local self-build; no bundled updater |

Native install:

```bash
git clone https://github.com/ilysenko/codex-desktop-linux.git
cd codex-desktop-linux
make bootstrap-native
```

If dependencies are already installed:

```bash
make install-native
```

`make bootstrap-native` installs build dependencies, validates the cached
upstream `Codex.dmg`, downloads it only when missing or stale, builds
`codex-app/`, packages it for your distro, and installs the newest artifact
from `dist/`.

If you are installing dependencies manually on Fedora:

```bash
# Fedora 41+
sudo dnf install python3 7zip curl unzip rpm-build make gcc-c++ @development-tools

# Fedora < 41
sudo dnf install python3 p7zip p7zip-plugins curl unzip rpm-build make gcc-c++
sudo dnf groupinstall 'Development Tools'
```

For a guided first-run checklist and optional feature picker:

```bash
make setup-native
```

See [Native setup](docs/native-setup.md) for the wizard, non-interactive
feature selection, cleanup flow, and `PACKAGE_WITH_UPDATER=0`.

## Before You Install

The generated app and native packages bundle a managed Linux Node.js runtime.
You do not need a distro `nodejs` / `npm` package for normal installs, Browser
Use, Codex CLI install/update, or local auto-update rebuilds.

The Codex CLI is still required at runtime. The first launch can install or
update `@openai/codex` with the bundled `npm`, or you can manage the CLI
yourself.

X11 and Wayland sessions are supported. The launcher prefers XWayland on
Wayland when available for better Electron popup positioning, then falls back
to Electron's automatic Wayland handling. See
[Troubleshooting](docs/troubleshooting.md) for GPU, Vulkan, and `/tmp noexec`
workarounds.

## Feature Matrix

| Feature | Default | Enable / use | Docs |
|---|---|---|---|
| Standard Codex Desktop UI | Always | Install or run the generated app | This README |
| Managed Linux Node.js runtime | Always | Bundled during build/install | [Build and packaging](docs/build-and-packaging.md) |
| Native packages | Always | `make package && make install` | [Build and packaging](docs/build-and-packaging.md) |
| Auto-update manager | Native packages | Included unless `PACKAGE_WITH_UPDATER=0` | [Updater](docs/updater.md) |
| AppImage self-build | Manual | `make build-app && make appimage` | [Build and packaging](docs/build-and-packaging.md#appimage-local-self-build) |
| Nix flake | Manual | `nix run github:ilysenko/codex-desktop-linux` | [Nix](docs/nix.md) |
| GUI install prompts | If installed | Uses `kdialog` / `zenity`, then terminal fallback | [Native setup](docs/native-setup.md) |
| Linux file manager integration | Always | Built into core Linux patches | [Architecture](docs/architecture.md) |
| Chrome plugin native host | Always | Installed with bundled plugins | [Architecture](docs/architecture.md) |
| Browser annotations | Always | Built into the patched webview | [Architecture](docs/architecture.md) |
| Tray and warm-start handoff | Always | Normal app launch | [Architecture](docs/architecture.md) |
| Multiple app instances | Opt-in | `./codex-app/start.sh --new-instance` | [Build and packaging](docs/build-and-packaging.md#running-the-generated-app) |
| Linux Computer Use backend | Bundled | MCP backend registers by default | [Linux Computer Use](docs/linux-computer-use.md) |
| Linux Computer Use UI | Opt-in | `CODEX_LINUX_ENABLE_COMPUTER_USE_UI=1` or settings flag | [Linux Computer Use](docs/linux-computer-use.md#enable-the-in-app-ui) |
| Linux Features framework | Opt-in | Edit `linux-features/features.json` | [Linux Features](linux-features/README.md) |
| Agent Workspaces | Opt-in | `agent-workspace` | [Docs](linux-features/agent-workspace/README.md) |
| Linux AppShots | Opt-in | `appshots` | [Docs](linux-features/appshots/README.md) |
| Wrapper updater button | Opt-in | `codex-wrapper-updater` | [Docs](linux-features/codex-wrapper-updater/README.md) |
| Conversation mode | Opt-in | `conversation-mode` | [Docs](linux-features/conversation-mode/README.md) |
| Copilot reasoning effort defaults | Opt-in | `copilot-reasoning-effort` | [Docs](linux-features/copilot-reasoning-effort/README.md) |
| Example Linux Feature | Developer example | `example-feature` | [Docs](linux-features/example-feature/README.md) |
| Open Target Discovery | Opt-in | `open-target-discovery` | [Docs](linux-features/open-target-discovery/README.md) |
| API key service tier | Opt-in | `api-key-service-tier` | [Docs](linux-features/api-key-service-tier/README.md) |
| Read Aloud button | Opt-in | `read-aloud` | [Docs](linux-features/read-aloud/README.md) |
| Read Aloud MCP | Opt-in | `read-aloud-mcp` | [Docs](linux-features/read-aloud-mcp/README.md) |
| Remote Control UI gates | Opt-in | `remote-control-ui` | [Docs](linux-features/remote-control-ui/README.md) |
| Experimental Remote Mobile Control | Opt-in | `remote-mobile-control` | [Docs](linux-features/remote-mobile-control/README.md) |
| Thorium Chrome Plugin Support | Opt-in | `thorium-chrome-plugin` | [Docs](linux-features/thorium-chrome-plugin/README.md) |

Server-gated upstream features, such as model rollouts, are controlled by
OpenAI per account. Rebuilding this wrapper does not unlock them.

## Optional Linux Features

Optional Linux-only integrations live in `linux-features/` and are disabled by
default. They can add ASAR patches, staged resources, runtime hooks, package
hooks, or legacy build/install hooks without changing the core build flow.

Enable tracked or local features before building:

```bash
cp linux-features/features.example.json linux-features/features.json
```

```json
{
  "enabled": [
    "read-aloud",
    "open-target-discovery"
  ]
}
```

Private user-local features can live under the git-ignored
`linux-features/local/<feature-id>/` directory and use the same `feature.json`
contract. Rebuild after changing feature choices:

```bash
make install-native
```

Full contract: [linux-features/README.md](linux-features/README.md) and
[docs/linux-features-architecture.md](docs/linux-features-architecture.md).

## Updates

Default native packages install `codex-update-manager`, a `systemd --user`
service that checks for newer upstream DMGs, rebuilds a local native package,
and installs it after Codex Desktop exits. The final install uses `pkexec`.
Minimal window-manager sessions need a graphical polkit authentication agent
for the in-app install button; otherwise the updater keeps the package ready
and reports a terminal `sudo /usr/bin/codex-update-manager ... --path ...`
command.

Manual-update package:

```bash
PACKAGE_WITH_UPDATER=0 make package
make install
```

Manual rebuild from a trusted checkout:

```bash
PACKAGE_WITH_UPDATER=0 make update-native
```

AppImage builds and repo-only generated apps do not include the native-package
updater. See [Updater](docs/updater.md).

## Build, Package, And Run

Generate the local Electron app:

```bash
make build-app-fresh
make run-app
```

Use a local DMG:

```bash
make build-app DMG=/path/to/Codex.dmg
```

Build and install a package:

```bash
make package
make install
```

Build a specific artifact:

```bash
make deb
make rpm
make pacman
make appimage
```

The package scripts only repackage the already-generated `codex-app/`. They do
not download or extract the DMG themselves. See
[Build and packaging](docs/build-and-packaging.md).

## Troubleshooting

| Problem | First thing to try |
|---|---|
| `/tmp` is mounted `noexec` | Set `TMPDIR` and `XDG_CACHE_HOME` to executable directories under `$HOME` |
| Blank window or splash stuck | Check `~/.cache/codex-desktop/launcher.log` and whether port `5175` is already in use |
| `CODEX_CLI_PATH` or CLI install error | Reopen the app or install `@openai/codex` manually |
| Wayland / GPU / Vulkan hang | Try `CODEX_LINUX_RENDERING_MODE=wayland-gpu ./codex-app/start.sh` or persistent launch flags |
| Resize ghosting or stale frame trails | Try `CODEX_ELECTRON_DISABLE_GPU_COMPOSITING=1 ./codex-app/start.sh` or `--disable-gpu-compositing` |
| Computer Use UI is hidden | Enable the UI opt-in; account/server rollouts may still hide upstream-gated parts |
| Computer Use has no input backend | Check `/dev/uinput`, portal support, or `ydotoold` / `ydotool.service` |
| Updater seems stuck | Check `codex-update-manager status --json` and service logs |

Full list: [Troubleshooting](docs/troubleshooting.md).

## Project Docs

- [Native setup](docs/native-setup.md)
- [Nix](docs/nix.md)
- [Linux Computer Use](docs/linux-computer-use.md)
- [Updater](docs/updater.md)
- [Build and packaging](docs/build-and-packaging.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Architecture](docs/architecture.md)
- [GitHub CLI auth in app-launched shells](docs/github-cli-auth.md)
- [Linux Features architecture](docs/linux-features-architecture.md)
- [Webview server evaluation](docs/webview-server-evaluation.md)

## Disclaimer

This is an unofficial community project. Codex Desktop is a product of OpenAI.
This tool does not redistribute any OpenAI software; it automates the conversion
process that users perform on their own copies.

## License

MIT
