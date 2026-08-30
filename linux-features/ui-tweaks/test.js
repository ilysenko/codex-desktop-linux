#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

require("./suggested-prompts.test.js");
require("./dock-icon.test.js");

const {
  discoverLinuxFeatureManifests,
  loadLinuxFeaturePatchDescriptors,
} = require("../../scripts/lib/linux-features.js");
const {
  ADVANCED_MENU_VIEW_PATTERN,
  DYNAMIC_POWER_EFFORTS_RUNTIME_MARKER,
  INLINE_MODEL_LIST_RUNTIME_MARKER,
  MODEL_PICKER_EFFORT_ASSET_PATTERN,
  MODEL_PICKER_INLINE_ASSET_PATTERN,
  MODEL_PICKER_STATE_ASSET_PATTERN,
  SIMPLE_MENU_VIEW_PATTERN,
  applyDefaultAdvancedViewPatch,
  applyDynamicSupportedReasoningEffortsPatch,
  applyInlineModelListPatch,
} = require("./patches/model-picker-model-list.js");
const {
  DEFAULT_PROJECT_NAME_STYLE,
  PROJECT_ROW_ATTRIBUTE,
  PROJECTS_SIDEBAR_ASSET_PATTERN,
  PROJECT_NAME_SELECTOR,
  RUNTIME_MARKER,
  STYLE_ID,
  applySidebarProjectNameStylePatch,
  descriptors: patches,
  sidebarProjectNameCss,
} = require("./patches/sidebar-project-name.js");
const {
  ENGLISH_REASONING_LABELS,
  ZH_CN_LOCALE_ASSET_PATTERN,
  applyEnglishReasoningLabels,
} = require("./patches/reasoning-effort-labels.js");
const {
  DEFAULT_MAX_UI_FONT_SIZE,
  EXPECTED_FONT_SIZE_BUNDLE_COUNT,
  MAX_CONFIGURABLE_UI_FONT_SIZE,
  MIN_EXTENDED_UI_FONT_SIZE,
  RUNTIME_MARKER: UI_FONT_SIZE_RUNTIME_MARKER,
  applyUiFontSizeAppPatch,
  applyUiFontSizePatch,
  findUiFontSizeBundles,
  normalizedMaxUiFontSize,
} = require("./patches/ui-font-size.js");

function projectBundleFixture() {
  return [
    `var actions={sidebarProjectRow:\`${PROJECT_ROW_ATTRIBUTE}\`};`,
    "function marquee(e){return(0,Iy.jsx)(`span`,{...e,\"data-marquee-text\":!0})}",
    "function projectRow(){let p=actions.sidebarProjectRow({collapsed:r,label:c,projectId:l});",
    "let E=(0,Iy.jsx)(Marquee,{className:`select-none`,animateOnGroupHover:!0,children:c});",
    "return(0,Iy.jsx)(FolderRow,{...p,label:E})}",
  ].join("");
}

function modelPickerStateBundleFixture() {
  return [
    "function picker(){",
    "vz=wu(`composer-model-picker-menu-view-v1`,`simple`);",
    "}",
    "function j_s(e){",
    "let d=`chatgpt-model-picker`,[h,g]=(0,F_s.useState)(``),[_,v]=(0,F_s.useState)(`simple`);",
    "return _}",
    "function next(){}",
  ].join("");
}

function modelPickerMenuBundleFixture() {
  return [
    "function j_s(){",
    "id:`composer.intelligenceDropdown.effort.title`;",
    "let re=[{id:`metadata`}],ie=re.find(e=>e.id),Ce=`label`,se=`text`;",
    "we=(0,K1.jsxs)(K1.Fragment,{children:[Ce,se]});return we}",
    "function Cgs(e){",
    "let t=[],{advancedConfig:r,hideAdvancedSubmenus:i}=e,v=i!==void 0&&i,ce;",
    "t[43]!==r.model||t[44]!==v?(ce=v||r.model==null?null:(0,H1.jsx)(wgs,{submenu:r.model}),t[43]=r.model,t[44]=v,t[45]=ce):ce=t[45];",
    "return ce}",
    "function wgs(e){",
    "let n=e.submenu,o=n.title==null?null:(0,H1.jsx)(hH.Title,{children:n.title}),l=n.options.map(Tgs);return [o,l]}",
    "function Tgs(e){return(0,H1.jsx)(hH.Item,{RightIcon:e.selected?fv:void 0,onSelect:t=>{t.preventDefault(),e.onSelect()},children:e.label},e.id)}",
    "function XVs(){",
    "id:`composer.intelligenceDropdown.model.title`;",
    "let g=fragment,ie=g;let fe;",
    "id:`composer.intelligenceDropdown.model.rowLabel`;}",
  ].join("");
}

