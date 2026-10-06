#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const { loadLinuxFeaturePatchDescriptors } = require("../../scripts/lib/linux-features.js");
const { patchExtractedApp } = require("../../scripts/patches/runner.js");
const {
  CATALOG_PATCH_MARKER,
  CATALOG_PRESET_OPTIONS_KEY,
  EFFORT_TO_THINKING_EFFORT,
  EXISTING_CHAT_OPTIMISTIC_MARKER,
  LOCAL_DEFAULT_PATCH_MARKER,
  LOCAL_COMPOSER_CONFIG_MARKER,
  LOCAL_COMPOSER_RESOLVER_MARKER,
  LOCAL_DRAFT_SELECTION_MARKER,
  SLIDER_PATCH_MARKER,
  applyCatalogPatch,
  applyExistingChatOptimisticPatch,
  applyLocalComposerConfigPatch,
  applyLocalComposerResolverPatch,
  applySliderMinimumPatch,
  catalogAssetMatch,
  catalogPatchContract,
  codexLinuxModelPickerDefaultPresets,
  existingChatOptimisticContract,
  normalizePresets,
  localComposerConfigContract,
  localComposerResolverContract,
  sliderAssetMatch,
  sliderPatchContract,
} = require("./patch.js");

function context(presets) {
  return {
    feature: {
      manifest: { presets: [] },
      settings: { presets },
    },
  };
}

function catalogFixture(name = "FOr") {
  return [
    `function ${name}(e){`,
    "let d=e.slider_settings.flatMap(e=>e),",
    "f=e.defaultThinkingEffortByModelSlug,p=e.defaultModelSlug,S=[],",
    "w=(e.internalOptions??[]).flatMap(e=>e.thinkingEfforts==null?[e]:",
    "e.thinkingEfforts.map(t=>{let n=t.label;return{slug:e.slug,thinkingEffort:t.effort,title:n}}));",
    "return S.length>0&&S.push(`fast`),{categories:e.categories,modelConfigBySlug:e.modelConfigBySlug,",
    "defaultThinkingEffortByModelSlug:f,defaultModelSlug:p,",
    "internalOptions:w,options:e.options.map(e=>{let t=e;return{...t}}),sliderSettings:d,",
    "versionOptions:e.versionOptions,workspaceModelPolicy:e.workspaceModelPolicy}}",
    "function ZL(e,t){let n=[...e?.options??[],...e?.internalOptions??[],",
    "...e?.versionOptions?.flatMap(e=>e.options)??[]],",
    "r=t.thinkingEffort??e?.defaultThinkingEffortByModelSlug?.[t.slug]??null,",
    "i=n.find(e=>e.slug===t.slug&&(e.thinkingEffort??null)===r);",
    "return i!=null||t.thinkingEffort!=null?i:n.find(e=>e.slug===t.slug)}",
    "function Next(){}",
  ].join("");
}

function sliderFixture(name = "Wkr") {
  return [
    "function Power(e,t,n,{includeUltraInSlider:r=false,isTppConversation:i=false,selectionMode:a=`default`}={}){",
    "let l=e?.options??t??[],u=l.flatMap(({slug:e,thinkingEffort:t})=>[{modelSlug:e,thinkingEffort:t??null}]),",
    "d=e?.sliderSettings?.filter(({modelSlug:e})=>i&&a===`default`||l.some(({slug:t})=>t===e))??[],",
    "f=(i&&a===`default`&&d.length>0?d:[...u,...d]);",
    "return{powerSettings:f,selectionMode:a}}",
    `function ${name}(e){`,
    "let powerSelectionsWithXHigh=e,fallbackPowerSelection=e,",
    "show_xhigh_in_simple_picker=true,canInitializePowerPicker=true;",
    "if(powerSelectionsWithXHigh.length>=3)return powerSelectionsWithXHigh;",
    "return fallbackPowerSelection.length>=3?fallbackPowerSelection:[]}",
    "function Next(){}",
  ].join("");
}

