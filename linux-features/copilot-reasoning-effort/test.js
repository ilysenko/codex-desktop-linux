#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  applyWebviewAssetPatchDescriptors,
  applyExtractedAppPatchDescriptors,
  normalizePatchDescriptors,
} = require("../../scripts/patches/engine.js");
const {
  loadLinuxFeaturePatchDescriptors,
} = require("../../scripts/lib/linux-features.js");
const {
  applyCopilotReasoningEffortModelListPatch,
  applyCopilotReasoningEffortModelListAppPatch,
  matchesCopilotReasoningEffortModelListContract,
  MODEL_LIST_NEEDLES,
  descriptors,
  applyCopilotSettingsPersistence,patchCopilotSettingsPersistence,settingsPersistenceState,
  matchesCopilotModelAndReasoningPersistenceContract,
} = require("./patch.js");
const { findWebviewAssetsContaining } = require("../../scripts/patches/lib/assets.js");
const { spawnSync } = require("node:child_process");
const { Script } = require("node:vm");
const {applyDropdownModule,dropdownModuleState,NEEDLES:DROPDOWN_OWNER_NEEDLES}=require("./dropdown-owner.js");
const currentDropdown=require("./fixtures/current-dropdown.json");
const currentSlash=require("./fixtures/current-slash.json");
const {applySlashModule,slashModuleState,NEEDLES:SLASH_OWNER_NEEDLES}=require("./slash-owner.js");
const { inspectModelCatalogOwner } = require("../../scripts/patches/lib/model-composer-owners.js");
const { rspackModuleFactories } = require("../../scripts/patches/lib/rspack-module-assets.js");
const { createPatchReport, captureWarnings, enabledFeatureFailuresFromReport } = require("../../scripts/lib/patch-report.js");
const currentModelCatalog = require("../../scripts/patches/lib/fixtures/current-model-composer.json").catalog;
const currentSettings=require("../../scripts/patches/lib/fixtures/current-model-composer.json").settings;
const MODEL_LIST_MARKER = "codexLinuxCopilotReasoningEffortModelList";

function applyPatchTwice(patchFn, source) {
  const patched = patchFn(source);
  assert.notEqual(patched, source);
  assert.equal(patchFn(patched), patched);
  return patched;
}

function withCapturedWarns(fn) {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    return { value: fn(), warnings };
  } finally {
    console.warn = originalWarn;
  }
}

// Fixtures below follow the current official rspack/SWC shapes.
function currentModelAndReasoningPersistenceFixture() { return currentSettings.moduleSource; }

function currentFilteredCopilotReasoningEffortModelListFixture() {
  const predicate = 'function({additionalAvailableModels:extra,apiKeyDaybreakSupported:daybreak,authMethod:auth,availableModels:allow,hasConfiguredModelCatalog:configured,isCustomModelProvider:custom,model:item,useHiddenModels:hidden}){let programs=item.availableAccessPrograms?.cyber;return("apikey"!==auth||!!daybreak||null==programs||!(programs.length>0)||!!programs.includes("standard"))&&(extra?.has(item.model)===!0||"codex-auto-review"!==item.model&&(configured&&!item.hidden||(hidden&&!custom&&"amazonBedrock"!==auth?allow.has(item.model)||"apikey"===auth&&daybreak&&!item.hidden&&programs?.some(program=>"standard"!==program)===!0:!item.hidden)))}';
  return 'var guard=loader("effort-guard");loader.d(exports,{},{catalog:function({additionalAvailableModels:extra,apiKeyDaybreakSupported:daybreak=!1,authMethod:auth,availableModels:allow,defaultModel:fallback,enabledReasoningEfforts:enabled,hasConfiguredModelCatalog:configured,includeUltraReasoningEffort:ultra,isCustomModelProvider:custom=!1,models:models,useHiddenModels:hidden}){let output=[],defaultModel=null,maximum=!1,ultraFlag=!1;return models.forEach(item=>{if(' + predicate + '({additionalAvailableModels:extra,apiKeyDaybreakSupported:daybreak,authMethod:auth,availableModels:allow,hasConfiguredModelCatalog:configured,isCustomModelProvider:custom,model:item,useHiddenModels:hidden})){let raw=ultra?item.supportedReasoningEfforts:item.supportedReasoningEfforts.filter(({reasoningEffort:effort})=>"ultra"!==effort),filtered=("copilot"===auth?[raw.find(effort=>"medium"===effort.reasoningEffort)??{reasoningEffort:"medium",description:"medium effort"}]:raw).filter(({reasoningEffort:effort})=>(0,guard.allowed)(effort)&&enabled.has(effort)),normalized={...item,supportedReasoningEfforts:filtered};output.push(normalized),item.isDefault&&(defaultModel=normalized)}}),null==defaultModel&&(defaultModel=output.find(item=>item.model===fallback)??null),{models:output,defaultModel:defaultModel,hasModelSupportingMaxReasoningEffort:maximum,hasModelSupportingUltraReasoningEffort:ultraFlag}}})';
}


