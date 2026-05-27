# AGENTS.md

## Purpose

This repository adapts the official macOS Codex Desktop DMG to a runnable Linux build, packages that build as native `.deb`, `.rpm`, and pacman artifacts, and ships a local Rust update manager that rebuilds future Linux packages from newer upstream DMGs.

The current working flow is:

1. `install.sh` extracts `Codex.dmg`
2. extracts and patches `app.asar`
3. rebuilds native Node modules for Linux
4. downloads a Linux Electron runtime
5. stages bundled plugins (Browser Use, Chrome native-messaging host, Linux Computer Use)
6. runs any opt-in `linux-features/` stage hooks
7. writes a Linux launcher into `codex-app/start.sh`
8. `scripts/build-deb.sh`, `scripts/build-rpm.sh`, or `scripts/build-pacman.sh` packages `codex-app/`
9. `codex-update-manager` runs as a `systemd --user` service and manages local auto-updates

## Source Of Truth

### Repo orchestration

- `install.sh`
  Top-level installer entrypoint. Sources the `scripts/lib/*.sh` build-pipeline modules and emits `codex-app/start.sh` from the launcher template. Stays small — just orchestration plus the prelude that bakes install-time identity into the generated launcher.
- `Makefile`
  Convenience targets for build, package, install, dev side-by-side app (`codex-cua-lab`), and cleanup workflows. Detects the host package format (`apt`, `dnf`, `pacman`) for `make install`.
- `Cargo.toml`
  Workspace root. Members: `computer-use-linux`, `updater`.
- `flake.nix` / `flake.lock`
  Nix flake that pins upstream DMG hash, Cargo deps hash, and Node deps hash so `nix build` can reproduce the install end-to-end. `scripts/ci/update-nix-hashes.sh` is the maintained way to refresh the pinned hashes.

### Launcher

- `launcher/start.sh.template`
  Runtime launcher body. Concatenated by `install.sh::create_start_script` after a short prelude that bakes in the install-time app identity (`CODEX_LINUX_APP_ID`, display name, default webview port). Edit this file for any launcher behavior change — webview server lifecycle, warm-start handoff, CLI preflight, GUI prompts, URL-scheme handling, ydotool helpers.
- `packaging/linux/codex-packaged-runtime.sh`
  Packaged-launcher helper for native-package-only runtime behavior. Loaded optionally from the launcher; keep distro/native-package specifics here so the generic launcher template stays portable.

### Build pipeline (`scripts/lib/`)

- `install-helpers.sh` — argument parsing, dependency checks, identity validation, install-dir preparation, color/log helpers, `shell_quote`.
- `node-runtime.sh` — managed Linux Node.js runtime download, SHA256 pinning, install layout (`resources/node-runtime/`). Default `v22.22.2` with override knobs (`CODEX_MANAGED_NODE_VERSION`, `CODEX_MANAGED_NODE_URL`, `CODEX_MANAGED_NODE_SHA256`).
- `process-detection.sh` — running-app detection used to refuse overwriting a live install. Skips Electron utility helpers via `/proc/<pid>/cmdline` `--type=` heuristic.
- `dmg.sh` — DMG download, extraction, Electron-version detection from upstream metadata.
- `native-modules.sh` — native-module rebuild for Linux (`better-sqlite3`, `node-pty`) plus Electron download and cache.
- `asar-patch.sh` — drives the Node patcher (`scripts/patch-linux-window-ui.js`) over `app.asar`.
- `webview-install.sh` — webview asset extraction and final `codex-app/` install layout.
- `bundled-plugins.sh` — Browser Use, Chrome, and Linux Computer Use plugin staging; Chrome native-host injection; Linux Computer Use backend build; COSMIC helper build; bundled-plugin marketplace generation.
- `patch-chrome-plugin.js` — Linux compatibility patcher for the upstream bundled Chrome plugin scripts. Adds Linux manifest checks, Chrome/Brave/Chromium native-host manifest coverage, Linux browser profile fallback, and Brave/Chromium-aware diagnostics when upstream has not already shipped them.
- `linux-update-bridge-patch.js` — injects the Electron-side bridge that lets the in-app menu trigger the local `codex-update-manager` (status read, install-after-quit shell helper, `codexLinuxQuitForUpdate` glue).
- `linux-target-context.js` — Linux target detection used by patch descriptors. Reads `/etc/os-release` plus env overrides and exposes helpers such as `matchesId()`, `packageFormatIs()`, `packageManagerIs()`, `desktopMatches()`, and `versionAtLeast()`.
- `patch-report.js` — shared helpers for building `patch-report.json` (status capture, warning capture, `recordPatch`, `writePatchReport`).
- `rebuild-report.sh` — writes `rebuild-report.json` (DMG path, Electron version, patch report, app dir) used by the rebuild candidate flow.
- `package-common.sh` — shared shell helpers used by the native package builders (versioning, payload staging, installed doctor rendering, user-service helper installation).
- `linux-features.sh` / `linux-features.js` — opt-in Linux feature framework loader. The shell side runs `stage.sh` hooks for enabled features; the JS side resolves manifests, validates entrypoints, and contributes `mainBundlePatch` functions to the patch registry.

