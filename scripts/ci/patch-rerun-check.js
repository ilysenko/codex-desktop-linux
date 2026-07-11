#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { readPatchReport } = require("../lib/patch-validation.js");

const USAGE = `Usage: scripts/ci/patch-rerun-check.js \\
  --app PATH --patcher PATH --first-report PATH --second-report PATH --output PATH`;

function parseArgs(argv) {
  const options = {};
  const valueOptions = new Map([
    ["--app", "appDir"],
    ["--patcher", "patcherPath"],
    ["--first-report", "firstReportPath"],
    ["--second-report", "secondReportPath"],
    ["--output", "outputPath"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (valueOptions.has(arg)) {
      const value = argv[++index];
      if (!value) throw new Error(`${arg} requires a value`);
      options[valueOptions.get(arg)] = value;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function hashFile(hash, filePath) {
  const descriptor = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

function hashTree(rootPath) {
  const root = path.resolve(rootPath);
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`Extracted app path must be a real directory: ${root}`);
  }

  const hash = crypto.createHash("sha256");
  const visit = (directory, relativeDirectory = "") => {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.posix.join(relativeDirectory, entry.name);
      const stat = fs.lstatSync(absolutePath);
      const mode = (stat.mode & 0o7777).toString(8);
      if (stat.isDirectory()) {
        hash.update(`directory\0${relativePath}\0${mode}\0`);
        visit(absolutePath, relativePath);
      } else if (stat.isFile()) {
        hash.update(`file\0${relativePath}\0${mode}\0${stat.size}\0`);
        hashFile(hash, absolutePath);
        hash.update("\0");
      } else if (stat.isSymbolicLink()) {
        hash.update(`symlink\0${relativePath}\0${mode}\0${fs.readlinkSync(absolutePath)}\0`);
      } else {
        hash.update(`special\0${relativePath}\0${mode}\0${stat.mode}\0`);
      }
    }
  };
  visit(root);
  return hash.digest("hex");
}

function isInside(parentPath, candidatePath) {
  const relative = path.relative(path.resolve(parentPath), path.resolve(candidatePath));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function canonicalOutputPath(filePath) {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  return path.join(fs.realpathSync(path.dirname(resolved)), path.basename(resolved));
}

function rejectSymbolicLink(filePath, label) {
  try {
    if (fs.lstatSync(filePath).isSymbolicLink()) {
      throw new Error(`${label} must not be a symbolic link`);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function patchMatrix(firstReport, secondReport, treeHashBefore, treeHashAfter) {
  const firstPatches = firstReport.patches ?? [];
  const secondPatches = secondReport.patches ?? [];
  const firstByName = new Map(firstPatches.map((entry) => [entry.name, entry]));
  const secondByName = new Map(secondPatches.map((entry) => [entry.name, entry]));
  const duplicateNames = (patches) => {
    const seen = new Set();
    const duplicates = new Set();
    for (const patch of patches) {
      if (seen.has(patch.name)) duplicates.add(patch.name);
      seen.add(patch.name);
    }
    return [...duplicates].sort();
  };
  const duplicateFirstPass = duplicateNames(firstPatches);
  const duplicateSecondPass = duplicateNames(secondPatches);
  const names = [...new Set([...firstByName.keys(), ...secondByName.keys()])].sort();
  const firstFeatures = Array.isArray(firstReport.enabledFeatures)
    ? [...new Set(firstReport.enabledFeatures)].sort()
    : [];
  const secondFeatures = Array.isArray(secondReport.enabledFeatures)
    ? [...new Set(secondReport.enabledFeatures)].sort()
    : [];
  const missingFromSecondPass = [...firstByName.keys()]
    .filter((name) => !secondByName.has(name))
    .sort();
  const unexpectedOnSecondPass = [...secondByName.keys()]
    .filter((name) => !firstByName.has(name))
    .sort();
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    enabledFeatures: firstFeatures,
    secondPassEnabledFeatures: secondFeatures,
    featureSetStable: JSON.stringify(firstFeatures) === JSON.stringify(secondFeatures),
    descriptorSetStable: missingFromSecondPass.length === 0
      && unexpectedOnSecondPass.length === 0
      && duplicateFirstPass.length === 0
      && duplicateSecondPass.length === 0,
    duplicateFirstPass,
    duplicateSecondPass,
    missingFromSecondPass,
    unexpectedOnSecondPass,
    treeHashBefore,
    treeHashAfter,
    idempotent: treeHashBefore === treeHashAfter,
    patches: names.map((name) => ({
      name,
      firstStatus: firstByName.get(name)?.status ?? "missing",
      secondStatus: secondByName.get(name)?.status ?? "missing",
    })),
  };
}

function runPatchRerunCheck(options) {
  const required = ["appDir", "patcherPath", "firstReportPath", "secondReportPath", "outputPath"];
  for (const name of required) {
    if (!options[name]) throw new Error(`${name} is required`);
  }

  const appDir = fs.realpathSync(path.resolve(options.appDir));
  const firstReportPath = fs.realpathSync(path.resolve(options.firstReportPath));
  const secondReportPath = canonicalOutputPath(options.secondReportPath);
  const outputPath = canonicalOutputPath(options.outputPath);
  rejectSymbolicLink(secondReportPath, "Second patch report");
  rejectSymbolicLink(outputPath, "Patch matrix output");
  if ([firstReportPath, secondReportPath, outputPath].some((candidate) => isInside(appDir, candidate))) {
    throw new Error("Patch reports and matrix output must stay outside the extracted app directory");
  }
  if (new Set([firstReportPath, secondReportPath, outputPath]).size !== 3) {
    throw new Error("First report, second report, and matrix output must use different paths");
  }

  const firstReport = readPatchReport(firstReportPath);
  const treeHashBefore = hashTree(appDir);
  fs.mkdirSync(path.dirname(secondReportPath), { recursive: true });
  fs.rmSync(secondReportPath, { force: true });
  const child = spawnSync(process.execPath, [
    path.resolve(options.patcherPath),
    "--report-json",
    secondReportPath,
    appDir,
  ], { stdio: "inherit" });
  if (child.error) throw child.error;
  if (child.signal) {
    throw new Error(`Second patch pass terminated by signal ${child.signal}`);
  }
  if (child.status !== 0) {
    throw new Error(`Second patch pass exited with status ${child.status}`);
  }

  const secondReport = readPatchReport(secondReportPath);
  const treeHashAfter = hashTree(appDir);
  const matrix = patchMatrix(firstReport, secondReport, treeHashBefore, treeHashAfter);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.rmSync(outputPath, { force: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(matrix, null, 2)}\n`, "utf8");
  if (!matrix.idempotent) {
    throw new Error("Second patch pass changed the extracted app tree");
  }
  if (!matrix.featureSetStable) {
    throw new Error("Second patch pass changed the enabled feature set");
  }
  if (!matrix.descriptorSetStable) {
    throw new Error("Second patch pass changed the patch descriptor set");
  }
  return matrix;
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  runPatchRerunCheck(options);
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

module.exports = {
  hashTree,
  main,
  parseArgs,
  patchMatrix,
  runPatchRerunCheck,
};
