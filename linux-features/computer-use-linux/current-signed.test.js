"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const descriptors = require("./patch.js");
const { findMainBundle } = require("../../scripts/patches/lib/assets.js");

test("native metadata stays feature-owned without retired core IPC helpers", () => {
  const source = fs.readFileSync(path.join(__dirname, "../../scripts/patches/impl/computer-use.js"), "utf8");
  assert.doesNotMatch(source, /linuxNativeDesktopAppsHelper|applyLinuxNativeDesktopAppsHandlerPatch/);
  const descriptor = descriptors.find(({ id }) => id === "native-applications");
  assert(descriptor);
  assert.equal(descriptor.phase, "main-bundle");
});

test("current signed native metadata factory patches without changing the trusted input", {
  skip: !process.env.CODEX_SIGNED_EXTRACTED_APP,
}, () => {
  const main = findMainBundle(process.env.CODEX_SIGNED_EXTRACTED_APP);
  assert(main, "Expected the verified main-process bundle");
  const file = path.join(main.buildDir, main.mainBundle);
  const actual = fs.readFileSync(file, "utf8");
  const patch = descriptors.find(({ id }) => id === "native-applications").apply;
  const patched = patch(actual);
  assert.notEqual(patched, actual);
  assert.equal(patch(patched), patched);
  assert.doesNotThrow(() => new vm.Script(patched));
  assert.equal(fs.readFileSync(file, "utf8"), actual);
});
