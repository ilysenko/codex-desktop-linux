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
  EXISTING_CHAT_OPTIMISTIC_MARKER,
  LOCAL_DEFAULT_PATCH_MARKER,
  LOCAL_COMPOSER_CONFIG_MARKER,
  LOCAL_COMPOSER_RESOLVER_MARKER,
  applyExistingChatOptimisticPatch,
  applyLocalComposerConfigPatch,
  applyLocalComposerResolverPatch,
  existingChatOptimisticContract,
  normalizePresets,
  localComposerConfigContract,
  localComposerResolverContract,
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
function rspackModuleExports(source, id, globals = {}) {
  const modules = vm.runInNewContext(
    `${source.replaceAll("export const ", "const ")};__webpack_modules__`,
    globals,
  );
  const exports = {};
  const require = () => ({object:()=>({parse:input=>input})});
  require.n = (module) => () => module;
  require.d = (target, definitions, values = {}) => {
    Object.assign(target, values);
    for (const [name, getter] of Object.entries(definitions)) {
      Object.defineProperty(target, name, { enumerable: true, get: getter });
    }
  };
  modules[id]({}, exports, require);
  return exports;
}

function defaultOptionBuilderModule(name = "o") {
  return [
    `function ${name}(e,{isTppConversation:t=!1,includeSyntheticDefault:n=!1,paidModelFallbackEnabled:r=!1}){`,
    "let i=e?.versionOptions?.find(({slugs:t,options:n})=>t.includes(e.defaultModelSlug)&&n.length>0)?.options??e?.options??[],",
    "s=e?.sliderSettings?.length?e.sliderSettings:d(i,t);",
    "return{defaultOption:n||r?{...c(e,i,s),isDefault:!0}:void 0,",
    "versionOptions:e?.versionOptions?.map(n=>({...r?c(e,n.options,s):l(e,n.options,{isTppConversation:t}),version:n}))??[]}}",
    "function l(e,t,{isTppConversation:n=!1}={}){",
    "let r=e?.sliderSettings?.filter(({modelSlug:e})=>t.some(({slug:t})=>t===e))??[];",
    "return c(e,t,[...d(t,n),...r])}",
    "function d(e,t){return e.flatMap(({slug:e,thinkingEffort:n})=>t&&null==n?[]:[{modelSlug:e,thinkingEffort:n??null}])}",
    "function c(e,t,n){let r=n.flatMap(({modelSlug:n,thinkingEffort:r})=>t.find(e=>e.slug===n&&(e.thinkingEffort??null)===r)??[]);",
    "return{isDefault:!1,options:[...t,...r],powerSettings:n}}",
    `n.d(t,{nX:()=>${name}})`,
  ].join("");
}

function defaultOptionBuilderFixture(module = defaultOptionBuilderModule()) {
  return rspackChunk({
    // Another factory reuses the minified builder name for unrelated code.
    Aaaa: 'function c(e,t,n){return"unrelated"}n.d(t,{c:()=>c})',
    TuVM: module,
  });
}

function localComposerResolverFixture(name = "LocalPower") {
  return [
    `function ${name}(e,{removeXHigh:t=false,sliderModelsConfig:n,stripGptPrefix:r=true}={}){`,
    "if(n!=null){let i=MapModels(e,{stripGptPrefix:r});for(let a of n.presets){",
    'let n=a.filter(({reasoning_effort:e})=>!t||"xhigh"!==e).flatMap(({model:e,reasoning_effort:t})=>{let n=i.find(n=>n.model===e&&n.reasoningEffort===t);return null==n?[]:[n]}),o=unique(resolve(n,e,r),({id:e})=>e);',
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

function existingChatStateFixture(stateName = "q8a") {
  return [
    `function ${stateName}(e,t,n){`,
    'let store=e,host={authMethod:t??"chatgpt"},isChatGptAuth=host?.authMethod==="chatgpt",',
    'target=n??["conversation","thread"],hasManagedNewThreadSettings=!1,',
    "setModelAndReasoningEffortForNextTurn=()=>true,",
    'error=Error("No conversation available for next-turn model update"),',
    "de=async(t,n,r)=>{let i=target,o={model:t,reasoningEffort:n,serviceTier:r?.threadSettings.serviceTier};",
    "void 0!==o.serviceTier&&store.set(I.pu,{conversationId:i},null),",
    "store.set(I.EX,i,o),await (async()=>!0)().finally(()=>{store.get(I.EX,i)===o&&store.set(I.EX,i,null)});return o};",
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
        slugs: ["version-model"],
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

test("upstream Default option reads ordered catalog slider while version options keep their models", () => {
  const presets = context([
    { model: "gpt-6-astra", effort: "medium", default: true },
    { model: "gpt-5.6-sol", effort: "high" },
  ]);
  const merged = catalog({sliderSettings:normalizePresets(presets).map(({modelSlug,thinkingEffort})=>({modelSlug,thinkingEffort}))});
  const { nX: buildPickerOptions } = rspackModuleExports(defaultOptionBuilderFixture(), "TuVM");
  const defaults = buildPickerOptions(merged, { includeSyntheticDefault: true });
  assert.deepEqual(plain(defaults.defaultOption.powerSettings), [
    { modelSlug: "gpt-6-astra", thinkingEffort: "standard" },
    { modelSlug: "gpt-5.6-sol", thinkingEffort: "extended" },
  ]);
  assert.deepEqual(plain(defaults.versionOptions[0].powerSettings), [
    { modelSlug: "version-model", thinkingEffort: "xhigh" },
  ]);
});

test("upstream Default-selection compatibility audit fails closed on missing and ambiguous replacements", () => {
  const presets = context([{ model: "gpt-6-astra", effort: "medium", default: true }]);
  const fixture = defaultOptionBuilderFixture();
  assert.equal(javascriptSourceParses(fixture), true);
  assert.equal(upstreamDefaultSelectionContract(fixture), "current");
  assert.equal(upstreamDefaultSelectionAssetMatch(fixture, "async/1.js", presets), true);
  assert.equal(
    upstreamDefaultSelectionAssetMatch(fixture, "async/1.js", {
      feature: { manifest: { presets: [] }, settings: {} },
    }),
    false,
  );
  const module = defaultOptionBuilderModule();
  for (const drifted of [
    "function unrelated(){}",
    `${defaultOptionBuilderModule()}${defaultOptionBuilderModule("p")}`,
    module.replace("includeSyntheticDefault:", "includeDefault:"),
    module.replace(
      "s=e?.sliderSettings?.length?e.sliderSettings:d(i,t)",
      "s=[...d(i,t),...e?.sliderSettings??[]]",
    ),
    module.replace("{...c(e,i,s),isDefault:!0}", "{...c(e,i,d(i,t)),isDefault:!0}"),
    module.replace("powerSettings:n}}", "powerSettings:r}}"),
  ]) {
    const source = defaultOptionBuilderFixture(drifted);
    assert.equal(upstreamDefaultSelectionContract(source), "drifted");
    assert.equal(upstreamDefaultSelectionAssetMatch(source, "async/1.js", presets), false);
  }
  // Without the rspack module registry the builder cannot be scoped.
  assert.equal(upstreamDefaultSelectionContract(module), "drifted");
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
    I: { EX: "pending", pu: "service-tier" },
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
