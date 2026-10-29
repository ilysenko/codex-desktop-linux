#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  corePatchDescriptors,
  featurePatchDescriptors,
  patchExtractedApp,
} = require("./patches/runner.js");
const {
  createPatchReport,
  enabledFeatureFailuresFromReport,
  reportHasPatchChanges,
} = require("./lib/patch-report.js");

test("best-effort feature drift stays non-fatal without hiding changed outputs", () => {
  const report = createPatchReport();
  report.enabledFeatures = ["best-effort", "strict"];
  report.patches = [
    {
      name: "feature:best-effort:repair",
      status: "skipped-optional",
      ciPolicy: "optional",
      sourceKind: "feature",
      featureId: "best-effort",
      enforceWhenEnabled: false,
    },
  ];
  assert.deepEqual(enabledFeatureFailuresFromReport(report), []);
  assert.equal(reportHasPatchChanges(report), false);

  report.patches[0].status = "applied-with-warnings";
  assert.equal(reportHasPatchChanges(report), true);

  report.patches[0] = {
    ...report.patches[0],
    name: "feature:strict:repair",
    status: "skipped-optional",
    featureId: "strict",
    enforceWhenEnabled: true,
  };
  assert.equal(enabledFeatureFailuresFromReport(report).length, 1);
});

test("official Linux baseline has required compatibility descriptors", () => {
  assert.deepEqual(
    corePatchDescriptors().map(({ id, ciPolicy, phase }) => ({ id, ciPolicy, phase })),
    [{
      id: "quit-confirmation-focus",
      ciPolicy: "required-upstream",
      phase: "extracted-app:pre-webview",
    }],
  );
  assert.equal(featurePatchDescriptors({
    featuresConfigPath: path.join(__dirname, "..", "linux-features", "features.example.json"),
  }).length, 0);
});

test("an explicitly empty core registry leaves an extracted official-style app unchanged", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-empty-patch-registry-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const buildDir = path.join(root, ".vite", "build");
  const webviewDir = path.join(root, "webview", "assets");
  fs.mkdirSync(buildDir, { recursive: true });
  fs.mkdirSync(webviewDir, { recursive: true });
  const mainPath = path.join(buildDir, "early-bootstrap.js");
  const assetPath = path.join(webviewDir, "app-initial-fixture.js");
  fs.writeFileSync(mainPath, "const officialMain=true;\n");
  fs.writeFileSync(assetPath, "const officialWebview=true;\n");
  const before = new Map([
    [mainPath, fs.readFileSync(mainPath)],
    [assetPath, fs.readFileSync(assetPath)],
  ]);
  const report = createPatchReport();
  patchExtractedApp(root, {
    report,
    corePatchRoot: path.join(root, "empty-core-registry"),
    featuresConfigPath: path.join(__dirname, "..", "linux-features", "features.example.json"),
  });
  assert.deepEqual(report.patches, []);
  for (const [filePath, bytes] of before) assert.deepEqual(fs.readFileSync(filePath), bytes);
});

test("final main-process syntax gate rejects duplicate parameters without executing the app", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-main-syntax-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const buildDir = path.join(root, ".vite", "build");
  fs.mkdirSync(buildDir, { recursive: true });
  // A valid entry does not hide an invalid imported chunk. This is the exact
  // destructured/formal collision introduced by the 26.1013 CUA adaptation.
  fs.writeFileSync(path.join(buildDir, "main.js"), 'throw Error("must never execute");');
  const chunk = path.join(buildDir, "cua-config.js");
  fs.writeFileSync(chunk, "function Aa({browserBackends:e,deferTools:t,surfaces:n,nodeRepl:r},r){}");
  const options = {
    corePatchRoot: path.join(root, "empty-core"),
    featuresConfigPath: path.join(__dirname, "..", "linux-features", "features.example.json"),
  };
  assert.throws(() => patchExtractedApp(root, options), (error) =>
    error.code === "PATCH_INTEGRITY_FAILURE" &&
    /cua-config\.js: SyntaxError: Duplicate parameter name/.test(error.message));

  fs.writeFileSync(chunk, "function Aa({browserBackends:e,deferTools:t,surfaces:n,nodeRepl:r},pluginRoot){}");
  fs.writeFileSync(path.join(buildDir, "module.mjs"), 'export const value = await Promise.resolve(1); throw Error("must never execute");');
  fs.writeFileSync(path.join(buildDir, "common.cjs"), 'return;');
  assert.doesNotThrow(() => patchExtractedApp(root, options));
});

