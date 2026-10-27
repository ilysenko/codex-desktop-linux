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

The packaged update-builder extracts the official payload, applies required
core patches and locally enabled features, and generates a deb, RPM, or pacman
candidate. Its application tree and package outputs live in
`<workspace_root>/workspaces/<version>/codex-app` and `dist/`, separate from the
installed `/opt/codex-desktop` tree. It contains its own minimal Node/ASAR build
tools but does not install them in the application runtime. The workspace build
uses `CODEX_INSTALL_TRANSACTION_ACTIVE=1` to stage its app directly rather than
promoting it over the managed installation.

Enabled feature drift rejects the candidate. Disabled features are neither
loaded nor probed. Native helper binaries belong to the project release package
and are not rebuilt for each upstream refresh. The minimal update-builder
copies those already staged release executables into the candidate workspace;
it contains no Cargo workspace.

## Promotion and rollback

Building may proceed while the managed app is running. Installation waits for
its process exit, then uses `pkexec` to authorize the distribution's native
package manager. The immediately previous managed package remains the rollback
target. Native installation and manual generated-tree promotion use different
transactions:

| Workflow | Candidate location | Replacement and recovery |
|---|---|---|
| Native updater | Configured workspace, with a rebuilt app and native package | Durable package transaction, authorized package-manager install, ownership-aware reconciliation |
| Direct `install.sh` / `make rebuild-install` generated tree | Sibling of the target app directory | Atomic directory exchange of an existing tree, with a separate promotion journal and previous-tree backup |

Before releasing the privileged command, the updater persists the package
identity and exact command-process owner behind a launch gate. After an
interruption it checks that owner, then verifies package-manager state and
installation effects before recording success. A nonzero package-manager exit
may follow partial file changes; it does not promise an unchanged installation
tree. An uncertain outcome retains the durable transaction for reconciliation;
unclassifiable ownership eventually requires the manual recovery described
below. Do not delete the journal to force another installation.

Automated user-local operations cannot override the running-app guard or
silently accept unverified input. A failed privileged installation remains
failed until an explicit retry or a newer candidate. If `pkexec` authentication
is cancelled before package mutation, the candidate instead remains ready; the
updater suppresses repeat prompts until an explicit retry or another app-exit
cycle.

Legacy schema-v1 candidate state is treated as an incompatible pending candidate
and reset; the installed package and recorded rollback artifact are preserved.
An active package transaction from schema 2, or any persisted transaction whose
owner lacks a reboot-safe identity, is marked failed without auto-reconciliation
and sets a manual-recovery barrier. Automatic checks remain paused until the
user confirms that no package manager is still running and explicitly retries
the interrupted operation with `install-ready` or `rollback`; the candidate and
rollback facts remain available. If owner classification stays unavailable
through the recovery grace period, the same manual state is entered rather than
assuming that the package manager exited.

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
artifact. Build workspaces under `workspaces/<version>` are removed once no
persisted path (active workspace, rebuilt package, rollback package, or an
in-flight install transaction) points into them, so only the installed build,
its rollback, and any build in progress stay on disk.

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

AppImage, direct `codex-app/`, Nix, and manual-update Gentoo outputs follow their
own replacement workflows and do not use this mutable native package updater.

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
