#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { loadLinuxFeaturePatchDescriptors } = require("../../scripts/lib/linux-features.js");
const { applyWebviewAssetPatchDescriptors, normalizePatchDescriptors } = require("../../scripts/patches/engine.js");
const { createPatchReport } = require("../../scripts/lib/patch-report.js");
const {
  CONTRACTS,
  applyDotsAppSharedPatch,
  applyDotsLandingRoutePatch,
  applyDotsPersonalizationPatch,
  descriptors,
} = require("./patch.js");

// Reduced rspack chunks shaped like the signed stable Linux 26.1029 webview.
const chunk = (id, body) => `export const __rspack_esm_id=${id};export const __rspack_esm_ids=[${id}];` +
  `export const __webpack_modules__={${body}};`;
const FIXTURES = {
  "async/221857.4c17f751f6.js": chunk(221857, 'Ab12(e,t,n){function route(){if("error"===$||N?.tbo_config?.tbo_available==null||null==N.structure)return null;if(N.tbo_config.tbo_available){return redirect}}}'),
  "async/24191.7b05d5cf83.js": chunk(24191, 'Cd34(e,t,n){function capable(){if(e.query.getData(s.sE,t)?.accounts[t]?.account.tbo_config?.tbo_available!==!0)throw Error();let capable="success"===r&&n?.accounts[t]?.account.tbo_config?.tbo_available===!0;return capable||"error"===l&&r?.accounts[n]?.account.tbo_config?.tbo_available===!0}}'),
  "async/860646.06b6da0005.js": chunk(860646, 'Ef56(e,t,n){first?.accounts[M]?.account.tbo_config?.tbo_available!==!0; second?.accounts[c]?.account.tbo_config?.tbo_available!==!0;}'),
};


function withFeatureConfig(enabled, fn) {
  const originalConfig = process.env.CODEX_LINUX_FEATURES_CONFIG;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatgpt-dots-any-country-"));
  process.env.CODEX_LINUX_FEATURES_CONFIG = path.join(tempDir, "features.json");
  try {
    fs.writeFileSync(process.env.CODEX_LINUX_FEATURES_CONFIG, JSON.stringify({ enabled }));
    return fn();
  } finally {
    if (originalConfig == null) delete process.env.CODEX_LINUX_FEATURES_CONFIG;
    else process.env.CODEX_LINUX_FEATURES_CONFIG = originalConfig;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

test("feature is disabled until selected", () => {
  const featuresRoot = path.resolve(__dirname, "..");
  withFeatureConfig([], () => {
    assert.equal(
      loadLinuxFeaturePatchDescriptors({ featuresRoot })
        .some((descriptor) => descriptor.id.startsWith("feature:chatgpt-dots-any-country:")),
      false,
    );
  });
  withFeatureConfig(["chatgpt-dots-any-country"], () => {
    assert.deepEqual(
      loadLinuxFeaturePatchDescriptors({ featuresRoot })
        .filter((descriptor) => descriptor.id.startsWith("feature:chatgpt-dots-any-country:"))
        .map((descriptor) => descriptor.id),
      [
        "feature:chatgpt-dots-any-country:dots-landing-route",
        "feature:chatgpt-dots-any-country:dots-app-shared-capability",
        "feature:chatgpt-dots-any-country:dots-personalization-capability",
      ],
    );
  });
});

test("landing route stays visible while preserving the server gate", () => {
  const patched = applyDotsLandingRoutePatch(FIXTURES["async/221857.4c17f751f6.js"]);
  assert.doesNotMatch(patched, /tbo_available==null/);
  assert.ok(patched.includes('if("error"===$||!1||null==N.structure)'));
  assert.match(patched, /if\(N\.tbo_config\.tbo_available\)/);
  assert.equal(applyDotsLandingRoutePatch(patched), patched);
});

test("shared Dots capability checks no longer reject a country-gated account", () => {
  const patched = applyDotsAppSharedPatch(FIXTURES["async/24191.7b05d5cf83.js"]);
  assert.ok(patched.includes('function capable(){if(!1)throw Error();let capable="success"===r&&!0;return capable||"error"===l&&!0}'));
  assert.doesNotMatch(patched, /\?\.[!01]/);
  assert.equal(applyDotsAppSharedPatch(patched), patched);
});

test("personalization Dots checks are patched together", () => {
  const patched = applyDotsPersonalizationPatch(FIXTURES["async/860646.06b6da0005.js"]);
  assert.ok(patched.includes("{!1; !1;}"));
  assert.doesNotMatch(patched, /\?\.[!01]/);
  assert.equal(applyDotsPersonalizationPatch(patched), patched);
});

test("ambiguous contracts fail closed", () => {
  const source = "a?.tbo_config?.tbo_available==null;b?.tbo_config?.tbo_available==null";
  assert.equal(applyDotsLandingRoutePatch(source), source);
});

test("each descriptor patches its current rspack chunk contract", () => {
  const extractedDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatgpt-dots-any-country-assets-"));
  const assetsDir = path.join(extractedDir, "webview", "assets");
  fs.mkdirSync(path.join(assetsDir, "async"), { recursive: true });
  try {
    for (const [name, source] of Object.entries(FIXTURES)) fs.writeFileSync(path.join(assetsDir, name), source);
    const report = createPatchReport();
    applyWebviewAssetPatchDescriptors(extractedDir, normalizePatchDescriptors(descriptors), {}, report);
    assert.deepEqual(report.patches.map(({ status }) => status), ["applied", "applied", "applied"]);
    assert.deepEqual(report.patches.map(({ assetName }) => assetName), Object.keys(FIXTURES));
    for (const name of Object.keys(FIXTURES)) {
      assert.doesNotMatch(fs.readFileSync(path.join(assetsDir, name), "utf8"), /tbo_available(?:==null|[!=]==!0)/);
    }
  } finally {
    fs.rmSync(extractedDir, { recursive: true, force: true });
  }
});

const signedApp = process.env.CODEX_SIGNED_EXTRACTED_APP;
test("the signed official webview has one pristine chunk per Dots contract", { skip: signedApp == null }, () => {
  const { findWebviewAssetsContaining } = require("../../scripts/patches/lib/assets.js");
  for (const descriptor of descriptors) {
    const matches = findWebviewAssetsContaining(signedApp, descriptor.assetNeedles).filter((name) =>
      descriptor.assetMatch(fs.readFileSync(path.join(signedApp, "webview", "assets", name), "utf8")));
    assert.equal(matches.length, 1, descriptor.id);
  }
});
