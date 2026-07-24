# Record And Replay Compatibility On Linux

This document tracks the Linux compatibility path for Codex Record & Replay.
Treat Record & Replay as a demo-to-skill compiler, not as a coordinate macro
recorder. Parity on Linux means staging the same bundled Record & Replay plugin
shell from the current upstream DMG, replacing the macOS Sky Computer Use
event-stream helper with a Linux implementation of that helper contract, then
capturing semantic evidence into a bundle that drafts and imports ordinary Codex
skills.

## Phase 1 Support Definition

Phase 1 supports the first Linux-native Record & Replay path behind the
disabled-by-default `record-and-replay` Linux feature.

Supported in Phase 1 means Linux can surface the opt-in `Record & Replay`
plugin shell, start a local recording session through its `event-stream` MCP
server, collect a bundle of screenshots, accessibility snapshots, spoken
transcript context, active desktop/window snapshots, window/session diagnostics,
and user markers, generate a draft-skill prompt, import ordinary Codex skill
folders where the required tools exist, and classify replay readiness. It does
not mean Linux replays raw mouse coordinates as a macro.

Use these terms consistently:

- Importable: the folder is a valid skill directory.
- Listable: the wrapped app or CLI reports the skill.
- Readable: Codex can load `SKILL.md`.
- Invocable: the user can explicitly reference the skill.
- Runnable: required tools/providers are present.
- Verified: a smoke run completed on this Linux host.

## Upstream Behavior

As of June 28, 2026, the OpenAI docs describe Record & Replay as a macOS
feature. Initial availability excludes the European Economic Area, the United
Kingdom, and Switzerland, and Computer Use must be available and enabled.

The workflow is:

1. The user starts "Record a skill" from the Plugins page overflow menu in the
   Codex app.
2. Codex asks for recording permission.
3. The user demonstrates a focused workflow on their Mac.
4. Codex observes the actions, window content, and spoken user context needed
   to learn the workflow.
5. After recording stops, Codex drafts a reusable skill.
6. Later, Codex uses that skill as context and completes the workflow with the
   tools available in the current environment.

The important compatibility point is the contract: the bundled plugin launches
an `event-stream` MCP server and the durable output is a Codex skill. The
current macOS bundle supplies that server through
`computer-use-client-launcher event-stream mcp`; the Linux feature supplies
`SkyLinuxComputerUseClient event-stream mcp`, backed by the Rust
`codex-record-replay-linux` backend.

## Chronicle / Skysight Parity

Chronicle/Skysight is the screen and event-memory sidecar for Record & Replay
on Linux. It is not microphone transcription. The Linux bridge now exposes
pause and resume alongside the existing start, status, stop, snapshot, and
exclusion methods so the app can keep the active capture session alive while
the backend moves between recording states.

Chronicle-compatible resources are written under
`${CODEX_HOME:-$HOME/.codex}/memories/extensions/chronicle/resources`, while the
runtime state directory remains `$XDG_RUNTIME_DIR/skysight`.

Each Linux Skysight snapshot now writes a segment directory with `events.jsonl`,
`metadata.json`, and bounded `artifacts/` evidence. Events include Computer Use
diagnostics, provider readiness, artifact references, capture failures, and
suppressed-evidence records. Artifacts include diagnostics on every snapshot
and add screenshots, window/app metadata, and AT-SPI/accessibility evidence
when those providers are available. Exclusion rules are enforced before
window/app/accessibility evidence is written and cause suppression records
instead of leaking excluded content into summaries.

The memory resources follow rolling-window semantics: `*-10min-*.md` summaries
cover recent segment windows, while `*-6h-*.md` rollups are cadence-limited and
reuse the current rollup until the next six-hour window is due.

Linux Chronicle OCR is implemented as optional local backends. In `auto` mode,
Skysight prefers RapidOCR through Python + ONNXRuntime when available, then
falls back to the Tesseract CLI. Skysight reports OCR mode, backend selection,
availability, language, version, dependency hints, and errors through
`skysight status`, provider readiness events, and the Linux Chronicle bridge.
Missing OCR dependencies are non-fatal unless `CODEX_SKYSIGHT_OCR=required`;
in non-required modes Skysight continues writing Chronicle-shaped `.ocr.jsonl`
rows with `runs_ocr=false`, empty `normalized_text`, and an explicit
unavailable/disabled status.

