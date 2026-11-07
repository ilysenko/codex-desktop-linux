#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Script } = require("node:vm");
const test = require("node:test");
const { applyExtractedAppPatchDescriptors, normalizePatchDescriptors } = require("../../scripts/patches/engine.js");
const { loadLinuxFeaturePatchDescriptors } = require("../../scripts/lib/linux-features.js");
const { createPatchReport, captureWarnings, enabledFeatureFailuresFromReport } = require("../../scripts/lib/patch-report.js");
const { inspectModelCatalogOwner } = require("../../scripts/patches/lib/model-composer-owners.js");
const { rspackModuleFactories } = require("../../scripts/patches/lib/rspack-module-assets.js");
const current = require("../../scripts/patches/lib/fixtures/current-model-composer.json");
const {
  applyApiKeyModelVisibilityPatch: apply,
  applyApiKeyModelVisibilityAppPatch: applyApp,
  descriptors,
} = require("./patch.js");

const MARKER = "codexLinuxApiKeyModelVisibility";
const chunk = (body, id = "RenamedCatalog", params = ["module", "exports", "loader"]) =>
  `export const __rspack_esm_ids=[101];export const __webpack_modules__={${id}(${params.join(",")}){${body}}};`;

// Reduced, deliberately renamed contract fixture. Behavior tests execute only
// this synthetic normalizer, never the retained signed-package factory.
function modelCatalogFixture() {
  const predicate = 'function({additionalAvailableModels:extra,apiKeyDaybreakSupported:daybreak,authMethod:auth,availableModels:allow,hasConfiguredModelCatalog:configured,isCustomModelProvider:custom,model:item,useHiddenModels:hidden}){let programs=item.availableAccessPrograms?.cyber;return("apikey"!==auth||!!daybreak||null==programs||!(programs.length>0)||!!programs.includes("standard"))&&(extra?.has(item.model)===!0||"codex-auto-review"!==item.model&&(configured&&!item.hidden||(hidden&&!custom&&"amazonBedrock"!==auth?allow.has(item.model)||"apikey"===auth&&daybreak&&!item.hidden&&programs?.some(program=>"standard"!==program)===!0:!item.hidden)))}';
  return 'var guard=loader("effort-guard");loader.d(exports,{},{catalog:function({additionalAvailableModels:extra,apiKeyDaybreakSupported:daybreak=!1,authMethod:auth,availableModels:allow,defaultModel:fallback,enabledReasoningEfforts:enabled,hasConfiguredModelCatalog:configured,includeUltraReasoningEffort:ultra,isCustomModelProvider:custom=!1,models:models,useHiddenModels:hidden}){let output=[],defaultModel=null,maximum=!1,ultraFlag=!1;return models.forEach(item=>{if(' + predicate + '({additionalAvailableModels:extra,apiKeyDaybreakSupported:daybreak,authMethod:auth,availableModels:allow,hasConfiguredModelCatalog:configured,isCustomModelProvider:custom,model:item,useHiddenModels:hidden})){let raw=ultra?item.supportedReasoningEfforts:item.supportedReasoningEfforts.filter(({reasoningEffort:effort})=>"ultra"!==effort),filtered=("copilot"===auth?[raw.find(e=>"medium"===e.reasoningEffort)??{reasoningEffort:"medium",description:"medium effort"}]:raw).filter(({reasoningEffort:effort})=>(0,guard.allowed)(effort)&&enabled.has(effort)),normalized={...item,supportedReasoningEfforts:filtered};output.push(normalized),item.isDefault&&(defaultModel=normalized)}}),null==defaultModel&&(defaultModel=output.find(item=>item.model===fallback)??null),{models:output,defaultModel:defaultModel,hasModelSupportingMaxReasoningEffort:maximum,hasModelSupportingUltraReasoningEffort:ultraFlag}}})';
}

