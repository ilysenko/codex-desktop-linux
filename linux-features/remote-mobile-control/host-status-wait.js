"use strict";
const path = require("node:path");
const { rspackModuleFactories } = require("../../scripts/patches/lib/rspack-module-assets.js");
const { findRspackExportPublication } = require("../../scripts/patches/lib/rspack-export-publication.js");
const { javascriptSourceParses } = require("../../scripts/patches/lib/javascript-syntax.js");
const { patchWebviewAssets } = require("../../scripts/patches/lib/assets.js");
const { inspectHostStatusOwner, WAIT_EXPRESSION, WAIT_MARKER, READ_MARKER } = require("./host-status-owner.js");
const { locateStatusReadCohort } = require("./host-status.js");
function fail(reason) { throw Error(`Remote status-wait cohort: ${reason}`); }
function same(rows, select, reason) { if (new Set(rows.map(select)).size !== 1) fail(reason); }
function prepareStatusWaitSource(copy) {
  const proof = inspectHostStatusOwner(copy);
  const nativeSource = proof.waitPeer ? copy.moduleSource.replace(WAIT_EXPRESSION, "5e3") : copy.moduleSource;
  const publication = findRspackExportPublication({ ...copy, moduleSource: nativeSource }, "Hf"), fn = publication?.fn;
  if (!fn || fn.name !== null || fn.body.split(",5e3)").length !== 2) fail("missing complete native inline wait timeout");
  const bodyStart = fn.end - 1 - fn.body.length;
  if (nativeSource.slice(bodyStart, fn.end - 1) !== fn.body) fail("stale native wait publication");
  const at = bodyStart + fn.body.indexOf(",5e3)") + 1;
  const patchedSource = nativeSource.slice(0, at) + WAIT_EXPRESSION + nativeSource.slice(at + 3);
  const replay = inspectHostStatusOwner({ ...copy, moduleSource: patchedSource });
  if (!replay.waitPeer || replay.readState !== proof.readState || replay.nativeSource !== proof.nativeSource ||
      patchedSource.replace(WAIT_EXPRESSION, "5e3") !== nativeSource ||
      proof.waitPeer && patchedSource !== copy.moduleSource) fail("canonical wait inverse/replay or read peer changed");
  return Object.freeze({ proof, nativeSource, patchedSource, state: proof.waitPeer ? "patched" : "pristine" });
}
function prepareStatusWaitString(source, context = {}) {
  if (context.factorySnapshot) {
    if (source !== context.factorySnapshot.moduleSource) fail("stale String snapshot");
    return prepareStatusWaitSource(context.factorySnapshot).patchedSource;
  }
  const copies = [...rspackModuleFactories(source, "String status wait")].filter(copy => {
    try { inspectHostStatusOwner(copy);return true; } catch { return false; }
  });
  if (!copies.length) fail("missing qualified native String owner");
  same(copies, copy => copy.moduleId, "ambiguous String owner");
  const plans = copies.map(prepareStatusWaitSource);
  same(plans, plan => plan.state, "mixed String waits");same(plans, plan => plan.proof.readState, "mixed String read peers");
  let patched = source;
  for (const [copy, plan] of copies.map((copy, index) => [copy, plans[index]]).sort((a, b) => b[0].start - a[0].start)) {
    patched = patched.slice(0, copy.start) + plan.patchedSource + patched.slice(copy.end);
  }
  if (patched.split(WAIT_MARKER).length - 1 !== copies.length ||
      patched.split(READ_MARKER).length - 1 !== (plans[0].proof.readState === "patched" ? 2 * copies.length : 0) ||
      !javascriptSourceParses(patched)) fail("orphan or invalid String contribution");
  return patched;
}
function locateStatusWaitCohort(assets) {
  // Reuse the complete accepted reader graph as read-only authority. Its read
  // proposals are deliberately not used: this descriptor owns only the timeout.
  const dependencies = locateStatusReadCohort(assets), edits = [];let targets = 0;
  for (const asset of dependencies.edits) {
    const copies = [...rspackModuleFactories(asset.source, asset.assetName)].filter(copy => copy.moduleId === dependencies.moduleIds.owner);
    let patchedSource = asset.source;
    for (const copy of copies.sort((a, b) => b.start - a.start)) {
      const plan = prepareStatusWaitSource(copy);
      if ((plan.state === "patched") !== dependencies.waitPeer ||
          (plan.proof.readState === "patched") !== dependencies.alreadyApplied) fail("inconsistent qualified read/wait peers");
      patchedSource = patchedSource.slice(0, copy.start) + plan.patchedSource + patchedSource.slice(copy.end);targets++;
    }
    edits.push(Object.freeze({ assetName: asset.assetName, source: asset.source, patchedSource }));
  }
  if (targets !== dependencies.targetCopies) fail("missing physical wait owner");
  return Object.freeze({ edits: Object.freeze(edits), alreadyApplied: dependencies.waitPeer,
    readPeer: dependencies.alreadyApplied, targetCopies: targets, moduleIds: dependencies.moduleIds,
    dependencyAssets: dependencies.dependencyAssets });
}
function applyStatusWaitPatch(extractedDir, options = {}) {
  const assets = path.join(extractedDir, "webview/assets"), plan = locateStatusWaitCohort(assets);
  return { ...patchWebviewAssets(assets, plan.edits, options), matched: true, targetCopies: plan.targetCopies, moduleIds: plan.moduleIds };
}
module.exports = { prepareStatusWaitSource, prepareStatusWaitString, locateStatusWaitCohort, applyStatusWaitPatch };
