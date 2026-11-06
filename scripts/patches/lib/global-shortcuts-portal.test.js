"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const vm = require("node:vm");
const { fakeHelperChild, waylandPatchContext, registerPortal, mainBundleFixture, mainBundleFixtureBody } = require("./global-shortcuts-portal.test-helpers.js");
const { installPortalBackend, registrationContract } = require("./global-shortcuts-portal.js");

const tick = () => new Promise(setImmediate);
const context = (children) => waylandPatchContext(children, { shortcuts: true });
async function spawned(ctx, count) {
  for (let i = 0; i < 20 && ctx.__spawns.length < count; i++) await tick();
  assert.equal(ctx.__spawns.length, count);
}
async function cleanup(ctx) {
  for (const r of ctx.codexLinuxGlobalShortcutsPortalRegistrations) r.unregister();
  await ctx.codexLinuxGlobalShortcutsPortalQueue;
}
function captureOrigin() {
  const origin = new EventEmitter(), window = new EventEmitter();
  origin.window = window;
  origin.isDestroyed = () => false;
  window.isDestroyed = () => false;
  window.isFocused = () => true;
  return origin;
}

test("shared backend fails closed for missing and ambiguous lifecycle anchors", () => {
  const source = mainBundleFixture();
  for (const input of [source.replace("generation:0", "generation:1"), source + source,
    source.replace("beginCapture()", "renamedCapture()"), source.replace("suspendDepth+=1", "suspendDepth+=2"),
    source.replace('status:"loading"', 'status:"pending"'), source.replace("flushAndDisposeContext:p", "flushContext:p"),
    source.replace("markAppQuitting:()=>", "markQuitting:()=>"),
    source.replace('ea.app.on("will-quit",', 'ea.app.on("before-quit",'),
    source.replaceAll("a.dispose(),o.dispose(),Promise.allSettled([", "o.dispose(),a.dispose(),Promise.allSettled([")]) {
    assert.throws(() => installPortalBackend(input));
  }
  const misleading = "function unrelated(e){if(wrongCheck(e)||otherCheck(e))return;}" + source;
  assert.equal(registrationContract(misleading).bareModifier, "Rk");
  const retiredWithoutRegistrationCallback = source.replace(
    "o=null==i?t:{onRegistrationChanged:t.onRegistrationChanged,onPressed:",
    "o=null==i?t:{onPressed:",
  );
  assert.throws(() => registrationContract(retiredWithoutRegistrationCallback), /ownership callbacks drifted/);
  const retiredMinifier = source.replaceAll('"win32"===process.platform', "process.platform===`win32`")
    .replace("o=null==i?t:", "o=i==null?t:").replace("(e,t,r){var n;let i=r?.ownership", "(e,t,n){var q;let i=n?.ownership");
  assert.throws(() => registrationContract(retiredMinifier), /global shortcut registration owner matched 0 times/);
});

test("shared backend installs into the rspack module that owns the registration function", () => {
  const source = mainBundleFixtureBody();
  const chunk = (owner, other) => `exports.ids=[916],exports.modules={11(e,t,r){"use strict";${owner}},22(e,t,r){"use strict";${other}}};`;
  const patched = installPortalBackend(chunk(source, ""));
  const ownerStart = patched.indexOf('11(e,t,r){"use strict";');
  const otherStart = patched.indexOf('22(e,t,r){"use strict";');
  const injected = patched.indexOf("var codexLinuxGlobalShortcutsPatch=");
  assert.ok(ownerStart < injected && injected < otherStart);
  assert.ok(patched.startsWith("exports.ids=[916]"));
  assert.doesNotThrow(() => new vm.Script(patched));
  assert.equal(installPortalBackend(patched), patched);

  const accessStart = source.indexOf("var accessState=");
  const accessEnd = source.indexOf("function flushWithTimeout(");
  const split = chunk(source.slice(0, accessStart) + source.slice(accessEnd), source.slice(accessStart, accessEnd));
  assert.throws(() => installPortalBackend(split), /application access readiness is outside the global shortcut module/);
});

test("current native pending read and commit attempt precede Portal stop and window marking", async () => {
  for (const mode of ["present", "null", "commit-caught", "getter-throws"]) {
    const child = fakeHelperChild(), ctx = context([child]), events = [];
    registerPortal(ctx, "Ctrl+Alt+G", {}, "hotkeyWindow");
    await spawned(ctx, 1); child.ready(); await ctx.codexLinuxGlobalShortcutsPortalQueue;
    const value = { threadIds: ["inert"] };
    ctx.__readPendingState = () => { events.push("read"); if (mode === "getter-throws") throw Error("inert reader failed"); return mode === "null" ? null : value; };
    ctx.__commitPending = actual => { assert.equal(actual, value); events.push("commit-attempt"); if (mode === "commit-caught") throw Error("inert transaction failed"); };
    ctx.__commitWarning = () => events.push("commit-warning");
    const windows = ctx.createWindowServices({ markAppQuitting() { assert.equal(ctx.codexLinuxGlobalShortcutsShuttingDown, true); events.push("window"); } },
      { markAppQuitting() { events.push("avatar"); } }, { dispose() { events.push("spotlight"); } }, { markAppQuitting() { events.push("notch"); } });
    if (mode === "getter-throws") {
      assert.throws(() => windows.markAppQuitting(), /inert reader failed/);
      assert.equal(ctx.codexLinuxGlobalShortcutsShuttingDown, false); assert.equal(child.killed, undefined);
      assert.deepEqual(events, ["read"]);
    } else {
      windows.markAppQuitting();
      assert.equal(child.killed, true);
      assert.deepEqual(events, ["read", ...(mode === "null" ? [] : ["commit-attempt"]), ...(mode === "commit-caught" ? ["commit-warning"] : []), "window", "avatar", "notch", "spotlight"]);
    }
    await cleanup(ctx);
  }
});

for (const [platform, privacy, expectedVeto] of [["linux", false, false], ["darwin", true, true], ["darwin", false, false], ["darwin", "throws", false]]) {
  test(`current native privacy polarity keeps platform policy ${platform}/${privacy}`, async () => {
    const child = fakeHelperChild(), ctx = context([child]);
    const handle = registerPortal(ctx, "Ctrl+Alt+G", {}, "hotkeyWindow");
    await spawned(ctx, 1); child.ready(); await ctx.codexLinuxGlobalShortcutsPortalQueue;
    ctx.process.platform = platform;
    ctx.__privacyAddon = () => { if (privacy === "throws") throw Error("inert addon failure"); return { isPrivacySettingsTerminationRequest: () => privacy }; };
    let marks = 0, veto = 0;
    const windows = ctx.createWindowServices({ markAppQuitting() { marks++; } }, { markAppQuitting() {} }, { dispose() {} });
    ctx.installQuitLifecycle({ windows });
    ctx.ea.app.emit("before-quit", { preventDefault() { veto++; } });
    assert.equal(veto, expectedVeto ? 1 : 0); assert.equal(marks, expectedVeto ? 0 : 1);
    assert.equal(ctx.codexLinuxGlobalShortcutsShuttingDown, !expectedVeto);
    if (expectedVeto) { assert.equal(handle.ready(), true); assert.equal(child.killed, undefined); }
    await cleanup(ctx);
  });
}

