# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added

- A shared upstream DMG acceptance profile now produces the same structured
  decision for local installs, updater rebuilds, and scheduled CI. Scheduled
  rejections create one fingerprinted drift issue and supersede issues for
  older DMGs. Acceptance evaluates only the user's enabled Linux features and
  preserves the working app if any enabled feature drifts.
- Nix module configurations can select the opt-in `mcp-helper-reaper`
  feature. Its Rust helper is supplied by a reproducible Nix derivation and is
  not added to the default package closure.
- An opt-in `global-dictation` Linux feature enables the desktop app's global
  hold and toggle dictation shortcuts on X11 and Wayland. X11 uses Electron
  registration with a bounded modifier release watcher, while Wayland uses the
  XDG GlobalShortcuts and RemoteDesktop portals for press, release, and paste
  handling without direct input-device access or elevated permissions.

### Changed

- Remote mobile control now relies on the current upstream account-enrollment
  compatibility and Connections tab resolver instead of patching duplicate
  Linux-specific fallbacks into those paths.
- Remote notification hydration, replay, completed-item recovery, and remote
  terminal-status recovery are no longer part of the default Linux patch set and
  remain owned by the disabled-by-default `remote-mobile-control` feature.
- The `remote-mobile-control` feature no longer duplicates the generic Linux
  `remote_control` config preservation patch already owned by the core patch
  set.

### Fixed

- Remote mobile control now patches the current upstream webview chunks for
  feature sync, settings visibility, host enablement, and active conversation
  status. Revoking the final controller now also clears the current mobile setup
  state. The enablement bridge accepts the current bundle ordering where its log
  marker is declared after the request handler.
- Automated user-local updates no longer inherit or set developer overrides
  that could replace a running Electron app or bypass DMG acceptance. Manual
  and timer rebuilds now fail safely at promotion, transactional installs retain
  only the immediately previous app backup, and drift issue automation mutates
  only issues carrying its valid fingerprint marker.
- The Add Project folder picker is no longer parented to the Codex window on
  Linux X11. This avoids a GNOME Shell modal input grab that could lock desktop
  input and flood system logs, while preserving parented dialogs on Wayland,
  macOS, and Windows.
- Completed thread resume and turn submission once again use the upstream
  conversation ownership lifecycle. Removing the Linux-only ownership reset
  and submit-time reclaim avoids false ownership after failed turn starts and
  races between windows.
- Updater DMG downloads now publish crash-durable, content-addressed files only
  after a complete streamed download. Concurrent daemon and wrapper rebuilds
  cannot truncate or replace each other's input, and DMG hashing stays bounded
  in memory in both the updater and acceptance engine. A shared cache lease
  now bounds retained downloads to the state-referenced DMG and safely removes
  old hashes and temporary files abandoned by interrupted downloads.
- Linux settings search no longer shows unavailable macOS Dock icon controls or
  Suggested prompts results that do not render in the generated Linux settings
  page.
- Read Aloud no longer crashes the generated Linux desktop settings page after
  its shared controls moved from React hooks to class components. The feature's
  enabled state, voice setup actions, and speech pace now use the same
  class-based global-state bridge as the rest of that page.
- Cold launches no longer stall for a full second between acquiring the
  launcher lock and spawning Electron. The CLI version log line reads the
  probe result through command substitution, and the probe's watchdog
  subshell inherited that pipe: its `sleep 1` child survived the watchdog
  kill and held the pipe open until the sleep expired, so even a CLI that
  answers `--version` in ~50 ms blocked the launch path for ~1 s. The
  watchdog now runs detached from the caller's stdout/stderr, cutting that
  launch phase from ~1010 ms to ~74 ms and making the window (and GNOME's
  startup feedback) appear about a second sooner on every cold start.

### Changed

- Local app generation is transactional: `install.sh` builds and validates a
  sibling candidate before replacing `codex-app`, keeps the working app on
  rejected or inconclusive candidates, and uses atomic directory exchange plus
  a recovery journal so interruption cannot remove the canonical app path.
