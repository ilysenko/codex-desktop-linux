"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { recordReplayBridgeSource, recordReplayHelperSource } = require("./patch.js");

const FIXED_TIMESTAMP = 1234567890;
const FIXED_PID = 32123;
const FIXED_RANDOM = 0.5;
const FIXTURE_UID = process.getuid ? process.getuid() : FIXED_PID;
const ACTIVE_SESSION_DIR = "/owned/recording with trailing space ";

function fixtureDirectory(t) {
  const cacheRoot = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  const scratchRoot = process.env.TMPDIR || path.join(cacheRoot, "codex-desktop-dev", "tmp");
  fs.mkdirSync(scratchRoot, { recursive: true });
  const directory = fs.mkdtempSync(path.join(scratchRoot, "record-replay-main-runtime-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function traceDirectory(runtimeDirectory) {
  return path.join(runtimeDirectory, `codex-record-replay-traces-${FIXTURE_UID}`);
}

function traceFile(runtimeDirectory) {
  const suffix = FIXED_RANDOM.toString(36).slice(2);
  return path.join(traceDirectory(runtimeDirectory), `trace-${FIXED_TIMESTAMP}-${FIXED_PID}-${suffix}.json`);
}

function remainingTraceFiles(runtimeDirectory) {
  const directory = traceDirectory(runtimeDirectory);
  return fs.existsSync(directory) ? fs.readdirSync(directory) : [];
}

function createRuntime({ runtimeDirectory, run, filesystem = fs }) {
  const calls = [];
  const source = [
    recordReplayHelperSource({ fsVar: "fs", pathVar: "path" }),
    `({handlers:{${recordReplayBridgeSource({ fsVar: "fs" })}},writeTempJson:codexLinuxRecordReplayWriteTempJson})`,
  ].join("\n");
  const runtime = vm.runInNewContext(source, {
    fs: filesystem,
    path,
    process: {
      env: { XDG_RUNTIME_DIR: runtimeDirectory, TMPDIR: runtimeDirectory },
      pid: FIXED_PID,
      getuid: () => FIXTURE_UID,
    },
    Date: { now: () => FIXED_TIMESTAMP },
    Math: { random: () => FIXED_RANDOM },
    codexLinuxRecordReplayString(value) {
      return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
    },
    async codexLinuxRecordReplayRun(args, timeout) {
      calls.push({ args: Array.from(args), timeout });
      return run(args, timeout);
    },
  });
  return { ...runtime, calls };
}

function activeStatus() {
  return {
    ok: true,
    json: {
      ok: true,
      schema_version: 1,
      state: "active",
      session_dir: ACTIVE_SESSION_DIR,
    },
  };
}

test("all 16 Record & Replay bridge actions use the current helper protocol", async t => {
  const runtimeDirectory = fixtureDirectory(t);
  const commandResult = { ok: true, json: { ok: true, fixture: "command result" } };
  const statusResult = activeStatus();
  const sessionDirectory = "/owned/direct session";
  const cases = [
    { method: "doctor", args: ["doctor"], timeout: 15000 },
    { method: "status", args: ["status"], timeout: 5000, result: statusResult },
    {
      method: "start",
      params: {
        sessionDir: sessionDirectory,
        appId: "org.example.App",
        windowId: "window-42",
        goal: "capture one bounded workflow",
        includeScreenshot: false,
        includeAccessibility: false,
        includeAudio: true,
      },
      args: ["record", "start", "--session-dir", sessionDirectory, "--app-id", "org.example.App", "--window-id", "window-42", "--goal", "capture one bounded workflow", "--no-screenshot", "--no-accessibility", "--audio"],
      timeout: 60000,
    },
    { method: "mark", params: { sessionDir: sessionDirectory, note: "intentional marker" }, args: ["record", "mark", "--session-dir", sessionDirectory, "--note", "intentional marker"], timeout: 15000 },
    { method: "speech-context", params: { sessionDir: sessionDirectory, transcript: "spoken context", source: "fixture-speech" }, args: ["record", "speech", "--session-dir", sessionDirectory, "--text", "spoken context", "--source", "fixture-speech"], timeout: 15000 },
    { method: "speech-context-active", params: { transcript: "active spoken context", source: "fixture-active-speech" }, active: true, args: ["record", "speech", "--session-dir", ACTIVE_SESSION_DIR, "--text", "active spoken context", "--source", "fixture-active-speech"], timeout: 15000 },
    {
      method: "browser-trace",
      params: { sessionDir: sessionDirectory, trace: { event: "fixture" }, url: "https://example.test/", title: "Fixture page", source: "fixture-cdp" },
      args: ["record", "browser-trace", "--session-dir", sessionDirectory, "--trace-file", traceFile(runtimeDirectory), "--url", "https://example.test/", "--title", "Fixture page", "--source", "fixture-cdp"],
      timeout: 30000,
    },
    { method: "desktop-snapshot", params: { sessionDir: sessionDirectory, source: "fixture-desktop" }, args: ["record", "desktop-snapshot", "--session-dir", sessionDirectory, "--source", "fixture-desktop"], timeout: 15000 },
    { method: "stop", params: { sessionDir: sessionDirectory }, args: ["record", "stop", "--session-dir", sessionDirectory], timeout: 15000 },
    { method: "stop-active", active: true, args: ["record", "stop", "--session-dir", ACTIVE_SESSION_DIR], timeout: 15000 },
    { method: "cancel", params: { sessionDir: sessionDirectory, discarded: true }, args: ["record", "cancel", "--session-dir", sessionDirectory, "--discarded"], timeout: 15000 },
    { method: "cancel-active", params: { discarded: true }, active: true, args: ["record", "cancel", "--session-dir", ACTIVE_SESSION_DIR, "--discarded"], timeout: 15000 },
    { method: "bundle", params: { bundle: "/owned/bundle" }, args: ["bundle", "validate", "--bundle", "/owned/bundle"], timeout: 15000 },
    { method: "draft-skill", params: { bundle: "/owned/bundle" }, args: ["bundle", "draft-prompt", "--bundle", "/owned/bundle"], timeout: 30000 },
    { method: "import-skill", params: { source: "/owned/skill", dryRun: true, allowUnsupported: true }, args: ["skill", "import", "--source", "/owned/skill", "--dry-run", "--allow-unsupported"], timeout: 30000 },
    { method: "inspect-skill", params: { source: "/owned/skill" }, args: ["skill", "inspect", "--source", "/owned/skill"], timeout: 15000 },
  ];
  const expectedMethods = cases.map(entry => `linux-record-replay-${entry.method}`).sort();
  const inventory = createRuntime({ runtimeDirectory, run: async () => commandResult });
  assert.deepEqual(Object.keys(inventory.handlers).sort(), expectedMethods);

  for (const entry of cases) {
    await t.test(entry.method, async () => {
      const runtime = createRuntime({
        runtimeDirectory,
        run: async args => args[0] === "status" ? statusResult : commandResult,
      });
      const result = await runtime.handlers[`linux-record-replay-${entry.method}`](entry.params);
      const expectedCalls = [];
      if (entry.active) expectedCalls.push({ args: ["status"], timeout: 5000 });
      expectedCalls.push({ args: entry.args, timeout: entry.timeout });
      assert.deepEqual(runtime.calls, expectedCalls);
      assert.equal(result, entry.result || commandResult);
      assert.equal(runtime.calls.some(call => call.args[0] === "skysight"), false);
      assert.deepEqual(remainingTraceFiles(runtimeDirectory), []);
    });
  }
});

test("start defaults keep audio opt-in and explicit false maps to no-audio", async t => {
  const runtimeDirectory = fixtureDirectory(t);
  const result = { ok: true, json: { ok: true } };
  const runtime = createRuntime({ runtimeDirectory, run: async () => result });
  await runtime.handlers["linux-record-replay-start"]({ sessionDir: "/owned/default" });
  await runtime.handlers["linux-record-replay-start"]({ sessionDir: "/owned/without-audio", includeAudio: false });
  assert.deepEqual(runtime.calls, [
    { args: ["record", "start", "--session-dir", "/owned/default"], timeout: 60000 },
    { args: ["record", "start", "--session-dir", "/owned/without-audio", "--no-audio"], timeout: 60000 },
  ]);
});

test("active actions reject malformed or inactive status and preserve diagnostics", async t => {
  const runtimeDirectory = fixtureDirectory(t);
  const validPayload = activeStatus().json;
  const invalidStatuses = [
    ["missing result", undefined],
    ["null result", null],
    ["failed process", { ok: false, json: validPayload, stderr: "fixture process failure" }],
    ["missing process ok", { json: validPayload }],
    ["truthy process ok", { ok: 1, json: validPayload }],
    ["missing payload", { ok: true }],
    ["null payload", { ok: true, json: null }],
    ["array payload", { ok: true, json: Object.assign([], validPayload) }],
    ["string payload", { ok: true, json: "active" }],
    ["number payload", { ok: true, json: 1 }],
    ["false payload", { ok: true, json: false }],
    ["helper failure", { ok: true, json: { ...validPayload, ok: false } }],
    ["missing helper ok", { ok: true, json: { state: "active", session_dir: ACTIVE_SESSION_DIR } }],
    ["truthy helper ok", { ok: true, json: { ...validPayload, ok: 1 } }],
    ["string helper ok", { ok: true, json: { ...validPayload, ok: "true" } }],
  ];
  for (const state of [undefined, "idle", "stopped", "canceled", "expired", "running", "paused"]) {
    invalidStatuses.push([`state ${String(state)}`, { ok: true, json: { ...validPayload, state } }]);
  }
  for (const sessionDir of [undefined, null, "", " \t\n", 1, {}, []]) {
    invalidStatuses.push([`session_dir ${JSON.stringify(sessionDir)}`, { ok: true, json: { ...validPayload, session_dir: sessionDir } }]);
  }

  const actions = [
    ["speech-context-active", { transcript: "fixture transcript", source: "fixture-speech" }],
    ["stop-active", undefined],
    ["cancel-active", { discarded: true }],
  ];
  for (const [method, params] of actions) {
    await t.test(method, async actionTest => {
      for (const [label, statusResult] of invalidStatuses) {
        await actionTest.test(label, async () => {
          const runtime = createRuntime({ runtimeDirectory, run: async () => statusResult });
          const result = await runtime.handlers[`linux-record-replay-${method}`](params);
          assert.equal(result.ok, false);
          assert.equal(Object.hasOwn(result, "status"), true);
          assert.equal(result.status, statusResult);
          assert.deepEqual(runtime.calls, [{ args: ["status"], timeout: 5000 }]);
        });
      }
    });
  }
});

test("browser trace uses a private file and removes it after each command outcome", async t => {
  for (const outcome of ["success", "helper error", "rejected promise"]) {
    await t.test(outcome, async outcomeTest => {
      const runtimeDirectory = fixtureDirectory(outcomeTest);
      const commandError = new Error("inert helper rejection");
      const commandResult = { ok: outcome === "success", json: { ok: outcome === "success" } };
      let observedFile;
      const runtime = createRuntime({
        runtimeDirectory,
        run: async (args, timeout) => {
          observedFile = args[5];
          assert.equal(timeout, 30000);
          assert.equal(observedFile, traceFile(runtimeDirectory));
          assert.equal(fs.readFileSync(observedFile, "utf8"), '{"fixture":true}');
          assert.equal(fs.statSync(path.dirname(observedFile)).mode & 0o777, 0o700);
          assert.equal(fs.statSync(observedFile).mode & 0o777, 0o600);
          if (outcome === "rejected promise") throw commandError;
          return commandResult;
        },
      });
      const request = runtime.handlers["linux-record-replay-browser-trace"]({ sessionDir: "/owned/session", trace: { fixture: true } });
      if (outcome === "rejected promise") {
        await assert.rejects(request, error => error === commandError);
      } else {
        assert.equal(await request, commandResult);
      }
      assert.equal(fs.existsSync(observedFile), false);
      assert.deepEqual(remainingTraceFiles(runtimeDirectory), []);
    });
  }
});

test("browser trace accepts pre-serialized traceJson without replacing it", async t => {
  const runtimeDirectory = fixtureDirectory(t);
  const traceJson = '{"serialized":"fixture","events":[1,2]}';
  const commandResult = { ok: true, json: { ok: true } };
  const runtime = createRuntime({
    runtimeDirectory,
    run: async args => {
      assert.equal(fs.readFileSync(args[5], "utf8"), traceJson);
      return commandResult;
    },
  });
  const result = await runtime.handlers["linux-record-replay-browser-trace"]({
    sessionDir: "/owned/session",
    traceJson,
    trace: { ignored: "traceJson takes precedence" },
  });
  assert.equal(result, commandResult);
  assert.deepEqual(remainingTraceFiles(runtimeDirectory), []);
});

test("browser trace cleans its file if optional argument coercion fails", async t => {
  for (const parameter of ["url", "title", "source"]) {
    await t.test(parameter, async parameterTest => {
      const runtimeDirectory = fixtureDirectory(parameterTest);
      const runtime = createRuntime({
        runtimeDirectory,
        run: async () => assert.fail("coercion failure must precede helper dispatch"),
      });
      const params = JSON.parse('{"sessionDir":"/owned/session","trace":{"fixture":true}}');
      params[parameter] = { toString: null };
      await assert.rejects(runtime.handlers["linux-record-replay-browser-trace"](params), /Cannot convert object to primitive value/);
      assert.deepEqual(runtime.calls, []);
      assert.deepEqual(remainingTraceFiles(runtimeDirectory), []);
    });
  }
});

test("temporary trace creation preserves existing regular files and symlinks", async t => {
  for (const collision of ["regular file", "symlink"]) {
    await t.test(collision, collisionTest => {
      const runtimeDirectory = fixtureDirectory(collisionTest);
      fs.mkdirSync(traceDirectory(runtimeDirectory), { mode: 0o700 });
      const destination = traceFile(runtimeDirectory);
      const victim = path.join(runtimeDirectory, "owned-victim.json");
      fs.writeFileSync(victim, "ORIGINAL", { mode: 0o644 });
      if (collision === "symlink") {
        fs.symlinkSync(victim, destination);
      } else {
        fs.writeFileSync(destination, "ORIGINAL", { mode: 0o644 });
      }
      const runtime = createRuntime({ runtimeDirectory, run: async () => assert.fail("unused inert runner") });
      assert.throws(() => runtime.writeTempJson('{"replacement":true}'), error => error.code === "EEXIST");
      assert.equal(fs.readFileSync(victim, "utf8"), "ORIGINAL");
      assert.equal(fs.readFileSync(destination, "utf8"), "ORIGINAL");
      assert.equal(fs.statSync(destination).mode & 0o777, 0o644);
      assert.equal(fs.lstatSync(destination).isSymbolicLink(), collision === "symlink");
      assert.deepEqual(runtime.calls, []);
    });
  }
});

test("temporary trace directory symlinks are rejected before target mutation", t => {
  const runtimeDirectory = fixtureDirectory(t);
  const target = path.join(runtimeDirectory, "owned-directory-target");
  fs.mkdirSync(target, { mode: 0o750 });
  fs.symlinkSync(target, traceDirectory(runtimeDirectory));
  const runtime = createRuntime({ runtimeDirectory, run: async () => assert.fail("unused inert runner") });
  assert.throws(() => runtime.writeTempJson('{"fixture":true}'), /trace directory is a symlink/);
  assert.equal(fs.statSync(target).mode & 0o777, 0o750);
  assert.deepEqual(fs.readdirSync(target), []);
  assert.equal(fs.lstatSync(traceDirectory(runtimeDirectory)).isSymbolicLink(), true);
});

test("temporary trace write failures close and remove only the newly owned file", async t => {
  const runtimeDirectory = fixtureDirectory(t);
  const writeError = new Error("injected partial trace write failure");
  writeError.code = "EIO";
  let openedDescriptor;
  const filesystem = Object.create(fs);
  filesystem.openSync = (file, flags, mode) => {
    assert.equal(file, traceFile(runtimeDirectory));
    assert.equal(flags, "wx");
    assert.equal(mode, 0o600);
    openedDescriptor = fs.openSync(file, flags, mode);
    return openedDescriptor;
  };
  filesystem.writeFileSync = (file, contents, options) => {
    assert.equal(file, openedDescriptor);
    fs.writeFileSync(file, String(contents).slice(0, 3), options);
    throw writeError;
  };
  const runtime = createRuntime({
    runtimeDirectory,
    filesystem,
    run: async () => assert.fail("partial trace write must precede helper dispatch"),
  });
  await assert.rejects(
    runtime.handlers["linux-record-replay-browser-trace"]({ sessionDir: "/owned/session", trace: { fixture: true } }),
    error => error === writeError,
  );
  assert.equal(typeof openedDescriptor, "number");
  assert.throws(() => fs.fstatSync(openedDescriptor), error => error.code === "EBADF");
  assert.equal(fs.existsSync(traceFile(runtimeDirectory)), false);
  assert.deepEqual(remainingTraceFiles(runtimeDirectory), []);
  assert.deepEqual(runtime.calls, []);
});
