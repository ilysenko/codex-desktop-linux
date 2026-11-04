#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  applyWebviewAssetPatchDescriptors,
  normalizePatchDescriptors,
} = require("../../scripts/patches/engine.js");
const {
  loadLinuxFeaturePatchDescriptors,
} = require("../../scripts/lib/linux-features.js");
const {
  applyApiKeyModelVisibilityPatch,
  descriptors,
} = require("./patch.js");

function applyPatchTwice(patchFn, source) {
  const once = patchFn(source);
  assert.notEqual(once, source);
  assert.equal(patchFn(once), once);
  return once;
}

function modelVisibilityHelperFixture() {
  // Current upstream rspack/SWC shape: an anonymous predicate inlined into the
  // catalog filter.
  return 'function({additionalAvailableModels:e,apiKeyDaybreakSupported:t,authMethod:n,availableModels:r,hasConfiguredModelCatalog:i,isCustomModelProvider:a,model:s,useHiddenModels:o}){let l=s.availableAccessPrograms?.cyber;return("apikey"!==n||!!t||null==l||!(l.length>0)||!!l.includes("standard"))&&(e?.has(s.model)===!0||"codex-auto-review"!==s.model&&(i&&!s.hidden||(o&&!a&&"amazonBedrock"!==n?r.has(s.model)||"apikey"===n&&t&&!s.hidden&&l?.some(e=>"standard"!==e)===!0:!s.hidden)))}';
}

function modelCatalogFixture(helper = modelVisibilityHelperFixture()) {
  return "function iti({additionalAvailableModels:e,apiKeyDaybreakSupported:t=!1,authMethod:n,availableModels:a,defaultModel:s,enabledReasoningEfforts:o,hasConfiguredModelCatalog:l,includeUltraReasoningEffort:u,isCustomModelProvider:d=!1,models:c,useHiddenModels:p}){let h=[],f=null;return c.forEach(i=>{if(" + helper + "({additionalAvailableModels:e,apiKeyDaybreakSupported:t,authMethod:n,availableModels:a,hasConfiguredModelCatalog:l,isCustomModelProvider:d,model:i,useHiddenModels:p})){h.push(i),i.isDefault&&(f=i)}}),null==f&&(f=h.find(e=>e.model===s)??null),{models:h,defaultModel:f}}";
}

function evaluateCatalog(
  source,
  authMethod,
  useHiddenModels = true,
  isCustomModelProvider = false,
) {
  const catalog = Function(`${source};return iti;`)();
  return catalog({
    authMethod,
    availableModels: new Set(["gpt-5.5"]),
    defaultModel: "gpt-5.5",
    enabledReasoningEfforts: new Set(),
    includeUltraReasoningEffort: true,
    isCustomModelProvider,
    models: [
      { model: "gpt-5.6-sol", hidden: false, isDefault: true },
      { model: "gpt-5.6-terra", hidden: false, isDefault: false },
      { model: "gpt-5.6-luna", hidden: false, isDefault: false },
      { model: "gpt-5.5", hidden: false, isDefault: false },
      { model: "codex-auto-review", hidden: true, isDefault: false },
    ],
    useHiddenModels,
  });
}

function modelNames(catalog) {
  return catalog.models.map((model) => model.model);
}

