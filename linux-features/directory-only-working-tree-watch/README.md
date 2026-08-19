# Directory-Only Working-Tree Watch

This opt-in Linux feature replaces ChatGPT Community's recursive working-tree
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

OpenAI Desktop `26.814.41957` has a Linux-specific Parcel working-tree path in
the official Linux package. That path calls `@parcel/watcher` directly instead of
the local `startFileWatch()` method this feature intercepts. When this feature
is selected, its current-package patch reroutes that one local recursive
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

The integration pins the official Watchbound `2.1.2` wrapper, neutral loader,
x64 GNU target, and ARM64 GNU target archives. The
artifact manifest records each registry URL, npm integrity, npm shasum, archive
SHA-256, complete file contract, and native SHA-256. It must contain both
officially supported ChatGPT Linux architectures, while staging selects exactly
one target for the build architecture. Musl, ARMv7/armhf, and
non-Linux targets are rejected by Watchbound's runtime qualification. The
selected `.node` file is unpacked by the existing ASAR native-file rule.

Normal builds fetch the pinned npm packages. The manifest pins four archives in
total; a fully offline build provides the three selected for its architecture:

```bash
export CODEX_WATCHBOUND_ARCHIVE=/path/to/watchbound-2.1.2.tgz
export CODEX_WATCHBOUND_NODE_ARCHIVE=/path/to/gadicc-watchbound-node-2.1.2.tgz
export CODEX_WATCHBOUND_NODE_X64_ARCHIVE=/path/to/gadicc-watchbound-node-linux-x64-gnu-2.1.2.tgz
# Use CODEX_WATCHBOUND_NODE_ARM64_ARCHIVE on ARM64.
./install.sh /path/to/chatgpt_<version>_<arch>.deb
```

Watchbound `2.1.2` qualifies x64 and ARM64 GNU/Linux with a Linux 5.15 floor,
Node 18.15 or newer with Node-API 6 or newer, and a GLIBC 2.35
baseline. Its native matrix covers Ubuntu 22.04/24.04, Debian 12, Fedora 42,
openSUSE Tumbleweed, Nix, and Arch on x64; ARM64 has the same lanes except Arch.
The checked-in consumer manifest records the signed Owl runtime's Node 24.14.
The adapter consumes capability schema 9 and requires binding API 5,
lockstep wrapper/native/engine `2.1.2` identities, native directory-name exclusions,
observed excluded paths, exact path bytes, root qualification, physical root
resolution, and `support.currentRuntime.targetCompatible`. It requires
`qualifyRoot()` to approve the actual workspace and verifies that the
established physical root still matches that qualification snapshot. It does
not recreate Watchbound's target or root decision from host strings.

Watchbound `2.1.2` no longer reads `process.report`, whose native
`getReport()` aborts inside the packaged Owl executable. Its loader reads the
exact bounded `PT_INTERP` segment from `/proc/self/exe`, opens that exact
interpreter, and runs the already-open descriptor as `/proc/self/fd/3
--version` under bounded output and timeout limits. The loader records this
admission snapshot and the public capability layer consumes the same evidence.
The downstream report shim from #1336 is therefore removed; import refusal
still degrades to the preserved Parcel route (worker) or original local watch
(src bundle) instead of crashing.

The Nix `PT_INTERP` relocation from #1332 remains necessary for upstream
`@parcel/watcher`, which still owns the disabled-feature and unqualified-root
fallback routes. Watchbound itself accepts the relocated interpreter without
a consumer-side compatibility path.

Build-time runtime qualification does not execute the upstream Electron
binary. The extracted app's pinned Electron dependency must match the exact
Electron version in the checked-in Watchbound artifact manifest, and an
explicit target Node version must satisfy Watchbound's published `>=18.15.0`
range. A mismatch rejects this enabled feature before package materialization.

Nix builds do not run npm or perform unpinned registry resolution. The flake
pins Watchbound's `v2.1.2` source commit and archive digest, builds the selected
native target from its Cargo lock, and fetches the wrapper and neutral loader
as fixed-output archives using the same checked-in artifact manifest as normal
builds. It byte-verifies both JavaScript packages against that manifest before
staging the three-package runtime tree without rewriting their runtime
metadata. This follows Watchbound's qualified Nix route on both `x86_64-linux`
and `aarch64-linux`.

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
archive/file manifest, the capability contract, and the latest-package fixture.
The focused integration suite, all-system flake evaluation, and the
Watchbound-enabled watchdog output then exercise that state. Missing targets,
package drift, runtime mismatch, current-package drift, or an unprovable rollback
reject an enabled-feature candidate; users who leave the feature disabled do
not enter this package or patch path.

## Runtime diagnostics

After opening a local working tree, this line confirms that Watchbound owns the
route rather than Parcel:

```text
INFO: directory-only working-tree watch established with Watchbound 2.1.2 for <root> (target=<target>, native=<count>, limit=<budget>).
```

It is emitted once per resolved physical root per app process, after that
root's native subscription, identity, Git policy, and initial complete
working-tree coverage are established. Reopening the same project, including
through an alias of the same physical root, does not repeat the line. The
remaining diagnostics distinguish the fallback and degraded states:

- `runtime rejected Watchbound` means the packaged runtime failed a supported
  platform, libc, kernel, Node, or Node-API check. The named upstream watcher
  is used instead. Missing, corrupt, or API-incompatible Watchbound packages
  remain hard errors and do not silently fall back.
- `root is unqualified` means Watchbound definitively rejected that particular
  working-tree root, so the upstream Parcel watcher is selected immediately.
- `root is unknown after 4 bounded retries` means root qualification stayed
  indeterminate or threw. The adapter retries after 250, 500, 1000, and 2000
  milliseconds, then preserves correctness by selecting Parcel.
- `coverage is partial` or `coverage is unknown` means Watchbound still owns
  the route but cannot currently claim complete recursive coverage. The
  adapter sends a conservative root invalidation and keeps Codex focus recovery
  active; `coverage recovered` confirms the episode ended.
- Configuration warnings identify an invalid or capped feature setting and
  state the effective default or limit that will be used.

Fallback diagnostics are deduplicated process-wide, while coverage warnings
appear once per incomplete episode. The success line is therefore the clearest
positive confirmation for the named root; its absence can also mean that the
working tree has not attempted the route yet or that the same physical root was
already logged through another path.

Completely exit an existing app instance before launching from a terminal,
because the existing single-instance process owns its logs:

```bash
/opt/codex-desktop/start.sh 2>&1 | rg --line-buffered \
  'directory-only[ -]working-tree[ -]watch|Watchbound|Parcel'
```

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

The exact-candidate signed Owl acceptance harness and its durable sanitized
evidence are documented in [`acceptance/README.md`](acceptance/README.md). It is
consumer-owned, requires the recorded signed executable, and is intentionally
not a substitute for ordinary feature unit tests or ARM64 qualification.

Watchbound now owns the low-level topology, overflow, allocation, fairness,
reconciliation, recovery, exact-byte, cancellation, and disposal suites. This
repository tests only its integration boundary: patch drift, settings, artifact
staging, the current OpenAI Parcel-route handoff, native-policy wiring, Git
policy, logical invalidation mapping, root recovery choice, and teardown.

```bash
node --test linux-features/directory-only-working-tree-watch/test.js
```
