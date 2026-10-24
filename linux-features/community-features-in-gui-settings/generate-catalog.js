"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { CATALOG_NAME, catalogFeatureFromManifest, validatePublicCatalog } = require("./catalog.js");

function generatePublicCatalog(featuresRoot = path.resolve(__dirname, ".."), onWarning = console.warn) {
  if (fs.existsSync(path.join(featuresRoot, "..", ".codex-linux/update-builder-manifest.txt"))) {
    throw Error("Public catalog generation requires the full source tree, not a minimal update-builder");
  }
  const features = [];
  // Never descend into local/. This publication step does not read private
  // manifests, enabled configuration, runtime state or feature implementations.
  for (const entry of fs.readdirSync(featuresRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name === "local" || entry.name.startsWith(".")) continue;
    const file = path.join(featuresRoot, entry.name, "feature.json");
    if (!fs.existsSync(file)) continue;
    const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    if (manifest.internal === true) continue;
    try {
      features.push(catalogFeatureFromManifest(manifest.id, manifest, "repo"));
    } catch (error) {
      onWarning(`WARN: community-features-in-gui-settings: skipping invalid catalog metadata in '${entry.name}': ${error.message}`);
    }
  }
  features.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return validatePublicCatalog({ schemaVersion: 1, sourceCommit: null, features });
}

function updatePublicCatalog({ featuresRoot = path.resolve(__dirname, ".."), output = path.join(__dirname, CATALOG_NAME), check = false } = {}) {
  const data = `${JSON.stringify(generatePublicCatalog(featuresRoot), null, 2)}\n`;
  if (check) {
    if (!fs.existsSync(output) || fs.readFileSync(output, "utf8") !== data) {
      throw Error("Public catalog is out of date; run node linux-features/community-features-in-gui-settings/generate-catalog.js");
    }
  } else fs.writeFileSync(output, data);
  return data;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--check") || args.length > 1) throw Error("Usage: generate-catalog.js [--check]");
  updatePublicCatalog({ check: args.includes("--check") });
}

module.exports = { generatePublicCatalog, updatePublicCatalog };
