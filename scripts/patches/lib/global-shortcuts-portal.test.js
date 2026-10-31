"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const vm = require("node:vm");
const { fakeHelperChild, waylandPatchContext, registerPortal, mainBundleFixture } = require("./global-shortcuts-portal.test-helpers.js");
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
    source.replace('status:"loading"', 'status:"pending"'), source.replace("flushAndDisposeContext:r", "flushContext:r"),
    source.replace("markAppQuitting:()=>", "markQuitting:()=>"),
    source.replace("null!=e&&clearPendingUpdate(e)", "clearPendingUpdate(e)")]) {
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
  assert.throws(() => registrationContract(retiredMinifier), /registration function matched 0 times/);
});

test("shared backend installs into the rspack module that owns the registration function", () => {
  const source = mainBundleFixture();
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
  const accessEnd = source.indexOf("async function shutdownApp(");
  const split = chunk(source.slice(0, accessStart) + source.slice(accessEnd), source.slice(accessStart, accessEnd));
  assert.throws(() => installPortalBackend(split), /application access readiness is outside the global shortcut module/);
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