OCR is downstream of privacy gating. Screenshot suppression prevents OCR, and
recognized text that matches an exclusion value is stripped before it can be
persisted to `.ocr.jsonl` or summarized. Markdown resources include OCR
status/count/path/truncation summaries only; raw OCR text is not copied into
durable resources by default. RapidOCR is the preferred advanced screen OCR
provider; Tesseract remains the safe local fallback.

After rebuilding the feature, Josh can verify the branch with:

1. `node --test linux-features/record-and-replay/test.js`
2. A rebuild/install of the app or feature bundle.
3. A live `skysight status` check that reports the resource root.
4. `skysight pause`, `skysight resume`, and `skysight stop` through the
   bridge or helper once the Rust worker is present.
5. A bundle/snapshot pass that shows segment `events.jsonl`, `metadata.json`,
   `artifacts/diagnostics.json`, a `*-10min-*.md` resource, and a current
   `*-6h-*.md` rollup.
6. A recording pass that still treats `speech_context` as transcript
   evidence, not audio replay; native audio artifacts are opt-in only.

See [docs/linux-chronicle-skysight.md](./linux-chronicle-skysight.md) for the
short runtime contract.

Relevant upstream docs:

- Record & Replay: <https://developers.openai.com/codex/record-and-replay>
- Skills: <https://developers.openai.com/codex/skills>
- Codex app: <https://developers.openai.com/codex/app>
- Codex changelog: <https://developers.openai.com/codex/changelog>

The June 18, 2026 changelog entry introduced Record & Replay in Codex app
26.616 as a macOS feature that turns a demonstrated workflow into a reusable
skill.

## Skill Format And Discovery

Codex skills are directories with a required `SKILL.md` and optional
`scripts/`, `references/`, `assets/`, and `agents/openai.yaml` metadata. The
`SKILL.md` file must include `name` and `description` frontmatter.

Codex can invoke skills explicitly or implicitly:

- Explicit: mention a skill in the prompt, use `/skills`, or type `$` in
  surfaces that support skill autocomplete.
- Implicit: Codex chooses a skill when the task matches the skill description.

Codex reads skills from repository, user, admin, and system locations:

| Scope | Location | Linux relevance |
| --- | --- | --- |
| Repo | `$CWD/.agents/skills` and parent `.agents/skills` directories up to repo root | Best for project-specific skills generated elsewhere. |
| User | `$HOME/.agents/skills` | Best first import target for personal Record & Replay output. |
| Admin | `/etc/codex/skills` | Useful for managed images or shared container defaults. |
| System | Bundled with Codex by OpenAI | Already upstream-owned. |

Codex also supports plugin-packaged skills for distribution. The Linux feature
ships its own plugin-packaged `record-and-replay` entrypoint, while generated
user skills still import to ordinary direct skill folders by default.

The default direct-import target for user skills should be
`$HOME/.agents/skills`, because that is the upstream documented user skill
location. Repo-specific skills belong under `.agents/skills` in the relevant
repository.

This repo also has a wrapper-owned skill installation pattern that stages
feature resources into the app and copies them into
`${CODEX_HOME:-~/.codex}/skills` at runtime. Treat that as a Linux-wrapper
feature bootstrap path until smoke tests prove it is a stable general import
location for upstream skills.

## Existing Linux Repo Hooks

This repo already has pieces that make skill consumption a realistic first
step:

- `linux-features/agent-workspace/` stages a bundled skill under
  `.codex-linux/features/...` and installs it into
  `${CODEX_HOME:-~/.codex}/skills/...` from a prelaunch hook. This is a proven
  pattern for feature-owned skills that need real user paths at runtime.
- `docs/linux-features-architecture.md` documents the same pattern and warns
  against writing user-home files from build-time `stage.sh` hooks.