### Patch registry (`scripts/patches/`)

- `scripts/patch-linux-window-ui.js` — ASAR patcher CLI and compatibility export surface. Implementation lives under `scripts/patches/`.
- `scripts/patches/engine.js` — auto-discovers `scripts/patches/core/**/patch.js`, normalizes patch descriptors, enforces duplicate-id checks, applies target filters, and records structured patch-report metadata.
- `scripts/patches/core/` — source of truth for shipped Linux compatibility patch descriptors, grouped by target namespace (`all-linux/`, `distro/`, `package/`, `desktop/`). Add new shipped patchers as `patch.js` descriptors here; each descriptor declares phase/order/CI policy and self-filters with `appliesTo(context)` when it is distro/package/desktop-specific.
- `scripts/patches/registry.js` — orchestrates discovered core descriptors, enabled `linux-features/*/patch.js` descriptors, and the aggregate `main-process-ui` report entry; drives `patchExtractedApp` and `patchMainBundleSource`.
- `scripts/patches/main-process.js` — Linux quit guard, single-instance, tray, file-manager, window options, set-icon, opaque background, avatar overlay passthrough, Chrome extension status, Browser Use NodeREPL approval, and other main-process needles.
- `scripts/patches/computer-use.js` — Linux Computer Use plugin gate (default-on) and the opt-in UI patches; owns `isComputerUseUiEnabled()`.
- `scripts/patches/launch-actions.js` — launch-action Unix-domain socket listener, hotkey-window prewarm, settings persistence, tray-close setting.
- `scripts/patches/webview-assets.js` — webview-bundle hash-named asset patches: app sunset gate, translucent sidebar default, Browser Use annotation screenshot patch.
- `scripts/patches/keybinds-settings.js` — keybinds settings page Linux additions.
- `scripts/patches/package-json.js` — packaged `package.json` desktop-name rewrite.
- `scripts/patches/shared.js` — bundle/asset discovery helpers (`findMainBundle`, `findIconAsset`, `patchAssetFiles`).
- `scripts/patch-linux-window-ui.test.js` — Node test suite for the patcher. Run with `node --test`.
- `scripts/ci/validate-patch-report.js` — CI guard that reads `patch-report.json` and fails upstream-build CI when a `required-upstream` patch is missing or skipped.

### CI helpers (`scripts/ci/`, `scripts/`)

- `scripts/ci-local.sh` — local CI runner. Reproduces the GitHub matrix with pinned container images (Ubuntu 22.04/24.04, Debian 12, Fedora 42, Arch base-devel, Nix). Targets: `pr` / `all` / `core` / `deb` / `rpm` / `pacman` / `install-deps[:image]` / `nix` / `upstream`.
- `scripts/ci/container-entrypoint.sh` — entrypoint executed inside CI containers. Knows the job names dispatched by `ci-local.sh` and the GitHub workflows.
- `scripts/ci/update-nix-hashes.sh` — refresh the SRI hashes baked into `flake.nix` (DMG, Cargo deps, Node deps) by running `nix build` and parsing the resulting hash mismatch errors.
- `scripts/rebuild-candidate.sh` — safe rebuild flow: inspect the DMG, write reports under `dist-next/rebuild/`, build a side-by-side candidate in `codex-app-next/`, and optionally promote it into `codex-app/` with a backup (`--install`).
- `scripts/install-deps.sh` — installs host dependencies and bootstraps Rust. NodeSource Node.js 22 by default on apt-based systems; `NODEJS_MAJOR=24` selects 24.

### Native packaging (`scripts/`, `packaging/linux/`)

- `scripts/build-deb.sh` — builds the `.deb` from the already-generated `codex-app/`.
- `scripts/build-rpm.sh` — builds the `.rpm` from the already-generated `codex-app/`.
- `scripts/build-pacman.sh` — builds the `.pkg.tar.zst` from the already-generated `codex-app/`.
- `packaging/linux/control` — Debian control template.
- `packaging/linux/codex-desktop.spec` — RPM spec template.
- `packaging/linux/PKGBUILD.template` — pacman PKGBUILD template (used to generate `.PKGINFO`/`.MTREE` plus the archive contents).
- `packaging/linux/codex-desktop.install` — pacman `.install` hooks (`post_install` / `post_upgrade` / `pre_remove` / `post_remove`).
- `packaging/linux/codex-desktop.desktop` — desktop entry template.
- `packaging/linux/codex-desktop-doctor.py` — installed safe healthcheck rendered as `/usr/bin/codex-desktop-doctor`; keep it status/path only and never print pairing secrets, browser contents, screenshots, cookies, or key material.
- `packaging/linux/codex-update-manager.service` — user-level `systemd` unit for the local update manager.
- `packaging/linux/codex-update-manager.postinst` — Debian maintainer script that starts the user service after install.
- `packaging/linux/codex-update-manager.prerm` — Debian maintainer script that stops or disables the user service during removal.
- `packaging/linux/codex-update-manager.postrm` — Debian maintainer script that reloads affected user managers after removal.
- `packaging/linux/codex-update-manager-user-service.sh` — shared shell helper sourced by `postinst` / `prerm` / `postrm` (DEB), `%post` / `%preun` / `%postun` (RPM), and pacman `.install` hooks. Provides `codex_ensure_user_service_running` / `codex_cleanup_user_service` / `codex_reload_user_managers` for safe `systemd --user` start/stop/disable across formats.
- `packaging/linux/com.github.ilysenko.codex-desktop-linux.update.policy` — Polkit policy installed under `/usr/share/polkit-1/actions/` so the privileged updater install steps trigger the desktop authentication agent instead of `pkexec`'s textual fallback.
- `assets/codex.png` — app icon used in native packages.

