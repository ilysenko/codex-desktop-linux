"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { findUniqueRspackModuleCopies, rspackModuleFactories } = require("../../scripts/patches/lib/rspack-module-assets.js");
const { findRspackExportPublication } = require("../../scripts/patches/lib/rspack-export-publication.js");
const { listWebviewAssetFiles, patchWebviewAssets } = require("../../scripts/patches/lib/assets.js");
const { javascriptSourceParses } = require("../../scripts/patches/lib/javascript-syntax.js");
const { MARKER, inspectHostToggle, prepareHostToggle } = require("./host-toggle-owner.js");
const graph = require("./host-toggle-graph.js");
function fail(reason) { throw Error(`Remote per-host enable/disable cohort: ${reason}`); }

function waitAndOverride(copy, caller) {
  const wait = findRspackExportPublication(copy, caller.waitExport);
  const override = findRspackExportPublication(copy, caller.overrideExport);
  if (!wait?.fn || !override?.fn ||
      !wait.fn.body.includes("Timed out waiting for remote control to connect") ||
      !wait.fn.body.includes(".watch(") || !wait.fn.params.includes("ignoreCurrentError:")) fail("native wait publication");
  const names = override.fn.params.split(",");
  if (names.length !== 3 || new Set(names).size !== 3 ||
      override.fn.body !== `${names[0]}.set(${graph.inspectHostStatusPublication(copy, caller.atomExport, caller.writeExport).overrideAtom},${names[1]},${names[2]})`) {
    fail("native wait override publication");
  }
}

function prepareHostToggleCohort(cohort) {
  if (!cohort?.toggles?.length || !cohort.clients?.length || !cohort.status?.length || !cohort.callers?.length) fail("missing target/provider/caller cohort");
  const plans = cohort.toggles.map(copy => prepareHostToggle(copy.moduleSource, copy));
  const first = plans[0].proof;
  if (new Set(cohort.toggles.map(copy => copy.moduleId)).size !== 1 ||
      plans.some(plan => plan.state !== plans[0].state ||
        plan.proof.client.moduleId !== first.client.moduleId || plan.proof.client.exportName !== first.client.exportName ||
        plan.proof.status.moduleId !== first.status.moduleId || plan.proof.status.atomExport !== first.status.atomExport ||
        plan.proof.status.writeExport !== first.status.writeExport ||
        plan.proof.publication.exportName !== first.publication.exportName)) fail("mixed target identities or canonical states");
  for (const copy of cohort.clients) {
    if (copy.moduleId !== first.client.moduleId) fail("wrong selected-client identity");
    graph.inspectSelectedHostClient(copy, first.client.exportName);
  }
  for (const copy of cohort.status) {
    if (copy.moduleId !== first.status.moduleId) fail("wrong status identity");
    graph.inspectHostStatusPublication(copy, first.status.atomExport, first.status.writeExport);
  }
  const targetId = cohort.toggles[0].moduleId;
  for (const copy of cohort.callers) {
    const proof = graph.inspectHostToggleCaller(copy, targetId, first.publication.exportName, first.status.moduleId);
    for (const status of cohort.status) waitAndOverride(status, { ...proof,
      atomExport: first.status.atomExport, writeExport: first.status.writeExport });
  }
  const assets = new Map();
  for (const role of ["toggles", "clients", "status", "callers"]) for (const copy of cohort[role]) {
    if (!Number.isInteger(copy.start) || !Number.isInteger(copy.end) || copy.start < 0 ||
        copy.end < copy.start || typeof copy.source !== "string" ||
        copy.source.slice(copy.start, copy.end) !== copy.moduleSource) fail("invalid physical source snapshot");
    const known = assets.get(copy.assetName);
    if (known && known.source !== copy.source) fail("different physical source snapshots");
    if (!known) assets.set(copy.assetName, { assetName: copy.assetName, source: copy.source, changes: [] });
  }
  for (const [index, copy] of cohort.toggles.entries()) {
    assets.get(copy.assetName).changes.push({ start: copy.start, end: copy.end, body: plans[index].patchedSource });
  }
  const edits = [...assets.values()].map(asset => {
    let patchedSource = asset.source, end = asset.source.length;
    for (const change of asset.changes.sort((a, b) => b.start - a.start)) {
      if (change.end > end) fail("overlapping toggle source ranges");
      patchedSource = patchedSource.slice(0, change.start) + change.body + patchedSource.slice(change.end);
      end = change.start;
    }
    return { assetName: asset.assetName, source: asset.source, patchedSource };
  });
  return Object.freeze({ edits: Object.freeze(edits.map(Object.freeze)),
    alreadyApplied: plans[0].state === "patched", targetId,
    clientId: first.client.moduleId, statusId: first.status.moduleId,
    targetCopies: plans.length, dependencyAssets: Object.freeze([...assets.keys()].sort()) });
}

