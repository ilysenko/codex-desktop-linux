"use strict";

const path = require("node:path");
const { escapeRegExp, findMatchingBrace } = require("../../scripts/patches/lib/minified-js.js");
const { findUniqueRspackModuleCopies, patchRspackModuleCopies } = require("../../scripts/patches/lib/rspack-module-assets.js");
const { extractedAppPatch, PHASE_EXTRACTED_APP_POST_WEBVIEW } = require("../../scripts/patches/descriptor.js");
const { runtimeVisibility, withRuntime } = require("./runtime.js");

const ID = "[A-Za-z_$][\\w$]*";
const MARKER = "/*community-reasoning-visibility-transcript*/";
const ENABLED = "codexLinuxReasoningVisibilityEnabled()";
const CONTRACT = new RegExp(
  `(?<classifier>let (?<classified>${ID})="reasoning"===(?<item>${ID})\\.type\\|\\|` +
  `"automatic-approval-review"===\\k<item>\\.type\\|\\|"subagent-activity"===\\k<item>\\.type\\?null:` +
  `\\(0,${ID}\\.${ID}\\)\\(\\k<item>\\);)if\\(` +
  `(?<patched>${escapeRegExp(ENABLED)}&&"reasoning"===\\k<item>\\.type\\|\\|${escapeRegExp(MARKER)})?` +
  `(?<condition>\\k<classified>\\?\\.grouping==="standalone"\\|\\|(?<persistent>${ID})\\?\\.has\\(\\k<item>\\)===!0)\\)\\{`, "g");

function transcriptState(source) {
  const starts = [...source.matchAll(/let [\w$]+="reasoning"===[\w$]+\.type/g)];
  const matches = [...source.matchAll(CONTRACT)];
  if (starts.length !== 1 || matches.length !== 1) return { kind: "invalid" };
  const [match] = matches;
  const open = match.index + match[0].length - 1;
  const end = findMatchingBrace(source, open);
  if (end < open) return { kind: "invalid" };
  const body = source.slice(open + 1, end);
  const prefix = new RegExp(`^(?<flush>${ID})\\(\\),(?<output>${ID})\\.push\\(\\{type:"activity-item",key:\x60transcript-activity-item-\\$\\{${ID}\\(${escapeRegExp(match.groups.item)},\x60`).exec(body);
  if (prefix == null || !body.endsWith(`,item:${match.groups.item}});continue`)) return { kind: "invalid" };
  const flushes = [...source.matchAll(new RegExp(`${escapeRegExp(prefix.groups.flush)}=\\(\\)=>\\{`, "g"))];
  if (flushes.length !== 1 || flushes[0].index >= match.index) return { kind: "invalid" };
  const flushOpen = flushes[0].index + flushes[0][0].length - 1;
  const flushEnd = findMatchingBrace(source, flushOpen);
  if (flushEnd < flushOpen || flushEnd >= match.index ||
      !source.slice(flushOpen + 1, flushEnd).includes(`${prefix.groups.output}.push({type:"agent-activity",`)) {
    return { kind: "invalid" };
  }
  const patched = match.groups.patched != null;
  const targetIndex = match.index + match.groups.classifier.length + "if(".length;
  const visibility = runtimeVisibility(source, targetIndex);
  if (source.split(MARKER).length - 1 !== Number(patched) || visibility === "invalid" ||
      visibility === "absent" && source.includes(ENABLED) || patched && visibility !== "visible") return { kind: "invalid" };
  return { kind: patched ? "patched" : "current", match, targetIndex };
}

function applyTranscriptPatch(source) {
  const state = transcriptState(source);
  if (state.kind === "invalid") {
    console.warn("WARN: reasoning-visibility/transcript: current projection contract missing, ambiguous, or incomplete");
    return source;
  }
  if (state.kind === "patched") return source;
  const { match } = state;
  const { classifier, item, condition } = match.groups;
  const replacement = `${classifier}if(${ENABLED}&&"reasoning"===${item}.type||${MARKER}${condition}){`;
  return withRuntime(source.slice(0, match.index) + replacement + source.slice(match.index + match[0].length), state.targetIndex);
}

function applyTranscriptAssets(extractedDir) {
  const assets = path.join(extractedDir, "webview", "assets");
  const copies = findUniqueRspackModuleCopies(assets, {
    sourceMatch: source => source.includes("transcript-activity-item-") && source.includes("collapseWhenPossible:"),
    matchModule: source => transcriptState(source).kind !== "invalid",
    description: "reasoning transcript projection",
  });
  const result = patchRspackModuleCopies(assets, copies, source => {
    if (transcriptState(source).kind === "invalid") throw new Error("Incomplete reasoning transcript projection replica");
    return applyTranscriptPatch(source);
  });
  return { ...result, reason: `Reasoning transcript projection module ${result.moduleId}: ${result.matched} copies` };
}

const transcriptDescriptor = extractedAppPatch({
  id: "transcript",
  phase: PHASE_EXTRACTED_APP_POST_WEBVIEW,
  order: 20_745,
  ciPolicy: "optional",
  assetNeedles: ["transcript-activity-item-", "collapseWhenPossible:"],
  apply: applyTranscriptAssets,
});

module.exports = { applyTranscriptPatch, transcriptDescriptor, transcriptState };