for (const skip of [false, true]) test(`current native will-quit joins stop settlement after native marking skip=${skip}`, async () => {
  const child = fakeHelperChild(), ctx = context([child]), events = [];
  const handle = registerPortal(ctx, "Ctrl+Alt+G", {}, "hotkeyWindow");
  await spawned(ctx, 1); child.ready(); await ctx.codexLinuxGlobalShortcutsPortalQueue;
  child.kill = signal => { child.signals ??= []; child.signals.push(signal); child.killed = true; return true; };
  let final = false, exited = false; child.once("exit", () => { exited = true; });
  const windows = ctx.createWindowServices({ markAppQuitting() { events.push("window"); assert.equal(child.killed, true); } }, { markAppQuitting() {} }, { dispose() {} });
  ctx.installQuitLifecycle({ windows, quitState: { shouldSkipDrainBeforeQuit: () => skip },
    hotkeyWindowLifecycleManager: { dispose() { events.push("hotkey"); handle.unregister(); } },
    globalDictationLifecycleManager: { dispose() { events.push("dictation"); } },
    settingsStore: { async flush() { events.push("settings"); } },
    flushAndDisposeContext: async () => { events.push("context"); }, disposables: { dispose() { final = true; events.push("final"); } } });
  ctx.ea.app.emit("before-quit", { preventDefault() { throw Error("Linux quit unexpectedly cancelled"); } });
  assert.deepEqual(events, ["window"]); assert.equal(exited, false);
  ctx.ea.app.emit("will-quit", { preventDefault() {} });
  await tick(); assert.equal(final, false); assert.deepEqual(events.slice(0, 3), ["window", "hotkey", "dictation"]);
  assert.equal(events.includes("settings"), !skip);
  const quit = new Promise(resolve => ctx.ea.app.once("quit", resolve));
  child.emit("exit", 0); await quit;
  assert.equal(final, true); assert.equal(events.indexOf("context") > events.indexOf("dictation"), true);
  assert.equal(exited, true);
  await cleanup(ctx);
});

test("current native packaged Windows forced-exit guard stays before drains and obeys repeat guard", async () => {
  const ctx = context([]), events = [];
  ctx.process.platform = "win32"; ctx.ea.app.isPackaged = true;
  ctx.__loadForceAddon = () => ({ armTerminateCurrentProcess(ms) { assert.equal(ms, 10000); events.push("force"); } });
  ctx.installQuitLifecycle({ isWindows: true, hotkeyWindowLifecycleManager: { dispose() { events.push("hotkey"); } },
    globalDictationLifecycleManager: { dispose() { events.push("dictation"); } },
    flushAndDisposeContext: async () => { events.push("context"); } });
  const quit = new Promise(resolve => ctx.ea.app.once("quit", resolve));
  ctx.ea.app.emit("will-quit", { preventDefault() {} });
  ctx.ea.app.emit("will-quit", { preventDefault() {} });
  await quit; assert.deepEqual(events.slice(0, 3), ["force", "hotkey", "dictation"]);
  assert.equal(events.filter(item => item === "force").length, 1);
});

test("native allSettled accepts failed stop settlement and retains context timeout", async () => {
  const ctx = context([]); let settleStop, timeout, finished = false;
  const stopped = new Promise(resolve => { settleStop = resolve; });
  ctx.codexLinuxGlobalShortcutsPortalBackend = { stop: () => stopped };
  ctx.setTimeout = (callback, ms) => { assert.equal(ms, 5000); timeout = callback; return { id: "inert-context-timer" }; };
  ctx.clearTimeout = () => {};
  ctx.installQuitLifecycle({ flushAndDisposeContext: () => new Promise(() => {}), disposables: { dispose() { finished = true; } } });
  ctx.ea.app.emit("will-quit", { preventDefault() {} });
  await tick(); assert.equal(finished, false); assert.equal(timeout, undefined);
  settleStop(false); await tick(); assert.equal(finished, false); assert.equal(typeof timeout, "function");
  const quit = new Promise(resolve => ctx.ea.app.once("quit", resolve)); timeout(); await quit; assert.equal(finished, true);
});

for (const features of [{dictation: true}, {shortcuts: true}, {dictation: true, shortcuts: true}]) {
  test(`ordinary quit preserves KDE's approved action set: ${JSON.stringify(features)}`, async () => {
    let saved = new Set(), consent = 0;
    for (let run = 0; run < 2; run++) {
      const child = fakeHelperChild(), ctx = waylandPatchContext([child], features);
      const first = registerPortal(ctx, "Ctrl+Alt+G", {}, features.shortcuts ? "hotkeyWindow" : "globalDictationHold");
      const second = registerPortal(ctx, "Super+Alt+P", {}, features.shortcuts ? "openAvatarOverlay" : "globalDictationSingleTap");
      await spawned(ctx, 1);
      const ids = ctx.__spawns[0][1].filter((_arg, index) => index % 4 === 2);
      if (ids.some(id => !saved.has(id))) consent++;
      saved = new Set(ids);
      child.ready();
      await ctx.codexLinuxGlobalShortcutsPortalQueue;
      let marked = false;
      const windows = ctx.createWindowServices(
        {markAppQuitting() {
          assert.equal(child.killed, true, "stop must start before window cleanup can unregister actions");
          marked = true;
        }}, {markAppQuitting() {}}, {dispose() {}});
      assert.equal(first.ready(), true, "shortcuts remain usable until quit is accepted");
      windows.markAppQuitting();
      windows.markAppQuitting();
      assert.deepEqual(child.signals, ["SIGINT"], "repeated quit marking stops the session only once");
      first.unregister(); // The ordinary will-quit path disposes owners before its asynchronous drain.
      await tick();
      assert.equal(ctx.__spawns.length, 1, "ordinary quit must not bind the remaining Mini action");
      second.unregister();
      await ctx.codexLinuxGlobalShortcutsPortalQueue;
      assert.equal(marked, true);
      assert.equal(registerPortal(ctx, "Ctrl+Q", {}, "hotkeyWindow"), null);
    }
    assert.equal(consent, 1, "ordinary restarts preserve consent for the full action set");
  });

  test(`startup and shutdown preserve KDE's approved action set: ${JSON.stringify(features)}`, async () => {
    let saved = new Set(), consent = 0;
    for (let run = 0; run < 2; run++) {
      const child = fakeHelperChild(), ctx = waylandPatchContext([child], features);
      ctx.accessReady = false;
      const id = features.shortcuts ? "hotkeyWindow" : "globalDictationHold";
      const first = registerPortal(ctx, "Ctrl+Alt+G", {}, id);
      await tick();
      assert.equal(ctx.__spawns.length, 0, "loading access must not bind a partial startup set");
      ctx.accessListeners.add(() => registerPortal(ctx, "Super+Alt+P", {},
        features.shortcuts ? "openAvatarOverlay" : "globalDictationSingleTap"));
      ctx.publishAccess({codexLocalAccess: true, workCloudAccess: false, workLocalAccess: false});
      await spawned(ctx, 1);
      const ids = ctx.__spawns[0][1].filter((_arg, index) => index % 4 === 2);
      if (ids.some(action => !saved.has(action))) consent++;
      saved = new Set(ids); // KDE removes saved actions omitted from BindShortcuts.
      assert.equal(saved.size, 2);
      child.ready();
      await ctx.codexLinuxGlobalShortcutsPortalQueue;
      let finishFlush;
      await ctx.shutdownApp({
        hotkeyWindowLifecycleManager: {dispose: () => first.unregister()},
        globalDictationLifecycleManager: {dispose() {}},
        flushAndDisposeContext: async () => {
          await tick();
          assert.equal(ctx.__spawns.length, 1, "shutdown must not rebind the remaining action");
          finishFlush = true;
        },
        disposables: {dispose: () => {for (const r of ctx.codexLinuxGlobalShortcutsPortalRegistrations) r.unregister()}},
      });
      await ctx.codexLinuxGlobalShortcutsPortalQueue;
      assert.equal(finishFlush, true);
      assert.equal(child.killed, true);
      assert.equal(ctx.__spawns.length, 1);
      assert.equal(registerPortal(ctx, "Ctrl+Q", {}, id), null);
    }
    assert.equal(consent, 1, "unchanged actions require consent only on the first run");
  });
}

