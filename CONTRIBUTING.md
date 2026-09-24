# Contributing to ChatGPT Community for Linux

Keep only one pull request open at a time (two only for an explicit maintainer
exception). Keep each change focused and stay engaged through review.

This project supports only the latest signed stable OpenAI Linux package on the
two published architectures. When upstream changes, remove obsolete drift
workarounds in the same pull request; do not retain version-specific branches or
fallback shapes.

OpenAI's signed Linux `.deb` is the only upstream. Do not reintroduce an
alternate source format or reconstruct parts of the upstream runtime.
**ChatGPT Community** is the desktop display name;
`codex-desktop` remains the package, executable, and path identity.

## Ways to contribute

- Reproduce and document a regression against the current official stable
  Linux package.
- Improve a disabled-by-default Linux feature and its adjacent tests.
- Validate deb, RPM, pacman, AppImage, Nix, Wayland, X11, `amd64`, or `arm64`.
- Improve installer, updater, packaging, or source-security coverage.
- Correct documentation where it disagrees with current commands or runtime
  ownership.

For bug reports, include the distribution, desktop session, architecture,
official package version, enabled feature IDs, reproduction steps, and relevant
diagnostic or patch reports. Account rollouts and unrelated OpenAI service
failures are not repository bugs.

## Before editing

- Read `AGENTS.md` and the relevant architecture document.
- Edit source owners, never generated `codex-app/`, candidates, `dist/`, or
  `target/`.
- Preserve clean-build `resources/app.asar` byte identity unless a reproduced
  mandatory blocker requires a tested core patch.
- Treat launcher, updater, shared package, and feature-framework changes as
  cross-format.
- Keep optional, distro/editor/browser/workflow-specific behavior in a
  disabled-by-default `linux-features/<id>/` module with a README.
- Do not add a core ASAR patch without a reproduced mandatory failure and a
  required regression test.
- Keep legacy bundled-plugin migrations limited to recognized upstream-bundled
  Browser/Chrome snapshots. Never clear arbitrary plugin caches as a generic
  repair strategy.

Primary source routing:

- verification/extraction: `scripts/lib/upstream-linux-package.*`
- launcher: `launcher/start.sh.template`
- ASAR engine: `scripts/patches/` and `scripts/patch-linux-window-ui.js`
- feature manifests/resources/hooks: `linux-features/`
- shared packaging: `scripts/lib/package-common.sh`
- updater: `updater/src/`
- Nix: `flake.nix` and `nix/`

## Setup

```bash
git clone https://github.com/ilysenko/codex-desktop-linux.git
cd codex-desktop-linux
bash scripts/install-deps.sh
./install.sh
```

For the normal installed application use `make install-native`; use
`make setup-native` first only when you want the interactive optional-feature
wizard. `make bootstrap-native` installs dependencies before performing the
same native build/package/install flow.

The build requires Node.js 20+, npm, Python 3, curl, `gpgv`, `dpkg-deb`,
SHA-256 utilities, tar, make, and a C/C++ toolchain. Rust is required for the
updater and retained native feature helpers.

Create a focused branch from current `main`. Avoid mixing generated artifacts,
format-only churn, dependency refreshes, and unrelated cleanup into a behavior
change.

## Engineering standards

- Fail closed at trust and promotion boundaries.
- Prefer semantic descriptor matching and byte-identical drift tests over
  pinning minified chunk names or identifiers.
- Make optional features self-contained. Every feature needs `feature.json`,
  `README.md`, explicit `defaultEnabled: false`, and tests for its active
  contract.
- Prefer declarative resources and runtime/package hooks. Keep `stage.sh` only
  when the operation cannot be represented safely in the manifest.
- Quote paths, validate destructive targets, and avoid wildcard cleanup.
- Keep Rust formatted and clippy-clean, with explicit persisted-state and
  filesystem transaction boundaries.
- Do not add dependencies when an existing helper or standard tool covers the
  requirement.

## Pull requests

Describe the problem, user-visible behavior, affected package formats/features,
and exact validation. Do not self-assign repository labels; maintainers and
authorized automation apply the taxonomy from `docs/label-governance.md`.

Prefer a regression test before the fix. Keep shell defensive, Rust idiomatic,
interfaces small, and dependencies explicit. Never weaken signature, hash,
sandbox, candidate-promotion, or running-app safety checks to make a test pass.

A good pull request includes the problem and solution, user-visible behavior,
affected architectures/formats/features, exact validation, and any untested
manual matrix or security/rollback risk. Keep commits reviewable. Update public
documentation when a command, option, invariant, or ownership boundary changes.

## Validation

Use the smallest relevant set, followed by broader coverage for shared changes:

```bash
bash -n install.sh scripts/lib/*.sh launcher/start.sh.template
bash tests/scripts_smoke.sh
node --test scripts/lib/upstream-linux-package.test.js
node --test scripts/patch-linux-window-ui.test.js scripts/lib/linux-features.test.js linux-features/*/test.js
cargo test -p codex-update-manager
cargo clippy -p codex-update-manager --all-targets -- -D warnings
./scripts/ci-local.sh pr
./scripts/ci-local.sh all
```

Package payload changes should inspect deb, RPM, pacman, AppImage, and Nix as
applicable. Feature changes require the adjacent feature test plus a build with
that feature alone. Upstream-source changes require the complete trust-failure
matrix.

Documentation-only changes should at least check Markdown links, documented
Make targets and feature IDs against source, and run `git diff --check`. Do not
restore historical DMG/runtime-port instructions as active guidance; historical
context belongs in `CHANGELOG.md` or a migration record.