- `launcher/start.sh.template` resolves `CODEX_HOME`, syncs bundled plugin
  caches, and now has a generic path for extra bundled plugins staged by
  opt-in Linux features.
- `linux-features/*/patch.js` descriptors provide the current optional bridge
  injection path for feature-specific app actions.
- `docs/linux-computer-use.md` documents the bundled Linux Computer Use MCP
  backend, its readiness checks, and its current backend limits.
- `computer-use-linux/src/diagnostics.rs` already reports separate readiness
  layers for portals, accessibility, windowing, screenshots, and input.

Those pieces point to the current incremental implementation: Linux consumes
and imports skills while adding a native recording bundle path that stays
semantic and provider-gated.

## Linux Compatibility Matrix

| Layer | Linux Phase 1 status |
| --- | --- |
| Codex app | Wrapped upstream app; this repo cannot unlock server-gated upstream product features. |
| Direct skill folders | Targeted; verify `$HOME/.agents/skills`, repo `.agents/skills`, symlinks, and duplicate names. |
| `${CODEX_HOME:-~/.codex}/skills` | Wrapper-specific; verify before documenting as a general import path. |
| Explicit skill invocation | Targeted; support claim requires a smoke test in the wrapped app and/or CLI. |
| Plugin-packaged skills | Implemented for the opt-in Record & Replay entrypoint; generated user skills still import as direct folders first. |
| Browser replay | Conditional; depends on browser provider, plugin state, and auth/session assumptions. |
| Desktop GUI replay | Experimental; only through capability-gated Linux Computer Use or isolated workspace providers. |
| macOS/Windows app automation | Unsupported; import/read/list only, then explain the platform blocker. |
| Record & Replay capture | Opt-in experimental Linux bundle capture through the upstream-shaped `Record & Replay` plugin shell and `SkyLinuxComputerUseClient event-stream mcp`, backed by `codex-record-replay-linux`. |

## Capability Model

Generated skills should be classified before Linux presents them as runnable.
The model should separate requirements, providers, confidence, and status
instead of assigning only one coarse label.

Recommended status values:

| Status | Meaning | Linux behavior |
| --- | --- | --- |
| `supported` | Skill is instruction-only or uses providers verified on this host. | Allow explicit invocation without extra warning. |
| `conditional` | Skill may work but depends on CLIs, credentials, browser state, plugin auth, MCP config, or project context. | Allow explicit invocation with clear missing/unknown requirements. |
| `experimental` | Skill needs Linux host desktop control or isolated GUI automation. | Require opt-in diagnostics and show Computer Use or Agent Workspace readiness. |
| `unsupported` | Skill clearly requires macOS/Windows-only APIs, apps, paths, or UI assumptions. | Import/read/list, but block "works on Linux" claims. |
| `unknown` | Classifier cannot infer enough. | Import as readable context; require manual review or smoke test before treating it as runnable. |

Capability classes:

| Capability | Signals | Linux treatment |
| --- | --- | --- |
| `instruction-only` | `SKILL.md` only; no scripts; no tool deps; general workflow instructions. | Best Phase 1 success case. |
| `cli-local` | Mentions shell commands, scripts, files, repo state, package managers, CLIs. | Conditional on required commands, path assumptions, credentials, and project CWD. |
| `browser-session` | Mentions in-app browser, Chrome extension, web forms, signed-in sites, browser actions. | Conditional; verify browser provider and auth/session expectations. |
| `plugin-dependent` | `agents/openai.yaml` dependencies or instructions naming plugins/MCP tools. | Conditional; map declared dependencies to installed plugins/MCP servers. |
| `desktop-observe` | Needs screenshots, app state, accessibility tree, or frontmost window. | Experimental; require screenshot/accessibility readiness. |
| `desktop-act` | Needs click, type, drag, scroll, focus, or window targeting. | Experimental/high-risk; require input, window focus, screenshot, and accessibility readiness. |
| `isolated-gui` | Workflow can run in a hidden/throwaway Linux desktop or workspace-owned browser. | Optional via Agent Workspaces; not equivalent to host desktop replay. |
| `platform-macos` | AppleScript, Finder, `.app`, Keychain, menu bar, macOS paths, System Settings, Mac accessibility assumptions. | Unsupported on Linux. |
| `platform-windows` | Registry, PowerShell UI setup, Win32 paths/apps, or Windows-specific Computer Use assumptions. | Unsupported on Linux. |
| `recording` | Requires capturing a new demonstration. | Supported only through the opt-in Linux recording bundle path. |
| `speech-context` | Spoken microphone/dictation transcript captured while demonstrating. | Treat as semantic user intent and evidence, not audio or timing to replay. |
| `desktop-snapshot` | Active app/window metadata captured while demonstrating. | Use as semantic workflow evidence; exact browser URLs still require browser trace/CDP or visible accessibility evidence. |

