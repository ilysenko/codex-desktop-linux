# Codex Desktop for Linux

Unofficial Linux build of [OpenAI Codex Desktop](https://openai.com/codex/). The official Codex Desktop app is macOS-only — this project converts the upstream macOS `Codex.dmg` into a runnable Linux Electron app, ships native `.deb` / `.rpm` / `.pkg.tar.zst` packages plus local AppImage self-builds and a Nix flake, and includes a local auto-updater that rebuilds future native Linux packages from newer upstream DMGs.

Before opening a pull request, please read [CONTRIBUTING.md](CONTRIBUTING.md).

## Linux features

Optional Linux-only additions live in `linux-features/`. Use them for integrations that are useful for some users but should not become mandatory core patches. Copy `linux-features/features.example.json` to the git-ignored `linux-features/features.json` before building; enabled features are applied during the install/build pipeline. See [`linux-features/README.md`](linux-features/README.md) for the feature contract.

## Supported platforms

| Distro / family | Package manager | Format produced | Notes |
|---|---|---|---|
| Debian, Ubuntu, Pop!_OS, Mint, Elementary | `apt` | `.deb` | Managed Node.js runtime is bundled; no distro Node.js package is required |
| Fedora 41+ | `dnf5` | `.rpm` | |
| Fedora < 41 | `dnf` | `.rpm` | |
| openSUSE Tumbleweed / Leap | `zypper` | `.rpm` | Uses `zypper --no-gpg-checks install` for the local rebuild |
| Arch, Manjaro, EndeavourOS | `pacman` | `.pkg.tar.zst` | |
| Atomic desktops / other Linux distros | none | `.AppImage` | Local self-build only; no bundled auto-updater |
| NixOS / Nix | flake | runnable directly | `nix run github:ilysenko/codex-desktop-linux` |

Anything systemd-based should work for the optional user services (`systemd --user`). The launcher targets Wayland with `XWayland` first (better Electron popup positioning); pure Wayland sessions fall through to `--ozone-platform-hint=auto`. X11 is fully supported. If XWayland or software rendering is unstable on a Wayland desktop, `CODEX_LINUX_RENDERING_MODE=wayland-gpu` forces native Wayland while keeping GPU compositing enabled.

## What you get

| Feature | Status | Notes |
|---|---|---|
| Standard Codex Desktop UI | ✅ always | Chats, browser, files, MCP plugins |
| Auto-updater (`codex-update-manager`) | ✅ native packages | Detects newer upstream DMGs, rebuilds + installs native packages locally |
| Installed setup doctor | ✅ native packages | `codex-desktop-doctor` checks package files, services, update-builder health, browser native messaging, and Computer Use readiness without reading private session contents |
| Optional app user service | ✅ native packages | `make app-service-enable` runs Codex Desktop through `systemd --user` for persistent desktop-session launches |
| Native packaging (`.deb` / `.rpm` / `.pkg.tar.zst`) | ✅ always | One-shot `make package` picks your distro |
| AppImage self-build | ✅ manual | `make appimage` writes a local `dist/*.AppImage`; rebuild manually after upstream updates |
| Linux tray + warm-start handoff | ✅ always | Single-instance lock, second-instance window focus |
| Multi-instance launcher | 🧪 opt-in | `--new-instance` or `CODEX_MULTI_LAUNCH=1` allocates a bounded webview port and isolated Electron profile |
| GUI install prompts (`kdialog` / `zenity`) | ✅ if installed | Falls back to interactive terminal prompt |
| Linux browser annotations | ✅ always | Stored-anchor screenshots, isolated marker rendering |
| Chrome plugin native host | ✅ always | Auto-installs the upstream Chrome plugin plus Linux native-messaging support for Chrome, Brave, and Chromium |
| Linux Computer Use | ⚠️ opt-in | MCP backend registers by default; the in-app UI is opt-in. Supports screenshots, accessibility, window targeting, and input synthesis |
| Linux Read Aloud | 🧪 opt-in experiment | `linux-features/read-aloud` adds an explicit response speaker button; `linux-features/read-aloud-mcp` stages a separate MCP plugin so the agent can read text aloud on request |
| Mobile remote control host | 🧪 opt-in experiment | SSH remote projects work normally. Phone/Android host access is upstream macOS-only by default; `linux-features/remote-mobile-control` adds experimental Linux device-key, visibility, and host-enablement patches |
| Server-gated features (e.g. `gpt-5.5`) | 🟡 server-side | OpenAI rolls per-account, not project-controlled. Building a fresh package does not unlock these. |

## Before you install

The generated app and native packages bundle a managed Linux Node.js runtime. You do **not** need a distro `nodejs` / `npm` package for normal installs, Browser Use, Codex CLI install/update, or local auto-update rebuilds.

The Codex CLI is still required at runtime. The first launch can install or update `@openai/codex` with the bundled `npm`, or you can manage the CLI yourself.

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
make bootstrap-native
```

`make bootstrap-native` installs build dependencies, regenerates `codex-app/` from a fresh upstream `Codex.dmg`, builds the matching native package, and installs the newest artifact from `dist/`. It uses the same package auto-detection as `make package` / `make install`.

If dependencies are already installed, use `make install-native` to run only the fresh app build, package, and install steps.

## Guided native setup

If you want a friendlier first-run checklist before building, use the optional guided setup helper:

```bash
git clone https://github.com/ilysenko/codex-desktop-linux.git
cd codex-desktop-linux
make setup-native
```

`make setup-native` is intentionally separate from `make bootstrap-native`, `make install-native`, `make package`, and `make install`, which remain non-interactive for scripts and CI. The guided helper detects your distro, package manager, native package format, desktop session, GUI prompt helpers, `pkexec`, portal status, and Computer Use readiness signals such as `ydotool`, `ydotoold` / `ydotool.service`, the ydotool socket, `/dev/uinput`, input-group membership, desktop window backend hints, and portal package hints. It also reports Read Aloud Kokoro paths, plugin cache paths, settings paths, and doctor commands when available.

It also discovers optional Linux features from `linux-features/*/feature.json` and can write the git-ignored `linux-features/features.json` file for the next build. Re-running it shows the currently enabled features and installed package/updater hints, then skips changes unless you ask for them. Non-interactive setup edits feature config and prints or runs explicitly requested next steps; it does not implicitly run build/package/install.

For repeatable setup docs or automation, pass feature choices through the environment:

```bash
CODEX_LINUX_FEATURES=remote-mobile-control,read-aloud \
CODEX_LINUX_DISABLE_FEATURES=conversation-mode \
PACKAGE_WITH_UPDATER=0 \
CODEX_BOOTSTRAP_NONINTERACTIVE=1 \
make setup-native
```

To have the wizard orchestrate the existing native install commands, opt in explicitly:

```bash
# Preview without changing the system:
CODEX_BOOTSTRAP_DRY_RUN=1 \
CODEX_BOOTSTRAP_INSTALL_DEPS=1 \
CODEX_BOOTSTRAP_INSTALL_NATIVE=1 \
make setup-native

# Run dependency bootstrap and then build/package/install:
CODEX_BOOTSTRAP_INSTALL_DEPS=1 \
CODEX_BOOTSTRAP_INSTALL_NATIVE=1 \
make setup-native

# Build a manual-update native package instead:
PACKAGE_WITH_UPDATER=0 \
CODEX_BOOTSTRAP_INSTALL_NATIVE=1 \
make setup-native
```

Build-time feature changes only apply after rebuilding and reinstalling:

```bash
make install-native

# or, for manual-update native packages:
PACKAGE_WITH_UPDATER=0 make install-native
```

The wizard is conservative with opt-outs. Removing a feature id from `features.json` does not delete local device keys, Read Aloud model files, Python runtimes, plugin caches, or system services. Cleanup is a separate interactive path through `CODEX_BOOTSTRAP_CLEANUP_FEATURES=remote-mobile-control,read-aloud make setup-native`; each deletion requires typing `DELETE <exact path>`, and `CODEX_BOOTSTRAP_DRY_RUN=1` prints the cleanup targets without deleting them. It prints the relevant paths and tells you when a rebuild/reinstall, `sudo` / `pkexec`, logout/login, input-group membership, ydotoold service work, or portal package install needs explicit user action.

### AppImage local self-build

For atomic desktops or systems where installing a native package is awkward, build an AppImage locally from the generated app:

```bash
make build-app
make appimage
./dist/codex-desktop-*.AppImage
```

The AppImage flow does not include `codex-update-manager`, systemd user services, the installed doctor, polkit policy, or the native-package update builder. When upstream Codex Desktop changes, update your checkout and rebuild locally:

```bash
git pull --ff-only
make build-app-fresh
make appimage
```

### NixOS / Nix one-liner

```bash
nix run github:ilysenko/codex-desktop-linux
```

The flake handles dependencies and patches Electron for NixOS. A GitHub Actions bot refreshes the upstream `Codex.dmg` hash and verifies the Nix package outputs in `main`; if you hit a hash mismatch right after an upstream release, wait for the next bot run and retry.

Because flakes do not include the git-ignored `linux-features/features.json` opt-in file, Nix exposes feature-specific app variants for optional integrations. To build and run Codex Desktop with the experimental mobile remote-control feature enabled:

```bash
nix run github:ilysenko/codex-desktop-linux#remote-mobile-control
```

Feature-specific Nix outputs are additive. To enable both the Computer Use UI and experimental mobile remote control:

```bash
nix run github:ilysenko/codex-desktop-linux#computer-use-ui-remote-mobile-control
```

For a declarative NixOS/Home Manager install with the mobile remote-control
app-server managed by systemd instead of the Desktop launcher, import the flake
module:

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

This installs the selected Codex Desktop package variant and starts a user
`codex-remote-control.service` with
`codex app-server --remote-control --listen unix://`. A
`nixosModules.default` export is also available for system-level configurations
that prefer a global user unit.

`nix develop github:ilysenko/codex-desktop-linux` enters a dev shell with the required tooling.

### Cachix binary cache

CI can populate a Cachix cache named `codex-desktop-linux` for the flake package outputs. To enable pushes, create that cache in Cachix and add a repository secret named `CACHIX_AUTH_TOKEN` with write access to the cache.

After the cache exists, users can opt in locally with:

```bash
cachix use codex-desktop-linux
```

The scheduled `Populate Cachix` workflow builds the default Codex Desktop package, the feature-specific Nix package variants, and `.#installer`. The upstream-hash refresh workflow also uploads its verification build when the token is present.

## Linux Computer Use

Linux Computer Use is an **opt-in** plugin that lets Codex inspect and control desktop apps on Linux through a native Rust MCP backend (`codex-computer-use-linux`). It is designed and maintained by [@avifenesh](https://github.com/avifenesh) and supports:

- app listing and accessibility trees via AT-SPI
- screenshots through GNOME Shell DBus or XDG Desktop Portal
- window listing and focusing on GNOME, KWin/Plasma, Hyprland, and i3
- keyboard, text, click, scroll, and drag input through a uinput absolute pointer, the XDG Desktop Portal RemoteDesktop session, or `ydotool`

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

The preferred coordinate input path opens `/dev/uinput` directly. The XDG RemoteDesktop portal can also provide input on desktops that expose it. `ydotool` remains the fallback path; when you need it, run `ydotoold`, add your user to the `input` group, then re-login:

```bash
sudo systemctl enable --now ydotoold
sudo usermod -a -G input "$USER"
```

On Fedora 44, the packaged unit is commonly named `ydotool.service` rather than `ydotoold.service`. Some distros install `/usr/bin/ydotoold` without any service unit. If `systemctl enable --now ydotoold` fails, start the distro-provided unit instead or create a user-session service that binds `%t/.ydotool_socket`. If `doctor` reports `ydotool_socket: Permission denied`, make sure the socket is usable by users in the `input` group.

If you are on Fedora + KDE Plasma and the system unit path is awkward, a user-session `ydotoold` service is also a valid setup. In that case, make sure:

- the socket is reachable at `%t/.ydotool_socket`
- the service runs inside your user session
- old system-level overrides are removed if they force the wrong socket path
- `codex-computer-use-linux doctor` reports `can_send_development_input: true`

A working XDG Desktop Portal implementation is needed if you are not on GNOME — `xdg-desktop-portal-kde` for KDE Plasma, `xdg-desktop-portal-wlr` for sway, `xdg-desktop-portal-hyprland` for Hyprland, or your distro's preferred portal backend for i3. GNOME ships a working portal by default.

### Verifying readiness

Once Computer Use is visible in the Codex UI, ask the LLM:

> Check whether Linux Computer Use is ready

You can also invoke the backend binary directly:

```bash
./codex-app/resources/plugins/openai-bundled/plugins/computer-use/bin/codex-computer-use-linux doctor
./codex-app/resources/plugins/openai-bundled/plugins/computer-use/bin/codex-computer-use-linux setup    # enables GNOME accessibility
./codex-app/resources/plugins/openai-bundled/plugins/computer-use/bin/codex-computer-use-linux apps     # lists running apps via AT-SPI
./codex-app/resources/plugins/openai-bundled/plugins/computer-use/bin/codex-computer-use-linux windows  # lists targetable windows
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

Either path enables the in-app controls on subsequent builds. To opt back out, unset the env var and remove or set the settings flag to `false`.

Nix users can also run the opt-in flake output directly:

```bash
nix run github:ilysenko/codex-desktop-linux#codex-desktop-computer-use-ui
```

The Computer Use UI output can also be combined with Linux feature outputs, for example:

```bash
nix run github:ilysenko/codex-desktop-linux#computer-use-ui-remote-mobile-control
```

### Side-by-side dev variant

If you'd like to test the backend without affecting your default install, the side-by-side dev variant builds a separate app under a different ID and webview port:

```bash
make build-dev-app
make run-dev-app
```

Override the dev identity with `DEV_APP_ID`, `DEV_APP_NAME`, and `CODEX_WEBVIEW_PORT` if needed.

### Multiple app instances

By default, second launches reuse the running app through the Linux warm-start handoff. To intentionally open another independent Codex Desktop process, use:

```bash
./codex-app/start.sh --new-instance
```

The launcher picks the first free webview port from a bounded range, then uses per-port pid files, launch socket, log, and Electron user-data dir. This keeps Electron's single-instance lock scoped to that new instance while leaving normal launches unchanged. The default range allows up to five instances.

Configure the range or make every launch use this mode with:

```bash
CODEX_MULTI_LAUNCH_PORT_RANGE=5175-5199 ./codex-app/start.sh --new-instance
CODEX_MULTI_LAUNCH=1 CODEX_MULTI_LAUNCH_PORT_RANGE=5175-5199 ./codex-app/start.sh
```

## Auto-update Manager

By default, the native package installs a companion `systemd --user` service named `codex-update-manager`.

- It checks upstream `Codex.dmg` on daemon startup, every 6 hours, and in the background on app launch when stale.
- When a new DMG is available, it rebuilds a local native package with `/opt/codex-desktop/update-builder`.
- If Codex Desktop is open, the final install waits until Electron exits.
- The updater runs unprivileged and uses `pkexec` only for the final package install.
- Codex CLI checks are best-effort and launcher-scoped. Set `CODEX_SYNC_CLI_PREFLIGHT=1` when debugging launch-time CLI preflight.

Inspect the live service and runtime files with:

```bash
systemctl --user status codex-update-manager.service
codex-update-manager status --json
sed -n '1,160p' ~/.local/state/codex-update-manager/state.json
sed -n '1,160p' ~/.local/state/codex-update-manager/service.log
```

If a rebuilt update installs but the previous retained package was better, close Codex Desktop and run:

```bash
codex-update-manager rollback
```

Rollback uses the last retained known-good package and refuses to run when no rollback package is available.

Runtime files live in standard XDG locations:

```text
~/.config/codex-update-manager/config.toml
~/.local/state/codex-update-manager/state.json
~/.local/state/codex-update-manager/service.log
~/.cache/codex-update-manager/
~/.cache/codex-desktop/launcher.log
~/.local/state/codex-desktop/app.pid
```

### Manual-update packages

For installs that must not include a resident updater, build the native package with:

```bash
PACKAGE_WITH_UPDATER=0 make package
make install
```

That package omits `codex-update-manager`, the user service unit, updater polkit policy, `/opt/codex-desktop/update-builder`, desktop updater actions, and launcher updater startup checks. The packaged launcher still exports desktop-entry hints for window/icon association, but it does not enable, start, or probe the updater. Installing a no-updater package over a default package also stops and disables any existing `codex-update-manager.service` for active user managers and removes stale per-user enablement links for inactive users.

Manual updates should come from a checkout you have chosen to trust:

```bash
PACKAGE_WITH_UPDATER=0 make update-native
```

`make update-native` runs `git pull --ff-only`, regenerates `codex-app/` from a fresh upstream `Codex.dmg`, builds the native package, and installs it. Keep `PACKAGE_WITH_UPDATER=0` when you want the installed package to stay in manual-update mode.

## Build from source / custom DMG

### Prerequisites

You need:

- `python3`, `7z` (or `7zz`), `curl`, `unzip`, `make`, `g++`
- **Rust toolchain** (`cargo`) for the `codex-update-manager` and `codex-computer-use-linux` crates, including the Chrome extension host binary

The installer downloads a managed Linux Node.js runtime into `codex-app/resources/node-runtime` and uses it for `node`, `npm`, and `npx` during the build. Existing `nvm`, asdf, Volta, NodeSource, or nodejs.org tarball installs are still fine, but they are no longer required for this project.

The easiest setup is the bundled bootstrap:

```bash
bash scripts/install-deps.sh
```

It auto-detects `apt`, `dnf5`, `dnf`, `pacman`, or `zypper`, installs system packages, and bootstraps Rust through `rustup` when needed.

#### Apt-specific (Debian / Ubuntu / Pop!_OS / Mint)

On apt-based systems, `install-deps.sh` can still bootstrap NodeSource Node.js for users who want a system Node.js toolchain:

```bash
bash scripts/install-deps.sh                       # full host bootstrap
NODEJS_MAJOR=24 bash scripts/install-deps.sh       # choose a different optional system Node line
```

Ubuntu-family `p7zip-full` can be too old for newer APFS DMGs, so `install-deps.sh` bootstraps `7zz` into `~/.local/bin` by default.

#### Manual deps per distro

```bash
# Fedora 41+
sudo dnf install python3 7zip curl unzip rpm-build @development-tools

# Fedora < 41
sudo dnf install python3 p7zip p7zip-plugins curl unzip rpm-build
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
make build-app                              # download upstream DMG if no cached Codex.dmg exists
make build-app-fresh                        # remove codex-app/ + cached Codex.dmg, then download current upstream DMG
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

### Electron download mirrors

The app build commands download Electron headers while rebuilding native modules, then download a Linux Electron runtime. If the runtime download from GitHub is slow or blocked, use a mirror:

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ \
make build-app
```

`ELECTRON_HEADERS_URL` is passed to `@electron/rebuild --dist-url` and must provide both `node-v<version>-headers.tar.gz` and the matching `SHASUMS256.txt`.

## Package formats

After `make build-app` or `make build-app-fresh`, build a native package from `codex-app/` with the format you need:

| Format | Build command | Output | Install |
|---|---|---|---|
| Debian | `make deb` or `./scripts/build-deb.sh` | `dist/codex-desktop_*.deb` | `sudo dpkg -i dist/codex-desktop_*.deb` |
| RPM (Fedora / openSUSE) | `make rpm` or `./scripts/build-rpm.sh` | `dist/codex-desktop-*.x86_64.rpm` | `sudo dnf install dist/codex-desktop-*.rpm` (Fedora) or `sudo zypper install dist/codex-desktop-*.rpm` (openSUSE) |
| Arch (pacman) | `make pacman` or `./scripts/build-pacman.sh` | `dist/codex-desktop-*.pkg.tar.zst` | `sudo pacman -U dist/codex-desktop-*.pkg.tar.zst` |
| AppImage | `make appimage` or `./scripts/build-appimage.sh` | `dist/codex-desktop-*.AppImage` | Run directly; no system install |
| Auto-detect | `make package && make install` | matches your distro | handled by `make install` |

Override the package version with `PACKAGE_VERSION=YYYY.MM.DD.HHMMSS+commitish ./scripts/build-*.sh`. AppImage builds require `appimagetool` on `PATH`, or `APPIMAGETOOL=/path/to/appimagetool`.

The packaging scripts only repackage what's already in `codex-app/`. They do not download or extract the DMG themselves.

Native packages bundle the managed Node.js runtime and do not hard-depend on distro `nodejs` / `npm`. Packages built with the default updater pull in `polkit` (or `policykit-1` on older Debian/Ubuntu) plus `pkexec` for privileged update installs; `PACKAGE_WITH_UPDATER=0` packages do not install those updater-specific artifacts.

### Installed doctor and app service

Native packages install a safe healthcheck at `/usr/bin/codex-desktop-doctor`:

```bash
codex-desktop-doctor
codex-desktop-doctor --json
make doctor
```

The doctor checks installed package files, the optional app service, updater/update-builder files, required ASAR patch markers, Chrome/Brave/Chromium native-messaging manifests, Flatpak Chrome permissions, Computer Use readiness, and remote-mobile feature markers. It reports only sanitized status fields and file paths; it does not print pairing secrets, browser tab contents, cookies, QR data, screenshots, or Computer Use window/application state.

For a deeper local runtime smoke test after login, run:

```bash
make parity-smoke
```

`make parity-smoke` starts `codex app-server --remote-control`, probes read-only app-server APIs for threads, plugins, apps, MCP status, skills, models, config, external-agent detection, a sandboxed command, and remote-control status through both an explicit status read and a status notification, then prints only sanitized counts and booleans. Transient app directory HTTP errors are summarized without response bodies. It does not print thread names, account fields, browser state, QR data, screenshots, cookies, tokens, or remote-control identifiers. To include optional real Electron UI presence checks, launch a separate debug-port instance yourself and pass its local CDP origin:

```bash
CODEX_DESKTOP_CDP_ORIGIN=http://127.0.0.1:9334 make parity-smoke
```

The CDP path only checks for generic UI controls and intentionally does not click or save the mobile pairing flow.

For a broader local parity pass, run:

```bash
make parity-schema
make parity-full
```

`make parity-schema` generates the current `codex app-server` JSON Schema into
a temporary directory and verifies the protocol methods and notifications used
by the Linux parity probes are still present. `make parity-full` composes the
installed doctor, `systemd --user` service state, app-server schema guard,
Computer Use doctor, and the non-sensitive app-server smoke. The smoke also
uses temporary repo fixtures for skill discovery, project config layering, and
external-agent detection. It summarizes only counts, booleans, and local
readiness states.

If the host is enrolled for experimental mobile remote control and you want the
full run to require connected remote-control state:

```bash
CODEX_PARITY_REQUIRE_REMOTE_CONNECTED=1 make parity-full
```

For a stricter installed-app profile, launch the app with a local CDP debug
origin and run:

```bash
CODEX_DESKTOP_CDP_ORIGIN=http://127.0.0.1:9334 make parity-strict
```

Strict mode fails instead of accepting skipped components. It also requires
connected remote-control status automatically when the installed
`remote-mobile-control` feature marker is present.

The current parity matrix and remaining Mac/Linux gaps are tracked in
[`docs/PARITY_MATRIX.md`](docs/PARITY_MATRIX.md).

Native packages also install an opt-in app unit at `/usr/lib/systemd/user/codex-desktop.service`:

```bash
make app-service-enable     # enable + start Codex Desktop for this user session
make app-service-status     # systemctl --user status codex-desktop.service
make app-service-disable    # stop + disable the app service
```

The app unit launches `/usr/bin/codex-desktop` and waits on the launcher PID file so the unit stays active even if Electron is moved into a desktop app scope. It intentionally does not add a CDP debug port; use a systemd drop-in if you need local debugging flags.

If `make app-service-enable` reports that the unit is enabled but not active, an already-running manually launched Codex Desktop process probably received the warm-start handoff. Close that process and run `systemctl --user start codex-desktop.service`.

### Updater service controls

After installing a default native package with the updater enabled:

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
make build-app-fresh
make bootstrap-native
make install-native
make update-native
make run-app
make build-dev-app
make run-dev-app
make deb
make rpm
make pacman
make appimage
make package           # auto-detect distro
make install           # install latest dist/ artifact
make service-enable
make service-status
make app-service-enable
make app-service-status
make app-service-disable
make doctor
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
| `gh auth status` works in a terminal but fails inside Codex Desktop | The app shell may be using isolated XDG paths or missing keyring DBus access. See [GitHub CLI auth in app-launched shells](docs/github-cli-auth.md) |
| Electron hangs while CLI is outdated | Re-run the launcher and check `~/.cache/codex-desktop/launcher.log` plus `~/.local/state/codex-update-manager/service.log`. Best-effort CLI preflight will warn if the automatic refresh fails |
| GPU / Vulkan / Wayland errors | Under Wayland with `DISPLAY` available, the launcher uses `--ozone-platform=x11` for window-positioning compatibility. Otherwise it uses `--ozone-platform-hint=auto`. The GPU sandbox is disabled by default, while GPU compositing stays enabled. On desktops where XWayland or software rendering hangs, such as some COSMIC/NVIDIA sessions, try `CODEX_LINUX_RENDERING_MODE=wayland-gpu ./codex-app/start.sh` |
| Window flickering | Try `CODEX_ELECTRON_DISABLE_GPU_COMPOSITING=1 ./codex-app/start.sh` to use the legacy compositing workaround. If flickering persists, try `./codex-app/start.sh --disable-gpu` to fully disable GPU acceleration |
| Sandbox errors | The launcher already sets `--no-sandbox` |
| Stale install / cached DMG | `make build-app-fresh` removes the existing install dir and cached DMG, then re-downloads |
| Unsure which installed integration is broken | Run `codex-desktop-doctor` or `codex-desktop-doctor --json` from a native package install |
| `codex-desktop.service` is enabled but inactive | Close any manually launched Codex Desktop process, then run `systemctl --user start codex-desktop.service` |
| Computer Use plugin invisible in UI | Ensure you enabled the Computer Use UI. If it is enabled and still hidden, the OpenAI per-account rollout may not be available |
| Computer Use `doctor` reports no input backend | Grant read/write `/dev/uinput`, enable the XDG RemoteDesktop portal, or start the distro-provided `ydotoold` / `ydotool` daemon with a socket accessible to your user |
| Computer Use `doctor` reports `ydotool_socket: Permission denied` | The daemon socket is root-only. Adjust the `ydotoold` service so `/tmp/.ydotool_socket` becomes `root:input` with `0660` permissions |
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
7. `scripts/build-{deb,rpm,pacman}.sh` packages `codex-app/` into a native artifact; `scripts/build-appimage.sh` creates a local AppImage
8. Native packages provide `codex-desktop-doctor` plus an opt-in `codex-desktop.service` app unit
9. Default native packages provide `codex-update-manager` plus a `systemd --user` updater service unit
10. The updater watches for newer upstream DMGs and rebuilds future native Linux packages locally, unless the package was built with `PACKAGE_WITH_UPDATER=0`

The installer replaces the macOS Electron binary with a Linux build, recompiles native modules, and removes macOS-only pieces such as `sparkle`.

The launcher serves extracted webview assets from `content/webview/` on `127.0.0.1` (`5175` by default, `5176` for the dev app), validates the origin, then starts Electron. Warm-start launches hand off actions such as `--new-chat` over a Unix-domain socket instead of spawning a second app process.

Native-package-only launcher behavior, such as desktop-entry hints and default update-manager startup, lives in `packaging/linux/codex-packaged-runtime.sh`.

The current evaluation for a future Rust replacement of the local webview server lives in `docs/webview-server-evaluation.md`.

## Validation

After changing installer, packaging, or updater logic:

```bash
bash -n install.sh scripts/lib/*.sh launcher/start.sh.template scripts/build-deb.sh scripts/build-rpm.sh scripts/build-pacman.sh scripts/build-appimage.sh scripts/install-deps.sh
node --check scripts/patch-linux-window-ui.js
node --check scripts/desktop-parity-smoke.js
node --check scripts/app-server-schema-guard.js
for file in scripts/patches/*.js; do node --check "$file"; done
node --check scripts/ci/validate-patch-report.js
node --test scripts/patch-linux-window-ui.test.js
node --test linux-features/*/test.js
bash tests/scripts_smoke.sh
cargo check -p codex-update-manager
cargo test -p codex-update-manager
cargo check -p codex-computer-use-linux
cargo test -p codex-computer-use-linux
make package
```

For package metadata checks, run the format-specific commands that are available on your system:

```bash
dpkg-deb -I dist/codex-desktop_*.deb
dpkg-deb -c dist/codex-desktop_*.deb | sed -n '1,40p'
make rpm
./scripts/build-pacman.sh
pacman -Qip dist/codex-desktop-*.pkg.tar.zst
pacman -Qlp dist/codex-desktop-*.pkg.tar.zst | sed -n '1,40p'
```

## Versioning

`codex-update-manager` current crate version: `0.8.1`

SemVer policy:

- **patch** for fixes, docs, and maintenance-only updates
- **minor** for compatible feature additions
- **major** for incompatible CLI, persisted-state, or install-flow changes

See [CHANGELOG.md](CHANGELOG.md) for per-version detail.

## Disclaimer

This is an unofficial community project. Codex Desktop is a product of OpenAI. This tool does not redistribute any OpenAI software; it automates the conversion process that users perform on their own copies.

## License

MIT
