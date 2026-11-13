"use strict";

const path = require("node:path");
const { findUniqueRspackModuleCopies, patchRspackModuleCopies } = require("../../scripts/patches/lib/rspack-module-assets.js");

const { inspectActivityPartition } = require("../../scripts/patches/lib/activity-partition.js");
const ACTIVITY_NEEDLES = ["collapsibleUnits:", "persistentUnits:", "keepMcpAppEntriesPersistent:"];
const MARKER = "/*codex-linux-authored-message-visibility*/";
const recovery = "Disable authored-message-visibility and rebuild, or update its patch for the current official package.";

function classifierShape(source) {
  const owner = inspectActivityPartition(source);
  if (!owner.ok) return owner;
  const prefix = `${MARKER}"assistant-message"===${owner.names.item}.type||"user-message"===${owner.names.item}.type||(`;
  const expression = owner.expression.source;
  const patched = expression === prefix + owner.nativeExpression.source + ")";
  if (source.split(MARKER).length - 1 !== Number(patched) ||
      !patched && expression !== owner.nativeExpression.source) {
    return { ok: false, reason: "incomplete authored message expression", candidateCount: 1 };
  }
  return { ...owner, prefix, patched };
}

function applyAuthoredMessageVisibilityPatch(source) {
  const shape = classifierShape(source);
  if (!shape.ok) {
    console.warn(`WARN: authored-message-visibility: expected one complete activity classifier, found 0 complete of ${shape.candidateCount}: ${shape.reason}. ${recovery}`);
    return source;
  }
  if (shape.patched) return source;
  // Keep the complete native MCP-rendering and steering prerequisites.
  // The feature's existing authored-message types override that expression.
  return source.slice(0, shape.expression.start) + shape.prefix + shape.nativeExpression.source + ")" + source.slice(shape.expression.end);
}

function patchAuthoredMessageAssets(extractedDir) {
  const assets = path.join(extractedDir, "webview", "assets");
  const ownsActivity = source => ACTIVITY_NEEDLES.every(needle => source.includes(needle));
  const copies = findUniqueRspackModuleCopies(assets, {
    matchModule: ownsActivity,
    sourceMatch: ownsActivity,
    description: "authored message activity partition",
  });
  return patchRspackModuleCopies(assets, copies, source => {
    if (!ownsActivity(source) || !classifierShape(source).ok) {
      throw new Error("Incomplete authored message activity owner");
    }
    return applyAuthoredMessageVisibilityPatch(source);
  });
}

module.exports = {
  applyAuthoredMessageVisibilityPatch,
  patchAuthoredMessageAssets,
  descriptors: [{
    id: "persistent-messages",
    phase: "extracted-app:pre-webview",
    order: 20_740,
    ciPolicy: "optional",
    assetNeedles: ACTIVITY_NEEDLES,
    missingWarning: `WARN: authored-message-visibility: activity partition bundle missing. ${recovery}`,
    apply: patchAuthoredMessageAssets,
  }],
};
