#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { loadLinuxFeaturePatchDescriptors } = require("../../scripts/lib/linux-features.js");
const { patchUniqueAssetFile } = require("../../scripts/patches/lib/assets.js");
const {
  CONTRACTS,
  applyDotsAppSharedPatch,
  applyDotsLandingRoutePatch,
  applyDotsPersonalizationPatch,
  descriptors,
} = require("./patch.js");

const FIXTURES = {
  "landing-route-current.js": `function route(){if(D===\`error\`||account?.tbo_config?.tbo_available==null||account.structure==null)return null;if(account.tbo_config.tbo_available){return redirect}}`,
  "app-initial-current.js": `function capable(){if(scope.query.getData(accountQuery,accountId)?.accounts[accountId]?.account.tbo_config?.tbo_available!==!0)throw Error();let capable=response?.accounts[accountId]?.account.tbo_config?.tbo_available===!0;return capable||retry?.accounts[accountId]?.account.tbo_config?.tbo_available===!0}`,
  "personalization-settings-current.js": `first?.accounts[accountId]?.account.tbo_config?.tbo_available!==!0; second?.accounts[otherId]?.account.tbo_config?.tbo_available!==!0;`,
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
  const patched = applyDotsLandingRoutePatch(FIXTURES["landing-route-current.js"]);
  assert.doesNotMatch(patched, /tbo_available==null/);
  assert.match(patched, /if\(account\.tbo_config\.tbo_available\)/);
  assert.equal(applyDotsLandingRoutePatch(patched), patched);
});

test("shared Dots capability checks no longer reject a country-gated account", () => {
  const patched = applyDotsAppSharedPatch(FIXTURES["app-initial-current.js"]);
  assert.equal(patched, "function capable(){if(!1)throw Error();let capable=!0;return capable||!0}");
  assert.doesNotMatch(patched, /\?\.[!01]/);
  assert.equal(applyDotsAppSharedPatch(patched), patched);
});

test("personalization Dots checks are patched together", () => {
  const patched = applyDotsPersonalizationPatch(FIXTURES["personalization-settings-current.js"]);
  assert.equal(patched, "!1; !1;");
  assert.doesNotMatch(patched, /\?\.[!01]/);
  assert.equal(applyDotsPersonalizationPatch(patched), patched);
});

test("ambiguous contracts fail closed", () => {
  const source = "a?.tbo_config?.tbo_available==null;b?.tbo_config?.tbo_available==null";
  assert.equal(applyDotsLandingRoutePatch(source), source);
});

test("each descriptor patches its current asset contract", () => {
  const extractedDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatgpt-dots-any-country-assets-"));
  const assetsDir = path.join(extractedDir, "webview", "assets");
  fs.mkdirSync(assetsDir, { recursive: true });
  try {
    for (const [name, source] of Object.entries(FIXTURES)) fs.writeFileSync(path.join(assetsDir, name), source);
    for (const descriptor of descriptors) {
      const result = patchUniqueAssetFile(
        extractedDir,
        descriptor.pattern,
        descriptor.assetMatch,
        descriptor.apply,
        "missing",
        "ambiguous",
      );
      assert.equal(result.matched, 1);
      assert.equal(result.changed, 1);
    }
  } finally {
    fs.rmSync(extractedDir, { recursive: true, force: true });
  }
});
