#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const {
  enabledLinuxFeatureIds,
  enabledLinuxFeatureInstallPlan,
  loadLinuxFeaturePatchDescriptors,
} = require("../../scripts/lib/linux-features.js");
const {
  RUNTIME_VERSION,
  STYLE_LINK_ID,
  THEME_CSS_ENV,
  INDEX_ENTRY_NEEDLES,
  applyOmarchyThemeLoader,
  omarchyThemeState,
  isWebviewIndexEntry,
  omarchyThemeRuntimeSource,
} = require("./patch.js");

// Shape of the rspack runtime entry chunks referenced by webview/index.html
// and webview/detached-window.html in the signed 26.1029.61003 package.
const INDEX_ENTRY_FIXTURE =
  'var e,a,c,v,p={Gav4(e,a,c){let f="codex-host-chunked-message-v1"},' +
  'R2r9(e,a,c){c.a(e,async function(e,a){try{c("TL6G"),a()}catch(e){a(e)}},1)}};' +
  'var O=p.O(void 0,["782259","727403","158624"],()=>p("R2r9"));p.O(O);export{v as __webpack_require__};\n' +
  "//# sourceMappingURL=348410.09aab3f377.js.map";
const DETACHED_ENTRY_FIXTURE = INDEX_ENTRY_FIXTURE.replace(
  'c("TL6G"),a()',
  'let{initializeDetachedWindow:e}=await c.e(770265).then(c.bind(c,"b9YD"));await e(),a()',
);

const FEATURE_DIR = __dirname;

function commandPath(name) {
  for (const directory of (process.env.PATH || "").split(path.delimiter)) {
    if (!directory || !path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (!fs.statSync(candidate).isFile()) continue;
      return candidate;
    } catch {}
  }
  throw new Error(`could not resolve executable from PATH: ${name}`);
}

const BASH = commandPath("bash");

