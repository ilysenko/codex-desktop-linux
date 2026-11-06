#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { execFileSync, spawn, spawnSync } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const { loadLinuxFeaturePatchDescriptors } = require("../../scripts/lib/linux-features.js");
const { createPatchReport } = require("../../scripts/lib/patch-report.js");
const {
  applyExtractedAppPatchDescriptors,
  normalizePatchDescriptors,
} = require("../../scripts/patches/engine.js");
const {
  descriptors, applyLinuxGlobalDictationMainProcessPatch, inspectGlobalDictationMainProcess,
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

// Behaves like uutils stdbuf (uutils/coreutils#13939): it makes a temporary
// directory in TMPDIR and execs its command, so nothing removes the directory.
const LEAKY_STDBUF = `#!${hostBash}\nmktemp -d "\${TMPDIR:-/tmp}/.tmpXXXXXX" >/dev/null || exit 125\nshift\nexec "$@"\n`;

// What the monitor's event dir and its stdbuf runs leave in TMPDIR.
function monitorLeftovers(tempDir) {
  return fs
    .readdirSync(tempDir)
    .filter((name) => name.startsWith("codex-global-dictation.") || name.startsWith(".tmp"));
}

// TMPDIR is the fixture here, so check it before the fixture's removal would
// hide a leftover.
function assertMonitorLeftNothing(tempDir) {
  assert.deepEqual(monitorLeftovers(tempDir), []);
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
  writeExecutable(path.join(binDir, "stdbuf"), LEAKY_STDBUF);
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
    const result = spawnSync(
      path.join(__dirname, "bin", "global-dictation-release-monitor"),
      ["--accelerator", accelerator],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          DISPLAY: ":99",
          PATH: `${binDir}${path.delimiter}${hostPath}`,
          // The monitor keeps its event dir and stdbuf directory in the fixture.
          TMPDIR: tempDir,
        },
        timeout,
      },
    );
    assertMonitorLeftNothing(tempDir);
    return result;
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
        "codexLinuxGlobalDictationReleaseWatcher(", "await codexLinuxGlobalDictationPasteX11(",
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

test("main patch enables Linux and preserves the native clipboard and other platform bodies", () => {
  const source = mainBundleFixture(), patched = applyPatchTwice(source);
  const before = inspectGlobalDictationMainProcess(source).plan;
  const after = inspectGlobalDictationMainProcess(patched).plan;
  assert.match(after.capability.text, /return"darwin"===process\.platform\|\|"win32"===process\.platform\|\|"linux"===process\.platform/u);
  const signal = after.paste.parameters;
  const guard = `if("linux"===process.platform){if(codexLinuxGlobalShortcutsUsesWayland()){await codexLinuxGlobalShortcutsPaste(${signal});return}await codexLinuxGlobalDictationPasteX11(${signal});return}`;
  assert.ok(after.paste.text.includes(guard));
  assert.equal(after.paste.text.replace(guard, ""), before.paste.text);
  assert.equal(after.bridge.text.replace(guard, ""), before.bridge.text);
  assert.equal(after.accessibility.text, before.accessibility.text);
  assert.deepEqual(after.bridge.invocation.arguments, before.bridge.invocation.arguments);
  assert.equal(after.bridge.invocation.wrapped, true);
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
    ambiguous: fixture.replace("let L=new H7({windowManager:D,globalState:G});", "let L=new H7({windowManager:D,globalState:G}),other=new H7({windowManager:D,globalState:G});"),
  };

  for (const [name, source] of Object.entries(variants)) {
    assert.notEqual(source, fixture, name);
    assert.equal(applyLinuxGlobalDictationMainProcessPatch(source), source, name);
  }
});

test("main patch handles dollar signs in minified identifiers", () => {
  const source = mainBundleFixture()
    .replace(/(?<![\w$])eA(?![\w$])/g, () => "e$A")
    .replace(/(?<![\w$])Lk(?![\w$])/g, () => "L$k");
  assert.ok(source.includes("loadNativeAddon:"), "Renaming a symbol preserves native parameter roles");
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

  await context.codexLinuxGlobalDictationPasteX11();
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

  await assert.rejects(context.codexLinuxGlobalDictationPasteX11(), /xdotool failed/);
});

