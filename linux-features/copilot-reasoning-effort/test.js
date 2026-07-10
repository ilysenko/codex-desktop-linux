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
  applyCopilotReasoningEffortModelListPatch,
  applyCopilotReasoningEffortSettingsPatch,
  applyCopilotReasoningEffortUiPatch,
} = require("./patch.js");

function applyPatchTwice(patchFn, source) {
  const patched = patchFn(source);
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

function copilotReasoningEffortSettingsFixture() {
  return [
    "function bwe(){let e=(0,Y.c)(3),t=wr(),{data:n,isLoading:r}=or(`copilot-default-model`),i=n??t.defaultModel,a;return e[0]!==r||e[1]!==i?(a={model:i,reasoningEffort:`medium`,profile:null,isLoading:r},e[0]=r,e[1]=i,e[2]=a):a=e[2],a}",
    "function $9(e=null){let t=j(fe),m=a?.authMethod===`copilot`,g=(0,q.useCallback)(async(t,n)=>!1,[]),c={profile:null},i=!0,r=`local`,s=`/tmp`,v=()=>{},y=()=>{};return{setModelAndReasoningEffort:(0,q.useCallback)(async(e,n)=>{try{if(await g(e,n))return;if(m){await Jn(t,`copilot-default-model`,e,{throwOnFailure:!0});return}if(h.info(`Setting default model and reasoning effort`,{safe:{newModel:e,newEffort:n,profile:c.profile}}),!i)throw Error(`Model settings host is unavailable`);await Gt(`set-default-model-config-for-host`,{hostId:r,model:e,reasoningEffort:n,profile:c.profile}),await v(),await t.query.fetch(Ss,{hostId:r,cwd:s})}catch(e){y(e)}},[m,g,c.profile,v,i,r,t,y,s])}}",
  ].join("");
}

function currentFilteredCopilotReasoningEffortModelListFixture() {
  return "function Jv({authMethod:e,availableModels:t,defaultModel:n,enabledReasoningEfforts:r,includeUltraReasoningEffort:i,models:a,useHiddenModels:o}){let s=[],c=null,l=o&&e!==`amazonBedrock`,u=a.some(e=>e.supportedReasoningEfforts.some(({reasoningEffort:e})=>e===`max`)),d=i&&a.some(e=>e.supportedReasoningEfforts.some(({reasoningEffort:e})=>e===`ultra`));return a.forEach(n=>{if(l?t.has(n.model):!n.hidden){let t=i?n.supportedReasoningEfforts:n.supportedReasoningEfforts.filter(({reasoningEffort:e})=>e!==`ultra`),a=(e===`copilot`?[t.find(e=>e.reasoningEffort===`medium`)??{reasoningEffort:`medium`,description:`medium effort`}]:t).filter(({reasoningEffort:e})=>vg(e)&&r.has(e)),o={...n,supportedReasoningEfforts:a};s.push(o),n.isDefault&&(c=o)}}),c??=s.find(e=>e.model===n)??null,{models:s,defaultModel:c,hasModelSupportingMaxReasoningEffort:u,hasModelSupportingUltraReasoningEffort:d}}";
}

function currentCopilotReasoningEffortUiFixture() {
  return [
    "function dz(){let k=!Bm(u),A=a?.authMethod===`copilot`,j=!k&&!A,M=yh(d,m);return aO(`composer.increaseReasoningEffort`,()=>we(`increase`),{enabled:j}),(0,gz.jsx)(_m,{reasoningEffortDisabled:A})}",
    "function unrelatedGate(){let q=a&&b&&!0,c;return q}",
    "function uU(){let p=o?.authMethod===`copilot`;let E=i.formatMessage({id:`composer.reasoningSlashCommand.title`});let O=s&&f&&!p&&!0,k;return{enabled:O,dependencies:k}}",
    "function permissionGate(){let A=O.length>0,j=!w&&!A;return{shouldAutoDenyPermissionRequest:j}}",
  ].join("");
}

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-copilot-reasoning-feature-"));
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

function writeAsset(extractedDir, name, source) {
  const assetsDir = path.join(extractedDir, "webview", "assets");
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.writeFileSync(path.join(assetsDir, name), source);
}

function readAsset(extractedDir, name) {
  return fs.readFileSync(path.join(extractedDir, "webview", "assets", name), "utf8");
}

test("persists Copilot reasoning effort with the default Copilot model", () => {
  const patched = applyPatchTwice(
    applyCopilotReasoningEffortSettingsPatch,
    copilotReasoningEffortSettingsFixture(),
  );

  assert.match(patched, /or\(`copilot-default-reasoning-effort`\)/);
  assert.match(patched, /reasoningEffort:codexCopilotReasoningEffortValue/);
  assert.match(patched, /isLoading:r\|\|codexCopilotReasoningEffortLoading/);
  assert.match(
    patched,
    /await Jn\(t,`copilot-default-model`,e,\{throwOnFailure:!0\}\);await Jn\(t,`copilot-default-reasoning-effort`,n,\{throwOnFailure:!0\}\);return/,
  );
  assert.doesNotMatch(patched, /reasoningEffort:`medium`,profile:null,isLoading:r/);
  assert.doesNotMatch(patched, /await Jn\(t,`copilot-default-model`,e,\{throwOnFailure:!0\}\);return/);
});

test("keeps filtered current app reasoning efforts for Copilot auth", () => {
  const patched = applyPatchTwice(
    applyCopilotReasoningEffortModelListPatch,
    currentFilteredCopilotReasoningEffortModelListFixture(),
  );

  assert.match(patched, /let t=i\?n\.supportedReasoningEfforts:n\.supportedReasoningEfforts\.filter/);
  assert.match(patched, /a=\[\.\.\.t\]\.filter\(\(\{reasoningEffort:e\}\)=>vg\(e\)&&r\.has\(e\)\)/);
  assert.doesNotMatch(patched, /e===`copilot`\?\[/);
  assert.doesNotMatch(patched, /description:`medium effort`/);
  const { value, warnings } = withCapturedWarns(() =>
    applyCopilotReasoningEffortModelListPatch(patched),
  );
  assert.equal(value, patched);
  assert.deepEqual(warnings, []);
});

test("allows Copilot auth to use the current app effort controls", () => {
  const patched = applyPatchTwice(
    applyCopilotReasoningEffortUiPatch,
    currentCopilotReasoningEffortUiFixture(),
  );

  assert.match(patched, /A=a\?\.authMethod===`copilot`,j=!k,M=/);
  assert.match(patched, /reasoningEffortDisabled:!1/);
  assert.match(patched, /let E=i\.formatMessage\(\{id:`composer\.reasoningSlashCommand\.title`\}\);let O=s&&f&&!0,k;/);
  assert.doesNotMatch(patched, /j=!k&&!A/);
  assert.doesNotMatch(patched, /reasoningEffortDisabled:A/);
  assert.doesNotMatch(patched, /O=s&&f&&!p&&!0/);
  assert.match(patched, /let q=a&&b&&!0,c/);
  assert.match(patched, /A=O\.length>0,j=!w&&!A/);
});

test("current app UI drift warns without touching adjacent gates", () => {
  const source = [
    "function dz(){let k=!Bm(u),A=isCopilot(a),j=!k&&!A,M=yh(d,m);",
    "return aO(`composer.increaseReasoningEffort`,()=>we(`increase`),{enabled:j}),",
    "(0,gz.jsx)(_m,{reasoningEffortDisabled:A})}",
    "function permissionGate(){let A=O.length>0,j=!w&&!A;return j}",
  ].join("");
  const { value, warnings } = withCapturedWarns(() =>
    applyCopilotReasoningEffortUiPatch(source),
  );

  assert.equal(value, source);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /current Copilot reasoning effort shortcut gate/);
  assert.match(value, /A=O\.length>0,j=!w&&!A/);
});

test("feature descriptor loader exposes the Copilot webview asset patches only when enabled", () => {
  const featuresRoot = path.resolve(__dirname, "..");

  withTempFeatureConfig([], () => {
    assert.deepEqual(loadLinuxFeaturePatchDescriptors({ featuresRoot }), []);
  });

  withTempFeatureConfig(["copilot-reasoning-effort"], () => {
    const descriptors = loadLinuxFeaturePatchDescriptors({ featuresRoot });

    assert.deepEqual(
      descriptors.map((descriptor) => descriptor.id),
      [
        "feature:copilot-reasoning-effort:settings",
        "feature:copilot-reasoning-effort:model-list",
        "feature:copilot-reasoning-effort:ui",
      ],
    );
    assert.deepEqual(
      descriptors.map((descriptor) => descriptor.phase),
      ["webview-asset", "webview-asset", "webview-asset"],
    );
    assert.ok(descriptors.every((descriptor) => descriptor.ciPolicy === "optional"));
    const currentSettingsChunk =
      "app-initial~app-main~onboarding-page~hotkey-window-thread-page~quick-chat-window-page~chatg~k0ede4gb-current.js";
    const currentUiChunk =
      "app-initial~app-main~new-thread-panel-page~appgen-library-page~hotkey-window-thread-page~ho~iufn7mg3-current.js";
    assert.match(currentSettingsChunk, descriptors[0].pattern);
    assert.match(currentSettingsChunk, descriptors[1].pattern);
    assert.match(currentUiChunk, descriptors[2].pattern);
    assert.ok(descriptors.every((descriptor) => !descriptor.pattern.test("unrelated-bundle.js")));
  });
});

test("enabled feature descriptors patch the current app settings chunk", () => {
  const featuresRoot = path.resolve(__dirname, "..");
  const currentSettingsChunk =
    "app-initial~app-main~onboarding-page~hotkey-window-thread-page~quick-chat-window-page~chatg~k0ede4gb-C17KDkOa.js";
  const currentUiChunk =
    "app-initial~app-main~new-thread-panel-page~appgen-library-page~hotkey-window-thread-page~ho~iufn7mg3-Cdmi2Vi6.js";

  withTempFeatureConfig(["copilot-reasoning-effort"], () => {
    withTempDir((extractedDir) => {
      writeAsset(
        extractedDir,
        currentSettingsChunk,
        `${copilotReasoningEffortSettingsFixture()};${currentFilteredCopilotReasoningEffortModelListFixture()}`,
      );
      writeAsset(extractedDir, currentUiChunk, currentCopilotReasoningEffortUiFixture());

      const descriptors = normalizePatchDescriptors(
        loadLinuxFeaturePatchDescriptors({ featuresRoot }),
      );
      applyWebviewAssetPatchDescriptors(extractedDir, descriptors, {}, null);
      const patched = readAsset(extractedDir, currentSettingsChunk);

      assert.match(patched, /copilot-default-reasoning-effort/);
      assert.match(patched, /a=\[\.\.\.t\]\.filter/);
      assert.doesNotMatch(patched, /e===`copilot`\?\[/);
      assert.match(readAsset(extractedDir, currentUiChunk), /reasoningEffortDisabled:!1/);
      assert.match(readAsset(extractedDir, currentUiChunk), /O=s&&f&&!0,k/);
    });
  });
});
