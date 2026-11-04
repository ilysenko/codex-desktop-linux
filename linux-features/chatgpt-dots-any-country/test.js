#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const { loadLinuxFeaturePatchDescriptors } = require("../../scripts/lib/linux-features.js");
const { applyWebviewAssetPatchDescriptors, normalizePatchDescriptors } = require("../../scripts/patches/engine.js");
const { captureWarnings, createPatchReport } = require("../../scripts/lib/patch-report.js");
const {
  CONTRACTS,
  applyDotsAppSharedPatch,
  applyDotsLandingRoutePatch,
  applyDotsPersonalizationPatch,
  descriptors,
} = require("./patch.js");

// Reduced rspack chunks shaped like the signed stable Linux 26.1029 webview.
const chunk = (id, body) => `export const __rspack_esm_id=${id};export const __rspack_esm_ids=[${id}];` +
  `export const __webpack_modules__={${body}};`;
const LANDING_ROUTE = 'function route(account,status){if("pending"===status)return"loading";if("error"===status||account?.tbo_config?.tbo_available==null||null==account.structure||null==account.plan_type)return"load-error";if(account.tbo_config.tbo_available){return"enter"}return"unavailable"}';
const FIXTURES = {
  "async/221857.4c17f751f6.js": chunk(221857, `Ab12(e,t,n){${LANDING_ROUTE}}`),
  "async/24191.7b05d5cf83.js": chunk(24191, 'Cd34(e,t,n){function capable(){if(e.query.getData(s.sE,t)?.accounts[t]?.account.tbo_config?.tbo_available!==!0)throw Error();let capable="success"===r&&n?.accounts[t]?.account.tbo_config?.tbo_available===!0;return capable||"error"===l&&r?.accounts[n]?.account.tbo_config?.tbo_available===!0}}'),
  "async/860646.06b6da0005.js": chunk(860646, 'Ef56(e,t,n){first?.accounts[M]?.account.tbo_config?.tbo_available!==!0; second?.accounts[c]?.account.tbo_config?.tbo_available!==!0;}'),
};


