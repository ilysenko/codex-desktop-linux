"use strict";

const fs = require("node:fs");
const path = require("node:path");

function applyLinuxMultiInstanceBootstrapPatch(currentSource) {
  const unguardedLock =
    "if(!(!S||n.app.requestSingleInstanceLock()))";
  const guardedLock =
    "if(!(!S||process.platform===`linux`&&process.env.CODEX_LINUX_MULTI_LAUNCH===`1`||n.app.requestSingleInstanceLock()))";
  const dynamicGuardedLockRegex =
    /if\(!\(!([A-Za-z_$][\w$]*)\|\|process\.platform===`linux`&&process\.env\.CODEX_LINUX_MULTI_LAUNCH===`1`\|\|([A-Za-z_$][\w$]*)\.app\.requestSingleInstanceLock\(\)\)\)/;
  const dynamicUnguardedLockRegex =
    /if\(!\(!([A-Za-z_$][\w$]*)\|\|([A-Za-z_$][\w$]*)\.app\.requestSingleInstanceLock\(\)\)\)/;

  if (currentSource.includes(guardedLock) || dynamicGuardedLockRegex.test(currentSource)) {
    return currentSource;
  }
  if (currentSource.includes(unguardedLock)) {
    return currentSource.replace(unguardedLock, guardedLock);
  }
  if (dynamicUnguardedLockRegex.test(currentSource)) {
    return currentSource.replace(
      dynamicUnguardedLockRegex,
      (_match, enabledVar, appVar) =>
        `if(!(!${enabledVar}||process.platform===\`linux\`&&process.env.CODEX_LINUX_MULTI_LAUNCH===\`1\`||${appVar}.app.requestSingleInstanceLock()))`,
    );
  }

  if (
    currentSource.includes("requestSingleInstanceLock") &&
    currentSource.includes("Exiting second desktop instance")
  ) {
    console.warn(
      "WARN: Could not find bootstrap single-instance lock — skipping Linux multi-instance bootstrap patch",
    );
  }
  return currentSource;
}

function patchLinuxMultiInstanceBootstrap(extractedDir) {
  const target = path.join(extractedDir, ".vite", "build", "bootstrap.js");
  if (!fs.existsSync(target)) {
    return { changed: false, reason: "bootstrap.js not found" };
  }

  const source = fs.readFileSync(target, "utf8");
  const patched = applyLinuxMultiInstanceBootstrapPatch(source);
  if (patched === source) {
    return { changed: false };
  }

  fs.writeFileSync(target, patched, "utf8");
  return { changed: true };
}

module.exports = {
  applyLinuxMultiInstanceBootstrapPatch,
  patchLinuxMultiInstanceBootstrap,
};
