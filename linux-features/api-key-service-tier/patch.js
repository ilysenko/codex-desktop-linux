"use strict";

const path = require("node:path");
const { Script } = require("node:vm");
const { createJavaScriptLexicalIndex } = require("../../scripts/patches/lib/minified-js.js");
const { findRspackExportPublication } = require("../../scripts/patches/lib/rspack-export-publication.js");
const { findRspackRequireBinding, findUniqueRspackModuleCopies, patchRspackModuleCopies } =
  require("../../scripts/patches/lib/rspack-module-assets.js");
const { rspackModuleFactories } = require("../../scripts/patches/lib/rspack-module-assets.js");
const { inspectModelCatalogOwner } = require("../../scripts/patches/lib/model-composer-owners.js");

const JS_IDENT = "[A-Za-z_$][\\w$]*";
const PATCH_MARKER = "codexLinuxApiKeyFastTier";
const MODEL_MARKER = "codexLinuxApiKeyServiceTierModel";
const API_KEY_ACCESS = "{fast:!0,ultrafast:!1}";

// rspack chunks have no stable filenames, so every owner is found by content.
// The speed-mode access hook is copied into every chunk that renders a speed
// control; prepare every physical copy before committing the cohort.
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

// This contract describes the complete current published hook, not text that
// merely resembles its entitlement branch. In particular the hostId, auth
// query, loading state, native resolver and both memoized outputs share the
// captured bindings. Import/export names and physical chunk names may drift.
function serviceTierGatePattern(patched = false) {
  const cacheAuth = patched ? "\\k<auth>" : "\\k<account>";
  const access = patched ? `"apikey"===\\k<auth>&&!\\k<loading>\\?\\{fast:!0,ultrafast:!1\\}:null` : "null";
  return new RegExp(
    `^function\\((?<argument>${JS_IDENT})\\)\\{let (?<query>${JS_IDENT}),(?<result>${JS_IDENT}),` +
    `(?<returned>${JS_IDENT}),(?<cache>${JS_IDENT})=\\(0,(?<memoModule>${JS_IDENT})\\.${JS_IDENT}\\)\\(10\\),` +
    `(?<defaultHost>${JS_IDENT})=\\(0,(?<queryModule>${JS_IDENT})\\.${JS_IDENT}\\)` +
    `\\((?<defaultModule>${JS_IDENT})\\.${JS_IDENT}\\),(?<hostId>${JS_IDENT})=\\k<argument>\\?\\.hostId\\?\\?\\k<defaultHost>,` +
    `(?<host>${JS_IDENT})=\\(0,(?<hostModule>${JS_IDENT})\\.${JS_IDENT}\\)\\(\\k<hostId>\\),` +
    `(?<account>${JS_IDENT})=\\k<host>\\?\\.authMethod==="chatgpt"` +
    `\\|\\|\\k<host>\\?\\.authMethod==="personalAccessToken"` +
    `\\|\\|\\k<host>\\?\\.authMethod==="amazonBedrock",(?<auth>${JS_IDENT})=\\k<host>\\?\\.authMethod\\?\\?null;` +
    `\\k<cache>\\[0\\]!==\\k<hostId>\\|\\|\\k<cache>\\[1\\]!==\\k<auth>\\?` +
    `\\(\\k<query>=\\{authMethod:\\k<auth>,hostId:\\k<hostId>\\},\\k<cache>\\[0\\]=\\k<hostId>,` +
    `\\k<cache>\\[1\\]=\\k<auth>,\\k<cache>\\[2\\]=\\k<query>\\):\\k<query>=\\k<cache>\\[2\\];` +
    `let\\{data:(?<requirements>${JS_IDENT}),isPending:(?<pending>${JS_IDENT})\\}=` +
    `\\(0,\\k<queryModule>\\.${JS_IDENT}\\)\\((?<requirementsModule>${JS_IDENT})\\.${JS_IDENT},\\k<query>\\),` +
    `(?<loading>${JS_IDENT})=!!\\k<host>\\?\\.isLoading\\|\\|\\k<account>&&\\k<pending>;` +
    `\\k<cache>\\[3\\]!==\\k<requirements>\\|\\|\\k<cache>\\[4\\]!==\\k<loading>\\|\\|\\k<cache>\\[5\\]!==${cacheAuth}\\?` +
    `\\(\\k<result>=\\k<account>&&!\\k<loading>&&null!=\\k<requirements>\\?` +
    `(?<resolver>\\(0,(?<resolverModule>${JS_IDENT})\\.${JS_IDENT}\\))\\(\\k<requirements>\\):${access},` +
    `\\k<cache>\\[3\\]=\\k<requirements>,\\k<cache>\\[4\\]=\\k<loading>,\\k<cache>\\[5\\]=${cacheAuth},` +
    `\\k<cache>\\[6\\]=\\k<result>\\):\\k<result>=\\k<cache>\\[6\\];` +
    `let (?<output>${JS_IDENT})=\\k<result>;return \\k<cache>\\[7\\]!==\\k<loading>\\|\\|\\k<cache>\\[8\\]!==\\k<output>\\?` +
    `\\(\\k<returned>=\\{serviceTierAccess:\\k<output>,isLoading:\\k<loading>\\},\\k<cache>\\[7\\]=\\k<loading>,` +
    `\\k<cache>\\[8\\]=\\k<output>,\\k<cache>\\[9\\]=\\k<returned>\\):\\k<returned>=\\k<cache>\\[9\\],\\k<returned>\\}$`, "u",
  );
}