Use evidence in this order:

1. `agents/openai.yaml` dependencies and invocation policy.
2. Directory structure, scripts, executable files, references, and assets.
3. `SKILL.md` frontmatter and instructions.
4. Heuristics over platform paths, tools, and UI terminology.

Phase 1 classification cannot safely rely on frontmatter data alone. The
checker must inspect skill-owned scripts and assets for obvious platform
assumptions, but it must not run skill-owned code during classification.

A future compatibility report could look like:

```json
{
  "skill_name": "example",
  "skill_path": "/home/user/.agents/skills/example/SKILL.md",
  "origin": "user",
  "trust": "external-import",
  "status": "conditional",
  "confidence": "heuristic",
  "requirements": [
    "shell",
    "browser-session",
    "computer_use.screenshot",
    "computer_use.input"
  ],
  "providers": {
    "browser": "unknown",
    "computer_use": {
      "screenshot": "available",
      "accessibility": "missing",
      "window_focus": "unknown",
      "input": "missing"
    }
  },
  "blockers": [],
  "warnings": [
    "Imported skill includes executable scripts; review before use."
  ],
  "next_steps": [
    "Run Linux Computer Use diagnostics."
  ]
}
```

## Import Safety

A skill can include scripts, references, and assets. Import must therefore be a
read/inspect operation first. The importer should validate the folder shape,
avoid path traversal, preserve the original files, warn on executable scripts,
and avoid running skill-owned code during classification.

External imports should default to explicit invocation only, or present a clear
implicit-invocation warning when the skill description is broad. Compatibility
metadata should live in app state, a cache, or a Linux-owned sidecar; do not
rewrite `SKILL.md` to store Linux compatibility state.

## Import And Invocation Feasibility

Direct skill import is feasible without inventing a new storage model:

- Copy or symlink a skill directory into `$HOME/.agents/skills`.
- For repo-specific workflows, keep skills in `.agents/skills` under the
  relevant repository.
- For feature-owned skills, follow the `agent-workspace` pattern and install
  into `${CODEX_HOME:-~/.codex}/skills` only from a runtime hook.

The first implementation PR should prefer a small importer or documentation
around these locations over a new Linux-only registry. Codex already owns skill
discovery; this repo should avoid shadowing it unless upstream app behavior
forces a bridge.

Open verification items:

- Confirm whether Record & Replay-generated skills are saved as ordinary skill
  directories with `SKILL.md`.
- Confirm the exact save location and export path used by the macOS app.
- Confirm whether the Linux wrapped Codex app and Codex CLI see
  `$HOME/.agents/skills`, repo `.agents/skills`, symlinks, and duplicates
  without additional patching.
- Confirm whether `${CODEX_HOME:-~/.codex}/skills` is a general discovery path
  or only a wrapper-owned feature bootstrap path.
- Confirm whether `agents/openai.yaml` dependencies are surfaced in the app
  strongly enough to power capability checks.
- Confirm whether the upstream Plugins overflow menu action can be enabled on
  Linux by patching availability gates only, or whether it depends on
  macOS-specific recording internals.
- Confirm whether `skills/list`, `plugin/skill/read`, and
  `skills/config/write` return enough metadata for a Linux compatibility view.
- Confirm whether the UI refreshes after filesystem import, or whether restart
  or an app-server notification path is required.

