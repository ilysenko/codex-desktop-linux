# Upstream DMG Intelligence

Use this lane when OpenAI ships a new macOS `Codex.dmg` and Linux parity work
needs to know what moved before accepting the build.

The intelligence command is report-only. It extracts a candidate DMG or scans an
already extracted `.app`, inventories protected surfaces, and writes a JSON plus
Markdown battle report under `reports/upstream-dmg/<timestamp>/`. That directory
is gitignored; check in only deliberate fixtures or registry changes.

## Commands

Current upstream-vs-cached baseline check, using the repo devcontainer image:

```bash
make inspect-upstream-intel-devcontainer
```

The devcontainer wrapper is the preferred path for real DMG checks because it
keeps `7zz`, Node, `jq`, and report-generation dependencies inside the project
container. With no `DMG=...`, it downloads the current upstream DMG into the
gitignored `reports/upstream-dmg/downloads/` directory and automatically uses
repo `./Codex.dmg` as the baseline when that cached file exists and differs
from the candidate. It builds `codex-desktop-linux-devcontainer:local` from
`.devcontainer/Dockerfile` if that image is missing, mounts outside candidate
or baseline paths into the container, and writes only the ignored report bundle
under `reports/upstream-dmg/` by default.

Inspect a specific candidate DMG without spelling out the baseline:

```bash
make inspect-upstream-intel-devcontainer DMG=/tmp/Codex-new.dmg
```

Host-side candidate-only inventory is still available when the host already has
the same toolchain:

```bash
make inspect-upstream-intel DMG=./Codex.dmg
```

For CI or release acceptance, keep report generation unchanged but fail the
command when protected-surface blockers are present:

```bash
scripts/dev/upstream-dmg-intel.js \
  --candidate /path/to/new/Codex.dmg \
  --fail-on-blockers
```

Explicit baseline comparison remains available for older known-good builds:

```bash
scripts/dev/upstream-dmg-intel.js \
  --baseline /path/to/known-good/Codex.app \
  --candidate /path/to/new/Codex.dmg
```

Pair it with the existing patch report path:

```bash
make inspect-upstream DMG=/path/to/new/Codex.dmg
make inspect-upstream-intel-devcontainer DMG=/path/to/new/Codex.dmg
```

When `dist-next/rebuild/patch-report.json` exists, `make inspect-upstream-intel`
folds it into the drift report. Required patch failures are classified as
blocking `PATCH_BROKEN`; optional skipped or warning statuses are classified as
review-only `PATCH_REVIEW`.

## Outputs

Each run writes:

- `inventory.json`: normalized file inventory from resources, `app.asar`, and
  extracted `app.asar.extracted` fixtures when present.
- `protected-surfaces.json`: checked registry surfaces with evidence paths,
  string hits, fingerprints, and Linux substrate status.
- `bridge-map.json`: Electron IPC/context bridge handler names plus minified
  string-literal channel candidates found in scanned text bundles.
- `plugin-map.json`: bundled plugin manifests, MCP configs, and skill files.
- `native-binary-map.json`: native candidate paths, file type output when
  available, hashes, and protected string evidence.
- `map-drift.json`: baseline/candidate structural deltas for bridge handlers,
  plugin ids/files, MCP tools, native binaries, and Linux substrate gaps.
- `drift-report.json` and `drift-report.md`: machine and human drift summaries.
- `substrate-action-plan.md`: Linux follow-up paths for moved, changed, missing,
  newly discovered, patch-broken, or substrate-gap surfaces.

The CLI stdout summary includes `decision.acceptance`, `blockersCount`,
`reviewItemsCount`, protected-surface status counts, and whether every protected
surface is fully present. `--fail-on-blockers` exits with status `2` after
writing the report bundle when `decision.blockersCount` is nonzero.

When a baseline is provided, the command also writes `baseline/` and
`candidate/` subdirectories with their own inventory, protected-surface,
bridge, plugin, and native-binary maps so root-cause drift can be inspected
without reverse-engineering the summary report.

