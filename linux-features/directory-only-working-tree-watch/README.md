# Directory-Only Working-Tree Watch

This opt-in Linux feature replaces Codex Desktop's recursive working-tree
`fs.watch` call with [Watchbound](https://www.npmjs.com/package/watchbound).
Watchbound owns recursive inotify topology, process-wide native-watch
allocation, bounded delivery, coverage reporting, reconciliation, root
replacement, and joined disposal. The Codex feature remains a policy adapter:
it computes Git and user-configured exclusions, maps physical invalidations
back to Codex logical paths, watches Git metadata targets, and keeps Codex's
focus-recovery contract active.

Electron's Node runtime can allocate one inotify watch for every file and
directory when `recursive: true` is used on Linux. Watchbound instead owns one
logical interest per included directory, shares overlapping native watches,
and reports partial or uncertain coverage when it cannot safely claim complete
coverage.

## Current OpenAI working-tree route

OpenAI Desktop `26.803.41515` has a Linux-specific Parcel working-tree path in
the official macOS DMG. That path calls `@parcel/watcher` directly instead of
the local `startFileWatch()` method this feature intercepts. When this feature
is selected, its current-DMG patch reroutes that one local recursive
working-tree request through `startFileWatch()`, where the exact recursive
working-tree contract enters Watchbound. Remote watches and non-working-tree
file watches retain their existing routes.

Both Parcel references originate in the upstream app: `.vite/build/worker.js`
contains the sole dynamic ``await import(`@parcel/watcher`)``, and the extracted
app's `package.json` declares `"@parcel/watcher": "2.5.6"`. This feature adds
neither reference. Qualified roots do not run Parcel; the preserved helper is
invoked only when Watchbound cannot safely qualify the root.

The Parcel route and the Watchbound adapter are alternative owners of the same
working-tree subscription; they do not run together. Qualified roots use
Watchbound. A permanently unqualified root uses the preserved upstream Parcel
helper, while unknown qualification evidence is retried with bounded
exponential backoff before taking that fallback. This feature requires exactly
one raw Parcel route or one completed Watchbound route marker in the current
`worker.js`. Missing, duplicate, or misplaced routes report enabled feature
drift and leave both current app bundles byte-identical rather than accepting
an injected helper that the active call path bypasses.

The route matcher does not pin minifier-generated identifier spellings. It
captures and correlates the Parcel helper, helper arguments, Git execution-host
factory, main connection, local host, route host, route options, and path API
across one complete semantic contract. Alias-only upstream churn therefore
remains patchable, while mismatched aliases, partial lookalikes, changed
ownership, duplicate contracts, or reordered semantics still fail closed.

This differs from the separate `shallow-repository-watches` feature. That
strategy changes Linux recursive requests to non-recursive watches and relies
on Codex focus recovery for deep changes. Watchbound retains bounded recursive
coverage of included directories, reports partial or uncertain coverage, and
uses the same focus recovery as a safety net. The features remain opt-in
alternative policies; do not enable both at once.

## Current package boundary

The integration pins the official Watchbound `2.1.1` wrapper, neutral loader,
x64 GNU target, ARM64 GNU target, and ARMv7 GNU hard-float target archives. The
artifact manifest records each registry URL, npm integrity, npm shasum, archive
SHA-256, complete file contract, and native SHA-256. It must contain all three
supported Codex Linux architectures, while staging selects exactly one target
for the build architecture. Musl, ARM soft-float or unknown ARM ABIs, and
non-Linux targets are rejected by Watchbound's runtime qualification. The
selected `.node` file is unpacked by the existing ASAR native-file rule.

Normal builds fetch the pinned npm packages. The manifest pins five archives in
total; a fully offline build provides the three selected for its architecture:

```bash
export CODEX_WATCHBOUND_ARCHIVE=/path/to/watchbound-2.1.1.tgz
export CODEX_WATCHBOUND_NODE_ARCHIVE=/path/to/gadicc-watchbound-node-2.1.1.tgz
export CODEX_WATCHBOUND_NODE_X64_ARCHIVE=/path/to/gadicc-watchbound-node-linux-x64-gnu-2.1.1.tgz
# Use CODEX_WATCHBOUND_NODE_ARM64_ARCHIVE on ARM64 or
# CODEX_WATCHBOUND_NODE_ARM_ARCHIVE on ARMv7/armhf.
./install.sh ./Codex.dmg
```

Watchbound `2.1.1` qualifies x64, ARM64, and exact little-endian ARMv7
hard-float GNU/Linux with a Linux 5.15 floor, Node 24.15–24.x, and a GLIBC 2.35
baseline. Its native matrix covers Ubuntu 22.04/24.04, Debian 12, Fedora 42,
openSUSE Tumbleweed, Nix, and Arch on x64; ARM64 has the same lanes except Arch.
ARMv7 has deterministic cross-build/package evidence plus production loader
and watch lifecycles under pinned QEMU-user Electron 42.3.0 and a booted ARMHF
5.15 kernel; this is emulated qualification, not native-hardware or performance
evidence. The adapter consumes capability schema 9 and requires binding API 5,
lockstep wrapper/native/engine `2.1.1` identities, native directory-name exclusions,
observed excluded paths, exact path bytes, root qualification, physical root
resolution, and `support.currentRuntime.targetCompatible`. It requires
`qualifyRoot()` to approve the actual workspace and verifies that the
established physical root still matches that qualification snapshot. It does
not recreate Watchbound's target or root decision from host strings.

Build-time runtime qualification does not execute the downloaded Electron
binary. The extracted app's pinned Electron dependency must match the exact
Electron/Node pair in the checked-in Watchbound artifact manifest; a mismatch
rejects this enabled feature before package materialization.

Nix builds do not run npm or perform unpinned registry resolution. The flake
pins Watchbound's `v2.1.1` source commit and archive digest, builds the selected
native target from its Cargo lock, and fetches the wrapper and neutral loader
as fixed-output archives using the same checked-in artifact manifest as normal
builds. It byte-verifies both JavaScript packages against that manifest before
staging the three-package runtime tree. This follows Watchbound's qualified Nix
route on both `x86_64-linux` and `aarch64-linux`.

## Maintenance and failure model

This remains an optional feature and is disabled by default. Watchbound is the
only feature-owned topology engine and remains the normal owner for qualified
roots. Qualification happens before an engine or subscription is created.
Permanent `unqualified` results immediately preserve correctness by returning
the existing upstream Parcel watcher; `unknown` results retry after 250, 500,
1000, and 2000 milliseconds before doing the same. Identical fallback
diagnostics are deduplicated process-wide. Calls outside the Git Parcel route
fall through to their original local watcher instead. Every path has exactly
one watcher owner, and the feature adds no polling.

Watchbound upgrades are deliberate lockstep changes. An upgrade must refresh
the source revision, Cargo lock, every supported published target, the complete
archive/file manifest, the capability contract, and the latest-DMG fixture.
The focused integration suite, all-system flake evaluation, and the
Watchbound-enabled watchdog output then exercise that state. Missing targets,
package drift, runtime mismatch, current-DMG drift, or an unprovable rollback
reject an enabled-feature candidate; users who leave the feature disabled do
not enter this package or patch path.

## Policy retained by Codex

The adapter gives Watchbound an exact directory-name exclusion for `.git` at
every depth and observes the root `.git` boundary without traversing it. Codex
keeps at most two small non-recursive `fs.watch` policy watches around the Git
index and `.git/info/exclude` targets. They deliberately sit outside
Watchbound's recursive process budget so a saturated large working tree cannot
starve Git policy refresh. Changes to those targets, the observed root `.git`
boundary, or a working-tree `.gitignore` recompute the complete exclusion
policy and atomically replace it in the main subscription.

Establishment first excludes the root while the initial Git snapshot is
computed. The first generation replacement removes that root prefix and
atomically installs the observed `.git` boundary; the second snapshot closes
the pre-observation window. Watchbound does not permit an observed path below
an independently excluded proper prefix, so the staged establishment is
intentional.

Directories are pruned for Git policy only when Git reports that the directory
itself is ignored and untracked. A force-added tracked file therefore keeps its
containing directory included. Ignored files are not excluded independently:
their parent directory remains watched, so a root-level file such as
`.env.local` still produces an invalidation.

There are no user-configured default name exclusions. A tracked directory named
`build` or `node_modules` remains included unless the user explicitly configures
that basename. Configured names are exact directory components, not patterns.
Watchbound prunes matching existing, future, and renamed-in subtrees at every
depth before installing descendant watches or delivering descendant events.
The complete name, observed-boundary, and Git-prefix policy is replaced as one
generation.

## Budget and coverage

By default, the process-wide Watchbound engine uses at most 8192 unique native
watches, or one eighth of the kernel's `fs.inotify.max_user_watches` value when
that is lower. The configurable ceiling is 65536. The Git metadata policy
watches do not consume this budget; each working tree can add at most two
non-recursive policy watches outside it. Watchbound performs fair allocation
and promotion across active recursive subscriptions.

When coverage becomes partial or uncertain, the adapter logs one warning for
the episode and sends Codex a conservative root invalidation. A later complete
batch logs recovery. The returned watcher deliberately reports
`recursive: false`, even though Watchbound recursively covers included paths,
so Codex's existing focus-recovery path remains active.

Watchbound invalidations are not exact create/update/delete history. The
adapter treats them as conservative recomputation boundaries. A representable
child invalidation maps to the matching Codex logical path and, for the current
upstream rename policy, its parent. Root, non-representable, partial, uncertain,
or lost-root batches collapse to an empty `changedPaths` root invalidation.

Root aliases are resolved once with Watchbound's `resolve-physical` policy.
Git policy, metadata watches, callback classification, and logical-path mapping
all use the returned physical root; later alias retargeting does not move the
subscription. A physical root that cannot be represented as a Node string is
rejected because Codex's Git and logical-path adapters cannot safely operate in
a bytes-only root namespace.

Root replacement remains an explicit application policy. This feature matches
its previous behavior by retrying
`recoverRoot({ identityPolicy: "accept-replacement" })` with bounded backoff.
Every restored or adopted physical root must pass `qualifyRoot()` again before
Codex resumes policy evaluation or accepts further change delivery.

## Enable and configure

Enable the feature in `linux-features/features.json` and rebuild:

```json
{
  "enabled": [
    "directory-only-working-tree-watch"
  ]
}
```

Optional settings retain the existing feature surface:

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

Set `honorGitIgnore` to `false` to retain Git-ignored working-tree directories.
Exact `.git` directories remain excluded and the root `.git` boundary remains
observed. Name-based exclusions can hide a legitimately tracked directory with
the same basename and are therefore disabled by default.

NixOS and Home Manager users can select the same feature:

```nix
programs.codexDesktopLinux.linuxFeatures = [
  "directory-only-working-tree-watch"
];
```

## Tests

Watchbound now owns the low-level topology, overflow, allocation, fairness,
reconciliation, recovery, exact-byte, cancellation, and disposal suites. This
repository tests only its integration boundary: patch drift, settings, artifact
staging, the current OpenAI Parcel-route handoff, native-policy wiring, Git
policy, logical invalidation mapping, root recovery choice, and teardown.

```bash
node --test linux-features/directory-only-working-tree-watch/test.js
```
