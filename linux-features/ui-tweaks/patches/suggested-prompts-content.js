"use strict";

const path = require("node:path");
const { Script } = require("node:vm");
function helpers() { return require("../../../scripts/patches/lib/minified-js.js"); }
function moduleHelpers() { return require("../../../scripts/patches/lib/rspack-module-assets.js"); }
const ID = "[A-Za-z_$][\\w$]*";
const HOME_CONTENT_SOURCE_MARKER = "codexLinuxSuggestedPromptsGeneratedSource";
const HOME_CONTENT_ASSET_NEEDLES = Object.freeze(['"curated"===', "shouldUseCuratedNewChatPageSuggestions:"]);
const RECORD = new RegExp(
  `\\(0,(?<policy>${ID})\\.(?<show>${ID})\\)\\(\\{canUsePersonalizedSuggestions:(?<runtime>${ID}),` +
  `generatedSuggestionsEnabled:(?<generated>${ID}),hasGeneratedSuggestionsReadSettled:(?<settled>${ID}),` +
  `shouldUseCuratedNewChatPageSuggestions:(?<flag>${ID})\\}\\)`, "g");
const CONTEXT = new RegExp(
  `(?<![\\w$.])(?<generated>${ID})=(?<page>${ID})&&null!=(?<project>${ID}),` +
  `(?<query>${ID})=null==(?<debug>${ID})&&\\k<generated>&&(?<runtime>${ID})(?=[,;])`, "g");
const SOURCE = new RegExp(
  `if\\((?<query>${ID})&&\\((?<loading>${ID})\\|\\|(?<eligible>${ID})&&(?<pending>${ID})\\)\\)(?<source>${ID})=null;else\\{let (?<value>${ID});` +
  `(?<cache>${ID})\\[(?<eligibleSlot>\\d+)\\]!==\\k<eligible>\\|\\|\\k<cache>\\[(?<personalizedSlot>\\d+)\\]!==(?<personalized>${ID})\\|\\|\\k<cache>\\[(?<debugSlot>\\d+)\\]!==(?<debug>${ID})\\?` +
  `\\(\\k<value>=\\(0,(?<policy>${ID})\\.(?<choose>${ID})\\)\\(\\{debugOverride:\\k<debug>,experimentEligible:\\k<eligible>,personalized:\\k<personalized>\\}\\),` +
  `\\k<cache>\\[\\k<eligibleSlot>\\]=\\k<eligible>,\\k<cache>\\[\\k<personalizedSlot>\\]=\\k<personalized>,\\k<cache>\\[\\k<debugSlot>\\]=\\k<debug>,\\k<cache>\\[(?<valueSlot>\\d+)\\]=\\k<value>\\):` +
  `\\k<value>=\\k<cache>\\[\\k<valueSlot>\\],\\k<source>=\\k<value>\\}`, "g");

function all(source, pattern) { return [...source.matchAll(pattern)]; }
function escape(value) { return helpers().escapeRegExp(value); }
function close(source, offset) { return helpers().findMatchingBrace(source, offset); }
function topLevel(source, offset) { return close("{" + source.slice(0, offset) + "}", 0) === offset + 1; }
function declarations(source, name) {
  return all(source, new RegExp(`(?<![\\w$.])${escape(name)}=(?![=>])`, "g")).length;
}
function markerCount(source) {
  return all(source, new RegExp(`(?<![\\w$])${HOME_CONTENT_SOURCE_MARKER}(?![\\w$])`, "g")).length;
}
function local(body, name, params = "") {
  try { new Script(`function probe(${params}){${body}\n;let ${name};}`); return false; }
  catch { return true; }
}
function statementAt(source, index) {
  if (!topLevel(source, index)) return false;
  // Preserve the exact prefix: an added newline could complete a line comment
  // or insert a semicolon after return. A lexical declaration cannot complete
  // a pending arrow/expression, label, conditional or loop header/body.
  try { new Script(`function probe(){${source.slice(0, index)}const __codexContentDeclaration = 0;}`); return true; }
  catch { return false; }
}
function functionAt(source, name) {
  const headers = all(source, new RegExp(`function ${escape(name)}\\((?<props>${ID})\\)\\{`, "g"));
  if (headers.length !== 1) return null;
  const header = headers[0], start = header.index + header[0].length, end = close(source, start - 1);
  if (end < start || !statementAt(source, header.index)) return null;
  return { name, props: header.groups.props, header: header.index, start, end, body: source.slice(start, end) };
}

