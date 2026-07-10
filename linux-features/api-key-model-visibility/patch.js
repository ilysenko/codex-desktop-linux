"use strict";

const JS_IDENT = "[A-Za-z_$][\\w$]*";
const PATCH_MARKER = "codexLinuxApiKeyModelVisibility";

function warn(message, patchName) {
  console.warn(`WARN: ${message} - skipping ${patchName}`);
}

function applyApiKeyModelVisibilityPatch(source) {
  const modelVisibilityPattern = new RegExp(
    `(function ${JS_IDENT}\\(\\{authMethod:(${JS_IDENT}),availableModels:${JS_IDENT},` +
      `defaultModel:${JS_IDENT},enabledReasoningEfforts:${JS_IDENT},` +
      `includeUltraReasoningEffort:${JS_IDENT},models:${JS_IDENT},` +
      `useHiddenModels:(${JS_IDENT})\\}\\)\\{let[\\s\\S]{0,600}?[,;]${JS_IDENT}=)` +
      `\\3&&\\2!==\\\`amazonBedrock\\\`(?=[,;])`,
    "g",
  );
  const patchedVisibilityPattern = new RegExp(
    `function ${JS_IDENT}\\(\\{authMethod:(${JS_IDENT}),availableModels:${JS_IDENT},` +
      `defaultModel:${JS_IDENT},enabledReasoningEfforts:${JS_IDENT},` +
      `includeUltraReasoningEffort:${JS_IDENT},models:${JS_IDENT},` +
      `useHiddenModels:(${JS_IDENT})\\}\\)\\{let[\\s\\S]{0,600}?[,;]${JS_IDENT}=` +
      `\\2&&\\1!==\\\`amazonBedrock\\\`&&\\1!==\\\`apikey\\\`/\\*${PATCH_MARKER}\\*/(?=[,;])`,
  );

  const patched = source.replace(
    modelVisibilityPattern,
    (_match, prefix, authMethodVar, useHiddenModelsVar) =>
      `${prefix}${useHiddenModelsVar}&&${authMethodVar}!==\`amazonBedrock\`&&` +
      `${authMethodVar}!==\`apikey\`/*${PATCH_MARKER}*/`,
  );

  if (patched !== source) {
    return patched;
  }

  if (patchedVisibilityPattern.test(source)) {
    return source;
  }

  if (
    source.includes("list-models-for-host") &&
    source.includes("useHiddenModels") &&
    source.includes("amazonBedrock")
  ) {
    warn("Could not find desktop model allowlist gate", "API key model visibility patch");
  }
  return source;
}

const descriptors = [
  {
    id: "api-key-model-visibility-ui",
    phase: "webview-asset",
    order: 20550,
    ciPolicy: "optional",
    pattern: /^app-initial~app-main~.*\.js$/,
    missingDescription: "app main webview bundle",
    skipDescription: "API key model visibility patch",
    apply: applyApiKeyModelVisibilityPatch,
  },
];

module.exports = {
  applyApiKeyModelVisibilityPatch,
  descriptors,
};
