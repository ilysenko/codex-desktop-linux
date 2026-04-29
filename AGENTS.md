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
  Main installer and launcher generator.
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
  Downloaded DMGs, rebuild workspaces, staged package artifacts, and build logs. Successful rebuilds prune older workspaces and keep the current workspace plus the newest previous one.

Do not assume `codex-app/` is pristine. If behavior differs from `install.sh`, prefer updating `install.sh` and then regenerating the app.

## Important Behavior And Known Fixes

- DMG extraction:
  `7z` can return a non-zero status for the `/Applications` symlink inside the DMG. This is currently treated as a warning if a `.app` bundle was still extracted successfully.
- Launcher and `nvm`:
  GUI launchers often do not inherit the user's shell `PATH`. The generated `start.sh` explicitly searches for `codex`, including common `nvm` locations.
- CLI preflight:
  Before Electron launches, the generated launcher asks `codex-update-manager` to verify the installed Codex CLI, install it automatically if it is missing, and update it if the npm package is newer. The check is best-effort: it uses a 1-hour cooldown for npm registry lookups, falls back to `npm install -g --prefix ~/.local` if a global install fails, and warns instead of blocking app launch when the refresh attempt does not succeed.
- Linux file manager integration:
  During ASAR patching, `scripts/patch-linux-window-ui.js` also tries to inject a Linux implementation for `Open in File Manager`. The patch is intentionally fail-soft: if the upstream minified bundle no longer matches, the install continues and emits exactly `Failed to apply Linux File Manager Patch`.
- Linux translucent sidebar default:
  During the same ASAR patch step, Linux defaults `Translucent sidebar` to `false` by applying `opaqueWindows: true` only when the app has no saved explicit value yet. This keeps existing user preferences intact while avoiding the sidebar disappearing bug on first run.
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
  A failed, cancelled, or timed-out `pkexec` install now stays in `Failed` and does not auto-retry every reconcile cycle. Check `service.log`, fix the root cause, and retry by waiting for the next rebuild or rebuilding a newer package.
- Interrupted installs:
  If updater state is left in `Installing` after a crash, restart, or interrupted privileged flow, the daemon now recovers that state automatically instead of staying stuck and skipping future upstream checks.
- Launch-time update checks:
  The packaged runtime starts `codex-update-manager.service` in best-effort mode on app launch, but it skips the transient `codex-update-manager-launch-check` unit when the user daemon is already active. The daemon owns initial and periodic checks once it is running.
- Package removal:
  Debian and RPM removal now make a best-effort attempt to stop and disable `codex-update-manager.service` for active user sessions. If a user manager is unavailable, manual cleanup is still `systemctl --user disable --now codex-update-manager.service`.

## Crate Versioning

- Current updater crate version: `0.4.3`
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

- `node`, `npm`, `npx`, `python3`, `7z`, `curl`, `unzip`, `make`, and `g++` are required for `install.sh`
- Node.js 20+ is required
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

The native builders and post-install hooks normalize staged `/opt` and `/usr` payload permissions after copying generated app files, so package artifacts and upgrades do not preserve group-writable modes from a developer checkout.

The RPM builder stages the same app and updater payload into an RPM buildroot before invoking `rpmbuild`.

The pacman builder stages the same payload into a package root, writes `.PKGINFO`/`.MTREE`, and then produces a `.pkg.tar.zst` archive for `pacman -U`.

## Preferred Validation After Changes

After editing installer or packaging logic, validate at least:

```bash
bash -n install.sh
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

- Prefer changing `install.sh` over manually patching `codex-app/start.sh`, unless you are making a temporary local test.
- Keep native-package-only launcher behavior in `packaging/linux/codex-packaged-runtime.sh`; `install.sh` should stay generic and only load that helper optionally.
- If you update the launcher template inside `install.sh`, regenerate `codex-app/` or keep `codex-app/start.sh` aligned before building a new package.
- Keep packaging changes in `packaging/linux/`, `scripts/build-deb.sh`, `scripts/build-rpm.sh`, and `scripts/build-pacman.sh`; avoid hardcoding distro-specific behavior outside those files unless necessary.
- Keep `scripts/lib/package-common.sh` aligned with both builders when you add or remove packaged files from the shared runtime payload.