- Cold starts overlap the webview server boot with the rest of launcher
  startup and run the five bundled plugin cache syncs concurrently. The
  launcher now spawns the Python webview server, does CLI lookup and cache
  syncs while it boots, and only then waits for readiness and verifies the
  origin — still strictly before Electron launches. The shared bundled
  marketplace metadata is staged exactly once before the concurrent syncs
  instead of being rewritten inside each sync. Measured on a warm-cache cold
  start, the sync block drops from ~285 ms to ~110 ms and the webview wait
  from ~150 ms to ~35 ms, putting Electron spawn ~330 ms earlier.
- The launcher now passes `--disable-dev-shm-usage` to Electron only when
  `/dev/shm` is missing, not writable, or smaller than 1 GiB (the container
  case the flag exists for). On regular desktops Chromium's renderer/GPU
  shared-memory buffers stay in RAM-backed `/dev/shm` instead of disk-backed
  temp storage, which improves rendering performance. Override with
  `CODEX_ELECTRON_DISABLE_DEV_SHM_USAGE=auto|0|1`.
- The launcher now adds `--force-renderer-accessibility` only when an
  assistive technology is detected (Orca or brltty running, the GNOME
  screen-reader setting, the AT-SPI accessibility state that
  `codex-computer-use-linux setup` enables — `org.a11y.Status IsEnabled` or
  `toolkit-accessibility` — or the `GNOME_ACCESSIBILITY` /
  `QT_LINUX_ACCESSIBILITY_ALWAYS_ON` / `ACCESSIBILITY_ENABLED` env markers).
  Keeping the Chromium accessibility engine on in every renderer measurably
  slows the webview UI, and the WSLg and wayland-gpu profiles already
  skipped it for that reason. Session-bus probes are watchdog-capped at
  0.5 s so a broken bus cannot delay launch.
  `CODEX_FORCE_RENDERER_ACCESSIBILITY=1|0` still overrides the detection in
  both directions.
- Refactored ASAR patching internals so `scripts/patch-linux-window-ui.js` is a
  CLI-only entrypoint and patch descriptors/implementations live under
  `scripts/patches/`.

### Removed

- Removed legacy external Linux feature patch contracts:
  `entrypoints.patches`, `entrypoints.mainBundlePatch`, `.patches`/`.default`
  descriptor exports, the unsuffixed `extracted-app` phase, and
  `patch-linux-window-ui.js` module exports.

## [0.8.4] - 2026-06-20

### Added

- The `make setup-native` Linux feature picker can now present a GUI checklist
  (zenity or kdialog) instead of the terminal-only numbered prompt, pre-checked
  with the currently-enabled features. It falls back to the terminal picker when
  no dialog tool or display is available (headless/SSH/CI) or when
  `CODEX_BOOTSTRAP_NO_GUI=1` is set. The existing Python discovery/validation/
  write path is reused unchanged.
- An "Install updates when you close Codex" toggle in the Keybinds settings page
  (new "Updates" section). When on (the default, matching prior behavior), a
  ready update waits for Codex to close and then installs; when off, updates
  wait until you explicitly click Update. The toggle persists to
  `~/.config/<appId>/settings.json` as `codex-linux-auto-update-on-exit`, and
  `codex-update-manager` rereads it during reconciliation as an overlay over
  `config.toml` so the in-app preference wins without restarting the service.
- `codex-update-manager` can now track newer *wrapper* releases (this repo's own
  Linux features and fixes) in addition to the upstream Codex DMG. Opt in with
  `enable_wrapper_updates = true` in `config.toml`; a new `check-wrapper`
  subcommand and the `status --json` output report the detected wrapper commit
  and a changelog of what changed. Detection is git-based, requires the remote
  candidate to descend from the installed checkout, clears stale candidates
  when no update is currently valid, uses timeout-bound non-interactive git
  commands, prefers curated `CHANGELOG.md` sections newer than the installed
  version, and falls back to git commit subjects. Packaged frozen bundles
  without a git checkout degrade gracefully (no wrapper tracking; updates arrive
  via a normal package upgrade).
