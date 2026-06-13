"use strict";

const fs = require("node:fs");
const path = require("node:path");

// Upstream gates the bootstrap single-instance lock behind a flag computed
// from {isMacOS, isPackaged}, which is always false on Linux — so the stock
// `!flag ||` short-circuit skips requestSingleInstanceLock() entirely and
// Linux gets no duplicate-instance protection. Rewrite the gate so Linux
// always takes the lock (unless an explicit CODEX_LINUX_MULTI_LAUNCH=1
// side-by-side launch opts out) while other platforms keep upstream
// semantics. Shapes handled, with minified variable names captured
// dynamically (enabled flag, electron namespace):
//   upstream:  if(!(!S||n.app.requestSingleInstanceLock()))
//   legacy:    if(!(!S||process.platform===`linux`&&process.env.CODEX_LINUX_MULTI_LAUNCH===`1`||n.app.requestSingleInstanceLock()))
//   enforced:  if(!(process.platform===`linux`?process.env.CODEX_LINUX_MULTI_LAUNCH===`1`||n.app.requestSingleInstanceLock():!S||n.app.requestSingleInstanceLock()))
const enforcedLockRegex =
  /if\(!\(process\.platform===`linux`\?process\.env\.CODEX_LINUX_MULTI_LAUNCH===`1`\|\|([A-Za-z_$][\w$]*)\.app\.requestSingleInstanceLock\(\):!([A-Za-z_$][\w$]*)\|\|\1\.app\.requestSingleInstanceLock\(\)\)\)/;
const legacyGuardedLockRegex =
  /if\(!\(!([A-Za-z_$][\w$]*)\|\|process\.platform===`linux`&&process\.env\.CODEX_LINUX_MULTI_LAUNCH===`1`\|\|([A-Za-z_$][\w$]*)\.app\.requestSingleInstanceLock\(\)\)\)/;
const unguardedLockRegex =
  /if\(!\(!([A-Za-z_$][\w$]*)\|\|([A-Za-z_$][\w$]*)\.app\.requestSingleInstanceLock\(\)\)\)/;

function enforcedLockCondition(enabledVar, appVar) {
  return (
    "if(!(process.platform===`linux`?process.env.CODEX_LINUX_MULTI_LAUNCH===`1`||" +
    `${appVar}.app.requestSingleInstanceLock():!${enabledVar}||` +
    `${appVar}.app.requestSingleInstanceLock()))`
  );
}

function applyLinuxMultiInstanceBootstrapPatch(currentSource) {
  if (enforcedLockRegex.test(currentSource)) {
    return currentSource;
  }
  if (legacyGuardedLockRegex.test(currentSource)) {
    return currentSource.replace(
      legacyGuardedLockRegex,
      (_match, enabledVar, appVar) => enforcedLockCondition(enabledVar, appVar),
    );
  }
  if (unguardedLockRegex.test(currentSource)) {
    return currentSource.replace(
      unguardedLockRegex,
      (_match, enabledVar, appVar) => enforcedLockCondition(enabledVar, appVar),
    );
  }

  if (
    currentSource.includes("requestSingleInstanceLock") &&
    currentSource.includes("Exiting second desktop instance")
  ) {
    console.warn(
      "WARN: Could not find bootstrap single-instance lock — Linux builds would allow unbounded duplicate instances",
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
