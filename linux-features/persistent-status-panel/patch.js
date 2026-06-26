"use strict";

const STORAGE_KEY = "codex-linux-persistent-status-panel-open";

const statusStatePattern =
  /\{conversationId:[^,]+,threadId:[^,]+,rateLimit:[^,]+,onOpenChange:([A-Za-z_$][\w$]*)\}=e,([A-Za-z_$][\w$]*)=[A-Za-z_$][\w$]*\(\),\[([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\]=\(0,([A-Za-z_$][\w$]*)\.useState\)\(!1\),/;

function countOccurrences(source, needle) {
  if (needle.length === 0) {
    return 0;
  }
  let count = 0;
  let index = 0;
  while ((index = source.indexOf(needle, index)) !== -1) {
    count += 1;
    index += needle.length;
  }
  return count;
}

function requireUniqueNeedle(source, needle, description) {
  const count = countOccurrences(source, needle);
  if (count === 1) {
    return true;
  }
  if (count === 0) {
    console.warn(`WARN: Could not find ${description} - skipping persistent status panel patch`);
  } else {
    console.warn(`WARN: Found ${count} ${description} occurrences - skipping persistent status panel patch`);
  }
  return false;
}

function applyPersistentStatusPanelPatch(source) {
  if (source.includes(STORAGE_KEY)) {
    return source;
  }

  if (!source.includes("composer.statusSlashCommand.description")) {
    return source;
  }

  const match = source.match(statusStatePattern);
  if (!match) {
    console.warn("WARN: Could not find Codex status panel state - skipping persistent status panel patch");
    return source;
  }

  const [stateNeedle, onOpenChange, _intl, isOpen, setIsOpen, reactVar] = match;
  const openNeedle = `async()=>{${setIsOpen}(!0),${onOpenChange}?.(!0)}`;
  const closeNeedle = `()=>{${setIsOpen}(!1),${onOpenChange}?.(!1)}`;
  if (
    !requireUniqueNeedle(source, stateNeedle, "Codex status panel state") ||
    !requireUniqueNeedle(source, openNeedle, "Codex status panel open handler") ||
    !requireUniqueNeedle(source, closeNeedle, "Codex status panel close handler")
  ) {
    return source;
  }

  const statePatch = stateNeedle.replace(
    ".useState)(!1),",
    `.useState)(()=>{try{return localStorage.getItem(\`${STORAGE_KEY}\`)===\`1\`}catch{return!1}}),`,
  );
  const openPatch = `async()=>{try{localStorage.setItem(\`${STORAGE_KEY}\`,\`1\`)}catch{}${setIsOpen}(!0),${onOpenChange}?.(!0)}`;
  const closePatch = `()=>{try{localStorage.removeItem(\`${STORAGE_KEY}\`)}catch{}${setIsOpen}(!1),${onOpenChange}?.(!1)}`;

  let patchedSource = source
    .replace(stateNeedle, statePatch)
    .replace(openNeedle, openPatch)
    .replace(closeNeedle, closePatch);
  const stateIndex = patchedSource.indexOf(statePatch);
  const declarationEndIndex = stateIndex === -1 ? -1 : patchedSource.indexOf(";", stateIndex + statePatch.length);
  if (declarationEndIndex === -1) {
    console.warn("WARN: Could not find Codex status panel state declaration end - skipping persistent status panel patch");
    return source;
  }
  const restoreEffect = `(0,${reactVar}.useEffect)(()=>{${isOpen}&&${onOpenChange}?.(!0)},[${isOpen},${onOpenChange}]);`;
  return `${patchedSource.slice(0, declarationEndIndex + 1)}${restoreEffect}${patchedSource.slice(declarationEndIndex + 1)}`;
}

const patches = [
  {
    id: "composer-status-state",
    phase: "webview-asset",
    order: 20_800,
    ciPolicy: "optional",
    pattern: /^composer-.*\.js$/,
    missingDescription: "composer status panel bundle",
    skipDescription: "persistent status panel patch",
    apply: applyPersistentStatusPanelPatch,
  },
];

module.exports = {
  STORAGE_KEY,
  applyPersistentStatusPanelPatch,
  patches,
};
