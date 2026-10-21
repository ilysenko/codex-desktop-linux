"use strict";

const fs = require("node:fs");
const path = require("node:path");

function requireSafeOfficialAppRoot(candidate, label) {
  const appRoot = path.resolve(candidate);
  const rootStat = fs.lstatSync(appRoot, { throwIfNoEntry: false });
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`${label} is missing or unsafe: ${appRoot}`);
  }
  for (const [relativePath, executable] of [
    ["ChatGPT", true],
    [path.join("resources", "app.asar"), false],
  ]) {
    const target = path.join(appRoot, relativePath);
    const stat = fs.lstatSync(target, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.isSymbolicLink() || (executable && (stat.mode & 0o111) === 0)) {
      throw new Error(`${label} has a missing or unsafe ${relativePath}: ${target}`);
    }
  }
  return appRoot;
}

function resolveOfficialAppRoot(extractedAsar, explicitAppRoot) {
  if (explicitAppRoot != null && explicitAppRoot !== "") {
    return requireSafeOfficialAppRoot(explicitAppRoot, "Official app root");
  }
  const watchdogAppRoot = path.join(
    path.dirname(path.resolve(extractedAsar)),
    "upstream",
    "usr",
    "lib",
    "chatgpt",
  );
  return requireSafeOfficialAppRoot(
    watchdogAppRoot,
    "Adjacent verified-package app root",
  );
}

module.exports = {
  requireSafeOfficialAppRoot,
  resolveOfficialAppRoot,
};
