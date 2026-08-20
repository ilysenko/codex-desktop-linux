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
  matchesCopilotReasoningEffortUiContract,
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

function currentCopilotReasoningEffortSettingsFixture() {
  return [
    "function Va(){let e=(0,Ya.c)(3),t=ua(),{data:n,isLoading:r}=hn(`copilot-default-model`),i=n??t.defaultModel,a;return e[0]!==r||e[1]!==i?(a={model:i,reasoningEffort:`medium`,profile:null,isLoading:r},e[0]=r,e[1]=i,e[2]=a):a=e[2],a}",
    "function currentWriter(){let u=!0,l=!0,n={},m={profile:null},a=`host`,f=`/tmp`,r={cancelQueries:async()=>{},getQueryData:()=>null},E=async()=>!1,ln=async()=>{},za=()=>[],Xe={info:()=>{}},j=()=>{};return async(e,t)=>{let i=null,o;try{if(await E(e,t))return;if(u){await ln(n,`copilot-default-model`,e,{throwOnFailure:!0});return}if(!l)throw Error(`Model settings host is unavailable`);i=za(a,f);let s={hostId:a,cwd:f};await r.cancelQueries({exact:!0,queryKey:i}),o=r.getQueryData(i),Xe.info(`Setting default model and reasoning effort`,{safe:{newModel:e,newEffort:t,profile:m.profile}})}catch(e){j(e)}}}",
  ].join("");
}

function currentFilteredCopilotReasoningEffortModelListFixture() {
  return "function Jv({authMethod:e,availableModels:t,defaultModel:n,enabledReasoningEfforts:r,includeUltraReasoningEffort:i,models:a,useHiddenModels:o}){let s=[],c=null,l=o&&e!==`amazonBedrock`,u=a.some(e=>e.supportedReasoningEfforts.some(({reasoningEffort:e})=>e===`max`)),d=i&&a.some(e=>e.supportedReasoningEfforts.some(({reasoningEffort:e})=>e===`ultra`));return a.forEach(n=>{if(l?t.has(n.model):!n.hidden){let t=i?n.supportedReasoningEfforts:n.supportedReasoningEfforts.filter(({reasoningEffort:e})=>e!==`ultra`),a=(e===`copilot`?[t.find(e=>e.reasoningEffort===`medium`)??{reasoningEffort:`medium`,description:`medium effort`}]:t).filter(({reasoningEffort:e})=>vg(e)&&r.has(e)),o={...n,supportedReasoningEfforts:a};s.push(o),n.isDefault&&(c=o)}}),c??=s.find(e=>e.model===n)??null,{models:s,defaultModel:c,hasModelSupportingMaxReasoningEffort:u,hasModelSupportingUltraReasoningEffort:d}}";
}

function currentCopilotReasoningEffortUiFixture() {
  return [
    "function tHc(){let q=!0,ee=p?.authMethod===`copilot`,te=QRc(j,T),ne=Xic(j),re=$Rc(y.reasoningEffort,te),ie=C?.isModelLocked!==!0&&!q&&!ee&&!0,ae=C?.isModelLocked!==!0&&l!=null&&!q&&g&&!ee&&A!==`error`;let He={enabled:ie};m1(`composer.increaseReasoningEffort`,Ve,He);return jsx(CVc,{reasoningEffortDisabled:ee,showReasoningEffortControls:!0})}",
    "function unrelatedGate(){let q=a&&b&&!0,c;return q}",
    "function G$c(){let l=c?.requiresAuth??!0,m=Fza(f),h=c?.authMethod===`copilot`;let A=o.formatMessage({id:`composer.reasoningSlashCommand.title`});let M=l&&m&&!h&&!0,N;return{enabled:M,dependencies:N}}",
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

test("persists Copilot reasoning effort through the current default writer", () => {
  const patched = applyPatchTwice(
    applyCopilotReasoningEffortSettingsPatch,
    currentCopilotReasoningEffortSettingsFixture(),
  );

  assert.match(
    patched,
    /await ln\(n,`copilot-default-model`,e,\{throwOnFailure:!0\}\);await ln\(n,`copilot-default-reasoning-effort`,t,\{throwOnFailure:!0\}\);return/,
  );
  assert.doesNotMatch(
    patched,
    /await ln\(n,`copilot-default-model`,e,\{throwOnFailure:!0\}\);return/,
  );
});

test("current package descriptors use the semantic app-initial owner", () => {
  const currentChunk = "app-initial-DAkTNeXg.js";
  const adjacentChunk = "projects-index-page-DjNy92Xe.js";
  const loaded = require("./patch.js").descriptors;

  assert.ok(loaded.every((descriptor) => descriptor.pattern.test(currentChunk)));
  assert.ok(loaded.every((descriptor) => descriptor.pattern.test(adjacentChunk) === false));
  assert.equal(loaded[2].assetMatch(currentCopilotReasoningEffortUiFixture()), true);
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
  assert.equal(matchesCopilotReasoningEffortUiContract(currentCopilotReasoningEffortUiFixture()), true);
  const patched = applyPatchTwice(
    applyCopilotReasoningEffortUiPatch,
    currentCopilotReasoningEffortUiFixture(),
  );

  assert.match(patched, /ee=p\?\.authMethod===`copilot`/);
  assert.match(patched, /ie=C\?\.isModelLocked!==!0&&!q&&!0/);
  assert.match(patched, /ae=C\?\.isModelLocked!==!0&&l!=null&&!q&&g&&A!==`error`/);
  assert.match(patched, /reasoningEffortDisabled:!1/);
  assert.match(patched, /let A=o\.formatMessage\(\{id:`composer\.reasoningSlashCommand\.title`\}\);let M=l&&m&&!0,N;/);
  assert.doesNotMatch(patched, /ie=C\?\.isModelLocked!==!0&&!q&&!ee&&!0/);
  assert.doesNotMatch(patched, /&&g&&!ee&&A!==`error`/);
  assert.doesNotMatch(patched, /reasoningEffortDisabled:ee/);
  assert.doesNotMatch(patched, /M=l&&m&&!h&&!0/);
  assert.match(patched, /let q=a&&b&&!0,c/);
  assert.match(patched, /A=O\.length>0,j=!w&&!A/);
  assert.equal(matchesCopilotReasoningEffortUiContract(patched), true);

  const { value, warnings } = withCapturedWarns(() =>
    applyCopilotReasoningEffortUiPatch(patched),
  );
  assert.equal(value, patched);
  assert.deepEqual(warnings, []);
});

test("duplicate current app UI contracts warn and remain byte-identical", () => {
  const source = currentCopilotReasoningEffortUiFixture().repeat(2);
  const { value, warnings } = withCapturedWarns(() =>
    applyCopilotReasoningEffortUiPatch(source),
  );

  assert.equal(matchesCopilotReasoningEffortUiContract(source), false);
  assert.equal(value, source);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /duplicate current Copilot reasoning effort composer contracts/);
});

test("mixed current app UI contract states warn and remain byte-identical", () => {
  const cleanSource = currentCopilotReasoningEffortUiFixture();
  const sources = [
    cleanSource.replace("reasoningEffortDisabled:ee", "reasoningEffortDisabled:!1"),
    cleanSource.replace("M=l&&m&&!h&&!0,N;", "M=l&&m&&!0,N;"),
  ];

  for (const source of sources) {
    const { value, warnings } = withCapturedWarns(() =>
      applyCopilotReasoningEffortUiPatch(source),
    );
    assert.equal(matchesCopilotReasoningEffortUiContract(source), false);
    assert.equal(value, source);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /mixed current Copilot reasoning effort UI contract state/);
  }
});

