# Architecture

This repository adapts the upstream macOS Codex Desktop DMG into Linux app and
package artifacts.

## Build Pipeline

1. `install.sh` extracts `Codex.dmg` with `7z` / `7zz`.
2. It detects the Electron version from upstream metadata, with a pinned
   fallback.
3. It extracts and patches `app.asar` with fail-soft Linux compatibility
   patches.
4. It rebuilds native Node modules such as `better-sqlite3` and `node-pty` for
   Linux through `@electron/rebuild`.
5. It downloads a matching Linux Electron runtime.
6. It stages bundled plugins and any enabled optional `linux-features/`.
7. It writes the Linux launcher to `codex-app/start.sh` from
   `launcher/start.sh.template`.
8. Package builders repackage `codex-app/` into `.deb`, `.rpm`,
   `.pkg.tar.zst`, or AppImage artifacts.
9. Default native packages install `codex-update-manager` and a
   `systemd --user` service.

The installer replaces the macOS Electron binary with a Linux build, recompiles
native modules, and removes macOS-only pieces such as Sparkle.

## Patch System

Core Linux compatibility patches live under `scripts/patches/core/`.
Descriptors declare phase, order, target filters, and CI policy.

`scripts/patch-linux-window-ui.js` is the build-facing CLI only. It parses
arguments, creates/writes the optional report, calls
`scripts/patches/runner.js`, and applies the critical gate after the report is
written. Internal code imports runner APIs, not the CLI file.

`scripts/patches/runner.js` collects core descriptors plus enabled
`linux-features/` descriptors and executes the fresh-DMG pipeline:

1. `main-bundle`
2. `extracted-app:pre-webview`
3. `webview-asset`
4. `extracted-app:post-webview`

`scripts/patches/engine.js` owns descriptor normalization, target/enabled
checks, phase execution, warning capture, and status recording. Shared
implementation code lives under `scripts/patches/impl/` by domain; generic
helpers live under `scripts/patches/lib/`. The deleted compatibility barrels
are intentionally not part of the architecture.

`ciPolicy` is the single criticality axis, enforced by the patch engine —
patches themselves never abort the build:

- `required-upstream` (critical): the app does not launch or is core-unusable
  without it. If one fails (no match or a throw), the patcher exits non-zero
  with an aggregated `Critical patch failures` summary and the build aborts.
  `CODEX_ENFORCE_CRITICAL_PATCHES=0` bypasses this for emergency builds.
- `optional`: best-effort. Failures and throws are caught by the engine,
  logged as warnings, and listed in the end-of-build
  `optional patches not fully applied` summary so they can be fixed later.
- `opt-in`: disabled unless explicitly enabled; recorded as `skipped-disabled`.

Every build writes a patch report (`<app>/.codex-linux/patch-report.json`,
next to `build-info.json`). `scripts/lib/patch-report.js` owns report statuses
and failure predicates. CI validates the same report with
`scripts/ci/validate-patch-report.js`, which shares the failure predicate with
the local gate and prints non-failing optional-drift warnings.

Optional additions belong under `linux-features/`. Feature patching uses only
`entrypoints.patchDescriptors`; feature descriptor ids are namespaced in patch
reports and are optional by default.

## Launcher

The launcher serves extracted webview assets from `content/webview/` on
`127.0.0.1` (`5175` by default, `5176` for the dev app), validates the origin,
then starts Electron.

Warm-start launches hand off actions such as `--new-chat` over a Unix-domain
socket instead of spawning a second app process.

Native-package-only launcher behavior, such as desktop-entry hints and default
update-manager startup, lives in:

```text
packaging/linux/codex-packaged-runtime.sh
```

The current evaluation for a future Rust replacement of the local webview
server lives in [webview-server-evaluation.md](webview-server-evaluation.md).

## Chrome Plugin

The build stages the upstream Chrome plugin, patches its Linux compatibility
paths, builds the native messaging host from Rust, and installs browser
manifests for Chrome, Brave, and Chromium.

## Validation

Run the subset that matches your change. For installer, packaging, patcher, or
updater changes:

```bash
bash -n install.sh scripts/lib/*.sh launcher/start.sh.template scripts/build-deb.sh scripts/build-rpm.sh scripts/build-pacman.sh scripts/build-appimage.sh scripts/install-deps.sh
node --check scripts/patch-linux-window-ui.js
node --test scripts/patch-linux-window-ui.test.js
node --test linux-features/*/test.js
bash tests/scripts_smoke.sh
cargo check -p codex-update-manager
cargo test -p codex-update-manager
cargo check -p codex-computer-use-linux
cargo test -p codex-computer-use-linux
cargo check -p codex-read-aloud-linux
cargo test -p codex-read-aloud-linux
cargo check -p codex-record-replay-linux
cargo test -p codex-record-replay-linux
make package
```

For contribution policy and review expectations, see [CONTRIBUTING.md](../CONTRIBUTING.md).
