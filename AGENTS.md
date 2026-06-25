# AGENTS.md

## Purpose

This repository adapts the official macOS Codex Desktop DMG into a runnable
Linux app, packages that app as native `.deb`, `.rpm`, pacman, and AppImage
artifacts, and ships a local Rust update manager that can rebuild future Linux
packages from newer upstream DMGs.

The current flow is:

1. `install.sh` downloads or extracts `Codex.dmg`.
2. The app `asar` is extracted and patched through the core patch registry plus
   any enabled `linux-features/` descriptors.
3. Native Node modules are rebuilt for Linux and a matching Linux Electron
   runtime is downloaded.
4. Bundled resources are staged: Browser Use, Chrome native messaging, Linux
   Computer Use, and opt-in feature resources such as Read Aloud when enabled.
5. Declarative Linux feature resources/runtime hooks and legacy `stage.sh`
   hooks are staged into `codex-app/`.
6. `install.sh` writes the generated Linux launcher into `codex-app/start.sh`.
7. Package builders turn `codex-app/` into `.deb`, `.rpm`, pacman, or AppImage
   artifacts.
8. Native packages include `codex-update-manager` and an update-builder bundle
   so local auto-updates rebuild future packages with the same feature config.

## Maintainer Rules

- Keep core behavior focused on the app launching and working for most Linux
  users. Experimental, workflow-specific, editor-specific, browser-specific,
  distro-specific, or minority-use integrations belong in `linux-features/` and
  must be disabled by default.
- If an optional feature needs a new core touchpoint, add the smallest generic
  extension point to core, then keep feature-specific logic inside that feature
  directory.
- Do not enable optional features in committed config. `linux-features/features.json`
  is local and gitignored; `features.example.json` stays empty.
- Each repository feature under `linux-features/<id>/` and each local feature
  under `linux-features/local/<id>/` must include a `README.md` next to
  `feature.json`.
- Do not manually patch generated output such as `codex-app/start.sh` for a
  durable fix. Change the source template, build helper, feature, or patch
  descriptor and regenerate.
- Treat updater, package builder, launcher, and feature framework changes as
  cross-format changes unless the code explicitly scopes them to one package
  format or desktop target.

## Source Of Truth

### Repo Orchestration

- `install.sh`
  Top-level installer entrypoint. It sources `scripts/lib/*.sh`, keeps the
  high-level build sequence small, and emits `codex-app/start.sh` from the
  launcher template plus an install-time identity prelude.
- `Makefile`
  Convenience targets for setup, fresh/build/install/package flows, native
  package autodetection, dev side-by-side app identities, AppImage, cleanup,
  and bootstrap workflows. Important targets include `setup-native`,
  `bootstrap-native`, `install-native`, `update-native`, `appimage`, `package`,
  and `install`, plus granular helpers (`build-app`, `build-app-fresh`,
  `rebuild`, `rebuild-install`, `rebuild-next`, `build-dev-app`, `run-app`,
  `run-dev-app`, `inspect-upstream`, `build-updater`, `service-enable`,
  `service-status`, `check`, `test`, `clean-dist`, `clean-state`).
- `scripts/bootstrap-wizard.sh`
  Guided native setup/update helper. It can discover Linux features, edit
  feature config, validate feature relationships, install native packages, and
  perform explicit feature-owned cleanup.
- `Cargo.toml`
  Workspace root. Members currently are `computer-use-linux`,
  `read-aloud-linux`, and `updater`.
- `flake.nix` / `flake.lock`
  Nix flake that pins upstream DMG, Cargo dependency, and Node dependency
  hashes. Use `scripts/ci/update-nix-hashes.sh` to refresh pins.
- `nix/`
  Nix integration modules: `home-manager-module.nix`, `nixos-module.nix`, and
  `native-modules/` rebuild support for the flake.
