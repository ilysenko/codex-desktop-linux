"use strict";

const JS_IDENT = "[A-Za-z_$][\\w$]*";
const PATCH_MARKER = "codexLinuxApiKeyFastTier";
const MODEL_MARKER = "codexLinuxApiKeyServiceTierModel";
const SERVICE_TIER_GATE_SHAPE = new RegExp(
  `authMethod===\`chatgpt\`[\\s\\S]{0,200}?authMethod\\?\\?null` +
    `[\\s\\S]{0,1200}?featureRequirements\\?\\.fast_mode` +
    `[\\s\\S]{0,500}?\\{isServiceTierAllowed:${JS_IDENT},isLoading:${JS_IDENT}\\}`,
);
const PATCHED_SERVICE_TIER_GATE = new RegExp(
  `${JS_IDENT}=!${JS_IDENT}&&\\(${JS_IDENT}\\?${JS_IDENT}!=null&&` +
    `${JS_IDENT}\\?\\.requirements\\?\\.featureRequirements\\?\\.fast_mode!==!1:` +
    `${JS_IDENT}===\`apikey\`\\)`,
);
const PATCHED_MODEL_MARKER = new RegExp(`${MODEL_MARKER}:${JS_IDENT}===\\\`apikey\\\``);
const MODEL_LIST_MAPPING_SHAPE = new RegExp(
  `function ${JS_IDENT}\\(\\{additionalAvailableModels:${JS_IDENT},authMethod:${JS_IDENT},availableModels:${JS_IDENT},` +
    `defaultModel:${JS_IDENT},enabledReasoningEfforts:${JS_IDENT},` +
    `hasConfiguredModelCatalog:${JS_IDENT},` +
    `includeUltraReasoningEffort:${JS_IDENT},isCustomModelProvider:${JS_IDENT}=!1,` +
    `models:${JS_IDENT},useHiddenModels:${JS_IDENT}\\}\\)` +
    `\\{[\\s\\S]{0,3000}?supportedReasoningEfforts[\\s\\S]{0,1200}?hasModelSupportingUltraReasoningEffort`,
);

function warn(message, patchName) {
  console.warn(`WARN: ${message} - skipping ${patchName}`);
}

function applyApiKeyServiceTierGatePatch(source) {
  const gateNeedle = new RegExp(
    `(${JS_IDENT})=(${JS_IDENT})\\?\\.authMethod===\\\`chatgpt\\\`,` +
      `(${JS_IDENT})=\\2\\?\\.authMethod\\?\\?null([\\s\\S]{0,500}?),` +
      `d=\\1&&!(${JS_IDENT})&&(${JS_IDENT})!=null&&\\6\\?\\.requirements\\?\\.featureRequirements\\?\\.fast_mode!==!1`,
    "g",
  );

  const patched = source.replace(
    gateNeedle,
    (_match, isChatGptVar, hostVar, authMethodVar, middle, loadingVar, requirementsVar) =>
      `${isChatGptVar}=${hostVar}?.authMethod===\`chatgpt\`,` +
      `${authMethodVar}=${hostVar}?.authMethod??null${middle},` +
      `d=!${loadingVar}&&(${isChatGptVar}?${requirementsVar}!=null&&${requirementsVar}?.requirements?.featureRequirements?.fast_mode!==!1:${authMethodVar}===\`apikey\`)`,
  );

  if (patched !== source || PATCHED_SERVICE_TIER_GATE.test(source)) {
    return patched;
  }

  if (hasApiKeyServiceTierGateShape(source)) {
    warn("Could not find service tier auth gate", "API key service tier gate patch");
  }
  return source;
}

function hasApiKeyServiceTierGateShape(source) {
  return SERVICE_TIER_GATE_SHAPE.test(source);
}

