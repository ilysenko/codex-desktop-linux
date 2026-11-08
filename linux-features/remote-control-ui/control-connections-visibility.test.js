"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { patchWebviewAssets } = require("../../scripts/patches/lib/assets.js");
const { createJavaScriptLexicalIndex } = require("../../scripts/patches/lib/minified-js.js");
const { prepareRemoteControlConnectionsVisibility: prepare, applyRemoteControlConnectionsVisibility: apply } = require("./control-connections-visibility.js");
const { applyRemoteConnectionsVisibility: applyEntry } = require("./remote-connections-visibility.js");
const { fixture, fixtureSources, snapshots, writeApp } = require("./control-visibility.test-helpers.js");
function temporary(fn) {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), "remote-control-visibility-"));
  try { return fn(app); } finally { fs.rmSync(app, { recursive: true, force: true }); }
}
function transition(sources, contribution = "ui", enabled = true) {
  return { ...sources, ...Object.fromEntries(prepare(snapshots(sources), contribution, enabled).edits.map(edit => [edit.assetName, edit.patchedSource])) };
}
function rejects(change, message = /Remote control visibility/) {
  const sources = fixtureSources();
  change(sources);
  const before = JSON.stringify(sources);
  assert.throws(() => prepare(snapshots(sources)), message);
  assert.equal(JSON.stringify(sources), before);
}
function evaluate(row, body, state, flag, linux) {
  // Complete bounded native858-byte module factory, with injected providers.
  // No app bootstrap, vendor factory, actual catalog subscription or RPC.
  const exports = {}, loader = id => ({
    QosV: { c: count => Array(count).fill(Symbol.for("react.memo_cache_sentinel")) },
    zTeN: { Ul: () => state }, xS4d: { h9: "catalog-state" }, PIwo: { mC: () => flag },
  })[id];
  loader.d = (target, getters, values) => { for (const [key, get] of Object.entries(getters)) Object.defineProperty(target, key, { get }); Object.assign(target, values); };
  new Function(...row.params, "navigator", body)(undefined, exports, loader, linux == null ? undefined : { userAgent: linux ? "Linux" : "Windows" });
  return exports;
}

test("all six current published predicate and hook copies preserve actual availability/access policy", () => {
  const current = fixtureSources(), ui = transition(current), cohort = snapshots(ui);
  assert.equal(cohort.visibility.length, 6);
  for (const [index, row] of cohort.visibility.entries()) for (const [state, flag, linux, expected] of [
    [{ available: true, accessRequired: false }, false, true, true],
    [{ available: false, accessRequired: false }, false, true, false],
    [{ available: true, accessRequired: true }, true, true, false],
    [{ available: true, accessRequired: false }, false, false, false],
    [{ available: true, accessRequired: false }, true, false, true],
    [undefined, false, true, true],
    [{ available: true, accessRequired: false }, false, null, false],
  ]) {
    const before = JSON.stringify(state);
    const exports = evaluate(fixture.roles.visibility[index], row.moduleSource, state, flag, linux);
    assert.equal(exports.Zi({ remoteControlConnectionsState: state, slingshotEnabled: flag }), expected);
    assert.equal(exports.wi(), expected);
    assert.equal(JSON.stringify(state), before);
  }
});

test("the native published tab selector remains unchanged across the UI contribution", () => {
  const ui = snapshots(transition(fixtureSources())).visibility;
  for (const [index, row] of ui.entries()) {
    const original = evaluate(fixture.roles.visibility[index], fixture.roles.visibility[index].moduleSource, undefined, false, false).HZ;
    const changed = evaluate(fixture.roles.visibility[index], row.moduleSource, undefined, false, true).HZ;
    for (const tab of ["control-this-mac", "access-other-devices", "ssh", "wsl"]) for (const show of [false, true]) {
      const input = { selectedConnectionsTab: tab, showControlOtherDevices: show, showControlThisMacTab: !show,
        showRemoteControlConnectionsSection: show, showRemoteSshConnections: !show, showTabbedSshPage: show,
        isWslConnectionsLoading: !show, showWslConnections: show };
      assert.equal(changed(input), original(input));
    }
  }
});