### Updater (`updater/`)

- `updater/Cargo.toml` — source of truth for the updater crate version and dependency policy.
- `updater/src/main.rs` — binary entrypoint; declares all updater modules.
- `updater/src/cli.rs` — `clap` CLI: `daemon`, `check-now`, `cli-preflight`, `prompt-install-cli`, `status`, `install-deb`, `install-rpm`, `install-pacman`, `install-ready`, `rollback`, etc.
- `updater/src/app.rs` — top-level dispatcher that wires CLI subcommands to the daemon, reconcile loop, and one-shot helpers.
- `updater/src/builder.rs` — drives the local rebuild bundle (`/opt/codex-desktop/update-builder` in installed packages) to produce a candidate `.deb`/`.rpm`/`.pkg.tar.zst` from a newer DMG.
- `updater/src/upstream.rs` — upstream DMG polling, ETag/If-None-Match cache, download, hash verification.
- `updater/src/install.rs` — privileged install entrypoint: dispatches to format-specific helpers and writes the rollback target.
- `updater/src/install_rollback.rs` — format-specific commands (`apt`, `dpkg`, `dnf`, `rpm`, `zypper`, `pacman`) used by both the rollback flow and ordinary installs.
- `updater/src/rollback.rs` — manual rollback orchestration: tracks the last-known-good package and exposes the `rollback` CLI command.
- `updater/src/codex_cli.rs` — Codex CLI discovery, version reads, npm-registry preflight checks, and the install/update flow used by `cli-preflight` and `prompt-install-cli`.
- `updater/src/state.rs` — `PersistedState` (status, candidate, installed version, CLI status, rollback target) and disk persistence at `~/.local/state/codex-update-manager/state.json`.
- `updater/src/config.rs` — runtime config loader (`~/.config/codex-update-manager/config.toml`) and the resolved `RuntimePaths` used elsewhere.
- `updater/src/liveness.rs` — Electron liveness checks (PID file plus `/proc` fallback).
- `updater/src/notify.rs` — desktop-notification helpers (uses `notify-rust`).
- `updater/src/logging.rs` — `tracing-subscriber` setup writing to `~/.local/state/codex-update-manager/service.log`.
- `updater/src/test_util.rs` — shared test helpers; serialises env-mutating tests under a single mutex so cargo's parallel runner cannot corrupt `HOME`/`PATH`/`NVM_DIR`/`CODEX_CLI_PATH`/D-Bus addresses.

### Computer Use and bundled Linux plugin (`computer-use-linux/`, `plugins/`)