- The opt-in `codex-wrapper-updater` update action can ask which optional Linux
  features to enable before rebuilding. The picker reads the recorded candidate
  wrapper source, preserves unknown/private feature ids from the existing
  config, saves selections to `~/.config/<appId>/linux-features.json`, and
  skips without blocking the update when there is no display, no dialog tool, a
  dialog launch failure, or a cancellation.
- The opt-in `codex-wrapper-updater` toolbar now shows the installed short
  wrapper commit as a SHA chip when build metadata is available, and shows a
  disabled "dev mode" action when the installed commit is ahead of the tracked
  remote.
- Launcher rendering mode `CODEX_LINUX_RENDERING_MODE=wayland-gpu`, which
  forces native Wayland with GPU compositing enabled and skips forced renderer
  accessibility by default for Wayland desktops where XWayland or software
  rendering is unstable.
- New opt-in Linux feature `read-aloud-mcp` that stages a standalone Rust Read
  Aloud MCP plugin with `doctor`, `read_aloud`, and `stop` tools. The MCP server
  reuses the Kokoro runner/model configuration from the Read Aloud UI feature
  and stays out of the default install unless enabled in
  `linux-features/features.json`. When bundled, the feature patches Codex's
  bundled plugin registry so the app keeps `read-aloud` installed, and the
  launcher syncs the plugin cache so new Codex windows expose the MCP tools
  through the same auto-install path as Computer Use.
- The Home Manager and NixOS modules gained a
  `programs.codexDesktopLinux.cliPackage` option that wraps the installed Codex
  Desktop launcher (and its `.desktop` entry) so it always starts with
  `CODEX_CLI_PATH` pointing at the chosen CLI. Because the path is baked into the
  launcher instead of exported as a session variable, Codex Desktop reliably
  finds the Codex CLI regardless of how it is launched (graphical autostart,
  application launcher, terminal, or warm-start handoff), even when the Nix
  profile is not on the graphical session `PATH`, and the change takes effect on
  the next app launch with no re-login. When unset it falls back to
  `remoteControl.package` if the remote-control service is enabled. This avoids
  the `Unable to locate the Codex CLI binary. Set CODEX_CLI_PATH ...` startup
  failure.

### Fixed

- `codex-update-manager` no longer depends on the `fs4` crate for updater check
  serialization. The updater now uses `std::fs::File::try_lock`, preserves the
  existing non-blocking `check.lock` behavior when another check is active, and
  adds regression coverage for `WouldBlock` lock contention semantics.
- The avatar overlay is focusable on Linux so inline pet reply inputs can accept
  keyboard input after being clicked, while still staying above the main Codex
  window as an overlay.
- Plugin marketplace browsing now preserves upstream's `remote_plugin`
  feature sync on Linux, so current app servers can load the remote OpenAI
  curated catalog instead of falling back to only locally installed plugins.
- The opt-in `remote-mobile-control` cold-start hook no longer removes
  `~/.local/bin/codex` when the launcher is actively using that symlink as
  `CODEX_CLI_PATH`.
- The in-app updater no longer quits into a broken `pkexec` install path when a
  minimal window-manager session has no graphical polkit authentication agent;
  it keeps the rebuilt package ready and reports a terminal `sudo
  /usr/bin/codex-update-manager ... --path ...` command instead.
- The opt-in Linux AppShots bare-modifier shortcuts now require left and right
  modifier keycodes, preventing a fast double-tap on one physical Alt or Shift
  key from opening AppShots.
- The wrapper updater no longer offers a "downgrade as update" when the
  installed build is ahead of the tracked remote. Detection records dev mode
  when the candidate does not descend from the installed commit, clears stale
  wrapper candidates when detection is not valid, and the apply path refuses to
  run while dev mode is recorded.
