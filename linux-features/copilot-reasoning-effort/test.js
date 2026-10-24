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
  applyCopilotReasoningEffortUiPatch,
  matchesCopilotModelAndReasoningPersistenceContract,
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

function currentModelAndReasoningPersistenceFixture() {
  return "function Hlo(){let ye=async(e,t,n)=>{await Ag(o,p).setDefaultModelConfig(e,t,j.profile);return!0},be=(t,n,r)=>vso(o,[`conversation`],{model:t,reasoningEffort:n,serviceTier:a},()=>ye(t,n,`current`,a)),xe=be,Se=(e,t)=>vso(o,[`default`],{model:e,reasoningEffort:t},()=>ye(e,t,`default`)),Ce=Se,we;return we={setDefaultModelAndReasoningEffort:Ce,setModelAndReasoningEffortForNextTurn:_e,setModelAndReasoningEffort:xe,modelSettings:de}}";
}

function currentFilteredCopilotReasoningEffortModelListFixture() {
  return "function Jv({authMethod:e,availableModels:t,defaultModel:n,enabledReasoningEfforts:r,includeUltraReasoningEffort:i,models:a,useHiddenModels:o}){let s=[],c=null,l=o&&e!==`amazonBedrock`,u=a.some(e=>e.supportedReasoningEfforts.some(({reasoningEffort:e})=>e===`max`)),d=i&&a.some(e=>e.supportedReasoningEfforts.some(({reasoningEffort:e})=>e===`ultra`));return a.forEach(n=>{if(l?t.has(n.model):!n.hidden){let t=i?n.supportedReasoningEfforts:n.supportedReasoningEfforts.filter(({reasoningEffort:e})=>e!==`ultra`),a=(e===`copilot`?[t.find(e=>e.reasoningEffort===`medium`)??{reasoningEffort:`medium`,description:`medium effort`}]:t).filter(({reasoningEffort:e})=>vg(e)&&r.has(e)),o={...n,supportedReasoningEfforts:a};s.push(o),n.isDefault&&(c=o)}}),c??=s.find(e=>e.model===n)??null,{models:s,defaultModel:c,hasModelSupportingMaxReasoningEffort:u,hasModelSupportingUltraReasoningEffort:d}}";
}

function currentCopilotReasoningEffortUiFixture() {
  return currentCopilotReasoningEffortDropdownFixture() +
    currentCopilotReasoningSlashFixture();
}

function currentCopilotReasoningEffortDropdownFixture() {
  return [
    "function hLr(){let w=p,fe=[{model:W,disabledReason:null}],Ae=!1,je=w?.authMethod===`copilot`||fe?.find(e=>{let{model:t}=e;return t.model===W})?.disabledReason!=null,Le=!l&&!Ae&&!k&&!je&&!0,Re=!l&&H?.isModelLocked!==!0&&v!=null&&P&&!je&&ne!==`error`,Bt=Ae||je;return jsx(MIr,{reasoningEffortDisabled:Bt,showReasoningEffortControls:!0})}",
    "function unrelatedGate(){let q=a&&b&&!0,c;return q}",
  ].join("");
}

function currentCopilotReasoningSlashFixture() {
  return [
    "function KYc(){let l=c?.requiresAuth??!0,m=Fza(f),h=c?.authMethod===`copilot`;let A=o.formatMessage({id:`composer.reasoningSlashCommand.title`});let M=l&&m&&!h&&!0,N;return{enabled:M,dependencies:N}}",
    "function permissionGate(){let A=O.length>0,j=!w&&!A;return{shouldAutoDenyPermissionRequest:j}}",
  ].join("");
}

