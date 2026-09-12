"use strict";

// Complete classifier template from official Linux 26.908.40834. Bind local
// aliases; only the final message branch changes. Tool exceptions stay intact.
const currentPattern = new RegExp("function\\ ([A-Za-z_$][\\w$]*)\\(\\{unit:([A-Za-z_$][\\w$]*),keepMcpAppEntriesPersistent:([A-Za-z_$][\\w$]*),mcpServerStatuses:([A-Za-z_$][\\w$]*),renderMcpApps:([A-Za-z_$][\\w$]*)\\}\\)\\{if\\(\\2\\.kind!==`standalone`\\)return!1;let\\ ([A-Za-z_$][\\w$]*)=\\2\\.item\\.item;return\\ \\6\\.type===`dynamic\\-tool\\-call`\\&\\&([A-Za-z_$][\\w$]*)\\(\\6\\)\\|\\|\\3\\&\\&\\5\\&\\&\\6\\.type===`mcp\\-tool\\-call`\\&\\&([A-Za-z_$][\\w$]*)\\(\\{item:\\6,mcpServerStatuses:\\4\\}\\)\\?!0:\\6\\.type===`user\\-message`\\&\\&\\(\\6\\.steeringStatus!=null\\|\\|\\6\\.hookFeedback===!0\\)\\}", "g");
const patchedPattern = new RegExp("function\\ ([A-Za-z_$][\\w$]*)\\(\\{unit:([A-Za-z_$][\\w$]*),keepMcpAppEntriesPersistent:([A-Za-z_$][\\w$]*),mcpServerStatuses:([A-Za-z_$][\\w$]*),renderMcpApps:([A-Za-z_$][\\w$]*)\\}\\)\\{if\\(\\2\\.kind!==`standalone`\\)return!1;let\\ ([A-Za-z_$][\\w$]*)=\\2\\.item\\.item;return\\ \\6\\.type===`dynamic\\-tool\\-call`\\&\\&([A-Za-z_$][\\w$]*)\\(\\6\\)\\|\\|\\3\\&\\&\\5\\&\\&\\6\\.type===`mcp\\-tool\\-call`\\&\\&([A-Za-z_$][\\w$]*)\\(\\{item:\\6,mcpServerStatuses:\\4\\}\\)\\?!0:\\6\\.type===`assistant\\-message`\\|\\|\\6\\.type===`user\\-message`\\}", "g");
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
  const item = match[6];
  const before = `${item}.type===\`user-message\`&&(${item}.steeringStatus!=null||${item}.hookFeedback===!0)`;
  const after = `${item}.type===\`assistant-message\`||${item}.type===\`user-message\``;
  return source.slice(0, match.index) + match[0].replace(before, after) + source.slice(match.index + match[0].length);
}

module.exports = {
  applyAuthoredMessageVisibilityPatch,
  descriptors: [{
    id: "persistent-messages",
    phase: "webview-asset",
    order: 20_740,
    ciPolicy: "optional",
    pattern: /^conversation-blocks-[A-Za-z0-9_-]+\.js$/,
    assetMatch: (source) => source.includes("collapsibleUnits:") && source.includes("persistentUnits:"),
    missingWarning: `WARN: authored-message-visibility: activity partition bundle missing. ${recovery}`,
    ambiguousWarning: `WARN: authored-message-visibility: multiple activity partition bundles. ${recovery}`,
    apply: applyAuthoredMessageVisibilityPatch,
  }],
};
