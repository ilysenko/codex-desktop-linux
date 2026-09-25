#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
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
  loadLinuxFeaturePatchDescriptors,
} = require("../../scripts/lib/linux-features.js");
const {
  applyApiKeyModelMarkerPatch,
  applyApiKeyServiceTierPatch,
  applyApiKeyServiceTierGatePatch,
  applyApiKeyServiceTierResolverPatch,
  applyCurrentGatePatch,
  applyCurrentModelPatch,
  applyCurrentResolverPatch,
  applyCurrentFallbackFastTierPatch,
  applyFallbackFastTierPatch,
  descriptors,
  hasApiKeyServiceTierGateShape,
  hasApiKeyModelListMappingShape,
} = require("./patch.js");

function applyPatchTwice(patchFn, source) {
  const once = patchFn(source);
  assert.notEqual(once, source);
  assert.equal(patchFn(once), once);
  return once;
}

function currentModelFixture() {
  return "function iti({additionalAvailableModels:e,authMethod:t,availableModels:n,defaultModel:r,enabledReasoningEfforts:i,hasConfiguredModelCatalog:h,includeUltraReasoningEffort:a,isCustomModelProvider:o=!1,models:s,useHiddenModels:c}){let l=[],u=null,d=s.some(e=>e.supportedReasoningEfforts.some(({reasoningEffort:e})=>e===`max`)),f=a&&s.some(e=>e.supportedReasoningEfforts.some(({reasoningEffort:e})=>e===`ultra`));return s.forEach(r=>{if(ati({additionalAvailableModels:e,authMethod:t,availableModels:n,hasConfiguredModelCatalog:h,isCustomModelProvider:o,model:r,useHiddenModels:c})){let e=a?r.supportedReasoningEfforts:r.supportedReasoningEfforts.filter(({reasoningEffort:e})=>e!==`ultra`),n=(t===`copilot`?[e.find(e=>e.reasoningEffort===`medium`)??{reasoningEffort:`medium`,description:`medium effort`}]:e).filter(({reasoningEffort:e})=>cI(e)&&i.has(e)),o={...r,supportedReasoningEfforts:n};l.push(o),r.isDefault&&(u=o)}}),u??=l.find(e=>e.model===r)??null,{models:l,defaultModel:u,hasModelSupportingMaxReasoningEffort:d,hasModelSupportingUltraReasoningEffort:f}}";
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

test("api-key-service-tier stays disabled until listed in features.json", () => {
  withFeatureConfig([], (featuresRoot) => {
    assert.deepEqual(loadLinuxFeaturePatchDescriptors({ featuresRoot }), []);
  });

  withFeatureConfig(["api-key-service-tier"], (featuresRoot) => {
    const loaded = loadLinuxFeaturePatchDescriptors({ featuresRoot });
    assert.deepEqual(
      loaded.map((descriptor) => [descriptor.id, descriptor.phase, descriptor.ciPolicy]),
      [
        ["feature:api-key-service-tier:api-key-service-tier-gate", "webview-asset", "optional"],
        ["feature:api-key-service-tier:api-key-service-tier-model", "webview-asset", "optional"],
        ["feature:api-key-service-tier:api-key-service-tier-resolver", "webview-asset", "optional"],
        ["feature:api-key-service-tier:api-key-service-tier-fallback", "webview-asset", "optional"],
      ],
    );
  });
});

test("current package descriptors use semantic app-initial and app-shared owners", () => {
  assert.deepEqual(
    descriptors.map((descriptor) => descriptor.id),
    [
      "api-key-service-tier-gate",
      "api-key-service-tier-model",
      "api-key-service-tier-resolver",
      "api-key-service-tier-fallback",
    ],
  );
  const sharedIds = new Set(["api-key-service-tier-resolver", "api-key-service-tier-fallback"]);
  assert.ok(descriptors.filter((descriptor) => !sharedIds.has(descriptor.id))
    .every((descriptor) => descriptor.pattern.test("app-initial-Bd3Z1bES.js")));
  assert.ok(descriptors.filter((descriptor) => sharedIds.has(descriptor.id))
    .every((descriptor) => descriptor.pattern.test("app-shared-d9439dc9e73f.js")));
  assert.ok(descriptors.every((descriptor) => !descriptor.pattern.test("projects-index-page-DjNy92Xe.js")));
});

test("current target wrappers warn when an exact contract disappears", () => {
  assert.deepEqual(captureWarnings(() => {
    assert.equal(applyCurrentGatePatch("function driftedGate(){}"), "function driftedGate(){}");
  }), [
    "WARN: Could not identify current service tier auth gate - skipping API key service tier gate patch",
  ]);
  assert.deepEqual(captureWarnings(() => {
    assert.equal(applyCurrentModelPatch("function driftedModel(){}"), "function driftedModel(){}");
  }), [
    "WARN: Could not identify current model list mapping - skipping API key model service tier marker patch",
  ]);
  assert.deepEqual(captureWarnings(() => {
    assert.equal(applyCurrentResolverPatch("function driftedResolver(){}"), "function driftedResolver(){}");
  }), [
    "WARN: Could not identify current service tier resolver - skipping API key service tier resolver patch",
  ]);
  assert.deepEqual(captureWarnings(() => {
    assert.equal(applyCurrentFallbackFastTierPatch("function driftedFallback(){}"), "function driftedFallback(){}");
  }), [
    "WARN: Could not identify current service tier option helpers - skipping API key fallback fast tier patch",
  ]);
});

test("partial current drift is reported when the other exact target still applies", () => {
  withFeatureConfig(["api-key-service-tier"], () => {
    const tempApp = fs.mkdtempSync(path.join(os.tmpdir(), "api-key-service-tier-partial-drift-"));
    try {
      const assetsDir = path.join(tempApp, "webview", "assets");
      fs.mkdirSync(assetsDir, { recursive: true });
      fs.writeFileSync(
        path.join(assetsDir, "app-initial-gate-drifted.js"),
        "function driftedGate(){return `priority_mode`}",
      );
      fs.writeFileSync(
        path.join(
          assetsDir,
          "app-initial-model-current.js",
        ),
        currentModelFixture(),
      );
      fs.writeFileSync(
        path.join(
          assetsDir,
          "app-shared-fallback-current.js",
        ),
        [
          "function pNr(e,t){return[gQ,...(t??[]).map(t=>({description:eEe(t),iconKind:fQ(t.id,t.name),label:$Te(t),tier:t,value:t.id}))]}",
        ].join(""),
      );
      fs.writeFileSync(
        path.join(assetsDir, "app-shared-resolver-current.js"),
        "function kH(e,t){return t==null?null:t===`fast`?AH(e):e?.serviceTiers?.find(e=>e.id===t)??null}",
      );

      const report = createPatchReport();
      const warnings = captureWarnings(() => patchExtractedApp(tempApp, { report }));
      const gate = report.patches.find(
        (entry) => entry.name === "feature:api-key-service-tier:api-key-service-tier-gate",
      );
      const model = report.patches.find(
        (entry) => entry.name === "feature:api-key-service-tier:api-key-service-tier-model",
      );
      const resolver = report.patches.find(
        (entry) => entry.name === "feature:api-key-service-tier:api-key-service-tier-resolver",
      );
      const fallback = report.patches.find(
        (entry) => entry.name === "feature:api-key-service-tier:api-key-service-tier-fallback",
      );

      assert.ok(warnings.some((warning) => warning.includes("current API key service tier gate bundle")));
      assert.equal(gate?.status, "skipped-optional");
      assert.equal(model?.status, "applied");
      assert.equal(resolver?.status, "applied");
      assert.equal(fallback?.status, "applied-with-warnings");
    } finally {
      fs.rmSync(tempApp, { recursive: true, force: true });
    }
  });
});

test("a missing exact current target gets its own skipped report entry", () => {
  withFeatureConfig(["api-key-service-tier"], () => {
    const tempApp = fs.mkdtempSync(path.join(os.tmpdir(), "api-key-service-tier-missing-target-"));
    try {
      fs.mkdirSync(path.join(tempApp, "webview", "assets"), { recursive: true });
      const report = createPatchReport();
      const warnings = captureWarnings(() => patchExtractedApp(tempApp, { report }));
      const gate = report.patches.find(
        (entry) => entry.name === "feature:api-key-service-tier:api-key-service-tier-gate",
      );
      const model = report.patches.find(
        (entry) => entry.name === "feature:api-key-service-tier:api-key-service-tier-model",
      );
      const resolver = report.patches.find(
        (entry) => entry.name === "feature:api-key-service-tier:api-key-service-tier-resolver",
      );
      const fallback = report.patches.find(
        (entry) => entry.name === "feature:api-key-service-tier:api-key-service-tier-fallback",
      );

      assert.ok(warnings.some((warning) => warning.includes("current API key service tier gate bundle")));
      assert.ok(warnings.some((warning) => warning.includes("current API key service tier model bundle")));
      assert.ok(warnings.some((warning) => warning.includes("current API key service tier resolver bundle")));
      assert.ok(warnings.some((warning) => warning.includes("current API key service tier fallback bundle")));
      assert.equal(gate?.status, "skipped-optional");
      assert.equal(model?.status, "skipped-optional");
      assert.equal(resolver?.status, "skipped-optional");
      assert.equal(fallback?.status, "skipped-optional");
    } finally {
      fs.rmSync(tempApp, { recursive: true, force: true });
    }
  });
});

test("service tier auth gate allows API-key hosts while preserving ChatGPT requirements", () => {
  const source =
    "function sxe(e){let t=(0,cxe.c)(6),n=X(os),r=e?.hostId??n,i=Cf(r),a=i?.authMethod===`chatgpt`,o=i?.authMethod??null,s;t[0]!==r||t[1]!==o?(s={authMethod:o,hostId:r},t[0]=r,t[1]=o,t[2]=s):s=t[2];let{data:c,isPending:l}=ye(is,s),u=!!i?.isLoading||a&&l,d=a&&!u&&c!=null&&c?.requirements?.featureRequirements?.fast_mode!==!1,f;return t[3]!==u||t[4]!==d?(f={isServiceTierAllowed:d,isLoading:u},t[3]=u,t[4]=d,t[5]=f):f=t[5],f}";

  assert.equal(hasApiKeyServiceTierGateShape(source), true);

  const patched = applyPatchTwice(applyApiKeyServiceTierGatePatch, source);

  assert.match(patched, /d=!u&&\(a\?c!=null&&c\?\.requirements\?\.featureRequirements\?\.fast_mode!==!1:o===`apikey`\)/);
  assert.doesNotMatch(patched, /d=a&&!u&&c!=null/);
});

test("current auth gate keeps personal-access-token hosts on the requirements path", () => {
  const source = "function YLn(e){let i=Gc(e),a=i?.authMethod===`chatgpt`||i?.authMethod===`personalAccessToken`,o=i?.authMethod??null,s={authMethod:o}, {data:c,isPending:l}=Kf(s),u=!!i?.isLoading||a&&l,d=a&&!u&&c!=null&&c?.requirements?.featureRequirements?.fast_mode!==!1;return{isServiceTierAllowed:d,isLoading:u}}";
  const patched = applyPatchTwice(applyApiKeyServiceTierGatePatch, source);
  assert.match(patched, /a=i\?\.authMethod===`chatgpt`\|\|i\?\.authMethod===`personalAccessToken`/u);
  assert.match(patched, /d=!u&&\(a\?c!=null/u);
  assert.match(patched, /:o===`apikey`\)/u);
});

test("current shared option owner synthesizes a fallback from its model argument", () => {
  const source = "function pNr(e,t){return[xNr,...(t??[]).map(t=>{let n=gN(t.id,t.name),r=n===`fast`?mNr(e):null;return{description:dNr(t,r),iconKind:n,label:uNr(t),speedMultiplier:r,tier:t,value:t.id}})]}";
  const patched = applyPatchTwice(applyFallbackFastTierPatch, source);
  assert.match(patched, /t\?\.length\?t:\[codexLinuxApiKeyFastTier\(e\)\]/u);
});

test("service tier auth gate warning ignores unrelated fast-mode config guards", () => {
  const source = [
    "async function _Pt(e,t){if(e==null)return null;try{if((await t()).requirements?.featureRequirements?.fast_mode===!1)return null}catch(e){return null}return e}",
    "function $pn(e){let t=(0,nmn.c)(21),r=(0,rmn.useContext)(EI)?.authMethod===`chatgpt`,i=Za(`local`)?.authMethod??null;return{isServiceTierAllowed:r,isLoading:i}}",
  ].join("");

  assert.equal(hasApiKeyServiceTierGateShape(source), false);
  assert.deepEqual(captureWarnings(() => {
    assert.equal(applyApiKeyServiceTierGatePatch(source), source);
  }), []);
});

test("service tier auth gate warning still reports a recognizable unpatchable gate", () => {
  const source =
    "function broken(){let a=i?.authMethod===`chatgpt`;let o=i?.authMethod??null;let d=a&&ready&&c?.requirements?.featureRequirements?.fast_mode!==!1;return{isServiceTierAllowed:d,isLoading:ready}}";

  assert.equal(hasApiKeyServiceTierGateShape(source), true);
  assert.deepEqual(captureWarnings(() => {
    assert.equal(applyApiKeyServiceTierGatePatch(source), source);
  }), ["WARN: Could not find service tier auth gate - skipping API key service tier gate patch"]);
});

test("service tier auth gate stays warning-idempotent with an earlier auth binding", () => {
  const source = [
    "function unrelated(){let s=x?.authMethod??null;return s}",
    "function sxe(e){let t=(0,cxe.c)(6),n=X(os),r=e?.hostId??n,i=Cf(r),a=i?.authMethod===`chatgpt`,o=i?.authMethod??null,s;t[0]!==r||t[1]!==o?(s={authMethod:o,hostId:r},t[0]=r,t[1]=o,t[2]=s):s=t[2];let{data:c,isPending:l}=ye(is,s),u=!!i?.isLoading||a&&l,d=a&&!u&&c!=null&&c?.requirements?.featureRequirements?.fast_mode!==!1,f;return t[3]!==u||t[4]!==d?(f={isServiceTierAllowed:d,isLoading:u},t[3]=u,t[4]=d,t[5]=f):f=t[5],f}",
  ].join("");
  const patched = applyApiKeyServiceTierGatePatch(source);

  assert.notEqual(patched, source);
  assert.deepEqual(captureWarnings(() => {
    assert.equal(applyApiKeyServiceTierGatePatch(patched), patched);
  }), []);
});

test("model list entries are marked only when loaded for API-key hosts", () => {
  const source = currentModelFixture();

  assert.equal(hasApiKeyModelListMappingShape(source), true);

  const patched = applyPatchTwice(applyApiKeyModelMarkerPatch, source);

  assert.match(patched, /o=\{\.\.\.r,supportedReasoningEfforts:n,codexLinuxApiKeyServiceTierModel:t===`apikey`\}/);
});

test("model list marker warning ignores unrelated app-main chunks", () => {
  const source = [
    "async function ZQt(e){try{return await phe(t=>H(`list-models-for-host`,{...t,hostId:e,priority:`critical`}))}catch{return[]}}",
    "let s=(await e.sendRequest(`model/list`,{cursor:null,includeHidden:!0,limit:100}).catch(()=>null))?.data.find(e=>e.model===r)?.supportedReasoningEfforts.some(e=>e.reasoningEffort===o)?o:`low`;",
    "function metadata(e){return{authMethod:e,availableModels:e,defaultModel:e,enabledReasoningEfforts:e,includeUltraReasoningEffort:e,models:e,useHiddenModels:e,isDefault:!1}}",
  ].join("");

  assert.equal(hasApiKeyModelListMappingShape(source), false);
  assert.deepEqual(captureWarnings(() => {
    assert.equal(applyApiKeyModelMarkerPatch(source), source);
  }), []);
});

test("model list marker rejects the superseded pre-catalog signature byte-identically", () => {
  const source =
    "function broken({additionalAvailableModels:e,authMethod:t,availableModels:n,defaultModel:r,enabledReasoningEfforts:i,includeUltraReasoningEffort:a,isCustomModelProvider:o=!1,models:s,useHiddenModels:c}){return s.map(e=>({supportedReasoningEfforts:e.supportedReasoningEfforts,hasModelSupportingUltraReasoningEffort:e.isDefault}))}";

  assert.equal(hasApiKeyModelListMappingShape(source), false);
  assert.deepEqual(captureWarnings(() => {
    assert.equal(applyApiKeyModelMarkerPatch(source), source);
  }), []);
});

test("fallback fast tier is synthesized only for API-key model catalog entries", () => {
  const source = [
    "function pNr(e,t){return[gQ,...(t??[]).map(t=>{let n=fQ(t.id,t.name),r=n===`fast`?1.5:null;return{description:eEe(t,r),iconKind:n,label:$Te(t),speedMultiplier:r,tier:t,value:t.id}})]}",
    "function nEe(e,t,n){return e?.find(e=>e.model===t&&hQ(e,n))??null}",
  ].join("");

  const patched = applyPatchTwice(applyFallbackFastTierPatch, source);

  assert.match(patched, /function codexLinuxApiKeyFastTier\(e\)/);
  assert.match(patched, /e\?\.codexLinuxApiKeyServiceTierModel!==!0\?null/);
  assert.match(patched, /codexLinuxApiKeyFastTier\(e\)/);
  assert.match(patched, /\?t:\[codexLinuxApiKeyFastTier\(e\)\]\)\.filter\(Boolean\)\)\.map/);
  assert.match(patched, /tier:t,value:t\.id/);
  assert.doesNotMatch(patched, /\(t\?\?\[\]\)\.map/);
  assert.doesNotMatch(patched, /\)\?\?null\}function nEe/);
});

