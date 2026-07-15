# Generated Artifacts And Runtime Notes

This document collects the detailed generated-output and runtime-state notes
that agents need without keeping them in the main quick-start.

## Generated Artifacts

- `codex-app/`
  Generated Linux app directory. Treat as build output.
- `codex-app-next/`
  Side-by-side rebuild candidate from `scripts/rebuild-candidate.sh`. Hidden
  sibling `.codex-app.candidate-*` directories are temporary transactional
  install state and are removed after success or rejection by default.
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

## Runtime Notes

- DMG extraction can warn when `7z` cannot materialize the `/Applications`
  symlink. This is acceptable if a `.app` bundle was extracted successfully.
- The managed Node.js runtime is installed under
  `codex-app/resources/node-runtime/`. Override only with
  `CODEX_MANAGED_NODE_VERSION`, `CODEX_MANAGED_NODE_URL`, and
  `CODEX_MANAGED_NODE_SHA256`; the SHA must be set when overriding version or
  URL.
- GUI launchers often do not inherit shell `PATH`. The generated launcher
  searches common Codex CLI and `nvm` locations and respects `CODEX_CLI_PATH`.
- CLI preflight is launcher-scoped and normally best-effort. A detected npm CLI
  missing its required Linux optional dependency is the exception: the launcher
  performs one bounded synchronous repair and blocks Electron startup if that
  repair fails or times out, because the known-broken CLI cannot serve the app.
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
  verifies the expected startup markers. See
  `docs/webview-server-evaluation.md` before changing the server model.
- Warm-start handoff uses a Unix-domain socket under `$XDG_RUNTIME_DIR` so
  second launches can send actions to the running app.
- Native package install/removal hooks start, stop, disable, and reload the
  `systemd --user` updater service on a best-effort basis.
- Failed privileged updater installs stay failed until a newer rebuild or an
  explicit retry path; avoid auto-retrying every reconcile cycle.
- Manual rollback uses the last-known-good package recorded in updater state
  and the same format-specific command layer as normal installs.

## Runtime Expectations

- `python3`, `7z`, `curl`, `unzip`, `tar`, `flock`, `make`, and `g++` are
  required for `install.sh`.
- Native package builders require their format-specific tools (`dpkg-deb`,
  `rpmbuild`, `makepkg`/pacman tooling, or `appimagetool`).
- `scripts/install-deps.sh` bootstraps common host dependencies. On apt-based
  systems, `NODEJS_MAJOR=24 bash scripts/install-deps.sh` selects Node.js 24
  instead of the default NodeSource major.
- The packaged app still needs the Codex CLI at runtime, but launcher preflight
  attempts a best-effort install/update when possible.
