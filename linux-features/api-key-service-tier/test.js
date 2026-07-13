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
  applyCurrentGatePatch,
  applyCurrentModelPatch,
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
        ["feature:api-key-service-tier:api-key-service-tier-fallback", "webview-asset", "optional"],
      ],
    );
  });
});

test("current DMG descriptors target the three owning app bundles", () => {
  assert.deepEqual(
    descriptors.map((descriptor) => descriptor.id),
    [
      "api-key-service-tier-gate",
      "api-key-service-tier-model",
      "api-key-service-tier-fallback",
    ],
  );
  assert.equal(
    descriptors[0].pattern.test("app-initial~app-main~onboarding-page-DjTNhJXu.js"),
    true,
  );
  assert.equal(
    descriptors[1].pattern.test(
      "app-initial~app-main~hotkey-window-thread-page~keyboard-shortcuts-settings~thread-app-shell~cf704xib-BpnUyB2R.js",
    ),
    true,
  );
  assert.equal(
    descriptors[2].pattern.test(
      "app-initial~app-main~quick-chat-window-page~work-home-page~chatgpt-conversation-page-BqLP6EDd.js",
    ),
    true,
  );
  assert.equal(
    descriptors.some((descriptor) =>
      descriptor.pattern.test(
        "app-initial~app-main~onboarding-page~hotkey-window-thread-page~quick-chat-window-page~chatg~k0ede4gb-C17KDkOa.js",
      ),
    ),
    false,
  );
  assert.equal(
    descriptors.some((descriptor) =>
      descriptor.pattern.test(
        "app-initial~app-main~pull-request-code-review~onboarding-page~hotkey-window-thread-page~cha~b76hmflu-y0KJWbm3.js",
      ),
    ),
    false,
  );
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
        path.join(assetsDir, "app-initial~app-main~onboarding-page-drifted.js"),
        "function driftedGate(){return `priority_mode`}",
      );
      fs.writeFileSync(
        path.join(
          assetsDir,
          "app-initial~app-main~hotkey-window-thread-page~keyboard-shortcuts-settings~thread-app-shell~cf704xib-current.js",
        ),
        "function vbe({authMethod:e,availableModels:t,defaultModel:n,enabledReasoningEfforts:r,includeUltraReasoningEffort:i,models:a,useHiddenModels:o}){let s=[],c=null,l=o&&e!==`amazonBedrock`,u=a.some(e=>e.supportedReasoningEfforts.some(({reasoningEffort:e})=>e===`max`)),d=i&&a.some(e=>e.supportedReasoningEfforts.some(({reasoningEffort:e})=>e===`ultra`));return a.forEach(n=>{if(l?t.has(n.model):!n.hidden){let t=i?n.supportedReasoningEfforts:n.supportedReasoningEfforts.filter(({reasoningEffort:e})=>e!==`ultra`),a=(e===`copilot`?[t.find(e=>e.reasoningEffort===`medium`)??{reasoningEffort:`medium`,description:`medium effort`}]:t).filter(({reasoningEffort:e})=>Gx(e)&&r.has(e)),o={...n,supportedReasoningEfforts:a};s.push(o),n.isDefault&&(c=o)}}),c??=s.find(e=>e.model===n)??null,{models:s,defaultModel:c}}",
      );
      fs.writeFileSync(
        path.join(
          assetsDir,
          "app-initial~app-main~quick-chat-window-page~work-home-page~chatgpt-conversation-page-current.js",
        ),
        [
          "let defaultServiceTier=null;",
          "function pQ(e,t){return t==null?null:t===`fast`?mQ(e):e?.serviceTiers?.find(e=>e.id===t)??null}",
          "function tEe(e){return[{description:yQ.standardDescription,iconKind:null,label:yQ.standardLabel,tier:null,value:null},...(e?.serviceTiers??[]).map(e=>({description:eEe(e),iconKind:fQ(e.id,e.name),label:$Te(e),tier:e,value:e.id}))]}",
          "function mQ(e){return e?.serviceTiers?.find(e=>fQ(e.id,e.name)===`fast`||e.name.trim().toLowerCase()===`priority`)??null}",
        ].join(""),
      );

      const report = createPatchReport();
      const warnings = captureWarnings(() => patchExtractedApp(tempApp, { report }));
      const gate = report.patches.find(
        (entry) => entry.name === "feature:api-key-service-tier:api-key-service-tier-gate",
      );
      const model = report.patches.find(
        (entry) => entry.name === "feature:api-key-service-tier:api-key-service-tier-model",
      );
      const fallback = report.patches.find(
        (entry) => entry.name === "feature:api-key-service-tier:api-key-service-tier-fallback",
      );

      assert.ok(warnings.some((warning) => warning.includes("current service tier auth gate")));
      assert.equal(gate?.status, "skipped-optional");
      assert.equal(model?.status, "applied");
      assert.equal(fallback?.status, "applied");
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
      const fallback = report.patches.find(
        (entry) => entry.name === "feature:api-key-service-tier:api-key-service-tier-fallback",
      );

      assert.ok(warnings.some((warning) => warning.includes("current API key service tier gate bundle")));
      assert.ok(warnings.some((warning) => warning.includes("current API key service tier model bundle")));
      assert.ok(warnings.some((warning) => warning.includes("current API key service tier fallback bundle")));
      assert.equal(gate?.status, "skipped-optional");
      assert.equal(model?.status, "skipped-optional");
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
  const source =
    "function vbe({authMethod:e,availableModels:t,defaultModel:n,enabledReasoningEfforts:r,includeUltraReasoningEffort:i,models:a,useHiddenModels:o}){let s=[],c=null,l=o&&e!==`amazonBedrock`,u=a.some(e=>e.supportedReasoningEfforts.some(({reasoningEffort:e})=>e===`max`)),d=i&&a.some(e=>e.supportedReasoningEfforts.some(({reasoningEffort:e})=>e===`ultra`));return a.forEach(n=>{if(l?t.has(n.model):!n.hidden){let t=i?n.supportedReasoningEfforts:n.supportedReasoningEfforts.filter(({reasoningEffort:e})=>e!==`ultra`),a=(e===`copilot`?[t.find(e=>e.reasoningEffort===`medium`)??{reasoningEffort:`medium`,description:`medium effort`}]:t).filter(({reasoningEffort:e})=>Gx(e)&&r.has(e)),o={...n,supportedReasoningEfforts:a};s.push(o),n.isDefault&&(c=o)}}),c??=s.find(e=>e.model===n)??null,{models:s,defaultModel:c}}";

  assert.equal(hasApiKeyModelListMappingShape(source), true);

  const patched = applyPatchTwice(applyApiKeyModelMarkerPatch, source);

  assert.match(patched, /o=\{\.\.\.n,supportedReasoningEfforts:a,codexLinuxApiKeyServiceTierModel:e===`apikey`\}/);
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

test("model list marker warning still reports a recognizable unpatchable mapping", () => {
  const source =
    "function broken({authMethod:e,availableModels:t,defaultModel:n,enabledReasoningEfforts:r,includeUltraReasoningEffort:i,models:a,useHiddenModels:o}){return a.map(e=>({supportedReasoningEfforts:e.supportedReasoningEfforts,isDefault:e.isDefault}))}";

  assert.equal(hasApiKeyModelListMappingShape(source), true);
  assert.deepEqual(captureWarnings(() => {
    assert.equal(applyApiKeyModelMarkerPatch(source), source);
  }), ["WARN: Could not find model list mapping - skipping API key model service tier marker patch"]);
});

test("fallback fast tier is synthesized only for API-key model catalog entries", () => {
  const source = [
    "function pQ(e,t){return t==null?null:t===`fast`?mQ(e):e?.serviceTiers?.find(e=>e.id===t)??null}",
    "function tEe(e){return[{description:yQ.standardDescription,iconKind:null,label:yQ.standardLabel,tier:null,value:null},...(e?.serviceTiers??[]).map(e=>({description:eEe(e),iconKind:fQ(e.id,e.name),label:$Te(e),tier:e,value:e.id}))]}",
    "function nEe(e,t,n){return e?.find(e=>e.model===t&&hQ(e,n))??null}",
    "function mQ(e){return e?.serviceTiers?.find(e=>fQ(e.id,e.name)===`fast`||e.name.trim().toLowerCase()===`priority`)??null}",
  ].join("");

  const patched = applyPatchTwice(applyFallbackFastTierPatch, source);

  assert.match(patched, /function codexLinuxApiKeyFastTier\(e\)/);
  assert.match(patched, /e\?\.codexLinuxApiKeyServiceTierModel!==!0\?null/);
  assert.match(patched, /codexLinuxApiKeyFastTier\(e\)/);
  assert.match(patched, /\?e\.serviceTiers:\[codexLinuxApiKeyFastTier\(e\)\]\)\.filter\(Boolean\)\)\.map/);
  assert.doesNotMatch(patched, /\(e\?\.serviceTiers\?\?\[\]\)\.map/);
  assert.doesNotMatch(patched, /\)\?\?null\}function nEe/);
});

