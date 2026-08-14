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
  return "function ati({additionalAvailableModels:e,authMethod:t,availableModels:n,isCustomModelProvider:r,model:i,useHiddenModels:a}){return e?.has(i.model)===!0||i.model!==`codex-auto-review`&&(a&&!r&&t!==`amazonBedrock`?n.has(i.model):!i.hidden)}";
}

function modelCatalogFixture() {
  // Current upstream shape (refactored): catalog filter delegates per-model
  // visibility to a q$r-style helper that owns the allowlist gate.
  return "function iti({additionalAvailableModels:e,authMethod:t,availableModels:n,defaultModel:r,enabledReasoningEfforts:i,includeUltraReasoningEffort:a,isCustomModelProvider:o=!1,models:s,useHiddenModels:c}){let l=[],u=null;return s.forEach(r=>{if(ati({additionalAvailableModels:e,authMethod:t,availableModels:n,isCustomModelProvider:o,model:r,useHiddenModels:c})){l.push(r),r.isDefault&&(u=r)}}),u??=l.find(e=>e.model===r)??null,{models:l,defaultModel:u}}" + modelVisibilityHelperFixture();
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

test("descriptor is optional and targets app main webview chunks", () => {
  assert.deepEqual(
    descriptors.map((descriptor) => [descriptor.id, descriptor.phase, descriptor.ciPolicy]),
    [["api-key-model-visibility-ui", "webview-asset", "optional"]],
  );
  assert.equal(descriptors[0].pattern.test("app-initial~app-main~onboarding-page-abc.js"), false);
  assert.equal(descriptors[0].pattern.test("app-initial-CKNQDTeE.js"), true);
  assert.equal(descriptors[0].pattern.test("settings-page-abc.js"), false);
});

test("API-key hosts use visible CLI models instead of the desktop allowlist", () => {
  const patched = applyPatchTwice(applyApiKeyModelVisibilityPatch, modelCatalogFixture());
  const catalog = evaluateCatalog(patched, "apikey");

  assert.match(patched, /!==`apikey`\/\*codexLinuxApiKeyModelVisibility\*\//);
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
    "function ati({additionalAvailableModels:e,authMethod:t,availableModels:n,isCustomModelProvider:r,model:i,useHiddenModels:a}){return a&&t!==`amazonBedrock`;}",
    "function ati({additionalAvailableModels:e,authMethod:t,availableModels:n,isCustomModelProvider:r,model:i,useHiddenModels:a}){return a&&t!==`amazonBedrock`,n.has(i.model)}",
    helper.replace(
      "?n.has(i.model):!i.hidden",
      "?featureGate&&n.has(i.model):!i.hidden",
    ),
    helper.replace(
      "?n.has(i.model):!i.hidden",
      "?n.has(i.model):featureGate&&!i.hidden",
    ),
  ];

  for (const source of driftedHelpers) {
    assert.equal(applyApiKeyModelVisibilityPatch(source), source);
  }
});

test("enabled descriptor patches a matching extracted webview asset", () => {
  withFeatureConfig(["api-key-model-visibility"], (featuresRoot) => {
    withTempDir((extractedDir) => {
      const assetsDir = path.join(extractedDir, "webview", "assets");
      const assetPath = path.join(assetsDir, "app-initial-CKNQDTeE.js");
      fs.mkdirSync(assetsDir, { recursive: true });
      fs.writeFileSync(assetPath, modelCatalogFixture());

      const normalized = normalizePatchDescriptors(
        loadLinuxFeaturePatchDescriptors({ featuresRoot }),
      );
      applyWebviewAssetPatchDescriptors(extractedDir, normalized, {}, null);

      assert.match(fs.readFileSync(assetPath, "utf8"), /codexLinuxApiKeyModelVisibility/);
    });
  });
});
