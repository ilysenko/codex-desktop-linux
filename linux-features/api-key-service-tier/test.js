#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  createPatchReport,
} = require("../../scripts/lib/patch-report.js");
const {
  patchExtractedApp,
} = require("../../scripts/patches/runner.js");
const {
  findWebviewAssetsContaining,
} = require("../../scripts/patches/lib/assets.js");
const {
  loadLinuxFeaturePatchDescriptors,
} = require("../../scripts/lib/linux-features.js");
const { applyExtractedAppPatchDescriptors, normalizePatchDescriptors } = require("../../scripts/patches/engine.js");
const { enabledFeatureFailuresFromReport } = require("../../scripts/lib/patch-report.js");
const {
  applyApiKeyModelMarkerPatch,
  applyApiKeyServiceTierGatePatch,
  patchApiKeyServiceTierGate,
  patchApiKeyModelMarker,
  serviceTierGateState,
  applyApiKeyServiceTierResolverPatch,
  applyApiKeyServiceTierResolverModule,
  resolverModuleState,
  applyFallbackFastTierPatch,
  applyFallbackFastTierModule,
  fallbackModuleState,
  descriptors,
} = require("./patch.js");

const { findRspackExportPublication } = require("../../scripts/patches/lib/rspack-export-publication.js");
const { inspectModelCatalogOwner } = require("../../scripts/patches/lib/model-composer-owners.js");
const current = require("../../scripts/patches/lib/fixtures/current-model-composer.json");
const { applyApiKeyModelVisibilityPatch } = require("../api-key-model-visibility/patch.js");
const { rspackModuleFactories, findUniqueRspackModuleCopies } = require("../../scripts/patches/lib/rspack-module-assets.js");

function gateSnapshot(source) { return { moduleSource: source, start: 0, params: ["e", "t", "n"] }; }
function patchGateFixture(source) { return applyApiKeyServiceTierGatePatch(source, gateSnapshot(source)); }

const DESCRIPTOR_IDS = [
  "api-key-service-tier-gate",
  "api-key-service-tier-model",
  "api-key-service-tier-resolver",
  "api-key-service-tier-fallback",
];

function applyPatchTwice(patchFn, source) {
  const once = patchFn(source);
  assert.notEqual(once, source);
  assert.equal(patchFn(once), once);
  return once;
}

// Fixtures below are the current official rspack/SWC shapes.
function currentGateFixture() {
  return 'var i=n("memo"),o=n("query"),a=n("resolver"),r=n("defaultHost"),s=n("host"),l=n("requirements");n.d(t,{},{U:function(e){let t,n,c,d=(0,i.c)(10),u=(0,o.Ul)(r.Dc),p=e?.hostId??u,m=(0,s.tn)(p),g=m?.authMethod==="chatgpt"||m?.authMethod==="personalAccessToken"||m?.authMethod==="amazonBedrock",h=m?.authMethod??null;d[0]!==p||d[1]!==h?(t={authMethod:h,hostId:p},d[0]=p,d[1]=h,d[2]=t):t=d[2];let{data:f,isPending:b}=(0,o._U)(l.b9,t),x=!!m?.isLoading||g&&b;d[3]!==f||d[4]!==x||d[5]!==g?(n=g&&!x&&null!=f?(0,a.W6)(f):null,d[3]=f,d[4]=x,d[5]=g,d[6]=n):n=d[6];let v=n;return d[7]!==x||d[8]!==v?(c={serviceTierAccess:v,isLoading:x},d[7]=x,d[8]=v,d[9]=c):c=d[9],c}})';
}

function currentModelFixture() {
  const predicate = 'function({additionalAvailableModels:extra,apiKeyDaybreakSupported:daybreak,authMethod:auth,availableModels:allow,hasConfiguredModelCatalog:configured,isCustomModelProvider:custom,model:item,useHiddenModels:hidden}){let programs=item.availableAccessPrograms?.cyber;return("apikey"!==auth||!!daybreak||null==programs||!(programs.length>0)||!!programs.includes("standard"))&&(extra?.has(item.model)===!0||"codex-auto-review"!==item.model&&(configured&&!item.hidden||(hidden&&!custom&&"amazonBedrock"!==auth?allow.has(item.model)||"apikey"===auth&&daybreak&&!item.hidden&&programs?.some(program=>"standard"!==program)===!0:!item.hidden)))}';
  return 'var guard=n("effort-guard");n.d(t,{},{catalog:function({additionalAvailableModels:extra,apiKeyDaybreakSupported:daybreak=!1,authMethod:auth,availableModels:allow,defaultModel:fallback,enabledReasoningEfforts:enabled,hasConfiguredModelCatalog:configured,includeUltraReasoningEffort:ultra,isCustomModelProvider:custom=!1,models:models,useHiddenModels:hidden}){let output=[],defaultModel=null,maximum=!1,ultraFlag=!1;return models.forEach(item=>{if(' + predicate + '({additionalAvailableModels:extra,apiKeyDaybreakSupported:daybreak,authMethod:auth,availableModels:allow,hasConfiguredModelCatalog:configured,isCustomModelProvider:custom,model:item,useHiddenModels:hidden})){let raw=ultra?item.supportedReasoningEfforts:item.supportedReasoningEfforts.filter(({reasoningEffort:effort})=>"ultra"!==effort),filtered=("copilot"===auth?[raw.find(e=>"medium"===e.reasoningEffort)??{reasoningEffort:"medium",description:"medium effort"}]:raw).filter(({reasoningEffort:effort})=>(0,guard.allowed)(effort)&&enabled.has(effort)),normalized={...item,supportedReasoningEfforts:filtered};output.push(normalized),item.isDefault&&(defaultModel=normalized)}}),null==defaultModel&&(defaultModel=output.find(item=>item.model===fallback)??null),{models:output,defaultModel:defaultModel,hasModelSupportingMaxReasoningEffort:maximum,hasModelSupportingUltraReasoningEffort:ultraFlag}}})';
}

