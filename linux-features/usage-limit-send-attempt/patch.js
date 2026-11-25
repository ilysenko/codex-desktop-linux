"use strict";

const fs = require("node:fs");
const path = require("node:path");

const IDENT = "[A-Za-z_$][\\w$]*";
const MARKER = "codexLinuxUsageLimitSendAttempt";
const CURRENT_REASON_SELECTOR = new RegExp(
  `(?<selector>${IDENT})=\\(0,${IDENT}\\.${IDENT}\\)\\(${IDENT}\\.${IDENT},` +
    `\\((?<host>${IDENT}),\\{get:(?<get>${IDENT})\\}\\)=>` +
    `\\[\\k<get>\\(${IDENT}\\.${IDENT},\\k<host>\\)&&"reserve-limit",` +
    `"local"===\\k<host>&&\\k<get>\\((?<usage>${IDENT})\\)&&"usage-limit"\\]` +
    `\\.filter\\(Boolean\\)\\.join\\(","\\)\\)`,
  "gu",
);

function pristineContracts(source) {
  CURRENT_REASON_SELECTOR.lastIndex = 0;
  return [...source.matchAll(CURRENT_REASON_SELECTOR)];
}

function applyUsageLimitSendAttemptPatch(source) {
  const markerCount = source.split(MARKER).length - 1;
  const contracts = pristineContracts(source);
  if (markerCount === 1 && contracts.length === 0) return source;
  if (markerCount !== 0 || contracts.length !== 1) return source;
  const contract = contracts[0];
  const { host, get: getter, usage } = contract.groups;
  const gate = `"local"===${host}&&${getter}(${usage})&&"usage-limit"`;
  const gateIndex = contract.index + contract[0].indexOf(gate);
  if (gateIndex < contract.index) return source;
  return source.slice(0, gateIndex) + `!1/*${MARKER}*/` +
    source.slice(gateIndex + gate.length);
}

function applyUsageLimitSendAttemptAppPatch(extractedDir) {
  const assets = path.join(extractedDir, "webview", "assets", "async");
  if (!fs.existsSync(assets)) return { changed: 0, reason: "webview usage-reason assets missing" };
  const relevant = [];
  for (const name of fs.readdirSync(assets)) {
    if (!name.endsWith(".js")) continue;
    const file = path.join(assets, name);
    const source = fs.readFileSync(file, "utf8");
    if (!source.includes('"reserve-limit"') || !source.includes('"usage-limit"')) continue;
    relevant.push({ file, source });
  }
  if (relevant.length !== 1 || pristineContracts(relevant[0].source).length !== 1) {
    return { changed: 0, reason: "shared local usage-reason selector changed or is ambiguous" };
  }
  const patched = applyUsageLimitSendAttemptPatch(relevant[0].source);
  if (patched === relevant[0].source) {
    return { changed: 0, reason: "shared local usage-reason selector changed or is ambiguous" };
  }
  fs.writeFileSync(relevant[0].file, patched);
  return { changed: 1, targets: [path.relative(extractedDir, relevant[0].file)] };
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