test("X11 hold mode adds only its Linux release watcher guard", () => {
  const source = mainBundleFixture(), patched = applyPatchTwice(source);
  const before = inspectGlobalDictationMainProcess(source).plan;
  const after = inspectGlobalDictationMainProcess(patched).plan;
  const [accelerator, released] = after.watcher.parameters.split(",");
  const guard = `if("linux"===process.platform){let codexLinuxGlobalDictationWatcher=codexLinuxGlobalDictationReleaseWatcher(${accelerator},${released});if(null==codexLinuxGlobalDictationWatcher)throw Error("Global dictation hotkey release watching is not supported.");return codexLinuxGlobalDictationWatcher}`;
  assert.ok(after.watcher.text.includes(guard));
  assert.equal(after.watcher.text.replace(guard, ""), before.watcher.text);
  assert.match(patched, /"linux"===process\.platform&&Rk\(e\)\)return"Modifier-only shortcuts are not supported for global dictation on Linux\."/u);
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

test("feature descriptor owns a complete main inventory transaction", () => {
  assert.equal(descriptors.length, 1);
  assert.equal(descriptors[0].phase, "extracted-app:pre-webview");
});

test("X11 release watcher exits when a required modifier is released", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "global-dictation-x11-"));
  const binDir = path.join(tempDir, "bin");
  const stateFile = path.join(tempDir, "state");
  fs.mkdirSync(binDir);
  writeExecutable(path.join(binDir, "stdbuf"), LEAKY_STDBUF);
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
          // The monitor keeps its event dir and stdbuf directory in the fixture.
          TMPDIR: tempDir,
          STATE_FILE: stateFile,
        },
        timeout: 2000,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assertMonitorLeftNothing(tempDir);
    assert.equal(Number(fs.readFileSync(stateFile, "utf8")), 1);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("X11 release watcher exits when the primary key is released while the modifier stays down", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "global-dictation-primary-release-"));
  const binDir = path.join(tempDir, "bin");
  fs.mkdirSync(binDir);
  writeExecutable(path.join(binDir, "stdbuf"), LEAKY_STDBUF);
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
      "if [ \"$1\" = test ]; then sleep 0.05; printf '%s\\n' 'key release 65'; exec sleep 10; fi",
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
          // The monitor keeps its event dir and stdbuf directory in the fixture.
          TMPDIR: tempDir,
        },
        timeout: X11_RELEASE_MONITOR_TEST_TIMEOUT_MS,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assertMonitorLeftNothing(tempDir);
    assert.equal(result.signal, null);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("X11 release watcher prefers resolved keycodes over fallback codes", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "global-dictation-remap-"));
  const binDir = path.join(tempDir, "bin");
  fs.mkdirSync(binDir);
  writeExecutable(path.join(binDir, "stdbuf"), LEAKY_STDBUF);
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
      "if [ \"$1\" = test ]; then exec sleep 10; fi",
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
          // The monitor keeps its event dir and stdbuf directory in the fixture.
          TMPDIR: tempDir,
        },
        timeout: X11_RELEASE_MONITOR_TEST_TIMEOUT_MS,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assertMonitorLeftNothing(tempDir);
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
    testLines: ["sleep 0.05", "printf '%s\\n' 'key release 21'", "exec sleep 10"],
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.signal, null);
});

