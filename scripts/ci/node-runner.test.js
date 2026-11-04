"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const runner = path.resolve(__dirname, "run-node-checks.sh");

function fixture(t, body) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "node-runner-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "scripts/ci"), { recursive: true });
  fs.copyFileSync(runner, path.join(root, "scripts/ci/run-node-checks.sh"));
  fs.writeFileSync(path.join(root, "scripts/ci/manage-labels.js"), '"use strict";\n');
  fs.writeFileSync(path.join(root, "probe.test.js"), body);
  for (const args of [["init", "-q"], ["add", "probe.test.js"]]) {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
  return { root, marker: path.join(root, "assertions-ran") };
}

function run({ root, marker }, timeout) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  return spawnSync("bash", ["scripts/ci/run-node-checks.sh", "tests"], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...env,
      NODE_TEST_REPORTER: "tap",
      NODE_TEST_TIMEOUT_SECONDS: String(timeout),
      NODE_TEST_KILL_AFTER_SECONDS: "1",
      ASSERTIONS_RAN_MARKER: marker,
    },
  });
}

test("the tracked Node runner reports a completed healthy inventory", t => {
  const app = fixture(t, `const test=require("node:test"),fs=require("node:fs");
    test("first",()=>{});test("second",()=>{fs.writeFileSync(process.env.ASSERTIONS_RAN_MARKER,"done")});`);
  const result = run(app, 20);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /# tests 2\b/);
  assert.equal(fs.readFileSync(app.marker, "utf8"), "done");
});

test("leaked worker handles fail the watchdog after assertions finish", t => {
  const app = fixture(t, `const test=require("node:test"),fs=require("node:fs");
    test("completed assertions",()=>{fs.writeFileSync(process.env.ASSERTIONS_RAN_MARKER,"done")});
    setInterval(()=>{},1000);`);
  const result = run(app, 3);
  assert.equal(fs.readFileSync(app.marker, "utf8"), "done");
  assert.equal(result.status, 124, result.stderr);
  assert.match(result.stderr, /Node test suite exited with status 124/);
});
