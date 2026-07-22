#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

require("./dock-icon.test.js");
require("./suggested-prompts.test.js");

const {
  discoverLinuxFeatureManifests,
  loadLinuxFeaturePatchDescriptors,
} = require("../../scripts/lib/linux-features.js");
const {
  ADVANCED_MENU_VIEW_PATTERN,
  DYNAMIC_POWER_EFFORTS_RUNTIME_MARKER,
  GPT_56_ALLOWLIST_MARKER,
  INLINE_MODEL_LIST_RUNTIME_MARKER,
  MODEL_ALLOWLIST_MARKER,
  MODEL_PICKER_ALLOWLIST_ASSET_PATTERN,
  MODEL_PICKER_EFFORT_ASSET_PATTERN,
  MODEL_PICKER_INLINE_ASSET_PATTERN,
  MODEL_PICKER_STATE_ASSET_PATTERN,
  SIMPLE_MENU_VIEW_PATTERN,
  applyDefaultAdvancedViewPatch,
  applyDynamicSupportedReasoningEffortsPatch,
  applyGpt56AllowlistPatch,
  applyInlineModelListPatch,
} = require("./patches/model-picker-model-list.js");
const {
  DEFAULT_PROJECT_NAME_STYLE,
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

function projectBundleFixture() {
  return [
    "function row(){let j=Pn(`group/folder-row group relative flex h-[var(--height-token-row)] text-sm text-token-foreground`);",
    "let V=(0,Iy.jsx)(`span`,{className:`text-fade-truncate pr-1`,children:p});return [j,V]}",
  ].join("");
}

function modelPickerStateBundleFixture() {
  return [
    "function picker(){",
    "vz=wu(`composer-model-picker-menu-view-v1`,`simple`);",
    "}",
  ].join("");
}

function modelPickerMenuBundleFixture() {
  return [
    "function menu(){",
    "id:`composer.intelligenceDropdown.model.title`;",
    `const allowed=${MODEL_ALLOWLIST_MARKER};`,
    "let ue=fragment,ie=ue;let fe;",
    "id:`composer.intelligenceDropdown.model.rowLabel`;",
    "id:`composer.intelligenceDropdown.effort.title`;",
    "we=(0,c6.jsxs)(c6.Fragment,{children:[ye,effort]});",
    "}",
  ].join("");
}

function modelPickerPowerBundleFixture() {
  return [
    "function ARe(e,t=!1){let n=PRe(t?[...FRe,URe]:FRe,e);if(n.length>=4)return n;let r=PRe(IRe,e);return r.length>=4?r:[]}",
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
    "composer.mode.local.reasoning.low.label": "轻度",
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
        ["feature:ui-tweaks:model-picker-default-advanced-view", "webview-asset", "optional"],
        ["feature:ui-tweaks:model-picker-include-gpt-5-6", "webview-asset", "optional"],
        ["feature:ui-tweaks:model-picker-inline-model-list", "webview-asset", "optional"],
        [
          "feature:ui-tweaks:model-picker-dynamic-supported-reasoning-efforts",
          "webview-asset",
          "optional",
        ],
        ["feature:ui-tweaks:reasoning-effort-labels-english", "webview-asset", "optional"],
        ["feature:ui-tweaks:appearance-dock-icon-main-process", "main-bundle", "optional"],
        ["feature:ui-tweaks:appearance-dock-icon-settings-row", "webview-asset", "optional"],
        ["feature:ui-tweaks:appearance-dock-icon-settings-search", "webview-asset", "optional"],
        ["feature:ui-tweaks:home-suggested-prompts-main-process", "main-bundle", "optional"],
        ["feature:ui-tweaks:home-suggested-prompts-app-page", "webview-asset", "optional"],
        ["feature:ui-tweaks:home-suggested-prompts-settings-row", "webview-asset", "optional"],
        ["feature:ui-tweaks:home-suggested-prompts-content", "webview-asset", "optional"],
      ],
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("model picker descriptors target the current state and menu bundles", () => {
  const stateAsset =
    "app-initial~app-main~settings-command-menu-section-items~new-thread-panel-page~settings-pag~unq8yzli-twtaboLE.js";
  const allowlistAsset =
    "app-initial~avatarOverlayCompositionSurface~artifact-tab-content.electron~app-main~plugin-d~kw7nl1sl-Dt2LYVtU.js";
  const effortAsset =
    "app-initial~app-main~new-thread-panel-page~appgen-library-page~hotkey-window-thread-page~ho~jhj9i1pn-CLC3YBho.js";

  assert.match(stateAsset, MODEL_PICKER_STATE_ASSET_PATTERN);
  assert.match(stateAsset, MODEL_PICKER_INLINE_ASSET_PATTERN);
  assert.match(allowlistAsset, MODEL_PICKER_ALLOWLIST_ASSET_PATTERN);
  assert.match(effortAsset, MODEL_PICKER_EFFORT_ASSET_PATTERN);

  assert.doesNotMatch(stateAsset, MODEL_PICKER_ALLOWLIST_ASSET_PATTERN);
  assert.doesNotMatch(stateAsset, MODEL_PICKER_EFFORT_ASSET_PATTERN);
  assert.doesNotMatch(allowlistAsset, MODEL_PICKER_STATE_ASSET_PATTERN);
  assert.doesNotMatch(effortAsset, MODEL_PICKER_STATE_ASSET_PATTERN);

  // Current-DMG-only targeting must not retain previous chunks as fallbacks.
  assert.doesNotMatch(
    "app-initial~app-main~page-CMpPiY3-.js",
    MODEL_PICKER_STATE_ASSET_PATTERN,
  );
  assert.doesNotMatch(
    "app-initial~artifact-tab-content.electron~app-main~settings-command-menu-section-items~firs~mknl0a7l-BXBV9E7p.js",
    MODEL_PICKER_ALLOWLIST_ASSET_PATTERN,
  );
  assert.doesNotMatch(
    "app-initial~app-main~new-thread-panel-page~onboarding-page~login-route~appgen-library-page~~gpgl9un5-_t04Xpau.js",
    MODEL_PICKER_ALLOWLIST_ASSET_PATTERN,
  );
  assert.doesNotMatch(
    "app-initial~app-main~onboarding-page~projects-index-page~hotkey-window-thread-page~quick-ch~iiv1g666-BjNKtmac.js",
    MODEL_PICKER_EFFORT_ASSET_PATTERN,
  );
  assert.doesNotMatch(
    "app-initial~app-main~hotkey-window-thread-page~keyboard-shortcuts-settings~thread-app-shell~cf704xib-BpnUyB2R.js",
    MODEL_PICKER_ALLOWLIST_ASSET_PATTERN,
  );
  assert.doesNotMatch(
    "app-initial~app-main~onboarding-page-qmFVRsFx.js",
    MODEL_PICKER_EFFORT_ASSET_PATTERN,
  );
});

test("model picker opens advanced view and renders model choices inline", () => {
  const stateSource = modelPickerStateBundleFixture();
  const menuSource = modelPickerMenuBundleFixture();
  const patchedState = applyDefaultAdvancedViewPatch(stateSource);
  const allowlistedMenu = applyGpt56AllowlistPatch(menuSource);
  const patchedMenu = applyInlineModelListPatch(allowlistedMenu);

  assert.match(patchedState, ADVANCED_MENU_VIEW_PATTERN);
  assert.doesNotMatch(patchedState, SIMPLE_MENU_VIEW_PATTERN);
  assert.match(patchedMenu, new RegExp(GPT_56_ALLOWLIST_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(patchedMenu, new RegExp(MODEL_ALLOWLIST_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(patchedMenu, new RegExp(INLINE_MODEL_LIST_RUNTIME_MARKER));
  assert.match(patchedMenu, /children:\[ie,\/\*codex-linux-inline-model-list\*\//);
  assert.equal(applyDefaultAdvancedViewPatch(patchedState), patchedState);
  assert.equal(applyGpt56AllowlistPatch(patchedMenu), patchedMenu);
  assert.equal(applyInlineModelListPatch(patchedMenu), patchedMenu);
});

test("GPT-5.6 allowlist behavior admits only visible GPT-5.6 models", () => {
  const evaluateAvailability = ({ model, hidden, availableModels }) => {
    const patchedExpression = applyGpt56AllowlistPatch(`return ${MODEL_ALLOWLIST_MARKER};`);
    return Function("l", "t", "n", patchedExpression)(
      true,
      new Set(availableModels),
      { model, hidden },
    );
  };

  assert.equal(
    evaluateAvailability({ model: "gpt-5.6-sol", hidden: false, availableModels: [] }),
    true,
  );
  assert.equal(
    evaluateAvailability({ model: "gpt-5.6-sol", hidden: true, availableModels: [] }),
    false,
  );
  assert.equal(
    evaluateAvailability({ model: "gpt-5.5-codex", hidden: false, availableModels: [] }),
    false,
  );
  assert.equal(
    evaluateAvailability({
      model: "gpt-5.5-codex",
      hidden: false,
      availableModels: ["gpt-5.5-codex"],
    }),
    true,
  );
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
      true,
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

test("model picker tweak can be disabled through feature settings", () => {
  const stateSource = modelPickerStateBundleFixture();
  const menuSource = modelPickerMenuBundleFixture();
  const context = {
    feature: {
      settings: {
        tweaks: {
          modelPicker: {
            showModelsByDefault: {
              enabled: false,
            },
          },
        },
      },
    },
  };

  assert.equal(applyDefaultAdvancedViewPatch(stateSource, context), stateSource);
  assert.equal(applyGpt56AllowlistPatch(menuSource, context), menuSource);
  assert.equal(applyInlineModelListPatch(menuSource, context), menuSource);
  assert.equal(
    applyDynamicSupportedReasoningEffortsPatch(modelPickerPowerBundleFixture(), context),
    modelPickerPowerBundleFixture(),
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

test("reasoning effort labels stay in English in the Simplified Chinese locale", () => {
  const source = simplifiedChineseLocaleFixture();
  const patched = applyEnglishReasoningLabels(source);

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

test("mixed reasoning effort label markers warn and remain byte-identical", () => {
  const source = simplifiedChineseLocaleFixture().replace(
    '"composer.mode.local.reasoning.medium.label":`中`',
    '"composer.mode.local.reasoning.medium.label":`Medium`',
  );
  const { value, warnings } = withCapturedWarns(() =>
    applyEnglishReasoningLabels(source, { warnOnMissingMarkers: true }),
  );

  assert.equal(value, source);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /mixed applied and untranslated reasoning label markers/i);
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
  assert.match(
    "app-initial~notebook-preview-panel~app-main~pull-request-route~projects-index-page~cloud-en~lpx9dmpy-CMWaEe8R.js",
    PROJECTS_SIDEBAR_ASSET_PATTERN,
  );
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
                sidebar: {
                  projectName: {
                    style: "font-weight: 800 !important; color: red;",
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

    const [descriptor] = loadLinuxFeaturePatchDescriptors({ featuresRoot });
    const patched = descriptor.apply(projectBundleFixture(), {});

    assert.match(patched, /font-weight: 800 !important; color: red;/);
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
    "function row(){let j=Pn(`group/folder-row group relative flex`);return j}",
  ].join("");

  const { value, warnings } = withCapturedWarns(() => applySidebarProjectNameStylePatch(source));

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
