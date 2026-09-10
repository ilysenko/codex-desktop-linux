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
  LOCAL_DEFAULT_PATCH_MARKER,
  LOCAL_COMPOSER_CONFIG_MARKER,
  LOCAL_COMPOSER_RESOLVER_MARKER,
  LOCAL_DRAFT_SELECTION_MARKER,
  SLIDER_PATCH_MARKER,
  applyCatalogPatch,
  applyLocalComposerConfigPatch,
  applyLocalComposerResolverPatch,
  applySliderMinimumPatch,
  catalogAssetMatch,
  catalogPatchContract,
  codexLinuxModelPickerDefaultPresets,
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
    "f=e.defaultThinkingEffortByModelSlug,p=e.defaultModelSlug;",
    "return{categories:e.categories,modelConfigBySlug:e.modelConfigBySlug,",
    "defaultThinkingEffortByModelSlug:f,defaultModelSlug:p,",
    "internalOptions:e.internalOptions,options:e.options,sliderSettings:d,",
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
    `function ${name}(e,{includeUltraInSlider:t=false,removeXHigh:n=false,sliderModelsConfig:r,stripGptPrefix:i=true}={}){`,
    "if(r!=null){let a=MapModels(e,{stripGptPrefix:i});for(let o of r.presets){",
    "let r=unique(resolve(o.filter(({reasoning_effort:e})=>(t||e!==`ultra`)&&(!n||e!==`xhigh`)),e,i),({id:e})=>e);",
    "if(r.length>=3)return r}}let a=fallbackA(e);if(a.length>=3)return a;",
    "let o=fallbackB(e);return o.length>=3?o:[]}",
    "function Next(){}",
  ].join("");
}

function localComposerFixture(name = "LocalComposer") {
  return [
    `function ${name}(available,serverConfig,upstreamDefault){`,
    "modelsForPicker(available);let{setDefaultModelAndReasoningEffort:setDefault}=selection;",
    "let He=available.find(Wqr),Ue=Power(available,{includeUltraInSlider:true,sliderModelsConfig:serverConfig,stripGptPrefix:true}),",
    "Ge=Ue,Ke=zae(Ge,He==null?void 0:`${He.model}:${He.defaultReasoningEffort}`);",
    "let choose=draft?.selectModelAndReasoningEffort??select,selected=choose(`gpt-5.6-sol`,`high`,()=>{});",
    "composer.mode.local.model.custom;let reset=zae(Ue,He==null?void 0:`${He.model}:${He.defaultReasoningEffort}`);",
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
    resolve: (entries) => entries.map(({ model, reasoning_effort: reasoningEffort }) => ({
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
  assert.equal(
    evaluate(
      patchedResolver,
      "LocalPower([],{sliderModelsConfig:config}).length",
      { ...resolverGlobals, config: onePairConfig },
    ),
    1,
  );
  assert.equal(
    evaluate(
      patchedResolver,
      "LocalPower([],{sliderModelsConfig:config}).length",
      { ...resolverGlobals, config: { presets: onePairConfig.presets } },
    ),
    0,
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
  assert.match(patchedComposer, /sliderModelsConfig:codexLinuxLocalDefaultPresetConfig/);
  const globals = {
    composer: { mode: { local: { model: { custom: null } } } },
    draft: null,
    modelsForPicker() {},
    selection: { setDefaultModelAndReasoningEffort() {} },
    Wqr: ({ isDefault }) => isDefault === true,
    zae: (selections, id) => selections.find((selection) => selection.id === id) ?? selections[0],
    Power: (available, { sliderModelsConfig }) => {
      const availableIds = new Set(available.map(({ id }) => id));
      const configured = sliderModelsConfig.presets[0].flatMap(({ model, reasoning_effort }) => {
        const id = `${model}:${reasoning_effort}`;
        return availableIds.has(id) ? [{ id, model, reasoningEffort: reasoning_effort }] : [];
      });
      return configured.length > 0 ? configured : available;
    },
    select: (_model, _effort, _callback, options) => options ?? null,
  };
  const unavailableDefault = plain(
    evaluate(
      patchedComposer,
      "LocalComposer([{id:'gpt-5.6-sol:high',model:'gpt-5.6-sol',reasoningEffort:'high'},{id:'upstream:medium',model:'upstream',defaultReasoningEffort:'medium',isDefault:true}],null,null)",
      { ...globals },
    ),
  );
  assert.equal(unavailableDefault.fallback.id, "gpt-5.6-sol:high");
  assert.equal(unavailableDefault.reset.id, "gpt-5.6-sol:high");
  assert.equal(unavailableDefault.selected.persistAsDefault, false);
  const completeFallback = plain(
    evaluate(
      patchedComposer,
      "LocalComposer([{id:'upstream:medium',model:'upstream',reasoningEffort:'medium',defaultReasoningEffort:'medium',isDefault:true}],null,null)",
      { ...globals },
    ),
  );
  assert.equal(completeFallback.fallback.id, "upstream:medium");
  assert.equal(completeFallback.reset.id, "upstream:medium");
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
    ]) {
      const { result, warnings } = withCapturedWarnings(() => apply(source, presets));
      assert.equal(result, source);
      assert.equal(warnings.length, 1);
    }
  }
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
  const writeConfig = (enabled) =>
    fs.writeFileSync(
      configPath,
      `${JSON.stringify({
        enabled,
        settings: {
          "model-picker-default-presets": {
            presets: [{ model: "gpt-6-astra", effort: "medium", default: true }],
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
    assert.equal(alone.length, 4);
    assert.ok(alone.every(({ featureId }) => featureId === "model-picker-default-presets"));
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
