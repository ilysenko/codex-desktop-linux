"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { findMatchingBrace, escapeRegExp, createJavaScriptLexicalIndex } = require("../../../scripts/patches/lib/minified-js.js");
const { registrationContract } = require("../../../scripts/patches/lib/global-shortcuts-portal.js");
const { mainProcessFactories } = require("../../../scripts/patches/lib/main-process-factories.js");
const { applyLinuxGlobalDictationMainProcessPatch } = require("../patch.js");

const IDENTIFIER = "[A-Za-z_$][\\w$]*";
const cachedSources = new Map();
const transformedMains = new Map();
const productionEntryCalls = new Map();
const plain = value => JSON.parse(JSON.stringify(value));
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const sdkRoot = path.resolve(__dirname, "../../..");

function moduleFiles(id, seen = new Set()) {
  if (seen.has(id)) return seen;
  const loaded = require.cache[id];
  if (!loaded || !id.startsWith(sdkRoot + path.sep)) return seen;
  seen.add(id);
  for (const child of loaded.children) moduleFiles(child.id, seen);
  return seen;
}
const loadedSdkFiles = [...new Set([
  ...moduleFiles(require.resolve("../patch.js")),
  ...moduleFiles(require.resolve("../../../scripts/patches/lib/main-process-factories.js")),
  __filename, path.resolve(__dirname, "../native-main.test.js"),
])].sort().map(file => ({ file, sha256: digest(fs.readFileSync(file)), mode: fs.statSync(file).mode & 0o777 }));
const sdkTreeSha256 = digest(JSON.stringify(loadedSdkFiles));

function cacheIdentity(extractedRoot) {
  for (const row of loadedSdkFiles) {
    assert.equal(digest(fs.readFileSync(row.file)), row.sha256, "native fixture SDK changed during the test process");
    assert.equal(fs.statSync(row.file).mode & 0o777, row.mode);
  }
  const directory = path.join(extractedRoot, ".vite/build");
  const inputs = fs.readdirSync(directory).filter(name => /^early-bootstrap.*\.js$/u.test(name)).sort()
    .map(name => {
      const file = path.join(directory, name), stat = fs.lstatSync(file);
      assert.ok(stat.isFile() && !stat.isSymbolicLink(), "native fixture inputs are regular files");
      return { name, sha256: digest(fs.readFileSync(file)), mode: stat.mode & 0o777 };
    });
  assert.equal(inputs.length, 19);
  return { key: digest(JSON.stringify({ nodeVersion: process.version, sdkTreeSha256, inputs })), inputs };
}

function unique(values, description) {
  assert.equal(values.length, 1, description);
  return values[0];
}

function functionSource(source, name) {
  const head = unique([...source.matchAll(new RegExp(`(?<![\\w$])(?:async )?function ${escapeRegExp(name)}\\(`, "gu"))], name);
  const open = source.indexOf("{", head.index), close = findMatchingBrace(source, open);
  assert.ok(close > open, name);
  return source.slice(head.index, close + 1);
}