function retiredCopilotReasoningEffortUiFixture() {
  return [
    "function pNc(){let S=p,ue=[{model:H,disabledReason:null}],ke=S?.authMethod===`copilot`||ue?.find(e=>{let{model:t}=e;return t.model===H})?.disabledReason!=null;return jsx(CVc,{reasoningEffortDisabled:ke,showReasoningEffortControls:!0})}",
    "function KYc(){let l=c?.requiresAuth??!0,m=Fza(f),h=c?.authMethod===`copilot`;let A=o.formatMessage({id:`composer.reasoningSlashCommand.title`});let M=l&&m&&!h&&!0,N;return{enabled:M,dependencies:N}}",
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

test("binds Copilot persistence to the current model-and-reasoning service", () => {
  const source = currentModelAndReasoningPersistenceFixture();
  assert.equal(matchesCopilotModelAndReasoningPersistenceContract(source), true);
  assert.equal(
    matchesCopilotModelAndReasoningPersistenceContract(
      source.replace(".setDefaultModelConfig(e,t,j.profile)", ".setDefaultModelConfig(e,j.profile)"),
    ),
    false,
  );
  assert.equal(matchesCopilotModelAndReasoningPersistenceContract(source.repeat(2)), false);
});

test("current package descriptors use their semantic asset owners", () => {
  const currentSettingsChunk = "app-initial-5e6ee461f636.js";
  const currentUiChunk = "app-primary-f72ae5046334.js";
  const currentSlashChunk = "composer-content-69456983584c.js";
  const adjacentChunk = "projects-index-page-DjNy92Xe.js";
  const loaded = require("./patch.js").descriptors;

  assert.ok(loaded[0].pattern.test(currentSettingsChunk));
  assert.ok(loaded[1].pattern.test(currentSettingsChunk));
  assert.ok(loaded[2].pattern.test(currentUiChunk));
  assert.ok(loaded[3].pattern.test(currentSlashChunk));
  assert.equal(loaded[0].assetMatch(currentModelAndReasoningPersistenceFixture()), true);
  assert.equal(loaded[2].assetMatch(currentCopilotReasoningEffortDropdownFixture()), true);
  assert.equal(loaded[2].assetMatch(currentCopilotReasoningSlashFixture()), false);
  assert.equal(loaded[3].assetMatch(currentCopilotReasoningSlashFixture()), true);
  assert.equal(loaded[3].assetMatch(currentCopilotReasoningEffortDropdownFixture()), false);
  assert.equal(loaded[1].pattern.test(adjacentChunk), false);
  assert.ok([loaded[0], ...loaded.slice(2)].every((descriptor) => descriptor.pattern.test(adjacentChunk)));
});

test("Copilot persistence validation rejects missing and duplicate replacement owners unchanged", () => {
  const descriptor = require("./patch.js").descriptors[0];
  const variants = {
    missing: "function unrelated(){}",
    duplicate: currentModelAndReasoningPersistenceFixture().repeat(2),
  };

  for (const [name, source] of Object.entries(variants)) {
    withTempDir((extractedDir) => {
      writeAsset(extractedDir, "app-initial-contract.js", source);
      const { warnings } = withCapturedWarns(() =>
        applyWebviewAssetPatchDescriptors(
          extractedDir,
          normalizePatchDescriptors([descriptor]),
          {},
          null,
        ),
      );
      assert.equal(readAsset(extractedDir, "app-initial-contract.js"), source, name);
      assert.equal(warnings.length, 1, name);
      assert.match(warnings[0], /current model-and-reasoning persistence owner/, name);
    });
  }

  withTempDir((extractedDir) => {
    const source = currentModelAndReasoningPersistenceFixture();
    writeAsset(extractedDir, "app-initial-one.js", source);
    writeAsset(extractedDir, "app-initial-two.js", source);
    const { warnings } = withCapturedWarns(() =>
      applyWebviewAssetPatchDescriptors(
        extractedDir,
        normalizePatchDescriptors([descriptor]),
        {},
        null,
      ),
    );
    assert.equal(readAsset(extractedDir, "app-initial-one.js"), source);
    assert.equal(readAsset(extractedDir, "app-initial-two.js"), source);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /Found multiple current model-and-reasoning persistence owner contracts/);
  });
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
  const dropdownPatched = applyPatchTwice(
    applyCopilotReasoningEffortUiPatch,
    currentCopilotReasoningEffortDropdownFixture(),
  );
  const slashPatched = applyPatchTwice(
    applyCopilotReasoningEffortUiPatch,
    currentCopilotReasoningSlashFixture(),
  );

  assert.match(dropdownPatched, /je=\/\*codexLinuxCopilotReasoningEffortUi\*\/fe\?\.find/);
  assert.match(dropdownPatched, /Bt=Ae\|\|je/);
  assert.match(dropdownPatched, /reasoningEffortDisabled:Bt/);
  assert.doesNotMatch(dropdownPatched, /je=w\?\.authMethod===`copilot`\|\|/);
  assert.match(dropdownPatched, /let q=a&&b&&!0,c/);
  assert.match(slashPatched, /let M=l&&m&&!0\/\*codexLinuxCopilotReasoningEffortUi\*\/,N;/);
  assert.doesNotMatch(slashPatched, /M=l&&m&&!h&&!0/);
  assert.match(slashPatched, /A=O\.length>0,j=!w&&!A/);
  assert.equal(matchesCopilotReasoningEffortUiContract(dropdownPatched), true);
  assert.equal(matchesCopilotReasoningEffortUiContract(slashPatched), true);
});

test("retired direct Copilot dropdown gate is rejected byte-identically", () => {
  const source = retiredCopilotReasoningEffortUiFixture();
  const { value, warnings } = withCapturedWarns(() =>
    applyCopilotReasoningEffortUiPatch(source),
  );

  assert.equal(matchesCopilotReasoningEffortUiContract(source), false);
  assert.equal(value, source);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /current compiled Copilot reasoning effort dropdown gate/);
});

