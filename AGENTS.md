# AGENTS.md

## Purpose

This repository adapts the official macOS Codex Desktop DMG to a runnable Linux build, packages that build as native `.deb`, `.rpm`, and pacman artifacts, and ships a local Rust update manager that rebuilds future Linux packages from newer upstream DMGs.

The current working flow is:

1. `install.sh` extracts `Codex.dmg`
2. extracts and patches `app.asar`
3. rebuilds native Node modules for Linux
4. downloads a Linux Electron runtime
5. writes a Linux launcher into `codex-app/start.sh`
6. `scripts/build-deb.sh`, `scripts/build-rpm.sh`, or `scripts/build-pacman.sh` packages `codex-app/`
7. `codex-update-manager` runs as a `systemd --user` service and manages local auto-updates

## Source Of Truth

- `install.sh`
  Top-level installer entrypoint. Sources the `scripts/lib/*.sh` build-pipeline modules and emits `codex-app/start.sh` from the launcher template.
- `launcher/start.sh.template`
  Runtime launcher body. Concatenated by `install.sh::create_start_script` after a short prelude that bakes in the install-time app identity (`CODEX_LINUX_APP_ID`, display name, default webview port). Edit this file for any launcher behavior change — webview server lifecycle, warm-start handoff, CLI preflight, GUI prompts, URL-scheme handling, ydotool helpers.
- `scripts/lib/install-helpers.sh`
  Argument parsing, dependency checks, identity validation, install-dir preparation, color/log helpers, `shell_quote`.
- `scripts/lib/process-detection.sh`
  Running-app detection used to refuse overwriting a live install. Skips Electron utility helpers via `/proc/<pid>/cmdline` `--type=` heuristic.
- `scripts/lib/dmg.sh`
  DMG download, extraction, and Electron-version detection from upstream metadata.
- `scripts/lib/native-modules.sh`
  Native-module rebuild for Linux (`better-sqlite3`, `node-pty`) plus Electron download and cache.
- `scripts/lib/asar-patch.sh`
  Drives the Node patcher (`scripts/patch-linux-window-ui.js`) over `app.asar`.
- `scripts/lib/webview-install.sh`
  Webview asset extraction and final `codex-app/` install layout.
- `scripts/lib/bundled-plugins.sh`
  Linux Computer Use backend build, COSMIC helper build, plugin staging, and bundled-plugin marketplace generation.
- `scripts/build-deb.sh`
  Builds the `.deb` from the already-generated `codex-app/`.
- `scripts/build-rpm.sh`
  Builds the `.rpm` from the already-generated `codex-app/`.
- `scripts/build-pacman.sh`
  Builds the `.pkg.tar.zst` from the already-generated `codex-app/`.
- `scripts/install-deps.sh`
  Installs host dependencies and bootstraps Rust.
- `scripts/lib/package-common.sh`
  Shared shell helpers used by the native package builders.
- `Makefile`
  Convenience targets for build, package, install, and cleanup workflows.
- `packaging/linux/control`
  Debian control template.
- `packaging/linux/codex-desktop.desktop`
  Desktop entry template.
- `packaging/linux/codex-packaged-runtime.sh`
  Packaged-launcher helper for native-package-only runtime behavior.
- `packaging/linux/codex-desktop.spec`
  RPM spec template.
- `packaging/linux/codex-update-manager.service`
  User-level `systemd` unit for the local update manager.
- `packaging/linux/codex-update-manager.prerm`
  Debian maintainer script that stops or disables the user service during removal.
- `packaging/linux/codex-update-manager.postrm`
  Debian maintainer script that reloads affected user managers after removal.
- `assets/codex.png`
  App icon used in native packages.
- `updater/`
  Rust crate that checks for new upstream DMGs, rebuilds local native-package artifacts, tracks update state, and installs prepared packages after the app exits.
- `updater/Cargo.toml`
  Source of truth for the updater crate version and dependency policy.
- `computer-use-linux/`
  Rust crate implementing the Linux Computer Use MCP backend (`codex-computer-use-linux` binary). Talks AT-SPI to read accessibility trees, captures screenshots through GNOME Shell DBus or XDG Desktop Portal, lists/focuses windows through `src/windowing/` backends, and synthesizes input via `ydotool`. Runs as a subprocess of Codex Electron when the bundled plugin is registered.