for (const ordinary of [false, true]) test(`shutdown cancels pending consent without registering queued actions: ordinary=${ordinary}`, async () => {
  const child = fakeHelperChild(), ctx = context([child]);
  registerPortal(ctx, "Ctrl+Alt+G", {}, "hotkeyWindow");
  await spawned(ctx, 1);
  registerPortal(ctx, "Super+Alt+P", {}, "openAvatarOverlay");
  if (ordinary) {
    ctx.createWindowServices({markAppQuitting() {}}, {markAppQuitting() {}}, {dispose() {}}).markAppQuitting();
  } else {
    await ctx.shutdownApp({hotkeyWindowLifecycleManager: {dispose() {}},
      globalDictationLifecycleManager: {dispose() {}}, flushAndDisposeContext: async () => {}, disposables: {dispose() {}}});
  }
  await ctx.codexLinuxGlobalShortcutsPortalQueue;
  assert.equal(child.killed, true);
  assert.equal(ctx.__spawns.length, 1);
});

test("validation uses the native parser before touching an active session", async () => {
  const child = fakeHelperChild(), ctx = context([child]);
  const popup = registerPortal(ctx, "Ctrl+Alt+G", {}, "hotkeyWindow");
  await spawned(ctx, 1);
  child.ready();
  await ctx.codexLinuxGlobalShortcutsPortalQueue;
  for (const key of ["Control+Alt+G", "Alt+Ctrl+G", "Ctrl+Unsupported"]) {
    assert.equal(registerPortal(ctx, key, {}, "openAvatarOverlay"), null);
    assert.equal(popup.ready(), true);
    assert.equal(child.killed, undefined);
  }
  assert.equal(ctx.__checks[0][1][0], "check");
  assert.equal(registerPortal(ctx, "Ctrl+G", {}, "unknownCommand"), null);
  assert.equal(ctx.__spawns.length, 1);
  await cleanup(ctx);
});

test("portal shortcut IDs stay stable so saved compositor bindings survive upgrades", async () => {
  const child = fakeHelperChild(), ctx = waylandPatchContext([child], { dictation: true, shortcuts: true });
  ctx.gestures = { press() {}, release() {}, cancelPress() {} };
  // Drive the patched dictation owner so its linuxCommandId tags feed the mapping.
  vm.runInNewContext('var dictation=new H7();dictation.shortcutGestures=gestures;' +
    'dictation.registerHotkeyOrThrow("Ctrl+Alt+D",{isOwner:()=>true});' +
    'dictation.registerToggleHotkeyOrThrow("Ctrl+Alt+T",{isOwner:()=>true})', ctx);
  for (const [id, key] of [["hotkeyWindow", "Ctrl+Alt+G"], ["openAvatarOverlay", "Super+Alt+P"],
    ["appshots", "Ctrl+Alt+A"], ["realtimeVoice", "Ctrl+Alt+V"], ["meetings", "Ctrl+Alt+M"]]) {
    assert.notEqual(registerPortal(ctx, key, {}, id), null);
  }
  await spawned(ctx, 1);
  const args = Array.from(ctx.__spawns[0][1]);
  const ids = args.flatMap((value, index) => args[index - 1] === "--shortcut" ? [value] : []);
  // Hold-to-talk was registered as `global-dictation` before the shared backend.
  assert.deepEqual(ids, ["global-dictation", "global-dictation-single-tap", "hotkeyWindow",
    "openAvatarOverlay", "appshots", "realtimeVoice", "meetings"]);
  assert.deepEqual(ctx.__checks.slice(0, 2).map(([, check]) => Array.from(check)), [
    ["check", "--shortcut", "global-dictation", "Dictation: hold to talk", "Ctrl+Alt+D"],
    ["check", "--shortcut", "global-dictation-single-tap", "Dictation: start / stop", "Ctrl+Alt+T"],
  ]);
  child.ready();
  vm.runInNewContext("dictation.deactivateLifecycle()", ctx);
  await cleanup(ctx);
});

test("an outdated staged helper is reported when validation is unsupported", () => {
  const ctx = context([]);
  ctx.__validate = () => Object.assign(new Error("Command failed"), { stderr: "unknown command: check\n" });
  const validate = ctx.__validate;
  ctx.__validate = () => { throw validate(); };
  assert.equal(registerPortal(ctx, "Ctrl+Alt+G", {}, "hotkeyWindow"), null);
  assert.equal(ctx.__warnings.some(([message]) => /helper is outdated/.test(message)), true);
  assert.equal(ctx.__spawns.length, 0);
});

test("same-tick registrations share one session and retain separate transitions", async () => {
  const child = fakeHelperChild(), ctx = context([child]);
  const presses = [0, 0], releases = [0, 0];
  registerPortal(ctx, "Ctrl+Alt+G", { onPressed: () => presses[0]++, onReleased: () => releases[0]++ }, "hotkeyWindow");
  registerPortal(ctx, "Super+Alt+P", { onPressed: () => presses[1]++, onReleased: () => releases[1]++ }, "openAvatarOverlay");
  await spawned(ctx, 1);
  assert.deepEqual(Array.from(ctx.__spawns[0][1]), ["portal", "--shortcut", "hotkeyWindow", "Open popout chat window", "Ctrl+Alt+G",
    "--shortcut", "openAvatarOverlay", "Show Mini / Pet", "Super+Alt+P"]);
  child.ready();
  child.stdout.emit("data", Buffer.from("down:0\ndown:0\nup:0\nup:0\ndown:1\nup:1\n"));
  assert.deepEqual(presses, [1, 1]);
  assert.deepEqual(releases, [1, 1]);
  await cleanup(ctx);
});

