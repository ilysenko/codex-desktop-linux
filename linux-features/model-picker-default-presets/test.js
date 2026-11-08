#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { loadLinuxFeaturePatchDescriptors } = require("../../scripts/lib/linux-features.js");
const { javascriptSourceParses } = require("../../scripts/patches/lib/javascript-syntax.js");
const { patchExtractedApp } = require("../../scripts/patches/runner.js");
const {
  EFFORT_TO_THINKING_EFFORT,
  applyLocalComposerConfigPatch,
  normalizePresets,
  localComposerConfigContract,
  upstreamDefaultSelectionAssetMatch,
  upstreamDefaultSelectionContract,
} = require("./patch.js");

function context(presets) {
  return {
    feature: {
      manifest: { presets: [] },
      settings: { presets },
    },
  };
}

// rspack registers each module factory in one `__webpack_modules__` object.
function rspackChunk(modules) {
  return [
    "export const __rspack_esm_id=1;export const __rspack_esm_ids=[1];",
    "export const __webpack_modules__={",
    Object.entries(modules).map(([id, body]) => `${id}(e,t,n){${body}}`).join(","),
    "};",
  ].join("");
}

function withCapturedWarnings(callback) {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    return { result: callback(), warnings };
  } finally {
    console.warn = originalWarn;
  }
}

test("normalizes every public effort without imposing a preset limit", () => {
  const entries = Object.keys(EFFORT_TO_THINKING_EFFORT).map((effort, index) => ({
    model: `model-${index}`,
    effort,
    ...(index === 4 ? { default: true } : {}),
  }));
  const normalized = normalizePresets(context(entries));
  assert.equal(normalized.length, entries.length);
  assert.deepEqual(
    normalized.map(({ thinkingEffort }) => thinkingEffort),
    ["zero", "min", "standard", "extended", "xhigh", "max", "ultra"],
  );
  assert.equal(normalized[4].isDefault, true);

  const longList = Array.from({ length: 256 }, (_, index) => ({
    model: `arbitrary-model-${index}`,
    effort: "medium",
    ...(index === 127 ? { default: true } : {}),
  }));
  assert.equal(normalizePresets(context(longList)).length, 256);
});

test("allows the empty manifest default only as a compatibility passthrough", () => {
  assert.deepEqual(
    normalizePresets({ feature: { manifest: { presets: [] }, settings: {} } }),
    [],
  );
  assert.throws(() => normalizePresets(context([])), /must contain at least one entry/);
});

test("rejects malformed preset settings", () => {
  const invalid = [
    ["not-an-array", /must be an array/],
    [[null], /presets\[0\] must be an object/],
    [[{ model: "", effort: "low", default: true }], /model must be a non-empty string/],
    [[{ model: "m", effort: "minimal", default: true }], /effort must be one of/],
    [[{ model: "m", effort: "low", default: "yes" }], /default must be a boolean/],
    [[{ model: "m", effort: "low", default: true, extra: 1 }], /unknown field 'extra'/],
    [[{ model: "m", effort: "low" }], /exactly one default entry/],
    [
      [
        { model: "m", effort: "low", default: true },
        { model: "n", effort: "high", default: true },
      ],
      /exactly one default entry/,
    ],
    [
      [
        { model: " m ", effort: "low", default: true },
        { model: "m", effort: "low" },
      ],
      /duplicate model\/effort pair/,
    ],
  ];
  for (const [presets, message] of invalid) {
    assert.throws(() => normalizePresets(context(presets)), message);
  }
});

test("upstream Default compatibility wrappers use the current complete registry owner", () => {
  const current=require("./fixtures/current-default-selection.json");
  const source=rspackChunk({TuVM:current.moduleSource});
  const presets=context([{model:"model-new",effort:"high",default:true}]);
  assert.equal(upstreamDefaultSelectionContract(source),"current");
  assert.equal(upstreamDefaultSelectionAssetMatch(source,"async/default.js",presets),true);
  assert.equal(upstreamDefaultSelectionContract(current.moduleSource),"drifted");
  assert.equal(upstreamDefaultSelectionContract(rspackChunk({TuVM:current.moduleSource,duplicate:current.moduleSource})),"drifted");
  assert.equal(upstreamDefaultSelectionAssetMatch(source,"async/default.js",{feature:{manifest:{presets:[]},settings:{}}}),false);
});

test("local composer compatibility wrappers require the actual registry and exact config replay",()=>{
 const current=require("./fixtures/current-composer-config.json"),source=`export const __webpack_modules__={cyhU(${current.params}){${current.moduleSource}}};`,presets=context([{model:"model-new",effort:"high",default:true}]);
 assert.equal(localComposerConfigContract(source,presets),"current");
 const patched=applyLocalComposerConfigPatch(source,presets);assert.equal(localComposerConfigContract(patched,presets),"applied");assert.equal(applyLocalComposerConfigPatch(patched,presets),patched);
 assert.equal(localComposerConfigContract(current.moduleSource,presets),"drifted");assert.throws(()=>applyLocalComposerConfigPatch(current.moduleSource,presets));
});

