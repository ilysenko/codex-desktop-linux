"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");
const { createNativeRuntime, nativeSources, methodSource, nativeSourceCacheStats, plain } = require("./fixtures/native-controller.js");
const signedApp = process.env.CODEX_SIGNED_EXTRACTED_APP;
const options = { skip: !signedApp };

test.after(() => {
  if (!signedApp || !nativeSourceCacheStats(signedApp)) return;
  nativeSources(signedApp);
  const cache = nativeSourceCacheStats(signedApp);
  assert.equal(cache.productionEntryCalls, 1, "the complete file uses one guarded production source transform");
  console.log("native-source-cache " + JSON.stringify(cache));
});

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
  assert.equal(nativeSources(signedApp), native, "the identical SDK and nineteen source inputs reuse the same proof");
  assert.equal(native.methodCount, native.originalMethodCount + 1);
  assert.equal(native.sourceFacts.rangeUnit, "UTF-16 code units");
  assert.equal(native.sourceFacts.controllerBytes, Buffer.byteLength(native.originalController.text));
  assert.equal(native.originalController.end - native.originalController.start, native.originalController.text.length);
  assert.equal(native.clipboardBridge.parameters.length, 4);
  assert.deepEqual(native.clipboardBridge.parameters, native.originalClipboard.parameters);
  assert.equal(native.paste.parameters.length, 1);
  assert.deepEqual(native.paste.parameters, native.originalPaste.parameters);
  assert.equal(native.accessibility.text, native.originalAccessibility.text);
  assert.doesNotThrow(() => new vm.Script(native.originalController.text));
  for (const name of native.originalMethodNames.filter(name => !["registerHotkeyOrThrow", "registerToggleHotkeyOrThrow", "handleTranscript"].includes(name))) {
    assert.equal(methodSource(native.controller.text, name), methodSource(native.originalController.text, name), name + " retains its complete native body");
  }
  const calls = [...native.controller.text.matchAll(new RegExp(`(?<![\\w$.])${native.registration.name}\\(`, "gu"))];
  assert.equal(calls.length, 3);
  assert.match(methodSource(native.controller.text, "registerHotkeyOrThrow"), /linuxCommandId:"globalDictationHold"/u);
  assert.match(methodSource(native.controller.text, "registerToggleHotkeyOrThrow"), /linuxCommandId:"globalDictationSingleTap"/u);
  assert.doesNotMatch(methodSource(native.controller.text, "updateEscapeRegistration"), /linuxCommandId/u);
  assert.equal(methodSource(native.controller.text, "updateEscapeRegistration"), methodSource(native.originalController.text, "updateEscapeRegistration"));
});

