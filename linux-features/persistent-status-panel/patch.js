"use strict";

const { findMatchingBrace } = require("../../scripts/patches/lib/minified-js.js");

const STORAGE_KEY = "codex-linux-persistent-status-panel-open";

function findContainingFunction(source, index) {
  let searchFrom = index;
  while (searchFrom >= 0) {
    const functionIndex = source.lastIndexOf("function", searchFrom);
    if (functionIndex === -1) {
      return null;
    }
    searchFrom = functionIndex - 1;

    const before = source[functionIndex - 1];
    const after = source[functionIndex + "function".length];
    if ((before != null && /[\w$]/u.test(before)) || (after != null && /[\w$]/u.test(after))) {
      continue;
    }

    const header = /^function(?:\s*\*)?\s*(?:[A-Za-z_$][\w$]*\s*)?\([^)]*\)\s*\{/u.exec(
      source.slice(functionIndex),
    );
    if (header == null) {
      continue;
    }

    const openIndex = functionIndex + header[0].length - 1;
    const closeIndex = findMatchingBrace(source, openIndex);
    if (closeIndex >= index) {
      return {
        start: functionIndex,
        end: closeIndex + 1,
        text: source.slice(functionIndex, closeIndex + 1),
      };
    }
  }
  return null;
}

function applyPersistentStatusPanelPatch(source) {
  if (source.includes(STORAGE_KEY)) {
    return source;
  }

  if (!source.includes("composer.statusSlashCommand.description")) {
    console.warn("WARN: Could not find Codex status panel bundle marker - skipping persistent status panel patch");
    return source;
  }

  const statePattern = /\[([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\]=\(0,([A-Za-z_$][\w$]*)\.useState\)\(!1\)/gu;
  const candidates = [...source.matchAll(statePattern)].filter((candidate) => {
    const setter = candidate[2];
    const owner = findContainingFunction(source, candidate.index);
    return owner != null &&
      owner.text.includes(`setIsStatusMenuOpen:${setter}`) &&
      owner.text.includes(`onClose:()=>${setter}(!1)`);
  });
  if (candidates.length !== 1) {
    console.warn("WARN: Could not find Codex status panel state - skipping persistent status panel patch");
    return source;
  }

  const candidate = candidates[0];
  const [stateNeedle, isOpen, setIsOpen, reactModule] = candidate;
  const rawSetter = "codexLinuxSetPersistentStatusPanelOpenState";
  const replacement =
    `[${isOpen},${rawSetter}]=(0,${reactModule}.useState)(()=>{try{return localStorage.getItem(\`${STORAGE_KEY}\`)===\`1\`}catch{return!1}}),` +
    `${setIsOpen}=e=>{try{e?localStorage.setItem(\`${STORAGE_KEY}\`,\`1\`):localStorage.removeItem(\`${STORAGE_KEY}\`)}catch{}${rawSetter}(e)}`;
  return source.slice(0, candidate.index) + replacement +
    source.slice(candidate.index + stateNeedle.length);
}

const patches = [
  {
    id: "composer-status-state",
    phase: "webview-asset",
    order: 20_800,
    ciPolicy: "optional",
    pattern: /^app-primary-[^.]+\.js$/,
    missingDescription: "composer status panel bundle",
    skipDescription: "persistent status panel patch",
    apply: applyPersistentStatusPanelPatch,
  },
];

module.exports = {
  STORAGE_KEY,
  applyPersistentStatusPanelPatch,
  descriptors: patches,
};