test("later registrations wait for consent, then rebind the accumulated set", async () => {
  const first = fakeHelperChild(), combined = fakeHelperChild(), ctx = context([first, combined]);
  registerPortal(ctx, "Ctrl+Alt+G", {}, "hotkeyWindow");
  await spawned(ctx, 1);
  registerPortal(ctx, "Super+Alt+P", {}, "openAvatarOverlay");
  await tick();
  assert.equal(first.killed, undefined);
  first.ready();
  await spawned(ctx, 2);
  assert.equal(first.killed, true);
  combined.ready();
  await ctx.codexLinuxGlobalShortcutsPortalQueue;
  await cleanup(ctx);
});

test("withdrawing the pending action cancels its dialog and releases the queue", async () => {
  const first = fakeHelperChild(), next = fakeHelperChild(), ctx = context([first, next]);
  const popup = registerPortal(ctx, "Ctrl+Alt+G", {}, "hotkeyWindow");
  await spawned(ctx, 1);
  registerPortal(ctx, "Super+Alt+P", {}, "openAvatarOverlay");
  popup.unregister();
  await spawned(ctx, 2);
  assert.equal(first.killed, true);
  assert.equal(next.shortcutCount, 1);
  next.ready();
  await ctx.codexLinuxGlobalShortcutsPortalQueue;
  await cleanup(ctx);
});

test("a withdrawn later request leaves the approved session in place", async () => {
  const child = fakeHelperChild(), ctx = context([child]);
  registerPortal(ctx, "Ctrl+Alt+G", {}, "hotkeyWindow");
  await spawned(ctx, 1);
  const pet = registerPortal(ctx, "Super+Alt+P", {}, "openAvatarOverlay");
  pet.unregister();
  child.ready();
  await ctx.codexLinuxGlobalShortcutsPortalQueue;
  assert.equal(child.killed, undefined);
  await cleanup(ctx);
});

test("partial approval and later system changes update only the affected actions", async () => {
  const child = fakeHelperChild(), ctx = context([child]);
  const failed = [];
  const popup = registerPortal(ctx, "Ctrl+Alt+G", {}, "hotkeyWindow");
  const pet = registerPortal(ctx, "Super+Alt+P", {onUnavailable: () => failed.push("pet")}, "openAvatarOverlay");
  await spawned(ctx, 1);
  child.ready([0]);
  await ctx.codexLinuxGlobalShortcutsPortalQueue;
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(popup.ready(), true);
  assert.equal(pet.ready(), false);
  assert.deepEqual(failed, []);
  child.ready([0, 1]);
  assert.equal(pet.ready(), true);
  assert.equal(ctx.__spawns.length, 1);
  await cleanup(ctx);
});

test("an unbound session keeps its action available for later system assignment", async () => {
  const child = fakeHelperChild(), ctx = context([child]);
  let failures = 0;
  const popup = registerPortal(ctx, "Ctrl+Alt+G", {onUnavailable: () => failures++}, "hotkeyWindow");
  await spawned(ctx, 1);
  child.ready([]);
  await ctx.codexLinuxGlobalShortcutsPortalQueue;
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(popup.ready(), false);
  assert.equal(failures, 0);
  assert.equal(child.killed, undefined);
  child.ready([0]);
  assert.equal(popup.ready(), true);
  assert.equal(ctx.__spawns.length, 1);
  await cleanup(ctx);
});

for (const [index, property, gesture] of [
  [0, "registeredHotkey", "primary"],
  [1, "registeredToggleHotkey", "single-tap"],
]) test(`dictation retains and restores an unbound action: ${gesture}`, async (t) => {
  const child = fakeHelperChild(), ctx = waylandPatchContext([child]);
  t.after(() => cleanup(ctx));
  ctx.Wl = () => false;
  const controller = vm.runInNewContext("new H7()", ctx);
  const events = [];
  controller.shortcutGestures = {
    press: name => events.push(`press:${name}`),
    release: name => events.push(`release:${name}`),
    cancelPress: name => events.push(`cancel:${name}`),
  };
  const owner = { isOwner: () => true };
  controller.registerHotkeyOrThrow("Ctrl+G", owner);
  controller.registerToggleHotkeyOrThrow("Ctrl+H", owner);
  const handle = controller[`${property}Registration`], hotkey = controller[property];
  await spawned(ctx, 1);
  const registrations = Array.from(ctx.codexLinuxGlobalShortcutsPortalRegistrations);
  const assertRetained = () => {
    assert.equal(controller[property], hotkey);
    assert.equal(controller[`${property}Registration`], handle);
    assert.equal(ctx.managerEntries.size, 2);
    assert.deepEqual(Array.from(ctx.codexLinuxGlobalShortcutsPortalRegistrations), registrations);
    assert.equal(ctx.__spawns.length, 1);
    assert.equal(child.killed, undefined);
  };
  child.ready([1 - index]);
  await ctx.codexLinuxGlobalShortcutsPortalQueue;
  await new Promise(resolve => setTimeout(resolve, 5));
  assertRetained();
  assert.equal(registrations[index].ready(), false);
  assert.equal(registrations[1 - index].ready(), true);

  child.ready();
  child.stdout.emit("data", Buffer.from(`down:${index}\n`));
  assert.deepEqual(events, [`press:${gesture}`]);
  child.ready([1 - index]);
  await new Promise(resolve => setTimeout(resolve, 5));
  assertRetained();
  assert.equal(registrations[index].ready(), false);
  assert.equal(registrations[1 - index].ready(), true);
  assert.deepEqual(events, [`press:${gesture}`, `cancel:${gesture}`]);
  child.stdout.emit("data", Buffer.from(`down:${index}\nup:${index}\n`));
  assert.equal(events.length, 2, "unbound actions must ignore press and release events");

  child.ready();
  assertRetained();
  assert.equal(registrations[index].ready(), true);
  child.stdout.emit("data", Buffer.from(`down:${index}\nup:${index}\n`));
  assert.deepEqual(events, [`press:${gesture}`, `cancel:${gesture}`, `press:${gesture}`, `release:${gesture}`]);
});

