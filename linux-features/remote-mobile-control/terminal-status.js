"use strict";
const fs = require("node:fs"), path = require("node:path");
const { findUniqueRspackModuleCopies, rspackModuleFactories } = require("../../scripts/patches/lib/rspack-module-assets.js");
const { listWebviewAssetFiles, patchWebviewAssets } = require("../../scripts/patches/lib/assets.js");
const { javascriptSourceParses } = require("../../scripts/patches/lib/javascript-syntax.js");
const { INPUT, TERMINAL, prepareTerminalStatusModule, prepareTerminalStatusCohort } = require("./terminal-status-owner.js");
const graph = require("./terminal-status-graph.js");
const TARGET_ROLES = ["terminal", "statusCaller", "pendingInput"];
const PROVIDER_ROLES = ["threadState", "runtimeState", "hostSelector"];
const MARKERS = [INPUT, TERMINAL];
function fail(reason) { throw Error(`Remote terminal status cohort: ${reason}`); }
function canPrepare(copy, role) { try { prepareTerminalStatusModule(copy, role);return true; } catch { return false; } }
function hasNeedle(source, role) {
  return role === "pendingInput" ? source.includes("mcpServerElicitationKind:") && source.includes("userInputAsync") :
    source.includes("hasInProgressOwnedWork:") && source.includes("latestTurnHasSystemError:");
}
function prepareTerminalCohort(cohort) {
  cohort = Object.freeze(Object.fromEntries([...TARGET_ROLES, ...PROVIDER_ROLES].map(role => {
    if (!Array.isArray(cohort?.[role]) || !cohort[role].length) fail("missing physical role " + role);
    return [role, Object.freeze(cohort[role].map(copy => Object.freeze({ ...copy, params: Object.freeze([...copy.params]) })))];
  })));
  const targets = prepareTerminalStatusCohort(cohort), threadId = targets.prepared.terminal[0].proof.threadState.moduleId;
  const providers = graph.inspectTerminalStateProviders(cohort, threadId, targets.prepared.terminal[0].proof);
  const assets = new Map();
  for (const role of [...TARGET_ROLES, ...PROVIDER_ROLES]) for (const copy of cohort[role]) {
    if (!Number.isInteger(copy.start) || !Number.isInteger(copy.end) || copy.start < 0 || copy.end < copy.start ||
        typeof copy.source !== "string" || copy.source.slice(copy.start, copy.end) !== copy.moduleSource) fail("stale physical source snapshot");
    const existing = assets.get(copy.assetName);
    if (existing && existing.source !== copy.source) fail("different physical snapshots for one asset");
    if (!existing) assets.set(copy.assetName, { assetName: copy.assetName, source: copy.source, changes: [] });
  }
  for (const row of targets.rows) assets.get(row.copy.assetName).changes.push({ start: row.copy.start, end: row.copy.end, body: row.patchedSource });
  const edits = [...assets.values()].map(asset => {
    let patchedSource = asset.source, end = asset.source.length;
    for (const change of asset.changes.sort((a, b) => b.start - a.start)) {
      if (change.end > end) fail("overlapping terminal module snapshots");
      patchedSource = patchedSource.slice(0, change.start) + change.body + patchedSource.slice(change.end);end = change.start;
    }
    return Object.freeze({ assetName: asset.assetName, source: asset.source, patchedSource });
  });
  const expectedMarkerCounts = Object.fromEntries(MARKERS.map(marker => [marker, targets.rows.reduce((sum, row) => sum + row.copy.moduleSource.split(marker).length - 1, 0)]));
  return Object.freeze({ edits: Object.freeze(edits), alreadyApplied: targets.state === "patched", providers,
    targetCopies: targets.rows.length, moduleIds: Object.freeze(Object.fromEntries(TARGET_ROLES.map(role => [role, cohort[role][0].moduleId]))),
    expectedMarkerCounts: Object.freeze(expectedMarkerCounts) });
}
function locateProvider(assets, id, description, inspect) {
  return findUniqueRspackModuleCopies(assets, { description, sourceMatch: source => source.includes(id),
    matchModule: (_source, copy) => {
      if (copy.moduleId !== id) return false;
      try { inspect(copy);return true; } catch { return false; }
    } });
}
function locateTerminalCohort(assets) {
  const cohort = {};
  for (const role of TARGET_ROLES) cohort[role] = findUniqueRspackModuleCopies(assets, {
    description: "current native terminal status " + role,
    sourceMatch: source => hasNeedle(source, role),
    matchModule: (source, copy) => hasNeedle(source, role) && canPrepare(copy, role),
  });
  const targets = prepareTerminalStatusCohort(cohort), threadId = targets.prepared.terminal[0].proof.threadState.moduleId;
  cohort.threadState = locateProvider(assets, threadId, "native host/thread state atom facade", graph.inspectThreadState);
  const first = graph.inspectThreadState(cohort.threadState[0]);
  cohort.runtimeState = locateProvider(assets, first.runtimeState.moduleId, "native per-thread runtime/request atoms", graph.inspectRuntimeState);
  cohort.hostSelector = locateProvider(assets, first.hostSelector.moduleId, "native conversation host selector", copy => graph.inspectHostSelector(copy, first.runtimeState.moduleId));
  const plan = prepareTerminalCohort(cohort), actual = Object.fromEntries(MARKERS.map(marker => [marker, 0]));
  for (const name of listWebviewAssetFiles(assets, /\.js$/u)) {
    const source = fs.readFileSync(path.join(assets, name), "utf8");
    for (const marker of MARKERS) actual[marker] += source.split(marker).length - 1;
  }
  if (MARKERS.some(marker => actual[marker] !== plan.expectedMarkerCounts[marker])) fail("orphan terminal contribution marker");
  return plan;
}
function applyTerminalStatus(extractedDir, options = {}) {
  const assets = path.join(extractedDir, "webview/assets"), plan = locateTerminalCohort(assets);
  return { ...patchWebviewAssets(assets, plan.edits, options), matched: true, moduleIds: plan.moduleIds, targetCopies: plan.targetCopies };
}
function prepareTerminalSource(source) {
  const all = [...rspackModuleFactories(source, "String input")], cohort = {};
  for (const role of TARGET_ROLES) {
    const matches = all.filter(copy => hasNeedle(copy.moduleSource, role) && canPrepare(copy, role));
    if (!matches.length || new Set(matches.map(copy => copy.moduleId)).size !== 1) fail("missing or ambiguous String target " + role);
    cohort[role] = all.filter(copy => copy.moduleId === matches[0].moduleId);
  }
  const targets = prepareTerminalStatusCohort(cohort), threadId = targets.prepared.terminal[0].proof.threadState.moduleId;
  cohort.threadState = all.filter(copy => copy.moduleId === threadId);
  if (!cohort.threadState.length) fail("missing native String state provider");
  const p = graph.inspectThreadState(cohort.threadState[0]);
  cohort.runtimeState = all.filter(copy => copy.moduleId === p.runtimeState.moduleId);
  cohort.hostSelector = all.filter(copy => copy.moduleId === p.hostSelector.moduleId);
  const plan = prepareTerminalCohort(cohort);
  for (const marker of MARKERS) if (source.split(marker).length - 1 !== plan.expectedMarkerCounts[marker]) fail("orphan String contribution");
  if (plan.edits.length !== 1 || !javascriptSourceParses(plan.edits[0].patchedSource)) fail("invalid generated String source");
  return plan.edits[0].patchedSource;
}
module.exports = { prepareTerminalCohort, locateTerminalCohort, applyTerminalStatus, prepareTerminalSource };
