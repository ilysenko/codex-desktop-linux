"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { findMatchingBrace, escapeRegExp } = require("../../../scripts/patches/lib/minified-js.js");
const { registrationContract } = require("../../../scripts/patches/lib/global-shortcuts-portal.js");
const { applyLinuxGlobalDictationMainProcessPatch } = require("../patch.js");

const IDENTIFIER = "[A-Za-z_$][\\w$]*";
const cachedSources = new Map();
const plain = value => JSON.parse(JSON.stringify(value));

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
  return { name: head[1], text: source.slice(head.index, close + 1) };
}

function methodSource(classText, name) {
  const body = classText.slice(classText.indexOf("{") + 1, -1);
  const heads = [...body.matchAll(new RegExp(`(?<![\\w$.])(?:async )?${escapeRegExp(name)}\\([^)]*\\)\\{`, "gu"))]
    .filter(head => findMatchingBrace("{" + body.slice(0, head.index) + "}", 0) === head.index + 1);
  const head = unique(heads, `native ${name}`), open = head.index + head[0].length - 1;
  return body.slice(head.index, findMatchingBrace(body, open) + 1);
}

function nativeSources(extractedRoot) {
  if (cachedSources.has(extractedRoot)) return cachedSources.get(extractedRoot);
  const directory = path.join(extractedRoot, ".vite/build");
  const main = unique(fs.readdirSync(directory).filter(name => /^early-bootstrap.*\.js$/u.test(name))
    .map(name => ({ name, text: fs.readFileSync(path.join(directory, name), "utf8") }))
    .filter(file => file.text.includes("shortcutGestures=new ") && file.text.includes("registeredToggleHotkeyRegistration=null")), "native dictation main chunk");
  const originalController = classSource(main.text, "shortcutGestures=new ");
  const patched = applyLinuxGlobalDictationMainProcessPatch(main.text);
  assert.notEqual(patched, main.text, "production transform patches the signed main owner");
  const controller = classSource(patched, "shortcutGestures=new ");
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
  const watcherName = /this\.activeHotkeyReleaseWatcher=([\w$]+)\(/u.exec(methodSource(controller.text, "ensureHotkeyReleaseWatchers"))[1];
  const bareGesture = /shortcutGestures\.press\("primary",([\w$]+)\(e\)/u.exec(controller.text)[1];
  const clipboard = /this\.clipboardFingerprintAtStop\?\?([\w$]+)\(\)/u.exec(methodSource(controller.text, "stopRecording"))[1];
  const random = /\(0,([\w$]+)\.randomUUID\)\(\)/u.exec(controller.text)[1];
  const logger = /\(0,([\w$]+)\.[\w$]+\)\(\)\.warning/u.exec(controller.text)[1];
  const keyCompare = /\(0,([\w$]+)\.([\w$]+)\)\(this\.configuredHotkey/u.exec(controller.text);
  const messageMap = /if\(!\(t\.type in ([\w$]+)\)\)/u.exec(methodSource(controller.text, "handleMessage"))[1];
  const result = { originalController, controller, gesture, registration, registry, activation, registrationLogger, electron, shared, access, depth,
    gestureImport, capability, keymap, chooseHotkey, validateHotkey, windowConstructor, watcherName, bareGesture, clipboard, random, logger, keyCompare, messageMap,
    functions: [functionSource(patched, activation), functionSource(patched, capability), functionSource(patched, watcherName),
      functionSource(patched, "codexLinuxGlobalDictationReleaseWatcher"), functionSource(patched, "codexLinuxGlobalDictationPasteX11")] };
  cachedSources.set(extractedRoot, result);
  return result;
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

function createNativeRuntime(extractedRoot, { sessionType = "wayland" } = {}) {
  const native = nativeSources(extractedRoot), clock = new Clock(), events = [], warnings = [], checks = [], children = [], accelerators = new Map();
  let nextSession = 0, nextShow = null, checkFailure = null;
  const pendingShows = [];
  const window = {
    getFocusedInAppWindow: () => null,
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
  };
  const electron = { app: new EventEmitter(), globalShortcut: {
    register(key, callback) { accelerators.set(key, callback); return sessionType === "x11" || key === "Escape"; },
    unregister(key) { accelerators.delete(key); },
  } };
  electron.app.getAppPath = () => null;
  function childFor(file, args) {
    const child = new EventEmitter(); child.pid = 100 + children.length;
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.args = Array.from(args); child.file = file; child.signals = [];
    child.stdin = { write(data, callback) { events.push({ type: "helper.stdin", data }); callback?.(); return true; } };
    child.kill = signal => { child.signals.push(signal ?? "default"); queueMicrotask(() => child.emit("exit", 0)); return true; };
    child.ready = () => { const count = args[0] === "portal" ? (args.length - 1) / 4 : 0; child.stdout.emit("data", Buffer.from(["bindings", ...Array.from({ length: count }, (_, i) => `bound:${i}:Fixture binding`), "ready", ""].join("\n"))); };
    child.down = (index = 0) => child.stdout.emit("data", Buffer.from(`down:${index}\n`));
    child.up = (index = 0) => child.stdout.emit("data", Buffer.from(`up:${index}\n`));
    children.push(child); return child;
  }
  const context = {
    Buffer, Symbol, console: { warn: (...args) => warnings.push(args) },
    process: { platform: "linux", env: { XDG_SESSION_TYPE: sessionType }, resourcesPath: "/inert/resources" },
    Date: { now: () => clock.now }, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    require(id) {
      if (id === "node:fs") return { accessSync() {}, constants: { X_OK: 1 } };
      if (id === "node:path") return path;
      if (id === "electron") return electron;
      if (id === "node:child_process") return {
        spawn: childFor,
        execFileSync(file, args) { checks.push({ file, args: Array.from(args) }); if (checkFailure) throw checkFailure; return args.at(-1).toUpperCase() + "\n"; },
        execFile(file, args, options, callback) { events.push({ type: "execFile", file, args: Array.from(args), options }); callback(null); },
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
  context[native.keymap] = () => ({ hasBinding: false }); context[native.chooseHotkey] = value => value.legacyHotkey; context[native.validateHotkey] = () => null;
  context[native.clipboard] = () => "inert-clipboard-fingerprint";
  context[native.random] = { randomUUID: () => `native-session-${++nextSession}` };
  context[native.logger] = { tZQ: () => ({ warning: (...args) => warnings.push(args) }) };
  context[native.keyCompare[1]] = { [native.keyCompare[2]]: value => value };
  context[native.messageMap] = Object.fromEntries(["global-dictation-dismiss", "global-dictation-recording-stopped", "global-dictation-failed", "global-dictation-close"].map(type => [type, true]));
  context[native.gestureImport[1]] = { Q2Y: { GLOBAL_DICTATION_FORCE_LOCK_DEBUG_ENABLED: "inert-debug" } };
  const script = `${native.gesture.text};globalThis.NativeGesture=${native.gesture.name};`;
  vm.runInNewContext(script, context);
  context[native.gestureImport[1]][native.gestureImport[2]] = context.NativeGesture;
  vm.runInNewContext([native.shared, native.registration.body, ...native.functions, native.controller.text,
    `globalThis.NativeController=${native.controller.name};`].join("\n"), context);
  const messages = [];
  const controller = new context.NativeController({ canForceGlobalDictationLock: false, globalState: { get() {}, set() {} },
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
  return { native, context, controller, window, clock, events, warnings, checks, children, messages, accelerators, lock, bind, settle, entry,
    holdChild: () => children.find(child => child.args[0] === "portal" && !child.signals.length),
    setCheckFailure(error) { checkFailure = error; },
    deferNextShow() { const held = deferred(); nextShow = held; return held; },
    cancelPrimary() { entry("globalDictationHold").onCancelled(); },
    async cleanup() {
      for (const held of pendingShows) held.resolve(false);
      controller.dispose();
      await settle();
      const stopped = context.codexLinuxGlobalShortcutsPortalShutdown();
      await settle(); if (stopped) await stopped;
      await context.codexLinuxGlobalShortcutsPortalQueue;
      clock.timers.clear();
    },
  };
}

module.exports = { createNativeRuntime, nativeSources, methodSource, settle, plain };
