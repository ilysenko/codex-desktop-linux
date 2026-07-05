# Auto-Update Manager

Default native packages install `codex-update-manager`, a companion
`systemd --user` service.

It:

- checks upstream `Codex.dmg` on daemon startup, every 6 hours, and in the
  background on app launch when stale
- rebuilds a local native package with `/opt/codex-desktop/update-builder`
- waits for Electron to exit before installing a ready update
- runs unprivileged; the final package install uses `pkexec` when a graphical
  polkit authentication agent is available, or keeps the package ready and
  reports a terminal `sudo /usr/bin/codex-update-manager ... --path ...`
  command when no auth agent is available
- performs best-effort Codex CLI preflight from the launcher

Codex CLI preflight preserves the detected CLI install type. npm-managed
installs continue to update through npm, while official standalone installs
under `~/.codex/packages/standalone` are updated with the official standalone
installer instead of being replaced through npm.

Before the preflight runs, the launcher resolves the newest local `codex`
binary it can find across the GUI `PATH` and known user install locations. This
prevents an older system-wide CLI from winning over a newer user install, and
the selected path plus version are written to the launcher log. `CODEX_CLI_PATH`
still pins an explicit binary when users need one.

## Inspect State

```bash
systemctl --user status codex-update-manager.service
codex-update-manager status --json
sed -n '1,160p' ~/.local/state/codex-update-manager/state.json
sed -n '1,160p' ~/.local/state/codex-update-manager/service.log
```

Runtime files:

```text
~/.config/codex-update-manager/config.toml
~/.local/state/codex-update-manager/state.json
~/.local/state/codex-update-manager/service.log
~/.cache/codex-update-manager/
~/.cache/codex-desktop/launcher.log
~/.local/state/codex-desktop/app.pid
```

## Generated Artifact Cleanup

The updater always prunes unreferenced updater workspaces under
`~/.cache/codex-update-manager/workspaces`. Local checkout build output such as
`dist/`, `target/`, and `codex-app/` is cleaned only when explicitly enabled.

Example:

```toml
[generated_artifact_cleanup]
enabled = true
min_free_bytes = 10737418240 # 10 GiB
roots = ["/home/mohit/Github/codex-desktop-linux"]
entries = ["dist", "target", "codex-app"]
```

If `roots` is omitted, the updater uses `builder_bundle_root`. Cleanup only runs
when the filesystem containing a root has less than `min_free_bytes` available.
Every entry must be a relative top-level name, and the updater only cleans roots
that look like this wrapper repository or packaged update-builder.

## Rollback

If a rebuilt update installs but the previous retained package was better,
close Codex Desktop and run:

```bash
codex-update-manager rollback
```

Rollback uses the last retained known-good package and refuses to run when no
rollback package is available.

## Manual-Update Packages

Build a native package without the resident updater:

```bash
PACKAGE_WITH_UPDATER=0 make package
make install
```

That package omits `codex-update-manager`, the user service unit, updater
polkit policy, `/opt/codex-desktop/update-builder`, desktop updater actions,
and launcher updater startup checks.

Installing a no-updater package over a default package also stops and disables
existing `codex-update-manager.service` instances for active user managers and
removes stale per-user enablement links for inactive users.

Manual updates should come from a checkout you trust:

```bash
PACKAGE_WITH_UPDATER=0 make update-native
```

`make update-native` runs `git pull --ff-only`, regenerates `codex-app/` from a
fresh upstream `Codex.dmg`, builds the native package, and installs it.

## Service Controls

```bash
make service-enable
make service-status
codex-update-manager status --json
```

`make service-enable` is meant for installed packages, not repo-only generated
apps.

To temporarily pause automatic package rebuilds and installs while keeping Codex
Desktop usable, disable the user service:

```bash
systemctl --user disable --now codex-update-manager.service
```

Launching Codex Desktop and upgrading the package will not re-enable a disabled
updater service. Re-enable updater behavior explicitly when you want automatic
checks again:

```bash
systemctl --user enable --now codex-update-manager.service
```

## Wrapper Updates

Optional wrapper-update tracking can watch this repository's own Linux wrapper
changes with:

```toml
enable_wrapper_updates = true
```

in `~/.config/codex-update-manager/config.toml`.

This is intended for git-checkout/dev update-builder installs. Frozen
native-package builders without a `.git` directory report no wrapper candidate
and receive wrapper changes through normal package upgrades.
