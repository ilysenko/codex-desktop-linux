"use strict";

const { escapeRegExp, findMatchingBrace } = require("../../scripts/patches/lib/minified-js.js");
const { runtimeVisibility, withRuntime } = require("./runtime.js");

const ID = "[A-Za-z_$][\\w$]*";
const MARKER = "/*community-reasoning-visibility-persistent*/";
const ENABLED = "codexLinuxReasoningVisibilityEnabled()";

function persistenceState(source) {
  const header = new RegExp(
    `function\\(\\{unit:(?<unit>${ID}),hasFollowingFinalAnswer:(?<following>${ID}),` +
    `keepMcpAppEntriesPersistent:(?<keepMcp>${ID}),mcpServerStatuses:(?<statuses>${ID}),renderMcpApps:(?<renderMcp>${ID})\\}\\)\\{` +
    `if\\("standalone"!==\\k<unit>\\.kind\\)return!1;let (?<item>${ID})=\\k<unit>\\.item\\.item;return` +
    `"user-input-response"===\\k<item>\\.type\\?!\\k<item>\\.completed:`, "g");
  const starts = [...source.matchAll(/function\(\{unit:[\w$]+,hasFollowingFinalAnswer:[\w$]+,keepMcpAppEntriesPersistent:/g)];
  const matches = [...source.matchAll(header)];
  if (starts.length !== 1 || matches.length !== 1) return { kind: "invalid" };
  const match = matches[0];
  const open = source.indexOf("){", match.index) + 1;
  const end = findMatchingBrace(source, open);
  const body = source.slice(open + 1, end);
  if (end < open || !body.includes(`"user-message"===${match.groups.item}.type`) ||
      !body.includes(`"mcp-tool-call"===${match.groups.item}.type`) ||
      !body.includes(`"dynamic-tool-call"===${match.groups.item}.type`)) return { kind: "invalid" };
  const call = new RegExp(`^\\(\\{unit:(?<unit>${ID}),hasFollowingFinalAnswer:`).exec(source.slice(end + 1));
  if (call == null) return { kind: "invalid" };
  const unit = call.groups.unit;
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
  // Keep the complete shared classifier unchanged: authored-message-visibility
  // owns its user/assistant clauses and must still recognize both applied states.
  return withRuntime(source.slice(0, match.index) + ` ${addition}` + source.slice(match.index), match.index + 1);
}

const persistentDescriptor = {
  id: "persistent",
  phase: "webview-asset",
  order: 20_745,
  ciPolicy: "optional",
  assetNeedles: ["collapsibleUnits:", "persistentUnits:"],
  assetMatch: source => source.includes("collapsibleUnits:") && source.includes("persistentUnits:"),
  missingDescription: "current reasoning visibility inline persistence contract",
  apply: applyPersistentPatch,
};

module.exports = { applyPersistentPatch, persistentDescriptor, persistenceState };
