"use strict";

const JS_IDENT = "[A-Za-z_$][\\w$]*";
const PATCH_MARKER = "codexLinuxApiKeyFastTier";
const MODEL_MARKER = "codexLinuxApiKeyServiceTierModel";
const API_KEY_ACCESS = "{fast:!0,ultrafast:!1}";

// rspack chunks have no stable filenames, so every owner is found by content.
// The speed-mode access hook is copied into every chunk that renders a speed
// control; each copy is patched independently.
const GATE_NEEDLES = ["serviceTierAccess:", 'authMethod==="personalAccessToken"'];
const MODEL_NEEDLES = [
  "hasModelSupportingUltraReasoningEffort",
  "apiKeyDaybreakSupported",
  "codex-auto-review",
];
const RESOLVER_NEEDLES = ["serviceTiers?.find(", "supportsIndependentSpeedModes"];
const FALLBACK_NEEDLES = ["Description for the Ultrafast service tier", "serviceTiers"];

const FALLBACK_FAST_TIER_HELPER =
  `function ${PATCH_MARKER}(e){return null==e||e.serviceTiers?.length||` +
  `e.${MODEL_MARKER}!==!0?null:{id:"fast",name:"Fast",description:"1.5x speed, increased usage"}}`;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function warn(message, patchName) {
  console.warn(`WARN: ${message} - skipping ${patchName}`);
}

function replaceOnce(source, from, to) {
  const index = source.indexOf(from);
  if (index === -1 || source.indexOf(from, index + 1) !== -1) return null;
  return source.slice(0, index) + to + source.slice(index + from.length);
}

function spliceMatch(source, match, replacement) {
  return source.slice(0, match.index) + replacement + source.slice(match.index + match[0].length);
}

// --- Speed-mode access gate -------------------------------------------------

function serviceTierGatePattern(patched = false) {
  const access = patched
    ? `"apikey"===\\k<auth>&&!\\k<loading>\\?\\{fast:!0,ultrafast:!1\\}:null`
    : "null";
  const cacheAuth = patched ? "\\k<auth>" : "\\k<account>";
  return new RegExp(
    `(?<account>${JS_IDENT})=(?<host>${JS_IDENT})\\?\\.authMethod==="chatgpt"` +
      `\\|\\|\\k<host>\\?\\.authMethod==="personalAccessToken"` +
      `\\|\\|\\k<host>\\?\\.authMethod==="amazonBedrock",` +
      `(?<auth>${JS_IDENT})=\\k<host>\\?\\.authMethod\\?\\?null;[\\s\\S]{0,500}?` +
      `(?<loading>${JS_IDENT})=!!\\k<host>\\?\\.isLoading\\|\\|\\k<account>&&${JS_IDENT};` +
      `(?<cache>${JS_IDENT})\\[3\\]!==(?<requirements>${JS_IDENT})\\|\\|\\k<cache>\\[4\\]!==\\k<loading>` +
      `\\|\\|\\k<cache>\\[5\\]!==${cacheAuth}\\?` +
      `\\((?<result>${JS_IDENT})=\\k<account>&&!\\k<loading>&&null!=\\k<requirements>` +
      `\\?(?<resolver>\\(0,${JS_IDENT}\\.${JS_IDENT}\\)|${JS_IDENT})\\(\\k<requirements>\\):${access},` +
      `\\k<cache>\\[3\\]=\\k<requirements>,\\k<cache>\\[4\\]=\\k<loading>,\\k<cache>\\[5\\]=${cacheAuth},` +
      `\\k<cache>\\[6\\]=\\k<result>\\):\\k<result>=\\k<cache>\\[6\\];` +
      `let (?<output>${JS_IDENT})=\\k<result>(?:,${JS_IDENT})*;return[\\s\\S]{0,160}?` +
      `serviceTierAccess:\\k<output>,isLoading:\\k<loading>\\}`,
    "g",
  );
}

function serviceTierGateState(source) {
  const current = [...source.matchAll(serviceTierGatePattern())];
  const patched = [...source.matchAll(serviceTierGatePattern(true))];
  if (current.length === 1 && patched.length === 0) return { kind: "current", match: current[0] };
  if (current.length === 0 && patched.length === 1) return { kind: "patched", match: patched[0] };
  return { kind: current.length + patched.length === 0 ? "missing" : "invalid" };
}

function applyApiKeyServiceTierGatePatch(source) {
  const state = serviceTierGateState(source);
  if (state.kind === "patched") return source;
  if (state.kind === "current") {
    const { account, auth, loading, result, cache, requirements, resolver } = state.match.groups;
    // Keep account entitlements intact. The memo is keyed by the auth method
    // instead of the account boolean: API-key and other non-account hosts
    // share the same false account-auth value.
    let replacement = replaceOnce(
      state.match[0],
      `${result}=${account}&&!${loading}&&null!=${requirements}?${resolver}(${requirements}):null,`,
      `${result}=${account}&&!${loading}&&null!=${requirements}?${resolver}(${requirements}):` +
        `"apikey"===${auth}&&!${loading}?${API_KEY_ACCESS}:null,`,
    );
    replacement = replacement && replaceOnce(replacement, `${cache}[5]!==${account}?`, `${cache}[5]!==${auth}?`);
    replacement = replacement && replaceOnce(replacement, `,${cache}[5]=${account},`, `,${cache}[5]=${auth},`);
    if (replacement != null) {
      const patched = spliceMatch(source, state.match, replacement);
      if (serviceTierGateState(patched).kind === "patched") return patched;
    }
  }
  warn(
    state.kind === "invalid"
      ? "Service tier auth gate is ambiguous or partially patched"
      : "Could not find service tier auth gate",
    "API key service tier gate patch",
  );
  return source;
}