function modelPickerPowerBundleFixture() {
  return [
    "function ARe(e,{includeUltraInSlider:t=!1,removeXHigh:n=!1}={}){let r=PRe((t?[...FRe,URe]:FRe).filter(({reasoningEffort:e})=>!n||e!==`xhigh`),e);if(r.length>=3)return r;let i=PRe(IRe.filter(({reasoningEffort:e})=>!n||e!==`xhigh`),e);return i.length>=3?i:[]}",
    "function MRe(e){return e?.flatMap(({displayName:e,model:t,supportedReasoningEfforts:n})=>{let r=e==null?`Custom`:e,i=n.flatMap(({reasoningEffort:e})=>[e]);return(i.length>0?i:[`medium`]).map(e=>({id:`${t}:${e}`,model:t,modelLabel:r,reasoningEffort:e}))})??[]}",
    "function PRe(e,t){return e.flatMap((e,n)=>t?.some(t=>t.model===e.model&&t.supportedReasoningEfforts.some(({reasoningEffort:t})=>t===e.reasoningEffort))?[{...e,powerSettingIndex:n}]:[])}",
    "var FRe=[{id:`gpt-5.6-terra:low`,model:`gpt-5.6-terra`,modelLabel:`5.6 Terra`,reasoningEffort:`low`},{id:`gpt-5.6-sol:low`,model:`gpt-5.6-sol`,modelLabel:`5.6 Sol`,reasoningEffort:`low`},{id:`gpt-5.6-sol:medium`,model:`gpt-5.6-sol`,modelLabel:`5.6 Sol`,reasoningEffort:`medium`},{id:`gpt-5.6-sol:high`,model:`gpt-5.6-sol`,modelLabel:`5.6 Sol`,reasoningEffort:`high`},{id:`gpt-5.6-sol:xhigh`,model:`gpt-5.6-sol`,modelLabel:`5.6 Sol`,reasoningEffort:`xhigh`}];",
    "var URe={id:`gpt-5.6-sol:ultra`,model:`gpt-5.6-sol`,modelLabel:`5.6 Sol`,reasoningEffort:`ultra`};",
    "var IRe=[{id:`gpt-5.6-terra:low`,model:`gpt-5.6-terra`,modelLabel:`5.6 Terra`,reasoningEffort:`low`},{id:`gpt-5.6-terra:medium`,model:`gpt-5.6-terra`,modelLabel:`5.6 Terra`,reasoningEffort:`medium`},{id:`gpt-5.6-terra:high`,model:`gpt-5.6-terra`,modelLabel:`5.6 Terra`,reasoningEffort:`high`},{id:`gpt-5.6-terra:xhigh`,model:`gpt-5.6-terra`,modelLabel:`5.6 Terra`,reasoningEffort:`xhigh`}];",
  ].join("");
}

function filteredGpt56Models(enabledReasoningEfforts) {
  const enabled = new Set(enabledReasoningEfforts);
  return [
    {
      displayName: "GPT-5.6-Terra",
      model: "gpt-5.6-terra",
      supportedReasoningEfforts: ["low", "medium", "high", "xhigh"]
        .filter((reasoningEffort) => enabled.has(reasoningEffort))
        .map((reasoningEffort) => ({ reasoningEffort })),
    },
    {
      displayName: "GPT-5.6-Sol",
      model: "gpt-5.6-sol",
      supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"]
        .filter((reasoningEffort) => enabled.has(reasoningEffort))
        .map((reasoningEffort) => ({ reasoningEffort })),
    },
  ];
}

function simplifiedChineseLocaleFixture() {
  const labels = {
    "composer.mode.local.reasoning.none.label": "无",
    "composer.mode.local.reasoning.minimal.label": "极低",
    "composer.mode.local.reasoning.medium.label": "中",
    "composer.mode.local.reasoning.high.label": "高",
    "composer.mode.local.reasoning.xhigh.label": "极高",
    "composer.mode.local.reasoning.max.label": "最高",
    "composer.mode.local.reasoning.ultra.label": "极高",
  };
  return Object.entries(labels)
    .map(([key, value]) => `"${key}":\`${value}\``)
    .join(",");
}

function uiFontSizeBundleFixture() {
  return [
    "var Wu,Gu,Input,Aje=setup(()=>{",
    "Wu={sans:{min:11,max:16},code:{min:8,max:24}},",
    "Gu={sansFontSize:setting({default:14,schema:number().min(Wu.sans.min).max(Wu.sans.max)})},",
    "Input=input({min:Wu.sans.min,max:Wu.sans.max})",
    "});",
    "function fontSizeState(){return {input:Input,limits:Wu,setting:Gu.sansFontSize}}",
  ].join("");
}

function uiFontSizeContext(overrides = {}) {
  return {
    feature: {
      manifest: {
        tweaks: {
          appearance: {
            uiFontSize: {
              enabled: false,
              max: DEFAULT_MAX_UI_FONT_SIZE,
            },
          },
        },
      },
      settings: {
        tweaks: {
          appearance: {
            uiFontSize: {
              enabled: true,
              ...overrides,
            },
          },
        },
      },
    },
  };
}

function createUiFontSizeExtractedApp() {
  const extractedDir = fs.mkdtempSync(path.join(os.tmpdir(), "ui-font-size-app-"));
  const buildDir = path.join(extractedDir, ".vite", "build");
  const webviewDir = path.join(extractedDir, "webview", "assets");
  fs.mkdirSync(buildDir, { recursive: true });
  fs.mkdirSync(webviewDir, { recursive: true });
  const targets = [
    path.join(buildDir, "src-fixture.js"),
    path.join(buildDir, "worker.js"),
    path.join(webviewDir, "app-initial-fixture.js"),
  ];
  for (const target of targets) {
    fs.writeFileSync(target, uiFontSizeBundleFixture());
  }
  fs.writeFileSync(path.join(buildDir, "unrelated.js"), "console.log('unrelated');");
  return { extractedDir, targets };
}

