"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { detectLinuxTargetContext } = require("../lib/linux-target-context.js");
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

function linuxTarget(id, versionId, desktop) {
  return detectLinuxTargetContext({
    env: {
      CODEX_LINUX_TARGET_ID: id,
      CODEX_LINUX_TARGET_VERSION_ID: versionId,
      CODEX_LINUX_TARGET_DESKTOP: desktop,
      CODEX_LINUX_TARGET_PACKAGE_FORMAT: id === "fedora" ? "rpm" : "deb",
      PATH: "",
    },
    osReleaseFields: {},
    atomic: false,
  });
}

const fedoraKde = linuxTarget("fedora", "44", "KDE:Plasma");
const ubuntuGnome = linuxTarget("ubuntu", "26.04", "ubuntu:GNOME");

test("the official Linux baseline registers required compatibility patches", () => {
  assert.deepEqual(
    corePatchDescriptors().map(({ id, ciPolicy, phase }) => ({ id, ciPolicy, phase })),
    [{
      id: "quit-confirmation-focus",
      ciPolicy: "required-upstream",
      phase: "extracted-app:pre-webview",
    }],
  );
  assert.deepEqual(
    allPatchPolicies({ featuresConfigPath: emptyConfig }),
    [{
      name: "quit-confirmation-focus",
      ciPolicy: "required-upstream",
      phase: "extracted-app:pre-webview",
    }],
  );
  assert.deepEqual(
    requiredPatchNamesForProfile("upstream-build", {
      featuresConfigPath: emptyConfig,
      linuxTarget: fedoraKde,
    }),
    ["quit-confirmation-focus"],
  );
  assert.deepEqual(
    requiredPatchNamesForProfile("upstream-build", {
      featuresConfigPath: emptyConfig,
      linuxTarget: ubuntuGnome,
    }),
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

test("the default core registry repairs Quit and shell startup without changing webview assets", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runner-baseline-"));
  try {
    const mainDir = path.join(root, ".vite", "build");
    const webviewDir = path.join(root, "webview", "assets");
    fs.mkdirSync(mainDir, { recursive: true });
    fs.mkdirSync(webviewDir, { recursive: true });
    const main = path.join(mainDir, "main.js");
    const webview = path.join(webviewDir, "app-initial-A.js");
    fs.writeFileSync(main, officialQuitBundle);
    const shell = path.join(mainDir, "shell-env-fixture.js");
    fs.writeFileSync(shell, "async function load(a,b){let start=Date.now();e.app.isPackaged||clean();" +
      "let abort=new AbortController;log(`Failed to load shell env`,{resultSource:`load`})}");
    fs.writeFileSync(webview, "official-webview\n");
    const report = createPatchReport();
    patchExtractedApp(root, {
      report,
      featuresConfigPath: emptyConfig,
      linuxTarget: fedoraKde,
    });
    assert.match(fs.readFileSync(main, "utf8"), /function codexLinuxQuitDialogParent\(/);
    assert.equal(fs.readFileSync(webview, "utf8"), "official-webview\n");
    assert.match(fs.readFileSync(shell, "utf8"), /await new Promise\(setImmediate\)/);
    assert.equal(report.patches.length, 1);
    assert.equal(report.patches[0].name, "quit-confirmation-focus");
    assert.equal(report.patches[0].status, "applied");
    assert.equal(report.patches[0].ciPolicy, "required-upstream");
    assert.equal(report.patches[0].sourceKind, "core");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("portable artifacts include the shell repair when built on Ubuntu GNOME", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runner-portable-shell-repair-"));
  try {
    const mainDir = path.join(root, ".vite", "build");
    fs.mkdirSync(mainDir, { recursive: true });
    const main = path.join(mainDir, "main.js");
    const shell = path.join(mainDir, "shell-env-fixture.js");
    const shellSource = "async function load(a,b){let start=Date.now();e.app.isPackaged||clean();" +
      "let abort=new AbortController;log(`Failed to load shell env`,{resultSource:`load`})}";
    fs.writeFileSync(main, officialQuitBundle);
    fs.writeFileSync(shell, shellSource);
    const report = createPatchReport();

    patchExtractedApp(root, {
      report,
      featuresConfigPath: emptyConfig,
      linuxTarget: ubuntuGnome,
    });

    assert.match(fs.readFileSync(main, "utf8"), /function codexLinuxQuitDialogParent\(/);
    assert.match(fs.readFileSync(shell, "utf8"), /await new Promise\(setImmediate\)/);
    assert.deepEqual(
      report.patches.map(({ name, status }) => ({ name, status })),
      [{ name: "quit-confirmation-focus", status: "applied" }],
    );
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
  assert.equal(entry.status, "skipped-optional");
  assert.equal(entry.enforceWhenEnabled, true);
  assert.equal(entry.unavailable, true);
  assert.equal(
    enabledFeatureFailuresFromReport(report).some((failure) => failure.name === entry.name),
    true,
  );
});
