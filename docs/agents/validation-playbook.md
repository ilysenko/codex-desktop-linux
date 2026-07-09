# Agent Validation Playbook

Run the smallest validation set that matches the touched surface, then broaden
when the change crosses package formats, launcher/runtime behavior, updater
state, or patch drift handling.

## Shell, Launcher, And Package Scripts

```bash
bash -n install.sh
bash -n scripts/lib/*.sh
bash -n launcher/start.sh.template
bash -n scripts/build-deb.sh
bash -n scripts/build-rpm.sh
bash -n scripts/build-pacman.sh
bash -n scripts/build-appimage.sh
```

For launcher behavior changes, rebuild or inspect the generated launcher:

```bash
sed -n '1,160p' codex-app/start.sh
```

If the change affects webview startup probes, run:

```bash
bash tests/webview_probe_equivalence.sh
```

## Patch Registry And Linux Features

```bash
node --test scripts/patch-linux-window-ui.test.js
node --test linux-features/*/test.js
bash tests/scripts_smoke.sh
```

For upstream drift or protected surface analysis:

```bash
make inspect-upstream DMG=/path/to/Codex.dmg
make inspect-upstream-intel-devcontainer
```

For patch report validation:

```bash
scripts/ci/validate-patch-report.js codex-app/.codex-linux/patch-report.json
```

## Rust Crates

Updater:

```bash
cargo check -p codex-update-manager
cargo test -p codex-update-manager
```

Linux Computer Use:

```bash
cargo check -p codex-computer-use-linux
cargo test -p codex-computer-use-linux
```

Read Aloud:

```bash
cargo check -p codex-read-aloud-linux
cargo test -p codex-read-aloud-linux
```

Record & Replay:

```bash
cargo check -p codex-record-replay-linux
cargo test -p codex-record-replay-linux
```

## Package Payloads

Build the relevant package format and inspect metadata/layout:

```bash
./scripts/build-deb.sh
dpkg-deb -I dist/codex-desktop_*.deb
dpkg-deb -c dist/codex-desktop_*.deb | sed -n '1,80p'
```

Run other package formats when shared payload logic, package hooks, updater
bundles, desktop files, permissions, or runtime helpers are touched:

```bash
./scripts/build-rpm.sh
./scripts/build-pacman.sh
./scripts/build-appimage.sh
```

Use a package version override when a deterministic package name helps review:

```bash
PACKAGE_VERSION=2026.03.24.120000+deadbeef ./scripts/build-deb.sh
```

## Updater Runtime Checks

When updater behavior changes, inspect service and state:

```bash
systemctl --user status codex-update-manager.service
codex-update-manager status --json
sed -n '1,120p' ~/.local/state/codex-update-manager/state.json
sed -n '1,160p' ~/.local/state/codex-update-manager/service.log
```

For rebuild candidates:

```bash
./scripts/rebuild-candidate.sh
./scripts/rebuild-candidate.sh --install
```

## Broad CI

Run broader local CI when a change affects multiple package formats, updater
install flows, launcher/runtime behavior, Nix pins, or core patch policy:

```bash
./scripts/ci-local.sh pr
./scripts/ci-local.sh all
```

For Nix hash refreshes:

```bash
scripts/ci/update-nix-hashes.sh
scripts/ci/validate-nix-pins.sh
```