function localComposerResolverFixture(name = "LocalPower") {
  return [
    `function ${name}(e,{removeXHigh:t=false,sliderModelsConfig:n,stripGptPrefix:r=true}={}){`,
    "if(n!=null){let i=MapModels(e,{stripGptPrefix:r});for(let a of n.presets){",
    "let n=a.filter(({reasoning_effort:e})=>!t||e!==`xhigh`).flatMap(({model:e,reasoning_effort:t})=>{let n=i.find(n=>n.model===e&&n.reasoningEffort===t);return n==null?[]:[n]}),o=unique(resolve(n,e,r),({id:e})=>e);",
    "if(o.length>=3)return o}}let i=fallbackA(e);if(i.length>=3)return i;",
    "let a=fallbackB(e);return a.length>=3?a:[]}",
    "function Next(){}",
  ].join("");
}

function localComposerFixture(name = "LocalComposer") {
  return [
    `function ${name}(available,serverConfig,conversationId,manualSelection){`,
    "let host={hostId:`local`,cwd:`/repo`},hostId=host.hostId;",
    "modelsForPicker(available);let{setDefaultModelAndReasoningEffort:setDefault}=selection,draftSelection=null;",
    "let He=available.find(Wqr),Ue=Power(available,{includeUltraInSlider:true,sliderModelsConfig:serverConfig,stripGptPrefix:true}),",
    "Ge=Ue,Ke=zae(Ge,He==null?void 0:`${He.model}:${He.defaultReasoningEffort}`);",
    "picker({resetContextKey:JSON.stringify([conversationId,hostId,host.cwd])});",
    "composer.mode.local.model.custom;let scratch=(0,React.useRef)(null),choose=function(e,t,n){let callback=()=>{};return draftSelection==null?select(normalize(e),t,callback,n):draftSelection.selectModelAndReasoningEffort(normalize(e),t,callback)};",
    "function normalize(e){return e}let selected=manualSelection?choose(`gpt-5.6-sol`,`high`):null;",
    "let reset=zae(Ue,He==null?void 0:`${He.model}:${He.defaultReasoningEffort}`);",
    "render({onSelectDefault:reset});",
    "return{powerSelections:Ue,fallback:Ke,reset,selected}}",
    "function Next(){}",
  ].join("");
}

