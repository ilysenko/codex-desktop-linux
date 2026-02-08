# Codex Desktop for Linux

Run [OpenAI Codex Desktop](https://openai.com/codex/) on Linux.

> **Fork of [ilysenko/codex-desktop-linux](https://github.com/ilysenko/codex-desktop-linux)** — the original project by [@ilysenko](https://github.com/ilysenko) that pioneered running Codex Desktop on Linux. This fork adds an automatic update mechanism and several installer improvements.

The official Codex Desktop app is macOS-only. This project provides an automated installer that converts the macOS `.dmg` into a working Linux application.

## What's new in this fork

### Linux Auto-Updater

The original installer removes the macOS-only Sparkle update framework, leaving the app with no way to check for or install updates on Linux. This fork adds a self-contained update mechanism (`linux-updater.js`) that:

- **Checks the official appcast feed** (`appcast.xml`) for new builds, comparing `<sparkle:version>` against the local `codexBuildNumber`
- **Patches the "Check for Updates" menu** so it actually works instead of showing "Updates Unavailable"
- **Runs background checks every 15 minutes**, matching the Sparkle interval on macOS
- **Notifies the renderer** via the same IPC messages the app already handles (`app-update-ready-changed`)
- **Handles the "Install Update" button** from the UI — intercepts the `install-app-update` message that was previously silently ignored on Linux
- **Install flow**: prompts the user, deletes the cached DMG (so it re-downloads), runs `install.sh --force` detached, then relaunches the app

The updater is injected into `app.asar` during installation and loaded before the app bundle via a `require()` prepended to the Vite entry point. It only activates on Linux (`process.platform === "linux"` guard).

### Installer improvements

- **Automatic updater injection** during `patch_asar()` — copies `linux-updater.js` into the build and patches `main.js`
- **Exports `CODEX_LINUX_INSTALLER_PATH`** in the generated `start.sh` so the updater can locate `install.sh` at runtime
- **Idempotent** — re-running `install.sh` re-injects the updater each time, so updates survive reinstalls

## How it works

The installer:

1. Extracts the macOS `.dmg` (using `7z`)
2. Extracts `app.asar` (the Electron app bundle)
3. Rebuilds native Node.js modules (`node-pty`, `better-sqlite3`) for Linux
4. Removes macOS-only modules (`sparkle` auto-updater)
5. **Injects the Linux update mechanism** (`linux-updater.js`)
6. Downloads Linux Electron (same version as the app — v40)
7. Repacks everything and creates a launch script

## Prerequisites

**Node.js 20+**, **npm**, **Python 3**, **7z**, **curl**, and **build tools** (gcc/g++/make).

### Debian/Ubuntu

```bash
sudo apt install nodejs npm python3 p7zip-full curl build-essential
```

### Fedora

```bash
sudo dnf install nodejs npm python3 p7zip curl
sudo dnf groupinstall 'Development Tools'
```

### Arch

```bash
sudo pacman -S nodejs npm python p7zip curl base-devel
```

You also need the **Codex CLI**:

```bash
npm i -g @openai/codex
```

## Installation

```bash
git clone https://github.com/green2grey/codex-desktop-linux.git
cd codex-desktop-linux
chmod +x install.sh
./install.sh
```

Or provide your own DMG:

```bash
./install.sh /path/to/Codex.dmg
```

## Usage

The app is installed into `codex-app/` next to the install script:

```bash
codex-desktop-linux/codex-app/start.sh
```

Or add an alias to your shell:

```bash
echo 'alias codex-desktop="~/codex-desktop-linux/codex-app/start.sh"' >> ~/.bashrc
```

### Custom install directory

```bash
CODEX_INSTALL_DIR=/opt/codex ./install.sh
```

### Updating

The app checks for updates automatically in the background. You can also check manually via the app menu: **Check for Updates...**

When an update is available, the app will prompt you to install it. This runs `install.sh --force` automatically, re-downloads the DMG, and relaunches the app.

To update manually:

```bash
cd codex-desktop-linux
rm Codex.dmg          # force re-download
./install.sh --force
```

## How it works (technical details)

The macOS Codex app is an Electron application. The core code (`app.asar`) is platform-independent JavaScript, but it bundles:

- **Native modules** compiled for macOS (`node-pty` for terminal emulation, `better-sqlite3` for local storage, `sparkle` for auto-updates)
- **Electron binary** for macOS

The installer replaces the macOS Electron with a Linux build and recompiles the native modules using `@electron/rebuild`. The `sparkle` module (macOS-only auto-updater) is removed and replaced with `linux-updater.js`.

A small Python HTTP server is used as a workaround: when `app.isPackaged` is `false` (which happens with extracted builds), the app tries to connect to a Vite dev server on `localhost:5175`. The HTTP server serves the static webview files on that port.

### Update mechanism details

`linux-updater.js` is a CommonJS module injected into `.vite/build/` inside `app.asar`. It's loaded via `require("./linux-updater.js")` prepended to `main.js` (the Vite entry point). It runs in the Electron main process and:

- Monkey-patches `ipcMain.handle` to intercept `install-app-update` messages
- Monkey-patches `Menu.setApplicationMenu` to fix the "Check for Updates" menu item
- Registers the `codex_desktop:check-for-updates` IPC handler (never registered on Linux in the original app)
- Uses the same IPC channels and message types the renderer already understands

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `Error: write EPIPE` | Make sure you're not piping the output — run `start.sh` directly |
| Blank window | Check that port 5175 is not in use: `lsof -i :5175` |
| `CODEX_CLI_PATH` error | Install CLI: `npm i -g @openai/codex` |
| GPU/rendering issues | Try: `./codex-app/start.sh --disable-gpu` |
| Sandbox errors | The `--no-sandbox` flag is already set in `start.sh` |
| "Updates Unavailable" in menu | Re-run `./install.sh --force` to re-inject the updater |

## Attribution

This is a fork of [ilysenko/codex-desktop-linux](https://github.com/ilysenko/codex-desktop-linux). All credit for the original installer goes to [@ilysenko](https://github.com/ilysenko).

## Disclaimer

This is an unofficial community project. Codex Desktop is a product of OpenAI. This tool does not redistribute any OpenAI software — it automates the conversion process that users perform on their own copies.

## License

MIT
