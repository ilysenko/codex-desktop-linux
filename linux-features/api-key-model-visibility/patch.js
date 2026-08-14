"use strict";

const JS_IDENT = "[A-Za-z_$][\\w$]*";
const PATCH_MARKER = "codexLinuxApiKeyModelVisibility";

function warn(message, patchName) {
  console.warn(`WARN: ${message} - skipping ${patchName}`);
}

function applyApiKeyModelVisibilityPatch(source) {
  if (source.includes(PATCH_MARKER)) {
    return source;
  }

  // Current upstream shape: the allowlist gate lives in a per-model helper
  // that also excludes Codex Auto Review and custom providers.
  // Bypass the allowlist for API-key authenticated hosts the same way it is
  // already bypassed for non-ChatGPT hosts: add `&&authMethod!==`apikey``.
  const helperPattern = new RegExp(
    `(function ${JS_IDENT}\\(\\{additionalAvailableModels:(${JS_IDENT}),` +
      `authMethod:(${JS_IDENT}),availableModels:(${JS_IDENT}),isCustomModelProvider:(${JS_IDENT}),` +
      `model:(${JS_IDENT}),useHiddenModels:(${JS_IDENT})\\}\\)\\{return ` +
      `\\2\\?\\.has\\(\\6\\.model\\)===!0\\|\\|\\6\\.model!==\\\`codex-auto-review\\\`&&\\()` +
      `\\7&&!\\5&&\\3!==\\\`amazonBedrock\\\`` +
      `(\\?\\4\\.has\\(\\6\\.model\\):!\\6\\.hidden\\)\\})`,
    "g",
  );
  const patched = source.replace(
    helperPattern,
    (
      _match,
      prefix,
      _additionalAvailableModelsVar,
      authMethodVar,
      _availableModelsVar,
      isCustomModelProviderVar,
      _modelVar,
      useHiddenModelsVar,
      suffix,
    ) =>
      `${prefix}${useHiddenModelsVar}&&!${isCustomModelProviderVar}&&` +
      `${authMethodVar}!==\`amazonBedrock\`&&` +
      `${authMethodVar}!==\`apikey\`/*${PATCH_MARKER}*/${suffix}`,
  );
  if (patched !== source) {
    return patched;
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
    pattern: /^app-initial-[^.]+\.js$/,
    missingDescription: "app main webview bundle",
    skipDescription: "API key model visibility patch",
    apply: applyApiKeyModelVisibilityPatch,
  },
];

module.exports = {
  applyApiKeyModelVisibilityPatch,
  descriptors,
};