- `.devcontainer/devcontainer.json` / `.devcontainer/Dockerfile`
  Generic repo build/test container with Rust, Node 22/npm, packaging tools,
  `rustfmt`, and `clippy`. Prefer it before asking users to install host
  Rust/toolchain dependencies.

### Launcher

- `launcher/start.sh.template`
  Runtime launcher body. Edit this for launcher behavior: webview server
  lifecycle, warm-start handoff, CLI preflight, GUI prompts, URL-scheme
  handling, runtime Linux feature hooks, bundled plugin cache sync, and
  process/liveness behavior. Single-instance enforcement uses an `flock`
  launcher lock (`$APP_STATE_DIR/launcher.lock`, wait tunable via
  `CODEX_LAUNCHER_LOCK_WAIT_SECONDS`) plus a serialized bootstrap critical
  section around detection/spawn/`app.pid`, and a `/proc`-based running-app scan
  filtered by `CODEX_LINUX_INSTANCE_ID` so duplicate launches collapse to the
  live instance while side-by-side identities stay independent.
- `launcher/webview-server.py`
  Standalone Python HTTP server for the local webview assets, serving them with
  explicit no-store/no-cache headers. Started and supervised by the launcher.
- `packaging/linux/codex-packaged-runtime.sh`
  Native-package-only runtime helper loaded optionally by the launcher. Keep
  distro/native-package specifics here so the generic launcher stays portable.
- `packaging/appimage/codex-appimage-runtime.sh`
  AppImage-only runtime helper.

### Build Pipeline (`scripts/lib/`)

- `install-helpers.sh`
  Argument parsing, dependency checks, identity validation, install-dir
  preparation, logging/color helpers, and shell quoting.
- `build-info.sh` / `build-info.js`
  Build provenance capture. Sourced by `install.sh` to record git commit, DMG
  source, upstream/Electron versions, enabled feature ids, and target context
  into the generated `codex-app/` so installs and rebuilds are traceable.
- `node-runtime.sh`
  Managed Linux Node.js runtime download and SHA256 validation. The launcher,
  Browser Use, native module rebuilds, Codex CLI install/update flow, and
  updater rebuilds use this runtime.
- `process-detection.sh`
  Running-app detection used to avoid overwriting a live install.
- `dmg.sh`
  DMG download/extraction and upstream Electron-version detection.
- `native-modules.sh`
  Linux rebuild of native modules such as `better-sqlite3` and `node-pty`, plus
  Electron runtime download/cache.
- `asar-patch.sh`
  Drives `scripts/patch-linux-window-ui.js` over the extracted upstream app.
- `webview-install.sh`
  Webview asset extraction and final `codex-app/` layout.
- `bundled-plugins.sh`
  Stages bundled Browser Use, Chrome, Linux Computer Use resources, native
  helper binaries, and marketplace metadata. Optional features can stage
  additional bundled-style resources, such as Read Aloud.
- `linux-features.sh` / `linux-features.js`
  Opt-in Linux feature framework. The JS side discovers repository and local
  features, validates manifests, dependencies, conflicts, entrypoints, resource
  modes, runtime hooks, package hooks, and exposes patch descriptors. The shell
  side runs feature staging in the install pipeline.
- `package-common.sh`
  Shared package-builder helpers: versioning, payload staging, permission
  normalization, package hook discovery/execution, update-builder staging, and
  user service helper installation.
- `linux-target-context.js`
  Build-time target detection for patch descriptors. Reads `/etc/os-release`
  and env overrides, then exposes helpers such as `matchesId()`,
  `packageFormatIs()`, `packageManagerIs()`, `desktopMatches()`, and
  `versionAtLeast()`.
- `patch-report.js` / `rebuild-report.sh`
  Structured patch and rebuild reports used by upstream drift validation and
  rebuild-candidate diagnostics.
- `patch-chrome-plugin.js` / `linux-update-bridge-patch.js`
  Focused patch helpers for Chrome plugin Linux compatibility and the in-app
  updater bridge.

