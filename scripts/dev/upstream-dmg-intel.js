#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { buildIntelReports } = require("../lib/upstream-dmg-intel.js");

const repoRoot = path.resolve(__dirname, "../..");
const defaultRegistryPath = path.join(__dirname, "upstream-dmg-protected-surfaces.json");
const BLOCKING_CLASSIFICATIONS = new Set([
  "REMOVED",
  "PATCH_BROKEN",
  "PATCH_INTEGRITY_BROKEN",
  "LINUX_SUBSTRATE_GAP",
  "PROTECTED_SURFACE_PARTIAL",
  "PROTECTED_SURFACE_MISSING",
]);

function usage() {
  return `Usage: scripts/dev/upstream-dmg-intel.js --candidate PATH [options]

Build an upstream DMG intelligence report without mutating codex-app/.

Options:
  --candidate PATH       Candidate Codex.dmg, extracted .app, or extracted app resources directory
  --baseline PATH        Optional known-good baseline DMG or extracted .app; defaults to ./Codex.dmg when different
  --no-baseline          Do a candidate-only scan even when ./Codex.dmg exists
  --patch-report PATH    Optional patch-report.json to fold patch blockers/review items into drift-report.json
  --registry PATH        Protected surface registry (default: scripts/dev/upstream-dmg-protected-surfaces.json)
  --output-dir DIR       Exact output directory (default: reports/upstream-dmg/<timestamp>)
  --timestamp VALUE      Timestamp slug used when --output-dir is omitted
  --fail-on-blockers     Exit nonzero when protected-surface acceptance blockers are present
  -h, --help             Show this help
`;
}

function parseArgs(argv) {
  const args = {
    autoBaseline: true,
    baselinePath: null,
    candidatePath: null,
    outputDir: null,
    failOnBlockers: false,
    patchReportPath: null,
    registryPath: defaultRegistryPath,
    timestamp: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--candidate") {
      args.candidatePath = argv[++index];
    } else if (arg === "--baseline") {
      args.baselinePath = argv[++index];
    } else if (arg === "--no-baseline") {
      args.autoBaseline = false;
      args.baselinePath = null;
    } else if (arg === "--patch-report") {
      args.patchReportPath = argv[++index];
    } else if (arg === "--registry") {
      args.registryPath = argv[++index];
    } else if (arg === "--output-dir") {
      args.outputDir = argv[++index];
    } else if (arg === "--timestamp") {
      args.timestamp = argv[++index];
    } else if (arg === "--fail-on-blockers") {
      args.failOnBlockers = true;
    } else if (arg === "-h" || arg === "--help") {
      args.help = true;
    } else if (!arg.startsWith("-") && args.candidatePath == null) {
      args.candidatePath = arg;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function requireReadable(label, filePath) {
  if (filePath == null) {
    throw new Error(`${label} is required`);
  }
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} not found: ${filePath}`);
  }
}

function statusCounts(surfaces = []) {
  const counts = {};
  for (const surface of surfaces) {
    counts[surface.status] = (counts[surface.status] ?? 0) + 1;
  }
  return counts;
}

function buildDecision({ driftReport, protectedSurfaces }) {
  const surfaceDrift = driftReport.surfaceDrift ?? [];
  const blockers = surfaceDrift.filter((item) => BLOCKING_CLASSIFICATIONS.has(item.classification));
  const reviewItems = surfaceDrift.filter((item) => !BLOCKING_CLASSIFICATIONS.has(item.classification));
  const protectedSurfaceStatusCounts = statusCounts(protectedSurfaces.surfaces ?? []);
  const allProtectedSurfacesPresent =
    (protectedSurfaces.surfaces ?? []).length > 0 &&
    (protectedSurfaces.surfaces ?? []).every((surface) => surface.status === "PRESENT");
  const acceptance = blockers.length > 0 ? "blocked" : (reviewItems.length > 0 ? "review" : "accepted");

  return {
    acceptance,
    blockersCount: blockers.length,
    reviewItemsCount: reviewItems.length,
    allProtectedSurfacesPresent,
    protectedSurfaceStatusCounts,
    blockerClassifications: [...new Set(blockers.map((item) => item.classification))].sort(),
  };
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(usage());
    return 0;
  }

  requireReadable("Candidate", args.candidatePath);
  requireReadable("Registry", args.registryPath);
  if (args.baselinePath != null) {
    requireReadable("Baseline", args.baselinePath);
  }
  if (args.patchReportPath != null) {
    requireReadable("Patch report", args.patchReportPath);
  }

  const registry = JSON.parse(fs.readFileSync(args.registryPath, "utf8"));
  const reports = buildIntelReports({
    autoBaseline: args.autoBaseline,
    baselinePath: args.baselinePath,
    candidatePath: args.candidatePath,
    outputDir: args.outputDir,
    patchReportPath: args.patchReportPath,
    registry,
    repoRoot,
    timestamp: args.timestamp,
  });
  const decision = buildDecision({
    driftReport: reports.driftReport,
    protectedSurfaces: reports.protectedSurfaces,
  });

  const summary = {
    outputDir: reports.outputDir,
    inventory: path.join(reports.outputDir, "inventory.json"),
    protectedSurfaces: path.join(reports.outputDir, "protected-surfaces.json"),
    driftReport: path.join(reports.outputDir, "drift-report.json"),
    driftMarkdown: path.join(reports.outputDir, "drift-report.md"),
    substrateActionPlan: path.join(reports.outputDir, "substrate-action-plan.md"),
    baselineSource: reports.driftReport.baselineSource,
    classificationCounts: reports.driftReport.classificationCounts,
    decision,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (args.failOnBlockers && decision.blockersCount > 0) {
    console.error(
      `Upstream DMG intelligence found ${decision.blockersCount} protected-surface acceptance blocker(s).`,
    );
    return 2;
  }
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error.message);
    console.error("");
    console.error(usage());
    process.exitCode = 1;
  }
}

module.exports = { buildDecision, main, parseArgs };