test("a failed candidate restores still-requested working actions once", async () => {
  const first = fakeHelperChild(), candidate = fakeHelperChild(), restored = fakeHelperChild();
  const ctx = context([first, candidate, restored]), failures = [];
  const popup = registerPortal(ctx, "Ctrl+Alt+G", {}, "hotkeyWindow");
  await spawned(ctx, 1); first.ready(); await ctx.codexLinuxGlobalShortcutsPortalQueue;
  registerPortal(ctx, "Super+Alt+P", {onUnavailable: () => failures.push("pet")}, "openAvatarOverlay");
  await spawned(ctx, 2);
  candidate.stderr.emit("data", Buffer.from("portal denied candidate"));
  candidate.emit("exit", 1);
  await spawned(ctx, 3);
  assert.equal(restored.shortcutCount, 1);
  restored.ready();
  await ctx.codexLinuxGlobalShortcutsPortalQueue;
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(popup.ready(), true);
  assert.deepEqual(failures, ["pet"]);
  restored.emit("exit", 1);
  await ctx.codexLinuxGlobalShortcutsPortalQueue;
  assert.equal(ctx.__spawns.length, 3);
  assert.equal(popup.ready(), false);
  await cleanup(ctx);
});

test("failed replacement never restores an explicitly withdrawn action", async () => {
  const first = fakeHelperChild(), candidate = fakeHelperChild(), ctx = context([first, candidate]);
  const popup = registerPortal(ctx, "Ctrl+Alt+G", {}, "hotkeyWindow");
  await spawned(ctx, 1); first.ready(); await ctx.codexLinuxGlobalShortcutsPortalQueue;
  registerPortal(ctx, "Super+Alt+P", {}, "openAvatarOverlay");
  await spawned(ctx, 2);
  popup.unregister();
  candidate.emit("exit", 1);
  await ctx.codexLinuxGlobalShortcutsPortalQueue;
  assert.equal(ctx.__spawns.length, 2);
  await cleanup(ctx);
});

test("capture waits for session release and resumes through the real registry lifecycle", async () => {
  const first = fakeHelperChild(), resumed = fakeHelperChild(), ctx = context([first, resumed]);
  let presses = 0, cancelled = 0;
  ctx.pressed = () => presses++;
  ctx.cancelled = () => cancelled++;
  const handle = vm.runInNewContext('eA("Ctrl+Alt+G",{linuxCommandId:"hotkeyWindow",onPressed:pressed,onCancelled:cancelled})', ctx);
  assert.equal(handle.handlesRelease, true);
  assert.equal(ctx.managerEntries.size, 1);
  await spawned(ctx, 1); first.ready(); await ctx.codexLinuxGlobalShortcutsPortalQueue;
  first.stdout.emit("data", Buffer.from("down\n"));
  assert.equal(presses, 1);
  first.kill = () => { first.killed = true; };
  ctx.origin = captureOrigin();
  let returned = false;
  const pending = vm.runInNewContext("new CaptureService(origin).beginCapture()", ctx).then(value => {returned = true; return value});
  await tick();
  assert.equal(returned, false);
  assert.equal(ctx.suspendDepth, 1);
  assert.equal(cancelled, 1);
  first.stdout.emit("data", Buffer.from("up\ndown\n"));
  assert.equal(presses, 1);
  first.emit("exit", 0);
  const capture = await pending;
  const nested = ctx.suspendGlobalHotkeys();
  capture[Symbol.dispose]();
  assert.equal(ctx.suspendDepth, 1);
  assert.equal(ctx.__spawns.length, 1);
  nested(); nested();
  await spawned(ctx, 2); resumed.ready(); await ctx.codexLinuxGlobalShortcutsPortalQueue;
  first.stdout.emit("data", Buffer.from("down\n"));
  resumed.stdout.emit("data", Buffer.from("down\n"));
  assert.equal(presses, 2);
  handle.unregister();
  assert.equal(ctx.managerEntries.size, 0);
  await cleanup(ctx);
});

test("capture cancelled during release restores the registration and returns no capture", async () => {
  const first = fakeHelperChild(), resumed = fakeHelperChild(), ctx = context([first, resumed]);
  const handle = vm.runInNewContext('eA("Ctrl+Alt+G",{linuxCommandId:"hotkeyWindow",onPressed(){}})', ctx);
  await spawned(ctx, 1); first.ready(); await ctx.codexLinuxGlobalShortcutsPortalQueue;
  first.kill = () => {};
  ctx.origin = captureOrigin();
  const pending = vm.runInNewContext("new CaptureService(origin).beginCapture()", ctx);
  ctx.origin.window.isFocused = () => false;
  ctx.origin.window.emit("blur");
  first.emit("exit", 0);
  assert.equal(await pending, null);
  await spawned(ctx, 2); resumed.ready(); await ctx.codexLinuxGlobalShortcutsPortalQueue;
  assert.equal(ctx.suspendDepth, 0);
  handle.unregister(); await cleanup(ctx);
});

test("a synchronous spawn failure releases the queue for a subsequent action", async () => {
  const ctx = context([]);
  const first = registerPortal(ctx, "Ctrl+Alt+G", {}, "hotkeyWindow");
  await ctx.codexLinuxGlobalShortcutsPortalQueue;
  assert.equal(first.ready(), false);
  await cleanup(ctx);
});

for (const failure of ["timeout", "spawn", "invalid-report"]) {
  test(`${failure} releases a pending request and allows the next action`, async () => {
    const first = fakeHelperChild(), next = fakeHelperChild(), ctx = context([first, next]);
    const timers = [], failures = [];
    ctx.setTimeout = (callback, ms) => {
      const timer = setTimeout(callback, ms);
      if (ms === 30000) timers.push(callback);
      return timer;
    };
    registerPortal(ctx, "Ctrl+Alt+G", {onUnavailable: () => failures.push("popup")}, "hotkeyWindow");
    await spawned(ctx, 1);
    const pet = registerPortal(ctx, "Super+Alt+P", {}, "openAvatarOverlay");
    if (failure === "timeout") timers[0]();
    else if (failure === "spawn") first.emit("error", new Error("spawn failed"));
    else first.stdout.emit("data", Buffer.from("bindings\nbound:999:invalid\n"));
    await spawned(ctx, 2); next.ready(); await ctx.codexLinuxGlobalShortcutsPortalQueue;
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(pet.ready(), true);
    assert.deepEqual(failures, ["popup"]);
    await cleanup(ctx);
  });
}

