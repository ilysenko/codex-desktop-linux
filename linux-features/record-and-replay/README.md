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

The feature adds allowlisted bridge methods:

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

All helper invocations use `execFile` with fixed command shapes. The bridge does
not expose a shell or arbitrary argv surface.

```bash
node --test linux-features/record-and-replay/test.js
```
