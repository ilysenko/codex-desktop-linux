const assert = require("node:assert/strict");
const test = require("node:test");

const { requireName, inferModuleAlias } = require("./minified-js.js");

test("requireName finds direct require assignment", () => {
  const source = `let a=1,b=require("electron"),c=3`;
  assert.strictEqual(requireName(source, "electron"), "b");
});

test("requireName finds require with double quotes", () => {
  const source = `const myModule=require("node:path")`;
  assert.strictEqual(requireName(source, "node:path"), "myModule");
});

test("requireName finds require with backticks", () => {
  const source = `const myModule=require(\`electron\`)`;
  assert.strictEqual(requireName(source, "electron"), "myModule");
});

test("requireName finds wrapped require with codexLinuxPatchExternalOpen", () => {
  const source = `let a=1,electronAlias=codexLinuxPatchExternalOpen(require(\`electron\`)),c=3`;
  assert.strictEqual(requireName(source, "electron"), "electronAlias");
});

test("requireName finds locally marked external-open targets", () => {
  const source =
    'let electronAlias=/*codexLinuxExternalOpenTarget*/codexLinuxPatchExternalOpen(require("electron"))';
  assert.strictEqual(requireName(source, "electron"), "electronAlias");
});

test("requireName rejects an arbitrary require wrapper", () => {
  const source = `let a=1,electronAlias=myCustomWrapper(require(\`electron\`)),c=3`;
  assert.strictEqual(requireName(source, "electron"), null);
});

test("requireName limits the Linux external-open wrapper to electron", () => {
  const source = `const fsAlias=codexLinuxPatchExternalOpen(require("node:fs"))`;
  assert.strictEqual(requireName(source, "node:fs"), null);
});

test("requireName returns null when module not found", () => {
  const source = `const other=require("other-module")`;
  assert.strictEqual(requireName(source, "electron"), null);
});

test("inferModuleAlias delegates to requireName for direct require", () => {
  const source = `let electronAlias=require("electron")`;
  assert.strictEqual(inferModuleAlias(source, "electron"), "electronAlias");
});

test("inferModuleAlias delegates to requireName for the Linux external-open wrapper", () => {
  const source = `let electronAlias=codexLinuxPatchExternalOpen(require("electron"))`;
  assert.strictEqual(inferModuleAlias(source, "electron"), "electronAlias");
});

test("inferModuleAlias falls back to pattern matching for electron", () => {
  const source = `let electronAlias={app:{`;
  assert.strictEqual(inferModuleAlias(source, "electron"), "electronAlias");
});
