"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");
const {
  applyQuitConfirmationFocusPatch,
  descriptors,
  findQuitLifecycleContract,
} = require("./patch.js");

function currentBundleShape(name = "install") {
  return "class QuitState{allowQuitWithoutPrompt=!1;" +
    "canQuitWithoutPrompt(){return this.allowQuitWithoutPrompt}" +
    "markQuitApproved(){this.allowQuitWithoutPrompt=!0}" +
    "shouldSkipDrainBeforeQuit(){return!1}}" +
    `${name}=function({isWindows:a,quitState:b,windows:c,applicationMenuManager:d,` +
    "ensureWindow:e,hotkeyWindowLifecycleManager:f,globalDictationLifecycleManager:g," +
    "globalState:h,settingsStore:i,stopCodexMicro:j,flushTracingBeforeQuit:k," +
    "flushAndDisposeContext:l,disposables:m,appEvent:n,onAppEntrySource:o," +
    "canAttributeAppReactivation:p}){let q=!1,r=!1;" +
    "u.app.on(\"before-quit\",e=>{privacy()?(r=!0,c.markAppQuitting()):e.preventDefault()})," +
    "u.app.on(\"will-quit\",e=>{q=!0})}";
}

function runBeforeQuit(source, { approved = false, privacy = false } = {}) {
  const listeners = new Map();
  const sandbox = {
    install: null,
    privacy: () => privacy,
    u: { app: { on: (name, callback) => listeners.set(name, callback) } },
  };
  vm.runInNewContext(source, sandbox);
  let marked = 0;
  sandbox.install({
    quitState: { canQuitWithoutPrompt: () => approved },
    windows: { markAppQuitting: () => { marked += 1; } },
  });
  let prevented = 0;
  listeners.get("before-quit")({ preventDefault: () => { prevented += 1; } });
  return { marked, prevented };
}

test("registers a required upstream main-bundle patch", () => {
  assert.deepEqual(
    descriptors.map(({ id, phase, ciPolicy }) => [id, phase, ciPolicy]),
    [["quit-confirmation-focus", "main-bundle", "required-upstream"]],
  );
});

test("approved quit is consumed by the unique before-quit owner", () => {
  const source = currentBundleShape();
  assert.equal(findQuitLifecycleContract(source).approvalConsumed, false);

  const patched = applyQuitConfirmationFocusPatch(source);
  assert.notEqual(patched, source);
  assert.equal(findQuitLifecycleContract(patched).approvalConsumed, true);
  assert.equal(applyQuitConfirmationFocusPatch(patched), patched);

  assert.deepEqual(runBeforeQuit(patched), { marked: 0, prevented: 1 });
  assert.deepEqual(runBeforeQuit(patched, { approved: true }), { marked: 1, prevented: 0 });
  assert.deepEqual(runBeforeQuit(patched, { privacy: true }), { marked: 1, prevented: 0 });
});

test("missing, ambiguous, and drifted lifecycle owners fail closed", () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (warning) => warnings.push(warning);
  try {
    const unrelated = "const officialMain=true;";
    assert.equal(applyQuitConfirmationFocusPatch(unrelated), unrelated);

    const ambiguous = currentBundleShape() + currentBundleShape("installAgain");
    assert.equal(applyQuitConfirmationFocusPatch(ambiguous), ambiguous);

    const drifted = currentBundleShape().replace("e.preventDefault()", "e.stopPropagation()");
    assert.equal(applyQuitConfirmationFocusPatch(drifted), drifted);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 3);
  assert.ok(warnings.every((warning) => warning.includes("before-quit owner")));
});