test("actual controller and exported gesture confirm hold then release exactly once", options, async t => {
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

function pasteCommands(r) { return events(r, "helper.stdin").filter(event => event.data === "paste\n"); }
function progress(request) {
  const result = { done: false };
  request.promise.then(() => { result.done = true; }, error => { result.done = true; result.error = error; });
  return result;
}
function assertRestored(r, snapshot, fingerprint) {
  assert.deepEqual(r.clipboard.snapshot(), snapshot);
  assert.equal(r.fingerprint(), fingerprint);
}

for (const phase of ["before-admission", "eligibility", "pending-paste", "committed-paste", "restore-window", "completed"]) {
  test("actual native clipboard abort retains the complete snapshot at " + phase, options, async t => {
    const r = runtime(t); await r.bind();
    const original = r.clipboard.snapshot(), fingerprint = r.fingerprint(), child = r.holdChild();
    const request = r.transcript("phase-" + phase, "  native transcript  ", { stoppedAt: r.clock.now - 50 });
    const state = progress(request);
    assert.equal(r.controller.pendingPasteSessionId, request.id);
    assert.equal(r.controller.pendingPasteAbort, request.abort);
    assert.equal(r.controller.activeSession, null);
    assert.equal(r.controller.clipboardFingerprintAtStop, undefined);
    assert.equal(r.history()[0].text, "native transcript");
    assert.equal(events(r, "window.hide").length, 1);
    if (phase === "before-admission") {
      r.controller.cancelPendingPaste();
      await request.promise;
      assert.equal(events(r, "clipboard.snapshot").length, 0);
      assert.equal(events(r, "clipboard.writeText").length, 0);
      assert.equal(pasteCommands(r).length, 0);
      assertRestored(r, original, fingerprint);
      return;
    }
    await r.settle();
    assert.equal(events(r, "clipboard.snapshot").length, 1);
    assert.deepEqual(events(r, "clipboard.snapshot")[0].snapshot, original);
    assert.equal(r.clipboard.readText(), "native transcript ");
    assert.equal(events(r, "native.wait")[0].delay, 100);
    await r.clock.advance(99);
    assert.equal(pasteCommands(r).length, 0);
    if (phase === "eligibility") {
      r.controller.cancelPendingPaste();
      await r.clock.advance(1);
      await request.promise;
      assert.equal(events(r, "native.wait").some(event => event.delay === 700), false);
      assert.deepEqual(child.signals, []);
    } else {
      await r.clock.advance(1);
      assert.equal(pasteCommands(r).length, 1);
      if (phase === "pending-paste" || phase === "committed-paste") {
        child.autoExit = false;
        if (phase === "committed-paste") child.commit();
        r.controller.cancelPendingPaste();
        await r.settle();
        assert.deepEqual(child.signals, ["SIGINT"]);
        await r.clock.advance(2001);
        assert.equal(state.done, false);
        assert.equal(events(r, "clipboard.restore").length, 0);
        assert.equal(events(r, "native.wait").some(event => event.delay === 700), false);
        assert.deepEqual(child.signals, ["SIGINT"]);
        child.exit(); await r.settle();
        assert.equal(events(r, "native.wait").at(-1).delay, 700);
      } else {
        child.pasteOk(); await r.settle();
        assert.equal(events(r, "native.wait").at(-1).delay, 700);
        if (phase === "restore-window") {
          r.controller.cancelPendingPaste(); await r.settle();
          assert.deepEqual(child.signals, []);
        }
      }
      await r.clock.advance(699);
      assert.equal(state.done, false);
      assert.equal(events(r, "clipboard.restore").length, 0);
      await r.clock.advance(1); await request.promise;
      if (phase === "completed") {
        request.abort.abort(); await r.settle();
        assert.deepEqual(child.signals, []);
      }
    }
    assert.equal(events(r, "clipboard.restore").length, 1);
    assert.equal(events(r, "window.pasteFailure").length, 0);
    assert.equal(r.controller.pendingPasteSessionId, null);
    assertRestored(r, original, fingerprint);
  });
}

test("actual Linux FIFO admits the third session after old exit, 700ms and native NX restoration", options, async t => {
  const r = runtime(t); await r.bind();
  const original = r.clipboard.snapshot(), fingerprint = r.fingerprint(), child = r.holdChild();
  child.autoExit = false;
  const first = r.transcript("fifo-first", "first", { fingerprint });
  const second = r.transcript("fifo-second", "second", { fingerprint });
  const third = r.transcript("fifo-third", "third", { fingerprint });
  assert.equal(new Set([first.signal, second.signal, third.signal]).size, 3);
  assert.equal(r.controller.pendingPasteSessionId, third.id);
  assert.equal(r.controller.pendingPasteAbort, third.abort);
  second.abort.abort();
  await r.settle();
  assert.deepEqual(events(r, "clipboard.writeText").map(event => event.text), ["first "]);
  await r.clock.advance(150);
  assert.equal(pasteCommands(r).length, 1);
  first.abort.abort(); await r.settle();
  await r.clock.advance(2500);
  assert.deepEqual(child.signals, ["SIGINT"]);
  assert.equal(events(r, "clipboard.snapshot").length, 1);
  assert.equal(r.controller.pendingPasteSessionId, third.id);
  assert.equal(third.signal.aborted, false);
  child.exit(); await r.settle();
  await r.readyPortals();
  await r.clock.advance(699);
  assert.equal(events(r, "clipboard.snapshot").length, 1);
  await r.clock.advance(1);
  await first.promise; await second.promise;
  assert.deepEqual(events(r, "clipboard.writeText").map(event => event.text), ["first ", "third "]);
  assert.equal(events(r, "clipboard.snapshot").length, 2);
  assert.deepEqual(events(r, "clipboard.snapshot")[1].snapshot, original);
  assert.equal(events(r, "native.wait").at(-1).delay, 0, "the third request retains its original stoppedAt");
  const restoreIndex = r.events.findIndex(event => event.type === "clipboard.restore");
  const thirdSnapshotIndex = r.events.findIndex((event, index) => index > restoreIndex && event.type === "clipboard.snapshot");
  assert.ok(restoreIndex >= 0 && restoreIndex < thirdSnapshotIndex);
  assert.equal(r.controller.pendingPasteSessionId, third.id);
  assert.equal(r.controller.pendingPasteAbort, third.abort);
  await r.clock.advance(0);
  const current = r.holdChild();
  assert.notEqual(current, child);
  current.pasteOk(); await r.settle();
  await r.clock.advance(700); await third.promise;
  assertRestored(r, original, fingerprint);
  assert.equal(r.controller.pendingPasteSessionId, null);
  assert.equal(events(r, "window.pasteFailure").length, 0);
});

test("native stop fingerprint and user clipboard changes retain their original failure decisions", options, async t => {
  const r = runtime(t); await r.bind();
  const fingerprint = r.fingerprint();
  r.clipboard.userChange("user changed before admission");
  const changed = r.clipboard.snapshot();
  const first = r.transcript("fingerprint-before", "first", { fingerprint });
  await first.promise;
  assert.equal(events(r, "clipboard.snapshot").length, 0);
  assert.equal(events(r, "clipboard.writeText").length, 0);
  assert.deepEqual(events(r, "window.pasteFailure").at(-1).failure, { text: "first ", copied: false, reason: "clipboard-changed" });
  assert.deepEqual(r.clipboard.snapshot(), changed);
  const second = r.transcript("fingerprint-after", "second");
  await r.settle();
  r.clipboard.userChange("user changed after copy");
  const afterCopy = r.clipboard.snapshot();
  await r.clock.advance(150); await second.promise;
  assert.deepEqual(events(r, "window.pasteFailure").at(-1).failure, { text: "second ", copied: false, reason: "clipboard-changed" });
  assert.equal(pasteCommands(r).length, 0);
  assert.equal(events(r, "clipboard.restore").length, 0);
  assert.deepEqual(r.clipboard.snapshot(), afterCopy);
});

test("native pending-session guards protect a newer session while an older failure view is pending", options, async t => {
  const r = runtime(t); await r.bind();
  const held = r.deferNextPasteFailure(), child = r.holdChild();
  const first = r.transcript("failure-first", "first");
  await r.settle(); await r.clock.advance(150);
  child.pasteError("inert ordinary failure"); await r.settle();
  const failure = events(r, "window.pasteFailure")[0];
  assert.deepEqual(failure.failure, { text: "first ", copied: true, reason: "paste" });
  assert.equal(failure.isCurrent(), true);
  assert.equal(r.clipboard.readText(), "first ");
  assert.equal(events(r, "clipboard.restore").length, 0);
  const second = r.transcript("failure-second", "second");
  await r.settle();
  const third = r.transcript("failure-third", "third");
  assert.equal(failure.isCurrent(), false);
  assert.equal(new Set([first.signal, second.signal, third.signal]).size, 3);
  held.resolve(); await first.promise;
  assert.equal(r.controller.pendingPasteSessionId, third.id);
  assert.equal(r.controller.pendingPasteAbort, third.abort);
  await r.clock.advance(150);
  child.pasteError("older second failure"); await second.promise; await r.settle();
  assert.equal(r.controller.pendingPasteSessionId, third.id);
  assert.equal(r.controller.pendingPasteAbort, third.abort);
  assert.equal(third.signal.aborted, false);
  third.abort.abort();
  await r.clock.advance(0); await third.promise;
  assert.equal(events(r, "window.pasteFailure").length, 1);
});

test("actual X11 committed paste waits for its original callback and abort restoration before FIFO admission", options, async t => {
  const r = runtime(t, { sessionType: "x11" }); await r.bind();
  const original = r.clipboard.snapshot(), fingerprint = r.fingerprint(), held = r.deferNextExec();
  const first = r.transcript("x11-first", "first", { fingerprint });
  await r.settle(); await r.clock.advance(150);
  assert.equal(events(r, "execFile").length, 1);
  assert.deepEqual(plain(events(r, "execFile")[0].options), { windowsHide: true });
  assert.equal(events(r, "execFile")[0].file, "xdotool");
  first.abort.abort();
  const second = r.transcript("x11-second", "second", { fingerprint });
  await r.clock.advance(2500);
  assert.deepEqual(events(r, "clipboard.writeText").map(event => event.text), ["first "]);
  held.resolve(); await r.settle();
  assert.equal(events(r, "native.wait").at(-1).delay, 700);
  await r.clock.advance(699);
  assert.equal(events(r, "clipboard.snapshot").length, 1);
  await r.clock.advance(1); await first.promise;
  assert.deepEqual(events(r, "clipboard.snapshot")[1].snapshot, original);
  await r.clock.advance(0); await r.settle(); await r.clock.advance(700); await second.promise;
  assertRestored(r, original, fingerprint);
  assert.equal(events(r, "helper.signal").length, 0);
});

for (const platform of ["darwin", "win32"]) {
  test("native " + platform + " dispatcher invokes immediately and returns the original Promise", options, async t => {
    const r = runtime(t, { platform, trustedAccessibility: false });
    const dispatcher = r.context.codexLinuxGlobalDictationClipboard;
    r.context.codexLinuxGlobalDictationClipboardQueues = { get() { throw Error("non-Linux queue access"); } };
    const bridge = vm.runInNewContext("(" + r.native.clipboardBridge.text + ")", r.context);
    const signal = new AbortController().signal, args = ["native platform ", r.clock.now, r.fingerprint(), signal];
    let original, calls = 0;
    const returned = dispatcher(r.controller, (...values) => { calls++; assert.deepEqual(values, args); original = bridge(...values); return original; }, ...args);
    assert.equal(calls, 1);
    assert.equal(returned, original);
    assert.equal(events(r, "clipboard.snapshot").length, 1, "the native function begins before returning");
    if (platform === "darwin") {
      assert.deepEqual(JSON.parse(JSON.stringify(await returned)), { text: "native platform ", copied: true, reason: "accessibility" });
      assert.equal(events(r, "platform.exec").length, 0);
      assert.equal(events(r, "clipboard.restore").length, 0);
    } else {
      await r.clock.advance(150);
      const call = events(r, "platform.exec")[0];
      assert.equal(call.file, "powershell.exe"); assert.equal(call.options.signal, signal);
      await r.clock.advance(700); assert.equal(await returned, null);
      assert.equal(events(r, "clipboard.restore").length, 1);
    }
  });
}

test("a queued replacement retains the original stopped fingerprint after the preceding native restoration", options, async t => {
  const r = runtime(t); await r.bind();
  const original = r.clipboard.snapshot(), fingerprint = r.fingerprint(), child = r.holdChild();
  const first = r.transcript("stale-first", "first", { fingerprint });
  await r.settle(); await r.clock.advance(150);
  const temporaryFingerprint = r.fingerprint();
  const second = r.transcript("stale-second", "second");
  assert.equal(second.fingerprint, temporaryFingerprint);
  assert.notEqual(temporaryFingerprint, fingerprint);
  first.abort.abort(); await r.settle();
  await r.clock.advance(700);
  await first.promise; await second.promise;
  assert.deepEqual(events(r, "clipboard.writeText").map(event => event.text), ["first "]);
  assert.equal(events(r, "clipboard.snapshot").length, 1);
  assert.deepEqual(events(r, "window.pasteFailure").at(-1).failure, { text: "second ", copied: false, reason: "clipboard-changed" });
  assertRestored(r, original, fingerprint);
  assert.deepEqual(child.signals, ["SIGINT"]);
});

for (const type of ["inApp", "pet"]) {
  test("native " + type + " transcript retains history, clear-session and idle context", options, async t => {
    const r = runtime(t); await r.bind();
    const original = r.clipboard.snapshot(), fingerprint = r.fingerprint(), id = "context-" + type;
    const completions = [];
    if (type === "inApp") r.controller.pendingInAppDictationStart = { sessionId: id, complete: value => completions.push(value) };
    if (type === "pet") {
      r.setVisiblePet({ id: 77 });
      r.controller.setNativePetRendererReady(77, true);
      r.events.length = 0; r.messages.length = 0;
    }
    const request = r.transcript(id, "  contextual text  ", { type, stoppedAt: r.clock.now - 10000, fingerprint });
    assert.equal(r.controller.activeSession, null);
    assert.equal(r.controller.clipboardFingerprintAtStop, undefined);
    assert.equal(r.history()[0].text, "contextual text");
    assert.equal(events(r, "window.hide").length, 1);
    if (type === "inApp") assert.deepEqual(completions, [false]);
    else assert.equal(r.messages.at(-1).message.type, "global-dictation-idle");
    await r.settle();
    assert.equal(events(r, "native.wait")[0].delay, 150, "only the native overlay context supplies stoppedAt");
    r.controller.cancelPendingPaste();
    await r.clock.advance(150); await request.promise;
    assertRestored(r, original, fingerprint);
  });
}

for (const outcome of ["success", "abort"]) {
  test("native " + outcome + " 700ms restoration respects a later user fingerprint", options, async t => {
    const r = runtime(t); await r.bind();
    const child = r.holdChild(), request = r.transcript("late-user-" + outcome, "transcript");
    await r.settle(); await r.clock.advance(150);
    if (outcome === "success") child.pasteOk(); else request.abort.abort();
    await r.settle();
    assert.equal(events(r, "native.wait").at(-1).delay, 700);
    r.clipboard.userChange("user owns the clipboard during restoration");
    const snapshot = r.clipboard.snapshot(), fingerprint = r.fingerprint();
    await r.clock.advance(700); await request.promise;
    assert.equal(events(r, "clipboard.restore").length, 0);
    assertRestored(r, snapshot, fingerprint);
    assert.equal(events(r, "window.pasteFailure").length, 0);
  });
}