test("empty manifest leaves the slider descriptor disabled", () => {
  const passthrough = { feature: { manifest: { presets: [] }, settings: {} } };
  const slider=require("./patch.js").descriptors.find(descriptor=>descriptor.id.endsWith("-slider-minimum"));
  assert.equal(slider.enabled(passthrough),false);
});

test("feature descriptors load alone and alongside ui-tweaks", () => {
  const root = path.resolve(__dirname, "..");
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "model-picker-presets-"));
  const configPath = path.join(temporaryDirectory, "features.json");
  const writeConfig = (enabled, presets = [{ model: "gpt-6-astra", effort: "medium", default: true }]) =>
    fs.writeFileSync(
      configPath,
      `${JSON.stringify({
        enabled,
        settings: {
          "model-picker-default-presets": {
            presets,
          },
        },
      })}\n`,
    );
  try {
    writeConfig([]);
    assert.deepEqual(
      loadLinuxFeaturePatchDescriptors({ featuresRoot: root, featuresConfigPath: configPath }),
      [],
    );
    writeConfig(["model-picker-default-presets"]);
    const alone = loadLinuxFeaturePatchDescriptors({
      featuresRoot: root,
      featuresConfigPath: configPath,
    });
    assert.equal(alone.length, 7);
    assert.ok(alone.every(({ featureId }) => featureId === "model-picker-default-presets"));
    const [scenario] = require("./feature.json").officialBundleAuditScenarios;
    writeConfig(["model-picker-default-presets"], scenario.settings.presets);
    assert.equal(loadLinuxFeaturePatchDescriptors({
      featuresRoot: root,
      featuresConfigPath: configPath,
    }).length, 7);
    writeConfig(["model-picker-default-presets", "ui-tweaks"]);
    const together = loadLinuxFeaturePatchDescriptors({
      featuresRoot: root,
      featuresConfigPath: configPath,
    });
    assert.ok(together.some(({ featureId }) => featureId === "model-picker-default-presets"));
    assert.ok(together.some(({ featureId }) => featureId === "ui-tweaks"));
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("invalid user settings stop an enabled feature build", () => {
  const root = path.resolve(__dirname, "..");
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "model-picker-invalid-"));
  const configPath = path.join(temporaryDirectory, "features.json");
  fs.writeFileSync(
    configPath,
    `${JSON.stringify({
      enabled: ["model-picker-default-presets"],
      settings: { "model-picker-default-presets": { presets: "invalid" } },
    })}\n`,
  );
  try {
    assert.throws(
      () =>
        patchExtractedApp(temporaryDirectory, {
          featuresRoot: root,
          featuresConfigPath: configPath,
        }),
      /presets must be an array/,
    );
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

const signedApp = process.env.CODEX_SIGNED_EXTRACTED_APP;
test("official rspack webview satisfies all configured descriptors through the production runner", {skip:signedApp==null},()=>{
 const {listWebviewScriptAssets}=require("../../scripts/patches/lib/assets.js");
 const {createPatchReport}=require("../../scripts/lib/patch-report.js");
 const cacheRoot=path.join(process.env.XDG_CACHE_HOME??path.join(os.homedir(),".cache"),"codex-desktop-dev");
 fs.mkdirSync(cacheRoot,{recursive:true});
 const root=fs.mkdtempSync(path.join(cacheRoot,"presets-signed-audit-")),assets=path.join(root,"app","webview","assets"),app=path.join(root,"app"),config=path.join(root,"features.json");
 const [scenario]=require("./feature.json").officialBundleAuditScenarios;
 try{
  fs.mkdirSync(assets,{recursive:true});
  for(const name of listWebviewScriptAssets(signedApp)){
   const from=path.join(signedApp,"webview","assets",name),to=path.join(assets,name);fs.mkdirSync(path.dirname(to),{recursive:true});fs.copyFileSync(from,to,fs.constants.COPYFILE_FICLONE);fs.chmodSync(to,fs.statSync(from).mode&0o777);
  }
  fs.writeFileSync(config,JSON.stringify({enabled:["model-picker-default-presets"],settings:{"model-picker-default-presets":scenario.settings}}));
  const options={featuresRoot:path.resolve(__dirname,".."),featuresConfigPath:config};
  const run=()=>{const report=createPatchReport();const {warnings}=withCapturedWarnings(()=>patchExtractedApp(app,{...options,report}));assert.deepEqual(warnings,[]);assert.equal(report.patches.length,7);assert(report.patches.every(p=>["applied","already-applied"].includes(p.status)),JSON.stringify(report.patches));return report;};
  const first=run(),before=new Map(listWebviewScriptAssets(app).map(name=>[name,fs.readFileSync(path.join(assets,name))]));
  assert(first.patches.some(p=>p.name.endsWith("-catalog")));
  const repeat=run();assert(repeat.patches.every(p=>p.status==="already-applied"),JSON.stringify(repeat.patches));
  for(const[name,bytes]of before)assert.deepEqual(fs.readFileSync(path.join(assets,name)),bytes,name);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