// The portal closes a session together with its D-Bus connection, so any helper
// exit releases the bindings; only a helper that may still be alive blocks capture.
for (const [exit, kill] of [
  ["SIGKILL after the grace period", (child, signal) => signal === "SIGKILL" && setImmediate(() => child.emit("exit", null, "SIGKILL"))],
  ["SIGINT default disposition", (child, signal) => setImmediate(() => child.emit("exit", null, signal))],
  ["a nonzero exit code", (child) => setImmediate(() => child.emit("exit", 1, null))],
]) test(`a helper terminated by ${exit} releases its session for capture`, async () => {
  const first = fakeHelperChild(), resumed = fakeHelperChild(), ctx = context([first, resumed]);
  const handle = vm.runInNewContext('eA("Ctrl+Alt+G",{linuxCommandId:"hotkeyWindow",onPressed(){}})', ctx);
  await spawned(ctx, 1); first.ready(); await ctx.codexLinuxGlobalShortcutsPortalQueue;
  let force;
  ctx.setTimeout = (callback, ms) => {
    const timer = setTimeout(callback, ms);
    if (ms === 2000) force = callback;
    return timer;
  };
  const signals = [];
  first.kill = signal => { signals.push(signal); kill(first, signal); return true; };
  ctx.origin = captureOrigin();
  const pending = vm.runInNewContext("new CaptureService(origin).beginCapture()", ctx);
  await tick();
  if (signals.at(-1) === "SIGINT" && exit.startsWith("SIGKILL")) force();
  const capture = await pending;
  assert.notEqual(capture, null);
  assert.deepEqual(signals, exit.startsWith("SIGKILL") ? ["SIGINT", "SIGKILL"] : ["SIGINT"]);
  assert.equal(ctx.suspendDepth, 1);
  assert.equal(ctx.__warnings.some(([message]) => /Unable to prepare shortcut capture/.test(message)), false);
  capture[Symbol.dispose]();
  await spawned(ctx, 2); resumed.ready(); await ctx.codexLinuxGlobalShortcutsPortalQueue;
  assert.equal(handle.handlesRelease, true);
  handle.unregister(); await cleanup(ctx);
});

test("a helper that is already gone is not signalled again and releases capture", async () => {
  const first = fakeHelperChild(), recovered = fakeHelperChild(), ctx = context([first, recovered]);
  const handle = vm.runInNewContext('eA("Ctrl+Alt+G",{linuxCommandId:"hotkeyWindow",onPressed(){}})', ctx);
  await spawned(ctx, 1); first.ready(); await ctx.codexLinuxGlobalShortcutsPortalQueue;
  first.emit("exit", null, "SIGTERM");
  await spawned(ctx, 2);
  assert.deepEqual(first.signals, undefined);
  recovered.ready(); await ctx.codexLinuxGlobalShortcutsPortalQueue;
  recovered.kill = signal => { (recovered.signals ??= []).push(signal); setImmediate(() => recovered.emit("exit", null, "SIGINT")); return true; };
  await ctx.codexLinuxGlobalShortcutsPortalPause();
  assert.deepEqual(recovered.signals, ["SIGINT"]);
  handle.unregister(); await cleanup(ctx);
});

test("a helper that may still hold its session blocks capture", async () => {
  const first = fakeHelperChild(), resumed = fakeHelperChild(), ctx = context([first, resumed]);
  const handle = vm.runInNewContext('eA("Ctrl+Alt+G",{linuxCommandId:"hotkeyWindow",onPressed(){}})', ctx);
  await spawned(ctx, 1); first.ready(); await ctx.codexLinuxGlobalShortcutsPortalQueue;
  first.kill = () => { throw new Error("EPERM"); };
  ctx.origin = captureOrigin();
  assert.equal(await vm.runInNewContext("new CaptureService(origin).beginCapture()", ctx), null);
  assert.equal(ctx.suspendDepth, 0);
  await spawned(ctx, 2); resumed.ready(); await ctx.codexLinuxGlobalShortcutsPortalQueue;
  handle.unregister(); await cleanup(ctx);
});

test("paste errors are isolated from shortcut registration", async () => {
  const child = fakeHelperChild(), ctx = context([child]);
  registerPortal(ctx, "Ctrl+Alt+G", {}, "hotkeyWindow");
  await spawned(ctx, 1); child.ready(); await ctx.codexLinuxGlobalShortcutsPortalQueue;
  const paste = ctx.codexLinuxGlobalShortcutsPaste();
  await assert.rejects(ctx.codexLinuxGlobalShortcutsPaste(), /already pending/);
  child.stdout.emit("data", Buffer.from("paste-error:permission denied\n"));
  await assert.rejects(paste, /permission denied/);
  const retry = ctx.codexLinuxGlobalShortcutsPaste();
  child.stdout.emit("data", Buffer.from("paste-ok\n"));
  await retry;
  assert.equal(ctx.codexLinuxGlobalShortcutsPortalBackend.ready, true);
  await cleanup(ctx);
});

test("paste timeout retires its helper before another paste can consume a late reply", async () => {
  const first = fakeHelperChild(), recovered = fakeHelperChild(), ctx = context([first, recovered]);
  let timeout;
  ctx.setTimeout = (callback, ms) => {
    const timer = setTimeout(callback, ms);
    if (ms === 35000) timeout = callback;
    return timer;
  };
  registerPortal(ctx, "Ctrl+Alt+G", {}, "hotkeyWindow");
  await spawned(ctx, 1); first.ready(); await ctx.codexLinuxGlobalShortcutsPortalQueue;
  const pending = ctx.codexLinuxGlobalShortcutsPaste();
  const rejected = assert.rejects(pending, /timed out/);
  timeout();
  await rejected;
  await spawned(ctx, 2); recovered.ready(); await ctx.codexLinuxGlobalShortcutsPortalQueue;
  let completed = false;
  const retry = ctx.codexLinuxGlobalShortcutsPaste().then(() => { completed = true; });
  first.stdout.emit("data", Buffer.from("paste-ok\n"));
  await tick();
  assert.equal(completed, false);
  recovered.stdout.emit("data", Buffer.from("paste-ok\n"));
  await retry;
  await cleanup(ctx);
});

function delayedExitChild() {
  const child = fakeHelperChild();
  child.signals = [];
  child.kill = signal => { child.signals.push(signal); return true; };
  child.finish = (code = 0, signal = null) => child.emit("exit", code, signal);
  return child;
}

function controlledTimers(ctx) {
  const timers = new Set();
  ctx.setTimeout = (callback, milliseconds) => {
    const timer = { callback, milliseconds, unref() {} };
    timers.add(timer);
    return timer;
  };
  ctx.clearTimeout = timer => timers.delete(timer);
  return timers;
}

test("paste aborted before write leaves its ready helper and clipboard transport untouched", async t => {
  const child = fakeHelperChild(), ctx = context([child]);
  t.after(() => cleanup(ctx));
  registerPortal(ctx, "Ctrl+Alt+G", {}, "hotkeyWindow");
  await spawned(ctx, 1); child.ready(); await ctx.codexLinuxGlobalShortcutsPortalQueue;
  const signal = new AbortController(), reason = new Error("cancel before paste");
  signal.abort(reason);
  await assert.rejects(ctx.codexLinuxGlobalShortcutsPaste(signal.signal), error => error === reason);
  assert.deepEqual(child.stdin.writes, []);
  assert.deepEqual(child.signals ?? [], []);
  assert.equal(ctx.codexLinuxGlobalShortcutsPortalBackend.ready, true);
});