- `computer-use-linux/src/windowing/`
  Modular Computer Use window backend layer. Keep shared types, target resolution, fallback order, and focus verification in `mod.rs` / `target.rs` / `registry.rs`; keep desktop-specific listing, activation, probes, parsers, and tests in `backends/*.rs`.
- `computer-use-linux/src/bin/codex-computer-use-cosmic.rs`
  COSMIC Wayland helper binary used by the Linux Computer Use backend for compositor-native window enumeration and activation on COSMIC sessions.
- `plugins/openai-bundled/plugins/computer-use/`
  Bundled plugin manifest for Linux Computer Use (`.codex-plugin/plugin.json` + `.mcp.json`). Author and license fields here must stay consistent with the repo's MIT license — they live alongside the runtime resources installed under `/opt/codex-desktop/resources/plugins/openai-bundled/`.
- `packaging/linux/codex-update-manager-user-service.sh`
  Shared shell helper sourced by `postinst` / `prerm` / `postrm` (DEB) and `%post` / `%preun` / `%postun` (RPM) plus pacman `.install` hooks. Provides `codex_ensure_user_service_running` / `codex_cleanup_user_service` / `codex_reload_user_managers` for safe `systemd --user` start/stop/disable across formats.
- `packaging/linux/com.github.ilysenko.codex-desktop-linux.update.policy`
  Polkit policy installed under `/usr/share/polkit-1/actions/` so the privileged updater install steps trigger the desktop authentication agent instead of `pkexec`'s textual fallback.
- `scripts/patch-linux-window-ui.js`
  ASAR patcher CLI and compatibility export surface. The implementation lives in `scripts/patches/`.
- `scripts/patches/`
  Modular ASAR patch registry and patch groups. Keep patch order in `scripts/patches/registry.js`; add feature-specific needles to the smallest matching module.
- `scripts/ci/validate-patch-report.js`
  CI guard that reads `patch-report.json` and fails upstream-build CI when a `required-upstream` patch is missing or skipped.
- `scripts/patch-linux-window-ui.test.js`
  Node test suite for the patcher. Run with `node --test`.
- `docs/webview-server-evaluation.md`
  Decision record for the future Python-to-Rust webview server discussion.

## Generated Artifacts

- `codex-app/`
  Generated Linux app directory. Treat this as build output unless you are intentionally patching the launcher or testing package contents.
- `dist/`
  Generated packaging output, including `dist/codex-desktop_*.deb`, `dist/codex-desktop-*.rpm`, and `dist/codex-desktop-*.pkg.tar.zst`.
- `Codex.dmg`
  Cached upstream DMG. Useful for repeat installs.
- `~/.config/codex-update-manager/config.toml`
  Runtime config written or read by the updater service.
- `~/.local/state/codex-update-manager/state.json`
  Updater state machine persistence.
- `~/.local/state/codex-update-manager/service.log`
  Updater service log.
- `~/.cache/codex-update-manager/`
  Downloaded DMGs, rebuild workspaces, staged package artifacts, and build logs.

Do not assume `codex-app/` is pristine. If behavior differs from `install.sh`, prefer updating `install.sh` and then regenerating the app.

## Important Behavior And Known Fixes

- DMG extraction:
  `7z` can return a non-zero status for the `/Applications` symlink inside the DMG. This is currently treated as a warning if a `.app` bundle was still extracted successfully.
- Launcher and `nvm`:
  GUI launchers often do not inherit the user's shell `PATH`. The generated `start.sh` explicitly searches for `codex`, including common `nvm` locations.
- CLI preflight:
  Before Electron launches, the generated launcher asks `codex-update-manager` to verify the installed Codex CLI, prompt to install it when it is missing, and update it if the npm package is newer. Terminal launches prompt inline; GUI launches prefer `kdialog` on KDE/Plasma, otherwise `zenity`, before falling back to an actionable desktop notification. Missing-CLI automatic installation is launcher-scoped: the daemon and `codex-update-manager status` report `cli_status: NotInstalled` and may notify, but they do not attempt installation on their own. The check is best-effort: it uses a 1-hour cooldown for npm registry lookups, caches local CLI version reads to keep startup light, falls back to `npm install -g --prefix ~/.local` if a global install fails, and warns instead of blocking app launch when the refresh attempt does not succeed.
