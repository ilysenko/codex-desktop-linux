#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const { loadLinuxFeaturePatchDescriptors } = require("../../scripts/lib/linux-features.js");
const { javascriptSourceParses } = require("../../scripts/patches/lib/javascript-syntax.js");
const { patchExtractedApp } = require("../../scripts/patches/runner.js");
const {
  EFFORT_TO_THINKING_EFFORT,
  LOCAL_DEFAULT_PATCH_MARKER,
  LOCAL_COMPOSER_CONFIG_MARKER,
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

// Evaluates one factory of an rspack chunk fixture and returns its exports.
function localComposerFixture(name = "LocalComposer") {
  return [
    `function ${name}(available,serverConfig,conversationId,manualSelection){`,
    "let host={hostId:`local`,cwd:`/repo`},hostId=host.hostId;",
    "modelsForPicker(available);let{setDefaultModelAndReasoningEffort:setDefault}=selection,draftSelection=null;",
    "let He=available.find(Wqr),Ue=Power(available,{includeUltraInSlider:true,sliderModelsConfig:hosted?hostedConfig:serverConfig,stripGptPrefix:true}),",
    "Ge=Ue,Ke=(0,Picker.zae)(Ge,null==He?void 0:`${He.model}:${He.defaultReasoningEffort}`);",
    "picker({resetContextKey:JSON.stringify([conversationId,hostId,host.cwd])});",
    "composer.mode.local.model.custom;async function choose(e,t){let n=normalize(e);await (null==draftSelection?select(n,t):draftSelection.setModelAndReasoningEffort(n,t))}",
    "function normalize(e){return e}let selected=manualSelection?choose(`gpt-5.6-sol`,`high`):null;",
    "let reset=(0,Picker.zae)(Ue,null==He?void 0:`${He.model}:${He.defaultReasoningEffort}`);",
    "render({onSelectDefault:reset});",
    "return{powerSelections:Ue,fallback:Ke,reset,selected}}",
    "function Next(){}",
  ].join("");
}

function evaluate(source, expression, globals = {}) {
  return vm.runInNewContext(`${source};${expression}`, globals);
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
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

test("local composer config supplies configured pairs and fallback", () => {
  const presets = context([
    { model: "gpt-5.6-sol", effort: "medium", default: true },
    { model: "gpt-5.6-sol", effort: "high" },
    { model: "gpt-6-astra", effort: "high" },
  ]);
  const available = [
    { model: "gpt-5.6-sol", reasoningEffort: "high" },
    { model: "gpt-5.6-sol", reasoningEffort: "xhigh" },
  ];
  const composerSource = localComposerFixture();
  assert.equal(localComposerConfigContract(composerSource), "current");
  const patchedComposer = applyLocalComposerConfigPatch(composerSource, presets);
  assert.equal(localComposerConfigContract(patchedComposer), "applied");
  assert.equal(applyLocalComposerConfigPatch(patchedComposer, presets), patchedComposer);
  assert.equal(
    (patchedComposer.match(new RegExp(LOCAL_COMPOSER_CONFIG_MARKER, "g")) ?? []).length,
    1,
  );
  assert.match(patchedComposer, /gpt-5\.6-sol:medium/);
  assert.ok(patchedComposer.includes(
    "sliderModelsConfig:(hosted?hostedConfig:serverConfig)==null?" +
      "(hosted?hostedConfig:serverConfig):codexLinuxLocalDefaultPresetConfig",
  ));
  const runComposer = ({
    available,
    conversationId = null,
    hookState = { refs: [] },
    hosted = false,
    hostedConfig = null,
    serverConfig = {},
    manualSelection = false,
  }) => {
    const effects = [];
    const selections = [];
    let refIndex = 0;
    const globals = {
      React: {
        useEffect(effect) {
          effects.push(effect);
        },
        useRef(value) {
          const index = refIndex++;
          hookState.refs[index] ??= { current: value };
          return hookState.refs[index];
        },
      },
      available,
      composer: { mode: { local: { model: { custom: null } } } },
      conversationId,
      draft: null,
      hosted,
      hostedConfig,
      manualSelection,
      modelsForPicker() {},
      picker() {},
      render() {},
      selection: { setDefaultModelAndReasoningEffort() {} },
      serverConfig,
      Wqr: ({ isDefault }) => isDefault === true,
      Picker: {
        zae: (selections, id) =>
          selections.find((selection) => selection.id === id) ?? selections[0],
      },
      Power: (models, { sliderModelsConfig }) => {
        if (sliderModelsConfig == null) return models;
        const availableIds = new Set(models.map(({ id }) => id));
        const configured = sliderModelsConfig.presets[0].flatMap(
          ({ model, reasoning_effort: effort }) => {
            const id = `${model}:${effort}`;
            return availableIds.has(id) ? [{ id, model, reasoningEffort: effort }] : [];
          },
        );
        return configured.length > 0 ? configured : models;
      },
      select: (model, effort, _callback, options) => {
        selections.push({ effort, model, options });
        return options ?? null;
      },
    };
    const result = plain(
      evaluate(
        patchedComposer,
        "LocalComposer(available,serverConfig,conversationId,manualSelection)",
        globals,
      ),
    );
    for (const effect of effects) effect();
    return { result, selections: plain(selections) };
  };
  const unavailableDefault = runComposer({
    available: [
      { id: "gpt-5.6-sol:high", model: "gpt-5.6-sol", reasoningEffort: "high" },
      {
        id: "upstream:medium",
        model: "upstream",
        defaultReasoningEffort: "medium",
        isDefault: true,
      },
    ],
  });
  assert.equal(unavailableDefault.result.fallback.id, "gpt-5.6-sol:high");
  assert.equal(unavailableDefault.result.reset.id, "gpt-5.6-sol:high");
  assert.deepEqual(unavailableDefault.selections, []);

  const hostedConfigured = runComposer({
    available: [
      { id: "gpt-5.6-sol:high", model: "gpt-5.6-sol", reasoningEffort: "high" },
      { id: "gpt-5.6-sol:medium", model: "gpt-5.6-sol", reasoningEffort: "medium" },
    ],
    hosted: true,
    hostedConfig: {},
    serverConfig: null,
  });
  assert.equal(hostedConfigured.result.fallback.id, "gpt-5.6-sol:medium");
  assert.deepEqual(
    hostedConfigured.result.powerSelections.map(({ id }) => id),
    ["gpt-5.6-sol:medium", "gpt-5.6-sol:high"],
  );

  const configuredDefault = runComposer({
    available: [
      { id: "gpt-5.6-sol:high", model: "gpt-5.6-sol", reasoningEffort: "high" },
      { id: "gpt-5.6-sol:medium", model: "gpt-5.6-sol", reasoningEffort: "medium" },
    ],
  });
  assert.deepEqual(configuredDefault.selections, []);

  const gatedOut = runComposer({
    available: [
      {
        id: "upstream:medium",
        model: "upstream",
        defaultReasoningEffort: "medium",
        isDefault: true,
      },
    ],
    serverConfig: null,
  });
  assert.equal(gatedOut.result.fallback.id, "upstream:medium");
  assert.equal(gatedOut.result.reset.id, "upstream:medium");
  assert.deepEqual(gatedOut.selections, []);

  const gatedManualSelection = runComposer({
    available: [
      { id: "gpt-5.6-sol:high", model: "gpt-5.6-sol", reasoningEffort: "high" },
    ],
    manualSelection: true,
    serverConfig: null,
  });
  assert.deepEqual(gatedManualSelection.selections, [
    { effort: "high", model: "gpt-5.6-sol" },
  ]);

  const completeFallback = runComposer({
    available: [
      {
        id: "upstream:medium",
        model: "upstream",
        defaultReasoningEffort: "medium",
        isDefault: true,
      },
    ],
  });
  assert.equal(completeFallback.result.fallback.id, "upstream:medium");
  assert.equal(completeFallback.result.reset.id, "upstream:medium");
  assert.deepEqual(completeFallback.selections, []);

  const existingConversation = runComposer({
    available: [
      { id: "gpt-5.6-sol:medium", model: "gpt-5.6-sol", reasoningEffort: "medium" },
    ],
    conversationId: "existing",
  });
  assert.deepEqual(existingConversation.selections, []);

  const existingConfiguredSelection = runComposer({
    available: [
      { id: "gpt-5.6-sol:high", model: "gpt-5.6-sol", reasoningEffort: "high" },
    ],
    conversationId: "existing",
    manualSelection: true,
  });
  assert.deepEqual(existingConfiguredSelection.selections, [
    {
      effort: "high",
      model: "gpt-5.6-sol",
    },
  ]);

  const lifecycleHooks = { refs: [] };
  const lifecycleAvailable = [
    { id: "gpt-5.6-sol:medium", model: "gpt-5.6-sol", reasoningEffort: "medium" },
  ];
  const firstDraft = runComposer({ available: lifecycleAvailable, hookState: lifecycleHooks });
  const createdConversation = runComposer({
    available: lifecycleAvailable,
    conversationId: "created",
    hookState: lifecycleHooks,
  });
  const nextDraft = runComposer({ available: lifecycleAvailable, hookState: lifecycleHooks });
  assert.equal(firstDraft.selections.length, 0);
  assert.equal(createdConversation.selections.length, 0);
  assert.equal(nextDraft.selections.length, 0);

  const manuallySelected = runComposer({
    available: [
      { id: "gpt-5.6-sol:medium", model: "gpt-5.6-sol", reasoningEffort: "medium" },
      { id: "gpt-5.6-sol:high", model: "gpt-5.6-sol", reasoningEffort: "high" },
    ],
    manualSelection: true,
  });
  assert.deepEqual(manuallySelected.selections, [
    {
      effort: "high",
      model: "gpt-5.6-sol",
    },
  ]);
});

test("local composer patches fail closed on drift, duplicate, and partial states", () => {
  const presets = context([{ model: "gpt-5.6-sol", effort: "medium", default: true }]);
  for (const [apply, fixture, marker] of [
    [applyLocalComposerConfigPatch, localComposerFixture, LOCAL_COMPOSER_CONFIG_MARKER],
  ]) {
    for (const source of [
      "function unrelated(){}",
      fixture("One") + fixture("Two"),
      `${marker};${fixture()}`,
      fixture().replace(
        "[conversationId,hostId,host.cwd]",
        "[conversationId,host.hostId,host.cwd]",
      ),
    ]) {
      const { result, warnings } = withCapturedWarnings(() => apply(source, presets));
      assert.equal(result, source);
      assert.equal(warnings.length, 1);
    }
  }

  const driftedComposer = localComposerFixture().replace(
    /let reset=\(0,Picker\.zae\)\([^;]+;/u,
    "let reset=null;",
  );
  const decoy =
    "function Decoy(y,z){let x=(0,Picker.zae)(y,null==z?void 0:`${z.model}:${z.defaultReasoningEffort}`);return x}";
  const driftedWithDecoy = driftedComposer + decoy;
  const { result, warnings } = withCapturedWarnings(() =>
    applyLocalComposerConfigPatch(driftedWithDecoy, presets),
  );
  assert.equal(result, driftedWithDecoy);
  assert.equal(warnings.length, 1);
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
