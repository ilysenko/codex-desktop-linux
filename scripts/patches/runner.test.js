"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { findMainProcessChunks } = require("./lib/assets.js");
const { findMatchingBrace } = require("./lib/minified-js.js");
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

test("the signed native before-quit callback permits Linux quit and preserves the macOS privacy boundary", {
  skip: process.env.CODEX_SIGNED_EXTRACTED_APP == null,
}, () => {
  const inventory = findMainProcessChunks(process.env.CODEX_SIGNED_EXTRACTED_APP);
  assert.ok(inventory);
  const id = "[A-Za-z_$][\\w$]*";
  const callbacks = [];
  for (const name of inventory.chunks) {
    const source = fs.readFileSync(path.join(inventory.buildDir, name), "utf8");
    const owners = [...source.matchAll(new RegExp(
      `function\\(\\{isWindows:${id},quitState:(${id}),windows:(${id}),applicationMenuManager:`, "gu",
    ))];
    for (const owner of owners) {
      const open = source.indexOf("){", owner.index) + 1;
      assert.ok(open > owner.index);
      const close = findMatchingBrace(source, open);
      assert.ok(close > open);
      const body = source.slice(open + 1, close);
      const heads = [...body.matchAll(new RegExp(
        `(${id})\\.app\\.on\\("before-quit",(${id})=>\\{!function\\(\\{addon:`, "gu",
      ))];
      assert.equal(heads.length, 1);
      const head = heads[0], callbackOpen = head.index + head[0].indexOf("=>{") + 2;
      const callbackClose = findMatchingBrace(body, callbackOpen);
      assert.ok(callbackClose > callbackOpen);
      const callback = body.slice(callbackOpen, callbackClose + 1);
      const accepted = [...callback.matchAll(new RegExp(
        `\\?\\((${id})=!0,${owner[2]}\\.markAppQuitting\\(\\)\\):${head[2]}\\.preventDefault\\(\\)`, "gu",
      ))];
      const addon = [...callback.matchAll(new RegExp(
        `\\?\\?(${id})\\(\\{electronAppPath:${id},resourcesPath:${id}\\}\\)`, "gu",
      ))];
      assert.equal(accepted.length, 1);
      assert.equal(addon.length, 1);
      callbacks.push({ callback, event: head[2], electron: head[1], quitState: owner[1], windows: owner[2],
        quitting: accepted[0][1], addon: addon[0][1] });
    }
  }
  assert.equal(callbacks.length, 1, "Expected the unique current native quit lifecycle owner");
  const site = callbacks[0];
  for (const platform of ["linux", "win32", "darwin"]) {
    for (const privacy of [false, true, "throws"]) {
      let marked = 0, prevented = 0, approvalReads = 0, addonLoads = 0;
      const context = {
        process: { platform, resourcesPath: "/inert/resources" },
        [site.electron]: { app: { getAppPath: () => "/inert/app" } },
        [site.windows]: { markAppQuitting: () => { marked++; } },
        [site.quitState]: { canQuitWithoutPrompt: () => { approvalReads++; return false; } },
        [site.quitting]: false,
        [site.addon]: () => {
          addonLoads++;
          return { isPrivacySettingsTerminationRequest() {
            if (privacy === "throws") throw new Error("inert unavailable addon");
            return privacy;
          } };
        },
      };
      const callback = vm.runInNewContext(`(${site.event}=>${site.callback})`, context);
      callback({ preventDefault() { prevented++; } });
      const rejected = platform === "darwin" && privacy === true;
      assert.equal(marked, rejected ? 0 : 1, `${platform}/${privacy}: native quitting transition`);
      assert.equal(prevented, rejected ? 1 : 0, `${platform}/${privacy}: native event cancellation`);
      assert.equal(context[site.quitting], !rejected);
      assert.equal(approvalReads, 0, "Ordinary native quits do not require approval consumption");
      assert.equal(addonLoads, platform === "darwin" ? 1 : 0, "The privacy addon stays macOS-only");
    }
  }
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

test("target context normalizes package aliases and accepts equivalent explicit overrides", () => {
  for (const [alias, expected] of [["amd64", "x64"], ["x86_64", "x64"], ["x64", "x64"], ["aarch64", "arm64"], ["arm64", "arm64"]]) {
    for (const key of ["CODEX_TARGET_ARCH", "CODEX_LINUX_TARGET_ARCH"]) {
      const context = detectLinuxTargetContext({ env: { [key]: alias, PATH: "" }, osReleaseFields: {} });
      assert.equal(context.arch, expected);
    }
  }
  assert.equal(detectLinuxTargetContext({ env: {
    CODEX_TARGET_ARCH: "amd64", CODEX_LINUX_TARGET_ARCH: "x86_64", PATH: "",
  }, osReleaseFields: {} }).arch, "x64");
  assert.equal(detectLinuxTargetContext({ env: {
    CODEX_TARGET_ARCH: "arm64", CODEX_LINUX_TARGET_ARCH: "aarch64", PATH: "",
  }, osReleaseFields: {} }).arch, "arm64");
});

test("unknown and conflicting architecture inputs reject before asset writes", t => {
  const cache = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "codex-desktop-dev", "tmp");
  fs.mkdirSync(cache, { recursive: true });
  const root = fs.mkdtempSync(path.join(cache, "target-context-conflict-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const main = path.join(root, ".vite/build/early-bootstrap.js");
  fs.mkdirSync(path.dirname(main), { recursive: true });
  fs.writeFileSync(main, "const originalAsset=true;");
  for (const env of [
    { CODEX_TARGET_ARCH: "arm64", CODEX_LINUX_TARGET_ARCH: "amd64" },
    { CODEX_TARGET_ARCH: "ppc64" },
    { CODEX_LINUX_TARGET_ARCH: "unknown" },
  ]) {
    assert.throws(() => patchExtractedApp(root, {
      featuresConfigPath: emptyConfig,
      linuxTargetOptions: { env: { ...env, PATH: "" }, osReleaseFields: {} },
    }), /architecture|conflicts/u);
    assert.equal(fs.readFileSync(main, "utf8"), "const originalAsset=true;");
  }
});

test("an explicit runner linuxTarget object keeps priority over environment detection", () => {
  const explicit = { ...fedoraKde, arch: "arm64" };
  const context = createMainBundleContext(null, {
    featuresConfigPath: emptyConfig,
    linuxTarget: explicit,
    linuxTargetOptions: { env: { CODEX_TARGET_ARCH: "unknown", CODEX_LINUX_TARGET_ARCH: "other" } },
  });
  assert.equal(context.linux, explicit);
  assert.equal(context.linuxTarget, explicit);
  assert.equal(context.linux.arch, "arm64");
});
