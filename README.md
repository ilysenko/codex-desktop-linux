<p align="center">
  <img src="assets/chatgpt-linux.png" width="96" alt="ChatGPT Desktop for Linux icon">
</p>

<h1 align="center">ChatGPT Desktop for Linux</h1>

<p align="center">
  <strong>Official project repository:</strong>
  <a href="https://github.com/EricKrouss/chatgpt-desktop-linux">EricKrouss/chatgpt-desktop-linux</a>
</p>

Unofficial Linux build wrapper for the [OpenAI ChatGPT desktop app](https://openai.com/chatgpt/download/).
The official ChatGPT app is available for macOS and Windows; this repository
covers Linux by converting the upstream macOS `ChatGPT.dmg` into a runnable Linux
Electron app. The icon above is the official ChatGPT app artwork extracted from
the supported upstream build.

This project builds on the original Codex Linux port created by **ilysenko**:
[ilysenko/codex-desktop-linux](https://github.com/ilysenko/codex-desktop-linux).

The project builds native `.deb`, `.rpm`, and `.pkg.tar.zst` packages, supports
local AppImage self-builds and Nix, and can install a local update manager that
rebuilds future Linux packages from newer upstream DMGs.

<p align="center">
  <a href="#how-to-install">Install</a> ·
  <a href="#uninstall">Uninstall</a> ·
  <a href="#feature-matrix">Features</a> ·
  <a href="#updates">Updates</a> ·
  <a href="#build-package-and-run">Build</a> ·
  <a href="#troubleshooting">Troubleshooting</a> ·
  <a href="#project-docs">Docs</a> ·
  <a href="https://github.com/EricKrouss/chatgpt-desktop-linux">Repository</a>
</p>

Before opening a pull request, read [CONTRIBUTING.md](CONTRIBUTING.md). For
implementation details, see [AGENTS.md](AGENTS.md).

## How To Install

ChatGPT Desktop for Linux is built locally from the upstream `ChatGPT.dmg`: the
installer downloads or reuses the DMG, extracts the Electron app, applies Linux
compatibility patches, rebuilds native modules, stages the Linux runtime, and
packages the result. Optional Linux-only integrations live in `linux-features/`
and stay disabled unless you enable them before building.

For native packages and AppImage self-builds, start from a checkout:

```bash
git clone https://github.com/EricKrouss/chatgpt-desktop-linux.git
cd chatgpt-desktop-linux
```

| Platform | Recommended path | Notes |
|---|---|---|
| Debian, Ubuntu, Pop!_OS, Mint, Elementary | `make bootstrap-native` | Builds and installs a `.deb` |
| Fedora | `make bootstrap-native` | Builds and installs an `.rpm` |
| openSUSE | `make bootstrap-native` | Builds and installs an `.rpm` |
| Arch, Manjaro, EndeavourOS | `make bootstrap-native` | Builds and installs a pacman package |
| NixOS / Nix | `nix run github:EricKrouss/chatgpt-desktop-linux` | See [Nix docs](docs/nix.md) |
| Atomic desktops / other distros | `make build-app && make appimage` | Local self-build; no bundled updater |

Recommended native install:

```bash
make bootstrap-native
```

If dependencies are already installed:

```bash
make install-native
```

`make bootstrap-native` installs build dependencies, validates the cached
upstream `ChatGPT.dmg`, downloads it only when missing or stale, builds
`chatgpt-app/`, packages it for your distro, and installs the newest artifact
from `dist/`.

After a native install, launch it from your desktop app menu as **ChatGPT
Desktop** or run `chatgpt-desktop` from a terminal. Running `./install.sh`
directly only regenerates the local `chatgpt-app/` tree; it does not register a
desktop entry.

Native packages use the `chatgpt-desktop` package and application id. Installing
one replaces the legacy `codex-desktop` package so only the current ChatGPT
Desktop launcher remains in the app menu. They also install the host Git client
and CA certificates; the launcher uses that Git installation's HTTPS transport
for fetches and pushes started inside ChatGPT Desktop.

Native packages include the update manager by default. It checks the official
ChatGPT DMG in the background, rebuilds a native package when OpenAI publishes a
new build, surfaces the ready update through the app, and installs it after
ChatGPT Desktop closes. See [Updates](#updates).

This project supports the latest **New ChatGPT** Electron DMG:
`https://persistent.oaistatic.com/codex-app-prod/ChatGPT.dmg`. The
`https://persistent.oaistatic.com/sidekick/public/ChatGPT.dmg` ChatGPT Classic
DMG is a native macOS app, not an Electron bundle, so this Linux conversion
pipeline cannot build it. If Classic is selected, the installer exits before
downloading and points back to New ChatGPT:

```bash
./install.sh --classic-chatgpt
```

DMG extraction accepts any available `7z`, `7za`, or `7zz` command. Depending on
the distribution, that command may be provided by a package named `p7zip`,
`p7zip-full`, or `7zip`.

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

## Uninstall

Close ChatGPT Desktop first, then remove the native package with your distro's
package manager:

```bash
# Debian / Ubuntu
sudo apt remove chatgpt-desktop

# Fedora
sudo dnf remove chatgpt-desktop

# openSUSE
sudo zypper remove chatgpt-desktop

# Arch / Manjaro
sudo pacman -R chatgpt-desktop
```

Native package removal stops and disables `chatgpt-update-manager.service` when
the service is installed. If the service was left behind by an older package or
a manual install, disable it explicitly:

```bash
systemctl --user disable --now chatgpt-update-manager.service
```

AppImage builds are not installed system-wide by this repository; delete the
AppImage file you created. A repo-only generated app can be removed from the
checkout with:

```bash
rm -rf chatgpt-app
```

`nix run github:EricKrouss/chatgpt-desktop-linux` is ephemeral. If you installed
the flake through a Nix profile, Home Manager, or a NixOS module, remove that
profile or configuration entry and rebuild your profile/system.

User data is preserved for reinstall. To remove only this wrapper's local app
state, logs, launcher flags, and updater state, delete these paths.

If you enabled Remote Mobile Control, `~/.config/chatgpt-desktop` can contain
`remote-control-device-keys-v1.json`. Revoke paired devices in ChatGPT Desktop
settings or ChatGPT before deleting that file or removing the whole directory.
For feature-owned data, prefer the cleanup flow in
[Native setup](docs/native-setup.md#feature-cleanup).

```bash
rm -rf \
  ~/.config/chatgpt-desktop \
  ~/.local/state/chatgpt-desktop \
  ~/.cache/chatgpt-desktop \
  ~/.config/chatgpt-update-manager \
  ~/.local/state/chatgpt-update-manager \
  ~/.cache/chatgpt-update-manager
```

Do not remove `~/.codex` unless you also want to delete your Codex CLI
configuration and project state.

## Before You Install

The generated app and native packages bundle a managed Linux Node.js runtime.
You do not need a distro `nodejs` / `npm` package for normal installs, Browser
Use, Codex CLI install/update, or local auto-update rebuilds.

The Codex CLI is still required at runtime. The first launch can install or
update `@openai/codex` with the bundled `npm`, or you can manage the CLI
yourself. If you install the CLI manually through npm, include optional
dependencies with `npm i -g --include=optional @openai/codex` so the Linux
platform binary is present. The launcher does not rank installed CLIs by
version; it uses an explicit `CODEX_CLI_PATH` first, then the normal lookup
order, and logs the resolved CLI path plus best-effort version so GUI PATH
issues are visible. Set `CODEX_CLI_PATH=/path/to/codex` when you want to pin a
specific binary.

X11 and Wayland sessions are supported. The launcher prefers XWayland on
Wayland when available for reliable Electron popup positioning and the global
screen coordinates needed by the draggable pet overlay. Pure Wayland sessions
fall back to Electron's automatic backend selection; native Wayland can also be
selected explicitly with `--wayland` or `CODEX_OZONE_PLATFORM=wayland`. See
[Troubleshooting](docs/troubleshooting.md) for GPU, Vulkan, and `/tmp noexec`
workarounds.

## Feature Matrix

### Core And Platform Support

| Feature | Default | Enable / use | Docs |
|---|---|---|---|
| Standard ChatGPT Desktop UI | Always | Install or run the generated app | This README |
| Managed Linux Node.js runtime | Always | Bundled during build/install | [Build and packaging](docs/build-and-packaging.md) |
| Native packages | Always | `make package && make install` | [Build and packaging](docs/build-and-packaging.md) |
| Auto-update manager | Native packages | Included unless `PACKAGE_WITH_UPDATER=0` | [Updater](docs/updater.md) |
| AppImage self-build | Manual | `make build-app && make appimage` | [Build and packaging](docs/build-and-packaging.md#appimage-local-self-build) |
| Nix flake | Manual | `nix run github:EricKrouss/chatgpt-desktop-linux` | [Nix](docs/nix.md) |
| GUI install prompts | If installed | Uses `kdialog` / `zenity`, then terminal fallback | [Native setup](docs/native-setup.md) |
| Linux file manager integration | Always | Built into core Linux patches | [Architecture](docs/architecture.md) |
| Chrome plugin native host | Always | Installed with bundled plugins | [Architecture](docs/architecture.md) |
| Browser annotations | Always | Built into the patched webview | [Architecture](docs/architecture.md) |
| Tray and warm-start handoff | Always | Normal app launch | [Architecture](docs/architecture.md) |
| Multiple app instances | Opt-in | `./chatgpt-app/start.sh --new-instance` | [Build and packaging](docs/build-and-packaging.md#running-the-generated-app) |
| Linux Computer Use backend | Bundled | MCP backend registers by default | [Linux Computer Use](docs/linux-computer-use.md) |
| Linux Computer Use UI | Opt-in | `CODEX_LINUX_ENABLE_COMPUTER_USE_UI=1` or settings flag | [Linux Computer Use](docs/linux-computer-use.md#enable-the-in-app-ui) |
| Linux Features framework | Opt-in | Edit `linux-features/features.json` | [Linux Features](linux-features/README.md) |

### Opt-In Linux Features

| Feature | Default / status | Enable / use | Docs |
|---|---|---|---|
| Record and Replay (alpha) | Opt-in alpha | `record-and-replay` | [Docs](linux-features/record-and-replay/README.md) |
| Agent Workspaces | Opt-in | `agent-workspace` | [Docs](linux-features/agent-workspace/README.md) |
| API key service tier | Opt-in | `api-key-service-tier` | [Docs](linux-features/api-key-service-tier/README.md) |
| Linux AppShots | Opt-in | `appshots` | [Docs](linux-features/appshots/README.md) |
| Authenticated proxy | Opt-in | `authenticated-proxy` | [Docs](linux-features/authenticated-proxy/README.md) |
| Wrapper updater button | Opt-in | `chatgpt-wrapper-updater` | [Docs](linux-features/chatgpt-wrapper-updater/README.md) |
| Conversation mode | Opt-in | `conversation-mode` | [Docs](linux-features/conversation-mode/README.md) |
| Copilot reasoning effort defaults | Opt-in | `copilot-reasoning-effort` | [Docs](linux-features/copilot-reasoning-effort/README.md) |
| Example Linux Feature | Developer example | `example-feature` | [Docs](linux-features/example-feature/README.md) |
| Frameless titlebar | Opt-in | `frameless-titlebar` | [Docs](linux-features/frameless-titlebar/README.md) |
| MCP helper reaper | Opt-in | `mcp-helper-reaper` | [Docs](linux-features/mcp-helper-reaper/README.md) |
| Browser Use node_repl reaper | Opt-in | `node-repl-reaper` | [Docs](linux-features/node-repl-reaper/README.md) |
| Open Target Discovery | Opt-in | `open-target-discovery` | [Docs](linux-features/open-target-discovery/README.md) |
| Persistent status panel | Opt-in | `persistent-status-panel` | [Docs](linux-features/persistent-status-panel/README.md) |
| Read Aloud button | Opt-in | `read-aloud` | [Docs](linux-features/read-aloud/README.md) |
| Read Aloud MCP | Opt-in | `read-aloud-mcp` | [Docs](linux-features/read-aloud-mcp/README.md) |
| Remote Control UI gates | Opt-in | `remote-control-ui` | [Docs](linux-features/remote-control-ui/README.md) |
| Experimental Remote Mobile Control | Opt-in | `remote-mobile-control` | [Docs](linux-features/remote-mobile-control/README.md) |
| Thorium Chrome Plugin Support | Opt-in | `thorium-chrome-plugin` | [Docs](linux-features/thorium-chrome-plugin/README.md) |
| UI tweaks | Opt-in | `ui-tweaks` | [Docs](linux-features/ui-tweaks/README.md) |
| X11/EWMH Computer Use adapter | Opt-in | `x11-ewmh-computer-use` | [Docs](linux-features/x11-ewmh-computer-use/README.md) |

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

Default native packages install `chatgpt-update-manager`, a `systemd --user`
service that checks for newer upstream DMGs, rebuilds a local native package,
and installs it after ChatGPT Desktop exits. The final install uses `pkexec`.
Minimal window-manager sessions need a graphical polkit authentication agent
for the in-app install button; otherwise the updater keeps the package ready
and reports a terminal `sudo /usr/bin/chatgpt-update-manager ... --path ...`
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
make build-app DMG=/path/to/ChatGPT.dmg
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

The package scripts only repackage the already-generated `chatgpt-app/`. They do
not download or extract the DMG themselves. See
[Build and packaging](docs/build-and-packaging.md).

## Troubleshooting

| Problem | First thing to try |
|---|---|
| `/tmp` is mounted `noexec` | Set `TMPDIR` and `XDG_CACHE_HOME` to executable directories under `$HOME` |
| Blank window or splash stuck | Check `~/.cache/chatgpt-desktop/launcher.log` and whether port `5175` is already in use |
| `CODEX_CLI_PATH` or CLI install error | Check `~/.cache/chatgpt-desktop/launcher.log`, set `CODEX_CLI_PATH=/path/to/codex` to pin a binary, or install `@openai/codex` manually with optional dependencies |
| Wayland / GPU / Vulkan hang | Try `CODEX_LINUX_RENDERING_MODE=wayland-gpu ./chatgpt-app/start.sh` or persistent launch flags |
| UI oversized or blurry (HiDPI / fractional scaling) | Try `CODEX_FORCE_DEVICE_SCALE_FACTOR=1 ./chatgpt-app/start.sh` or `CODEX_OZONE_PLATFORM=x11 ./chatgpt-app/start.sh`; see `./chatgpt-app/start.sh --diagnose-scaling` |
| Resize ghosting or stale frame trails | Try `CODEX_ELECTRON_DISABLE_GPU_COMPOSITING=1 ./chatgpt-app/start.sh` or `--disable-gpu-compositing` |
| Computer Use UI is hidden | Enable the UI opt-in; account/server rollouts may still hide upstream-gated parts |
| Computer Use has no input backend | Check `/dev/uinput`, portal support, or `ydotoold` / `ydotool.service` |
| Updater seems stuck | Check `chatgpt-update-manager status --json` and service logs |

Full list: [Troubleshooting](docs/troubleshooting.md).

## Project Docs

- [Native setup](docs/native-setup.md)
- [Nix](docs/nix.md)
- [Linux Computer Use](docs/linux-computer-use.md)
- [Record and Replay on Linux](docs/record-and-replay-linux.md)
- [Updater](docs/updater.md)
- [Build and packaging](docs/build-and-packaging.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Architecture](docs/architecture.md)
- [GitHub CLI auth in app-launched shells](docs/github-cli-auth.md)
- [Linux Features architecture](docs/linux-features-architecture.md)
- [Wayland input focus investigation](docs/wayland-input-focus-investigation.md)
- [Webview server evaluation](docs/webview-server-evaluation.md)
- [Launcher performance notes](docs/launcher-performance.md)

## Credits

The maintained project home, clone URL, issue tracker, and CI are all under
[EricKrouss/chatgpt-desktop-linux](https://github.com/EricKrouss/chatgpt-desktop-linux).
This project began as a ChatGPT-oriented fork of
[ilysenko/codex-desktop-linux](https://github.com/ilysenko/codex-desktop-linux),
which remains credited as the original Linux port foundation.

## Disclaimer

This is an unofficial community project and is not affiliated with OpenAI.
ChatGPT Desktop, OpenAI services, trademarks, upstream application code, binaries,
and assets remain the property of OpenAI or their respective owners.

The MIT license in this repository applies only to this wrapper's source code,
packaging scripts, documentation, and Linux compatibility glue. It does not
grant any rights to OpenAI software or services.

This repository does not redistribute OpenAI software or modified OpenAI
application binaries. Users must obtain their own authorized copy of ChatGPT
Desktop through OpenAI's official channels. The build process performs a local
Linux compatibility conversion on the user's own copy so it can run on Linux.
In practice, it automates the conversion process that users perform on their
own copies.

Use of ChatGPT Desktop remains subject to OpenAI's applicable terms and
server-side feature availability.

## License

MIT