test("syntax validation runs after extracted-app post-webview transforms", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-final-syntax-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const buildDir = path.join(root, ".vite", "build");
  const corePatchRoot = path.join(root, "core");
  fs.mkdirSync(buildDir, { recursive: true });
  fs.mkdirSync(corePatchRoot, { recursive: true });
  fs.writeFileSync(path.join(buildDir, "main.js"), "const main=true;");
  fs.writeFileSync(path.join(corePatchRoot, "patch.js"), `
    module.exports.descriptors = [{
      id: "late-syntax-regression", phase: "extracted-app:post-webview",
      apply(root) {
        require("node:fs").writeFileSync(require("node:path").join(root, ".vite/build/main.js"),
          "function Aa({nodeRepl:r},r){}");
        return { changed: true };
      }
    }];
  `);
  assert.throws(() => patchExtractedApp(root, {
    corePatchRoot,
    featuresConfigPath: path.join(__dirname, "..", "linux-features", "features.example.json"),
  }), /JavaScript syntax validation failed.*main\.js: SyntaxError: Duplicate parameter name/);
});

test("CLI rejects drift in an explicitly enabled feature", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-enabled-feature-drift-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, ".vite", "build"), { recursive: true });
  fs.mkdirSync(path.join(root, "webview", "assets"), { recursive: true });
  fs.writeFileSync(path.join(root, ".vite", "build", "early-bootstrap.js"), "const main=true;\n");
  fs.writeFileSync(path.join(root, "webview", "assets", "app-initial-fixture.js"), "const webview=true;\n");
  const config = path.join(root, "features.json");
  const report = path.join(root, "report.json");
  fs.writeFileSync(config, '{"enabled":["frameless-titlebar"]}\n');

  const result = childProcess.spawnSync(
    process.execPath,
    [path.join(__dirname, "patch-linux-window-ui.js"), "--report-json", report, "--enforce-critical", root],
    {
      encoding: "utf8",
      env: { ...process.env, CODEX_LINUX_FEATURES_CONFIG: config },
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /explicitly enabled feature patches drifted/);
});

function patchFeatureFixture(t, moduleSource, manifest = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feature-descriptor-input-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const featuresRoot = path.join(root, "features");
  const featureDir = path.join(featuresRoot, "probe");
  const appDir = path.join(root, "app");
  const mainPath = path.join(appDir, ".vite", "build", "early-bootstrap.js");
  const config = path.join(featuresRoot, "features.json");
  fs.mkdirSync(featureDir, { recursive: true });
  fs.mkdirSync(path.dirname(mainPath), { recursive: true });
  fs.writeFileSync(mainPath, "const main=true;\n");
  fs.writeFileSync(config, JSON.stringify({
    enabled: ["probe"], settings: { probe: { marker: "configured" } },
  }));
  fs.writeFileSync(path.join(featureDir, "README.md"), "# Probe\n");
  fs.writeFileSync(path.join(featureDir, "feature.json"), JSON.stringify({
    id: "probe", entrypoints: { patchDescriptors: "./patch.js" }, ...manifest,
  }));
  fs.writeFileSync(path.join(featureDir, "patch.js"), moduleSource);
  return {
    root, appDir, mainPath, config,
    options: { featuresRoot, featuresConfigPath: config, corePatchRoot: path.join(root, "empty-core") },
  };
}

