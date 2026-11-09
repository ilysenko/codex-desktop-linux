"use strict";

const MODEL_PICKER_INLINE_ASSET_PATTERN = /^app-initial-[^.]+\.js$/;
const MODEL_PICKER_EFFORT_ASSET_PATTERN = MODEL_PICKER_INLINE_ASSET_PATTERN;
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

function escapedPattern(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

function inlineModelListContract(source) {
  const modelSubmenuPattern = new RegExp(
    `([,;])(${JS_IDENT});(${JS_IDENT})\\[(\\d+)\\]!==(${JS_IDENT})\\.model\\|\\|` +
      `\\3\\[(\\d+)\\]!==(${JS_IDENT})\\?\\(\\2=\\7\\|\\|\\5\\.model==null\\?null:` +
      `\\(0,(${JS_IDENT})\\.jsx\\)\\((${JS_IDENT}),\\{submenu:\\5\\.model\\}\\),` +
      `\\3\\[\\4\\]=\\5\\.model,\\3\\[\\6\\]=\\7,\\3\\[(\\d+)\\]=\\2\\)` +
      `:\\2=\\3\\[\\10\\]`,
    "g",
  );
  const submenuMatches = [...source.matchAll(modelSubmenuPattern)];
  if (submenuMatches.length !== 1) {
    return null;
  }

  const match = submenuMatches[0];
  const submenuComponent = match[9];
  const submenuMarker = `function ${submenuComponent}(`;
  const submenuStart = source.indexOf(submenuMarker);
  if (submenuStart < 0 || source.indexOf(submenuMarker, submenuStart + 1) >= 0) {
    return null;
  }
  const submenuEnd = source.indexOf("function ", submenuStart + submenuMarker.length);
  if (submenuEnd < 0) {
    return null;
  }

  const submenuSection = source.slice(submenuStart, submenuEnd);
  const jsxNamespace = match[8];
  const titlePattern = new RegExp(
    `\\(0,${escapedPattern(jsxNamespace)}\\.jsx\\)\\((${JS_IDENT})\\.Title,`,
    "g",
  );
  const optionMapPattern = new RegExp(`\\.options\\.map\\((${JS_IDENT})\\)`, "g");
  const titleMatches = [...submenuSection.matchAll(titlePattern)];
  const optionMapMatches = [...submenuSection.matchAll(optionMapPattern)];
  if (titleMatches.length !== 1 || optionMapMatches.length !== 1) {
    return null;
  }

  const menuNamespace = titleMatches[0][1];
  const optionRenderer = optionMapMatches[0][1];
  const optionRendererPattern = new RegExp(
    `function ${escapedPattern(optionRenderer)}\\((${JS_IDENT})\\)\\{return` +
      `\\(0,${escapedPattern(jsxNamespace)}\\.jsx\\)` +
      `\\(${escapedPattern(menuNamespace)}\\.Item,`,
    "g",
  );
  if ([...source.matchAll(optionRendererPattern)].length !== 1) {
    return null;
  }

  return {
    cache: match[3],
    config: match[5],
    hide: match[7],
    hideIndex: match[6],
    jsxNamespace,
    menuNamespace,
    modelIndex: match[4],
    optionRenderer,
    original: match[0],
    prefix: match[1],
    result: match[2],
    resultIndex: match[10],
  };
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

    const contract = inlineModelListContract(source);
    if (contract == null) {
      if (context.warnOnMissingMarkers === true) {
        warn("Could not find the current advanced model submenu contract");
      }
      return source;
    }

    const {
      cache,
      config,
      hide,
      hideIndex,
      jsxNamespace,
      menuNamespace,
      modelIndex,
      optionRenderer,
      original,
      prefix,
      result,
      resultIndex,
    } = contract;
    const inlineModelList =
      `(0,${jsxNamespace}.jsxs)(${jsxNamespace}.Fragment,{children:[` +
      `(0,${jsxNamespace}.jsx)(${menuNamespace}.Title,{children:${config}.model.label}),` +
      `(0,${jsxNamespace}.jsx)(\`div\`,{className:` +
      "`vertical-scroll-fade-mask flex max-h-[250px] flex-col overflow-y-auto`" +
      `,children:${config}.model.options.map(${optionRenderer})})]})` +
      `/*${INLINE_MODEL_LIST_RUNTIME_MARKER}*/`;
    const replacement =
      `${prefix}${result};${cache}[${modelIndex}]!==${config}.model||` +
      `${cache}[${hideIndex}]!==${hide}?(${result}=${hide}||${config}.model==null?null:` +
      `${inlineModelList},${cache}[${modelIndex}]=${config}.model,` +
      `${cache}[${hideIndex}]=${hide},${cache}[${resultIndex}]=${result})` +
      `:${result}=${cache}[${resultIndex}]`;
    return source.replace(original, replacement);
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
    phase: "extracted-app:pre-webview",
    order: 20_794,
    ciPolicy: "optional",
    enabled,
    apply: applyDefaultAdvancedViewToApp,
  },
  {
    id: "model-picker-inline-model-list",
    phase: "webview-asset",
    order: 20_796,
    ciPolicy: "optional",
    enabled,
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
  INLINE_MODEL_LIST_RUNTIME_MARKER,
  MODEL_PICKER_EFFORT_ASSET_PATTERN,
  MODEL_PICKER_INLINE_ASSET_PATTERN,
  applyDefaultAdvancedViewPatch,
  applyDefaultAdvancedViewToApp,
  applyDynamicSupportedReasoningEffortsPatch,
  applyInlineModelListPatch,
  applyModelPickerModelListPatch,
  descriptors,
  findDynamicPowerSelectionsFunction,
};