function withTempDir(fn) {
  const cache = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "codex-desktop-dev");
  fs.mkdirSync(cache, { recursive: true });
  const dir = fs.mkdtempSync(path.join(cache, "codex-copilot-reasoning-feature-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function withTempFeatureConfig(enabled, fn) {
  const originalConfig = process.env.CODEX_LINUX_FEATURES_CONFIG;
  return withTempDir((tmp) => {
    process.env.CODEX_LINUX_FEATURES_CONFIG = path.join(tmp, "features.json");
    fs.writeFileSync(process.env.CODEX_LINUX_FEATURES_CONFIG, JSON.stringify({ enabled }, null, 2));
    try {
      return fn();
    } finally {
      if (originalConfig == null) {
        delete process.env.CODEX_LINUX_FEATURES_CONFIG;
      } else {
        process.env.CODEX_LINUX_FEATURES_CONFIG = originalConfig;
      }
    }
  });
}

function asChunk(body) {
  return `export const __rspack_esm_id=1;export const __webpack_modules__={m(module,exports,loader){${body}}};`;
}

function writeAsset(extractedDir, name, source) {
  const assetsDir = path.join(extractedDir, "webview", "assets", "async");
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.writeFileSync(path.join(assetsDir, name), source === currentSettings.moduleSource || source.startsWith(currentSettings.moduleSource.slice(0,20)) ? `export const __webpack_modules__={settings(${currentSettings.params.join(",")}){${source}}};` : source.includes("additionalAvailableModels:") ? asChunk(source).replace("{m(", "{ModelCatalog(") : asChunk(source));
}

function readAsset(extractedDir, name) {
  return fs.readFileSync(path.join(extractedDir, "webview", "assets", "async", name), "utf8");
}

test("binds Copilot persistence to the current model-and-reasoning service", () => {
  const source = currentModelAndReasoningPersistenceFixture();
  assert.equal(matchesCopilotModelAndReasoningPersistenceContract(source,currentSettings), true);
  for (const drifted of [
    source.replace(".setDefaultModelConfig(e,l,eA.profile)", ".setDefaultModelConfig(e,eA.profile)"),
    source.replace('()=>eJ(e,l,"default")', '()=>other(e,l,"default")'),
    source.repeat(2),
  ]) {
    assert.equal(matchesCopilotModelAndReasoningPersistenceContract(drifted,currentSettings), false);
  }
});

test("descriptors find their owners by content needles, not chunk names", () => {
  assert.deepEqual(descriptors.map((descriptor) => descriptor.id), [
    "persistence-contract",
    "model-list",
    "ui-dropdown",
    "ui-slash-command",
  ]);
  const fixtures = [
    currentModelAndReasoningPersistenceFixture(),
    currentFilteredCopilotReasoningEffortModelListFixture(),
    currentDropdown.composer.source,
    currentSlash.synthetic.source,
  ];
  descriptors.forEach((descriptor, index) => {
    assert.equal(descriptor.pattern, undefined);
    assert.equal(descriptor.assetPattern, undefined);
    assert.equal(descriptor.assetMatch, undefined);
    if (["model-list","persistence-contract","ui-dropdown","ui-slash-command"].includes(descriptor.id)) {
      assert.equal(descriptor.phase, "extracted-app:pre-webview");
      assert.equal(descriptor.assetNeedles, undefined);
      if(descriptor.id==="model-list")assert.ok(MODEL_LIST_NEEDLES.every(needle => fixtures[index].includes(needle)));
      if(descriptor.id==="ui-dropdown")assert.ok(DROPDOWN_OWNER_NEEDLES.every(needle=>currentDropdown.composer.source.includes(needle)));
      if(descriptor.id==="ui-slash-command")assert.ok(SLASH_OWNER_NEEDLES.every(needle=>currentSlash.synthetic.source.includes(needle)));
      return;
    }
    for (const needle of descriptor.assetNeedles) {
      assert.equal(fixtures[index].includes(needle), true, `${descriptor.id}: ${needle}`);
    }
  });
});

test("Copilot persistence rejects a drifted physical copy before editing its healthy sibling",()=>{
 withTempDir(extractedDir=>{const good=currentSettings.moduleSource;const drifted=good.replace('()=>eJ(e,l,"default")','()=>other(e,l,"default")');
 writeAsset(extractedDir,"1.a.js",good);writeAsset(extractedDir,"2.b.js",drifted);
 const before=["1.a.js","2.b.js"].map(name=>readAsset(extractedDir,name));
 assert.throws(()=>patchCopilotSettingsPersistence(extractedDir),/persistence factory/);
 assert.deepEqual(["1.a.js","2.b.js"].map(name=>readAsset(extractedDir,name)),before);
 });
});

function modelListSnapshot(source) {
  return [...rspackModuleFactories(asChunk(source), "fixture.js")][0];
}
function applyModelListBody(source) {
  return applyCopilotReasoningEffortModelListPatch(source, { factorySnapshot: modelListSnapshot(source) });
}
function syntheticCatalog(source, predicate = effort => effort !== "invalid") {
  const found = inspectModelCatalogOwner(modelListSnapshot(source));
  assert.equal(found.ok, true, found.reason);
  // Only this reduced synthetic function is evaluated. Signed factory fixtures
  // below are inspected and parsed as source, never executed.
  return Function("guard", `return (${source.slice(found.owner.start, found.owner.end)});`)({ allowed: predicate });
}
function catalogInputs(authMethod = "copilot", extra = {}) {
  return { authMethod, availableModels: new Set(["allowed"]), defaultModel: "allowed",
    enabledReasoningEfforts: new Set(["low", "medium", "high", "ultra", "invalid"]),
    includeUltraReasoningEffort: false, useHiddenModels: false,
    models: [{ model: "allowed", hidden: false, isDefault: true,
      supportedReasoningEfforts: ["low", "high", "ultra", "invalid"].map(reasoningEffort => ({ reasoningEffort })) }], ...extra };
}
const effortNames = result => result.models.map(model => model.supportedReasoningEfforts.map(e => e.reasoningEffort));

test("Copilot efforts keep native model, hidden, enabled and ultra filtering across identity changes", () => {
  const source = currentFilteredCopilotReasoningEffortModelListFixture(), patched = applyModelListBody(source);
  assert.notEqual(patched, source);
  assert.equal(applyModelListBody(patched), patched);
  assert.match(patched, /filtered=\/\*codexLinuxCopilotReasoningEffortModelList\*\/\[\.\.\.raw\]\.filter/);
  assert.doesNotMatch(patched, /description:"medium effort"/);
  const normalize = syntheticCatalog(patched);
  assert.deepEqual(effortNames(normalize(catalogInputs())), [["low", "high"]]);
  assert.deepEqual(effortNames(normalize(catalogInputs("copilot", { includeUltraReasoningEffort: true }))), [["low", "high", "ultra"]]);
  assert.deepEqual(effortNames(normalize(catalogInputs("copilot", { enabledReasoningEfforts: new Set(["high"]) }))), [["high"]]);
  assert.deepEqual(effortNames(normalize(catalogInputs("copilot", { models: [{ ...catalogInputs().models[0], hidden: true }] }))), []);
  assert.deepEqual(effortNames(normalize(catalogInputs("copilot", { models: [{ ...catalogInputs().models[0], supportedReasoningEfforts: [] }] }))), [[]]);
  for (const auth of ["chatgpt", "apikey", "amazonBedrock", "unknown", null]) {
    assert.deepEqual(normalize(catalogInputs(auth)), syntheticCatalog(source)(catalogInputs(auth)), String(auth));
  }
  assert.deepEqual(effortNames(normalize(catalogInputs("copilot", { models: [{ ...catalogInputs().models[0], supportedReasoningEfforts: [{ reasoningEffort: "medium" }] }] }))), [["medium"]]);
  assert.deepEqual(effortNames(normalize(catalogInputs())), [["low", "high"]]);
  assert.doesNotThrow(() => new Script(patched));
});

test("retained current signed catalog qualifies and changes exactly the effort expression", () => {
  const source = currentModelCatalog.moduleSource;
  const context = { factorySnapshot: currentModelCatalog };
  const patched = applyCopilotReasoningEffortModelListPatch(source, context);
  const native = '("copilot"===n?[e.find(e=>"medium"===e.reasoningEffort)??{reasoningEffort:"medium",description:"medium effort"}]:e)';
  assert.equal(patched.replace(`/*${MODEL_LIST_MARKER}*/[...e]`, native), source);
  assert.equal(applyCopilotReasoningEffortModelListPatch(patched, { factorySnapshot: { ...currentModelCatalog, moduleSource: patched } }), patched);
  assert.doesNotThrow(() => new Script(patched));
});

test("model list requires native publication, imports, model output and exact canonical contribution", () => {
  const source = currentFilteredCopilotReasoningEffortModelListFixture(), patched = applyModelListBody(source);
  const candidates = [
    source.replace('"copilot"===auth', '"copilot"===other'), source.replace('loader.d(exports,', 'loader.d(otherExports,'),
    source.replace('var guard=loader("effort-guard");', 'const guard=unrelated;'),
    source.replace('normalized={...item,', 'normalized={...other,'),
    source.replace('normalized={...item,supportedReasoningEfforts:filtered};output.push(normalized),item.isDefault&&(defaultModel=normalized)', 'ultra={...item,supportedReasoningEfforts:filtered};output.push(ultra),item.isDefault&&(defaultModel=ultra)'),
    source.replace('enabled.has(effort)', 'other.has(effort)'),
    source.replace('models.forEach(item=>', 'models.forEach(auth=>'),
    source.replace('filtered=("copilot"', 'raw=other,filtered=("copilot"'),
    source.replace('),normalized={', ').filter(x=>!0),normalized={'),
    source.replace('if(function({additionalAvailableModels:', 'if(!0||function({additionalAvailableModels:'),
    source.replace('raw.find(effort=>"medium"===effort.reasoningEffort)', 'raw.find(other=>"medium"===other.reasoningEffort)'),
    source + `/*${MODEL_LIST_MARKER}*/`, patched + `/*${MODEL_LIST_MARKER}*/`,
    patched.replace('[...raw]', '[...other]'), patched.replace(`/*${MODEL_LIST_MARKER}*/`, ''),
    source.replace('filtered=("copilot"', `filtered=/*${MODEL_LIST_MARKER}*/("copilot"`),
  ];
  for (const candidate of candidates) {
    assert.equal(matchesCopilotReasoningEffortModelListContract(candidate, { factorySnapshot: modelListSnapshot(candidate) }), false);
    assert.throws(() => applyModelListBody(candidate), /Unsupported|noncanonical/);
  }
  assert.throws(() => applyCopilotReasoningEffortModelListPatch(source), /Missing/);
  assert.throws(() => applyCopilotReasoningEffortModelListPatch(source, { factorySnapshot: { ...modelListSnapshot(source), moduleSource: "stale" } }), /Stale/);
  const registry = asChunk(source);
  for (const opaque of ['/*'+registry+'*/', 'const example=`'+registry+'`;', JSON.stringify(registry)]) {
    assert.throws(() => applyCopilotReasoningEffortModelListPatch(opaque), /Opaque|Missing/);
  }
  assert.throws(() => applyCopilotReasoningEffortModelListPatch(`/*${MODEL_LIST_MARKER}*/`+registry), /Orphan/);
  assert.throws(() => applyCopilotReasoningEffortModelListPatch(registry.replace('}};', `},Other(module,exports,loader){const marker="${MODEL_LIST_MARKER}";}};`)), /Orphan/);
});

function modelListScene(files, run) {
  return withTempDir(root => {
    const assets = path.join(root, "webview", "assets");
    fs.mkdirSync(assets, { recursive: true });
    for (const [name, source] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(assets, name)), { recursive: true });
      fs.writeFileSync(path.join(assets, name), source, { mode: 0o640 });
    }
    return run(root, assets, name => fs.readFileSync(path.join(assets, name), "utf8"));
  });
}
function modelListReport(root) {
  const report = createPatchReport();
  report.enabledFeatures = ["copilot-reasoning-effort"];
  const descriptor = { ...descriptors[1], featureId: "copilot-reasoning-effort" };
  captureWarnings(() => applyExtractedAppPatchDescriptors(root, normalizePatchDescriptors([descriptor]), { enabledFeatureIds: ["copilot-reasoning-effort"] }, report, descriptor.phase));
  return report;
}

