"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { prepareTerminalSource, locateTerminalCohort, applyTerminalStatus } = require("./terminal-status.js");
const h = require("./fixtures/terminal-status-harness.js");
function temporary(sources, callback) {
  const base = process.env.TMPDIR ?? path.join(os.homedir(), ".cache/codex-desktop-dev/tmp");fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, "up90-test-")), assets = path.join(root, "webview/assets");
  try { for (const [name, source] of Object.entries(sources)) { const p = path.join(assets, name);fs.mkdirSync(path.dirname(p), { recursive: true });fs.writeFileSync(p, source);fs.chmodSync(p, 0o640); }return callback(root, assets); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}
function read(assets, sources) { return Object.fromEntries(Object.keys(sources).map(name => [name, fs.readFileSync(path.join(assets, name), "utf8")])); }

test("complete current native String cohort changes only three small modules and repeats exactly", () => {
  const native = h.source(), patched = prepareTerminalSource(native);
  assert.equal(Buffer.byteLength(patched) - Buffer.byteLength(native), 2189);
  assert.equal(prepareTerminalSource(patched), patched);
  for (const name of ["tl5a", "XQr6", "Bl6U"]) {
    const provider = require("./fixtures/current-terminal-status-graph.json").modules.find(x => x.moduleId === name).moduleSource;
    assert.ok(patched.includes(provider), name + " readonly native bytes");
  }
  assert.throws(() => prepareTerminalSource(native + '/*codexLinuxRemoteHasUserInputRequest*/'), /orphan String/);
});

test("extracted cohort validates all physical peers, preserves readonly assets and modes", () => temporary(h.sources(), (root, assets) => {
  const native = h.sources(), plan = locateTerminalCohort(assets);
  assert.equal(plan.edits.length, 6);assert.equal(plan.targetCopies, 3);assert.equal(plan.alreadyApplied, false);
  assert.ok(Object.isFrozen(plan.edits) && plan.edits.every(Object.isFrozen));
  const first = applyTerminalStatus(root);assert.equal(first.changed, 3);
  const after = read(assets, native);assert.equal(applyTerminalStatus(root).changed, 0);
  for (const name of Object.keys(native)) {
    assert.equal(fs.statSync(path.join(assets, name)).mode & 0o777, 0o640);
    if (name.includes("tl5a") || name.includes("XQr6") || name.includes("Bl6U")) assert.equal(after[name], native[name]);
  }
}));

test("malformed hidden same-ID owner or readonly peers reject before any write", () => {
  for (const [id, from, to] of [
    ["EU9a", 'return e?"loading"', 'return e?"idle"'],
    ["XQr6", 'type:"thread",key:t,field:"listState"', 'type:"host",key:t,field:"listState"'],
    ["e9KY", 'a=n("zTeN")', 'a=n("foreignAtoms")'],
  ]) {
    const sources = h.sources();sources["async/hidden.js"] = sources[`async/${id}.js`].replace(from, to);
    temporary(sources, (root, assets) => { assert.throws(() => applyTerminalStatus(root));assert.deepEqual(read(assets, sources), sources); });
  }
});

test("mid-transaction I/O failure restores all original target and readonly bytes", () => temporary(h.sources(), (root, assets) => {
  const sources = h.sources();let calls = 0;
  assert.throws(() => applyTerminalStatus(root, { writeFileSync(file, data) { calls++;if (calls === 2) throw Error("injected mid-write fault");fs.writeFileSync(file, data); } }), /injected mid-write/);
  assert.deepEqual(read(assets, sources), sources);
  assert.ok(calls >= 4, "both attempted targets restored through transaction rollback");
}));