function applyApiKeyModelMarkerPatch(source) {
  if (PATCHED_MODEL_MARKER.test(source)) {
    return source;
  }

  const modelListPattern = new RegExp(
    `(function ${JS_IDENT}\\(\\{additionalAvailableModels:${JS_IDENT},authMethod:(${JS_IDENT}),availableModels:${JS_IDENT},` +
      `defaultModel:${JS_IDENT},enabledReasoningEfforts:${JS_IDENT},` +
      `hasConfiguredModelCatalog:${JS_IDENT},` +
      `includeUltraReasoningEffort:${JS_IDENT},isCustomModelProvider:${JS_IDENT}=!1,` +
      `models:${JS_IDENT},useHiddenModels:${JS_IDENT}\\}\\)` +
      `\\{[\\s\\S]{0,1800}?[,;]${JS_IDENT}=\\{\\.\\.\\.${JS_IDENT},supportedReasoningEfforts:${JS_IDENT})(\\})`,
    "g",
  );

  const patched = source.replace(
    modelListPattern,
    (_match, prefix, authMethodVar, suffix) => `${prefix},${MODEL_MARKER}:${authMethodVar}===\`apikey\`${suffix}`,
  );

  if (patched !== source) {
    return patched;
  }

  if (hasApiKeyModelListMappingShape(source)) {
    warn("Could not find model list mapping", "API key model service tier marker patch");
  }
  return source;
}

function hasApiKeyModelListMappingShape(source) {
  return MODEL_LIST_MAPPING_SHAPE.test(source);
}

function matchesApiKeyServiceTierGateContract(source) {
  return PATCHED_SERVICE_TIER_GATE.test(source) || hasApiKeyServiceTierGateShape(source);
}

function matchesApiKeyServiceTierModelContract(source) {
  return PATCHED_MODEL_MARKER.test(source) || hasApiKeyModelListMappingShape(source);
}

function fallbackFastTierHelper() {
  return `function ${PATCH_MARKER}(e){return e==null||e?.serviceTiers?.length||e?.${MODEL_MARKER}!==!0?null:{id:\`fast\`,name:\`Fast\`,description:\`1.5x speed, increased usage\`}}`;
}

function fallbackOptionCallbackPattern() {
  const concise =
    `\\(\\{(?=[^{}]{0,800}description:)(?=[^{}]{0,800}iconKind:)` +
    `(?=[^{}]{0,800}label:)(?=[^{}]{0,800}tier:\\2,value:\\2\\.id)[^{}]{1,800}\\}\\)`;
  const block =
    `\\{[^{}]{0,800}?return\\{(?=[^{}]{0,800}description:)(?=[^{}]{0,800}iconKind:)` +
    `(?=[^{}]{0,800}label:)(?=[^{}]{0,800}tier:\\2,value:\\2\\.id)[^{}]{1,800}\\}\\}`;
  return `(${JS_IDENT})=>(?:${concise}|${block})`;
}

function currentFallbackOptionsPattern(flags = "") {
  return new RegExp(
    `\\.\\.\\.\\((${JS_IDENT})\\?\\.serviceTiers\\?\\?\\[\\]\\)\\.map\\((${JS_IDENT})=>` +
      fallbackOptionCallbackPattern().replace(`(${JS_IDENT})=>`, "") + `\\)`,
    flags,
  );
}

function patchedFallbackOptionsPattern(flags = "") {
  return new RegExp(
    `\\.\\.\\.\\(\\((${JS_IDENT})\\?\\.serviceTiers\\?\\.length\\?\\1\\.serviceTiers:` +
      `\\[${PATCH_MARKER}\\(\\1\\)\\]\\)\\.filter\\(Boolean\\)\\)\\.map\\(` +
      fallbackOptionCallbackPattern() + `\\)`,
    flags,
  );
}

function fallbackOptionMatches(source, pattern) {
  return [...source.matchAll(pattern)];
}

function fallbackFastTierState(source) {
  const current = fallbackOptionMatches(source, currentFallbackOptionsPattern("g"));
  const patched = fallbackOptionMatches(source, patchedFallbackOptionsPattern("g"));
  const helper = fallbackFastTierHelper();
  const helperCount = source.split(helper).length - 1;

  if (current.length === 1 && patched.length === 0 && helperCount <= 1 &&
      (!source.includes(`function ${PATCH_MARKER}(`) || helperCount === 1)) {
    return { kind: "current", match: current[0], helperCount };
  }
  if (current.length === 0 && patched.length === 1 && helperCount === 1) {
    return { kind: "patched", match: patched[0], helperCount };
  }
  return null;
}

function matchesFallbackFastTierContract(source) {
  return fallbackFastTierState(source) != null;
}

function hasCompleteFallbackFastTierPatch(source) {
  return fallbackFastTierState(source)?.kind === "patched";
}

