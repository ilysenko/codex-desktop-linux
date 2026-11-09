# Generated and runtime notes

Do not edit or commit generated application/package state:

- `codex-app/`, `codex-app-next/`, `codex-app.backup-*`,
  `.codex-app.candidate-*`
- `codex-*-app/`, `dist/`, `dist-next/`, `target/`
- `linux-features/features.json`, `linux-features/local/`
- staged feature manifests and build/patch reports
- updater config/state/cache/log directories under XDG paths

The local selection files are intentionally untracked:

```text
linux-features/features.json
linux-features/local/<id>/
```

Do not replace them with committed defaults or include private local feature
code in a pull request by accident.

The baseline staged tree is extracted from `/usr/lib/chatgpt` in the verified
official package. Its runtime, native modules, commands, libraries, locales, and
Owl metadata remain upstream-owned. `start.sh` and `.codex-linux/` are generated
from repository templates and feature manifests.

When both required core and enabled feature descriptor sets are empty, compare
`resources/app.asar` from the verified official input `.deb` with the staged
app's copy: their SHA-256 values must match and no extraction occurs. With
active descriptors, consult the patch report for core/feature outcomes and
hashes; no reported changes still preserve the official archive. An empty
feature config does not imply an empty core registry. In either case, the ASAR
inside a custom output package must match that output's staged copy.

Expected generated metadata under `codex-app/.codex-linux/` includes build-info
schema v2, the enabled feature snapshot, launcher hook directories, the
community icon, and patch/build reports where applicable. These are regenerated
from repository templates and manifests.

The official payload should continue to supply:

- `ChatGPT` and its Electron libraries;
- `resources/app.asar`;
- Linux native modules;
- bundled `codex`, `rg`, and code-mode host;
- bundled official plugins, locales, assets, and Owl metadata.

A generated tree containing a downloaded replacement Electron, an external CLI
bundle, rebuilt upstream native modules, or a local webview HTTP server signals
that retired architecture has been reintroduced.

Manual generated-tree candidates are siblings of the target tree; replacing an
existing tree uses atomic directory exchange and a promotion journal. Native
updater candidates instead live in the configured build workspace and install
through the package manager, with a durable package transaction and owner-based
recovery. Package failure may leave partial changes. Do not manually rename an
active/candidate pair or delete either workflow's recovery journal.
An old root-owned `codex-app.backup-*` is disposable only after verifying it is
not the active tree or the updater's recorded rollback artifact.

Package manager output under `/opt/codex-desktop` is installed state, not a
development source tree. Fix templates in the repository, rebuild a package,
and reinstall rather than modifying `/opt` in place.

## Shared Object bridge retirement

The upstream Linux interface comparison records the retirement of
`electronBridge.getSharedObjectSnapshotValue`, the
`codex_desktop:get-shared-object-snapshot` IPC entry, the shared-object
snapshot/set/subscribe/unsubscribe/update channels, and the main-process
`sharedObjectRepository` between packages `26.1027.51404` and `26.1029.61003`.

The `26.1103.60933` compatibility audit found zero repository-owned consumers
across the tracked bridge, request, settings, launcher, updater and feature
sources. A separate static census covered both architecture extracts, and nine
actual repository generator outputs covered Chronicle/Record & Replay handlers,
the Remote device-key provider, the Computer Use cursor bridge, sidebar styling
and the Work Power resolver contribution. The complete feature-output census is
part of final integration validation.

New injected state and request adapters resolve the current native owner or
use their feature-owned state hooks. Source inspection and generated-code
checks establish the consumer scope. Live GUI state operations and IPC
subscriptions retain their separate runtime validation scope.

## Review delivery protocol

The signed `26.1103.60933` package bundles CLI `0.167.0-alpha.3.2`. Its offline
schema exports contain 322 files by default and 470 with experimental methods.
Both exports define the app-server `ReviewDelivery` string enum as `inline`.
`ReviewStartParams.delivery` permits omission, `null`, or `inline`. An
independent review thread starts with `thread/start`, and `review/start` then
uses that thread's ID.

The Desktop review UI also has an `inline`/`detached` preference. Its detached
path creates a `code_review` conversation and submits an ordinary text turn.
That preference and its translated labels retain their UI meaning. A
repository-owned app-server request constructor follows the generated wire
schema for its delivery field.

The consumer audit found zero repository-owned `review/start` request
constructors or `ReviewDelivery` consumers. Its evidence consists of signed CLI
identity, offline schema exports and static source/client classification. Real
review completion has a separate runtime evidence scope.