- `computer-use-linux/Cargo.toml` — Rust crate (`codex-computer-use-linux`) with three binaries: `codex-computer-use-linux` (MCP backend), `codex-chrome-extension-host` (Chrome native messaging host), `codex-computer-use-cosmic` (COSMIC Wayland helper).
- `computer-use-linux/src/main.rs` — argv dispatcher: `mcp`, `doctor`, `setup`, `apps`, etc.
- `computer-use-linux/src/server.rs` — MCP server surface; ties together AT-SPI, screenshots, portal pointer, GNOME extension, and the windowing layer.
- `computer-use-linux/src/atspi_tree.rs` — AT-SPI accessibility tree snapshotting, action invocation, value setting.
- `computer-use-linux/src/screenshot.rs` — screenshot capture via GNOME Shell DBus or XDG Desktop Portal.
- `computer-use-linux/src/remote_desktop.rs` — XDG Desktop Portal RemoteDesktop session: pointer click/drag/scroll.
- `computer-use-linux/src/diagnostics.rs` — `doctor` and `setup` reports, plus `hydrate_session_bus_env` used by every D-Bus client to find the user bus inside `systemd --user` services.
- `computer-use-linux/src/gnome_extension.rs` — bundled GNOME Shell extension installer/diagnostics for `codex-window-control@openai.com`. Embeds the extension assets via `include_str!`.
- `computer-use-linux/src/cosmic_helper.rs` — invokes the bundled `codex-computer-use-cosmic` helper binary for COSMIC Wayland window targeting.
- `computer-use-linux/src/terminal.rs` — terminal context detection (tty, root/active process, cwd) used to resolve terminal-targeted windows.
- `computer-use-linux/src/windows.rs` — re-export shim for the modular `windowing/` layer; legacy import path used by `server.rs` and the integration tests.
- `computer-use-linux/src/windowing/mod.rs` — module wiring for the windowing layer; re-exports backend constants and target helpers, and hosts the cross-backend integration test suite.
- `computer-use-linux/src/windowing/types.rs` — `WindowInfo`, `WindowBounds`, `WindowTarget`, `WindowFocusResult`.
- `computer-use-linux/src/windowing/registry.rs` — backend descriptors, ordering, list-note hints, and the `WINDOW_PERMISSION_HINT`.
- `computer-use-linux/src/windowing/target.rs` — target resolution (window id, pid, title, app, terminal selectors), focus verification, ambiguity errors.
- `computer-use-linux/src/windowing/backends/` — desktop-specific listing, activation, probes, parsers, and per-backend tests. Current backends: `gnome.rs`, `cosmic.rs`, `kwin.rs`, `hyprland.rs`, `i3.rs`. Add new desktop/window-manager support here and register it in `registry.rs`; avoid adding backend-specific branches to `server.rs` or `diagnostics.rs`.
- `computer-use-linux/src/bin/codex-chrome-extension-host.rs` — Linux native-messaging host for the bundled Chrome plugin. Bridges Chrome extension stdio frames to local Browser Use Unix-socket clients, validates the socket directory and same-UID peer credentials, watches Codex session rollout files for completed turns, emits `turnEnded`, and is staged as `extension-host/linux/<arch>/extension-host`.
- `computer-use-linux/src/bin/codex-computer-use-cosmic.rs` — COSMIC Wayland helper binary used by the Linux Computer Use backend for compositor-native window enumeration and activation on COSMIC sessions.
- `computer-use-linux/gnome-shell-extension/codex-window-control@openai.com/` — bundled GNOME Shell extension (`extension.js` + `metadata.json`) installed by `gnome_extension.rs` for exact window activation under GNOME Shell.
- `plugins/openai-bundled/plugins/computer-use/` — bundled plugin manifest for Linux Computer Use (`.codex-plugin/plugin.json` + `.mcp.json`). Author and license fields here must stay consistent with the repo's MIT license — they live alongside the runtime resources installed under `/opt/codex-desktop/resources/plugins/openai-bundled/`.

### Opt-in Linux features (`linux-features/`)

- `linux-features/README.md` — contract documentation. Features are off by default; copy `features.example.json` to `features.json` and list the ids you want enabled.
- `linux-features/features.example.json` — empty `{ "enabled": [] }` template. The active `linux-features/features.json` is gitignored so per-developer choices do not leak into commits.
- `linux-features/example-feature/` — disabled-by-default sample: `feature.json`, `README.md`, optional `patch.js` (`applyMainBundlePatch(source, context)`), optional `stage.sh` (run with `SCRIPT_DIR`/`INSTALL_DIR`/`WORK_DIR`/`ARCH`/`CODEX_UPSTREAM_APP_DIR`), optional `test.js`. Run feature tests with `node --test linux-features/*/test.js`.

Core Linux compatibility patch descriptors live in `scripts/patches/core/`. Use `linux-features/` for additions that are useful for some users but should not ship to every Linux build.

### User-local install (`contrib/user-local-install/`)

- `install-user-local.sh` — opt-in installer that lays everything out under `~/.local/opt/codex-desktop-linux`, with thin wrappers in `~/.local/bin` (`codex-desktop`, `codex-desktop-update`, `codex-desktop-check-update`, `codex-desktop-version`) and a desktop entry under `~/.local/share/applications`.
- `files/.local/lib/codex-desktop-linux/common.sh` — shared helpers used by the installed maintenance scripts.
- `files/.config/systemd/user/codex-desktop-update.{service,timer}` — opt-in weekly user-timer (`--enable-timer`) for unattended update checks.
- `README.md` — install layout and removal steps.

This path is for users who do not want a system-wide native package; the daily-driver install flow stays `install.sh` + native package + `codex-update-manager`.

### Tests (`tests/`)

- `tests/scripts_smoke.sh` — top-level smoke tests covering the shell helpers, package builders, launcher template, installer Electron-version detection, native-module pipeline, ASAR patches, and bundled-plugin staging. The CI `core` target runs this suite.
- `tests/fixtures/create-packaged-app-fixture.sh` — minimal fake `codex-app/` layout used by package-builder smoke tests.

### Docs

- `docs/webview-server-evaluation.md` — decision record for the future Python-to-Rust webview server discussion.
- `README.md` / `CONTRIBUTING.md` / `CHANGELOG.md` — public documentation. Keep release notes in `CHANGELOG.md` aligned with the updater crate version.