- Nix builds now rewrite crates.io API crate download URLs to the static
  crates.io CDN path, avoiding PR-only CI failures from crates.io API 403s
  while preserving the same lockfile checksums.
- Bundled Browser plugin staging now preserves local `file://` target support
  advertised by the Browser plugin while keeping remote file hosts and `data:`
  URLs blocked by the URL policy.
- `codex-update-manager` now prunes unreferenced updater workspaces under `~/.cache/codex-update-manager/workspaces`, removing heavy build artifacts (`builder/`, `codex-app/`, `dist/`) while preserving lightweight diagnostics such as `logs/` and rebuild reports.
- The Chrome native-messaging host now evicts stale browser clients when a newer Codex browser client connects, preventing old Node REPL sessions from repeatedly reattaching CDP and driving extension service-worker CPU.
- The bundled Chrome plugin is now auto-installed during app startup, matching Browser Use, so the plugin page no longer falls back to an install button after restart when the Linux native host is already staged.
- Nix builds, installer apps, and dev shells now use modern `7zz`, and the installer dependency check accepts `7zz` without requiring a separate legacy `7z` binary.
- Codex Desktop no longer removes user-enabled `remote_control = true` from the local Linux config before starting the app server.
- Linux webview bundles no longer ask current Codex CLI app servers to enable unsupported feature flags, avoiding connector authentication sync errors.
- Native Linux launches now keep GPU compositing enabled by default, avoiding sustained Electron GPU-process CPU usage on some X11/NVIDIA desktops. Users who still need the old flicker workaround can opt in with `CODEX_ELECTRON_DISABLE_GPU_COMPOSITING=1`.
- Linux Keybinds settings now show current upstream shortcut defaults for Quick Chat, alternate New Chat, search, terminal, browser, and thread actions, and no longer lists non-dispatchable runtime rows.

## [0.8.0] - 2026-05-16

### Added

- New opt-in Linux feature `remote-control-ui` that patches upstream webview bundles to expose the `remote_control` / Codex mobile UI surfaces on Linux without faking backend state, MFA, or connected-client data.
- `linux-features` can now contribute opt-in `webview-asset` patch descriptors in addition to main-bundle patches, so feature-scoped Linux UI experiments can hook hashed webview assets without being promoted into the core patch registry.

## [0.7.1] - 2026-05-06

### Fixed

- Local auto-update rebuilds and package builds now find the Rust toolchain reliably when `cargo` is installed via `rustup` under `~/.cargo/bin`, even if the `codex-update-manager` user service or packaging scripts inherit a reduced `PATH`.

### Added

- Regression coverage for the build-environment fix: updater path construction now has a unit test for `~/.cargo/bin`, and packaging helpers resolve `cargo` through the same fallback path used by Linux Computer Use staging.

## [0.7.0] - 2026-05-04

### Added

- Linux Computer Use plugin now exposes accessibility actions and editable-value setting via a new `perform_action` MCP tool. `element_index` selections resolve back to cached AT-SPI object references so actions and value writes target the same node as a click.
- UI-driven Linux app update flow: when an update is rebuilt and ready, the in-app updater control can request install. The app exits, the user service installs the package, and the launcher relaunches `/usr/bin/codex-desktop` after the update lands. Backed by a new `codex-update-manager install-ready` subcommand and a `scripts/rebuild-candidate.sh` helper packaged into the update-builder bundle.
- NixOS launcher exposes Electron GL/EGL libraries and primary-runtime native libraries via `LD_LIBRARY_PATH`, so the bundled Python/Node payloads (Pillow, NumPy, sharp, canvas) load on stock NixOS.
- The installer now bundles a managed Linux Node.js 22.22 runtime into `codex-app/resources/node-runtime`; packaged launches and local auto-update rebuilds use it before any system, nvm, asdf, or manually installed Node.js.

### Changed

