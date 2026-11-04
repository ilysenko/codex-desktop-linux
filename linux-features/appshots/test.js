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
const { patchUniqueAssetFile } = require("../../scripts/patches/lib/assets.js");
const { findMatchingBrace, escapeRegExp } = require("../../scripts/patches/lib/minified-js.js");
const { javascriptSourceParses } = require("../../scripts/patches/lib/javascript-syntax.js");
const { makeSocketTempDir } = require("../../scripts/lib/unix-socket-dir.test-helpers.js");

const {
  loadLinuxFeaturePatchDescriptors,
} = require("../../scripts/lib/linux-features.js");
const {
  applyLinuxAppshotAvailabilityPatch,
  applyLinuxAppshotHotkeyPatch,
  applyLinuxAppshotMainProcessPatch,
  descriptors,
  matchesLinuxAppshotAvailabilityContract,
  matchesLinuxAppshotMainProcessContract,
  matchesLinuxAppshotHotkeyContract,
} = require("./patch.js");

function applyPatchTwice(patchFn, source) {
  const once = patchFn(source);
  assert.notEqual(once, source);
  assert.equal(patchFn(once), once);
  return once;
}

function captureWarnings(callback) {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    callback();
  } finally {
    console.warn = originalWarn;
  }
  return warnings;
}

function appshotAvailabilityAtomBundleFixture() {
  return 'async function q1o({scope:e,hostId:t,queryClient:n}){let p=e.get(platformAtom);if(!J1o(p)||!featureGate(e,"1304276663")||"windows"===p&&(!featureGate(e,"2124127696")||!(await e.query.getOrFetch(hotkeyState)).supported))return!1;let r=await n.ensureQueryData({hostId:t});return r.requirements?.allowAppshots!==!1}function J1o(e){return"macOS"===e||"windows"===e}';
}

function appshotMainProcessBundleFixture() {
  return [
    'class CaptureService extends owner.TF{options;abortController=new AbortController;',
    'constructor(e){super(),this.options=e}[Symbol.dispose](){this.abortController.abort()}',
    'async getFrontmostWindow(){return this.abortController.signal.aborted?null:"win32"===process.platform?capabilities().appshotsEnabled?this.options.windowsCaptureNativeBridge?.getFrontmostWindow(this.options.origin,this.abortController.signal)??null:null:macFrontmost()}',
    'async start({animationDestination:e,animationPresentationStyle:t,bundleIdentifier:r,requestId:n}){let{origin:i,settings:s,windowManager:a,requestComputerUseCaptureWorker:o,subscribeComputerUseCaptureWorkerEvent:l,windowsCaptureNativeBridge:c}=this.options;if(this.abortController.signal.aborted)return null;',
    'let d=makeAnimation(e,t);return null==d?null:"win32"===process.platform?capabilities().appshotsEnabled&&null!=c?windowsCapture({animationTarget:d,bundleIdentifier:r,origin:i,requestId:n,signal:this.abortController.signal,windowManager:a,windowsCaptureNativeBridge:c}):null:null==o||null==l?null:macCapture({animationTarget:d,bundleIdentifier:r,origin:i,requestComputerUseCaptureWorker:o,requestId:n,subscribeComputerUseCaptureWorkerEvent:l,windowManager:a})}}',
    'function services(e,g){return{appshotCapture:"darwin"===process.platform&&null!=this.options.requestComputerUseWorker&&null!=this.options.subscribeComputerUseCaptureWorkerEvent||"win32"===process.platform&&null!=this.options.windowsCaptureNativeBridge?new CaptureService({origin:e,settings:this.settings,windowManager:g,requestComputerUseCaptureWorker:this.options.requestComputerUseWorker,subscribeComputerUseCaptureWorkerEvent:this.options.subscribeComputerUseCaptureWorkerEvent,windowsCaptureNativeBridge:this.options.windowsCaptureNativeBridge}):void 0}}',
  ].join("");
}

function currentAppshotHotkeyMainBundleFixture() {
  return [
    'var Yk=new Set(["cmdorctrl","command","cmd","control","ctrl","alt","option","super"]),Jk=new Set([...Yk,"shift"]);',
    'function zk(e){return e}',
    'function Qk(){return null}',
    'function Nk(e,t,n){globalThis.registered={hotkey:e,handlers:t,trigger:n};return{unregister(){}}}',
    'function Lk(e,t=process.platform){return"darwin"===t&&null!=zk(e)}',
    'var Mk=function(e,t,n="press"){var a;let x;if("darwin"!==process.platform)return null;let r=zk(e)??Qk(e);return null==r?null:Nk(r,t,n)};',
    'class B8{configuredHotkey;registration=null;windowsCaptureNativeBridgeFailed=!1;constructor(e){this.enabled=!0,this.windowsCaptureNativeBridge=null;let a=e.getStored("appshotHotkey");void 0===a?this.configuredHotkey="win32"===process.platform?"DoubleAlt":"DoubleCommand":this.configuredHotkey=a;this.sync()}getState(){return{supported:this.enabled&&("darwin"===process.platform||"win32"===process.platform&&null!=this.windowsCaptureNativeBridge&&!this.windowsCaptureNativeBridgeFailed),configuredHotkey:this.configuredHotkey,isActive:null!=this.registration}}sync(){if(!this.getState().supported||null==this.configuredHotkey)return;this.registration=Mk(this.configuredHotkey,{onPressed(){}})}}',
    'globalThis.hotkeyEligible=Lk;globalThis.modifiers=Jk;',
    'globalThis.AppshotHotkeys=B8;',
    'globalThis.appshotHotkeyState="appshot-hotkey-state";',
  ].join("");
}

for (const location of ["installed", "cache", "retired only"]) {
  test(`AppShots backend commands use the staged unified plugin: ${location}`, async (t) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "appshots-backend-"));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    const installDir = path.join(workspace, "app");
    const resources = path.join(installDir, "resources");
    const codexHome = path.join(workspace, "codex-home");
    const plugin = path.join(resources, "plugins/openai-bundled/plugins/unified-computer-use");
    const marketplace = path.join(plugin, "../../.agents/plugins/marketplace.json");
    fs.mkdirSync(path.dirname(marketplace), { recursive: true });
    fs.writeFileSync(marketplace, JSON.stringify({ plugins: [{ name: "unified-computer-use" }] }));
    fs.mkdirSync(path.join(plugin, ".codex-plugin"), { recursive: true });
    fs.mkdirSync(path.join(plugin, "scripts"));
    fs.writeFileSync(path.join(plugin, ".codex-plugin/plugin.json"), JSON.stringify({
      name: "unified-computer-use", version: "26.908.31748", mcpServers: "./.mcp.json",
    }));
    fs.writeFileSync(path.join(plugin, ".mcp.json"), JSON.stringify({
      mcpServers: { cua_repl: { command: "node", args: [], enabled: false } },
    }));
    const backend = path.join(workspace, "backend");
    fs.writeFileSync(backend, '#!/bin/sh\n[ "$1" = windows ] || exit 1\nprintf \'%s\\n\' \'{"backend":"staged-unified","windows":[]}\'\n', { mode: 0o755 });
    execFileSync("bash", [path.join(__dirname, "../computer-use-linux/stage.sh")], {
      env: { ...process.env, SCRIPT_DIR: path.resolve(__dirname, "../.."), INSTALL_DIR: installDir,
        CODEX_COMPUTER_USE_BINARY_SOURCE: backend, CODEX_COMPUTER_USE_COSMIC_BINARY_SOURCE: backend, CODEX_COMPUTER_USE_INDICATOR_BINARY_SOURCE: backend },
      stdio: "pipe",
    });
    if (location === "cache") {
      const cached = path.join(codexHome, "plugins/cache/openai-bundled/unified-computer-use/latest");
      fs.cpSync(plugin, cached, { recursive: true });
    }
    if (location !== "installed") {
      fs.rmSync(plugin, { recursive: true });
      // A leftover legacy helper must neither shadow the unified cache nor act as a fallback.
      for (const retired of [
        path.join(resources, "plugins/openai-bundled/plugins/computer-use/bin"),
        path.join(codexHome, "plugins/cache/openai-bundled/computer-use/latest/bin"),
      ]) {
        fs.mkdirSync(retired, { recursive: true });
        fs.writeFileSync(path.join(retired, "codex-computer-use-linux"),
          '#!/bin/sh\nprintf \'%s\\n\' \'{"backend":"retired"}\'\n', { mode: 0o755 });
      }
    }
    const patched = applyLinuxAppshotMainProcessPatch(appshotMainProcessBundleFixture());
    const context = vm.createContext({
      require, process: { env: { CODEX_HOME: codexHome }, platform: "linux", resourcesPath: resources },
    });
    vm.runInContext(patched.slice(patched.lastIndexOf(";function codexLinuxAppshotRequire")), context);
    if (location === "retired only") {
      await assert.rejects(context.codexLinuxAppshotBackendJson(["windows"]), /backend is not installed/);
    } else {
      const report = await context.codexLinuxAppshotBackendJson(["windows"]);
      assert.equal(report.backend, "staged-unified");
      assert.equal(report.windows.length, 0);
    }
  });
}

test("appshots stays disabled until listed in features.json", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "appshots-feature-"));
  const configPath = path.join(tempDir, "features.json");
  const featuresRoot = path.resolve(__dirname, "..");
  const originalConfig = process.env.CODEX_LINUX_FEATURES_CONFIG;

  try {
    process.env.CODEX_LINUX_FEATURES_CONFIG = configPath;
    fs.writeFileSync(configPath, '{"enabled":[]}\n');
    assert.deepEqual(loadLinuxFeaturePatchDescriptors({ featuresRoot }), []);

    fs.writeFileSync(configPath, '{"enabled":["appshots"]}\n');
    const loaded = loadLinuxFeaturePatchDescriptors({ featuresRoot });

    assert.equal(loaded.length, 3);
    assert.deepEqual(
      loaded.map((descriptor) => descriptor.id).sort(),
      [
        "feature:appshots:linux-appshots-availability",
        "feature:appshots:linux-appshots-hotkey",
        "feature:appshots:linux-appshots-main-process",
      ].sort(),
    );
    assert.ok(loaded.every((descriptor) => descriptor.ciPolicy === "optional"));
  } finally {
    if (originalConfig == null) {
      delete process.env.CODEX_LINUX_FEATURES_CONFIG;
    } else {
      process.env.CODEX_LINUX_FEATURES_CONFIG = originalConfig;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("appshots feature descriptors are optional", () => {
  assert.equal(descriptors.length, 3);
  assert.ok(descriptors.every((descriptor) => descriptor.ciPolicy == null));
});

test("appshots availability descriptor matches the current bundle", () => {
  const descriptor = descriptors.find(
    (descriptor) => descriptor.id === "linux-appshots-availability",
  );

  assert.ok(descriptor.pattern.test("async/24191.7b05d5cf83.js"));
  assert.ok(descriptor.pattern.test("renamed-renderer.js"));
  assert.equal(descriptor.pattern.test("style.css"), false);
  assert.equal(descriptor.assetMatch(appshotAvailabilityAtomBundleFixture()), true);
  assert.equal(descriptor.assetMatch("function unrelated(){return `windows`}"), false);
});

test("stages the Linux bare modifier monitor helper and Wayland portal hook", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "feature.json"), "utf8"));
  const helperSource = fs.readFileSync(
    path.join(__dirname, "bin", "bare-modifier-monitor"),
    "utf8",
  );
  const electronArgsSource = fs.readFileSync(path.join(__dirname, "electron-args"), "utf8");

  assert.deepEqual(manifest.resources, [
    {
      source: "bin/bare-modifier-monitor",
      target: "resources/native/bare-modifier-monitor",
      mode: "0755",
    },
  ]);
  assert.deepEqual(manifest.runtimeHooks, {
    electronArgs: {
      source: "electron-args",
      name: "electron-args",
      mode: "0644",
    },
  });
  assert.equal(electronArgsSource.trim(), "--enable-features=GlobalShortcutsPortal");
  assert.match(helperSource, /xinput test-xi2 --root/);
  assert.match(helperSource, /stdbuf -oL/);
  assert.doesNotMatch(helperSource, /\bmktemp\s+-u\b/);
  assert.doesNotMatch(helperSource, /xinput list --short/);
  assert.doesNotMatch(helperSource, /xinput test "\$device_id"/);
  assert.doesNotMatch(helperSource, /mkfifo/);
  assert.match(helperSource, /parent_pid="\$PPID"/);
  assert.match(helperSource, /kill -0 "\$parent_pid"/);
  assert.match(helperSource, /read -r -t 1 -u "\$event_fd" line/);
  assert.match(helperSource, /kill "\$monitor_pid"/);
  assert.match(helperSource, /doublealt\|doubleoption\|alt\+alt/);
  assert.match(helperSource, /doubleshift\|shift\+shift\|leftshift\+rightshift/);
  assert.match(helperSource, /Shift_L Shift_R/);
  assert.match(helperSource, /last_tap_code=""/);
  assert.match(helperSource, /\[ "\$code" != "\$last_tap_code" \]/);
  assert.match(helperSource, /date \+%s%N/);
  assert.match(helperSource, /10#\$epoch_nanoseconds \/ 1000000/);
  assert.doesNotMatch(helperSource, /date \+%s%3N/);
  assert.doesNotMatch(helperSource, /while IFS= read -r pending code/);
  execFileSync("bash", ["-n", path.join(__dirname, "bin", "bare-modifier-monitor")]);
});

