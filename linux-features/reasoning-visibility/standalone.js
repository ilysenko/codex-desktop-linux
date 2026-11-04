"use strict";

const path = require("node:path");
const { escapeRegExp } = require("../../scripts/patches/lib/minified-js.js");
const { findUniqueRspackModuleCopies, patchRspackModuleCopies } = require("../../scripts/patches/lib/rspack-module-assets.js");
const { extractedAppPatch, PHASE_EXTRACTED_APP_POST_WEBVIEW } = require("../../scripts/patches/descriptor.js");
const { runtimeVisibility, withRuntime } = require("./runtime.js");

const ID = "[A-Za-z_$][\\w$]*";
const MARKER = "/*community-reasoning-visibility-standalone*/";
const ENABLED = "codexLinuxReasoningVisibilityEnabled()";
const CONTRACT = new RegExp(
  `(?<prefix>case"worktree-init":return (?<wrap>${ID})\\((?<item>${ID}),"standalone"\\);case"reasoning":)` +
  `(?<patched>return ${escapeRegExp(ENABLED)}\\?\\k<wrap>\\(\\k<item>,"standalone"\\):null${escapeRegExp(MARKER)};)?` +
  '(?<suffix>case"automation-update":)', "g");

function standaloneState(source) {
  const matches = [...source.matchAll(CONTRACT)];
  const starts = [...source.matchAll(/case"worktree-init":return/g)];
  if (!source.includes("includeGeneratedImages:") || matches.length !== 1 || starts.length !== 1) return { kind: "invalid" };
  const [match] = matches;
  const patched = match.groups.patched != null;
  const targetIndex = match.index + match.groups.prefix.length + "return ".length;
  const visibility = runtimeVisibility(source, targetIndex);
  if (source.split(MARKER).length - 1 !== Number(patched) || visibility === "invalid" ||
      visibility === "absent" && source.includes(ENABLED) || patched && visibility !== "visible") return { kind: "invalid" };
  return { kind: patched ? "patched" : "current", match, targetIndex };
}

function applyStandalonePatch(source) {
  const state = standaloneState(source);
  if (state.kind === "invalid") {
    console.warn("WARN: reasoning-visibility/standalone: current activity discriminator missing, ambiguous, or incomplete");
    return source;
  }
  if (state.kind === "patched") return source;
  const { match } = state;
  const { prefix, wrap, item, suffix } = match.groups;
  const replacement = `${prefix}return ${ENABLED}?${wrap}(${item},"standalone"):null${MARKER};${suffix}`;
  return withRuntime(source.slice(0, match.index) + replacement + source.slice(match.index + match[0].length), state.targetIndex);
}

function applyStandaloneAssets(extractedDir) {
  const assets = path.join(extractedDir, "webview", "assets");
  const copies = findUniqueRspackModuleCopies(assets, {
    sourceMatch: source => source.includes("includeGeneratedImages:") && source.includes('case"reasoning":'),
    matchModule: source => standaloneState(source).kind !== "invalid",
    description: "reasoning standalone activity discriminator",
  });
  const result = patchRspackModuleCopies(assets, copies, source => {
    if (standaloneState(source).kind === "invalid") throw new Error("Incomplete reasoning standalone activity discriminator replica");
    return applyStandalonePatch(source);
  });
  return { ...result, reason: `Reasoning standalone discriminator module ${result.moduleId}: ${result.matched} copies` };
}

const standaloneDescriptor = extractedAppPatch({
  id: "standalone",
  phase: PHASE_EXTRACTED_APP_POST_WEBVIEW,
  order: 20_745,
  ciPolicy: "optional",
  assetNeedles: ['case"worktree-init":return ', '"standalone");case"reasoning":'],
  apply: applyStandaloneAssets,
});

module.exports = { applyStandalonePatch, standaloneDescriptor, standaloneState };
