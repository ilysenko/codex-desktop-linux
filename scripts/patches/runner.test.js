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

const { findMainProcessChunks } = require("./lib/assets.js");
const {
  findMatchingBrace,
} = require("./lib/minified-js.js");

const emptyConfig = path.join(__dirname, "..", "..", "linux-features", "features.example.json");
const { SHELL_ENVIRONMENT_FIXTURE } = require("./core/shell-env-startup/test-helpers.js");

test("the signed baseline owns approved quit completion", {
  skip: process.env.CODEX_SIGNED_EXTRACTED_APP == null,
}, () => {
  const mainProcess = findMainProcessChunks(process.env.CODEX_SIGNED_EXTRACTED_APP);
  assert.ok(mainProcess, "Expected the verified main-process chunks");
  const chunks = mainProcess.chunks.map((name) => ({
    name,
    source: fs.readFileSync(path.join(mainProcess.buildDir, name), "utf8"),
  }));
  const uniqueOwner = (markers, description) => {
    const owners = chunks.filter(({ source }) =>
      markers.every((marker) => source.includes(marker)));
    assert.equal(
      owners.length,
      1,
      `Expected one ${description}; found ${owners.map(({ name }) => name).join(", ") || "none"}`,
    );
    return owners[0].source;
  };

  const quitOwner = uniqueOwner([
    "canQuitWithoutPrompt(){return this.allowQuitWithoutPrompt}",
    "markQuitApproved(){this.allowQuitWithoutPrompt=!0}",
    "hasPendingLocalGitReviewComments:",
    '.app.on("before-quit",',
  ], "native approved-quit lifecycle owner");
  const identifier = "[A-Za-z_$][\\w$]*";
  const lifecycleHeader = new RegExp(
    `function\\(\\{[^{}]*quitState:(?<quitState>${identifier}),` +
      `windows:(?<windows>${identifier}),[^{}]*` +
      `hasPendingLocalGitReviewComments:(?<pending>${identifier}),[^{}]*\\}\\)\\{`,
    "gu",
  );
  const lifecycleMatches = [...quitOwner.matchAll(lifecycleHeader)];
  assert.equal(lifecycleMatches.length, 1, "Expected one native quit lifecycle owner");
  const { quitState, windows, pending } = lifecycleMatches[0].groups;
  const lifecycleOpen = lifecycleMatches[0].index + lifecycleMatches[0][0].length - 1;
  const lifecycleClose = findMatchingBrace(quitOwner, lifecycleOpen);
  assert.ok(lifecycleClose > lifecycleOpen, "Expected a complete native quit lifecycle owner");
  const lifecycleBody = quitOwner.slice(lifecycleOpen, lifecycleClose + 1);
  const beforeQuitPattern = new RegExp(
    `${identifier}\\.app\\.on\\("before-quit",(?<event>${identifier})=>\\{`,
    "gu",
  );
  const beforeQuitMatches = [...lifecycleBody.matchAll(beforeQuitPattern)];
  assert.equal(beforeQuitMatches.length, 1, "Expected one native before-quit handler");
  const handlerOpen = beforeQuitMatches[0].index + beforeQuitMatches[0][0].length - 1;
  const handlerClose = findMatchingBrace(lifecycleBody, handlerOpen);
  assert.ok(handlerClose > handlerOpen, "Expected a complete native before-quit handler");
  const handlerBody = lifecycleBody.slice(handlerOpen, handlerClose + 1);
  const approvalGate = `!${quitState}.canQuitWithoutPrompt()`;
  const pendingCheck = `${pending}()`;
  const localApproval = `${quitState}.markQuitApproved()`;
  const quittingTransition = `${windows}.markAppQuitting()`;
  assert.equal(handlerBody.split(approvalGate).length - 1, 1);
  assert.equal(handlerBody.split(pendingCheck).length - 1, 1);
  assert.equal(handlerBody.split(localApproval).length - 1, 1);
  assert.equal(handlerBody.split(quittingTransition).length - 1, 1);
  assert.ok(handlerBody.indexOf(approvalGate) < handlerBody.indexOf(pendingCheck));
  assert.ok(handlerBody.indexOf(pendingCheck) < handlerBody.indexOf(localApproval));
  assert.ok(handlerBody.indexOf(localApproval) < handlerBody.indexOf(quittingTransition));

});

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

test("the default core registry repairs shell startup without changing other assets", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runner-baseline-"));
  try {
    const mainDir = path.join(root, ".vite", "build");
    const webviewDir = path.join(root, "webview", "assets");
    fs.mkdirSync(mainDir, { recursive: true });
    fs.mkdirSync(webviewDir, { recursive: true });
    const main = path.join(mainDir, "early-bootstrap.js");
    const webview = path.join(webviewDir, "app-initial-A.js");
    fs.writeFileSync(main, "const officialMain=true;");
    const shell = path.join(mainDir, "early-bootstrap-133-abcd.js");
    fs.writeFileSync(shell, SHELL_ENVIRONMENT_FIXTURE);
    fs.writeFileSync(webview, "official-webview\n");
    const report = createPatchReport();
    patchExtractedApp(root, {
      report,
      featuresConfigPath: emptyConfig,
      linuxTarget: fedoraKde,
    });
    assert.equal(fs.readFileSync(main, "utf8"), "const officialMain=true;");
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
    const main = path.join(mainDir, "early-bootstrap.js");
    const shell = path.join(mainDir, "early-bootstrap-133-abcd.js");
    const shellSource = SHELL_ENVIRONMENT_FIXTURE;
    fs.writeFileSync(main, "const officialMain=true;");
    fs.writeFileSync(shell, shellSource);
    const report = createPatchReport();

    patchExtractedApp(root, {
      report,
      featuresConfigPath: emptyConfig,
      linuxTarget: ubuntuGnome,
    });

    assert.equal(fs.readFileSync(main, "utf8"), "const officialMain=true;");
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
