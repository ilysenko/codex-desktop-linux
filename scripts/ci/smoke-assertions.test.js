"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const smokePath = path.resolve(__dirname, "../../tests/scripts_smoke.sh");
const source = fs.readFileSync(smokePath, "utf8");
const firstAssertion = source.indexOf("\nassert_executable install.sh");
assert.ok(firstAssertion > 0);
const helpers = source.slice(0, firstAssertion);

function run(t, { contents = "present\n", pattern = "missing", missingFile = false, flags = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-assertion-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "fixture");
  if (!missingFile) fs.writeFileSync(file, contents);
  return spawnSync("bash", ["-c", helpers + '\nassert_absent "$@"\n', smokePath, file, pattern, ...flags], { encoding: "utf8" });
}

test("negative smoke checks accept only a valid no-match result", t => {
  const result = run(t);
  assert.equal(result.status, 0, result.stderr);
});

test("negative smoke checks reject an actual matching source line", t => {
  const result = run(t, { pattern: "present" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unexpectedly contains/);
});

test("negative smoke checks reject regex and input errors", t => {
  for (const options of [{ pattern: "(" }, { missingFile: true }, { flags: ["--invalid-smoke-option"] }]) {
    const result = run(t, options);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /rg failed with status 2/);
  }
});

test("retired ASAR listing check matches a literal backslash and pipe", t => {
  const pattern = "find . -type f -printf '%P\\n' | LC_ALL=C sort";
  assert.ok(source.split("\n").some(line => line.startsWith("assert_absent scripts/lib/asar-patch.sh \"find ") && line.endsWith(" --fixed-strings")));
  const found = run(t, { contents: pattern + "\n", pattern, flags: ["--fixed-strings"] });
  assert.equal(found.status, 1);
  assert.match(found.stderr, /unexpectedly contains/);
  const absent = run(t, { pattern, flags: ["--fixed-strings"] });
  assert.equal(absent.status, 0, absent.stderr);
});
