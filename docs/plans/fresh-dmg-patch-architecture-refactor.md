# Fresh-DMG Patch Architecture Refactor

## Summary

Refactor the patch system in one coherent iteration around the new contract: only fresh upstream DMGs are supported. Remove old internal compatibility exports, legacy feature patch entrypoints, historical fallback needles, compatibility barrels, and the magic extracted-app split order.

Keep frozen only the build-facing CLI contract: `scripts/patch-linux-window-ui.js`, `--report-json`, `--enforce-critical`, exit behavior, and "write report before critical gate".

## Architecture

- Make `scripts/patch-linux-window-ui.js` CLI-only: argument parsing, report creation/write, runner call, critical gating, no module exports.
- Rename `scripts/patches/registry.js` to `scripts/patches/runner.js`; it owns `patchExtractedApp`, `patchMainBundleSource`, `allPatchPolicies`, `requiredPatchNamesForProfile`, and descriptor collection.
- Keep `scripts/patches/engine.js` focused on descriptor normalization, target/enabled checks, phase execution, warning capture, status recording, and strategy metadata.
- Add `scripts/patches/descriptor.js` with factories for `mainBundlePatch`, `webviewAssetPatch`, and `extractedAppPatch`, plus phase and CI policy constants.
- Replace the `EXTRACTED_APP_WEBVIEW_SPLIT_ORDER` model with explicit phases: `main-bundle`, `extracted-app:pre-webview`, `webview-asset`, `extracted-app:post-webview`.
- Sort by `order` only inside each phase.

## Implementation Changes

- Convert all core descriptors under `scripts/patches/core/**/patch.js` to descriptor factories.
- Move implementations into `scripts/patches/impl/` by domain, not one `implementation.js` per descriptor: main-process modules, webview domain modules, keybinds, computer-use, chrome-plugin, launch-actions, automation-schedule, bootstrap, package-json, avatar-overlay, and projectless-documents.
- Split `scripts/patches/shared.js` into `scripts/patches/lib/assets.js`, `scripts/patches/lib/minified-js.js`, and `scripts/patches/lib/settings-keys.js`.
- Delete old compatibility barrels after imports are migrated: `scripts/patches/main-process.js`, `scripts/patches/webview-assets.js`, and `scripts/patches/shared.js`.
- Keep `scripts/lib/patch-report.js` as the only owner of report statuses and failure predicates. Preserve `applied-with-warnings`.
- Keep `strategy-telemetry.js`, but make it fresh-DMG drift diagnostics only: `upstream`, `upstream-*`, `already-applied`, `none`; remove `legacy:*` semantics and wording.
- Remove historical fallback needles only after comparing a fresh-DMG baseline patch report; keep idempotency detection.

## Linux Features

- Change the feature patch contract intentionally: feature patching uses only `entrypoints.patchDescriptors`.
- Remove `mainBundlePatch`, `entrypoints.patches`, `.patches` exports, and `.default` descriptor export aliases.
- Convert current repo features that still use legacy/alias entrypoints so they continue working after the refactor.
- Features without patch entrypoints remain valid when they only stage resources or runtime hooks.
- Feature tests import runner APIs from `scripts/patches/runner.js` and report helpers from `scripts/lib/patch-report.js`, never from the CLI file.

## Tests

- Before refactor, capture a fresh-DMG baseline patch report and use it as the regression oracle for patch names, order, criticality, and phase behavior.
- Split the large patch test suite into focused tests: CLI/report integration, runner, engine, descriptor factories, and domain tests beside `impl/*`.
- Update all tests away from `patch-linux-window-ui.js` module exports.
- Run `node --check scripts/patch-linux-window-ui.js scripts/patches/*.js scripts/patches/lib/*.js scripts/lib/linux-features.js`.
- Run `node --test scripts/patches/*.test.js scripts/patches/**/*.test.js scripts/patch-linux-window-ui.test.js`.
- Run `node --test linux-features/*/test.js`.
- Run `bash tests/scripts_smoke.sh`.
- Build at least `.deb` and inspect the update-builder payload includes `runner.js`, `descriptor.js`, `impl/`, and `patches/lib/`.

## Documentation

- Update `scripts/patches/core/README.md` with the four-phase pipeline, factories, fresh-DMG-only policy, order convention, and `impl/` ownership.
- Update `linux-features/README.md` and `docs/linux-features-architecture.md` to document `patchDescriptors` as the only patch entrypoint.
- Update `docs/architecture.md` with the CLI-only patcher and descriptor-only architecture.
- Update `AGENTS.md` source-of-truth notes so compatibility layers are not recreated.

## Assumptions

- No backward compatibility is required for old DMGs, old internal imports, old feature entrypoints, or old tests.
- Current repo Linux Features must still work after being migrated to the new contract.
- Generated app output is not edited directly.
- This is implemented as one PR/iteration, with docs and tests updated in the same change.