function gateOwner(source, module, patched) {
  if (module == null || !Array.isArray(module.params) || module.params.length !== 3 ||
      !GATE_NEEDLES.every(needle => source.includes(needle))) return null;
  if (typeof module.source === "string" &&
      !createJavaScriptLexicalIndex(module.source).isCode(module.start)) return null;
  const snapshot = { ...module, moduleSource: source };
  const lexical = createJavaScriptLexicalIndex(source);
  const keys = [...source.matchAll(new RegExp(`(?<key>${JS_IDENT}):function\\(`, "gu"))]
    .filter(match => lexical.isCode(match.index)).map(match => match.groups.key);
  const owners = [];
  for (const key of new Set(keys)) {
    const publication = findRspackExportPublication(snapshot, key);
    if (publication?.fn == null) continue;
    const { start, end } = publication.fn;
    const match = serviceTierGatePattern(patched).exec(source.slice(start, end));
    if (match == null) continue;
    const groups = match.groups;
    const imports = [groups.memoModule, groups.queryModule, groups.defaultModule,
      groups.hostModule, groups.requirementsModule, groups.resolverModule];
    const locals = [groups.argument, groups.query, groups.result, groups.returned, groups.cache,
      groups.defaultHost, groups.hostId, groups.host, groups.account, groups.auth,
      groups.requirements, groups.pending, groups.loading, groups.output];
    if (new Set(imports).size !== imports.length || new Set(locals).size !== locals.length ||
        locals.some(name => imports.includes(name)) || imports.some(name => module.params.includes(name))) continue;
    const bindings = imports.map(name => findRspackRequireBinding(snapshot, name));
    if (bindings.some(binding => binding == null)) continue;
    // The current owner contains only static imports and this direct anonymous
    // publication. No earlier/later reassignment, shadow scope or extra export
    // may borrow the otherwise matching branch.
    const req = escapeRegExp(publication.requireName), exp = escapeRegExp(publication.exportsName);
    const imported = `${JS_IDENT}=${req}\\((?:"(?:\\\\.|[^"\\\\])*"|\\d+)\\)`;
    const prefix = new RegExp(`^var ${imported}(?:,${imported}){5};${req}\\.d\\(${exp},\\{\\},\\{${escapeRegExp(key)}:$`, "u");
    if (!prefix.test(source.slice(0, start)) || !/^\}\);?$/u.test(source.slice(end))) continue;
    owners.push({ match: { ...match, index: start }, publication, imports: bindings });
  }
  return owners.length === 1 ? owners[0] : null;
}

function rewriteGate(source, owner, reverse = false) {
  const { account, auth, loading, result, cache, requirements, resolver } = owner.match.groups;
  const nativeAccess = `${result}=${account}&&!${loading}&&null!=${requirements}?${resolver}(${requirements}):null,`;
  const apiKeyAccess = `${result}=${account}&&!${loading}&&null!=${requirements}?${resolver}(${requirements}):` +
    `"apikey"===${auth}&&!${loading}?${API_KEY_ACCESS}:null,`;
  let replacement = replaceOnce(owner.match[0], reverse ? apiKeyAccess : nativeAccess, reverse ? nativeAccess : apiKeyAccess);
  replacement = replacement && replaceOnce(replacement, `${cache}[5]!==${reverse ? auth : account}?`, `${cache}[5]!==${reverse ? account : auth}?`);
  replacement = replacement && replaceOnce(replacement, `,${cache}[5]=${reverse ? auth : account},`, `,${cache}[5]=${reverse ? account : auth},`);
  return replacement == null ? null : spliceMatch(source, owner.match, replacement);
}

