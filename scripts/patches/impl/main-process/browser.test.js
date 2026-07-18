#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");

const {
  applyLinuxBrowserUseSocketDirectoryPatch,
  applyLinuxExternalOpenEnvPatch,
} = require("./browser.js");

const browserUseSocketFixture =
  '"use strict";' +
  'var zt=e=>e===`win32`?`\\\\\\\\.\\\\pipe\\\\codex-browser-use`:`/tmp/codex-browser-use`;' +
  'var Sd=class{server;pipePath;async start(){await new Promise((e,t)=>{this.server.once(`error`,t),this.server.listen(this.pipePath,()=>{this.server.off(`error`,t),e()})})}};' +
  'globalThis.socketDirectory=zt(`linux`);';

function evaluateBrowserUseSocketPatch({ env = {}, metadataUid = 1000 } = {}) {
  const operations = [];
  const fs = {
    mkdirSync: (target, options) => operations.push(["mkdir", target, options]),
    lstatSync: (target) => ({
      isDirectory: () => true,
      isSymbolicLink: () => false,
      uid: metadataUid,
      target,
    }),
    chmodSync: (target, mode) => operations.push(["chmod", target, mode]),
  };
  const context = {
    globalThis: {},
    process: { env, getuid: () => 1000, platform: "linux" },
    require: (specifier) => {
      assert.equal(specifier, "node:fs");
      return fs;
    },
  };
  vm.runInNewContext(
    applyLinuxBrowserUseSocketDirectoryPatch(browserUseSocketFixture),
    context,
  );
  return { context, operations };
}

test("Linux IAB producer uses the same deterministic per-user socket directory as Browser clients", () => {
  const { context, operations } = evaluateBrowserUseSocketPatch();

  assert.equal(context.globalThis.socketDirectory, "/tmp/codex-browser-use-1000");
  assert.equal(operations[0][0], "mkdir");
  assert.equal(operations[0][1], "/tmp/codex-browser-use-1000");
  assert.equal(operations[0][2].recursive, true);
  assert.equal(operations[0][2].mode, 0o700);
  assert.deepEqual(operations[1], ["chmod", "/tmp/codex-browser-use-1000", 0o700]);
});

test("Linux IAB producer honors the explicit shared socket directory override", () => {
  const { context } = evaluateBrowserUseSocketPatch({
    env: { CODEX_BROWSER_USE_SOCKET_DIR: "/custom/browser-use" },
  });

  assert.equal(context.globalThis.socketDirectory, "/custom/browser-use");
});

test("Linux IAB producer rejects a socket directory owned by another user", () => {
  assert.throws(
    () => evaluateBrowserUseSocketPatch({ metadataUid: 2000 }),
    /not owned by the current user/,
  );
});

test("Linux IAB socket alignment patch hardens the directory and socket modes", () => {
  const patched = applyLinuxBrowserUseSocketDirectoryPatch(browserUseSocketFixture);

  assert.match(patched, /mkdirSync\(t,\{recursive:!0,mode:448\}\)/);
  assert.match(patched, /chmodSync\(t,448\)/);
  assert.match(patched, /chmodSync\(this\.pipePath,384\)/);
  assert.match(patched, /this\.server\.close\(\(\)=>\{\}\)/);
  assert.match(patched, /t\(e\);return/);
  assert.match(patched, /codexLinuxBrowserUseSocketMode/);
  assert.equal(applyLinuxBrowserUseSocketDirectoryPatch(patched), patched);
});

test("Linux external open env patch wraps electron require with helper", () => {
  const source = '"use strict";let e=require("electron");';
  const patched = applyLinuxExternalOpenEnvPatch(source);

  assert.match(patched, /codexLinuxPatchExternalOpen\(require\(("|`)electron\1\)\)/);
  assert.match(patched, /function codexLinuxPatchExternalOpen\(/);
});

test("Linux external open env patch injects env var guard in helper", () => {
  const source = '"use strict";let e=require("electron");';
  const patched = applyLinuxExternalOpenEnvPatch(source);

  assert.match(
    patched,
    /CODEX_LINUX_DISABLE_EXTERNAL_OPEN_PATCH/,
    "helper should check CODEX_LINUX_DISABLE_EXTERNAL_OPEN_PATCH env var",
  );
});

test("Linux external open env patch is idempotent", () => {
  const source = '"use strict";let e=require("electron");';
  const first = applyLinuxExternalOpenEnvPatch(source);
  const second = applyLinuxExternalOpenEnvPatch(first);

  assert.equal(second, first, "second application should not change the source");
});

test("Linux external open env patch warns when no electron require found", () => {
  const source = '"use strict";const fs=require("node:fs");';
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (msg) => warnings.push(msg);
  try {
    const patched = applyLinuxExternalOpenEnvPatch(source);
    assert.equal(patched, source, "source should be unchanged");
    assert.ok(warnings.length > 0, "should have warned about missing require");
    assert.match(warnings[0], /Could not find Electron require initializer/);
  } finally {
    console.warn = originalWarn;
  }
});
