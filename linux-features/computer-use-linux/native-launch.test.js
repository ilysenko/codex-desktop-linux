"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

test("native bootstrap retains upstream browser methods and disables upstream native control", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "native-bootstrap-"));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const factoryPath = path.join(dir, "factory.mjs");
  fs.writeFileSync(factoryPath, 'export async function create_tinysky_alt(options) { return {options, getBrowser: () => "upstream", getState: async () => ({apps: [], browsers: []})}; }');
  const { setupLinuxComputerUse } = await import("./native-launch.mjs");
  const oldRuntime = globalThis.nodeRepl, oldCua = globalThis.cua;
  t.after(() => { globalThis.nodeRepl = oldRuntime; globalThis.cua = oldCua; });
  globalThis.nodeRepl = {rpc: async () => ({}), write: () => {}};
  for (const browser of [true, false]) {
    await setupLinuxComputerUse({browser, factoryPath});
    assert.deepEqual(globalThis.cua.options, {browser, computer: false});
    assert.equal(globalThis.cua.getBrowser(), "upstream");
    assert.equal(typeof globalThis.cua.getApp, "function");
    assert.equal(globalThis.cua.initialize, globalThis.cua.getState);
  }
});
