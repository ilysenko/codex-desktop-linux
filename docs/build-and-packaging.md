# Build And Packaging

## Prerequisites

You need:

- `python3`, `7z` or `7zz`, `curl`, `unzip`, `make`, `g++`
- `flatpak` and `flatpak-builder` for Flatpak self-builds
- Rust toolchain with `cargo` for `codex-update-manager`,
  `codex-computer-use-linux`, and the Chrome extension host binary

The installer downloads a managed Linux Node.js runtime into
`codex-app/resources/node-runtime` and uses it for `node`, `npm`, and `npx`
during the build. Existing `nvm`, asdf, Volta, NodeSource, or nodejs.org
installs are fine, but no longer required for this project.

Bootstrap dependencies:

```bash
bash scripts/install-deps.sh
```

It detects `apt`, `dnf5`, `dnf`, `pacman`, or `zypper`, installs system
packages, and bootstraps Rust through `rustup` when needed.

## Manual Dependencies

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

# Rust toolchain
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

On apt-based systems, `scripts/install-deps.sh` can still bootstrap optional
NodeSource Node.js for users who want a system Node.js toolchain:

```bash
bash scripts/install-deps.sh
NODEJS_MAJOR=24 bash scripts/install-deps.sh
```

Ubuntu-family `p7zip-full` can be too old for newer APFS DMGs, so
`install-deps.sh` bootstraps `7zz` into `~/.local/bin` by default.

## Generate The Local App

```bash
make build-app
make build-app-fresh
make build-app DMG=/path/to/Codex.dmg
```

Equivalent direct commands:

```bash
./install.sh
./install.sh /path/to/Codex.dmg
./install.sh --fresh
```

The default path stores upstream DMG headers, plus a hash of the upstream URL,
next to `Codex.dmg` and refreshes the cached file when that upstream fingerprint
changes. `--fresh` still forces a cache removal before rebuilding, and an
explicit `DMG=/path/to/Codex.dmg` uses that file exactly.

Run the generated app:

```bash
make run-app
./codex-app/start.sh
```

## Running The Generated App

By default, second launches reuse the running app through the Linux warm-start
handoff.

Open an independent app process:

```bash
./codex-app/start.sh --new-instance
```

Configure the port range or make every launch use multi-instance mode:

```bash
CODEX_MULTI_LAUNCH_PORT_RANGE=5175-5199 ./codex-app/start.sh --new-instance
CODEX_MULTI_LAUNCH=1 CODEX_MULTI_LAUNCH_PORT_RANGE=5175-5199 ./codex-app/start.sh
```

## Package Formats

After `make build-app` or `make build-app-fresh`, build a native package or
AppImage from `codex-app/`:

| Format | Build command | Output | Install |
|---|---|---|---|
| Debian | `make deb` | `dist/codex-desktop_*.deb` | `sudo dpkg -i dist/codex-desktop_*.deb` |
| RPM | `make rpm` | `dist/codex-desktop-*.x86_64.rpm` | `sudo dnf install dist/codex-desktop-*.rpm` or `sudo zypper install dist/codex-desktop-*.rpm` |
| Arch | `make pacman` | `dist/codex-desktop-*.pkg.tar.zst` | `sudo pacman -U dist/codex-desktop-*.pkg.tar.zst` |
| AppImage | `make appimage` | `dist/codex-desktop-*.AppImage` | Run directly |
| Auto-detect | `make package && make install` | matches host distro | handled by `make install` |

Override package version:

```bash
PACKAGE_VERSION=2026.03.24.220723+88f07cd3 make deb
```

The native package and AppImage scripts only repackage what is already in
`codex-app/`; they do not download or extract the DMG. Flatpak is handled
separately below and rebuilds from source inside `flatpak-builder`.

## AppImage Local Self-Build

```bash
make build-app
make appimage
./dist/codex-desktop-*.AppImage
```

The AppImage flow does not include `codex-update-manager`, the systemd user
service, polkit policy, or the native-package update builder.

When upstream Codex Desktop changes:

```bash
git pull --ff-only
make build-app-fresh
make appimage
```

AppImage builds require `appimagetool` on `PATH`, or:

