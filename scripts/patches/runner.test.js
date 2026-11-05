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
const officialShellBundle =
  "let load=async function(a,b){let start=Date.now();e.app.isPackaged||clean();" +
  "let abort=new AbortController;log(\"Failed to load shell env\",{resultSource:\"load\"})}";

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
      id: "shell-env-startup",
      ciPolicy: "required-upstream",
      phase: "extracted-app:pre-webview",
    }],
  );
  assert.deepEqual(
    allPatchPolicies({ featuresConfigPath: emptyConfig }),
    [{
      name: "shell-env-startup",
      ciPolicy: "required-upstream",
      phase: "extracted-app:pre-webview",
    }],
  );
  assert.deepEqual(
    requiredPatchNamesForProfile("upstream-build", {
      featuresConfigPath: emptyConfig,
      linuxTarget: fedoraKde,
    }),
    ["shell-env-startup"],
  );
  assert.deepEqual(
    requiredPatchNamesForProfile("upstream-build", {
      featuresConfigPath: emptyConfig,
      linuxTarget: ubuntuGnome,
    }),
    ["shell-env-startup"],
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

test("the default core registry repairs shell startup without changing webview assets", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runner-baseline-"));
  try {
    const mainDir = path.join(root, ".vite", "build");
    const webviewDir = path.join(root, "webview", "assets");
    fs.mkdirSync(mainDir, { recursive: true });
    fs.mkdirSync(webviewDir, { recursive: true });
    const webview = path.join(webviewDir, "app-initial-A.js");
    const shell = path.join(mainDir, "shell-env-fixture.js");
    fs.writeFileSync(shell, officialShellBundle);
    fs.writeFileSync(webview, "official-webview\n");
    const report = createPatchReport();
    patchExtractedApp(root, {
      report,
      featuresConfigPath: emptyConfig,
      linuxTarget: fedoraKde,
    });
    assert.equal(fs.readFileSync(webview, "utf8"), "official-webview\n");
    assert.match(fs.readFileSync(shell, "utf8"), /await new Promise\(setImmediate\)/);
    assert.equal(report.patches.length, 1);
    assert.equal(report.patches[0].name, "shell-env-startup");
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
    const shell = path.join(mainDir, "shell-env-fixture.js");
    fs.writeFileSync(shell, officialShellBundle);
    const report = createPatchReport();

    patchExtractedApp(root, {
      report,
      featuresConfigPath: emptyConfig,
      linuxTarget: ubuntuGnome,
    });

    assert.match(fs.readFileSync(shell, "utf8"), /await new Promise\(setImmediate\)/);
    assert.deepEqual(
      report.patches.map(({ name, status }) => ({ name, status })),
      [{ name: "shell-env-startup", status: "applied" }],
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
    patch.name === "shell-env-startup");
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
