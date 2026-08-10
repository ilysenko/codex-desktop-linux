#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");
const { descriptors } = require("./patch.js");
const applyAutomationSchemaFlattenPatch = descriptors[0].apply;
const {
  enabledLinuxFeatureIds,
  loadLinuxFeaturePatchDescriptors,
} = require("../../scripts/lib/linux-features.js");
const {
  createPatchReport,
} = require("../../scripts/lib/patch-report.js");
const {
  patchExtractedApp,
} = require("../../scripts/patches/runner.js");

// The real bundle emits the tool inside a map callback, so the line ends with
// the callback's closing brace. The regex intentionally preserves the
// trailing punctuation.
const EMITTER_SNIPPET = "return e.name===`automation_update`&&delete t.deferLoading,t}";

function withTempFeatureRoot(enabled, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-automation-schema-flatten-"));
  const originalConfig = process.env.CODEX_LINUX_FEATURES_CONFIG;
  try {
    delete process.env.CODEX_LINUX_FEATURES_CONFIG;
    fs.writeFileSync(path.join(root, "features.json"), JSON.stringify({ enabled }, null, 2));
    fs.cpSync(
      path.resolve(__dirname, "..", "automation-schema-flatten"),
      path.join(root, "automation-schema-flatten"),
      { recursive: true },
    );
    return fn(root);
  } finally {
    if (originalConfig == null) {
      delete process.env.CODEX_LINUX_FEATURES_CONFIG;
    } else {
      process.env.CODEX_LINUX_FEATURES_CONFIG = originalConfig;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function syntaxCheck(source) {
  const result = spawnSync(process.execPath, ["--check"], {
    input: source,
    encoding: "utf8",
  });
  return result.status === 0;
}

test("flattens the automation_update emitter into a valid object schema", () => {
  // Mirror the real bundle: the emitter is the tail of a map callback that
  // closes with `}` before the closing `)`.
  const source = `[0].map(e=>{let t={};${EMITTER_SNIPPET})`;
  const patched = applyAutomationSchemaFlattenPatch(source);

  assert.notEqual(patched, source);
  assert.match(patched, /if\(e\.name===`automation_update`\)\{delete t\.deferLoading/);
  assert.match(patched, /let o=\{type:`object`,properties:p,additionalProperties:!0\}/);
  assert.match(patched, /t\.inputSchema=o\}/);
  assert.ok(syntaxCheck(patched), "patched emitter must remain valid JavaScript");
});

test("merges oneOf variant properties and preserves required fields", () => {
  const source = EMITTER_SNIPPET;
  const patched = applyAutomationSchemaFlattenPatch(source);

  assert.match(
    patched,
    /if\(s&&typeof s===\`object\`&&!s\.type&&Array\.isArray\(s\.oneOf\)\)\{let p=\{\},r=\[\];function merge\(x\)\{if\(x&&x\.properties\)Object\.assign\(p,x\.properties\)/,
  );
  assert.match(patched, /if\(r\.length\)o\.required=\[\.\.\.new Set\(r\)\]/);
});

test("is a no-op when the emitter marker is absent", () => {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const source = "const x = 1;";
    assert.equal(applyAutomationSchemaFlattenPatch(source), source);
  } finally {
    console.warn = originalWarn;
  }
});

test("feature stays disabled until listed in features.json", () => {
  withTempFeatureRoot([], (root) => {
    assert.deepEqual(enabledLinuxFeatureIds({ featuresRoot: root }), []);
    assert.deepEqual(loadLinuxFeaturePatchDescriptors({ featuresRoot: root }), []);
  });
});

test("feature exposes a webview-asset patch when enabled", () => {
  withTempFeatureRoot(["automation-schema-flatten"], (root) => {
    assert.deepEqual(enabledLinuxFeatureIds({ featuresRoot: root }), ["automation-schema-flatten"]);

    const patches = loadLinuxFeaturePatchDescriptors({ featuresRoot: root })
      .filter((patch) => patch.phase === "webview-asset");
    assert.equal(patches.length, 1);
    assert.equal(patches[0].name, "feature:automation-schema-flatten:automation-schema-flatten-webview");
    assert.ok(patches[0].pattern.test("app-initial-test.js"));
    assert.equal(patches[0].pattern.test("other-bundle.js"), false);
    assert.equal(patches[0].apply(EMITTER_SNIPPET), applyAutomationSchemaFlattenPatch(EMITTER_SNIPPET));
  });
});

test("feature participates in webview asset patching and patch reports", () => {
  withTempFeatureRoot(["automation-schema-flatten"], (root) => {
    const originalRoot = process.env.CODEX_LINUX_FEATURES_ROOT;
    process.env.CODEX_LINUX_FEATURES_ROOT = root;
    const tempApp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-automation-schema-flatten-app-"));
    try {
      const assetsDir = path.join(tempApp, "webview", "assets");
      fs.mkdirSync(assetsDir, { recursive: true });
      fs.writeFileSync(
        path.join(assetsDir, "app-initial-test.js"),
        `const x = 1;${EMITTER_SNIPPET}`,
      );

      const report = createPatchReport();
      patchExtractedApp(tempApp, { report });

      const patched = fs.readFileSync(path.join(assetsDir, "app-initial-test.js"), "utf8");
      assert.match(patched, /if\(e\.name===`automation_update`\)/);
      assert.ok(
        report.patches.some((patch) =>
          patch.name === "feature:automation-schema-flatten:automation-schema-flatten-webview" &&
          patch.status === "applied"
        ),
      );
    } finally {
      if (originalRoot == null) {
        delete process.env.CODEX_LINUX_FEATURES_ROOT;
      } else {
        process.env.CODEX_LINUX_FEATURES_ROOT = originalRoot;
      }
      fs.rmSync(tempApp, { recursive: true, force: true });
    }
  });
});
