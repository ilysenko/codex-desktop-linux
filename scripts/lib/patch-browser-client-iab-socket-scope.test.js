#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const patcher = path.join(__dirname, "patch-browser-client-iab-socket-scope.js");

test("IAB discovery excludes extension sockets before connecting", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-iab-socket-scope-"));
  const clientPath = path.join(workspace, "browser-client.mjs");
const fixture = `
const Cb="/tmp/codex-browser-use";
const entries=["extension-123.sock","iab-session.sock","extension-stale.sock"];
const yP=async()=>entries;
const wP={resolve:(root,entry)=>root+"/"+entry};
const _P=()=>"linux";
export const EV=()=>_P()==="win32"?TV():CV(),CV=async()=>(await yP(Cb)).map(e=>wP.resolve(Cb,e)),TV=async()=>[];
`;

  try {
    fs.writeFileSync(clientPath, fixture, "utf8");
    const firstPatch = spawnSync(process.execPath, [patcher, clientPath], { encoding: "utf8" });
    assert.equal(firstPatch.status, 0, firstPatch.stderr);
    const patched = fs.readFileSync(clientPath, "utf8");
    assert.match(patched, /codexLinuxIabSocketScope/);

    const secondPatch = spawnSync(process.execPath, [patcher, clientPath], { encoding: "utf8" });
    assert.equal(secondPatch.status, 0, secondPatch.stderr);
    assert.equal(fs.readFileSync(clientPath, "utf8"), patched);

    const module = await import(`${pathToFileURL(clientPath).href}?patched=1`);
    assert.deepEqual(await module.CV(), ["/tmp/codex-browser-use/iab-session.sock"]);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("leaves an unrelated socket-directory map unchanged", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-iab-unrelated-"));
  const clientPath = path.join(workspace, "browser-client.mjs");
  const fixture =
    'const Cb="/tmp/codex-browser-use";const CV=async()=>(await yP(Cb)).map(e=>wP.resolve(Cb,e));';

  try {
    fs.writeFileSync(clientPath, fixture, "utf8");
    const result = spawnSync(process.execPath, [patcher, clientPath], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const actual = fs.readFileSync(clientPath, "utf8");
    assert.equal(actual, fixture);
    assert.doesNotMatch(actual, /codexLinuxIabSocketScope/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("leaves ambiguous IAB discovery chains unchanged", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-iab-ambiguous-"));
  const clientPath = path.join(workspace, "browser-client.mjs");
  const chain = (suffix) =>
    `EV${suffix}=()=>P${suffix}()==="win32"?TV${suffix}():CV${suffix}(),` +
    `CV${suffix}=async()=>(await Y${suffix}(C${suffix})).map(e=>W${suffix}.resolve(C${suffix},e)),` +
    `TV${suffix}=async()=>[]`;
  const fixture = `const root="/tmp/codex-browser-use";${chain("A")};${chain("B")};`;

  try {
    fs.writeFileSync(clientPath, fixture, "utf8");
    const result = spawnSync(process.execPath, [patcher, clientPath], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(clientPath, "utf8"), fixture);
    assert.match(result.stderr, /found 2/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