function applyFallbackFastTierPatch(source) {
  const state = fallbackFastTierState(source);
  if (state?.kind === "patched") {
    return source;
  }
  if (state?.kind !== "current") {
    if (source.includes("serviceTiers")) {
      warn("Could not find service tier option helpers", "API key fallback fast tier patch");
    }
    return source;
  }
  const modelVar = state.match[1];
  const replacement = state.match[0].replace(
    `...(${modelVar}?.serviceTiers??[])`,
    `...((${modelVar}?.serviceTiers?.length?${modelVar}.serviceTiers:[${PATCH_MARKER}(${modelVar})]).filter(Boolean))`,
  );
  let patched = source.slice(0, state.match.index) + replacement +
    source.slice(state.match.index + state.match[0].length);
  if (state.helperCount === 0) patched = fallbackFastTierHelper() + patched;

  if (hasCompleteFallbackFastTierPatch(patched)) {
    return patched;
  }

  if (patched !== source || source.includes(PATCH_MARKER)) {
    warn("Could not apply all current service tier option helpers", "API key fallback fast tier patch");
    return source;
  }

  if (source.includes("serviceTiers")) {
    warn("Could not find service tier option helpers", "API key fallback fast tier patch");
  }
  return source;
}

function applyApiKeyServiceTierPatch(source) {
  return applyFallbackFastTierPatch(
    applyApiKeyModelMarkerPatch(applyApiKeyServiceTierGatePatch(source)),
  );
}

function applyCurrentGatePatch(source) {
  const gateAlreadyPatched = PATCHED_SERVICE_TIER_GATE.test(source);
  const gateCandidate = gateAlreadyPatched ? source : applyApiKeyServiceTierGatePatch(source);
  const gateReady = gateAlreadyPatched || gateCandidate !== source;

  if (!gateReady && !hasApiKeyServiceTierGateShape(source)) {
    warn("Could not identify current service tier auth gate", "API key service tier gate patch");
  }
  return gateCandidate;
}

function applyCurrentModelPatch(source) {
  const modelAlreadyPatched = PATCHED_MODEL_MARKER.test(source);
  const modelCandidate = modelAlreadyPatched ? source : applyApiKeyModelMarkerPatch(source);
  const modelReady = modelAlreadyPatched || modelCandidate !== source;

  if (!modelReady && !hasApiKeyModelListMappingShape(source)) {
    warn("Could not identify current model list mapping", "API key model service tier marker patch");
  }
  return modelCandidate;
}

function applyCurrentFallbackFastTierPatch(source) {
  if (
    !source.includes(PATCH_MARKER) &&
    !source.includes("serviceTiers")
  ) {
    warn("Could not identify current service tier option helpers", "API key fallback fast tier patch");
  }
  return applyFallbackFastTierPatch(source);
}

const descriptors = [
  {
    id: "api-key-service-tier-gate",
    phase: "webview-asset",
    order: 20600,
    ciPolicy: "optional",
    pattern: /^app-initial-[^.]+\.js$/,
    assetMatch: matchesApiKeyServiceTierGateContract,
    missingDescription: "current API key service tier gate bundle",
    skipDescription: "API key service tier gate patch",
    apply: applyCurrentGatePatch,
  },
  {
    id: "api-key-service-tier-model",
    phase: "webview-asset",
    order: 20605,
    ciPolicy: "optional",
    pattern: /^app-initial-[^.]+\.js$/,
    assetMatch: matchesApiKeyServiceTierModelContract,
    missingDescription: "current API key service tier model bundle",
    skipDescription: "API key model service tier marker patch",
    apply: applyCurrentModelPatch,
  },
  {
    id: "api-key-service-tier-fallback",
    phase: "webview-asset",
    order: 20610,
    ciPolicy: "optional",
    pattern: /^app-initial-[^.]+\.js$/,
    assetMatch: matchesFallbackFastTierContract,
    missingDescription: "current API key service tier fallback bundle",
    skipDescription: "API key fallback fast tier patch",
    apply: applyCurrentFallbackFastTierPatch,
  },
];

module.exports = {
  applyApiKeyModelMarkerPatch,
  applyApiKeyServiceTierGatePatch,
  applyFallbackFastTierPatch,
  applyApiKeyServiceTierPatch,
  applyCurrentGatePatch,
  applyCurrentModelPatch,
  applyCurrentFallbackFastTierPatch,
  hasApiKeyServiceTierGateShape,
  hasApiKeyModelListMappingShape,
  matchesApiKeyServiceTierGateContract,
  matchesApiKeyServiceTierModelContract,
  matchesFallbackFastTierContract,
  descriptors,
};