function classSource(source, marker) {
  const at = source.indexOf(marker);
  assert.ok(at >= 0, marker);
  assert.equal(source.indexOf(marker, at + marker.length), -1, `${marker} is unique`);
  const head = [...source.slice(0, at).matchAll(/\bclass ([A-Za-z_$][\w$]*)\{/gu)].at(-1);
  assert.ok(head, marker);
  const open = head.index + head[0].length - 1, close = findMatchingBrace(source, open);
  assert.ok(open < at && at < close, marker);
  return { name: head[1], start: head.index, end: close + 1, text: source.slice(head.index, close + 1) };
}

function methodSource(classText, name) {
  const body = classText.slice(classText.indexOf("{") + 1, -1);
  const heads = [...body.matchAll(new RegExp(`(?<![\\w$.])(?:async )?${escapeRegExp(name)}\\([^)]*\\)\\{`, "gu"))]
    .filter(head => findMatchingBrace("{" + body.slice(0, head.index) + "}", 0) === head.index + 1);
  const head = unique(heads, `native ${name}`), open = head.index + head[0].length - 1;
  return body.slice(head.index, findMatchingBrace(body, open) + 1);
}

function anonymousSource(source, parameterCount, needle) {
  const lexical = createJavaScriptLexicalIndex(source);
  const heads = [...source.matchAll(/async function\(([^()]*)\)\{/gu)].filter(head =>
    lexical.isCode(head.index) && head[1].split(",").length === parameterCount);
  const functions = heads.map(head => {
    const open = head.index + head[0].length - 1, close = findMatchingBrace(source, open);
    assert.ok(close > open, "complete anonymous native function");
    return { start: head.index, end: close + 1, text: source.slice(head.index, close + 1), parameters: head[1].split(",") };
  });
  return unique(functions.filter(fn => fn.start > 0 && (!needle || fn.text.includes(needle))), "native anonymous " + parameterCount + "-argument function");
}

function nativeSources(extractedRoot) {
  const identity = cacheIdentity(extractedRoot), cached = cachedSources.get(extractedRoot);
  if (cached) {
    assert.equal(identity.key, cached.key, "native fixture input changed during the test process");
    cached.value.cache.reuseCalls++;
    return cached.value;
  }
  const directory = path.join(extractedRoot, ".vite/build");
  const main = unique(fs.readdirSync(directory).filter(name => /^early-bootstrap.*\.js$/u.test(name))
    .map(name => ({ name, text: fs.readFileSync(path.join(directory, name), "utf8") }))
    .filter(file => file.text.includes("shortcutGestures=new ") && file.text.includes("registeredToggleHotkeyRegistration=null")), "native dictation main chunk");
  const originalController = classSource(main.text, "shortcutGestures=new ");
  let transformed = transformedMains.get(extractedRoot);
  if (transformed) assert.equal(transformed.key, identity.key, "a changed source cannot reuse a transform or its failure");
  else {
    const started = Date.now();
    productionEntryCalls.set(extractedRoot, (productionEntryCalls.get(extractedRoot) ?? 0) + 1);
    transformed = { key: identity.key };
    try { transformed.output = applyLinuxGlobalDictationMainProcessPatch(main.text); }
    catch (error) { transformed.error = error; }
    transformed.elapsedMs = Date.now() - started;
    transformedMains.set(extractedRoot, transformed);
  }
  if (transformed.error) throw transformed.error;
  const patched = transformed.output, transformElapsedMs = transformed.elapsedMs;
  assert.notEqual(patched, main.text, "production transform patches the signed main owner");
  const controller = classSource(patched, "shortcutGestures=new ");
  const originalFactory = unique(mainProcessFactories(main.text).filter(factory =>
    factory.start <= originalController.start && originalController.end <= factory.end), "native controller factory");
  const patchedFactory = unique(mainProcessFactories(patched).filter(factory =>
    factory.start <= controller.start && controller.end <= factory.end), "patched controller factory");
  assert.equal(patchedFactory.identity, originalFactory.identity);
  assert.equal(methodSource(controller.text, "updateEscapeRegistration"), methodSource(originalController.text, "updateEscapeRegistration"), "native Escape method is byte-identical");
  const gestureImport = new RegExp(`shortcutGestures=new (${IDENTIFIER})\\.(${IDENTIFIER})\\(`, "u").exec(controller.text);
  const moduleImport = unique([...main.text.matchAll(new RegExp(`(?<![\\w$.])${gestureImport[1]}=${IDENTIFIER}\\((\\d+)\\)`, "gu"))], "gesture import");
  const entry = fs.readFileSync(path.join(directory, "early-bootstrap.js"), "utf8");
  const factoryHead = unique([...entry.matchAll(new RegExp(`(?:^|[{,])${moduleImport[1]}\\(${IDENTIFIER},${IDENTIFIER},${IDENTIFIER}\\)\\{`, "gu"))], "gesture factory");
  const factoryOpen = factoryHead.index + factoryHead[0].length - 1, factoryClose = findMatchingBrace(entry, factoryOpen);
  const factory = entry.slice(factoryOpen + 1, factoryClose);
  const gesture = classSource(factory, "callbacks;primaryPressedAtMs;");
  assert.match(factory, new RegExp(`${escapeRegExp(gestureImport[2])}:\\(\\)=>${escapeRegExp(gesture.name)}(?=[,}])`, "u"), "actual module export resolves to the gesture class");
  const registration = registrationContract(patched);
  const registry = /if\(\[\.\.\.([\w$]+)\]\.some/u.exec(registration.body)[1];
  const activation = /generation:0,registered:!1\},[\w$]+=([\w$]+)\(/u.exec(registration.body)[1];
  const registrationLogger = /([\w$]+)\(\)\.debug\("global_hotkey_pressed"/u.exec(registration.body)[1];
  const electron = /([\w$]+)\.globalShortcut\.unregister\(/u.exec(registration.body)[1];
  const sharedStart = patched.indexOf("var codexLinuxGlobalShortcutsPatch=");
  const tail = functionSource(patched, "codexLinuxGlobalShortcutsActivate");
  const sharedEnd = patched.indexOf(tail, sharedStart) + tail.length;
  const shared = patched.slice(sharedStart, sharedEnd);
  const access = /function codexLinuxGlobalShortcutsAccessReady\(\)\{return"ready"===([\w$]+)\(\)\.status\}/u.exec(shared)[1];
  const depth = /function codexLinuxGlobalShortcutsIsSuspended\(\)\{return ([\w$]+)>0\}/u.exec(shared)[1];
  const constructor = methodSource(controller.text, "constructor");
  const capability = /!([\w$]+)\(\)\)return;/u.exec(constructor)[1];
  const keymap = /([\w$]+)\("globalDictationHold"\)/u.exec(constructor)[1];
  const chooseHotkey = /this\.configuredHotkey=([\w$]+)\(/u.exec(constructor)[1];
  const validateHotkey = /null==([\w$]+)\(t\)\?t:null/u.exec(constructor)[1];
  const windowConstructor = /this\.windowController=new ([\w$]+)\(/u.exec(constructor)[1];
  const recoveryConstructor = /this\.hotkeyController\.recovery=new ([\w$]+)\(/u.exec(constructor)[1];
  const watcherName = /this\.activeHotkeyReleaseWatcher=([\w$]+)\(/u.exec(methodSource(controller.text, "ensureHotkeyReleaseWatchers"))[1];
  const bareGesture = /shortcutGestures\.press\("primary",([\w$]+)\(e\)/u.exec(controller.text)[1];
  const clipboard = /this\.clipboardFingerprintAtStop\?\?([\w$]+)\(\)/u.exec(methodSource(controller.text, "stopRecording"))[1];
  const random = /\(0,([\w$]+)\.randomUUID\)\(\)/u.exec(controller.text)[1];
  const logger = /\(0,([\w$]+)\.[\w$]+\)\(\)\.warning/u.exec(controller.text)[1];
  const keyCompare = /\(0,([\w$]+)\.([\w$]+)\)\(this\.configuredHotkey/u.exec(controller.text);
  const messageMap = /if\(!\(t\.type in ([\w$]+)\)\)/u.exec(methodSource(controller.text, "handleMessage"))[1];
  const originalTranscript = methodSource(originalController.text, "handleTranscript");
  const transcript = methodSource(controller.text, "handleTranscript");
  const originalClipboard = anonymousSource(originalTranscript, 4);
  const clipboardBridge = anonymousSource(transcript, 4);
  const originalPaste = anonymousSource(originalClipboard.text, 1, "Global dictation paste is not supported on this OS.");
  const paste = anonymousSource(clipboardBridge.text, 1, "Global dictation paste is not supported on this OS.");
  const originalAccessibility = anonymousSource(originalPaste.text, 1, "AXUIElementPerformAction");
  const accessibility = anonymousSource(paste.text, 1, "AXUIElementPerformAction");
  assert.equal(accessibility.text, originalAccessibility.text, "complete opaque native Mac accessibility body is preserved");
  const linuxPaste = 'if("linux"===process.platform){if(codexLinuxGlobalShortcutsUsesWayland()){await codexLinuxGlobalShortcutsPaste(' +
    paste.parameters[0] + ');return}await codexLinuxGlobalDictationPasteX11(' + paste.parameters[0] + ');return}';
  assert.equal(paste.text.split(linuxPaste).length - 1, 1, "one signal-bearing Linux paste seam");
  assert.equal(paste.text.replace(linuxPaste, ""), originalPaste.text, "every other native paste-platform byte is preserved");
  assert.equal(clipboardBridge.text.replace(paste.text, originalPaste.text), originalClipboard.text, "complete four-argument native clipboard body is preserved");
  assert.equal(transcript.slice(0, clipboardBridge.start), originalTranscript.slice(0, originalClipboard.start) + "codexLinuxGlobalDictationClipboard(this,");
  assert.equal(transcript.slice(clipboardBridge.end), "," + originalTranscript.slice(originalClipboard.end + 1), "native argument expressions and completion guards are preserved");
  const timer = /\(0,([\w$]+)\.setTimeout\)\(Math\.max\(0,150-/u.exec(clipboardBridge.text)[1];
  const restore = /\(\)===([\w$]+)&&([\w$]+)\(([\w$]+),([\w$]+)\)/u.exec(clipboardBridge.text)[2];
  const fingerprintSource = functionSource(patched, clipboard);
  const restoreSource = functionSource(patched, restore);
  assert.equal(fingerprintSource, functionSource(main.text, clipboard));
  assert.equal(restoreSource, functionSource(main.text, restore));
  const hashImport = /\(0,([\w$]+)\.createHash\)/u.exec(fingerprintSource)[1];
  const platformExec = /await ([\w$]+)\("\/usr\/bin\/osascript"/u.exec(paste.text)[1];
  const record = methodSource(controller.text, "recordHistoryText");
  const historyRead = /\.\.\.([\w$]+)\(\)\.filter/u.exec(record)[1];
  const historyWrite = /\?\(([\w$]+)\(\[/u.exec(record)[1];
  const controllerBody = controller.text.slice(controller.text.indexOf("{") + 1, -1);
  const lexical = createJavaScriptLexicalIndex(controllerBody);
  const methodCount = [...controllerBody.matchAll(/(?<![\w$.])(?:async )?[A-Za-z_$][\w$]*\([^)]*\)\{/gu)]
    .filter(head => lexical.isRoot(head.index)).length;
  const originalBody = originalController.text.slice(originalController.text.indexOf("{") + 1, -1);
  const originalLexical = createJavaScriptLexicalIndex(originalBody);
  const originalMethodNames = [...originalBody.matchAll(/(?<![\w$.])(?:async )?([A-Za-z_$][\w$]*)\([^)]*\)\{/gu)]
    .filter(head => originalLexical.isRoot(head.index)).map(head => head[1]);
  const originalMethodCount = originalMethodNames.length;
  const sourceFacts = {
    rangeUnit: "UTF-16 code units",
    ownerId: originalFactory.identity,
    mainBytes: Buffer.byteLength(main.text), mainUtf16Length: main.text.length,
    controllerBytes: Buffer.byteLength(originalController.text), controllerUtf16Length: originalController.text.length,
    methodInventoryScope: "complete original class; sealed method excerpts are a selected list",
  };
  const result = { originalController, controller, gesture, registration, registry, activation, registrationLogger, electron, shared, access, depth,
    gestureImport, capability, keymap, chooseHotkey, validateHotkey, windowConstructor, watcherName, bareGesture, clipboard, random, logger, keyCompare, messageMap,
    originalClipboard, clipboardBridge, originalPaste, paste, originalAccessibility, accessibility, timer, restore, hashImport,
    fingerprintSource, restoreSource, platformExec, historyRead, historyWrite, methodCount, originalMethodCount, originalMethodNames, recoveryConstructor, sourceFacts,
    functions: [functionSource(patched, activation), functionSource(patched, capability), functionSource(patched, watcherName),
      functionSource(patched, "codexLinuxGlobalDictationReleaseWatcher"), functionSource(patched, "codexLinuxGlobalDictationPasteX11"),
      "var codexLinuxGlobalDictationClipboardQueues=new WeakMap;",
      functionSource(patched, "codexLinuxGlobalDictationClipboard"), fingerprintSource, restoreSource] };
  assert.equal(cacheIdentity(extractedRoot).key, identity.key, "native source qualification retains the same SDK and inputs");
  result.cache = {
    key: identity.key, nodeVersion: process.version, sdkTreeSha256, sdkFiles: loadedSdkFiles.length,
    inputFiles: identity.inputs.length, inputMainSha256: digest(main.text), outputMainSha256: digest(patched),
    productionEntryCalls: productionEntryCalls.get(extractedRoot), reuseCalls: 0, transformElapsedMs,
    ownerId: originalFactory.identity,
    guardScope: "loaded transitive SDK modules, both test files and all nineteen main inputs",
  };
  cachedSources.set(extractedRoot, { key: identity.key, value: result });
  return result;
}

function nativeSourceCacheStats(extractedRoot) {
  const cached = cachedSources.get(extractedRoot);
  return cached ? { ...cached.value.cache } : null;
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

class Clock {
  now = 1000;
  timers = new Map();
  nextId = 0;
  setTimeout = (callback, delay = 0) => {
    const timer = { id: ++this.nextId, at: this.now + delay, callback, unref() {} };
    this.timers.set(timer.id, timer);
    return timer;
  };
  clearTimeout = timer => { this.timers.delete(timer?.id); };
  async advance(milliseconds) {
    const target = this.now + milliseconds;
    for (;;) {
      const next = [...this.timers.values()].filter(timer => timer.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      this.now = next.at; this.timers.delete(next.id); next.callback();
      await settle();
    }
    this.now = target; await settle();
  }
}

async function settle() {
  await new Promise(setImmediate);
  await new Promise(setImmediate);
}

function createClipboard(events, clock) {
  const image = bytes => ({ toPNG: () => Buffer.from(bytes), isEmpty: () => bytes.length === 0 });
  let data = { text: "original text", html: "<p>original html</p>", rtf: "{\\rtf1 original}", image: image(Buffer.from([0, 255, 8, 9])), bookmark: "original bookmark" };
  const standardFormats = value => new Map([
    ["text/plain", Buffer.from(value.text)], ["text/html", Buffer.from(value.html)], ["text/rtf", Buffer.from(value.rtf)],
    ["image/png", value.image.toPNG()], ["application/x-bookmark", Buffer.from(value.bookmark)],
  ]);
  let formats = standardFormats(data);
  formats.set("application/x-private", Buffer.from([0, 255, 127, 5]));
  formats.set("application/x-empty", Buffer.alloc(0));
  function snapshot() {
    return { data: { text: data.text, html: data.html, rtf: data.rtf, image: data.image.toPNG().toString("hex"), bookmark: data.bookmark },
      formats: [...formats].map(([format, bytes]) => ({ format, hex: bytes.toString("hex") })).sort((left, right) => left.format.localeCompare(right.format)) };
  }
  return {
    readText: () => data.text,
    readHTML() { events.push({ type: "clipboard.snapshot", at: clock.now, snapshot: snapshot() }); return data.html; },
    readRTF: () => data.rtf, readImage: () => data.image, readBookmark: () => ({ title: data.bookmark, url: "inert://bookmark" }),
    availableFormats: () => [...formats.keys()], readBuffer: format => Buffer.from(formats.get(format) ?? []),
    writeText(text) {
      events.push({ type: "clipboard.writeText", at: clock.now, text });
      data = { text, html: "", rtf: "", image: image(Buffer.alloc(0)), bookmark: "" };
      formats = new Map([["text/plain", Buffer.from(text)]]);
    },
    write(value) {
      data = { ...value }; formats = standardFormats(data);
      events.push({ type: "clipboard.restore", at: clock.now, data: snapshot().data });
    },
    writeBuffer(format, bytes) {
      formats.set(format, Buffer.from(bytes));
      events.push({ type: "clipboard.writeBuffer", at: clock.now, format, hex: bytes.toString("hex") });
    },
    snapshot,
    userChange(text) {
      data = { text, html: "", rtf: "", image: image(Buffer.alloc(0)), bookmark: "" };
      formats = new Map([["text/plain", Buffer.from(text)], ["application/x-user", Buffer.from([4, 3, 2, 1])]]);
      events.push({ type: "clipboard.userChange", at: clock.now, snapshot: snapshot() });
    },
  };
}

function createNativeRuntime(extractedRoot, { sessionType = "wayland", platform = "linux", trustedAccessibility = true } = {}) {
  const native = nativeSources(extractedRoot), clock = new Clock(), events = [], warnings = [], checks = [], children = [], accelerators = new Map();
  let nextSession = 0, nextShow = null, nextFailure = null, nextExec = null, checkFailure = null, visiblePet = null, inAppWindow = null;
  let history = [];
  const pendingShows = [], pendingFailures = [], pendingExecs = [], transcriptTasks = [];
  const clipboard = createClipboard(events, clock);
  const window = {
    getFocusedInAppWindow: () => inAppWindow,
    close: () => events.push({ type: "window.close" }),
    hide: () => events.push({ type: "window.hide" }),
    prewarm() {},
    async showAndStart(id, gesture, current, pendingConfirmation, timing) {
      events.push({ type: "window.start", id, gesture, pendingConfirmation, timing: plain(timing) });
      const held = nextShow; nextShow = null;
      if (held) { pendingShows.push(held); return held.promise; }
      return true;
    },
    confirmStart: id => events.push({ type: "window.confirm", id }),
    sendStop: (id, cancel) => events.push({ type: "window.stop", id, cancel }),
    async showPasteFailure(failure, isCurrent) {
      events.push({ type: "window.pasteFailure", failure: plain(failure), isCurrent, at: clock.now });
      const held = nextFailure; nextFailure = null;
      if (held) { pendingFailures.push(held); await held.promise; }
    },
  };
  const electron = { app: new EventEmitter(), clipboard, systemPreferences: { isTrustedAccessibilityClient: () => trustedAccessibility }, globalShortcut: {
    register(key, callback) { accelerators.set(key, callback); return sessionType === "x11" || key === "Escape"; },
    unregister(key) { accelerators.delete(key); },
  } };
  electron.app.getAppPath = () => null;
  function childFor(file, args) {
    const child = new EventEmitter(); child.pid = 100 + children.length;
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.args = Array.from(args); child.file = file; child.signals = [];
    child.autoExit = true;
    child.once("exit", () => { child.exited = true; });
    child.exit = (code = 0) => { if (!child.exited) child.emit("exit", code); };
    child.stdin = { write(data, callback) { events.push({ type: "helper.stdin", data, child, at: clock.now }); child.onWrite?.(data); callback?.(); return true; } };
    child.kill = signal => {
      child.signals.push(signal ?? "default");
      events.push({ type: "helper.signal", signal, child, at: clock.now });
      if (child.autoExit) queueMicrotask(() => child.exit());
      return true;
    };
    child.ready = () => { const count = args[0] === "portal" ? (args.length - 1) / 4 : 0; child.stdout.emit("data", Buffer.from(["bindings", ...Array.from({ length: count }, (_, i) => `bound:${i}:Fixture binding`), "ready", ""].join("\n"))); };
    child.down = (index = 0) => child.stdout.emit("data", Buffer.from(`down:${index}\n`));
    child.up = (index = 0) => child.stdout.emit("data", Buffer.from(`up:${index}\n`));
    child.pasteOk = () => child.stdout.emit("data", Buffer.from("paste-ok\n"));
    child.pasteError = message => child.stdout.emit("data", Buffer.from("paste-error:" + message + "\n"));
    child.commit = () => events.push({ type: "helper.commit", child, at: clock.now });
    children.push(child); return child;
  }
  const context = {
    Buffer, Symbol, AbortController, console: { warn: (...args) => warnings.push(args) },
    process: { platform, env: { XDG_SESSION_TYPE: sessionType }, resourcesPath: "/inert/resources" },
    Date: { now: () => clock.now }, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    require(id) {
      if (id === "node:fs") return { accessSync() {}, constants: { X_OK: 1 } };
      if (id === "node:path") return path;
      if (id === "electron") return electron;
      if (id === "node:child_process") return {
        spawn: childFor,
        execFileSync(file, args) { checks.push({ file, args: Array.from(args) }); if (checkFailure) throw checkFailure; return args.at(-1).toUpperCase() + "\n"; },
        execFile(file, args, options, callback) {
          events.push({ type: "execFile", file, args: Array.from(args), options, at: clock.now });
          const held = nextExec; nextExec = null;
          if (held) { pendingExecs.push(held); held.promise.then(() => callback(null)); } else callback(null);
        },
      };
      throw Error(`Unexpected native collaborator import ${id}`);
    },
  };
  context[native.registry] = new Set(); context[native.depth] = 0;
  context[native.access] = () => ({ status: "ready" });
  context[native.registrationLogger] = () => ({ debug() {} });
  context[native.bareGesture] = () => false;
  context[native.electron] = electron; context[native.registration.bareModifier] = () => false; context[native.registration.special] = () => false;
  context[native.windowConstructor] = class { constructor() { return window; } };
  context[native.recoveryConstructor] = class { dispose() {} };
  context[native.keymap] = () => ({ hasBinding: false }); context[native.chooseHotkey] = value => value.legacyHotkey; context[native.validateHotkey] = () => null;
  context[native.hashImport] = { createHash: require("node:crypto").createHash };
  context[native.timer] = { setTimeout(delay) {
    events.push({ type: "native.wait", delay, at: clock.now, text: clipboard.readText() });
    return new Promise(resolve => clock.setTimeout(resolve, delay));
  } };
  context[native.historyRead] = () => history;
  context[native.historyWrite] = value => { history = plain(value); events.push({ type: "history", history }); };
  context[native.platformExec] = (file, args, options) => {
    events.push({ type: "platform.exec", file, args: Array.from(args), options, at: clock.now });
    const held = nextExec; nextExec = null;
    if (held) pendingExecs.push(held);
    return held?.promise ?? Promise.resolve();
  };
  Object.assign(context[native.random] ??= {}, { randomUUID: () => `native-session-${++nextSession}` });
  Object.assign(context[native.logger] ??= {}, { tZQ: () => ({ warning: (...args) => warnings.push(args) }) });
  Object.assign(context[native.keyCompare[1]] ??= {}, { [native.keyCompare[2]]: value => value });
  context[native.messageMap] = Object.fromEntries(["global-dictation-dismiss", "global-dictation-recording-stopped", "global-dictation-failed", "global-dictation-close"].map(type => [type, true]));
  Object.assign(context[native.gestureImport[1]] ??= {}, { Q2Y: { GLOBAL_DICTATION_FORCE_LOCK_DEBUG_ENABLED: "inert-debug" } });
  const script = `${native.gesture.text};globalThis.NativeGesture=${native.gesture.name};`;
  vm.runInNewContext(script, context);
  context[native.gestureImport[1]][native.gestureImport[2]] = context.NativeGesture;
  vm.runInNewContext([native.shared, native.registration.body, ...native.functions, native.controller.text,
    `globalThis.NativeController=${native.controller.name};`].join("\n"), context);
  const messages = [];
  const controller = new context.NativeController({ canForceGlobalDictationLock: false, globalState: { get() {}, set() {} },
    getVisibleNativePetWebContents: () => visiblePet,
    windowManager: { sendMessageToWebContents: (view, message) => messages.push({ view, message }), sendMessageToWebContentsId: (id, message) => messages.push({ id, message }) } });
  const lock = { owned: true, isOwner() { return this.owned; }, dispose() { events.push({ type: "lock.dispose" }); } };
  controller.lifecycleLock = lock; controller.isGateEnabled = true; events.length = 0;
  function entry(kind) { return [...context[native.registry]].find(value => value.linuxCommandId === kind); }
  async function bind({ hold = true, toggle = false } = {}) {
    if (hold) controller.registerHotkeyOrThrow("Ctrl+Alt+D", lock);
    if (toggle) controller.registerToggleHotkeyOrThrow("Ctrl+Alt+T", lock);
    await settle();
    if (sessionType === "wayland") {
      for (const child of children.filter(value => value.args[0] === "portal" && !value.signals.length)) child.ready();
      await context.codexLinuxGlobalShortcutsPortalQueue;
    }
  }
  return { native, context, controller, window, clock, events, warnings, checks, children, messages, accelerators, lock, bind, settle, entry, clipboard,
    fingerprint: () => context[native.clipboard](),
    history: () => plain(history),
    transcript(id, text, { type = "overlay", stoppedAt = clock.now, fingerprint = context[native.clipboard]() } = {}) {
      controller.activeSession = { id, type, recordingStoppedAtMs: stoppedAt };
      controller.clipboardFingerprintAtStop = fingerprint;
      const promise = controller.handleTranscript(id, text), abort = controller.pendingPasteAbort;
      transcriptTasks.push(promise); promise.catch(() => {});
      return { id, promise, abort, signal: abort?.signal, stoppedAt, fingerprint };
    },
    async readyPortals() {
      for (const child of children.filter(child => child.args[0] === "portal" && !child.signals.length && !child.exited)) child.ready();
      await context.codexLinuxGlobalShortcutsPortalQueue;
    },
    deferNextPasteFailure() { const held = deferred(); nextFailure = held; return held; },
    deferNextExec() { const held = deferred(); nextExec = held; return held; },
    setVisiblePet(pet) { visiblePet = pet; },
    setInAppWindow(value) { inAppWindow = value; },
    holdChild: () => children.find(child => child.args[0] === "portal" && !child.signals.length),
    setCheckFailure(error) { checkFailure = error; },
    deferNextShow() { const held = deferred(); nextShow = held; return held; },
    cancelPrimary() { entry("globalDictationHold").onCancelled(); },
    async cleanup() {
      for (const held of pendingShows) held.resolve(false);
      for (const held of pendingFailures) held.resolve();
      for (const held of pendingExecs) held.resolve();
      controller.dispose();
      await settle();
      const stopped = context.codexLinuxGlobalShortcutsPortalShutdown();
      for (const child of children) child.exit();
      await clock.advance(5000);
      await settle(); if (stopped) await stopped;
      await context.codexLinuxGlobalShortcutsPortalQueue;
      await Promise.allSettled(transcriptTasks);
      clock.timers.clear();
    },
  };
}

module.exports = { createNativeRuntime, nativeSources, methodSource, nativeSourceCacheStats, settle, plain };