## Generated Artifacts

- `codex-app/` — generated Linux app directory. Treat as build output unless you are intentionally patching the launcher or testing package contents. Do not assume it is pristine; if behavior differs from `install.sh`, prefer updating `install.sh` (or a `scripts/lib/*.sh` helper) and regenerating.
- `codex-app-next/` — side-by-side rebuild candidate produced by `scripts/rebuild-candidate.sh` before promotion.
- `codex-*-app/` — alternate identity build directories (e.g. `codex-cua-lab-app/` from the Makefile dev target).
- `dist/` — generated packaging output (`codex-desktop_*.deb`, `codex-desktop-*.rpm`, `codex-desktop-*.pkg.tar.zst`).
- `dist-next/rebuild/` — rebuild candidate reports (`patch-report.json`, `rebuild-report.json`).
- `target/` — Rust build output for both workspace crates.
- `Codex.dmg` — cached upstream DMG. Useful for repeat installs.
- `linux-features/features.json` — per-developer opt-in feature config (gitignored).
- `~/.config/codex-update-manager/config.toml` — runtime config written or read by the updater service.
- `~/.local/state/codex-update-manager/state.json` — updater state-machine persistence.
- `~/.local/state/codex-update-manager/service.log` — updater service log.
- `~/.cache/codex-update-manager/` — downloaded DMGs, rebuild workspaces, staged package artifacts, build logs.
- `~/.cache/codex-desktop/launcher.log` — generated launcher log.
- `~/.local/state/codex-desktop/app.pid` and `webview.pid` — launcher liveness files.
- `$XDG_RUNTIME_DIR/codex-desktop/launch-action.sock` — warm-start handoff socket.

## Important Behavior And Known Fixes

- DMG extraction:
  `7z` can return a non-zero status for the `/Applications` symlink inside the DMG. This is currently treated as a warning if a `.app` bundle was still extracted successfully.
- Managed Node.js runtime:
  `install.sh` always provisions a managed Linux Node.js runtime under `codex-app/resources/node-runtime/` (default `v22.22.2`). The launcher, native module rebuild, Browser Use, the Codex CLI install/update flow, and the local auto-update rebuilds all use this runtime. Override with `CODEX_MANAGED_NODE_VERSION` / `CODEX_MANAGED_NODE_URL` / `CODEX_MANAGED_NODE_SHA256` (the SHA must be set when overriding the version or URL).
- Launcher and `nvm`:
  GUI launchers often do not inherit the user's shell `PATH`. The generated `start.sh` explicitly searches for `codex`, including common `nvm` locations.
- CLI preflight:
  Before Electron launches, the generated launcher asks `codex-update-manager` to verify the installed Codex CLI, prompt to install it when it is missing, and update it if the npm package is newer. Terminal launches prompt inline; GUI launches prefer `kdialog` on KDE/Plasma, otherwise `zenity`, before falling back to an actionable desktop notification. Missing-CLI automatic installation is launcher-scoped: the daemon and `codex-update-manager status` report `cli_status: NotInstalled` and may notify, but they do not attempt installation on their own. The check is best-effort: it uses a 1-hour cooldown for npm registry lookups, caches local CLI version reads to keep startup light, falls back to `npm install -g --prefix ~/.local` if a global install fails, and warns instead of blocking app launch when the refresh attempt does not succeed.
- ASAR patches are independent and fail-soft:
  `scripts/patches/core/**/patch.js` descriptors are the source of truth for shipped patch order, phase, target filter, and CI policy; `scripts/patches/registry.js` discovers and orchestrates them. Each patch function has its own regex-driven needles, an idempotency check, and a `console.warn` fall-back when the upstream bundle drifts. Current groups: main-process shell/window patches, webview asset patches, keybinds settings, launch actions, Computer Use gates, package metadata, and any opt-in `linux-features/` patches that have been enabled. The wrapper `scripts/patch-linux-window-ui.js` keeps the old CLI and test export surface. When adding a new needle, mirror this pattern — never `throw` unless the existing patch is intentionally required.
- Patch reporting and CI gate:
  `scripts/lib/patch-report.js` produces `patch-report.json` for each install (and `rebuild-report.sh` rolls it into `rebuild-report.json` under `dist-next/rebuild/`). `scripts/ci/validate-patch-report.js` reads that report and fails upstream-build CI when a `required-upstream` patch is missing or skipped. Mark new patches with `ciPolicy: REQUIRED_UPSTREAM` only when their absence should block CI.
- Linux features framework:
  `linux-features/` is opt-in. By default no extras are loaded. Per-developer choices live in the gitignored `linux-features/features.json`; CI sees only the empty `features.example.json` template. Features can contribute a main-bundle patch (registered as `feature:<id>` with `ciPolicy: optional`) and/or a `stage.sh` hook executed during install staging. Keep core Linux fixes in `scripts/patches/`; reserve `linux-features/` for additions that should not ship to every Linux build.
