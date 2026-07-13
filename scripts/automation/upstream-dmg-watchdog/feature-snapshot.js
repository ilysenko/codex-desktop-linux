#!/usr/bin/env node
"use strict";

const path = require("node:path");
const fs = require("node:fs");

const {
  enabledLinuxFeaturesConfig,
  loadEnabledLinuxFeatures,
} = require("../../lib/linux-features.js");

function main() {
  const checkout = process.argv[2];
  if (!checkout) {
    throw new Error("usage: feature-snapshot.js CHECKOUT");
  }
  const sourceCheckout = path.resolve(checkout);
  const featuresRoot = path.join(sourceCheckout, "linux-features");
  const config = enabledLinuxFeaturesConfig({ featuresRoot });
  const features = loadEnabledLinuxFeatures({ featuresRoot });
  process.stdout.write(`${JSON.stringify({
    sourceCheckout,
    featuresRoot,
    config,
    hasLocalConfig: fs.existsSync(path.join(featuresRoot, "features.json")),
    enabled: features.map((feature) => feature.id),
    local: features
      .filter((feature) => feature.local)
      .map((feature) => ({ id: feature.id, dir: feature.dir })),
  }, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  console.error(`ERROR: ${error.message}`);
  process.exit(1);
}