test("AppShots stages only its private backend and COSMIC helper for both official architectures", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "appshots-stage-"));
  try {
    const backend = path.join(root, "backend");
    const cosmic = path.join(root, "cosmic");
    for (const [arch, machine] of [["amd64", 62], ["arm64", 183]]) {
      const bytes = Buffer.alloc(20);
      Buffer.from([127, 69, 76, 70, 2, 1]).copy(bytes);
      bytes.writeUInt16LE(machine, 18);
      for (const file of [backend, cosmic]) fs.writeFileSync(file, bytes, { mode: 0o755 });
      const app = path.join(root, arch);
      const env = {
        ...process.env, SCRIPT_DIR: path.resolve(__dirname, "../.."), INSTALL_DIR: app, ARCH: arch,
        CODEX_COMPUTER_USE_BINARY_SOURCE: backend, CODEX_COMPUTER_USE_COSMIC_BINARY_SOURCE: cosmic,
      };
      execFileSync("bash", [path.join(__dirname, "stage.sh")], { env, stdio: "pipe" });
      for (const file of ["codex-computer-use-linux", "codex-computer-use-cosmic"]) {
        const staged = path.join(app, "resources/native/appshots", file);
        assert.deepEqual(fs.readFileSync(staged), bytes);
        assert.equal(fs.statSync(staged).mode & 0o777, 0o755);
      }
      assert.equal(fs.existsSync(path.join(app, "resources/plugins")), false);
      assert.equal(fs.existsSync(path.join(app, ".codex-linux/features/computer-use-linux")), false);
      assert.equal(fs.existsSync(path.join(app, "resources/native/appshots/codex-computer-use-indicator")), false);
      const mismatched = spawnSync("bash", [path.join(__dirname, "stage.sh")], {
        env: { ...env, ARCH: arch === "amd64" ? "arm64" : "amd64" }, encoding: "utf8",
      });
      assert.notEqual(mismatched.status, 0);
      assert.match(mismatched.stderr, /not a .* Linux ELF executable/);
      fs.rmSync(cosmic);
      const missing = spawnSync("bash", [path.join(__dirname, "stage.sh")], { env, encoding: "utf8" });
      assert.notEqual(missing.status, 0);
      assert.match(missing.stderr, /helper is missing or not executable/);
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "feature.json"), "utf8"));
    assert.equal(manifest.entrypoints.stageHook, "./stage.sh");
    assert.equal(manifest.requires, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("AppShots runtime prefers an explicit override, then its private packaged backend", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "appshots-private-backend-"));
  try {
    const privatePath = path.join(root, "resources/native/appshots/codex-computer-use-linux");
    const pluginPath = path.join(root, "resources/plugins/openai-bundled/plugins/unified-computer-use/bin/codex-computer-use-linux");
    const override = path.join(root, "override");
    for (const [file, backend] of [[privatePath, "private"], [pluginPath, "plugin"], [override, "override"]]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' '{"backend":"${backend}","windows":[]}'\n`, { mode: 0o755 });
    }
    const context = vm.createContext({
      require, process: { platform: "linux", env: {}, resourcesPath: path.join(root, "resources") },
    });
    const source = applyLinuxAppshotMainProcessPatch(appshotMainProcessBundleFixture());
    vm.runInContext(source.slice(source.lastIndexOf(";function codexLinuxAppshotRequire")), context);
    assert.equal((await context.codexLinuxAppshotBackendJson(["windows"])).backend, "private");
    context.process.env.CODEX_LINUX_COMPUTER_USE_BACKEND_SOURCE = override;
    assert.equal((await context.codexLinuxAppshotBackendJson(["windows"])).backend, "override");
    delete context.process.env.CODEX_LINUX_COMPUTER_USE_BACKEND_SOURCE;
    fs.rmSync(privatePath);
    assert.equal((await context.codexLinuxAppshotBackendJson(["windows"])).backend, "plugin");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Behaves like uutils stdbuf (uutils/coreutils#13939): it makes a temporary
// directory in TMPDIR and execs its command, so nothing removes the directory.
const LEAKY_STDBUF = '#!/bin/sh\nmktemp -d "${TMPDIR:-/tmp}/.tmpXXXXXX" >/dev/null || exit 125\nshift\nexec "$@"\n';

// What xinput --version prints for an X server with XInput 2.4; the monitor
// checks it before it starts the event stream.
const XINPUT_VERSION_OK =
  'if [ "$1" = --version ]; then printf \'%s\\n\' \'xinput version 1.6.4\' \'XI version on server: 2.4\'; exit 0; fi';

// What the bare modifier monitor's stdbuf run leaves in TMPDIR.
function stdbufLeftovers(dir) {
  return fs
    .readdirSync(dir)
    .filter((name) => name.startsWith(".tmp") || name.startsWith("codex-appshots-stdbuf."));
}

test("bare modifier monitor emits one transition from one XInput2 stream", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "appshots-xinput2-"));
  const binDir = path.join(tempDir, "bin");
  const helper = path.join(__dirname, "bin", "bare-modifier-monitor");
  fs.mkdirSync(binDir);
  fs.writeFileSync(
    path.join(binDir, "xmodmap"),
    "#!/bin/sh\nprintf '%s\\n' 'keycode 50 = Shift_L' 'keycode 62 = Shift_R'\n",
    { mode: 0o755 },
  );
  fs.writeFileSync(path.join(binDir, "stdbuf"), LEAKY_STDBUF, { mode: 0o755 });
  fs.writeFileSync(
    path.join(binDir, "xinput"),
    [
      "#!/bin/sh",
      XINPUT_VERSION_OK,
      "[ \"$1 $2\" = \"test-xi2 --root\" ] || exit 2",
      "printf '%s\\n' \\",
      "  'EVENT type 13 (RawKeyPress)' '    detail: 50' \\",
      "  'EVENT type 14 (RawKeyRelease)' '    detail: 50' \\",
      "  'EVENT type 13 (RawKeyPress)' '    detail: 62' \\",
      "  'EVENT type 14 (RawKeyRelease)' '    detail: 62'",
      "sleep 0.25",
    ].join("\n"),
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(binDir, "date"),
    "#!/bin/sh\n[ \"$1\" = \"+%s%N\" ] || exit 2\nprintf '%s\\n' 1787195182868568236\n",
    { mode: 0o755 },
  );

  try {
    const result = spawnSync(helper, ["--key", "DoubleShift", "--immediate"], {
      encoding: "utf8",
      env: {
        ...process.env,
        DISPLAY: ":99",
        PATH: `${binDir}:${process.env.PATH}`,
        // The monitor makes its stdbuf directory in the fixture, where the test checks it is gone.
        TMPDIR: tempDir,
      },
      timeout: 2_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split("\n"), ["ready", "down", "up"]);
    assert.deepEqual(stdbufLeftovers(tempDir), []);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("bare modifier monitor fails closed before ready when xinput cannot reach the X server", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "appshots-xinput2-startup-"));
  const binDir = path.join(tempDir, "bin");
  const helper = path.join(__dirname, "bin", "bare-modifier-monitor");
  fs.mkdirSync(binDir);
  fs.writeFileSync(
    path.join(binDir, "xmodmap"),
    "#!/bin/sh\nprintf '%s\\n' 'keycode 50 = Shift_L' 'keycode 62 = Shift_R'\n",
    { mode: 0o755 },
  );
  fs.writeFileSync(path.join(binDir, "stdbuf"), LEAKY_STDBUF, { mode: 0o755 });
  // Every xinput command fails, as when the X server is unreachable.
  fs.writeFileSync(path.join(binDir, "xinput"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });

  try {
    const result = spawnSync(helper, ["--key", "DoubleShift", "--immediate"], {
      encoding: "utf8",
      env: {
        ...process.env,
        DISPLAY: ":99",
        PATH: `${binDir}:${process.env.PATH}`,
        // The monitor makes its stdbuf directory in the fixture, where the test checks it is gone.
        TMPDIR: tempDir,
      },
      timeout: 2_000,
    });
    assert.notEqual(result.status, 0, result.stderr);
    assert.equal(result.stdout, "permission-denied\n");
    assert.deepEqual(stdbufLeftovers(tempDir), []);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// The preflight waits for xinput's own answer, so a slow start under load
// cannot turn a failure into ready. The old 0.1 s check printed ready here.
for (const [name, xinput, expected] of [
  ["fails closed for a slow xinput that cannot reach the X server", "#!/bin/sh\nsleep 0.3\nexit 1\n", "permission-denied\n"],
  [
    "fails closed when the X server has no XInput 2",
    "#!/bin/sh\n[ \"$1\" = --version ] && printf '%s\\n' 'xinput version 1.6.4' 'XI version on server: 1.5' && exit 0\nexec sleep 30\n",
    "permission-denied\n",
  ],
]) {
  test(`bare modifier monitor ${name}`, (t) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "appshots-xinput2-preflight-"));
    t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
    const binDir = path.join(tempDir, "bin");
    fs.mkdirSync(binDir);
    fs.writeFileSync(
      path.join(binDir, "xmodmap"),
      "#!/bin/sh\nprintf '%s\\n' 'keycode 50 = Shift_L' 'keycode 62 = Shift_R'\n",
      { mode: 0o755 },
    );
    fs.writeFileSync(path.join(binDir, "stdbuf"), LEAKY_STDBUF, { mode: 0o755 });
    fs.writeFileSync(path.join(binDir, "xinput"), xinput, { mode: 0o755 });
    const result = spawnSync(path.join(__dirname, "bin", "bare-modifier-monitor"), ["--key", "DoubleShift"], {
      encoding: "utf8",
      env: { ...process.env, DISPLAY: ":99", PATH: `${binDir}:${process.env.PATH}`, TMPDIR: tempDir },
      timeout: 5_000,
    });
    assert.notEqual(result.status, 0, result.stderr);
    assert.equal(result.stdout, expected);
    assert.deepEqual(stdbufLeftovers(tempDir), []);
  });
}

