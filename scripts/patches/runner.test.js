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
const { findMainProcessChunks } = require("./lib/assets.js");
const {
  findQuitLifecycleContract,
} = require("./core/quit-confirmation-focus/patch.js");

const emptyConfig = path.join(__dirname, "..", "..", "linux-features", "features.example.json");

test("the official Linux baseline registers the required quit compatibility patch", () => {
  assert.deepEqual(
    corePatchDescriptors().map(({ id, phase, ciPolicy }) => ({ id, phase, ciPolicy })),
    [{
      id: "quit-confirmation-focus",
      phase: "main-bundle",
      ciPolicy: "required-upstream",
    }],
  );
  assert.deepEqual(allPatchPolicies({ featuresConfigPath: emptyConfig }), [{
    name: "quit-confirmation-focus",
    ciPolicy: "required-upstream",
    phase: "main-bundle",
  }]);
  assert.deepEqual(requiredPatchNamesForProfile("upstream-build", {
    featuresConfigPath: emptyConfig,
  }), ["quit-confirmation-focus"]);
});

test("the signed baseline needs one quit repair and retains the retired shell replacement", {
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

  const quitOwners = chunks
    .map((chunk) => ({ ...chunk, contract: findQuitLifecycleContract(chunk.source) }))
    .filter(({ contract }) => contract != null);
  assert.equal(quitOwners.length, 1, "Expected one signed before-quit owner tied to quit state");
  assert.equal(
    quitOwners[0].contract.approvalConsumed,
    false,
    "The signed before-quit owner must reproduce the missing approval consumption",
  );

  const quitPatch = corePatchDescriptors().find(({ id }) => id === "quit-confirmation-focus");
  assert.ok(quitPatch, "Expected the required quit patch descriptor");
  const originalWarn = console.warn;
  console.warn = () => {};
  let patchedChunks;
  try {
    patchedChunks = chunks.map((chunk) => ({
      ...chunk,
      source: quitPatch.apply(chunk.source),
    }));
  } finally {
    console.warn = originalWarn;
  }
  const changed = patchedChunks.filter(({ source }, index) => source !== chunks[index].source);
  assert.deepEqual(
    changed.map(({ name }) => name),
    [quitOwners[0].name],
    "The required quit patch must change only the unique signed before-quit owner",
  );
  const patchedQuitOwners = patchedChunks
    .map((chunk) => findQuitLifecycleContract(chunk.source))
    .filter((contract) => contract != null);
  assert.equal(patchedQuitOwners.length, 1, "Expected one patched signed before-quit owner");
  assert.equal(
    patchedQuitOwners[0].approvalConsumed,
    true,
    "The patched signed before-quit owner must consume the coordinator approval",
  );

  const shellOwner = uniqueOwner([
    "main app.whenReady resolved",
    "shell environment hydrated",
  ], "upstream shell-startup owner");
  const identifier = "[A-Za-z_$][\\w$]*";
  const readyPattern = new RegExp(
    `await ${identifier}\\.app\\.whenReady\\(\\),${identifier}\\(` +
      `"main app\\.whenReady resolved"`,
    "gu",
  );
  const shellStartPattern = new RegExp(
    `(?:let|const) ${identifier}=Date\\.now\\(\\),${identifier}=\\(0,` +
      `${identifier}\\.${identifier}\\)\\(\\),${identifier}=${identifier}=>\\{` +
      `${identifier}\\("shell environment hydrated"`,
    "gu",
  );
  const readyMatches = [...shellOwner.matchAll(readyPattern)];
  const shellStartMatches = [...shellOwner.matchAll(shellStartPattern)];
  assert.equal(readyMatches.length, 1, "Expected one awaited main app readiness boundary");
  assert.equal(shellStartMatches.length, 1, "Expected one shell-environment startup call");
  assert.ok(
    shellStartMatches[0].index > readyMatches[0].index,
    "Shell-environment startup must follow awaited app readiness",
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

test("required core drift fails closed without changing unmatched application assets", () => {
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
    assert.equal(report.patches.length, 1);
    assert.equal(report.patches[0].name, "quit-confirmation-focus");
    assert.equal(report.patches[0].status, "failed-required");
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