- Linux file manager integration:
  `applyLinuxFileManagerPatch` injects a Linux implementation for `Open in File Manager`. If the upstream minified bundle no longer matches, the install continues and emits exactly `Failed to apply Linux File Manager Patch`.
- Linux Computer Use plugin gate:
  Upstream excludes Linux from four allow-list gates; we patch them with two different default postures.
  - **Default-on:** `applyLinuxComputerUsePluginGatePatch` flips the bundled-plugin manifest from `darwin`-only to `darwin || linux` and adds `installWhenMissing: true` so the MCP plugin auto-registers. Pure platform-port glue — no Statsig involvement, no behavioural override; it has shipped on by default since the project's first release.
  - **Opt-in:** `applyLinuxComputerUseFeaturePatch`, `applyLinuxComputerUseRendererAvailabilityPatch`, and `applyLinuxComputerUseInstallFlowPatch` together unlock the Codex Desktop UI controls. The install-flow patch in particular falls back to `navigator.userAgent.includes("Linux")` as an OR-clause against the `computer_use` Statsig flag, which is why it is deliberately not on by default. The orchestrator (`patchMainBundleSource` / `patchExtractedApp`) calls `isComputerUseUiEnabled()` once per build; the helper returns `true` when `process.env.CODEX_LINUX_ENABLE_COMPUTER_USE_UI === "1"` OR `~/.config/codex-desktop/settings.json` contains `"codex-linux-computer-use-ui-enabled": true`. The settings-flag fallback exists so the auto-updater (a `systemd --user` service that does not inherit interactive shell env) can keep applying the UI patches across rebuilds without the user re-exporting an env var on every login.
  - **Out of scope:** OpenAI per-account Statsig rollouts that gate other features (`gpt-5.5` model rollout is the recurring example). Those are decided server-side per account and there is nothing in the local install that controls them.
- Linux Chrome plugin and native messaging:
  `install_bundled_plugin_resources` stages the upstream `chrome` plugin alongside `browser-use`, patches the Chrome plugin scripts for Linux, builds `codex-chrome-extension-host` from Rust, and installs that ELF as `extension-host/linux/<arch>/extension-host`. The host mirrors the macOS native host's browser socket bridge and rollout/session watcher: it observes browser requests carrying `session_id` / `turn_id`, tails the matching rollout JSONL under `~/.codex/sessions`, and emits `turnEnded` back to the extension after `task_complete`. It keeps one active Browser Use client per extension host: a newer Codex browser client evicts stale client sockets and clears their pending requests so old Node REPL kernels cannot keep issuing CDP setup calls. The launcher mirrors the staged plugin into `~/.codex/plugins/cache/openai-bundled/chrome/<version>`, maintains `latest`, writes bundled marketplace metadata, symlinks `plugins/chrome` under the temporary marketplace root, derives extension id/native-host name from the staged plugin metadata, and installs native-host manifests for Google Chrome, Brave, and Chromium. `applyLinuxChromePluginAutoInstallPatch` adds `installWhenMissing` to the upstream Chrome plugin descriptor so the plugin page does not depend on a manually persisted marketplace install state after restart. The staged diagnostics also recognize Brave and Chromium installs, running processes, profiles, and extension-aware profile selection before telling the user Chrome setup is missing. `applyLinuxChromeExtensionStatusPatch` fixes the Electron settings page's `chrome-extension-installed-read` handler so the visible Connected/Not connected badge scans Linux Chrome, Brave, and Chromium profile roots instead of returning false on Linux. Chrome's bundled `browser-client.mjs` must receive the same Linux `/aura/site_status` allowlist fallback as Browser Use so `Always allow` is not defeated by a missing `nodeRepl.fetch` allowlist. This is the durable source-of-truth fix for Linux browser extension availability; do not hand-edit only the user cache.
- Linux Computer Use window backends:
  Add new desktop/window-manager support under `computer-use-linux/src/windowing/backends/` and register it in `windowing/registry.rs`; avoid adding backend-specific branches to `server.rs` or `diagnostics.rs`. GNOME uses `org.gnome.Shell.Introspect` for listing plus the bundled `codex-window-control@openai.com` GNOME Shell extension for exact activation. COSMIC Wayland uses the bundled `codex-computer-use-cosmic` helper, which talks directly to the compositor's COSMIC toplevel Wayland protocols. KWin uses a generated KWin scripting bridge; Hyprland uses `hyprctl`; i3/Sway uses the i3 IPC tree plus `xprop` for PIDs. When no compositor backend is available, Computer Use still supports screenshots, AT-SPI, and global `ydotool` input, but not verified window-targeted keyboard input.
- Linux settings persistence:
  `applyLinuxSettingsPersistencePatch` inserts `codexLinuxPersistSettingsState(...)` so the keybinds-settings page toggles (system tray, warm start, compact prompt window) are mirrored to `~/.config/codex-desktop/settings.json`, where `linux_setting_enabled` in `install.sh` reads them. The patch is fail-soft: if the upstream `Yb` state-file marker or `set-global-state` IPC handler isn't present, the patch logs a warning and skips, leaving keybinds toggles in-memory only.