test("split semantic owners round-trip synthetic fast for an API-key model without service tiers", () => {
  const optionsSource = [
    "const gQ={value:null};function eEe(e){return e.description}function fQ(e){return e}function $Te(e){return e.name}",
    "function pNr(e,t){return[gQ,...(t??[]).map(t=>({description:eEe(t),iconKind:fQ(t.id,t.name),label:$Te(t),tier:t,value:t.id}))]}",
  ].join("");
  const resolverSource = [
    "function py(e,t){let n=t?.trim().toLowerCase();return e===`priority`||e===`fast`||n===`fast`?`fast`:null}",
    "function kH(e,t){return t==null?null:t===`fast`?AH(e):e?.serviceTiers?.find(e=>e.id===t)??null}",
    "function AH(e){return e?.serviceTiers?.find(e=>py(e.id,e.name)===`fast`||e.name.trim().toLowerCase()===`priority`)??null}",
  ].join("");

  const patchedOptions = applyPatchTwice(applyFallbackFastTierPatch, optionsSource);
  const patchedResolver = applyPatchTwice(applyApiKeyServiceTierResolverPatch, resolverSource);
  const optionsFor = Function(`${patchedOptions};return pNr`)();
  const resolveTier = Function(`${patchedResolver};return kH`)();
  const apiKeyModel = { codexLinuxApiKeyServiceTierModel: true };
  const syntheticOption = optionsFor(apiKeyModel, apiKeyModel.serviceTiers).find(({ value }) => value === "fast");

  assert.equal(syntheticOption?.tier?.id, "fast");
  assert.equal(resolveTier(apiKeyModel, syntheticOption.value)?.id, "fast");
  assert.equal(resolveTier(apiKeyModel, syntheticOption.value)?.name, "Fast");

  const upstreamFast = { id: "priority", name: "Priority", description: "Upstream fast" };
  const chatGptModel = { codexLinuxApiKeyServiceTierModel: false, serviceTiers: [upstreamFast] };
  assert.equal(resolveTier(chatGptModel, "fast"), upstreamFast);
  assert.equal(resolveTier({}, "fast"), null);
});