### Patch Registry (`scripts/patches/`)

- `scripts/patch-linux-window-ui.js`
  ASAR patcher CLI and compatibility export surface.
- `scripts/patches/core/**/patch.js`
  Source of truth for shipped Linux compatibility patch descriptors. New core
  patches should be added as descriptors here, grouped under `all-linux/`,
  `distro/`, `package/`, or `desktop/`. Today all shipped descriptors live under
  `all-linux/` (split into `extracted-app/`, `main-process/`, and `webview/`);
  the `distro/`, `package/`, and `desktop/` buckets are README-only placeholders
  reserved for future target-scoped patches.
- `scripts/patches/engine.js`
  Discovers descriptors, normalizes them, checks duplicate ids, applies target
  filters, and records patch report metadata.
- `scripts/patches/registry.js`
  Orchestrates discovered core descriptors plus enabled Linux feature
  descriptors.
- `scripts/patches/*.js`
  Shared implementation helpers and compatibility modules used by descriptors.
  Do not treat these as the preferred location for new shipped patch entries.
- `scripts/patches/core/README.md`
  Descriptor contract. Read it before adding or moving core patches.
- `scripts/patch-linux-window-ui.test.js`
  Node test suite for the patcher.
- `scripts/ci/validate-patch-report.js`
  CI guard for required upstream patches. Mark a descriptor as required only
  when its absence should block upstream-build CI.

### Linux Features (`linux-features/`)

`linux-features/` is the extension boundary for optional Linux integrations.
Detailed contract: `linux-features/README.md` and
`docs/linux-features-architecture.md`.

- Repository features live under `linux-features/<feature-id>/`.
- User-local/private features live under `linux-features/local/<feature-id>/`;
  this directory is gitignored.
- `features.example.json` is the committed empty template. The active
  `features.json` is gitignored and lists enabled ids.
- `CODEX_LINUX_FEATURES_ROOT` and `CODEX_LINUX_FEATURES_CONFIG` can override
  feature discovery/config paths for setup and build flows.
- Feature ids use one namespace across repository and local features. Local
  features cannot shadow repository features.
- `defaultEnabled: true` is rejected. Optional features are always opt-in.
- Every feature must have `feature.json` and `README.md`.
- Prefer `entrypoints.patchDescriptors` for new patching. Legacy
  `mainBundlePatch` and `stageHook` remain supported for existing features.
- Manifest `requires` and `conflicts` are validated by setup, installer,
  patcher, and package builders.
- Declarative `resources`, `runtimeHooks`, and `packageHooks` are preferred
  over ad hoc staging whenever possible.
- Runtime hook types are `env`, `prelaunch`, `electronArgs`, `coldStart`, and
  `afterExit`; they are staged under `codex-app/.codex-linux/`.
- Declarative resources and runtime hooks are tracked in
  `.codex-linux/linux-features-staged.json` and removed on the next install
  when their owning feature is disabled.
- Declarative resource targets must stay inside the app directory and cannot
  target the app root. Mode values must be quoted octal strings such as
  `"0644"` or `"0755"`; numeric JSON modes are rejected. Declared modes are
  preserved through native packaging.
- Avoid writing user-home files from `stage.sh`. Stage sources with resources
  and copy them from runtime hooks, where real user paths are available.
- `packageHooks` run during native package staging with package/app root
  environment variables. They must be idempotent and narrowly scoped.
- Native package update-builder bundles preserve the enabled feature id list and
  configured feature root, including local features, so local auto-updates keep
  the same opt-in features.

Use `linux-features/` for anything useful to some users but not mandatory for
the baseline Linux app. If a feature needs more power, add a generic hook or
extension point to core rather than moving the feature itself into core.

### Native Packaging

- `scripts/build-deb.sh`
  Builds `.deb` from an already-generated `codex-app/`.