function factory(body = modelCatalogFixture()) {
  return [...rspackModuleFactories(chunk(body), "fixture.js")][0];
}
function applyBody(body) {
  return apply(body, { factorySnapshot: factory(body) });
}
function normalizer(body) {
  const module = factory(body), owner = inspectModelCatalogOwner(module);
  assert.equal(owner.ok, true, owner.reason);
  const source = body.slice(owner.owner.start, owner.owner.end);
  return Function("guard", `return (${source});`)({ allowed: () => true });
}
function model(name, options = {}) {
  return { model: name, hidden: false, isDefault: false, supportedReasoningEfforts: [
    { reasoningEffort: "medium", description: "medium effort" },
    { reasoningEffort: "high", description: "high effort" },
    { reasoningEffort: "ultra", description: "ultra effort" },
  ], ...options };
}
function evaluate(body, authMethod = "apikey", options = {}) {
  return normalizer(body)({
    authMethod, availableModels: new Set(["allowed", "hidden-allowed"]),
    defaultModel: "allowed", enabledReasoningEfforts: new Set(["medium", "high", "ultra"]),
    includeUltraReasoningEffort: true, isCustomModelProvider: false, useHiddenModels: true,
    models: [model("new", { isDefault: true }), model("allowed"), model("hidden-allowed", { hidden: true }),
      model("hidden", { hidden: true }), model("codex-auto-review")], ...options,
  });
}
const names = result => result.models.map(item => item.model);

function workspace(t, files = {}) {
  const cache = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "codex-desktop-dev");
  fs.mkdirSync(cache, { recursive: true });
  const root = fs.mkdtempSync(path.join(cache, "up44-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const assets = path.join(root, "webview", "assets");
  fs.mkdirSync(assets, { recursive: true });
  for (const [name, source] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(assets, name)), { recursive: true });
    fs.writeFileSync(path.join(assets, name), source);
  }
  return { root, assets, read: name => fs.readFileSync(path.join(assets, name), "utf8") };
}
function loadedFeature(t, enabled = true) {
  const { root } = workspace(t);
  const config = path.join(root, "features.json");
  fs.writeFileSync(config, JSON.stringify({ enabled: enabled ? ["api-key-model-visibility"] : [] }));
  return normalizePatchDescriptors(loadLinuxFeaturePatchDescriptors({
    featuresRoot: path.resolve(__dirname, ".."), featuresConfigPath: config,
  }));
}
function report(root, loaded) {
  const result = createPatchReport();
  result.enabledFeatures = ["api-key-model-visibility"];
  captureWarnings(() => applyExtractedAppPatchDescriptors(root, loaded, {}, result, descriptors[0].phase));
  return result;
}

test("feature is opt-in and qualifies a complete extracted-app cohort", t => {
  assert.deepEqual(loadedFeature(t, false), []);
  assert.deepEqual(loadedFeature(t).map(item => [item.id, item.phase, item.ciPolicy]), [
    ["feature:api-key-model-visibility:api-key-model-visibility-ui", "extracted-app:pre-webview", "optional"],
  ]);
  assert.equal(descriptors[0].assetPattern, undefined);
  assert.equal(descriptors[0].pattern, undefined);
});

