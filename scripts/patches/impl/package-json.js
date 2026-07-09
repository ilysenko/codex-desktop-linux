"use strict";

const fs = require("node:fs");
const path = require("node:path");

// Package metadata patching is separate from ASAR bundle rewriting but shares
// the same patch report so rebuild inspection has one source of truth.
function patchPackageJson(extractedDir) {
  const packageJsonPath = path.join(extractedDir, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    return null;
  }

  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  const desktopName = resolveDesktopName();
  if (packageJson.desktopName !== desktopName) {
    packageJson.desktopName = desktopName;
    fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
  }
  return packageJson.desktopName;
}

function resolveDesktopName(env = process.env) {
  const appId = env.CODEX_APP_ID || "codex-desktop";
  if (!/^[A-Za-z0-9._-]+$/.test(appId)) {
    throw new Error("CODEX_APP_ID must contain only letters, numbers, dots, underscores, and hyphens");
  }
  return `${appId}.desktop`;
}

module.exports = {
  patchPackageJson,
  resolveDesktopName,
};
