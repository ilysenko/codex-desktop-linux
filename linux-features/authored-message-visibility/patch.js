"use strict";

// Complete classifier template from the current signed package. Bind every
// local alias and keep the upstream assistant/tool exceptions intact unless
// both authored-message branches match as one unique contract.
const identifier = String.raw`[A-Za-z_$][\w$]*`;
const classifierPrefix =
  String.raw`function (?<classifier>${identifier})\(\{unit:(?<unit>${identifier}),keepMcpAppEntriesPersistent:(?<keep>${identifier}),mcpServerStatuses:(?<statuses>${identifier}),renderMcpApps:(?<render>${identifier})\}\)\{if\(\k<unit>\.kind!==\`standalone\`\)return!1;let (?<item>${identifier})=\k<unit>\.item\.item;return `;
const classifierTools =
  String.raw`\|\|\k<item>\.type===\`dynamic-tool-call\`&&${identifier}\(\k<item>\)\|\|\k<keep>&&\k<render>&&\k<item>\.type===\`mcp-tool-call\`&&${identifier}\(\{item:\k<item>,mcpServerStatuses:\k<statuses>\}\)\?!0:`;
const currentPattern = new RegExp(
  classifierPrefix +
    String.raw`\k<item>\.type===\`assistant-message\`&&(?<assistantFilter>${identifier})\(\k<item>\)` +
    classifierTools +
    String.raw`\k<item>\.type===\`user-message\`&&\(\k<item>\.steeringStatus!=null\|\|\k<item>\.hookFeedback===!0\)\}`,
  "g",
);
const patchedPattern = new RegExp(
  classifierPrefix +
    String.raw`\k<item>\.type===\`assistant-message\`` +
    classifierTools +
    String.raw`\k<item>\.type===\`user-message\`\}`,
  "g",
);
const recovery = "Disable authored-message-visibility and rebuild, or update its patch for the current official package.";

function applyAuthoredMessageVisibilityPatch(source) {
  const current = [...source.matchAll(currentPattern)];
  const patched = [...source.matchAll(patchedPattern)];
  if (current.length === 0 && patched.length === 1) return source;
  if (current.length !== 1 || patched.length !== 0) {
    console.warn(`WARN: authored-message-visibility: expected one complete activity classifier, found ${current.length} original and ${patched.length} patched. ${recovery}`);
    return source;
  }
  const match = current[0];
  const item = match.groups.item;
  const assistantFilter = match.groups.assistantFilter;
  const assistantBefore = `${item}.type===\`assistant-message\`&&${assistantFilter}(${item})`;
  const assistantAfter = `${item}.type===\`assistant-message\``;
  const before = `${item}.type===\`user-message\`&&(${item}.steeringStatus!=null||${item}.hookFeedback===!0)`;
  const after = `${item}.type===\`assistant-message\`||${item}.type===\`user-message\``;
  const replacement = match[0]
    .replace(assistantBefore, assistantAfter)
    .replace(before, `${item}.type===\`user-message\``);
  return source.slice(0, match.index) + replacement + source.slice(match.index + match[0].length);
}

module.exports = {
  applyAuthoredMessageVisibilityPatch,
  descriptors: [{
    id: "persistent-messages",
    phase: "webview-asset",
    order: 20_740,
    ciPolicy: "optional",
    pattern: /^[A-Za-z0-9_-]+\.js$/,
    assetMatch: (source) => source.includes("collapsibleUnits:") && source.includes("persistentUnits:"),
    missingWarning: `WARN: authored-message-visibility: activity partition bundle missing. ${recovery}`,
    ambiguousWarning: `WARN: authored-message-visibility: multiple activity partition bundles. ${recovery}`,
    apply: applyAuthoredMessageVisibilityPatch,
  }],
};