test("production extracted-app model-list descriptor reaches all copies before and after its splice", () => {
  const body = currentFilteredCopilotReasoningEffortModelListFixture(), pristine = asChunk(body);
  modelListScene({ "one.js": pristine, "nested/two.js": pristine, "other.js": "export const keep=1;" }, (root, assets, read) => {
    const first = modelListReport(root);
    assert.equal(first.patches[0].status, "applied");
    assert.deepEqual(enabledFeatureFailuresFromReport(first), []);
    assert.equal(read("one.js"), applyCopilotReasoningEffortModelListPatch(pristine));
    assert.equal(read("nested/two.js"), read("one.js"));
    assert.equal(read("other.js"), "export const keep=1;");
    assert.equal(modelListReport(root).patches[0].status, "already-applied");
    for (const name of ["one.js", "nested/two.js"]) assert.equal(fs.statSync(path.join(assets, name)).mode & 0o777, 0o640);
  });
});

test("model-list cohorts reject ambiguous, missing, mixed, hidden, damaged and opaque copies before any write", () => {
  const source = asChunk(currentFilteredCopilotReasoningEffortModelListFixture()), patched = applyCopilotReasoningEffortModelListPatch(source);
  for (const files of [
    {}, { "one.js": source, "two.js": source.replace('{m(', '{Other(') },
    { "one.js": source, "two.js": patched },
    { "one.js": source, "nested/two.js": asChunk('const lostEveryNeedle=true;') },
    { "one.js": source, "two.js": source.replace('enabled.has(effort)', 'wrong.has(effort)') },
    { "one.js": source, "orphan.js": `export const marker="${MODEL_LIST_MARKER}";` },
    { "one.js": source, "two.js": asChunk('const opaque="'+MODEL_LIST_MARKER+'";').replace('{m(', '{Other(') },
  ]) modelListScene(files, (root, assets, read) => {
    assert.throws(() => applyCopilotReasoningEffortModelListAppPatch(root), /find|identities|Partially|Unsupported|Orphan|Syntax/);
    const result = modelListReport(root);
    assert.equal(enabledFeatureFailuresFromReport(result).length, 1);
    for (const [name, original] of Object.entries(files)) {
      assert.equal(read(name), original);
      assert.equal(fs.statSync(path.join(assets, name)).mode & 0o777, 0o640);
    }
  });
});