- ASAR patches are independent and fail-soft:
  `scripts/patches/registry.js` is the source of truth for patch order and CI policy. Each patch function has its own regex-driven needles, an idempotency check, and a `console.warn` fall-back when the upstream bundle drifts. Current groups: main-process shell/window patches, webview asset patches, keybinds settings, launch actions, Computer Use gates, and package metadata. The wrapper `scripts/patch-linux-window-ui.js` keeps the old CLI and test export surface. When adding a new needle, mirror this pattern — never `throw` unless the existing patch is intentionally required.
- Linux file manager integration:
  `applyLinuxFileManagerPatch` injects a Linux implementation for `Open in File Manager`. If the upstream minified bundle no longer matches, the install continues and emits exactly `Failed to apply Linux File Manager Patch`.
- Linux Computer Use plugin gate:
  Upstream excludes Linux from four allow-list gates; we patch them with two different default postures.
  - **Default-on:** `applyLinuxComputerUsePluginGatePatch` flips the bundled-plugin manifest from `darwin`-only to `darwin || linux` and adds `installWhenMissing: true` so the MCP plugin auto-registers. Pure platform-port glue — no Statsig involvement, no behavioural override; it has shipped on by default since the project's first release.
  - **Opt-in:** `applyLinuxComputerUseFeaturePatch`, `applyLinuxComputerUseRendererAvailabilityPatch`, and `applyLinuxComputerUseInstallFlowPatch` together unlock the Codex Desktop UI controls. The install-flow patch in particular falls back to `navigator.userAgent.includes("Linux")` as an OR-clause against the `computer_use` Statsig flag, which is why it is deliberately not on by default. The orchestrator (`patchMainBundleSource` / `patchExtractedApp`) calls `isComputerUseUiEnabled()` once per build; the helper returns `true` when `process.env.CODEX_LINUX_ENABLE_COMPUTER_USE_UI === "1"` OR `~/.config/codex-desktop/settings.json` contains `"codex-linux-computer-use-ui-enabled": true`. The settings-flag fallback exists so the auto-updater (a `systemd --user` service that does not inherit interactive shell env) can keep applying the UI patches across rebuilds without the user re-exporting an env var on every login.
  - **Out of scope:** OpenAI per-account Statsig rollouts that gate other features (`gpt-5.5` model rollout is the recurring example). Those are decided server-side per account and there is nothing in the local install that controls them.
- Linux Computer Use window backends:
  Add new desktop/window-manager support under `computer-use-linux/src/windowing/backends/` and register it in `windowing/registry.rs`; avoid adding backend-specific branches to `server.rs` or `diagnostics.rs`. GNOME uses `org.gnome.Shell.Introspect` for listing plus the bundled `codex-window-control@openai.com` GNOME Shell extension for exact activation. COSMIC Wayland uses the bundled `codex-computer-use-cosmic` helper, which talks directly to the compositor's COSMIC toplevel Wayland protocols. When neither backend is available, Computer Use still supports screenshots, AT-SPI, and global `ydotool` input, but not verified window-targeted keyboard input.
- Linux settings persistence:
  `applyLinuxSettingsPersistencePatch` inserts `codexLinuxPersistSettingsState(...)` so the keybinds-settings page toggles (system tray, warm start, compact prompt window) are mirrored to `~/.config/codex-desktop/settings.json`, where `linux_setting_enabled` in `install.sh` reads them. The patch is fail-soft: if the upstream `Yb` state-file marker or `set-global-state` IPC handler isn't present, the patch logs a warning and skips, leaving keybinds toggles in-memory only.
- Linux warm-start handoff:
  `applyLinuxLaunchActionArgsPatch` + `applyLinuxHotkeyWindowPrewarmPatch` add a Unix-domain-socket launch-action listener (`launch-action.sock` under `$XDG_RUNTIME_DIR/codex-desktop/`). When `start.sh` detects an existing Electron PID, it sends `--new-chat` / `--quick-chat` / `--prompt-chat` / `--hotkey-window` over the socket and exits, so a second launch never spawns a fresh Electron.
- Linux translucent sidebar default:
  During the same ASAR patch step, Linux defaults `Translucent sidebar` to `false` by applying `opaqueWindows: true` only when the app has no saved explicit value yet. This keeps existing user preferences intact while avoiding the sidebar disappearing bug on first run.