- Linux warm-start handoff:
  `applyLinuxLaunchActionArgsPatch` + `applyLinuxHotkeyWindowPrewarmPatch` add a Unix-domain-socket launch-action listener (`launch-action.sock` under `$XDG_RUNTIME_DIR/codex-desktop/`). When `start.sh` detects an existing Electron PID, it sends `--new-chat` / `--quick-chat` / `--prompt-chat` / `--hotkey-window` over the socket and exits, so a second launch never spawns a fresh Electron.
- Linux translucent sidebar default:
  During the same ASAR patch step, Linux defaults `Translucent sidebar` to `false` by applying `opaqueWindows: true` only when the app has no saved explicit value yet. This keeps existing user preferences intact while avoiding the sidebar disappearing bug on first run.
- Linux pet overlay mouse passthrough:
  `applyLinuxAvatarOverlayMousePassthroughPatch` keeps the floating pet's transparent-area click-through behavior by preferring `BrowserWindow.setShape()` on Linux. Electron only documents forwarded mouse events for macOS and Windows, so Linux can miss the renderer mousemove that should turn `setIgnoreMouseEvents(true)` back off after pet/workspace changes or when the Codex window is not focused. The Linux patch shapes the overlay input region to the current pet mascot/tray rectangles, expands it to the full overlay while dragging, leaves transparent regions click-through at the window-manager level, and falls back to the main-process pointer sync loop only if `setShape()` is unavailable or fails.
- In-app updater bridge:
  `linux-update-bridge-patch.js` (registered as `linux-app-updater-bridge` and `linux-app-updater-menu`) injects an Electron-side bridge so the in-app menu can read the local updater state file, kick off `codex-update-manager install-ready`, and trigger `codexLinuxQuitForUpdate` when an update is staged. The bridge is fail-soft: when the upstream bundle bindings cannot be located it emits a warning and leaves the macOS Sparkle code path intact.
- Launcher logging:
  The generated launcher logs to `~/.cache/codex-desktop/launcher.log` (or `$XDG_CACHE_HOME/<app id>/launcher.log` for non-default identities).
- App liveness:
  The launcher writes a PID file to `~/.local/state/codex-desktop/app.pid`. The updater uses that plus `/proc` fallback to know whether Electron is still running.
- Desktop icon association:
  The launcher runs Electron with `--class=codex-desktop`, and the desktop file sets `StartupWMClass=codex-desktop` so the taskbar/dock can associate the correct icon.
- Webview server:
  The launcher starts a local `python3 -m http.server` on port `5175` (default identity) or `5176` (alternate identity) from `content/webview/`, waits for the port to become reachable, verifies that `http://127.0.0.1:<port>/index.html` serves the expected Codex startup markers, and only then launches Electron because the extracted app expects local webview assets there. Opt-in multi-instance launches (`--new-instance` / `CODEX_MULTI_LAUNCH=1`) allocate the first free port from `CODEX_MULTI_LAUNCH_PORT_RANGE` and isolate pid files, launch sockets, logs, and Electron user-data dirs under the selected `port-<n>` instance id.
- Wayland/GPU compatibility:
  The generated launcher enables `--ozone-platform-hint=auto`, `--disable-gpu-sandbox`, and `--enable-features=WaylandWindowDecorations` by default. Keep these in mind when debugging Pop!_OS, Wayland, or Nvidia-specific rendering issues.
- Webview server roadmap:
  Review `docs/webview-server-evaluation.md` before changing the local server model; that document captures the current recommendation, risks, and acceptance criteria.
- Closing behavior:
  If future work touches shutdown behavior, assume the confirmation dialog may be implemented inside the app bundle rather than the Linux launcher.
- Update manager:
  Default native packages include `/usr/bin/codex-update-manager`, `/usr/lib/systemd/user/codex-update-manager.service`, and a minimal rebuild bundle under `/opt/codex-desktop/update-builder`. All native packages include `/usr/bin/codex-desktop-doctor`.
- Privilege boundary:
  The updater runs unprivileged. It only escalates at install time via `pkexec /usr/bin/codex-update-manager install-deb --path <deb>`, `install-rpm --path <rpm>`, or `install-pacman --path <pkg.tar.zst>`.
- Manual rollback:
  `codex-update-manager rollback` reinstalls the last-known-good package recorded in `state.json`. The same `install_rollback.rs` command shells (`apt`/`dpkg`, `dnf`/`rpm`/`zypper`, `pacman`) drive both the rollback and the ordinary post-install path; do not duplicate format detection elsewhere.
- Failed privileged installs:
  A failed or cancelled `pkexec` install stays in `Failed` and does not auto-retry every reconcile cycle. Check `service.log`, fix the root cause, and retry by waiting for the next rebuild or rebuilding a newer package.