test("unrelated function dropdown propagation cannot authorize the UI patch", () => {
  const source = currentCopilotReasoningEffortUiFixture()
    .replace("Bt=Ae||je", "Bt=Ae||z")
    .replace(
      "function unrelatedGate()",
      "function unrelatedGate(){let Bt=Ae||je,x={reasoningEffortDisabled:Bt};return x}function ignoredGate()",
    );
  const { value, warnings } = withCapturedWarns(() =>
    applyCopilotReasoningEffortUiPatch(source),
  );

  assert.equal(matchesCopilotReasoningEffortUiContract(source), false);
  assert.equal(value, source);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /current compiled Copilot reasoning effort dropdown gate/);
});

test("duplicate dropdown propagation in the composer owner is rejected byte-identically", () => {
  const source = currentCopilotReasoningEffortUiFixture().replace(
    "Bt=Ae||je;return",
    "Bt=Ae||je,Xt={reasoningEffortDisabled:Bt},Ct=Ae||je,Yt={reasoningEffortDisabled:Ct};return",
  );
  const { value, warnings } = withCapturedWarns(() =>
    applyCopilotReasoningEffortUiPatch(source),
  );

  assert.equal(matchesCopilotReasoningEffortUiContract(source), false);
  assert.equal(value, source);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /duplicate current compiled Copilot reasoning effort dropdown gates/);
});

test("duplicate current app UI contracts warn and remain byte-identical", () => {
  const source = currentCopilotReasoningEffortUiFixture().repeat(2);
  const { value, warnings } = withCapturedWarns(() =>
    applyCopilotReasoningEffortUiPatch(source),
  );

  assert.equal(matchesCopilotReasoningEffortUiContract(source), false);
  assert.equal(value, source);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /duplicate current compiled Copilot reasoning effort gates/);
});

test("split current app UI contracts patch independently", () => {
  const dropdown = applyPatchTwice(
    applyCopilotReasoningEffortUiPatch,
    currentCopilotReasoningEffortDropdownFixture(),
  );
  const slash = applyPatchTwice(
    applyCopilotReasoningEffortUiPatch,
    currentCopilotReasoningSlashFixture(),
  );
  assert.match(dropdown, /codexLinuxCopilotReasoningEffortUi/);
  assert.match(slash, /codexLinuxCopilotReasoningEffortUi/);
});