- `scripts/build-rpm.sh`
  Builds `.rpm` from `codex-app/`.
- `scripts/build-pacman.sh`
  Builds `.pkg.tar.zst` from `codex-app/`.
- `scripts/build-appimage.sh`
  Builds an AppImage using `packaging/appimage/`.
- `packaging/linux/`
  Debian control files, RPM spec, pacman `PKGBUILD.template`/install hooks,
  desktop entry, icon policy, Polkit policy, packaged runtime helper, shared
  user-service maintainer-script helper, and `codex-desktop-entry-doctor.sh`
  (desktop-entry validation/repair run from package hooks).
- `packaging/appimage/`
  AppImage `AppRun`, desktop file, and runtime helper.

The native package payload installs the app under `/opt/codex-desktop`, the
launcher under `/usr/bin/codex-desktop`, the updater under
`/usr/bin/codex-update-manager`, the user service under
`/usr/lib/systemd/user/`, desktop/icon metadata under `/usr/share/`, and an
update-builder bundle under `/opt/codex-desktop/update-builder`.

### Updater (`updater/`)

- `updater/src/main.rs` / `app.rs` / `cli.rs`
  Binary entrypoint, top-level dispatcher, and `clap` CLI.
- `builder.rs`
  Drives the packaged update-builder bundle to rebuild packages from newer
  upstream DMGs.
- `upstream.rs`
  Upstream DMG polling, ETag cache, download, and hash verification.
- `wrapper.rs` / `wrapper_apply.rs` / `changelog.rs` / `feature_picker.rs`
  Wrapper-repo (this repository) self-update path, separate from the upstream
  DMG flow: detect pending Linux feature/patch updates from the wrapper repo,
  surface CHANGELOG entries and an interactive feature picker for the in-app
  Update button, then rebuild and reinstall for packaged and user-local installs.
- `cache_cleanup.rs`
  Cleanup of updater-managed download/rebuild workspaces under the cache dir.
- `install.rs` / `install_rollback.rs` / `rollback.rs`
  Privileged package install, format-specific install/rollback commands, and
  manual rollback orchestration.
- `codex_cli.rs`
  Codex CLI discovery, version reads, npm-registry preflight checks, and
  install/update flow used by launcher preflight.
- `state.rs` / `config.rs`
  Persisted updater state and runtime config/path resolution.
- `liveness.rs` / `notify.rs` / `logging.rs`
  Electron liveness, desktop notifications, and service logging.
- `test_util.rs`
  Shared test helpers, including serialization of env-mutating tests.

The updater runs unprivileged and only escalates through `pkexec` for
`install-deb`, `install-rpm`, or `install-pacman`.

### Computer Use, Browser, And Read Aloud

- `computer-use-linux/`
  Rust crate for Linux Computer Use MCP, Chrome native messaging host, and the
  COSMIC helper. Beyond windowing it covers input (`abs_pointer.rs` uinput
  absolute pointer), capture (`screenshot.rs`), accessibility (`atspi_tree.rs`),
  terminal (`terminal.rs`), identity (`identity.rs`), and desktop integrations
  (`gnome_extension.rs`, `cosmic_helper.rs`, `remote_desktop.rs`). Binaries live
  in `src/bin/` (`codex-chrome-extension-host.rs`, `codex-computer-use-cosmic.rs`).
- `computer-use-linux/src/windowing/`
  Window backend registry, target resolution, focus verification, and
  backend-specific implementations (`backends/` holds `cosmic`, `gnome`,
  `hyprland`, `i3`, `kwin`). Add new compositor/window-manager support under
  `windowing/backends/` and register it in `windowing/registry.rs`; avoid
  backend-specific branches in `server.rs` or `diagnostics.rs`.
- `computer-use-linux/gnome-shell-extension/`
  Bundled GNOME Shell extension used for exact GNOME activation.
