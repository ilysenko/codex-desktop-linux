# Raspberry Pi 5

The core ChatGPT Desktop for Linux build has been validated on a 16 GB
Raspberry Pi 5. The existing upstream ARM64 support built and ran without a
Pi-specific source patch.

This page records a field test, not a separate Raspberry Pi port. ARM64 support
comes from the work already maintained in this repository by
[@ilysenko](https://github.com/ilysenko) and its contributors.

## Validated environment

The successful test used:

- Raspberry Pi 5 with 16 GB RAM
- 64-bit Debian 13 (trixie), `aarch64`
- NVMe storage
- LightDM with the Raspberry Pi Labwc Wayland desktop
- 1920x1080 display output
- repository version `0.10.4` at commit `ab314923b5bf`
- upstream ChatGPT app version `26.727.51351`
- Electron `42.3.0`

The native build acceptance verdict was `accepted`, with no blockers or
warnings. The generated Debian package reported `Architecture: arm64`, and the
Electron executable, native Node modules, Linux helpers, and Codex CLI platform
binary were verified as AArch64 executables.

## Build and install

Use a 64-bit operating system. Active cooling and SSD or NVMe storage are
recommended for the native build.

The repository's normal Debian-family setup path should be used:

```bash
git clone https://github.com/ilysenko/codex-desktop-linux.git
cd codex-desktop-linux
PACKAGE_WITH_UPDATER=0 MAX_BUILD_THREADS=4 make bootstrap-native
```

`PACKAGE_WITH_UPDATER=0` keeps the first Pi installation simple by omitting the
automatic rebuild service. After the baseline is stable, it can be evaluated
separately. Limiting build parallelism to four jobs is a conservative starting
point for Pi thermals and responsiveness.

The tested run performed the same stages separately:

```bash
bash scripts/install-deps.sh
PACKAGE_WITH_UPDATER=0 MAX_BUILD_THREADS=4 make build-app-fresh
PACKAGE_WITH_UPDATER=0 MAX_BUILD_THREADS=4 make deb
```

Install the generated package from `dist/` with the normal Debian package
manager. Do not download or redistribute someone else's generated package:
this project intentionally performs the conversion locally from the official
upstream application.

## Desktop setup

The application needs a graphical desktop session. A Pi configured for
console-only boot must have its existing display manager enabled before the
desktop launcher can be tested. The validated system used LightDM automatic
login with the Raspberry Pi Labwc session.

After installation, start **ChatGPT** from the desktop menu. The first launch
may install or update the Codex CLI. If manual setup is needed, include the
optional platform dependency:

```bash
npm install -g --include=optional --prefix ~/.local @openai/codex
```

## Validation results

The following checks passed on the test Pi:

- clean ARM64 app build using the official ABI-matched native modules
- native `arm64` Debian package creation and installation
- graphical reboot into the Labwc Wayland desktop
- application launch from the live desktop session
- correctly rendered ChatGPT sign-in window
- account sign-in
- Codex app-server startup using the ARM64 Codex CLI
- workspace file creation and editing
- integrated command execution
- Python, SQLite, automated test, and local Git workflows
- a Chromium publishing workflow using Linux Computer Use for screen capture,
  accessible element discovery, and global pointer and keyboard input, with
  external manual `wlrctl` shell commands for Labwc window listing and focus

## Optional capability results

A combined Chromium workflow was validated on the Labwc Wayland session after
the desktop-control dependencies were completed. Initially, screenshots worked,
but accessibility discovery, pointer input, and keyboard input were incomplete.
Labwc is not currently a supported window-control backend, so window listing
and focus were supplied separately through manual `wlrctl` shell commands.

The successful Pi configuration added:

- `at-spi2-core` and toolkit accessibility for AT-SPI element discovery
- external manual use of `wlrctl` for window listing and focus through Labwc's
  wlroots foreign-toplevel interface; the Computer Use backend did not invoke
  these commands
- an ARM64 build of `ydotool` 1.0.3 or newer and an enabled per-user
  `ydotoold.service`
- membership of the desktop user in the `input` group

A scoped udev rule granted the `input` group read/write access to
`/dev/uinput`:

```udev
KERNEL=="uinput", GROUP="input", MODE="0660"
```

Debian 13 did not offer a `ydotool` package on the validated image, so
`ydotool` and `ydotoold` were built for ARM64 and installed under
`/usr/local/bin`. The daemon exposed its socket at
`$XDG_RUNTIME_DIR/.ydotool_socket`. See [Linux Computer Use](linux-computer-use.md)
for the general dependency, daemon, UI opt-in, and supported-backend readiness
instructions.

The final test combined Linux Computer Use screen capture, AT-SPI inspection,
and global pointer and keyboard input with external `wlrctl` shell focus to
open an external user-owned web application, complete a content form, publish
a persistent test item, and read back its public URL. One initial keyboard
attempt reached the wrong window; the manual focus step was added before the
successful retry.

The public item verifies that the combined workflow published and persisted the
result. It does not establish that the backend's built-in `list_windows`,
`focused_window`, or targeted-input verification supported Labwc. Treat those
window-control capabilities as unavailable on Labwc until a dedicated backend
is implemented.

Granting access to `/dev/uinput` and running `ydotoold` allows synthetic input.
Limit access to trusted local users, keep the device rule group-scoped, and do
not use a world-writable device mode.

One known architecture-specific gap remains: the repository's Browser Use
`node_repl` fallback resource is currently x86-64-only when no compatible
upstream or user-supplied ARM64 binary is available. The Browser and Chrome
plugins were enabled and discoverable during this test, but the demonstrated
workflow used Chromium through Linux Computer Use. Treat Browser Use as a
separate capability until its execution path is independently validated on
ARM64.

## Remaining validation

Long-running thermal behavior, peak memory use, and the automatic update
manager were not measured during this first validation.

## Reporting Pi issues

Include the following when reporting a Raspberry Pi problem:

- Pi model and RAM size
- operating system and architecture from `uname -m`
- desktop environment and X11 or Wayland session type
- repository commit and upstream app version
- exact build command
- package format
- relevant output from `~/.cache/codex-desktop/launcher.log`

Keep generated applications and packages out of pull requests. Documentation,
diagnostics, tests, and fixes should target the repository sources.
