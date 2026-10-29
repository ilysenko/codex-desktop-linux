"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const descriptors = require("./patch.js");
const { findMainProcessChunks } = require("../../scripts/patches/lib/assets.js");

function signedChunks() {
  const mainProcess = findMainProcessChunks(process.env.CODEX_SIGNED_EXTRACTED_APP);
  assert(mainProcess, "Expected the verified main-process chunks");
  return mainProcess.chunks.map(name => {
    const file = path.join(mainProcess.buildDir, name);
    return { name, file, source: fs.readFileSync(file, "utf8") };
  });
}

function quietly(fn) {
  const warn = console.warn;
  console.warn = () => {};
  try {
    return fn();
  } finally {
    console.warn = warn;
  }
}

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
  // Locate the chunk holding the fetch handler semantically, not by chunk id.
  const owners = signedChunks().filter(({ source }) =>
    source.includes("nativeApplications:this.fetchHandler.nativeApplications"));
  assert.equal(owners.length, 1, "Expected one chunk exposing native Applications metadata");
  const [{ file, source: actual }] = owners;
  const patch = descriptors.find(({ id }) => id === "native-applications").apply;
  const patched = patch(actual);
  assert.notEqual(patched, actual);
  assert.equal(patch(patched), patched);
  assert.doesNotThrow(() => new vm.Script(patched));
  assert.equal(fs.readFileSync(file, "utf8"), actual);
});

test("every current signed main-process descriptor patches exactly one chunk idempotently", {
  skip: !process.env.CODEX_SIGNED_EXTRACTED_APP,
}, () => {
  const chunks = signedChunks();
  for (const descriptor of descriptors.filter(({ phase }) => phase === "main-bundle")) {
    const changed = [];
    for (const chunk of chunks) {
      let patched;
      try {
        patched = quietly(() => descriptor.apply(chunk.source));
      } catch {
        continue;
      }
      if (patched === chunk.source) continue;
      changed.push(chunk.name);
      assert.equal(quietly(() => descriptor.apply(patched)), patched, `${descriptor.id} is not idempotent`);
      assert.doesNotThrow(() => new vm.Script(patched), `${descriptor.id} produced invalid JavaScript`);
    }
    assert.equal(changed.length, 1, `${descriptor.id} changed ${changed.join(", ") || "no chunk"}`);
  }
});