- `get_app_state(window_id=...)` and `get_app_state(pid=...)` prefer exact PID/window-root matching when resolving the AT-SPI tree.
- `click(element_index=...)` falls back to the primary AT-SPI action when the element exposes no usable bounds.
- `app.asar` repack is now reproducible: file ordering is sorted and `node-pty/build/Makefile` (which embeds absolute build paths) is removed before packing.
- Native packages no longer hard-depend on distro `nodejs`/`npm`; the bundled managed Node.js runtime covers Codex CLI install/update flows, Browser Use, and updater rebuilds. This lets users with `nvm`, asdf, Volta, or nodejs.org tarball installs install the native package cleanly. Fixes #104.

### Fixed

- AT-SPI sentinel bounds no longer trigger bogus portal clicks on hidden or off-screen nodes.
- Linux quit now bypasses the close-to-tray gate so the app actually exits instead of getting trapped in the tray.
- Keybinds settings index patch tolerates upstream minified variable-name drift; the route map is detected via a `(0,X.lazy)` lookahead instead of hard-coded `c_e` / `Xge` / `Zge` names.
- NixOS-installed `start.sh` shebang is patched to a nix-store `bash` so the launcher actually runs on systems without `/bin/bash`.
- Native packages now always stage `scripts/lib/node-runtime.sh` into `/opt/codex-desktop/update-builder`, so local auto-update rebuilds can source the managed Node runtime helper instead of failing before package generation.

## [0.6.2] - 2026-05-01

### Changed

- Missing Codex CLI recovery is now exposed as an explicit `cli_status: NotInstalled` state in updater status output and persisted state, instead of overloading `Unknown`.
- Automatic installation of a missing Codex CLI is now documented and enforced as launcher-scoped behavior; the daemon and `codex-update-manager status` only report and notify when the dependency is missing.
- The Computer Use in-app UI surface is now opt-in. The MCP backend still registers by default; the UI controls are enabled when the user sets `CODEX_LINUX_ENABLE_COMPUTER_USE_UI=1` at build time, or persists `"codex-linux-computer-use-ui-enabled": true` in `~/.config/codex-desktop/settings.json` (also honoured by the `codex-update-manager` user service across rebuilds). Existing users who relied on the UI being on by default need to set one of these once.

### Added

- New `isComputerUseUiEnabled()` helper in `scripts/patch-linux-window-ui.js` that reads both the env var and the persisted settings flag.
- Smoke test `test_linux_computer_use_ui_opt_in_smoke` covering all three branches (default off, env-var on, settings-flag on).

### Fixed

- Launcher error messages now distinguish between a CLI that is missing versus an automatic installation attempt that failed, clarifying the supported recovery path.
- Missing-CLI desktop notifications now key off the explicit `NotInstalled` state instead of inferring absence from cleared fields.

## [0.6.1] - 2026-04-30

### Added

- New GitHub Actions workflow `upstream-build-app.yml` that builds `make build-app` against the real upstream `Codex.dmg`, caches the DMG between runs when upstream metadata is unchanged, and records the tested DMG URL, `Last-Modified`, `ETag`, `Content-Length`, `SHA-256`, size, and test timestamp in the job summary plus an uploaded JSON artifact.

### Changed

- Script smoke tests now assert that the upstream-DMG CI workflow continues to track DMG provenance and cache behavior, reducing the chance that future CI edits silently drop reproducibility metadata for upstream build validation.

## [0.6.0] - 2026-04-30

### Added

- Packaged GUI launches can now prompt to install a missing Codex CLI through `codex-update-manager`, preferring `kdialog` on KDE/Plasma, then `zenity`, and finally an actionable desktop notification when no dialog helper is available.
- `scripts/install-deps.sh` now installs one desktop-appropriate GUI dialog helper so first-run CLI installation works cleanly outside a terminal.
- GitHub Actions CI now runs Rust checks, script smoke tests, and real Debian, RPM, and pacman package build validations with job summaries.

### Changed