function withTempDir(callback) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "api-key-model-visibility-"));
  try {
    return callback(tempDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function withFeatureConfig(enabled, callback) {
  const originalConfig = process.env.CODEX_LINUX_FEATURES_CONFIG;
  return withTempDir((tempDir) => {
    const configPath = path.join(tempDir, "features.json");
    fs.writeFileSync(configPath, `${JSON.stringify({ enabled })}\n`);
    process.env.CODEX_LINUX_FEATURES_CONFIG = configPath;
    try {
      return callback(path.resolve(__dirname, ".."));
    } finally {
      if (originalConfig == null) {
        delete process.env.CODEX_LINUX_FEATURES_CONFIG;
      } else {
        process.env.CODEX_LINUX_FEATURES_CONFIG = originalConfig;
      }
    }
  });
}

test("api-key-model-visibility stays disabled until listed in features.json", () => {
  withFeatureConfig([], (featuresRoot) => {
    assert.deepEqual(loadLinuxFeaturePatchDescriptors({ featuresRoot }), []);
  });

  withFeatureConfig(["api-key-model-visibility"], (featuresRoot) => {
    const loaded = loadLinuxFeaturePatchDescriptors({ featuresRoot });
    assert.deepEqual(
      loaded.map((descriptor) => [descriptor.id, descriptor.phase, descriptor.ciPolicy]),
      [["feature:api-key-model-visibility:api-key-model-visibility-ui", "webview-asset", "optional"]],
    );
  });
});

test("descriptor is optional and finds the model allowlist chunk by content", () => {
  assert.deepEqual(
    descriptors.map((descriptor) => [descriptor.id, descriptor.phase, descriptor.ciPolicy]),
    [["api-key-model-visibility-ui", "webview-asset", "optional"]],
  );
  assert.equal(descriptors[0].pattern, undefined);
  assert.equal(descriptors[0].assetPattern, undefined);
  assert.deepEqual(descriptors[0].assetNeedles, [
    "useHiddenModels",
    "codex-auto-review",
    "availableAccessPrograms",
  ]);
  for (const needle of descriptors[0].assetNeedles) {
    assert.equal(modelCatalogFixture().includes(needle), true, needle);
  }
});

test("API-key hosts use visible CLI models instead of the desktop allowlist", () => {
  const patched = applyPatchTwice(applyApiKeyModelVisibilityPatch, modelCatalogFixture());
  const catalog = evaluateCatalog(patched, "apikey");

  assert.match(patched, /"amazonBedrock"!==n&&"apikey"!==n\/\*codexLinuxApiKeyModelVisibility\*\//);
  assert.deepEqual(modelNames(catalog), [
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.5",
  ]);
  assert.equal(catalog.defaultModel.model, "gpt-5.6-sol");
});

test("API-key hosts still exclude models marked hidden by the CLI", () => {
  const patched = applyApiKeyModelVisibilityPatch(modelCatalogFixture());

  assert.equal(modelNames(evaluateCatalog(patched, "apikey")).includes("codex-auto-review"), false);
});

test("visible custom-provider models preserve upstream visibility", () => {
  const source = modelCatalogFixture();
  const patched = applyApiKeyModelVisibilityPatch(source);
  const expected = modelNames(evaluateCatalog(source, "chatgpt", true, true));

  assert.deepEqual(modelNames(evaluateCatalog(patched, "chatgpt", true, true)), expected);
  assert.deepEqual(expected, [
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.5",
  ]);
});

test("ChatGPT and existing no-allowlist paths keep their upstream behavior", () => {
  const patched = applyApiKeyModelVisibilityPatch(modelCatalogFixture());

  assert.deepEqual(modelNames(evaluateCatalog(patched, "chatgpt")), ["gpt-5.5"]);
  assert.deepEqual(modelNames(evaluateCatalog(patched, "copilot")), ["gpt-5.5"]);
  assert.deepEqual(modelNames(evaluateCatalog(patched, "chatgpt", false)), [
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.5",
  ]);
  assert.deepEqual(modelNames(evaluateCatalog(patched, "amazonBedrock")), [
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.5",
  ]);
});

test("drifted model visibility helpers fail soft and stay byte-identical", () => {
  const helper = modelVisibilityHelperFixture();
  const driftedHelpers = [
    helper.replace('"amazonBedrock"!==n?', '"amazonBedrock"!==n&&featureGate?'),
    helper.replace("?r.has(s.model)", "?featureGate&&r.has(s.model)"),
    helper.replace(":!s.hidden)))}", ":featureGate&&!s.hidden)))}"),
    helper.replace("i&&!s.hidden||", ""),
    helper.replace("useHiddenModels:o}", "useHiddenModels:o,extra:x}"),
  ];

  for (const drifted of driftedHelpers) {
    const source = modelCatalogFixture(drifted);
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (message) => warnings.push(message);
    try {
      assert.equal(applyApiKeyModelVisibilityPatch(source), source);
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(warnings.length, 1, drifted);
    assert.match(warnings[0], /Could not find desktop model allowlist gate/);
  }
});

test("duplicate allowlist gates are rejected as ambiguous", () => {
  const source = modelCatalogFixture() + modelCatalogFixture().replace("function iti(", "function itj(");
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (message) => warnings.push(message);
  try {
    assert.equal(applyApiKeyModelVisibilityPatch(source), source);
  } finally {
    console.warn = originalWarn;
  }
  assert.match(warnings.join("\n"), /ambiguous/);
});

test("enabled descriptor patches a matching extracted webview asset", () => {
  withFeatureConfig(["api-key-model-visibility"], (featuresRoot) => {
    withTempDir((extractedDir) => {
      const assetsDir = path.join(extractedDir, "webview", "assets");
      const assetPath = path.join(assetsDir, "async", "24191.7b05d5cf83.js");
      fs.mkdirSync(path.dirname(assetPath), { recursive: true });
      fs.writeFileSync(assetPath, `export const __webpack_modules__={a(e,t,r){${modelCatalogFixture()}}};`);

      const normalized = normalizePatchDescriptors(
        loadLinuxFeaturePatchDescriptors({ featuresRoot }),
      );
      applyWebviewAssetPatchDescriptors(extractedDir, normalized, {}, null);

      assert.match(fs.readFileSync(assetPath, "utf8"), /codexLinuxApiKeyModelVisibility/);
    });
  });
});

const signedApp = process.env.CODEX_SIGNED_EXTRACTED_APP;
test("official signed webview patches exactly one chunk", { skip: !signedApp }, () => {
  const { findWebviewAssetsContaining } = require("../../scripts/patches/lib/assets.js");
  const { spawnSync } = require("node:child_process");
  const assets = findWebviewAssetsContaining(signedApp, descriptors[0].assetNeedles);
  assert.equal(assets.length, 1);
  const source = fs.readFileSync(path.join(signedApp, "webview", "assets", assets[0]), "utf8");
  const patched = applyApiKeyModelVisibilityPatch(source);
  assert.notEqual(patched, source);
  assert.equal(patched.split("codexLinuxApiKeyModelVisibility").length, 2);
  assert.equal(applyApiKeyModelVisibilityPatch(patched), patched);
  const check = spawnSync(process.execPath, ["--input-type=module", "--check"], {
    input: patched,
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(check.status, 0, String(check.stderr));
});
