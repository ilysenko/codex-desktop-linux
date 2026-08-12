"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "../..");

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function job(workflow, jobName) {
  const lines = workflow.split("\n");
  const start = lines.findIndex((line) => line === `  ${jobName}:`);
  assert.notEqual(start, -1, `expected ${jobName} job`);
  const end = lines.findIndex(
    (line, index) => index > start && /^  [a-zA-Z0-9_-]+:$/.test(line),
  );
  return lines.slice(start, end === -1 ? undefined : end).join("\n");
}

test("CI runs the complete workflow regression suite", () => {
  const workflow = read(".github/workflows/ci.yml");
  assert.match(workflow, /node --test scripts\/ci\/\*\.test\.js/);
});

test("official Linux validation runs fully on every pull request but not hourly", () => {
  const workflow = read(".github/workflows/upstream-build-app.yml");
  assert.doesNotMatch(workflow, /^  schedule:/m);
  assert.match(workflow, /^  pull_request:\s*\n  push:/m);
  assert.match(workflow, /^      - \.github\/workflows\/upstream-build-app\.yml$/m);
  assert.match(job(workflow, "signed-baseline"), /architecture: \[amd64, arm64\]/);

  const packageMatrix = job(workflow, "package-matrix");
  assert.match(packageMatrix, /architecture: amd64/);
  assert.match(packageMatrix, /architecture: arm64/);
  assert.match(packageMatrix, /\.\/scripts\/build-deb\.sh/);
  assert.match(packageMatrix, /\.\/scripts\/build-rpm\.sh/);
  assert.match(packageMatrix, /\.\/scripts\/build-pacman\.sh/);
  assert.match(packageMatrix, /\.\/scripts\/build-appimage\.sh/);
});

test("official Linux metadata expires after seven days", () => {
  const workflow = read(".github/workflows/upstream-build-app.yml");
  const signedBaseline = job(workflow, "signed-baseline");
  assert.match(signedBaseline, /name: official-linux-\$\{\{ matrix\.architecture \}\}-metadata/);
  assert.match(signedBaseline, /retention-days: 7/);
});

test("official Linux gate fails closed unless every dependency succeeds", () => {
  const workflow = read(".github/workflows/upstream-build-app.yml");
  const gate = job(workflow, "official-linux-gate");
  assert.match(
    gate,
    /^  official-linux-gate:\n    if: \$\{\{ always\(\) \}\}\n    needs:\n      - signed-baseline\n      - package-matrix\n      - watchdog\n    runs-on:/,
  );

  for (const [dependency, resultVariable] of [
    ["signed-baseline", "SIGNED_BASELINE_RESULT"],
    ["package-matrix", "PACKAGE_MATRIX_RESULT"],
    ["watchdog", "WATCHDOG_RESULT"],
  ]) {
    assert.match(
      gate,
      new RegExp(
        `^          ${resultVariable}: \\$\\{\\{ needs\\.${dependency}\\.result \\}\\}$`,
        "m",
      ),
    );
    assert.match(
      gate,
      new RegExp(`^          test "\\$${resultVariable}" = success$`, "m"),
    );
  }
});

test("Nix pin refresh is watchdog-dispatched and campaign-bound", () => {
  const workflow = read(".github/workflows/update-official-linux-pins.yml");
  assert.doesNotMatch(workflow, /^  schedule:/m);
  for (const input of [
    "release_id",
    "expected_main_sha",
    "version",
    "amd64_repository_path",
    "amd64_sha256",
    "arm64_repository_path",
    "arm64_sha256",
  ]) {
    assert.match(workflow, new RegExp(`^      ${input}:$`, "m"));
  }
  assert.match(workflow, /^  actions: write$/m);
  assert.match(workflow, /Require the accepted commit to be current main/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /gh api "repos\/\$GITHUB_REPOSITORY\/commits\/main" --jq \.sha/);
  assert.match(workflow, /ref: \$\{\{ inputs\.expected_main_sha \}\}/);
  assert.match(workflow, /codex\/official-linux-pins-\$\{RELEASE_ID:0:12\}/);
  assert.match(workflow, /dispatch_if_missing ci\.yml/);
  assert.match(workflow, /dispatch_if_missing upstream-build-app\.yml/);
  assert.match(workflow, /Official-Linux-Release-ID:/);
  assert.match(workflow, /--force-with-lease=refs\/heads\/\$branch:\$remote_head/);
  assert.match(workflow, /git rev-parse 'FETCH_HEAD\^\{tree\}'/);
  assert.match(workflow, /--head "\$GITHUB_REPOSITORY_OWNER:\$branch"/);
});

test("manual official Linux validation accepts an exact campaign", () => {
  const workflow = read(".github/workflows/upstream-build-app.yml");
  assert.match(workflow, /run-name:.*Official Linux campaign.*inputs\.release_id/);
  for (const input of ["release_id", "version", "amd64_sha256", "arm64_sha256"]) {
    assert.match(workflow, new RegExp(`^      ${input}:$`, "m"));
  }
  assert.equal((workflow.match(/^        required: true$/gm) || []).length, 6);
  assert.match(workflow, /Require the dispatched signed campaign/);
  assert.match(workflow, /resolved signed package does not match the dispatched campaign/);
  assert.match(workflow, /Resolve and bind the two-architecture campaign/);
  assert.match(workflow, /actual\.releaseId !== expected\.EXPECTED_RELEASE_ID/);
  const packageMatrix = job(workflow, "package-matrix");
  assert.match(packageMatrix, /Resolve exact package matrix input/);
  assert.match(packageMatrix, /package matrix input does not match the dispatched campaign/);
  assert.match(packageMatrix, /\.\/install\.sh "\$\{\{ steps\.upstream\.outputs\.package \}\}"/);
});