const MODEL_MARKER = "codexLinuxApiKeyServiceTierModel";
function modelSnapshot(source) { return { moduleSource: source, start: 0, params: ["e", "t", "n"] }; }
function patchModelFixture(source) { return applyApiKeyModelMarkerPatch(source, {factorySnapshot: modelSnapshot(source)}); }
function modelChunk(source = currentModelFixture(), id = "catalogOwner") { return gateChunk(source, id); }
function modelNormalizer(source) {
  const owner = inspectModelCatalogOwner(modelSnapshot(source));
  assert.equal(owner.ok, true, owner.reason);
  return Function("guard", `return (${source.slice(owner.owner.start, owner.owner.end)});`)({allowed: () => true});
}

function currentResolverFixture() {
  return 'let r="priority",a="fast",o="default";function l(e,t){let n=t?.trim().toLowerCase();return e===r||e===a||"fast"===n?"fast":"ultrafast"===e||"ultrafast"===n?"ultrafast":null}function c(e,t){return null==t?null:t===a?u(e):e?.serviceTiers?.find(e=>e.id===t)??null}function u(e){return e?.serviceTiers?.find(e=>"fast"===l(e.id,e.name)||"priority"===e.name.trim().toLowerCase())??null}';
}

function currentOptionsFixture() {
  return 'let o={description:"Standard",iconKind:null,label:"Standard",speedMultiplier:null,tier:null,value:null};function l(e){return"fast"===(0,r.Pg)(e)}function u(e){return d(e?.model,e?.serviceTiers)}function d(e,t){return[o,...(t??[]).map(e=>{let t=(0,r.Pg)(e.id,e.name),n="fast"===t?1.5:null;return{description:function(e,t){switch((0,r.Pg)(e?.id??null,e?.name)){case"fast":return"fast";case"ultrafast":return e?.description||"ultrafast";case null:return e?.description??"standard"}}(e,n),iconKind:t,label:function(e){switch((0,r.Pg)(e?.id??null,e?.name)){case"fast":return"Fast";case"ultrafast":return"Ultrafast";case null:return e?.name??"Standard"}}(e),speedMultiplier:n,tier:e,value:e.id}})]}';
}

function gateHarness(source) {
  const publication = findRspackExportPublication(gateSnapshot(source), "U");
  const fn = source.slice(publication.fn.start, publication.fn.end);
  return Function(`
    let host, requirements, pending = false, calls = 0, query;
    const memo = [];
    const i = {c: () => memo}, r = {Dc: "local"}, l = {b9: {}};
    const o = {Ul: value => value, _U: (_, value) => {query = value; return {data: requirements, isPending: pending}}};
    const s = {tn: () => host};
    const a = {W6: data => {calls++; return data.access}};
    const gate = ${fn};
    return {gate, setHost: value => host = value, setRequirements: value => requirements = value,
      setPending: value => pending = value, calls: () => calls, query: () => query};
  `)();
}

function captureWarnings(callback) {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    callback();
  } finally {
    console.warn = originalWarn;
  }
  return warnings;
}

