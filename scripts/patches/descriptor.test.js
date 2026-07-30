const assert = require("node:assert/strict");
const test = require("node:test");

const {
  CI_POLICY_OPTIONAL,
  PHASE_EXTRACTED_APP_POST_WEBVIEW,
  PHASE_EXTRACTED_APP_PRE_WEBVIEW,
  PHASE_MAIN_BUNDLE,
  PHASE_WEBVIEW_ASSET,
  extractedAppPatch,
  mainBundlePatch,
  webviewAssetPatch,
} = require("./descriptor.js");

test("descriptor factories stamp explicit patch phases", () => {
  assert.equal(
    mainBundlePatch({
      id: "main",
      apply: (source) => source,
    }).phase,
    PHASE_MAIN_BUNDLE,
  );

  assert.equal(
    webviewAssetPatch({
      id: "asset",
      pattern: /^app-.*\.js$/,
      apply: (source) => source,
    }).phase,
    PHASE_WEBVIEW_ASSET,
  );

  assert.equal(
    extractedAppPatch({
      id: "pre",
      phase: PHASE_EXTRACTED_APP_PRE_WEBVIEW,
      apply: () => ({ changed: false }),
    }).phase,
    PHASE_EXTRACTED_APP_PRE_WEBVIEW,
  );

  assert.equal(
    extractedAppPatch({
      id: "post",
      phase: PHASE_EXTRACTED_APP_POST_WEBVIEW,
      apply: () => ({ changed: false }),
    }).phase,
    PHASE_EXTRACTED_APP_POST_WEBVIEW,
  );
});

test("descriptor factories validate the fresh descriptor contract", () => {
  assert.equal(
    mainBundlePatch({
      id: "default-policy",
      apply: (source) => source,
    }).ciPolicy,
    CI_POLICY_OPTIONAL,
  );

  assert.throws(
    () => webviewAssetPatch({ id: "missing-pattern", apply: (source) => source }),
    /must define assetPattern or pattern/,
  );
  assert.throws(
    () => webviewAssetPatch({
      id: "invalid-asset-match",
      pattern: /^app-.*\.js$/,
      assetMatch: "current contract",
      apply: (source) => source,
    }),
    /assetMatch must be a function/,
  );
  assert.throws(
    () => extractedAppPatch({ id: "old-extracted", phase: "extracted-app", apply: () => ({ changed: false }) }),
    /must use phase 'extracted-app:pre-webview' or 'extracted-app:post-webview'/,
  );
  assert.throws(
    () => mainBundlePatch({ id: "bad-policy", ciPolicy: "legacy", apply: (source) => source }),
    /unsupported ciPolicy 'legacy'/,
  );
  assert.throws(
    () => mainBundlePatch({ id: "bad-composition", composesPatches: "linux-owner", apply: (source) => source }),
    /composesPatches must be a non-empty array/,
  );
  assert.throws(
    () => mainBundlePatch({ id: "bad-owner", composesPatches: ["feature:owner"], apply: (source) => source }),
    /composesPatches entries must match/,
  );
  assert.throws(
    () => mainBundlePatch({
      id: "duplicate-owner",
      composesPatches: ["linux-owner", "linux-owner"],
      apply: (source) => source,
    }),
    /composesPatches must not contain duplicates/,
  );
});