// --- Model catalog marker ----------------------------------------------------

const PATCHED_MODEL_MARKER = new RegExp(`${MODEL_MARKER}:"apikey"===${JS_IDENT}\\}`);

function modelListPattern() {
  return new RegExp(
    `(function ${JS_IDENT}\\(\\{additionalAvailableModels:${JS_IDENT},apiKeyDaybreakSupported:${JS_IDENT}=!1,` +
      `authMethod:(${JS_IDENT}),availableModels:${JS_IDENT},defaultModel:${JS_IDENT},` +
      `enabledReasoningEfforts:${JS_IDENT},hasConfiguredModelCatalog:${JS_IDENT},` +
      `includeUltraReasoningEffort:${JS_IDENT},isCustomModelProvider:${JS_IDENT}=!1,` +
      `models:${JS_IDENT},useHiddenModels:${JS_IDENT}\\}\\)` +
      `\\{[\\s\\S]{0,2400}?[,;]${JS_IDENT}=\\{\\.\\.\\.${JS_IDENT},supportedReasoningEfforts:${JS_IDENT})(\\})` +
      `(?=[\\s\\S]{0,1200}?hasModelSupportingUltraReasoningEffort)`,
    "g",
  );
}

function applyApiKeyModelMarkerPatch(source) {
  if (PATCHED_MODEL_MARKER.test(source)) {
    return source;
  }
  const matches = [...source.matchAll(modelListPattern())];
  if (matches.length === 1) {
    const [, prefix, authMethodVar, suffix] = matches[0];
    return spliceMatch(
      source,
      matches[0],
      `${prefix},${MODEL_MARKER}:"apikey"===${authMethodVar}${suffix}`,
    );
  }
  warn(
    matches.length > 1 ? "Model list mapping is ambiguous" : "Could not find model list mapping",
    "API key model service tier marker patch",
  );
  return source;
}

// --- Service tier resolver ---------------------------------------------------

function serviceTierResolverPattern() {
  return new RegExp(
    `(?<helper>${escapeRegExp(FALLBACK_FAST_TIER_HELPER)})?` +
      `function (?<name>${JS_IDENT})\\((?<model>${JS_IDENT}),(?<tier>${JS_IDENT})\\)\\{return ` +
      `null==\\k<tier>\\?null:\\k<tier>===(?:"fast"|(?<fastConst>${JS_IDENT}))` +
      `\\?(?<findFast>${JS_IDENT})\\(\\k<model>\\)(?<fallback>\\?\\?${PATCH_MARKER}\\(\\k<model>\\))?:` +
      `\\k<model>\\?\\.serviceTiers\\?\\.find\\((?<item>${JS_IDENT})=>\\k<item>\\.id===\\k<tier>\\)\\?\\?null\\}`,
    "g",
  );
}

function resolverOwnsFastConstant(source, match) {
  const { fastConst, findFast } = match.groups;
  const before = source.slice(Math.max(0, match.index - 3000), match.index);
  if (fastConst != null &&
      !new RegExp(`(?:let |,)${escapeRegExp(fastConst)}="fast"[,;]`).test(before)) {
    return false;
  }
  const after = source.slice(match.index, match.index + match[0].length + 400);
  return new RegExp(
    `function ${escapeRegExp(findFast)}\\((${JS_IDENT})\\)\\{return \\1\\?\\.serviceTiers\\?\\.find\\(`,
  ).test(after);
}

function serviceTierResolverState(source) {
  const matches = [...source.matchAll(serviceTierResolverPattern())]
    .filter((match) => resolverOwnsFastConstant(source, match));
  if (matches.length !== 1) return { kind: matches.length === 0 ? "missing" : "invalid" };
  const [match] = matches;
  const { helper, fallback } = match.groups;
  if (helper != null && fallback != null) return { kind: "patched", match };
  if (helper == null && fallback == null) return { kind: "current", match };
  return { kind: "invalid" };
}

function applyApiKeyServiceTierResolverPatch(source) {
  const state = serviceTierResolverState(source);
  if (state.kind === "patched") return source;
  if (state.kind === "current") {
    const { model, findFast } = state.match.groups;
    const replacement = replaceOnce(
      state.match[0],
      `?${findFast}(${model}):`,
      `?${findFast}(${model})??${PATCH_MARKER}(${model}):`,
    );
    if (replacement != null) {
      // The helper is declared next to the resolver, inside the same webpack
      // module factory, so it never relies on another module's scope.
      const patched = spliceMatch(source, state.match, FALLBACK_FAST_TIER_HELPER + replacement);
      if (serviceTierResolverState(patched).kind === "patched") return patched;
    }
  }
  warn(
    state.kind === "invalid"
      ? "Service tier resolver is ambiguous or partially patched"
      : "Could not find service tier resolver",
    "API key service tier resolver patch",
  );
  return source;
}

