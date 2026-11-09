"use strict";

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

function applyDynamicSupportedReasoningEffortsPatch(source, context = {}) {
  if (!enabled(context)) return source;
  try {
    return require("./model-picker-dynamic-efforts.js").prepareDynamicEffortSource(source);
  } catch (error) {
    warn(`Could not qualify the current dynamic Power efforts: ${error.message}`);
    return source;
  }
}

function applyDynamicSupportedReasoningEffortsToApp(extractedDir, context = {}) {
  if (!enabled(context)) return { matched: 0, changed: 0 };
  return require("./model-picker-dynamic-efforts.js").applyDynamicEfforts(extractedDir, context.modelPickerWriteOptions);
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
    phase: "extracted-app:post-webview",
    order: 20_797,
    ciPolicy: "optional",
    enabled,
    apply: applyDynamicSupportedReasoningEffortsToApp,
  },
];

module.exports = {
  applyDefaultAdvancedViewPatch,
  applyDefaultAdvancedViewToApp,
  applyDynamicSupportedReasoningEffortsPatch,
  applyDynamicSupportedReasoningEffortsToApp,
  applyInlineModelListPatch,
  applyInlineModelListToApp,
  descriptors,
};
