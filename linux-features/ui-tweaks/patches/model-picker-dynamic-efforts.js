"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { findRspackExportPublication } = require("../../../scripts/patches/lib/rspack-export-publication.js");
const { findRspackRequireBinding, findUniqueRspackModuleCopies, rspackModuleFactories } = require("../../../scripts/patches/lib/rspack-module-assets.js");
const { createJavaScriptLexicalIndex, escapeRegExp: q } = require("../../../scripts/patches/lib/minified-js.js");
const { assertUnambiguousModelComposerLexicalSource } = require("../../../scripts/patches/lib/model-composer-lexical-guard.js");
const { hasStableEagerMainBinding } = require("../../../scripts/patches/lib/main-request-sites.js");
const { javascriptSourceParses } = require("../../../scripts/patches/lib/javascript-syntax.js");
const { listWebviewAssetFiles, patchWebviewAssets } = require("../../../scripts/patches/lib/assets.js");
const contribution = require("../../../scripts/patches/lib/model-power-effort-contribution.js");
const { inspectDefaultView } = require("./model-picker-default-view.js");

const ID = "[A-Za-z_$][\\w$]*";
const RESOLVER_HASHES = new Set([
  "81c85ec914babd28a7202182e5366942116038404345b8a3b0c517b0fd8c4b7e",
  // The configured-presets feature changes only its flagged group threshold.
  "ffac50933e364cd868973b1df4fc9d42aac67b7587500a7963d5f72b995fb6f1",
]);

function one(values, label) {
  if (values.length !== 1) throw new Error(`Current dynamic Power efforts: ${label}`);
  return values[0];
}

function matches(source, expression, root = false) {
  const lexical = createJavaScriptLexicalIndex(source);
  return [...source.matchAll(expression)].filter(match => root ? lexical.isRoot(match.index) : lexical.isCode(match.index));
}

function snapshot(copy, limit) {
  if (typeof copy?.moduleSource !== "string" || typeof copy.source !== "string" ||
      copy.source.slice(copy.start, copy.end) !== copy.moduleSource || Buffer.byteLength(copy.moduleSource) > limit) {
    throw new Error("Current dynamic Power efforts: invalid factory snapshot");
  }
  assertUnambiguousModelComposerLexicalSource(copy.moduleSource, createJavaScriptLexicalIndex(copy.moduleSource));
}

function withModuleSource(copy, moduleSource) {
  return { ...copy, moduleSource, end: copy.start + moduleSource.length,
    source: copy.source.slice(0, copy.start) + moduleSource + copy.source.slice(copy.end) };
}

function requireProvider(copy, name, expected) {
  const binding = findRspackRequireBinding(copy, name);
  if (!binding || binding.moduleId !== expected || copy.params.includes(name)) {
    throw new Error(`Current dynamic Power efforts: wrong ${expected} provider`);
  }
  const at = binding.start - copy.start;
  let probe = "__nativePowerProvider";
  while (copy.moduleSource.includes(probe)) probe += "$";
  const projected = copy.moduleSource.slice(0, at) + probe + copy.moduleSource.slice(at + name.length);
  if (!hasStableEagerMainBinding(projected, name)) throw new Error("Current dynamic Power efforts: replaced provider");
}

function stableInitializer(body, name, at) {
  let probe = "__nativePowerInitializer";
  while (body.includes(probe)) probe += "$";
  if (!hasStableEagerMainBinding(body.slice(0, at) + probe + body.slice(at + name.length), name)) {
    throw new Error("Current dynamic Power efforts: replaced native input");
  }
}

