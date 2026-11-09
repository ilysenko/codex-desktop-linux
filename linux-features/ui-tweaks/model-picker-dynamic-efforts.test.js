"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { resolver, dependencies, work, current, chunk, copy, world, uiBodies, callWork, callOther, model, config, plain, ids, deepFreeze } = require("./model-picker-dynamic-efforts.test-helpers.js");
const dynamic = require("./patches/model-picker-dynamic-efforts.js");
const picker = require("./patches/model-picker-model-list.js");
const defaultView = require("./patches/model-picker-default-view.js");
const contribution = require("../../scripts/patches/lib/model-power-effort-contribution.js");
const { findRspackExportPublication } = require("../../scripts/patches/lib/rspack-export-publication.js");
const { createJavaScriptLexicalIndex } = require("../../scripts/patches/lib/minified-js.js");
const { extractedAppPatch } = require("../../scripts/patches/descriptor.js");
const { applyExtractedAppPatchDescriptors } = require("../../scripts/patches/engine.js");
const { createPatchReport } = require("../../scripts/lib/patch-report.js");

const native = world();
const active = world(uiBodies().resolver);
const disabled = { feature: { settings: { tweaks: { modelPicker: { showModelsByDefault: { enabled: false } } } } } };
const allEfforts = () => new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "persistent"]);
const inputFiles = {
  "resolver.js": chunk([resolver]),
  "async/work.js": chunk([work]),
};

