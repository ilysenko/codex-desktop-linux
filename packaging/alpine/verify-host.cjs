#!/usr/bin/env node
"use strict";

// Run this using the packaged glibc Node. Requests use the real bundled Codex
// app-server, without creating an agent thread or contacting a model.
const cp = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const assert = require("node:assert/strict");

async function main() {
  const [appArg, repositoryArg, ...command] = process.argv.slice(2);
  assert.ok(appArg && repositoryArg, "usage: verify-host.cjs APP REPOSITORY [COMMAND...]");
  const [app, repository] = [appArg, repositoryArg].map((value) => fs.realpathSync(value));
  assert.equal(process.env.LD_LIBRARY_PATH, undefined, "foreign libraries must not reach host commands");
  const hostOs = fs.readFileSync("/etc/os-release", "utf8");
  assert.match(hostOs, /^ID=alpine$/m);
  const probe = ["/bin/sh", "-c", "cat /etc/os-release; pwd; git rev-parse --show-toplevel; command -v sh; command -v cargo; ldd /bin/busybox"];
  const expected = cp.execFileSync(probe[0], probe.slice(1), { cwd: repository, encoding: "utf8" });
  const server = cp.spawn(path.join(app, "resources/codex"), ["app-server", "--stdio"], { stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map();
  let nextId = 0;
  let errors = "";
  server.stderr.on("data", (data) => { errors = (errors + data).slice(-8192); });
  readline.createInterface({ input: server.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    const waiter = pending.get(message.id);
    if (waiter) {
      pending.delete(message.id);
      message.error ? waiter.reject(new Error(JSON.stringify(message.error))) : waiter.resolve(message.result);
    }
  });
  server.on("error", (error) => { for (const waiter of pending.values()) waiter.reject(error); });
  server.on("exit", () => { for (const waiter of pending.values()) waiter.reject(new Error(`app-server exited: ${errors}`)); });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    server.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
  const timeout = setTimeout(() => server.kill("SIGKILL"), 120000);
  try {
    await request("initialize", { clientInfo: { name: "alpine-host-verification", version: "1" }, capabilities: { experimentalApi: true } });
    server.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
    const result = await request("command/exec", { command: probe, cwd: repository, timeoutMs: 10000 });
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    const withoutAslr = (text) => text.replace(/0x[0-9a-f]+/g, "<address>");
    assert.equal(withoutAslr(result.stdout), withoutAslr(expected), "app-server must execute against the same host repository and tools");
    assert.match(result.stdout, /ld-musl/);
    console.log(result.stdout);
    console.log("PASS: packaged glibc Node → bundled Codex app-server → Alpine musl shell and host repository");
    if (command.length) {
      const check = await request("command/exec", { command, cwd: repository, timeoutMs: 90000 });
      console.log(check.stdout);
      if (check.stderr) console.error(check.stderr);
      assert.equal(check.exitCode, 0, "host repository verification command failed");
    }
  } finally {
    clearTimeout(timeout);
    server.stdin.end();
    server.kill("SIGTERM");
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