function requireRootReference(props, name, reference) {
  const lexical = createJavaScriptLexicalIndex(props);
  const properties = [...props.matchAll(new RegExp(`(?<![\\w$.])(?:${q(name)}|"${q(name)}"|'${q(name)}')\\s*:`, "gu"))]
    .filter(match => lexical.isRoot(match.index + match[0].length - 1));
  const property = one(properties, `missing or ambiguous native ${name} input`);
  const overlays = [...props.matchAll(/\.\.\.|\[/gu)]
    .filter(match => {
      if (!lexical.isRoot(match.index)) return false;
      if (match[0] === "...") return true;
      let previous = match.index - 1;
      while (previous >= 0 && (!lexical.isCode(previous) || /\s/u.test(props[previous]))) {
        previous--;
      }
      return previous < 0 || props[previous] === ",";
    });
  if (overlays.length || !new RegExp(`^${q(reference)}(?=,|$)`, "u")
    .test(props.slice(property.index + property[0].length))) {
    throw new Error(`Current dynamic Power efforts: disconnected native ${name} input`);
  }
}

function requireRenderedPowerSelections(copy, body, call, returnedMenuProps) {
  const lexical = createJavaScriptLexicalIndex(body);
  stableInitializer(body, call[1], call.index);
  const effective = one(matches(body, new RegExp(`(?<![\\w$.])(${ID})=${q(call[1])};`, "gu"), true),
    "resolver output does not reach the native selection branches")[1];
  if (matches(body, new RegExp(`(?<![\\w$.])${q(effective)}=(?!=|>)`, "gu")).length !== 4) {
    throw new Error("Current dynamic Power efforts: replaced native selection branches");
  }
  const power = one(matches(body, new RegExp(`(${ID})=\\(0,(${ID})\\.q\\)\\(\\{canRenderPowerPickerSurface:`, "gu"), true),
    "missing native Power selection hook");
  stableInitializer(body, power[1], power.index);
  const open = body.indexOf("{", power.index);
  const props = body.slice(open + 1, lexical.matchingBrace(open));
  requireRootReference(props, "powerSelectionsWithXHigh", effective);
  requireProvider(copy, power[2], "unb4");
  requireRootReference(returnedMenuProps, "powerSelections", power[1]);
}

function inspectDynamicResolver(copy) {
  snapshot(copy, 16 * 1024);
  if (copy.moduleId !== "TWUU") throw new Error("Current dynamic Power efforts: wrong resolver identity");
  const publication = findRspackExportPublication(copy, "Qv");
  if (!publication?.fn) throw new Error("Current dynamic Power efforts: missing resolver publication");
  const actual = copy.moduleSource.slice(publication.fn.start, publication.fn.end);
  const projection = contribution.projectPowerEffortFunction(actual);
  const nativeSource = copy.moduleSource.slice(0, publication.fn.start) + projection.nativeFunction + copy.moduleSource.slice(publication.fn.end);
  const nativeCopy = withModuleSource(copy, nativeSource);
  const normalized = findRspackExportPublication(nativeCopy, "CT");
  if (!normalized?.expression || !new RegExp(`^${ID}$`, "u").test(normalized.expression)) {
    throw new Error("Current dynamic Power efforts: missing native capability mapper");
  }
  const head = new RegExp(`^function\\((?<models>${ID}),\\{removeXHigh:(?<remove>${ID})=!1,sliderModelsConfig:(?<config>${ID}),stripGptPrefix:(?<strip>${ID})=!0\\}=\\{\\}\\)\\{`, "u").exec(projection.nativeFunction);
  const intersection = one([...new Set(matches(projection.nativeFunction,
    new RegExp(`(${ID})\\((${ID})\\.filter\\(\\(\\{reasoningEffort:${ID}\\}\\)=>`, "gu")).map(match => match[1]))],
  "missing native supported-pair intersection");
  if (!head || !nativeSource.includes("supportedReasoningEfforts") || !nativeSource.includes('"persistent"!==')) {
    throw new Error("Current dynamic Power efforts: missing native capability contract");
  }
  const roles = { ...head.groups, normalizer: normalized.expression, intersection };
  contribution.requirePowerEffortRoles(projection, roles);
  const digest = crypto.createHash("sha256").update(nativeSource).digest("hex");
  if (!RESOLVER_HASHES.has(digest)) throw new Error("Current dynamic Power efforts: changed current resolver ABI");
  const generated = contribution.applyPowerEffortFunction(projection.nativeFunction, roles);
  const patchedSource = nativeSource.slice(0, publication.fn.start) + generated + nativeSource.slice(publication.fn.start + projection.nativeFunction.length);
  if (projection.applied && patchedSource !== copy.moduleSource) throw new Error("Current dynamic Power efforts: noncanonical resolver replay");
  return { kind: "resolver", state: projection.applied ? "patched" : "native", nativeSource, patchedSource,
    moduleId: copy.moduleId, roles, nativeSha256: digest };
}

function inspectEffortConsumer(copy) {
  snapshot(copy, 256 * 1024);
  const projection = contribution.projectPowerEffortOption(copy.moduleSource);
  const nativeSource = projection.nativeSource;
  const nativeCopy = withModuleSource(copy, nativeSource);
  // This existing owner inspection proves the published mounted Work menu and
  // its returned native renderer. It preserves the default-view contribution.
  const view = inspectDefaultView(nativeCopy, "work");
  const publication = findRspackExportPublication(nativeCopy, "M");
  if (!publication?.fn) throw new Error("Current dynamic Power efforts: missing Work consumer publication");
  const body = publication.fn.body;
  const call = one(matches(body, new RegExp(`(${ID})=\\(0,(${ID})\\.Qv\\)\\((${ID}),\\{sliderModelsConfig:([^;]{1,600}?),stripGptPrefix:!(${ID})\\}\\)`, "gu"), true),
    "missing native Work Power resolver call");
  requireProvider(nativeCopy, call[2], "TWUU");
  requireRenderedPowerSelections(nativeCopy, body, call, view.returnedMenuProps);
  const input = contribution.inspectEnabledPowerEffortInput(body, { namespace: call[2], models: call[3], strip: call[5] });
  const enabled = input.enabled;
  requireProvider(nativeCopy, input.reader, "zTeN");
  requireProvider(nativeCopy, input.atom, "Q3tq");
  stableInitializer(body, enabled, input.initializer);
  if (projection.applied && projection.enabled !== enabled) throw new Error("Current dynamic Power efforts: disconnected enabled-effort option");
  const option = contribution.powerEffortOption(enabled);
  // fn.body is authoritative. Derive its absolute start from the publication
  // end, since the function's parameter object also contains an opening brace.
  const bodyStart = publication.fn.end - 1 - body.length;
  const at = bodyStart + call.index + call[0].length - 2;
  if (nativeSource[at] !== "}") throw new Error("Current dynamic Power efforts: wrong consumer option boundary");
  const patchedSource = nativeSource.slice(0, at) + option + nativeSource.slice(at);
  if (projection.applied && patchedSource !== copy.moduleSource) throw new Error("Current dynamic Power efforts: noncanonical consumer replay");
  return { kind: "consumer", state: projection.applied ? "patched" : "native", nativeSource, patchedSource,
    moduleId: copy.moduleId, enabledEfforts: enabled, resolverModuleId: "TWUU", resolverExport: "Qv" };
}

function prepareCopies(copies) {
  const plans = copies.map(copy => copy.moduleId === "TWUU" ? inspectDynamicResolver(copy) : inspectEffortConsumer(copy));
  if (new Set(plans.map(plan => plan.state)).size !== 1) throw new Error("Current dynamic Power efforts: mixed contribution states");
  const assets = new Map(copies.map(copy => [copy.assetName, copy.source]));
  if ([...assets.values()].reduce((bytes, source) => bytes + Buffer.byteLength(source), 0) > 16 * 1024 * 1024) {
    throw new Error("Current dynamic Power efforts: selected source budget exceeded");
  }
  return [...assets].map(([assetName, source]) => {
    let patchedSource = source;
    const members = copies.map((copy, index) => ({ copy, plan: plans[index] }))
      .filter(member => member.copy.assetName === assetName).sort((left, right) => right.copy.start - left.copy.start);
    for (const { copy, plan } of members) patchedSource = patchedSource.slice(0, copy.start) + plan.patchedSource + patchedSource.slice(copy.end);
    if (!javascriptSourceParses(patchedSource)) throw new Error("Current dynamic Power efforts: invalid generated asset");
    return { assetName, source, patchedSource };
  });
}

function requireMarkerCohort(sources, copies) {
  const markers = [contribution.MARKER, contribution.CONSUMER_MARKER];
  const totals = [0, 0];
  for (const source of sources) {
    for (const [index, marker] of markers.entries()) totals[index] += source.split(marker).length - 1;
  }
  for (const [index, marker] of markers.entries()) {
    const expected = copies.reduce((count, copy) => count + copy.moduleSource.split(marker).length - 1, 0);
    if (totals[index] !== expected) throw new Error("Current dynamic Power efforts: orphan contribution marker");
  }
}

function applyDynamicEfforts(extractedDir, options = {}) {
  const assets = path.join(extractedDir, "webview/assets");
  const copies = [
    ...findUniqueRspackModuleCopies(assets, { description: "current dynamic Power resolver",
      sourceMatch: source => source.includes("sliderModelsConfig:"),
      matchModule: (_source, copy) => { try { inspectDynamicResolver(copy); return true; } catch { return false; } } }),
    ...findUniqueRspackModuleCopies(assets, { description: "current Work enabled-effort consumer",
      sourceMatch: source => source.includes("setModelAndReasoningEffort") && source.includes("showModelList"),
      matchModule: (_source, copy) => { try { inspectEffortConsumer(copy); return true; } catch { return false; } } }),
  ];
  requireMarkerCohort((function* () {
    for (const name of listWebviewAssetFiles(assets, /\.js$/u)) yield fs.readFileSync(path.join(assets, name), "utf8");
  })(), copies);
  return { ...patchWebviewAssets(assets, prepareCopies(copies), options), matched: copies.length };
}

function prepareDynamicEffortSource(source) {
  if (typeof source !== "string" || Buffer.byteLength(source) > 16 * 1024 * 1024) throw new Error("Current dynamic Power efforts: source budget exceeded");
  const copies = [...rspackModuleFactories(source, "source.js")].filter(copy => copy.moduleId === "TWUU" || copy.moduleId === "cyhU");
  if (copies.filter(copy => copy.moduleId === "TWUU").length !== 1 || copies.filter(copy => copy.moduleId === "cyhU").length !== 1) {
    throw new Error("Current dynamic Power efforts: incomplete or ambiguous native cohort");
  }
  requireMarkerCohort([source], copies);
  return prepareCopies(copies)[0].patchedSource;
}

module.exports = { inspectDynamicResolver, inspectEffortConsumer, prepareDynamicEffortSource, applyDynamicEfforts };
