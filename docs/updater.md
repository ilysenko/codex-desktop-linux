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

The updater scopes permission hardening to the official standalone installer
process. New managed releases use the caller's existing umask plus the
group/world write restrictions from `0022`; stricter policies such as `0027`
and `0077` remain intact, and the launcher, Electron, app-server, hooks, and
unrelated child processes keep the caller's original mask.

Before executing a managed standalone CLI, the updater verifies that its tree
and canonical parent chain are owned by the current user or root and are not
group/world-writable (apart from root-owned sticky directories such as
`/tmp`). Every generated launcher performs the same trust-only check through a
bundled helper before any CLI version probe, including AppImage and native
packages built without the updater. The helper executes the returned canonical
release binary rather than a replaceable visible symlink and does not depend on
an installed updater version. An unsafe tree is rejected without
executing it, changing its modes, or deleting it; updater state records a
failed preflight with clean-reinstall guidance.

To recover, stop any active updater or Codex installer, remove the rejected
`~/.codex/packages/standalone` tree, and run:

```bash
codex-update-manager recover-standalone-cli --print-path
```

If the standalone installer link belongs in a non-default directory, add
`--install-dir /absolute/path/to/bin`. If the recorded standalone home is not
the default `~/.codex`, also add `--codex-home /absolute/path/to/codex-home`.
Recovery refuses to overwrite any
existing standalone tree. It downloads the official installer and runs only
that child with the caller's umask plus the `0022` write restrictions, so the
flow remains safe even when the desktop session uses `umask 0002`. Before the
download, recovery removes group/world write access from existing
current-user-owned directories below `$HOME` along both installer paths (for
example `.codex`, `packages`, `.local`, and `bin`) and rejects symlinks,
untrusted ownership, or unsafe ancestors it cannot safely narrow. Automatic
standalone updates reject an unsafe visible-command directory before
downloading or spawning the installer. Both update and recovery resolve the
installer shell, downloader, and child commands only from root-controlled
system tool directories; they never reuse programs already present in a
formerly writable user directory. Do not run the official installer directly
for this recovery: it would inherit the ambient mask. Removing write bits from
the rejected standalone tree or its command directory is not sufficient because
their contents may already have been modified.

AppImage, Nix, and native packages built without the updater do not provide the
recovery command. On those formats, either temporarily install an updater-enabled
native package and use the command above, or remove the rejected standalone tree
and reinstall the CLI from a verified package channel into a fresh path whose
files and canonical ancestors are owned by the current user or root and are not
group/world-writable. Do not reuse the rejected tree, and do not rerun the
standalone installer under an ambient `0002` mask.

An npm CLI whose canonical executable or ancestors are already group/world-
writable is also rejected because its pathname cannot be pinned safely against
replacement. Do not reinstall into that existing prefix. Remove the rejected
Codex package tree, then use a fresh dedicated prefix such as
`(umask 0022; npm i -g --include=optional --prefix ~/.codex-cli-npm
@openai/codex)`; the launcher and updater both discover that prefix.

After a managed standalone tree is first detected, launcher and updater trust
checks record its home in `~/.codex-standalone-provenance`, outside the managed
tree. That durable record keeps standalone provenance active even if the tree or
visible command has already been replaced. To switch installation channels
intentionally, remove both the standalone tree and this provenance file;
otherwise an external replacement is rejected rather than silently reclassified
as npm- or system-managed.

System-package-managed CLI installs are reused but not mutated through npm or
the standalone installer flow. On Arch-like hosts, when the resolved CLI lives
under a system bin directory and `pacman -Qo` confirms package ownership, the
updater tracks two separate version signals in state:
`cli_official_latest_version` for the latest published `@openai/codex` npm
release and `cli_package_manager_latest_version` for the latest package version
currently known to pacman.

For pacman-managed installs, `cli_status` follows the package-manager-actionable
result, not the npm result:

- if pacman currently offers a newer package, `cli_status` becomes
  `UpdateRequired` and the stored status message tells the user to update
  through pacman instead (for example: `sudo pacman -Syu`)
- if pacman does not currently offer a newer package but npm upstream is newer,
  `cli_status` stays `UpToDate` and the stored status message explains that the
  distro package and official upstream have diverged so the user can decide
  whether to stay on the distro-managed CLI or switch installation channels

If the CLI resolves to a system-path binary but `pacman -Qo` cannot determine
ownership, the updater still skips npm auto-updates and reports that ownership
verification failed so the user can inspect the CLI source manually.

The launcher does not choose the newest installed CLI. It resolves an explicit
`CODEX_CLI_PATH` first, then falls back to the usual `PATH`, nvm, and known
user/system locations. Startup logs include the resolved path plus a
best-effort CLI version probe; set `CODEX_CLI_PATH=/path/to/codex` when you
need to pin a particular binary from a GUI-launched session. `CODEX_CLI_PATH`
does not bypass install-type detection; if it points at a pacman-managed CLI,
the same non-npm guidance applies.

## Inspect State

```bash
systemctl --user status codex-update-manager.service
codex-update-manager status --json
codex-update-manager diagnose --json
sed -n '1,160p' ~/.local/state/codex-update-manager/state.json
sed -n '1,160p' ~/.local/state/codex-update-manager/service.log
```

`diagnose` is read-only and intended for post-update support reports. It checks
the persisted updater state, installed app executable, launcher `app.pid` and
`webview.pid`, local webview HTTP endpoint, warm-start handoff socket, and
Linux build metadata without starting, stopping, installing, or repairing
anything.

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
close ChatGPT Desktop and run:

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
fresh upstream `Codex.dmg`, builds the native package, and installs it. The
rebuild uses the shared [upstream DMG acceptance profile](upstream-dmg-acceptance.md);
rejected and inconclusive candidates never replace the working generated app
or advance to package installation.
The rebuild evaluates only the Linux Features selected in the user's saved
configuration. Drift in any selected feature rejects the candidate; disable
that feature and retry if receiving the upstream update is more important than
retaining it.

Automated user-local rebuilds always force
`CODEX_INSTALL_ALLOW_RUNNING=0` and `CODEX_ACCEPTANCE_OVERRIDE=0`, even if the
service or invoking shell inherited developer overrides. The in-app update path
continues through its after-exit hook and relaunches after a successful update.
A manual command or timer may build while the app is open, but final promotion
is refused and the working app remains unchanged until Electron exits. Failed
promotion candidates are disposable by default; opt in to diagnostic retention
with `CODEX_KEEP_REJECTED_CANDIDATE=1`.

Transactional user-local installs retain one previous-app directory for manual
recovery. Each successful promotion replaces that retained backup with the
version that was working immediately beforehand; older exact managed backup
directories are pruned under the promotion lock.

Updater downloads are streamed to unique temporary files and published as
`Codex-<sha256>.dmg` only after the file and parent directory are synced. The
content-addressed path stays immutable while daemon and wrapper rebuild flows
consume it under a shared lease, so cleanup and concurrent rebuilds cannot
truncate or remove another build's DMG input. Startup and post-build cleanup
retain the DMG referenced by updater state, remove older managed hash files,
and delete strictly named download temporaries left by a killed process.
Unrelated files and symlinks in `downloads/` are never removed.

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

Launching ChatGPT Desktop and upgrading the package will not re-enable a disabled
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
