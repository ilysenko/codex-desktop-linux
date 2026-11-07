"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { findMainProcessChunks } = require("../../scripts/patches/lib/assets.js");

const IDENT = String.raw`[A-Za-z_$][\w$]*`;
// The current main process has one reference to this rollout gate. Count it
// independently of reader syntax before validating the exact owner contract.
const CANDIDATE = /["']codex-app-server-custom-sections["']/g;
const READER = new RegExp(
  String.raw`read:(?<key>${IDENT})=>\((?<assertCurrent>${IDENT})\(\),"sidebarCustomSectionsEnabled"===\k<key>\)` +
    String.raw`\?null!=(?<accountId>${IDENT})\(\):(?<evaluations>${IDENT})\.getReadyClient\(\)` +
    String.raw`\?\.checkGate\("codex-app-server-custom-sections"\)(?<fallback>\?\?![01])?(?=\}\})`,
  "g",
);

function applyForkSidebarFallback(source) {
  const matches = [...source.matchAll(READER)];
  if ([...source.matchAll(CANDIDATE)].length !== 1 ||
      matches.length !== 1 || matches[0].groups.fallback === "??!0") {
    console.warn(
      "WARN: Expected one current fork sidebar settings reader - skipping fork sidebar fallback",
    );
    return source;
  }
  const [match] = matches;
  if (match.groups.fallback === "??!1") return source;

  // The renderer defaults this optional rollout to false. The background
  // reader otherwise returns undefined without a ready Statsig client, which
  // makes fork placement report execution-config-loading indefinitely.
  const end = match.index + match[0].length;
  return source.slice(0, end) + "??!1" + source.slice(end);
}

function patchExtractedApp(extractedDir) {
  const main = findMainProcessChunks(extractedDir);
  const candidates = (main?.chunks ?? []).map((name) => {
    const file = path.join(main.buildDir, name);
    const source = fs.readFileSync(file, "utf8");
    return { file, source, count: [...source.matchAll(CANDIDATE)].length };
  }).filter(({ count }) => count > 0);
  if (candidates.length !== 1 || candidates[0].count !== 1) {
    console.warn("WARN: Expected one fork sidebar settings reader across main-process chunks");
    return { matched: false, changed: false };
  }
  const [{ file, source }] = candidates;
  const matches = [...source.matchAll(READER)];
  if (matches.length !== 1 || matches[0].groups.fallback === "??!0") {
    console.warn("WARN: Fork sidebar settings reader contract changed");
    return { matched: false, changed: false };
  }
  const patched = applyForkSidebarFallback(source);
  if (patched !== source) fs.writeFileSync(file, patched, "utf8");
  return { matched: true, changed: patched !== source };
}

const descriptors = [{
  id: "sidebar-settings",
  phase: "extracted-app:pre-webview",
  ciPolicy: "optional",
  apply: patchExtractedApp,
  status: (result) => !result?.matched ? "skipped-optional" :
    result.changed ? "applied" : "already-applied",
}];

module.exports = { applyForkSidebarFallback, descriptors };
