# Codex Desktop for Linux

Run [OpenAI Codex Desktop](https://openai.com/codex/) on Linux.

The official Codex Desktop app is macOS-only. This project provides an automated installer that converts the macOS `.dmg` into a working Linux application.

## How it works

The installer:

1. Extracts the macOS `.dmg` (using `7z`)
2. Extracts `app.asar` (the Electron app bundle)
3. Rebuilds native Node.js modules (`node-pty`, `better-sqlite3`) for Linux
4. Removes macOS-only modules (`sparkle` auto-updater)
5. Downloads Linux Electron (same version as the app — v40)
6. Repacks everything and creates launch/update scripts
7. Enables a daily `systemd --user` timer for automatic update checks

## Prerequisites

**Node.js 20+**, **npm**, **Python 3**, **7z**, **curl**, **pgrep/procps**, and **build tools** (gcc/g++/make).

### Debian/Ubuntu

```bash
sudo apt install nodejs npm python3 p7zip-full curl procps build-essential
```

### Fedora

```bash
sudo dnf install nodejs npm python3 p7zip curl procps-ng
sudo dnf groupinstall 'Development Tools'
```

### Arch

```bash
sudo pacman -S nodejs npm python p7zip curl procps-ng base-devel
```

You also need the **Codex CLI**:

```bash
npm i -g @openai/codex
```

## Installation

### Option A: Auto-download DMG

```bash
git clone https://github.com/ilysenko/codex-desktop-linux.git
cd codex-desktop-linux
chmod +x install.sh
./install.sh
```

### Option B: Provide your own DMG

Download `Codex.dmg` from [openai.com/codex](https://openai.com/codex/), then:

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

## Auto-update behavior

- `start.sh` checks for a newer upstream `Codex.dmg` before launch and installs it automatically when safe.
- A `systemd --user` timer (`codex-desktop-updater.timer`) checks once per day in the background.
- If Codex is already running when the timer finds an update, the install is deferred and applied automatically on the next launch.
- Auto-updates target the upstream OpenAI Codex Desktop app only, not this wrapper repo.

### Disable auto-updates

For a one-off launch or install session:

```bash
CODEX_AUTO_UPDATE=0 ./install.sh
CODEX_AUTO_UPDATE=0 ./codex-app/start.sh
```

### Custom install directory

```bash
CODEX_INSTALL_DIR=/opt/codex ./install.sh
```

Automatic updates require the install directory to be writable by your user. A root-owned location like `/opt/codex` may work for the initial install but will block unattended updates.

## How it works (technical details)

The macOS Codex app is an Electron application. The core code (`app.asar`) is platform-independent JavaScript, but it bundles:

- **Native modules** compiled for macOS (`node-pty` for terminal emulation, `better-sqlite3` for local storage, `sparkle` for auto-updates)
- **Electron binary** for macOS

The installer replaces the macOS Electron with a Linux build and recompiles the native modules using `@electron/rebuild`. The `sparkle` module (macOS-only auto-updater) is removed since it has no Linux equivalent, and this project installs its own Linux-side updater using shell scripts plus `systemd --user`.

A small Python HTTP server is used as a workaround: when `app.isPackaged` is `false` (which happens with extracted builds), the app tries to connect to a Vite dev server on `localhost:5175`. The HTTP server serves the static webview files on that port.

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `Error: write EPIPE` | Make sure you're not piping the output — run `start.sh` directly |
| Blank window | Check that port 5175 is not in use: `lsof -i :5175` |
| `CODEX_CLI_PATH` error | Install CLI: `npm i -g @openai/codex` |
| GPU/rendering issues | Try: `./codex-app/start.sh --disable-gpu` |
| Sandbox errors | The `--no-sandbox` flag is already set in `start.sh` |
| Timer not enabled | Run `systemctl --user daemon-reload && systemctl --user enable --now codex-desktop-updater.timer` |

## Disclaimer

This is an unofficial community project. Codex Desktop is a product of OpenAI. This tool does not redistribute any OpenAI software — it automates the conversion process that users perform on their own copies.

## License

MIT