function withFeatureConfig(enabled, callback) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "api-key-service-tier-"));
  const configPath = path.join(tempDir, "features.json");
  const originalConfig = process.env.CODEX_LINUX_FEATURES_CONFIG;

  try {
    fs.writeFileSync(configPath, `${JSON.stringify({ enabled })}\n`);
    process.env.CODEX_LINUX_FEATURES_CONFIG = configPath;
    return callback(path.resolve(__dirname, ".."));
  } finally {
    if (originalConfig == null) {
      delete process.env.CODEX_LINUX_FEATURES_CONFIG;
    } else {
      process.env.CODEX_LINUX_FEATURES_CONFIG = originalConfig;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function asChunk(...factories) {
  return `export const __rspack_esm_id=1;export const __rspack_esm_ids=[1];export const __webpack_modules__={${
    factories.map((body, index) => `m${index}(e,t,n){${body}}`).join(",")
  }};`;
}

function gateChunk(source = currentGateFixture(), id = "gateOwner") {
  return `export const __rspack_esm_ids=[3];export const __webpack_modules__={${id}(e,t,n){${source}}};`;
}

function withExtractedApp(chunks, callback) {
  const tempApp = fs.mkdtempSync(path.join(os.tmpdir(), "api-key-service-tier-app-"));
  try {
    const asyncDir = path.join(tempApp, "webview", "assets", "async");
    fs.mkdirSync(asyncDir, { recursive: true });
    for (const [name, source] of Object.entries(chunks)) {
      fs.writeFileSync(path.join(asyncDir, name), source);
    }
    return callback(tempApp, asyncDir);
  } finally {
    fs.rmSync(tempApp, { recursive: true, force: true });
  }
}

function reportEntries(report) {
  return Object.fromEntries(DESCRIPTOR_IDS.map((id) => [
    id,
    report.patches.find((entry) => entry.name === `feature:api-key-service-tier:${id}`),
  ]));
}

test("api-key-service-tier stays disabled until listed in features.json", () => {
  withFeatureConfig([], (featuresRoot) => {
    assert.deepEqual(loadLinuxFeaturePatchDescriptors({ featuresRoot }), []);
  });

  withFeatureConfig(["api-key-service-tier"], (featuresRoot) => {
    const loaded = loadLinuxFeaturePatchDescriptors({ featuresRoot });
    assert.deepEqual(
      loaded.map((descriptor) => [descriptor.id, descriptor.phase, descriptor.ciPolicy]),
      DESCRIPTOR_IDS.map((id, index) => [`feature:api-key-service-tier:${id}`, index <= 3 ? "extracted-app:pre-webview" : "webview-asset", "optional"]),
    );
  });
});

test("descriptors find their owners by content needles, not chunk names", () => {
  assert.deepEqual(descriptors.map((descriptor) => descriptor.id), DESCRIPTOR_IDS);
  const fixtures = {
    "api-key-service-tier-gate": currentGateFixture(),
    "api-key-service-tier-model": currentModelFixture(),
    "api-key-service-tier-resolver": currentResolverFixture() + "supportsIndependentSpeedModes",
    "api-key-service-tier-fallback": currentOptionsFixture() + "Description for the Ultrafast service tier",
  };
  assert.equal(descriptors[1].phase, "extracted-app:pre-webview");
  assert.equal(descriptors[1].assetNeedles, undefined);
  for (const descriptor of descriptors.slice(4)) {
    assert.equal(descriptor.pattern, undefined);
    assert.equal(descriptor.assetPattern, undefined);
    assert.equal(descriptor.assetMatch, undefined);
    assert.ok(descriptor.assetNeedles.length >= 2);
    for (const needle of descriptor.assetNeedles) {
      assert.equal(fixtures[descriptor.id].includes(needle), true, `${descriptor.id}: ${needle}`);
    }
  }
});

test("model marker refuses missing owners while resolver and fallback warn byte-identically", () => {
  assert.throws(() => applyApiKeyModelMarkerPatch("function drifted(){}"), /Missing or ambiguous/);
  for (const [patchFn, message] of [
    [applyApiKeyServiceTierResolverPatch, "Could not find service tier resolver - skipping API key service tier resolver patch"],
    [applyFallbackFastTierPatch, "Could not find service tier option helpers - skipping API key fallback fast tier patch"],
  ]) {
    const source = "function drifted(){}";
    assert.deepEqual(captureWarnings(() => assert.equal(patchFn(source), source)), [`WARN: ${message}`]);
  }
});

test("current service-tier access allows API-key Fast without enabling Ultrafast", () => {
  const patched = applyPatchTwice(patchGateFixture, currentGateFixture());
  assert.match(patched, /\(0,a\.W6\)\(f\):"apikey"===h&&!x\?\{fast:!0,ultrafast:!1\}:null,/);
  assert.match(patched, /d\[5\]!==h\?/);
  assert.match(patched, /,d\[5\]=h,/);
  const driver = gateHarness(patched);
  driver.setHost({ authMethod: "apikey", isLoading: false });
  assert.deepEqual(driver.gate().serviceTierAccess, { fast: true, ultrafast: false });
  assert.equal(driver.calls(), 0);
  driver.setPending(true);
  assert.deepEqual(driver.gate(), { serviceTierAccess: { fast: true, ultrafast: false }, isLoading: false });
  driver.setHost({ authMethod: "apikey", isLoading: true });
  assert.deepEqual(driver.gate(), { serviceTierAccess: null, isLoading: true });
  driver.setHost({ authMethod: "apikey", isLoading: false });
  assert.deepEqual(driver.gate(), { serviceTierAccess: { fast: true, ultrafast: false }, isLoading: false });
  assert.equal(driver.calls(), 0);
});

test("current gate preserves account requirements and pending state", () => {
  const driver = gateHarness(patchGateFixture(currentGateFixture()));
  for (const authMethod of ["chatgpt", "personalAccessToken", "amazonBedrock"]) {
    driver.setHost({ authMethod, isLoading: false });
    const access = { fast: false, ultrafast: true };
    driver.setRequirements({ access });
    assert.equal(driver.gate().serviceTierAccess, access);
    driver.setPending(true);
    assert.deepEqual(driver.gate(), { serviceTierAccess: null, isLoading: true });
    driver.setPending(false);
    driver.setRequirements(null);
    assert.deepEqual(driver.gate(), { serviceTierAccess: null, isLoading: false });
  }
  assert.equal(driver.calls(), 3);
});

test("memoized current gate recomputes access when API-key authentication changes", () => {
  const driver = gateHarness(patchGateFixture(currentGateFixture()));
  const host = { authMethod: "apikey", isLoading: false };
  driver.setHost(host);
  assert.equal(driver.gate().serviceTierAccess.fast, true);
  for (const authMethod of ["copilot", "custom-provider", null, undefined, "apikey"]) {
    host.authMethod = authMethod;
    assert.deepEqual(driver.gate().serviceTierAccess,
      authMethod === "apikey" ? { fast: true, ultrafast: false } : null);
    assert.equal(driver.query().authMethod, authMethod ?? null);
    assert.equal(driver.query().hostId, "local");
  }
  assert.equal(driver.calls(), 0);
});

test("service-tier gate rejects ambiguous, partial and drifted access contracts", () => {
  const source = currentGateFixture();
  const patched = patchGateFixture(source);
  const partial = patched.replace(",d[5]=h,", ",d[5]=g,");
  const drifted = source.replace("(0,a.W6)(f)", "(0,a.W6)(f,other)");
  for (const candidate of [source + source, patched + source, partial, drifted]) {
    assert.throws(() => patchGateFixture(candidate), /gate owner/);
  }
});

test("gate ownership rejects opaque, wrong-binding and unpublished lookalikes", () => {
  const source = currentGateFixture();
  for (const candidate of [
    `/*${source}*/`, `const opaque=${JSON.stringify(source)};`,
    source.replace("n.d(t,", "foreign.d(t,"),
    source.replace("n.d(t,", "n.d(other,"),
    source.replace("s=n(\"host\")", "s=foreign(\"host\")"),
    source.replace("s.tn)(p)", "a.tn)(p)"),
    source.replace("l.b9,t)", "l.b9,other)"),
    source.replace("p=e?.hostId??u", "p=foreign?.hostId??u"),
    source.replace("x=!!m?.isLoading||g&&b", "x=!!m?.isLoading||g&&other"),
    source.replace("n.d(t,", "function nested(){n.d(t,") + "}",
    "globalThis.codexLinuxApiKeyFastTier=true;" + source,
    source + ";s=foreign;",
  ]) assert.throws(() => patchGateFixture(candidate), /gate owner/);
});

test("gate owner follows renamed imports, bindings, publication and module identity", () => {
  let source = currentGateFixture();
  const renamed = {i: "memoApi", o: "queryApi", a: "accessApi", r: "defaultsApi", s: "hostsApi", l: "requirementsApi"};
  source = source.replace(/\b[iorasl]\b/gu, name => renamed[name]);
  source = source.replace("{U:function", "{accessHook:function");
  const patched = applyPatchTwice(patchGateFixture, source);
  assert.equal(serviceTierGateState(patched, gateSnapshot(patched)).kind, "patched");
  withExtractedApp({"nested-name.js": gateChunk(source, "arbitraryOwner")}, (app) => {
    const result = patchApiKeyServiceTierGate(app);
    assert.equal(result.moduleId, "arbitraryOwner");
    assert.equal(result.changed, 1);
  });
});

test("gate cohort refuses missing, ambiguous, partial and mixed copies before any write", () => {
  const source = currentGateFixture(), patched = patchGateFixture(source);
  const drifted = source.replace("(0,a.W6)(f)", "(0,a.W6)(f,other)");
  const partial = patched.replace(",d[5]=h,", ",d[5]=g,");
  const cases = [
    {}, {"opaque.js": `/*${gateChunk()}*/`}, {"opaque.js": `const opaque=\`${gateChunk()}\`;`},
    {"a.js": gateChunk(), "b.js": `/*${gateChunk()}*/`},
    {"a.js": gateChunk(), "b.js": gateChunk(source, "otherOwner")},
    {"a.js": gateChunk(), "b.js": gateChunk(drifted)},
    {"a.js": gateChunk(), "b.js": gateChunk(partial)},
    {"a.js": gateChunk(), "b.js": gateChunk(patched)},
    {"a.js": gateChunk(), "b.js": gateChunk("let hidden=true;")},
    {"a.js": gateChunk(), "b.js": gateChunk("let hidden=true;", '"gateO\\u0077ner"')},
  ];
  for (const chunks of cases) withExtractedApp(chunks, (app, assets) => {
    let writes = 0;
    assert.throws(() => patchApiKeyServiceTierGate(app, {writeFileSync: () => {writes++;}}));
    assert.equal(writes, 0);
    for (const [name, bytes] of Object.entries(chunks)) assert.equal(fs.readFileSync(path.join(assets, name), "utf8"), bytes);
  });
});

test("gate cohort commits every physical copy, repeats without writes, and preserves unrelated modules", () => {
  const unrelated = asChunk('let untouched="serviceTierAccess: authMethod=personalAccessToken";');
  withExtractedApp({"a.js": gateChunk(), "b.js": gateChunk(), "unrelated.js": unrelated}, (app, assets) => {
    const result = patchApiKeyServiceTierGate(app);
    assert.equal(result.matched, 2);
    assert.equal(result.changed, 2);
    assert.equal(fs.readFileSync(path.join(assets, "unrelated.js"), "utf8"), unrelated);
    let writes = 0;
    const repeat = patchApiKeyServiceTierGate(app, {writeFileSync: () => {writes++;}});
    assert.equal(repeat.changed, 0);
    assert.equal(repeat.matched, 2);
    assert.equal(writes, 0);
  });
});

test("gate cohort restores earlier and partially written later copies after a later write fault", () => {
  const chunks = {"a.js": gateChunk(), "b.js": gateChunk(), "c.js": gateChunk()};
  withExtractedApp(chunks, (app, assets) => {
    let writes = 0;
    assert.throws(() => patchApiKeyServiceTierGate(app, {writeFileSync: (filename, bytes) => {
      writes++;
      if (writes === 2) { fs.writeFileSync(filename, bytes.subarray(0, 37)); throw new Error("later write fault"); }
      fs.writeFileSync(filename, bytes);
    }}), /later write fault/);
    assert.equal(writes, 4, "two attempted writes and both rollbacks");
    for (const [name, bytes] of Object.entries(chunks)) assert.equal(fs.readFileSync(path.join(assets, name), "utf8"), bytes);
  });
});

test("model marker recomputes each host identity and catalog refresh without losing provider data", () => {
  const source = currentModelFixture(), patched = applyPatchTwice(patchModelFixture, source);
  const normalize = modelNormalizer(patched);
  const efforts = [{reasoningEffort: "medium", description: "medium"}, {reasoningEffort: "high", description: "high"}, {reasoningEffort: "ultra", description: "ultra"}];
  const tiers = [{id: "priority", name: "Provider fast"}];
  const input = {model: "custom", hidden: false, isDefault: true, supportedReasoningEfforts: efforts,
    serviceTiers: tiers, extraProviderField: {keep: true}, [MODEL_MARKER]: true};
  const options = {availableModels: new Set(["custom"]), defaultModel: "custom", enabledReasoningEfforts: new Set(["medium", "high"]), models: [input]};
  for (const authMethod of ["apikey", "chatgpt", "personalAccessToken", "amazonBedrock", "copilot", null, "unknown", "apikey"]) {
    const result = normalize({...options, authMethod}), model = result.models[0];
    assert.equal(model[MODEL_MARKER], authMethod === "apikey", String(authMethod));
    assert.equal(model.serviceTiers, tiers);
    assert.equal(model.extraProviderField, input.extraProviderField);
    assert.equal(result.defaultModel, model);
    assert.deepEqual(model.supportedReasoningEfforts.map(e => e.reasoningEffort), authMethod === "copilot" ? ["medium"] : ["medium", "high"]);
    assert.deepEqual({...model, [MODEL_MARKER]: undefined}, {...modelNormalizer(source)({...options, authMethod}).models[0], [MODEL_MARKER]: undefined});
  }
  const refreshedTiers = [{id: "batch", name: "Batch"}];
  const refreshed = normalize({...options, authMethod: "apikey", models: [{...input, serviceTiers: refreshedTiers}]});
  assert.equal(refreshed.models[0].serviceTiers, refreshedTiers);
  assert.equal(refreshed.models[0][MODEL_MARKER], true);
  assert.equal(input[MODEL_MARKER], true);
  assert.equal(input.supportedReasoningEfforts, efforts);
  assert.deepEqual(tiers, [{id: "priority", name: "Provider fast"}]);
});

test("model marker binds the published output and rejects drift, shadows and stale snapshots", () => {
  const source = currentModelFixture();
  for (const [from, to] of [
    ["apiKeyDaybreakSupported:daybreak=!1,", ""],
    ["n.d(t,", "n.d(wrongExports,"],
    ["models.forEach(item=>", "models.forEach(auth=>"],
    ["normalized={...item,", "normalized={...wrongModel,"],
    ["output.push(normalized)", "otherOutput.push(normalized)"],
    ["supportedReasoningEfforts:filtered}", "supportedReasoningEfforts:otherEfforts}"],
    ["authMethod:auth,availableModels:allow,defaultModel", "authMethod:otherAuth,availableModels:allow,defaultModel"],
    ["return models.forEach(", "models.forEach("],
  ]) {
    assert.ok(source.includes(from), from);
    assert.throws(() => patchModelFixture(source.replace(from, to)), /Unsupported/, from);
  }
  assert.throws(() => applyApiKeyModelMarkerPatch(source), /Missing or ambiguous/);
  assert.throws(() => applyApiKeyModelMarkerPatch(source, {factorySnapshot: {...modelSnapshot(source), moduleSource: "stale"}}), /Stale/);
  assert.throws(() => applyApiKeyModelMarkerPatch(modelChunk(source).replace("}};", `},second(e,t,n){${source}}};`)), /ambiguous/);
});

test("opaque, orphan, partial, duplicate and wrong-auth model markers never qualify as applied", () => {
  const source = currentModelFixture(), patched = patchModelFixture(source);
  const contribution = `,${MODEL_MARKER}:"apikey"===auth`;
  for (const body of [source + `/*${MODEL_MARKER}:"apikey"===auth}*/`, source + `const example='${MODEL_MARKER}:"apikey"===auth}';`,
    patched + `/*${MODEL_MARKER}*/`, patched.replace(contribution, `,${MODEL_MARKER}:"apikey"===otherAuth`),
    patched.replace(contribution, `,${MODEL_MARKER}:!0`), patched.replace(contribution, `,${MODEL_MARKER}:"apikey"===auth,extra:1`),
    patched.replace(contribution, contribution + contribution)]) {
    assert.throws(() => patchModelFixture(body), /Orphan|noncanonical|Unsupported/);
  }
  for (const opaque of ["const example=`" + modelChunk(source) + "`;", "/*" + modelChunk(source) + "*/", JSON.stringify(modelChunk(source))]) {
    assert.throws(() => applyApiKeyModelMarkerPatch(opaque), /Opaque|Missing/);
  }
  assert.throws(() => applyApiKeyModelMarkerPatch(`/*${MODEL_MARKER}*/` + modelChunk(source)), /Orphan/);
  assert.throws(() => applyApiKeyModelMarkerPatch(modelChunk(source).replace("}};", `},other(e,t,n){const example="${MODEL_MARKER}";}};`)), /Orphan/);
});

test("model marker changes only its exact output contribution in the retained signed factory", () => {
  const source = current.catalog.moduleSource;
  const patched = applyApiKeyModelMarkerPatch(source, {factorySnapshot: current.catalog});
  const contribution = `,${MODEL_MARKER}:"apikey"===n`;
  assert.equal(patched.replace(contribution, ""), source);
  assert.equal(applyApiKeyModelMarkerPatch(patched, {factorySnapshot: {...current.catalog, moduleSource: patched}}), patched);
  assert.equal(applyApiKeyModelMarkerPatch(modelChunk(source, "RenamedIdentity")), modelChunk(patched, "RenamedIdentity"));
  assert.equal(spawnSync(process.execPath, ["--check"], {input: patched}).status, 0);
});

test("model marker preserves UP44 visibility and canonical Copilot effort contributions", () => {
  const source = currentModelFixture().replace('filtered=("copilot"===auth?[raw.find(e=>"medium"===e.reasoningEffort)??{reasoningEffort:"medium",description:"medium effort"}]:raw).filter(',
    'filtered=/*codexLinuxCopilotReasoningEffort*/[...raw].filter(');
  const visible = applyApiKeyModelVisibilityPatch(source, {factorySnapshot: modelSnapshot(source)});
  const patched = patchModelFixture(visible);
  assert.equal(patched.replace(`,${MODEL_MARKER}:"apikey"===auth`, ""), visible);
  assert.equal(patchModelFixture(patched), patched);
  assert.equal(applyApiKeyModelVisibilityPatch(patched, {factorySnapshot: modelSnapshot(patched)}), patched);
});

test("catalog auth cannot be shadowed at the normalized output", () => {
  const source = currentModelFixture().replace('filtered=("copilot"===auth?[raw.find(e=>"medium"===e.reasoningEffort)??{reasoningEffort:"medium",description:"medium effort"}]:raw).filter(',
    'filtered=/*codexLinuxCopilotReasoningEffort*/[...raw].filter(');
  for (const declaration of ["let auth;", "let {auth}=identity;", "let [auth]=identity;", "var auth;", "function auth(){}"]) {
    const shadowed = source.replace(',normalized={...item,', `;${declaration}let normalized={...item,`);
    assert.equal(inspectModelCatalogOwner(modelSnapshot(shadowed)).ok, true, declaration);
    assert.throws(() => patchModelFixture(shadowed), /auth scope binding/, declaration);
  }
  const hoisted = source.replace('item.isDefault&&(defaultModel=normalized)}})', 'item.isDefault&&(defaultModel=normalized)}var auth;})');
  assert.equal(inspectModelCatalogOwner(modelSnapshot(hoisted)).ok, true);
  assert.throws(() => patchModelFixture(hoisted), /auth scope binding/);
});

test("enabled model descriptor reports the complete cohort and its exact repeat", () => {
  withFeatureConfig(["api-key-service-tier"], featuresRoot => {
    const loaded = normalizePatchDescriptors(loadLinuxFeaturePatchDescriptors({featuresRoot}))
      .filter(descriptor => descriptor.id.endsWith(":api-key-service-tier-model"));
    assert.equal(loaded.length, 1);
    withExtractedApp({"a.js": modelChunk(), "b.js": modelChunk()}, (app) => {
      for (const status of ["applied", "already-applied"]) {
        const report = createPatchReport();
        report.enabledFeatures = ["api-key-service-tier"];
        assert.deepEqual(captureWarnings(() => applyExtractedAppPatchDescriptors(app, loaded, {}, report, "extracted-app:pre-webview")), []);
        assert.equal(report.patches[0].status, status);
        assert.deepEqual(enabledFeatureFailuresFromReport(report), []);
      }
    });
  });
});

test("model cohort commits all copies, ignores needle-only consumers and repeats without writes", () => {
  const sibling = '},consumer(e,t,n){let keep="hasModelSupportingUltraReasoningEffort apiKeyDaybreakSupported codex-auto-review";}';
  const source = modelChunk().replace("}};", sibling + "};");
  withExtractedApp({"a.js": source, "b.js": modelChunk(), "consumer.js": asChunk('let keep="hasModelSupportingUltraReasoningEffort apiKeyDaybreakSupported codex-auto-review";')}, (app, assets) => {
    const before = fs.readFileSync(path.join(assets, "consumer.js"), "utf8");
    fs.chmodSync(path.join(assets, "a.js"), 0o640);
    const result = patchApiKeyModelMarker(app);
    assert.equal(result.matched, 2);
    assert.equal(result.changed, 2);
    assert.ok(fs.readFileSync(path.join(assets, "a.js"), "utf8").endsWith(sibling + "};"));
    assert.equal(fs.readFileSync(path.join(assets, "consumer.js"), "utf8"), before);
    let writes = 0;
    const repeat = patchApiKeyModelMarker(app, {}, {writeFileSync: () => {writes++;}});
    assert.equal(repeat.changed, 0);
    assert.equal(repeat.matched, 2);
    assert.equal(writes, 0);
    assert.equal(fs.statSync(path.join(assets, "a.js")).mode & 0o777, 0o640);
  });
});

test("model cohort refuses damaged, opaque, hidden, mixed or orphan copies before any writes", () => {
  const source = currentModelFixture(), patched = patchModelFixture(source);
  const cases = [
    {"a.js": modelChunk(), "b.js": modelChunk(source.replace("apiKeyDaybreakSupported:daybreak=!1,", ""))},
    {"a.js": modelChunk(), "b.js": modelChunk(source.replace("supportedReasoningEfforts:filtered}", `supportedReasoningEfforts:filtered,${MODEL_MARKER}:!0}`))},
    {"a.js": modelChunk(), "b.js": modelChunk(patched)},
    {"a.js": modelChunk(), "b.js": modelChunk("let hidden=true;")},
    {"a.js": modelChunk(), "b.js": modelChunk("let hidden=true;", '"catalogO\\u0077ner"')},
    {"a.js": modelChunk(), "b.js": "const example=`" + modelChunk() + "`;"},
    {"a.js": modelChunk(), "b.js": "/*" + modelChunk() + "*/"},
    {"a.js": modelChunk(), "b.js": `const example='${MODEL_MARKER}:"apikey"===auth}';`},
    {"a.js": modelChunk(source, "first"), "b.js": modelChunk(source, "second")},
    {},
  ];
  for (const chunks of cases) withExtractedApp(chunks, (app, assets) => {
    let writes = 0;
    assert.throws(() => patchApiKeyModelMarker(app, {}, {writeFileSync: () => {writes++;}}));
    assert.equal(writes, 0);
    for (const [name, bytes] of Object.entries(chunks)) assert.equal(fs.readFileSync(path.join(assets, name), "utf8"), bytes);
  });
});

test("model cohort rolls back a partially written later file and retains every mode", () => {
  const chunks = {"a.js": modelChunk(), "b.js": modelChunk(), "c.js": modelChunk()};
  withExtractedApp(chunks, (app, assets) => {
    for (const [index, name] of Object.keys(chunks).entries()) fs.chmodSync(path.join(assets, name), 0o640 + index);
    let writes = 0;
    assert.throws(() => patchApiKeyModelMarker(app, {}, {writeFileSync: (filename, bytes) => {
      writes++;
      if (writes === 2) {fs.writeFileSync(filename, bytes.subarray(0, 37)); throw new Error("model later write fault");}
      fs.writeFileSync(filename, bytes);
    }}), /model later write fault/);
    assert.equal(writes, 4);
    for (const [index, [name, bytes]] of Object.entries(chunks).entries()) {
      assert.equal(fs.readFileSync(path.join(assets, name), "utf8"), bytes);
      assert.equal(fs.statSync(path.join(assets, name)).mode & 0o777, 0o640 + index);
    }
  });
});

test("speed options and resolver round-trip synthetic fast for an API-key model without tiers", () => {
  const patchedOptions = applyPatchTwice(applyFallbackFastTierPatch, currentOptionsFixture());
  const patchedResolver = applyPatchTwice(applyApiKeyServiceTierResolverPatch, currentResolverFixture());
  assert.match(patchedOptions, /function u\(e\)\{function codexLinuxApiKeyFastTier\(e\)\{[^}]*\}\}return d\(e\?\.model,e\?\.serviceTiers\?\.length\?e\.serviceTiers:\[codexLinuxApiKeyFastTier\(e\)\]\.filter\(Boolean\)\)\}/);
  assert.match(patchedResolver, /function codexLinuxApiKeyFastTier\(e\)\{[^}]*\}\}function c\(e,t\)\{return null==t\?null:t===a\?u\(e\)\?\?codexLinuxApiKeyFastTier\(e\):/);

  const pg = (id, name) => (id === "fast" || id === "priority" || name?.trim().toLowerCase() === "fast" ? "fast" : null);
  const optionsFor = Function("r", `${patchedOptions};return u`)({ Pg: pg });
  const resolveTier = Function(`${patchedResolver};return c`)();
  const apiKeyModel = { model: "gpt-5", codexLinuxApiKeyServiceTierModel: true };
  const syntheticOption = optionsFor(apiKeyModel).find(({ value }) => value === "fast");

  assert.equal(syntheticOption?.tier?.id, "fast");
  assert.equal(syntheticOption?.speedMultiplier, 1.5);
  assert.equal(resolveTier(apiKeyModel, syntheticOption.value)?.id, "fast");
  assert.equal(resolveTier(apiKeyModel, syntheticOption.value)?.name, "Fast");

  const upstreamFast = { id: "priority", name: "Priority", description: "Upstream fast" };
  const chatGptModel = { model: "gpt-5", codexLinuxApiKeyServiceTierModel: false, serviceTiers: [upstreamFast] };
  assert.equal(resolveTier(chatGptModel, "fast"), upstreamFast);
  assert.deepEqual(optionsFor(chatGptModel).map(({ value }) => value), [null, "priority"]);
  assert.equal(resolveTier({ model: "gpt-5" }, "fast"), null);
  assert.deepEqual(optionsFor({ model: "gpt-5" }).map(({ value }) => value), [null]);
});

