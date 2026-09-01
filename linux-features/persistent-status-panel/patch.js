"use strict";

const STORAGE_KEY = "codex-linux-persistent-status-panel-open";

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
    const tail = source.slice(candidate.index, candidate.index + 50_000);
    return tail.includes(`setIsStatusMenuOpen:${setter}`) &&
      tail.includes(`onClose:()=>${setter}(!1)`);
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
    pattern: /^app-initial-[^.]+\.js$/,
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