- Linux pet overlay mouse passthrough:
  `applyLinuxAvatarOverlayMousePassthroughPatch` keeps the floating pet's transparent-area click-through behavior by preferring `BrowserWindow.setShape()` on Linux. Electron only documents forwarded mouse events for macOS and Windows, so Linux can miss the renderer mousemove that should turn `setIgnoreMouseEvents(true)` back off after pet/workspace changes or when the Codex window is not focused. The Linux patch shapes the overlay input region to the current pet mascot/tray rectangles, expands it to the full overlay while dragging, leaves transparent regions click-through at the window-manager level, and falls back to the main-process pointer sync loop only if `setShape()` is unavailable or fails.
- Launcher logging:
  The generated launcher logs to:
  `~/.cache/codex-desktop/launcher.log`
- App liveness:
  The launcher writes a PID file to `~/.local/state/codex-desktop/app.pid`. The updater uses that plus `/proc` fallback to know whether Electron is still running.
- Desktop icon association:
  The launcher runs Electron with `--class=codex-desktop`, and the desktop file sets `StartupWMClass=codex-desktop` so the taskbar/dock can associate the correct icon.
- Webview server:
  The launcher starts a local `python3 -m http.server 5175` from `content/webview/`, waits for port `5175` to become reachable, verifies that `http://127.0.0.1:5175/index.html` serves the expected Codex startup markers, and only then launches Electron because the extracted app expects local webview assets there.
- Wayland/GPU compatibility:
  The generated launcher enables `--ozone-platform-hint=auto`, `--disable-gpu-sandbox`, and `--enable-features=WaylandWindowDecorations` by default. Keep these in mind when debugging Pop!_OS, Wayland, or Nvidia-specific rendering issues.
- Webview server roadmap:
  Review `docs/webview-server-evaluation.md` before changing the local server model; that document captures the current recommendation, risks, and acceptance criteria.
- Closing behavior:
  If future work touches shutdown behavior, assume the confirmation dialog may be implemented inside the app bundle rather than the Linux launcher.
- Update manager:
  The native packages include `/usr/bin/codex-update-manager`, `/usr/lib/systemd/user/codex-update-manager.service`, and a minimal rebuild bundle under `/opt/codex-desktop/update-builder`.
- Privilege boundary:
  The updater runs unprivileged. It only escalates at install time via `pkexec /usr/bin/codex-update-manager install-deb --path <deb>`, `install-rpm --path <rpm>`, or `install-pacman --path <pkg.tar.zst>`.
- Failed privileged installs:
  A failed or cancelled `pkexec` install now stays in `Failed` and does not auto-retry every reconcile cycle. Check `service.log`, fix the root cause, and retry by waiting for the next rebuild or rebuilding a newer package.
- Interrupted installs:
  If updater state is left in `Installing` after a crash, restart, or interrupted privileged flow, the daemon now recovers that state automatically instead of staying stuck and skipping future upstream checks.
- Package removal:
  Debian and RPM removal now make a best-effort attempt to stop and disable `codex-update-manager.service` for active user sessions. If a user manager is unavailable, manual cleanup is still `systemctl --user disable --now codex-update-manager.service`.

## Crate Versioning

- Current updater crate version: `0.7.1`
- Bump `patch` for fixes, docs, and maintenance-only updates.
- Bump `minor` for compatible feature additions.
- Bump `major` for incompatible CLI, persisted-state, or install-flow changes.
- If the updater crate version changes, update README and AGENTS in the same change so the maintenance docs do not drift.

## How To Rebuild

### Regenerate the Linux app

```bash
./install.sh ./Codex.dmg
```

Or let the script download the DMG:

```bash
./install.sh
```

### Build the Debian package

```bash
./scripts/build-deb.sh
```

Default output:

```bash
dist/codex-desktop_YYYY.MM.DD.HHMMSS_amd64.deb
```

Optional version override:

```bash
PACKAGE_VERSION=2026.03.24.120000+deadbeef ./scripts/build-deb.sh
```

### Build the RPM package

```bash
./scripts/build-rpm.sh
```

Default output:

```bash
dist/codex-desktop-YYYY.MM.DD.HHMMSS-<release>.x86_64.rpm
```

Optional version override:

```bash
PACKAGE_VERSION=2026.03.24.120000+deadbeef ./scripts/build-rpm.sh
```

### Build the pacman package

```bash
./scripts/build-pacman.sh
```

