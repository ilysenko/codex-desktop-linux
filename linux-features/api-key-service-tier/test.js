#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  loadLinuxFeaturePatchDescriptors,
} = require("../../scripts/lib/linux-features.js");
const {
  applyApiKeyModelMarkerPatch,
  applyApiKeyServiceTierPatch,
  applyApiKeyServiceTierGatePatch,
  applyFallbackFastTierPatch,
  descriptors,
} = require("./patch.js");

function applyPatchTwice(patchFn, source) {
  const once = patchFn(source);
  assert.notEqual(once, source);
  assert.equal(patchFn(once), once);
  return once;
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
      [["feature:api-key-service-tier:api-key-service-tier-ui", "webview-asset", "optional"]],
    );
  });
});

test("descriptor is optional and targets app main webview chunks", () => {
  assert.deepEqual(
    descriptors.map((descriptor) => [descriptor.id, descriptor.phase, descriptor.ciPolicy]),
    [["api-key-service-tier-ui", "webview-asset", "optional"]],
  );
  assert.equal(descriptors[0].pattern.test("app-initial~app-main~onboarding-page-abc.js"), true);
  assert.equal(descriptors[0].pattern.test("settings-page-abc.js"), false);
});

test("service tier auth gate allows API-key hosts while preserving ChatGPT requirements", () => {
  const source =
    "function sxe(e){let t=(0,cxe.c)(6),n=X(os),r=e?.hostId??n,i=Cf(r),a=i?.authMethod===`chatgpt`,o=i?.authMethod??null,s;t[0]!==r||t[1]!==o?(s={authMethod:o,hostId:r},t[0]=r,t[1]=o,t[2]=s):s=t[2];let{data:c,isPending:l}=ye(is,s),u=!!i?.isLoading||a&&l,d=a&&!u&&c!=null&&c?.requirements?.featureRequirements?.fast_mode!==!1,f;return t[3]!==u||t[4]!==d?(f={isServiceTierAllowed:d,isLoading:u},t[3]=u,t[4]=d,t[5]=f):f=t[5],f}";

  const patched = applyPatchTwice(applyApiKeyServiceTierGatePatch, source);

  assert.match(patched, /d=!u&&\(a\?c!=null&&c\?\.requirements\?\.featureRequirements\?\.fast_mode!==!1:o===`apikey`\)/);
  assert.doesNotMatch(patched, /d=a&&!u&&c!=null/);
});

test("model list entries are marked only when loaded for API-key hosts", () => {
  const source =
    "function vbe({authMethod:e,availableModels:t,defaultModel:n,enabledReasoningEfforts:r,includeUltraReasoningEffort:i,models:a,useHiddenModels:o}){let s=[],c=null,l=o&&e!==`amazonBedrock`,u=a.some(e=>e.supportedReasoningEfforts.some(({reasoningEffort:e})=>e===`max`)),d=i&&a.some(e=>e.supportedReasoningEfforts.some(({reasoningEffort:e})=>e===`ultra`));return a.forEach(n=>{if(l?t.has(n.model):!n.hidden){let t=i?n.supportedReasoningEfforts:n.supportedReasoningEfforts.filter(({reasoningEffort:e})=>e!==`ultra`),a=(e===`copilot`?[t.find(e=>e.reasoningEffort===`medium`)??{reasoningEffort:`medium`,description:`medium effort`}]:t).filter(({reasoningEffort:e})=>Gx(e)&&r.has(e)),o={...n,supportedReasoningEfforts:a};s.push(o),n.isDefault&&(c=o)}}),c??=s.find(e=>e.model===n)??null,{models:s,defaultModel:c}}";

  const patched = applyPatchTwice(applyApiKeyModelMarkerPatch, source);

  assert.match(patched, /o=\{\.\.\.n,supportedReasoningEfforts:a,codexLinuxApiKeyServiceTierModel:e===`apikey`\}/);
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