test("the future mobile/joint protocol composes and inverses exactly without qualifying the existing UP83 adapter", () => {
  const original = fixtureSources(), ui = transition(original), mobile = transition(original, "mobile");
  const jointA = transition(ui, "mobile"), jointB = transition(mobile);
  assert.deepEqual(jointA, jointB);
  assert.deepEqual(transition(jointA, "ui", false), mobile);
  assert.deepEqual(transition(jointA, "mobile", false), ui);
  assert.deepEqual(transition(ui, "ui", false), original);
  assert.deepEqual(transition(mobile, "mobile", false), original);
  assert.deepEqual(transition(jointA), jointA);
  for (const row of snapshots(jointA).visibility) {
    const model = { params: row.params };
    for (const required of [false, true]) {
      const state = Object.freeze({ available: false, accessRequired: required, authRequired: true, clientAuthorized: false });
      const api = evaluate(model, row.moduleSource, state, false, true);
      assert.equal(api.Zi({ remoteControlConnectionsState: state, slingshotEnabled: false }), !required);
    }
  }
});

test("actual UP77 and UP78 adapters work in both orders and repeat byte-identically", () => {
  const outputs = [];
  for (const order of [[applyEntry, apply], [apply, applyEntry]]) temporary(app => {
    const sources = fixtureSources(), assets = writeApp(app, sources);
    for (const action of order) assert.ok(action(app).changed > 0);
    const before = Object.fromEntries(Object.keys(sources).map(name => [name, fs.readFileSync(path.join(assets, name), "utf8")]));
    assert.equal(applyEntry(app).changed, 0);
    assert.equal(apply(app).changed, 0);
    assert.deepEqual(Object.fromEntries(Object.keys(sources).map(name => [name, fs.readFileSync(path.join(assets, name), "utf8")])), before);
    outputs.push(before);
  });
  assert.deepEqual(outputs[0], outputs[1]);
});

test("missing/ambiguous identities and damaged physical peers cannot prepare a partial cohort", () => {
  rejects(s => { delete s["async/catalog.js"]; });
  rejects(s => { s["async/visibility-4.js"] = s["async/visibility-4.js"].replace('accessRequired!==!0', 'accessRequired===!1'); });
  rejects(s => { s["async/visibility-5.js"] = s["async/visibility-5.js"].replace('Zi:n,', 'wrong:n,'); });
  const c = snapshots();c.visibility.push({ ...c.visibility[0], assetName: "other.js", moduleId: "anotherIdentity" });
  assert.throws(() => prepare(c), /ambiguous/);
});

test("wrong publications, imports, scope, reassignment and opaque decoys are refused", () => {
  for (const change of [
    s => { s["async/visibility-0.js"] = s["async/visibility-0.js"].replace('s.mC', 's.Ik'); },
    s => { s["async/visibility-0.js"] = s["async/visibility-0.js"].replace('a.h9', 'a.Zr'); },
    s => { s["async/visibility-0.js"] = s["async/visibility-0.js"].replace('"xS4d"', '"otherCatalog"'); },
    s => { s["async/visibility-0.js"] = s["async/visibility-0.js"].replace('var o=', 'var opaque="remoteControlConnectionsState:";var o='); },
    s => { s["async/visibility-0.js"] = s["async/visibility-0.js"].replace('function l(', 's={mC:()=>true};function l('); },
    s => { s["async/catalog.js"] = s["async/catalog.js"].replace('e(d)?.remoteControlState', 'e(d)?.remoteControl'); },
    s => { s["async/visibility-0.js"] = s["async/visibility-0.js"].replace('return"wsl"', 'return\n"wsl"'); },
    s => { s["async/visibility-0.js"] = s["async/visibility-0.js"].replace('uodG(e,t,n)', 'uodG(navigator,t,n)'); },
    s => { s["async/visibility-0.js"] = s["async/visibility-0.js"].replace('toString', 'wrong').replace('"control-this-mac"', '"control-this -mac"'); },
  ]) rejects(change);
  const c = snapshots();c.catalog[0] = { ...c.catalog[0], source: c.catalog[0].source + "mutated", start: 1 };
  assert.throws(() => prepare(c), /stale catalog/);
});