test("incomplete current app UI contracts warn and remain byte-identical", () => {
  const sources = [
    currentCopilotReasoningEffortDropdownFixture().replace("w?.authMethod===`copilot`||", ""),
    currentCopilotReasoningEffortDropdownFixture().replace("Bt=Ae||je", "Bt=Ae||z"),
    currentCopilotReasoningEffortDropdownFixture().replace("reasoningEffortDisabled:Bt", "effortDisabled:Bt"),
    currentCopilotReasoningSlashFixture().replace("composer.reasoningSlashCommand.title", "composer.effortCommand.title"),
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
  const source = currentCopilotReasoningSlashFixture().replace(
    "M=l&&m&&!h&&!0,N;",
    "M=l&&m&&!z&&!0,N;",
  );
  const { value, warnings } = withCapturedWarns(() =>
    applyCopilotReasoningEffortUiPatch(source),
  );

  assert.equal(matchesCopilotReasoningEffortUiContract(source), false);
  assert.equal(value, source);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /reasoning slash command auth gate/);
  assert.match(value, /M=l&&m&&!z&&!0,N;/);
});

test("current app UI drift warns without touching adjacent gates", () => {
  const source = [
    "function pNc(){let re=!0,ie=isCopilot(p),ce=!re&&!ie&&!0;",
    "return m1(`composer.increaseReasoningEffort`,Ve,{enabled:ce}),",
    "jsx(CVc,{reasoningEffortDisabled:ie})}",
    "function permissionGate(){let A=O.length>0,j=!w&&!A;return j}",
  ].join("");
  const { value, warnings } = withCapturedWarns(() =>
    applyCopilotReasoningEffortUiPatch(source),
  );

  assert.equal(value, source);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /current Copilot reasoning effort shortcut gate|current compiled/);
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
        "feature:copilot-reasoning-effort:persistence-contract",
        "feature:copilot-reasoning-effort:model-list",
        "feature:copilot-reasoning-effort:ui-dropdown",
        "feature:copilot-reasoning-effort:ui-slash-command",
      ],
    );
    assert.deepEqual(
      descriptors.map((descriptor) => descriptor.phase),
      ["webview-asset", "webview-asset", "webview-asset", "webview-asset"],
    );
    assert.ok(descriptors.every((descriptor) => descriptor.ciPolicy === "optional"));
    const currentSettingsChunk = "app-initial-settings-current.js";
    const currentUiChunk = "app-primary-ui-current.js";
    const currentSlashChunk = "composer-content-current.js";
    assert.match(currentSettingsChunk, descriptors[0].pattern);
    assert.match(currentSettingsChunk, descriptors[1].pattern);
    assert.match(currentUiChunk, descriptors[2].pattern);
    assert.match(currentSlashChunk, descriptors[3].pattern);
    assert.equal(descriptors[1].pattern.test("unrelated-bundle.js"), false);
    assert.ok([descriptors[0], ...descriptors.slice(2)].every((descriptor) => descriptor.pattern.test("unrelated-bundle.js")));
  });
});

test("enabled feature descriptors patch the current app settings chunk", () => {
  const featuresRoot = path.resolve(__dirname, "..");
  const currentSettingsChunk = "app-initial-settings-Bd3Z1bES.js";
  const currentUiChunk = "app-primary-ui-ea0fa37e0a01.js";
  const currentSlashChunk = "composer-content-current.js";

  withTempFeatureConfig(["copilot-reasoning-effort"], () => {
    withTempDir((extractedDir) => {
      writeAsset(
        extractedDir,
        currentSettingsChunk,
        currentFilteredCopilotReasoningEffortModelListFixture() +
          currentModelAndReasoningPersistenceFixture(),
      );
      writeAsset(extractedDir, currentUiChunk, currentCopilotReasoningEffortDropdownFixture());
      writeAsset(extractedDir, currentSlashChunk, currentCopilotReasoningSlashFixture());

      const descriptors = normalizePatchDescriptors(
        loadLinuxFeaturePatchDescriptors({ featuresRoot }),
      );
      applyWebviewAssetPatchDescriptors(extractedDir, descriptors, {}, null);
      const patched = readAsset(extractedDir, currentSettingsChunk);

      assert.match(patched, /a=\[\.\.\.t\]\.filter/);
      assert.doesNotMatch(patched, /e===`copilot`\?\[/);
      assert.match(readAsset(extractedDir, currentUiChunk), /reasoningEffortDisabled:Bt/);
      assert.match(
        readAsset(extractedDir, currentSlashChunk),
        /M=l&&m&&!0\/\*codexLinuxCopilotReasoningEffortUi\*\/,N/,
      );
    });
  });
});
