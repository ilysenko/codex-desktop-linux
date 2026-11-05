"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createNativeRuntime, nativeSources, methodSource } = require("./fixtures/native-controller.js");
const signedApp = process.env.CODEX_SIGNED_EXTRACTED_APP;
const options = { skip: !signedApp };

function runtime(t, settings) {
  const result = createNativeRuntime(signedApp, settings);
  t.after(() => result.cleanup());
  return result;
}

function events(runtime, kind) { return runtime.events.filter(event => event.type === kind); }

// Every class, gesture callback and registration function in these tests comes
// from the actual signed JavaScript. Window/audio transport and OS processes are
// explicit inert collaborators. The vendor factory/startup is never executed.
test("actual dictation controller owns hold/toggle while retaining native Escape", options, () => {
  const native = nativeSources(signedApp);
  assert.equal(native.gestureImport[2], "vAN");
  const calls = [...native.controller.text.matchAll(new RegExp(`(?<![\\w$.])${native.registration.name}\\(`, "gu"))];
  assert.equal(calls.length, 3);
  assert.match(methodSource(native.controller.text, "registerHotkeyOrThrow"), /linuxCommandId:"globalDictationHold"/u);
  assert.match(methodSource(native.controller.text, "registerToggleHotkeyOrThrow"), /linuxCommandId:"globalDictationSingleTap"/u);
  assert.doesNotMatch(methodSource(native.controller.text, "updateEscapeRegistration"), /linuxCommandId/u);
  assert.equal(methodSource(native.controller.text, "updateEscapeRegistration"), methodSource(native.originalController.text, "updateEscapeRegistration"));
});

test("actual Uf and exported gesture confirm hold then release exactly once", options, async t => {
  const r = runtime(t); await r.bind(); const child = r.holdChild();
  assert.equal(r.children.length, 1);
  assert.deepEqual(r.checks[0].args.slice(0, 3), ["check", "--shortcut", "global-dictation"]);
  child.down(); await r.settle();
  const session = r.controller.activeSession;
  assert.equal(session.mode, "hold"); assert.equal(session.isStarting, false);
  assert.equal(events(r, "window.start")[0].pendingConfirmation, true);
  await r.clock.advance(99); assert.equal(events(r, "window.confirm").length, 0);
  await r.clock.advance(1); assert.deepEqual(events(r, "window.confirm").map(event => event.id), [session.id]);
  child.up(); child.up(); await r.settle();
  assert.equal(events(r, "window.stop").length, 1);
  assert.equal(events(r, "window.stop")[0].id, session.id);
  assert.equal(events(r, "window.stop")[0].cancel, undefined);
  assert.equal(r.controller.activeSession.stopRequested, true);
});

test("failed helper validation preserves the actual controller's existing registration", options, async t => {
  const r = runtime(t); await r.bind(); const child = r.holdChild();
  const registration = r.controller.registeredHotkeyRegistration;
  r.setCheckFailure(new Error("inert helper check failure"));
  assert.throws(() => r.controller.registerHotkeyOrThrow("Ctrl+Alt+X", r.lock), /Unable to register global dictation hotkey/u);
  assert.equal(r.controller.registeredHotkey, "Ctrl+Alt+D");
  assert.equal(r.controller.registeredHotkeyRegistration, registration);
  assert.equal(child.signals.length, 0);
  child.down(); await r.settle();
  assert.equal(events(r, "window.start").length, 1);
});

test("actual cancel callback cancels held recording and ignores subsequent release", options, async t => {
  const r = runtime(t); await r.bind(); const child = r.holdChild();
  child.down(); await r.settle(); await r.clock.advance(100);
  r.cancelPrimary(); await r.settle();
  assert.equal(r.controller.activeSession, null);
  assert.deepEqual(events(r, "window.stop").map(event => event.cancel), [true]);
  child.up(); r.cancelPrimary(); await r.settle();
  assert.equal(events(r, "window.stop").length, 1);
  assert.equal(r.controller.shortcutGestures.hasPendingStart, false);
});

test("release during pending native window start cancels and a late result cannot replace a new session", options, async t => {
  const r = runtime(t); await r.bind(); const child = r.holdChild(), pending = r.deferNextShow();
  child.down(); await r.settle(); const oldId = r.controller.activeSession.id;
  assert.equal(r.controller.activeSession.isStarting, true);
  assert.equal(r.controller.shortcutGestures.hasPendingStart, true);
  child.up(); await r.settle(); assert.equal(r.controller.activeSession, null);
  await r.clock.advance(500);
  child.down(); await r.settle(); const current = r.controller.activeSession;
  assert.notEqual(current.id, oldId); assert.equal(current.mode, "hold");
  pending.resolve(true); await r.settle(); await r.clock.advance(100);
  assert.equal(r.controller.activeSession.id, current.id);
  assert.deepEqual(events(r, "window.confirm").map(event => event.id), [current.id]);
  await r.controller.handleMessage({ sender: { id: 999 } }, { type: "global-dictation-dismiss", sessionId: oldId });
  assert.equal(r.controller.activeSession.id, current.id, "late native dismissal keeps current session");
});