test("API-key bypass preserves normal catalog normalization and default selection", () => {
  const source = modelCatalogFixture(), patched = applyBody(source);
  assert.notEqual(patched, source);
  assert.equal(applyBody(patched), patched);
  assert.deepEqual(names(evaluate(patched)), ["new", "allowed"]);
  assert.deepEqual(names(evaluate(source)), ["allowed", "hidden-allowed"]);
  const result = evaluate(patched);
  assert.equal(result.defaultModel, result.models[0]);
  assert.deepEqual(result.models[0].supportedReasoningEfforts.map(item => item.reasoningEffort), ["medium", "high", "ultra"]);
  assert.match(patched, /"amazonBedrock"!==auth&&"apikey"!==auth\/\*codexLinuxApiKeyModelVisibility\*\//);
  assert.doesNotThrow(() => new Script(patched));
});

test("account changes, ChatGPT, Copilot, Bedrock and custom-provider policies remain native", () => {
  const source = modelCatalogFixture(), patched = applyBody(source);
  for (const auth of ["chatgpt", "copilot", "amazonBedrock", "unknown", null]) {
    for (const options of [{}, { useHiddenModels: false }, { isCustomModelProvider: true }, { hasConfiguredModelCatalog: true }]) {
      assert.deepEqual(evaluate(patched, auth, options), evaluate(source, auth, options), `${auth}: ${JSON.stringify(options)}`);
    }
  }
  assert.deepEqual(names(evaluate(patched, "chatgpt")), ["allowed", "hidden-allowed"]);
  assert.deepEqual(names(evaluate(patched, "amazonBedrock")), ["new", "allowed"]);
  assert.deepEqual(names(evaluate(patched, "apikey", { isCustomModelProvider: true })), ["new", "allowed"]);
  // Reusing the same normalizer after an identity switch does not retain API-key visibility.
  const normalize = normalizer(patched);
  const inputs = { models: [model("new")], availableModels: new Set(), enabledReasoningEfforts: new Set(["medium"]), useHiddenModels: true };
  assert.deepEqual(names(normalize({ ...inputs, authMethod: "apikey" })), ["new"]);
  assert.deepEqual(names(normalize({ ...inputs, authMethod: "chatgpt" })), []);
  assert.deepEqual(names(normalize({ ...inputs, authMethod: "apikey" })), ["new"]);
});

test("access-program checks precede the bypass and upstream explicit exceptions stay intact", () => {
  const source = modelCatalogFixture(), patched = applyBody(source);
  const models = [model("standard", { availableAccessPrograms: { cyber: ["standard"] } }),
    model("cyber", { availableAccessPrograms: { cyber: ["restricted"] } }),
    model("empty", { availableAccessPrograms: { cyber: [] } }), model("hidden", { hidden: true }),
    model("codex-auto-review"), model("hidden-extra", { hidden: true }),
    model("cyber-extra", { availableAccessPrograms: { cyber: ["restricted"] } })];
  const options = { models, additionalAvailableModels: new Set(["hidden-extra", "codex-auto-review", "cyber-extra"]) };
  assert.deepEqual(names(evaluate(patched, "apikey", options)), ["standard", "empty", "codex-auto-review", "hidden-extra"]);
  assert.deepEqual(names(evaluate(patched, "apikey", { ...options, apiKeyDaybreakSupported: true })),
    ["standard", "cyber", "empty", "codex-auto-review", "hidden-extra", "cyber-extra"]);
  for (const auth of ["chatgpt", "copilot", "amazonBedrock"]) {
    assert.deepEqual(evaluate(patched, auth, options), evaluate(source, auth, options));
  }
  // A configured catalog still honors hidden flags before falling through to the API-key path.
  assert.deepEqual(names(evaluate(patched, "apikey", { hasConfiguredModelCatalog: true })), ["new", "allowed"]);
});

test("retained current signed factory qualifies source-only and keeps all other bytes", () => {
  const source = current.catalog.moduleSource;
  const context = { factorySnapshot: current.catalog };
  const patched = apply(source, context);
  const insertion = '&&"apikey"!==n/*' + MARKER + '*/';
  assert.notEqual(patched, source);
  assert.equal(patched.replace(insertion, ""), source);
  assert.equal(apply(patched, { factorySnapshot: { ...current.catalog, moduleSource: patched } }), patched);
  assert.equal(apply(chunk(source, "ChangedIdentity", current.catalog.params)), chunk(patched, "ChangedIdentity", current.catalog.params));
  assert.doesNotThrow(() => new Script(patched));
  // No settings, profile, host or query-cache code is replaced by this contribution.
  const sibling = 'Other(module,exports,loader){const profile="preserved",hostId="active",cacheKey=[hostId,"auth",profile];}';
  const registry = chunk(source, "ChangedIdentity", current.catalog.params).replace("}};", `},${sibling}};`);
  assert.ok(apply(registry).endsWith(sibling + "};"));
});

test("native auth, visibility, loop and publication drift fails closed", () => {
  const source = modelCatalogFixture();
  const changes = [
    ['authMethod:auth,availableModels:allow,hasConfiguredModelCatalog:configured', 'authMethod:other,availableModels:allow,hasConfiguredModelCatalog:configured'],
    ['"amazonBedrock"!==auth?', '"amazonBedrock"!==auth&&featureGate?'],
    ['?allow.has(item.model)', '?featureGate&&allow.has(item.model)'],
    [':!item.hidden)))}', ':featureGate&&!item.hidden)))}'],
    ['configured&&!item.hidden||', ''],
    ['useHiddenModels:hidden}){let programs', 'useHiddenModels:hidden,extraInput:x}){let programs'],
    ['return models.forEach(', 'models.forEach('],
    ['loader.d(exports,', 'loader.d(otherExports,'],
    ['normalized={...item,supportedReasoningEfforts:filtered}', 'normalized={...wrongModel,supportedReasoningEfforts:filtered}'],
    ['"apikey"!==auth||!!daybreak', '"apikey"!==wrongAuth||!!daybreak'],
    ['programs?.some(program=>"standard"!==program)', 'programs?.some(program=>"standard"!==wrongProgram)'],
  ];
  for (const [from, to] of changes) {
    assert.ok(source.includes(from), from);
    assert.throws(() => applyBody(source.replace(from, to)), /Unsupported/);
  }
  assert.throws(() => apply(source), /Missing or ambiguous/);
  assert.throws(() => apply(source, { factorySnapshot: { ...factory(), moduleSource: "stale" } }), /Stale/);
  assert.throws(() => apply(""), /Missing or ambiguous/);
  assert.throws(() => apply(chunk(source).replace("}};", '},Second(module,exports,loader){' + source + '}};')), /ambiguous/);
});

test("the actual if decision and outer captured roles must reach model normalization", () => {
  const source = modelCatalogFixture();
  for (const body of [
    source.replace('if(function({additionalAvailableModels:', 'if(!0||function({additionalAvailableModels:'),
    source.replace('if(function({additionalAvailableModels:', 'if(!1&&function({additionalAvailableModels:'),
    source.replace('model:item,useHiddenModels:hidden})){let ', 'model:item,useHiddenModels:hidden})||!0){let '),
    source.replace('models.forEach(item=>{if(', 'models.forEach(auth=>{if(')
      .replace('model:item,useHiddenModels:hidden})){', 'model:auth,useHiddenModels:hidden})){')
      .replaceAll('ultra?item.supportedReasoningEfforts:item.supportedReasoningEfforts', 'ultra?auth.supportedReasoningEfforts:auth.supportedReasoningEfforts')
      .replace('normalized={...item,', 'normalized={...auth,').replace('item.isDefault', 'auth.isDefault'),
  ]) assert.throws(() => applyBody(body), /Unsupported/);
  const actual = chunk(source);
  for (const opaque of ["const example=`" + actual + "`;", '/*' + actual + '*/', JSON.stringify(actual)]) {
    assert.throws(() => apply(opaque), /Opaque|Missing/);
  }
});

test("opaque, orphan, partial and wrong-binding contributions cannot count as applied", () => {
  const source = modelCatalogFixture(), patched = applyBody(source);
  const insertion = '&&"apikey"!==auth/*' + MARKER + '*/';
  for (const invalid of [source + `/*${MARKER}*/`, `const example="${MARKER}";` + source,
    patched + `/*${MARKER}*/`, patched.replace(insertion, '&&"apikey"!==other/*' + MARKER + '*/'),
    patched.replace(insertion, '&&"apikey"!==auth'), patched.replace(insertion, `/*${MARKER}*/`),
    source.replace('"amazonBedrock"!==auth?', '"amazonBedrock"!==auth&&"apikey"!==auth?'),
    source.replace('return("apikey"', `/*${MARKER}*/return("apikey"`)]) {
    assert.throws(() => applyBody(invalid), /Unsupported/);
  }
  for (const opaque of [`/*${MARKER}*/`, `const marker="${MARKER}";`, `const example=${JSON.stringify(source)};`]) {
    assert.throws(() => apply(chunk(opaque)), /Unsupported|Missing|ambiguous/);
  }
  assert.throws(() => apply(`/*${MARKER}*/` + chunk(source)), /Orphan/);
  assert.throws(() => apply(chunk(source).replace("}};", `},Other(module,exports,loader){const marker="${MARKER}";}};`)), /Orphan/);
});

test("exact feature reconstruction preserves other legitimate catalog contributions", () => {
  let source = modelCatalogFixture().replace('normalized={...item,supportedReasoningEfforts:filtered}',
    'normalized={...item,supportedReasoningEfforts:filtered,codexLinuxApiKeyModel:"apikey"===auth}');
  source = source.replace('filtered=("copilot"===auth?[raw.find(e=>"medium"===e.reasoningEffort)??{reasoningEffort:"medium",description:"medium effort"}]:raw).filter(',
    'filtered=/*codexLinuxCopilotReasoningEffort*/[...raw].filter(');
  const patched = applyBody(source);
  assert.equal(applyBody(patched), patched);
  assert.equal(patched.replace('&&"apikey"!==auth/*' + MARKER + '*/', ''), source);
  assert.deepEqual(names(evaluate(patched)), ["new", "allowed"]);
});

test("enabled production descriptor patches all renamed physical copies and reports idempotence", t => {
  const source = chunk(modelCatalogFixture()).replace("}};", '},Unrelated(module,exports,loader){const keep="untouched";}};');
  const ws = workspace(t, { "async/one.js": source, "nested/two.js": source, "ordinary.js": "export const keep=1;" });
  const loaded = loadedFeature(t);
  const first = report(ws.root, loaded);
  assert.equal(first.patches[0].status, "applied");
  assert.deepEqual(enabledFeatureFailuresFromReport(first), []);
  for (const name of ["async/one.js", "nested/two.js"]) assert.equal(ws.read(name), apply(source));
  assert.equal(ws.read("ordinary.js"), "export const keep=1;");
  assert.equal(report(ws.root, loaded).patches[0].status, "already-applied");
});

test("query consumers with the same discovery needles are not catalog owner identities", t => {
  // Reduced current relationship: a query consumer forwards catalog arguments
  // to the imported normalizer, but does not own its publication or model loop.
  const consumer = 'var normalizer=loader("RenamedCatalog");function readCatalog(models,authMethod){return(0,normalizer.catalog)({additionalAvailableModels:new Set(),enabledReasoningEfforts:new Set(),hasConfiguredModelCatalog:!1,useHiddenModels:!0,models:models,authMethod:authMethod})}loader.d(exports,{read:()=>readCatalog});';
  const { ASSET_NEEDLES } = require("./patch.js");
  assert.ok(ASSET_NEEDLES.every(needle => consumer.includes(needle)));
  assert.equal(inspectModelCatalogOwner(factory(consumer)).ok, false);
  const owner = chunk(modelCatalogFixture());
  const consumerChunk = chunk(consumer, "CatalogQueryConsumer");
  const combined = owner.replace("}};", `},CatalogQueryConsumer(module,exports,loader){${consumer}}};`);
  assert.equal(apply(combined), combined.replace(modelCatalogFixture(), applyBody(modelCatalogFixture())));
  const ws = workspace(t, { "one.js": combined, "nested/two.js": owner, "query.js": consumerChunk });
  const result = report(ws.root, loadedFeature(t));
  assert.equal(result.patches[0].status, "applied");
  assert.deepEqual(enabledFeatureFailuresFromReport(result), []);
  assert.equal(ws.read("one.js"), apply(combined));
  assert.equal(ws.read("nested/two.js"), apply(owner));
  assert.equal(ws.read("query.js"), consumerChunk);
  assert.equal(report(ws.root, loadedFeature(t)).patches[0].status, "already-applied");
});

test("missing, ambiguous, mixed, damaged and opaque cohorts reject every write", t => {
  const pristine = chunk(modelCatalogFixture()), patched = apply(pristine);
  const scenarios = [
    {},
    { "one.js": pristine, "two.js": chunk(modelCatalogFixture(), "OtherCatalog") },
    { "one.js": pristine, "two.js": patched },
    { "one.js": pristine, "deep/two.js": chunk('const lostAllSemanticNeedles=true;') },
    { "one.js": pristine, "two.js": pristine.replace('"amazonBedrock"!==auth?', '"amazonBedrock"!==other?') },
    { "one.js": pristine, "two.js": '/*' + MARKER + '*/export const ordinary=1;' },
    { "one.js": pristine, "two.js": chunk('const opaque="' + MARKER + '";', "Other") },
    { "one.js": pristine + '/*' + MARKER + '*/' },
  ];
  const loaded = loadedFeature(t);
  for (const files of scenarios) {
    const ws = workspace(t, files);
    assert.throws(() => applyApp(ws.root), /find|identities|Partially|Unsupported|Orphan/);
    const failed = report(ws.root, loaded);
    assert.equal(enabledFeatureFailuresFromReport(failed).length, 1);
    assert.notEqual(failed.patches[0].status, "already-applied");
    for (const [name, source] of Object.entries(files)) assert.equal(ws.read(name), source);
  }
});

test("interrupted second physical write restores exact bytes and file modes", t => {
  const source = chunk(modelCatalogFixture());
  const ws = workspace(t, { "one.js": source, "nested/two.js": source });
  for (const name of ["one.js", "nested/two.js"]) fs.chmodSync(path.join(ws.assets, name), 0o640);
  let writes = 0;
  assert.throws(() => applyApp(ws.root, {}, {
    writeFileSync(file, bytes) {
      fs.writeFileSync(file, bytes);
      if (++writes === 2) throw new Error("UP44 injected second-write fault");
    },
  }), /UP44 injected/);
  for (const name of ["one.js", "nested/two.js"]) {
    assert.equal(ws.read(name), source);
    assert.equal(fs.statSync(path.join(ws.assets, name)).mode & 0o777, 0o640);
  }
});