- `make build-app` now defers to `install.sh` when no `DMG=...` override is provided, so fresh checkouts can reuse or download `Codex.dmg` through the installer's normal flow instead of failing on a missing local cache path.
- Electron runtime downloads are now cached under `~/.cache/codex-desktop/electron` and resume interrupted transfers, reducing repeated `make build-app` rebuild time.
- Launcher CLI preflight now uses cached local CLI state on the fast path, leaving heavier `codex --version` and registry refresh work to the updater when the cache is stale or invalid.

### Fixed

- `make build-app` now rebuilds `better-sqlite3` with an Electron 41-compatible release when the upstream DMG bundles an older native module source.
- `codex-update-manager` now refreshes CLI status when the daemon starts and shows a desktop notification if the Codex CLI is missing, so package installs do not rely on the user manually checking updater state to understand why Codex Desktop cannot launch cleanly.
- When the Codex CLI is missing, terminal launches still prompt before installation and GUI launches now have a matching fallback path instead of failing with only a passive notification.


## [0.5.0] - 2026-04-30

### Added

- Linux Computer Use plugin and native Rust MCP backend `codex-computer-use-linux`. Provides AT-SPI accessibility-tree access, screenshot capture through GNOME Shell or XDG Desktop Portal, and `ydotool` input synthesis. Plugin is gated by OpenAI's per-account Statsig rollout (`computerUse` feature flag) — installing the package does not by itself make Computer Use appear in the Codex UI.
- Linux keybinds settings page injected into the Codex webview, with persistent toggles for the compact prompt window, system tray, and warm-start handoff.
- Warm-start handoff: launching the app while another instance is already running now sends the launch action over a Unix-domain socket (`launch-action.sock`) and exits, instead of starting a fresh Electron. New launcher CLI flags `--new-chat`, `--quick-chat`, `--prompt-chat`, `--hotkey-window` route through that path.
- Linux system tray with platform-gated guard, single-instance lock, and second-instance window focus through Electron's `requestSingleInstanceLock` / `second-instance` event.
- Polkit policy `com.github.ilysenko.codex-desktop-linux.update.policy` so privileged updater installs use the desktop authentication agent (`pkexec --disable-internal-agent`) instead of falling back to a textual prompt.
- openSUSE / zypper support across `scripts/install-deps.sh`, the `make install` target, and the updater's RPM install path.
- Browser Use bundled plugin resources are now installed alongside the Linux app, with launcher-side environment hydration for `CODEX_ELECTRON_RESOURCES_PATH`, `CODEX_BROWSER_USE_NODE_PATH`, and `CODEX_NODE_REPL_PATH`.
- Apt Node bootstrap: `install-deps.sh` prefers a compatible distro `nodejs`/`npm` candidate and otherwise installs Node.js 22 from NodeSource. CI matrix validates the bootstrap on Ubuntu 22.04, Ubuntu 24.04, and Debian 12.
- Electron version is now auto-detected from upstream DMG metadata (`Electron Framework.framework/Versions/A/Resources/Info.plist` then `app.asar` `package.json`); the pinned `41.3.0` remains as the fallback when detection fails.
- `codex-update-manager check-now --if-stale` subcommand and a launch-time best-effort check that skips when the last successful upstream check is still fresh.
- New updater subcommand `prompt-install-cli` plus persisted-state field `cli_last_verified_at` to support GUI-launched CLI install prompts and a cached-status fast path.

### Changed

- ASAR patcher refactored into independent fail-soft patch functions with regex-driven needles instead of hard-coded minified variable names. Added Node test suite (`scripts/patch-linux-window-ui.test.js`).
- DEB / RPM / pacman packages now declare `nodejs (>= 20)` and pull in `polkit` (or `policykit-1` on older Debian/Ubuntu) plus `pkexec`, so the privileged install flow works out of the box on every supported distro.
- Wayland sessions with `DISPLAY` available now default to `--ozone-platform=x11` for Electron popup positioning compatibility; pure Wayland sessions keep `--ozone-platform-hint=auto`.
- RPM `%preun` only stops and disables the user updater service on package erase (`$1 -eq 0`), not on upgrade. Prevents the long-standing footgun where every upgrade left the updater service stopped until the next user login.
- RPM staging now uses the shared `stage_common_package_files` / `stage_update_builder_bundle` helpers, fixing missing `.codex-linux/codex-packaged-runtime.sh` and an incomplete `update-builder/` payload in shipped RPMs.
- Updater check serialization moved to a kernel-backed file lock (`flock(2)` via the `fs4` crate). A non-graceful exit no longer leaves a stale sentinel file that silences future upstream checks.
- Webview server is now adopted and reused across launches instead of `pkill`-and-restart, and explicitly binds to `127.0.0.1` only.

