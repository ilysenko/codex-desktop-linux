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
const {
  applyApiKeyModelMarkerPatch,
  applyApiKeyServiceTierGatePatch,
  applyApiKeyServiceTierResolverPatch,
  applyFallbackFastTierPatch,
  descriptors,
} = require("./patch.js");

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
  return 'function gate(e){let t,n,c,d=(0,i.c)(10),u=(0,o.Ul)(r.Dc),p=e?.hostId??u,m=(0,s.tn)(p),g=m?.authMethod==="chatgpt"||m?.authMethod==="personalAccessToken"||m?.authMethod==="amazonBedrock",h=m?.authMethod??null;d[0]!==p||d[1]!==h?(t={authMethod:h,hostId:p},d[0]=p,d[1]=h,d[2]=t):t=d[2];let{data:f,isPending:b}=(0,o._U)(l.b9,t),x=!!m?.isLoading||g&&b;d[3]!==f||d[4]!==x||d[5]!==g?(n=g&&!x&&null!=f?(0,a.W6)(f):null,d[3]=f,d[4]=x,d[5]=g,d[6]=n):n=d[6];let v=n;return d[7]!==x||d[8]!==v?(c={serviceTierAccess:v,isLoading:x},d[7]=x,d[8]=v,d[9]=c):c=d[9],c}';
}

function currentModelFixture() {
  return 'function i({additionalAvailableModels:e,apiKeyDaybreakSupported:t=!1,authMethod:n,availableModels:a,defaultModel:s,enabledReasoningEfforts:o,hasConfiguredModelCatalog:l,includeUltraReasoningEffort:u,isCustomModelProvider:d=!1,models:c,useHiddenModels:p}){let h=[],f=null,m=c.some(e=>e.supportedReasoningEfforts.some(({reasoningEffort:e})=>"max"===e)),g=u&&c.some(e=>e.supportedReasoningEfforts.some(({reasoningEffort:e})=>"ultra"===e));return c.forEach(i=>{if(function({additionalAvailableModels:e,apiKeyDaybreakSupported:t,authMethod:n,availableModels:r,hasConfiguredModelCatalog:i,isCustomModelProvider:a,model:s,useHiddenModels:o}){let l=s.availableAccessPrograms?.cyber;return("apikey"!==n||!!t||null==l||!(l.length>0)||!!l.includes("standard"))&&(e?.has(s.model)===!0||"codex-auto-review"!==s.model&&(i&&!s.hidden||(o&&!a&&"amazonBedrock"!==n?r.has(s.model)||"apikey"===n&&t&&!s.hidden&&l?.some(e=>"standard"!==e)===!0:!s.hidden)))}({additionalAvailableModels:e,apiKeyDaybreakSupported:t,authMethod:n,availableModels:a,hasConfiguredModelCatalog:l,isCustomModelProvider:d,model:i,useHiddenModels:p})){let e=u?i.supportedReasoningEfforts:i.supportedReasoningEfforts.filter(({reasoningEffort:e})=>"ultra"!==e),t=("copilot"===n?[e.find(e=>"medium"===e.reasoningEffort)??{reasoningEffort:"medium",description:"medium effort"}]:e).filter(({reasoningEffort:e})=>(0,r.eE)(e)&&o.has(e)),a={...i,supportedReasoningEfforts:t};h.push(a),i.isDefault&&(f=a)}}),null==f&&(f=h.find(e=>e.model===s)??null),{models:h,defaultModel:f,hasModelSupportingMaxReasoningEffort:m,hasModelSupportingUltraReasoningEffort:g}}';
}

function currentResolverFixture() {
  return 'let r="priority",a="fast",o="default";function l(e,t){let n=t?.trim().toLowerCase();return e===r||e===a||"fast"===n?"fast":"ultrafast"===e||"ultrafast"===n?"ultrafast":null}function c(e,t){return null==t?null:t===a?u(e):e?.serviceTiers?.find(e=>e.id===t)??null}function u(e){return e?.serviceTiers?.find(e=>"fast"===l(e.id,e.name)||"priority"===e.name.trim().toLowerCase())??null}';
}