// --- Speed option list for the active model ----------------------------------

function fallbackOptionsPattern() {
  return new RegExp(
    `(?<helper>${escapeRegExp(FALLBACK_FAST_TIER_HELPER)})?` +
      `function (?<wrapper>${JS_IDENT})\\((?<model>${JS_IDENT})\\)\\{return (?<options>${JS_IDENT})` +
      `\\(\\k<model>\\?\\.model,(?:\\k<model>\\?\\.serviceTiers|(?<fallback>\\k<model>\\?\\.serviceTiers\\?\\.length` +
      `\\?\\k<model>\\.serviceTiers:\\[${PATCH_MARKER}\\(\\k<model>\\)\\]\\.filter\\(Boolean\\)))\\)\\}`,
    "g",
  );
}

function optionsOwnerMatches(source, optionsVar) {
  // The option builder prepends the Standard option, maps every advertised
  // tier into a picker option and keeps the tier object as `tier`.
  const pattern = new RegExp(
    `function ${escapeRegExp(optionsVar)}\\(${JS_IDENT},(${JS_IDENT})\\)\\{return\\[${JS_IDENT},` +
      `\\.\\.\\.\\(\\1\\?\\?\\[\\]\\)\\.map\\((${JS_IDENT})=>\\{[\\s\\S]{0,1500}?` +
      `iconKind:${JS_IDENT},label:[\\s\\S]{0,300}?tier:\\2,value:\\2\\.id\\}\\}\\)\\]\\}`,
    "g",
  );
  return [...source.matchAll(pattern)].length === 1;
}

function fallbackFastTierState(source) {
  const matches = [...source.matchAll(fallbackOptionsPattern())]
    .filter((match) => optionsOwnerMatches(source, match.groups.options));
  if (matches.length !== 1) return { kind: matches.length === 0 ? "missing" : "invalid" };
  const [match] = matches;
  const { helper, fallback } = match.groups;
  if (helper != null && fallback != null) return { kind: "patched", match };
  if (helper == null && fallback == null) return { kind: "current", match };
  return { kind: "invalid" };
}

function applyFallbackFastTierPatch(source) {
  const state = fallbackFastTierState(source);
  if (state.kind === "patched") return source;
  if (state.kind === "current") {
    const { model } = state.match.groups;
    const replacement = replaceOnce(
      state.match[0],
      `${model}?.model,${model}?.serviceTiers)}`,
      `${model}?.model,${model}?.serviceTiers?.length?${model}.serviceTiers:` +
        `[${PATCH_MARKER}(${model})].filter(Boolean))}`,
    );
    if (replacement != null) {
      const patched = spliceMatch(source, state.match, FALLBACK_FAST_TIER_HELPER + replacement);
      if (fallbackFastTierState(patched).kind === "patched") return patched;
    }
  }
  warn(
    state.kind === "invalid"
      ? "Service tier option helpers are ambiguous or partially patched"
      : "Could not find service tier option helpers",
    "API key fallback fast tier patch",
  );
  return source;
}

const descriptors = [
  {
    id: "api-key-service-tier-gate",
    phase: "webview-asset",
    order: 20600,
    ciPolicy: "optional",
    assetNeedles: GATE_NEEDLES,
    missingDescription: "current API key service tier gate bundle",
    skipDescription: "API key service tier gate patch",
    apply: applyApiKeyServiceTierGatePatch,
  },
  {
    id: "api-key-service-tier-model",
    phase: "webview-asset",
    order: 20605,
    ciPolicy: "optional",
    assetNeedles: MODEL_NEEDLES,
    missingDescription: "current API key service tier model bundle",
    skipDescription: "API key model service tier marker patch",
    apply: applyApiKeyModelMarkerPatch,
  },
  {
    id: "api-key-service-tier-resolver",
    phase: "webview-asset",
    order: 20608,
    ciPolicy: "optional",
    assetNeedles: RESOLVER_NEEDLES,
    missingDescription: "current API key service tier resolver bundle",
    skipDescription: "API key service tier resolver patch",
    apply: applyApiKeyServiceTierResolverPatch,
  },
  {
    id: "api-key-service-tier-fallback",
    phase: "webview-asset",
    order: 20610,
    ciPolicy: "optional",
    assetNeedles: FALLBACK_NEEDLES,
    missingDescription: "current API key service tier fallback bundle",
    skipDescription: "API key fallback fast tier patch",
    apply: applyFallbackFastTierPatch,
  },
];

module.exports = {
  FALLBACK_FAST_TIER_HELPER,
  applyApiKeyModelMarkerPatch,
  applyApiKeyServiceTierGatePatch,
  applyApiKeyServiceTierResolverPatch,
  applyFallbackFastTierPatch,
  descriptors,
  fallbackFastTierState,
  serviceTierGateState,
  serviceTierResolverState,
};
