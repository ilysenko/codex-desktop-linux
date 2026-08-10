# Linux app-shell tab layout performance

## Goal

Reduce stalls when opening or switching to long/running conversations with
Browser tabs, without suspending Browser Use or Computer Use workloads.

## Evidence and scope

- An isolated same-DMG baseline reproduced 2.0-6.8 second settle times, a 3.6
  second long task, and up to 6,674 DOM elements across eight session switches.
- A focused heavy-session CPU profile attributed about 423 ms to the app-shell
  tab overflow callback and 361 ms to Framer Motion `measureScroll` work.
- App-shell tabs entered from zero width on every tab-strip mount. Their label
  ResizeObserver synchronously read `scrollWidth` during the same resize/layout
  cascade.
- Retained hidden Browser guest views are intentional for active Browser Use.
  Destroying or suspending them is out of scope.
- Reducing thread overscan and adding per-block CSS containment were measured
  against the same workload and rejected because they did not materially help.

## Implementation

1. Add one optional all-Linux webview-asset patch for the semantic app-shell tab
   contract in the current `app-initial-*.js` bundle.
2. Disable only the tab's enter-from-zero-width animation when a tab strip is
   mounted; preserve its exit animation, drag behavior, and tab controls.
3. Defer and coalesce each label's overflow read to one animation-frame callback
   so it no longer forces layout during React/ResizeObserver delivery.
4. Keep the overflow fade state and retained Browser webviews intact.
5. Match one complete contract, remain idempotent, and fail soft on upstream
   drift, ambiguity, or a partial patch.

## Validation

- Lock the transform with fixture tests for the complete contract, idempotence,
  semantic rejection, ambiguity, and drift.
- Rebuild from the same upstream DMG and require an accepted patch report.
- Profile a light-to-heavy switch in an isolated candidate and verify the two
  targeted layout-read hotspots fall materially.
- Check after two animation frames that overflowing tab labels retain their fade
  and all retained Browser webviews remain connected.
- Run focused and full patch tests, smoke tests, local PR CI, diff checks, and an
  independent read-only review before publication.

## Publication

- Correct issue #1279 with the confirmed resize/layout root cause and sanitized
  measurements.
- Commit only implementation, descriptor, tests, and this plan.
- Push a focused branch, open one draft PR, and inspect CI to terminal status.

## Stop conditions

- Stop if tab overflow state no longer converges after animation frames, tab
  interactions regress, or Browser/Computer Use guest views disconnect.
- Stop if the current bundle contract is not unique.
- Do not claim an end-to-end settle-time improvement from noisy live-session
  sweeps; report the directly profiled hotspot reduction instead.