test("malformed enabled descriptor inputs abort loading, patching, and build CLIs", async (t) => {
  const invalid = [
    ["missing apply", "[{ id: 'broken' }]", /must export an apply function/],
    ["non-callable apply", "[{ id: 'broken', apply: true }]", /must export an apply function/],
    ["missing id", "[{ apply() {} }]", /must have id or name/],
    ["invalid id", "[{ id: 42, apply() {} }]", /must have id or name/],
    ["empty id", "[{ id: '', apply() {} }]", /must have id or name/],
    ["null descriptor", "[null]", /must be an object/],
    ["array descriptor", "[[]]", /must be an object/],
    ["scalar descriptor", "[7]", /must be an object/],
    ["null export", "null", /must export descriptors/],
    ["undefined export", "undefined", /must export descriptors/],
    ["scalar export", "'broken'", /must be an object/],
    ["function export", "() => []", /must be an object/],
    ["invalid descriptors export", "{ descriptors: [false] }", /must be an object/],
    ["later invalid item", "[{ id: 'valid', apply: s => s + '// changed' }, null]", /patch descriptor 2.*must be an object/],
  ];
  for (const [name, exported, reason] of invalid) {
    await t.test(name, (t) => {
      const fixture = patchFeatureFixture(t, `module.exports = ${exported};\n`);
      const before = fs.readFileSync(fixture.mainPath);
      const diagnostic = (error) => {
        assert.match(error.message, /Linux feature 'probe'/);
        assert.match(error.message, /patch\.js/);
        assert.match(error.message, reason);
        return true;
      };
      assert.throws(() => featurePatchDescriptors(fixture.options), diagnostic);
      assert.throws(() => patchExtractedApp(fixture.appDir, {
        ...fixture.options, report: createPatchReport(),
      }), diagnostic);
      const report = path.join(fixture.root, "report.json");
      const env = {
        ...process.env,
        CODEX_LINUX_FEATURES_ROOT: fixture.options.featuresRoot,
        CODEX_LINUX_FEATURES_CONFIG: fixture.config,
      };
      for (const args of [
        [path.join(__dirname, "lib/linux-features.js"), "--patch-descriptor-count"],
        [path.join(__dirname, "patch-linux-window-ui.js"), "--report-json", report, "--enforce-critical", fixture.appDir],
      ]) {
        const result = childProcess.spawnSync(process.execPath, args, { encoding: "utf8", env });
        assert.notEqual(result.status, 0, result.stdout);
        diagnostic(new Error(result.stderr));
      }
      assert.equal(fs.existsSync(report), false, "invalid inputs must not produce a successful empty report");
      assert.deepEqual(fs.readFileSync(fixture.mainPath), before);
    });
  }
});

test("valid raw and constructor feature descriptors keep settings, attribution, and idempotence", (t) => {
  const descriptorModule = path.join(__dirname, "patches/descriptor.js");
  const fixture = patchFeatureFixture(t, `
    const { mainBundlePatch } = require(${JSON.stringify(descriptorModule)});
    module.exports.descriptors = [
      { name: 'raw', apply(source, { feature }) {
        const marker = '// ' + feature.settings.marker;
        return source.includes(marker) ? source : source + marker + '\\n';
      } },
      mainBundlePatch({ id: 'constructed', apply(source) {
        return source.includes('// constructor') ? source : source + '// constructor\\n';
      } }),
    ];
  `);
  for (const status of ["applied", "already-applied"]) {
    const report = createPatchReport();
    patchExtractedApp(fixture.appDir, { ...fixture.options, report });
    assert.deepEqual(report.enabledFeatures, ["probe"]);
    assert.deepEqual(report.patches.map(({ name, status, featureId, sourceKind }) => ({
      name, status, featureId, sourceKind,
    })), ["raw", "constructed"].map((id) => ({
      name: `feature:probe:${id}`, status, featureId: "probe", sourceKind: "feature",
    })));
    assert.deepEqual(enabledFeatureFailuresFromReport(report), []);
  }
  assert.equal(fs.readFileSync(fixture.mainPath, "utf8"), "const main=true;\n// configured\n// constructor\n");
});

test("empty descriptors, resource-only features, and disabled modules remain valid", (t) => {
  for (const [source, manifest, enabled] of [
    ["module.exports = [];", {}, true],
    ["module.exports = { descriptors: [] };", {}, true],
    ["throw Error('resource-only module must not load');", { entrypoints: {} }, true],
    ["throw Error('disabled module must not load');", {}, false],
  ]) {
    const fixture = patchFeatureFixture(t, source, manifest);
    if (!enabled) fs.writeFileSync(fixture.config, '{"enabled":[]}');
    assert.deepEqual(featurePatchDescriptors(fixture.options), []);
    const report = createPatchReport();
    patchExtractedApp(fixture.appDir, { ...fixture.options, report });
    assert.deepEqual(report.patches, []);
    assert.equal(fs.readFileSync(fixture.mainPath, "utf8"), "const main=true;\n");
  }
});
