# Update manager

`codex-update-manager` is an optional Rust component in native packages. It
updates the custom distribution without transferring ownership to the official
`chatgpt` package.

It updates the `codex-desktop` package shown as **ChatGPT Community**. It does
not install, remove, or update OpenAI's separate `chatgpt` package.

## Release discovery

The service verifies OpenAI's signed stable `InRelease`, the digest of the
architecture-specific `Packages` file, and the selected package SHA-256. An
unchanged version/architecture/SHA tuple is a no-op. Downloads are cached as:

```text
<version>-<architecture>-<sha256>.deb
```

Signature, index, package hash, metadata, or payload failures never replace the
working app.

## Rebuild

The packaged update-builder extracts the official payload, applies only the
locally enabled features, generates the selected package format, and places the
result beside the active install. It contains its own minimal Node/ASAR build
tools but does not install Node.js in the application runtime. Native packages
require the host's packaged Node.js 24 or newer, and the updater validates that
version at `/usr/bin/node` before running the signed-package verifier. User
version-manager shims do not override the packaged updater runtime.

Enabled feature drift rejects the candidate. Disabled features are neither
loaded nor probed. Native helper binaries belong to the project release package
and are not rebuilt for each upstream refresh. The minimal update-builder
copies those already staged release executables into the candidate workspace;
it contains no Cargo workspace.

## Promotion and rollback

Building may proceed while ChatGPT is running. Promotion does not: the updater
waits for process exit, then performs the same atomic candidate exchange used by
manual rebuilds. A durable journal recovers interrupted promotion, and the
immediately previous managed package remains the rollback target.

Automated user-local operations cannot override the running-app guard or
silently accept unverified input. A failed privileged installation remains
failed until an explicit retry or a newer candidate.

Legacy schema state is treated as an incompatible pending candidate and reset;
the installed package and recorded rollback artifact are preserved.

## Commands

```bash
codex-update-manager status
codex-update-manager status --json
codex-update-manager diagnose
codex-update-manager diagnose --json
codex-update-manager check-now
codex-update-manager install-ready
codex-update-manager rollback
```

- `status` shows the persisted candidate, installed, and rollback state.
- `diagnose` adds runtime paths, configuration, process-liveness, and package
  readiness details suitable for bug reports.
- `check-now` performs a signed release check immediately. When a newer release
  is available, it drives the normal download/build state machine.
- `install-ready` retries installation of an already prepared candidate after
  the application is closed or a package-manager problem is fixed.
- `rollback` installs the immediately previous retained managed package and
  blocks the rejected candidate tuple from immediate reinstallation.

The service is controlled with:

```bash
systemctl --user enable --now codex-update-manager.service
systemctl --user status codex-update-manager.service --no-pager
journalctl --user -u codex-update-manager.service
```

To trigger one foreground daemon pass while debugging, stop the service and
run `codex-update-manager daemon` from a terminal. Do not run two daemon
instances against the same state directory.

Update interaction is exposed through the service, CLI, desktop actions, and
notification actions. The upstream ASAR is not patched to add an update button.

## State and logs

The manager follows XDG locations:

```text
${XDG_CONFIG_HOME:-~/.config}/codex-update-manager
${XDG_STATE_HOME:-~/.local/state}/codex-update-manager
${XDG_CACHE_HOME:-~/.cache}/codex-update-manager
```

Use `status --json` and `diagnose --json` instead of editing persisted JSON.
Candidate packages are content-addressed. Conservative cache cleanup retains
the installed source, current candidate, and immediately previous rollback
artifact.

The authoritative service log is the user journal:

```bash
journalctl --user -u codex-update-manager.service -n 200 --no-pager
journalctl --user -u codex-update-manager.service -f
```

## Manual-update packages

To build `codex-desktop` without the service and update-builder:

```bash
PACKAGE_WITH_UPDATER=0 make package
make install
```

Update that installation from a trusted checkout with:

```bash
PACKAGE_WITH_UPDATER=0 make update-native
```

AppImage, direct `codex-app/`, and Nix outputs follow their own replacement
workflow and do not use this mutable package updater.

## Recovery

If state says `WaitingForAppExit`, fully close both official **ChatGPT** and
**ChatGPT Community**; the shared upstream process name/profile can otherwise
keep the guard active. If installation failed, fix the reported package-manager
or polkit problem and run `install-ready`.

Use `rollback` only after confirming the retained artifact is the version you
want. `make clean-state` deletes updater state and cache, including the managed
rollback path; it is not a normal troubleshooting step.

## Validation scenarios

Tests cover new and unchanged releases, interrupted downloads, all trust
failures, build-while-running, promotion-after-exit, rollback, cleanup, and old
state migration. Run:

```bash
cargo test -p codex-update-manager
cargo clippy -p codex-update-manager --all-targets -- -D warnings
```
