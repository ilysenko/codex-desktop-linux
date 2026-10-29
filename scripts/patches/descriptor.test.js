const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createPatchReport,
  criticalFailuresFromReport,
} = require("../lib/patch-report.js");

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
const {
  normalizePatchDescriptors,
  recordUnavailablePhasePatchDescriptors,
} = require("./engine.js");

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
  assert.equal(
    mainBundlePatch({
      id: "default-enforcement",
      apply: (source) => source,
    }).enforceWhenEnabled,
    true,
  );
  assert.equal(
    mainBundlePatch({
      id: "best-effort",
      ciPolicy: "optional",
      enforceWhenEnabled: false,
      apply: (source) => source,
    }).enforceWhenEnabled,
    false,
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
    /removed composesPatches support/,
  );
  assert.throws(
    () => mainBundlePatch({ id: "bad-enforcement", enforceWhenEnabled: "no", apply: (source) => source }),
    /enforceWhenEnabled must be a boolean/,
  );
  assert.throws(
    () => mainBundlePatch({
      id: "required-bypass",
      ciPolicy: "required-upstream",
      enforceWhenEnabled: false,
      apply: (source) => source,
    }),
    /only with ciPolicy 'optional'/,
  );
  assert.throws(
    () => normalizePatchDescriptors([{
      id: "raw-required-bypass",
      ciPolicy: "required-upstream",
      enforceWhenEnabled: false,
      apply: (source) => source,
    }]),
    /only with ciPolicy 'optional'/,
  );
});

test("missing required phase remains fail-closed", () => {
  const [descriptor] = normalizePatchDescriptors([mainBundlePatch({
    id: "required-main",
    ciPolicy: "required-upstream",
    apply: (source) => source,
  })]);
  const report = createPatchReport();

  recordUnavailablePhasePatchDescriptors(
    [descriptor],
    PHASE_MAIN_BUNDLE,
    {},
    report,
    "main bundle unavailable",
  );

  assert.equal(report.patches[0].status, "failed-required");
  assert.equal(report.patches[0].unavailable, true);
  assert.equal(criticalFailuresFromReport(report).length, 1);
});

test("main-process descriptors patch only the rspack chunk that holds their anchor", () => {
  const { applyMainProcessChunkPatchDescriptors } = require("./engine.js");
  const descriptors = normalizePatchDescriptors([
    mainBundlePatch({
      id: "anchored",
      apply(source) {
        if (!source.includes("ANCHOR")) {
          console.warn("WARN: anchor missing - skipping anchored patch");
          return source;
        }
        return source.replace("ANCHOR", "PATCHED");
      },
    }),
    mainBundlePatch({
      id: "missing",
      apply(source) {
        console.warn("WARN: nothing to patch - skipping missing patch");
        return source;
      },
    }),
  ]);
  const report = createPatchReport();
  const chunks = applyMainProcessChunkPatchDescriptors(
    [
      { name: "early-bootstrap.js", source: "entry" },
      { name: "early-bootstrap-916-0123456789abcdef.js", source: "x ANCHOR y" },
    ],
    descriptors,
    {},
    report,
  );

  assert.deepEqual(chunks.map(({ source }) => source), ["entry", "x PATCHED y"]);
  const anchored = report.patches.find((patch) => patch.name === "anchored");
  assert.equal(anchored.status, "applied");
  assert.deepEqual(anchored.chunks, ["early-bootstrap-916-0123456789abcdef.js"]);
  assert.equal(anchored.warnings, undefined);
  const missing = report.patches.find((patch) => patch.name === "missing");
  assert.equal(missing.status, "skipped-optional");
  assert.match(missing.reason, /^missing matched no main-process chunk: nothing to patch/);
});

test("a main-process descriptor that throws on every chunk keeps its error", () => {
  const { applyMainProcessChunkPatchDescriptors } = require("./engine.js");
  const report = createPatchReport();
  applyMainProcessChunkPatchDescriptors(
    [{ name: "early-bootstrap.js", source: "entry" }],
    normalizePatchDescriptors([mainBundlePatch({
      id: "throws",
      apply() {
        throw new Error("expected one current contract");
      },
    })]),
    {},
    report,
  );
  assert.equal(report.patches[0].status, "skipped-optional");
  assert.match(report.patches[0].reason, /expected one current contract/);
});

test("main-process chunk misses are not printed once the descriptor applies", () => {
  const { applyMainProcessChunkPatchDescriptors } = require("./engine.js");
  const printed = [];
  const originalWarn = console.warn;
  console.warn = (...args) => printed.push(args.join(" "));
  try {
    applyMainProcessChunkPatchDescriptors(
      [
        { name: "early-bootstrap.js", source: "entry" },
        { name: "early-bootstrap-1-0123456789abcdef.js", source: "ANCHOR" },
      ],
      normalizePatchDescriptors([mainBundlePatch({
        id: "quiet",
        apply(source) {
          if (!source.includes("ANCHOR")) {
            console.warn("WARN: anchor missing - skipping quiet patch");
            return source;
          }
          return "PATCHED";
        },
      })]),
      {},
      createPatchReport(),
    );
  } finally {
    console.warn = originalWarn;
  }
  assert.deepEqual(printed, []);
});
