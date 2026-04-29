# Codex Desktop for Linux

Run [OpenAI Codex Desktop](https://openai.com/codex/) on Linux.

The official Codex Desktop app is macOS-only. This project converts the upstream macOS `Codex.dmg` into a runnable Linux Electron app, packages it as `.deb`, `.rpm`, or pacman artifacts, and includes a local updater that rebuilds future Linux packages from newer upstream DMGs.

`codex-update-manager` current crate version: `0.4.3`

SemVer policy for the crate:

- `major` for incompatible CLI, persisted-state, or install-flow changes
- `minor` for compatible feature additions
- `patch` for fixes, docs, and maintenance-only updates

## Supported Workflows

This repo supports 2 primary workflows:

1. Generate a local Linux app into `codex-app/` and run it directly from the checkout.
2. Build and install a native package that installs the app under `/opt/codex-desktop` and the updater service under `systemd --user`.

The build pipeline is:

1. Extract the macOS `.dmg` with `7z`
2. Extract and patch `app.asar`
3. Rebuild native Node.js modules for Linux
4. Download a Linux Electron runtime
5. Write a Linux launcher into `codex-app/start.sh`
6. Optionally package `codex-app/` as a Debian, RPM, or pacman package
7. When installed from a native package, run `codex-update-manager` as a `systemd --user` service for local auto-updates

During the ASAR patch step, the installer also attempts a Linux-specific fix for `Open in File Manager`. If the upstream minified bundle changes and that targeted patch no longer matches, the installer keeps going and emits exactly:

```text
Failed to apply Linux File Manager Patch
```

The same ASAR patch step also defaults `Translucent sidebar` to `false` on Linux by setting `opaqueWindows: true` only when the user has not already saved an explicit preference. Existing user choices still win.

## Prerequisites

You need:

- Node.js 20+
- `npm`, `npx`
- `python3`
- `7z`
- `curl`
- `unzip`
- `make`
- `g++`
- Rust and `cargo` for `codex-update-manager`

The easiest setup path is:

```bash
bash scripts/install-deps.sh
```

That helper detects `apt`, `dnf5`, `dnf`, or `pacman`, installs system packages, and bootstraps Rust through `rustup` if needed.
The generated launcher can then auto-install `@openai/codex` on first run if the CLI is still missing and `npm` is available.

If you prefer to preinstall the CLI manually:

```bash
npm i -g @openai/codex
```

That helper detects `apt`, `dnf5`, `dnf`, `pacman`, or `zypper`, installs system packages, and bootstraps Rust through `rustup` if needed.

If your system does not allow global npm installs, a rootless alternative also works:

```bash
npm i -g --prefix ~/.local @openai/codex
```

### Ubuntu / Pop!_OS Note

Ubuntu-family `p7zip-full` can be too old to extract newer APFS DMGs.
Run `bash scripts/install-deps.sh` to install dependencies and bootstrap a newer `7zz`
into `~/.local/bin` by default (set `SEVENZIP_SYSTEM_INSTALL=1` to use `/usr/local/bin` instead).

To install it manually, use the current Linux tarball from
https://www.7-zip.org/download.html:

```bash
# Replace <VERSION> with the current version number from the download page
curl -L -o /tmp/7z.tar.xz "https://www.7-zip.org/a/7z<VERSION>-linux-x64.tar.xz"
tar -C /tmp -xf /tmp/7z.tar.xz 7zz
install -d -m 755 "$HOME/.local/bin"
install -m 755 /tmp/7zz "$HOME/.local/bin/7zz"
```

### Fedora

You need **Node.js 20+**, **npm**, **Python 3**, **7z**, **curl**, build tools (`gcc`/`g++`/`make`), and **Rust** (`cargo`) for the updater crate and local package rebuilds.

The easiest way to install the required system packages is:

```bash
bash scripts/install-deps.sh
```

That helper detects `apt`, `dnf5`, `dnf`, `pacman`, or `zypper`, installs the system dependencies, and bootstraps Rust through `rustup` if needed.

### openSUSE

```bash
bash scripts/install-deps.sh
```

Or manually:

```bash
sudo zypper install nodejs-default npm-default python3 p7zip-full curl unzip
sudo zypper install -t pattern devel_basis
```

You also need the **Rust toolchain** for the updater crate:

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

### Arch Linux

```bash
bash scripts/install-deps.sh
```

Or manually:

```bash
sudo pacman -S --needed nodejs npm python p7zip curl unzip zstd base-devel
```

You also need the **Rust toolchain** for the updater crate:

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

### NixOS

A Nix flake is provided that handles dependencies and patches Electron for NixOS:

```bash
nix run github:ilysenko/codex-desktop-linux
```

This installs the app into `codex-app/` in the current directory. You can also enter a dev shell with the required tooling:

```bash
nix develop github:ilysenko/codex-desktop-linux
```

**Note on `hash mismatch` errors.** The flake pins the SRI hash of the upstream `Codex.dmg`, which OpenAI republishes at the same URL on every release. A GitHub Actions bot refreshes that hash in `main` once every 24 hours, so most of the time `nix run` just works. If you happen to try right after a new Codex release and hit:

```text
error: hash mismatch in fixed-output derivation
```

wait up to a day for the bot to publish the updated hash, then retry. If it still fails after that, please open an issue — the bot may need a manual nudge.

## Quick Start

Clone the repo, generate the local app, and run it:

```bash
git clone https://github.com/ilysenko/codex-desktop-linux.git
cd codex-desktop-linux
bash scripts/install-deps.sh
make build-app
make run-app
```

The first launch can auto-install the Codex CLI if it is still missing.
If you prefer to preinstall it yourself, use:

```bash
npm i -g @openai/codex
```

If global npm installs need elevated privileges on your system, replace that with:

```bash
npm i -g --prefix ~/.local @openai/codex
```

### Use your own DMG

```bash
make build-app DMG=/path/to/Codex.dmg
```

## Usage

### 1. Generate the local Electron app

This creates `codex-app/` from the upstream DMG and writes the Linux launcher to `codex-app/start.sh`.

```bash
make build-app
```

Run the generated app directly from the repo:

```bash
make run-app
```

Equivalent direct command:

```bash
./codex-app/start.sh
```

### 2. Build a native package

Build the package that matches the current distro automatically:

```bash
make package
```

Or choose the format explicitly:

```bash
make deb
make rpm
make pacman
```

If you prefer an alias:

```bash
echo 'alias codex-desktop="~/codex-desktop-linux/codex-app/start.sh"' >> ~/.bashrc
```

## Native Packages

The repository can build a Debian, RPM, or pacman package from the generated `codex-app/` directory.

**Prerequisite:** Run `make build-app` (or `./install.sh`) first to produce `codex-app/`. The packaging scripts only repackage what is already there — they do not download or extract the DMG themselves.

### Debian

Requires `codex-app/` to exist (run `make build-app` first).

```bash
./scripts/build-deb.sh
```

Optional version override:

```bash
PACKAGE_VERSION=2026.03.24.120000+deadbeef ./scripts/build-deb.sh
```

Output:

```bash
dist/codex-desktop_YYYY.MM.DD.HHMMSS_amd64.deb
```

### RPM (Fedora / openSUSE)

Requires `codex-app/` to exist (run `make build-app` first).

```bash
./scripts/build-rpm.sh
```

Optional version override:

```bash
PACKAGE_VERSION=2026.03.24.120000+deadbeef ./scripts/build-rpm.sh
```

Output:

```bash
dist/codex-desktop-YYYY.MM.DD.HHMMSS-<release>.x86_64.rpm
```

### Arch Linux (pacman)

Requires `codex-app/` to exist (run `make build-app` first).

```bash
./scripts/build-pacman.sh
```

Output:

```bash
dist/codex-desktop-YYYY.MM.DD.HHMMSS-1-x86_64.pkg.tar.zst
```

Install it with:

```bash
sudo pacman -U dist/codex-desktop-*.pkg.tar.zst
```

### Install the newest package from `dist/`

```bash
make install
```

### Start or inspect the updater service

These commands make sense after the native package is installed, because the service unit and updater binary are installed by the package.

Enable and start the user service:

```bash
make service-enable
```

Inspect the service:

```bash
make service-status
codex-update-manager status --json
```

### Makefile shortcuts
Notes:

- `codex-update-manager.service` is a `systemd --user` service, not a system-wide root service.
- The packaged launcher also starts the service in best-effort mode when you open the installed app.
- `make service-enable` is not meant for an unpackaged repo-only run unless you already installed the package into the system.

## Make Targets

```bash
make help
make check
make test
make build-updater
make build-app
make run-app
make deb
make rpm
make pacman
make package
make install
make service-enable
make service-status
make clean-dist
make clean-state
```

`make package` auto-detects the native package manager available on the host and builds the matching package type (Debian, RPM, or pacman). `make install` does the same for the latest built native package.
## How It Works

The build and update flow is:

1. `install.sh` extracts `Codex.dmg` with `7z`
2. it extracts and patches `app.asar`
3. it rebuilds native Node modules for Linux
4. it downloads a Linux Electron runtime
5. it writes the Linux launcher into `codex-app/start.sh`
6. `scripts/build-deb.sh` or `scripts/build-rpm.sh` packages `codex-app/`
7. the installed package provides `codex-update-manager` plus `codex-update-manager.service`
8. the updater checks for newer upstream DMGs and rebuilds future Linux package updates locally

## Update Manager

The package installs a companion service named `codex-update-manager`.

- It runs as a `systemd --user` service.
- The launcher starts it in best-effort mode on app launch.
- If the service is not already active, the launcher also triggers a background `check-now --if-stale`; otherwise the running daemon owns startup and periodic checks.
- It checks the upstream `Codex.dmg` on daemon startup and every 6 hours.
- When a new DMG is detected, it rebuilds a local native package using `/opt/codex-desktop/update-builder`.
- Successful rebuilds retain the current workspace plus the newest previous workspace and prune older updater workspaces from `~/.cache/codex-update-manager/workspaces`.
- If the app is open, the update waits until Electron exits.
- When the app is closed, the updater uses `pkexec` only for the final native-package install step.
- On Arch, that final install step is `pacman -U --noconfirm` against the locally rebuilt `.pkg.tar.zst`, not `git pull`.
- On openSUSE, that final install step is `zypper --non-interactive --no-gpg-checks install` against the locally rebuilt `.rpm` (the package is unsigned because it is built locally).
- If a privileged install fails, is dismissed, or times out, the updater stays in `failed` instead of re-prompting every 15 seconds.
- If an `Installing` state is interrupted by a crash or restart, the updater now recovers that state automatically instead of getting stuck and skipping all future upstream checks.
- Before Electron launches, the launcher only resolves a usable Codex CLI path. If the CLI is missing and the launcher was started from an interactive terminal, it prompts before attempting an automatic install. The updater CLI preflight then runs in the background by default so npm registry checks and follow-up updates do not block the first window.
- That CLI preflight is best-effort: it uses a 1-hour cooldown for registry checks, falls back to `npm install -g --prefix ~/.local` if a global install fails, and keeps the app launch on the current CLI when the automatic refresh does not succeed. Set `CODEX_SYNC_CLI_PREFLIGHT=1` to restore the old synchronous preflight behavior for debugging.

Inspect the live service and runtime files with:

```bash
systemctl --user status codex-update-manager.service
codex-update-manager status --json
sed -n '1,160p' ~/.local/state/codex-update-manager/state.json
sed -n '1,160p' ~/.local/state/codex-update-manager/service.log
```

Runtime files live in the standard XDG locations:

```bash
~/.config/codex-update-manager/config.toml
~/.local/state/codex-update-manager/state.json
~/.local/state/codex-update-manager/service.log
~/.cache/codex-update-manager/
```

The Electron launcher also writes:

```bash
~/.cache/codex-desktop/launcher.log
~/.local/state/codex-desktop/app.pid
```

That PID file lets the updater know whether Electron is still running before it installs a pending package.

## Technical Notes

The macOS Codex app is an Electron application. The core code (`app.asar`) is platform-independent JavaScript, but it bundles macOS-native modules and a macOS Electron binary.

The installer replaces the macOS Electron with a Linux build and recompiles the native modules using `@electron/rebuild`. The `sparkle` module is removed because it is macOS-only.

The extracted app expects a local webview origin on `127.0.0.1:5175`, so the launcher starts `python3 -m http.server 5175 --bind 127.0.0.1` from `content/webview/`, waits for the socket to become reachable, and only then launches Electron. The launcher tracks the owned webview server PID under XDG state, rediscovers an orphaned server from the same `content/webview/` directory, and reuses an already verified server instead of killing every process that matches the port.
The launcher also verifies that `http://127.0.0.1:5175/index.html` contains the expected Codex startup markers before cold-starting Electron, so a port collision or incomplete extracted webview fails fast in `launcher.log` instead of hanging on the splash screen. If an existing Electron process is detected, the launcher uses a warm-start handoff path and lets the app's single-instance handler focus the running window.

Native-package-only launcher behavior such as desktop-entry hints, `codex-update-manager` session bootstrapping, and the background launch-time update check lives in `packaging/linux/codex-packaged-runtime.sh`, which the generated launcher loads only when present inside a packaged install.

The current evaluation for a future Rust replacement for the local webview server lives in `docs/webview-server-evaluation.md`.

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `Error: write EPIPE` | Run `start.sh` directly instead of piping output |
| Blank window | Check whether port 5175 is already in use: `ss -tlnp \| grep 5175` |
| `ERR_CONNECTION_REFUSED` on `:5175` | The webview HTTP server failed to start. Ensure `python3` works and port 5175 is free |
| Stuck on the Codex logo splash | Check `~/.cache/codex-desktop/launcher.log`. If webview origin validation failed, another process is probably serving port `5175` or the extracted `content/webview/` bundle is incomplete |
| `CODEX_CLI_PATH` error | Install the CLI with `npm i -g @openai/codex` or `npm i -g --prefix ~/.local @openai/codex` |
| Electron hangs while the CLI is outdated | Re-run the launcher and check `~/.cache/codex-desktop/launcher.log` plus `~/.local/state/codex-update-manager/service.log`; the launcher now runs a best-effort CLI preflight and warns if the automatic refresh fails |
| GPU/Vulkan/Wayland errors | The launcher sets `--ozone-platform-hint=auto`, `--disable-gpu-sandbox`, `--disable-gpu-compositing`, and `--enable-features=WaylandWindowDecorations` by default. If you need X11 explicitly, try `./codex-app/start.sh --ozone-platform=x11` |
| Window flickering | GPU compositing is now disabled by default (`--disable-gpu-compositing`). If flickering persists, try `./codex-app/start.sh --disable-gpu` to fully disable GPU acceleration |
| Sandbox errors | The launcher already sets `--no-sandbox` |
| Stale install / cached DMG | Run `./install.sh --fresh` to remove the existing install dir and re-download the DMG |
| Usage help | Run `./install.sh --help` or `./codex-app/start.sh --help` |
| `codex-update-manager` keeps running after package removal | Run `systemctl --user disable --now codex-update-manager.service` once in the affected session, then confirm `/opt/codex-desktop` is gone |

## Validation

After changing installer, packaging, or updater logic, validate at least:

```bash
bash -n install.sh scripts/build-deb.sh scripts/build-rpm.sh scripts/build-pacman.sh scripts/install-deps.sh
cargo check -p codex-update-manager
cargo test -p codex-update-manager
make package
```

If you are validating a Debian package specifically, also run:

```bash
dpkg-deb -I dist/codex-desktop_*.deb
dpkg-deb -c dist/codex-desktop_*.deb | sed -n '1,40p'
```

If `rpmbuild` is available, also run:

```bash
make rpm
```

If `makepkg` is available (Arch Linux), also run:

```bash
./scripts/build-pacman.sh
pacman -Qip dist/codex-desktop-*.pkg.tar.zst
pacman -Qlp dist/codex-desktop-*.pkg.tar.zst | sed -n '1,40p'
```

If launcher behavior changed, inspect:

```bash
sed -n '1,140p' codex-app/start.sh
```

## Disclaimer

This is an unofficial community project. Codex Desktop is a product of OpenAI. This tool does not redistribute any OpenAI software; it automates the conversion process that users perform on their own copies.

## License

MIT