## Linux-Native Recording Research

Native Linux recording should keep growing behind the narrow bundle/recorder
interface, not as a blind event recorder. Candidate backends:

| Backend | Strength | Risk |
| --- | --- | --- |
| Browser trace/CDP | Semantic for web workflows, less desktop-specific | Only covers browser workflows |
| AT-SPI | Semantic UI tree for accessible Linux apps | Coverage varies by toolkit/app and permissions |
| X11 event capture | Mature and inspectable on X11 sessions | Coordinate-heavy and increasingly less representative |
| XDG portals | User-approved screen/input boundaries | APIs differ by desktop; recording semantic actions is limited |
| Compositor-specific backends | Can expose better window/control data | GNOME/KWin/Hyprland/Sway/COSMIC all differ |
| App-specific integrations | High fidelity for known apps | Not general purpose |

The implemented architecture should look like:

```text
RecorderBackend
  -> normalized observations and actions
  -> screenshots/accessibility/browser snapshots where available
  -> skill-drafting context
  -> generated Skill directory
```

The default backend should be semantic bundle capture. Browser and AT-SPI
backends are more promising than raw coordinate replay. InputCapture/libei and
X11 should contribute explicit provider evidence first, then grow into richer
event streams only where the desktop/session can support that without turning
Record & Replay into coordinate macro playback.

Current Linux slice status:

- `codex-record-replay-linux doctor` now emits a structured `backend_catalog`
  alongside the older `recorders` list.
- `record start` stores the same catalog in `manifest.json` and appends a
  `backend_catalog` observation to `timeline.jsonl`.
- `record start` creates `browser/`, `input-capture/`, and `x11/` provider
  evidence files so bundle reviewers can inspect browser trace readiness,
  InputCapture/libei portal readiness, and X11/window metadata.
- `record desktop-snapshot`, MCP `desktop_snapshot`, and the Linux HUD append
  active focused-window metadata into `x11/*-desktop-snapshot.json` and surface
  that context in the draft prompt timeline.
- `record browser-trace` and MCP `browser_trace` append caller-provided
  browser/CDP-style trace JSON into the bundle as semantic evidence.
- InputCapture/libei and X11 are real readiness/evidence providers in this PR.
  Raw libei event-stream capture and X11 input-event capture remain follow-up
  backend expansion, not replay architecture blockers.

## Open Questions And Blockers

- Is the Record & Replay generated skill format fully identical to manually
  authored Codex skills?
- Are generated skills portable across machines, or do they include local app
  paths, account-specific assumptions, temporary directories, or machine IDs?
- Does upstream expose enough metadata to distinguish instruction-only skills
  from GUI-dependent skills?
- Can the Linux app expose the upstream Plugins overflow "Record a skill"
  launcher on Linux without a brittle bundle patch?
- Does the app-server skill API expose all information needed for a
  compatibility matrix?
- How should Linux request and persist permission for any future recording
  backend, especially under Wayland?
- Should imported macOS-generated skills be read-only by default until the user
  edits platform assumptions?
- How should Linux distinguish shared-host desktop automation from isolated
  workspace automation in user-facing warnings?
- How should imported skills with broad descriptions avoid surprising implicit
  invocation?

## Recommended PR Split

1. Shared Rust Computer Use surface: expose existing Linux diagnostics,
   screenshot, accessibility, and windowing primitives as reusable Rust modules
   while preserving the current MCP binary behavior.
2. `codex-record-replay-linux`: add a Rust CLI and stdio MCP server for
   `doctor`, `record start/mark/speech/stop`, `bundle validate`, `bundle
   draft-prompt`, and `skill inspect/import`.
3. Recording bundle schema: write `manifest.json`, `timeline.jsonl`,
   `screenshots/`, `accessibility/`, `browser/`, `transcripts/`,
   `diagnostics.json`, and `draft-prompt.md`.
4. Safe skill importer/classifier: validate `SKILL.md`, classify capability
   requirements, reject internal symlink and collision risks by default, and
   never execute skill-owned code.