test("soft paste abort joins normal stop and capture until observed exit without a hard timer", async t => {
  const first = delayedExitChild(), fresh = fakeHelperChild(), ctx = context([first, fresh]);
  const timers = controlledTimers(ctx);
  t.after(async () => { first.finish(); await cleanup(ctx); });
  let cancelled = 0;
  registerPortal(ctx, "Ctrl+Alt+G", { onCancelled: () => cancelled++ }, "hotkeyWindow");
  await spawned(ctx, 1); first.ready(); await ctx.codexLinuxGlobalShortcutsPortalQueue;
  first.stdout.emit("data", Buffer.from("down\n"));
  const controller = new AbortController(), reason = new Error("cancel pending paste");
  let settled = false;
  const paste = ctx.codexLinuxGlobalShortcutsPaste(controller.signal);
  paste.then(() => { settled = true; }, () => { settled = true; });
  const rejected = assert.rejects(paste, error => error === reason);
  const oldTimeout = [...timers].find(timer => timer.milliseconds === 35000);
  controller.abort(reason);
  let pauseFinished = false;
  const paused = ctx.codexLinuxGlobalShortcutsPortalPause().then(() => { pauseFinished = true; });
  const ordinaryStop = ctx.codexLinuxGlobalShortcutsPortalBackend.stop(new Error("normal reconfigure"));
  oldTimeout.callback();
  await tick();
  first.stdout.emit("data", Buffer.from("paste-ok\n"));
  await tick();
  assert.deepEqual(first.signals, ["SIGINT"]);
  assert.equal([...timers].some(timer => timer.milliseconds === 2000), false);
  assert.equal(settled, false);
  assert.equal(pauseFinished, false);
  assert.equal(cancelled, 1);
  assert.equal(ctx.__spawns.length, 1);
  await assert.rejects(ctx.codexLinuxGlobalShortcutsPaste(), /No ready/);
  first.finish();
  await rejected; await paused; assert.equal(await ordinaryStop, true);
  await spawned(ctx, 2); fresh.ready(); await ctx.codexLinuxGlobalShortcutsPortalQueue;
  let replacementFinished = false;
  const replacement = ctx.codexLinuxGlobalShortcutsPaste().then(() => { replacementFinished = true; });
  first.stdout.emit("data", Buffer.from("paste-ok\n"));
  controller.signal.dispatchEvent(new Event("abort"));
  await tick();
  assert.equal(replacementFinished, false);
  assert.deepEqual(first.signals, ["SIGINT"]);
  fresh.stdout.emit("data", Buffer.from("paste-ok\n"));
  await replacement;
});

test("soft paste retirement restores all current intent including unbound and new actions", async t => {
  const first = delayedExitChild(), fresh = fakeHelperChild(), ctx = context([first, fresh]);
  controlledTimers(ctx);
  t.after(async () => { first.finish(); await cleanup(ctx); });
  const unavailable = [];
  const add = (key, id) => registerPortal(ctx, key, { onUnavailable: () => unavailable.push(id) }, id);
  const approved = add("Ctrl+Alt+A", "hotkeyWindow");
  const unbound = add("Ctrl+Alt+B", "meetings");
  const withdrawn = add("Ctrl+Alt+D", "openAvatarOverlay");
  await spawned(ctx, 1); first.ready([0, 2]); await ctx.codexLinuxGlobalShortcutsPortalQueue;
  assert.equal(unbound.ready(), false);
  const controller = new AbortController(), reason = new Error("replace paste helper");
  const paste = ctx.codexLinuxGlobalShortcutsPaste(controller.signal);
  const rejected = assert.rejects(paste, error => error === reason);
  controller.abort(reason);
  const added = add("Ctrl+Alt+C", "realtimeVoice");
  withdrawn.unregister();
  await tick();
  assert.equal(ctx.__spawns.length, 1);
  first.finish(); await rejected;
  await spawned(ctx, 2);
  assert.deepEqual(Array.from(ctx.__spawns[1][1]).filter((_, index) => index >= 2 && (index - 2) % 4 === 0),
    ["hotkeyWindow", "meetings", "realtimeVoice"]);
  fresh.ready([0, 2]); await ctx.codexLinuxGlobalShortcutsPortalQueue;
  assert.equal(approved.ready(), true);
  assert.equal(added.ready(), true);
  assert.equal(unbound.ready(), false);
  assert.equal(unbound.failed, false);
  assert.equal(ctx.codexLinuxGlobalShortcutsPortalRegistrations.has(unbound), true);
  assert.deepEqual(unavailable, []);
});

test("failed soft SIGINT keeps safe completion fenced until a later real exit", async t => {
  const first = delayedExitChild(), fresh = fakeHelperChild(), ctx = context([first, fresh]);
  const timers = controlledTimers(ctx);
  first.kill = signal => { first.signals.push(signal); throw new Error("signal denied"); };
  t.after(async () => { first.finish(); await cleanup(ctx); });
  registerPortal(ctx, "Ctrl+Alt+G", {}, "hotkeyWindow");
  await spawned(ctx, 1); first.ready(); await ctx.codexLinuxGlobalShortcutsPortalQueue;
  const controller = new AbortController(), reason = new Error("cancel while stuck");
  let completed = false;
  const paste = ctx.codexLinuxGlobalShortcutsPaste(controller.signal);
  paste.then(() => { completed = true; }, () => { completed = true; });
  const rejected = assert.rejects(paste, error => error === reason);
  controller.abort(reason);
  let stopped = false;
  const joined = ctx.codexLinuxGlobalShortcutsPortalBackend.stop(new Error("ordinary stop"))
    .then(value => { stopped = true; return value; });
  await tick();
  assert.equal(completed, false);
  assert.equal(stopped, false);
  assert.equal(ctx.__spawns.length, 1);
  assert.equal([...timers].some(timer => timer.milliseconds === 2000), false);
  assert.equal(ctx.__warnings.some(args => String(args[0]).includes("no observed exit")), true);
  first.finish(); await rejected; assert.equal(await joined, true);
  await spawned(ctx, 2); fresh.ready(); await ctx.codexLinuxGlobalShortcutsPortalQueue;
});

test("false ordinary stop status cannot settle a written paste before observed exit", async t => {
  const first = delayedExitChild(), fresh = fakeHelperChild(), ctx = context([first, fresh]);
  controlledTimers(ctx);
  first.kill = signal => { first.signals.push(signal); throw new Error("stop failed"); };
  t.after(async () => { first.finish(); await cleanup(ctx); });
  registerPortal(ctx, "Ctrl+Alt+G", {}, "hotkeyWindow");
  await spawned(ctx, 1); first.ready(); await ctx.codexLinuxGlobalShortcutsPortalQueue;
  let completed = false;
  const paste = ctx.codexLinuxGlobalShortcutsPaste();
  paste.then(() => { completed = true; }, () => { completed = true; });
  const rejected = assert.rejects(paste, /test stop/);
  const status = await ctx.codexLinuxGlobalShortcutsPortalBackend.stop(new Error("test stop"));
  assert.equal(status, false);
  await tick();
  assert.equal(completed, false);
  assert.equal(ctx.__spawns.length, 1);
  first.finish(); await rejected;
  await spawned(ctx, 2); fresh.ready(); await ctx.codexLinuxGlobalShortcutsPortalQueue;
});

