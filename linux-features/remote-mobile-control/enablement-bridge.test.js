"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const fixture = require("./fixtures/current-enablement-bridge.json");
const { applyBridgePatch, locateBridgeCohort, prepareBridgeSource } = require("./enablement-bridge.js");
const { MARKER } = require("./enablement-bridge-owner.js");
function bridge() {
  const f = fixture.bridgeFragments;
  return { moduleId: f.moduleId, params: f.params, moduleSource: "var " + f.imports.map(row => `${row.local}=n(${JSON.stringify(row.moduleId)})`).join(",") + ";" + f.functions.map(row => row.source).join("") };
}
function carrier(rows) { return `export const __webpack_modules__={${rows.map(row => `${JSON.stringify(row.moduleId)}(${row.params.join(",")}){${row.moduleSource}}`).join(",")}};`; }
function scene(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-enablement-bridge-"));t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const assets = path.join(dir, "webview/assets");fs.mkdirSync(assets, { recursive: true });
  for (const [name, rows] of Object.entries({ "a.js": [bridge()], "b.js": [bridge()], "providers.js": [fixture.pairing, fixture.hook], "facade.js": [fixture.facades[0]], "facade-copy.js": [fixture.facades[1]] })) fs.writeFileSync(path.join(assets, name), carrier(rows));
  return { dir, assets };
}
function snapshot(assets) { return Object.fromEntries(fs.readdirSync(assets).sort().map(name => [name, { bytes: fs.readFileSync(path.join(assets, name)), mode: fs.statSync(path.join(assets, name)).mode & 0o777 }])); }

test("all bridge physical copies share exact native dependencies in one repeatable transaction", t => {
  const s = scene(t), before = snapshot(s.assets), first = applyBridgePatch(s.dir);
  assert.equal(first.changed, 2);assert.equal(first.targetCopies, 2);
  const after = snapshot(s.assets);
  for (const name of ["a.js", "b.js"]) assert.equal(after[name].bytes.length - before[name].bytes.length, 113);
  for (const name of ["providers.js", "facade.js", "facade-copy.js"]) assert.deepEqual(after[name], before[name]);
  assert.equal(applyBridgePatch(s.dir).changed, 0);assert.deepEqual(snapshot(s.assets), after);
  assert.equal(locateBridgeCohort(s.assets).alreadyApplied, true);
});

test("bad hidden facade peer, wrong hook publication and mixed bridge contributions reject before writes", t => {
  for (const kind of ["hidden", "hook", "mixed"]) {
    const s = scene(t);
    if (kind === "hidden") {
      const copy = { ...fixture.facades[0], moduleSource: fixture.facades[0].moduleSource.replace("appServices:()=>o", "appServices:()=>t") };
      fs.writeFileSync(path.join(s.assets, "hidden.js"), carrier([copy]));
    } else if (kind === "hook") {
      const p = path.join(s.assets, "providers.js");fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace("cn:u", "Wrong:u"));
    } else {
      const p = path.join(s.assets, "a.js");fs.writeFileSync(p, prepareBridgeSource(fs.readFileSync(p, "utf8")));
    }
    const before = snapshot(s.assets);assert.throws(() => applyBridgePatch(s.dir));assert.deepEqual(snapshot(s.assets), before);
  }
});

test("read-only facade changed between preparation and commit prevents all bridge writes", t => {
  const s = scene(t), before = snapshot(s.assets);let changed = false;
  assert.throws(() => applyBridgePatch(s.dir, { readFileSync(file) {
    if (!changed && String(file).endsWith("facade.js")) { changed = true;fs.appendFileSync(file, "\n// controlled concurrent service facade change"); }
    return fs.readFileSync(file);
  } }), /changed before patch commit/);
  const after = snapshot(s.assets);for (const name of ["a.js", "b.js"]) assert.deepEqual(after[name], before[name]);
});

test("controlled partial bridge write rolls back target bytes and original modes", t => {
  const s = scene(t);fs.chmodSync(path.join(s.assets, "a.js"), 0o640);const before = snapshot(s.assets);let failed = false;
  assert.throws(() => applyBridgePatch(s.dir, { writeFileSync(file, bytes) {
    if (!failed && String(file).endsWith("b.js") && bytes.includes(Buffer.from(MARKER))) { failed = true;fs.writeFileSync(file, bytes.subarray(0, 7));throw Error("controlled partial bridge write"); }
    fs.writeFileSync(file, bytes);
  } }), /partial bridge write/);
  assert.equal(failed, true);assert.deepEqual(snapshot(s.assets), before);
});
