# Directory-Only Working-Tree Watch

This opt-in Linux feature replaces Codex Desktop's recursive working-tree
`fs.watch` call with one non-recursive watch per relevant directory. Electron's
Node runtime currently allocates one inotify watch for every file and directory
when `recursive: true` is used on Linux, so large dependency and build trees can
exhaust the per-user inotify limit.

The feature keeps recursive change detection by maintaining directory watches
as directories are created, renamed, deleted, or replaced. It skips recursive
traversal of every `.git` directory; Codex retains its dedicated Git metadata
watches, and this feature adds small directory watches around the Git index and
`.git/info/exclude` so ignore topology follows index and exclude changes.

Directories are pruned only when Git confirms that the directory itself is
ignored and untracked. An unignored wrapper directory remains watched even if
all of its current contents are ignored, and a force-added tracked file keeps
its containing directory watched. Ignored files are not skipped: their parent
directories remain watched, so a root-level file such as `.env.local` still
produces an event.

There are no default name-based exclusions. A tracked directory named `build`
or `node_modules` remains watched even if its name resembles generated output.

By default, the watcher uses at most 8192 inotify watches per app process across
all active working trees, or one eighth of the kernel's
`fs.inotify.max_user_watches` value when that is lower. The configurable ceiling
is 65536. The shared process budget also includes this feature's Git index and
exclude refresh watches. If another working tree temporarily consumes the
remaining budget, a root can wait for a watch to be released instead of failing
and entering Codex's retry loop. Separate `--new-instance` app processes have
independent budgets.

Uncovered working-tree roots get first claim on released capacity. Remaining
capacity is reserved round-robin across partially covered trees instead of
always being reclaimed by the tree that released it. Competing trees receive
at most 256 reserved slots per allocation pass, so a stalled filesystem cannot
hold all future headroom; reservations also constrain topology work that was
already queued when capacity became available.

When the app is launched through its generated launcher, reaching the
configured budget writes one warning per partial-coverage episode to the
launcher log. Its normal location is
`${XDG_CACHE_HOME:-$HOME/.cache}/$CODEX_LINUX_APP_ID/launcher.log` (usually
`~/.cache/codex-desktop/launcher.log`); `--new-instance` launches use
`launcher-port-<port>.log` in the same directory. A later complete
reconciliation writes one recovery message. Repeated reconciliations while
coverage remains partial do not repeat the warning. Operating-system watch
resource failures are logged separately once per app process at error level.

The watcher deliberately reports partial recursive coverage to Codex. That
keeps the existing focus-recovery path active so Git query state is refreshed
when the app regains focus, even if a subtree was skipped or the budget was
reached. Focus recovery does not itself rebuild the directory-watch topology.

Enable it in `linux-features/features.json` and rebuild:

```json
{
  "enabled": [
    "directory-only-working-tree-watch"
  ]
}
```

NixOS and Home Manager users can instead add the ID to the module's
`linuxFeatures` list:

```nix
programs.codexDesktopLinux.linuxFeatures = [
  "directory-only-working-tree-watch"
];
```

Pure-flake selection currently uses this feature's shipped defaults; the
per-feature settings below are available through the regular
`linux-features/features.json` flow, not the Nix module option.

Optional build-time settings can change the budget or add an explicit
name-based exclusion list. Git-ignored directories are included when
`honorGitIgnore` is set to `false`; `.git` remains excluded because its state is
covered by the dedicated metadata watches:

```json
{
  "enabled": [
    "directory-only-working-tree-watch"
  ],
  "settings": {
    "directory-only-working-tree-watch": {
      "maxWatches": 4096,
      "honorGitIgnore": true,
      "ignoredDirectoryNames": [
        "node_modules",
        ".next",
        ".venv"
      ]
    }
  }
}
```

## Tradeoffs and risks

- Changes inside excluded directories do not trigger immediate Git-query
  invalidation. Git-ignored, untracked content normally does not affect those
  queries.
- Name-based exclusions can hide a legitimately tracked directory with the
  same name. They are disabled by default; use `ignoredDirectoryNames` only
  when that tradeoff is intentional.
- Changes to `.gitignore`, the Git index, and `.git/info/exclude` refresh the
  watch topology. Changes to a global Git excludes file require a restart to
  rebuild the topology.
- Git subprocesses are asynchronous, disable repository filesystem-monitor
  hooks, and are individually limited to five seconds. If an ignore query times
  out or fails, that refresh conservatively falls back to watching directories
  up to the shared budget without blocking Electron's event loop. Retryable
  ignore-query failures and incomplete metadata-target discovery are retried
  with exponential backoff from one to thirty seconds.
- Transient operating-system resource failures during Git metadata discovery,
  directory-topology traversal, or creation of a non-root working-tree or
  metadata directory watch are retried with capped exponential backoff.
  Non-resource Git metadata-watch failures use the same bounded-backoff refresh
  path so conservative working-tree coverage can remain active.
  Intentional exhaustion of this feature's configured watch budget uses the
  separate released-capacity recovery path and does not poll.
- Other working-tree directory-watch or traversal failures that leave topology
  coverage incomplete receive two bounded full-tree recovery attempts before
  the session returns control to Codex's existing watcher retry path.
- Directory topology scans read one directory at a time with promise
  `readdir`, yield while processing large results, and are serialized with Git
  refreshes. Promise `readdir` deliberately trades per-directory array
  allocation for avoiding Node's synchronous `DT_UNKNOWN` fallback on
  filesystems such as NFS or FUSE. Repeated topology events are coalesced into
  at most one follow-up reconciliation while work is queued or running. A burst
  of more than 256 distinct rename paths collapses into one full topology
  reconciliation rather than retaining or synchronously probing every path.
- This is an upstream-bundle patch. Drift in the enabled feature rejects a
  rebuild candidate instead of silently restoring the unbounded watcher.

Before considering this feature for default or core Linux behavior, persistent
zero-watch coverage should gain a deduplicated in-app notice with an Open Logs
or troubleshooting action. Actual operating-system watch resource failures
should also be surfaced in-app because they mean the configured reserve was
unavailable.

Ordinary partial coverage should remain log-only: the cap is deliberate and
Codex's focus-recovery path remains active.

## Test

```bash
node --test linux-features/directory-only-working-tree-watch/test.js
```
