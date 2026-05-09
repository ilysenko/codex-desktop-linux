# Codex Desktop for Linux

Before opening a pull request, please read [CONTRIBUTING.md](CONTRIBUTING.md).

Unofficial Linux build of [OpenAI Codex Desktop](https://openai.com/codex/). The official Codex Desktop app is macOS-only — this project converts the upstream macOS `Codex.dmg` into a runnable Linux Electron app, ships native `.deb` / `.rpm` / `.pkg.tar.zst` packages plus a Nix flake, and includes a local auto-updater that rebuilds future Linux packages from newer upstream DMGs.

## Supported platforms

| Distro / family | Package manager | Format produced | Notes |
|---|---|---|---|
| Debian, Ubuntu, Pop!_OS, Mint, Elementary | `apt` | `.deb` | Managed Node.js runtime is bundled; no distro Node.js package is required |
| Fedora 41+ | `dnf5` | `.rpm` | |
| Fedora < 41 | `dnf` | `.rpm` | |
| openSUSE Tumbleweed / Leap | `zypper` | `.rpm` | Uses `zypper --no-gpg-checks install` for the local rebuild |
| Arch, Manjaro, EndeavourOS | `pacman` | `.pkg.tar.zst` | |
| NixOS / Nix | flake | runnable directly | `nix run github:ilysenko/codex-desktop-linux` |

Anything systemd-based should work for the optional auto-updater service (`systemd --user`). The launcher targets Wayland with `XWayland` first (better Electron popup positioning); pure Wayland sessions fall through to `--ozone-platform-hint=auto`. X11 is fully supported.

## What you get

| Feature | Status | Notes |
|---|---|---|
| Standard Codex Desktop UI | ✅ always | Chats, browser, files, MCP plugins |
| Auto-updater (`codex-update-manager`) | ✅ always | Detects newer upstream DMGs, rebuilds + installs locally |
| Native packaging (`.deb` / `.rpm` / `.pkg.tar.zst`) | ✅ always | One-shot `make package` picks your distro |
| Linux tray + warm-start handoff | ✅ always | Single-instance lock, second-instance window focus |
| GUI install prompts (`kdialog` / `zenity`) | ✅ if installed | Falls back to interactive terminal prompt |
| Linux browser annotations | ✅ always | Stored-anchor screenshots, isolated marker rendering |
| Linux Computer Use | ⚠️ opt-in | Linux Computer Use backend with screen capture, accessibility, window targeting, and input synthesis. The MCP server registers by default; the in-app UI surface is enabled at your discretion — see "Enabling Computer Use UI" below. Validated on Ubuntu/GNOME, KDE Plasma/KWin, Hyprland, and i3. |
| Server-gated features (e.g. `gpt-5.5`) | 🟡 server-side | OpenAI rolls per-account, not project-controlled. Building a fresh package does not unlock these. |

## Before you install

Codex Desktop for Linux now bundles a managed Linux Node.js runtime in the generated app and native packages. You do **not** need a distro `nodejs` / `npm` package for normal installs, Browser Use, Codex CLI install/update, or local auto-update rebuilds.

Existing `nvm`, asdf, Volta, NodeSource, or nodejs.org tarball installs are still fine. They are optional user tooling now, not required package dependencies.

The Codex CLI is still required at runtime, but the first launch can install or update `@openai/codex` automatically using the bundled managed `npm`. You can also pre-install and manage the CLI yourself if you prefer.

On some systems (e.g. hardened Linux setups), `/tmp` may be mounted with `noexec`, preventing the rust installer and bundled Node.js runtime from executing.

Workaround:

```bash
mkdir -p ~/tmp/codex-work ~/tmp/codex-cache

export TMPDIR=~/tmp/codex-work
export XDG_CACHE_HOME=~/tmp/codex-cache

# run install steps in this shell
```

## Quick install

The fastest path: install deps, build the local app, build the native package, install it.

```bash
git clone https://github.com/ilysenko/codex-desktop-linux.git
cd codex-desktop-linux
bash scripts/install-deps.sh
make build-app
make package        # auto-detects deb / rpm / pacman
make install        # installs the newest package from dist/
```

`make package` picks the format that matches your distro. `make install` then runs the right `dpkg -i` / `dnf install` / `zypper install` / `pacman -U` against the freshly built artifact.

The first launch can auto-install the Codex CLI (`@openai/codex`) using the bundled managed Node.js runtime. You can still pre-install the CLI yourself, but a system `node` / `npm` install is no longer required for the packaged app.

### NixOS / Nix one-liner

```bash
nix run github:ilysenko/codex-desktop-linux
```

The flake handles dependencies and patches Electron for NixOS. A GitHub Actions bot keeps the upstream `Codex.dmg` SRI hash and the recursive Nix payload `outputHash` refreshed in `main` every 2 hours. If you happen to try right after an upstream Codex release and hit `error: hash mismatch in fixed-output derivation`, wait for the next bot run and retry.

`nix develop github:ilysenko/codex-desktop-linux` enters a dev shell with the required tooling.

## Linux Computer Use

Linux Computer Use is an **opt-in** plugin that lets Codex inspect and control desktop apps on Linux through a native Rust MCP backend (`codex-computer-use-linux`). It is designed and maintained by [@avifenesh](https://github.com/avifenesh). It supports:

- **App listing & accessibility tree** — via AT-SPI bus (`org.a11y.Bus`)
- **Screenshot capture** — primary path through GNOME Shell DBus, fallback through XDG Desktop Portal (`org.freedesktop.portal.Screenshot`)
- **Window listing & focusing** — via the Codex GNOME Shell extension, GNOME Shell introspection, KWin/Plasma DBus scripting, Hyprland `hyprctl`, or i3 `i3-msg`
- **Input synthesis** — keys, text, click, scroll, drag — through `ydotool` with `ydotoold` daemon

### Runtime dependencies

```bash
# Debian / Ubuntu
sudo apt install ydotool
# Some Ubuntu releases package the daemon separately:
sudo apt install ydotoold

# Fedora
sudo dnf install ydotool

# Arch
sudo pacman -S ydotool

# openSUSE
sudo zypper install ydotool
```

`ydotool` needs `/dev/uinput` access. The simplest path is to run `ydotoold` as the daemon and add your user to the `input` group (then re-login):

```bash
sudo systemctl enable --now ydotoold
sudo usermod -a -G input "$USER"
```

On Ubuntu 24.04, the `ydotoold` package may install `/usr/bin/ydotoold` without a systemd unit. In that case, create or install a `ydotoold.service` unit before running `systemctl enable --now ydotoold`.

A working XDG Desktop Portal implementation is needed if you are not on GNOME — `xdg-desktop-portal-kde` for KDE Plasma, `xdg-desktop-portal-wlr` for sway / Hyprland, or your distro's preferred portal backend for i3. GNOME ships a working portal by default.

### Verifying readiness

The plugin exposes a `doctor` tool. Once Computer Use is visible in the Codex UI, ask the LLM:

> Check whether Linux Computer Use is ready

The response is a structured report covering AT-SPI bus availability, GNOME Shell version, KWin/Plasma, Hyprland, and i3 windowing support, Desktop Portal interfaces, `ydotool` / `ydotoold` / `/dev/uinput`, and a top-level readiness verdict. You can also invoke the backend binary directly:

```bash
./codex-app/resources/plugins/openai-bundled/plugins/computer-use/bin/codex-computer-use-linux doctor
./codex-app/resources/plugins/openai-bundled/plugins/computer-use/bin/codex-computer-use-linux setup    # enables GNOME accessibility
./codex-app/resources/plugins/openai-bundled/plugins/computer-use/bin/codex-computer-use-linux apps     # lists running apps via AT-SPI
./codex-app/resources/plugins/openai-bundled/plugins/computer-use/bin/codex-computer-use-linux windows  # lists targetable windows
./codex-app/resources/plugins/openai-bundled/plugins/computer-use/bin/codex-computer-use-linux state Codex
./codex-app/resources/plugins/openai-bundled/plugins/computer-use/bin/codex-computer-use-linux screenshot
```

### Enabling Computer Use UI

By default the MCP backend registers, but the Codex Desktop sidebar does not surface the Computer Use controls. If you want to use it through the in-app UI, opt in by setting one of:

```bash
# Ad-hoc, for a single build:
CODEX_LINUX_ENABLE_COMPUTER_USE_UI=1 make build-app

# Persistent (also picked up by the auto-updater on future rebuilds):
mkdir -p ~/.config/codex-desktop
echo '{"codex-linux-computer-use-ui-enabled": true}' > ~/.config/codex-desktop/settings.json
```

Either path enables the in-app controls on subsequent builds. Use of this option is at your own discretion; this is an unofficial Linux build and the upstream app may change at any time.

To opt back out, unset the env var and remove or set the settings flag to `false`.

### Side-by-side dev variant

If you'd like to test the backend without affecting your default install, the side-by-side dev variant builds a separate app under a different ID and webview port:

```bash
make build-dev-app
make run-dev-app
```

Override the dev identity with `DEV_APP_ID`, `DEV_APP_NAME`, and `CODEX_WEBVIEW_PORT` if needed.

## Auto-update Manager

The package installs a companion service named `codex-update-manager`.

- It runs as a `systemd --user` service, started in best-effort mode by the launcher on app launch.
- Each app launch also triggers a background `check-now --if-stale`; the updater skips that request when the last successful upstream check is still fresh, or another check / rebuild / install is already active. Concurrent checks are serialized via a kernel-backed file lock (`flock(2)`).
- It checks the upstream `Codex.dmg` on daemon startup and every 6 hours.
- When a new DMG is detected, it rebuilds a local native package using `/opt/codex-desktop/update-builder`.
- If the app is open, the update waits until Electron exits.
- When the app is closed, the updater uses `pkexec` (with `--disable-internal-agent`, so the desktop polkit agent renders the auth dialog) only for the final native-package install step.
- On Arch, that final install step is `pacman -U --noconfirm` against the locally rebuilt `.pkg.tar.zst`.
- On openSUSE, that final install step is `zypper --non-interactive --no-gpg-checks install` against the locally rebuilt `.rpm` (the package is unsigned because it is built locally).
- A failed or dismissed `pkexec` prompt (exit `126` / `127`) keeps the candidate `ReadyToInstall` and retries on the next app exit, instead of moving to a permanent `Failed` state.
- An `Installing` state interrupted by a crash or restart is automatically recovered.
- Before Electron launches, the launcher only resolves a usable Codex CLI path. If the CLI is missing and the launcher was started from an interactive terminal, it prompts before attempting an automatic install. GUI launches use the updater prompt flow for the same recovery path. The updater CLI preflight then runs in the background by default so npm registry checks and follow-up updates do not block the first window. Set `CODEX_SYNC_CLI_PREFLIGHT=1` to restore the synchronous preflight for debugging.
- That CLI preflight is best-effort: it uses the bundled managed `npm`, applies a 1-hour cooldown for registry checks, falls back to a user-local `~/.local` npm prefix when a global install fails, and keeps the app launch on the current CLI when the automatic refresh does not succeed.
- Automatic installation of a missing CLI is launcher-scoped. The daemon and `codex-update-manager status` report a missing dependency as `cli_status: NotInstalled` and may notify, but they do not install the CLI on their own.

Inspect the live service and runtime files with:

```bash
systemctl --user status codex-update-manager.service
codex-update-manager status --json
sed -n '1,160p' ~/.local/state/codex-update-manager/state.json
sed -n '1,160p' ~/.local/state/codex-update-manager/service.log
```

If a rebuilt update installs but the previous retained package was better, close
Codex Desktop and run:

```bash
codex-update-manager rollback
```

Rollback uses the last retained known-good package and refuses to run when no
rollback package is available.

Runtime files live in standard XDG locations:

```text
~/.config/codex-update-manager/config.toml
~/.local/state/codex-update-manager/state.json
~/.local/state/codex-update-manager/service.log
~/.cache/codex-update-manager/
~/.cache/codex-desktop/launcher.log
~/.local/state/codex-desktop/app.pid
```

## Build from source / custom DMG

### Prerequisites

You need:

- `python3`, `7z` (or `7zz`), `curl`, `unzip`, `make`, `g++`
- **Rust toolchain** (`cargo`) for the `codex-update-manager` and `codex-computer-use-linux` crates

The installer downloads a managed Linux Node.js runtime into `codex-app/resources/node-runtime` and uses it for `node`, `npm`, and `npx` during the build. Existing `nvm`, asdf, Volta, NodeSource, or nodejs.org tarball installs are still fine, but they are no longer required for this project.

The easiest setup is the bundled bootstrap:

```bash
bash scripts/install-deps.sh
```

It auto-detects `apt`, `dnf5`, `dnf`, `pacman`, or `zypper`, installs system packages, and bootstraps Rust through `rustup` when needed.

#### Apt-specific (Debian / Ubuntu / Pop!_OS / Mint)

`install-deps.sh` can still bootstrap NodeSource Node.js for users who want a system Node.js toolchain, but `install.sh`, native packages, Browser Use, and the Codex CLI install/update flow use the bundled managed runtime:

```bash
bash scripts/install-deps.sh                       # full host bootstrap
NODEJS_MAJOR=24 bash scripts/install-deps.sh       # choose a different optional system Node line
```

Ubuntu-family `p7zip-full` can be too old for newer APFS DMGs. `install-deps.sh` bootstraps `7zz` into `~/.local/bin` (set `SEVENZIP_SYSTEM_INSTALL=1` to install to `/usr/local/bin` instead).

#### Manual deps per distro

```bash
# Fedora 41+
sudo dnf install python3 7zip curl unzip @development-tools

# Fedora < 41
sudo dnf install python3 p7zip p7zip-plugins curl unzip
sudo dnf groupinstall 'Development Tools'

# openSUSE
sudo zypper install python3 p7zip-full curl unzip
sudo zypper install -t pattern devel_basis

# Arch / Manjaro
sudo pacman -S --needed python p7zip curl unzip zstd base-devel

# Rust toolchain (any distro)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

### Generate the local Electron app

This produces `codex-app/` from the upstream DMG and writes the Linux launcher to `codex-app/start.sh`:

```bash
make build-app                              # downloads upstream DMG
make build-app DMG=/path/to/Codex.dmg       # use a local copy
make run-app                                # launches the generated app
```

Equivalent direct commands:

```bash
./install.sh                                # default: download or reuse cached DMG
./install.sh /path/to/Codex.dmg             # use a specific DMG
./install.sh --fresh                        # remove existing install dir + cached DMG
./codex-app/start.sh                        # run after build
```

Manual Codex CLI installation is optional. If you choose to manage the CLI yourself and `npm i -g` needs elevated privileges on your system:

```bash
npm i -g --prefix ~/.local @openai/codex
```

### Electron download mirrors

`make build-app` downloads Electron headers while rebuilding native modules, then downloads a Linux Electron runtime. The installer uses Electron's `artifacts.electronjs.org` headers endpoint by default so `@electron/rebuild` does not need to connect to `www.electronjs.org`. If the later runtime download from GitHub is slow or blocked, use an Electron runtime mirror:

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ \
make build-app
```

`ELECTRON_HEADERS_URL` is passed to `@electron/rebuild --dist-url`. It must provide both `node-v<version>-headers.tar.gz` and the matching `SHASUMS256.txt`; ordinary Electron runtime mirrors may not include the headers checksum format that `node-gyp` expects.

## Native package formats

After `make build-app`, build a native package from `codex-app/` with the format you need:

| Format | Build command | Output | Install |
|---|---|---|---|
| Debian | `make deb` or `./scripts/build-deb.sh` | `dist/codex-desktop_*.deb` | `sudo dpkg -i dist/codex-desktop_*.deb` |
| RPM (Fedora / openSUSE) | `make rpm` or `./scripts/build-rpm.sh` | `dist/codex-desktop-*.x86_64.rpm` | `sudo dnf install dist/codex-desktop-*.rpm` (Fedora) or `sudo zypper install dist/codex-desktop-*.rpm` (openSUSE) |
| Arch (pacman) | `make pacman` or `./scripts/build-pacman.sh` | `dist/codex-desktop-*.pkg.tar.zst` | `sudo pacman -U dist/codex-desktop-*.pkg.tar.zst` |
| Auto-detect | `make package && make install` | matches your distro | handled by `make install` |

Override the package version with `PACKAGE_VERSION=YYYY.MM.DD.HHMMSS+commitish ./scripts/build-*.sh`.

The packaging scripts only repackage what's already in `codex-app/`. They do not download or extract the DMG themselves.

Native packages bundle the managed Node.js runtime used by the launcher, Browser Use, Codex CLI install/update flow, and local auto-update rebuilds. They do not hard-depend on distro `nodejs` / `npm`, so installs also work when Node.js comes from `nvm`, asdf, Volta, or the nodejs.org tarball. Packages still pull in `polkit` (or `policykit-1` on older Debian/Ubuntu) plus `pkexec` so the privileged install flow works out of the box.

### Updater service controls

After installing a native package:

```bash
make service-enable           # enable + start the systemd --user service
make service-status           # systemctl --user status
codex-update-manager status --json
```

`make service-enable` is not meant for an unpackaged repo-only run unless you've already installed the package into the system.

## Make targets

```bash
make help
make check
make test
make build-updater
make build-app
make run-app
make build-dev-app
make run-dev-app
make deb
make rpm
make pacman
make package           # auto-detect distro
make install           # install latest dist/ artifact
make service-enable
make service-status
make clean-dist
make clean-state
```

## Troubleshooting

| Problem | Solution |
|---|---|
| `Error: write EPIPE` | Run `start.sh` directly instead of piping output |
| Blank window | Check whether the configured webview port is already in use: `ss -tlnp \| grep -E '5175\|5176'` |
| `ERR_CONNECTION_REFUSED` on the webview port | The webview HTTP server failed to start. Ensure `python3` works and the configured port is free |
| Stuck on Codex logo splash | Check `~/.cache/codex-desktop/launcher.log`. If webview origin validation failed, another process is probably serving the configured webview port or the extracted `content/webview/` bundle is incomplete |
| `CODEX_CLI_PATH` error | Reopen the app to retry the automatic CLI install flow, or install manually with `npm i -g @openai/codex` / `npm i -g --prefix ~/.local @openai/codex` |
| Electron hangs while CLI is outdated | Re-run the launcher and check `~/.cache/codex-desktop/launcher.log` plus `~/.local/state/codex-update-manager/service.log`. Best-effort CLI preflight will warn if the automatic refresh fails |
| GPU / Vulkan / Wayland errors | Under Wayland with `DISPLAY` available, the launcher uses `--ozone-platform=x11` for window-positioning compatibility. Otherwise it uses `--ozone-platform-hint=auto`. GPU sandbox / compositing are disabled by default |
| Window flickering | GPU compositing is disabled by default. If flickering persists, try `./codex-app/start.sh --disable-gpu` to fully disable GPU acceleration |
| Sandbox errors | The launcher already sets `--no-sandbox` |
| Stale install / cached DMG | `./install.sh --fresh` removes the existing install dir and re-downloads |
| Computer Use plugin invisible in UI | Most likely the OpenAI per-account Statsig rollout (`computerUse` feature flag) hasn't been enabled for your account. Building / reinstalling does not change this |
| Computer Use `doctor` reports `ydotool not running` | `sudo systemctl enable --now ydotoold` and add your user to the `input` group |
| `ConnectTimeoutError` for `www.electronjs.org` during `@electron/rebuild` | Re-run `make build-app`; the installer now uses `https://artifacts.electronjs.org/headers/dist` for Electron headers by default |
| Computer Use AT-SPI tree empty | Run `codex-computer-use-linux setup` to flip GNOME accessibility on, then restart the target app |
| `codex-update-manager` keeps running after package removal | `systemctl --user disable --now codex-update-manager.service` once in the affected session, then confirm `/opt/codex-desktop` is gone |

## How it works

1. `install.sh` extracts `Codex.dmg` with `7z`/`7zz`
2. It auto-detects the Electron version from upstream metadata, falling back to a pinned constant
3. It extracts and patches `app.asar` (Linux File Manager integration, tray, single-instance handoff, browser-annotation fixes, Computer Use platform gate, Linux opaque background, etc.) — every patch fail-soft, with regex-driven needles
4. It rebuilds native Node modules (`better-sqlite3`, `node-pty`) for Linux via `@electron/rebuild`
5. It downloads the matching Linux Electron runtime (cached under `~/.cache/codex-desktop/electron/`)
6. It writes the Linux launcher into `codex-app/start.sh` (body sourced from `launcher/start.sh.template`)
7. `scripts/build-{deb,rpm,pacman}.sh` packages `codex-app/` into a native artifact
8. The installed package provides `codex-update-manager` plus a `systemd --user` service unit
9. The updater watches for newer upstream DMGs and rebuilds future Linux packages locally

The macOS Codex app is an Electron application; `app.asar` is platform-independent JavaScript but bundles macOS-native modules and a macOS Electron binary. The installer replaces the macOS Electron with a Linux build and recompiles native modules. The `sparkle` module is removed because it is macOS-only.

The extracted app expects a local webview origin, so the launcher starts `python3 -m http.server "$CODEX_LINUX_WEBVIEW_PORT" --bind 127.0.0.1` from `content/webview/`, exports `ELECTRON_RENDERER_URL`, waits for the socket, validates that `/index.html` contains the expected Codex startup markers, and only then launches Electron. The default app uses port `5175`; the dev-app variant defaults to `5176`. The launcher tracks the owned webview server PID under XDG state, rediscovers an orphaned server from the same `content/webview/` directory, and reuses an already-verified server instead of killing every process that matches the port.

If an existing Electron process is detected, the launcher uses a warm-start handoff: it sends launch-action args (e.g. `--new-chat`, `--prompt-chat`) over a Unix-domain socket and exits, letting the running app's single-instance handler focus the right window.

Native-package-only launcher behavior (desktop-entry hints, `codex-update-manager` session bootstrapping, the launch-time update check) lives in `packaging/linux/codex-packaged-runtime.sh`, which the generated launcher loads only when present inside a packaged install.

The current evaluation for a future Rust replacement of the local webview server lives in `docs/webview-server-evaluation.md`.

## Validation

After changing installer, packaging, or updater logic:

```bash
bash -n install.sh scripts/lib/*.sh launcher/start.sh.template scripts/build-deb.sh scripts/build-rpm.sh scripts/build-pacman.sh scripts/install-deps.sh
node --check scripts/patch-linux-window-ui.js
for file in scripts/patches/*.js; do node --check "$file"; done
node --check scripts/ci/validate-patch-report.js
node --test scripts/patch-linux-window-ui.test.js
bash tests/scripts_smoke.sh
cargo check -p codex-update-manager
cargo test -p codex-update-manager
cargo check -p codex-computer-use-linux
cargo test -p codex-computer-use-linux
make package
```

If `dpkg-deb` is available:

```bash
dpkg-deb -I dist/codex-desktop_*.deb
dpkg-deb -c dist/codex-desktop_*.deb | sed -n '1,40p'
```

If `rpmbuild` is available:

```bash
make rpm
```

If `makepkg` is available (Arch):

```bash
./scripts/build-pacman.sh
pacman -Qip dist/codex-desktop-*.pkg.tar.zst
pacman -Qlp dist/codex-desktop-*.pkg.tar.zst | sed -n '1,40p'
```

## Versioning

`codex-update-manager` current crate version: `0.7.1`

SemVer policy:

- **patch** for fixes, docs, and maintenance-only updates
- **minor** for compatible feature additions
- **major** for incompatible CLI, persisted-state, or install-flow changes

See [CHANGELOG.md](CHANGELOG.md) for per-version detail.

## Disclaimer

This is an unofficial community project. Codex Desktop is a product of OpenAI. This tool does not redistribute any OpenAI software; it automates the conversion process that users perform on their own copies.

## License

MIT
