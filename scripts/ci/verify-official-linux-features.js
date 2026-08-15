#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  discoverLinuxFeatureManifests,
  loadLinuxFeaturePatchDescriptors,
} = require("../lib/linux-features.js");
const { createPatchReport, enabledFeatureFailuresFromReport } = require("../lib/patch-report.js");
const { patchExtractedApp } = require("../patches/runner.js");

const source = process.argv[2];
if (!source || !fs.statSync(source, { throwIfNoEntry: false })?.isDirectory()) {
  console.error("Usage: verify-official-linux-features.js <extracted-official-app-asar>");
  process.exit(2);
}

const featuresRoot = path.resolve(__dirname, "../../linux-features");
const features = discoverLinuxFeatureManifests({ featuresRoot });
const featureMap = new Map(features.map((feature) => [feature.id, feature]));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "codex-official-feature-audit-"));
const failures = [];
let audited = 0;

try {
  for (const feature of features) {
    const enabled = [];
    const addWithRequirements = (id) => {
      if (enabled.includes(id)) return;
      const current = featureMap.get(id);
      if (current == null) throw new Error(`Missing required feature ${id}`);
      for (const required of current.manifest.requires) addWithRequirements(required);
      enabled.push(id);
    };
    addWithRequirements(feature.id);
    const internalFeatureIds = enabled.filter((id) => featureMap.get(id)?.manifest.internal === true);
    const config = path.join(work, `${feature.id}.json`);
    fs.writeFileSync(config, `${JSON.stringify({ enabled })}\n`);
    const descriptors = loadLinuxFeaturePatchDescriptors({
      featuresRoot,
      featuresConfigPath: config,
      internalFeatureIds,
    });
    if (!descriptors.some((descriptor) => descriptor.featureId === feature.id)) continue;

    const app = path.join(work, feature.id);
    fs.cpSync(source, app, { recursive: true, verbatimSymlinks: true });
    const report = createPatchReport();
    patchExtractedApp(app, {
      report,
      featuresRoot,
      featuresConfigPath: config,
      internalFeatureIds,
    });
    const featureFailures = enabledFeatureFailuresFromReport(report);
    audited += 1;
    if (featureFailures.length > 0) {
      failures.push({ featureId: feature.id, failures: featureFailures });
    }
    fs.rmSync(app, { recursive: true, force: true });
  }
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`Feature drift: ${failure.featureId}`);
    for (const entry of failure.failures) {
      console.error(`  ${entry.name}: ${entry.status}${entry.reason ? ` — ${entry.reason}` : ""}`);
    }
  }
  process.exit(1);
}

console.log(`Official Linux feature audit passed: ${audited} ASAR feature(s)`);