// After a good preflight, a stream that still dies at once is caught by the
// short check when the monitor sees it in time, else it ends after ready.
// Either way the monitor removes its stdbuf directory.
test("bare modifier monitor removes its stdbuf directory when the stream dies after the preflight", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "appshots-xinput2-stream-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const binDir = path.join(tempDir, "bin");
  fs.mkdirSync(binDir);
  fs.writeFileSync(
    path.join(binDir, "xmodmap"),
    "#!/bin/sh\nprintf '%s\\n' 'keycode 50 = Shift_L' 'keycode 62 = Shift_R'\n",
    { mode: 0o755 },
  );
  fs.writeFileSync(path.join(binDir, "stdbuf"), LEAKY_STDBUF, { mode: 0o755 });
  fs.writeFileSync(path.join(binDir, "xinput"), `#!/bin/sh\n${XINPUT_VERSION_OK}\nexit 2\n`, { mode: 0o755 });
  const result = spawnSync(path.join(__dirname, "bin", "bare-modifier-monitor"), ["--key", "DoubleShift"], {
    encoding: "utf8",
    env: { ...process.env, DISPLAY: ":99", PATH: `${binDir}:${process.env.PATH}`, TMPDIR: tempDir },
    timeout: 5_000,
  });
  assert.ok(["permission-denied\n", "ready\n"].includes(result.stdout), result.stdout);
  // A refusal exits non-zero; after ready, the end of the stream is a normal stop.
  if (result.stdout === "permission-denied\n") assert.notEqual(result.status, 0, result.stderr);
  else assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(stdbufLeftovers(tempDir), []);
});

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  test(`bare modifier monitor removes its stdbuf directory on ${signal}`, { timeout: 15_000 }, async (t) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "appshots-xinput2-signal-"));
    t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
    const binDir = path.join(tempDir, "bin");
    fs.mkdirSync(binDir);
    fs.writeFileSync(
      path.join(binDir, "xmodmap"),
      "#!/bin/sh\nprintf '%s\\n' 'keycode 50 = Shift_L' 'keycode 62 = Shift_R'\n",
      { mode: 0o755 },
    );
    fs.writeFileSync(path.join(binDir, "stdbuf"), LEAKY_STDBUF, { mode: 0o755 });
    fs.writeFileSync(
      path.join(binDir, "xinput"),
      `#!/bin/sh\n${XINPUT_VERSION_OK}\n[ "$1 $2" = "test-xi2 --root" ] || exit 2\nexec sleep 30\n`,
      { mode: 0o755 },
    );

    const monitor = spawn(path.join(__dirname, "bin", "bare-modifier-monitor"), ["--key", "DoubleShift"], {
      env: { ...process.env, DISPLAY: ":99", PATH: `${binDir}:${process.env.PATH}`, TMPDIR: tempDir },
      stdio: ["ignore", "pipe", "pipe"],
      // Its own process group, so cleanup reaches xinput too if the test fails early.
      detached: true,
    });
    t.after(() => {
      try {
        process.kill(-monitor.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    });
    const exited = once(monitor, "exit");
    let stdout = "";
    monitor.stdout.setEncoding("utf8");
    monitor.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    const deadline = Date.now() + 5_000;
    while (!stdout.includes("ready\n")) {
      assert.ok(Date.now() < deadline, `monitor never became ready: ${stdout}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    // While xinput runs, its stdbuf directory sits in the monitor's own directory.
    const running = stdbufLeftovers(tempDir);
    assert.equal(running.length, 1, `${running}`);
    assert.match(running[0], /^codex-appshots-stdbuf\./);

    // Only the monitor gets the signal, as when the app stops it.
    monitor.kill(signal);
    const [code, exitSignal] = await exited;
    assert.ok(code !== 0 || exitSignal !== null, "the monitor exited 0 on a signal");
    assert.deepEqual(stdbufLeftovers(tempDir), []);
  });
}

// A live process, not a zombie.
function processRunning(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
  } catch {
    return false;
  }
}

async function waitUntil(condition, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    assert.ok(Date.now() < deadline, message());
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// An X server that never answers: xinput --version records its pid and hangs.
function hangingPreflightFixture(t, prefix) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const binDir = path.join(tempDir, "bin");
  const xinputPidFile = path.join(tempDir, "xinput.pid");
  fs.mkdirSync(binDir);
  fs.writeFileSync(
    path.join(binDir, "xmodmap"),
    "#!/bin/sh\nprintf '%s\\n' 'keycode 50 = Shift_L' 'keycode 62 = Shift_R'\n",
    { mode: 0o755 },
  );
  fs.writeFileSync(path.join(binDir, "stdbuf"), LEAKY_STDBUF, { mode: 0o755 });
  fs.writeFileSync(
    path.join(binDir, "xinput"),
    `#!/bin/sh\n[ "$1" = --version ] || exit 2\nprintf '%s\\n' "$$" > "${xinputPidFile}"\nexec sleep 30\n`,
    { mode: 0o755 },
  );
  const env = { ...process.env, DISPLAY: ":99", PATH: `${binDir}:${process.env.PATH}`, TMPDIR: tempDir };
  const xinputPid = () => (fs.existsSync(xinputPidFile) ? Number(fs.readFileSync(xinputPidFile, "utf8")) : 0);
  return { tempDir, env, xinputPid };
}

// Its own process group, so the test can end everything it started.
function killGroupAfter(t, child) {
  t.after(() => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  });
}

// The preflight waits for the server as long as it takes, but a stop request
// still ends the monitor and the probe with it.
test("bare modifier monitor stops a hanging preflight on SIGTERM", { timeout: 15_000 }, async (t) => {
  const { tempDir, env, xinputPid } = hangingPreflightFixture(t, "appshots-xinput2-hang-term-");
  const monitor = spawn(path.join(__dirname, "bin", "bare-modifier-monitor"), ["--key", "DoubleShift"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  killGroupAfter(t, monitor);
  const exited = once(monitor, "exit");
  let stdout = "";
  monitor.stdout.setEncoding("utf8");
  monitor.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  await waitUntil(() => xinputPid() > 0, 5_000, () => "xinput --version never started");
  monitor.kill("SIGTERM");
  await exited;
  await waitUntil(() => !processRunning(xinputPid()), 2_000, () => "xinput --version outlived the monitor");
  assert.equal(stdout, "");
  assert.deepEqual(stdbufLeftovers(tempDir), []);
});

// The app can exit without stopping the monitor. The monitor then ends on its
// own, during the preflight too.
test("bare modifier monitor stops a hanging preflight when its parent exits", { timeout: 15_000 }, async (t) => {
  const { tempDir, env, xinputPid } = hangingPreflightFixture(t, "appshots-xinput2-hang-parent-");
  const pidFile = path.join(tempDir, "monitor.pid");
  // The parent starts the monitor, waits for the preflight, then exits.
  const parent = spawn(
    "/bin/sh",
    [
      "-c",
      [
        '"$1" --key DoubleShift >/dev/null 2>&1 </dev/null &',
        'printf "%s\\n" "$!" > "$2"',
        "i=0",
        'while [ ! -s "$3" ] && [ "$i" -lt 100 ]; do sleep 0.05; i=$((i + 1)); done',
      ].join("\n"),
      "sh",
      path.join(__dirname, "bin", "bare-modifier-monitor"),
      pidFile,
      path.join(tempDir, "xinput.pid"),
    ],
    { env, stdio: "ignore", detached: true },
  );
  killGroupAfter(t, parent);
  const [code] = await once(parent, "exit");
  assert.equal(code, 0);
  assert.ok(xinputPid() > 0, "xinput --version never started");
  const monitorPid = Number(fs.readFileSync(pidFile, "utf8"));
  await waitUntil(
    () => !processRunning(monitorPid) && !processRunning(xinputPid()),
    5_000,
    () => `still running: monitor ${processRunning(monitorPid)}, xinput --version ${processRunning(xinputPid())}`,
  );
  assert.deepEqual(stdbufLeftovers(tempDir), []);
});

test("enables AppShots availability atom on Linux", () => {
  const patched = applyPatchTwice(
    applyLinuxAppshotAvailabilityPatch,
    appshotAvailabilityAtomBundleFixture(),
  );

  assert.match(
    patched,
    /"linux"===e\/\*codexLinuxAppshotsPlatformAvailable\*\/\|\|"macOS"===e/,
  );
  assert.match(patched, /"windows"===e/);
  assert.equal(matchesLinuxAppshotAvailabilityContract(patched), true);
});

test("AppShots availability preserves rollout, host requirements and Windows backend guards", async () => {
  const source = applyLinuxAppshotAvailabilityPatch(appshotAvailabilityAtomBundleFixture());
  for (const scenario of [
    { platform: "linux", allowed: true },
    { platform: "macOS", allowed: true },
    { platform: "windows", allowed: true },
    { platform: "freebsd", allowed: false },
    { platform: "linux", rollout: false, allowed: false },
    { platform: "linux", requirement: false, allowed: false },
    { platform: "windows", nativeRollout: false, allowed: false },
    { platform: "windows", supported: false, allowed: false },
  ]) {
    const context = vm.createContext({
      platformAtom: "platform", hotkeyState: "state",
      featureGate(_scope, id) { return id === "1304276663" ? scenario.rollout !== false : scenario.nativeRollout !== false; },
    });
    vm.runInContext(source, context);
    const result = await context.q1o({
      scope: { get: () => scenario.platform, query: { getOrFetch: async () => ({ supported: scenario.supported !== false }) } },
      hostId: "local", queryClient: { ensureQueryData: async () => ({ requirements: { allowAppshots: scenario.requirement } }) },
    });
    assert.equal(result, scenario.allowed, JSON.stringify(scenario));
  }
});

test("AppShots availability rejects missing, duplicate and partial states and patches a nested semantic owner", () => {
  const source = appshotAvailabilityAtomBundleFixture();
  const patched = applyLinuxAppshotAvailabilityPatch(source);
  const partial = patched.replace('"windows"===e}', '"windows"===wrongPlatform}');
  for (const invalid of ["function unrelated(){}", source + source, patched + patched, source + patched, partial]) {
    assert.equal(matchesLinuxAppshotAvailabilityContract(invalid), false);
    captureWarnings(() => assert.equal(applyLinuxAppshotAvailabilityPatch(invalid), invalid));
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "appshots-owner-"));
  try {
    const assets = path.join(root, "webview/assets/async");
    fs.mkdirSync(assets, { recursive: true });
    const file = path.join(assets, "1.hash.js");
    fs.writeFileSync(file, source);
    const descriptor = descriptors.find(({ id }) => id === "linux-appshots-availability");
    const apply = () => patchUniqueAssetFile(root, descriptor.pattern, descriptor.assetMatch, descriptor.apply, "missing", "ambiguous");
    assert.equal(apply().assetName, "async/1.hash.js");
    assert.equal(apply().changed, 0);
    assert.equal(javascriptSourceParses(fs.readFileSync(file, "utf8")), true);
    fs.writeFileSync(path.join(assets, "2.hash.js"), source);
    captureWarnings(() => assert.equal(apply().matched, 2));
    assert.equal(fs.readFileSync(file, "utf8"), patched);
    assert.equal(fs.readFileSync(path.join(assets, "2.hash.js"), "utf8"), source);
    fs.writeFileSync(path.join(assets, "2.hash.js"), partial);
    captureWarnings(() => assert.equal(apply().matched, 2));
    assert.equal(fs.readFileSync(file, "utf8"), patched);
    assert.equal(fs.readFileSync(path.join(assets, "2.hash.js"), "utf8"), partial);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function captureServiceContext(platform = "linux") {
  const scheduled = [];
  const context = vm.createContext({
    owner: { TF: class {} }, AbortController, Symbol,
    process: { platform, env: {}, resourcesPath: "", pid: 101 },
    require() { throw new Error("No real backend expected"); },
    capabilities: () => ({ appshotsEnabled: true }), makeAnimation: () => "animation",
    macFrontmost: () => "mac-window", macCapture: () => "mac-capture", windowsCapture: () => "windows-capture",
    console: { warn() {} },
    setTimeout(callback) { scheduled.push(callback); return scheduled.length; },
  });
  vm.runInContext(applyLinuxAppshotMainProcessPatch(appshotMainProcessBundleFixture()) + ";globalThis.Service=CaptureService;", context);
  context.codexLinuxAppshotBackendPath = () => "/fixture/backend";
  let options = {
    origin: { isDestroyed: () => false }, settings: {}, windowManager: {},
    requestComputerUseCaptureWorker() {}, subscribeComputerUseCaptureWorkerEvent() {},
    windowsCaptureNativeBridge: { getFrontmostWindow: () => "windows-window" },
  };
  const service = context.services.call({ options: { subscribeComputerUseCaptureWorkerEvent: options.subscribeComputerUseCaptureWorkerEvent, windowsCaptureNativeBridge: options.windowsCaptureNativeBridge, requestComputerUseWorker: options.requestComputerUseCaptureWorker }, settings: options.settings }, options.origin, options.windowManager).appshotCapture;
  options = service.options;
  const params = { animationDestination: {}, animationPresentationStyle: "immediate", bundleIdentifier: "editor", requestId: "capture" };
  return { context, service, options, params, scheduled };
}

test("current capture service preserves platform paths, disposal and missing-backend returns", async () => {
  for (const platform of ["linux", "darwin", "win32"]) {
    const { context, service, options, params } = captureServiceContext(platform);
    const calls = [];
    context.codexLinuxAppshotFrontmostWindow = () => "linux-window";
    context.codexLinuxAppshotStartCapture = (request) => { calls.push(request); return "linux-capture"; };
    assert.equal(await service.getFrontmostWindow(), platform === "linux" ? "linux-window" : platform === "win32" ? "windows-window" : "mac-window");
    assert.equal(await service.start(params), platform === "linux" ? "linux-capture" : platform === "win32" ? "windows-capture" : "mac-capture");
    if (platform === "linux") {
      assert.equal(calls[0].origin, options.origin);
      assert.equal(calls[0].signal, service.abortController.signal);
      assert.equal(calls[0].windowManager, options.windowManager);
      context.codexLinuxAppshotBackendPath = () => null;
      assert.equal(await service.start(params), null);
      context.codexLinuxAppshotBackendPath = () => "/fixture/backend";
      options.origin.isDestroyed = () => true;
      assert.equal(await service.start(params), null);
    } else if (platform === "win32") {
      context.capabilities = () => ({ appshotsEnabled: false });
      assert.equal(await service.start(params), null);
      assert.equal(await service.getFrontmostWindow(), null);
    } else {
      options.requestComputerUseCaptureWorker = null;
      assert.equal(await service.start(params), null);
    }
    service[Symbol.dispose]();
    assert.equal(await service.getFrontmostWindow(), null);
    assert.equal(await service.start(params), null);
  }
});

test("current capture service delivers pixels and AT-SPI text through existing attachment updates", async () => {
  const { context, service, params, scheduled } = captureServiceContext();
  const updates = [];
  context.codexLinuxAppshotFocusedWindow = async () => ({
    backend: "fixture", focusedWindow: { app_id: "editor", title: "document", bounds: { x: 0, y: 0, width: 10, height: 10 } }, windows: [],
  });
  context.codexLinuxAppshotPrepareWindowForCapture = async (state) => state;
  context.codexLinuxAppshotAccessibilityNodes = async () => ({ nodes: [{ role: "text", text: "selected source" }] });
  context.codexLinuxAppshotScreenshot = async () => ({ dataURL: "data:image/png;base64,cGl4ZWxz" });
  context.codexLinuxAppshotSend = (_manager, _origin, _id, update) => updates.push(update);
  assert.equal((await service.start(params)).result, "started");
  scheduled.splice(0).forEach((callback) => callback());
  await vm.runInContext("codexLinuxAppshotCaptureQueue", context);
  assert.deepEqual(updates.map(({ type }) => type), ["metadata", "axText", "screenshot", "completed"]);
  assert.match(updates[1].text, /selected source/);
  assert.equal(updates[2].screenshotDataURL, "data:image/png;base64,cGl4ZWxz");
  assert.equal(updates[3].transitionSnapshotDataURL, updates[2].screenshotDataURL);
});

test("disposing the capture service cancels queued work and suppresses in-flight attachment delivery", async () => {
  for (const duringCapture of [false, true]) {
    const { context, service, params, scheduled } = captureServiceContext();
    const updates = [];
    let requests = 0;
    let resolveScreenshot;
    context.codexLinuxAppshotFocusedWindow = async () => {
      requests += 1;
      return { backend: "fixture", focusedWindow: { app_id: "editor" }, windows: [] };
    };
    context.codexLinuxAppshotPrepareWindowForCapture = async (state) => state;
    context.codexLinuxAppshotAccessibilityNodes = async () => ({ nodes: [] });
    context.codexLinuxAppshotScreenshot = () => new Promise((resolve) => { resolveScreenshot = resolve; });
    context.codexLinuxAppshotSend = (_manager, _origin, _id, update) => updates.push(update);
    await service.start(params);
    if (duringCapture) {
      scheduled.splice(0).forEach((callback) => callback());
      await new Promise((resolve) => setImmediate(resolve));
    }
    service[Symbol.dispose]();
    if (duringCapture) resolveScreenshot({ dataURL: "data:image/png;base64,cGl4ZWxz" });
    else scheduled.splice(0).forEach((callback) => callback());
    await vm.runInContext("codexLinuxAppshotCaptureQueue", context);
    assert.equal(requests, duringCapture ? 1 : 0);
    assert.deepEqual(updates, []);
  }
});

test("AppShots main descriptors require one complete owner and reject partial helper state", () => {
  const pristine = appshotMainProcessBundleFixture();
  const patched = applyLinuxAppshotMainProcessPatch(pristine);
  for (const invalid of [pristine + pristine, patched + patched, patched.replace('"linux"===process.platform?codexLinuxAppshotFrontmostWindow():', ""), patched.replace("function codexLinuxAppshotSend", "function brokenSend"),
    patched.replace('appshotCapture:"linux"===process.platform||', 'appshotCapture:'),
    patched.replace('new CaptureService({origin:', 'new UnrelatedService({origin:'),
    patched.replace('signal:this.abortController.signal})}', 'signal:null})}'),
    patched.replace('[Symbol.dispose](){this.abortController.abort()}', '[Symbol.dispose](){}'),
    pristine.replace('this.options=e}', 'this.options=null}'),
    pristine.replace('null!=this.options.subscribeComputerUseCaptureWorkerEvent||', ''),
    pristine + 'function codexLinuxAppshotBackendPath(){return null}',
    patched + 'function codexLinuxAppshotBackendPath(){return null}',
    patched + 'let codexLinuxAppshotCaptureQueue=Promise.resolve()',
  ]) {
    assert.equal(matchesLinuxAppshotMainProcessContract(invalid), false);
    captureWarnings(() => assert.equal(applyLinuxAppshotMainProcessPatch(invalid), invalid));
  }
  assert.equal(javascriptSourceParses(patched), true);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "appshots-main-owner-"));
  try {
    const build = path.join(root, ".vite/build");
    fs.mkdirSync(build, { recursive: true });
    const descriptor = descriptors.find(({ id }) => id === "linux-appshots-main-process");
    assert.equal(descriptor.phase, "extracted-app:pre-webview");
    captureWarnings(() => assert.equal(descriptor.apply(root).changed, 0));
    const first = path.join(build, "early-bootstrap.js");
    fs.writeFileSync(first, pristine);
    assert.equal(descriptor.apply(root).changed, 1);
    assert.equal(descriptor.apply(root).changed, 0);
    fs.writeFileSync(path.join(build, "early-bootstrap-1-a1.js"), pristine);
    captureWarnings(() => assert.equal(descriptor.apply(root).changed, 0));
    assert.equal(fs.readFileSync(first, "utf8"), patched);
    fs.writeFileSync(path.join(build, "early-bootstrap-1-a1.js"), patched.replace("function codexLinuxAppshotSend", "function brokenSend"));
    captureWarnings(() => assert.equal(descriptor.apply(root).changed, 0));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects the obsolete raw renderer message sender shape", () => {
  const obsolete = "var F=`codex_desktop:message-for-view`;function nS(e,t){e.send(F,t)}";
  assert.equal(applyLinuxAppshotMainProcessPatch(obsolete), obsolete);
});

test("routes AppShots capture through the self-contained Linux feature", () => {
  const patched = applyPatchTwice(
    applyLinuxAppshotMainProcessPatch,
    appshotMainProcessBundleFixture(),
  );

  assert.match(patched, /"linux"===process\.platform\?codexLinuxAppshotFrontmostWindow\(\):"win32"===process\.platform/);
  assert.match(patched, /return codexLinuxAppshotStartCapture\(\{origin:i,requestId:n,bundleIdentifier:r,windowManager:a,signal:this\.abortController\.signal\}\)/);
  assert.match(patched, /function codexLinuxAppshotBackendPath/);
  assert.match(patched, /codexLinuxAppshotBackendJson\(\[`windows`\],5000\)/);
  assert.match(
    patched,
    /codexLinuxAppshotBackendJson\(e\.startsWith\(`-`\)\?\[`state`,`--`,e\]:\[`state`,e\],10000\)/,
  );
  assert.match(patched, /function codexLinuxAppshotPreviousExternalWindow/);
  assert.match(patched, /function codexLinuxAppshotHyprlandPickerData/);
  assert.match(patched, /`hyprland-preview-share-picker`,`hyprland-share-picker`/);
  assert.match(patched, /function codexLinuxAppshotHyprlandPickerConfig/);
  assert.match(patched, /function codexLinuxAppshotHyprlandInstanceSignature/);
  assert.match(patched, /default_page: windows/);
  assert.match(patched, /GDK_BACKEND:`wayland`/);
  assert.match(patched, /XDPH_WINDOW_SHARING_LIST:n\.list/);
  assert.doesNotMatch(patched, /focusHistoryID/);
  assert.match(patched, /function codexLinuxAppshotHyprlandFocusWindow/);
  assert.match(patched, /\[`dispatch`,`hl\.dsp\.focus/);
  assert.match(patched, /\[`dispatch`,`focuswindow`,t\]/);
  assert.match(patched, /function codexLinuxAppshotPrepareWindowForCapture/);
  assert.match(patched, /let codexLinuxAppshotCaptureQueue=Promise\.resolve\(\)/);
  assert.match(patched, /codexLinuxAppshotVerifyCapturedWindow/);
  assert.match(patched, /codexLinuxAppshotRestoreWindow/);
  assert.match(
    patched,
    /e\.execFile\(`xprop`,\[`-root`,`_NET_CLIENT_LIST_STACKING`\]/,
  );
  assert.match(patched, /function codexLinuxAppshotX11Session/);
  assert.match(patched, /spectacle.*-b.*-n/);
  assert.match(patched, /programs:\[`spectacle`,`\/usr\/bin\/spectacle`\]/);
  assert.match(patched, /codexLinuxAppshotCropWithImageMagick/);
  assert.ok(
    patched.indexOf("await codexLinuxAppshotCropWithImageMagick") <
      patched.indexOf("codexLinuxAppshotCropNativeImage(o,d,c.source===`imagemagick-window`?null:s)"),
  );
  assert.match(patched, /\[linux-appshots\]/);
  assert.match(patched, /codexLinuxAppshotCropRects/);
  assert.match(patched, /codexLinuxAppshotFirstValidCrop/);
  assert.match(patched, /mkdtempSync\(i\.join\(r\.tmpdir\(\),`codex-appshot-`\)\)/);
  assert.match(patched, /chmodSync\(u,448\)/);
  assert.match(patched, /i\.join\(u,`source\.png`\)/);
  assert.match(patched, /i\.join\(u,`crop\.png`\)/);
  assert.match(patched, /rmSync\(u,\{recursive:true,force:true\}\)/);
  assert.doesNotMatch(patched, /i\.join\(r\.tmpdir\(\),`codex-appshot-\$\{/);
  assert.doesNotMatch(patched, /\[`appshot`/);
  assert.doesNotMatch(patched, /bare-modifier-monitor/);
  assert.match(
    patched,
    /function codexLinuxAppshotSend\(e,t,n,r\)\{try\{e\.sendInlineMessageForView\(t,\{requestId:n,type:`computer-use-capture-updated`,update:r\}\)\}catch\{\}\}/,
  );
  assert.doesNotMatch(
    patched,
    /codex_desktop:message-for-view/,
  );
  assert.match(patched, /transitionSnapshotHeight:140/);
  assert.match(patched, /type:`metadata`,app:\{bundleIdentifier:c\.bundleIdentifier/);
  assert.match(patched, /type:`axText`,text:l/);
  assert.match(patched, /type:`screenshot`,screenshotDataURL:u\.dataURL/);
  assert.match(patched, /type:`completed`,transitionSnapshotDataURL:u\.dataURL/);
});

test("AppShots maps an explicit Hyprland picker selection and keeps X11 stacking fallback", () => {
  const patched = applyLinuxAppshotMainProcessPatch(appshotMainProcessBundleFixture());
  const helperStart = patched.lastIndexOf(";function codexLinuxAppshotRequire");
  const context = vm.createContext({
    Buffer,
    console: { warn() {} },
    process: { env: {}, pid: 101, platform: "linux", resourcesPath: "" },
    require() {
      throw new Error("No module access expected");
    },
    setTimeout,
  });
  const windows = [
    {
      app_id: "codex-desktop",
      focused: true,
      pid: 101,
      title: "ChatGPT",
      window_id: Number.parseInt("0x100", 16),
      wm_class: "codex-desktop",
    },
    {
      app_id: "chromium",
      focused: false,
      pid: 202,
      title: "Example - Chromium",
      window_id: Number.parseInt("0x200", 16),
      wm_class: "chromium",
    },
  ];
  vm.runInContext(patched.slice(helperStart), context, { timeout: 1_000 });

  const portalWindow = {
    app_id: "Xdg-desktop-portal-gtk",
    focused: true,
    pid: 303,
    title: "Select Project Root",
    window_id: Number.parseInt("0x300", 16),
    wm_class: "Xdg-desktop-portal-gtk",
  };
  const pickerData = context.codexLinuxAppshotHyprlandPickerData([
    portalWindow,
    windows[0],
    { ...windows[1], title: "Example [HC>] - Chromium" },
    { ...windows[1], app_id: "hidden", hidden: true, window_id: 0x400 },
  ]);

  assert.equal(pickerData.windowsById.size, 1);
  assert.equal(pickerData.windowsById.get("1")?.app_id, "chromium");
  assert.equal(
    pickerData.list,
    "1[HC>]chromium[HT>]Example   - Chromium[HE>]512[HA>]",
  );
  assert.equal(
    context.codexLinuxAppshotHyprlandPickerSelection(
      "debug output\n[SELECTION]/window:1\n",
    ),
    "1",
  );
  assert.equal(context.codexLinuxAppshotHyprlandPickerSelection("cancelled"), null);
  assert.equal(
    context.codexLinuxAppshotHyprlandPickerSelection(
      "[SELECTION]r/window:not-a-number\n",
    ),
    null,
  );
  assert.equal(
    context.codexLinuxAppshotHyprlandPickerData([portalWindow, windows[0]])
      .windowsById.size,
    0,
  );
  assert.equal(
    context.codexLinuxAppshotHyprlandWindowAddress(windows[1]),
    "address:0x200",
  );
  assert.equal(
    context.codexLinuxAppshotHyprlandWindowAddress({ window_id: "invalid" }),
    null,
  );
  assert.equal(
    context.codexLinuxAppshotUsableBounds({
      bounds: { height: 100, width: 100, x: null, y: 0 },
    }),
    false,
  );
  assert.equal(
    context.codexLinuxAppshotPreviousExternalWindow(
      windows,
      context.codexLinuxAppshotX11StackingCandidates(
        "_NET_CLIENT_LIST_STACKING(WINDOW): window id # 0x200, 0x100",
      ),
    )?.app_id,
    "chromium",
  );
  assert.equal(
    context.codexLinuxAppshotPreviousExternalWindow(
      [windows[0]],
      [{ window_id: "0x100" }],
    ),
    null,
  );
  assert.equal(
    context.codexLinuxAppshotPreviousExternalWindow(
      [{ ...windows[1], hidden: true }],
      [{ window_id: "0x200" }],
    ),
    null,
  );
  context.process.env = { DISPLAY: ":0", XDG_SESSION_TYPE: "x11" };
  assert.equal(context.codexLinuxAppshotX11Session(), true);
  context.process.env = { DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-1" };
  assert.equal(context.codexLinuxAppshotX11Session(), false);
});

test("AppShots keeps custom pickers argument-free and forces native Wayland backends", async () => {
  const patched = applyLinuxAppshotMainProcessPatch(appshotMainProcessBundleFixture());
  const helperStart = patched.lastIndexOf(";function codexLinuxAppshotRequire");
  const pickerPath = "/test/custom-share-picker";
  let invocation = null;
  const fakeFs = {
    ...fs,
    accessSync(target, mode) {
      assert.equal(target, pickerPath);
      assert.equal(mode, fs.constants.X_OK);
    },
  };
  const context = vm.createContext({
    Buffer,
    console: { warn() {} },
    process: {
      env: {
        CODEX_LINUX_APPSHOT_PICKER: pickerPath,
        GDK_BACKEND: "x11",
        HOME: "/nonexistent",
        KEEP_ME: "yes",
        QT_QPA_PLATFORM: "xcb",
      },
      pid: 101,
      platform: "linux",
      resourcesPath: "",
    },
    require(moduleName) {
      if (moduleName === "node:fs") return fakeFs;
      if (moduleName === "node:os") return os;
      if (moduleName === "node:path") return path;
      if (moduleName === "node:child_process") {
        return {
          execFile(program, args, options, callback) {
            invocation = { args, options, program };
            callback(null, "[SELECTION]/window:1\n", "");
          },
        };
      }
      throw new Error(`Unexpected module: ${moduleName}`);
    },
    setTimeout,
  });
  const window = {
    app_id: "org.gnome.Nautilus",
    focused: false,
    title: "Documents",
    window_id: 0x200,
    wm_class: "org.gnome.Nautilus",
  };

  vm.runInContext(patched.slice(helperStart), context, { timeout: 1_000 });
  const selected = await context.codexLinuxAppshotHyprlandPickWindow([window]);

  assert.equal(selected?.app_id, window.app_id);
  assert.equal(invocation?.program, pickerPath);
  assert.deepEqual(Array.from(invocation?.args ?? []), []);
  assert.equal(invocation?.options.env.GDK_BACKEND, "wayland");
  assert.equal(invocation?.options.env.QT_QPA_PLATFORM, "wayland");
  assert.equal(invocation?.options.env.KEEP_ME, "yes");
  assert.match(invocation?.options.env.XDPH_WINDOW_SHARING_LIST ?? "", /Documents/);
});

test("AppShots overrides only the picker default page and removes the temporary config", () => {
  const patched = applyLinuxAppshotMainProcessPatch(appshotMainProcessBundleFixture());
  const helperStart = patched.lastIndexOf(";function codexLinuxAppshotRequire");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "appshots-picker-config-"));
  const configDir = path.join(home, ".config", "hyprland-preview-share-picker");
  const configPath = path.join(configDir, "config.yaml");
  const source = [
    'stylesheets: ["../../theme/picker.css"]',
    "default_page: outputs",
    "window:",
    "  width: 1000",
    "",
  ].join("\n");
  const context = vm.createContext({
    Buffer,
    console: { warn() {} },
    process: { env: { HOME: home }, pid: 101, platform: "linux", resourcesPath: "" },
    require,
    setTimeout,
  });

  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(configPath, source);

  try {
    vm.runInContext(patched.slice(helperStart), context, { timeout: 1_000 });
    const override = context.codexLinuxAppshotHyprlandPickerConfig({ preview: true });
    const args = Array.from(override.args);

    assert.equal(args[0], "--config");
    assert.equal(path.dirname(args[1]), configDir);
    assert.notEqual(args[1], configPath);
    assert.equal(fs.readFileSync(configPath, "utf8"), source);
    assert.equal(
      fs.readFileSync(args[1], "utf8"),
      source.replace("default_page: outputs", "default_page: windows"),
    );

    override.cleanup();
    assert.equal(fs.existsSync(args[1]), false);

    fs.writeFileSync(configPath, source.replace("default_page: outputs", "default_page: windows"));
    const unchanged = context.codexLinuxAppshotHyprlandPickerConfig({ preview: true });
    assert.deepEqual(Array.from(unchanged.args), []);
    assert.deepEqual(
      Array.from(context.codexLinuxAppshotHyprlandPickerConfig({ preview: false }).args),
      [],
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("AppShots resolves the live Hyprland instance when Electron did not inherit it", () => {
  const patched = applyLinuxAppshotMainProcessPatch(appshotMainProcessBundleFixture());
  const helperStart = patched.lastIndexOf(";function codexLinuxAppshotRequire");
  const fakeFs = {
    ...fs,
    existsSync(target) {
      return target === "/proc/111" || target === "/proc/222";
    },
    readFileSync(target) {
      if (target.endsWith("/older/hyprland.lock")) return "111\nwayland-0\n";
      if (target.endsWith("/matching/hyprland.lock")) return "222\nwayland-1\n";
      throw new Error(`Unexpected read: ${target}`);
    },
    readdirSync(target) {
      assert.equal(target, "/runtime/hypr");
      return ["older", "matching"];
    },
    statSync(target) {
      if (!target.endsWith("/.socket.sock")) throw new Error(`Unexpected stat: ${target}`);
      return {
        isSocket: () => true,
        mtimeMs: target.includes("matching") ? 10 : 20,
      };
    },
  };
  const context = vm.createContext({
    Buffer,
    console: { warn() {} },
    process: {
      env: { XDG_RUNTIME_DIR: "/runtime", WAYLAND_DISPLAY: "wayland-1" },
      getuid: () => 1000,
      pid: 101,
      platform: "linux",
      resourcesPath: "",
    },
    require(moduleName) {
      if (moduleName === "node:fs") return fakeFs;
      if (moduleName === "node:path") return path;
      throw new Error(`Unexpected module: ${moduleName}`);
    },
    setTimeout,
  });

  vm.runInContext(patched.slice(helperStart), context, { timeout: 1_000 });

  assert.equal(context.codexLinuxAppshotHyprlandInstanceSignature(), "matching");
  assert.deepEqual(
    Array.from(context.codexLinuxAppshotHyprctlArgs(["clients", "-j"])),
    ["-i", "matching", "clients", "-j"],
  );
  assert.equal(
    context.codexLinuxAppshotHyprlandEnv().HYPRLAND_INSTANCE_SIGNATURE,
    "matching",
  );

  context.process.env.HYPRLAND_INSTANCE_SIGNATURE = "inherited";
  assert.deepEqual(
    Array.from(context.codexLinuxAppshotHyprctlArgs(["clients", "-j"])),
    ["clients", "-j"],
  );
});

test("AppShots ends backend flags before a candidate that starts with a dash", async () => {
  const patched = applyLinuxAppshotMainProcessPatch(appshotMainProcessBundleFixture());
  const helperStart = patched.lastIndexOf(";function codexLinuxAppshotRequire");
  const context = vm.createContext({
    Buffer,
    console: { warn() {} },
    process: { env: {}, pid: 101, platform: "linux", resourcesPath: "" },
    require() {
      throw new Error("No module access expected");
    },
    setTimeout,
  });
  vm.runInContext(patched.slice(helperStart), context, { timeout: 1_000 });
  const calls = [];
  context.codexLinuxAppshotBackendJson = async (args) => {
    calls.push(Array.from(args));
    // The backend refuses an unknown flag with exit 2, so only `--` reaches
    // the terminal frame named after the login shell.
    if (args[1] === "-zsh") throw new Error("unknown option '-zsh' for 'state'");
    return args[2] === "-zsh" ? [{ role: "frame", name: "-zsh" }] : [];
  };

  const result = await context.codexLinuxAppshotAccessibilityNodes(
    { app_id: "org.example.Terminal", wm_class: "example-terminal", title: "-zsh" },
    "org.example.Terminal",
  );

  assert.equal(result.candidate, "-zsh");
  assert.equal(result.nodes.length, 1);
  assert.deepEqual(calls, [
    ["state", "org.example.Terminal"],
    ["state", "example-terminal"],
    ["state", "--", "-zsh"],
  ]);
});

test("AppShots requires a safe return target before changing Hyprland focus", async () => {
  const patched = applyLinuxAppshotMainProcessPatch(appshotMainProcessBundleFixture());
  const helperStart = patched.lastIndexOf(";function codexLinuxAppshotRequire");
  const context = vm.createContext({
    Buffer,
    console: { warn() {} },
    process: { env: {}, pid: 101, platform: "linux", resourcesPath: "" },
    require() {
      throw new Error("No module access expected");
    },
    setTimeout,
  });
  let focusCalls = 0;
  vm.runInContext(patched.slice(helperStart), context, { timeout: 1_000 });
  context.codexLinuxAppshotHyprlandFocusWindow = async () => {
    focusCalls += 1;
    return true;
  };

  await assert.rejects(
    context.codexLinuxAppshotPrepareWindowForCapture({
      backend: "hyprland",
      focusedWindow: {
        app_id: "chromium",
        bounds: { height: 800, width: 1200, x: 0, y: 0 },
        focused: false,
        window_id: 0x200,
        wm_class: "chromium",
      },
      returnWindow: null,
    }),
    /No safe ChatGPT return target/,
  );
  assert.equal(focusCalls, 0);

  const hiddenReturn = {
    app_id: "codex-desktop",
    bounds: { height: 800, width: 1200, x: 0, y: 0 },
    hidden: true,
    pid: 101,
    window_id: 0x100,
    wm_class: "codex-desktop",
  };
  assert.equal(context.codexLinuxAppshotValidReturnWindow(hiddenReturn), false);
  assert.equal(
    context.codexLinuxAppshotValidReturnWindow({ ...hiddenReturn, hidden: false }),
    true,
  );
});

test("AppShots rejects changed, hidden, unfocused, or moved capture targets", async () => {
  const patched = applyLinuxAppshotMainProcessPatch(appshotMainProcessBundleFixture());
  const helperStart = patched.lastIndexOf(";function codexLinuxAppshotRequire");
  const context = vm.createContext({
    Buffer,
    console: { warn() {} },
    process: { env: {}, pid: 101, platform: "linux", resourcesPath: "" },
    require() {
      throw new Error("No module access expected");
    },
    setTimeout,
  });
  const selected = {
    app_id: "chromium",
    bounds: { height: 800, width: 1200, x: 0, y: 0 },
    focused: true,
    pid: 202,
    window_id: 0x200,
    wm_class: "chromium",
  };
  vm.runInContext(patched.slice(helperStart), context, { timeout: 1_000 });

  assert.equal(
    context.codexLinuxAppshotCaptureReadyWindow([selected], selected, "0:0:1200:800")
      ?.window_id,
    0x200,
  );
  for (const changed of [
    { ...selected, app_id: "other" },
    { ...selected, focused: false },
    { ...selected, hidden: true },
    { ...selected, bounds: { ...selected.bounds, x: 20 } },
  ]) {
    assert.equal(
      context.codexLinuxAppshotCaptureReadyWindow(
        [changed],
        selected,
        "0:0:1200:800",
      ),
      null,
    );
  }

  context.codexLinuxAppshotBackendJson = async () => ({
    backend: "hyprland",
    windows: [{ ...selected, app_id: "other" }],
  });
  await assert.rejects(
    context.codexLinuxAppshotVerifyCapturedWindow(selected, "0:0:1200:800"),
    /changed during capture/,
  );
});

test("AppShots activates a selected Hyprland window and waits for stable bounds", async () => {
  const patched = applyLinuxAppshotMainProcessPatch(appshotMainProcessBundleFixture());
  const helperStart = patched.lastIndexOf(";function codexLinuxAppshotRequire");
  const context = vm.createContext({
    Buffer,
    console: { warn() {} },
    process: { env: {}, pid: 101, platform: "linux", resourcesPath: "" },
    require() {
      throw new Error("No module access expected");
    },
    setTimeout,
  });
  const selected = {
    app_id: "chromium",
    bounds: { height: 400, width: 600, x: 900, y: 100 },
    focused: false,
    window_id: 0x200,
    wm_class: "chromium",
  };
  const refreshed = {
    ...selected,
    bounds: { height: 800, width: 1200, x: 0, y: 0 },
    focused: true,
  };
  const ownWindow = {
    app_id: "codex-desktop",
    bounds: { height: 800, width: 1200, x: 0, y: 0 },
    focused: false,
    pid: 101,
    window_id: 0x100,
    wm_class: "codex-desktop",
  };
  const focusCalls = [];
  let windowReports = 0;

  vm.runInContext(patched.slice(helperStart), context, { timeout: 1_000 });
  context.codexLinuxAppshotHyprlandFocusWindow = async (window) => {
    focusCalls.push(window.window_id);
    return true;
  };
  context.codexLinuxAppshotBackendJson = async () => {
    windowReports += 1;
    return { backend: "hyprland", windows: [ownWindow, refreshed] };
  };
  context.codexLinuxAppshotDelay = async () => {};

  const prepared = await context.codexLinuxAppshotPrepareWindowForCapture({
    backend: "hyprland",
    focusedWindow: selected,
    returnWindow: ownWindow,
    windows: [ownWindow, selected],
  });

  assert.deepEqual(focusCalls, [0x200]);
  assert.equal(windowReports, 4);
  assert.equal(prepared.focusedWindow.window_id, 0x200);
  assert.equal(prepared.focusedWindow.focused, true);
  assert.equal(prepared.focusedWindow.bounds.width, 1200);
});

function x11AppshotCaptureFixture({ backend = "x11", initiallyFocused = false, failure } = {}) {
  const patched = applyLinuxAppshotMainProcessPatch(appshotMainProcessBundleFixture());
  const desktop = {
    app_id: "codex-desktop", wm_class: "codex-desktop", pid: 101,
    window_id: 0x100, focused: !initiallyFocused,
    bounds: { x: 0, y: 0, width: 1200, height: 800 },
  };
  const external = {
    app_id: "chromium", wm_class: "chromium", pid: 202,
    window_id: 0x200, focused: initiallyFocused, title: "Example - Chromium",
    bounds: { ...desktop.bounds },
  };
  const updates = [];
  const activations = [];
  let screenshots = 0;
  const context = vm.createContext({
    Buffer, console: { warn() {} }, setTimeout,
    process: { env: { DISPLAY: ":fixture", XDG_SESSION_TYPE: "x11" }, pid: 101, platform: "linux" },
    require(name) {
      assert.equal(name, "node:child_process");
      return { execFile(program, args, _options, callback) {
        // i3 and Sway take the decimal X11 id; Sway rejects the hex form.
        const id = backend === "i3" ? Number(args[0].match(/^\[id="(\d+)"\] focus$/)[1]) : Number(args[2]);
        assert.equal(program, backend === "i3" ? "i3-msg" : "wmctrl");
        assert.deepEqual(Array.from(args), backend === "i3"
          ? [`[id="${id}"] focus`] : ["-i", "-a", `0x${id.toString(16)}`]);
        activations.push(id);
        if (failure === "activation-command" && id === external.window_id) {
          callback(new Error("activation failed"), "", "");
          return;
        }
        if (!(failure === "activation-ignored" && id === external.window_id)
            && !(failure === "restore-ignored" && id === desktop.window_id)) {
          desktop.focused = id === desktop.window_id;
          external.focused = id === external.window_id;
        }
        callback(null, backend === "i3" ? '[{"success":true}]' : "", "");
      } };
    },
  });
  vm.runInContext(patched.slice(patched.lastIndexOf(";function codexLinuxAppshotRequire")), context);
  context.codexLinuxAppshotI3Program = () => "i3-msg";
  context.codexLinuxAppshotI3Socket = () => null;
  context.codexLinuxAppshotBackendJson = async () => ({
    backend, windows: [structuredClone(desktop), structuredClone(external)],
  });
  context.codexLinuxAppshotX11Stacking = async () => [{ window_id: "0x100" }, { window_id: "0x200" }];
  context.codexLinuxAppshotDelay = async () => {};
  context.codexLinuxAppshotAccessibilityNodes = async () => ({ nodes: [], error: null });
  context.codexLinuxAppshotScreenshot = async (target) => {
    screenshots++;
    assert.equal(target.window_id, external.window_id);
    // Model the actual root screenshot: the covering Desktop supplies the pixels until activation.
    const dataURL = `data:image/png;base64,${desktop.focused ? "DESKTOP" : "CHROMIUM"}`;
    if (failure === "target-changed") external.pid = 999;
    if (failure === "focus-changed") { external.focused = false; desktop.focused = true; }
    if (failure === "bounds-changed") external.bounds.x = 20;
    return { dataURL };
  };
  context.codexLinuxAppshotSend = (_manager, _origin, _request, update) => {
    if (!initiallyFocused) assert.equal(desktop.focused, true, "restore before delivering any content");
    updates.push(update);
  };
  return {
    context, desktop, external, updates, activations,
    screenshots: () => screenshots,
    capture: () => context.codexLinuxAppshotCapture({ origin: "fixture", requestId: "fixture", windowManager: {} }),
  };
}

for (const backend of ["x11", "i3"]) {
  test(`AppShots activates the covered ${backend} target and restores Desktop before delivery`, async () => {
    const fixture = x11AppshotCaptureFixture({ backend });
    await fixture.capture();
    assert.equal(fixture.updates.find((update) => update.type === "metadata").app.name, "chromium");
    assert.equal(fixture.updates.find((update) => update.type === "screenshot").screenshotDataURL,
      "data:image/png;base64,CHROMIUM");
    assert.deepEqual(fixture.activations, [0x200, 0x100]);
    assert.equal(fixture.updates.at(-1).type, "completed");
  });
}

test("AppShots focuses i3 and Sway windows the way the i3 backend reports them", async () => {
  const patched = applyLinuxAppshotMainProcessPatch(appshotMainProcessBundleFixture());
  const calls = [];
  const context = vm.createContext({
    Buffer, console: { warn() {} }, setTimeout,
    process: { env: {}, pid: 101, platform: "linux" },
    require(name) {
      assert.equal(name, "node:child_process");
      return { execFile(program, args, _options, callback) {
        calls.push([program, ...args]);
        callback(null, '[{"success":true}]', "");
      } };
    },
  });
  vm.runInContext(patched.slice(patched.lastIndexOf(";function codexLinuxAppshotRequire")), context);

  // swaymsg only when i3-msg is missing, as the backend's ipc_program does.
  for (const [installed, expected] of [
    [["i3-msg", "swaymsg"], "i3-msg"],
    [["swaymsg"], "swaymsg"],
    [["i3-msg"], "i3-msg"],
    [[], "i3-msg"],
  ]) {
    context.codexLinuxAppshotExecutablePath = (names) =>
      names.find((name) => installed.includes(name)) ?? null;
    assert.equal(context.codexLinuxAppshotI3Program(), expected);
  }

  // X11 windows take their decimal id; a native Wayland window on Sway is
  // 2^32 plus its container id and is focused by con_id, as i3_focus_command
  // does. The socket the backend would pick goes in front with -s.
  context.codexLinuxAppshotI3Program = () => "swaymsg";
  context.codexLinuxAppshotI3Socket = () => null;
  for (const window_id of [0x200, 2 ** 32 - 1, 2 ** 32, 2 ** 32 + 7]) {
    assert.equal(await context.codexLinuxAppshotFocusWindow({ window_id }, "i3"), true);
  }
  context.codexLinuxAppshotI3Socket = () => "/run/user/1000/sway-ipc.1000.42.sock";
  assert.equal(await context.codexLinuxAppshotFocusWindow({ window_id: 0x200 }, "i3"), true);
  assert.deepEqual(calls, [
    ["swaymsg", '[id="512"] focus'],
    ["swaymsg", '[id="4294967295"] focus'],
    ["swaymsg", '[con_id="0"] focus'],
    ["swaymsg", '[con_id="7"] focus'],
    ["swaymsg", "-s", "/run/user/1000/sway-ipc.1000.42.sock", '[id="512"] focus'],
  ]);
});

test("AppShots finds the i3 or Sway socket in the backend's order", async (t) => {
  const net = require("node:net");
  const patched = applyLinuxAppshotMainProcessPatch(appshotMainProcessBundleFixture());
  const runtime = makeSocketTempDir("as-", "sway-ipc.1000.42.sock");
  const servers = [];
  t.after(async () => {
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
    fs.rmSync(runtime, { recursive: true, force: true });
  });
  const listen = (socketPath) => new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(socketPath, () => { servers.push(server); resolve(socketPath); });
  });
  const env = {};
  const context = vm.createContext({
    Buffer, console: { warn() {} }, setTimeout,
    process: { env, pid: 101, platform: "linux" },
    require,
  });
  vm.runInContext(patched.slice(patched.lastIndexOf(";function codexLinuxAppshotRequire")), context);
  const missing = path.join(runtime, "missing.sock");
  env.XDG_RUNTIME_DIR = runtime;
  assert.equal(context.codexLinuxAppshotI3Socket(), null);
  env.I3SOCK = missing;
  assert.equal(context.codexLinuxAppshotI3Socket(), missing, "a set variable is the last resort");
  const sway = await listen(path.join(runtime, "sway-ipc.1000.42.sock"));
  assert.equal(context.codexLinuxAppshotI3Socket(), sway);
  fs.mkdirSync(path.join(runtime, "i3"));
  const i3 = await listen(path.join(runtime, "i3", "ipc-socket.7"));
  assert.equal(context.codexLinuxAppshotI3Socket(), i3, "the i3 runtime socket comes before Sway's");
  env.SWAYSOCK = sway;
  assert.equal(context.codexLinuxAppshotI3Socket(), sway, "a set variable naming a socket comes first");
});

test("AppShots ranks Sway windows by Xwayland stacking only when it lists every target", async () => {
  const patched = applyLinuxAppshotMainProcessPatch(appshotMainProcessBundleFixture());
  const context = vm.createContext({
    Buffer, console: { warn() {} }, setTimeout,
    process: { env: { WAYLAND_DISPLAY: "wayland-1", XDG_SESSION_TYPE: "wayland" }, pid: 101, platform: "linux" },
    require() {
      throw new Error("No module access expected");
    },
  });
  vm.runInContext(patched.slice(patched.lastIndexOf(";function codexLinuxAppshotRequire")), context);
  let stackingReads = 0;
  context.codexLinuxAppshotX11Stacking = async () => {
    stackingReads++;
    return [{ window_id: "0x1200003" }];
  };
  const chatgpt = { app_id: "codex-desktop", pid: 101, window_id: 2 ** 32 + 1, focused: true };
  const code = { app_id: "code", wm_class: "code", pid: 303, window_id: 0x1200003, focused: false };
  const firefox = { app_id: "firefox", pid: 404, window_id: 2 ** 32 + 2, focused: false };

  // Every external window is Xwayland: the stacking list covers them.
  const covered = await context.codexLinuxAppshotResolvedWindow({ backend: "i3", windows: [chatgpt, code] });
  assert.equal(covered.focusedWindow?.app_id, "code");
  assert.equal(stackingReads, 1);

  // A native Wayland window is missing from Xwayland stacking, so no target is guessed.
  const mixed = await context.codexLinuxAppshotResolvedWindow({ backend: "i3", windows: [chatgpt, firefox, code] });
  assert.equal(mixed.focusedWindow, null);
  assert.equal(stackingReads, 1);
});

for (const failure of ["activation-command", "activation-ignored", "target-changed", "focus-changed", "bounds-changed", "restore-ignored"]) {
  test(`AppShots delivers no X11 attachment on ${failure}`, async () => {
    const fixture = x11AppshotCaptureFixture({ failure });
    await assert.rejects(fixture.capture(), /activate|capture-ready|changed during capture|focus restoration/);
    assert.deepEqual(fixture.updates, []);
    assert.equal(fixture.activations.at(-1), 0x100);
    if (failure.startsWith("activation")) assert.equal(fixture.screenshots(), 0);
  });
}

test("AppShots rejects an unfocused X11 fallback from an unsupported compositor backend", async () => {
  const fixture = x11AppshotCaptureFixture({ backend: "unsupported" });
  await assert.rejects(fixture.capture(), /Unsupported.*capture/);
  assert.deepEqual(fixture.updates, []);
  assert.deepEqual(fixture.activations, []);
  assert.equal(fixture.screenshots(), 0);
});

test("AppShots verifies an already focused X11 target without a focus handoff", async () => {
  const fixture = x11AppshotCaptureFixture({ initiallyFocused: true });
  await fixture.capture();
  assert.equal(fixture.updates.find((update) => update.type === "screenshot").screenshotDataURL,
    "data:image/png;base64,CHROMIUM");
  assert.deepEqual(fixture.activations, []);
  assert.equal(fixture.external.focused, true);

  const changed = x11AppshotCaptureFixture({ initiallyFocused: true, failure: "target-changed" });
  await assert.rejects(changed.capture(), /changed during capture/);
  assert.deepEqual(changed.updates, []);
});

test("AppShots restores ChatGPT after successful and failed Hyprland capture", async () => {
  const patched = applyLinuxAppshotMainProcessPatch(appshotMainProcessBundleFixture());
  const helperStart = patched.lastIndexOf(";function codexLinuxAppshotRequire");
  const context = vm.createContext({
    Buffer,
    console: { warn() {} },
    process: { env: {}, pid: 101, platform: "linux", resourcesPath: "" },
    require() {
      throw new Error("No module access expected");
    },
    setTimeout,
  });
  const ownWindow = {
    app_id: "codex-desktop",
    bounds: { height: 800, width: 1200, x: 0, y: 0 },
    focused: true,
    pid: 101,
    window_id: 0x100,
    wm_class: "codex-desktop",
  };
  const selected = {
    app_id: "chromium",
    bounds: { height: 800, width: 1200, x: 0, y: 0 },
    focused: true,
    title: "Example - Chromium",
    window_id: 0x200,
    wm_class: "chromium",
  };
  const report = {
    backend: "hyprland",
    focusedWindow: selected,
    returnWindow: ownWindow,
    windows: [{ ...ownWindow, focused: false }, selected],
  };
  const restoreCalls = [];
  const updates = [];
  const trace = [];

  vm.runInContext(patched.slice(helperStart), context, { timeout: 1_000 });
  context.codexLinuxAppshotFocusedWindow = async () => report;
  context.codexLinuxAppshotPrepareWindowForCapture = async () => report;
  context.codexLinuxAppshotAccessibilityNodes = async () => ({
    error: null,
    nodes: [],
  });
  context.codexLinuxAppshotAccessibilityText = () => "accessibility text";
  context.codexLinuxAppshotVerifyCapturedWindow = async () => {
    trace.push("verify-captured-target");
    return selected;
  };
  context.codexLinuxAppshotScreenshot = async () => ({
    dataURL: "data:image/png;base64,AA==",
  });
  context.codexLinuxAppshotSend = (_manager, _origin, _requestId, update) => {
    updates.push(update.type);
    trace.push(`send:${update.type}`);
  };
  context.codexLinuxAppshotRestoreWindow = async (window) => {
    restoreCalls.push(window.window_id);
    trace.push(`restore:${window.window_id}`);
    return true;
  };

  await context.codexLinuxAppshotCapture({
    bundleIdentifier: "chromium",
    origin: "view",
    requestId: "success",
    windowManager: {},
  });
  assert.deepEqual(updates, ["metadata", "axText", "screenshot", "completed"]);
  assert.deepEqual(restoreCalls, [0x100]);
  assert.deepEqual(trace, [
    "verify-captured-target",
    "restore:256",
    "send:metadata",
    "send:axText",
    "send:screenshot",
    "send:completed",
  ]);

  restoreCalls.length = 0;
  trace.length = 0;
  context.codexLinuxAppshotScreenshot = async () => {
    throw new Error("Expected capture failure");
  };
  await assert.rejects(
    context.codexLinuxAppshotCapture({
      bundleIdentifier: "chromium",
      origin: "view",
      requestId: "failure",
      windowManager: {},
    }),
    /Expected capture failure/,
  );
  assert.deepEqual(restoreCalls, [0x100]);
  assert.deepEqual(trace, ["restore:256"]);

  updates.length = 0;
  restoreCalls.length = 0;
  trace.length = 0;
  context.codexLinuxAppshotScreenshot = async () => ({
    dataURL: "data:image/png;base64,AA==",
  });
  context.codexLinuxAppshotRestoreWindow = async (window) => {
    restoreCalls.push(window.window_id);
    trace.push(`restore-failed:${window.window_id}`);
    return false;
  };
  await assert.rejects(
    context.codexLinuxAppshotCapture({
      bundleIdentifier: "chromium",
      origin: "view",
      requestId: "restore-failure",
      windowManager: {},
    }),
    /Could not verify ChatGPT focus restoration/,
  );
  assert.deepEqual(updates, []);
  assert.deepEqual(restoreCalls, [0x100]);
  assert.deepEqual(trace, ["verify-captured-target", "restore-failed:256"]);
});

test("AppShots prefers direct X11 window capture before root screenshot fallback", () => {
  const patched = applyLinuxAppshotMainProcessPatch(appshotMainProcessBundleFixture());
  const helperStart = patched.lastIndexOf(";function codexLinuxAppshotRequire");
  const context = vm.createContext({
    process: { env: {}, pid: 101, platform: "linux" },
    require() {
      throw new Error("No module access expected");
    },
  });

  vm.runInContext(patched.slice(helperStart), context, { timeout: 1_000 });

  const directCapture = context.codexLinuxAppshotScreenshotCommands({
    backend: "x11",
    window_id: 0x200,
  })[0];
  assert.equal(directCapture.source, "imagemagick-window");
  assert.deepEqual(Array.from(directCapture.programs), ["import", "/usr/bin/import"]);
  assert.deepEqual(Array.from(directCapture.args), ["-window", "0x200"]);
  assert.equal(directCapture.output, "append");
  for (const window_id of [0, -1, NaN, 1.5, "invalid", Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(
      context.codexLinuxAppshotScreenshotCommands({ backend: "x11", window_id })[0].source,
      "grim",
    );
  }
  assert.equal(
    context.codexLinuxAppshotScreenshotCommands({
      backend: "wayland",
      window_id: 0x200,
    })[0].source,
    "grim",
  );
  // An X11 window under i3 or Xwayland keeps the direct capture; a native
  // Wayland window on Sway (2^32 plus its container id) has no X11 id.
  for (const window_id of [0x200, 2 ** 32 - 1]) {
    assert.deepEqual(
      Array.from(context.codexLinuxAppshotScreenshotCommands({ backend: "i3", window_id })[0].args),
      ["-window", `0x${window_id.toString(16)}`],
    );
  }
  for (const window_id of [2 ** 32, 2 ** 32 + 7]) {
    assert.equal(
      context.codexLinuxAppshotScreenshotCommands({ backend: "i3", window_id })[0].source,
      "grim",
    );
  }
});

test("AppShots captures accessibility and pixels concurrently", async () => {
  const patched = applyLinuxAppshotMainProcessPatch(appshotMainProcessBundleFixture());
  const helperStart = patched.lastIndexOf(";function codexLinuxAppshotRequire");
  const context = vm.createContext({
    Buffer,
    console: { warn() {} },
    process: { env: {}, pid: 101, platform: "linux", resourcesPath: "" },
    require() {
      throw new Error("No module access expected");
    },
    setTimeout,
  });
  const ownWindow = {
    app_id: "codex-desktop",
    focused: false,
    pid: 101,
    window_id: 0x100,
  };
  const selected = {
    app_id: "chromium",
    bounds: { height: 800, width: 1200, x: 0, y: 0 },
    focused: true,
    window_id: 0x200,
  };
  const report = {
    backend: "hyprland",
    focusedWindow: selected,
    returnWindow: ownWindow,
    windows: [ownWindow, selected],
  };
  let releaseAccessibility;
  let screenshotStarted = false;

  vm.runInContext(patched.slice(helperStart), context, { timeout: 1_000 });
  context.codexLinuxAppshotFocusedWindow = async () => report;
  context.codexLinuxAppshotPrepareWindowForCapture = async () => report;
  context.codexLinuxAppshotAccessibilityNodes = () =>
    new Promise((resolve) => {
      releaseAccessibility = () => resolve({ error: null, nodes: [] });
    });
  context.codexLinuxAppshotAccessibilityText = () => "";
  context.codexLinuxAppshotVerifyCapturedWindow = async () => selected;
  context.codexLinuxAppshotScreenshot = async () => {
    screenshotStarted = true;
    return { dataURL: "data:image/png;base64,AA==" };
  };
  context.codexLinuxAppshotRestoreWindow = async () => true;
  context.codexLinuxAppshotSend = () => {};

  const capture = context.codexLinuxAppshotCapture({
    bundleIdentifier: "chromium",
    origin: "view",
    requestId: "parallel",
    windowManager: {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(screenshotStarted, true);
  releaseAccessibility();
  await capture;
});

test("AppShots serializes capture transactions", async () => {
  const patched = applyLinuxAppshotMainProcessPatch(appshotMainProcessBundleFixture());
  const helperStart = patched.lastIndexOf(";function codexLinuxAppshotRequire");
  const scheduled = [];
  const context = vm.createContext({
    Buffer,
    console: { warn() {} },
    process: { env: {}, pid: 101, platform: "linux", resourcesPath: "" },
    require() {
      throw new Error("No module access expected");
    },
    setTimeout(callback) {
      scheduled.push(callback);
      return scheduled.length;
    },
  });
  const started = [];
  const releases = [];
  vm.runInContext(patched.slice(helperStart), context, { timeout: 1_000 });
  context.codexLinuxAppshotCapture = ({ requestId }) =>
    new Promise((resolve) => {
      started.push(requestId);
      releases.push(resolve);
    });
  context.codexLinuxAppshotSend = () => {};

  context.codexLinuxAppshotStartCapture({
    bundleIdentifier: "first",
    origin: "view",
    requestId: "first",
    windowManager: {},
  });
  context.codexLinuxAppshotStartCapture({
    bundleIdentifier: "second",
    origin: "view",
    requestId: "second",
    windowManager: {},
  });
  scheduled.splice(0).forEach((callback) => callback());
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["first"]);

  releases.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["first", "second"]);
  releases.shift()();
  await vm.runInContext("codexLinuxAppshotCaptureQueue", context);
});

test("AppShots preserves window captures and cleans private temporary directories", async () => {
  const patched = applyLinuxAppshotMainProcessPatch(appshotMainProcessBundleFixture());
  const helperStart = patched.lastIndexOf(";function codexLinuxAppshotRequire");
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "appshots-private-capture-"));
  const captureDirs = [];
  const chmodModes = [];
  let failCaptures = false;
  let failDirectCapture = false;
  const cropArgs = [];

  assert.ok(helperStart >= 0);

  const fakeFs = {
    ...fs,
    mkdtempSync(prefix) {
      const captureDir = fs.mkdtempSync(prefix);
      captureDirs.push(captureDir);
      return captureDir;
    },
    chmodSync(target, mode) {
      chmodModes.push(mode);
      fs.chmodSync(target, mode);
    },
  };
  const fakeChildProcess = {
    execFile(program, args, options, callback) {
      if (failCaptures) {
        callback(new Error("Expected capture failure"), "", "expected failure");
        return;
      }
      if (program.endsWith("import") && args[1] === "0x200") {
        if (failDirectCapture) callback(new Error("Direct capture unavailable"), "", "");
        else {
          fs.writeFileSync(args.at(-1), "window source");
          callback(null, "", "");
        }
        return;
      }
      if (program.endsWith("grim")) {
        fs.writeFileSync(args.at(-1), "source");
        callback(null, "", "");
        return;
      }
      if (program.endsWith("identify")) {
        callback(null, "100 100", "");
        return;
      }
      if (program.endsWith("convert")) {
        cropArgs.push(args[2]);
        fs.writeFileSync(args.at(-1), "crop");
        callback(null, "", "");
        return;
      }
      callback(new Error(`Unexpected program: ${program}`), "", "unexpected program");
    },
  };
  const context = vm.createContext({
    Buffer,
    console: { warn() {} },
    process: { env: {}, pid: process.pid, platform: "linux", resourcesPath: "" },
    require(moduleName) {
      if (moduleName === "node:fs") return fakeFs;
      if (moduleName === "node:os") return { tmpdir: () => tempRoot };
      if (moduleName === "node:path") return path;
      if (moduleName === "node:child_process") return fakeChildProcess;
      if (moduleName === "electron") {
        return {
          nativeImage: {
            createFromPath: () => ({
              getSize: () => ({ width: 0, height: 0 }),
            }),
          },
        };
      }
      throw new Error(`Unexpected module: ${moduleName}`);
    },
    setTimeout,
  });

  try {
    vm.runInContext(patched.slice(helperStart), context, { timeout: 1_000 });
    const result = await context.codexLinuxAppshotScreenshot(
      { bounds: { height: 40, width: 50, x: 0, y: 0 } },
      [],
    );

    assert.equal(result?.width, 50);
    assert.equal(result?.height, 40);
    assert.match(result?.dataURL ?? "", /^data:image\/png;base64,/);
    assert.equal(captureDirs.length, 1);
    assert.equal(fs.existsSync(captureDirs[0]), false);

    for (const backend of ["x11", "i3"]) {
      const direct = await context.codexLinuxAppshotScreenshot(
        { backend, window_id: 0x200, bounds: { x: 20, y: 30, width: 50, height: 40 } },
        [],
      );
      assert.equal(direct.width, 100);
      assert.equal(direct.height, 100);
      assert.equal(cropArgs.at(-1), "100x100+0+0");
      assert.match(direct.source, /^imagemagick-window:/);
    }
    failDirectCapture = true;
    const fallback = await context.codexLinuxAppshotScreenshot(
      { backend: "x11", window_id: 0x200, bounds: { x: 20, y: 30, width: 50, height: 40 } },
      [],
    );
    assert.equal(fallback.width, 50);
    assert.equal(fallback.height, 40);
    assert.equal(cropArgs.at(-1), "50x40+20+30");
    assert.match(fallback.source, /^grim:/);

    const nativeCrops = [];
    const nativeImage = {
      createFromPath: () => ({
        getSize: () => ({ width: 100, height: 100 }),
        crop: (rect) => {
          nativeCrops.push({ ...rect });
          return { getSize: () => ({ width: rect.width, height: rect.height }) };
        },
      }),
    };
    const native = context.codexLinuxAppshotCropNativeImage(nativeImage, "source.png", null);
    assert.equal(native.width, 100);
    assert.equal(native.height, 100);
    assert.deepEqual(nativeCrops, [{ x: 0, y: 0, width: 100, height: 100 }]);
    assert.equal(context.codexLinuxAppshotCropNativeImage({
      createFromPath: () => ({ getSize: () => ({ width: NaN, height: NaN }) }),
    }, "invalid.png", null), null);

    failCaptures = true;
    const failedResult = await context.codexLinuxAppshotScreenshot(
      { bounds: { height: 40, width: 50, x: 0, y: 0 } },
      [],
    );

    assert.equal(failedResult, null);
    assert.ok(captureDirs.length > 1);
    assert.deepEqual(chmodModes, captureDirs.map(() => 0o700));
    assert.ok(captureDirs.every((captureDir) => !fs.existsSync(captureDir)));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("current AppShots hotkey owner supports Linux and registers a saved bare-modifier shortcut", () => {
  const pristine = currentAppshotHotkeyMainBundleFixture();
  const patched = applyPatchTwice(applyLinuxAppshotHotkeyPatch, pristine);

  assert.equal(matchesLinuxAppshotHotkeyContract(pristine), true);
  assert.equal(matchesLinuxAppshotHotkeyContract(patched), true);
  assert.match(patched, /"linux"===process\.platform\|\|"darwin"===process\.platform/);
  assert.match(patched, /"darwin"!==process\.platform&&"linux"!==process\.platform/);
  assert.match(patched, /"shift","meta","win"/);
  assert.match(patched, /"linux"===process\.platform\?null:"DoubleCommand"/);

  const context = vm.createContext({
    process: { env: { XDG_SESSION_TYPE: "x11" }, platform: "linux" },
  });
  vm.runInContext(patched, context);
  const noSavedShortcut = new context.AppshotHotkeys({ getStored() {} });
  assert.equal(noSavedShortcut.getState().supported, true);
  assert.equal(noSavedShortcut.getState().configuredHotkey, null);
  assert.equal(noSavedShortcut.getState().linuxWayland, false);
  assert.equal(noSavedShortcut.getState().isActive, false);

  const savedShortcut = new context.AppshotHotkeys({ getStored: () => "DoubleAlt" });
  assert.equal(savedShortcut.getState().supported, true);
  assert.equal(savedShortcut.getState().isActive, true);
  assert.equal(context.registered.hotkey, "DoubleAlt");
  assert.equal(context.hotkeyEligible("DoubleAlt"), true);
  assert.deepEqual(Array.from(context.modifiers).slice(-3), ["shift", "meta", "win"]);
});

test("AppShots hotkey Linux eligibility remains disabled for Wayland bare modifiers", () => {
  const patched = applyLinuxAppshotHotkeyPatch(currentAppshotHotkeyMainBundleFixture());
  const context = vm.createContext({
    process: { env: { WAYLAND_DISPLAY: "wayland-0" }, platform: "linux" },
  });
  vm.runInContext(patched, context);
  assert.equal(context.hotkeyEligible("DoubleAlt"), false);
  assert.equal(new context.AppshotHotkeys({ getStored() {} }).getState().linuxWayland, true);
});

test("AppShots hotkey patch fails closed for missing, partial, duplicate, and ambiguous owners", () => {
  const pristine = currentAppshotHotkeyMainBundleFixture();
  const patched = applyLinuxAppshotHotkeyPatch(pristine);
  const partial = patched.replace(
    '"linux"===process.platform||"darwin"===process.platform',
    '"darwin"===process.platform',
  );
  const missing = "globalThis.appshotHotkeyState=`appshot-hotkey-state`";
  const retired = pristine.replace("let r=zk(e)??Qk(e)", "let r=zk(e)");
  const mixedContracts = pristine + 'var retired=function(e,t,n="press"){if("darwin"!==process.platform)return null;let r=zk(e);};';
  for (const source of [
    missing,
    retired,
    mixedContracts,
    partial,
    pristine + pristine,
    patched + patched,
    pristine + patched,
  ]) {
    assert.equal(matchesLinuxAppshotHotkeyContract(source), false);
    assert.deepEqual(captureWarnings(() => {
      assert.equal(applyLinuxAppshotHotkeyPatch(source), source);
    }), [
      "WARN: Could not find one complete current AppShots hotkey owner - skipping Linux AppShots hotkey patch",
    ]);
  }
});


test("AppShots factory preserves native platform eligibility and activates Linux without native workers", () => {
  const patched = applyLinuxAppshotMainProcessPatch(appshotMainProcessBundleFixture());
  for (const scenario of [
    { platform: "linux", options: {}, present: true },
    { platform: "darwin", options: {}, present: false },
    { platform: "darwin", options: { requestComputerUseWorker() {} }, present: false },
    { platform: "darwin", options: { requestComputerUseWorker() {}, subscribeComputerUseCaptureWorkerEvent() {} }, present: true },
    { platform: "win32", options: {}, present: false },
    { platform: "win32", options: { windowsCaptureNativeBridge: {} }, present: true },
    { platform: "freebsd", options: {}, present: false },
  ]) {
    const context = vm.createContext({ owner: { TF: class {} }, process: { platform: scenario.platform }, AbortController, Symbol });
    vm.runInContext(patched, context);
    const service = context.services.call({ options: scenario.options, settings: {} }, {}, {}).appshotCapture;
    assert.equal(service != null, scenario.present, scenario.platform);
  }
});

test("AppShots Linux routing forwards an empty bundle identifier accepted by the native target schema", async () => {
  const { context, service, params } = captureServiceContext();
  const calls = [];
  context.codexLinuxAppshotStartCapture = (request) => { calls.push(request); return { result: "started" }; };
  assert.equal((await service.start({ ...params, bundleIdentifier: "" })).result, "started");
  assert.equal(calls[0].bundleIdentifier, "");
  assert.equal(calls[0].requestId, params.requestId);
});

test(
  "signed upstream AppShots factory creates its actual Linux service and forwards lifecycle to capture",
  { skip: process.env.CODEX_SIGNED_EXTRACTED_APP == null },
  async () => {
    const { findMainProcessChunks } = require("../../scripts/patches/lib/assets.js");
    const main = findMainProcessChunks(process.env.CODEX_SIGNED_EXTRACTED_APP);
    const owners = main.chunks.map((name) => ({ name, source: fs.readFileSync(path.join(main.buildDir, name), "utf8") }))
      .filter(({ source }) => matchesLinuxAppshotMainProcessContract(source));
    assert.equal(owners.length, 1);
    const patched = applyLinuxAppshotMainProcessPatch(owners[0].source);
    assert.notEqual(patched, owners[0].source);
    assert.equal(applyLinuxAppshotMainProcessPatch(patched), patched);
    assert.doesNotThrow(() => new vm.Script(patched));
    const factory = [...patched.matchAll(/appshotCapture:[^?{}]+\?new ([A-Za-z_$][\w$]*)\(\{[^{}]*\}\):void 0/g)];
    assert.equal(factory.length, 1);
    const constructor = new RegExp(`class ${escapeRegExp(factory[0][1])} extends ([A-Za-z_$][\\w$]*)(?:\\.([A-Za-z_$][\\w$]*))?\\{`).exec(patched);
    assert.ok(constructor);
    const open = constructor.index + constructor[0].lastIndexOf("{");
    const end = findMatchingBrace(patched, open);
    const classSource = patched.slice(constructor.index, end + 1);
    const calls = [];
    const context = vm.createContext({
      [constructor[1]]: constructor[2] == null ? class {} : { [constructor[2]]: class {} },
      AbortController, Symbol, process: { platform: "linux" },
      origin: { isDestroyed: () => false }, windowManager: {}, owner: { options: {}, settings: {} },
      codexLinuxAppshotBackendPath: () => "/fixture/backend",
      codexLinuxAppshotFrontmostWindow: () => "linux-window",
      codexLinuxAppshotStartCapture: (request) => { calls.push(request); return { result: "started" }; },
    });
    vm.runInContext(`${classSource};globalThis.service=(function(e,g){return{${factory[0][0]}}}).call(owner,origin,windowManager).appshotCapture`, context);
    const service = context.service;
    assert.ok(service, "the actual factory must expose the Linux service");
    assert.equal(await service.getFrontmostWindow(), "linux-window");
    const request = { animationDestination: {}, animationPresentationStyle: "immediate", bundleIdentifier: "", requestId: "f73f1558-d31d-4e89-824d-652539788e86" };
    assert.equal((await service.start(request)).result, "started");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].origin, context.origin);
    assert.equal(calls[0].windowManager, context.windowManager);
    assert.equal(calls[0].bundleIdentifier, "");
    assert.equal(calls[0].requestId, request.requestId);
    assert.equal(calls[0].signal, service.abortController.signal);
    service[Symbol.dispose]();
    assert.equal(await service.start(request), null);
    assert.equal(await service.getFrontmostWindow(), null);
    assert.equal(calls.length, 1);
    const unreachable = patched.replace('appshotCapture:"linux"===process.platform||', 'appshotCapture:');
    assert.equal(matchesLinuxAppshotMainProcessContract(unreachable), false);
    captureWarnings(() => assert.equal(applyLinuxAppshotMainProcessPatch(unreachable), unreachable));
  },
);

test(
  "signed upstream webview exposes exactly one current AppShots availability and hotkey owner",
  { skip: process.env.CODEX_SIGNED_EXTRACTED_APP == null },
  () => {
    const { findWebviewAssetsContaining, findMainProcessChunks } = require("../../scripts/patches/lib/assets.js");
    const root = process.env.CODEX_SIGNED_EXTRACTED_APP;
    const descriptor = descriptors.find(({ id }) => id === "linux-appshots-availability");
    const owners = findWebviewAssetsContaining(root, descriptor.assetNeedles)
      .filter((name) => matchesLinuxAppshotAvailabilityContract(fs.readFileSync(path.join(root, "webview/assets", name), "utf8")));
    assert.equal(owners.length, 1);
    const source = fs.readFileSync(path.join(root, "webview/assets", owners[0]), "utf8");
    assert.notEqual(applyLinuxAppshotAvailabilityPatch(source), source);
    const main = findMainProcessChunks(root);
    const hotkeys = main.chunks.map((name) => fs.readFileSync(path.join(main.buildDir, name), "utf8"))
      .filter(matchesLinuxAppshotHotkeyContract);
    assert.equal(hotkeys.length, 1);
    const patched = applyLinuxAppshotHotkeyPatch(hotkeys[0]);
    assert.notEqual(patched, hotkeys[0]);
    assert.equal(applyLinuxAppshotHotkeyPatch(patched), patched);
    assert.doesNotThrow(() => new vm.Script(patched));
  },
);


test("AppShots binds the factory to both bare and namespaced capture base classes", () => {
  const namespaced = appshotMainProcessBundleFixture();
  for (const source of [namespaced, namespaced.replace("extends owner.TF", "extends TF")]) {
    assert.equal(matchesLinuxAppshotMainProcessContract(source), true);
    const patched = applyLinuxAppshotMainProcessPatch(source);
    assert.notEqual(patched, source);
    assert.equal(matchesLinuxAppshotMainProcessContract(patched), true);
    assert.equal(applyLinuxAppshotMainProcessPatch(patched), patched);
  }
});
