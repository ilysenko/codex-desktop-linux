"use strict";

const path = require("node:path");
const { Script } = require("node:vm");

// Disabled isolated copies can load the feature without ASAR engine helpers.
function moduleHelpers() { return require("../../../scripts/patches/lib/rspack-module-assets.js"); }
function escapeRegExp(value) { return require("../../../scripts/patches/lib/minified-js.js").escapeRegExp(value); }
function findMatchingBrace(source, index) {
  return require("../../../scripts/patches/lib/minified-js.js").findMatchingBrace(source, index);
}

const ID = "[A-Za-z_$][\\w$]*";
const FEATURE_SYNC_MARKER = "codexLinuxUiTweaksSuggestedPromptsFeatureSync";
const FEATURE_SYNC_ASSET_NEEDLES = Object.freeze(['"2425897452"', "electron-desktop-features-changed"]);
const CALL = `\\(0,(?<gateImport>${ID})\\.(?<gateExport>${ID})\\)\\("2425897452"\\)`;
const CURRENT = new RegExp(`(?<![\\w$.])(?<gate>${ID})=(?<call>${CALL})`, "g");
const PATCHED = new RegExp(
  `(?<![\\w$.])(?<gate>${ID})=\\((?<call>${CALL}),function ${FEATURE_SYNC_MARKER}\\(\\)\\{return!0\\}\\(\\)\\)`, "g");
const DISPATCH = new RegExp(`(?<![\\w$.])(?<bus>${ID})\\.${ID}\\.dispatchMessage\\("electron-desktop-features-changed",\\{`, "g");
const EFFECT = new RegExp(`\\(0,(?<react>${ID})\\.useEffect\\)\\(\\(\\)=>\\{`, "g");

function matches(source, pattern) { return [...source.matchAll(pattern)]; }
function atTopLevel(source, offset) {
  return findMatchingBrace("{" + source.slice(0, offset) + "}", 0) === offset + 1;
}
function references(source, name) {
  return matches(source, new RegExp(`(?<![\\w$.])${escapeRegExp(name)}(?![\\w$])`, "g")).length;
}
function declares(body, name, params = "") {
  // This probe is parsed, never executed. A new lexical declaration conflicts
  // only with a binding in this function scope, not one in a nested function.
  try { new Script(`function probe(${params}){${body}\n;let ${name};}`); return false; }
  catch { return true; }
}

function declarationAt(source, index) {
  if (!atTopLevel(source, index)) return false;
  try { new Script(`function probe(){${source.slice(0, index)}\nconst __codexFeatureSyncDeclaration = 0;}`); return true; }
  catch { return false; }
}

function moduleState(module) {
  const source = module.moduleSource;
  const current = matches(source, CURRENT), patched = matches(source, PATCHED);
  const gate = current.length === 1 && patched.length === 0 ? current[0]
    : current.length === 0 && patched.length === 1 ? patched[0] : null;
  const dispatches = matches(source, DISPATCH);
  if (gate == null || dispatches.length !== 1 ||
      references(source, FEATURE_SYNC_MARKER) !== Number(patched.length === 1)) return null;
  const dispatch = dispatches[0];
  const owners = matches(source, new RegExp(`function (?<name>${ID})\\(\\)\\{`, "g")).map(header => {
    const start = header.index + header[0].length, end = findMatchingBrace(source, start - 1);
    return { name: header.groups.name, header: header.index, start, end, body: source.slice(start, end) };
  }).filter(owner => owner.start <= gate.index && gate.index < owner.end &&
    owner.start <= dispatch.index && dispatch.index < owner.end && declarationAt(source, owner.header));
  if (owners.length !== 1) return null;
  const owner = owners[0];
  try { new Script(`function probe(){${owner.body}\n}`); } catch { return null; }
  if (!declares(source, owner.name) || !atTopLevel(owner.body, gate.index - owner.start)) return null;
  const payloadStart = dispatch.index + dispatch[0].length;
  const consumer = new RegExp(`^ambientSuggestions:(?<gate>${ID})&&"enabled"===(?<status>${ID})\\.status(?=[,}])`)
    .exec(source.slice(payloadStart));
  if (consumer == null || consumer.groups.gate !== gate.groups.gate) return null;
  const status = consumer.groups.status;
  const statusReads = matches(owner.body, new RegExp(
    `(?<![\\w$.])${escapeRegExp(status)}=\\(0,(?<store>${ID})\\.${ID}\\)\\((?<availability>${ID})\\.${ID}\\)`, "g"));
  if (statusReads.length !== 1 || !atTopLevel(owner.body, statusReads[0].index)) return null;
  const effects = matches(owner.body, EFFECT).map(header => {
    const start = header.index + header[0].length, end = findMatchingBrace(owner.body, start - 1);
    return { header, start, end, body: owner.body.slice(start, end) };
  }).filter(effect => effect.start <= dispatch.index - owner.start && dispatch.index - owner.start < effect.end &&
    atTopLevel(owner.body, effect.header.index));
  if (effects.length !== 1) return null;
  const effect = effects[0];
  const beforeDispatch = effect.body.slice(0, dispatch.index - owner.start - effect.start);
  // The native effect uses a logical loading guard followed by the dispatch.
  // A nested callback/loop/declaration could resolve a same-spelled alias from
  // another scope, even while the gate and consumer remain in one component.
  if (!atTopLevel(effect.body, beforeDispatch.length) ||
      /[;{}]|=>|\b(?:function|class|let|const|var|for|while|if|catch|switch)\b/.test(beforeDispatch) ||
      declares(effect.body, gate.groups.gate) || declares(effect.body, status)) return null;
  const dependencies = /^,\[(?<items>[^\[\]{}]*)\]\)/.exec(owner.body.slice(effect.end + 1));
  if (dependencies == null || references(dependencies.groups.items, gate.groups.gate) !== 1 ||
      references(dependencies.groups.items, status) !== 1 ||
      !dependencies.groups.items.split(",").includes(`${status}.status`)) return null;
  // Each native binding occurs only at its initializer, IPC predicate and
  // effect dependency. Extra assignments or shadow bindings must not prove an
  // applied gate just because the same short name still reaches the payload.
  if (!declares(owner.body, gate.groups.gate) || !declares(owner.body, status) ||
      references(owner.body, gate.groups.gate) !== 3 || references(owner.body, status) !== 3) return null;

  const mounts = matches(source, new RegExp(
    `\\(0,(?<jsx>${ID})\\.jsx\\)\\(${escapeRegExp(owner.name)},\\{\\}\\)`, "g"));
  if (mounts.length !== 1 || references(source, owner.name) !== 2) return null;
  const callers = matches(source, new RegExp(`function ${ID}\\((?<params>[^()]*)\\)\\{`, "g")).map(header => {
    const start = header.index + header[0].length, end = findMatchingBrace(source, start - 1);
    return { header, start, end, body: source.slice(start, end) };
  }).filter(caller => caller.start <= mounts[0].index && mounts[0].index < caller.end && declarationAt(source, caller.header.index));
  if (callers.length !== 1 || declares(callers[0].body, mounts[0].groups.jsx, callers[0].header.groups.params)) return null;
  const imports = [gate.groups.gateImport, dispatch.groups.bus, effect.header.groups.react,
    statusReads[0].groups.store, statusReads[0].groups.availability];
  const { findRspackRequireBinding } = moduleHelpers();
  if (!imports.every(name => findRspackRequireBinding(module, name) != null && !declares(owner.body, name)) ||
      findRspackRequireBinding(module, mounts[0].groups.jsx) == null) return null;
  return { kind: patched.length === 1 ? "patched" : "current", gate, owner };
}

