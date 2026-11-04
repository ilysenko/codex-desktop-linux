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
  applyCopilotReasoningEffortDropdownPatch,
  applyCopilotReasoningEffortModelListPatch,
  applyCopilotReasoningSlashPatch,
  descriptors,
  matchesCopilotModelAndReasoningPersistenceContract,
  matchesCopilotReasoningEffortDropdownContract,
  matchesCopilotReasoningSlashContract,
} = require("./patch.js");
const { findWebviewAssetsContaining } = require("../../scripts/patches/lib/assets.js");
const { spawnSync } = require("node:child_process");

function applyPatchTwice(patchFn, source) {
  const patched = patchFn(source);
  assert.notEqual(patched, source);
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

// Fixtures below follow the current official rspack/SWC shapes.
function currentModelAndReasoningPersistenceFixture() {
  return 'function hook(){let l=await (0,u.V)(Y,eE).setDefaultModelConfig(e,t,eM.profile);let a=r?.serviceTier;z=(t,n,r)=>(0,E.HM)(Y,i,{model:t,reasoningEffort:n,serviceTier:a},()=>eK(t,n,"current",a));let eJ=z;W=(e,t)=>(0,E.HM)(Y,["default",ec,eI],{model:e,reasoningEffort:t},()=>eK(e,t,"default"));let e0=W;return G={defaultAdvancedModel:eM.model,setDefaultModelAndReasoningEffort:e0,setModelAndReasoningEffortForNextTurn:eQ,setModelAndReasoningEffort:eJ,modelSettings:eX}}';
}

function currentFilteredCopilotReasoningEffortModelListFixture() {
  return 'function i({additionalAvailableModels:e,apiKeyDaybreakSupported:t=!1,authMethod:n,availableModels:a,defaultModel:s,enabledReasoningEfforts:o,hasConfiguredModelCatalog:l,includeUltraReasoningEffort:u,isCustomModelProvider:d=!1,models:c,useHiddenModels:p}){let h=[],f=null;return c.forEach(i=>{if(!i.hidden){let e=u?i.supportedReasoningEfforts:i.supportedReasoningEfforts.filter(({reasoningEffort:e})=>"ultra"!==e),t=("copilot"===n?[e.find(e=>"medium"===e.reasoningEffort)??{reasoningEffort:"medium",description:"medium effort"}]:e).filter(({reasoningEffort:e})=>(0,r.eE)(e)&&o.has(e)),a={...i,supportedReasoningEfforts:t};h.push(a),i.isDefault&&(f=a)}}),null==f&&(f=h.find(e=>e.model===s)??null),{models:h,defaultModel:f}}';
}

function currentCopilotReasoningEffortDropdownFixture() {
  return [
    'function composer(){let ov=lock,n4=[{model:{model:nH},disabledReason:null}],oy=nc?.authMethod==="copilot"||n4?.find(e=>{let{model:l}=e;return l.model===nH})?.disabledReason!=null,ts=ov||"error"===nV,tr=ov||oy||n_?.lockedReasoningEffort!=null;return(0,r.jsx)(M,{modelOptionsDisabled:ts,reasoningEffortDisabled:tr,showReasoningEffortControls:!0})}',
    "function unrelatedGate(){let q=a&&b&&!0;return q}",
  ].join("");
}

function currentCopilotReasoningSlashFixture() {
  return [
    'function reasoningCommand(e){let j=e.requiresAuth??!0,M=(0,a.tn)(C),R=ready(T),P=M?.authMethod==="copilot";h=S.formatMessage({id:"composer.reasoningSlashCommand.title",defaultMessage:"Reasoning"});let H=j&&R&&!P&&!0;return g=[j,R,P],v={id:"reasoning",title:h,description:p,requiresEmptyComposer:!1,Icon:f,submenu:B,enabled:H,dependencies:g},(0,rq.r6)(v),null}',
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

function asChunk(body) {
  return `export const __rspack_esm_id=1;export const __webpack_modules__={m(e,t,n){${body}}};`;
}

function writeAsset(extractedDir, name, source) {
  const assetsDir = path.join(extractedDir, "webview", "assets", "async");
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.writeFileSync(path.join(assetsDir, name), asChunk(source));
}

function readAsset(extractedDir, name) {
  return fs.readFileSync(path.join(extractedDir, "webview", "assets", "async", name), "utf8");
}

test("binds Copilot persistence to the current model-and-reasoning service", () => {
  const source = currentModelAndReasoningPersistenceFixture();
  assert.equal(matchesCopilotModelAndReasoningPersistenceContract(source), true);
  for (const drifted of [
    source.replace(".setDefaultModelConfig(e,t,eM.profile)", ".setDefaultModelConfig(e,eM.profile)"),
    source.replace('()=>eK(e,t,"default")', '()=>other(e,t,"default")'),
    source.repeat(2),
  ]) {
    assert.equal(matchesCopilotModelAndReasoningPersistenceContract(drifted), false);
  }
});

test("descriptors find their owners by content needles, not chunk names", () => {
  assert.deepEqual(descriptors.map((descriptor) => descriptor.id), [
    "persistence-contract",
    "model-list",
    "ui-dropdown",
    "ui-slash-command",
  ]);
  const fixtures = [
    currentModelAndReasoningPersistenceFixture(),
    currentFilteredCopilotReasoningEffortModelListFixture(),
    currentCopilotReasoningEffortDropdownFixture(),
    currentCopilotReasoningSlashFixture(),
  ];
  descriptors.forEach((descriptor, index) => {
    assert.equal(descriptor.pattern, undefined);
    assert.equal(descriptor.assetPattern, undefined);
    assert.equal(descriptor.assetMatch, undefined);
    for (const needle of descriptor.assetNeedles) {
      assert.equal(fixtures[index].includes(needle), true, `${descriptor.id}: ${needle}`);
    }
  });
});

test("Copilot persistence validation warns on every drifted copy and never edits it", () => {
  const descriptor = descriptors[0];
  withTempDir((extractedDir) => {
    const good = currentModelAndReasoningPersistenceFixture();
    const drifted = good.replace('()=>eK(e,t,"default")', '()=>other(e,t,"default")');
    writeAsset(extractedDir, "1.a.js", good);
    writeAsset(extractedDir, "2.b.js", drifted);
    const { warnings } = withCapturedWarns(() =>
      applyWebviewAssetPatchDescriptors(extractedDir, normalizePatchDescriptors([descriptor]), {}, null),
    );
    assert.equal(readAsset(extractedDir, "1.a.js"), asChunk(good));
    assert.equal(readAsset(extractedDir, "2.b.js"), asChunk(drifted));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /current model-and-reasoning persistence owner/);
  });
});

test("keeps filtered current app reasoning efforts for Copilot auth", () => {
  const patched = applyPatchTwice(
    applyCopilotReasoningEffortModelListPatch,
    currentFilteredCopilotReasoningEffortModelListFixture(),
  );

  assert.match(patched, /t=\/\*codexLinuxCopilotReasoningEffortModelList\*\/\[\.\.\.e\]\.filter\(\(\{reasoningEffort:e\}\)=>\(0,r\.eE\)\(e\)&&o\.has\(e\)\)/);
  assert.doesNotMatch(patched, /"copilot"===n\?\[/);
  assert.doesNotMatch(patched, /description:"medium effort"/);

  const catalog = Function("r", `${patched};return i;`)({ eE: () => true });
  const result = catalog({
    authMethod: "copilot",
    defaultModel: "gpt-5",
    enabledReasoningEfforts: new Set(["low", "medium", "high"]),
    includeUltraReasoningEffort: false,
    models: [{
      model: "gpt-5",
      isDefault: true,
      supportedReasoningEfforts: ["low", "high", "ultra"].map((reasoningEffort) => ({ reasoningEffort })),
    }],
  });
  assert.deepEqual(result.models[0].supportedReasoningEfforts.map((e) => e.reasoningEffort), ["low", "high"]);
});

test("model list patch rejects missing and duplicate filters byte-identically", () => {
  const source = currentFilteredCopilotReasoningEffortModelListFixture();
  for (const candidate of [source.replace('"copilot"===n', '"other"===n'), source + source]) {
    const { value, warnings } = withCapturedWarns(() => applyCopilotReasoningEffortModelListPatch(candidate));
    assert.equal(value, candidate);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /Copilot model reasoning effort filter/);
  }
});

test("allows Copilot auth to use the current app effort controls", () => {
  const dropdownPatched = applyPatchTwice(
    applyCopilotReasoningEffortDropdownPatch,
    currentCopilotReasoningEffortDropdownFixture(),
  );
  const slashPatched = applyPatchTwice(
    applyCopilotReasoningSlashPatch,
    currentCopilotReasoningSlashFixture(),
  );

  assert.match(dropdownPatched, /oy=\/\*codexLinuxCopilotReasoningEffortUi\*\/n4\?\.find/);
  assert.match(dropdownPatched, /tr=ov\|\|oy\|\|/);
  assert.match(dropdownPatched, /reasoningEffortDisabled:tr/);
  assert.doesNotMatch(dropdownPatched, /authMethod==="copilot"/);
  assert.match(dropdownPatched, /let q=a&&b&&!0;/);
  assert.match(slashPatched, /let H=j&&R&&!0\/\*codexLinuxCopilotReasoningEffortUi\*\/;/);
  assert.doesNotMatch(slashPatched, /H=j&&R&&!P&&!0/);
  assert.match(slashPatched, /A=O\.length>0,j=!w&&!A/);
  assert.equal(matchesCopilotReasoningEffortDropdownContract(dropdownPatched), true);
  assert.equal(matchesCopilotReasoningSlashContract(slashPatched), true);
  assert.equal(matchesCopilotReasoningEffortDropdownContract(currentCopilotReasoningSlashFixture()), false);
  assert.equal(matchesCopilotReasoningSlashContract(currentCopilotReasoningEffortDropdownFixture()), false);
});

test("dropdown gate that no longer reaches the dropdown is rejected byte-identically", () => {
  const base = currentCopilotReasoningEffortDropdownFixture();
  const cases = [
    [base.replace("tr=ov||oy||", "tr=ov||z||"), /dropdown gate/],
    [base.replace("reasoningEffortDisabled:tr", "effortDisabled:tr"), /dropdown gate/],
    [base.replace("tr=ov||oy||", "tr=ov||oy||").replace("ts=ov||", "ts=ov||oy||"), /dropdown gate/],
    [base.replace('nc?.authMethod==="copilot"||', ""), /reasoning effort gate/],
    [base + base, /duplicate current compiled Copilot reasoning effort gates/],
  ];
  for (const [source, warning] of cases) {
    const { value, warnings } = withCapturedWarns(() => applyCopilotReasoningEffortDropdownPatch(source));
    assert.equal(matchesCopilotReasoningEffortDropdownContract(source), false);
    assert.equal(value, source);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], warning);
  }
});

