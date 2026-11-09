"use strict";

const MODEL_PICKER_EFFORT_ASSET_PATTERN = /^app-initial-[^.]+\.js$/;
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
  if (!enabled(context)) return source;
  try {
    return require("./model-picker-default-view.js").prepareDefaultViewSource(source);
  } catch (error) {
    warn(`Could not qualify the current native model picker: ${error.message}`);
    return source;
  }
}

function applyDefaultAdvancedViewToApp(extractedDir, context = {}) {
  if (!enabled(context)) return { matched: 0, changed: 0 };
  return require("./model-picker-default-view.js").applyDefaultView(extractedDir, context.modelPickerWriteOptions);
}

function applyInlineModelListPatch(source, context = {}) {
  if (!enabled(context)) return source;
  try {
    return require("./model-picker-inline-list.js").auditInlineModelListSource(source);
  } catch (error) {
    warn(`Could not verify the current native inline model list: ${error.message}`);
    return source;
  }
}

function applyInlineModelListToApp(extractedDir, context = {}) {
  if (!enabled(context)) return { matched: 0, changed: 0 };
  return require("./model-picker-inline-list.js").auditInlineModelList(extractedDir);
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
    phase: "extracted-app:pre-webview",
    order: 20_794,
    ciPolicy: "optional",
    enabled,
    apply: applyDefaultAdvancedViewToApp,
  },
  {
    id: "model-picker-inline-model-list",
    phase: "extracted-app:post-webview",
    order: 20_796,
    ciPolicy: "optional",
    enabled,
    apply: applyInlineModelListToApp,
  },
  {
    id: "model-picker-dynamic-supported-reasoning-efforts",
    phase: "webview-asset",
    order: 20_797,
    ciPolicy: "optional",
    enabled,
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
  DYNAMIC_POWER_EFFORTS_RUNTIME_MARKER,
  MODEL_PICKER_EFFORT_ASSET_PATTERN,
  applyDefaultAdvancedViewPatch,
  applyDefaultAdvancedViewToApp,
  applyDynamicSupportedReasoningEffortsPatch,
  applyInlineModelListPatch,
  applyInlineModelListToApp,
  applyModelPickerModelListPatch,
  descriptors,
  findDynamicPowerSelectionsFunction,
};
