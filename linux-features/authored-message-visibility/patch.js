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
  String.raw`function(?: ${identifier})?\(\{unit:(?<unit>${identifier}),hasFollowingFinalAnswer:(?<following>${identifier}),` +
    String.raw`keepMcpAppEntriesPersistent:(?<keep>${identifier}),mcpServerStatuses:(?<statuses>${identifier}),renderMcpApps:(?<render>${identifier})\}\)\{` +
    String.raw`if\("standalone"!==\k<unit>\.kind\)return!1;let (?<item>${identifier})=\k<unit>\.item\.item;return`,
  "g",
);
const recovery = "Disable authored-message-visibility and rebuild, or update its patch for the current official package.";

function classifierShape(source, match) {
  const open = match.index + match[0].indexOf("){if(") + 1;
  const end = findMatchingBrace(source, open);
  if (end < 0) return null;
  const body = source.slice(match.index, end + 1);
  const { item, following, keep, render, statuses } = match.groups;
  const i = escapeRegExp(item);
  // Upstream-owned exceptions that must survive unchanged in both states.
  const tools = [
    `"user-input-response"===${item}.type?!${item}.completed:`,
    `"dynamic-tool-call"===${item}.type&&`,
    `${keep}&&${render}&&"mcp-tool-call"===${item}.type&&`,
    `mcpServerStatuses:${statuses}}))`,
  ];
  if (!tools.every((part) => body.split(part).length === 2) ||
      !new RegExp(String.raw`"mcp-tool-call"===${i}\.type&&${call}\(${i}\)\|\|"assistant-message"===${i}\.type`).test(body)) {
    return null;
  }
  const assistant = [...body.matchAll(new RegExp(String.raw`\|\|"assistant-message"===${i}\.type&&${call}\(${i}\)\|\|"dynamic-tool-call"===`, "g"))];
  const assistantPatched = body.split(`||"assistant-message"===${item}.type||"dynamic-tool-call"===`).length - 1;
  const user = `||"user-message"===${item}.type&&("pending"===${item}.steeringStatus||!0===${item}.followsInterruptedFinalAnswer||` +
    `!0===${item}.wasInHistoryPreview||"not-sent"===${item}.deliveryStatus||!0===${item}.hookFeedback||!${following})}`;
  const userPatched = `||"user-message"===${item}.type}`;
  const original = assistant.length === 1 && assistantPatched === 0 && body.endsWith(user);
  const patched = assistant.length === 0 && assistantPatched === 1 && body.endsWith(userPatched);
  if (!original && !patched) return null;
  return { start: match.index, body, item, original, assistant: assistant[0]?.[0], user, userPatched };
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
  const [{ start, body, item, assistant, user, userPatched }] = current;
  const replacement = body
    .replace(assistant, `||"assistant-message"===${item}.type||"dynamic-tool-call"===`)
    .slice(0, -user.length) + userPatched;
  return source.slice(0, start) + replacement + source.slice(start + body.length);
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
