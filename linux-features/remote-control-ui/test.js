#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
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
const {
  descriptors: featurePatches,
} = require("./patch.js");

function withTempFeatureConfig(enabled, fn) {
  const originalConfig = process.env.CODEX_LINUX_FEATURES_CONFIG;
  const root = path.resolve(__dirname, "..");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-remote-control-feature-test-"));
  process.env.CODEX_LINUX_FEATURES_CONFIG = path.join(tempDir, "features.json");
  try {
    fs.writeFileSync(process.env.CODEX_LINUX_FEATURES_CONFIG, JSON.stringify({ enabled }, null, 2));
    return fn(root);
  } finally {
    if (originalConfig == null) {
      delete process.env.CODEX_LINUX_FEATURES_CONFIG;
    } else {
      process.env.CODEX_LINUX_FEATURES_CONFIG = originalConfig;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function withLinuxFeatureRootEnv(root, fn) {
  const originalRoot = process.env.CODEX_LINUX_FEATURES_ROOT;
  process.env.CODEX_LINUX_FEATURES_ROOT = root;
  try {
    return fn();
  } finally {
    if (originalRoot == null) {
      delete process.env.CODEX_LINUX_FEATURES_ROOT;
    } else {
      process.env.CODEX_LINUX_FEATURES_ROOT = originalRoot;
    }
  }
}

function captureWarns(fn) {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    return { value: fn(), warnings };
  } finally {
    console.warn = originalWarn;
  }
}

test("remote-control UI feature stays disabled until listed in features.json", () => {
  withTempFeatureConfig([], (root) => {
    assert.deepEqual(enabledLinuxFeatureIds({ featuresRoot: root }), []);
    assert.deepEqual(loadLinuxFeaturePatchDescriptors({ featuresRoot: root }), []);
  });
});

test("remote-control UI feature exposes its cohort and optional asset descriptors when enabled", () => {
  withTempFeatureConfig(["remote-control-ui"], (root) => {
    assert.deepEqual(enabledLinuxFeatureIds({ featuresRoot: root }), ["remote-control-ui"]);

    const patches = loadLinuxFeaturePatchDescriptors({ featuresRoot: root });
    assert.equal(patches.length, 3);
    assert.deepEqual(
      patches.map((patch) => [patch.name, patch.phase, patch.ciPolicy]),
      [
        ["feature:remote-control-ui:remote-connections-visibility", "extracted-app:pre-webview", "optional"],
        ["feature:remote-control-ui:remote-control-connections-visibility", "extracted-app:pre-webview", "optional"],
        ["feature:remote-control-ui:experimental-features", "extracted-app:pre-webview", "optional"],
      ],
    );
  });
});

// rspack/SWC fixtures: jotai atoms read the Statsig gate through their getter,
// strings are double-quoted and comparisons are literal-first.
function rspackChunk(id, modules) {
  return `export const __rspack_esm_id=${id};export const __rspack_esm_ids=[${id}];export const __webpack_modules__={${modules}};`;
}

test("all remote-control UI descriptors use cohort transactions instead of asset needles", () => {
  for (const patch of featurePatches) {
    assert.equal(patch.phase, "extracted-app:pre-webview", patch.id);
    assert.equal(patch.pattern, undefined, patch.id);
    assert.equal(patch.assetPattern, undefined, patch.id);
    assert.equal(patch.assetMatch, undefined, patch.id);
    assert.equal(patch.assetNeedles, undefined, patch.id);
  }
});

test("remote-control UI feature patches every rspack chunk copy and records patch report entries", () => {
  withTempFeatureConfig(["remote-control-ui"], (root) => {
    withLinuxFeatureRootEnv(root, () => {
      const tempApp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-remote-control-feature-app-"));
      try {
        const buildDir = path.join(tempApp, ".vite", "build");
        const assetsDir = path.join(tempApp, "webview", "assets");
        fs.mkdirSync(path.join(assetsDir, "async"), { recursive: true });
        fs.mkdirSync(buildDir, { recursive: true });
        fs.writeFileSync(path.join(buildDir, "main.js"), "console.log('main bundle');");
        fs.writeFileSync(path.join(tempApp, "package.json"), JSON.stringify({ name: "codex" }));

        const chunks = {
          ...require("./control-visibility.test-helpers.js").fixtureSources(),
          ...require("./experimental-filter.test-helpers.js").fixtureSources(),
          "async/1.decoy.js": rspackChunk(1, 'abcd(e,t,n){let x="remoteControlConnectionsState:"}'),
        };
        for (const [name, source] of Object.entries(chunks)) fs.writeFileSync(path.join(assetsDir, name), source);

        const report = createPatchReport();
        const { warnings } = captureWarns(() => patchExtractedApp(tempApp, { report }));
        assert.ok(
          warnings.every((warning) => !warning.includes("remote control UI")),
          warnings.join("\n"),
        );

        const read = (name) => fs.readFileSync(path.join(assetsDir, name), "utf8");
        for (const role of ["boolean", "state"]) {
          assert.equal(read(`async/${role}-0.js`).split("codexLinuxRemoteConnectionsVisibility").length - 1, 1);
        }
        for (let index = 0; index < 6; index++) {
          assert.equal(read(`async/visibility-${index}.js`).split("codexLinuxRemoteControlUiVisibilityEnabled").length - 1, 1);
        }
        for (const row of require("./fixtures/current-experimental-features.json").roles.filter) {
          const name = row.sourceAsset.replace("webview/assets/", "");
          assert.equal(read(name).split("codexLinuxRemoteExperimentalFilter").length - 1, 1);
        }
        assert.equal(read("async/1.decoy.js"), chunks["async/1.decoy.js"]);
        assert.deepEqual(
          report.patches
            .filter((patch) => patch.featureId === "remote-control-ui")
            .map((patch) => [patch.name, patch.status]),
          [
            ["feature:remote-control-ui:remote-connections-visibility", "applied"],
            ["feature:remote-control-ui:remote-control-connections-visibility", "applied"],
            ["feature:remote-control-ui:experimental-features", "applied"],
          ],
        );
      } finally {
        fs.rmSync(tempApp, { recursive: true, force: true });
      }
    });
  });
});

const signedApp = process.env.CODEX_SIGNED_EXTRACTED_APP;
test("signed webview chunks satisfy every remote-control UI contract", { skip: !signedApp }, () => {
  for (const patch of featurePatches) {
    if (patch.id === "remote-connections-visibility") {
      const { locateRemoteConnectionsVisibility } = require("./remote-connections-visibility.js");
      const prepared = locateRemoteConnectionsVisibility(path.join(signedApp, "webview/assets"));
      assert.ok(prepared.edits.length > 0);
      continue;
    }
    if (patch.id === "remote-control-connections-visibility") {
      const { locateRemoteControlConnectionsVisibility } = require("./control-connections-visibility.js");
      const prepared = locateRemoteControlConnectionsVisibility(path.join(signedApp, "webview/assets"));
      assert.ok(prepared.edits.length > 0);
      continue;
    }
    const { locateExperimentalFeaturesVisibility } = require("./experimental-features.js");
    const prepared = locateExperimentalFeaturesVisibility(path.join(signedApp, "webview/assets"));
    assert.ok(prepared.edits.length > 0);

  }
});
