"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { extractedAppPatch } = require("../../scripts/patches/descriptor.js");

// The signed official package identifies itself as the upstream ChatGPT entry.
// Electron copies this value into CHROME_DESKTOP during startup, replacing the
// launcher's value, and Linux notifications send it as their desktop-entry.
const UPSTREAM_DESKTOP_NAME = "chatgpt.desktop";
const APP_ID_PATTERN = /^[A-Za-z0-9._-]+$/u;
const DESKTOP_NAME_FIELD = /("desktopName"\s*:\s*)"((?:[^"\\]|\\.)*)"/gu;

function resolveDesktopName(env = process.env) {
  const appId = env.CODEX_APP_ID || "codex-desktop";
  if (!APP_ID_PATTERN.test(appId)) {
    throw new Error("CODEX_APP_ID must contain only letters, numbers, dots, underscores, and hyphens");
  }
  return `${appId}.desktop`;
}

function sameExceptDesktopName(original, patched) {
  const { desktopName: _originalName, ...originalRest } = original;
  const { desktopName: _patchedName, ...patchedRest } = patched;
  return JSON.stringify(originalRest) === JSON.stringify(patchedRest);
}

// Rewrites only the desktopName string so the rest of the signed metadata keeps
// its exact bytes. Any other upstream shape is a drift and is reported unmatched.
function patchDesktopNameSource(source, desktopName) {
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    return { source, matched: 0, changed: 0, reason: "app package.json is not valid JSON" };
  }
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { source, matched: 0, changed: 0, reason: "app package.json is not a JSON object" };
  }
  if (parsed.desktopName === desktopName) {
    return { source, matched: 1, changed: 0 };
  }
  if (parsed.desktopName !== UPSTREAM_DESKTOP_NAME) {
    return {
      source,
      matched: 0,
      changed: 0,
      reason: `app package.json desktopName is not the upstream ${UPSTREAM_DESKTOP_NAME} contract`,
    };
  }

  const fields = [...source.matchAll(DESKTOP_NAME_FIELD)];
  if (fields.length !== 1) {
    return {
      source,
      matched: 0,
      changed: 0,
      reason: `expected one desktopName field in app package.json, found ${fields.length}`,
    };
  }
  const patched = source.replace(DESKTOP_NAME_FIELD, (_match, prefix) => `${prefix}${JSON.stringify(desktopName)}`);
  const reparsed = JSON.parse(patched);
  if (reparsed.desktopName !== desktopName || !sameExceptDesktopName(parsed, reparsed)) {
    return { source, matched: 0, changed: 0, reason: "desktopName rewrite changed other package metadata" };
  }
  return { source: patched, matched: 1, changed: 1 };
}

function patchPackageDesktopName(extractedDir, env = process.env) {
  const packageJsonPath = path.join(extractedDir, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    return { matched: 0, changed: 0, reason: "app package.json is missing" };
  }
  const desktopName = resolveDesktopName(env);
  const source = fs.readFileSync(packageJsonPath, "utf8");
  const result = patchDesktopNameSource(source, desktopName);
  if (result.changed === 1) {
    fs.writeFileSync(packageJsonPath, result.source, "utf8");
  }
  return { matched: result.matched, changed: result.changed, reason: result.reason ?? null, desktopName };
}

const descriptors = [
  extractedAppPatch({
    id: "package-desktop-name",
    phase: "extracted-app:pre-webview",
    order: 20_050,
    ciPolicy: "opt-in",
    targetSummary: "official app package.json desktopName",
    apply: (extractedDir) => patchPackageDesktopName(extractedDir),
    status: (result) => {
      if (result?.matched !== 1) {
        return { status: "skipped-optional", reason: result?.reason ?? null };
      }
      return result.changed === 1 ? "applied" : "already-applied";
    },
  }),
];

module.exports = {
  UPSTREAM_DESKTOP_NAME,
  descriptors,
  patchDesktopNameSource,
  patchPackageDesktopName,
  resolveDesktopName,
};
