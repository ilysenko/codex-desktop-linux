# Linux streaming Markdown animation performance

## Goal

Remove the session-switch freeze caused by replaying word-level Markdown fade
animations across a large in-progress turn, without changing message content,
Browser Use webview retention, scrolling, or image enter motion.

## Evidence and root cause

- A representative running session mounted one 4,920 px turn containing 2,484
  descendants, 24 animated Markdown roots, and 1,181 fade spans. Most animated
  roots were outside the viewport.
- Chromium traces attributed the switch stall to renderer program work plus
  `UpdateLayoutTree`, `Layout`, `Layerize`, and `Commit`; reducing the chunked
  message batch size did not improve these costs.
- Same-renderer A/B on the heavy `21 -> 7` switch reduced total long-task time
  from 2,881/2,608 ms to 930/884 ms and the longest task from 660/636 ms to
  392/389 ms when only Markdown text/list-marker animation was disabled.
- Fresh-app 25-session A/B used the same fingerprint sequence and reached the
  same maximum of eight retained Browser Use webviews. Total long-task time
  fell from 16,119 ms to 12,866 ms, maximum task duration from 760 ms to 518 ms,
  and median longest task from 217 ms to 189 ms.

## Implementation

1. Add an optional, Linux-only webview CSS descriptor targeting the unique
   streaming Markdown animation contract in the current `app-initial` asset.
2. Render streaming text, block elements, and list markers immediately instead
   of allocating hundreds of fade animations on session restore.
3. Preserve image enter animation and all content/streaming behavior.
4. Keep the patch semantic, idempotent, ambiguity-rejecting, and fail-soft on
   upstream drift.

## Regression coverage

- Exact output contract for text/list-marker animation removal.
- Image enter motion remains byte-identical.
- Unpatched and patched assets both match exactly once.
- Generic, drifted, and ambiguous assets are not modified.
- Descriptor discovery, CSS-only targeting, and optional drift policy.

## Validation

- Focused Node tests for the patch and descriptor.
- Full script smoke suite, separating pre-existing environment failures.
- Patch the exact current DMG stylesheet and verify idempotence.
- Fresh baseline/candidate 25-session sweep and targeted heavy-session A/B.

## Non-goals

- Do not detach or cap Browser Use webviews.
- Do not change transcript virtualization or message data.
- Do not include the rejected chunk-decoder micro-optimization.