function serviceTierGateState(source, module) {
  const current = gateOwner(source, module, false), patched = gateOwner(source, module, true);
  if (current != null && patched == null) return { kind: "current", ...current };
  if (current == null && patched != null) {
    const native = rewriteGate(source, patched, true), owner = gateOwner(native, module, false);
    if (owner != null && rewriteGate(native, owner) === source) return { kind: "patched", ...patched };
  }
  return { kind: "missing" };
}

function applyApiKeyServiceTierGatePatch(source, module) {
  const state = serviceTierGateState(source, module);
  if (state.kind === "patched") return source;
  if (state.kind !== "current") throw new Error("Missing, ambiguous or partial current API key service tier gate owner");
  const patched = rewriteGate(source, state);
  if (patched == null || serviceTierGateState(patched, module).kind !== "patched") {
    throw new Error("API key service tier gate patch failed canonical replay");
  }
  return patched;
}

function patchApiKeyServiceTierGate(extractedDir, options = {}) {
  const assetsDir = path.join(extractedDir, "webview", "assets");
  const copies = findUniqueRspackModuleCopies(assetsDir, {
    description: "current API key service tier gate bundle",
    sourceMatch: source => GATE_NEEDLES.every(needle => source.includes(needle)),
    matchModule: (source, module) => serviceTierGateState(source, module).kind !== "missing",
  });
  return patchRspackModuleCopies(assetsDir, copies, applyApiKeyServiceTierGatePatch, options);
}

// --- Model catalog marker ----------------------------------------------------

const MODEL_DESCRIPTION = "current API key service tier model bundle";
const modelMarkerCount = source => source.split(MODEL_MARKER).length - 1;
const identifiesModelOwner = source => source.includes(MODEL_MARKER) || MODEL_NEEDLES.every(needle => source.includes(needle));

