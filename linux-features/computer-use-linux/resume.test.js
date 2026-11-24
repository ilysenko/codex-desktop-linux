"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { findMainProcessChunks } = require("../../scripts/patches/lib/assets.js");
const { applyUnifiedComputerUsePatch } = require("./unified.js");

test("official per-thread CUA configuration reuses the cached verified root", {
  skip: !process.env.CODEX_SIGNED_EXTRACTED_APP,
}, () => {
  const main = findMainProcessChunks(process.env.CODEX_SIGNED_EXTRACTED_APP);
  assert(main);
  const owners = main.chunks.map(name =>
    fs.readFileSync(path.join(main.buildDir, name), "utf8")
  ).filter(source => source.includes("cuaReplSurfaces:"));
  assert.equal(owners.length, 1);
  const patched = applyUnifiedComputerUsePatch(owners[0]);
  assert.doesNotThrow(() => new vm.Script(patched));
  assert.match(patched, /codexLinuxCuaContext:[A-Za-z_$][\w$]*/u);
  assert.match(patched, /codexLinuxUnifiedCuaRoot/u);
  assert.match(patched,
    /codexLinuxCuaPluginRoot:[A-Za-z_$][\w$]*\.codexLinuxCuaPluginRoot/u);
  assert.match(patched,
    /codexLinuxUnifiedCuaThread[\s\S]*?NODE_REPL_JS_BANNER=/u);
  assert.equal(
    patched.split('require("node:path").join(codexLinuxCuaPluginRoot,"scripts","native-service.mjs")').length - 1,
    2,
  );
  assert.equal(applyUnifiedComputerUsePatch(patched), patched);
});