test("actual toggle callback starts on down and stops on the next press", options, async t => {
  const r = runtime(t); await r.bind({ hold: false, toggle: true }); const child = r.holdChild();
  child.down(); await r.settle(); const session = r.controller.activeSession;
  assert.equal(session.mode, "toggle"); assert.equal(events(r, "window.start")[0].gesture, "tap");
  assert.equal(events(r, "window.start")[0].pendingConfirmation, false);
  child.up(); await r.settle(); assert.equal(events(r, "window.stop").length, 0);
  child.down(); child.up(); await r.settle();
  assert.equal(events(r, "window.stop").length, 1); assert.equal(events(r, "window.stop")[0].id, session.id);
});

test("native ownership and setup-window gates prevent registration callbacks from recording", options, async t => {
  const r = runtime(t); await r.bind(); const child = r.holdChild();
  r.lock.owned = false; child.down(); child.up(); await r.settle();
  assert.equal(events(r, "window.start").length, 0);
  r.lock.owned = true; r.controller.hotkeyController.setSetupWindowFocused(true);
  child.down(); child.up(); await r.settle(); assert.equal(events(r, "window.start").length, 0);
  r.controller.hotkeyController.setSetupWindowFocused(false);
  child.down(); await r.settle(); assert.equal(events(r, "window.start").length, 1);
});

test("native hold and toggle share one portal while Escape retains its Electron boundary", options, async t => {
  const r = runtime(t); await r.bind({ hold: true, toggle: true }); const child = r.holdChild();
  assert.equal(r.children.filter(value => value.args[0] === "portal").length, 1);
  assert.deepEqual(child.args.filter((value, index) => child.args[index - 1] === "--shortcut"), ["global-dictation", "global-dictation-single-tap"]);
  child.down(); await r.settle();
  const nativeEscape = [...r.context[r.native.registry]].find(entry => entry.hotkey === "Escape");
  assert.ok(nativeEscape); assert.equal(nativeEscape.linuxCommandId, undefined);
  assert.equal(child.args.includes("Escape"), false);
  const escape = r.accelerators.get("Escape"); assert.equal(typeof escape, "function");
  escape(); await r.settle(); assert.equal(r.controller.activeSession, null);
  assert.equal(r.children.filter(value => value.args[0] === "portal").length, 1);
});

test("actual X11 watcher releases a hold on error and suppresses repeated exit callbacks", options, async t => {
  const r = runtime(t, { sessionType: "x11" }); await r.bind();
  const pressed = r.accelerators.get("Ctrl+Alt+D"); assert.equal(typeof pressed, "function");
  pressed(); await r.settle(); await r.clock.advance(100);
  const monitor = r.children.find(child => child.file.endsWith("global-dictation-release-monitor"));
  assert.ok(monitor); assert.deepEqual(monitor.args, ["--accelerator", "Ctrl+Alt+D"]);
  assert.equal(r.children.some(child => child.args[0] === "portal"), false);
  const lateFailure = monitor.listeners("error")[0];
  monitor.emit("error", new Error("inert monitor failure")); await r.settle();
  assert.equal(events(r, "window.stop").length, 1); assert.equal(r.controller.activeHotkeyReleaseWatcher.isActive, false);
  monitor.emit("exit", 1); lateFailure(new Error("late inert failure")); await r.settle();
  assert.equal(events(r, "window.stop").length, 1);
});

test("actual X11 unregister disposes its monitor before late callbacks can start or stop again", options, async t => {
  const r = runtime(t, { sessionType: "x11" }); await r.bind(); const pressed = r.accelerators.get("Ctrl+Alt+D");
  pressed(); await r.settle(); await r.clock.advance(100);
  const monitor = r.children.find(child => child.file.endsWith("global-dictation-release-monitor"));
  r.controller.unregisterHotkey(); await r.settle();
  assert.equal(monitor.signals.length, 1); assert.equal(r.controller.activeHotkeyReleaseWatcher, null);
  const stops = events(r, "window.stop").length, starts = events(r, "window.start").length;
  monitor.emit("exit", 0); pressed(); await r.settle();
  assert.equal(events(r, "window.stop").length, stops); assert.equal(events(r, "window.start").length, starts);
});