function moduleState(module) {
  const source = module.moduleSource, { findRspackRequireBinding } = moduleHelpers();
  const records = all(source, RECORD), contexts = all(source, CONTEXT), policies = all(source, SOURCE);
  if (records.length !== 1 || contexts.length !== 1 || policies.length !== 1) return null;
  const record = records[0], context = contexts[0], policy = policies[0];
  const r = record.groups, c = context.groups, p = policy.groups;
  if (r.runtime !== c.runtime || r.generated !== c.generated || r.policy !== p.policy ||
      c.query !== p.query || c.debug !== p.debug) return null;
  const owners = all(source, new RegExp(`function (?<name>${ID})\\(${ID}\\)\\{`, "g"))
    .map(header => functionAt(source, header.groups.name)).filter(owner => owner != null &&
      [record.index, context.index, policy.index].every(index => owner.start <= index && index < owner.end));
  if (owners.length !== 1) return null;
  const owner = owners[0];
  try { new Script(`function probe(${owner.props}){${owner.body}\n}`); } catch { return null; }
  if (!topLevel(owner.body, context.index - owner.start)) return null;
  const props = all(owner.body, new RegExp(`\\{(?<entries>[^{}]*)\\}=${escape(owner.props)}(?=[,;])`, "g"))
    .filter(match => match.groups.entries.includes("generatedSuggestionsEnabled:"));
  if (props.length !== 1) return null;
  const property = key => {
    const matches = all(props[0].groups.entries, new RegExp(`(?:^|,)${key}:(?<value>${ID})(?=,|$)`, "g"));
    return matches.length === 1 ? matches[0].groups.value : null;
  };
  const host = property("hostId");
  if (property("generatedSuggestionsEnabled") !== c.page || property("projectRoot") !== c.project || host == null) return null;
  const runtime = all(owner.body, new RegExp(
    `${escape(c.runtime)}=!0===\\(0,(?<hook>${ID})\\.${ID}\\)\\((?<settings>${ID})\\.${ID}\\.enabled\\)`, "g"));
  const debug = all(owner.body, new RegExp(`${escape(c.debug)}=\\(0,(?<store>${ID})\\.${ID}\\)\\(${ID}(?:\\.${ID})?\\)`, "g"));
  if (runtime.length !== 1 || debug.length !== 1 || !topLevel(owner.body, runtime[0].index) || !topLevel(owner.body, debug[0].index)) return null;
  const query = all(owner.body, new RegExp(
    `(?<options>${ID})=\\{accountId:${ID}\\.accountId,enabled:${escape(c.query)},hostId:${escape(host)}\\}`, "g"));
  if (query.length !== 1) return null;
  const queryReads = all(owner.body, new RegExp(
    `\\{data:(?<data>${ID}),isLoading:${escape(p.loading)}\\}=\\(0,${escape(r.policy)}\\.${ID}\\)\\(${escape(query[0].groups.options)}\\)`, "g"));
  if (queryReads.length !== 1 || !owner.body.includes(`${p.eligible}=${c.query}&&!0===${queryReads[0].groups.data}`)) return null;

  // Both native memo projections retain their input/output slots. The
  // conditional loading branch owns the source assigned to the returned flag.
  const personalized = all(owner.body, new RegExp(
    `${escape(p.cache)}\\[(?<eligibleSlot>\\d+)\\]!==${escape(p.eligible)}\\|\\|${escape(p.cache)}\\[(?<pendingSlot>\\d+)\\]!==${escape(p.pending)}\\|\\|${escape(p.cache)}\\[(?<configSlot>\\d+)\\]!==(?<config>${ID})\\?` +
    `\\((?<value>${ID})=${escape(p.eligible)}&&!${escape(p.pending)}&&\\k<config>\\.get\\("personalized",!1\\),` +
    `${escape(p.cache)}\\[\\k<eligibleSlot>\\]=${escape(p.eligible)},${escape(p.cache)}\\[\\k<pendingSlot>\\]=${escape(p.pending)},${escape(p.cache)}\\[\\k<configSlot>\\]=\\k<config>,` +
    `${escape(p.cache)}\\[(?<valueSlot>\\d+)\\]=\\k<value>\\):\\k<value>=${escape(p.cache)}\\[\\k<valueSlot>\\];let ${escape(p.personalized)}=\\k<value>;`, "g"));
  if (personalized.length !== 1 || !topLevel(owner.body, personalized[0].index) ||
      !topLevel(owner.body, policy.index - owner.start) || personalized[0].index + owner.start >= policy.index ||
      new Set([p.eligibleSlot,p.personalizedSlot,p.debugSlot,p.valueSlot]).size !== 4 ||
      new Set(Object.entries(personalized[0].groups).filter(([key])=>key.endsWith("Slot")).map(([,value])=>value)).size !== 4) return null;
  const flagStart = policy.index + policy[0].length;
  const original = `let ${r.flag}="curated"===${p.source};`;
  const replacement = `let ${r.flag}="curated"===${p.source}&&!${c.query}/*${HOME_CONTENT_SOURCE_MARKER}*/;`;
  const patched = source.startsWith(replacement, flagStart);
  if (!(patched || source.startsWith(original, flagStart)) || markerCount(source) !== Number(patched) ||
      flagStart >= record.index || !topLevel(owner.body, flagStart - owner.start)) return null;
  if ([c.generated, c.query, c.runtime, c.debug, r.flag].some(name => declarations(owner.body, name) !== 1) ||
      declarations(owner.body, p.source) !== 2) return null;
  const requireName = module.params[2], exportsName = module.params[1];
  if (requireName == null || exportsName == null) return null;
  const exported = all(source, new RegExp(
    `(?<![\\w$.])${escape(requireName)}\\.d\\(${escape(exportsName)},\\{HomeAmbientSuggestionsContent:\\(\\)=>(?<wrapper>${ID})\\}\\)`, "g"));
  if (exported.length !== 1 || !statementAt(source, exported[0].index)) return null;
  const wrapper = functionAt(source, exported[0].groups.wrapper);
  const mounts = all(source, new RegExp(`\\(0,(?<jsx>${ID})\\.jsx\\)\\(${escape(owner.name)},\\{[^{}]*generatedSuggestionsEnabled:${ID},[^{}]*projectRoot:${ID}[^{}]*\\}\\)`, "g"));
  if (wrapper == null || mounts.length !== 1 || mounts[0].index < wrapper.start || mounts[0].index >= wrapper.end) return null;
  const imports = [r.policy, runtime[0].groups.hook, runtime[0].groups.settings, debug[0].groups.store];
  if (!imports.every(name => findRspackRequireBinding(module, name) != null && !local(owner.body, name, owner.props)) ||
      findRspackRequireBinding(module, mounts[0].groups.jsx) == null) return null;
  return { kind: patched ? "patched" : "current", flagStart, original, replacement };
}

