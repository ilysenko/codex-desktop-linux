# Record & Replay

Opt-in Linux integration for Record & Replay demo-to-skill workflows.

This feature stages the official `Record & Replay` bundled plugin shell from
the current Linux package when it is available, swaps the unavailable helper for a
Linux `event-stream` helper, and keeps the fallback template aligned with that
same contract. The staged plugin launches `./bin/SkyLinuxComputerUseClient
event-stream mcp`; that helper is backed by the Rust
`codex-record-replay-linux` binary. The Rust helper records Linux workflow
evidence into a bundle, generates a skill-drafting prompt, and imports
generated skills as ordinary Codex skill folders.

It is disabled by default. Enable it in `linux-features/features.json`:

```json
{
  "enabled": [
    "record-and-replay"
  ]
}
```

## Build Prerequisite

The project release builds `codex-record-replay-linux` once and copies it into
`resources/native/`, the staged plugin
`bin/codex-record-replay-linux`, and the official-shaped plugin helper alias
`bin/SkyLinuxComputerUseClient`. `make install-native` performs that release
build once before staging. Direct `./install.sh` builds may set
`CODEX_RECORD_REPLAY_LINUX_SOURCE` to an executable prebuilt binary. Updater
rebuilds reuse the packaged artifact and never invoke Cargo.

## Behavior

- Records semantic evidence, not coordinate macro playback.
- Creates bundles with `manifest.json`, `timeline.jsonl`, screenshots,
  accessibility snapshots, browser trace evidence, transcript context,
  opt-in native audio metadata/recordings when explicitly enabled, InputCapture/libei
  readiness, X11 session metadata, active desktop/window snapshots,
  diagnostics, and `draft-prompt.md`.
- Exposes Linux Skysight pause/resume, status, snapshots, exclusions, and a
  rolling evidence daemon through the same `event-stream` MCP server so
  Chronicle-compatible resources can feed skill drafting.
- Skysight segment directories contain `events.jsonl`, `metadata.json`, and
  bounded artifacts such as diagnostics, screenshots, window metadata, and
  AT-SPI/accessibility evidence when available.
- Runs optional local-only Chronicle OCR through RapidOCR/ONNXRuntime when
  available, with Tesseract CLI fallback. Missing OCR dependencies are
  non-fatal unless OCR is marked required, and are surfaced in
  `skysight status`, provider readiness, and `.ocr.jsonl` rows.
- Applies screenshot exclusions before OCR and strips recognized text before
  persistence if it matches an exclusion value.
- Writes rolling 10-minute markdown summaries and cadence-limited 6-hour
  rollups instead of treating every snapshot as a fresh six-hour window.
- Writes a structured `backend_catalog` into the bundle manifest and a matching
  `backend_catalog` observation into the timeline so testers can see why
  InputCapture/libei or X11 paths are available or missing.
- Accepts browser/CDP-style trace JSON through the CLI, MCP, and Linux bridge
  as semantic evidence for skill drafting.
- Captures active desktop/window snapshots through the CLI, MCP, Linux bridge,
  and recording HUD so bundles can show focused apps/windows during a demo.
- Treats Chronicle/Skysight as screen/event memory, not microphone
  transcription.
- See [docs/linux-chronicle-skysight.md](../../docs/linux-chronicle-skysight.md)
  for the runtime resource contract and verification steps.
- Exposes the plugin as `Record & Replay` with MCP server `event-stream` and
  skill `record-and-replay`.
- Imports skills into `$HOME/.agents/skills` by default.
- Uses Linux Computer Use diagnostics to describe GUI readiness.
- Keeps replay skill-driven through Codex and available providers.
- Treats InputCapture/libei and X11 backend entries as readiness/evidence
  providers, not live coordinate macro replay.

## Bundled plugin availability

Enabling this community feature updates the existing native `recordAndReplay`
registry entry. Linux availability follows the enabled community opt-in and
retains Linux automatic installation when the bundled plugin is missing. The
original native availability predicate and imported descriptor fields continue
to govern other platforms. The feature requires Chronicle / Skysight and uses
its Linux backend. Computer Use availability and the native Record & Replay
rollout bit remain independent inputs to their original native consumers.

The plugin gate runs in `extracted-app:pre-webview` at order 150, before the
Chronicle bridge and Record & Replay bridge. It qualifies the evaluated native
entry loader, full namespace and descriptor publications, one root registry
entry and its startup controller across all main chunks. Missing, duplicate,
partial or mixed factory cohorts leave every asset intact. The shared asset
transaction verifies writes and rollback. Repeated application verifies the
complete canonical row.