test("resolver and option patches reject ambiguous, partial and near-miss owners", () => {
  const resolver = currentResolverFixture();
  const patchedResolver = applyApiKeyServiceTierResolverPatch(resolver);
  const partialResolver = patchedResolver.replace(/function codexLinuxApiKeyFastTier\(e\)\{[^}]*\}\}/, "");
  const foreignConstant = resolver.replace('a="fast"', 'a="priority"');
  for (const source of [resolver + resolver, patchedResolver + resolver, partialResolver, foreignConstant]) {
    assert.equal(captureWarnings(() => {
      assert.equal(applyApiKeyServiceTierResolverPatch(source), source);
    }).length, 1);
  }

  const options = currentOptionsFixture();
  const patchedOptions = applyFallbackFastTierPatch(options);
  const partialOptions = patchedOptions.replace(/function codexLinuxApiKeyFastTier\(e\)\{[^}]*\}\}/, "");
  const nearMiss = options.replace("tier:e,value:e.id", "value:e.id");
  for (const source of [options + options, partialOptions, nearMiss]) {
    assert.equal(captureWarnings(() => {
      assert.equal(applyFallbackFastTierPatch(source), source);
    }).length, 1);
  }
});

test("rspack chunks patch every gate copy and report a drifted owner separately", () => {
  withFeatureConfig(["api-key-service-tier"], () => {
    const chunks = {
      "11.aaaa.js": gateChunk(),
      "12.bbbb.js": gateChunk(),
      "13.cccc.js": modelChunk().replace("}};", '},optionsOwner(e,t,n){' + currentOptionsFixture() + 'let q="Description for the Ultrafast service tier";}};'),
      "14.dddd.js": asChunk(currentResolverFixture().replace("t===a?u(e)", "t===a?drift(e)") + "let z=\"supportsIndependentSpeedModes\";"),
    };
    withExtractedApp(chunks, (tempApp, asyncDir) => {
      const report = createPatchReport();
      const warnings = captureWarnings(() => patchExtractedApp(tempApp, { report }));
      const entries = reportEntries(report);
      assert.equal(entries["api-key-service-tier-gate"]?.status, "applied");
      assert.equal(entries["api-key-service-tier-model"]?.status, "applied");
      assert.equal(entries["api-key-service-tier-fallback"]?.status, "skipped-optional");
      assert.ok(entries["api-key-service-tier-fallback"]?.reason?.includes("options factory"));
      assert.equal(entries["api-key-service-tier-resolver"]?.status, "skipped-optional");
      assert.ok(entries["api-key-service-tier-resolver"]?.reason?.includes("current API key service tier resolver factory"));
      for (const name of ["11.aaaa.js", "12.bbbb.js"]) {
        assert.match(fs.readFileSync(path.join(asyncDir, name), "utf8"), /"apikey"===h&&!x\?/);
      }
      assert.equal(fs.readFileSync(path.join(asyncDir, "14.dddd.js"), "utf8"), chunks["14.dddd.js"]);
    });
  });
});

