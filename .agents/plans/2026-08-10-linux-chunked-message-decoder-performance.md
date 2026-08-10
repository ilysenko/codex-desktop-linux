# Linux Chunked Message Decoder Performance Implementation Plan

> **For Codex:** Execute this plan sequentially with test-driven development. Keep the generated webview patch optional, semantic, fail-soft, and idempotent.

**Goal:** Reduce renderer main-thread work while reconstructing large chunked host messages without changing decoded object semantics or weakening protection for the special `__proto__` key.

**Architecture:** Add one all-Linux webview asset descriptor for the primary `app-initial-*.js` bundle. Its semantic matcher will locate exactly one current chunk assembler contract using the chunk protocol marker, assembler diagnostics, and object-write shape. The transform will use ordinary property assignment for normal keys and retain `Object.defineProperty` for `__proto__`, which preserves the existing own-property descriptor and prototype behavior.

**Evidence baseline (2026-08-10, ChatGPT 26.803.41515 / Electron 42.3.0):** A 34-session CPU profile identified chunk decoding as a recurring renderer hotspot (`j6e` 2.36s, `saveValue` 367ms in one baseline sweep). A controlled in-app benchmark decoded five 50,000-property transfers through the real `window.postMessage` listener. Across three sequential A/B samples, median wall time fell from 777.9ms to 728.5ms (-6.35%) and median `saveValue` self time fell from 163.2ms to 108.6ms (-33.45%). Concurrent samples were excluded because the two Electron instances contended for CPU. A previous synchronous text-measurement candidate was rejected after an exact-input sweep regressed end-to-end long-task time by about 9%.

---

## Task 1: Lock the semantic and safety contract with failing tests

**Files:**
- Modify: `scripts/patch-linux-window-ui.test.js`

1. Import the new matcher and transform from `scripts/patches/impl/webview/index.js`.
2. Add a compact current-bundle fixture containing the chunk marker, validation/assembler diagnostics, object/array/root behavior, and the original unconditional `Object.defineProperty` write.
3. Add tests that require:
   - exactly one semantic contract match;
   - idempotent transformation;
   - ordinary keys use direct assignment;
   - `__proto__` still becomes an enumerable, configurable, writable own data property while the decoded object's prototype remains unchanged;
   - ordinary keys such as `constructor` and `toString` preserve own-property descriptors;
   - array and root writes are unchanged;
   - generic, drifted, duplicated, and incomplete candidates remain byte-identical and warn precisely.
4. Add the descriptor id to the canonical core descriptor list and assert its filename pattern/optional policy.
5. Run the focused Node test by name and confirm it fails because the new exports/descriptor do not exist yet.

## Task 2: Implement the minimal fail-soft webview transform

**Files:**
- Modify: `scripts/patches/impl/webview/index.js`
- Create: `scripts/patches/core/all-linux/webview/chunked-message-decoder-performance/patch.js`

1. Add semantic candidate discovery for the current chunk assembler using protocol and diagnostic anchors plus alias-tolerant write patterns.
2. Recognize only one fully unpatched or fully patched candidate; reject ambiguous, drifted, and incomplete states.
3. Replace the unconditional object-property write with a conditional that retains the exact `Object.defineProperty` call for `__proto__` and uses `object[key] = value` otherwise.
4. Export the matcher and transform.
5. Register an optional all-Linux `webview-asset` descriptor after the existing layout performance descriptors, targeting only `^app-initial-[^.]+\\.js$`.
6. Run the focused tests and make them pass without loosening assertions.

## Task 3: Verify generated-asset integration and runtime behavior

**Files:**
- No additional production files expected.

1. Run the focused performance/safety tests, then the complete `scripts/patch-linux-window-ui.test.js` suite.
2. Run repository lint/type/build checks required by the existing contribution workflow.
3. Apply the descriptor to a fresh copy of the current generated asset and prove exactly one semantic match, one change, and idempotency; verify the original generated asset remains byte-identical.
4. Build or regenerate the native app through the repository-supported path as practical, then rerun the controlled decoder benchmark on baseline and patched instances sequentially.
5. Record exact before/after medians, retained Browser webview counts, test results, and any residual variance.

## Task 4: Contribution handoff

**Files:**
- Modify only contribution documentation if the repository requires it.

1. Review the complete diff for accidental generated artifacts or unrelated user files.
2. Create a focused GitHub issue with reproduction, profiler evidence, scope, and acceptance criteria.
3. Commit only owned files, push the feature branch, and open one PR linked to the issue with security semantics, validation evidence, and before/after results.
4. Check CI and review feedback; address only actionable findings within this PR's scope.
