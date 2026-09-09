# Experimental Alpine host build

This opt-in packaging path runs ChatGPT Community directly on Alpine Linux
x86_64. It supplies a private glibc library closure for the official desktop
runtime while repository commands continue to use Alpine's shell, musl,
compiler, Git, and filesystem. It creates no container, chroot, or alternate
operating-system namespace and does not require root.

The regular installer still verifies OpenAI's signed stable repository and
builds the Community app. The Alpine packager reuses the Nix ELF inventory,
interpreter relocation, and dependency audit. It changes ELF loading metadata,
preserves `resources/app.asar`, and does not rebuild upstream native modules.
It is a manual packaging experiment, not a supported `apk` package or updater.

## Prerequisites

Alpine 3.24 x86_64, a working KDE/X11 or KDE/Wayland desktop with XWayland,
unprivileged user namespaces, Git, Bash, Node.js 20+, Python 3, GnuPG, curl,
and patchelf. Keep several GB free for package downloads and extracted copies.
The scripts have been exercised with Node 24 and Python 3.14.

`prepare-tools.cjs` needs apk-tools 3 and the host's trusted Alpine repository
configuration. It downloads and verifies native Alpine tools with `apk verify`
and extracts them with `apk extract --no-chown`. It does not install packages
into the OS or run package scripts. GNU flock/tar/coreutils are needed because
their BusyBox replacements lack options used by the upstream builder. Native
Alpine procps supplies the desktop's `ps -ax` process sampler.

## Build and install

Run from the checkout. Use fresh output directories; these scripts deliberately
refuse to overwrite a previous build. All paths are permanent once built:
ELF interpreters and library paths contain their absolute locations.

```sh
alpine_tools="$HOME/.local/share/codex-desktop/alpine-tools"
alpine_runtime="$HOME/.local/share/codex-desktop/alpine-runtime"
alpine_app="$HOME/.local/share/codex-desktop/alpine-build"

node packaging/alpine/prepare-tools.cjs "$alpine_tools"

PATH="$alpine_tools/root/usr/bin:$alpine_tools/root/bin:$PATH" \
  python3 packaging/alpine/fetch-runtime.py --output "$alpine_runtime"

PATH="$alpine_tools/root/usr/bin:$alpine_tools/root/bin:$PATH" \
  bash ./install.sh

node packaging/alpine/build.cjs ./codex-app "$alpine_runtime" "$alpine_app"
node packaging/alpine/install-desktop.cjs "$alpine_app" "$alpine_tools"
"$alpine_app/launch.sh"
```

The application menu entry is **ChatGPT Community**. The generated launcher
selects GTK 3 and XWayland, adds only the native Alpine `ps` command to PATH,
and forwards user arguments and deep-link URIs. It does not set
`LD_LIBRARY_PATH`, replace the host shell, or disable Chromium's sandbox.
On KDE, run `kbuildsycoca6 --noincremental` if the menu has not refreshed.

Because the desktop refreshes PATH from the login shell, the installer also
exposes native Alpine procps as `~/.local/bin/ps`. An existing command at that
path is validated and never overwritten. This user-level helper becomes the
default `ps` when `~/.local/bin` precedes `/bin`; it remains an Alpine musl
binary. Ensure that the user bin directory is in the login shell's PATH.

The runtime downloader verifies Debian 13 archive keys against pinned primary
fingerprints, verifies each `InRelease`, checks metadata expiry when provided,
and checks index and package SHA-256 and size. It combines trixie,
trixie-updates, and trixie-security. Package data is extracted without executing
maintainer scripts. Only library and shared-data directories enter the final
application build; Debian executables never enter the launch PATH. The package
manifest records origins, versions, architectures, and hashes. No application
or runtime binaries should be committed to this repository.

ELF `NODEFLIB` prevents missing optional dependencies (particularly Qt on KDE)
from falling back to incompatible libraries in Alpine's `/usr/lib`. Every
private shared library receives its own RUNPATH; preserving relative symlinks
is essential so they resolve to those adjusted copies. This is library
compatibility, not a security isolation boundary.

## Validation

```sh
python3 -m unittest discover -s packaging/alpine -p 'test_*.py'
node --test scripts/ci/elf-runtime.test.js scripts/ci/relocate-elf-interpreter.test.js

"$alpine_app/opt/codex-desktop/resources/cua_node/bin/node" \
  packaging/alpine/verify-host.cjs "$alpine_app/opt/codex-desktop" /absolute/repository

# Optionally execute a repository check through the bundled app-server:
"$alpine_app/opt/codex-desktop/resources/cua_node/bin/node" \
  packaging/alpine/verify-host.cjs "$alpine_app/opt/codex-desktop" "$PWD" \
  python3 -m unittest discover -s packaging/alpine -p 'test_*.py'
```

The host probe launches the packaged glibc Node, then the bundled Codex
app-server, and issues `command/exec` without creating an agent thread or
contacting a model. It compares OS, repository, command paths, and musl loader
output with the direct host result. The optional check uses the repository's
real host toolchain and has a 90-second timeout.

Validated locally on Alpine 3.24.1 x86_64, KDE Plasma 6.6.6 Wayland/XWayland,
with official upstream 26.903.61454: rendered desktop UI, existing account
session, local app-server, Git access, Cargo workspace metadata in a host
repository, and the Alpine packaging tests executed through `command/exec`.

## Current limits

- amd64 only; ARM64 is not implemented or tested.
- XWayland is the tested path. Native Wayland, hardware video decoding,
  accelerated graphics, microphone/voice, keyring integration, computer use,
  and the full browser workflow are not validated. GPU and GTK module warnings
  can appear without preventing the basic desktop workflow.
- There is no automated update or rollback manager for this output. Build to
  a fresh prefix for each upstream or library update; keep the old prefix
  until validation passes. The desktop installer refuses to overwrite an
  existing menu entry, so switch it explicitly after reviewing a new build.
- This reuses Nix's current upstream ELF contract. Inventory drift rejects the
  build and must be investigated rather than bypassed.
- Optional Qt shims cannot load Alpine Qt. The app uses the supplied GTK
  libraries, so native KDE theming may differ.
- As with other Community builds, do not run a separate official ChatGPT app
  against the same `Codex` profile simultaneously.

To uninstall, close ChatGPT Community and remove its generated
`codex-desktop.desktop` menu entry and the exact build/tools/runtime prefixes
you selected. Remove `~/.local/bin/ps` only if it is the symlink this installer
created into your selected tools prefix. Keep `~/.codex` and
`~/.config/Codex`; they contain user data.
