"use strict";

const path = require("node:path");
const { inspectModelCatalogOwner } = require("../../scripts/patches/lib/model-composer-owners.js");
const { createJavaScriptLexicalIndex, escapeRegExp } = require("../../scripts/patches/lib/minified-js.js");
const {
  findUniqueRspackModuleCopies,
  patchRspackModuleCopies,
  rspackModuleFactories,
} = require("../../scripts/patches/lib/rspack-module-assets.js");

const ID = "[A-Za-z_$][\\w$]*";
const PATCH_MARKER = "codexLinuxApiKeyModelVisibility";
const ASSET_NEEDLES = ["additionalAvailableModels:", "enabledReasoningEfforts:", "hasConfiguredModelCatalog:", "useHiddenModels:"];
const DESCRIPTION = "API key model visibility catalog";

function identifiesOwner(source) {
  return source.includes(PATCH_MARKER) || ASSET_NEEDLES.every(needle => source.includes(needle));
}

function markerCount(source) {
  return source.split(PATCH_MARKER).length - 1;
}

// Only the prefix through the registry header needs lexical inspection. This
// excludes opaque examples without indexing an entire multi-megabyte asset.
function requireNativeRegistry(source) {
  const headers = [...source.matchAll(/\bexport\s+const\s+__webpack_modules__\s*=\s*\{/gu)];
  if (headers.length !== 1) throw new Error(`Missing or ambiguous ${DESCRIPTION} registry`);
  const [header] = headers;
  const prefix = createJavaScriptLexicalIndex(source.slice(0, header.index + header[0].length));
  if (!prefix.isRoot(header.index)) throw new Error(`Opaque or nested ${DESCRIPTION} registry`);
}

function inspectVisibility(module) {
  const found = inspectModelCatalogOwner(module);
  if (!found.ok) throw new Error(`Unsupported ${DESCRIPTION}: ${found.reason}`);
  // The visibility result must directly control normalization of this loop
  // model, with the actual outer inputs captured rather than shadowed by it.
  const captured = ["additional", "daybreak", "auth", "available", "configured", "custom", "hidden", "ultra", "enabled"];
  const ifOpen = found.visibility.call.end + 1;
  if (captured.some(role => found.inputs[role] === found.loop.model) ||
      found.visibility.owner.start !== found.loop.range.end ||
      module.moduleSource.slice(found.visibility.call.end, found.normalization.sourceRange.start) !== "){let " ||
      createJavaScriptLexicalIndex(module.moduleSource).matchingBrace(ifOpen) !== found.normalization.outputRange.end) {
    throw new Error(`Unsupported ${DESCRIPTION} visibility decision binding`);
  }
  const body = found.visibility.owner.body;
  const native = module.moduleSource.slice(body.start, body.end);
  const { additional, daybreak, auth, available, configured, custom, model, hidden } = found.visibility.inputs;
  const access = new RegExp(`^let (${ID})=${escapeRegExp(model)}\\.availableAccessPrograms\\?\\.cyber;`).exec(native)?.[1];
  if (access == null || Object.values(found.visibility.inputs).includes(access)) {
    throw new Error(`Unsupported ${DESCRIPTION} access-program binding`);
  }
  const gate = `${hidden}&&!${custom}&&"amazonBedrock"!==${auth}`;
  // The callback's local identifier is independent of every captured role.
  const callback = new RegExp(`\\?\\.some\\((${ID})=>"standard"!==\\1\\)===!0`).exec(native)?.[1];
  if (callback == null) throw new Error(`Unsupported ${DESCRIPTION} access-program callback`);
  const expected = `let ${access}=${model}.availableAccessPrograms?.cyber;return("apikey"!==${auth}||!!${daybreak}||null==${access}||!(${access}.length>0)||!!${access}.includes("standard"))&&(${additional}?.has(${model}.model)===!0||"codex-auto-review"!==${model}.model&&(${configured}&&!${model}.hidden||(${gate}?${available}.has(${model}.model)||"apikey"===${auth}&&${daybreak}&&!${model}.hidden&&${access}?.some(${callback}=>"standard"!==${callback})===!0:!${model}.hidden)))`;
  const contribution = `&&"apikey"!==${auth}/*${PATCH_MARKER}*/`;
  const patched = expected.replace(`${gate}?`, `${gate}${contribution}?`);
  const applied = native === patched && markerCount(module.moduleSource) === 1;
  if (!applied && (native !== expected || markerCount(module.moduleSource) !== 0)) {
    throw new Error(`Unsupported or noncanonical ${DESCRIPTION} visibility predicate`);
  }
  return { applied, body, patched };
}

function patchFactory(source, snapshot) {
  const module = { ...snapshot, moduleSource: source };
  const state = inspectVisibility(module);
  if (state.applied) return source;
  const patched = source.slice(0, state.body.start) + state.patched + source.slice(state.body.end);
  if (!inspectVisibility({ ...module, moduleSource: patched }).applied) {
    throw new Error(`Incomplete ${DESCRIPTION} insertion`);
  }
  return patched;
}

function applyApiKeyModelVisibilityPatch(source, context = {}) {
  if (context.factorySnapshot != null) {
    if (context.factorySnapshot.moduleSource !== source) throw new Error("Stale model catalog factory snapshot");
    return patchFactory(source, context.factorySnapshot);
  }
  requireNativeRegistry(source);
  const candidates = [...rspackModuleFactories(source, "model-catalog.js")]
    .filter(module => identifiesOwner(module.moduleSource));
  if (candidates.length !== 1) throw new Error(`Missing or ambiguous ${DESCRIPTION} factory`);
  const [module] = candidates;
  if (markerCount(source) !== markerCount(module.moduleSource)) throw new Error(`Orphan ${DESCRIPTION} marker`);
  return source.slice(0, module.start) + patchFactory(module.moduleSource, module) + source.slice(module.end);
}

function applyApiKeyModelVisibilityAppPatch(extractedDir, _context = {}, options = {}) {
  const assets = path.join(extractedDir, "webview", "assets");
  const markerAssets = new Set();
  const copies = findUniqueRspackModuleCopies(assets, {
    description: DESCRIPTION,
    sourceMatch(source, name) {
      if (source.includes(PATCH_MARKER)) markerAssets.add(name);
      return identifiesOwner(source);
    },
    matchModule: identifiesOwner,
  });
  for (const copy of copies) {
    requireNativeRegistry(copy.source);
    inspectVisibility(copy);
    if (markerCount(copy.source) !== markerCount(copy.moduleSource)) throw new Error(`Orphan ${DESCRIPTION} marker`);
    markerAssets.delete(copy.assetName);
  }
  if (markerAssets.size > 0) throw new Error(`Orphan ${DESCRIPTION} marker in ${[...markerAssets].join(", ")}`);
  return patchRspackModuleCopies(assets, copies, patchFactory, options);
}

const descriptors = [{
  id: "api-key-model-visibility-ui",
  phase: "extracted-app:pre-webview",
  order: 20550,
  ciPolicy: "optional",
  apply: applyApiKeyModelVisibilityAppPatch,
}];

module.exports = {
  ASSET_NEEDLES,
  applyApiKeyModelVisibilityPatch,
  applyApiKeyModelVisibilityAppPatch,
  descriptors,
};
