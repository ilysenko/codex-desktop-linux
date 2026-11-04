"use strict";

const JS_IDENT = "[A-Za-z_$][\\w$]*";
const PATCH_MARKER = "codexLinuxApiKeyModelVisibility";
const ASSET_NEEDLES = ["useHiddenModels", "codex-auto-review", "availableAccessPrograms"];

function warn(message, patchName) {
  console.warn(`WARN: ${message} - skipping ${patchName}`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function applyApiKeyModelVisibilityPatch(source) {
  if (source.includes(PATCH_MARKER)) {
    return source;
  }

  // Current upstream (rspack/SWC) shape: the per-model visibility predicate is
  // inlined into the catalog filter. It destructures the visibility inputs and
  // gates the Statsig allowlist behind
  //   `useHiddenModels&&!isCustomModelProvider&&"amazonBedrock"!==authMethod`.
  // Bypass the allowlist for API-key hosts the same way it is already bypassed
  // for Amazon Bedrock, so they fall through to `!model.hidden`.
  const headerPattern = new RegExp(
    `function(?: ${JS_IDENT})?\\(\\{additionalAvailableModels:(${JS_IDENT}),` +
      `apiKeyDaybreakSupported:(${JS_IDENT}),authMethod:(${JS_IDENT}),` +
      `availableModels:(${JS_IDENT}),hasConfiguredModelCatalog:(${JS_IDENT}),` +
      `isCustomModelProvider:(${JS_IDENT}),model:(${JS_IDENT}),useHiddenModels:(${JS_IDENT})\\}\\)\\{`,
    "g",
  );
  const headers = [...source.matchAll(headerPattern)];
  const edits = [];
  for (const header of headers) {
    const [
      ,
      ,
      ,
      authMethod,
      availableModels,
      hasConfiguredModelCatalog,
      isCustomModelProvider,
      model,
      useHiddenModels,
    ] = header;
    const bodyStart = header.index + header[0].length;
    const bodyEnd = source.indexOf("}", bodyStart);
    if (bodyEnd === -1 || bodyEnd - bodyStart > 1000) continue;
    const body = source.slice(bodyStart, bodyEnd + 1);
    const m = escapeRegExp(model);
    const gate =
      `${escapeRegExp(useHiddenModels)}&&!${escapeRegExp(isCustomModelProvider)}&&` +
      `"amazonBedrock"!==${escapeRegExp(authMethod)}`;
    const gatePattern = new RegExp(
      `"codex-auto-review"!==${m}\\.model&&\\(${escapeRegExp(hasConfiguredModelCatalog)}&&` +
        `!${m}\\.hidden\\|\\|\\((${gate})\\?${escapeRegExp(availableModels)}\\.has\\(${m}\\.model\\)`,
    );
    const gateMatch = gatePattern.exec(body);
    if (gateMatch == null || !new RegExp(`:!${m}\\.hidden\\)\\)\\)\\}$`).test(body)) {
      continue;
    }
    const at =
      bodyStart + gateMatch.index + gateMatch[0].indexOf(gateMatch[1]) + gateMatch[1].length;
    edits.push({ at, text: `&&"apikey"!==${authMethod}/*${PATCH_MARKER}*/` });
  }

  if (headers.length === 1 && edits.length === 1) {
    const [{ at, text }] = edits;
    return `${source.slice(0, at)}${text}${source.slice(at)}`;
  }

  if (headers.length > 0 || ASSET_NEEDLES.every((needle) => source.includes(needle))) {
    warn(
      headers.length > 1
        ? "Desktop model allowlist gate is ambiguous"
        : "Could not find desktop model allowlist gate",
      "API key model visibility patch",
    );
  }
  return source;
}

const descriptors = [
  {
    id: "api-key-model-visibility-ui",
    phase: "webview-asset",
    order: 20550,
    ciPolicy: "optional",
    assetNeedles: ASSET_NEEDLES,
    missingDescription: "desktop model allowlist webview chunk",
    skipDescription: "API key model visibility patch",
    apply: applyApiKeyModelVisibilityPatch,
  },
];

module.exports = {
  ASSET_NEEDLES,
  applyApiKeyModelVisibilityPatch,
  descriptors,
};