test("service tier resolver classifies exactly one pristine or fully patched app-shared owner", () => {
  const current =
    "function kH(e,t){return t==null?null:t===`fast`?AH(e):e?.serviceTiers?.find(e=>e.id===t)??null}";
  const other =
    "function other(n,r){return r==null?null:r===`fast`?findFast(n):n?.serviceTiers?.find(t=>t.id===r)??null}";
  const patched = applyApiKeyServiceTierResolverPatch(current);
  const partial = patched.slice(patched.indexOf("function kH"));
  const descriptor = descriptors.find(({ id }) => id === "api-key-service-tier-resolver");

  assert.equal(descriptor.assetMatch(current), true);
  assert.equal(descriptor.assetMatch(patched), true);
  for (const source of [current + other, current + patched, patched + patched, partial]) {
    assert.equal(descriptor.assetMatch(source), false);
    assert.equal(applyApiKeyServiceTierResolverPatch(source), source);
    assert.equal(applyCurrentResolverPatch(source), source);
  }
});

test("fallback fast tier leaves the asset byte-identical when one insertion point drifts", () => {
  const source = [
    "function Tdt(e){return e?.serviceTiers??[]}",
  ].join("");

  assert.deepEqual(captureWarnings(() => {
    assert.equal(applyCurrentFallbackFastTierPatch(source), source);
  }), [
    "WARN: Could not find service tier option helpers - skipping API key fallback fast tier patch",
  ]);
});