- `plugins/openai-bundled/plugins/computer-use/` and `.../read-aloud/`
  Bundled plugin manifests/resources staged into the Linux app.
- `read-aloud-linux/`
  Rust MCP backend for optional Read Aloud support.
- `linux-features/read-aloud/` and `linux-features/read-aloud-mcp/`
  Optional Linux features for Read Aloud patching/staging/integration. They are
  two of ~16 opt-in features under `linux-features/` (e.g. `agent-workspace`,
  `appshots`, `codex-wrapper-updater`, `conversation-mode`,
  `copilot-reasoning-effort`, `frameless-titlebar`, `node-repl-reaper`,
  `open-target-discovery`, `remote-control-ui`, `remote-mobile-control`,
  `thorium-chrome-plugin`, `x11-ewmh-computer-use`,
  plus the `example-feature` template); all ship `feature.json` + `README.md`
  and are disabled by default.

### User-Local Install (`contrib/user-local-install/`)

This is an opt-in install path for users who do not want a system-wide native
package. The daily-driver flow remains `install.sh` plus a native package plus
`codex-update-manager`.

- `install-user-local.sh`
  Installs under `~/.local/opt/codex-desktop-linux`, creates wrappers under
  `~/.local/bin`, and installs a user desktop entry.
- `files/.local/bin/codex-desktop{,-update,-check-update,-version}`
  Installed launcher and update/version maintenance wrappers.
- `files/.local/lib/codex-desktop-linux/common.sh`
  Shared helpers for installed maintenance scripts.
- `files/.local/share/applications/codex-desktop.desktop`
  User desktop entry installed by the user-local path.
- `files/.config/systemd/user/codex-desktop-update.{service,timer}`
  Optional weekly user timer.

### Tests And CI

- `tests/scripts_smoke.sh`
  Top-level smoke suite for shell helpers, package builders, launcher template,
  Electron-version detection, native modules, ASAR patches, and bundled plugin
  staging.
- `tests/fixtures/create-packaged-app-fixture.sh`
  Minimal fake packaged app layout for package-builder tests.
- `tests/webview_probe_equivalence.sh`
  Checks the launcher's webview startup probe stays equivalent to the standalone
  `launcher/webview-server.py` behavior.
- `scripts/ci-local.sh`
  Local containerized CI runner. Targets include `pr`, `all`, `core`, `deb`,
  `rpm`, `pacman`, `install-deps[:image]`, `nix`, and `upstream`.
- `.github/workflows/`
  GitHub Actions: `ci.yml`, `upstream-build-app.yml`, `install-deps.yml`,
  `cachix.yml`, `update-codex-hash.yml` (refresh upstream Nix hash pins), and
  `computer-use-sync-reminder.yml`. Nix pins are validated by
  `scripts/ci/validate-nix-pins.sh` and refreshed by
  `scripts/ci/update-nix-hashes.sh`.

### Docs

- `README.md`
  Public install/usage entrypoint.
- `CONTRIBUTING.md`
  Contributor expectations.
- `CHANGELOG.md`
  Release notes.
- `docs/architecture.md`
  High-level architecture overview of the repo and runtime flow.
- `docs/build-and-packaging.md`
  Build pipeline and native package builder reference.
- `docs/native-setup.md`
  Guided native setup/install/update walkthrough.
- `docs/updater.md`
  Update manager design, states, and operations.
- `docs/linux-features-architecture.md`
  Linux feature framework contract.
- `docs/linux-computer-use.md`
  Linux Computer Use backend, windowing, and desktop integration notes.
- `docs/nix.md`
  Nix flake, modules (`nix/`), and hash-pin workflow.
- `docs/troubleshooting.md`
  Common install/runtime issues and diagnostics.
- `docs/github-cli-auth.md`
  GitHub CLI authentication guidance.
- `docs/webview-server-evaluation.md`
  Decision record for the future local webview server model.

## Generated Artifacts