test("mismatched or unowned Copilot slash command gates warn and remain byte-identical", () => {
  const base = currentCopilotReasoningSlashFixture();
  const cases = [
    [base.replace("H=j&&R&&!P&&!0;", "H=j&&R&&!z&&!0;"), /reasoning slash command auth gate/],
    [base.replace("enabled:H,", "enabled:other,"), /reasoning slash command gate/],
    [base + base, /duplicate current compiled Copilot reasoning slash command gates/],
  ];
  for (const [source, warning] of cases) {
    const { value, warnings } = withCapturedWarns(() => applyCopilotReasoningSlashPatch(source));
    assert.equal(matchesCopilotReasoningSlashContract(source), false);
    assert.equal(value, source);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], warning);
  }
});

test("feature descriptor loader exposes the Copilot webview asset patches only when enabled", () => {
  const featuresRoot = path.resolve(__dirname, "..");

  withTempFeatureConfig([], () => {
    assert.deepEqual(loadLinuxFeaturePatchDescriptors({ featuresRoot }), []);
  });

  withTempFeatureConfig(["copilot-reasoning-effort"], () => {
    const loaded = loadLinuxFeaturePatchDescriptors({ featuresRoot });
    assert.deepEqual(loaded.map((descriptor) => descriptor.id), [
      "feature:copilot-reasoning-effort:persistence-contract",
      "feature:copilot-reasoning-effort:model-list",
      "feature:copilot-reasoning-effort:ui-dropdown",
      "feature:copilot-reasoning-effort:ui-slash-command",
    ]);
    assert.ok(loaded.every((descriptor) => descriptor.phase === "webview-asset"));
    assert.ok(loaded.every((descriptor) => descriptor.ciPolicy === "optional"));
  });
});

