"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { findMainProcessChunks } = require("../../lib/assets.js");
const { commitAssetEdits } = require("../../lib/asset-edits.js");
const { applyShellEnvironmentStartup, matchesShellEnvironment } = require("./shell-env.js");
const { mainProcessFactories } = require("../../lib/main-process-factories.js");

function patchShellEnvironmentStartup(extractedDir) {
  const inventory = findMainProcessChunks(extractedDir);
  if (!inventory) throw new Error("Missing official main-process shell environment inventory");
  const modules = inventory.chunks.map(assetName => ({
    assetName, source: fs.readFileSync(path.join(inventory.buildDir, assetName), "utf8"),
  }));
  const candidates = modules.filter(module => matchesShellEnvironment(module.source));
  if (candidates.length !== 1) throw new Error("Expected exactly one official shell environment asset");
  const [owner] = candidates;
  const patchedSource = applyShellEnvironmentStartup(owner.source);
  const identities = mainProcessFactories(owner.source).filter(module => matchesShellEnvironment(module.body));
  if (identities.length !== 1) throw new Error("Expected exactly one official shell environment module identity");
  const copies = modules.flatMap(module => mainProcessFactories(module.source)
    .filter(factory => factory.identity === identities[0].identity));
  if (copies.length !== 1) throw new Error("Duplicate or damaged official shell environment module");
  return { matched: 1, ...commitAssetEdits(inventory.buildDir, [{ ...owner, patchedSource }]) };
}

const descriptors = [{
  id: "shell-env-startup",
  phase: "extracted-app:pre-webview",
  ciPolicy: "required-upstream",
  apply: patchShellEnvironmentStartup,
}];

module.exports = { descriptors, patchShellEnvironmentStartup };