- `codex-app/`
  Generated Linux app directory. Treat as build output.
- `codex-app-next/`
  Side-by-side rebuild candidate from `scripts/rebuild-candidate.sh`.
- `codex-*-app/`
  Alternate identity app directories, such as `codex-cua-lab-app/`.
- `dist/`
  Native package and AppImage outputs.
- `dist/appimage.AppDir/`
  Generated AppImage staging tree.
- `dist-next/rebuild/`
  Rebuild candidate reports.
- `target/`
  Rust build output for all workspace crates.
- `Codex.dmg`
  Cached upstream DMG.
- `linux-features/features.json`
  Gitignored local opt-in feature config.
- `linux-features/local/`
  Gitignored user-local feature directory.
- `codex-app/.codex-linux/linux-features-staged.json`
  Staged declarative feature ownership manifest.
- `~/.config/codex-update-manager/config.toml`
  Runtime updater config.
- `~/.local/state/codex-update-manager/state.json`
  Updater state-machine persistence.
- `~/.local/state/codex-update-manager/service.log`
  Updater service log.
- `~/.cache/codex-update-manager/`
  Downloaded DMGs, rebuild workspaces, staged package artifacts, and build logs.
- `~/.cache/codex-desktop/launcher.log`
  Launcher log for the default app identity.
- `~/.local/state/codex-desktop/app.pid` and `webview.pid`
  Launcher liveness files.
- `$XDG_RUNTIME_DIR/codex-desktop/launch-action.sock`
  Warm-start handoff socket.

## Important Behavior

- DMG extraction can warn when `7z` cannot materialize the `/Applications`
  symlink. This is acceptable if a `.app` bundle was extracted successfully.
- The managed Node.js runtime is installed under
  `codex-app/resources/node-runtime/`. Override only with
  `CODEX_MANAGED_NODE_VERSION`, `CODEX_MANAGED_NODE_URL`, and
  `CODEX_MANAGED_NODE_SHA256`; the SHA must be set when overriding version or
  URL.
- GUI launchers often do not inherit shell `PATH`. The generated launcher
  searches common Codex CLI and `nvm` locations and respects `CODEX_CLI_PATH`.
- CLI preflight is launcher-scoped and best-effort. It can prompt to install
  or update the Codex CLI, but failures should warn rather than block app
  launch.
- ASAR patches are fail-soft unless intentionally marked required. Each patch
  should be idempotent and report warnings when upstream drift prevents a
  needle from matching.
- Patch reports are written for installs/rebuilds. Upstream-build CI fails only
  for required upstream patches that are missing or skipped.
- Linux Computer Use plugin registration is default-on platform port glue, but
  Computer Use UI enablement remains opt-in and must not bypass upstream
  server-side rollouts unrelated to local Linux support.
- The Linux Chrome integration stages the bundled Chrome plugin, native host,
  marketplace metadata, and browser profile/native-host diagnostics for Chrome,
  Brave, and Chromium. Do not fix only the user cache; patch staged bundled
  resources.
- The generated launcher starts the local webview server before Electron and
  verifies the expected startup markers. See `docs/webview-server-evaluation.md`
  before changing the server model.
- Warm-start handoff uses a Unix-domain socket under `$XDG_RUNTIME_DIR` so
  second launches can send actions to the running app.
- Native package install/removal hooks start, stop, disable, and reload the
  `systemd --user` updater service on a best-effort basis.
- Failed privileged updater installs stay failed until a newer rebuild or an
  explicit retry path; avoid auto-retrying every reconcile cycle.
- Manual rollback uses the last-known-good package recorded in updater state
  and the same format-specific command layer as normal installs.

## How To Rebuild

Regenerate the Linux app:

```bash
./install.sh ./Codex.dmg
./install.sh
```

Guided native setup/install/update:

```bash
make setup-native
make bootstrap-native
make install-native
make update-native
```