function identifiesModule(source) {
  return source.includes('dispatchMessage("electron-desktop-features-changed"') || references(source, FEATURE_SYNC_MARKER) > 0;
}

function chunkState(source) {
  try {
    const { rspackModuleFactories } = moduleHelpers();
    const modules = [...rspackModuleFactories(source, "Suggested Prompts feature sync")].filter(module => identifiesModule(module.moduleSource));
    if (modules.length !== 1) return null;
    const module = modules[0], state = moduleState(module);
    if (state == null || references(source, FEATURE_SYNC_MARKER) !== references(module.moduleSource, FEATURE_SYNC_MARKER)) return null;
    return { ...state, module };
  } catch { return null; }
}

function suggestedPromptsFeatureSyncContract(source) {
  return typeof source === "string" ? chunkState(source)?.kind ?? "drifted" : "drifted";
}

function patchModule(module) {
  const state = moduleState(module);
  if (state == null) throw Error("Current Suggested Prompts feature sync contract has invalid lexical bindings");
  if (state.kind === "patched") return module.moduleSource;
  const { gate } = state;
  return module.moduleSource.slice(0, gate.index) +
    `${gate.groups.gate}=(${gate.groups.call},function ${FEATURE_SYNC_MARKER}(){return!0}())` +
    module.moduleSource.slice(gate.index + gate[0].length);
}

function applySuggestedPromptsFeatureSyncPatch(source) {
  const state = chunkState(source);
  if (state == null) {
    console.warn("WARN: Could not find current Suggested Prompts feature sync contract - skipping ui-tweaks patch");
    return source;
  }
  if (state.kind === "patched") return source;
  const next = patchModule(state.module);
  const patched = source.slice(0, state.module.start) + next + source.slice(state.module.end);
  if (chunkState(patched)?.kind !== "patched") throw Error("Suggested Prompts feature sync post-patch verification failed");
  return patched;
}

function applySuggestedPromptsFeatureSyncAssets(extractedDir) {
  const assets = path.join(extractedDir, "webview", "assets");
  const { findUniqueRspackModuleCopies, patchRspackModuleCopies } = moduleHelpers();
  const copies = findUniqueRspackModuleCopies(assets, {
    sourceMatch: identifiesModule, matchModule: identifiesModule,
    description: "Suggested Prompts feature sync",
  });
  if (copies.some(copy => references(copy.source, FEATURE_SYNC_MARKER) !== references(copy.moduleSource, FEATURE_SYNC_MARKER))) {
    throw Error("Suggested Prompts feature sync marker escaped its module owner");
  }
  return patchRspackModuleCopies(assets, copies, (source, snapshot) =>
    patchModule({ ...snapshot, moduleSource: source, start: 0, end: source.length }));
}

module.exports = {
  FEATURE_SYNC_MARKER, FEATURE_SYNC_ASSET_NEEDLES, suggestedPromptsFeatureSyncContract,
  applySuggestedPromptsFeatureSyncPatch, applySuggestedPromptsFeatureSyncAssets,
};
