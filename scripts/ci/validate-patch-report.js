#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const {
  requiredPatchNamesForProfile,
} = require("../patches/registry.js");
const {
  SUCCESS_STATUSES,
  criticalFailuresFromReport,
  optionalDriftFromReport,
} = require("../lib/patch-report.js");

function usage() {
  return "Usage: validate-patch-report.js <patch-report.json> [--profile upstream-build]";
}

function parseArgs(argv) {
  let profile = "upstream-build";
  const positional = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--profile") {
      profile = argv[index + 1];
      if (!profile) {
        throw new Error(usage());
      }
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else {
      positional.push(arg);
    }
  }

  if (positional.length !== 1) {
    throw new Error(usage());
  }

  return { profile, reportPath: positional[0] };
}

function readReport(reportPath) {
  const raw = fs.readFileSync(reportPath, "utf8");
  const report = JSON.parse(raw);
  if (report == null || typeof report !== "object" || !Array.isArray(report.patches)) {
    throw new Error(`Invalid patch report: ${reportPath}`);
  }
  return report;
}

function validateReport(report, profile) {
  const requiredNames = requiredPatchNamesForProfile(profile);
  const patchesByName = new Map(report.patches.map((patch) => [patch.name, patch]));
  const failures = [];

  // A required patch that never ran leaves no report entry, so the
  // report-driven check below cannot see it — catch it by name first.
  for (const name of requiredNames) {
    if (!patchesByName.has(name)) {
      failures.push(`${name}: missing from patch report`);
    }
  }

  // Shared predicate with the local build gate (patch-linux-window-ui.js
  // --enforce-critical): any recorded critical patch with a non-success,
  // applicable status fails validation.
  for (const failure of criticalFailuresFromReport(report)) {
    failures.push(`${failure.name}: ${failure.status}${failure.reason ? ` (${failure.reason})` : ""}`);
  }

  return failures;
}

function printOptionalDrift(report) {
  const drift = optionalDriftFromReport(report);
  if (drift.length === 0) {
    return;
  }
  console.warn(`Optional patch drift (${drift.length}, non-failing):`);
  for (const item of drift) {
    console.warn(`- ${item.name}: ${item.status}${item.reason ? ` (${item.reason})` : ""}`);
  }
}

function main() {
  try {
    const { profile, reportPath } = parseArgs(process.argv.slice(2));
    const report = readReport(reportPath);
    printOptionalDrift(report);
    const failures = validateReport(report, profile);
    if (failures.length > 0) {
      console.error(`Required patch validation failed for profile ${profile}:`);
      for (const failure of failures) {
        console.error(`- ${failure}`);
      }
      process.exit(1);
    }
    console.log(`Required patch validation passed for profile ${profile}.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  SUCCESS_STATUSES,
  readReport,
  validateReport,
};
