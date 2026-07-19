#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const { EventEmitter } = require("node:events");
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
  applyLinuxGlobalDictationMainProcessPatch,
  descriptors,
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

function applyPatchTwice(source) {
  const patched = applyLinuxGlobalDictationMainProcessPatch(source);
  assert.notEqual(patched, source);
  assert.equal(applyLinuxGlobalDictationMainProcessPatch(patched), patched);
  assert.doesNotThrow(() => new vm.Script(patched));
  return patched;
}

function mainBundleFixture() {
  return [
    "var p=require(`node:fs`),u=require(`node:path`),h=require(`node:child_process`),c=require(`electron`),r={r:()=>({warning(){}})};",
    "function Kk(e,t){let n=``;e.stdout?.on(`data`,e=>{n+=e.toString(`utf8`);let r=n.indexOf(`\\n`);for(;r!==-1;)t(n.slice(0,r).trim()),n=n.slice(r+1),r=n.indexOf(`\\n`)})}",
    "function eA(e,t,n){if(Rk(e))return Lk(e)?Mk(e,t,n?.bareModifierTrigger):null;let r=oA(e),i=()=>{t.onPressed()},a=c.globalShortcut.register(r,i);return a?process.platform===`darwin`?sA({hotkey:e,onPressed:i,registrationHotkey:r}):{handlesRelease:!1,unregister:()=>{c.globalShortcut.unregister(r)}}:null}",
    "function fA(e){return nA(e)??(Lk(e)||bA(e,process.platform)?null:`Shortcut key is not supported for global dictation.`)}",
    "function pA(e,t){switch(process.platform){case`darwin`:{let n=Ik(mA(e),t);if(n==null)throw Error(`Global dictation hotkey release watching is not supported.`);return n}case`win32`:{let n=gA(e,process.platform);if(n==null)throw Error(`Global dictation hotkey release watching is not supported.`);return BA((0,h.spawn)(`powershell.exe`,[],{stdio:`ignore`}),t)}case`aix`:case`android`:case`cygwin`:case`freebsd`:case`haiku`:case`linux`:case`netbsd`:case`openbsd`:case`sunos`:throw Error(`Global dictation hotkey release watching is not supported.`)}}",
    "function mA(e){let t=[];for(let n of e.split(`+`)){let e=uA.get(n.trim().toLowerCase());e!=null&&!t.includes(e)&&t.push(e)}return t}",
    "function _A(){return [`/unrelated/native/path`]}",
    "function BA(e,t){let n=!1,i=e=>{n||(n=!0,e!=null&&r.r().warning(`Global dictation hotkey release watching failed`,{safe:{},sensitive:{error:e}}),t())};return e.once(`error`,i),e.once(`exit`,()=>i()),{dispose:()=>{n=!0,e.kill()}}}",
    "function bA(e,t){return t===`darwin`?mA(e).length>0:gA(e,t)!=null}",
    "function k7(e,t,n){return{x:e.centerX-n.x-t.width/2,y:e.centerY-n.y-t.height/2,...t}}var V7=async(...e)=>globalThis.__upstreamExecFile(...e);async function P7(){switch(process.platform){case`darwin`:await V7(`/usr/bin/osascript`,[]);return;case`win32`:return;case`aix`:case`android`:case`cygwin`:case`freebsd`:case`haiku`:case`linux`:case`netbsd`:case`openbsd`:case`sunos`:throw Error(`Global dictation paste is not supported on this OS.`)}}",
    "var H7=class{registeredHotkey=null;registeredHotkeyRegistration=null;registeredToggleHotkey=null;registeredToggleHotkeyRegistration=null;registerHotkeyOrThrow(e){if(this.registeredHotkey===e)return;let t=this.registeredHotkey,n=eA(e,{onPressed:()=>{this.handleHoldHotkeyPressed()},onReleased:()=>{this.handleHoldHotkeyReleased()}});if(n==null)throw Error(`Unable to register global dictation hotkey: ${e}`);t!=null&&this.registeredHotkeyRegistration?.unregister(),this.registeredHotkey=e,this.registeredHotkeyRegistration=n}unregisterHotkey(){this.registeredHotkey!=null&&(this.registeredHotkeyRegistration?.unregister(),this.registeredHotkey=null,this.registeredHotkeyRegistration=null)}registerToggleHotkeyOrThrow(e){if(this.registeredToggleHotkey===e)return;let t=this.registeredToggleHotkey,n=eA(e,{onPressed:()=>{this.handleToggleHotkeyPressed()}},{bareModifierTrigger:`release`});if(n==null)throw Error(`Unable to register global dictation toggle hotkey: ${e}`);t!=null&&this.registeredToggleHotkeyRegistration?.unregister(),this.registeredToggleHotkey=e,this.registeredToggleHotkeyRegistration=n}unregisterToggleHotkey(){this.registeredToggleHotkey!=null&&(this.registeredToggleHotkeyRegistration?.unregister(),this.registeredToggleHotkey=null,this.registeredToggleHotkeyRegistration=null)}deactivateLifecycle(){this.unregisterHotkey(),this.unregisterToggleHotkey()}handleHoldHotkeyPressed(){}handleHoldHotkeyReleased(){}handleToggleHotkeyPressed(){}};",
    "function W7(){return process.platform===`darwin`||process.platform===`win32`}",
  ].join("");
}

