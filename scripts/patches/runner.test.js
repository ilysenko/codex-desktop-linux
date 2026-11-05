"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  createPatchReport,
  enabledFeatureFailuresFromReport,
} = require("../lib/patch-report.js");
const {
  allPatchPolicies,
  corePatchDescriptors,
  createMainBundleContext,
  patchExtractedApp,
  requiredPatchNamesForProfile,
} = require("./runner.js");

const emptyConfig = path.join(__dirname, "..", "..", "linux-features", "features.example.json");

test("the official Linux baseline has no required compatibility patches", () => {
  assert.deepEqual(corePatchDescriptors(), []);
  assert.deepEqual(allPatchPolicies({ featuresConfigPath: emptyConfig }), []);
  assert.deepEqual(requiredPatchNamesForProfile("upstream-build", {
    featuresConfigPath: emptyConfig,
  }), []);
});

test("runner context exposes enabled feature IDs", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "runner-context-"));
  try {
    const config = path.join(temp, "features.json");
    fs.writeFileSync(config, '{"enabled":["frameless-titlebar"]}\n');
    const context = createMainBundleContext(null, { featuresConfigPath: config });
    assert.deepEqual(context.enabledFeatureIds, ["frameless-titlebar"]);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("the default core registry leaves official application assets unchanged", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runner-baseline-"));
  try {
    const mainDir = path.join(root, ".vite", "build");
    const webviewDir = path.join(root, "webview", "assets");
    fs.mkdirSync(mainDir, { recursive: true });
    fs.mkdirSync(webviewDir, { recursive: true });
    const webview = path.join(webviewDir, "app-initial-A.js");
    const main = path.join(mainDir, "early-bootstrap.js");
    fs.writeFileSync(main, "const officialMain=true;\n");
    fs.writeFileSync(webview, "official-webview\n");
    const mainBefore = fs.readFileSync(main);
    const webviewBefore = fs.readFileSync(webview);
    const report = createPatchReport();
    patchExtractedApp(root, {
      report,
      featuresConfigPath: emptyConfig,
    });
    assert.deepEqual(fs.readFileSync(main), mainBefore);
    assert.deepEqual(fs.readFileSync(webview), webviewBefore);
    assert.deepEqual(report.patches, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("missing main bundle records enabled feature drift", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runner-missing-main-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = path.join(root, "features.json");
  fs.writeFileSync(config, '{"enabled":["frameless-titlebar"]}\n');
  const report = createPatchReport();

  patchExtractedApp(root, { report, featuresConfigPath: config });

  const entry = report.patches.find((patch) =>
    patch.name === "feature:frameless-titlebar:main-process");
  assert.ok(entry);
  assert.equal(entry.status, "skipped-optional");
  assert.equal(entry.enforceWhenEnabled, true);
  assert.equal(entry.unavailable, true);
  assert.equal(
    enabledFeatureFailuresFromReport(report).some((failure) => failure.name === entry.name),
    true,
  );
});

test("main-process chunks are the rspack early-bootstrap entry and its numbered chunks", () => {
  const { findMainProcessChunks } = require("./lib/assets.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runner-rspack-chunks-"));
  try {
    const buildDir = path.join(root, ".vite", "build");
    fs.mkdirSync(buildDir, { recursive: true });
    for (const name of [
      "early-bootstrap.js",
      "early-bootstrap-916-2f6483d5bfd826f1.js",
      "early-bootstrap-87-929aa7e5d829f2a8.js",
      "worker.js",
      "worker-904-f6f849be9d0ea1f7.js",
      "preload.js",
      "main-legacy.js",
    ]) {
      fs.writeFileSync(path.join(buildDir, name), "");
    }
    assert.deepEqual(findMainProcessChunks(root), {
      buildDir,
      chunks: [
        "early-bootstrap-87-929aa7e5d829f2a8.js",
        "early-bootstrap-916-2f6483d5bfd826f1.js",
        "early-bootstrap.js",
      ],
    });
    assert.equal(findMainProcessChunks(path.join(root, "missing")), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
