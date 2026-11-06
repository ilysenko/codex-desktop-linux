"use strict";

const path = require("node:path");
const { findUniqueRspackModuleCopies } = require("../../scripts/patches/lib/rspack-module-assets.js");
const { commitAssetEdits } = require("../../scripts/patches/lib/asset-edits.js");
const { escapeRegExp } = require("../../scripts/patches/lib/minified-js.js");
const { runtimeVisibility, withRuntime } = require("./runtime.js");

const { inspectActivityPartition } = require("../../scripts/patches/lib/activity-partition.js");
const ACTIVITY_NEEDLES = ["collapsibleUnits:", "persistentUnits:", "keepMcpAppEntriesPersistent:"];
const MARKER = "/*community-reasoning-visibility-persistent*/";
const ENABLED = "codexLinuxReasoningVisibilityEnabled()";

function persistenceState(source) {
  const owner = inspectActivityPartition(source);
  if (!owner.ok) return { kind: "invalid" };
  const { expression, nativeExpression, names } = owner;
  const authoredPrefix = `/*codex-linux-authored-message-visibility*/"assistant-message"===${names.item}.type||"user-message"===${names.item}.type||(`;
  const authored = expression.source === authoredPrefix + nativeExpression.source + ")";
  if (source.split("/*codex-linux-authored-message-visibility*/").length - 1 !== Number(authored) ||
      !authored && expression.source !== nativeExpression.source) return { kind: "invalid" };
  const unit = owner.call.unit;
  const match = { index: owner.classifier.start };
  const addition = `${ENABLED}&&"standalone"===${unit}.kind&&"reasoning"===${unit}.item.item.type||${MARKER}`;
  const prefix = source.slice(0, match.index);
  const patched = prefix.endsWith(addition);
  if (!patched && new RegExp(`${escapeRegExp(ENABLED)}[^;{}]*$`).test(prefix)) return { kind: "invalid" };
  const targetIndex = patched ? match.index - addition.length : match.index;
  const visibility = runtimeVisibility(source, targetIndex);
  if (source.split(MARKER).length - 1 !== Number(patched) || visibility === "invalid" ||
      visibility === "absent" && source.includes(ENABLED) ||
      patched && visibility !== "visible") {
    return { kind: "invalid" };
  }
  return { kind: patched ? "patched" : "current", match, addition };
}

function applyPersistentPatch(source) {
  const state = persistenceState(source);
  if (state.kind === "invalid") {
    console.warn("WARN: reasoning-visibility/persistent: current inline persistence contract missing, ambiguous, or incomplete");
    return source;
  }
  if (state.kind === "patched") return source;
  const { match, addition } = state;
  // Preserve the complete current native expression and any complete authored
  // wrapper. The preference only adds the existing standalone reasoning case.
  return withRuntime(source.slice(0, match.index) + ` ${addition}` + source.slice(match.index), match.index + 1);
}

function patchPersistentAssets(extractedDir) {
  const assets = path.join(extractedDir, "webview", "assets");
  const ownsActivity = source => ACTIVITY_NEEDLES.every(needle => source.includes(needle));
  const copies = findUniqueRspackModuleCopies(assets, {
    matchModule: ownsActivity,
    sourceMatch: ownsActivity,
    description: "reasoning activity partition",
  });
  const edits = copies.map(copy => {
    const owner = inspectActivityPartition(copy.source);
    if (!ownsActivity(copy.moduleSource) || !owner.ok ||
        owner.classifier.start < copy.start || owner.classifier.end > copy.end ||
        persistenceState(copy.source).kind === "invalid") {
      throw new Error(`Incomplete reasoning activity owner in ${copy.assetName}`);
    }
    // The pure API also verifies program-level runtimes created by earlier
    // builds. Plan complete assets so that helper scope and bytes stay intact.
    const patchedSource = applyPersistentPatch(copy.source);
    if (applyPersistentPatch(patchedSource) !== patchedSource) {
      throw new Error(`Incomplete reasoning activity result in ${copy.assetName}`);
    }
    return { assetName: copy.assetName, source: copy.source, patchedSource };
  });
  const changed = edits.map(edit => edit.source !== edit.patchedSource);
  if (changed.some(Boolean) && !changed.every(Boolean)) throw new Error("Partially applied reasoning activity copies");
  return { matched: copies.length, ...commitAssetEdits(assets, edits),
    reason: `Reasoning activity module ${copies[0].moduleId}: ${copies.length} copies` };
}

const persistentDescriptor = {
  id: "persistent",
  phase: "extracted-app:pre-webview",
  order: 20_745,
  ciPolicy: "optional",
  assetNeedles: ["collapsibleUnits:", "persistentUnits:"],
  assetMatch: source => source.includes("collapsibleUnits:") && source.includes("persistentUnits:"),
  missingDescription: "current reasoning visibility inline persistence contract",
  apply: patchPersistentAssets,
};

module.exports = { applyPersistentPatch, patchPersistentAssets, persistentDescriptor, persistenceState };