Build native packages:

```bash
./scripts/build-deb.sh
./scripts/build-rpm.sh
./scripts/build-pacman.sh
./scripts/build-appimage.sh
```

Common package version override:

```bash
PACKAGE_VERSION=2026.03.24.120000+deadbeef ./scripts/build-deb.sh
```

Side-by-side rebuild candidate:

```bash
./scripts/rebuild-candidate.sh
./scripts/rebuild-candidate.sh --install
```

## Runtime Expectations

- `python3`, `7z`, `curl`, `unzip`, `tar`, `make`, and `g++` are required for
  `install.sh`.
- Native package builders require their format-specific tools (`dpkg-deb`,
  `rpmbuild`, `makepkg`/pacman tooling, or `appimagetool`).
- `scripts/install-deps.sh` bootstraps common host dependencies. On apt-based
  systems, `NODEJS_MAJOR=24 bash scripts/install-deps.sh` selects Node.js 24
  instead of the default NodeSource major.
- The packaged app still needs the Codex CLI at runtime, but launcher preflight
  attempts a best-effort install/update when possible.

## Preferred Validation After Changes

For shell/launcher/package changes:

```bash
bash -n install.sh
bash -n scripts/lib/*.sh
bash -n launcher/start.sh.template
bash -n scripts/build-deb.sh
bash -n scripts/build-rpm.sh
bash -n scripts/build-pacman.sh
bash -n scripts/build-appimage.sh
```

For patch and Linux feature changes:

```bash
node --test scripts/patch-linux-window-ui.test.js
node --test linux-features/*/test.js
bash tests/scripts_smoke.sh
```

For Rust changes:

```bash
cargo check -p codex-update-manager
cargo test -p codex-update-manager
cargo check -p codex-computer-use-linux
cargo test -p codex-computer-use-linux
cargo check -p codex-read-aloud-linux
cargo test -p codex-read-aloud-linux
```

For package payload changes, build the relevant formats and inspect metadata:

```bash
./scripts/build-deb.sh
dpkg-deb -I dist/codex-desktop_*.deb
dpkg-deb -c dist/codex-desktop_*.deb | sed -n '1,80p'
```

Also run RPM, pacman, AppImage, or containerized CI when the touched code
affects those paths:

```bash
./scripts/build-rpm.sh
./scripts/build-pacman.sh
./scripts/build-appimage.sh
./scripts/ci-local.sh pr
./scripts/ci-local.sh all
```

If launcher behavior changed, inspect the generated launcher after rebuild:

```bash
sed -n '1,160p' codex-app/start.sh
```

If updater behavior changed, inspect:

```bash
systemctl --user status codex-update-manager.service
codex-update-manager status --json
sed -n '1,120p' ~/.local/state/codex-update-manager/state.json
sed -n '1,160p' ~/.local/state/codex-update-manager/service.log
```

## Editing Guidance

- Prefer source files over generated artifacts: `launcher/start.sh.template`
  for launcher behavior, `scripts/lib/*.sh` for build pipeline behavior,
  `scripts/patches/core/**/patch.js` for shipped patches, and
  `linux-features/<id>/` for optional integrations.
- Keep native-package-only behavior in `packaging/linux/` helpers and
  AppImage-only behavior in `packaging/appimage/` helpers.
- Keep all package builders aligned through `scripts/lib/package-common.sh`
  when adding or removing shared payload files.
- Keep new core patch descriptors fail-soft and idempotent unless there is a
  deliberate required-upstream CI policy.
- Keep optional feature patches optional in CI and disabled by default.
- Add tests near the behavior being changed: patcher tests for ASAR needles,
  feature tests for Linux features, Rust tests for updater/MCP backends, and
  package smoke checks for payload/layout changes.
- When refreshing Nix hashes, use `scripts/ci/update-nix-hashes.sh`; do not
  hand-edit SRI hashes in `flake.nix`.