function withFeatureConfig(enabled, fn) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-omarchy-theme-config-"));
  const originalConfig = process.env.CODEX_LINUX_FEATURES_CONFIG;
  const configPath = path.join(tempDir, "features.json");
  fs.writeFileSync(configPath, `${JSON.stringify({ enabled }, null, 2)}\n`);
  process.env.CODEX_LINUX_FEATURES_CONFIG = configPath;
  try {
    return fn(path.resolve(FEATURE_DIR, ".."));
  } finally {
    if (originalConfig == null) {
      delete process.env.CODEX_LINUX_FEATURES_CONFIG;
    } else {
      process.env.CODEX_LINUX_FEATURES_CONFIG = originalConfig;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

test("omarchy-theme stays disabled until selected", () => {
  withFeatureConfig([], (featuresRoot) => {
    assert.deepEqual(enabledLinuxFeatureIds({ featuresRoot }), []);
    assert.deepEqual(loadLinuxFeaturePatchDescriptors({ featuresRoot }), []);
    const plan = enabledLinuxFeatureInstallPlan({ featuresRoot });
    assert.deepEqual(plan.resources, []);
    assert.deepEqual(plan.runtimeHooks, []);
  });
});

test("omarchy-theme exposes optional patches, resources, and hooks when enabled", () => {
  withFeatureConfig(["omarchy-theme"], (featuresRoot) => {
    assert.deepEqual(enabledLinuxFeatureIds({ featuresRoot }), ["omarchy-theme"]);

    const descriptors = loadLinuxFeaturePatchDescriptors({ featuresRoot });
    assert.equal(descriptors.length, 1);
    assert.equal(descriptors[0].id, "feature:omarchy-theme:omarchy-theme-css-loader");
    assert.equal(descriptors[0].ciPolicy, "optional");
    assert.equal(descriptors[0].pattern, undefined);
    assert.deepEqual(descriptors[0].assetNeedles, INDEX_ENTRY_NEEDLES);
    assert.equal(descriptors[0].assetMatch(INDEX_ENTRY_FIXTURE, "348410.09aab3f377.js"), true);
    assert.equal(descriptors[0].assetMatch(DETACHED_ENTRY_FIXTURE, "357055.8ef98feffe.js"), false);
    assert.equal(descriptors[0].assetMatch(INDEX_ENTRY_FIXTURE, "async/202543.e3d6d1466d.js"), false);

    const plan = enabledLinuxFeatureInstallPlan({ featuresRoot });
    assert.deepEqual(
      plan.resources.map((resource) => [resource.id, resource.target, resource.mode]),
      [[
        "omarchy-theme",
        ".codex-linux/features/omarchy-theme/codex-desktop.css.tpl",
        0o644,
      ]],
    );
    assert.deepEqual(
      plan.runtimeHooks.map((hook) => [hook.id, hook.key, hook.target, hook.mode]),
      [
        [
          "omarchy-theme",
          "prelaunch",
          ".codex-linux/prelaunch.d/omarchy-theme-install-template.sh",
          0o755,
        ],
        [
          "omarchy-theme",
          "launcher",
          ".codex-linux/launcher.d/omarchy-theme-stylesheet-env.sh",
          0o755,
        ],
      ],
    );
  });
});

test("renderer patch targets only the index entry chunk", () => {
  assert.equal(isWebviewIndexEntry(INDEX_ENTRY_FIXTURE), true);
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(message);
  try {
    for (const source of [DETACHED_ENTRY_FIXTURE, "console.log('codex');"]) {
      assert.equal(applyOmarchyThemeLoader(source), source);
    }
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 2);
});

function eventTarget() {
  const listeners = new Map();
  return {
    listeners,
    addEventListener(name, listener, options) {
      if (!listeners.has(name)) listeners.set(name, new Map());
      listeners.get(name).set(listener, options);
    },
    removeEventListener(name, listener) { listeners.get(name)?.delete(listener); },
    emit(name) {
      for (const [listener, options] of [...(listeners.get(name) ?? [])]) {
        if (options?.once) listeners.get(name).delete(listener);
        listener();
      }
    },
    count(name) { return listeners.get(name)?.size ?? 0; },
  };
}

function rendererHarness(bridge, { loading = false, target = true, failAppend = false } = {}) {
  const links = new Map(), timers = new Map(), window = eventTarget(), document = eventTarget();
  let intervalCount = 0, clearCount = 0, appends = 0;
  const head = { appendChild(node) {
    if (failAppend) { failAppend = false; throw Error("temporary DOM failure"); }
    appends++; links.set(node.id, node);
  } };
  Object.assign(document, {
    readyState: loading ? "loading" : "complete", hidden: false,
    head: target ? head : null, documentElement: null,
    getElementById: (id) => links.get(id) ?? null,
    createElement: (tag) => ({ tagName: tag.toUpperCase(), textContent: "", remove() { links.delete(this.id); } }),
  });
  const context = vm.createContext({
    codexLinuxOmarchyTheme: bridge, window, document,
    setInterval(fn, delay) { assert.equal(delay, 5000); timers.set(++intervalCount, fn); return intervalCount; },
    clearInterval(id) { clearCount++; timers.delete(id); },
  });
  return {
    context, window, document, links, timers, head,
    load: () => vm.runInContext(omarchyThemeRuntimeSource(), context),
    tick: () => [...timers.values()].forEach((fn) => fn()),
    stats: () => ({ intervalCount, clearCount, appends }),
    style: () => links.get(STYLE_LINK_ID)?.textContent,
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("renderer runtime is idempotent, process-free and refreshes on interval/focus/visibility", async () => {
  let css = ":root{--accent:red}", calls = 0;
  const harness = rendererHarness({ readStylesheet: async () => { calls++; return css; } });
  harness.load(); harness.load(); await settle();
  assert.equal(vm.runInContext("typeof process", harness.context), "undefined");
  assert.equal(harness.style(), css);
  assert.deepEqual(harness.stats(), { intervalCount: 1, clearCount: 0, appends: 1 });
  assert.equal(harness.window.count("focus"), 1);
  assert.equal(harness.document.count("visibilitychange"), 1);
  css = ":root{--accent:blue}"; harness.tick(); await settle(); assert.equal(harness.style(), css);
  css = ":root{--accent:green}"; harness.window.emit("focus"); await settle(); assert.equal(harness.style(), css);
  harness.document.hidden = true; const before = calls; harness.document.emit("visibilitychange"); await settle(); assert.equal(calls, before);
  harness.document.hidden = false; css = ":root{--accent:orange}"; harness.document.emit("visibilitychange"); await settle(); assert.equal(harness.style(), css);
  harness.context.codexLinuxOmarchyThemeCleanup();
  assert.equal(harness.timers.size, 0); assert.equal(harness.window.count("focus"), 0); assert.equal(harness.document.count("visibilitychange"), 0);
  harness.load(); await settle(); assert.equal(harness.timers.size, 1); assert.equal(harness.window.count("focus"), 1);
  assert.equal(harness.stats().appends, 1);
});

test("DOM loading, missing targets, cleanup-before-load and transient DOM errors recover", async () => {
  let calls = 0; const bridge = { readStylesheet: async () => { calls++; return "body{color:red}"; } };
  const loading = rendererHarness(bridge, { loading: true, target: false });
  loading.load(); loading.load(); assert.equal(calls, 0); assert.equal(loading.document.count("DOMContentLoaded"), 1);
  loading.document.emit("DOMContentLoaded"); await settle(); assert.equal(calls, 1); assert.equal(loading.links.size, 0); assert.equal(loading.timers.size, 1);
  loading.document.head = loading.head; loading.tick(); await settle(); assert.equal(loading.style(), "body{color:red}");
  const cancelled = rendererHarness(bridge, { loading: true });
  cancelled.load(); cancelled.context.codexLinuxOmarchyThemeCleanup(); cancelled.document.emit("DOMContentLoaded"); await settle(); assert.equal(cancelled.timers.size, 0); assert.equal(cancelled.links.size, 0);
  const failed = rendererHarness(bridge, { failAppend: true });
  failed.load(); await settle(); assert.equal(failed.links.size, 0); assert.equal(failed.timers.size, 1);
  failed.window.emit("focus"); await settle(); assert.equal(failed.style(), "body{color:red}");
});

test("launcher hook publishes the generated stylesheet as a file URI", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-omarchy-theme-uri-"));
  try {
    const stylesheet = path.join(tempDir, "theme.css");
    const result = spawnSync(BASH, [path.join(FEATURE_DIR, "stylesheet-env.sh")], {
      env: { ...process.env, CODEX_LINUX_OMARCHY_STYLESHEET: stylesheet },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), `env ${THEME_CSS_ENV}=${new URL(`file://${stylesheet}`).href}`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("prelaunch hook installs the template, refreshes missing CSS, and preserves local edits", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-omarchy-template-install-"));
  try {
    const home = path.join(tempDir, "home");
    const featuresDir = path.join(tempDir, "features");
    const stagedDir = path.join(featuresDir, "omarchy-theme");
    const omarchyHome = path.join(home, ".config", "omarchy");
    const target = path.join(omarchyHome, "themed", "codex-desktop.css.tpl");
    const generated = path.join(omarchyHome, "current", "theme", "codex-desktop.css");
    const binDir = path.join(tempDir, "bin");
    const callLog = path.join(tempDir, "omarchy.log");
    fs.mkdirSync(stagedDir, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    fs.copyFileSync(path.join(FEATURE_DIR, "codex-desktop.css.tpl"), path.join(stagedDir, "codex-desktop.css.tpl"));
    const fakeOmarchy = path.join(binDir, "omarchy");
    fs.writeFileSync(
      fakeOmarchy,
      `#!${BASH}\nset -e\nprintf '%s\\n' "$*" >> "$OMARCHY_TEST_LOG"\nmkdir -p "$HOME/.config/omarchy/current/theme"\nprintf 'generated' > "$HOME/.config/omarchy/current/theme/codex-desktop.css"\n`,
    );
    fs.chmodSync(fakeOmarchy, 0o755);

    const env = {
      ...process.env,
      HOME: home,
      PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`,
      CODEX_LINUX_FEATURES_DIR: featuresDir,
      OMARCHY_TEST_LOG: callLog,
    };
    const first = spawnSync(BASH, [path.join(FEATURE_DIR, "install-template.sh")], {
      env,
      encoding: "utf8",
    });
    assert.equal(first.status, 0, first.stderr);
    assert.equal(fs.readFileSync(target, "utf8"), fs.readFileSync(path.join(FEATURE_DIR, "codex-desktop.css.tpl"), "utf8"));
    assert.equal(fs.readFileSync(generated, "utf8"), "generated");
    assert.equal(fs.readFileSync(callLog, "utf8"), "theme refresh\n");

    fs.writeFileSync(target, "/* local customization */\n");
    fs.rmSync(generated);
    const second = spawnSync(BASH, [path.join(FEATURE_DIR, "install-template.sh")], {
      env,
      encoding: "utf8",
    });
    assert.equal(second.status, 0, second.stderr);
    assert.equal(fs.readFileSync(target, "utf8"), "/* local customization */\n");
    assert.equal(fs.readFileSync(generated, "utf8"), "generated");
    assert.equal(fs.readFileSync(callLog, "utf8"), "theme refresh\ntheme refresh\n");
    assert.match(second.stderr, /leaving it untouched/);

    fs.rmSync(generated);
    fs.writeFileSync(
      fakeOmarchy,
      `#!${BASH}\nsleep 30\n`,
    );
    const startedAt = Date.now();
    const hanging = spawnSync(BASH, [path.join(FEATURE_DIR, "install-template.sh")], {
      env: {
        ...env,
        CODEX_OMARCHY_THEME_REFRESH_TIMEOUT_SECONDS: "1",
      },
      encoding: "utf8",
    });
    assert.equal(hanging.status, 0, hanging.stderr);
    assert.ok(Date.now() - startedAt < 5000, "prelaunch hook must not wait for a hung refresh");
    assert.match(hanging.stderr, /timed out or failed/);
    assert.equal(fs.existsSync(generated), false);

    const timeoutLog = path.join(tempDir, "timeout.log");
    fs.writeFileSync(
      path.join(binDir, "timeout"),
      `#!${BASH}\nprintf '%s\\n' "$*" > "$OMARCHY_TEST_TIMEOUT_LOG"\nexit 124\n`,
    );
    fs.chmodSync(path.join(binDir, "timeout"), 0o755);
    const oversizedTimeout = spawnSync(BASH, [path.join(FEATURE_DIR, "install-template.sh")], {
      env: {
        ...env,
        CODEX_OMARCHY_THEME_REFRESH_TIMEOUT_SECONDS: "999999999999999999999",
        OMARCHY_TEST_TIMEOUT_LOG: timeoutLog,
      },
      encoding: "utf8",
    });
    assert.equal(oversizedTimeout.status, 0, oversizedTimeout.stderr);
    assert.match(oversizedTimeout.stderr, /whole number between 1 and 60 seconds/);
    assert.equal(fs.readFileSync(timeoutLog, "utf8"), "--kill-after=2s 15s omarchy theme refresh\n");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});


const transport = require("./transport.js");
const { applyExtractedAppPatchDescriptors } = require("../../scripts/patches/engine.js");
const { createPatchReport, captureWarnings } = require("../../scripts/lib/patch-report.js");
const { javascriptSourceParses } = require("../../scripts/patches/lib/javascript-syntax.js");
const { findWebviewAssetsContaining } = require("../../scripts/patches/lib/assets.js");
const { pathToFileURL } = require("node:url");
const NATIVE_PRELOAD_FIXTURE = 'const{contextBridge,ipcRenderer}=require("electron");ipcRenderer.sendSync("codex_desktop:get-system-theme-variant");contextBridge.exposeInMainWorld("electronBridge",{getDesktopUserAgent(){return"fixture"}});';

function testDirectory(t) {
  const cache = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "codex-desktop-dev");
  fs.mkdirSync(cache, { recursive: true });
  const root = fs.mkdtempSync(path.join(cache, "omarchy-theme-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function nativeTransport(t, { preloadSource = NATIVE_PRELOAD_FIXTURE, reply } = {}) {
  const root = testDirectory(t), stylesheet = path.join(root, "theme file#?.css");
  const hook = spawnSync(BASH, [path.join(FEATURE_DIR, "stylesheet-env.sh")], {
    env: { ...process.env, CODEX_LINUX_OMARCHY_STYLESHEET: stylesheet }, encoding: "utf8",
  });
  assert.equal(hook.status, 0, hook.stderr);
  const uri = hook.stdout.trim().slice(`env ${THEME_CSS_ENV}=`.length);
  const env = { [THEME_CSS_ENV]: uri }, handlers = new Map(), pending = new Set(), replies = [], invocations = [];
  let registrations = 0, event = { senderFrame: { url: "app://-/index.html", parent: null }, sender: { isDestroyed: () => false } };
  const ipcMain = {
    handle(channel, handler) { assert.equal(handlers.has(channel), false); registrations++; handlers.set(channel, handler); },
    removeHandler(channel) { handlers.delete(channel); },
  };
  const main = vm.createContext({ Buffer, URL, process: { env }, require(name) {
    return name === "electron" ? { ipcMain } : require(name);
  } });
  vm.runInContext(transport.mainRuntimeSource(), main);
  const exposed = new Map();
  const ipcRenderer = {
    send() {}, on() {}, removeListener() {}, postMessage() {},
    sendSync(channel) { return channel.endsWith("get-system-theme-variant") ? "light" : { appVersion: "26.1029.61003", codexAppSessionId: "fixture" }; },
    invoke(channel, ...args) {
      invocations.push({ channel, args }); const number = invocations.length;
      const result = Promise.resolve().then(() => {
        const handler = handlers.get(channel);
        if (!handler) throw Error("No registered CSS handler");
        return handler(event, ...args);
      }).then((value) => { replies.push(value); return reply ? reply(value, number) : value; });
      pending.add(result); result.then(() => pending.delete(result), () => pending.delete(result)); return result;
    },
  };
  const window = { ...eventTarget(), location: { origin: "app://-" }, postMessage() {} };
  const preload = vm.createContext({
    window, document: { documentElement: { dataset: {} } }, performance: { timeOrigin: 1 },
    module: { exports: {} }, process: { platform: "linux", arch: "x64" }, console,
    require(name) { assert.equal(name, "electron"); return { ipcRenderer, contextBridge: { exposeInMainWorld(name, value) { assert.equal(exposed.has(name), false); exposed.set(name, value); } }, webUtils: { getPathForFile: () => "" } }; },
  });
  vm.runInContext(preloadSource + "\n" + transport.preloadRuntimeSource(), preload);
  return {
    root, stylesheet, env, handlers, main, preload, exposed, invocations, replies,
    bridge: exposed.get(transport.BRIDGE), registrations: () => registrations,
    useSender(value) { event = value; },
    async drain() { while (pending.size) await Promise.allSettled([...pending]); await settle(); },
    async waitForReplies(count) {
      const deadline = Date.now() + 3000;
      while (replies.length < count && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 1));
      assert.ok(replies.length >= count);
      await settle();
    },
  };
}

test("registered main/preload bridge reads only configured regular bounded CSS and validates the exact native frame", async (t) => {
  const bridge = nativeTransport(t);
  assert.deepEqual(Object.keys(bridge.bridge), ["readStylesheet"]);
  assert.equal(await bridge.bridge.readStylesheet(), null);
  fs.writeFileSync(bridge.stylesheet, ":root{--accent:red}");
  assert.equal(await bridge.bridge.readStylesheet("/etc/passwd"), ":root{--accent:red}");
  assert.deepEqual(bridge.invocations.at(-1).args, []);
  const valid = { senderFrame: { url: "app://-/index.html?initialRoute=home#home", parent: null }, sender: { isDestroyed: () => false } };
  assert.equal(new URL(valid.senderFrame.url).origin, new URL("app://untrusted/index.html").origin);
  for (const url of ["https://example.test/index.html", "app://untrusted/index.html", "app://-/detached-window.html", "app://-/index.html.evil", "app://user@-/index.html", "app://-:123/index.html"]) {
    bridge.useSender({ ...valid, senderFrame: { url, parent: null } });
    assert.equal(await bridge.bridge.readStylesheet(), null, url);
  }
  bridge.useSender({ ...valid, senderFrame: { url: valid.senderFrame.url, parent: {} } });
  assert.equal(await bridge.bridge.readStylesheet(), null);
  bridge.useSender({ ...valid, sender: { isDestroyed: () => true } });
  assert.equal(await bridge.bridge.readStylesheet(), null);
  bridge.useSender(valid); bridge.env[THEME_CSS_ENV] = ""; assert.equal(await bridge.bridge.readStylesheet(), null);
  bridge.env[THEME_CSS_ENV] = "https://example.test/theme.css"; assert.equal(await bridge.bridge.readStylesheet(), null);
  bridge.env[THEME_CSS_ENV] = pathToFileURL(bridge.root).href; assert.equal(await bridge.bridge.readStylesheet(), null);
  bridge.env[THEME_CSS_ENV] = pathToFileURL(bridge.stylesheet).href;
  fs.writeFileSync(bridge.stylesheet, Buffer.alloc(transport.MAX_CSS_BYTES + 1)); assert.equal(await bridge.bridge.readStylesheet(), null);
  fs.writeFileSync(bridge.stylesheet, ""); assert.equal(await bridge.bridge.readStylesheet(), "");
});

test("actual launcher preserves the current-theme symlink and registered renderer reloads after missing/error/theme switch", async (t) => {
  const bridge = nativeTransport(t), first = path.join(bridge.root, "first"), second = path.join(bridge.root, "second"), current = path.join(bridge.root, "current");
  const initiallyMissing = rendererHarness(bridge.bridge); initiallyMissing.load(); await bridge.drain();
  assert.equal(initiallyMissing.links.size, 0); assert.equal(initiallyMissing.timers.size, 1);
  fs.writeFileSync(bridge.stylesheet, "body{color:available}"); initiallyMissing.window.emit("focus"); await bridge.drain();
  assert.equal(initiallyMissing.style(), "body{color:available}"); initiallyMissing.context.codexLinuxOmarchyThemeCleanup();
  fs.mkdirSync(first); fs.mkdirSync(second); fs.mkdirSync(current);
  fs.writeFileSync(path.join(first, "theme.css"), "body{color:red}"); fs.writeFileSync(path.join(second, "theme.css"), "body{color:blue}");
  const symlink = path.join(current, "theme"); fs.symlinkSync(first, symlink);
  const selected = path.join(symlink, "theme.css");
  const hook = spawnSync(BASH, [path.join(FEATURE_DIR, "stylesheet-env.sh")], { env: { ...process.env, CODEX_LINUX_OMARCHY_STYLESHEET: selected }, encoding: "utf8" });
  assert.equal(hook.status, 0, hook.stderr); bridge.env[THEME_CSS_ENV] = hook.stdout.trim().slice(`env ${THEME_CSS_ENV}=`.length);
  assert.equal(bridge.env[THEME_CSS_ENV], pathToFileURL(selected).href);
  const renderer = rendererHarness(bridge.bridge); renderer.load(); await bridge.drain(); assert.equal(renderer.style(), "body{color:red}");
  assert.equal(vm.runInContext("typeof process", renderer.context), "undefined");
  fs.unlinkSync(symlink); fs.symlinkSync(second, symlink);
  renderer.window.emit("focus"); await bridge.drain(); assert.equal(renderer.style(), "body{color:blue}");
  fs.unlinkSync(path.join(second, "theme.css")); renderer.tick(); await bridge.drain(); assert.equal(renderer.style(), "body{color:blue}");
  fs.writeFileSync(path.join(second, "theme.css"), "body{color:green}"); renderer.tick(); await bridge.drain(); assert.equal(renderer.style(), "body{color:green}");
  bridge.main.codexLinuxOmarchyThemeMainCleanup(); renderer.window.emit("focus"); await bridge.drain(); assert.equal(renderer.style(), "body{color:green}");
  vm.runInContext(transport.mainRuntimeSource(), bridge.main); vm.runInContext(transport.mainRuntimeSource(), bridge.main);
  vm.runInContext(transport.preloadRuntimeSource(), bridge.preload);
  fs.writeFileSync(path.join(second, "theme.css"), "body{color:orange}"); renderer.window.emit("focus"); await bridge.drain(); assert.equal(renderer.style(), "body{color:orange}");
  assert.equal(bridge.handlers.size, 1); assert.equal(bridge.registrations(), 2); assert.equal(renderer.links.size, 1);
});

test("stale registered CSS replies and cleanup cannot overwrite or reinstall a later stylesheet", async (t) => {
  let release; const gate = new Promise((resolve) => { release = resolve; });
  const bridge = nativeTransport(t, { reply: (css, number) => number === 1 ? gate.then(() => css) : css });
  fs.writeFileSync(bridge.stylesheet, "body{color:old}");
  const renderer = rendererHarness(bridge.bridge); renderer.load(); await bridge.waitForReplies(1);
  fs.writeFileSync(bridge.stylesheet, "body{color:new}"); renderer.window.emit("focus"); await bridge.waitForReplies(2); assert.equal(renderer.style(), "body{color:new}");
  release(); await bridge.drain(); assert.equal(renderer.style(), "body{color:new}");
  let finish; const pending = new Promise((resolve) => { finish = resolve; });
  const late = rendererHarness({ readStylesheet: () => pending }); late.load(); late.context.codexLinuxOmarchyThemeCleanup(); finish("body{color:late}"); await settle();
  assert.equal(late.links.size, 0); assert.equal(late.timers.size, 0);
});

function appWorkspace(t, overrides = {}) {
  const root = testDirectory(t), files = {
    "package.json": JSON.stringify({ main: ".vite/build/early-bootstrap.js" }),
    ".vite/build/early-bootstrap.js": 'require("electron");module.exports={};',
    ".vite/build/preload.js": NATIVE_PRELOAD_FIXTURE,
    "webview/index.html": '<script type="module" src="./assets/index.js"></script>',
    "webview/assets/index.js": INDEX_ENTRY_FIXTURE,
    ...overrides,
  };
  for (const [name, source] of Object.entries(files)) { const target = path.join(root, name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, source); }
  return { root, files };
}

function normalDescriptor(root) {
  const report = createPatchReport();
  const [descriptor] = require("./patch.js").descriptors;
  captureWarnings(() => applyExtractedAppPatchDescriptors(root, [descriptor], {}, report, descriptor.phase));
  return report.patches[0];
}

test("a canonical main transport cannot prove its own erased native bootstrap", () => {
  const runtime = transport.mainRuntimeSource(), native = 'require("electron");module.exports={};';
  const owner = (source) => /\brequire\(/u.test(source);
  assert.equal(transport.runtimeState(runtime, runtime, owner), "invalid");
  assert.equal(transport.runtimeState(native, runtime, owner), "current");
  assert.equal(transport.runtimeState(native + "\n" + runtime, runtime, owner), "patched");
});

test("normal Omarchy descriptor atomically prepares all three surfaces and preserves another feature prefix", (t) => {
  const other = ';(()=>{globalThis.otherFeatureVersion="v1"})();\n';
  const { root } = appWorkspace(t, { "webview/assets/index.js": other + INDEX_ENTRY_FIXTURE, ".vite/build/early-bootstrap.js": other + 'require("electron");module.exports={};', ".vite/build/preload.js": other + NATIVE_PRELOAD_FIXTURE });
  assert.equal(normalDescriptor(root).status, "applied"); assert.equal(normalDescriptor(root).status, "already-applied");
  const main = fs.readFileSync(path.join(root, ".vite/build/early-bootstrap.js"), "utf8"), preload = fs.readFileSync(path.join(root, ".vite/build/preload.js"), "utf8"), renderer = fs.readFileSync(path.join(root, "webview/assets/index.js"), "utf8");
  assert.equal(transport.runtimeState(main, transport.mainRuntimeSource(), (source) => source.includes("require(")), "patched");
  assert.equal(transport.runtimeState(preload, transport.preloadRuntimeSource(), transport.isNativePreload), "patched");
  assert.equal(omarchyThemeState(renderer), "patched"); assert.ok(renderer.startsWith(other)); assert.ok(main.startsWith(other)); assert.ok(preload.startsWith(other));
  for (const source of [main, preload, renderer]) assert.equal(javascriptSourceParses(source), true);
});

for (const scenario of ["missing-preload", "ambiguous-preload", "wrong-main", "ambiguous-index", "detached-index", "mixed", "missing-focus", "nested-runtime", "bad-main-sender", "preload-path-argument", "erased-native-main-prefix"]) {
  test(`Omarchy rejects ${scenario} with every input byte preserved`, (t) => {
    const { root, files } = appWorkspace(t);
    if (scenario === "missing-preload") fs.writeFileSync(path.join(root, ".vite/build/preload.js"), "module.exports={}");
    if (scenario === "ambiguous-preload") fs.writeFileSync(path.join(root, ".vite/build/another.js"), NATIVE_PRELOAD_FIXTURE);
    if (scenario === "wrong-main") fs.writeFileSync(path.join(root, "package.json"), '{"main":"../outside.js"}');
    if (scenario === "ambiguous-index") fs.writeFileSync(path.join(root, "webview/index.html"), '<script src="./assets/index.js"></script><script src="./assets/index.js"></script>');
    if (scenario === "detached-index") fs.writeFileSync(path.join(root, "webview/assets/index.js"), DETACHED_ENTRY_FIXTURE);
    if (scenario === "mixed") fs.appendFileSync(path.join(root, ".vite/build/early-bootstrap.js"), "\n" + transport.mainRuntimeSource());
    if (scenario === "erased-native-main-prefix") {
      transport.applyOmarchyThemeToApp(root);
      fs.writeFileSync(path.join(root, ".vite/build/early-bootstrap.js"), transport.mainRuntimeSource());
    }
    if (scenario === "bad-main-sender" || scenario === "preload-path-argument") {
      transport.applyOmarchyThemeToApp(root);
      const name = scenario === "bad-main-sender" ? ".vite/build/early-bootstrap.js" : ".vite/build/preload.js";
      const file = path.join(root, name), source = fs.readFileSync(file, "utf8");
      fs.writeFileSync(file, scenario === "bad-main-sender" ? source.replace("origin.hostname", "origin.origin") : source.replace("readStylesheet:()=>ipcRenderer.invoke(CHANNEL)", "readStylesheet:(path)=>ipcRenderer.invoke(CHANNEL,path)"));
    }
    if (scenario === "missing-focus" || scenario === "nested-runtime") {
      transport.applyOmarchyThemeToApp(root);
      const file = path.join(root, "webview/assets/index.js"), source = fs.readFileSync(file, "utf8");
      fs.writeFileSync(file, scenario === "missing-focus" ? source.replace('window.addEventListener(`focus`,refresh);', "") : source.replace(omarchyThemeRuntimeSource(), `function unused(){${omarchyThemeRuntimeSource()}}`));
    }
    const before = new Map(Object.keys(files).map((name) => [name, fs.readFileSync(path.join(root, name))]));
    assert.equal(normalDescriptor(root).status, "skipped-optional");
    for (const [name, bytes] of before) assert.deepEqual(fs.readFileSync(path.join(root, name)), bytes);
  });
}

test("Omarchy three-surface transaction restores a partial second write", (t) => {
  const { root, files } = appWorkspace(t); let failed = false;
  assert.throws(() => transport.applyOmarchyThemeToApp(root, { writeFileSync(file, data) {
    if (!failed && file.endsWith("preload.js")) { failed = true; fs.writeFileSync(file, data.subarray(0, 11)); throw Error("injected partial write"); }
    fs.writeFileSync(file, data);
  } }), /injected partial write/);
  for (const [name, source] of Object.entries(files)) assert.equal(fs.readFileSync(path.join(root, name), "utf8"), source);
});

test("canonical Omarchy runtimes reject removed lifecycle steps, wrong scopes and duplicate markers", () => {
  const runtime = omarchyThemeRuntimeSource();
  for (const appended of [runtime.replace('window.addEventListener(`focus`,refresh);', ""), runtime.replace("setInterval(refresh,5000)", "setInterval(refresh,50000)"), `function unused(){${runtime}}`, `/*${runtime}*/`, runtime + runtime, 'globalThis.codexLinuxOmarchyThemeVersion="partial"']) {
    const source = INDEX_ENTRY_FIXTURE + "\n" + appended;
    assert.equal(javascriptSourceParses(source), true);
    assert.equal(omarchyThemeState(source), "invalid");
    const result = captureWarnings(() => applyOmarchyThemeLoader(source)); assert.equal(result.value, source); assert.equal(result.warnings.length, 1);
  }
  assert.equal(omarchyThemeState(DETACHED_ENTRY_FIXTURE + "\n" + runtime), "invalid");
});

test("signed native main/preload/root contracts patch twice and deliver CSS through the registered bridge without renderer process", {
  skip: !process.env.CODEX_SIGNED_EXTRACTED_APP,
}, async (t) => {
  const app = process.env.CODEX_SIGNED_EXTRACTED_APP;
  const names = findWebviewAssetsContaining(app, INDEX_ENTRY_NEEDLES).filter((name) => isWebviewIndexEntry(fs.readFileSync(path.join(app, "webview/assets", name), "utf8"), name));
  assert.equal(names.length, 1);
  const manifest = fs.readFileSync(path.join(app, "package.json"), "utf8"), mainName = JSON.parse(manifest).main.replace(/^\.\//u, "");
  const preload = fs.readFileSync(path.join(app, ".vite/build/preload.js"), "utf8"), html = fs.readFileSync(path.join(app, "webview/index.html"), "utf8");
  assert.ok(html.includes("style-src 'self' 'unsafe-inline'"));
  assert.equal(preload.includes("process.env"), false);
  const original = { "package.json": manifest, [mainName]: fs.readFileSync(path.join(app, mainName), "utf8"), ".vite/build/preload.js": preload, "webview/index.html": html, [`webview/assets/${names[0]}`]: fs.readFileSync(path.join(app, "webview/assets", names[0]), "utf8") };
  const root = testDirectory(t);
  for (const [name, source] of Object.entries(original)) { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, source); }
  // Keep the native HTML's vendor script references present as well as its
  // selected root entry; production receives the complete extracted bundle.
  for (const name of fs.readdirSync(path.join(app, "webview/assets")).filter((name) => name.endsWith(".js"))) {
    fs.copyFileSync(path.join(app, "webview/assets", name), path.join(root, "webview/assets", name));
  }
  assert.equal(normalDescriptor(root).status, "applied"); assert.equal(normalDescriptor(root).status, "already-applied");
  assert.equal(fs.readFileSync(path.join(root, "webview/index.html"), "utf8"), html);
  for (const name of [mainName, ".vite/build/preload.js", `webview/assets/${names[0]}`]) assert.equal(javascriptSourceParses(fs.readFileSync(path.join(root, name), "utf8")), true);
  const registered = nativeTransport(t, { preloadSource: preload });
  assert.ok(registered.exposed.has("electronBridge")); assert.ok(registered.exposed.has(transport.BRIDGE));
  assert.equal(vm.runInContext("typeof process.env", registered.preload), "undefined");
  fs.writeFileSync(registered.stylesheet, ":root{--accent:violet}");
  const renderer = rendererHarness(registered.bridge); renderer.load(); await registered.drain();
  assert.equal(vm.runInContext("typeof process", renderer.context), "undefined"); assert.equal(renderer.style(), ":root{--accent:violet}");
  const rendererFile = path.join(root, "webview/assets", names[0]);
  const damaged = fs.readFileSync(rendererFile, "utf8").replace('window.addEventListener(`focus`,refresh);', ""); fs.writeFileSync(rendererFile, damaged);
  assert.equal(normalDescriptor(root).status, "skipped-optional"); assert.equal(fs.readFileSync(rendererFile, "utf8"), damaged);
});
