"use strict";

const { escapeRegExp, findMatchingBrace } = require("../../scripts/patches/lib/minified-js.js");

// Complete activity classifier from the current signed rspack/SWC package.
// The bundler inlines the classifier into the partition loop as a function
// expression, so the contract is bound by its destructured options and guard
// and then checked as one complete function body. Every local alias is
// captured; the upstream tool exceptions must stay intact.
const identifier = String.raw`[A-Za-z_$][\w$]*`;
const call = String.raw`(?:\(0,${identifier}\.${identifier}\)|${identifier})`;
const classifierHead = new RegExp(
  String.raw`function(?: ${identifier})?\((?<unit>${identifier}),(?<following>${identifier}),\{` +
    String.raw`keepMcpAppEntriesPersistent:(?<keep>${identifier}),mcpServerStatuses:(?<statuses>${identifier}),` +
    String.raw`plainAsyncMessageIds:(?<plain>${identifier})\}\)\{` +
    String.raw`if\("standalone"!==\k<unit>\.kind\)return!1;let (?<item>${identifier})=\k<unit>\.item\.item;return`,
  "g",
);
const recovery = "Disable authored-message-visibility and rebuild, or update its patch for the current official package.";

function classifierShape(source, match) {
  const open = match.index + match[0].indexOf("){if(") + 1;
  const end = findMatchingBrace(source, open);
  if (end < 0) return null;
  const body = source.slice(match.index, end + 1);
  const { item, following, keep, plain, statuses } = match.groups;
  const i = escapeRegExp(item);
  // Upstream-owned exceptions that must survive unchanged in both states.
  const tools = [
    `"user-input-response"===${item}.type?!${item}.completed:`,
    `"dynamic-tool-call"===${item}.type&&`,
    `${keep}&&"mcp-tool-call"===${item}.type&&`,
    `mcpServerStatuses:${statuses}}))`,
  ];
  const assistant = new RegExp(
    String.raw`"assistant-message"===${i}\.type\?(?<patched>!0\|\|)?${call}\(${i}\)\|\|"async"===${i}\.delivery&&` +
      String.raw`null!=${i}\.searchItemId&&${escapeRegExp(plain)}\?\.has\(${i}\.searchItemId\)===!0:!!\(`,
    "g",
  );
  if (!tools.every((part) => body.split(part).length === 2) ||
      !new RegExp(String.raw`"mcp-tool-call"===${i}\.type&&${call}\(${i}\)`).test(body)) {
    return null;
  }
  const assistants = [...body.matchAll(assistant)];
  const user = `||"user-message"===${item}.type&&("pending"===${item}.steeringStatus||!0===${item}.followsInterruptedFinalAnswer||` +
    `!0===${item}.wasInHistoryPreview||"not-sent"===${item}.deliveryStatus||!0===${item}.hookFeedback||!${following})}`;
  const currentUser = user.slice(0, -1) + ")}";
  const userPatched = `||"user-message"===${item}.type${currentUser}`;
  const original = assistants.length === 1 && assistants[0].groups.patched == null && body.endsWith(currentUser);
  const patched = assistants.length === 1 && assistants[0].groups.patched != null && body.endsWith(userPatched);
  if (!original && !patched) return null;
  return { start: match.index, body, item, original, assistant: assistants[0], user: currentUser, userPatched };
}

function applyAuthoredMessageVisibilityPatch(source) {
  const shapes = [...source.matchAll(classifierHead)].map((match) => classifierShape(source, match));
  const current = shapes.filter((shape) => shape?.original);
  const patched = shapes.filter((shape) => shape != null && !shape.original);
  if (shapes.length === 1 && patched.length === 1) return source;
  if (shapes.length !== 1 || current.length !== 1) {
    console.warn(`WARN: authored-message-visibility: expected one complete activity classifier, found ${current.length} original and ${patched.length} patched of ${shapes.length}. ${recovery}`);
    return source;
  }
  const [{ start, body, assistant, user, userPatched }] = current;
  const replacement = body
    .slice(0, assistant.index + assistant[0].indexOf("?") + 1) + "!0||" +
    body.slice(assistant.index + assistant[0].indexOf("?") + 1);
  const patchedBody = replacement
    .slice(0, -user.length) + userPatched;
  return source.slice(0, start) + patchedBody + source.slice(start + body.length);
}

module.exports = {
  applyAuthoredMessageVisibilityPatch,
  descriptors: [{
    id: "persistent-messages",
    phase: "webview-asset",
    order: 20_740,
    ciPolicy: "optional",
    // Content-addressed: every chunk that carries the activity partition
    // module is patched, because rspack can duplicate a module across chunks.
    assetNeedles: ["collapsibleUnits:", "persistentUnits:", "keepMcpAppEntriesPersistent:"],
    missingWarning: `WARN: authored-message-visibility: activity partition bundle missing. ${recovery}`,
    apply: applyAuthoredMessageVisibilityPatch,
  }],
};