test("fallback fast tier rejects ambiguous, mixed, and semantic near-miss options", () => {
  const descriptor = descriptors.find(({ id }) => id === "api-key-service-tier-fallback");
  const current =
    "function pNr(e,t){return[gQ,...(t??[]).map(t=>({description:eEe(t),iconKind:fQ(t.id,t.name),label:$Te(t),tier:t,value:t.id}))]}";
  const patched = applyFallbackFastTierPatch(current);
  const nearMiss =
    "function telemetry(e,t){return[...(t??[]).map(t=>{audit(t);return{tier:t,value:t.id}})]}";
  const partial = current.replace("label:$Te(t),", "");
  const retired =
    "function tEe(e){return[gQ,...(e?.serviceTiers??[]).map(t=>({description:eEe(t),iconKind:fQ(t.id,t.name),label:$Te(t),tier:t,value:t.id}))]}";

  for (const source of [current + current, patched + current, nearMiss, partial, retired]) {
    assert.equal(applyFallbackFastTierPatch(source), source);
    assert.equal(descriptor.assetMatch(source), false);
  }
});

test("fallback fast tier accepts the current official callback-body contract", () => {
  const source =
    "function pNr(e,t){return[gQ,...(t??[]).map(t=>{let n=fQ(t.id,t.name),r=n===`fast`?1.5:null;return{description:eEe(t,r),iconKind:n,label:$Te(t),speedMultiplier:r,tier:t,value:t.id}})]}";
  const patched = applyFallbackFastTierPatch(source);

  const descriptor = descriptors.find(({ id }) => id === "api-key-service-tier-fallback");
  assert.equal(descriptor.assetMatch(source), true);
  assert.notEqual(patched, source);
  assert.equal(descriptor.assetMatch(patched), true);
  assert.equal(applyFallbackFastTierPatch(patched), patched);
});