### Fixed

- Failed `pkexec` authentication (exit code `126` or `127`) now keeps the candidate `ReadyToInstall` for retry on the next app exit, instead of marking the candidate permanently `Failed` and surfacing repeat prompts every reconcile cycle.
- RPM installs now reject non-newer package versions, matching the existing DEB and pacman downgrade guards.
- Linux browser annotation screenshots now use the stored anchor geometry and render only the selected marker, fixing misaligned and over-cluttered annotation captures.
- The Linux settings persistence patch now warns and skips instead of throwing when its needle is missing on a fresh upstream bundle, so the install pipeline no longer aborts on a bundle-shape change.
- DEB packages now alternate-depend on `pkexec | policykit-1` and `polkitd | policykit-1`, so installs succeed on Ubuntu 22.04 and Mint 21.x where the polkit binaries still ship inside `policykit-1`.

## [0.4.2] - 2026-04-23

### Changed

- `make build-app` now defers to `install.sh` when no `DMG=...` override is provided, so fresh checkouts can reuse or download `Codex.dmg` through the installer's normal flow instead of failing on a missing local cache path.
- Launcher CLI preflight now uses `install.sh` to decide when missing-CLI installation is allowed, instead of always enabling the updater's auto-install path up front.

### Fixed

- `codex-update-manager` now refreshes CLI status when the daemon starts and shows a desktop notification if the Codex CLI is missing, so package installs do not rely on the user manually checking updater state to understand why Codex Desktop cannot launch cleanly.
- When the Codex CLI is missing and the launcher starts from an interactive terminal, it now prompts before attempting installation instead of requiring the missing-CLI install behavior to be forced implicitly.

## [0.4.1] - 2026-04-19

### Added

- Debian `postinst` maintainer script for `codex-update-manager` so package installs and upgrades can reload user managers and bring the updater service back online.

### Changed

- Native package install and upgrade flows now make a best-effort attempt to start or re-enable `codex-update-manager.service` for active user sessions across Debian, RPM, and pacman packaging paths.
- `codex-update-manager status` now refreshes cached CLI status before printing and surfaces the current CLI error message in plain-text output.
- Native package maintainer hooks now share a single `codex-update-manager-user-service.sh` helper for `systemd --user` reload, start, enable, stop, and disable behavior across Debian, RPM, and pacman packaging paths.
- Packaging hook scripts now use explicit `shellcheck source=...` directives when sourcing the installed user-service helper so static linting can resolve the shared helper path cleanly.

### Fixed

- Restored the final success notification after automatic installs by replaying the `Installed` notification when the updater recovers from an interrupted `Installing` state or daemon restart.
- Deduplicated `Installed` notifications so successful recovery does not spam repeated desktop toasts.
- Hardened Codex CLI version-check caching and error handling so stale cached data does not mask a changed local CLI version or a failed version read.
- `PersistedState::save` now replaces `state.json` atomically with a temporary file and rename, so ad-hoc `codex-update-manager status` refreshes cannot leave partially written updater state behind during concurrent access.

## [0.4.0] - 2026-04-13

### Added

- Automatic Codex CLI installation during launcher preflight when the CLI is missing, exposed through the updater `cli-preflight --allow-install-missing` flow.
- Linux `Open in File Manager` integration in the patched app bundle.
- Launcher-side webview origin validation before Electron starts, with clearer diagnostics when port `5175` serves the wrong content or exits early.
- Expanded smoke coverage for Linux launcher generation and UI patching behavior.

