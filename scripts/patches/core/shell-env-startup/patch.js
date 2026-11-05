"use strict";

const fs = require("node:fs");
const path = require("node:path");

const {
  applyShellEnvironmentStartup,
  matchesShellEnvironment,
} = require("./shell-env.js");

function patchRequiredShellEnvironmentStartup(extractedDir) {
  const buildDir = path.join(extractedDir, ".vite", "build");
  const candidates = fs.readdirSync(buildDir)
    .filter((name) => name.endsWith(".js"))
    .sort()
    .map((name) => ({
      file: path.join(buildDir, name),
      source: fs.readFileSync(path.join(buildDir, name), "utf8"),
    }))
    .filter(({ source }) => matchesShellEnvironment(source));
  if (candidates.length !== 1) {
    throw new Error("Expected exactly one official shell environment module");
  }

  const [{ file, source }] = candidates;
  const patched = applyShellEnvironmentStartup(source);
  if (patched !== source) fs.writeFileSync(file, patched, "utf8");
  return { changed: patched !== source };
}

const descriptors = [{
  id: "shell-env-startup",
  phase: "extracted-app:pre-webview",
  ciPolicy: "required-upstream",
  apply: patchRequiredShellEnvironmentStartup,
}];

module.exports = {
  descriptors,
  patchRequiredShellEnvironmentStartup,
};
