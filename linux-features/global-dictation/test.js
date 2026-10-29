#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const { loadLinuxFeaturePatchDescriptors } = require("../../scripts/lib/linux-features.js");
const { createPatchReport } = require("../../scripts/lib/patch-report.js");
const {
  applyMainBundlePatchDescriptors,
  normalizePatchDescriptors,
} = require("../../scripts/patches/engine.js");
const {
  descriptors, applyLinuxGlobalDictationMainProcessPatch,
} = require("./patch.js");

const hostPathEntries = (process.env.PATH ?? "")
  .split(path.delimiter)
  .filter((entry) => path.isAbsolute(entry));
const hostPath = [...new Set(hostPathEntries)].join(path.delimiter);
const X11_RELEASE_MONITOR_TEST_TIMEOUT_MS = 3000;

function findHostExecutable(name) {
  const executable = hostPathEntries
    .map((entry) => path.join(entry, name))
    .find((candidate) => {
      try {
        if (!fs.statSync(candidate).isFile()) return false;
        fs.accessSync(candidate, fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
  assert.ok(executable, `required host executable is unavailable: ${name}`);
  return executable;
}

const hostBash = findHostExecutable("bash");

const {mainBundleFixture,applyPatchTwice,waylandPatchContext,fakeHelperChild}=require("../../scripts/patches/lib/global-shortcuts-portal.test-helpers.js");

function writeExecutable(filePath, body) {
  fs.writeFileSync(filePath, body, { mode: 0o755 });
}

function runX11ReleaseMonitor({
  accelerator,
  xmodmapLines,
  queryStateLines,
  testLines,
  timeout = X11_RELEASE_MONITOR_TEST_TIMEOUT_MS,
}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "global-dictation-x11-map-"));
  const binDir = path.join(tempDir, "bin");
  fs.mkdirSync(binDir);
  writeExecutable(
    path.join(binDir, "xmodmap"),
    `#!${hostBash}\nprintf '%s\\n' ${xmodmapLines.map((line) => JSON.stringify(line)).join(" ")}\n`,
  );
  writeExecutable(
    path.join(binDir, "xinput"),
    [
      `#!${hostBash}`,
      "if [ \"$1\" = list ]; then printf '%s\\n' 'Virtual keyboard id=12 [slave  keyboard (3)]'; exit 0; fi",
      `if [ "$1" = query-state ]; then printf '%s\\n' ${queryStateLines
        .map((line) => JSON.stringify(line))
        .join(" ")}; exit 0; fi`,
      `if [ "$1" = test ]; then ${testLines.join("; ")}; exit 0; fi`,
      "exit 2",
    ].join("\n"),
  );

  try {
    return spawnSync(
      path.join(__dirname, "bin", "global-dictation-release-monitor"),
      ["--accelerator", accelerator],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          DISPLAY: ":99",
          PATH: `${binDir}${path.delimiter}${hostPath}`,
        },
        timeout,
      },
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

test("global dictation stays disabled until selected", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "global-dictation-feature-"));
  const configPath = path.join(tempDir, "features.json");
  const featuresRoot = path.resolve(__dirname, "..");
  const previous = process.env.CODEX_LINUX_FEATURES_CONFIG;

  try {
    process.env.CODEX_LINUX_FEATURES_CONFIG = configPath;
    fs.writeFileSync(configPath, '{"enabled":[]}\n');
    assert.deepEqual(loadLinuxFeaturePatchDescriptors({ featuresRoot }), []);

    fs.writeFileSync(configPath, '{"enabled":["global-dictation"]}\n');
    const loaded = loadLinuxFeaturePatchDescriptors({ featuresRoot });
    assert.deepEqual(loaded.map((descriptor) => descriptor.id), [
      "feature:global-dictation:linux-global-dictation-main-process",
    ]);
    assert.equal(loaded[0].ciPolicy, "optional");
  } finally {
    if (previous == null) delete process.env.CODEX_LINUX_FEATURES_CONFIG;
    else process.env.CODEX_LINUX_FEATURES_CONFIG = previous;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("main patch installs into exactly one signed main-process chunk", { skip: !process.env.CODEX_SIGNED_EXTRACTED_APP }, () => {
  const buildDir = path.join(process.env.CODEX_SIGNED_EXTRACTED_APP, ".vite/build");
  const chunks = fs.readdirSync(buildDir).filter((name) => /^early-bootstrap(?:-\d+-[0-9a-f]{16})?\.js$/.test(name));
  assert.ok(chunks.length > 1);
  const patchedChunks = [];
  const previousWarn = console.warn;
  console.warn = () => {};
  try {
    for (const name of chunks) {
      const source = fs.readFileSync(path.join(buildDir, name), "utf8");
      const patched = applyLinuxGlobalDictationMainProcessPatch(source);
      if (patched === source) continue;
      patchedChunks.push(name);
      assert.equal(applyLinuxGlobalDictationMainProcessPatch(patched), patched, name);
      assert.doesNotThrow(() => new vm.Script(patched, { filename: name }), name);
      for (const marker of ['linuxCommandId:"globalDictationHold"', 'linuxCommandId:"globalDictationSingleTap"',
        "codexLinuxGlobalDictationReleaseWatcher(", "await codexLinuxGlobalDictationPasteX11()",
        "Modifier-only shortcuts are not supported for global dictation on Linux.", "codex-linux-global-shortcuts-portal-v1"]) {
        assert.ok(patched.includes(marker), `${name}: ${marker}`);
      }
      // Injected helpers share the owning module's scope instead of the chunk prologue.
      assert.ok(patched.startsWith(source.slice(0, 200)), name);
    }
  } finally {
    console.warn = previousWarn;
  }
  assert.equal(patchedChunks.length, 1, patchedChunks.join(","));
});

test("main patch enables Linux and preserves the other platform gates", () => {
  const patched = applyPatchTwice(mainBundleFixture());
  assert.match(
    patched,
    /function W7\(\)\{return"darwin"===process\.platform\|\|"win32"===process\.platform\|\|"linux"===process\.platform\}/,
  );
  assert.match(patched, /return;case"linux":if\(codexLinuxGlobalShortcutsUsesWayland\(\)\)/);
  assert.match(patched, /return;case"aix":case"android":case"cygwin":case"freebsd":case"haiku":case"netbsd":case"openbsd":case"sunos":throw Error\("Global dictation paste is not supported on this OS\."\)/);
  assert.match(
    patched,
    /await codexLinuxGlobalDictationPasteX11\(\)/,
  );
  assert.doesNotMatch(patched, /return _A\(n,t\)/);
  assert.doesNotMatch(patched, /await k7\(`xdotool`/);
});

test("main patch accepts the verified Windows-first registration and validation layout", () => {
  const patched = applyPatchTwice(mainBundleFixture());
  assert.match(patched, /function fA\(e\)\{if\("linux"===process\.platform&&Rk\(e\)\)return"Modifier-only shortcuts/u);
  assert.match(patched, /codexLinuxGlobalShortcutsPortalRegistration/u);
});

test("modifier validation is scoped to the registration function", () => {
  const source = "function unrelated(e){if(unrelatedCheck(e)||otherCheck(e))return;}" + mainBundleFixture();
  const patched = applyPatchTwice(source);
  assert.match(patched, /"linux"===process\.platform&&Rk\(e\)\)return"Modifier-only shortcuts/u);
  assert.doesNotMatch(patched, /"linux"===process\.platform&&unrelatedCheck\(e\)/);
});

test("dictation registration failures clean up only their own action", () => {
  const ctx = waylandPatchContext([]);
  const controller = vm.runInNewContext("new H7()", ctx);
  const removed = [];
  controller.unregisterHotkey = () => removed.push("hold");
  controller.unregisterToggleHotkey = () => removed.push("toggle");
  controller.deactivateLifecycle = () => assert.fail("failure must be scoped to one action");
  controller.handleLinuxHotkeyUnavailable("hold", new Error("denied"));
  controller.handleLinuxHotkeyUnavailable("toggle", new Error("denied"));
  assert.deepEqual(removed, ["hold", "toggle"]);
});

test("main patch rejects retired, partial, duplicate, and ambiguous toggle registrations", () => {
  const current = 'eA(e,{onRegistrationChanged:()=>this.publishShortcutRecovery(),onPressed:()=>{this.setupWindowFocused||(this.ensureHotkeyReleaseWatchers(),this.shortcutGestures.press("single-tap",Wl(e)||"win32"===process.platform&&oP(e)))},onReleased:()=>{this.setupWindowFocused||this.shortcutGestures.release("single-tap")},onCancelled:()=>{this.setupWindowFocused||this.shortcutGestures.cancelPress("single-tap")}},{bareModifierTrigger:"cancellablePress",ownership:t})';
  const retired = 'eA(e,{onPressed:()=>{this.handleToggleHotkeyPressed()}},{bareModifierTrigger:"release",ownership:t})';
  const fixture = mainBundleFixture();
  const variants = {
    retired: fixture.replace(current, retired),
    partial: fixture.replace(',onCancelled:()=>{this.setupWindowFocused||this.shortcutGestures.cancelPress("single-tap")}', ""),
    duplicate: fixture.replace(current, `${current},${current}`),
    ambiguous: fixture + `function duplicate(e,t){return ${current}}`,
  };

  for (const [name, source] of Object.entries(variants)) {
    assert.notEqual(source, fixture, name);
    assert.equal(applyLinuxGlobalDictationMainProcessPatch(source), source, name);
  }
});

test("main patch handles dollar signs in minified identifiers", () => {
  const source = mainBundleFixture()
    .split("eA")
    .join("e$A")
    .split("Lk")
    .join("L$k");
  const patched = applyPatchTwice(source);
  assert.match(patched, /function e\$A\(e,t,r\)/);
  assert.match(patched, /e\$A\(e,\{linuxCommandId:"globalDictationHold",onRegistrationChanged:/);
  assert.match(patched, /Rk\(e\)\)return"Modifier-only shortcuts/);
});

test("main patch fails closed when the ownership release alias drifts", () => {
  const source = mainBundleFixture()
    .replace(
      "onReleased:null==s?void 0:()=>{i.isOwner()&&s()}",
      "onReleased:null==s?void 0:()=>{i.isOwner()&&q()}",
    );
  assert.notEqual(source, mainBundleFixture());
  assert.equal(applyLinuxGlobalDictationMainProcessPatch(source), source);
  assert.doesNotMatch(source, /codex-linux-global-dictation-v3/);
});

test("X11 paste uses xdotool with fixed arguments", async () => {
  const calls = [];
  const context = waylandPatchContext([]);
  context.process.env = { DISPLAY: ":1", XDG_SESSION_TYPE: "x11" };
  context.__execFile = (file, args, options, callback) => {
    calls.push([file, args, options]);
    callback();
  };

  await context.P7();
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ["xdotool", ["key", "--clearmodifiers", "ctrl+v"], { windowsHide: true }],
  ]);
});

test("X11 paste propagates xdotool failures", async () => {
  const context = waylandPatchContext([]);
  context.process.env = { DISPLAY: ":1", XDG_SESSION_TYPE: "x11" };
  context.__execFile = (_file, _args, _options, callback) => {
    callback(new Error("xdotool failed"));
  };

  await assert.rejects(context.P7(), /xdotool failed/);
});

test("X11 hold mode starts the bounded release watcher", () => {
  const patched = applyPatchTwice(mainBundleFixture());
  assert.match(patched, /function codexLinuxGlobalDictationReleaseWatcher\(/);
  assert.match(patched, /return r\}case"linux":\{let n=codexLinuxGlobalDictationReleaseWatcher\(e,t\);if\(null==n\)throw Error\("Global dictation hotkey release watching is not supported\."\);return n\}case"win32":case"aix":/);
  assert.doesNotMatch(patched, /case"haiku":case"linux":/);
  assert.match(
    patched,
    /"linux"===process\.platform&&Rk\(e\)\)return"Modifier-only shortcuts are not supported for global dictation on Linux\."/,
  );
});

test("X11 hold watcher exposes a disposable and releases once", async () => {
  const firstChild = fakeHelperChild();
  const secondChild = fakeHelperChild();
  const context = waylandPatchContext([firstChild, secondChild]);
  context.process.env = { DISPLAY: ":1", XDG_SESSION_TYPE: "x11" };
  let releases = 0;

  const completed = context.pA("Ctrl+Space", () => releases++);
  assert.equal(typeof completed.dispose, "function");
  firstChild.emit("exit", 0);
  firstChild.emit("error", new Error("late error"));
  await new Promise(setImmediate);
  assert.equal(releases, 1);

  const cancelled = context.pA("Ctrl+Space", () => releases++);
  cancelled.dispose();
  secondChild.emit("exit", 0);
  await new Promise(setImmediate);
  assert.equal(secondChild.killed, true);
  assert.equal(releases, 1);
});

test("feature descriptor stays limited to the main bundle", () => {
  assert.equal(descriptors.length, 1);
  assert.equal(descriptors[0].phase, "main-bundle");
});

test("X11 release watcher exits when a required modifier is released", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "global-dictation-x11-"));
  const binDir = path.join(tempDir, "bin");
  const stateFile = path.join(tempDir, "state");
  fs.mkdirSync(binDir);
  fs.writeFileSync(stateFile, "0\n");
  fs.writeFileSync(
    path.join(binDir, "xmodmap"),
    `#!${hostBash}\nprintf '%s\\n' 'keycode 37 = Control_L' 'keycode 65 = space' 'keycode 105 = Control_R'\n`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(binDir, "xinput"),
    [
      `#!${hostBash}`,
      "if [ \"$1\" = list ]; then",
      "  printf '%s\\n' 'Virtual keyboard id=12 [slave  keyboard (3)]'",
      "  exit 0",
      "fi",
      "if [ \"$1\" = query-state ]; then",
      "  count=$(cat \"$STATE_FILE\")",
      "  printf '%s\\n' 'key[37]=down' 'key[65]=down'",
      "  echo $((count + 1)) > \"$STATE_FILE\"",
      "  exit 0",
      "fi",
      "if [ \"$1\" = test ]; then sleep 0.05; printf '%s\\n' 'key release 37'; exit 0; fi",
      "exit 2",
    ].join("\n"),
    { mode: 0o755 },
  );

  try {
    const result = spawnSync(
      path.join(__dirname, "bin", "global-dictation-release-monitor"),
      ["--accelerator", "CommandOrControl+Space"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          DISPLAY: ":99",
          PATH: `${binDir}${path.delimiter}${hostPath}`,
          STATE_FILE: stateFile,
        },
        timeout: 2000,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(Number(fs.readFileSync(stateFile, "utf8")), 1);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("X11 release watcher exits when the primary key is released while the modifier stays down", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "global-dictation-primary-release-"));
  const binDir = path.join(tempDir, "bin");
  fs.mkdirSync(binDir);
  fs.writeFileSync(
    path.join(binDir, "xmodmap"),
    `#!${hostBash}\nprintf '%s\\n' 'keycode 37 = Control_L' 'keycode 65 = space'\n`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(binDir, "xinput"),
    [
      `#!${hostBash}`,
      "if [ \"$1\" = list ]; then printf '%s\\n' 'Virtual keyboard id=12 [slave  keyboard (3)]'; exit 0; fi",
      "if [ \"$1\" = query-state ]; then printf '%s\\n' 'key[37]=down' 'key[65]=down'; exit 0; fi",
      "if [ \"$1\" = test ]; then sleep 0.05; printf '%s\\n' 'key release 65'; sleep 10; exit 0; fi",
      "exit 2",
    ].join("\n"),
    { mode: 0o755 },
  );

  try {
    const result = spawnSync(
      path.join(__dirname, "bin", "global-dictation-release-monitor"),
      ["--accelerator", "Ctrl+Space"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          DISPLAY: ":99",
          PATH: `${binDir}${path.delimiter}${hostPath}`,
        },
        timeout: X11_RELEASE_MONITOR_TEST_TIMEOUT_MS,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.signal, null);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("X11 release watcher prefers resolved keycodes over fallback codes", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "global-dictation-remap-"));
  const binDir = path.join(tempDir, "bin");
  fs.mkdirSync(binDir);
  fs.writeFileSync(
    path.join(binDir, "xmodmap"),
    `#!${hostBash}\nprintf '%s\\n' 'keycode 90 = Control_L' 'keycode 38 = a A'\n`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(binDir, "xinput"),
    [
      `#!${hostBash}`,
      "if [ \"$1\" = list ]; then printf '%s\\n' 'Remapped keyboard id=12 [slave  keyboard (3)]'; exit 0; fi",
      "if [ \"$1\" = query-state ]; then printf '%s\\n' 'key[90]=up' 'key[37]=down' 'key[38]=down'; exit 0; fi",
      "if [ \"$1\" = test ]; then sleep 10; exit 0; fi",
      "exit 2",
    ].join("\n"),
    { mode: 0o755 },
  );

  try {
    const result = spawnSync(
      path.join(__dirname, "bin", "global-dictation-release-monitor"),
      ["--accelerator", "Ctrl+A"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          DISPLAY: ":99",
          PATH: `${binDir}${path.delimiter}${hostPath}`,
        },
        timeout: X11_RELEASE_MONITOR_TEST_TIMEOUT_MS,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.signal, null);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("X11 release watcher resolves Electron punctuation aliases case-insensitively", () => {
  const result = runX11ReleaseMonitor({
    accelerator: "Ctrl+Plus",
    xmodmapLines: ["keycode 37 = Control_L", "keycode 21 = equal plus"],
    queryStateLines: ["key[37]=down", "key[21]=down"],
    testLines: ["sleep 0.05", "printf '%s\\n' 'key release 21'", "sleep 10"],
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.signal, null);
});

test("X11 release watcher resolves media and numpad aliases", () => {
  const media = runX11ReleaseMonitor({
    accelerator: "Ctrl+VolumeUp",
    xmodmapLines: ["keycode 37 = Control_L", "keycode 123 = XF86AudioRaiseVolume"],
    queryStateLines: ["key[37]=down", "key[123]=down"],
    testLines: ["sleep 0.05", "printf '%s\\n' 'key release 123'", "sleep 10"],
  });
  assert.equal(media.status, 0, media.stderr);
  assert.equal(media.signal, null);

  const numpad = runX11ReleaseMonitor({
    accelerator: "Ctrl+NumAdd",
    xmodmapLines: ["keycode 37 = Control_L", "keycode 86 = KP_Add"],
    queryStateLines: ["key[37]=down", "key[86]=down"],
    testLines: ["sleep 0.05", "printf '%s\\n' 'key release 86'", "sleep 10"],
  });
  assert.equal(numpad.status, 0, numpad.stderr);
  assert.equal(numpad.signal, null);
});

test("main patch warns when the release watcher sentinel is missing", () => {
  const source = mainBundleFixture().replaceAll(
    "Global dictation hotkey release watching is not supported.",
    "Global dictation release watcher changed.",
  );
  const warnings = [];
  const previousWarn = console.warn;
  console.warn = (message) => warnings.push(message);

  try {
    assert.equal(applyLinuxGlobalDictationMainProcessPatch(source), source);
  } finally {
    console.warn = previousWarn;
  }

  assert.deepEqual(warnings, [
    "WARN: release watcher sentinel was not found - skipping Linux global dictation patch",
  ]);
});

test("main patch reports a missing release watcher sentinel as an optional skip", () => {
  const source = mainBundleFixture().replaceAll(
    "Global dictation hotkey release watching is not supported.",
    "Global dictation release watcher changed.",
  );
  const report = createPatchReport();
  const [descriptor] = normalizePatchDescriptors([
    {
      ...descriptors[0],
      id: "feature:global-dictation:linux-global-dictation-main-process",
      sourceKind: "feature",
      featureId: "global-dictation",
    },
  ]);

  const result = applyMainBundlePatchDescriptors(source, [descriptor], {}, report);

  assert.equal(result.patchedSource, source);
  assert.deepEqual(report.patches, [
    {
      name: "feature:global-dictation:linux-global-dictation-main-process",
      status: "skipped-optional",
      reason: "WARN: release watcher sentinel was not found - skipping Linux global dictation patch",
      phase: "main-bundle",
      targetSummary: "all-linux",
      ciPolicy: "optional",
      enforceWhenEnabled: true,
      sourceKind: "feature",
      featureId: "global-dictation",
      warnings: ["WARN: release watcher sentinel was not found - skipping Linux global dictation patch"],
    },
  ]);
});

test("X11 release watcher fails closed without a display or modifier", () => {
  const monitor = path.join(__dirname, "bin", "global-dictation-release-monitor");
  const withoutDisplay = spawnSync(monitor, ["--accelerator", "Ctrl+Space"], {
    encoding: "utf8",
    env: { ...process.env, DISPLAY: "", PATH: hostPath },
  });
  assert.equal(withoutDisplay.status, 1);
  assert.match(withoutDisplay.stderr, /X11 display is unavailable/);

  const withoutModifier = spawnSync(monitor, ["--accelerator", "Space"], {
    encoding: "utf8",
    env: { ...process.env, DISPLAY: ":99", PATH: hostPath },
  });
  assert.notEqual(withoutModifier.status, 0);
});

test("stage hook accepts a verified prebuilt helper", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "global-dictation-stage-"));
  try {
    const helper = path.join(tempDir, "helper");
    writeExecutable(helper, "#!/bin/sh\nexit 0\n");
    execFileSync(path.join(__dirname, "stage.sh"), {
      cwd: path.resolve(__dirname, "../.."),
      env: {
        ...process.env,
        CODEX_GLOBAL_DICTATION_LINUX_SOURCE: helper,
        INSTALL_DIR: tempDir,
        SCRIPT_DIR: path.resolve(__dirname, "../.."),
      },
      stdio: "pipe",
    });
    const target = path.join(tempDir, "resources", "native", "codex-global-dictation-linux");
    assert.equal(fs.statSync(target).mode & 0o777, 0o755);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("stage hook requires a release artifact and never invokes Cargo", () => {
  const stage = fs.readFileSync(path.join(__dirname, "../../scripts/lib/stage-global-shortcuts.sh"), "utf8");
  assert.doesNotMatch(stage, /cargo\s+(?:build|install)/);
  assert.match(stage, /global-dictation-linux\/target\/release\/codex-global-dictation-linux/);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "global-dictation-missing-release-"));
  try {
    assert.throws(
      () => execFileSync(path.join(__dirname, "stage.sh"), {
        cwd: "/",
        env: {
          ...process.env,
          CODEX_GLOBAL_DICTATION_LINUX_SOURCE: path.join(tempDir, "missing-helper"),
          INSTALL_DIR: path.join(tempDir, "install"),
          SCRIPT_DIR: path.resolve(__dirname, "../.."),
        },
        stdio: "pipe",
      }),
      /Command failed/,
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
