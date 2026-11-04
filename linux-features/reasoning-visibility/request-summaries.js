"use strict";

const { escapeRegExp } = require("../../scripts/patches/lib/minified-js.js");
const { runtimeVisibility, withRuntime } = require("./runtime.js");

const ID = "[A-Za-z_$][\\w$]*";
const MARKER = "/*community-reasoning-visibility-request-summaries*/";
const ENABLED = "codexLinuxReasoningVisibilityEnabled()";
const FALLBACK = `!0===${ID}\\.getDefaultFeatureOverride\\("concurrent_reasoning_summaries"\\)\\|\\|${ID}\\?"detailed":null`;
const SUFFIX = `,getRequestModel:(?<model>${ID})=>\\k<model>,getRequestCollaborationMode\\(`;
const CURRENT = new RegExp(`reasoningSummaryOverride:(?<fallback>${FALLBACK})(?<suffix>${SUFFIX})`, "g");
const PATCHED = new RegExp(`reasoningSummaryOverride:${escapeRegExp(ENABLED)}\\?"detailed":\\((?<fallback>${FALLBACK})\\)${escapeRegExp(MARKER)}(?<suffix>${SUFFIX})`, "g");

function summaryRequestState(source) {
  const current = [...source.matchAll(CURRENT)];
  const patched = [...source.matchAll(PATCHED)];
  const count = source.split(MARKER).length - 1;
  const match = current.length === 1 && patched.length === 0 ? current[0]
    : current.length === 0 && patched.length === 1 ? patched[0] : null;
  if (match == null) return { kind: "invalid" };
  const targetIndex = match.index + "reasoningSummaryOverride:".length;
  const visibility = runtimeVisibility(source, targetIndex);
  if (visibility === "invalid" || visibility === "absent" && source.includes(ENABLED)) return { kind: "invalid" };
  if (current.length === 1 && count === 0) return { kind: "current", match, targetIndex };
  if (patched.length === 1 && count === 1 && visibility === "visible") return { kind: "patched", match, targetIndex };
  return { kind: "invalid" };
}

function applyRequestSummariesPatch(source) {
  const state = summaryRequestState(source);
  if (state.kind === "invalid") {
    console.warn("WARN: reasoning-visibility/request-summaries: current summary option contract missing, ambiguous, or incomplete");
    return source;
  }
  if (state.kind === "patched") return source;
  const { match } = state;
  const replacement = `reasoningSummaryOverride:${ENABLED}?"detailed":(${match.groups.fallback})${MARKER}${match.groups.suffix}`;
  return withRuntime(source.slice(0, match.index) + replacement + source.slice(match.index + match[0].length), state.targetIndex);
}

const requestSummariesDescriptor = {
  id: "request-summaries",
  phase: "webview-asset",
  order: 20_745,
  ciPolicy: "optional",
  assetNeedles: ["concurrent_reasoning_summaries", "getRequestCollaborationMode("],
  assetMatch: source => source.includes(MARKER) ||
    source.includes("concurrent_reasoning_summaries") && source.includes("getRequestCollaborationMode("),
  missingDescription: "current reasoning visibility summary request contract",
  apply: applyRequestSummariesPatch,
};

module.exports = { applyRequestSummariesPatch, requestSummariesDescriptor };