function identifiesModule(source) {
  return source.includes("HomeAmbientSuggestionsContent:") || markerCount(source) > 0;
}
function chunkState(source) {
  try {
    const modules = [...moduleHelpers().rspackModuleFactories(source, "Suggested Prompts content")].filter(module => identifiesModule(module.moduleSource));
    if (modules.length !== 1) return null;
    const module = modules[0], state = moduleState(module);
    if (state == null || markerCount(source) !== markerCount(module.moduleSource)) return null;
    return { ...state, module };
  } catch { return null; }
}
function suggestedPromptsHomeContentContract(source) { return typeof source === "string" ? chunkState(source)?.kind ?? "drifted" : "drifted"; }
function patchModule(module) {
  const state = moduleState(module);
  if (state == null) throw Error("Current Suggested Prompts Home content has invalid source-policy bindings");
  return state.kind === "patched" ? module.moduleSource : module.moduleSource.slice(0, state.flagStart) + state.replacement +
    module.moduleSource.slice(state.flagStart + state.original.length);
}
function applySuggestedPromptsHomeContentPatch(source) {
  const state = chunkState(source);
  if (state == null) {
    console.warn("WARN: Could not find current Suggested Prompts Home generated-source contract - skipping ui-tweaks patch");
    return source;
  }
  if (state.kind === "patched") return source;
  const next = patchModule(state.module);
  const patched = source.slice(0, state.module.start) + next + source.slice(state.module.end);
  if (chunkState(patched)?.kind !== "patched") throw Error("Suggested Prompts Home content post-patch verification failed");
  return patched;
}
function applySuggestedPromptsHomeContentAssets(extractedDir) {
  const { findUniqueRspackModuleCopies, patchRspackModuleCopies } = moduleHelpers();
  const assets = path.join(extractedDir, "webview", "assets");
  const copies = findUniqueRspackModuleCopies(assets, { sourceMatch: identifiesModule, matchModule: identifiesModule,
    description: "Suggested Prompts Home content" });
  if (copies.some(copy => markerCount(copy.source) !== markerCount(copy.moduleSource))) throw Error("Suggested Prompts content marker escaped its module owner");
  return patchRspackModuleCopies(assets, copies, (source, snapshot) => patchModule({ ...snapshot, moduleSource: source, start: 0, end: source.length }));
}

module.exports = { HOME_CONTENT_SOURCE_MARKER, HOME_CONTENT_ASSET_NEEDLES, suggestedPromptsHomeContentContract,
  applySuggestedPromptsHomeContentPatch, applySuggestedPromptsHomeContentAssets };
