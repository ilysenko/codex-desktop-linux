"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const {
  configForChangedLinuxFeatures,
  writeChangedLinuxFeaturesConfig,
} = require("./changed-linux-features.js");

function withFeatureRoot(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "changed-linux-features-"));
  const featuresRoot = path.join(root, "linux-features");
  fs.mkdirSync(featuresRoot, { recursive: true });
  try {
    return fn({ root, featuresRoot });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function addFeature(featuresRoot, id, manifest = {}, relativeDir = id) {
  const featureDir = path.join(featuresRoot, relativeDir);
  fs.mkdirSync(featureDir, { recursive: true });
  fs.writeFileSync(path.join(featureDir, "README.md"), `# ${id}\n`);
  fs.writeFileSync(path.join(featureDir, "feature.json"), `${JSON.stringify({
    id,
    title: id,
    ...manifest,
  }, null, 2)}\n`);
}

test("enables the repository feature containing a changed file", () => withFeatureRoot(({ featuresRoot }) => {
  addFeature(featuresRoot, "alpha");

  const config = configForChangedLinuxFeatures(["linux-features/alpha/patch.js"], { featuresRoot });

  assert.deepEqual(config, { enabled: ["alpha"] });
}));

test("enables multiple compatible changed features in stable order", () => withFeatureRoot(({ featuresRoot }) => {
  addFeature(featuresRoot, "zulu");
  addFeature(featuresRoot, "alpha");

  const config = configForChangedLinuxFeatures([
    "linux-features/zulu/test.js",
    "linux-features/alpha/feature.json",
  ], { featuresRoot });

  assert.deepEqual(config, { enabled: ["alpha", "zulu"] });
}));

test("treats documentation inside a feature as a feature change", () => withFeatureRoot(({ featuresRoot }) => {
  addFeature(featuresRoot, "alpha");

  const config = configForChangedLinuxFeatures(["linux-features/alpha/README.md"], { featuresRoot });

  assert.deepEqual(config, { enabled: ["alpha"] });
}));

test("ignores local, top-level, core, unknown, and invalid feature paths", () => withFeatureRoot(({ featuresRoot }) => {
  addFeature(featuresRoot, "alpha");
  addFeature(featuresRoot, "private-feature", {}, path.join("local", "private-feature"));
  fs.writeFileSync(path.join(featuresRoot, "local", "private-feature", "feature.json"), "{broken-json\n");

  const config = configForChangedLinuxFeatures([
    "linux-features/local/private-feature/patch.js",
    "linux-features/README.md",
    "linux-features/not-a-feature/notes.md",
    "linux-features/INVALID_ID/patch.js",
    "scripts/patches/engine.js",
  ], { featuresRoot });

  assert.deepEqual(config, { enabled: [] });
}));

test("expands transitive feature requirements", () => withFeatureRoot(({ featuresRoot }) => {
  addFeature(featuresRoot, "base");
  addFeature(featuresRoot, "middle", { requires: ["base"] });
  addFeature(featuresRoot, "leaf", { requires: ["middle"] });

  const config = configForChangedLinuxFeatures(["linux-features/leaf/patch.js"], { featuresRoot });

  assert.deepEqual(config, { enabled: ["base", "leaf", "middle"] });
}));

test("rejects conflicts in the combined changed feature set", () => withFeatureRoot(({ featuresRoot }) => {
  addFeature(featuresRoot, "alpha", { conflicts: ["beta"] });
  addFeature(featuresRoot, "beta");

  assert.throws(
    () => configForChangedLinuxFeatures([
      "linux-features/alpha/patch.js",
      "linux-features/beta/patch.js",
    ], { featuresRoot }),
    /Linux feature 'alpha' conflicts with 'beta'/,
  );
}));

test("uses the manifest loader to reject invalid feature ids", () => withFeatureRoot(({ featuresRoot }) => {
  addFeature(featuresRoot, "INVALID_ID", {}, "broken");

  assert.throws(
    () => configForChangedLinuxFeatures(["linux-features/broken/patch.js"], { featuresRoot }),
    /Linux feature id .* must match/,
  );
}));

test("does not replace an existing config when validation fails", () => withFeatureRoot(({ root, featuresRoot }) => {
  addFeature(featuresRoot, "alpha", { conflicts: ["beta"] });
  addFeature(featuresRoot, "beta");
  const outputPath = path.join(root, "features.json");
  fs.writeFileSync(outputPath, "original\n");

  assert.throws(
    () => writeChangedLinuxFeaturesConfig(outputPath, [
      "linux-features/alpha/patch.js",
      "linux-features/beta/patch.js",
    ], { featuresRoot }),
    /Linux feature 'alpha' conflicts with 'beta'/,
  );
  assert.equal(fs.readFileSync(outputPath, "utf8"), "original\n");
}));

test("CLI writes a build-ready config from NUL-delimited changed paths", () => withFeatureRoot(({ root, featuresRoot }) => {
  addFeature(featuresRoot, "base");
  addFeature(featuresRoot, "leaf", { requires: ["base"] });
  const outputPath = path.join(root, "features.json");
  const cli = path.join(__dirname, "changed-linux-features.js");

  const result = spawnSync(process.execPath, [
    cli,
    "--features-root", featuresRoot,
    "--output", outputPath,
  ], {
    encoding: "utf8",
    input: "linux-features/leaf/README.md\0scripts/core.js\0",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(outputPath, "utf8")), {
    enabled: ["base", "leaf"],
  });
  assert.match(result.stdout, /base, leaf/);
}));

test("upstream workflow runs feature-aware acceptance for feature PRs only", () => {
  const workflow = fs.readFileSync(
    path.resolve(__dirname, "../../.github/workflows/upstream-build-app.yml"),
    "utf8",
  );

  const pullRequestBlock = workflow.slice(workflow.indexOf("  pull_request:"), workflow.indexOf("  push:"));
  const pushBlock = workflow.slice(workflow.indexOf("  push:"), workflow.indexOf("  workflow_dispatch:"));
  const configureStep = workflow.slice(
    workflow.indexOf("      - name: Configure changed Linux Features"),
    workflow.indexOf("      - name: Install build dependencies"),
  );
  assert.match(pullRequestBlock, /- linux-features\/\*\/\*\*/);
  assert.match(pullRequestBlock, /- '!linux-features\/local\/\*\*'/);
  assert.match(pullRequestBlock, /- scripts\/lib\/linux-features\.js/);
  assert.doesNotMatch(pushBlock, /- linux-features\//);
  assert.match(pushBlock, /- scripts\/lib\/linux-features\.js/);
  assert.match(workflow, /fetch-depth: \$\{\{ github\.event_name == 'pull_request' && '0' \|\| '1' \}\}/);
  assert.match(configureStep, /if: github\.event_name == 'pull_request'/);
  assert.match(configureStep, /git diff --no-renames --name-only -z/);
  assert.match(configureStep, /changed-linux-features\.js/);
  assert.match(configureStep, /CODEX_LINUX_FEATURES_CONFIG/);
  assert.equal(workflow.match(/CODEX_LINUX_FEATURES_CONFIG/g)?.length, 1);
});
