#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { applyMainBundlePatch } = require("./patch.js");
const {
  enabledLinuxFeatureIds,
  loadLinuxFeatureMainBundlePatches,
} = require("../../scripts/lib/linux-features.js");
const {
  createPatchReport,
  patchExtractedApp,
  patchMainBundleSource,
} = require("../../scripts/patch-linux-window-ui.js");

const zedOpenerBundle =
  "function Tw(e,t){return t?[`${e}:${t.line}:${t.column}`]:[e]}function Rp(e){return e}var eT={id:`zed`,platforms:{darwin:{label:`Zed`,icon:`apps/zed.png`,kind:`editor`,detect:tT,args:Tw,open:async({command:e,path:t,location:n})=>{await aT(e,t,n)}},win32:{label:`Zed`,icon:`apps/zed.png`,kind:`editor`,detect:nT,args:Tw}}};function tT(){return Rp(`zed`)??nC(`Zed`,`zed`)}function nT(){let e=Rp(`zed.exe`)??Rp(`zed`);return e}";

function applyPatchTwice(patchFn, source, ...args) {
  const patched = patchFn(source, ...args);
  assert.equal(patchFn(patched, ...args), patched);
  return patched;
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

function withTempFeatureConfig(enabled, fn) {
  const originalConfig = process.env.CODEX_LINUX_FEATURES_CONFIG;
  const root = path.resolve(__dirname, "..");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-zed-feature-test-"));
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

test("Zed opener feature adds Linux editor support to the upstream opener block", () => {
  const patched = applyPatchTwice(applyMainBundlePatch, zedOpenerBundle);

  assert.match(patched, /linux:\{label:`Zed`,icon:`apps\/zed\.png`,kind:`editor`/);
  assert.match(
    patched,
    /detect:\(\)=>Rp\(`zed`\)\?\?Rp\(`zeditor`\)\?\?Rp\(`zedit`\)\?\?Rp\(`zed-cli`\)/,
  );
  assert.match(patched, /args:Tw/);
});

test("Zed opener feature is a no-op when Linux support is already present", () => {
  const patched = applyMainBundlePatch(zedOpenerBundle);

  assert.equal(applyMainBundlePatch(patched), patched);
});

test("Zed opener feature fails soft when the opener block is missing", () => {
  const { value, warnings } = captureWarns(() => applyMainBundlePatch("real codex bundle"));

  assert.equal(value, "real codex bundle");
  assert.match(warnings.join("\n"), /Could not find Zed opener block/);
});

test("Zed opener feature stays disabled while core Zed support remains enabled", () => {
  withTempFeatureConfig([], (root) => {
    assert.deepEqual(enabledLinuxFeatureIds({ featuresRoot: root }), []);
    assert.deepEqual(loadLinuxFeatureMainBundlePatches({ featuresRoot: root }), []);

    withLinuxFeatureRootEnv(root, () => {
      const { value: patched } = captureWarns(() => patchMainBundleSource(zedOpenerBundle, null));
      assert.match(patched, /linux:\{label:`Zed`/);
    });
  });
});

test("Zed opener feature exposes its patch when enabled", () => {
  withTempFeatureConfig(["zed-opener"], (root) => {
    assert.deepEqual(enabledLinuxFeatureIds({ featuresRoot: root }), ["zed-opener"]);

    const patches = loadLinuxFeatureMainBundlePatches({ featuresRoot: root });
    assert.equal(patches.length, 1);
    assert.equal(patches[0].name, "feature:zed-opener");
    assert.match(patches[0].apply(zedOpenerBundle, {}), /linux:\{label:`Zed`/);
  });
});

test("Zed opener feature participates in main bundle patching and patch reports", () => {
  withTempFeatureConfig(["zed-opener"], (root) => {
    withLinuxFeatureRootEnv(root, () => {
      assert.match(
        captureWarns(() => patchMainBundleSource(zedOpenerBundle, null)).value,
        /linux:\{label:`Zed`/,
      );

      const tempApp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-zed-feature-app-"));
      try {
        const buildDir = path.join(tempApp, ".vite", "build");
        const assetsDir = path.join(tempApp, "webview", "assets");
        fs.mkdirSync(buildDir, { recursive: true });
        fs.mkdirSync(assetsDir, { recursive: true });
        fs.writeFileSync(path.join(buildDir, "main.js"), zedOpenerBundle);
        fs.writeFileSync(path.join(tempApp, "package.json"), JSON.stringify({ name: "codex" }));

        const report = createPatchReport();
        captureWarns(() => patchExtractedApp(tempApp, { report }));

        assert.match(fs.readFileSync(path.join(buildDir, "main.js"), "utf8"), /linux:\{label:`Zed`/);
        assert.ok(
          report.patches.some((patch) => patch.name === "linux-zed-opener" && patch.status === "applied"),
        );
        assert.ok(
          report.patches.some((patch) => patch.name === "feature:zed-opener" && patch.status === "already-applied"),
        );
      } finally {
        fs.rmSync(tempApp, { recursive: true, force: true });
      }
    });
  });
});