test("canonical model-list contribution preserves other catalog feature edits", () => {
  const source = currentFilteredCopilotReasoningEffortModelListFixture()
    .replace('"amazonBedrock"!==auth?', '"amazonBedrock"!==auth&&"apikey"!==auth/*codexLinuxApiKeyModelVisibility*/?')
    .replace('normalized={...item,supportedReasoningEfforts:filtered}', 'normalized={...item,supportedReasoningEfforts:filtered,codexLinuxApiKeyModel:"apikey"===auth}');
  const patched = applyModelListBody(source);
  assert.equal(applyModelListBody(patched), patched);
  assert.equal(patched.replace(`/*${MODEL_LIST_MARKER}*/[...raw]`, '("copilot"===auth?[raw.find(effort=>"medium"===effort.reasoningEffort)??{reasoningEffort:"medium",description:"medium effort"}]:raw)'), source);
});

test("unrecoverable model-list rollback remains a fatal integrity error", () => {
  const source = asChunk(currentFilteredCopilotReasoningEffortModelListFixture());
  modelListScene({ "one.js": source, "two.js": source }, (root) => {
    let writes = 0;
    assert.throws(() => applyCopilotReasoningEffortModelListAppPatch(root, {}, {
      writeFileSync(file, bytes) {
        writes += 1;
        if (writes === 1) { fs.writeFileSync(file, bytes); return; }
        fs.writeFileSync(file, "corrupt");
        throw new Error("UP50 injected unrecoverable rollback fault");
      },
    }), error => error.name === "PatchIntegrityError" && /restore original bytes/.test(error.message));
  });
});

