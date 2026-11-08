"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const fixture = require("./fixtures/current-host-toggle.json");
const { MARKER } = require("./host-toggle-owner.js");
const { applyHostTogglePatch, applyHostToggleSource, locateHostToggleCohort } = require("./host-toggle.js");

function carrier(rows) {
  return `export const __webpack_modules__={${rows.map(row => `${JSON.stringify(row.moduleId)}(${row.params.join(",")}){${row.moduleSource}}`).join(",")}};`;
}
function scene(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-host-toggle-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const assets = path.join(dir, "webview/assets"); fs.mkdirSync(assets, { recursive: true });
  const targets = fixture.modules.filter(x => x.moduleId === "WbV5");
  const groups = { "a.js": [targets[0]], "b.js": [targets[1]],
    "provider.js": fixture.modules.filter(x => ["Dgwo", "ihPm"].includes(x.moduleId)),
    "caller.js": fixture.modules.filter(x => x.moduleId === "UIre") };
  for (const [name, rows] of Object.entries(groups)) fs.writeFileSync(path.join(assets, name), carrier(rows));
  return { dir, assets };
}
function snapshot(assets) {
  return Object.fromEntries(fs.readdirSync(assets).sort().map(name => [name,
    { bytes: fs.readFileSync(path.join(assets, name)), mode: fs.statSync(path.join(assets, name)).mode & 0o777 }]));
}

test("two real target copies and read-only providers/caller form one atomic repeatable cohort", t => {
  const s = scene(t), before = snapshot(s.assets);
  const first = applyHostTogglePatch(s.dir);
  assert.equal(first.changed, 2); assert.equal(first.targetCopies, 2);
  const after = snapshot(s.assets);
  assert.equal(after["a.js"].bytes.length - before["a.js"].bytes.length, 48);
  assert.equal(after["b.js"].bytes.length - before["b.js"].bytes.length, 48);
  assert.deepEqual(after["provider.js"], before["provider.js"]);
  assert.deepEqual(after["caller.js"], before["caller.js"]);
  assert.equal(applyHostTogglePatch(s.dir).changed, 0);
  assert.deepEqual(snapshot(s.assets), after);
  const plan = locateHostToggleCohort(s.assets);
  assert.equal(plan.alreadyApplied, true);
  assert.equal(plan.dependencyAssets.length, 4);
});

test("wrong provider publication, hidden damaged same-ID peer and mixed states write nothing", t => {
  for (const kind of ["provider", "hidden", "mixed"]) {
    const s = scene(t);
    if (kind === "provider") {
      const p = path.join(s.assets, "provider.js");fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace("V:function(e,t)", "Other:function(e,t)"));
    } else if (kind === "hidden") {
      const row = fixture.modules.find(x => x.moduleId === "WbV5");
      fs.writeFileSync(path.join(s.assets, "hidden.js"), carrier([{ ...row, moduleSource: row.moduleSource.replace("(0,a.V)(e,t)", '(0,a.V)(e,"wrong")') }]));
    } else {
      const p = path.join(s.assets, "a.js");fs.writeFileSync(p, applyHostToggleSource(fs.readFileSync(p, "utf8")));
    }
    const before = snapshot(s.assets);
    assert.throws(() => applyHostTogglePatch(s.dir));
    assert.deepEqual(snapshot(s.assets), before);
  }
});

test("changed read-only dependency is rejected before any target write", t => {
  const s = scene(t), before = snapshot(s.assets);let changed = false;
  assert.throws(() => applyHostTogglePatch(s.dir, { readFileSync(file) {
    if (!changed && String(file).endsWith("provider.js")) { changed = true;fs.appendFileSync(file, "\n// concurrent dependency change"); }
    return fs.readFileSync(file);
  } }), /changed before patch commit/);
  const after = snapshot(s.assets);
  assert.deepEqual(after["a.js"], before["a.js"]);
  assert.deepEqual(after["b.js"], before["b.js"]);
});

test("partial second write restores every attempted target and its original mode", t => {
  const s = scene(t);fs.chmodSync(path.join(s.assets, "a.js"), 0o640);
  const before = snapshot(s.assets);let failed = false;
  assert.throws(() => applyHostTogglePatch(s.dir, { writeFileSync(file, bytes) {
    if (!failed && String(file).endsWith("b.js") && bytes.includes(Buffer.from(MARKER))) {
      failed = true;fs.writeFileSync(file, bytes.subarray(0, 9));throw Error("controlled partial write");
    }
    fs.writeFileSync(file, bytes);
  } }), /partial write/);
  assert.equal(failed, true);assert.deepEqual(snapshot(s.assets), before);
});