test("a missing owner gets its own skipped report entry", () => {
  withFeatureConfig(["api-key-service-tier"], () => {
    withExtractedApp({}, (tempApp) => {
      const report = createPatchReport();
      const warnings = captureWarnings(() => patchExtractedApp(tempApp, { report }));
      const entries = reportEntries(report);
      for (const [id, description] of [
        ["api-key-service-tier-gate", "current API key service tier gate bundle"],
        ["api-key-service-tier-model", "current API key service tier model bundle"],
        ["api-key-service-tier-resolver", "current API key service tier resolver factory"],
        ["api-key-service-tier-fallback", "current API key service tier options factory"],
      ]) {
        assert.ok(warnings.some((warning) => warning.includes(description)) || entries[id]?.reason?.includes(description), description);
        assert.equal(entries[id]?.status, "skipped-optional");
      }
    });
  });
});

const signedApp = process.env.CODEX_SIGNED_EXTRACTED_APP;
test("official signed webview owners patch once, idempotently, and still parse", { skip: !signedApp }, () => {
  const assetsDir = path.join(signedApp, "webview", "assets");
  const counts = {};
  for (const descriptor of descriptors) {
    const copies = ["api-key-service-tier-gate", "api-key-service-tier-model", "api-key-service-tier-resolver", "api-key-service-tier-fallback"].includes(descriptor.id)
      ? findUniqueRspackModuleCopies(assetsDir, {
        sourceMatch: source => descriptor.id === "api-key-service-tier-fallback" ? ["Description for the Ultrafast service tier", "serviceTiers"].every(needle=>source.includes(needle)) : descriptor.id === "api-key-service-tier-resolver" ? ["serviceTiers?.find(","supportsIndependentSpeedModes"].every(needle=>source.includes(needle)) : source.includes(descriptor.id === "api-key-service-tier-gate" ? "serviceTierAccess:" : "apiKeyDaybreakSupported"),
        matchModule: (source, module) => descriptor.id === "api-key-service-tier-fallback" ? fallbackModuleState(source, module).kind === "current" : descriptor.id === "api-key-service-tier-gate" ? serviceTierGateState(source, module).kind === "current" : descriptor.id === "api-key-service-tier-resolver" ? resolverModuleState(source, module).kind === "current" : inspectModelCatalogOwner(module).ok,
      }) : null;
    const assets = copies?.map(copy => copy.assetName) ?? findWebviewAssetsContaining(signedApp, descriptor.assetNeedles);
    assert.ok(assets.length > 0, descriptor.id);
    for (const asset of assets) {
      const source = fs.readFileSync(path.join(assetsDir, asset), "utf8");
      const copy = copies?.find(copy => copy.assetName === asset);
      const apply = copy == null ? descriptor.apply : text => {
        const body = text.slice(copy.start, text.length - (source.length - copy.end));
        return text.slice(0, copy.start) + (descriptor.id === "api-key-service-tier-fallback" ? applyFallbackFastTierModule(body, copy) : descriptor.id === "api-key-service-tier-gate" ? applyApiKeyServiceTierGatePatch(body, copy) : descriptor.id === "api-key-service-tier-resolver" ? applyApiKeyServiceTierResolverModule(body, copy) : applyApiKeyModelMarkerPatch(body, {factorySnapshot: {...copy, moduleSource: body}})) + text.slice(text.length - (source.length - copy.end));
      };
      let patched;
      assert.deepEqual(captureWarnings(() => {
        patched = apply(source);
      }), [], `${descriptor.id} ${asset}`);
      assert.notEqual(patched, source, `${descriptor.id} ${asset}`);
      assert.equal(apply(patched), patched, `${descriptor.id} ${asset}`);
      const check = spawnSync(process.execPath, ["--input-type=module", "--check"], {
        input: patched,
        maxBuffer: 64 * 1024 * 1024,
      });
      assert.equal(check.status, 0, `${descriptor.id} ${asset}: ${check.stderr}`);
    }
    counts[descriptor.id] = assets.length;
  }
  assert.equal(counts["api-key-service-tier-model"], 1);
  assert.equal(counts["api-key-service-tier-resolver"], 1);
  assert.equal(counts["api-key-service-tier-fallback"], 1);
  assert.ok(counts["api-key-service-tier-gate"] >= 1);
});