5. Opt-in Linux feature: stage the current upstream `Record & Replay` bundled
   plugin shell when available, remove the macOS helper payload, install
   `SkyLinuxComputerUseClient event-stream mcp` as the Linux helper, and add
   allowlisted bridge methods for recording status, HUD stop, diagnostics,
   bundle review, browser trace ingestion, draft prompt generation, and skill
   import.
6. Upstream activation follow-up: inspect the current DMG bundle and enable the
   Plugins page overflow action "Record a skill" on Linux if it can launch the
   plugin/MCP flow without macOS-only private recorder dependencies.
7. Provider follow-ups: expand browser trace/CDP into live browser attachment,
   add GlobalShortcuts markers, implement raw InputCapture/libei event-stream
   capture where the portal stack supports it, deepen X11 event metadata, and
   add richer compositor-specific capture backends behind the same bundle
   contract.

## Phase 1 Conclusion

Phase 1 is successful if Linux can produce a recording bundle, draft a skill
from that bundle, import the generated skill, classify its replay requirements,
and invoke it through Codex when the required providers exist. The feature is
bleeding-edge and opt-in, but it is real Linux Record & Replay work rather than
just an importer. No UI should imply coordinate macro replay or unsupported
macOS/Windows app automation.

## Tester Acceptance Matrix

Use `current` for behavior this PR should already provide, `target` for the
visible product behavior testers should confirm, and `follow-up` for behavior
that may still be pending but should be reported explicitly.

| Check | Scope | Pass condition | Evidence to attach |
| --- | --- | --- | --- |
| Build with feature enabled | current | The feature builds cleanly and stages the official `Record & Replay` shell plus the Linux helper. | Build command, package name, enabled feature list. |
| Official shell + Sky helper | current | The plugin keeps the upstream `Record & Replay` identity and launches `SkyLinuxComputerUseClient event-stream mcp`. | App/plugin screen, bridge log, helper command. |
| HUD visible | target | Recording shows a visible HUD with state and timer. | Screenshot or short screen capture. |
| Stop from HUD | target | HUD stop ends the active session and finalizes the bundle. | Stop log, final bundle path. |
| Cancel/discard | target | HUD discard cancels the active session, marks the bundle as discarded evidence, and does not draft a skill from it. | Note whether the control exists, final status, and bundle path. |
| 30-minute session | target | The session remains usable up to the cap or fails with a clear cap message. | Start/stop timestamps or cap message. |
| Mic / speech context | current | Spoken context is captured as transcript evidence, not replay audio. | Transcript excerpt or bundle file path. |
| Native audio artifacts | current | Native audio capture stays off unless the caller opts in and `CODEX_RECORD_REPLAY_AUDIO` is affirmative. | Start command/options and `audio/recording.json` status when tested. |
| Browser trace evidence | current | Browser/CDP-style trace JSON can be added to the active bundle and appears in the draft prompt timeline. | `browser/*-trace.json` path and timeline row. |
| Active desktop/window evidence | current | Focused app/window metadata is captured during the recording and appears in the draft prompt timeline. | `x11/*-desktop-snapshot.json` path and timeline row. |
| InputCapture/libei evidence | current | The bundle records portal readiness and input capability evidence even when live input capture is unavailable. | `input-capture/0000-readiness.json`. |
| X11 evidence | current | The bundle records session/window metadata and marks X11-specific support when running on X11. | `x11/0000-session.json`. |
| Bundle validation | current | Bundle validation reports pass, warnings, or blockers before drafting. | Validation output and bundle path. |
| Skill draft/import | current | The bundle produces a draft prompt and an importable skill folder. | Draft prompt path, skill path, import result. |
| Fresh-thread invocation | target | A new thread can invoke the generated skill without relying on the recording thread. | Thread link or command/output summary. |
| Diagnostics / degradation report | current | Doctor output explains what is ready, partial, missing, or blocked. | Doctor output plus provider readiness summary. |

## Tester Report Template

- Desktop environment:
- Session type:
- Computer Use doctor:
- Provider readiness:
- Bundle path(s):
- Generated skill path:
- Generated skill behavior:
- Degradation or blocker notes:
