"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { resolveOfficialAppRoot } = require("./official-linux-feature-runtime.js");

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "official-feature-runtime-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function writeOfficialApp(root) {
  fs.mkdirSync(path.join(root, "resources"), { recursive: true });
  fs.writeFileSync(path.join(root, "ChatGPT"), "official-runtime", { mode: 0o755 });
  fs.writeFileSync(path.join(root, "resources", "app.asar"), "signed-asar");
}

test("official feature audit accepts an explicit verified app root", (t) => {
  const root = temporaryDirectory(t);
  const extractedAsar = path.join(root, "extracted-asar");
  const appRoot = path.join(root, "signed-app");
  fs.mkdirSync(extractedAsar);
  writeOfficialApp(appRoot);

  assert.equal(resolveOfficialAppRoot(extractedAsar, appRoot), appRoot);
});

test("official feature audit finds the watchdog's adjacent verified payload", (t) => {
  const root = temporaryDirectory(t);
  const extractedAsar = path.join(root, "app-asar");
  const appRoot = path.join(root, "upstream", "usr", "lib", "chatgpt");
  fs.mkdirSync(extractedAsar);
  writeOfficialApp(appRoot);

  assert.equal(resolveOfficialAppRoot(extractedAsar), appRoot);
});

test("official feature audit rejects missing or unsafe runtime evidence", (t) => {
  const root = temporaryDirectory(t);
  const extractedAsar = path.join(root, "app-asar");
  const appRoot = path.join(root, "signed-app");
  const foreignRoot = path.join(root, "foreign-app");
  fs.mkdirSync(extractedAsar);
  writeOfficialApp(appRoot);
  writeOfficialApp(foreignRoot);

  fs.rmSync(path.join(appRoot, "ChatGPT"));
  fs.symlinkSync(path.join(foreignRoot, "ChatGPT"), path.join(appRoot, "ChatGPT"));
  assert.throws(
    () => resolveOfficialAppRoot(extractedAsar, appRoot),
    /missing or unsafe ChatGPT/u,
  );
  assert.throws(
    () => resolveOfficialAppRoot(extractedAsar),
    /Adjacent verified-package app root is missing or unsafe/u,
  );
});
