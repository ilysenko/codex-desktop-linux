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
const officialQuitBundle =
  "function qrt({isWindows:e,quitState:r,windows:i}){" +
  "let S=!1;l.app.on(`before-quit`,o=>{if(e||r.canQuitWithoutPrompt()){S=!0,i.markAppQuitting();return}" +
  "if(l.dialog.showMessageBoxSync({message:`Quit?`,buttons:[{messageId:`desktop.quitConfirmation.quit`},`Cancel`]})!==0){o.preventDefault();return}" +
  "r.markQuitApproved(),S=!0,i.markAppQuitting()})}function next(){}";

test("the official Linux baseline registers the required Quit focus patch", () => {
  assert.deepEqual(
    corePatchDescriptors().map(({ id, ciPolicy, phase }) => ({ id, ciPolicy, phase })),
    [{
      id: "quit-confirmation-focus",
      ciPolicy: "required-upstream",
      phase: "main-bundle",
    }],
  );
  assert.deepEqual(
    allPatchPolicies({ featuresConfigPath: emptyConfig }),
    [{
      name: "quit-confirmation-focus",
      ciPolicy: "required-upstream",
      phase: "main-bundle",
      appliesTo: undefined,
    }],
  );
  assert.deepEqual(
    requiredPatchNamesForProfile("upstream-build", { featuresConfigPath: emptyConfig }),
    ["quit-confirmation-focus"],
  );
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

test("the default core registry patches the official Quit handler only", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runner-baseline-"));
  try {
    const mainDir = path.join(root, ".vite", "build");
    const webviewDir = path.join(root, "webview", "assets");
    fs.mkdirSync(mainDir, { recursive: true });
    fs.mkdirSync(webviewDir, { recursive: true });
    const main = path.join(mainDir, "main.js");
    const webview = path.join(webviewDir, "app-initial-A.js");
    fs.writeFileSync(main, officialQuitBundle);
    fs.writeFileSync(webview, "official-webview\n");
    const report = createPatchReport();
    patchExtractedApp(root, {
      report,
      featuresConfigPath: emptyConfig,
    });
    assert.match(fs.readFileSync(main, "utf8"), /function codexLinuxQuitDialogParent\(/);
    assert.equal(fs.readFileSync(webview, "utf8"), "official-webview\n");
    assert.equal(report.patches.length, 1);
    assert.equal(report.patches[0].name, "quit-confirmation-focus");
    assert.equal(report.patches[0].status, "applied");
    assert.equal(report.patches[0].ciPolicy, "required-upstream");
    assert.equal(report.patches[0].sourceKind, "core");
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
  const coreEntry = report.patches.find((patch) =>
    patch.name === "quit-confirmation-focus");
  assert.ok(entry);
  assert.ok(coreEntry);
  assert.equal(coreEntry.status, "failed-required");
  assert.equal(coreEntry.unavailable, true);
  assert.equal(entry.status, "skipped-optional");
  assert.equal(entry.enforceWhenEnabled, true);
  assert.equal(entry.unavailable, true);
  assert.equal(
    enabledFeatureFailuresFromReport(report).some((failure) => failure.name === entry.name),
    true,
  );
});
