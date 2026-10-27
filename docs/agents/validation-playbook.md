# Validation playbook

## Fast source checks

```bash
bash -n install.sh scripts/lib/*.sh launcher/start.sh.template
bash tests/scripts_smoke.sh
node --test scripts/lib/upstream-linux-package.test.js
node --test scripts/patch-linux-window-ui.test.js scripts/lib/linux-features.test.js linux-features/*/test.js
cargo test -p codex-update-manager
cargo clippy -p codex-update-manager --all-targets -- -D warnings
```

## Source-security matrix

Cover valid, corrupt, unsigned, and wrong-key `InRelease`; `Packages` digest
mismatch; package digest mismatch; wrong name/version/architecture; unsupported
architecture; and incomplete official payload. These are unit-tested with local
fixtures and fail closed.

## Baseline build

Build with `features.example.json`, inspect `.codex-linux/build-info.json`, and
compare the official and staged `resources/app.asar` hashes. Confirm no runtime
replacement, external CLI, or local content server appears in the staged tree.
The hashes must match when neither required core nor enabled feature descriptors
exist. Otherwise inspect core/feature outcomes and hashes in the patch report;
an unchanged report must retain the official archive. Empty feature selection
alone does not guarantee equality. The custom output package's ASAR must match
its staged copy.
Confirm the desktop name is **ChatGPT Community**, its icon has the community
mark, and the package/bin/path identity is still `codex-desktop`.

Smoke-test login, project open, terminal, file picker, URI launch, tray,
notifications, clean quit, and a second launch on GNOME Wayland, KDE Wayland,
and X11. Verify official/custom coexistence and shared-profile single-instance
behavior.

When upgrading an installation made by the former Linux port, also exercise the
recognized Browser/Chrome cache migration. Confirm the official clients use
`/tmp/codex-browser-use`, the Chrome app-server parent is not group-writable,
and unrelated/user-authored plugin caches are unchanged.

## Features

Build every retained feature independently and run its adjacent test. Enabled
drift must reject a candidate; disabled drift must not be probed. Retired IDs
are ignored and arbitrary unknown IDs fail.

## Package matrix

Inspect deb, RPM, pacman, AppImage, and Nix outputs on both architectures. Check
official ELF/runtime payload, dependencies, desktop identity, AppArmor path,
updater payload, and absence of official package-manager configuration.
AppImage must never inject `--no-sandbox`.

## Updater

Test new/unchanged releases, interrupted download, trust failures,
build-while-running, promotion-after-exit, rollback, cleanup, and state-schema
migration without losing installed/rollback artifacts.

## Broad validation

```bash
./scripts/ci-local.sh pr
./scripts/ci-local.sh all
nix flake check
nix build .#codex-desktop
```

Finish with a repository search for retired active architecture references and
a diff review for orphan helpers, tests, workflows, fixtures, and docs.