test("a second physical model-list write failure restores bytes and modes", () => {
  const source = asChunk(currentFilteredCopilotReasoningEffortModelListFixture());
  modelListScene({ "one.js": source, "nested/two.js": source }, (root, assets, read) => {
    let writes = 0;
    assert.throws(() => applyCopilotReasoningEffortModelListAppPatch(root, {}, {
      writeFileSync(file, bytes) { fs.writeFileSync(file, bytes); if (++writes === 2) throw new Error("UP50 injected second-write fault"); },
    }), /UP50 injected/);
    for (const name of ["one.js", "nested/two.js"]) {
      assert.equal(read(name), source);
      assert.equal(fs.statSync(path.join(assets, name)).mode & 0o777, 0o640);
    }
  });
});

test("feature descriptor loader exposes the Copilot webview asset patches only when enabled", () => {
  const featuresRoot = path.resolve(__dirname, "..");

  withTempFeatureConfig([], () => {
    assert.deepEqual(loadLinuxFeaturePatchDescriptors({ featuresRoot }), []);
  });

  withTempFeatureConfig(["copilot-reasoning-effort"], () => {
    const loaded = loadLinuxFeaturePatchDescriptors({ featuresRoot });
    assert.deepEqual(loaded.map((descriptor) => descriptor.id), [
      "feature:copilot-reasoning-effort:persistence-contract",
      "feature:copilot-reasoning-effort:model-list",
      "feature:copilot-reasoning-effort:ui-dropdown",
      "feature:copilot-reasoning-effort:ui-slash-command",
    ]);
    assert.deepEqual(loaded.map(descriptor => descriptor.phase), ["extracted-app:pre-webview", "extracted-app:pre-webview", "extracted-app:pre-webview", "extracted-app:pre-webview"]);
    assert.ok(loaded.every((descriptor) => descriptor.ciPolicy === "optional"));
  });
});

