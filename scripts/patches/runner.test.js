const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  createPatchReport,
} = require("../lib/patch-report.js");
const {
  patchExtractedApp,
} = require("./runner.js");

test("runner executes descriptor phases explicitly and sorts order only within each phase", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-runner-phase-order-"));
  try {
    const appDir = path.join(tempRoot, "app");
    const buildDir = path.join(appDir, ".vite", "build");
    const assetsDir = path.join(appDir, "webview", "assets");
    const coreRoot = path.join(tempRoot, "core");
    const patchDir = path.join(coreRoot, "all-linux", "sample");
    fs.mkdirSync(buildDir, { recursive: true });
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.mkdirSync(patchDir, { recursive: true });
    fs.writeFileSync(path.join(buildDir, "main.js"), "main");
    fs.writeFileSync(path.join(assetsDir, "app-test.js"), "asset");
    fs.writeFileSync(path.join(assetsDir, "app-test.png"), "");

    fs.writeFileSync(
      path.join(patchDir, "patch.js"),
      [
        "\"use strict\";",
        `const descriptor = require(${JSON.stringify(path.join(__dirname, "descriptor.js"))});`,
        "module.exports = [",
        "  descriptor.webviewAssetPatch({ id: 'webview-low-order', order: 1, pattern: /^app-.*\\.js$/, apply: (source) => source + '|webview' }),",
        "  descriptor.extractedAppPatch({ id: 'post-high-order', phase: descriptor.PHASE_EXTRACTED_APP_POST_WEBVIEW, order: 1, apply: () => ({ changed: true }) }),",
        "  descriptor.mainBundlePatch({ id: 'main-high-order', order: 20, apply: (source) => source + '|main-high' }),",
        "  descriptor.extractedAppPatch({ id: 'pre-high-order', phase: descriptor.PHASE_EXTRACTED_APP_PRE_WEBVIEW, order: 9999, apply: () => ({ changed: true }) }),",
        "  descriptor.mainBundlePatch({ id: 'main-low-order', order: 10, apply: (source) => source + '|main-low' }),",
        "];",
        "",
      ].join("\n"),
    );

    const report = createPatchReport();
    patchExtractedApp(appDir, {
      report,
      corePatchRoot: coreRoot,
      featuresConfigPath: path.join(__dirname, "..", "..", "linux-features", "features.example.json"),
    });

    const names = report.patches.map((patch) => patch.name);
    assert.ok(names.indexOf("main-low-order") < names.indexOf("main-high-order"));
    assert.ok(names.indexOf("main-high-order") < names.indexOf("pre-high-order"));
    assert.ok(names.indexOf("pre-high-order") < names.indexOf("webview-low-order"));
    assert.ok(names.indexOf("webview-low-order") < names.indexOf("post-high-order"));
    assert.equal(fs.readFileSync(path.join(buildDir, "main.js"), "utf8"), "main|main-low|main-high");
    assert.equal(fs.readFileSync(path.join(assetsDir, "app-test.js"), "utf8"), "asset|webview");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
