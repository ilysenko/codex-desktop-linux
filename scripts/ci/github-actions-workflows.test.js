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
  const nixBuild = job(workflow, "nix-build");
  assert.match(nixBuild, /system: x86_64-linux/);
  assert.match(nixBuild, /system: aarch64-linux/);
  assert.match(nixBuild, /runner: ubuntu-24\.04-arm/);
  assert.match(nixBuild, /checks\.\$\{\{ matrix\.system \}\}\.modules/);
  assert.match(nixBuild, /nix-runtime-maximal-directory-watch/);
  assert.match(nixBuild, /nix-runtime-maximal-shallow-watch/);
  assert.match(nixBuild, /nix-installer/);

  const nixVm = job(workflow, "nix-vm");
  assert.match(nixVm, /checks\.x86_64-linux\.nixos-vm/);

  const nixGate = job(workflow, "nix");
  assert.match(nixGate, /if: \$\{\{ always\(\) \}\}/);
  assert.match(nixGate, /test "\$NIX_BUILD_RESULT" = success/);
  assert.match(nixGate, /test "\$NIX_VM_RESULT" = success/);
});

test("official Linux validation runs fully on every pull request but not hourly", () => {
  const workflow = read(".github/workflows/upstream-build-app.yml");
  assert.doesNotMatch(workflow, /^  schedule:/m);
  assert.match(workflow, /^  pull_request:\s*\n  push:/m);
  assert.match(workflow, /^      - \.github\/workflows\/upstream-build-app\.yml$/m);
  const signedBaseline = job(workflow, "signed-baseline");
  assert.match(signedBaseline, /architecture: \[amd64, arm64\]/);
  assert.match(
    signedBaseline,
    /name: Validate the Nix ELF contract against the official payload[\s\S]*?env:\n          CODEX_INSTALL_DIR:.*matrix\.architecture[\s\S]*?nix\/elf-runtime\.cjs fix[\s\S]*?nix\/elf-runtime\.cjs audit/,
  );
  assert.match(
    signedBaseline,
    /nix\/elf-runtime\.cjs validate-upstream[\s\S]*?--root "\$CODEX_INSTALL_DIR"[\s\S]*?--arch "\$\{\{ matrix\.architecture \}\}"/,
  );

  const packageMatrix = job(workflow, "package-matrix");
  assert.match(packageMatrix, /architecture: amd64/);
  assert.match(packageMatrix, /architecture: arm64/);
  assert.match(packageMatrix, /\.\/scripts\/build-deb\.sh/);
  assert.match(packageMatrix, /\.\/scripts\/build-rpm\.sh/);
  assert.match(packageMatrix, /\.\/scripts\/build-pacman\.sh/);
  assert.match(packageMatrix, /\.\/scripts\/build-appimage\.sh/);

  const dockFeatureAlone = job(workflow, "dock-icon-feature-alone");
  assert.match(
    dockFeatureAlone,
    /ref: \$\{\{ github\.event_name == 'pull_request' && github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/,
  );
  assert.match(dockFeatureAlone, /"enabled": \["ui-tweaks"\]/);
  assert.match(dockFeatureAlone, /"dockIcon": \{ "enabled": true \}/);
  assert.match(
    dockFeatureAlone,
    /--require-applied feature:ui-tweaks:appearance-dock-icon-main-process/,
  );
  assert.match(
    dockFeatureAlone,
    /--require-applied feature:ui-tweaks:appearance-dock-icon-settings-row/,
  );
  assert.match(dockFeatureAlone, /Expected Dock descriptors 2\/2 applied/);
  assert.match(dockFeatureAlone, /scripts\/lib\/upstream-linux-package\.js/);
  assert.match(
    dockFeatureAlone,
    /--key-base64 assets\/openai-codex-linux-repository-key\.gpg\.base64/,
  );
  assert.match(dockFeatureAlone, /\.\/install\.sh "\$package"/);
  assert.match(
    dockFeatureAlone,
    /find "\$payload" -mindepth 1 -maxdepth 1 -printf '%f\\n'/,
  );
  assert.doesNotMatch(dockFeatureAlone, /find "\$payload"[^\n]+-type f/);
  assert.match(dockFeatureAlone, /test ! -L "\$payload\/\$resource"/);
  for (const sourceComparison of [
    /cmp "\$upstream_root\/usr\/lib\/chatgpt\/resources\/icon-chatgpt\.png" "\$payload\/icon-chatgpt\.png"/,
    /cmp assets\/codex-linux\.png "\$payload\/icon-codex-dark-color\.png"/,
    /cmp assets\/codex-linux\.png "\$payload\/icon-codex-light\.png"/,
    /cmp linux-features\/ui-tweaks\/sync-desktop-icon\.sh "\$payload\/sync-desktop-icon\.sh"/,
    /cmp linux-features\/ui-tweaks\/sync-desktop-icon\.sh "\$hook"/,
  ]) {
    assert.match(dockFeatureAlone, sourceComparison);
  }
  assert.match(dockFeatureAlone, /test -x "\$payload\/sync-desktop-icon\.sh"/);
  assert.match(dockFeatureAlone, /ui-tweaks-dock-icon-cleanup\.sh/);
  assert.match(dockFeatureAlone, /test -x "\$hook"/);
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
    /^  official-linux-gate:\n    if: \$\{\{ always\(\) \}\}\n    needs:\n      - signed-baseline\n      - package-matrix\n      - dock-icon-feature-alone\n      - watchdog\n    runs-on:/,
  );

  for (const [dependency, resultVariable] of [
    ["signed-baseline", "SIGNED_BASELINE_RESULT"],
    ["package-matrix", "PACKAGE_MATRIX_RESULT"],
    ["dock-icon-feature-alone", "DOCK_ICON_FEATURE_ALONE_RESULT"],
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
  assert.match(workflow, /nix build \.#checks\.x86_64-linux\.nix-runtime --no-link/);
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
