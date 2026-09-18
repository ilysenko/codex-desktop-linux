"use strict";

const TRAY_USAGE_ANCHOR =
  /getNativeTrayMenuItems\(\)\{let\{pinnedThreads:[A-Za-z_$][\w$]*,recentThreads:[A-Za-z_$][\w$]*,runningThreads:[A-Za-z_$][\w$]*,unreadThreads:[A-Za-z_$][\w$]*,usageLimits:([A-Za-z_$][\w$]*)\}=this\.trayMenuThreads,/g;
const TRAY_USAGE_WINDOW_LENGTH = 6_000;
const TRAY_USAGE_RETURN_BOUNDARY = ";return[";

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function trayUsageGates(source, patched) {
  if (typeof source !== "string") return [];
  TRAY_USAGE_ANCHOR.lastIndex = 0;
  const matches = [];

  for (const anchor of source.matchAll(TRAY_USAGE_ANCHOR)) {
    const usageLimitsAlias = anchor[1];
    const escapedUsageLimitsAlias = escapeRegExp(usageLimitsAlias);
    const platformGate = patched
      ? "process\\.platform!==`darwin`&&process\\.platform!==`linux`"
      : "process\\.platform!==`darwin`";
    const gatePattern = new RegExp(
      `([,\\[])${platformGate}\\|\\|${escapedUsageLimitsAlias}\\.length===0\\?\\[\\]:`,
    );
    const labelMapPattern = new RegExp(
      `${escapedUsageLimitsAlias}\\.map\\(\\(\\{label:([A-Za-z_$][\\w$]*)\\}\\)=>\\(\\{label:\\1,enabled:!1\\}\\)\\)`,
    );
    const windowStart = anchor.index + anchor[0].length;
    const window = source.slice(windowStart, windowStart + TRAY_USAGE_WINDOW_LENGTH);
    const returnBoundary = window.indexOf(TRAY_USAGE_RETURN_BOUNDARY);
    if (returnBoundary === -1) continue;
    const methodBody = window.slice(0, returnBoundary);
    const gate = gatePattern.exec(methodBody);
    if (gate == null) continue;
    const labelMapStart = gate.index + gate[0].length;
    const labelMap = labelMapPattern.exec(methodBody.slice(labelMapStart, labelMapStart + 700));
    if (labelMap == null) continue;
    matches.push({
      index: windowStart + gate.index,
      match: gate[0],
      prefix: gate[1],
      usageLimitsAlias,
    });
  }

  return matches;
}

function trayUsageMainContract(source) {
  const currentCount = trayUsageGates(source, false).length;
  const patchedCount = trayUsageGates(source, true).length;
  if (currentCount === 1 && patchedCount === 0) return "current";
  if (currentCount === 0 && patchedCount === 1) return "patched";
  return "drifted";
}

function applyTrayUsageMainPatch(source) {
  const contract = trayUsageMainContract(source);
  if (contract === "patched") return source;
  if (contract !== "current") {
    console.warn(
      "WARN: Could not find the current Linux tray-usage main-process contract - skipping tray usage patch",
    );
    return source;
  }

  const [{ index, match, prefix, usageLimitsAlias }] = trayUsageGates(source, false);
  const replacement = `${prefix}process.platform!==\`darwin\`&&process.platform!==\`linux\`||${usageLimitsAlias}.length===0?[]:`;
  const patched = `${source.slice(0, index)}${replacement}${source.slice(index + match.length)}`;
  if (trayUsageMainContract(patched) !== "patched") {
    console.warn(
      "WARN: Linux tray-usage main-process contract changed while patching - skipping tray usage patch",
    );
    return source;
  }
  return patched;
}

const descriptors = [
  {
    id: "linux-tray-usage-main-process",
    phase: "main-bundle",
    order: 20_960,
    ciPolicy: "optional",
    apply: applyTrayUsageMainPatch,
  },
];

module.exports = {
  applyTrayUsageMainPatch,
  descriptors,
  trayUsageMainContract,
};