// The generic registry walker is textual. Qualify its header as actual root
// code before allowing it to inspect factories in comments or example strings.
function requireModelRegistry(source) {
  const headers = [...source.matchAll(/\bexport\s+const\s+__webpack_modules__\s*=\s*\{/gu)];
  if (headers.length !== 1) throw new Error(`Missing or ambiguous ${MODEL_DESCRIPTION} registry`);
  const [header] = headers;
  const prefix = createJavaScriptLexicalIndex(source.slice(0, header.index + header[0].length));
  if (!prefix.isRoot(header.index)) throw new Error(`Opaque or nested ${MODEL_DESCRIPTION} registry`);
}

function inspectModelMarker(source, snapshot) {
  const module = { ...snapshot, moduleSource: source };
  const found = inspectModelCatalogOwner(module);
  if (!found.ok) throw new Error(`Unsupported ${MODEL_DESCRIPTION}: ${found.reason}`);
  const { normalization, inputs, loop, visibility } = found;
  const lexical = createJavaScriptLexicalIndex(source);
  const captured = ["additional", "daybreak", "auth", "available", "configured", "custom", "hidden", "ultra", "enabled"];
  if (captured.some(role => inputs[role] === loop.model) || visibility.owner.start !== loop.range.end ||
      source.slice(visibility.call.end, normalization.sourceRange.start) !== "){let " ||
      lexical.matchingBrace(visibility.call.end + 1) !== normalization.outputRange.end) {
    throw new Error(`Unsupported ${MODEL_DESCRIPTION} normalization binding`);
  }
  // The captured auth must resolve to the catalog parameter at the insertion.
  // Syntax-only probes catch lexical/destructured/function declarations and
  // hoisted vars without executing the factory or rejecting unrelated locals
  // inside sibling functions. These are the three scopes enclosing the field.
  const loopOpen = loop.range.end - "{if(".length;
  const scopes = [found.owner.body,
    {start: loopOpen + 1, end: lexical.matchingBrace(loopOpen)},
    {start: visibility.call.end + 2, end: normalization.outputRange.end}];
  for (const scope of scopes) {
    try { new Script(`function modelMarkerScope(){${source.slice(scope.start, scope.end)};let ${inputs.auth};}`); }
    catch { throw new Error(`Unsupported ${MODEL_DESCRIPTION} auth scope binding`); }
  }
  const output = source.slice(normalization.outputRange.start, normalization.outputRange.end);
  const prefix = `${normalization.output}={...${loop.model},supportedReasoningEfforts:${normalization.filteredEfforts}`;
  const close = output.indexOf("};");
  if (!output.startsWith(prefix) || close < prefix.length) throw new Error(`Unsupported ${MODEL_DESCRIPTION} output`);
  const contribution = `,${MODEL_MARKER}:"apikey"===${inputs.auth}`;
  const applied = output.slice(0, close).endsWith(contribution) && modelMarkerCount(source) === 1;
  if (!applied && modelMarkerCount(source) !== 0) throw new Error(`Orphan or noncanonical ${MODEL_DESCRIPTION} marker`);
  return { applied, insertion: normalization.outputRange.start + close, contribution };
}

function patchModelFactory(source, snapshot) {
  const state = inspectModelMarker(source, snapshot);
  if (state.applied) {
    const start = state.insertion - state.contribution.length;
    const native = source.slice(0, start) + source.slice(state.insertion);
    const original = inspectModelMarker(native, snapshot);
    if (original.applied || native.slice(0, original.insertion) + original.contribution + native.slice(original.insertion) !== source) {
      throw new Error(`Noncanonical ${MODEL_DESCRIPTION} replay`);
    }
    return source;
  }
  const patched = source.slice(0, state.insertion) + state.contribution + source.slice(state.insertion);
  if (!inspectModelMarker(patched, snapshot).applied || patchModelFactory(patched, snapshot) !== patched) {
    throw new Error(`Incomplete ${MODEL_DESCRIPTION} insertion`);
  }
  return patched;
}

function applyApiKeyModelMarkerPatch(source, context = {}) {
  if (context.factorySnapshot != null) {
    if (context.factorySnapshot.moduleSource !== source) throw new Error("Stale model catalog factory snapshot");
    return patchModelFactory(source, context.factorySnapshot);
  }
  requireModelRegistry(source);
  const candidates = [...rspackModuleFactories(source, "model-catalog.js")]
    .filter(module => identifiesModelOwner(module.moduleSource) && inspectModelCatalogOwner(module).ok);
  if (candidates.length !== 1) throw new Error(`Missing or ambiguous ${MODEL_DESCRIPTION} factory`);
  const [module] = candidates;
  if (modelMarkerCount(source) !== modelMarkerCount(module.moduleSource)) throw new Error(`Orphan ${MODEL_DESCRIPTION} marker`);
  return source.slice(0, module.start) + patchModelFactory(module.moduleSource, module) + source.slice(module.end);
}

function patchApiKeyModelMarker(extractedDir, _context = {}, options = {}) {
  const assetsDir = path.join(extractedDir, "webview", "assets");
  const markerAssets = new Set();
  const copies = findUniqueRspackModuleCopies(assetsDir, {
    description: MODEL_DESCRIPTION,
    sourceMatch(source, name) {
      if (source.includes(MODEL_MARKER)) markerAssets.add(name);
      return identifiesModelOwner(source);
    },
    matchModule: (source, module) => identifiesModelOwner(source) && inspectModelCatalogOwner(module).ok,
  });
  for (const copy of copies) {
    requireModelRegistry(copy.source);
    inspectModelMarker(copy.moduleSource, copy);
    if (modelMarkerCount(copy.source) !== modelMarkerCount(copy.moduleSource)) throw new Error(`Orphan ${MODEL_DESCRIPTION} marker`);
    markerAssets.delete(copy.assetName);
  }
  if (markerAssets.size > 0) throw new Error(`Orphan ${MODEL_DESCRIPTION} marker in ${[...markerAssets].join(", ")}`);
  return patchRspackModuleCopies(assetsDir, copies, patchModelFactory, options);
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
    `(?:function (?<wrapper>${JS_IDENT})|${JS_IDENT}:function)\\((?<model>${JS_IDENT})\\)\\{` +
      `(?<helper>${escapeRegExp(FALLBACK_FAST_TIER_HELPER)})?return (?<options>${JS_IDENT})` +
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
      const withHelper = replacement.replace("{return ", `{${FALLBACK_FAST_TIER_HELPER}return `);
      const patched = spliceMatch(source, state.match, withHelper);
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
    phase: "extracted-app:pre-webview",
    order: 20600,
    ciPolicy: "optional",
    apply: patchApiKeyServiceTierGate,
  },
  {
    id: "api-key-service-tier-model",
    phase: "extracted-app:pre-webview",
    order: 20605,
    ciPolicy: "optional",
    apply: patchApiKeyModelMarker,
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
  patchApiKeyModelMarker,
  applyApiKeyServiceTierGatePatch,
  patchApiKeyServiceTierGate,
  applyApiKeyServiceTierResolverPatch,
  applyFallbackFastTierPatch,
  descriptors,
  fallbackFastTierState,
  serviceTierGateState,
  serviceTierResolverState,
};
