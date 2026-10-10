"use strict";

const JS_IDENT = "[A-Za-z_$][\\w$]*";
const PATCH_MARKER = "codexLinuxApiKeyFastTier";
const MODEL_MARKER = "codexLinuxApiKeyServiceTierModel";
const SERVICE_TIER_GATE_SHAPE = new RegExp(
  `authMethod===\\\`chatgpt\\\`\\|\\|${JS_IDENT}\\?\\.authMethod===\\\`personalAccessToken\\\`` +
    `[\\s\\S]{0,1800}?serviceTierAccess:${JS_IDENT},isLoading:${JS_IDENT}`,
);
const API_KEY_ACCESS = "{fast:!0,ultrafast:!1}";

function serviceTierGatePattern(patched = false) {
  const access = patched
    ? `\\k<auth>===\\\`apikey\\\`&&!\\k<loading>\\?\\{fast:!0,ultrafast:!1\\}:null`
    : "null";
  const cacheAuth = patched ? "\\k<auth>" : "\\k<account>";
  return new RegExp(
    `(?<account>${JS_IDENT})=(?<host>${JS_IDENT})\\?\\.authMethod===\\\`chatgpt\\\`\\|\\|\\k<host>\\?\\.authMethod===\\\`personalAccessToken\\\`,` +
    `(?<auth>${JS_IDENT})=\\k<host>\\?\\.authMethod\\?\\?null[\\s\\S]{0,500}?` +
    `(?<loading>${JS_IDENT})=!!\\k<host>\\?\\.isLoading\\|\\|\\k<account>&&${JS_IDENT},(?<result>${JS_IDENT});` +
    `(?<cache>${JS_IDENT})\\[3\\]!==(?<requirements>${JS_IDENT})\\|\\|\\k<cache>\\[4\\]!==\\k<loading>\\|\\|\\k<cache>\\[5\\]!==${cacheAuth}\\?` +
    `\\(\\k<result>=\\k<account>&&!\\k<loading>&&\\k<requirements>!=null\\?(?<resolver>${JS_IDENT})\\(\\k<requirements>\\):${access},` +
    `\\k<cache>\\[3\\]=\\k<requirements>,\\k<cache>\\[4\\]=\\k<loading>,\\k<cache>\\[5\\]=${cacheAuth},\\k<cache>\\[6\\]=\\k<result>\\):\\k<result>=\\k<cache>\\[6\\];` +
    `let (?<output>${JS_IDENT})=\\k<result>,${JS_IDENT};return[\\s\\S]{0,160}?serviceTierAccess:\\k<output>,isLoading:\\k<loading>`,
    "g",
  );
}

function serviceTierGateState(source) {
  const current = [...source.matchAll(serviceTierGatePattern())];
  const patched = [...source.matchAll(serviceTierGatePattern(true))];
  if (current.length === 1 && patched.length === 0) return { kind: "current", match: current[0] };
  if (current.length === 0 && patched.length === 1) return { kind: "patched", match: patched[0] };
  return { kind: "invalid" };
}
const PATCHED_MODEL_MARKER = new RegExp(`${MODEL_MARKER}:${JS_IDENT}===\\\`apikey\\\``);
const PATCHED_SERVICE_TIER_RESOLVER = new RegExp(
  `function ${JS_IDENT}\\((${JS_IDENT}),(${JS_IDENT})\\)\\{return \\2==null\\?null:` +
    `\\2===\\\`fast\\\`\\?${JS_IDENT}\\(\\1\\)\\?\\?${PATCH_MARKER}\\(\\1\\):` +
    `\\1\\?\\.serviceTiers\\?\\.find\\((${JS_IDENT})=>\\3\\.id===\\2\\)\\?\\?null\\}`,
);
const MODEL_LIST_MAPPING_SHAPE = new RegExp(
  `function ${JS_IDENT}\\(\\{additionalAvailableModels:${JS_IDENT},apiKeyDaybreakSupported:${JS_IDENT}=!1,authMethod:${JS_IDENT},availableModels:${JS_IDENT},` +
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
  const state = serviceTierGateState(source);
  if (state.kind === "patched") return source;
  if (state.kind !== "current") {
    if (hasApiKeyServiceTierGateShape(source)) {
      warn("Could not find service tier auth gate", "API key service tier gate patch");
    }
    return source;
  }
  const { account, auth, loading, result, cache, requirements, resolver } = state.match.groups;
  // The access object now comes from the upstream speed-mode resolver. Keep
  // account entitlements intact and key its memo by auth method: API-key and
  // other non-account hosts share the same false account-auth boolean.
  const replacement = state.match[0]
    .replace(`${result}=${account}&&!${loading}&&${requirements}!=null?${resolver}(${requirements}):null`,
      `${result}=${account}&&!${loading}&&${requirements}!=null?${resolver}(${requirements}):${auth}===\`apikey\`&&!${loading}?${API_KEY_ACCESS}:null`)
    .replace(`${cache}[5]!==${account}`, `${cache}[5]!==${auth}`)
    .replace(`${cache}[5]=${account}`, `${cache}[5]=${auth}`);
  const patched = source.slice(0, state.match.index) + replacement +
    source.slice(state.match.index + state.match[0].length);
  return serviceTierGateState(patched).kind === "patched" ? patched : source;
}