test("mixed states, canonical tampering and changed UP77 dependency inverse are rejected", () => {
  const pristine = fixtureSources(), ui = transition(pristine);
  assert.throws(() => prepare(snapshots({ ...pristine, "async/visibility-0.js": ui["async/visibility-0.js"] })), /partially applied/);
  for (const mutate of [text => text.replace('includes(`Linux`)', 'includes(`Windows`)'), text => text.replace('?.available??!0', '?.available??!1'),
    text => text.replace('accessRequired!==!0', 'accessRequired===!1')]) {
    const copy = { ...ui, "async/visibility-0.js": mutate(ui["async/visibility-0.js"]) };
    assert.throws(() => prepare(snapshots(copy)), /Remote control visibility/);
  }
  temporary(app => {
    const sources = fixtureSources(), assets = writeApp(app, sources);applyEntry(app);
    const body = fs.readFileSync(path.join(assets, "async/boolean-0.js"), "utf8").replace('includes(`Linux`)', 'includes(`Windows`)');
    fs.writeFileSync(path.join(assets, "async/boolean-0.js"), body);
    assert.throws(() => apply(app), /Could not find|Remote control visibility/);
  });
});

test("semantic factory-local and module identity renames retain the native graph", () => {
  const sources = fixtureSources(), ids = { uodG: "renamedVisibility", xS4d: "renamedCatalog", PIwo: "renamedGate", zTeN: "renamedAtoms", OWtl: "renamedScope" };
  for (const [name, source] of Object.entries(sources)) {
    let text = source;
    for (const [old, next] of Object.entries(ids)) text = text.replaceAll('"' + old + '"', '"' + next + '"').replace(new RegExp('(?<=[{,])' + old + '\\(', 'gu'), next + '(');
    const lexical = createJavaScriptLexicalIndex(text), tokens = [...text.matchAll(/\b(?:e|t|n|r|i|a|s|o|l|u|d|c|p|h|f|m|g|v|y|_)\b/gu)]
      .filter(match => lexical.isCode(match.index) && text[match.index - 1] !== "." && !/^\s*:/u.test(text.slice(match.index + match[0].length)));
    for (const token of tokens.reverse()) text = text.slice(0, token.index) + "local_" + token[0] + text.slice(token.index + token[0].length);
    sources[name] = text;
  }
  assert.equal(prepare(snapshots(sources, ids)).contributions.ui, true);
});

test("dependency readback rejects stale replay before any visibility write", () => temporary(app => {
  const sources = fixtureSources(), assets = writeApp(app, sources), plan = prepare(snapshots(sources));
  fs.appendFileSync(path.join(assets, "async/catalog.js"), "\n// changed dependency");
  assert.throws(() => patchWebviewAssets(assets, plan.edits), /changed before patch commit/);
  for (let i = 0; i < 6; i++) assert.equal(fs.readFileSync(path.join(assets, `async/visibility-${i}.js`), "utf8"), sources[`async/visibility-${i}.js`]);
}));

test("an interrupted peer write rolls back all bytes while retaining modes", () => temporary(app => {
  const sources = fixtureSources(), assets = writeApp(app, sources);let writes = 0;
  fs.chmodSync(path.join(assets, "async/visibility-0.js"), 0o640);
  assert.throws(() => apply(app, { writeFileSync(file, bytes) {
    if (++writes === 2) { fs.writeFileSync(file, bytes.subarray(0, 9));throw Error("interrupted peer write"); }
    fs.writeFileSync(file, bytes);
  } }), /interrupted peer write/);
  for (const [name, text] of Object.entries(sources)) assert.equal(fs.readFileSync(path.join(assets, name), "utf8"), text);
  assert.equal(fs.statSync(path.join(assets, "async/visibility-0.js")).mode & 0o777, 0o640);
  assert.equal(apply(app).changed, 6);
  assert.equal(apply(app).changed, 0);
  fs.writeFileSync(path.join(assets, "async/orphan.js"), 'const orphan="codexLinuxRemoteControlUiVisibilityEnabled";');
  assert.throws(() => apply(app), /orphan visibility marker/);
}));