function withApp(files, callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dynamic-power-efforts-"));
  const directory = path.join(root, "webview/assets");
  fs.mkdirSync(directory, { recursive: true });
  for (const [name, source] of Object.entries(files)) {
    const file = path.join(directory, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, source, { mode: 0o640 });
  }
  const read = name => fs.readFileSync(path.join(directory, name), "utf8");
  const snapshot = () => Object.fromEntries(Object.keys(files).map(name => {
    const file = path.join(directory, name);
    return [name, { source: read(name), mode: fs.statSync(file).mode & 0o777 }];
  }));
  try { return callback({ root, read, snapshot }); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function insertBeforeComponentReturn(source, statement) {
  const publication = findRspackExportPublication(copy(work, source), "M");
  assert.ok(publication?.fn);
  const body = publication.fn.body;
  const lexical = createJavaScriptLexicalIndex(body);
  const exits = [...body.matchAll(/\breturn\b/gu)].filter(match => lexical.isRoot(match.index));
  const at = publication.fn.end - 1 - body.length + exits.at(-1).index;
  const changed = source.slice(0, at) + statement + source.slice(at);
  new vm.Script(`function current(${work.params.join(",")}){${changed}}`);
  return changed;
}

test("current official module hashes verify the reused resolver, consumer and native dependencies", () => {
  for (const [name, record] of [["resolver", resolver], ["consumer", work], ["predicate", dependencies.FQih], ["formatter", dependencies.O5Ra]]) {
    assert.equal(crypto.createHash("sha256").update(record.moduleSource).digest("hex"), current.currentOwners[name].moduleSha256);
  }
  assert.equal(current.callers.length, 6);
  for (const caller of current.callers) {
    assert.equal(caller.nativeResolverImport, "TWUU");
    assert.match(caller.assetSha256, /^[a-f0-9]{64}$/);
    assert.match(caller.moduleSha256, /^[a-f0-9]{64}$/);
  }
});

test("native loading and empty model catalogs remain empty through the opt-in path", () => {
  for (const models of [undefined, null, []]) {
    assert.deepEqual(plain(active.run(models, { enabledReasoningEfforts: allEfforts() })), []);
  }
  for (const efforts of [[], ["persistent"], ["invalid"], ["persistent", "invalid"]]) {
    assert.deepEqual(plain(active.run([model("new-model", efforts)], { enabledReasoningEfforts: new Set(efforts) })), []);
  }
  for (const missing of [undefined, null]) {
    const models = [{ model: "new-model", displayName: "New", supportedReasoningEfforts: missing }];
    assert.throws(() => native.normalize(models));
    assert.throws(() => active.run(models, { enabledReasoningEfforts: allEfforts() }));
  }
});

test("all available models supply current enabled efforts, Max, native ids and native indexes", () => {
  const models = [model("vendor-new", ["low", "medium", "high", "persistent", "invalid"]),
    model("opaque\"} 🦊", ["none", "max", "ultra"], "Vendor 🦊 2.0")];
  const result = active.run(models, { enabledReasoningEfforts: allEfforts() });
  assert.deepEqual(ids(result), ["vendor-new:low", "vendor-new:medium", "vendor-new:high", 'opaque"} 🦊:none', 'opaque"} 🦊:max', 'opaque"} 🦊:ultra']);
  assert.deepEqual(Array.from(result, row => row.powerSettingIndex), [0, 1, 2, 3, 4, 5]);
  assert.equal(result[4].reasoningEffort, "max");
  assert.equal(result[4].modelLabel, "Vendor 🦊 2.0");
});

test("removeXHigh keeps Max and the native three-position minimum", () => {
  const models = [model("new-model", ["low", "medium", "xhigh", "max"])];
  assert.deepEqual(ids(active.run(models, { enabledReasoningEfforts: allEfforts(), removeXHigh: true })), ["new-model:low", "new-model:medium", "new-model:max"]);
  assert.deepEqual(ids(active.run(models, { enabledReasoningEfforts: new Set(["low", "max"]), removeXHigh: true })), []);
  assert.deepEqual(ids(active.run(models, { enabledReasoningEfforts: new Set() })), []);
});

test("native formatting handles prefix settings and nullable names without changing input data", () => {
  for (const name of [undefined, null, "gpt-new-generation", "Vendor 🦊"]) {
    const models = [model("new-model", ["low", "medium", "high"], name)];
    if (name === undefined) models[0].displayName = undefined;
    const before = plain(models);
    deepFreeze(models);
    const stripped = active.run(models, { enabledReasoningEfforts: allEfforts(), stripGptPrefix: true });
    const full = active.run(models, { enabledReasoningEfforts: allEfforts(), stripGptPrefix: false });
    assert.equal(stripped[0].modelLabel, name == null ? "Custom" : name.startsWith("gpt") ? "New-Generation" : name);
    assert.equal(full[0].modelLabel, name == null ? "Custom" : name.startsWith("gpt") ? "GPT-New-Generation" : name);
    assert.deepEqual(models, before);
  }
});

test("capability refresh and the same user Set are read afresh on each resolver call", () => {
  const models = [model("new-model", ["low", "medium", "high"])];
  const enabled = new Set(["low", "medium", "high", "max"]);
  assert.deepEqual(ids(active.run(models, { enabledReasoningEfforts: enabled })), ["new-model:low", "new-model:medium", "new-model:high"]);
  models[0].supportedReasoningEfforts.push({ reasoningEffort: "max" });
  assert.deepEqual(ids(active.run(models, { enabledReasoningEfforts: enabled })), ["new-model:low", "new-model:medium", "new-model:high", "new-model:max"]);
  enabled.delete("medium");
  assert.deepEqual(ids(active.run(models, { enabledReasoningEfforts: enabled })), ["new-model:low", "new-model:high", "new-model:max"]);
  enabled.clear();
  assert.deepEqual(ids(active.run(models, { enabledReasoningEfforts: enabled })), []);
});

test("resolver calls preserve catalog objects, arrays, capabilities, settings and the user Set", () => {
  const models = [model("vendor-new", ["low", "medium", "high", "max"])];
  const enabled = new Set(["low", "medium", "high", "max"]);
  const settings = config([["vendor-new", "high"]]);
  const beforeModels = plain(models), beforeSettings = plain(settings), beforeEnabled = [...enabled];
  const capabilities = models[0].supportedReasoningEfforts;
  deepFreeze(models);
  deepFreeze(settings);
  active.run(models, { enabledReasoningEfforts: enabled, sliderModelsConfig: settings });
  assert.deepEqual(models, beforeModels);
  assert.equal(models[0].supportedReasoningEfforts, capabilities);
  assert.deepEqual(settings, beforeSettings);
  assert.deepEqual([...enabled], beforeEnabled);
});

test("unmarked native curation yields to opt-in capabilities while marked presets retain order", () => {
  const models = [model("new-model")];
  const pairs = [["new-model", "high"], ["new-model", "medium"], ["new-model", "low"]];
  const enabled = allEfforts();
  assert.deepEqual(ids(native.run(models, { sliderModelsConfig: config(pairs) })), ["new-model:high", "new-model:medium", "new-model:low"]);
  assert.deepEqual(ids(active.run(models, { sliderModelsConfig: config(pairs), enabledReasoningEfforts: enabled })), ["new-model:low", "new-model:medium", "new-model:high"]);
  assert.deepEqual(ids(active.run(models, { sliderModelsConfig: config(pairs, true), enabledReasoningEfforts: enabled })), ["new-model:high", "new-model:medium", "new-model:low"]);
});

test("mounted Work call forwards its actual subscribed Set and current catalog", () => {
  const models = [model("new-model", ["low", "medium", "high", "max"])];
  const enabled = new Set(["low", "medium", "high"]);
  const result = callWork(uiBodies().consumer, active.run, models, enabled);
  assert.equal(result.call.input, models);
  assert.equal(result.call.options.enabledReasoningEfforts, enabled);
  assert.deepEqual(ids(result.result), ["new-model:low", "new-model:medium", "new-model:high"]);
  enabled.delete("low");
  enabled.add("max");
  assert.deepEqual(ids(callWork(uiBodies().consumer, active.run, models, enabled).result), ["new-model:medium", "new-model:high", "new-model:max"]);
  assert.deepEqual(ids(callWork(uiBodies().consumer, active.run, models, new Set()).result), []);
});

test("all six other native call expressions retain original resolver behavior without opting in", () => {
  const models = [model("gpt-5.6-sol", ["low", "medium", "high", "xhigh"]), model("gpt-5.6-terra", ["low", "medium", "high"])];
  const settings = config([["gpt-5.6-sol", "high"], ["gpt-5.6-sol", "medium"], ["gpt-5.6-terra", "low"]]);
  for (const record of current.callers) for (const input of [undefined, null, models]) {
    const before = callOther(record, native.run, input, settings);
    const after = callOther(record, active.run, input, settings);
    assert.deepEqual(plain(after.result), plain(before.result));
    assert.equal(Object.hasOwn(after.call.options, "enabledReasoningEfforts"), false);
    assert.deepEqual(Object.keys(after.call.options), ["sliderModelsConfig"]);
  }
});

test("UI resolver and Work contributions invert and repeat exactly while preserving the default-view sibling", () => {
  const carrier = chunk([resolver, work]);
  const first = dynamic.prepareDynamicEffortSource(carrier);
  assert.notEqual(first, carrier);
  assert.equal(dynamic.prepareDynamicEffortSource(first), first);
  for (const [record, inspect, source] of [[resolver, dynamic.inspectDynamicResolver, uiBodies().resolver], [work, dynamic.inspectEffortConsumer, uiBodies().consumer]]) {
    const result = inspect(copy(record, source));
    assert.equal(result.state, "patched");
    assert.equal(result.nativeSource, record.moduleSource);
    assert.equal(result.patchedSource, source);
  }
  const beforeDefault = defaultView.inspectDefaultView(copy(work), "work").patchedSource;
  const afterDynamic = dynamic.inspectEffortConsumer(copy(work, beforeDefault)).patchedSource;
  assert.equal(defaultView.inspectDefaultView(copy(work, contribution.projectPowerEffortOption(afterDynamic).nativeSource), "work").state, "patched");
});

test("consumer qualification rejects dead resolver output, disconnected menu inputs and replaced native Sets", () => {
  const mutations = [
    work.moduleSource.replace("powerSelections:oO", "powerSelections:[]"),
    insertBeforeComponentReturn(work.moduleSource.replace("powerSelections:oO", "powerSelections:[]"),
      "let unreturnedPicker=(0,o.jsx)(D.i,{powerSelections:oO,});"),
    work.moduleSource.replace("powerSelections:oO", "powerSelections:[],unused:{powerSelections:oO}"),
    work.moduleSource.replace("powerSelections:oO", 'powerSelections:oO,"powerSelections":[]'),
    work.moduleSource.replace("powerSelections:oO", "powerSelections:oO,...unprovenProps"),
    work.moduleSource.replace("powerSelections:oO", "powerSelections:oO,/* sibling */...{powerSelections:[]}"),
    work.moduleSource.replace("powerSelections:oO", 'powerSelections:oO,/* sibling */["powerSelections"]:[]'),
    work.moduleSource.replace("powerSelectionsWithXHigh:oR", "powerSelectionsWithXHigh:[]"),
    work.moduleSource.replace("powerSelectionsWithXHigh:oR", "powerSelectionsWithXHigh:[],unused:{powerSelectionsWithXHigh:oR}"),
    insertBeforeComponentReturn(work.moduleSource, "oT=[];"),
    insertBeforeComponentReturn(work.moduleSource, "oO=[];"),
    insertBeforeComponentReturn(work.moduleSource, "nF=new Set();"),
  ];
  for (const source of mutations) {
    assert.notEqual(source, work.moduleSource);
    new vm.Script(`function current(${work.params.join(",")}){${source}}`);
    assert.throws(() => dynamic.inspectEffortConsumer(copy(work, source)));
  }
});

test("normal dynamic descriptor patches all physical peers, repeats and skips disabled discovery", () => {
  const descriptor = extractedAppPatch(picker.descriptors.find(item => item.id === "model-picker-dynamic-supported-reasoning-efforts"));
  withApp({ ...inputFiles, "peer/resolver.js": chunk([resolver]), "peer/work.js": chunk([work]) }, ({ root, read, snapshot }) => {
    let first;
    for (const expected of ["applied", "already-applied"]) {
      const report = createPatchReport();
      applyExtractedAppPatchDescriptors(root, [descriptor], {}, report, descriptor.phase);
      assert.equal(report.patches[0].status, expected);
      if (!first) first = snapshot();
      else assert.deepEqual(snapshot(), first);
    }
    assert.equal(read("resolver.js"), read("peer/resolver.js"));
    assert.equal(read("async/work.js"), read("peer/work.js"));
    for (const value of Object.values(snapshot())) assert.equal(value.mode, 0o640);
  });
  assert.equal(picker.applyDynamicSupportedReasoningEffortsPatch("unrelated source", disabled), "unrelated source");
  assert.deepEqual(picker.applyDynamicSupportedReasoningEffortsToApp("/missing-disabled-efforts", disabled), { matched: 0, changed: 0 });
  const report = createPatchReport();
  applyExtractedAppPatchDescriptors("/missing-disabled-efforts", [descriptor], disabled, report, descriptor.phase);
  assert.equal(report.patches[0].status, "skipped-disabled");
});

test("dynamic cohort rejects incomplete, damaged and mixed states and rolls back a later write failure", () => {
  const cases = [
    { "resolver.js": chunk([resolver]) },
    { ...inputFiles, "resolver.js": chunk([{ ...resolver, moduleSource: uiBodies().resolver }]) },
    { ...inputFiles, "bad-peer.js": chunk([{ ...resolver, moduleSource: resolver.moduleSource.replace('"persistent"!==e', '"invalid"!==e') }]) },
    { ...inputFiles, "bad-work.js": chunk([{ ...work, moduleSource: work.moduleSource.replace("powerSelections:oO", "powerSelections:[]") }]) },
  ];
  for (const files of cases) withApp(files, ({ root, snapshot }) => {
    const before = snapshot();
    assert.throws(() => dynamic.applyDynamicEfforts(root));
    assert.deepEqual(snapshot(), before);
  });
  withApp(inputFiles, ({ root, snapshot }) => {
    const before = snapshot();
    let writes = 0;
    assert.throws(() => dynamic.applyDynamicEfforts(root, { writeFileSync(file, bytes) {
      if (++writes === 2) { fs.writeFileSync(file, "truncated"); throw new Error("dynamic second write failed"); }
      fs.writeFileSync(file, bytes);
    } }), /dynamic second write failed/);
    assert.deepEqual(snapshot(), before);
  });
});

test("UI-only, Presets-only and both application orders retain canonical resolver and Work contributions", { timeout: 360000 }, () => {
  const local = require("../model-picker-default-presets/local-resolver.js");
  const composer = require("../model-picker-default-presets/composer-config.js");
  const presetsMain = require("../model-picker-default-presets/patch.js");
  const choices = [{ modelSlug: "new-model", thinkingEffort: "extended", isDefault: true },
    { modelSlug: "new-model", thinkingEffort: "standard", isDefault: false }];
  const map = presetsMain.THINKING_EFFORT_TO_EFFORT;
  const presetsResolver = local.applyLocalResolver(resolver.moduleSource, resolver);
  const presetsConsumer = composer.prepareComposerFactory(work.moduleSource, copy(work), choices, map).patchedSource;
  const uiThenPresetsResolver = local.applyLocalResolver(uiBodies().resolver, { ...resolver, moduleSource: uiBodies().resolver });
  const presetsThenUiResolver = dynamic.inspectDynamicResolver(copy(resolver, presetsResolver)).patchedSource;
  assert.equal(uiThenPresetsResolver, presetsThenUiResolver);
  const uiThenPresetsConsumer = composer.prepareComposerFactory(uiBodies().consumer, copy(work, uiBodies().consumer), choices, map).patchedSource;
  const presetsThenUiConsumer = dynamic.inspectEffortConsumer(copy(work, presetsConsumer)).patchedSource;
  assert.equal(uiThenPresetsConsumer, presetsThenUiConsumer);
  assert.equal(local.applyLocalResolver(uiThenPresetsResolver, { ...resolver, moduleSource: uiThenPresetsResolver }), uiThenPresetsResolver);
  assert.equal(dynamic.inspectDynamicResolver(copy(resolver, uiThenPresetsResolver)).patchedSource, uiThenPresetsResolver);
  const repeated = composer.prepareComposerFactory(uiThenPresetsConsumer, copy(work, uiThenPresetsConsumer), choices, map);
  assert.equal(repeated.state, "applied");
  assert.equal(repeated.patchedSource, uiThenPresetsConsumer);
  assert.equal(dynamic.inspectEffortConsumer(copy(work, uiThenPresetsConsumer)).patchedSource, uiThenPresetsConsumer);
  assert.equal(dynamic.inspectEffortConsumer(copy(work, uiThenPresetsConsumer)).nativeSource, presetsConsumer);
  assert.equal(repeated.nativeSource, uiBodies().consumer);
  const enabled = new Set(["low", "medium", "high"]), models = [model("new-model")];
  const configured = config([["new-model", "high"], ["new-model", "medium"]], true);
  const presetsOnly = world(presetsResolver), both = world(uiThenPresetsResolver);
  assert.deepEqual(ids(presetsOnly.run(models, { sliderModelsConfig: configured })), ["new-model:high", "new-model:medium"]);
  assert.deepEqual(ids(both.run(models, { sliderModelsConfig: configured, enabledReasoningEfforts: enabled })), ["new-model:high", "new-model:medium"]);
  const one = config([["new-model", "high"]], true);
  assert.deepEqual(ids(both.run(models, { sliderModelsConfig: one, enabledReasoningEfforts: enabled })), ["new-model:high"]);
});
