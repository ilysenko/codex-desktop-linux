"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const test = require("node:test");
const { createRequire } = require("node:module");
const { prepareRemoteMobileVisibility: prepare, locateRemoteMobileVisibility } = require("./remote-control-visibility.js");
const { patchWebviewAssets } = require("../../scripts/patches/lib/assets.js");
const harness = require("./fixtures/remote-visibility-harness.js");
const { fixture, sources, snapshots, applyEdits, writeApp, readApp } = harness;
const descriptor = require("./patch.js").find(row => row.id === "linux-remote-control-visibility");
const apply83 = descriptor.apply;
function temporary(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remote-mobile-visibility-"));
  try { return fn(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
function rejects(change) {
  const input = sources();change(input);const before = JSON.stringify(input);
  assert.throws(() => prepare(snapshots(input)));
  assert.equal(JSON.stringify(input), before);
}
function evaluate(copy, state, flag, linux) {
  const output = {}, load = id => ({
    QosV: { c: count => Array(count).fill(Symbol.for("react.memo_cache_sentinel")) },
    zTeN: { Ul: () => state }, xS4d: { h9: "state" }, PIwo: { mC: () => flag },
  })[id];
  load.d = (target, getters, values) => { for (const [name, get] of Object.entries(getters)) Object.defineProperty(target, name, { get });Object.assign(target, values); };
  // Complete bounded858-byte visibility factory with controlled providers;
  // no actual catalog, gate service, bootstrap, vendor factory or RPC.
  new Function(...copy.params, "navigator", copy.moduleSource)(undefined, output, load,
    linux == null ? undefined : { userAgent: linux ? "Linux" : "Windows" });
  return output;
}
function permutations(items) { return items.length ? items.flatMap((item, index) => permutations(items.filter((_, at) => at !== index)).map(rest => [item, ...rest])) : [[]]; }

test("the registered83 adapter owns a pre-webview cohort and leaves81 proposals read-only", () => temporary(root => {
  assert.equal(descriptor.phase, "extracted-app:pre-webview");assert.equal(descriptor.order, 20120);assert.equal(descriptor.assetNeedles, undefined);
  const input = sources(), cohort = snapshots(input), plan = prepare(cohort);
  const ownerBefore = cohort.gate[0].moduleSource, hookBefore = cohort.gateHook[0].moduleSource;
  const after = snapshots(applyEdits(input, plan));
  assert.equal(after.gate[0].moduleSource, ownerBefore);assert.equal(after.gateHook[0].moduleSource, hookBefore);
  assert.equal(plan.gatePeerState.load81, false);
  writeApp(root, input);assert.equal(apply83(root).changed, 6);assert.equal(apply83(root).changed, 0);
}));

test("all6native predicate/hook copies showLinux pre-enable/404 views but retain403 denial and actual input state", () => {
  const cohort = snapshots(applyEdits(sources(), prepare(snapshots())));
  for (const copy of cohort.visibility) for (const [linux, flag, available, accessRequired] of [
    [true, false, false, false], [true, false, true, true], [true, true, false, true],
    [false, false, true, false], [false, true, false, false], [false, true, true, false], [null, false, true, false],
  ]) {
    const state = Object.freeze({ available, accessRequired, authRequired: true, clientAuthorized: false, localRemoteControlClientId: null });
    const before = JSON.stringify(state), api = evaluate(copy, state, flag, linux);
    const expected = Boolean((linux === true || flag) && (linux === true || available) && !accessRequired);
    assert.equal(api.Zi({ remoteControlConnectionsState: state, slingshotEnabled: flag }), expected);
    assert.equal(api.wi(), expected);assert.equal(JSON.stringify(state), before);
  }
});

test("actual77/78/81/registered83 APIs compose in all24orders and repeat with identical bytes", () => {
  const ui = require("../remote-control-ui/patch.js").descriptors;
  const rmc = require("./patch.js");
  const apis = { 77: ui.find(row => row.id === "remote-connections-visibility").apply,
    78: ui.find(row => row.id === "remote-control-connections-visibility").apply,
    81: rmc.find(row => row.id === "linux-remote-control-load-gate").apply, 83: apply83 };
  const input = harness.combinedSources(require("../remote-control-ui/visibility.test-helpers.js").fixtureSources());
  let expected;
  for (const order of permutations([77, 78, 81, 83])) temporary(root => {
    writeApp(root, input);
    for (const id of order) assert.ok(apis[id](root).changed > 0, order.join("→") + ":" + id);
    const after = readApp(root, input);
    for (const id of order) assert.equal(apis[id](root).changed, 0, "repeat:" + order.join("→") + ":" + id);
    assert.deepEqual(readApp(root, input), after);
    if (expected) assert.deepEqual(after, expected);else expected = after;
  });
});

test("actualAPI joint output inverses to exact actualUI-only/mobile-only bytes while77/81 remain", () => {
  const ui = require("../remote-control-ui/patch.js").descriptors;
  const rmc = require("./patch.js"), uiPrepare = require("../remote-control-ui/control-connections-visibility.js").prepareRemoteControlConnectionsVisibility;
  const run77 = ui.find(row => row.id === "remote-connections-visibility").apply;
  const run78 = ui.find(row => row.id === "remote-control-connections-visibility").apply;
  const run81 = rmc.find(row => row.id === "linux-remote-control-load-gate").apply;
  const input = harness.combinedSources(require("../remote-control-ui/visibility.test-helpers.js").fixtureSources());
  function built(actions) { return temporary(root => { writeApp(root, input);for (const action of actions) action(root);return readApp(root, input); }); }
  const peers = built([run77, run81]), mobile = built([run77, run81, apply83]), onlyUi = built([run77, run81, run78]), joint = built([run77, run81, run78, apply83]);
  assert.deepEqual(applyEdits(joint, prepare(snapshots(joint), false)), onlyUi);
  const uiCohort = ({ visibility, catalog, gate }) => ({ visibility, catalog, gate });
  const withoutUi = applyEdits(joint, uiPrepare(uiCohort(snapshots(joint)), "ui", false));
  assert.deepEqual(withoutUi, mobile);
  assert.deepEqual(applyEdits(withoutUi, prepare(snapshots(withoutUi), false)), peers);
});

test("missing/ambiguous/damaged physical peers, publications, scope and canonical tampering refuse", () => {
  const asset = index => fixture.roles.visibility[index].sourceAsset.replace("webview/assets/", "");
  rejects(s => { s[asset(4)] = s[asset(4)].replace('accessRequired!==!0', 'accessRequired===!1'); });
  rejects(s => { s[asset(0)] = s[asset(0)].replace('Zi:l,', 'Other:l,'); });
  rejects(s => { s[asset(0)] = s[asset(0)].replace('"xS4d"', '"otherCatalog"'); });
  rejects(s => { s[asset(0)] = s[asset(0)].replace('s.mC', 's.Ik'); });
  rejects(s => { s[asset(0)] = s[asset(0)].replace('function l(', 's={mC:()=>true};function l('); });
  rejects(s => { s[asset(0)] = s[asset(0)].replace('"control-this-mac"', '"control-this -mac"'); });
  rejects(s => { s[asset(0)] = s[asset(0)].replace('return"wsl"', 'return\n"wsl"'); });
  const canonical = applyEdits(sources(), prepare(snapshots()));
  const mixed = { ...sources(), [asset(0)]: canonical[asset(0)] };assert.throws(() => prepare(snapshots(mixed)), /partially applied/);
  for (const mutate of [text => text.replace('includes(`Linux`)', 'includes(`Windows`)'), text => text.replace('accessRequired!==!0', 'accessRequired===!1')]) {
    assert.throws(() => prepare(snapshots({ ...canonical, [asset(0)]: mutate(canonical[asset(0)]) })));
  }
  const c = snapshots();c.catalog = [];assert.throws(() => prepare(c), /missing/);
  const ambiguous = snapshots();ambiguous.visibility.push({ ...ambiguous.visibility[0], assetName: "other.js", moduleId: "otherIdentity" });assert.throws(() => prepare(ambiguous), /ambiguous/);
});

test("native81callee changes and stale read-only dependencies fail before any83write", () => temporary(root => {
  const input = sources(), cohort = snapshots(input), plan = prepare(cohort), assets = writeApp(root, input);
  const dependency = cohort.gate[0].assetName;fs.appendFileSync(path.join(assets, dependency), "\n// changed dependency");
  assert.throws(() => patchWebviewAssets(assets, plan.edits), /changed before patch commit/);
  for (const copy of cohort.visibility) assert.equal(fs.readFileSync(path.join(assets, copy.assetName), "utf8"), input[copy.assetName]);
  const damaged = sources(), hook = snapshots(damaged).gateHook[0];
  assert.ok(hook.moduleSource.includes(".getLayer("));
  damaged[hook.assetName] = damaged[hook.assetName].replace(".getLayer(", ".wrongLayer(");
  assert.notEqual(damaged[hook.assetName], hook.source);
  assert.throws(() => prepare(snapshots(damaged)));
}));

test("interrupted83 peer writes roll back exact original bytes and modes", () => temporary(root => {
  const input = sources(), assets = writeApp(root, input), name = snapshots(input).visibility[0].assetName;fs.chmodSync(path.join(assets, name), 0o640);let writes = 0;
  assert.throws(() => apply83(root, { writeFileSync(file, bytes) {
    if (++writes === 2) { fs.writeFileSync(file, bytes.subarray(0, 9));throw Error("interrupted83peer"); }fs.writeFileSync(file, bytes);
  } }), /interrupted83peer/);
  assert.deepEqual(readApp(root, input), input);assert.equal(fs.statSync(path.join(assets, name)).mode & 0o777, 0o640);
  assert.equal(apply83(root).changed, 6);assert.equal(apply83(root).changed, 0);
  fs.writeFileSync(path.join(assets, "async/orphan.js"), 'const orphan="codexLinuxRemoteControlVisibilityEnabled";');
  assert.throws(() => apply83(root), /orphan visibility marker/);
}));

test("RMC-only andUI-only feature-source closures load and apply without the disabled sibling folder", () => {
  const source = path.resolve(__dirname, "../..");
  for (const feature of ["remote-mobile-control", "remote-control-ui"]) temporary(root => {
    const copied = new Set();
    fs.cpSync(path.join(source, "linux-features", feature), path.join(root, "linux-features", feature), { recursive: true });
    function closure(file) {
      const relative = path.relative(source, file);if (relative.startsWith("..") || path.isAbsolute(relative)) throw Error("source closure escape");
      if (copied.has(relative)) return;copied.add(relative);
      const target = path.join(root, relative);fs.mkdirSync(path.dirname(target), { recursive: true });fs.copyFileSync(file, target);
      const text = fs.readFileSync(file, "utf8");
      for (const match of text.matchAll(/require\((["'])(\.{1,2}\/[^"']+)\1\)/gu)) {
        let next = path.resolve(path.dirname(file), match[2]);if (!path.extname(next)) next += ".js";
        if (fs.existsSync(next)) closure(next);
      }
    }
    const entry = path.join(source, "linux-features", feature, "patch.js");closure(entry);
    const opposite = feature === "remote-mobile-control" ? "remote-control-ui" : "remote-mobile-control";
    assert.ok(!fs.existsSync(path.join(root, "linux-features", opposite)));
    assert.ok([...copied].every(relative => !relative.startsWith("linux-features/" + opposite + "/")));
    const load = createRequire(path.join(root, "entry.cjs")), exported = load(path.join(root, "linux-features", feature, "patch.js"));
    const rows = Array.isArray(exported) ? exported : exported.descriptors;
    const selected = rows.find(row => row.id === (feature === "remote-mobile-control" ? "linux-remote-control-visibility" : "remote-control-connections-visibility"));
    const app = path.join(root, "app");writeApp(app);assert.equal(selected.apply(app).changed, 6);assert.equal(selected.apply(app).changed, 0);
  });
});