function existingChatStateFixture(stateName = "q8a") {
  return [
    `function ${stateName}(e,t,n){`,
    "let store=e,host={authMethod:t??`chatgpt`},isChatGptAuth=host?.authMethod===`chatgpt`,",
    "target=n??[`conversation`,`thread`],hasManagedNewThreadSettings=false,",
    "setModelAndReasoningEffortForNextTurn=()=>true,",
    "error=Error(`No conversation available for next-turn model update`),",
    "de=async(t,n,r)=>{let i=target,o={model:t,reasoningEffort:n,serviceTier:r?.serviceTier};",
    "store.set($1,i,o),await Promise.resolve(!0).finally(()=>{store.get($1,i)===o&&store.set($1,i,null)});return o};",
    "return{hasManagedNewThreadSettings:hasManagedNewThreadSettings,",
    "setModelAndReasoningEffortForNextTurn:setModelAndReasoningEffortForNextTurn,",
    "setModelAndReasoningEffort:de,error}}",
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

function catalog(overrides = {}) {
  return {
    categories: ["manual-category"],
    defaultModelSlug: "upstream-default",
    defaultThinkingEffortByModelSlug: {
      "upstream-default": "standard",
      "gpt-6-astra": "standard",
      "gpt-5.6-sol": "min",
    },
    internalOptions: [{ slug: "internal-model", thinkingEffort: "extended" }],
    modelConfigBySlug: { "gpt-6-astra": { title: "Astra" } },
    options: [
      { slug: "upstream-default", thinkingEffort: "standard" },
      { slug: "gpt-6-astra", thinkingEffort: "standard" },
      { slug: "gpt-5.6-sol", thinkingEffort: "min" },
    ],
    sliderSettings: [{ modelSlug: "upstream-default", thinkingEffort: "standard" }],
    versionOptions: [
      {
        id: "version",
        options: [{ slug: "version-model", thinkingEffort: "xhigh" }],
      },
    ],
    workspaceModelPolicy: { newThreadPrecedence: "prefer_policy" },
    ...overrides,
  };
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

test("runtime preserves order and resolves configured efforts from available models", () => {
  const upstream = catalog();
  const configured = normalizePresets(
    context([
      { model: "gpt-5.6-sol", effort: "high" },
      { model: "version-model", effort: "xhigh" },
      { model: "gpt-6-astra", effort: "medium", default: true },
      { model: "internal-model", effort: "high" },
    ]),
  );
  const result = codexLinuxModelPickerDefaultPresets(upstream, configured);
  assert.deepEqual(result.sliderSettings, [
    { modelSlug: "gpt-5.6-sol", thinkingEffort: "extended" },
    { modelSlug: "version-model", thinkingEffort: "xhigh" },
    { modelSlug: "gpt-6-astra", thinkingEffort: "standard" },
    { modelSlug: "internal-model", thinkingEffort: "extended" },
  ]);
  assert.equal(result.defaultModelSlug, "gpt-6-astra");
  assert.equal(result.defaultThinkingEffortByModelSlug["gpt-6-astra"], "standard");
  assert.deepEqual(
    result.codexLinuxDefaultPresetOptions.map(({ slug, thinkingEffort }) => ({
      slug,
      thinkingEffort,
    })),
    [
      { slug: "gpt-5.6-sol", thinkingEffort: "extended" },
      { slug: "version-model", thinkingEffort: "xhigh" },
      { slug: "gpt-6-astra", thinkingEffort: "standard" },
      { slug: "internal-model", thinkingEffort: "extended" },
    ],
  );
  assert.strictEqual(result.options, upstream.options);
  assert.strictEqual(result.internalOptions, upstream.internalOptions);
  assert.strictEqual(result.versionOptions, upstream.versionOptions);
  assert.strictEqual(result.workspaceModelPolicy, upstream.workspaceModelPolicy);
  assert.strictEqual(result.categories, upstream.categories);
});

test("runtime filters unavailable models and falls back from an unavailable default", () => {
  const configured = normalizePresets(
    context([
      { model: "missing", effort: "medium", default: true },
      { model: "gpt-5.6-sol", effort: "high" },
      { model: "gpt-5.6-sol", effort: "ultra" },
    ]),
  );
  const result = codexLinuxModelPickerDefaultPresets(catalog(), configured);
  assert.deepEqual(result.sliderSettings, [
    { modelSlug: "gpt-5.6-sol", thinkingEffort: "extended" },
    { modelSlug: "gpt-5.6-sol", thinkingEffort: "ultra" },
  ]);
  assert.equal(result.defaultModelSlug, "gpt-5.6-sol");
  assert.equal(result.defaultThinkingEffortByModelSlug["gpt-5.6-sol"], "extended");
});

test("runtime returns the exact upstream catalog when every pair is unavailable", () => {
  const upstream = catalog();
  const configured = normalizePresets(
    context([{ model: "missing", effort: "ultra", default: true }]),
  );
  assert.strictEqual(codexLinuxModelPickerDefaultPresets(upstream, configured), upstream);
});

test("catalog patch has one semantic target, is executable, and is idempotent", () => {
  const presets = context([
    { model: "gpt-6-astra", effort: "medium", default: true },
    { model: "gpt-5.6-sol", effort: "high" },
  ]);
  const source = catalogFixture();
  assert.equal(catalogPatchContract(source), "current");
  assert.equal(catalogAssetMatch(source), true);
  const patched = applyCatalogPatch(source, presets);
  assert.equal(catalogPatchContract(patched), "applied");
  assert.equal((patched.match(new RegExp(CATALOG_PATCH_MARKER, "g")) ?? []).length, 2);
  assert.equal((patched.match(new RegExp(CATALOG_PRESET_OPTIONS_KEY, "g")) ?? []).length, 2);
  assert.equal(applyCatalogPatch(patched, presets), patched);
  const result = plain(evaluate(patched, "FOr(input)", { input: catalog({ slider_settings: [] }) }));
  assert.deepEqual(result.sliderSettings, [
    { modelSlug: "gpt-6-astra", thinkingEffort: "standard" },
    { modelSlug: "gpt-5.6-sol", thinkingEffort: "extended" },
  ]);
  assert.equal(result.defaultModelSlug, "gpt-6-astra");
  assert.equal(
    plain(evaluate(patched, "ZL(result,{slug:'gpt-5.6-sol',thinkingEffort:'extended'})", {
      result,
    })).thinkingEffort,
    "extended",
  );
});

test("catalog patch fails closed on drift, duplicate, and partial states", () => {
  const presets = context([{ model: "gpt-6-astra", effort: "medium", default: true }]);
  for (const source of [
    "function unrelated(){}",
    catalogFixture("One") + catalogFixture("Two"),
    `${CATALOG_PATCH_MARKER};${catalogFixture()}`,
    `${CATALOG_PRESET_OPTIONS_KEY};${catalogFixture()}`,
  ]) {
    const { result, warnings } = withCapturedWarnings(() => applyCatalogPatch(source, presets));
    assert.equal(result, source);
    assert.equal(warnings.length, 1);
  }
});

test("slider minimum makes two entries a slider while one stays fixed", () => {
  const presets = context([
    { model: "gpt-6-astra", effort: "medium", default: true },
    { model: "gpt-5.6-sol", effort: "high" },
    { model: "model-low", effort: "low" },
    { model: "model-none", effort: "none" },
    { model: "model-max", effort: "max" },
  ]);
  const source = sliderFixture();
  assert.equal(sliderPatchContract(source), "current");
  assert.equal(sliderAssetMatch(source, "fixture.js", presets), true);
  const patched = applySliderMinimumPatch(source, presets);
  assert.equal(sliderPatchContract(patched), "applied");
  assert.equal((patched.match(new RegExp(SLIDER_PATCH_MARKER, "g")) ?? []).length, 1);
  assert.equal((patched.match(new RegExp(LOCAL_DEFAULT_PATCH_MARKER, "g")) ?? []).length, 1);
  assert.equal(applySliderMinimumPatch(patched, presets), patched);
  const catalogWithCustomDefault = {
    codexLinuxDefaultPresetOptions: [{}],
    options: [{ slug: "server", thinkingEffort: "min" }],
    sliderSettings: [
      { modelSlug: "gpt-6-astra", thinkingEffort: "standard" },
      { modelSlug: "gpt-5.6-sol", thinkingEffort: "extended" },
    ],
  };
  assert.deepEqual(
    plain(evaluate(patched, "Power(input,null,null,{isTppConversation:false,selectionMode:'default'}).powerSettings", {
      input: catalogWithCustomDefault,
    })),
    catalogWithCustomDefault.sliderSettings,
  );
  assert.equal(
    plain(
      evaluate(
        patched,
        "Power(input,null,null,{isTppConversation:false,selectionMode:'model'}).powerSettings.length",
        { input: catalogWithCustomDefault },
      ),
    ),
    1,
  );
  const configured = [
    { id: "gpt-6-astra:medium" },
    { id: "gpt-5.6-sol:high" },
    { id: "model-low:low" },
    { id: "model-none:none" },
    { id: "model-max:max" },
  ];
  assert.deepEqual(plain(evaluate(patched, "Wkr(input)", { input: configured.slice(0, 1) })), []);
  assert.deepEqual(
    plain(evaluate(patched, "Wkr(input)", { input: configured.slice(0, 2) })),
    configured.slice(0, 2),
  );
  assert.deepEqual(
    plain(evaluate(patched, "Wkr(input)", { input: configured })),
    configured,
  );
  assert.deepEqual(
    plain(
      evaluate(patched, "Wkr(input)", {
        input: [{ id: "server-a:low" }, { id: "server-b:high" }],
      }),
    ),
    [],
  );
});

test("slider patch fails closed on drift, duplicate, and partial states", () => {
  const presets = context([{ model: "gpt-6-astra", effort: "medium", default: true }]);
  for (const source of [
    "function unrelated(){}",
    sliderFixture("One") + sliderFixture("Two"),
    sliderFixture().replace("{", `{/*${SLIDER_PATCH_MARKER}*/`),
    sliderFixture().replace("f=(", `f=(/*${LOCAL_DEFAULT_PATCH_MARKER}*/`),
  ]) {
    const { result, warnings } = withCapturedWarnings(() =>
      applySliderMinimumPatch(source, presets),
    );
    assert.equal(result, source);
    assert.equal(warnings.length, 1);
  }
});

test("local composer uses configured pairs and lowers only its config threshold", () => {
  const presets = context([
    { model: "gpt-5.6-sol", effort: "medium", default: true },
    { model: "gpt-5.6-sol", effort: "high" },
    { model: "gpt-6-astra", effort: "high" },
  ]);
  const resolverSource = localComposerResolverFixture();
  assert.equal(localComposerResolverContract(resolverSource), "current");
  const patchedResolver = applyLocalComposerResolverPatch(resolverSource, presets);
  assert.equal(localComposerResolverContract(patchedResolver), "applied");
  assert.equal(applyLocalComposerResolverPatch(patchedResolver, presets), patchedResolver);
  assert.equal(
    (patchedResolver.match(new RegExp(LOCAL_COMPOSER_RESOLVER_MARKER, "g")) ?? []).length,
    1,
  );
  const resolverGlobals = {
    fallbackA: () => [],
    fallbackB: () => [],
    MapModels: (models) => models,
    resolve: (entries) => entries.map(({ model, reasoningEffort }) => ({
      id: `${model}:${reasoningEffort}`,
      model,
      reasoningEffort,
    })),
    unique: (entries) => entries,
  };
  const onePairConfig = {
    codexLinuxDefaultPresets: true,
    presets: [[{ model: "gpt-5.6-sol", reasoning_effort: "high" }]],
  };
  const available = [
    { model: "gpt-5.6-sol", reasoningEffort: "high" },
    { model: "gpt-5.6-sol", reasoningEffort: "xhigh" },
  ];
  assert.equal(
    evaluate(
      patchedResolver,
      "LocalPower(available,{sliderModelsConfig:config}).length",
      { ...resolverGlobals, config: onePairConfig, available },
    ),
    1,
  );
  assert.equal(
    evaluate(
      patchedResolver,
      "LocalPower(available,{sliderModelsConfig:config}).length",
      { ...resolverGlobals, config: { presets: onePairConfig.presets }, available },
    ),
    0,
  );

  const twoPairConfig = {
    codexLinuxDefaultPresets: true,
    presets: [[
      { model: "missing", reasoning_effort: "high" },
      { model: "gpt-5.6-sol", reasoning_effort: "xhigh" },
      { model: "gpt-5.6-sol", reasoning_effort: "high" },
    ]],
  };
  for (const removeXHigh of [false, true]) {
    assert.deepEqual(
      plain(evaluate(
        patchedResolver,
        "LocalPower(available,{sliderModelsConfig:config,removeXHigh}).map(({id})=>id)",
        { ...resolverGlobals, available, config: twoPairConfig, removeXHigh },
      )),
      removeXHigh ? ["gpt-5.6-sol:high"] : ["gpt-5.6-sol:xhigh", "gpt-5.6-sol:high"],
    );
  }
  assert.deepEqual(
    plain(evaluate(patchedResolver, "LocalPower([],{sliderModelsConfig:config})", {
      ...resolverGlobals, config: twoPairConfig,
      fallbackA: () => [{ id: "upstream-a" }, { id: "upstream-b" }, { id: "upstream-c" }],
    })),
    [{ id: "upstream-a" }, { id: "upstream-b" }, { id: "upstream-c" }],
  );

  const composerSource = localComposerFixture();
  assert.equal(localComposerConfigContract(composerSource), "current");
  const patchedComposer = applyLocalComposerConfigPatch(composerSource, presets);
  assert.equal(localComposerConfigContract(patchedComposer), "applied");
  assert.equal(applyLocalComposerConfigPatch(patchedComposer, presets), patchedComposer);
  assert.equal(
    (patchedComposer.match(new RegExp(LOCAL_COMPOSER_CONFIG_MARKER, "g")) ?? []).length,
    1,
  );
  assert.equal(
    (patchedComposer.match(new RegExp(LOCAL_DRAFT_SELECTION_MARKER, "g")) ?? []).length,
    1,
  );
  assert.match(patchedComposer, /gpt-5\.6-sol:medium/);
  assert.match(
    patchedComposer,
    /sliderModelsConfig:serverConfig==null\?serverConfig:codexLinuxLocalDefaultPresetConfig/,
  );
  assert.match(
    patchedComposer,
    /codexLinuxLocalDraftDefaultScope=conversationId==null\?JSON\.stringify\(\[hostId,host\.cwd\]\):null/,
  );
  const runComposer = ({
    available,
    conversationId = null,
    hookState = { refs: [] },
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
      manualSelection,
      modelsForPicker() {},
      picker() {},
      render() {},
      selection: { setDefaultModelAndReasoningEffort() {} },
      serverConfig,
      Wqr: ({ isDefault }) => isDefault === true,
      zae: (selections, id) =>
        selections.find((selection) => selection.id === id) ?? selections[0],
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
  assert.deepEqual(unavailableDefault.selections, [
    {
      effort: "high",
      model: "gpt-5.6-sol",
      options: { persistAsDefault: false },
    },
  ]);

  const configuredDefault = runComposer({
    available: [
      { id: "gpt-5.6-sol:high", model: "gpt-5.6-sol", reasoningEffort: "high" },
      { id: "gpt-5.6-sol:medium", model: "gpt-5.6-sol", reasoningEffort: "medium" },
    ],
  });
  assert.deepEqual(configuredDefault.selections[0], {
    effort: "medium",
    model: "gpt-5.6-sol",
    options: { persistAsDefault: false },
  });

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
  assert.equal(firstDraft.selections.length, 1);
  assert.equal(createdConversation.selections.length, 0);
  assert.equal(nextDraft.selections.length, 1);

  const manuallySelected = runComposer({
    available: [
      { id: "gpt-5.6-sol:medium", model: "gpt-5.6-sol", reasoningEffort: "medium" },
      { id: "gpt-5.6-sol:high", model: "gpt-5.6-sol", reasoningEffort: "high" },
    ],
    manualSelection: true,
  });
  assert.equal(manuallySelected.result.selected.persistAsDefault, false);
  assert.deepEqual(manuallySelected.selections, [
    {
      effort: "high",
      model: "gpt-5.6-sol",
      options: { persistAsDefault: false },
    },
  ]);
});

test("existing chats retain configured optimistic selections until another selection replaces them", async () => {
  const presets = context([
    { model: "gpt-5.6-sol", effort: "medium", default: true },
    { model: "gpt-5.6-sol", effort: "xhigh" },
  ]);
  const source = existingChatStateFixture();
  assert.equal(existingChatOptimisticContract(source), "current");
  const patched = applyExistingChatOptimisticPatch(source, presets);
  assert.equal(existingChatOptimisticContract(patched), "applied");
  assert.equal(applyExistingChatOptimisticPatch(patched, presets), patched);
  assert.equal(
    (patched.match(new RegExp(EXISTING_CHAT_OPTIMISTIC_MARKER, "g")) ?? []).length,
    2,
  );

  const state = new Map();
  const key = (_atom, target) => JSON.stringify(target);
  const store = {
    get(atom, target) {
      return state.get(`${atom}:${key(atom, target)}`);
    },
    set(atom, target, value) {
      state.set(`${atom}:${key(atom, target)}`, value);
    },
  };
  const globals = {
    $1: "pending",
    store,
  };
  const configured = await evaluate(
    patched,
    "q8a(store).setModelAndReasoningEffort('gpt-5.6-sol','xhigh')",
    { ...globals },
  );
  const target = ["conversation", "thread"];
  assert.strictEqual(store.get("pending", target), configured);

  const translatedConfigured = await evaluate(
    patched,
    "q8a(store).setModelAndReasoningEffort('gpt-5.6-sol','standard')",
    { ...globals },
  );
  assert.equal(translatedConfigured.codexLinuxKeepOptimisticSelection, true);

  const nonChatGptConfigured = await evaluate(
    patched,
    "q8a(store,'api-key').setModelAndReasoningEffort('gpt-5.6-sol','xhigh')",
    { ...globals },
  );
  assert.equal(nonChatGptConfigured.codexLinuxKeepOptimisticSelection, false);

  const newThreadConfigured = await evaluate(
    patched,
    "q8a(store,undefined,['default','local','/repo']).setModelAndReasoningEffort('gpt-5.6-sol','xhigh')",
    { ...globals },
  );
  assert.equal(newThreadConfigured.codexLinuxKeepOptimisticSelection, false);

  const manual = await evaluate(
    patched,
    "q8a(store).setModelAndReasoningEffort('gpt-6-astra','standard')",
    { ...globals },
  );
  assert.equal(manual.codexLinuxKeepOptimisticSelection, false);
  assert.equal(store.get("pending", target), null);
});

test("existing-chat patch fails closed on drift, duplicate, and partial states", () => {
  const presets = context([{ model: "gpt-5.6-sol", effort: "medium", default: true }]);
  for (const source of [
    "function unrelated(){}",
    existingChatStateFixture("qOne") + existingChatStateFixture("qTwo"),
    `${EXISTING_CHAT_OPTIMISTIC_MARKER};${existingChatStateFixture()}`,
  ]) {
    const { result, warnings } = withCapturedWarnings(() =>
      applyExistingChatOptimisticPatch(source, presets),
    );
    assert.equal(result, source);
    assert.equal(warnings.length, 1);
  }
});

test("local composer patches fail closed on drift, duplicate, and partial states", () => {
  const presets = context([{ model: "gpt-5.6-sol", effort: "medium", default: true }]);
  for (const [apply, fixture, marker] of [
    [applyLocalComposerResolverPatch, localComposerResolverFixture, LOCAL_COMPOSER_RESOLVER_MARKER],
    [applyLocalComposerConfigPatch, localComposerFixture, LOCAL_COMPOSER_CONFIG_MARKER],
  ]) {
    for (const source of [
      "function unrelated(){}",
      fixture("One") + fixture("Two"),
      `${marker};${fixture()}`,
      ...(apply === applyLocalComposerResolverPatch ? [
        fixture().replace("removeXHigh:", "changed:"),
        fixture().replace("if(o.length>=3)return o", "if(o.length>=4)return o"),
      ] : [fixture().replace(
        "[conversationId,hostId,host.cwd]",
        "[conversationId,host.hostId,host.cwd]",
      )]),
    ]) {
      const { result, warnings } = withCapturedWarnings(() => apply(source, presets));
      assert.equal(result, source);
      assert.equal(warnings.length, 1);
    }
  }

  const driftedComposer = localComposerFixture().replace(
    /let reset=zae\([^;]+;/u,
    "let reset=null;",
  );
  const decoy =
    "function Decoy(y,z){let x=zae(y,z==null?void 0:`${z.model}:${z.defaultReasoningEffort}`);return x}";
  const driftedWithDecoy = driftedComposer + decoy;
  const { result, warnings } = withCapturedWarnings(() =>
    applyLocalComposerConfigPatch(driftedWithDecoy, presets),
  );
  assert.equal(result, driftedWithDecoy);
  assert.equal(warnings.length, 1);
});

test("empty manifest is a runtime passthrough used for compatibility auditing", () => {
  const passthrough = { feature: { manifest: { presets: [] }, settings: {} } };
  const patchedCatalog = applyCatalogPatch(catalogFixture(), passthrough);
  const upstream = catalog({ slider_settings: [{ modelSlug: "server", thinkingEffort: "min" }] });
  assert.deepEqual(plain(evaluate(patchedCatalog, "FOr(input)", { input: upstream })), {
    categories: upstream.categories,
    modelConfigBySlug: upstream.modelConfigBySlug,
    defaultThinkingEffortByModelSlug: upstream.defaultThinkingEffortByModelSlug,
    defaultModelSlug: upstream.defaultModelSlug,
    internalOptions: upstream.internalOptions,
    options: upstream.options,
    sliderSettings: upstream.slider_settings,
    versionOptions: upstream.versionOptions,
    workspaceModelPolicy: upstream.workspaceModelPolicy,
  });
  assert.equal(applySliderMinimumPatch(sliderFixture(), passthrough), sliderFixture());
  assert.equal(sliderAssetMatch(sliderFixture(), "fixture.js", passthrough), false);
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
    assert.equal(alone.length, 5);
    assert.ok(alone.every(({ featureId }) => featureId === "model-picker-default-presets"));
    const [scenario] = require("./feature.json").officialBundleAuditScenarios;
    writeConfig(["model-picker-default-presets"], scenario.settings.presets);
    assert.equal(loadLinuxFeaturePatchDescriptors({
      featuresRoot: root,
      featuresConfigPath: configPath,
    }).length, 5);
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