function hasApiKeyServiceTierGateShape(source) {
  return SERVICE_TIER_GATE_SHAPE.test(source);
}

function applyApiKeyModelMarkerPatch(source) {
  if (PATCHED_MODEL_MARKER.test(source)) {
    return source;
  }

  const modelListPattern = new RegExp(
    `(function ${JS_IDENT}\\(\\{additionalAvailableModels:${JS_IDENT},apiKeyDaybreakSupported:${JS_IDENT}=!1,authMethod:(${JS_IDENT}),availableModels:${JS_IDENT},` +
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
  return serviceTierGateState(source).kind !== "invalid";
}

function matchesApiKeyServiceTierModelContract(source) {
  return PATCHED_MODEL_MARKER.test(source) || hasApiKeyModelListMappingShape(source);
}

function currentServiceTierResolverPattern(flags = "") {
  return new RegExp(
    `function (${JS_IDENT})\\((${JS_IDENT}),(${JS_IDENT})\\)\\{return \\3==null\\?null:` +
      `\\3===\\\`fast\\\`\\?(${JS_IDENT})\\(\\2\\):` +
      `\\2\\?\\.serviceTiers\\?\\.find\\((${JS_IDENT})=>\\5\\.id===\\3\\)\\?\\?null\\}`,
    flags,
  );
}

function fallbackFastTierHelper() {
  return `function ${PATCH_MARKER}(e){return e==null||e?.serviceTiers?.length||e?.${MODEL_MARKER}!==!0?null:{id:\`fast\`,name:\`Fast\`,description:\`1.5x speed, increased usage\`}}`;
}

function serviceTierResolverState(source) {
  const current = [...source.matchAll(currentServiceTierResolverPattern("g"))];
  const patched = [...source.matchAll(new RegExp(PATCHED_SERVICE_TIER_RESOLVER.source, "g"))];
  const helper = fallbackFastTierHelper();
  const helperCount = source.split(helper).length - 1;

  if (current.length === 1 && patched.length === 0 && helperCount === 0 &&
      !source.includes(PATCH_MARKER)) {
    return { kind: "current", match: current[0] };
  }
  if (current.length === 0 && patched.length === 1 && helperCount === 1) {
    return { kind: "patched", match: patched[0] };
  }
  return { kind: "invalid" };
}

function matchesApiKeyServiceTierResolverContract(source) {
  const state = serviceTierResolverState(source);
  return state.kind === "current" || state.kind === "patched";
}

function applyApiKeyServiceTierResolverPatch(source) {
  const state = serviceTierResolverState(source);
  if (state.kind === "patched") {
    return source;
  }
  if (state.kind !== "current") {
    return source;
  }
  const [, _resolverVar, modelVar, tierVar, findFastVar] = state.match;
  const replacement = state.match[0].replace(
    `${tierVar}===\`fast\`?${findFastVar}(${modelVar})`,
    `${tierVar}===\`fast\`?${findFastVar}(${modelVar})??${PATCH_MARKER}(${modelVar})`,
  );
  const patchedResolver = source.slice(0, state.match.index) + replacement +
    source.slice(state.match.index + state.match[0].length);
  const patched = fallbackFastTierHelper() + patchedResolver;

  return serviceTierResolverState(patched).kind === "patched" ? patched : source;
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

function currentSharedFallbackOptionsPattern(flags = "") {
  return new RegExp(
    `function ${JS_IDENT}\\((${JS_IDENT}),(${JS_IDENT})\\)\\{return\\[[^\\]]{0,800}?` +
      `\\.\\.\\.\\(\\2\\?\\?\\[\\]\\)\\.map\\((${JS_IDENT})=>` +
      fallbackOptionCallbackPattern().replace(`(${JS_IDENT})=>`, "") + `\\)\\]\\}`,
    flags,
  );
}

function patchedSharedFallbackOptionsPattern(flags = "") {
  return new RegExp(
    `function ${JS_IDENT}\\((${JS_IDENT}),(${JS_IDENT})\\)\\{return\\[[^\\]]{0,800}?` +
      `\\.\\.\\.\\(\\(\\2\\?\\.length\\?\\2:\\[${PATCH_MARKER}\\(\\1\\)\\]\\)\\.filter\\(Boolean\\)\\)\\.map\\(` +
      fallbackOptionCallbackPattern() + `\\)\\]\\}`,
    flags,
  );
}

function fallbackOptionMatches(source, pattern) {
  return [...source.matchAll(pattern)];
}

function fallbackFastTierState(source) {
  const current = fallbackOptionMatches(source, currentSharedFallbackOptionsPattern("g"))
    .map((match) => ({ match, modelVar: match[1], tiersVar: match[2] }));
  const patched = fallbackOptionMatches(source, patchedSharedFallbackOptionsPattern("g"))
    .map((match) => ({ match }));
  const helper = fallbackFastTierHelper();
  const helperCount = source.split(helper).length - 1;

  if (current.length === 1 && patched.length === 0 && helperCount <= 1 &&
      (!source.includes(`function ${PATCH_MARKER}(`) || helperCount === 1)) {
    return { kind: "current", ...current[0], helperCount };
  }
  if (current.length === 0 && patched.length === 1 && helperCount === 1) {
    return { kind: "patched", ...patched[0], helperCount };
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
  const modelVar = state.modelVar;
  const replacement = state.match[0].replace(
    `...(${state.tiersVar}??[])`,
    `...((${state.tiersVar}?.length?${state.tiersVar}:[${PATCH_MARKER}(${modelVar})]).filter(Boolean))`,
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
    applyApiKeyServiceTierResolverPatch(
      applyApiKeyModelMarkerPatch(applyApiKeyServiceTierGatePatch(source)),
    ),
  );
}

function applyCurrentGatePatch(source) {
  const gateAlreadyPatched = serviceTierGateState(source).kind === "patched";
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

function applyCurrentResolverPatch(source) {
  const resolverState = serviceTierResolverState(source);
  const resolverCandidate = resolverState.kind === "patched"
    ? source
    : applyApiKeyServiceTierResolverPatch(source);
  const resolverReady = resolverState.kind === "patched" || resolverCandidate !== source;

  if (!resolverReady) {
    warn("Could not identify current service tier resolver", "API key service tier resolver patch");
  }
  return resolverCandidate;
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
    id: "api-key-service-tier-resolver",
    phase: "webview-asset",
    order: 20608,
    ciPolicy: "optional",
    pattern: /^app-shared-[^.]+\.js$/,
    assetMatch: matchesApiKeyServiceTierResolverContract,
    missingDescription: "current API key service tier resolver bundle",
    skipDescription: "API key service tier resolver patch",
    apply: applyCurrentResolverPatch,
  },
  {
    id: "api-key-service-tier-fallback",
    phase: "webview-asset",
    order: 20610,
    ciPolicy: "optional",
    pattern: /^app-shared-[^.]+\.js$/,
    assetMatch: matchesFallbackFastTierContract,
    missingDescription: "current API key service tier fallback bundle",
    skipDescription: "API key fallback fast tier patch",
    apply: applyCurrentFallbackFastTierPatch,
  },
];

module.exports = {
  applyApiKeyModelMarkerPatch,
  applyApiKeyServiceTierGatePatch,
  applyApiKeyServiceTierResolverPatch,
  applyFallbackFastTierPatch,
  applyApiKeyServiceTierPatch,
  applyCurrentGatePatch,
  applyCurrentModelPatch,
  applyCurrentResolverPatch,
  applyCurrentFallbackFastTierPatch,
  hasApiKeyServiceTierGateShape,
  hasApiKeyModelListMappingShape,
  matchesApiKeyServiceTierGateContract,
  matchesApiKeyServiceTierModelContract,
  matchesApiKeyServiceTierResolverContract,
  matchesFallbackFastTierContract,
  descriptors,
};