## Tester Contract

Use the matrix in [docs/record-and-replay-linux.md](../../docs/record-and-replay-linux.md#tester-acceptance-matrix) for PR verification.

Minimum report data:

- Desktop environment.
- Session type.
- Computer Use doctor output.
- Provider readiness summary.
- Bundle path(s).
- Generated skill path and behavior.
- Any degradation, cap, stop, or cancel/discard notes.

## Bridge

The feature registers allowlisted bridge methods in the Chronicle / Skysight
bridge registry; the webview reaches them with `fetch` messages for
`vscode://codex/<method>`, which the Chronicle route in the desktop fetch
wrapper answers. The `linux-record-replay-skysight-*` methods come from
Chronicle / Skysight itself:

- `linux-record-replay-doctor`
- `linux-record-replay-status`
- `linux-record-replay-skysight-start`
- `linux-record-replay-skysight-status`
- `linux-record-replay-skysight-pause`
- `linux-record-replay-skysight-resume`
- `linux-record-replay-skysight-stop`
- `linux-record-replay-skysight-snapshot`
- `linux-record-replay-skysight-list-exclusions`
- `linux-record-replay-skysight-update-exclusion`
- `linux-record-replay-start`
- `linux-record-replay-mark`
- `linux-record-replay-speech-context`
- `linux-record-replay-speech-context-active`
- `linux-record-replay-browser-trace`
- `linux-record-replay-desktop-snapshot`
- `linux-record-replay-stop`
- `linux-record-replay-stop-active`
- `linux-record-replay-cancel`
- `linux-record-replay-cancel-active`
- `linux-record-replay-bundle`
- `linux-record-replay-draft-skill`
- `linux-record-replay-import-skill`
- `linux-record-replay-inspect-skill`

The Rust helper also exposes MCP tools `skysight_start`,
`skysight_status`, `skysight_pause`, `skysight_resume`, `skysight_stop`,
`skysight_snapshot`, `desktop_snapshot`, `skysight_update_exclusion`, and
`skysight_list_exclusions`. Skysight runtime state defaults to
`$XDG_RUNTIME_DIR/skysight`; memory resources default to
`${CODEX_HOME:-$HOME/.codex}/memories/extensions/chronicle/resources`.

The main bridge runs after Chronicle in `extracted-app:pre-webview`, order 152.
It uses Chronicle's complete native request graph, outer registry and extension
slot, then verifies the exact Record & Replay helper and literal registration.
The descriptor inventories all main chunks before writing; missing, duplicate,
mixed or partial owners, including opaque copies of the same native factory,
leave the source unchanged. Writes use the shared transaction with verified
rollback. Enabling this feature does not itself start a recording or Skysight.

All helper invocations use `execFile` with fixed command shapes. The bridge does
not expose a shell or arbitrary argv surface. Process results retain `ok`,
`stdout`, `stderr`, `code` on failure, and parsed `json`; a successful process can
still return `json.ok: false` for bundle validation or skill inspection.
`draft-skill` creates a drafting prompt and does not invoke a model.

Recording states are `active`, `stopped`, `canceled`, `expired`, and `idle`;
these are separate from Skysight's `running`, `paused`, and `stopped` states.
The three `*-active` actions require both process and JSON success, an `active`
recording, and a nonblank string session directory before dispatching the next
command. Invalid status is returned in the diagnostic `status` field.

`record start` records bounded initial/provider evidence without starting the
continuous Skysight daemon. Native audio defaults off and needs both an explicit
`includeAudio: true` request and affirmative `CODEX_RECORD_REPLAY_AUDIO`.
The helper persists a 1,800-second deadline; status, stop, or cancel lazily
finalizes an expired session, so status may mutate expired recording state.
Stop and cancel seal evidence and stop only a Skysight daemon owned by that
exact `recording-session:<id>`; manual continuous capture survives. Starting
again in an existing session directory or mutating/stopping/canceling sealed
evidence returns a helper error rather than an idempotent success.

Browser traces use a private `0700` trace directory and exclusively create a
new `0600` file. Existing filenames and symlinks are preserved. The bridge
removes only its newly created file after command success, helper failure,
argument conversion failure, or partial write failure. The runtime root is
selected from `XDG_RUNTIME_DIR`, then `TMPDIR`, then `/tmp`.

```bash
node --test linux-features/record-and-replay/test.js
```