function fakeHelperChild() {
  const child = new EventEmitter();
  child.stdin = {
    writes: [],
    write(value, callback) {
      this.writes.push(value);
      callback?.();
      return true;
    },
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {
    child.killed = true;
    return true;
  };
  return child;
}

function waylandPatchContext(children) {
  const context = {
    Buffer,
    console: { warn() {} },
    process: {
      env: { XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0" },
      platform: "linux",
      resourcesPath: "/test/resources",
    },
    require(id) {
      if (id === "node:fs") return { accessSync() {}, constants: { X_OK: 1 } };
      if (id === "node:path") return path;
      if (id === "node:child_process") {
        return {
          spawn: () => children.shift(),
          execFile: (...args) => context.__execFile(...args),
        };
      }
      if (id === "electron") return { app: { getAppPath: () => null }, globalShortcut: {} };
      throw new Error(`unexpected module: ${id}`);
    },
    clearTimeout,
    setTimeout,
    __execFile: (_file, _args, _options, callback) => callback(),
    __upstreamExecFile: async () => {},
  };
  vm.runInNewContext(applyPatchTwice(mainBundleFixture()), context);
  return context;
}

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

test("main patch enables Linux and preserves the other platform gates", () => {
  const patched = applyPatchTwice(mainBundleFixture());
  assert.match(
    patched,
    /function W7\(\)\{return process\.platform===`darwin`\|\|process\.platform===`win32`\|\|process\.platform===`linux`\}/,
  );
  assert.match(patched, /case`linux`:if\(codexLinuxGlobalDictationUsesWayland\(\)\)/);
  assert.match(
    patched,
    /await codexLinuxGlobalDictationPasteX11\(\)/,
  );
  assert.doesNotMatch(patched, /return _A\(n,t\)/);
  assert.doesNotMatch(patched, /await k7\(`xdotool`/);
});

test("main patch handles dollar signs in minified identifiers", () => {
  const source = mainBundleFixture()
    .split("eA")
    .join("e$A")
    .split("Lk")
    .join("L$k");
  const patched = applyPatchTwice(source);
  assert.match(patched, /function e\$A\(e,t,n\)/);
  assert.match(patched, /e\$A\(e,\{onPressed:/);
  assert.match(patched, /L\$k\(e\)\?`Modifier-only shortcuts/);
});

test("Wayland registration uses a release-aware portal helper", () => {
  const patched = applyPatchTwice(mainBundleFixture());
  assert.match(patched, /function codexLinuxGlobalDictationUsesWayland\(/);
  assert.match(patched, /function codexLinuxGlobalDictationPortalRegistration\(/);
  assert.match(patched, /codexLinuxGlobalDictationPortalQueue=Promise\.resolve\(\)/);
  assert.match(patched, /handlesRelease: true/);
  assert.match(patched, /line === "down" && isReady && !pressed/);
  assert.match(patched, /line === "up" && isReady && pressed/);
  assert.match(patched, /onUnavailable:/);
});

test("Wayland registration forwards one press and release per helper transition", async () => {
  const child = fakeHelperChild();
  const context = waylandPatchContext([child]);

  let pressed = 0;
  let released = 0;
  let unavailable = 0;
  const registration = context.codexLinuxGlobalDictationPortalRegistration("Ctrl+Space", {
    onPressed: () => pressed++,
    onReleased: () => released++,
    onUnavailable: () => unavailable++,
  });
  await new Promise(setImmediate);
  child.stdout.emit("data", Buffer.from("ready\ndown\ndown\nup\nup\n"));
  await new Promise(setImmediate);

  assert.equal(registration.handlesRelease, true);
  assert.equal(pressed, 1);
  assert.equal(released, 1);
  assert.equal(unavailable, 0);
  const paste = context.P7();
  await new Promise(setImmediate);
  assert.deepEqual(child.stdin.writes, ["paste\n"]);
  child.stdout.emit("data", Buffer.from("paste-ok\n"));
  await paste;
  registration.unregister();
  assert.equal(child.killed, true);
});

test("Wayland paste errors reject only the active request", async () => {
  const child = fakeHelperChild();
  const context = waylandPatchContext([child]);
  const registration = context.codexLinuxGlobalDictationPortalRegistration("Ctrl+Space", {});
  await new Promise(setImmediate);
  child.stdout.emit("data", Buffer.from("ready\n"));
  await new Promise(setImmediate);

  const firstPaste = context.P7();
  await new Promise(setImmediate);
  await assert.rejects(context.P7(), /already pending/);
  child.stdout.emit("data", Buffer.from("paste-error:permission denied\n"));
  await assert.rejects(firstPaste, /permission denied/);

  const retry = context.P7();
  await new Promise(setImmediate);
  child.stdout.emit("data", Buffer.from("paste-ok\n"));
  await retry;
  assert.deepEqual(child.stdin.writes, ["paste\n", "paste\n"]);
  registration.unregister();
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

test("Wayland helper failure is reported once and releases the registration queue", async () => {
  const firstChild = fakeHelperChild();
  const secondChild = fakeHelperChild();
  const context = waylandPatchContext([firstChild, secondChild]);
  const failures = [];
  context.codexLinuxGlobalDictationPortalRegistration("Ctrl+Space", {
    onPressed() {
      assert.fail("failed helper must not emit a press");
    },
    onUnavailable: (error) => failures.push(error.message),
  });
  await new Promise(setImmediate);
  firstChild.stderr.emit("data", Buffer.from("portal unavailable"));
  firstChild.emit("exit", 1);
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.deepEqual(failures, ["portal unavailable"]);
  assert.equal(firstChild.killed, true);

  const next = context.codexLinuxGlobalDictationPortalRegistration("Ctrl+Space", {});
  await new Promise(setImmediate);
  secondChild.stdout.emit("data", Buffer.from("ready\n"));
  await new Promise(setImmediate);
  next.unregister();
  assert.equal(secondChild.killed, true);
});

test("X11 hold mode starts the bounded release watcher", () => {
  const patched = applyPatchTwice(mainBundleFixture());
  assert.match(patched, /function codexLinuxGlobalDictationReleaseWatcher\(/);
  assert.match(patched, /case`linux`:\{let n=codexLinuxGlobalDictationReleaseWatcher\(e,t\)/);
  assert.match(patched, /t===`darwin`\|\|t===`linux`\?mA\(e\)\.length>0/);
  assert.match(
    patched,
    /process\.platform===`linux`&&Lk\(e\)\?`Modifier-only shortcuts are not supported for global dictation on Linux\.`/,
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

test("portal failure tears down the existing lifecycle without dropping other platforms", () => {
  const patched = applyPatchTwice(mainBundleFixture());
  assert.match(patched, /handleLinuxHotkeyUnavailable\(e,t\)/);
  assert.match(patched, /this\.deactivateLifecycle\(\)/);
  assert.match(patched, /onUnavailable:t=>\{this\.handleLinuxHotkeyUnavailable\(`hold`,t\)\}/);
  assert.match(patched, /onUnavailable:t=>\{this\.handleLinuxHotkeyUnavailable\(`toggle`,t\)\}/);
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
    execFileSync(path.join(__dirname, "stage.sh"), {
      cwd: path.resolve(__dirname, "../.."),
      env: {
        ...process.env,
        CODEX_GLOBAL_DICTATION_LINUX_SOURCE: process.execPath,
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

test("stage hook builds from the repository root", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "global-dictation-build-root-"));
  const sourceRoot = path.join(tempDir, "source");
  const installDir = path.join(tempDir, "install");
  const binDir = path.join(tempDir, "bin");
  const observedCwd = path.join(tempDir, "cargo.cwd");
  fs.mkdirSync(sourceRoot);
  fs.mkdirSync(binDir);
  fs.writeFileSync(
    path.join(binDir, "cargo"),
    [
      `#!${hostBash}`,
      "set -eu",
      "pwd > \"$FAKE_CARGO_CWD\"",
      "printf '%s\\n' \"$*\" > \"$FAKE_CARGO_ARGS\"",
      "target_dir=\"$FAKE_SOURCE_ROOT/global-dictation-linux/target/release\"",
      "mkdir -p \"$target_dir\"",
      "cp \"$FAKE_SOURCE_BINARY\" \"$target_dir/codex-global-dictation-linux\"",
    ].join("\n"),
    { mode: 0o755 },
  );

  try {
    execFileSync(path.join(__dirname, "stage.sh"), {
      cwd: "/",
      env: {
        ...process.env,
        FAKE_CARGO_ARGS: path.join(tempDir, "cargo.args"),
        FAKE_CARGO_CWD: observedCwd,
        FAKE_SOURCE_ROOT: sourceRoot,
        FAKE_SOURCE_BINARY: process.execPath,
        INSTALL_DIR: installDir,
        PATH: `${binDir}${path.delimiter}${hostPath}`,
        SCRIPT_DIR: sourceRoot,
      },
      stdio: "pipe",
    });
    assert.equal(fs.readFileSync(observedCwd, "utf8").trim(), sourceRoot);
    assert.equal(
      fs.readFileSync(path.join(tempDir, "cargo.args"), "utf8").trim(),
      "build --release --manifest-path global-dictation-linux/Cargo.toml",
    );
    assert.equal(
      fs.statSync(
        path.join(installDir, "resources", "native", "codex-global-dictation-linux"),
      ).mode & 0o777,
      0o755,
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