test("X11 release watcher resolves media and numpad aliases", () => {
  const media = runX11ReleaseMonitor({
    accelerator: "Ctrl+VolumeUp",
    xmodmapLines: ["keycode 37 = Control_L", "keycode 123 = XF86AudioRaiseVolume"],
    queryStateLines: ["key[37]=down", "key[123]=down"],
    testLines: ["sleep 0.05", "printf '%s\\n' 'key release 123'", "exec sleep 10"],
  });
  assert.equal(media.status, 0, media.stderr);
  assert.equal(media.signal, null);

  const numpad = runX11ReleaseMonitor({
    accelerator: "Ctrl+NumAdd",
    xmodmapLines: ["keycode 37 = Control_L", "keycode 86 = KP_Add"],
    queryStateLines: ["key[37]=down", "key[86]=down"],
    testLines: ["sleep 0.05", "printf '%s\\n' 'key release 86'", "exec sleep 10"],
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

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /dictation release helper consumption/u);
});

test("main descriptor reports missing live helper authority without writing", (t) => {
  const source = mainBundleFixture().replaceAll(
    "Global dictation hotkey release watching is not supported.", "Global dictation release watcher changed.");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "global-dictation-missing-authority-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const build = path.join(root, ".vite/build"); fs.mkdirSync(build, { recursive: true });
  const target = path.join(build, "early-bootstrap-45-abc.js"); fs.writeFileSync(target, source);
  const report = createPatchReport();
  const selected = normalizePatchDescriptors(descriptors.map(descriptor => ({ ...descriptor,
    id: "feature:global-dictation:" + descriptor.id, sourceKind: "feature", featureId: "global-dictation" })));
  applyExtractedAppPatchDescriptors(root, selected, {}, report, "extracted-app:pre-webview");
  assert.equal(fs.readFileSync(target, "utf8"), source);
  assert.equal(report.patches[0].status, "skipped-optional");
  assert.equal(report.patches[0].phase, "extracted-app:pre-webview");
  assert.match(report.patches[0].reason, /dictation release helper consumption/u);
});

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  test(`X11 release watcher removes its event and stdbuf directories on ${signal}`, { timeout: 15_000 }, async (t) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "global-dictation-signal-"));
    t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
    const binDir = path.join(tempDir, "bin");
    const started = path.join(tempDir, "started");
    fs.mkdirSync(binDir);
    writeExecutable(path.join(binDir, "stdbuf"), LEAKY_STDBUF);
    writeExecutable(
      path.join(binDir, "xmodmap"),
      `#!${hostBash}\nprintf '%s\\n' 'keycode 37 = Control_L' 'keycode 65 = space'\n`,
    );
    // Two keyboards: one stdbuf run, and one stdbuf directory, each.
    writeExecutable(
      path.join(binDir, "xinput"),
      [
        `#!${hostBash}`,
        "if [ \"$1\" = list ]; then printf '%s\\n' 'Keyboard A id=12 [slave  keyboard (3)]' 'Keyboard B id=13 [slave  keyboard (3)]'; exit 0; fi",
        "if [ \"$1\" = query-state ]; then printf '%s\\n' 'key[37]=down' 'key[65]=down'; exit 0; fi",
        "if [ \"$1\" = test ]; then echo \"$2\" >> \"$STARTED_FILE\"; exec sleep 30; fi",
        "exit 2",
      ].join("\n"),
    );

    const monitor = spawn(
      path.join(__dirname, "bin", "global-dictation-release-monitor"),
      ["--accelerator", "Ctrl+Space"],
      {
        env: {
          ...process.env,
          DISPLAY: ":99",
          PATH: `${binDir}${path.delimiter}${hostPath}`,
          STARTED_FILE: started,
          TMPDIR: tempDir,
        },
        stdio: ["ignore", "ignore", "pipe"],
        // Its own process group, so cleanup reaches the keyboard and watchdog
        // children too if the test fails early.
        detached: true,
      },
    );
    t.after(() => {
      try {
        process.kill(-monitor.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    });
    const exited = once(monitor, "exit");
    const deadline = Date.now() + 5_000;
    const startedKeyboards = () =>
      fs.existsSync(started) ? fs.readFileSync(started, "utf8").trim().split("\n").length : 0;
    while (startedKeyboards() < 2) {
      assert.ok(Date.now() < deadline, "the monitor never started both keyboards");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    // While it runs, both stdbuf directories sit inside the event dir.
    const [eventDir] = monitorLeftovers(tempDir);
    assert.match(eventDir, /^codex-global-dictation\./);
    assert.equal(fs.readdirSync(path.join(tempDir, eventDir, "stdbuf")).length, 2);

    // Only the monitor gets the signal, as when the app stops it.
    monitor.kill(signal);
    const [code, exitSignal] = await exited;
    assert.ok(code !== 0 || exitSignal !== null, "the monitor exited 0 on a signal");
    assertMonitorLeftNothing(tempDir);
  });
}

