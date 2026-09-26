#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
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

function window(id, { destroyed = false, visible = true } = {}) {
  return {
    id,
    isDestroyed: () => destroyed,
    isVisible: () => visible,
  };
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
    const event = { preventDefault: () => { prevented += 1; } };
    for (const handler of handlers.get("before-quit") ?? []) {
      handler(event);
    }
  };
  const context = {
    Promise,
    console: { error: (...args) => errors.push(args) },
    require: (name) => {
      assert.equal(name, "electron");
      return {
        BrowserWindow: {
          getFocusedWindow: () => focused,
          getAllWindows: () => others,
        },
      };
    },
    l: {
      app: {
        on: (name, callback) => handlers.set(name, [...handlers.get(name) ?? [], callback]),
        quit: () => {
          quitCalls += 1;
          emitBeforeQuit();
        },
      },
      dialog: {
        showMessageBoxSync: () => {
          throw new Error("synchronous dialog must not run");
        },
        showMessageBox: (...args) => {
          dialogCalls.push(args);
          return new Promise((resolve) => { resolveDialog = resolve; });
        },
      },
    },
  };
  const register = vm.runInNewContext(
    `${applyQuitConfirmationFocus(OFFICIAL_BUNDLE)};qrt`,
    context,
  );
  register({
    isWindows: false,
    quitState: {
      canQuitWithoutPrompt: () => approved,
      markQuitApproved: () => { approved = true; },
    },
    windows: {
      windowManager: { getPrimaryWindow: () => primary },
      markAppQuitting: () => { accepted += 1; },
    },
  });
  return {
    answer: (response) => resolveDialog({ response }),
    dialogCalls,
    emitBeforeQuit,
    errors,
    get accepted() { return accepted; },
    get prevented() { return prevented; },
    get quitCalls() { return quitCalls; },
  };
}

const tick = () => new Promise(setImmediate);

test("patches only the official confirmation and is idempotent", () => {
  const patched = applyQuitConfirmationFocus(OFFICIAL_BUNDLE);
  assert.match(patched, /codexLinuxQuitDialogParent\(i\)/);
  assert.match(patched, /dialog\.showMessageBox\(codexLinuxParent,codexLinuxOptions\)/);
  assert.doesNotMatch(patched, /showMessageBoxSync\(/);
  assert.match(patched, /Promise\.allSettled\(\[flush\(\),save\(\)\]\)/);
  assert.equal(applyQuitConfirmationFocus(patched), patched);
  new vm.Script(patched);
});

test("fails closed when the official Quit confirmation changes or is ambiguous", () => {
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
  assert.throws(
    () => applyQuitConfirmationFocus(`${OFFICIAL_BUNDLE}${OFFICIAL_BUNDLE}`),
    /Expected exactly one official Quit confirmation anchor/,
  );
});

test("parents the confirmation, prevents reentrancy, and resumes Quit on approval", async () => {
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

test("falls back to another visible live window", async () => {
  const app = harness({
    focused: window(2, { destroyed: true }),
    primary: window(3, { visible: false }),
    others: [window(4, { visible: false }), window(5)],
  });
  app.emitBeforeQuit();
  await tick();
  assert.equal(app.dialogCalls[0][0].id, 5);
  app.answer(1);
  await tick();
  assert.equal(app.accepted, 0);
});

test("applies to the uniquely anchored signed campaign bundle", {
  skip: process.env.CODEX_SIGNED_EXTRACTED_APP == null,
}, () => {
  const buildDir = path.join(process.env.CODEX_SIGNED_EXTRACTED_APP, ".vite", "build");
  const candidates = fs.readdirSync(buildDir)
    .filter((name) => name.endsWith(".js"))
    .sort()
    .map((name) => ({
      name,
      source: fs.readFileSync(path.join(buildDir, name), "utf8"),
    }))
    .filter(({ source }) => source.includes("messageId:`desktop.quitConfirmation.quit`"));
  assert.equal(
    candidates.length,
    1,
    `expected one signed main-process Quit anchor, found: ${candidates.map(({ name }) => name).join(", ")}`,
  );

  const source = candidates[0].source;
  const patched = applyQuitConfirmationFocus(source);
  assert.notEqual(patched, source);
  assert.match(patched, /function codexLinuxQuitDialogParent\(/);
  assert.match(patched, /codexLinuxQuitPromptPending=!0/);
  assert.doesNotMatch(
    patched.slice(
      patched.lastIndexOf("function ", patched.indexOf("desktop.quitConfirmation.quit")),
      patched.indexOf("}function ", patched.indexOf("desktop.quitConfirmation.quit")) + 1,
    ),
    /showMessageBoxSync\(/,
  );
  assert.equal(applyQuitConfirmationFocus(patched), patched);
});