function currentOptionsFixture() {
  return 'let o={description:"Standard",iconKind:null,label:"Standard",speedMultiplier:null,tier:null,value:null};function l(e){return"fast"===(0,r.Pg)(e)}function u(e){return d(e?.model,e?.serviceTiers)}function d(e,t){return[o,...(t??[]).map(e=>{let t=(0,r.Pg)(e.id,e.name),n="fast"===t?1.5:null;return{description:function(e,t){switch((0,r.Pg)(e?.id??null,e?.name)){case"fast":return"fast";case"ultrafast":return e?.description||"ultrafast";case null:return e?.description??"standard"}}(e,n),iconKind:t,label:function(e){switch((0,r.Pg)(e?.id??null,e?.name)){case"fast":return"Fast";case"ultrafast":return"Ultrafast";case null:return e?.name??"Standard"}}(e),speedMultiplier:n,tier:e,value:e.id}})]}';
}

function gateHarness(source) {
  return Function(`
    let host, requirements, pending = false, calls = 0;
    const memo = [];
    const i = {c: () => memo}, r = {Dc: "local"}, l = {b9: {}};
    const o = {Ul: value => value, _U: () => ({data: requirements, isPending: pending})};
    const s = {tn: () => host};
    const a = {W6: data => {calls++; return data.access}};
    ${source}
    return {gate, setHost: value => host = value, setRequirements: value => requirements = value,
      setPending: value => pending = value, calls: () => calls};
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
      DESCRIPTOR_IDS.map((id) => [`feature:api-key-service-tier:${id}`, "webview-asset", "optional"]),
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
  for (const descriptor of descriptors) {
    assert.equal(descriptor.pattern, undefined);
    assert.equal(descriptor.assetPattern, undefined);
    assert.equal(descriptor.assetMatch, undefined);
    assert.ok(descriptor.assetNeedles.length >= 2);
    for (const needle of descriptor.assetNeedles) {
      assert.equal(fixtures[descriptor.id].includes(needle), true, `${descriptor.id}: ${needle}`);
    }
  }
});

test("every patch warns and stays byte-identical when its contract disappears", () => {
  for (const [patchFn, message] of [
    [applyApiKeyServiceTierGatePatch, "Could not find service tier auth gate - skipping API key service tier gate patch"],
    [applyApiKeyModelMarkerPatch, "Could not find model list mapping - skipping API key model service tier marker patch"],
    [applyApiKeyServiceTierResolverPatch, "Could not find service tier resolver - skipping API key service tier resolver patch"],
    [applyFallbackFastTierPatch, "Could not find service tier option helpers - skipping API key fallback fast tier patch"],
  ]) {
    const source = "function drifted(){}";
    assert.deepEqual(captureWarnings(() => assert.equal(patchFn(source), source)), [`WARN: ${message}`]);
  }
});

test("current service-tier access allows API-key Fast without enabling Ultrafast", () => {
  const patched = applyPatchTwice(applyApiKeyServiceTierGatePatch, currentGateFixture());
  assert.match(patched, /\(0,a\.W6\)\(f\):"apikey"===h&&!x\?\{fast:!0,ultrafast:!1\}:null,/);
  assert.match(patched, /d\[5\]!==h\?/);
  assert.match(patched, /,d\[5\]=h,/);
  const driver = gateHarness(patched);
  driver.setHost({ authMethod: "apikey", isLoading: false });
  assert.deepEqual(driver.gate().serviceTierAccess, { fast: true, ultrafast: false });
  assert.equal(driver.calls(), 0);
  driver.setHost({ authMethod: "apikey", isLoading: true });
  assert.deepEqual(driver.gate(), { serviceTierAccess: null, isLoading: true });
});

test("current gate preserves account requirements and pending state", () => {
  const driver = gateHarness(applyApiKeyServiceTierGatePatch(currentGateFixture()));
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
  const driver = gateHarness(applyApiKeyServiceTierGatePatch(currentGateFixture()));
  const host = { authMethod: "apikey", isLoading: false };
  driver.setHost(host);
  assert.equal(driver.gate().serviceTierAccess.fast, true);
  for (const authMethod of ["copilot", null, "apikey"]) {
    host.authMethod = authMethod;
    assert.deepEqual(driver.gate().serviceTierAccess,
      authMethod === "apikey" ? { fast: true, ultrafast: false } : null);
  }
});

test("service-tier gate rejects ambiguous, partial and drifted access contracts", () => {
  const source = currentGateFixture();
  const patched = applyApiKeyServiceTierGatePatch(source);
  const partial = patched.replace(",d[5]=h,", ",d[5]=g,");
  const drifted = source.replace("(0,a.W6)(f)", "(0,a.W6)(f,other)");
  for (const candidate of [source + source, patched + source, partial, drifted]) {
    const warnings = captureWarnings(() => {
      assert.equal(applyApiKeyServiceTierGatePatch(candidate), candidate);
    });
    assert.equal(warnings.length, 1);
  }
});

test("model list entries are marked only when loaded for API-key hosts", () => {
  const patched = applyPatchTwice(applyApiKeyModelMarkerPatch, currentModelFixture());
  assert.match(
    patched,
    /a=\{\.\.\.i,supportedReasoningEfforts:t,codexLinuxApiKeyServiceTierModel:"apikey"===n\}/,
  );
  const catalog = Function("r", `${patched};return i;`)({ eE: () => true });
  const run = (authMethod) => catalog({
    authMethod,
    availableModels: new Set(["gpt-5"]),
    defaultModel: "gpt-5",
    enabledReasoningEfforts: new Set(["medium"]),
    includeUltraReasoningEffort: false,
    models: [{ model: "gpt-5", hidden: false, isDefault: true, supportedReasoningEfforts: [] }],
    useHiddenModels: false,
  });
  assert.equal(run("apikey").models[0].codexLinuxApiKeyServiceTierModel, true);
  assert.equal(run("chatgpt").models[0].codexLinuxApiKeyServiceTierModel, false);
});

test("model list marker rejects the superseded pre-Daybreak signature byte-identically", () => {
  const source = currentModelFixture().replace("apiKeyDaybreakSupported:t=!1,", "");
  assert.deepEqual(captureWarnings(() => {
    assert.equal(applyApiKeyModelMarkerPatch(source), source);
  }), ["WARN: Could not find model list mapping - skipping API key model service tier marker patch"]);
});

test("speed options and resolver round-trip synthetic fast for an API-key model without tiers", () => {
  const patchedOptions = applyPatchTwice(applyFallbackFastTierPatch, currentOptionsFixture());
  const patchedResolver = applyPatchTwice(applyApiKeyServiceTierResolverPatch, currentResolverFixture());
  assert.match(patchedOptions, /function codexLinuxApiKeyFastTier\(e\)\{[^}]*\}\}function u\(e\)\{return d\(e\?\.model,e\?\.serviceTiers\?\.length\?e\.serviceTiers:\[codexLinuxApiKeyFastTier\(e\)\]\.filter\(Boolean\)\)\}/);
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
      "11.aaaa.js": asChunk(currentGateFixture()),
      "12.bbbb.js": asChunk(currentGateFixture()),
      "13.cccc.js": asChunk(currentModelFixture(), currentOptionsFixture() + 'let q="Description for the Ultrafast service tier";'),
      "14.dddd.js": asChunk(currentResolverFixture().replace("t===a?u(e)", "t===a?drift(e)") + "let z=\"supportsIndependentSpeedModes\";"),
    };
    withExtractedApp(chunks, (tempApp, asyncDir) => {
      const report = createPatchReport();
      const warnings = captureWarnings(() => patchExtractedApp(tempApp, { report }));
      const entries = reportEntries(report);
      assert.equal(entries["api-key-service-tier-gate"]?.status, "applied");
      assert.equal(entries["api-key-service-tier-model"]?.status, "applied");
      assert.equal(entries["api-key-service-tier-fallback"]?.status, "applied");
      assert.equal(entries["api-key-service-tier-resolver"]?.status, "skipped-optional");
      assert.ok(warnings.some((warning) => warning.includes("Could not find service tier resolver")));
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
        ["api-key-service-tier-resolver", "current API key service tier resolver bundle"],
        ["api-key-service-tier-fallback", "current API key service tier fallback bundle"],
      ]) {
        assert.ok(warnings.some((warning) => warning.includes(description)), description);
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
    const assets = findWebviewAssetsContaining(signedApp, descriptor.assetNeedles);
    assert.ok(assets.length > 0, descriptor.id);
    for (const asset of assets) {
      const source = fs.readFileSync(path.join(assetsDir, asset), "utf8");
      let patched;
      assert.deepEqual(captureWarnings(() => {
        patched = descriptor.apply(source);
      }), [], `${descriptor.id} ${asset}`);
      assert.notEqual(patched, source, `${descriptor.id} ${asset}`);
      assert.equal(descriptor.apply(patched), patched, `${descriptor.id} ${asset}`);
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