test("fallback fast tier leaves the asset byte-identical when one insertion point drifts", () => {
  const source = [
    "let defaultServiceTier=null;",
    "function Tdt(e,t){return t==null?null:t===`fast`?Odt(e):e?.serviceTiers?.find(e=>e.id===t)??null}",
    "function Odt(e){return e?.serviceTiers?.find(e=>gz(e.id,e.name)===`fast`||e.name.trim().toLowerCase()===`priority`)??null}",
  ].join("");

  assert.deepEqual(captureWarnings(() => {
    assert.equal(applyCurrentFallbackFastTierPatch(source), source);
  }), [
    "WARN: Could not apply all current service tier option helpers - skipping API key fallback fast tier patch",
  ]);
});

test("fallback descriptor reports skipped when one insertion point drifts", () => {
  withFeatureConfig(["api-key-service-tier"], () => {
    const tempApp = fs.mkdtempSync(path.join(os.tmpdir(), "api-key-service-tier-fallback-drift-"));
    try {
      const assetsDir = path.join(tempApp, "webview", "assets");
      const targetPath = path.join(
        assetsDir,
        "app-initial~app-main~quick-chat-window-page~work-home-page~chatgpt-conversation-page-drifted.js",
      );
      const source = [
        "let defaultServiceTier=null;",
        "function Tdt(e,t){return t==null?null:t===`fast`?Odt(e):e?.serviceTiers?.find(e=>e.id===t)??null}",
        "function Odt(e){return e?.serviceTiers?.find(e=>gz(e.id,e.name)===`fast`||e.name.trim().toLowerCase()===`priority`)??null}",
      ].join("");
      fs.mkdirSync(assetsDir, { recursive: true });
      fs.writeFileSync(targetPath, source);

      const report = createPatchReport();
      const warnings = captureWarnings(() => patchExtractedApp(tempApp, { report }));
      const fallback = report.patches.find(
        (entry) => entry.name === "feature:api-key-service-tier:api-key-service-tier-fallback",
      );

      assert.ok(warnings.some((warning) => warning.includes("all current service tier option helpers")));
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
    "function vbe({authMethod:e,availableModels:t,defaultModel:n,enabledReasoningEfforts:r,includeUltraReasoningEffort:i,models:a,useHiddenModels:o}){let s=[],c=null,l=o&&e!==`amazonBedrock`,u=a.some(e=>e.supportedReasoningEfforts.some(({reasoningEffort:e})=>e===`max`)),d=i&&a.some(e=>e.supportedReasoningEfforts.some(({reasoningEffort:e})=>e===`ultra`));return a.forEach(n=>{if(l?t.has(n.model):!n.hidden){let t=i?n.supportedReasoningEfforts:n.supportedReasoningEfforts.filter(({reasoningEffort:e})=>e!==`ultra`),a=(e===`copilot`?[t.find(e=>e.reasoningEffort===`medium`)??{reasoningEffort:`medium`,description:`medium effort`}]:t).filter(({reasoningEffort:e})=>Gx(e)&&r.has(e)),o={...n,supportedReasoningEfforts:a};s.push(o),n.isDefault&&(c=o)}}),c??=s.find(e=>e.model===n)??null,{models:s,defaultModel:c}}",
    "function pQ(e,t){return t==null?null:t===`fast`?mQ(e):e?.serviceTiers?.find(e=>e.id===t)??null}",
    "function tEe(e){return[{description:yQ.standardDescription,iconKind:null,label:yQ.standardLabel,tier:null,value:null},...(e?.serviceTiers??[]).map(e=>({description:eEe(e),iconKind:fQ(e.id,e.name),label:$Te(e),tier:e,value:e.id}))]}",
    "function mQ(e){return e?.serviceTiers?.find(e=>fQ(e.id,e.name)===`fast`||e.name.trim().toLowerCase()===`priority`)??null}",
  ].join("");

  const patched = applyPatchTwice(applyApiKeyServiceTierPatch, source);

  assert.match(patched, /o===`apikey`/);
  assert.match(patched, /codexLinuxApiKeyServiceTierModel:e===`apikey`/);
  assert.match(patched, /e\?\.codexLinuxApiKeyServiceTierModel!==!0\?null/);
  assert.match(patched, /function codexLinuxApiKeyFastTier\(e\)/);
});
