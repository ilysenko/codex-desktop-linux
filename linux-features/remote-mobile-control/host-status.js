"use strict";
const fs = require("node:fs"), path = require("node:path");
const { findUniqueRspackModuleCopies, rspackModuleFactories } = require("../../scripts/patches/lib/rspack-module-assets.js");
const { listWebviewAssetFiles, patchWebviewAssets } = require("../../scripts/patches/lib/assets.js");
const { javascriptSourceParses } = require("../../scripts/patches/lib/javascript-syntax.js");
const owner = require("./host-status-owner.js"), graph = require("./host-status-graph.js");
const { inspectAppServicesFacade, locateAppServicesCopies } = require("./renderer-remote-connections-owners.js");
function fail(reason) { throw Error(`Remote status-read cohort: ${reason}`); }
function same(rows, key, reason) { if (new Set(rows.map(key)).size !== 1) fail(reason); }
function captured(copy) {
  if (!copy || !Array.isArray(copy.params) || typeof copy.source !== "string" ||
      !Number.isInteger(copy.start) || !Number.isInteger(copy.end) || copy.start < 0 || copy.end < copy.start ||
      copy.source.slice(copy.start, copy.end) !== copy.moduleSource || typeof copy.assetName !== "string") fail("invalid physical source snapshot");
  return Object.freeze({ ...copy, params: Object.freeze([...copy.params]) });
}
function member(proof, name) {
  const imported = proof.imports.find(row => row.localName === name);
  if (!imported) fail("missing native status provider " + name);
  return imported;
}
function prepareStatusReadCohort(input) {
  const roles = ["owner", "classifier", "classifierFacade", "durable", "awaiter", "manager", "subscriber", "serviceFacade"], cohort = {};
  for (const role of roles) {
    if (!input?.[role]?.length) fail("missing " + role);
    cohort[role] = Object.freeze(input[role].map(captured));
    same(cohort[role], copy => copy.moduleId, "ambiguous " + role + " identity");
  }
  if (new Set(roles.map(role => cohort[role][0].moduleId)).size !== roles.length) fail("native role identity collision");
  const plans = cohort.owner.map(owner.prepareStatusReadSource), first = plans[0].proof;
  same(plans, row => row.state, "mixed read contributions");same(plans, row => row.proof.waitPeer, "mixed canonical wait peers");
  same(plans, row => JSON.stringify(row.proof.imports.map(x => x.moduleId)), "inconsistent status module provider identities");
  for (const plan of plans) if (plan.proof.read.roles.classifierKey !== first.read.roles.classifierKey || plan.proof.read.roles.awaiterKey !== first.read.roles.awaiterKey) fail("inconsistent native reader publications");
  const classifierId = member(first, first.read.roles.classifier).moduleId, awaiterId = member(first, first.read.roles.awaiter).moduleId;
  if (cohort.classifier[0].moduleId !== classifierId || cohort.awaiter[0].moduleId !== awaiterId) fail("wrong classifier or awaiter identity");
  const classifiers = cohort.classifier.map(copy => graph.inspectClassifierBridge(copy, first.read.roles.classifierKey));
  same(classifiers, row => row.facade.moduleId + ":" + row.exportName, "different classifier bridge targets");
  if (cohort.classifierFacade[0].moduleId !== classifiers[0].facade.moduleId) fail("wrong classifier facade");
  const facades = cohort.classifierFacade.map(copy => graph.inspectClassifierFacade(copy, classifiers[0].exportName));
  same(facades, row => row.literalModule.moduleId + ":" + row.exportName, "different native durable providers");
  if (cohort.durable[0].moduleId !== facades[0].literalModule.moduleId) fail("wrong native durable identity");
  for (const copy of cohort.durable) graph.inspectDurableLiteral(copy, facades[0].exportName);
  for (const copy of cohort.awaiter) graph.inspectNativeAwaiter(copy, first.read.roles.awaiterKey);
  const managers = cohort.manager.map(graph.inspectNativeManager);
  same(managers, row => JSON.stringify(row.imports.map(x => x.moduleId)), "different manager lifecycle providers");
  if (managers[0].classifierFacade.moduleId !== cohort.classifierFacade[0].moduleId || managers[0].subscriber.moduleId !== cohort.subscriber[0].moduleId || managers[0].facade.moduleId !== cohort.serviceFacade[0].moduleId) fail("foreign per-host lifecycle graph");
  const subscribers = cohort.subscriber.map(copy => graph.inspectReadLifecycle(copy, cohort.owner[0].moduleId));
  same(subscribers, row => JSON.stringify(Object.entries(row.prefixProviders).map(([key, value]) => [key, value.moduleId])), "different subscriber prefix providers");
  for (const row of subscribers) if (row.prefixProviders.v.moduleId !== member(first, first.read.roles.logger).moduleId) fail("different native error logger");
  for (const copy of cohort.serviceFacade) inspectAppServicesFacade(copy);
  const assets = new Map();
  for (const role of roles) for (const copy of cohort[role]) {
    const known = assets.get(copy.assetName);
    if (known && known.source !== copy.source) fail("inconsistent asset snapshots");
    if (!known) assets.set(copy.assetName, { assetName: copy.assetName, source: copy.source, changes: [] });
  }
  for (const [index, copy] of cohort.owner.entries()) assets.get(copy.assetName).changes.push({ start: copy.start, end: copy.end, text: plans[index].patchedSource });
  const edits = [...assets.values()].map(asset => {
    let text = asset.source, end = text.length;
    for (const change of asset.changes.sort((a, b) => b.start - a.start)) {
      if (change.end > end) fail("overlapping status owners");
      text = text.slice(0, change.start) + change.text + text.slice(change.end);end = change.start;
    }
    return Object.freeze({ assetName: asset.assetName, source: asset.source, patchedSource: text });
  });
  return Object.freeze({ edits: Object.freeze(edits), alreadyApplied: plans[0].state === "patched", waitPeer: first.waitPeer,
    targetCopies: plans.length, moduleIds: Object.freeze(Object.fromEntries(roles.map(role => [role, cohort[role][0].moduleId]))),
    dependencyAssets: Object.freeze([...assets.keys()].sort()) });
}
function known(assets, id, description, inspect) {
  return findUniqueRspackModuleCopies(assets, {
    description, sourceMatch: source => source.includes(id),
    matchModule: (_body, copy) => { if (copy.moduleId !== id) return false;try { inspect(copy);return true; } catch { return false; } },
  });
}
function locateStatusReadCohort(assets) {
  const owners = findUniqueRspackModuleCopies(assets, {
    description: "complete native per-host status reader",
    sourceMatch: source => source.includes("Failed to read remote-control status") || source.includes(owner.READ_MARKER),
    matchModule: (_body, copy) => {
      if (Buffer.byteLength(copy.moduleSource) > 16 * 1024) return false;
      try { owner.inspectHostStatusOwner(copy);return true; } catch { return false; }
    },
  });
  const first = owner.inspectHostStatusOwner(owners[0]);
  const classifierId = member(first, first.read.roles.classifier).moduleId, awaiterId = member(first, first.read.roles.awaiter).moduleId;
  const classifier = known(assets, classifierId, "native status early-skip bridge", copy => graph.inspectClassifierBridge(copy, first.read.roles.classifierKey));
  const bridge = graph.inspectClassifierBridge(classifier[0], first.read.roles.classifierKey);
  const classifierFacade = known(assets, bridge.facade.moduleId, "native early-skip facade", copy => graph.inspectClassifierFacade(copy, bridge.exportName));
  const facade = graph.inspectClassifierFacade(classifierFacade[0], bridge.exportName);
  const durable = known(assets, facade.literalModule.moduleId, "native durable host literal", copy => graph.inspectDurableLiteral(copy, facade.exportName));
  const awaiter = known(assets, awaiterId, "native abortable read awaiter", copy => graph.inspectNativeAwaiter(copy, first.read.roles.awaiterKey));
  const manager = findUniqueRspackModuleCopies(assets, {
    description: "native per-host app-server manager lifecycle",
    sourceMatch: source => source.includes("Desktop host did not provide its AppServerManager service"),
    matchModule: (_body, copy) => {
      if (Buffer.byteLength(copy.moduleSource) > 16 * 1024) return false;
      try { graph.inspectNativeManager(copy);return true; } catch { return false; }
    },
  });
  const managerProof = graph.inspectNativeManager(manager[0]);
  const subscriber = known(assets, managerProof.subscriber.moduleId, "published native status subscriber lifecycle", copy => graph.inspectReadLifecycle(copy, owners[0].moduleId));
  const serviceFacade = locateAppServicesCopies(assets, managerProof.facade.moduleId);
  const plan = prepareStatusReadCohort({ owner: owners, classifier, classifierFacade, durable, awaiter, manager, subscriber, serviceFacade });
  let readMarkers = 0, waitMarkers = 0;
  for (const file of listWebviewAssetFiles(assets, /\.js$/u)) {
    const source = fs.readFileSync(path.join(assets, file), "utf8");
    readMarkers += source.split(owner.READ_MARKER).length - 1;waitMarkers += source.split(owner.WAIT_MARKER).length - 1;
  }
  if (readMarkers !== (plan.alreadyApplied ? 2 * plan.targetCopies : 0) || waitMarkers !== (plan.waitPeer ? plan.targetCopies : 0)) fail("orphan read/wait contribution");
  return plan;
}
function applyStatusReadPatch(extractedDir, options = {}) {
  const assets = path.join(extractedDir, "webview/assets"), plan = locateStatusReadCohort(assets);
  return { ...patchWebviewAssets(assets, plan.edits, options), matched: true, moduleIds: plan.moduleIds, targetCopies: plan.targetCopies };
}
function prepareStatusReadString(source, context = {}) {
  if (context.factorySnapshot) {
    if (source !== context.factorySnapshot.moduleSource) fail("stale String snapshot");
    return owner.prepareStatusReadSource(context.factorySnapshot).patchedSource;
  }
  const copies = [...rspackModuleFactories(source, "String input")].filter(copy => { try { owner.inspectHostStatusOwner(copy);return true; } catch { return false; } });
  if (!copies.length) fail("missing qualified native String owner");same(copies, row => row.moduleId, "ambiguous String owner");
  const plans = copies.map(owner.prepareStatusReadSource);same(plans, row => row.state, "mixed String owner states");same(plans, row => row.proof.waitPeer, "mixed String wait peer");
  let result = source;
  for (const [index, copy] of copies.map((copy, index) => [index, copy]).sort((a, b) => b[1].start - a[1].start)) result = result.slice(0, copy.start) + plans[index].patchedSource + result.slice(copy.end);
  if (result.split(owner.READ_MARKER).length - 1 !== 2 * copies.length || !javascriptSourceParses(result)) fail("orphan or invalid String contribution");
  return result;
}
module.exports = { prepareStatusReadCohort, locateStatusReadCohort, applyStatusReadPatch, prepareStatusReadString };
