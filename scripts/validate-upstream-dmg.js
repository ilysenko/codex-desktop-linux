#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { decisionMarkdown, evaluateUpstreamDmg } = require("./lib/upstream-dmg-acceptance.js");

function usage() {
  return `Usage: scripts/validate-upstream-dmg.js --dmg PATH --core-report PATH [options]

Options:
  --build-info PATH
  --metadata PATH
  --build-status success|failure
  --output PATH
  --summary PATH
  --source local|github-actions
  --run-id VALUE
  --run-attempt VALUE
  --run-url URL
  --require-enabled-feature FEATURE_ID
  --require-success PATCH_NAME
  --require-applied PATCH_NAME
  --enforce
`;
}

function parseArgs(argv) {
  const args = {
    buildStatus: "unknown",
    source: "local",
    requirements: {
      requiredAppliedPatches: [],
      requiredEnabledFeatures: [],
      requiredSuccessfulPatches: [],
    },
  };
  const valueOptions = new Map([
    ["--dmg", "dmgPath"], ["--core-report", "coreReportPath"],
    ["--build-info", "buildInfoPath"],
    ["--metadata", "metadataPath"], ["--build-status", "buildStatus"],
    ["--output", "outputPath"],
    ["--summary", "summaryPath"], ["--source", "source"], ["--run-id", "runId"],
    ["--run-attempt", "runAttempt"], ["--run-url", "runUrl"], ["--repo-root", "repoRoot"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--enforce") {
      args.enforce = true;
    } else if (arg === "--require-enabled-feature") {
      const value = argv[++index];
      if (!value) throw new Error(`${arg} requires a value`);
      args.requirements.requiredEnabledFeatures.push(value);
    } else if (arg === "--require-success") {
      const value = argv[++index];
      if (!value) throw new Error(`${arg} requires a value`);
      args.requirements.requiredSuccessfulPatches.push(value);
    } else if (arg === "--require-applied") {
      const value = argv[++index];
      if (!value) throw new Error(`${arg} requires a value`);
      args.requirements.requiredAppliedPatches.push(value);
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (valueOptions.has(arg)) {
      const value = argv[++index];
      if (!value) throw new Error(`${arg} requires a value`);
      args[valueOptions.get(arg)] = value;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  for (const name of Object.keys(args.requirements)) {
    args.requirements[name] = [...new Set(args.requirements[name])];
  }
  return args;
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(usage());
    return 0;
  }
  if (!args.dmgPath || !args.coreReportPath || !args.outputPath) {
    throw new Error(usage());
  }
  const decision = evaluateUpstreamDmg(args);
  fs.mkdirSync(path.dirname(args.outputPath), { recursive: true });
  fs.writeFileSync(args.outputPath, `${JSON.stringify(decision, null, 2)}\n`, "utf8");
  if (args.summaryPath) {
    fs.appendFileSync(args.summaryPath, decisionMarkdown(decision), "utf8");
  }
  process.stdout.write(`${JSON.stringify(decision, null, 2)}\n`);
  if (args.enforce && decision.verdict === "rejected") return 2;
  if (args.enforce && decision.verdict === "inconclusive") return 3;
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

module.exports = { main, parseArgs };