function locateHostToggleCohort(assets) {
  const toggles = findUniqueRspackModuleCopies(assets, {
    description: "current per-host Remote enable/disable adapter",
    sourceMatch: source => source.includes("remoteControl/enable") && source.includes("remoteControl/disable") || source.includes(MARKER),
    matchModule: (_body, copy) => inspectHostToggle(copy).ok,
  });
  const plans = toggles.map(copy => prepareHostToggle(copy.moduleSource, copy));
  const proof = plans[0].proof, targetId = toggles[0].moduleId;
  const clients = findUniqueRspackModuleCopies(assets, {
    description: "native selected-host RPC client getter",
    sourceMatch: source => source.includes("AppServerManager RPC is unavailable for hostId:"),
    matchModule: (_body, copy) => {
      if (copy.moduleId !== proof.client.moduleId) return false;
      try { graph.inspectSelectedHostClient(copy, proof.client.exportName); return true; } catch { return false; }
    },
  });
  const status = findUniqueRspackModuleCopies(assets, {
    description: "native per-host Remote status atom and mapper",
    sourceMatch: source => source.includes("Failed to read remote-control status"),
    matchModule: (_body, copy) => {
      if (copy.moduleId !== proof.status.moduleId) return false;
      try { graph.inspectHostStatusPublication(copy, proof.status.atomExport, proof.status.writeExport); return true; } catch { return false; }
    },
  });
  const callers = findUniqueRspackModuleCopies(assets, {
    description: "native enable/wait public caller",
    sourceMatch: source => source.includes("remoteControlEnvironments") && source.includes("ignoreCurrentError"),
    matchModule: (_body, copy) => {
      try { graph.inspectHostToggleCaller(copy, targetId, proof.publication.exportName, proof.status.moduleId); return true; } catch { return false; }
    },
  });
  const prepared = prepareHostToggleCohort({ toggles, clients, status, callers });
  let markers = 0;
  for (const asset of listWebviewAssetFiles(assets, /\.js$/u)) markers += fs.readFileSync(path.join(assets, asset), "utf8").split(MARKER).length - 1;
  if (markers !== (prepared.alreadyApplied ? prepared.targetCopies : 0)) fail("orphan parameter contribution");
  return prepared;
}

function applyHostTogglePatch(extractedDir, options = {}) {
  const assets = path.join(extractedDir, "webview/assets"), plan = locateHostToggleCohort(assets);
  return { ...patchWebviewAssets(assets, plan.edits, options), matched: true,
    moduleId: plan.targetId, targetCopies: plan.targetCopies };
}

function applyHostToggleSource(source, context = {}) {
  if (context.factorySnapshot) return prepareHostToggle(source, context.factorySnapshot).patchedSource;
  const copies = [...rspackModuleFactories(source, "String input")].filter(copy => inspectHostToggle(copy).ok);
  if (!copies.length || new Set(copies.map(copy => copy.moduleId)).size !== 1) fail("missing or ambiguous owned String input");
  const plans = copies.map(copy => prepareHostToggle(copy.moduleSource, copy));
  if (plans.some(plan => plan.state !== plans[0].state)) fail("mixed owned String states");
  let result = source;
  for (const [index, copy] of copies.map((copy, index) => [index, copy]).sort((a, b) => b[1].start - a[1].start)) {
    result = result.slice(0, copy.start) + plans[index].patchedSource + result.slice(copy.end);
  }
  if (result.split(MARKER).length - 1 !== copies.length) fail("orphan owned String parameter marker");
  if (!javascriptSourceParses(result)) fail("invalid generated String input");
  return result;
}

module.exports = { prepareHostToggleCohort, locateHostToggleCohort, applyHostTogglePatch, applyHostToggleSource };
