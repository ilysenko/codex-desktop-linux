#!/usr/bin/env node
"use strict";

const {
  createPatchReport,
  criticalFailuresFromReport,
  writePatchReport,
} = require("./lib/patch-report.js");
const {
  patchExtractedApp,
} = require("./patches/runner.js");
const {
  createInventory,
  findPostPatchIntegrityFindings,
} = require("./lib/upstream-dmg-intel.js");

const USAGE = "Usage: patch-linux-window-ui.js [--report-json path] [--enforce-critical] <extracted-app-asar-dir>";

function main() {
  const args = process.argv.slice(2);
  let reportJson = null;
  let enforceCritical = false;
  const positional = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--report-json") {
      reportJson = args[index + 1];
      if (!reportJson) {
        console.error(USAGE);
        process.exit(1);
      }
      index += 1;
    } else if (arg === "--enforce-critical") {
      enforceCritical = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else {
      positional.push(arg);
    }
  }

  const extractedDir = positional[0];

  if (!extractedDir || positional.length > 1) {
    console.error(USAGE);
    process.exit(1);
  }

  // Enforcement needs the report data even when no --report-json was requested.
  const report = reportJson == null && !enforceCritical ? null : createPatchReport();
  patchExtractedApp(extractedDir, { report });
  if (report != null) {
    const inventory = createInventory({ sourcePath: extractedDir });
    const findings = findPostPatchIntegrityFindings(inventory);
    report.postPatchIntegrity = {
      sourcePath: extractedDir,
      findingCount: findings.length,
      findings,
    };
  }
  // Write the report before gating so CI artifact upload sees it even on failure.
  writePatchReport(reportJson, report);

  if (enforceCritical) {
    const failures = criticalFailuresFromReport(report);
    if (failures.length > 0) {
      console.error(`Critical patch failures (${failures.length}):`);
      for (const failure of failures) {
        console.error(`  - ${failure.name} (${failure.status})${failure.reason ? `: ${failure.reason}` : ""}`);
      }
      console.error(
        "Aborting: these patches are required for a working Linux app. " +
          "Set CODEX_ENFORCE_CRITICAL_PATCHES=0 to bypass (emergency builds only).",
      );
      process.exit(1);
    }
  }
}

if (require.main === module) {
  main();
}