test("incomplete current app UI contracts warn and remain byte-identical", () => {
  const cleanSource = currentCopilotReasoningEffortUiFixture();
  const sources = [
    cleanSource.replace("&&!ee&&!0", "&&!0"),
    cleanSource.replace("reasoningEffortDisabled:ee", "effortDisabled:ee"),
    cleanSource.replace("composer.reasoningSlashCommand.title", "composer.effortCommand.title"),
  ];

  for (const source of sources) {
    const { value, warnings } = withCapturedWarns(() =>
      applyCopilotReasoningEffortUiPatch(source),
    );
    assert.equal(matchesCopilotReasoningEffortUiContract(source), false);
    assert.equal(value, source);
    assert.equal(warnings.length, 1);
  }
});

test("mismatched Copilot slash command gates warn and remain byte-identical", () => {
  const source = currentCopilotReasoningEffortUiFixture().replace(
    "M=l&&m&&!h&&!0,N;",
    "M=l&&m&&!z&&!0,N;",
  );
  const { value, warnings } = withCapturedWarns(() =>
    applyCopilotReasoningEffortUiPatch(source),
  );

  assert.equal(matchesCopilotReasoningEffortUiContract(source), false);
  assert.equal(value, source);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /reasoning slash command enabled state/);
  assert.match(value, /M=l&&m&&!z&&!0,N;/);
});

test("current app UI drift warns without touching adjacent gates", () => {
  const source = [
    "function tHc(){let q=!0,ee=isCopilot(p),ie=C?.isModelLocked!==!0&&!q&&!ee&&!0;",
    "return m1(`composer.increaseReasoningEffort`,Ve,{enabled:ie}),",
    "jsx(CVc,{reasoningEffortDisabled:ee})}",
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
    const currentSettingsChunk = "app-initial-settings-current.js";
    const currentUiChunk = "app-initial-ui-current.js";
    assert.match(currentSettingsChunk, descriptors[0].pattern);
    assert.match(currentSettingsChunk, descriptors[1].pattern);
    assert.match(currentUiChunk, descriptors[2].pattern);
    assert.ok(descriptors.every((descriptor) => !descriptor.pattern.test("unrelated-bundle.js")));
  });
});

test("enabled feature descriptors patch the current app settings chunk", () => {
  const featuresRoot = path.resolve(__dirname, "..");
  const currentSettingsChunk = "app-initial-settings-Bd3Z1bES.js";
  const currentUiChunk = "app-initial-ui-DAkTNeXg.js";

  withTempFeatureConfig(["copilot-reasoning-effort"], () => {
    withTempDir((extractedDir) => {
      writeAsset(
        extractedDir,
        currentSettingsChunk,
        `${currentCopilotReasoningEffortSettingsFixture()};${currentFilteredCopilotReasoningEffortModelListFixture()}`,
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
      assert.match(readAsset(extractedDir, currentUiChunk), /M=l&&m&&!0,N/);
    });
  });
});