function withFeatureConfig(enabled, fn) {
  const originalConfig = process.env.CODEX_LINUX_FEATURES_CONFIG;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatgpt-dots-any-country-"));
  process.env.CODEX_LINUX_FEATURES_CONFIG = path.join(tempDir, "features.json");
  try {
    fs.writeFileSync(process.env.CODEX_LINUX_FEATURES_CONFIG, JSON.stringify({ enabled }));
    return fn();
  } finally {
    if (originalConfig == null) delete process.env.CODEX_LINUX_FEATURES_CONFIG;
    else process.env.CODEX_LINUX_FEATURES_CONFIG = originalConfig;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

test("feature is disabled until selected", () => {
  const featuresRoot = path.resolve(__dirname, "..");
  withFeatureConfig([], () => {
    assert.equal(
      loadLinuxFeaturePatchDescriptors({ featuresRoot })
        .some((descriptor) => descriptor.id.startsWith("feature:chatgpt-dots-any-country:")),
      false,
    );
  });
  withFeatureConfig(["chatgpt-dots-any-country"], () => {
    assert.deepEqual(
      loadLinuxFeaturePatchDescriptors({ featuresRoot })
        .filter((descriptor) => descriptor.id.startsWith("feature:chatgpt-dots-any-country:"))
        .map((descriptor) => descriptor.id),
      [
        "feature:chatgpt-dots-any-country:dots-landing-route",
        "feature:chatgpt-dots-any-country:dots-app-shared-capability",
        "feature:chatgpt-dots-any-country:dots-personalization-capability",
      ],
    );
  });
});

test("landing route stays visible while preserving the server gate and missing-config safety", () => {
  const patched = applyDotsLandingRoutePatch(LANDING_ROUTE);
  assert.doesNotMatch(patched, /tbo_available==null/);
  assert.match(patched,/if\(account\.tbo_config\.tbo_available\)/);
  assert.equal(applyDotsLandingRoutePatch(patched),patched);
  const route=vm.runInNewContext(patched+";route");
  const account={structure:"personal",plan_type:"plus"};
  for(const tbo_config of [{},{tbo_available:null},{tbo_available:false}]) assert.equal(route({...account,tbo_config}),"unavailable");
  assert.equal(route({...account,tbo_config:{tbo_available:true}}),"enter");
  assert.equal(route(undefined),"load-error");
  assert.equal(route(account),"load-error");
  assert.equal(route({...account,tbo_config:null}),"load-error");
  assert.equal(route({...account,tbo_config:{}},"error"),"load-error");
  assert.equal(route(undefined,"pending"),"loading");
});

test("landing recognizes only a complete original or marked applied contract", () => {
  const patched=applyDotsLandingRoutePatch(LANDING_ROUTE),descriptor=descriptors[0];
  assert.equal(descriptor.assetMatch(LANDING_ROUTE),true);
  assert.equal(descriptor.assetMatch(patched),true);
  assert.ok(descriptor.assetNeedles.every(needle=>LANDING_ROUTE.includes(needle)&&patched.includes(needle)));
  const repeated=captureWarnings(()=>applyDotsLandingRoutePatch(patched));
  assert.equal(repeated.value,patched);assert.deepEqual(repeated.warnings,[]);
  for(const source of ["",LANDING_ROUTE+LANDING_ROUTE,LANDING_ROUTE+patched,patched+patched,
    patched.replace("/*codexDotsLandingRoute*/",""),
    patched.replace("?.tbo_config==null/*codexDotsLandingRoute*/","!1/*codexDotsLandingRoute*/"),
    LANDING_ROUTE.replace("if(account.tbo_config.tbo_available){","if(false){"),
    LANDING_ROUTE.replace("null==account.plan_type","null==other.plan_type")]){
    const result=captureWarnings(()=>applyDotsLandingRoutePatch(source));
    assert.equal(result.value,source);assert.equal(result.warnings.length,1);
  }
});

test("landing production discovery keeps stable needles through the second run and rejects ambiguity", () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"dots-landing-rspack-"));
  try{
    const assets=path.join(root,"webview/assets/async");fs.mkdirSync(assets,{recursive:true});
    const file=path.join(assets,"221857.current.js"),descriptor=normalizePatchDescriptors([descriptors[0]]);
    fs.writeFileSync(file,FIXTURES["async/221857.4c17f751f6.js"]);
    for(const expected of ["applied","already-applied"]){
      const report=createPatchReport();applyWebviewAssetPatchDescriptors(root,descriptor,{},report);
      assert.equal(report.patches[0].status,expected);
      assert.equal(report.patches[0].assetName,"async/221857.current.js");
      assert.ok(descriptors[0].assetNeedles.every(needle=>fs.readFileSync(file,"utf8").includes(needle)));
    }
    const duplicate=path.join(assets,"duplicate.current.js");fs.copyFileSync(file,duplicate);
    const before=fs.readFileSync(file,"utf8"),report=createPatchReport();
    captureWarnings(()=>applyWebviewAssetPatchDescriptors(root,descriptor,{},report));
    assert.equal(report.patches[0].status,"skipped-optional");
    assert.equal(fs.readFileSync(file,"utf8"),before);assert.equal(fs.readFileSync(duplicate,"utf8"),before);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test("shared Dots capability checks no longer reject a country-gated account", () => {
  const patched = applyDotsAppSharedPatch(FIXTURES["async/24191.7b05d5cf83.js"]);
  assert.ok(patched.includes('function capable(){if(!1)throw Error();let capable="success"===r&&!0;return capable||"error"===l&&!0}'));
  assert.doesNotMatch(patched, /\?\.[!01]/);
  assert.equal(applyDotsAppSharedPatch(patched), patched);
});

test("personalization Dots checks are patched together", () => {
  const patched = applyDotsPersonalizationPatch(FIXTURES["async/860646.06b6da0005.js"]);
  assert.ok(patched.includes("{!1; !1;}"));
  assert.doesNotMatch(patched, /\?\.[!01]/);
  assert.equal(applyDotsPersonalizationPatch(patched), patched);
});

test("ambiguous contracts fail closed", () => {
  const source = "a?.tbo_config?.tbo_available==null;b?.tbo_config?.tbo_available==null";
  assert.equal(applyDotsLandingRoutePatch(source), source);
});

test("each descriptor patches its current rspack chunk contract", () => {
  const extractedDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatgpt-dots-any-country-assets-"));
  const assetsDir = path.join(extractedDir, "webview", "assets");
  fs.mkdirSync(path.join(assetsDir, "async"), { recursive: true });
  try {
    for (const [name, source] of Object.entries(FIXTURES)) fs.writeFileSync(path.join(assetsDir, name), source);
    const report = createPatchReport();
    applyWebviewAssetPatchDescriptors(extractedDir, normalizePatchDescriptors(descriptors), {}, report);
    assert.deepEqual(report.patches.map(({ status }) => status), ["applied", "applied", "applied"]);
    assert.deepEqual(report.patches.map(({ assetName }) => assetName), Object.keys(FIXTURES));
    for (const name of Object.keys(FIXTURES)) {
      assert.doesNotMatch(fs.readFileSync(path.join(assetsDir, name), "utf8"), /tbo_available(?:==null|[!=]==!0)/);
    }
  } finally {
    fs.rmSync(extractedDir, { recursive: true, force: true });
  }
});

const signedApp = process.env.CODEX_SIGNED_EXTRACTED_APP;
test("the signed official webview has one pristine chunk per Dots contract", { skip: signedApp == null }, () => {
  const { findWebviewAssetsContaining } = require("../../scripts/patches/lib/assets.js");
  for (const descriptor of descriptors) {
    const matches = findWebviewAssetsContaining(signedApp, descriptor.assetNeedles).filter((name) =>
      descriptor.assetMatch(fs.readFileSync(path.join(signedApp, "webview", "assets", name), "utf8")));
    assert.equal(matches.length, 1, descriptor.id);
  }
});

test("signed landing owner patches through the production descriptor twice without changing inputs", {skip:!signedApp}, () => {
  const {findWebviewAssetsContaining}=require("../../scripts/patches/lib/assets.js");
  const descriptor=descriptors[0],assets=path.join(signedApp,"webview/assets");
  const owners=findWebviewAssetsContaining(signedApp,descriptor.assetNeedles)
    .map(assetName=>({assetName,source:fs.readFileSync(path.join(assets,assetName),"utf8")}))
    .filter(({source})=>descriptor.assetMatch(source));
  assert.equal(owners.length,1);const[owner]=owners;
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"dots-landing-signed-"));
  try{
    const target=path.join(root,"webview/assets",owner.assetName);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,owner.source);
    for(const expected of ["applied","already-applied"]){
      const report=createPatchReport();applyWebviewAssetPatchDescriptors(root,normalizePatchDescriptors([descriptor]),{},report);
      assert.equal(report.patches[0].status,expected);assert.equal(report.patches[0].assetName,owner.assetName);
    }
    assert.equal(fs.readFileSync(path.join(assets,owner.assetName),"utf8"),owner.source);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
