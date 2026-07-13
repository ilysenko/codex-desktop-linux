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
  `function ${JS_IDENT}\\(\\{authMethod:${JS_IDENT},availableModels:${JS_IDENT},` +
    `defaultModel:${JS_IDENT},enabledReasoningEfforts:${JS_IDENT},` +
    `includeUltraReasoningEffort:${JS_IDENT},models:${JS_IDENT},useHiddenModels:${JS_IDENT}\\}\\)` +
    `\\{[\\s\\S]{0,3000}?supportedReasoningEfforts[\\s\\S]{0,1200}?isDefault`,
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
    `(function ${JS_IDENT}\\(\\{authMethod:(${JS_IDENT}),availableModels:${JS_IDENT},` +
      `defaultModel:${JS_IDENT},enabledReasoningEfforts:${JS_IDENT},` +
      `includeUltraReasoningEffort:${JS_IDENT},models:${JS_IDENT},useHiddenModels:${JS_IDENT}\\}\\)` +
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

function hasCompleteFallbackFastTierPatch(source) {
  return (
    source.includes(`function ${PATCH_MARKER}(`) &&
    source.includes(`??${PATCH_MARKER}(`) &&
    source.includes(`[${PATCH_MARKER}(`) &&
    source.includes(".filter(Boolean)).map")
  );
}

function applyFallbackFastTierPatch(source) {
  if (hasCompleteFallbackFastTierPatch(source)) {
    return source;
  }

  let patched = source;

  if (!patched.includes(`function ${PATCH_MARKER}(`)) {
    const fastResolverPattern = new RegExp(
      `function (${JS_IDENT})\\(e\\)\\{return e\\?\\.serviceTiers\\?\\.find\\(e=>` +
        `(${JS_IDENT})\\(e\\.id,e\\.name\\)===\\\`fast\\\`\\|\\|e\\.name\\.trim\\(\\)\\.toLowerCase\\(\\)===\\\`priority\\\`\\)\\?\\?null\\}`,
    );
    const fastResolverMatch = patched.match(fastResolverPattern);
    if (fastResolverMatch != null) {
      const helper =
        `function ${PATCH_MARKER}(e){return e==null||e?.serviceTiers?.length||e?.${MODEL_MARKER}!==!0?null:{id:\`fast\`,name:\`Fast\`,description:\`1.5x speed, increased usage\`}}`;
      patched = patched.replace(fastResolverPattern, `${helper}${fastResolverMatch[0]}`);
    }
  }

  const fastResolverPatch = new RegExp(
    `function (${JS_IDENT})\\(e\\)\\{return e\\?\\.serviceTiers\\?\\.find\\(e=>` +
      `(${JS_IDENT})\\(e\\.id,e\\.name\\)===\\\`fast\\\`\\|\\|e\\.name\\.trim\\(\\)\\.toLowerCase\\(\\)===\\\`priority\\\`\\)\\?\\?null\\}`,
    "g",
  );
  patched = patched.replace(
    fastResolverPatch,
    `function $1(e){return e?.serviceTiers?.find(e=>$2(e.id,e.name)===\`fast\`||e.name.trim().toLowerCase()===\`priority\`)??${PATCH_MARKER}(e)}`,
  );

  const optionsPatch = new RegExp(
    `\\.\\.\\.\\((${JS_IDENT})\\?\\.serviceTiers\\?\\?\\[\\]\\)\\.map\\((${JS_IDENT})=>\\(\\{` +
      `description:(${JS_IDENT})\\(\\2\\),iconKind:(${JS_IDENT})\\(\\2\\.id,\\2\\.name\\),` +
      `label:(${JS_IDENT})\\(\\2\\),tier:\\2,value:\\2\\.id\\}\\)\\)`,
    "g",
  );
  patched = patched.replace(
    optionsPatch,
    `...(($1?.serviceTiers?.length?$1.serviceTiers:[${PATCH_MARKER}($1)]).filter(Boolean)).map($2=>({description:$3($2),iconKind:$4($2.id,$2.name),label:$5($2),tier:$2,value:$2.id}))`,
  );

  if (hasCompleteFallbackFastTierPatch(patched)) {
    return patched;
  }

  if (patched !== source || source.includes(PATCH_MARKER)) {
    warn("Could not apply all current service tier option helpers", "API key fallback fast tier patch");
    return source;
  }

  if (source.includes("serviceTiers") && source.includes("defaultServiceTier")) {
    warn("Could not find service tier option helpers", "API key fallback fast tier patch");
  }
  return source;
}

function applyApiKeyServiceTierPatch(source) {
  return applyFallbackFastTierPatch(applyApiKeyModelMarkerPatch(applyApiKeyServiceTierGatePatch(source)));
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
    !(source.includes("serviceTiers") && source.includes("defaultServiceTier"))
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
    pattern: /^app-initial~app-main~onboarding-page-[^.]+\.js$/,
    missingDescription: "current API key service tier gate bundle",
    skipDescription: "API key service tier gate patch",
    apply: applyCurrentGatePatch,
  },
  {
    id: "api-key-service-tier-model",
    phase: "webview-asset",
    order: 20605,
    ciPolicy: "optional",
    pattern: /^app-initial~app-main~hotkey-window-thread-page~keyboard-shortcuts-settings~thread-app-shell~cf704xib-[^.]+\.js$/,
    missingDescription: "current API key service tier model bundle",
    skipDescription: "API key model service tier marker patch",
    apply: applyCurrentModelPatch,
  },
  {
    id: "api-key-service-tier-fallback",
    phase: "webview-asset",
    order: 20610,
    ciPolicy: "optional",
    pattern: /^app-initial~app-main~quick-chat-window-page~work-home-page~chatgpt-conversation-page-[^.]+\.js$/,
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
  descriptors,
};