test("enabled feature descriptors patch rspack async chunks", () => {
  const featuresRoot = path.resolve(__dirname, "..");
  withTempFeatureConfig(["copilot-reasoning-effort"], () => {
    withTempDir((extractedDir) => {
      writeAsset(extractedDir, "24191.a.js", currentFilteredCopilotReasoningEffortModelListFixture());
      const dropdownAssets=path.join(extractedDir,"webview","assets","async");
      for(const [name,record,id]of [["104066.c.js",currentDropdown.composer,"dropdownOwner"],["selector.js",currentDropdown.selector,"sU9s"]]) {
        fs.writeFileSync(path.join(dropdownAssets,name),`export const __webpack_modules__={${id}(${record.params.join(",")}){${record.source}}};`);
      }
      // The selector imports this native hook by module identity.
      const settingsAsset=path.join(dropdownAssets,"258607.b.js");
      fs.writeFileSync(settingsAsset,`export const __webpack_modules__={o8WW(${currentDropdown.settings.params.join(",")}){${currentDropdown.settings.source}}};`);
      fs.writeFileSync(path.join(dropdownAssets,"589850.d.js"),`export const __webpack_modules__={reasoningOwner(${currentSlash.synthetic.params.join(",")}){${currentSlash.synthetic.source}}};`);

      const { warnings } = withCapturedWarns(() => {
        const loaded = normalizePatchDescriptors(loadLinuxFeaturePatchDescriptors({ featuresRoot }));
        applyExtractedAppPatchDescriptors(extractedDir, loaded, { enabledFeatureIds: ["copilot-reasoning-effort"] }, null, "extracted-app:pre-webview");
        applyWebviewAssetPatchDescriptors(extractedDir, loaded, {}, null);
      });
      assert.deepEqual(warnings, []);
      assert.match(readAsset(extractedDir, "24191.a.js"), /codexLinuxCopilotReasoningEffortModelList\*\/\[\.\.\.raw\]\.filter/);
      assert.match(readAsset(extractedDir, "104066.c.js"), /t1=\/\*codexLinuxCopilotEffortDropdown\*\//);
      assert.match(readAsset(extractedDir, "589850.d.js"), /F=M&&_\/\*codexLinuxCopilotReasoningSlash\*\//);
      assert.match(readAsset(extractedDir, "258607.b.js"), /codexLinuxCopilotEffortPreferences/);
    });
  });
});

const signedApp = process.env.CODEX_SIGNED_EXTRACTED_APP;
test("official signed webview owners validate or patch once and still parse", { skip: !signedApp }, () => {
  const assetsDir = path.join(signedApp, "webview", "assets");
  const counts = {};
  for (const descriptor of descriptors) {
    const candidates = findWebviewAssetsContaining(signedApp, descriptor.id === "model-list" ? MODEL_LIST_NEEDLES : descriptor.id==="ui-dropdown" ? DROPDOWN_OWNER_NEEDLES : descriptor.id==="ui-slash-command" ? SLASH_OWNER_NEEDLES : descriptor.id==="persistence-contract" ? ["setDefaultModelAndReasoningEffort:",".setDefaultModelConfig("] : descriptor.assetNeedles);
    const assets=descriptor.id==="model-list"?candidates.filter(asset=>[...rspackModuleFactories(fs.readFileSync(path.join(assetsDir,asset),"utf8"),asset)].some(module=>MODEL_LIST_NEEDLES.every(needle=>module.moduleSource.includes(needle))&&inspectModelCatalogOwner(module).ok)):candidates;
    counts[descriptor.id] = assets.length;
    for (const asset of assets) {
      const source = fs.readFileSync(path.join(assetsDir, asset), "utf8");
      const copy=descriptor.id==="ui-slash-command"?[...rspackModuleFactories(source,asset)].find(m=>slashModuleState(m.moduleSource,m).kind==="current"):descriptor.id==="ui-dropdown"?[...rspackModuleFactories(source,asset)].find(m=>dropdownModuleState(m.moduleSource,m).kind==="current"):descriptor.id==="persistence-contract"?[...rspackModuleFactories(source,asset)].find(m=>settingsPersistenceState(m.moduleSource,m).kind==="current"):null;
      const apply = descriptor.id === "model-list" ? applyCopilotReasoningEffortModelListPatch : copy ? text=>{const end=text.length-(source.length-copy.end);return text.slice(0,copy.start)+(descriptor.id==="ui-slash-command"?applySlashModule(text.slice(copy.start,end),copy):descriptor.id==="ui-dropdown"?applyDropdownModule(text.slice(copy.start,end),copy):applyCopilotSettingsPersistence(text.slice(copy.start,end),copy))+text.slice(end)} : descriptor.apply;
      const { value: patched, warnings } = withCapturedWarns(() => apply(source));
      assert.deepEqual(warnings, [], `${descriptor.id} ${asset}`);
      assert.equal(apply(patched), patched, `${descriptor.id} ${asset}`);
      assert.notEqual(patched, source, `${descriptor.id} ${asset}`);
      const check = spawnSync(process.execPath, ["--input-type=module", "--check"], {
        input: patched,
        maxBuffer: 64 * 1024 * 1024,
      });
      assert.equal(check.status, 0, `${descriptor.id} ${asset}: ${check.stderr}`);
    }
  }
  assert.ok(counts["persistence-contract"] >= 1);
  assert.equal(counts["model-list"], 1);
  assert.equal(counts["ui-dropdown"], 1);
  assert.equal(counts["ui-slash-command"], 1);
});
