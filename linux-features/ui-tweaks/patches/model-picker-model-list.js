"use strict";

const MODEL_PICKER_STATE_ASSET_PATTERN = /^app-initial-[^.]+\.js$/;
const MODEL_PICKER_INLINE_ASSET_PATTERN = MODEL_PICKER_STATE_ASSET_PATTERN;
const MODEL_PICKER_EFFORT_ASSET_PATTERN = MODEL_PICKER_STATE_ASSET_PATTERN;
const SIMPLE_MENU_VIEW_PATTERN =
  /([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(`composer-model-picker-menu-view-v1`,`simple`\)/;
const ADVANCED_MENU_VIEW_PATTERN =
  /([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(`composer-model-picker-menu-view-v2`,`advanced`\)/;
const MODEL_TITLE_MARKER = "composer.intelligenceDropdown.model.title";
const MODEL_ROW_MARKER = "composer.intelligenceDropdown.model.rowLabel";
const EFFORT_TITLE_MARKER = "composer.intelligenceDropdown.effort.title";
const INLINE_MODEL_LIST_RUNTIME_MARKER = "codex-linux-inline-model-list";
const DYNAMIC_POWER_EFFORTS_RUNTIME_MARKER =
  "codex-linux-dynamic-supported-reasoning-efforts";
const JS_IDENT = "[A-Za-z_$][\\w$]*";

function warn(message) {
  console.warn(`WARN: ${message} - skipping ui-tweaks model picker patch`);
}

function modelPickerConfig(context) {
  const defaults = context?.feature?.manifest?.tweaks?.modelPicker?.showModelsByDefault;
  const settings = context?.feature?.settings?.tweaks?.modelPicker?.showModelsByDefault;
  return {
    ...(defaults != null && typeof defaults === "object" && !Array.isArray(defaults) ? defaults : {}),
    ...(settings != null && typeof settings === "object" && !Array.isArray(settings) ? settings : {}),
  };
}

function enabled(context) {
  return modelPickerConfig(context).enabled !== false;
}

function applyDefaultAdvancedViewPatch(source, context = {}) {
  try {
    if (typeof source !== "string") {
      warn("Asset source is not a string");
      return source;
    }
    if (!enabled(context) || ADVANCED_MENU_VIEW_PATTERN.test(source)) {
      return source;
    }
    if (!SIMPLE_MENU_VIEW_PATTERN.test(source)) {
      if (context.warnOnMissingMarkers === true) {
        warn("Could not find the persisted model picker view marker");
      }
      return source;
    }

    return source.replace(
      SIMPLE_MENU_VIEW_PATTERN,
      '$1=$2(`composer-model-picker-menu-view-v2`,`advanced`)',
    );
  } catch (error) {
    warn(`Unexpected error: ${error instanceof Error ? error.message : String(error)}`);
    return source;
  }
}

function findInlineModelListVariable(source) {
  const titleIndex = source.indexOf(MODEL_TITLE_MARKER);
  const rowIndex = source.indexOf(MODEL_ROW_MARKER, titleIndex);
  if (titleIndex < 0 || rowIndex < 0) {
    return null;
  }

  const section = source.slice(titleIndex, rowIndex);
  const assignments = [
    ...section.matchAll(/,([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*);let/g),
  ];
  return assignments.at(-1)?.[1] ?? null;
}

function applyInlineModelListPatch(source, context = {}) {
  try {
    if (typeof source !== "string") {
      warn("Asset source is not a string");
      return source;
    }
    if (!enabled(context) || source.includes(INLINE_MODEL_LIST_RUNTIME_MARKER)) {
      return source;
    }

    const inlineModelListVariable = findInlineModelListVariable(source);
    const effortIndex = source.indexOf(EFFORT_TITLE_MARKER);
    if (inlineModelListVariable == null || effortIndex < 0) {
      if (context.warnOnMissingMarkers === true) {
        warn("Could not find the model list and advanced picker markers");
      }
      return source;
    }

    const tail = source.slice(effortIndex);
    const advancedChildrenPattern =
      /(([A-Za-z_$][\w$]*)=\(0,([A-Za-z_$][\w$]*)\.jsxs\)\(\3\.Fragment,\{children:\[)([A-Za-z_$][\w$]*),/;
    const match = tail.match(advancedChildrenPattern);
    if (match == null) {
      if (context.warnOnMissingMarkers === true) {
        warn("Could not find the advanced picker child list");
      }
      return source;
    }

    const patchedTail = tail.replace(
      advancedChildrenPattern,
      `$1${inlineModelListVariable},/*${INLINE_MODEL_LIST_RUNTIME_MARKER}*/`,
    );
    return source.slice(0, effortIndex) + patchedTail;
  } catch (error) {
    warn(`Unexpected error: ${error instanceof Error ? error.message : String(error)}`);
    return source;
  }
}

function findDynamicPowerSelectionsFunction(source) {
  const pattern = new RegExp(
    `function (${JS_IDENT})\\((${JS_IDENT})\\)\\{return \\2\\?\\.flatMap\\(\\(\\{` +
      `displayName:${JS_IDENT},model:${JS_IDENT},supportedReasoningEfforts:${JS_IDENT}` +
      `\\}\\)=>`,
  );
  return source.match(pattern)?.[1] ?? null;
}

function applyDynamicSupportedReasoningEffortsPatch(source, context = {}) {
  try {
    if (typeof source !== "string") {
      warn("Asset source is not a string");
      return source;
    }
    if (!enabled(context) || source.includes(DYNAMIC_POWER_EFFORTS_RUNTIME_MARKER)) {
      return source;
    }

    const dynamicPowerSelectionsFunction = findDynamicPowerSelectionsFunction(source);
    if (dynamicPowerSelectionsFunction == null) {
      if (context.warnOnMissingMarkers === true) {
        warn("Could not find the supported reasoning effort mapper");
      }
      return source;
    }

    const powerSelectionPattern = new RegExp(
      `function (${JS_IDENT})\\((${JS_IDENT}),\\{includeUltraInSlider:(${JS_IDENT})=!1,` +
        `removeXHigh:(${JS_IDENT})=!1\\}=\\{\\}\\)\\{let (${JS_IDENT})=(${JS_IDENT})` +
        `\\((.+?\\.filter\\(\\(\\{reasoningEffort:(${JS_IDENT})\\}\\)=>!\\4\\|\\|\\8!==` +
        "`xhigh`\\))" +
        `,\\2\\);if\\(\\5\\.length>=3\\)return \\5;let (${JS_IDENT})=\\6` +
        `\\((.+?\\.filter\\(\\(\\{reasoningEffort:(${JS_IDENT})\\}\\)=>!\\4\\|\\|\\11!==` +
        "`xhigh`\\))" +
        `,\\2\\);return \\9\\.length>=3\\?\\9:\\[\\]\\}`,
    );
    const match = source.match(powerSelectionPattern);
    if (match == null) {
      if (context.warnOnMissingMarkers === true) {
        warn("Could not find the compact Power selection resolver");
      }
      return source;
    }

    const [
      original,
      resolverFunction,
      modelsVar,
      includeUltraVar,
      removeXHighVar,
      primarySelectionsVar,
      supportedSelectionsFilter,
      primaryCandidates,
      _primaryEffortVar,
      fallbackSelectionsVar,
      fallbackCandidates,
      _fallbackEffortVar,
    ] = match;
    const patched =
      `function ${resolverFunction}(${modelsVar},{includeUltraInSlider:${includeUltraVar}=!1,` +
      `removeXHigh:${removeXHighVar}=!1}={}){` +
      `let codexLinuxCandidates=[...(${primaryCandidates}).filter(({model:codexLinuxModel})=>` +
      `codexLinuxModel!==\`gpt-5.6-sol\`),...${dynamicPowerSelectionsFunction}(` +
      `${modelsVar}?.filter(({model:codexLinuxModel})=>codexLinuxModel===\`gpt-5.6-sol\`))` +
      `.filter(({reasoningEffort:codexLinuxEffort})=>` +
      `(${includeUltraVar}||codexLinuxEffort!==\`ultra\`)&&` +
      `(!${removeXHighVar}||codexLinuxEffort!==\`xhigh\`))]` +
      `/*${DYNAMIC_POWER_EFFORTS_RUNTIME_MARKER}*/,` +
      `${primarySelectionsVar}=${supportedSelectionsFilter}(codexLinuxCandidates,${modelsVar});` +
      `if(${primarySelectionsVar}.length>=3)return ${primarySelectionsVar};` +
      `let ${fallbackSelectionsVar}=${supportedSelectionsFilter}(${fallbackCandidates},${modelsVar});` +
      `return ${fallbackSelectionsVar}.length>=3?${fallbackSelectionsVar}:[]}`;

    return source.replace(original, patched);
  } catch (error) {
    warn(`Unexpected error: ${error instanceof Error ? error.message : String(error)}`);
    return source;
  }
}

function applyModelPickerModelListPatch(source, context = {}) {
  return applyDynamicSupportedReasoningEffortsPatch(
    applyInlineModelListPatch(applyDefaultAdvancedViewPatch(source, context), context),
    context,
  );
}

const descriptors = [
  {
    id: "model-picker-default-advanced-view",
    phase: "webview-asset",
    order: 20_794,
    ciPolicy: "optional",
    pattern: MODEL_PICKER_STATE_ASSET_PATTERN,
    missingDescription: "composer model picker state bundle",
    skipDescription: "ui-tweaks model picker default advanced view patch",
    apply: (source, context = {}) =>
      applyDefaultAdvancedViewPatch(source, { ...context, warnOnMissingMarkers: true }),
  },
  {
    id: "model-picker-inline-model-list",
    phase: "webview-asset",
    order: 20_796,
    ciPolicy: "optional",
    pattern: MODEL_PICKER_INLINE_ASSET_PATTERN,
    missingDescription: "composer model picker menu bundle",
    skipDescription: "ui-tweaks model picker inline model list patch",
    apply: (source, context = {}) =>
      applyInlineModelListPatch(source, { ...context, warnOnMissingMarkers: true }),
  },
  {
    id: "model-picker-dynamic-supported-reasoning-efforts",
    phase: "webview-asset",
    order: 20_797,
    ciPolicy: "optional",
    pattern: MODEL_PICKER_EFFORT_ASSET_PATTERN,
    missingDescription: "composer model picker menu bundle",
    skipDescription: "ui-tweaks dynamic supported reasoning efforts patch",
    apply: (source, context = {}) =>
      applyDynamicSupportedReasoningEffortsPatch(source, {
        ...context,
        warnOnMissingMarkers: true,
      }),
  },
];

module.exports = {
  ADVANCED_MENU_VIEW_PATTERN,
  DYNAMIC_POWER_EFFORTS_RUNTIME_MARKER,
  EFFORT_TITLE_MARKER,
  INLINE_MODEL_LIST_RUNTIME_MARKER,
  MODEL_PICKER_EFFORT_ASSET_PATTERN,
  MODEL_PICKER_INLINE_ASSET_PATTERN,
  MODEL_PICKER_STATE_ASSET_PATTERN,
  MODEL_ROW_MARKER,
  MODEL_TITLE_MARKER,
  SIMPLE_MENU_VIEW_PATTERN,
  applyDefaultAdvancedViewPatch,
  applyDynamicSupportedReasoningEffortsPatch,
  applyInlineModelListPatch,
  applyModelPickerModelListPatch,
  descriptors,
  findDynamicPowerSelectionsFunction,
  findInlineModelListVariable,
};
