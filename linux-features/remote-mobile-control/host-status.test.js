"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const host = require("./fixtures/current-host-toggle.json").modules.find(x => x.moduleId === "ihPm"), graph = require("./fixtures/current-host-status-graph.json").modules;
const facades = require("./fixtures/current-enablement-bridge.json").facades;
const { applyStatusReadPatch, locateStatusReadCohort, prepareStatusReadString } = require("./host-status.js");
const { READ_MARKER } = require("./host-status-owner.js");
const oldWait = require("./patch.js").applyLinuxRemoteControlStatusWaitPatch;
function carrier(rows) { return `export const __webpack_modules__={${rows.map(row => `${JSON.stringify(row.moduleId)}(${row.params.join(",")}){${row.moduleSource}}`).join(",")}};`; }
function scene(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "native-status-cohort-"));t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const assets = path.join(dir, "webview/assets");fs.mkdirSync(assets, { recursive: true });
  const groups = { "a.js": [host], "b.js": [host], "lifecycle.js": graph.filter(x => ["dbK8", "hms3", "J8Ro"].includes(x.moduleId)), "literal.js": graph.filter(x => ["DBCl", "N2rm"].includes(x.moduleId)), "awaiter.js": graph.filter(x => x.moduleId === "q77y"), "service-a.js": [facades[0]], "service-b.js": [facades[1]] };
  for (const [name, rows] of Object.entries(groups)) fs.writeFileSync(path.join(assets, name), carrier(rows));
  return { dir, assets };
}
function snapshot(assets) { return Object.fromEntries(fs.readdirSync(assets).sort().map(name => [name, { bytes: fs.readFileSync(path.join(assets, name)), mode: fs.statSync(path.join(assets, name)).mode & 0o777 }])); }

test("all native reader copies and lifecycle providers form one repeatable atomic transaction", t => {
  const s = scene(t), before = snapshot(s.assets), first = applyStatusReadPatch(s.dir);assert.equal(first.changed, 2);assert.equal(first.targetCopies, 2);
  const after = snapshot(s.assets);for (const name of ["a.js", "b.js"]) assert.equal(after[name].bytes.length - before[name].bytes.length, 329);
  for (const name of ["lifecycle.js", "literal.js", "awaiter.js", "service-a.js", "service-b.js"]) assert.deepEqual(after[name], before[name]);
  assert.equal(applyStatusReadPatch(s.dir).changed, 0);assert.deepEqual(snapshot(s.assets), after);
});

test("hidden malformed reader, wrong literal, mixed wait peer and inconsistent manager copies reject", t => {
  for (const kind of ["hidden", "literal", "wait", "manager"]) {
    const s = scene(t);
    if (kind === "hidden") fs.writeFileSync(path.join(s.assets, "hidden.js"), carrier([{ ...host, moduleSource: host.moduleSource.replace('"remoteControl/status/read"', '"other/read"') }]));
    else if (kind === "literal") { const p = path.join(s.assets, "literal.js");fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace('r="durable"', 'r="cloud"')); }
    else if (kind === "wait") { const p = path.join(s.assets, "a.js");fs.writeFileSync(p, oldWait(fs.readFileSync(p, "utf8"))); }
    else { const m = graph.find(x => x.moduleId === "hms3");fs.writeFileSync(path.join(s.assets, "hidden-manager.js"), carrier([{ ...m, moduleSource: m.moduleSource.replace('u=n("uku1")', 'u=n("foreignmode")') }])); }
    const before = snapshot(s.assets);assert.throws(() => applyStatusReadPatch(s.dir));assert.deepEqual(snapshot(s.assets), before);
  }
});

test("read-only late service dependency must stay unchanged before reader writes", t => {
  const s = scene(t), before = snapshot(s.assets);let changed = false;
  assert.throws(() => applyStatusReadPatch(s.dir, { readFileSync(file) {
    if (!changed && String(file).endsWith("service-a.js")) { changed = true;fs.appendFileSync(file, "\n// concurrent service change"); }
    return fs.readFileSync(file);
  } }), /changed before patch commit/);
  const after = snapshot(s.assets);for (const name of ["a.js", "b.js"]) assert.deepEqual(after[name], before[name]);
});

test("partial second reader write restores attempted bytes and original modes", t => {
  const s = scene(t);fs.chmodSync(path.join(s.assets, "a.js"), 0o640);const before = snapshot(s.assets);let failed = false;
  assert.throws(() => applyStatusReadPatch(s.dir, { writeFileSync(file, bytes) {
    if (!failed && String(file).endsWith("b.js") && bytes.includes(Buffer.from(READ_MARKER))) { failed = true;fs.writeFileSync(file, bytes.subarray(0, 7));throw Error("controlled partial status write"); }
    fs.writeFileSync(file, bytes);
  } }), /partial status write/);
  assert.equal(failed, true);assert.deepEqual(snapshot(s.assets), before);
});

test("existing precise wait contribution composes in either order through production reader API", t => {
  const s = scene(t);
  for (const name of ["a.js", "b.js"]) { const p = path.join(s.assets, name);fs.writeFileSync(p, oldWait(fs.readFileSync(p, "utf8"))); }
  assert.equal(applyStatusReadPatch(s.dir).changed, 2);assert.equal(locateStatusReadCohort(s.assets).waitPeer, true);
  for (const name of ["a.js", "b.js"]) { const p = path.join(s.assets, name), text = fs.readFileSync(p, "utf8");assert.equal(oldWait(text), text);assert.equal(prepareStatusReadString(text), text); }
  assert.equal(applyStatusReadPatch(s.dir).changed, 0);
});
