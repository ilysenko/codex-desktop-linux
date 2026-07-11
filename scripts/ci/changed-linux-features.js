"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  discoverLinuxFeatureManifests,
  loadEnabledLinuxFeatures,
} = require("../lib/linux-features.js");

function repositoryFeatureDirectory(feature) {
  return ["linux-features", ...feature.relativeDir.split(/[\\/]+/)].join("/");
}

function changedRepositoryFeatureIds(changedPaths, features) {
  const featureByDirectory = new Map(
    features
      .filter((feature) => !feature.local)
      .map((feature) => [repositoryFeatureDirectory(feature), feature.id]),
  );
  const changed = new Set();
  for (const changedPath of changedPaths) {
    const normalized = String(changedPath).replaceAll("\\", "/").replace(/^\.\//, "");
    const parts = normalized.split("/");
    if (parts.length < 3 || parts[0] !== "linux-features" || parts[1] === "local") {
      continue;
    }
    const id = featureByDirectory.get(parts.slice(0, 2).join("/"));
    if (id != null) {
      changed.add(id);
    }
  }
  return [...changed].sort();
}

function expandedFeatureIds(initialIds, features) {
  const featureById = new Map(features.map((feature) => [feature.id, feature]));
  const enabled = new Set();
  function enable(id) {
    if (enabled.has(id)) {
      return;
    }
    const feature = featureById.get(id);
    if (feature == null) {
      throw new Error(`Linux feature '${id}' requires a feature that does not exist in this checkout`);
    }
    enabled.add(id);
    for (const required of feature.manifest.requires) {
      enable(required);
    }
  }
  for (const id of initialIds) {
    enable(id);
  }
  return [...enabled].sort();
}

function validateGeneratedConfig(config, options) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "changed-linux-features-config-"));
  const configPath = path.join(tempRoot, "features.json");
  try {
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    loadEnabledLinuxFeatures({ ...options, featuresConfigPath: configPath });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function configForChangedLinuxFeatures(changedPaths, options = {}) {
  const repositoryOptions = { ...options, includeLocal: false };
  const features = discoverLinuxFeatureManifests(repositoryOptions);
  const changedIds = changedRepositoryFeatureIds(changedPaths, features);
  const config = { enabled: expandedFeatureIds(changedIds, features) };
  validateGeneratedConfig(config, repositoryOptions);
  return config;
}

function writeChangedLinuxFeaturesConfig(outputPath, changedPaths, options = {}) {
  const config = configForChangedLinuxFeatures(changedPaths, options);
  const resolvedOutput = path.resolve(outputPath);
  const temporaryPath = `${resolvedOutput}.tmp-${process.pid}-${Date.now()}`;
  fs.mkdirSync(path.dirname(resolvedOutput), { recursive: true });
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`);
    fs.renameSync(temporaryPath, resolvedOutput);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
  return config;
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--output") {
      options.outputPath = argv[++index];
    } else if (argument === "--features-root") {
      options.featuresRoot = argv[++index];
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!options.outputPath) {
    throw new Error("Usage: changed-linux-features.js --output PATH [--features-root PATH]");
  }
  return options;
}

function main() {
  const { outputPath, featuresRoot } = parseArgs(process.argv.slice(2));
  const changedPaths = fs.readFileSync(0).toString("utf8").split("\0").filter(Boolean);
  const config = writeChangedLinuxFeaturesConfig(outputPath, changedPaths, {
    ...(featuresRoot ? { featuresRoot } : {}),
  });
  process.stdout.write(`Changed Linux Features enabled for upstream acceptance: ${config.enabled.join(", ") || "none"}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  changedRepositoryFeatureIds,
  configForChangedLinuxFeatures,
  expandedFeatureIds,
  writeChangedLinuxFeaturesConfig,
};