- Interrupted installs:
  If updater state is left in `Installing` after a crash, restart, or interrupted privileged flow, the daemon recovers that state automatically instead of staying stuck and skipping future upstream checks.
- Package install/removal hooks:
  All three formats start the user service on install (DEB `postinst`, RPM `%post`, pacman `post_install`/`post_upgrade`) and best-effort stop/disable it on removal. If a user manager is unavailable, manual cleanup is still `systemctl --user disable --now codex-update-manager.service`.

## Crate Versioning

- Current updater crate version: `0.7.1` (`updater/Cargo.toml`).
- Current `codex-computer-use-linux` crate version: `0.2.3-linux-alpha1` (`computer-use-linux/Cargo.toml`). The enumeration tracks the standalone `agent-sh/computer-use-linux` crate (currently `0.2.3`); a mismatch means a sync between the two is pending.
- Bump `patch` for fixes, docs, and maintenance-only updates.
- Bump `minor` for compatible feature additions.
- Bump `major` for incompatible CLI, persisted-state, or install-flow changes.
- If the updater crate version changes, update `README.md` and `AGENTS.md` in the same change so the maintenance docs do not drift.

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

### Side-by-side rebuild candidate

```bash
./scripts/rebuild-candidate.sh             # build into codex-app-next/
./scripts/rebuild-candidate.sh --install   # promote candidate, keep backup
```

## Runtime Expectations

- `python3`, `7z`, `curl`, `unzip`, `tar`, `make`, and `g++` are required for `install.sh`.
- `install.sh` downloads and installs a managed Linux Node.js runtime into `codex-app/resources/node-runtime`; that runtime provides `node`, `npm`, and `npx` for native module rebuilds, Browser Use, the Codex CLI install/update flow, and local auto-update rebuilds.
- On apt-based systems, `scripts/install-deps.sh` can still bootstrap NodeSource Node.js 22 for users who want a system Node.js. `NODEJS_MAJOR=24 bash scripts/install-deps.sh` selects Node.js 24 instead.
- The packaged app still requires the Codex CLI at runtime: `codex` must exist in `PATH` or be set through `CODEX_CLI_PATH`, but the launcher attempts a best-effort automatic install on first run when the CLI is missing and `npm` is available.

## Packaging Notes

The native packages currently install:

- app files under `/opt/codex-desktop`
- launcher under `/usr/bin/codex-desktop`
- installed doctor under `/usr/bin/codex-desktop-doctor`
- updater binary under `/usr/bin/codex-update-manager`
- updater unit under `/usr/lib/systemd/user/codex-update-manager.service`
- update builder bundle under `/opt/codex-desktop/update-builder`
- desktop file under `/usr/share/applications/codex-desktop.desktop`
- icon under `/usr/share/icons/hicolor/256x256/apps/codex-desktop.png`
- polkit policy under `/usr/share/polkit-1/actions/com.github.ilysenko.codex-desktop-linux.update.policy`

The Debian builder uses `dpkg-deb --root-owner-group` so package ownership is correct.

The RPM builder stages the same app and updater payload into an RPM buildroot before invoking `rpmbuild`.

The pacman builder stages the same payload into a package root, expands `PKGBUILD.template`, writes `.PKGINFO`/`.MTREE`, and produces a `.pkg.tar.zst` archive for `pacman -U`.

## Preferred Validation After Changes

After editing installer or packaging logic, validate at least:

```bash
bash -n install.sh
bash -n scripts/lib/*.sh
bash -n launcher/start.sh.template
bash -n scripts/build-deb.sh
bash -n scripts/build-rpm.sh
bash -n scripts/build-pacman.sh
python3 -m py_compile packaging/linux/codex-desktop-doctor.py
node --test scripts/patch-linux-window-ui.test.js
node --test linux-features/*/test.js
bash tests/scripts_smoke.sh
cargo check -p codex-update-manager
cargo test -p codex-update-manager
cargo check -p codex-computer-use-linux
cargo test -p codex-computer-use-linux
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

For a containerised PR-equivalent run that mirrors the GitHub matrix:

```bash
./scripts/ci-local.sh pr        # core + deb + rpm + pacman
./scripts/ci-local.sh all       # pr + install-deps + nix + upstream
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
- Keep `scripts/lib/package-common.sh` aligned with all three builders when you add or remove packaged files from the shared runtime payload.
- Keep core Linux compatibility patches under `scripts/patches/`. Use `linux-features/` only for additions that should not ship to every Linux build, and never enable a feature in the committed `features.example.json`.
- Add new compositor support under `computer-use-linux/src/windowing/backends/` and register it in `windowing/registry.rs` instead of branching in `server.rs` or `diagnostics.rs`.
- When refreshing pinned hashes (Cargo, Node, DMG) for the Nix flake, use `scripts/ci/update-nix-hashes.sh` rather than editing `flake.nix` by hand.