Default output:

```bash
dist/codex-desktop-YYYY.MM.DD.HHMMSS-<release>-x86_64.pkg.tar.zst
```

Optional version override:

```bash
PACKAGE_VERSION=2026.03.24.120000+deadbeef ./scripts/build-pacman.sh
```

## Runtime Expectations

- `python3`, `7z`, `curl`, `unzip`, `tar`, `make`, and `g++` are required for `install.sh`
- `install.sh` downloads and installs a managed Linux Node.js runtime into `codex-app/resources/node-runtime`; that runtime provides `node`, `npm`, and `npx` for native module rebuilds, Browser Use, Codex CLI install/update flow, and local auto-update rebuilds.
- On apt-based systems, `scripts/install-deps.sh` can still bootstrap NodeSource Node.js 22 for users who want a system Node.js. `NODEJS_MAJOR=24 bash scripts/install-deps.sh` selects Node.js 24 instead.
- the packaged app still requires the Codex CLI at runtime:
  `codex` must exist in `PATH` or be set through `CODEX_CLI_PATH`, but the launcher now attempts a best-effort automatic install on first run when the CLI is missing and `npm` is available

## Packaging Notes

The native packages currently install:

- app files under `/opt/codex-desktop`
- launcher under `/usr/bin/codex-desktop`
- updater binary under `/usr/bin/codex-update-manager`
- updater unit under `/usr/lib/systemd/user/codex-update-manager.service`
- update builder bundle under `/opt/codex-desktop/update-builder`
- desktop file under `/usr/share/applications/codex-desktop.desktop`
- icon under `/usr/share/icons/hicolor/256x256/apps/codex-desktop.png`

The Debian builder uses `dpkg-deb --root-owner-group` so package ownership is correct.

The RPM builder stages the same app and updater payload into an RPM buildroot before invoking `rpmbuild`.

The pacman builder stages the same payload into a package root, writes `.PKGINFO`/`.MTREE`, and then produces a `.pkg.tar.zst` archive for `pacman -U`.

## Preferred Validation After Changes

After editing installer or packaging logic, validate at least:

```bash
bash -n install.sh
bash -n scripts/lib/*.sh
bash -n launcher/start.sh.template
bash -n scripts/build-deb.sh
bash -n scripts/build-rpm.sh
bash -n scripts/build-pacman.sh
cargo check -p codex-update-manager
cargo test -p codex-update-manager
./scripts/build-deb.sh
dpkg-deb -I dist/codex-desktop_*.deb
dpkg-deb -c dist/codex-desktop_*.deb | sed -n '1,40p'
```

If `rpmbuild` is available, also run:

```bash
./scripts/build-rpm.sh
```

If `pacman` is available, also run:

```bash
./scripts/build-pacman.sh
pacman -Qip dist/codex-desktop-*.pkg.tar.zst
pacman -Qlp dist/codex-desktop-*.pkg.tar.zst | sed -n '1,40p'
```

If launcher behavior changed, also inspect:

```bash
sed -n '1,120p' codex-app/start.sh
```

If updater behavior changed, also inspect:

```bash
systemctl --user status codex-update-manager.service
codex-update-manager status --json
sed -n '1,120p' ~/.local/state/codex-update-manager/state.json
sed -n '1,160p' ~/.local/state/codex-update-manager/service.log
```

## Editing Guidance

- Prefer changing `launcher/start.sh.template` (for runtime/launcher behavior) or `scripts/lib/*.sh` (for build-pipeline behavior) over manually patching `codex-app/start.sh`, unless you are making a temporary local test. `install.sh` itself stays small — it's just orchestration and the prelude that bakes install-time identity into the generated launcher.
- Keep native-package-only launcher behavior in `packaging/linux/codex-packaged-runtime.sh`; `launcher/start.sh.template` should stay generic and only load that helper optionally.
- If you update `launcher/start.sh.template`, regenerate `codex-app/` or keep `codex-app/start.sh` aligned before building a new package.
- Keep packaging changes in `packaging/linux/`, `scripts/build-deb.sh`, `scripts/build-rpm.sh`, and `scripts/build-pacman.sh`; avoid hardcoding distro-specific behavior outside those files unless necessary.
- Keep `scripts/lib/package-common.sh` aligned with both builders when you add or remove packaged files from the shared runtime payload.