test("fallback descriptor reports skipped when one insertion point drifts", () => {
  withFeatureConfig(["api-key-service-tier"], () => {
    const tempApp = fs.mkdtempSync(path.join(os.tmpdir(), "api-key-service-tier-fallback-drift-"));
    try {
      const assetsDir = path.join(tempApp, "webview", "assets");
      const targetPath = path.join(
        assetsDir,
        "app-initial-fallback-drifted.js",
      );
      const source = [
        "function Tdt(e){return e?.serviceTiers??[]}",
      ].join("");
      fs.mkdirSync(assetsDir, { recursive: true });
      fs.writeFileSync(targetPath, source);

      const report = createPatchReport();
      const warnings = captureWarnings(() => patchExtractedApp(tempApp, { report }));
      const fallback = report.patches.find(
        (entry) => entry.name === "feature:api-key-service-tier:api-key-service-tier-fallback",
      );

      assert.ok(warnings.some((warning) => warning.includes("current API key service tier fallback bundle")));
      assert.equal(fallback?.status, "skipped-optional");
      assert.equal(fs.readFileSync(targetPath, "utf8"), source);
    } finally {
      fs.rmSync(tempApp, { recursive: true, force: true });
    }
  });
});

test("combined patch updates both service tier gate and fallback options", () => {
  const source = [
    "function sxe(e){let t=(0,cxe.c)(6),n=X(os),r=e?.hostId??n,i=Cf(r),a=i?.authMethod===`chatgpt`,o=i?.authMethod??null,s;t[0]!==r||t[1]!==o?(s={authMethod:o,hostId:r},t[0]=r,t[1]=o,t[2]=s):s=t[2];let{data:c,isPending:l}=ye(is,s),u=!!i?.isLoading||a&&l,d=a&&!u&&c!=null&&c?.requirements?.featureRequirements?.fast_mode!==!1,f;return t[3]!==u||t[4]!==d?(f={isServiceTierAllowed:d,isLoading:u},t[3]=u,t[4]=d,t[5]=f):f=t[5],f}",
    currentModelFixture(),
    "function pNr(e,t){return[gQ,...(t??[]).map(t=>({description:eEe(t),iconKind:fQ(t.id,t.name),label:$Te(t),tier:t,value:t.id}))]}",
  ].join("");

  const patched = applyPatchTwice(applyApiKeyServiceTierPatch, source);

  assert.match(patched, /o===`apikey`/);
  assert.match(patched, /codexLinuxApiKeyServiceTierModel:t===`apikey`/);
  assert.match(patched, /e\?\.codexLinuxApiKeyServiceTierModel!==!0\?null/);
  assert.match(patched, /function codexLinuxApiKeyFastTier\(e\)/);
});