test("enabled feature descriptors patch rspack async chunks", () => {
  const featuresRoot = path.resolve(__dirname, "..");
  withTempFeatureConfig(["copilot-reasoning-effort"], () => {
    withTempDir((extractedDir) => {
      writeAsset(extractedDir, "24191.a.js", currentFilteredCopilotReasoningEffortModelListFixture());
      writeAsset(extractedDir, "258607.b.js", currentModelAndReasoningPersistenceFixture());
      writeAsset(extractedDir, "104066.c.js", currentCopilotReasoningEffortDropdownFixture());
      writeAsset(extractedDir, "589850.d.js", currentCopilotReasoningSlashFixture());

      const { warnings } = withCapturedWarns(() => applyWebviewAssetPatchDescriptors(
        extractedDir,
        normalizePatchDescriptors(loadLinuxFeaturePatchDescriptors({ featuresRoot })),
        {},
        null,
      ));
      assert.deepEqual(warnings, []);
      assert.match(readAsset(extractedDir, "24191.a.js"), /codexLinuxCopilotReasoningEffortModelList\*\/\[\.\.\.e\]\.filter/);
      assert.match(readAsset(extractedDir, "104066.c.js"), /oy=\/\*codexLinuxCopilotReasoningEffortUi\*\//);
      assert.match(readAsset(extractedDir, "589850.d.js"), /H=j&&R&&!0\/\*codexLinuxCopilotReasoningEffortUi\*\//);
      assert.equal(readAsset(extractedDir, "258607.b.js"), asChunk(currentModelAndReasoningPersistenceFixture()));
    });
  });
});

const signedApp = process.env.CODEX_SIGNED_EXTRACTED_APP;
test("official signed webview owners validate or patch once and still parse", { skip: !signedApp }, () => {
  const assetsDir = path.join(signedApp, "webview", "assets");
  const counts = {};
  for (const descriptor of descriptors) {
    const assets = findWebviewAssetsContaining(signedApp, descriptor.assetNeedles);
    counts[descriptor.id] = assets.length;
    for (const asset of assets) {
      const source = fs.readFileSync(path.join(assetsDir, asset), "utf8");
      const { value: patched, warnings } = withCapturedWarns(() => descriptor.apply(source));
      assert.deepEqual(warnings, [], `${descriptor.id} ${asset}`);
      assert.equal(descriptor.apply(patched), patched, `${descriptor.id} ${asset}`);
      if (descriptor.id === "persistence-contract") {
        assert.equal(patched, source);
        continue;
      }
      assert.notEqual(patched, source, `${descriptor.id} ${asset}`);
      const check = spawnSync(process.execPath, ["--input-type=module", "--check"], {
        input: patched,
        maxBuffer: 64 * 1024 * 1024,
      });
      assert.equal(check.status, 0, `${descriptor.id} ${asset}: ${check.stderr}`);
    }
  }
  assert.ok(counts["persistence-contract"] >= 1);
  assert.equal(counts["model-list"], 1);
  assert.equal(counts["ui-dropdown"], 1);
  assert.equal(counts["ui-slash-command"], 1);
});