test("only real shutdown upgrades a soft retirement to the existing hard watchdog", async t => {
  const first = delayedExitChild(), ctx = context([first]);
  const timers = controlledTimers(ctx);
  t.after(async () => { first.finish(); await cleanup(ctx); });
  let cancelled = 0;
  registerPortal(ctx, "Ctrl+Alt+G", { onCancelled: () => cancelled++ }, "hotkeyWindow");
  await spawned(ctx, 1); first.ready(); await ctx.codexLinuxGlobalShortcutsPortalQueue;
  first.stdout.emit("data", Buffer.from("down\n"));
  const controller = new AbortController(), reason = new Error("cancel before quit");
  let completed = false;
  const paste = ctx.codexLinuxGlobalShortcutsPaste(controller.signal);
  paste.then(() => { completed = true; }, () => { completed = true; });
  const rejected = assert.rejects(paste, error => error === reason);
  controller.abort(reason);
  const shutdown = ctx.codexLinuxGlobalShortcutsPortalShutdown();
  assert.equal(ctx.codexLinuxGlobalShortcutsPortalShutdown(), shutdown);
  const hardTimers = [...timers].filter(timer => timer.milliseconds === 2000);
  assert.equal(hardTimers.length, 1);
  assert.deepEqual(first.signals, ["SIGINT"]);
  hardTimers[0].callback();
  await tick();
  assert.deepEqual(first.signals, ["SIGINT", "SIGKILL"]);
  assert.equal(completed, false);
  assert.equal(cancelled, 1);
  first.finish(null, "SIGKILL");
  await rejected; assert.equal(await shutdown, true);
  await ctx.codexLinuxGlobalShortcutsPortalQueue;
  assert.equal(ctx.__spawns.length, 1);
  assert.equal(ctx.__warnings.some(args => String(args[0]).includes("input may already")), true);
});

test("abort reentered during stdin write takes the sent-request exit barrier", async t => {
  const first = delayedExitChild(), fresh = fakeHelperChild(), ctx = context([first, fresh]);
  controlledTimers(ctx);
  t.after(async () => { first.finish(); await cleanup(ctx); });
  registerPortal(ctx, "Ctrl+Alt+G", {}, "hotkeyWindow");
  await spawned(ctx, 1); first.ready(); await ctx.codexLinuxGlobalShortcutsPortalQueue;
  const controller = new AbortController();
  const write = first.stdin.write;
  first.stdin.write = function(value, callback) {
    const result = write.call(this, value, callback);
    controller.abort(null);
    return result;
  };
  let completed = false;
  const paste = ctx.codexLinuxGlobalShortcutsPaste(controller.signal);
  paste.then(() => { completed = true; }, () => { completed = true; });
  const rejected = assert.rejects(paste, error => error === null);
  await tick();
  assert.deepEqual(first.stdin.writes, ["paste\n"]);
  assert.deepEqual(first.signals, ["SIGINT"]);
  assert.equal(completed, false);
  first.finish(); await rejected;
  await spawned(ctx, 2); fresh.ready(); await ctx.codexLinuxGlobalShortcutsPortalQueue;
});

test("a completed paste removes its old abort listener", async t => {
  const child = fakeHelperChild(), ctx = context([child]);
  t.after(() => cleanup(ctx));
  registerPortal(ctx, "Ctrl+Alt+G", {}, "hotkeyWindow");
  await spawned(ctx, 1); child.ready(); await ctx.codexLinuxGlobalShortcutsPortalQueue;
  const controller = new AbortController();
  const paste = ctx.codexLinuxGlobalShortcutsPaste(controller.signal);
  child.stdout.emit("data", Buffer.from("paste-ok\n"));
  await paste;
  controller.abort(); await tick();
  assert.deepEqual(child.signals ?? [], []);
  assert.equal(ctx.codexLinuxGlobalShortcutsPortalBackend.ready, true);
  assert.equal(ctx.__spawns.length, 1);
});

test("soft retirement rechecks account access before restoring current intent", async t => {
  const first = delayedExitChild(), fresh = fakeHelperChild(), ctx = context([first, fresh]);
  controlledTimers(ctx);
  t.after(async () => { first.finish(); await cleanup(ctx); });
  const registration = registerPortal(ctx, "Ctrl+Alt+G", {}, "hotkeyWindow");
  await spawned(ctx, 1); first.ready(); await ctx.codexLinuxGlobalShortcutsPortalQueue;
  const controller = new AbortController();
  const paste = ctx.codexLinuxGlobalShortcutsPaste(controller.signal);
  const rejected = assert.rejects(paste);
  controller.abort();
  ctx.accessReady = false;
  first.finish(); await rejected; await ctx.codexLinuxGlobalShortcutsPortalQueue;
  assert.equal(ctx.__spawns.length, 1);
  assert.equal(ctx.codexLinuxGlobalShortcutsPortalRegistrations.has(registration), true);
  ctx.publishAccess({});
  await spawned(ctx, 2); fresh.ready(); await ctx.codexLinuxGlobalShortcutsPortalQueue;
  assert.equal(registration.ready(), true);
});

test("native shortcut capture joins an existing soft paste retirement", async t => {
  const first = delayedExitChild(), fresh = fakeHelperChild(), ctx = context([first, fresh]);
  const timers = controlledTimers(ctx);
  const handle = vm.runInNewContext('eA("Ctrl+Alt+G",{linuxCommandId:"hotkeyWindow",onPressed(){}})', ctx);
  let pendingCapture;
  t.after(async () => {
    first.finish();
    const capture = pendingCapture ? await pendingCapture : null;
    capture?.[Symbol.dispose]();
    handle.unregister();
    await cleanup(ctx);
  });
  await spawned(ctx, 1); first.ready(); await ctx.codexLinuxGlobalShortcutsPortalQueue;
  const controller = new AbortController();
  const paste = ctx.codexLinuxGlobalShortcutsPaste(controller.signal);
  const rejected = assert.rejects(paste);
  controller.abort();
  ctx.origin = captureOrigin();
  let returned = false;
  pendingCapture = vm.runInNewContext("new CaptureService(origin).beginCapture()", ctx)
    .then(capture => { returned = true; return capture; });
  await tick();
  assert.equal(returned, false);
  assert.equal(ctx.suspendDepth, 1);
  assert.deepEqual(first.signals, ["SIGINT"]);
  assert.equal([...timers].some(timer => timer.milliseconds === 2000), false);
  first.finish(); await rejected;
  const capture = await pendingCapture;
  assert.ok(capture);
  assert.equal(ctx.__spawns.length, 1);
  capture[Symbol.dispose]();
  await spawned(ctx, 2); fresh.ready(); await ctx.codexLinuxGlobalShortcutsPortalQueue;
  assert.equal(ctx.suspendDepth, 0);
});
