"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { escapeRegExp } = require("../../scripts/patches/lib/minified-js.js");

const IDENT = "[A-Za-z_$][\\w$]*";
const MARKER = "codexLinuxUsageLimitSendAttempt";
const COMPOSER = new RegExp(
  `let\\{agentMode:${IDENT},permissionProfileId:${IDENT},shouldSendPermissionOverrides:${IDENT}\\}`,
);
const LOCAL_USAGE_GATE = new RegExp(
  `(?<flag>${IDENT})=\\(0,${IDENT}\\.${IDENT}\\)\\("local"===${IDENT}&&${IDENT}\\.${IDENT}\\)`,
  "g",
);

function usageLimitReasonContract(source, gate) {
  const after = source.slice(gate.index + gate[0].length, gate.index + gate[0].length + 20000);
  const flag = escapeRegExp(gate.groups.flag);
  const reason = [...after.matchAll(new RegExp(
    `(?<name>${IDENT})=${flag}&&"usage-limit";`,
    "g",
  ))];
  if (reason.length !== 1) return false;
  const reasonName = escapeRegExp(reason[0].groups.name);
  const reasons = [...after.matchAll(new RegExp(
    `(?<name>${IDENT})=\\[[^\\]]{0,1500}(?:^|,)${reasonName}\\]\\.filter\\(Boolean\\)`,
    "g",
  ))];
  if (reasons.length !== 1) return false;
  const reasonsName = escapeRegExp(reasons[0].groups.name);
  const joined = [...after.matchAll(new RegExp(
    `let (?<name>${IDENT})=${reasonsName}\\.join\\(","\\);`,
    "g",
  ))];
  return joined.length === 1 &&
    after.split(`submitDisabledReasons:${joined[0].groups.name}`).length === 2;
}

function applyUsageLimitSendAttemptPatch(source) {
  if (source.includes(MARKER)) return source;

  // Match the local Codex composer and the complete semantic path from the
  // account usage gate through its disabled-reason list and rendered prop.
  const rawGates = [...source.matchAll(LOCAL_USAGE_GATE)];
  if (rawGates.length !== 1) return source;
  const gates = rawGates.filter((gate) => {
    const before = source.slice(Math.max(0, gate.index - 1200), gate.index);
    if (!COMPOSER.test(before)) return false;

    return usageLimitReasonContract(source, gate);
  });
  if (gates.length !== 1) return source;

  const gate = gates[0];
  return source.slice(0, gate.index) + `${gate.groups.flag}=!1/*${MARKER}*/` +
    source.slice(gate.index + gate[0].length);
}

function applyUsageLimitSendAttemptAppPatch(extractedDir) {
  const assets = path.join(extractedDir, "webview", "assets", "async");
  if (!fs.existsSync(assets)) return { changed: 0, reason: "webview composer assets missing" };
  const candidates = [];
  for (const name of fs.readdirSync(assets)) {
    if (!name.endsWith(".js")) continue;
    const file = path.join(assets, name);
    const source = fs.readFileSync(file, "utf8");
    if (!COMPOSER.test(source) || !source.includes("submitDisabledReasons:")) continue;
    const patched = applyUsageLimitSendAttemptPatch(source);
    if (patched === source) {
      return { changed: 0, reason: "local Codex composer usage gate changed" };
    }
    candidates.push({ file, patched });
  }
  if (candidates.length === 0) return { changed: 0, reason: "local Codex composer usage gate changed" };
  for (const { file, patched } of candidates) fs.writeFileSync(file, patched);
  return {
    changed: candidates.length,
    targets: candidates.map(({ file }) => path.relative(extractedDir, file)),
  };
}

const descriptors = [{
  id: "usage-limit-send-attempt-ui",
  phase: "extracted-app:post-webview",
  order: 20560,
  ciPolicy: "optional",
  apply: applyUsageLimitSendAttemptAppPatch,
  status: (result) => result.changed > 0 ? "applied" : { status: "skipped-optional", reason: result.reason },
}];

module.exports = {
  applyUsageLimitSendAttemptPatch,
  applyUsageLimitSendAttemptAppPatch,
  descriptors,
};