### Changed

- Linux ASAR patching now also adjusts shell behavior, window icon handling, and default opaque window settings on Linux when the user has not explicitly chosen a translucent sidebar preference yet.
- Desktop notifications now resolve icons from packaged, system, and repository locations and send them as file URIs for better desktop-environment compatibility.
- `scripts/install-deps.sh` now owns the `7zz` bootstrap flow, probes pinned upstream tarballs newest-first with `HEAD` checks, and installs to `~/.local/bin` by default unless `SEVENZIP_SYSTEM_INSTALL=1`.
- Updated bundled dependencies and metadata: Electron `40.8.5`, `tokio` `1.51.1`, `windows-sys` `0.61.2`, and `codex-update-manager` `0.4.0`.

### Fixed

- Avoid Linux startup failures caused by stale minified symbol assumptions in the window icon patch (`t.join is not a function`).
- Make updater SHA-256 formatting deterministic so downloaded DMGs produce stable candidate versions and comparisons.
- Prevent `bootstrap_7zz` from warning on unsupported architectures when a working `7zz` or a new enough system `7z` is already available.
- Keep the Linux file manager patch fail-soft when upstream minified bundles drift while still validating that the expected Linux hooks were actually applied.

## [0.3.2] - 2026-04-07

### Fixed

- Fix transparent background flickering on Linux when moving the window or hovering over the sidebar. The upstream Electron app sets `backgroundColor: '#00000000'` (fully transparent) for non-Windows platforms, relying on macOS vibrancy. Linux has no compositor equivalent, causing the desktop to bleed through. The main bundle is now patched to use opaque theme-aware colors (`#000000` dark / `#f9f9f9` light) on Linux.
- Replace transparent startup background in `index.html` with `#1e1e1e` to prevent flash of transparency during app load.

## [0.3.1] - 2026-04-07

### Added

- CLI preflight: before Electron launches, the updater verifies the installed Codex CLI and updates it if a newer npm version is available. Uses a 1-hour cooldown for registry checks and falls back to `npm install -g --prefix ~/.local` if global install fails. Warns instead of blocking app launch on failure.
- Interrupted install recovery: if updater state is left in `Installing` after a crash or restart, the daemon now recovers automatically instead of getting stuck.
- Notification icon resolution chain: bundled, system, repo, then fallback name.
- Makefile targets: `run-app`, `service-enable`, `service-status`.

### Fixed

- `npm install -g` now falls back to `--prefix ~/.local` when global install requires root.

## [0.2.1] - 2026-04-02

### Added

- Native Arch Linux (pacman) package support for updater and install flow.
- Updater builder bundle fix for Arch rebuilds.
- User-local desktop integration (desktop entry, icon, systemd service for non-root installs).

### Fixed

- GPU compositing flickering: added `--disable-gpu-compositing` Electron flag.
- Recoverable 7z warnings handled; added `--fresh` / `--reuse-dmg` flags to installer.
- Graceful patching in `patch-linux-window-ui.js` (warn + skip instead of throw).

## [0.2.0] - 2026-03-27

### Added

- Fedora/RPM packaging support and update manager RPM integration.
- `scripts/install-deps.sh` for automated dependency installation.
- Shared native builders and hardened launcher startup.
- Packaged runtime helper (`codex-packaged-runtime.sh`).
- Failed privileged install no longer auto-retries every reconcile cycle.

### Fixed

- Privilege escalation uses installed binary for self-update.
- Pending install recovery from failed state.
- NVM toolchain preferred for service rebuilds.

## [0.1.0] - 2026-03-20

### Added

- Initial release: automated macOS DMG to Linux Electron app conversion.
- Debian (`.deb`) packaging.
- `codex-update-manager` daemon with systemd user service.
- Upstream DMG detection, local rebuild, and pending install flow.
- Nix flake for NixOS support.
- Wayland and X11 support with GPU error workarounds.
