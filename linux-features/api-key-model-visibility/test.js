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
  applyApiKeyServiceTierPatch,
} = require("../api-key-service-tier/patch.js");
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

function modelCatalogFixture() {
  return "function vbe({authMethod:e,availableModels:t,defaultModel:n,enabledReasoningEfforts:r,includeUltraReasoningEffort:i,models:a,useHiddenModels:o}){let s=[],c=null,l=o&&e!==`amazonBedrock`;return a.forEach(n=>{if(l?t.has(n.model):!n.hidden){s.push(n),n.isDefault&&(c=n)}}),c??=s.find(e=>e.model===n)??null,{models:s,defaultModel:c}}";
}

function serviceTierCompatibleFixture() {
  return "function vbe({authMethod:e,availableModels:t,defaultModel:n,enabledReasoningEfforts:r,includeUltraReasoningEffort:i,models:a,useHiddenModels:o}){let s=[],c=null,l=o&&e!==`amazonBedrock`,u=a.some(e=>e.supportedReasoningEfforts.some(({reasoningEffort:e})=>e===`max`)),d=i&&a.some(e=>e.supportedReasoningEfforts.some(({reasoningEffort:e})=>e===`ultra`));return a.forEach(n=>{if(l?t.has(n.model):!n.hidden){let t=i?n.supportedReasoningEfforts:n.supportedReasoningEfforts.filter(({reasoningEffort:e})=>e!==`ultra`),a=(e===`copilot`?[t.find(e=>e.reasoningEffort===`medium`)??{reasoningEffort:`medium`,description:`medium effort`}]:t).filter(({reasoningEffort:e})=>Gx(e)&&r.has(e)),o={...n,supportedReasoningEfforts:a};s.push(o),n.isDefault&&(c=o)}}),c??=s.find(e=>e.model===n)??null,{models:s,defaultModel:c}}";
}

function evaluateCatalog(source, authMethod, useHiddenModels = true) {
  const catalog = Function(`${source};return vbe;`)();
  return catalog({
    authMethod,
    availableModels: new Set(["gpt-5.5"]),
    defaultModel: "gpt-5.5",
    enabledReasoningEfforts: new Set(),
    includeUltraReasoningEffort: true,
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
  assert.equal(descriptors[0].pattern.test("app-initial~app-main~onboarding-page-abc.js"), true);
  assert.equal(descriptors[0].pattern.test("settings-page-abc.js"), false);
});

test("API-key hosts use visible CLI models instead of the desktop allowlist", () => {
  const patched = applyPatchTwice(applyApiKeyModelVisibilityPatch, modelCatalogFixture());
  const catalog = evaluateCatalog(patched, "apikey");

  assert.match(patched, /e!==`apikey`\/\*codexLinuxApiKeyModelVisibility\*\//);
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

test("ChatGPT and existing no-allowlist paths keep their upstream behavior", () => {
  const patched = applyApiKeyModelVisibilityPatch(modelCatalogFixture());

  assert.deepEqual(modelNames(evaluateCatalog(patched, "chatgpt")), ["gpt-5.5"]);
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

test("model visibility and API key service tier patches compose in either order", () => {
  const source = serviceTierCompatibleFixture();
  const visibilityFirst = applyApiKeyServiceTierPatch(
    applyApiKeyModelVisibilityPatch(source),
  );
  const serviceTierFirst = applyApiKeyModelVisibilityPatch(
    applyApiKeyServiceTierPatch(source),
  );

  assert.equal(visibilityFirst, serviceTierFirst);
  for (const patched of [visibilityFirst, serviceTierFirst]) {
    assert.match(patched, /codexLinuxApiKeyModelVisibility/);
    assert.match(patched, /codexLinuxApiKeyServiceTierModel:e===`apikey`/);
  }
});

test("extended upstream model gates fail soft instead of patching mid-expression", () => {
  const source = modelCatalogFixture().replace(
    "l=o&&e!==`amazonBedrock`;",
    "l=o&&e!==`amazonBedrock`&&featureGate;",
  );

  assert.equal(applyApiKeyModelVisibilityPatch(source), source);
});

test("enabled descriptor patches a matching extracted webview asset", () => {
  withFeatureConfig(["api-key-model-visibility"], (featuresRoot) => {
    withTempDir((extractedDir) => {
      const assetsDir = path.join(extractedDir, "webview", "assets");
      const assetPath = path.join(assetsDir, "app-initial~app-main~fixture.js");
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