test("model marker census recognizes only complete canonical sibling Fast factories",()=>{
 const resolver=require("./fixtures/current-resolver.json").resolver;
 const options=require("./fixtures/current-options.json").options;
 const rsource=applyApiKeyServiceTierResolverModule(resolver.source,{params:resolver.params,moduleSource:resolver.source,start:0});
 const osource=applyFallbackFastTierModule(options.moduleSource??options.source,{params:options.params,moduleSource:options.moduleSource??options.source,start:0});
 const whole=`export const __webpack_modules__={catalogOwner(e,t,n){${currentModelFixture()}},eWgO(e,t,n){${rsource}},l2g8(e,t,n){${osource}}};`;
 withExtractedApp({"catalog.js":whole},root=>{assert.equal(patchApiKeyModelMarker(root).changed,1);assert.equal(patchApiKeyModelMarker(root).changed,0);});
 for(const body of [rsource.replace('name:"Fast"','name:"Faster"'),`/*${rsource}*/`,`const sample=${JSON.stringify(rsource)};`,`const arbitrary=model.${MODEL_MARKER};`]){
  withExtractedApp({"catalog.js":modelChunk(),"reader.js":gateChunk(body,"reader")},(root,dir)=>{const before=fs.readFileSync(path.join(dir,"catalog.js"));assert.throws(()=>patchApiKeyModelMarker(root),/Orphan/);assert.deepEqual(fs.readFileSync(path.join(dir,"catalog.js")),before);});
 }
});
