#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");

const { applyQuitConfirmationFocus } = require("./patch.js");

// This shape comes from the signed official Linux main bundle. Keep the
// fixture independent of patch.js so upstream confirmation drift is visible.
const OFFICIAL_BUNDLE =
  "function qrt({isWindows:e,quitState:r,windows:i}){" +
  "let S=!1;l.app.on(`before-quit`,o=>{if(e||r.canQuitWithoutPrompt()){S=!0,i.markAppQuitting();return}" +
  "if(l.dialog.showMessageBoxSync({message:`Quit?`,buttons:[{messageId:`desktop.quitConfirmation.quit`},`Cancel`]})!==0){o.preventDefault();return}" +
  "r.markQuitApproved(),S=!0,i.markAppQuitting()})," +
  "l.app.on(`will-quit`,t=>{Promise.allSettled([flush(),save()]).then(()=>l.app.quit())})}" +
  "function next(){}";

function window(id, visible = true) {
  return { id, isDestroyed: () => false, isVisible: () => visible };
}

function harness({ focused = window(7), primary = window(3), others = [] } = {}) {
  const handlers = new Map();
  const dialogCalls = [];
  const errors = [];
  let resolveDialog;
  let prevented = 0;
  let accepted = 0;
  let quitCalls = 0;
  let approved = false;
  const emitBeforeQuit = () => {
    const event = { preventDefault: () => { prevented++; } };
    for (const handler of handlers.get("before-quit") ?? []) handler(event);
  };
  const context = {
    Promise,
    console: { error: (...args) => errors.push(args) },
    require: (name) => {
      assert.equal(name, "electron");
      return { BrowserWindow: {
        getFocusedWindow: () => focused,
        getAllWindows: () => others,
      } };
    },
    l: {
      app: {
        on: (name, callback) => handlers.set(name, [...handlers.get(name) ?? [], callback]),
        quit: () => { quitCalls++; emitBeforeQuit(); },
      },
      dialog: {
        showMessageBoxSync: () => { throw new Error("synchronous dialog must not run"); },
        showMessageBox: (...args) => {
          dialogCalls.push(args);
          return new Promise((resolve) => { resolveDialog = resolve; });
        },
      },
    },
  };
  const register = vm.runInNewContext(`${applyQuitConfirmationFocus(OFFICIAL_BUNDLE)};qrt`, context);
  register({
    isWindows: false,
    quitState: {
      canQuitWithoutPrompt: () => approved,
      markQuitApproved: () => { approved = true; },
    },
    windows: {
      windowManager: { getPrimaryWindow: () => primary },
      markAppQuitting: () => { accepted++; },
    },
  });
  return {
    emitBeforeQuit,
    dialogCalls,
    errors,
    answer: (response) => resolveDialog({ response }),
    get prevented() { return prevented; },
    get accepted() { return accepted; },
    get quitCalls() { return quitCalls; },
  };
}

const tick = () => new Promise(setImmediate);

test("patches only the official confirmation and is idempotent", () => {
  const patched = applyQuitConfirmationFocus(OFFICIAL_BUNDLE);
  assert.match(patched, /codexLinuxQuitDialogParent\(i\)/);
  assert.match(patched, /dialog\.showMessageBox\(codexLinuxParent,/);
  assert.doesNotMatch(patched, /showMessageBoxSync\(/);
  assert.match(patched, /Promise\.allSettled\(\[flush\(\),save\(\)\]\)/);
  assert.equal(applyQuitConfirmationFocus(patched), patched);
  new vm.Script(patched);
});

test("fails closed when the official Quit confirmation changes", () => {
  assert.throws(
    () => applyQuitConfirmationFocus(OFFICIAL_BUNDLE.replace("showMessageBoxSync", "showMessageBox")),
    /Expected one official synchronous Quit confirmation/,
  );
  assert.throws(
    () => applyQuitConfirmationFocus(OFFICIAL_BUNDLE.replace("quitState:r", "quitStateChanged:r")),
    /Official Quit binding changed: quitState/,
  );
  assert.throws(
    () => applyQuitConfirmationFocus(OFFICIAL_BUNDLE.replace("markQuitApproved", "approveQuit")),
    /Expected one official synchronous Quit confirmation/,
  );
});

test("focuses the confirmation and resumes official Quit on approval", async () => {
  const app = harness();
  app.emitBeforeQuit();
  assert.equal(app.prevented, 1);
  assert.equal(app.dialogCalls.length, 0);
  await tick();
  assert.equal(app.dialogCalls.length, 1);
  assert.equal(app.dialogCalls[0][0].id, 7);
  assert.equal(app.dialogCalls[0][1].message, "Quit?");
  app.emitBeforeQuit();
  assert.equal(app.prevented, 2);
  assert.equal(app.dialogCalls.length, 1);
  app.answer(0);
  await tick();
  assert.equal(app.quitCalls, 1);
  assert.equal(app.accepted, 1);
  assert.deepEqual(app.errors, []);
});

test("uses the visible primary window and allows a later Quit after cancellation", async () => {
  const app = harness({ focused: null });
  app.emitBeforeQuit();
  await tick();
  assert.equal(app.dialogCalls[0][0].id, 3);
  app.answer(1);
  await tick();
  assert.equal(app.quitCalls, 0);
  assert.equal(app.accepted, 0);
  app.emitBeforeQuit();
  await tick();
  assert.equal(app.dialogCalls.length, 2);
  app.answer(0);
  await tick();
  assert.equal(app.accepted, 1);
});

test("falls back to another visible window when the primary is unavailable", async () => {
  const app = harness({ focused: null, primary: null, others: [window(4, false), window(5)] });
  app.emitBeforeQuit();
  await tick();
  assert.equal(app.dialogCalls[0][0].id, 5);
  app.answer(1);
  await tick();
  assert.equal(app.accepted, 0);
});