// Live processes whose environment sets TMPDIR to dir or to a directory under
// it, such as the stream's stdbuf directory: what a watcher run with that
// TMPDIR left behind. Zombies are skipped.
function processesWithTmpdir(dir) {
  const markers = [`\0TMPDIR=${dir}\0`, `\0TMPDIR=${dir}/`];
  const found = [];
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const environ = `\0${fs.readFileSync(`/proc/${entry}/environ`, "latin1")}`;
      if (!markers.some((marker) => environ.includes(marker))) continue;
      const stat = fs.readFileSync(`/proc/${entry}/stat`, "utf8");
      if (stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z") found.push(Number(entry));
    } catch {}
  }
  return found;
}

// Ends whatever a watcher run left, stopped processes included.
function killProcessesWithTmpdir(dir) {
  for (const pid of processesWithTmpdir(dir)) {
    for (const signal of ["SIGCONT", "SIGKILL"]) {
      try {
        process.kill(pid, signal);
      } catch {}
    }
  }
}

// The parent check runs sleep 1 in a loop. Here its sleep ignores SIGTERM and
// lasts 0.4 s, and pkill takes 1 s after it signals, so the loop forks its next
// sleep after pkill -P has listed the children and before kill reaches the
// subshell. That sleep must not outlive its helper.
test("X11 release watcher leaves no child that a helper forks during cleanup", { timeout: 20_000 }, async (t) => {
  let realPkill;
  try {
    realPkill = findHostExecutable("pkill");
  } catch {
    t.skip("pkill is unavailable");
    return;
  }
  const realSleep = findHostExecutable("sleep");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "global-dictation-cleanup-race-"));
  const sleepLog = path.join(tempDir, "sleeps");
  t.after(() => {
    killProcessesWithTmpdir(tempDir);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  const binDir = path.join(tempDir, "bin");
  fs.mkdirSync(binDir);
  writeExecutable(
    path.join(binDir, "xmodmap"),
    `#!${hostBash}\nprintf '%s\\n' 'keycode 37 = Control_L' 'keycode 65 = space'\n`,
  );
  writeExecutable(
    path.join(binDir, "xinput"),
    [
      `#!${hostBash}`,
      "if [ \"$1\" = list ]; then printf '%s\\n' 'Virtual keyboard id=12 [slave  keyboard (3)]'; exit 0; fi",
      "if [ \"$1\" = query-state ]; then printf '%s\\n' 'key[37]=down' 'key[65]=down'; exit 0; fi",
      `if [ "$1" = test ]; then ${realSleep} 0.5; printf '%s\\n' 'key release 37'; exec ${realSleep} 30; fi`,
      "exit 2",
    ].join("\n"),
  );
  writeExecutable(
    path.join(binDir, "pkill"),
    `#!${hostBash}\n${realPkill} "$@"\nstatus=$?\n${realSleep} 1\nexit "$status"\n`,
  );
  writeExecutable(
    path.join(binDir, "sleep"),
    [
      `#!${hostBash}`,
      'echo "$1" >> "$SLEEP_LOG"',
      `[ "$1" = 1 ] || exec ${realSleep} "$@"`,
      // Outlives SIGTERM, and reports when the helper that started it died first.
      "trap '' TERM",
      "helper=$PPID",
      `${realSleep} 0.4`,
      'kill -0 "$helper" 2>/dev/null || echo outlived >> "$SLEEP_LOG"',
    ].join("\n"),
  );

  const result = spawnSync(
    path.join(__dirname, "bin", "global-dictation-release-monitor"),
    ["--accelerator", "Ctrl+Space"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        DISPLAY: ":99",
        PATH: `${binDir}${path.delimiter}${hostPath}`,
        SLEEP_LOG: sleepLog,
        TMPDIR: tempDir,
      },
      timeout: 15_000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  // Every parent-check sleep has ended 0.4 s after it started.
  await new Promise((resolve) => setTimeout(resolve, 600));
  const sleeps = fs.readFileSync(sleepLog, "utf8").split("\n");
  assert.ok(sleeps.filter((arg) => arg === "1").length > 1, "the parent check never looped");
  assert.ok(!sleeps.includes("outlived"), "a parent-check sleep outlived its helper");
  assert.deepEqual(processesWithTmpdir(tempDir), []);
  assertMonitorLeftNothing(tempDir);
});

// A second SIGTERM while cleanup waits on a slow pkill used to run the exit
// trap at once, which left the helpers and their sleeps running.
test("X11 release watcher finishes its cleanup when a second SIGTERM arrives", { timeout: 20_000 }, async (t) => {
  let realPkill;
  try {
    realPkill = findHostExecutable("pkill");
  } catch {
    t.skip("pkill is unavailable");
    return;
  }
  const realSleep = findHostExecutable("sleep");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "global-dictation-second-signal-"));
  t.after(() => {
    killProcessesWithTmpdir(tempDir);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  const binDir = path.join(tempDir, "bin");
  const started = path.join(tempDir, "started");
  fs.mkdirSync(binDir);
  writeExecutable(
    path.join(binDir, "xmodmap"),
    `#!${hostBash}\nprintf '%s\\n' 'keycode 37 = Control_L' 'keycode 65 = space'\n`,
  );
  writeExecutable(
    path.join(binDir, "xinput"),
    [
      `#!${hostBash}`,
      "if [ \"$1\" = list ]; then printf '%s\\n' 'Virtual keyboard id=12 [slave  keyboard (3)]'; exit 0; fi",
      "if [ \"$1\" = query-state ]; then printf '%s\\n' 'key[37]=down' 'key[65]=down'; exit 0; fi",
      `if [ "$1" = test ]; then : > "${started}"; exec ${realSleep} 30; fi`,
      "exit 2",
    ].join("\n"),
  );
  writeExecutable(
    path.join(binDir, "pkill"),
    `#!${hostBash}\n${realPkill} "$@"\nstatus=$?\n${realSleep} 1.3\nexit "$status"\n`,
  );

  const monitor = spawn(
    path.join(__dirname, "bin", "global-dictation-release-monitor"),
    ["--accelerator", "Ctrl+Space"],
    {
      env: { ...process.env, DISPLAY: ":99", PATH: `${binDir}${path.delimiter}${hostPath}`, TMPDIR: tempDir },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  const exited = once(monitor, "exit");
  const deadline = Date.now() + 5_000;
  while (!fs.existsSync(started)) {
    assert.ok(Date.now() < deadline, "the keyboard stream never started");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  monitor.kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 400));
  monitor.kill("SIGTERM");
  await exited;
  assert.deepEqual(processesWithTmpdir(tempDir), []);
  assertMonitorLeftNothing(tempDir);
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

test("Linux clipboard FIFO waits for the complete predecessor and skips a queued aborted body", async () => {
  const context = waylandPatchContext([]), owner = {}, events = [];
  let finishFirst;
  const first = context.codexLinuxGlobalDictationClipboard(owner, async (...args) => {
    events.push(["snapshot-first", ...args]);
    await new Promise(resolve => { finishFirst = resolve; });
    events.push(["restore-first"]);
    return "first-result";
  }, "first", 11, "fingerprint-first", new AbortController().signal);
  await Promise.resolve();
  const cancelled = new AbortController();
  let argumentReads = 0, secondFinished = false;
  const text = () => { argumentReads++; return "second"; };
  const second = context.codexLinuxGlobalDictationClipboard(owner, async (_text, _time, _fingerprint, signal) => {
    if (signal.aborted) return null;
    events.push(["snapshot-second"]);
    return "unexpected";
  }, text(), 22, "fingerprint-second", cancelled.signal);
  second.then(() => { secondFinished = true; });
  const third = context.codexLinuxGlobalDictationClipboard(owner, async (...args) => {
    events.push(["snapshot-third", ...args]);
    return "third-result";
  }, "third", 33, "fingerprint-third", new AbortController().signal);
  cancelled.abort();
  await new Promise(setImmediate);
  assert.equal(argumentReads, 1, "Original argument expressions are evaluated at the native call site");
  assert.equal(secondFinished, false);
  assert.deepEqual(events.map(event => event[0]), ["snapshot-first"]);
  finishFirst();
  assert.equal(await first, "first-result");
  assert.equal(await second, null);
  assert.equal(await third, "third-result");
  assert.deepEqual(events.map(event => event[0]), ["snapshot-first", "restore-first", "snapshot-third"]);
  assert.deepEqual(events[2].slice(1, 4), ["third", 33, "fingerprint-third"]);
  await new Promise(setImmediate);
  assert.equal(context.codexLinuxGlobalDictationClipboardQueues.has(owner), false);
});

test("Linux clipboard FIFO preserves rejection and lets the next native operation run", async () => {
  const context = waylandPatchContext([]), owner = {}, reason = new Error("native bridge failed");
  let rejectFirst;
  const first = context.codexLinuxGlobalDictationClipboard(owner,
    () => new Promise((_resolve, reject) => { rejectFirst = reject; }), "first", 1, "one", new AbortController().signal);
  const rejected = assert.rejects(first, error => error === reason);
  await Promise.resolve();
  let secondStarted = false;
  const second = context.codexLinuxGlobalDictationClipboard(owner, () => {
    secondStarted = true;
    return Promise.resolve("second");
  }, "second", 2, "two", new AbortController().signal);
  await new Promise(setImmediate);
  assert.equal(secondStarted, false);
  rejectFirst(reason);
  await rejected;
  assert.equal(await second, "second");
  await new Promise(setImmediate);
  assert.equal(context.codexLinuxGlobalDictationClipboardQueues.has(owner), false);
});

for (const platform of ["darwin", "win32"]) {
  test(`clipboard dispatcher preserves the immediate native Promise and arguments on ${platform}`, () => {
    const context = waylandPatchContext([]), owner = {}, signal = new AbortController().signal;
    context.process.platform = platform;
    const nativePromise = Promise.resolve("native result");
    let called = false;
    const result = context.codexLinuxGlobalDictationClipboard(owner, (...args) => {
      called = true;
      assert.deepEqual(args, ["text", 123, "fingerprint", signal]);
      return nativePromise;
    }, "text", 123, "fingerprint", signal);
    assert.equal(called, true);
    assert.equal(result, nativePromise);
    assert.equal(context.codexLinuxGlobalDictationClipboardQueues.has(owner), false);
  });
}

test("X11 abort before the key command sends no input", async () => {
  const context = waylandPatchContext([]), controller = new AbortController(), reason = new Error("cancel before xdotool");
  context.process.env = { DISPLAY: ":1", XDG_SESSION_TYPE: "x11" };
  context.__execFile = () => assert.fail("Aborted paste must not spawn xdotool");
  controller.abort(reason);
  await assert.rejects(context.codexLinuxGlobalDictationPasteX11(controller.signal), error => error === reason);
});

test("X11 abort after key submission waits for its release command to finish", async () => {
  const context = waylandPatchContext([]), controller = new AbortController(), reason = new Error("cancel committed xdotool");
  context.process.env = { DISPLAY: ":1", XDG_SESSION_TYPE: "x11" };
  let finish, completed = false;
  const calls = [];
  context.__execFile = (file, args, options, callback) => {
    calls.push([file, Array.from(args), options]);
    finish = callback;
    return { kill() { assert.fail("A committed Ctrl+V command must finish its releases"); } };
  };
  const paste = context.codexLinuxGlobalDictationPasteX11(controller.signal);
  paste.then(() => { completed = true; }, () => { completed = true; });
  const rejected = assert.rejects(paste, error => error === reason);
  controller.abort(reason);
  await new Promise(setImmediate);
  assert.equal(completed, false);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 2), ["xdotool", ["key", "--clearmodifiers", "ctrl+v"]]);
  assert.equal(calls[0][2].signal, undefined);
  finish();
  await rejected;
});

test("a detached callback outside the native factory cannot create a second live toggle owner", () => {
  const source = mainBundleFixture() + 'function unrelated(){return eA("Ctrl+Alt+X",{onPressed(){}})}';
  const patched = applyPatchTwice(source);
  assert.ok(patched.endsWith('function unrelated(){return eA("Ctrl+Alt+X",{onPressed(){}})}'));
});