```bash
APPIMAGETOOL=/path/to/appimagetool make appimage
```

## Flatpak Self-Build

```bash
flatpak remote-add --if-not-exists flathub https://flathub.org/repo/flathub.flatpakrepo
make flatpak
flatpak install --user dist/io.github.ilysenko.codex_desktop_linux-*.flatpak
```

The Flatpak build path renders `packaging/flatpak/io.github.ilysenko.codex_desktop_linux.json`, stages a pinned npm cache for `asar`, the bundled Codex CLI, and native-module rebuild inputs, then builds a local bundle through `flatpak-builder`.

`scripts/build-flatpak.sh` always builds through `flatpak-builder`, which is the same path you should expect to use for a Flathub submission. If the host cannot run `flatpak-builder`'s sandbox correctly, Flatpak self-builds are unsupported on that host; build on another machine or in a working Flatpak-capable environment instead of falling back to a host-side export path.

The default Flatpak manifest is intentionally self-contained rather than native-package feature parity. It keeps the desktop shell, bundled Codex CLI, bundled Node runtime, bundled Git and ripgrep runtime tools, GPU/window-system access, the PulseAudio compatibility socket for in-app voice input/output, SSH agent forwarding, and Secret Service access that the packaged app needs, while deliberately avoiding both broad host filesystem grants and the `org.freedesktop.Flatpak` host-command bridge.

The wrapper pins `HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`, and `XDG_STATE_HOME` into Flatpak-managed persistent storage under `/var`, so launcher state, Codex home, CLI caches, and Git config stay inside the sandbox. That is the default storage model for the Flatpak package, but it does not prevent explicit user-granted access to files or directories chosen through portal-backed file dialogs.

As a result, the default Flatpak build should be treated as a sandboxed desktop package with a reduced support matrix relative to the native packages in this repository:

- no packaged updater / rebuild-manager flow
- no host browser native-host registration
- no Linux Computer Use staging
- no broad host filesystem grant; host files are available only when the user explicitly chooses them through the document portal

If full host integration is a hard requirement, prefer the native packages from this repository. A Flatpak variant that adds broad host filesystem access or `org.freedesktop.Flatpak` host-command access would be a different trust model and should not be the default Flathub submission.

Important differences from the native package flow:

- No `codex-update-manager`, package hooks, or privileged in-app updater path.
- No bundled Browser Use / Chrome native-host / Linux Computer Use resource staging.
- A small Python runtime is bundled only to satisfy launcher internals inside the Flatpak sandbox.
- The launcher uses `zypak-wrapper` from the Electron BaseApp and skips host URL-scheme registration.

If the required Flatpak refs are already present, skip dependency installation with `FLATPAK_INSTALL_DEPS=0 make flatpak`. To use a different remote name, set `FLATPAK_DEPS_REMOTE=your-remote-name`.

When you change pinned npm dependencies for Flatpak packaging, regenerate the lockfiles, source manifests, and checked-in manifest:

```bash
bash scripts/flatpak/refresh-generated-sources.sh
```

For a real Flathub submission, keep the checked-in Flatpak files here but render the manifest with a pinned archive or git source instead of the local `dir` source, and complete a normal Flathub policy/trademark review. `scripts/build-flatpak.sh` already does this locally by rendering a temporary manifest from a tarball snapshot of the current checkout.

## Electron Mirrors

If runtime downloads from GitHub are slow or blocked:

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ make build-app
```

`ELECTRON_HEADERS_URL` is passed to `@electron/rebuild --dist-url` and must
provide both `node-v<version>-headers.tar.gz` and the matching `SHASUMS256.txt`.

## Build Parallelism

```bash
MAX_BUILD_THREADS=8 make build-app-fresh
MAX_BUILD_THREADS=8 make package
MAX_BUILD_THREADS=8 make install-native
```

`MAX_BUILD_THREADS=0` is the default and preserves each tool's automatic
behavior. A nonzero value controls Cargo jobs, native module rebuild jobs,
Debian package compression, pacman package compression, and RPM zstd payload
compression.

## Make Targets

Run:

```bash
make help
```

Common targets:

```bash
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
make flatpak
make package
make install
make service-enable
make service-status
make clean-dist
make clean-state
```
