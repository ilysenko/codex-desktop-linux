"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const {
  DEFER,
  applyShellEnvironmentStartup,
} = require("./shell-env.js");

// Independent reduced fixture of the signed shell loader contract.
const FIXTURE = "async function load(caller,timeout){let started=Date.now();electron.app.isPackaged||clean();" +
  "let abort=new AbortController;let result=await spawnShell(abort.signal);" +
  "logger(`Failed to load shell env`,{resultSource:`load`});return result}";

test("deferral prevents browser initialization from losing child completion", async () => {
  async function startup(source) {
    const callbacks = [];
    let childExit = () => {};
    let completed = false;
    const context = {
      process: { platform: "linux" },
      setImmediate: (callback) => callbacks.push(callback),
      electron: { app: { isPackaged: true } },
      AbortController,
      spawnShell: () => new Promise((resolve) => { childExit = resolve; }),
      logger() {},
    };
    const load = vm.runInNewContext(`${source};load`, context);
    const result = load("startup", 5000);
    result.then(() => { completed = true; });
    // Chromium resets SIGCHLD after the initial JavaScript and its microtasks.
    await Promise.resolve();
    childExit = () => {};
    for (const callback of callbacks) callback();
    await Promise.resolve();
    childExit();
    // Observe settlement without an arbitrary wall-clock timeout. An unsettled
    // promise models the observed hang but holds no resources or live handles.
    await new Promise(setImmediate);
    return completed;
  }

  assert.equal(await startup(FIXTURE), false);
  assert.equal(await startup(applyShellEnvironmentStartup(FIXTURE)), true);
});

test("Linux shell spawn waits until the next event-loop turn", async () => {
  let tick;
  let spawned = 0;
  const context = {
    process: { platform: "linux" },
    setImmediate: (callback) => { tick = callback; },
    electron: { app: { isPackaged: true } },
    AbortController,
    spawnShell: async () => { spawned++; return { PATH: "/test/bin" }; },
    logger() {},
  };
  const load = vm.runInNewContext(`${applyShellEnvironmentStartup(FIXTURE)};load`, context);
  const result = load("startup", 5000);
  await Promise.resolve();
  assert.equal(spawned, 0);
  assert.equal(typeof tick, "function");
  tick();
  assert.deepEqual(await result, { PATH: "/test/bin" });
  assert.equal(spawned, 1);
});

test("other platforms retain immediate shell startup and failures propagate", async () => {
  const failure = new Error("shell unavailable");
  const context = {
    process: { platform: "darwin" },
    setImmediate() { throw new Error("unexpected deferral"); },
    electron: { app: { isPackaged: true } },
    AbortController,
    spawnShell: async () => { throw failure; },
  };
  const load = vm.runInNewContext(`${applyShellEnvironmentStartup(FIXTURE)};load`, context);
  await assert.rejects(load("startup", 5000), (error) => error === failure);
});

test("patch is idempotent and rejects changed, duplicate, or partial contracts", () => {
  const patched = applyShellEnvironmentStartup(FIXTURE);
  assert.equal(patched.replace(DEFER, ""), FIXTURE);
  assert.equal(applyShellEnvironmentStartup(patched), patched);
  assert.throws(() => applyShellEnvironmentStartup(FIXTURE.replace("Date.now()", "performance.now()")));
  assert.throws(() => applyShellEnvironmentStartup(FIXTURE + FIXTURE));
  assert.throws(() => applyShellEnvironmentStartup(patched.replace("new Promise(setImmediate)", "Promise.resolve()")));
  assert.throws(() => applyShellEnvironmentStartup(DEFER + FIXTURE));
});

test("matches renamed minified bindings without depending on the original identifiers", () => {
  const renamed = FIXTURE.replace("load(caller,timeout)", "$x(a,b)")
    .replaceAll("started", "$s").replaceAll("electron", "$e");
  const patched = applyShellEnvironmentStartup(renamed);
  assert.equal(patched.replace(DEFER, ""), renamed);
  new vm.Script(patched);
});

test("applies to the signed official shell environment module", {
  skip: process.env.CODEX_SIGNED_EXTRACTED_APP == null,
}, () => {
  const dir = path.join(process.env.CODEX_SIGNED_EXTRACTED_APP, ".vite", "build");
  const sources = fs.readdirSync(dir).filter((name) => name.endsWith(".js"))
    .map((name) => fs.readFileSync(path.join(dir, name), "utf8"))
    .filter((source) => source.includes("`Failed to load shell env`"));
  assert.equal(sources.length, 1);
  const patched = applyShellEnvironmentStartup(sources[0]);
  assert.notEqual(patched, sources[0]);
  assert.equal(patched.replace(DEFER, ""), sources[0]);
  new vm.Script(patched);
  assert.equal(applyShellEnvironmentStartup(patched), patched);
});