## Protected Surfaces

The checked-in registry lives at:

```bash
scripts/dev/upstream-dmg-protected-surfaces.json
```

It currently protects the surfaces Linux mirrors or patches most aggressively:

- `codex_chronicle`
- `chronicle_settings_toggles`
- `sky_computer_use_client`
- `skysight_bridge`
- `event_stream_mcp`
- `record_and_replay_plugin`
- `computer_use_plugin`
- `chrome_native_messaging`
- `dictation_transcript_finalization`
- `browser_window_metadata`
- `electron_ipc_bridge_handlers`
- `plugin_manifests_marketplace`
- `native_bridge_sidecars`
- `browser_use_plugin`
- `browser_use_node_repl_runtime`
- `browser_use_native_pipe_bridge`
- `browser_use_policy_shims`

Do not treat registry names as proof that upstream still uses those names. The
scanner records actual path, content, plugin, bridge, native string, and hash
evidence from the candidate build.

Registry entries can declare `requiredEvidence` anchors. A surface is `PRESENT`
only when those anchors are satisfied; loose matches are reported as `PARTIAL`
with `satisfiedAnchors`, `missingAnchors`, and `confidence` fields.

The `chronicle_settings_toggles` surface intentionally protects both Settings
routes that can change Chronicle state:

- the dedicated Chronicle research preview row, including enable and disable
  handlers;
- the broad Memory master toggle path that calls `chronicleDisable` while
  changing memory feature/config state.

If either route moves or disappears, treat it as a Chronicle/Skysight parity
review item before accepting the upstream DMG.

## Drift Classifications

- `UNCHANGED`: the protected surface is present with the same evidence paths and
  fingerprint.
- `MOVED`: the surface is still present, but evidence paths changed.
- `RENAMED`: reserved for future structured rename hints.
- `PAYLOAD_CHANGED`: paths remained stable, but content or native string
  evidence changed.
- `REMOVED`: a baseline-present surface disappeared from the candidate.
- `NEW_UPSTREAM_CAPABILITY`: a candidate-present surface was missing in the
  baseline.
- `PATCH_BROKEN`: a required patch-report failure matched this protected
  surface.
- `PATCH_REVIEW`: an optional patch-report warning or skip matched this
  protected surface.
- `LINUX_SUBSTRATE_GAP`: upstream evidence exists, but the registry's required
  Linux substrate path is missing.

## Acceptance Gate

The automated tests use synthetic `.app` fixtures and `app.asar.extracted`
directories so normal verification does not rebuild Electron or require the real
DMG. Manual real-DMG verification is still required before accepting a new
upstream build. The normal path downloads current upstream and compares it to
the cached repo baseline:

```bash
node --test scripts/dev/upstream-dmg-intel.test.js
scripts/dev/upstream-dmg-intel-devcontainer \
  --output-dir reports/upstream-dmg/<run-id>
```

Review `protected-surfaces.json` first. A candidate should not be accepted while
required protected surfaces are `PARTIAL` or `MISSING` unless the Linux substrate
owner has explicitly retired or replaced that contract. Then review
`drift-report.json`, `drift-report.md`, and `substrate-action-plan.md` as the
navigation layer:

- `MOVED` with no structural bridge/plugin/MCP/native additions or removals is
  usually hashed asset churn; update Linux code only when a patch, staging rule,
  or mirror references one of the old paths.
- `PAYLOAD_CHANGED` means a stable protected file changed hash or size. Review
  the listed file samples and run the owning Linux feature or backend tests.
- `REMOVED`, `PROTECTED_SURFACE_MISSING`, `PROTECTED_SURFACE_PARTIAL`,
  `PATCH_BROKEN`, and `LINUX_SUBSTRATE_GAP` are acceptance blockers until the
  registry, patch, or Linux substrate action is resolved. `PATCH_REVIEW` remains
  review-only unless the protected surface is also missing, partial, removed, or
  has a required patch failure.
