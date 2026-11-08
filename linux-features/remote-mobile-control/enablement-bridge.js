"use strict";
const fs = require("node:fs"), path = require("node:path");
const { findUniqueRspackModuleCopies, rspackModuleFactories } = require("../../scripts/patches/lib/rspack-module-assets.js");
const { listWebviewAssetFiles, patchWebviewAssets } = require("../../scripts/patches/lib/assets.js");
const { javascriptSourceParses } = require("../../scripts/patches/lib/javascript-syntax.js");
const { MARKER, inspectBridgeOwner, inspectPairingGate, inspectNativeGateHook, prepareBridgeOwner } = require("./enablement-bridge-owner.js");
const { inspectAppServicesFacade, locateAppServicesCopies } = require("./renderer-remote-connections-owners.js");
function fail(reason) { throw Error(`Remote enablement bridge cohort: ${reason}`); }

function prepareBridgeCohort(cohort) {
  const roles = ["bridge", "facade", "pairing", "hook"];
  for (const role of roles) if (!cohort?.[role]?.length) fail("missing " + role);
  const plans = cohort.bridge.map(prepareBridgeOwner), first = plans[0].proof;
  if (new Set(cohort.bridge.map(copy => copy.moduleId)).size !== 1 ||
      plans.some(plan => plan.state !== plans[0].state ||
        ["compiler", "hook", "pairing", "facade", "logger", "react"].some(role => plan.proof.imports[role].moduleId !== first.imports[role].moduleId) ||
        plan.proof.roles.pairingKey !== first.roles.pairingKey || plan.proof.jsx.moduleId !== first.jsx.moduleId ||
        plan.proof.mobile.moduleId !== first.mobile.moduleId)) fail("mixed bridge identities or contribution states");
  for (const copy of cohort.facade) {
    if (copy.moduleId !== first.imports.facade.moduleId) fail("wrong facade identity");
    inspectAppServicesFacade(copy);
  }
  for (const copy of cohort.pairing) {
    if (copy.moduleId !== first.imports.pairing.moduleId) fail("wrong native pairing gate identity");
    inspectPairingGate(copy, first.roles.pairingKey);
  }
  const statsigSources = new Set();
  for (const copy of cohort.hook) {
    if (copy.moduleId !== first.imports.hook.moduleId) fail("wrong native hook identity");
    const hook = inspectNativeGateHook(copy, "cn");
    if (hook.react.moduleId !== first.imports.react.moduleId) fail("different native React context provider");
    statsigSources.add(hook.statsig.moduleId);
  }
  if (statsigSources.size !== 1) fail("inconsistent native Statsig client source");
  const assets = new Map();
  for (const role of roles) for (const copy of cohort[role]) {
    if (!Number.isInteger(copy.start) || !Number.isInteger(copy.end) || copy.start < 0 || copy.end < copy.start ||
        typeof copy.source !== "string" || copy.source.slice(copy.start, copy.end) !== copy.moduleSource) fail("stale physical source snapshot");
    const known = assets.get(copy.assetName);
    if (known && known.source !== copy.source) fail("inconsistent physical source snapshots");
    if (!known) assets.set(copy.assetName, { assetName: copy.assetName, source: copy.source, changes: [] });
  }
  for (const [index, copy] of cohort.bridge.entries()) assets.get(copy.assetName).changes.push({ start: copy.start, end: copy.end, source: plans[index].patchedSource });
  const edits = [...assets.values()].map(asset => {
    let source = asset.source, end = source.length;
    for (const change of asset.changes.sort((a, b) => b.start - a.start)) {
      if (change.end > end) fail("overlapping bridge owners");
      source = source.slice(0, change.start) + change.source + source.slice(change.end); end = change.start;
    }
    return { assetName: asset.assetName, source: asset.source, patchedSource: source };
  });
  return Object.freeze({ edits: Object.freeze(edits.map(Object.freeze)), alreadyApplied: plans[0].state === "patched",
    moduleIds: Object.freeze(Object.fromEntries(roles.map(role => [role, cohort[role][0].moduleId]))),
    targetCopies: plans.length, dependencyAssets: Object.freeze([...assets.keys()].sort()) });
}
function locateBridgeCohort(assets) {
  const bridge = findUniqueRspackModuleCopies(assets, {
    description: "native live Remote enablement bridge",
    sourceMatch: source => source.includes("[remote-connections/gate-bridge] sync_failed") || source.includes(MARKER),
    matchModule: (_body, copy) => { try { inspectBridgeOwner(copy); return true; } catch { return false; } },
  });
  const first = inspectBridgeOwner(bridge[0]);
  const facade = locateAppServicesCopies(assets, first.imports.facade.moduleId);
  const pairing = findUniqueRspackModuleCopies(assets, {
    description: "native published one-to-one pairing gate",
    sourceMatch: source => source.includes("2055603567"),
    matchModule: (_body, copy) => {
      if (copy.moduleId !== first.imports.pairing.moduleId) return false;
      try { inspectPairingGate(copy, first.roles.pairingKey); return true; } catch { return false; }
    },
  });
  const hook = findUniqueRspackModuleCopies(assets, {
    description: "native gate hook and context publication",
    sourceMatch: source => source.includes(first.imports.hook.moduleId),
    matchModule: (_body, copy) => {
      if (copy.moduleId !== first.imports.hook.moduleId) return false;
      try { inspectNativeGateHook(copy, "cn"); return true; } catch { return false; }
    },
  });
  const plan = prepareBridgeCohort({ bridge, facade, pairing, hook });
  let markers = 0;
  for (const name of listWebviewAssetFiles(assets, /\.js$/u)) markers += fs.readFileSync(path.join(assets, name), "utf8").split(MARKER).length - 1;
  if (markers !== (plan.alreadyApplied ? plan.targetCopies : 0)) fail("orphan bridge contribution");
  return plan;
}
function applyBridgePatch(extractedDir, options = {}) {
  const assets = path.join(extractedDir, "webview/assets"), plan = locateBridgeCohort(assets);
  return { ...patchWebviewAssets(assets, plan.edits, options), matched: true, moduleIds: plan.moduleIds, targetCopies: plan.targetCopies };
}
function prepareBridgeSource(source, context = {}) {
  const copies = context.factorySnapshot ? [context.factorySnapshot] :
    [...rspackModuleFactories(source, "String input")].filter(copy => {
      try { inspectBridgeOwner(copy); return true; } catch { return false; }
    });
  if (!copies.length || new Set(copies.map(copy => copy.moduleId)).size !== 1) fail("missing or ambiguous qualified String owner");
  if (context.factorySnapshot && source !== context.factorySnapshot.moduleSource) fail("stale String snapshot");
  const plans = copies.map(prepareBridgeOwner);
  if (plans.some(plan => plan.state !== plans[0].state)) fail("mixed String owner states");
  let result = source;
  if (context.factorySnapshot) result = plans[0].patchedSource;
  else for (const [index, copy] of copies.map((copy, index) => [index, copy]).sort((a, b) => b[1].start - a[1].start)) result = result.slice(0, copy.start) + plans[index].patchedSource + result.slice(copy.end);
  if (result.split(MARKER).length - 1 !== copies.length || !javascriptSourceParses(result)) fail("orphan or invalid generated String contribution");
  return result;
}
module.exports = { prepareBridgeCohort, locateBridgeCohort, applyBridgePatch, prepareBridgeSource };