function applyPatchTwice(source, context) {
  const patched = applySidebarProjectNameStylePatch(source, context);
  assert.equal(applySidebarProjectNameStylePatch(patched, context), patched);
  return patched;
}

function copyFeatureTo(featuresRoot) {
  const featureDir = path.join(featuresRoot, "ui-tweaks");
  fs.mkdirSync(featureDir, { recursive: true });
  for (const name of ["feature.json", "README.md", "patch.js"]) {
    fs.copyFileSync(path.join(__dirname, name), path.join(featureDir, name));
  }
  fs.cpSync(path.join(__dirname, "patches"), path.join(featureDir, "patches"), { recursive: true });
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

test("ui-tweaks is discoverable and disabled until listed in features.json", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ui-tweaks-feature-"));
  try {
    const featuresRoot = path.join(tempDir, "linux-features");
    fs.mkdirSync(featuresRoot, { recursive: true });
    copyFeatureTo(featuresRoot);
    fs.writeFileSync(path.join(featuresRoot, "features.example.json"), '{"enabled":[]}\n');

    const manifests = discoverLinuxFeatureManifests({ featuresRoot });
    assert.equal(manifests.length, 1);
    assert.equal(manifests[0].id, "ui-tweaks");
    assert.equal(manifests[0].manifest.defaultEnabled, false);
    assert.deepEqual(loadLinuxFeaturePatchDescriptors({ featuresRoot }), []);

    fs.writeFileSync(path.join(featuresRoot, "features.json"), '{"enabled":["ui-tweaks"]}\n');
    const descriptors = loadLinuxFeaturePatchDescriptors({ featuresRoot });
    assert.deepEqual(
      descriptors.map((descriptor) => [descriptor.id, descriptor.phase, descriptor.ciPolicy]),
      [
        ["feature:ui-tweaks:sidebar-project-name-style", "webview-asset", "optional"],
        [
          "feature:ui-tweaks:extended-ui-font-size",
          "extracted-app:post-webview",
          "optional",
        ],
        ["feature:ui-tweaks:model-picker-default-advanced-view", "webview-asset", "optional"],
        ["feature:ui-tweaks:model-picker-inline-model-list", "webview-asset", "optional"],
        [
          "feature:ui-tweaks:model-picker-dynamic-supported-reasoning-efforts",
          "webview-asset",
          "optional",
        ],
        ["feature:ui-tweaks:reasoning-effort-labels-english", "webview-asset", "optional"],
        ["feature:ui-tweaks:appearance-dock-icon-main-process", "main-bundle", "optional"],
        ["feature:ui-tweaks:appearance-dock-icon-settings-row", "webview-asset", "optional"],
        ["feature:ui-tweaks:home-suggested-prompts-main-process", "main-bundle", "optional"],
        ["feature:ui-tweaks:home-suggested-prompts-app-page", "webview-asset", "optional"],
        ["feature:ui-tweaks:home-suggested-prompts-settings-row", "webview-asset", "optional"],
        ["feature:ui-tweaks:home-suggested-prompts-content", "webview-asset", "optional"],
      ],
    );
    const modelPickerDescriptors = descriptors.filter((descriptor) =>
      descriptor.id.includes(":model-picker-"),
    );
    assert.equal(modelPickerDescriptors.length, 3);
    assert.ok(
      modelPickerDescriptors.every((descriptor) => typeof descriptor.enabled === "function"),
    );
    assert.ok(modelPickerDescriptors.every((descriptor) => descriptor.enabled({}) === false));
    const uiFontSizeDescriptor = descriptors.find((descriptor) =>
      descriptor.id.endsWith(":extended-ui-font-size"),
    );
    assert.equal(typeof uiFontSizeDescriptor?.enabled, "function");
    assert.equal(uiFontSizeDescriptor.enabled({}), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("UI font size tweak raises the shared input and schema maximum", () => {
  const source = uiFontSizeBundleFixture();
  const patched = applyUiFontSizePatch(source, uiFontSizeContext());
  const state = Function(
    "setup",
    "setting",
    "number",
    "input",
    `${patched};return fontSizeState();`,
  )(
    (callback) => callback(),
    (value) => value,
    () => ({
      min(value) {
        this.minValue = value;
        return this;
      },
      max(value) {
        this.maxValue = value;
        return this;
      },
    }),
    (value) => value,
  );

  assert.deepEqual(state.limits, {
    sans: { min: 11, max: DEFAULT_MAX_UI_FONT_SIZE },
    code: { min: 8, max: 24 },
  });
  assert.equal(state.input.max, DEFAULT_MAX_UI_FONT_SIZE);
  assert.equal(state.setting.schema.maxValue, DEFAULT_MAX_UI_FONT_SIZE);
  assert.match(patched, new RegExp(UI_FONT_SIZE_RUNTIME_MARKER));
  assert.equal((patched.match(new RegExp(UI_FONT_SIZE_RUNTIME_MARKER, "g")) ?? []).length, 1);
  assert.equal(applyUiFontSizePatch(patched, uiFontSizeContext()), patched);
});

test("UI font size tweak atomically patches all three runtime registries", () => {
  const { extractedDir, targets } = createUiFontSizeExtractedApp();
  try {
    const discovery = findUiFontSizeBundles(extractedDir);
    assert.equal(discovery.candidates.length, EXPECTED_FONT_SIZE_BUNDLE_COUNT);

    const result = applyUiFontSizeAppPatch(extractedDir, uiFontSizeContext({ max: 32 }));
    assert.equal(result.matched, EXPECTED_FONT_SIZE_BUNDLE_COUNT);
    assert.equal(result.changed, EXPECTED_FONT_SIZE_BUNDLE_COUNT);
    for (const target of targets) {
      const source = fs.readFileSync(target, "utf8");
      assert.match(source, /sans:\{min:11,max:32\/\*/);
      assert.match(source, new RegExp(UI_FONT_SIZE_RUNTIME_MARKER));
    }

    const repeated = applyUiFontSizeAppPatch(extractedDir, uiFontSizeContext({ max: 32 }));
    assert.equal(repeated.matched, EXPECTED_FONT_SIZE_BUNDLE_COUNT);
    assert.equal(repeated.changed, 0);
  } finally {
    fs.rmSync(extractedDir, { recursive: true, force: true });
  }
});

test("UI font size app patch rejects missing, duplicate, and mixed registries byte-identically", () => {
  for (const mutate of [
    ({ targets }) => fs.rmSync(targets[1]),
    ({ extractedDir }) =>
      fs.writeFileSync(
        path.join(extractedDir, ".vite", "build", "duplicate.js"),
        uiFontSizeBundleFixture(),
      ),
    ({ targets }) =>
      fs.writeFileSync(
        targets[0],
        applyUiFontSizePatch(fs.readFileSync(targets[0], "utf8"), uiFontSizeContext()),
      ),
    ({ targets }) =>
      fs.writeFileSync(
        targets[0],
        fs.readFileSync(targets[0], "utf8") + `/*${UI_FONT_SIZE_RUNTIME_MARKER}*/`,
      ),
    ({ targets }) => {
      for (const target of targets) {
        fs.writeFileSync(
          target,
          applyUiFontSizePatch(fs.readFileSync(target, "utf8"), uiFontSizeContext()),
        );
      }
      fs.writeFileSync(
        targets[0],
        applyUiFontSizePatch(uiFontSizeBundleFixture(), uiFontSizeContext({ max: 32 })),
      );
    },
  ]) {
    const fixture = createUiFontSizeExtractedApp();
    try {
      mutate(fixture);
      const before = fixture.targets
        .filter((target) => fs.existsSync(target))
        .map((target) => [target, fs.readFileSync(target, "utf8")]);
      const { value: result, warnings } = withCapturedWarns(() =>
        applyUiFontSizeAppPatch(fixture.extractedDir, uiFontSizeContext()),
      );

      assert.equal(result.matched, 0);
      assert.equal(result.changed, 0);
      assert.equal(warnings.length, 1);
      for (const [target, source] of before) {
        assert.equal(fs.readFileSync(target, "utf8"), source);
      }
    } finally {
      fs.rmSync(fixture.extractedDir, { recursive: true, force: true });
    }
  }
});

test("UI font size tweak is disabled by default and accepts a custom maximum", () => {
  const source = uiFontSizeBundleFixture();
  const featureJson = JSON.parse(fs.readFileSync(path.join(__dirname, "feature.json"), "utf8"));
  const defaultContext = { feature: { manifest: featureJson } };
  const customContext = uiFontSizeContext({ max: 32 });

  assert.equal(featureJson.tweaks.appearance.uiFontSize.enabled, false);
  assert.equal(featureJson.tweaks.appearance.uiFontSize.max, DEFAULT_MAX_UI_FONT_SIZE);
  assert.equal(applyUiFontSizePatch(source, defaultContext), source);
  assert.match(applyUiFontSizePatch(source, customContext), /sans:\{min:11,max:32\/\*/);
  assert.equal(normalizedMaxUiFontSize(customContext), 32);
});

test("invalid UI font size maxima warn and fall back to the safe default", () => {
  for (const max of [16, 24.5, MAX_CONFIGURABLE_UI_FONT_SIZE + 1, "32"]) {
    const context = uiFontSizeContext({ max });
    const { value, warnings } = withCapturedWarns(() =>
      applyUiFontSizePatch(uiFontSizeBundleFixture(), context),
    );

    assert.match(value, new RegExp(`sans:\\{min:11,max:${DEFAULT_MAX_UI_FONT_SIZE}\\/\\*`));
    assert.equal(warnings.length, 1);
    assert.match(
      warnings[0],
      new RegExp(
        `must be an integer from ${MIN_EXTENDED_UI_FONT_SIZE} ` +
          `to ${MAX_CONFIGURABLE_UI_FONT_SIZE}`,
      ),
    );
  }
});

test("UI font size drift and duplicate contracts fail closed", () => {
  for (const source of [
    "var limits={sans:{min:11,max:17},code:{min:8,max:24}};",
    uiFontSizeBundleFixture() + uiFontSizeBundleFixture(),
  ]) {
    const { value, warnings } = withCapturedWarns(() =>
      applyUiFontSizePatch(source, {
        ...uiFontSizeContext(),
        warnOnMissingMarkers: true,
      }),
    );

    assert.equal(value, source);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /unique current UI and code font size limits/);
  }
});

test("model picker descriptors target the current state and menu bundles", () => {
  const stateAsset = "app-initial-BTphDPeq.js";
  const effortAsset = stateAsset;

  assert.match(stateAsset, MODEL_PICKER_STATE_ASSET_PATTERN);
  assert.match(stateAsset, MODEL_PICKER_INLINE_ASSET_PATTERN);
  assert.match(effortAsset, MODEL_PICKER_EFFORT_ASSET_PATTERN);

  // Current-package-only targeting must not retain previous chunks as fallbacks.
  assert.doesNotMatch(
    "app-initial~app-main~page-CMpPiY3-.js",
    MODEL_PICKER_STATE_ASSET_PATTERN,
  );
});

test("model picker opens advanced view and renders model choices inline", () => {
  const stateSource = modelPickerStateBundleFixture();
  const menuSource = modelPickerMenuBundleFixture();
  const patchedState = applyDefaultAdvancedViewPatch(stateSource);
  const patchedMenu = applyInlineModelListPatch(menuSource);
  const H1 = {
    Fragment: Symbol("Fragment"),
    jsx: (type, props, key) => ({ key, props, type }),
    jsxs: (type, props, key) => ({ key, props, type }),
  };
  const hH = { Item: Symbol("Item"), Title: Symbol("Title") };
  const renderAdvancedModelList = Function(
    "H1",
    "hH",
    "fv",
    `${patchedMenu};return Cgs;`,
  )(H1, hH, Symbol("Selected"));
  const selected = [];
  const modelOptions = [
    {
      id: "gpt-5.6-terra",
      label: "5.6 Terra",
      onSelect: () => selected.push("gpt-5.6-terra"),
      selected: false,
    },
    {
      id: "gpt-5.6-sol",
      label: "5.6 Sol",
      onSelect: () => selected.push("gpt-5.6-sol"),
      selected: true,
    },
  ];
  const rendered = renderAdvancedModelList({
    advancedConfig: { model: { label: "Model", options: modelOptions } },
    hideAdvancedSubmenus: false,
  });

  assert.match(patchedState, ADVANCED_MENU_VIEW_PATTERN);
  assert.doesNotMatch(patchedState, SIMPLE_MENU_VIEW_PATTERN);
  assert.match(patchedState, /useState\)\(`advanced`\)/);
  assert.doesNotMatch(patchedState, /useState\)\(`simple`\)/);
  assert.match(patchedMenu, new RegExp(INLINE_MODEL_LIST_RUNTIME_MARKER));
  assert.equal(
    (patchedMenu.match(new RegExp(INLINE_MODEL_LIST_RUNTIME_MARKER, "g")) ?? []).length,
    1,
  );
  assert.match(patchedMenu, /children:\[Ce,se\]/);
  assert.doesNotMatch(patchedMenu, /children:\[ie,\/\*codex-linux-inline-model-list\*\//);
  assert.equal(rendered.type, H1.Fragment);
  assert.equal(rendered.props.children[0].type, hH.Title);
  assert.equal(rendered.props.children[0].props.children, "Model");
  assert.equal(rendered.props.children[1].type, "div");
  assert.deepEqual(
    rendered.props.children[1].props.children.map((item) => item.props.children),
    ["5.6 Terra", "5.6 Sol"],
  );
  assert.ok(rendered.props.children[1].props.children.every((item) => item.type === hH.Item));
  assert.ok(
    rendered.props.children[1].props.children.every((item) => !modelOptions.includes(item)),
  );
  let prevented = false;
  rendered.props.children[1].props.children[1].props.onSelect({
    preventDefault: () => {
      prevented = true;
    },
  });
  assert.equal(prevented, true);
  assert.deepEqual(selected, ["gpt-5.6-sol"]);
  assert.equal(
    renderAdvancedModelList({
      advancedConfig: { model: { label: "Model", options: modelOptions } },
      hideAdvancedSubmenus: true,
    }),
    null,
  );
  assert.equal(
    renderAdvancedModelList({
      advancedConfig: { model: null },
      hideAdvancedSubmenus: false,
    }),
    null,
  );
  assert.equal(applyDefaultAdvancedViewPatch(patchedState), patchedState);
  assert.equal(applyInlineModelListPatch(patchedMenu), patchedMenu);
});

test("GPT-5.6 Power slider follows reasoning efforts enabled in settings", () => {
  const source = modelPickerPowerBundleFixture();
  const patched = applyDynamicSupportedReasoningEffortsPatch(source);
  const resolvePowerSelections = Function(`${patched};return ARe;`)();

  assert.match(patched, new RegExp(DYNAMIC_POWER_EFFORTS_RUNTIME_MARKER));
  assert.equal(applyDynamicSupportedReasoningEffortsPatch(patched), patched);
  assert.deepEqual(
    resolvePowerSelections(filteredGpt56Models(["low", "medium", "high", "xhigh", "max"]))
      .map(({ id }) => id),
    [
      "gpt-5.6-terra:low",
      "gpt-5.6-sol:low",
      "gpt-5.6-sol:medium",
      "gpt-5.6-sol:high",
      "gpt-5.6-sol:xhigh",
      "gpt-5.6-sol:max",
    ],
  );
  assert.deepEqual(
    resolvePowerSelections(filteredGpt56Models(["low", "medium", "high", "xhigh"]))
      .map(({ id }) => id),
    [
      "gpt-5.6-terra:low",
      "gpt-5.6-sol:low",
      "gpt-5.6-sol:medium",
      "gpt-5.6-sol:high",
      "gpt-5.6-sol:xhigh",
    ],
  );
  assert.deepEqual(
    resolvePowerSelections(
      filteredGpt56Models(["low", "medium", "high", "xhigh", "ultra"]),
      { includeUltraInSlider: true },
    ).map(({ id }) => id),
    [
      "gpt-5.6-terra:low",
      "gpt-5.6-sol:low",
      "gpt-5.6-sol:medium",
      "gpt-5.6-sol:high",
      "gpt-5.6-sol:xhigh",
      "gpt-5.6-sol:ultra",
    ],
  );
});

test("GPT-5.6 Power slider effort patch fails soft when upstream markers drift", () => {
  const source = "function modelPickerPowerSelections(){return []}";
  const { value, warnings } = withCapturedWarns(() =>
    applyDynamicSupportedReasoningEffortsPatch(source, { warnOnMissingMarkers: true }),
  );

  assert.equal(value, source);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Could not find the supported reasoning effort mapper/);
});

test("model picker tweak is disabled by default and can be explicitly enabled", () => {
  const stateSource = modelPickerStateBundleFixture();
  const menuSource = modelPickerMenuBundleFixture();
  const featureJson = JSON.parse(fs.readFileSync(path.join(__dirname, "feature.json"), "utf8"));
  const defaultContext = {
    feature: {
      manifest: featureJson,
    },
  };
  const enabledContext = {
    feature: {
      manifest: featureJson,
      settings: {
        tweaks: {
          modelPicker: {
            showModelsByDefault: {
              enabled: true,
            },
          },
        },
      },
    },
  };

  assert.equal(featureJson.tweaks.modelPicker.showModelsByDefault.enabled, false);
  assert.equal(applyDefaultAdvancedViewPatch(stateSource, defaultContext), stateSource);
  assert.equal(applyInlineModelListPatch(menuSource, defaultContext), menuSource);
  assert.equal(
    applyDynamicSupportedReasoningEffortsPatch(modelPickerPowerBundleFixture(), defaultContext),
    modelPickerPowerBundleFixture(),
  );
  assert.match(
    applyDefaultAdvancedViewPatch(stateSource, enabledContext),
    ADVANCED_MENU_VIEW_PATTERN,
  );
  assert.match(
    applyInlineModelListPatch(menuSource, enabledContext),
    new RegExp(INLINE_MODEL_LIST_RUNTIME_MARKER),
  );
  assert.match(
    applyDynamicSupportedReasoningEffortsPatch(modelPickerPowerBundleFixture(), enabledContext),
    new RegExp(DYNAMIC_POWER_EFFORTS_RUNTIME_MARKER),
  );
});

test("model picker drift warns and leaves the asset unchanged", () => {
  const source = "console.log('model picker drifted');";
  const { value, warnings } = withCapturedWarns(() =>
    applyDefaultAdvancedViewPatch(source, { warnOnMissingMarkers: true }),
  );

  assert.equal(value, source);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^WARN: Could not find the persisted model picker view marker/);
});

test("model picker mixed, duplicate, and incomplete contracts fail closed", () => {
  const mixedState = modelPickerStateBundleFixture().replace(
    "`composer-model-picker-menu-view-v1`,`simple`",
    "`composer-model-picker-menu-view-v2`,`advanced`",
  );
  const duplicateMenu = modelPickerMenuBundleFixture() + modelPickerMenuBundleFixture();
  const incompleteMenu = modelPickerMenuBundleFixture().replace(
    "n.options.map(Tgs)",
    "n.options",
  );

  for (const [source, apply] of [
    [mixedState, applyDefaultAdvancedViewPatch],
    [duplicateMenu, applyInlineModelListPatch],
    [incompleteMenu, applyInlineModelListPatch],
  ]) {
    const { value, warnings } = withCapturedWarns(() =>
      apply(source, { warnOnMissingMarkers: true }),
    );
    assert.equal(value, source);
    assert.equal(warnings.length, 1);
  }
});

test("reasoning effort labels stay in English in the Simplified Chinese locale", () => {
  const source = simplifiedChineseLocaleFixture();
  const patched = applyEnglishReasoningLabels(source);

  assert.equal(
    Object.hasOwn(ENGLISH_REASONING_LABELS, "composer.mode.local.reasoning.low.label"),
    false,
  );
  for (const [key, label] of Object.entries(ENGLISH_REASONING_LABELS)) {
    assert.match(patched, new RegExp(`"${key.replaceAll(".", "\\.")}":\\\`${label}\\\``));
  }
  assert.equal(applyEnglishReasoningLabels(patched), patched);
  assert.match("zh-CN-BPHwMaw8.js", ZH_CN_LOCALE_ASSET_PATTERN);
  assert.doesNotMatch("zh-TW-rBlCyjlT.js", ZH_CN_LOCALE_ASSET_PATTERN);
});

test("reasoning effort label drift warns and leaves the asset unchanged", () => {
  const source = simplifiedChineseLocaleFixture().replace(
    '"composer.mode.local.reasoning.ultra.label":`极高`',
    '"composer.mode.local.reasoning.ultra.missing":`极高`',
  );
  const { value, warnings } = withCapturedWarns(() =>
    applyEnglishReasoningLabels(source, { warnOnMissingMarkers: true }),
  );

  assert.equal(value, source);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /composer\.mode\.local\.reasoning\.ultra\.label/);
});

test("mixed upstream reasoning effort labels translate the remaining labels atomically", () => {
  const source = simplifiedChineseLocaleFixture().replace(
    '"composer.mode.local.reasoning.medium.label":`中`',
    '"composer.mode.local.reasoning.medium.label":`Medium`',
  );
  const { value, warnings } = withCapturedWarns(() =>
    applyEnglishReasoningLabels(source, { warnOnMissingMarkers: true }),
  );

  for (const [key, label] of Object.entries(ENGLISH_REASONING_LABELS)) {
    assert.match(value, new RegExp(`"${key.replaceAll(".", "\\.")}":\\\`${label}\\\``));
  }
  assert.deepEqual(warnings, []);
  assert.equal(applyEnglishReasoningLabels(value), value);
});

test("English reasoning effort labels can be disabled", () => {
  const source = simplifiedChineseLocaleFixture();
  const context = {
    feature: {
      settings: {
        tweaks: {
          reasoning: {
            keepEffortLabelsEnglish: {
              enabled: false,
            },
          },
        },
      },
    },
  };

  assert.equal(applyEnglishReasoningLabels(source, context), source);
});

test("sidebar project descriptor targets only the current project sidebar asset", () => {
  assert.match("app-initial-BTphDPeq.js", PROJECTS_SIDEBAR_ASSET_PATTERN);
  assert.doesNotMatch(
    "app-initial~app-main~page-kMhXWEru.js",
    PROJECTS_SIDEBAR_ASSET_PATTERN,
  );
  assert.doesNotMatch(
    "app-initial~app-main~automations-page-BcHjEK7e.js",
    PROJECTS_SIDEBAR_ASSET_PATTERN,
  );
  assert.doesNotMatch("projects-index-page-TFjtVwC4.js", PROJECTS_SIDEBAR_ASSET_PATTERN);
  assert.doesNotMatch(
    "app-initial~app-main~remote-conversation-page~projects-index-page-By2_tGIM.js",
    PROJECTS_SIDEBAR_ASSET_PATTERN,
  );
});

test("patch injects sidebar project-name stylesheet runtime once", () => {
  const context = {
    feature: {
      manifest: {
        tweaks: {
          sidebar: {
            projectName: {
              style: DEFAULT_PROJECT_NAME_STYLE,
            },
          },
        },
      },
      settings: {
        tweaks: {
          sidebar: {
            projectName: {
              style: "font-weight: 800 !important; color: red;",
            },
          },
        },
      },
    },
  };

  const patched = applyPatchTwice(projectBundleFixture(), context);

  assert.match(patched, new RegExp(STYLE_ID));
  assert.match(patched, new RegExp(RUNTIME_MARKER));
  assert.match(patched, /font-weight: 800 !important; color: red;/);
  assert.ok(
    patched.includes(JSON.stringify(sidebarProjectNameCss("font-weight: 800 !important; color: red;"))),
  );
  assert.equal((patched.match(new RegExp(STYLE_ID, "g")) ?? []).length, 1);
});

test("sidebar project name selector follows the semantic project-row marquee contract", () => {
  assert.equal(
    PROJECT_NAME_SELECTOR,
    `[${PROJECT_ROW_ATTRIBUTE}] [data-marquee-text]`,
  );
  assert.doesNotMatch(PROJECT_NAME_SELECTOR, /folder-row|text-fade-truncate/);
});

test("feature manifest defaults reach descriptor context through the feature loader", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ui-tweaks-manifest-defaults-"));
  try {
    const featuresRoot = path.join(tempDir, "linux-features");
    fs.mkdirSync(featuresRoot, { recursive: true });
    copyFeatureTo(featuresRoot);
    fs.writeFileSync(path.join(featuresRoot, "features.json"), '{"enabled":["ui-tweaks"]}\n');

    const [descriptor] = loadLinuxFeaturePatchDescriptors({ featuresRoot });
    const patched = descriptor.apply(projectBundleFixture(), {});

    assert.match(patched, /font-weight: 700 !important;/);
    assert.doesNotMatch(patched, /padding-top/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("default project name style is bold without changing fixed row geometry", () => {
  const featureJson = JSON.parse(fs.readFileSync(path.join(__dirname, "feature.json"), "utf8"));
  assert.equal(featureJson.tweaks.sidebar.projectName.style, DEFAULT_PROJECT_NAME_STYLE);
  assert.match(DEFAULT_PROJECT_NAME_STYLE, /font-weight:\s*700\s*!important/);
  assert.doesNotMatch(DEFAULT_PROJECT_NAME_STYLE, /(?:padding|margin|height)/i);
  assert.doesNotMatch(DEFAULT_PROJECT_NAME_STYLE, /color/i);
  assert.doesNotMatch(sidebarProjectNameCss(DEFAULT_PROJECT_NAME_STYLE), /#000|black/i);
});

test("feature settings override the tracked defaults through features.json", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ui-tweaks-settings-"));
  try {
    const featuresRoot = path.join(tempDir, "linux-features");
    fs.mkdirSync(featuresRoot, { recursive: true });
    copyFeatureTo(featuresRoot);
    fs.writeFileSync(
      path.join(featuresRoot, "features.json"),
      `${JSON.stringify(
        {
          enabled: ["ui-tweaks"],
          settings: {
            "ui-tweaks": {
              tweaks: {
                appearance: {
                  uiFontSize: {
                    enabled: true,
                    max: 32,
                  },
                },
                sidebar: {
                  projectName: {
                    style: "font-weight: 800 !important; color: red;",
                  },
                },
                modelPicker: {
                  showModelsByDefault: {
                    enabled: true,
                  },
                },
              },
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    const descriptors = loadLinuxFeaturePatchDescriptors({ featuresRoot });
    const [descriptor] = descriptors;
    const patched = descriptor.apply(projectBundleFixture(), {});

    assert.match(patched, /font-weight: 800 !important; color: red;/);
    assert.ok(
      descriptors
        .filter((candidate) => candidate.id.includes(":model-picker-"))
        .every((candidate) => candidate.enabled({}) === true),
    );
    const uiFontSizeDescriptor = descriptors.find((candidate) =>
      candidate.id.endsWith(":extended-ui-font-size"),
    );
    assert.equal(uiFontSizeDescriptor.enabled({}), true);
    const fontSizeFixture = createUiFontSizeExtractedApp();
    try {
      const result = uiFontSizeDescriptor.apply(fontSizeFixture.extractedDir, {});
      assert.equal(result.changed, EXPECTED_FONT_SIZE_BUNDLE_COUNT);
      for (const target of fontSizeFixture.targets) {
        assert.match(fs.readFileSync(target, "utf8"), /max:32\/\*/);
      }
    } finally {
      fs.rmSync(fontSizeFixture.extractedDir, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("invalid feature settings warn and fall back to defaults", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ui-tweaks-invalid-settings-"));
  try {
    const featuresRoot = path.join(tempDir, "linux-features");
    fs.mkdirSync(featuresRoot, { recursive: true });
    copyFeatureTo(featuresRoot);
    fs.writeFileSync(
      path.join(featuresRoot, "features.json"),
      '{"enabled":["ui-tweaks"],"settings":{"ui-tweaks":false}}\n',
    );

    const { value: descriptors, warnings } = withCapturedWarns(() =>
      loadLinuxFeaturePatchDescriptors({ featuresRoot }),
    );
    const patched = descriptors[0].apply(projectBundleFixture(), {});

    assert.match(warnings.join("\n"), /WARN: Linux feature 'ui-tweaks' settings/);
    assert.match(patched, /font-weight: 700 !important;/);
    assert.doesNotMatch(patched, /padding-top/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("patch skips unrelated assets", () => {
  const source = "console.log('not the sidebar');";
  const { value, warnings } = withCapturedWarns(() => applySidebarProjectNameStylePatch(source));

  assert.equal(value, source);
  assert.deepEqual(warnings, []);
});

test("drift warning returns source unchanged", () => {
  const source = [
    "function Hd(){return {id:`sidebarElectron.projectsNavLink`,defaultMessage:`Projects`}}",
    "function row(){return actions.sidebarProjectRow({collapsed:r,label:c,projectId:l})}",
  ].join("");

  const { value, warnings } = withCapturedWarns(() => applySidebarProjectNameStylePatch(source));

  assert.equal(value, source);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^WARN: Could not find current sidebar project name markers/);
});

test("obsolete project-name markers do not produce a false applied result", () => {
  const source = [
    "function row(){let j=Pn(`group/folder-row group relative flex`);",
    "let V=(0,Iy.jsx)(`span`,{className:`text-fade-truncate pe-1`,children:p});return [j,V]}",
    'function marquee(){return {"data-marquee-text":!0}}',
  ].join("");

  const { value, warnings } = withCapturedWarns(() => patches[0].apply(source, {}));

  assert.equal(value, source);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^WARN: Could not find current sidebar project name markers/);
});

test("target asset drift warning returns source unchanged when all markers are missing", () => {
  const source = "console.log('projects sidebar bundle drifted');";

  const { value, warnings } = withCapturedWarns(() => patches[0].apply(source, {}));

  assert.equal(value, source);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^WARN: Could not find current sidebar project name markers/);
});

test("invalid and empty styles warn and fall back without throwing", () => {
  for (const badStyle of [42, "   "]) {
    const { value, warnings } = withCapturedWarns(() =>
      applySidebarProjectNameStylePatch(projectBundleFixture(), {
        feature: {
          manifest: {
            tweaks: {
              sidebar: {
                projectName: {
                  style: DEFAULT_PROJECT_NAME_STYLE,
                },
              },
            },
          },
          settings: {
            tweaks: {
              sidebar: {
                projectName: {
                  style: badStyle,
                },
              },
            },
          },
        },
      }),
    );

    assert.match(value, new RegExp(STYLE_ID));
    assert.match(value, /font-weight: 700 !important;/);
    assert.doesNotMatch(value, /padding-top/);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /^WARN: ui-tweaks sidebar project name style/);
  }
});

test("unsafe styles warn, stay scoped, and fall back to the default", () => {
  const unsafeStyle = "font-weight:700;} body{display:none} /*";
  const { value, warnings } = withCapturedWarns(() =>
    applySidebarProjectNameStylePatch(projectBundleFixture(), {
      feature: {
        settings: {
          tweaks: {
            sidebar: {
              projectName: {
                style: unsafeStyle,
              },
            },
          },
        },
      },
    }),
  );

  assert.match(value, new RegExp(STYLE_ID));
  assert.match(value, /font-weight: 700 !important;/);
  assert.doesNotMatch(value, /padding-top/);
  assert.doesNotMatch(value, /body\{display:none\}/);
  assert.equal(value.includes(unsafeStyle), false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^WARN: ui-tweaks sidebar project name style must be a safe CSS declaration list/);
});
