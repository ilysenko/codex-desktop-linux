"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");
const { createJavaScriptLexicalIndex } = require("../../scripts/patches/lib/minified-js.js");
const { patchWebviewAssets } = require("../../scripts/patches/lib/assets.js");
const { prepareRemoteLoadGate: prepare, prepareRemoteLoadGateSource, applyRemoteLoadGate: apply, inspectRemoteLoadGateOwner } = require("./remote-load-gate.js");
const { MARKER } = require("./load-gate-peer.js");
const h = require("./fixtures/remote-load-gate-harness.js");
const ui77 = require("../remote-control-ui/remote-connections-visibility.js");
const ui78 = require("../remote-control-ui/control-connections-visibility.js");
const h77 = require("../remote-control-ui/visibility.test-helpers.js");
const h78 = require("../remote-control-ui/control-visibility.test-helpers.js");
function temporary(fn) {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), "remote-load-gate-"));
  try { return fn(app); } finally { fs.rmSync(app, { recursive: true, force: true }); }
}
function change(input, fn) { return Object.fromEntries(Object.entries(input).map(([name, text]) => [name, fn(text, name)])); }
function enable(input) { return h.applyEdits(input, prepare(h.snapshots(input))); }
function readApp(app, input) { return Object.fromEntries(Object.keys(input).map(name => [name, fs.readFileSync(path.join(app, "webview/assets", name), "utf8")])); }
function jointSources() {
  const input = h78.fixtureSources(), row = h.fixture.callee;
  input["async/native-hook.js"] = h.chunk(700, `${row.moduleId}(${row.params}){${row.moduleSource}}`);
  return input;
}
function transition(input, id) {
  return h.applyEdits(input, id === 81 ? prepare(h.snapshots(input)) : id === 77 ? ui77.prepareRemoteConnectionsVisibility(h77.snapshots(input)) : ui78.prepareRemoteControlConnectionsVisibility(h78.snapshots(input)));
}
function entryInverse(input) {
  const marker = "codexLinuxRemoteConnectionsVisibility";
  const inverse = change(input, text => text.replace(/\(([A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*\.JW,"4114442250"\))\|\|typeof navigator!==`undefined`&&navigator.userAgent.includes\(`Linux`\)\)\/\*codexLinuxRemoteConnectionsVisibility\*\//gu, "$1"));
  assert.ok(Object.values(input).some(text => text.includes(marker)));
  assert.ok(Object.values(inverse).every(text => !text.includes(marker)));
  return inverse;
}

test("native hook runs once before platform access and non-Linux returns retain every identity", () => {
  const native = h.sources(), patched = enable(native);
  const values = [true, false, 0, -0, null, undefined, "", NaN, Object.freeze({ native: true }), Symbol("native")];
  for (const ua of ["X11 Linux", "Macintosh", null]) for (const value of values) {
    const result = h.callMC(patched, ua, value);
    assert.equal(result.error, undefined);
    assert.ok(Object.is(result.result, ua?.includes("Linux") ? true : value));
    assert.deepEqual(result.calls, ["1042620455"]);
    assert.deepEqual(result.trace, ua === null ? ["native"] : ["native", "platform"]);
  }
  for (const ua of ["Linux", "Windows", null]) {
    const result = h.callMC(patched, ua, false, true);
    assert.equal(result.error, "native hook throw");
    assert.deepEqual(result.trace, ["native"]);
    assert.deepEqual(result.calls, ["1042620455"]);
  }
  assert.deepEqual(h.applyEdits(patched, prepare(h.snapshots(patched)), "nativeSource"), native);
  assert.deepEqual(enable(patched), patched);
});

test("fresh result bindings, semantic local names, and native horizontal trivia replay exactly", () => {
  for (const kind of ["collision", "renamed", "trivia"]) {
    const native = change(h.sources(), text => kind === "collision" ? text.replaceAll("function p(e){return e.autoConnect", "function codexLinuxRemoteControlNativeLoadGateResult(e){return e.autoConnect").replaceAll("a.flatMap(p)", "a.flatMap(codexLinuxRemoteControlNativeLoadGateResult)") : kind === "trivia" ? text.replace('return(0,l.Zj)("1042620455")', ' return \t(0, l.Zj) ("1042620455")\t') : (() => {
      const code = createJavaScriptLexicalIndex(text), tokens = [...text.matchAll(/\b(?:e|t|n|r|i|a|s|o|l|u|d|c|p|h|f)\b/gu)].filter(row => code.isCode(row.index) && text[row.index - 1] !== "." && !/^\s*:/u.test(text.slice(row.index + row[0].length)));
      for (const row of tokens.reverse()) text = text.slice(0, row.index) + "local_" + row[0] + text.slice(row.index + row[0].length);
      return text;
    })());
    const patched = enable(native);
    assert.deepEqual(enable(patched), patched, kind);
    assert.deepEqual(h.applyEdits(patched, prepare(h.snapshots(patched)), "nativeSource"), native, kind);
    if (kind === "collision") assert.match(Object.values(patched)[0], /const codexLinuxRemoteControlNativeLoadGateResult\$=/u);
  }
});

test("complete current owner/callee publications and shared providers are required", () => {
  const mutations = [
    text => text.replace('mC:function()', 'mC:function(value)'),
    text => text.replace('mC:function()', 'wrong:function()'),
    text => text.replace('"1042620455"', '"1042620456"'),
    text => text.replace('"4114442250"', '"4114442251"'),
    text => text.replace('return(0,l.Zj)', 'return(0,o.Ks)'),
    text => text.replace('i=n("zTeN")', 'i=n("wrongAtoms")'),
    text => text.replace('var r=n("QosV")', 'var r=n("wrongMemo")'),
    text => text.replace('n=(0,r.c)(2)', 'n=(0,r.c)(3)'),
    text => text.replace('scope:o.JW.scope', 'scope:o.JW.wrong'),
    text => text.replace('mC:function(){return', 'mC:function(){l={Zj(){return true}};return'),
    text => text.replace('PIwo(e,t,n)', 'PIwo(navigator,t,n)'),
  ];
  // Import IDs may rename together; independently changed shared atom/memo identities fail.
  for (const mutate of mutations) {
    const native = h.sources(), broken = change(native, mutate);
    assert.notDeepEqual(broken, native);
    assert.throws(() => prepare(h.snapshots(broken)), /Remote load gate|Remote load gate peer/);
    assert.deepEqual(native, h.sources());
  }
  const source = h.source();
  for (const broken of ["function unrelated(){}", source.replace(/,hZax\(e,t,n\)\{.*(?=\};$)/u, ""), source + source, source + `\n/*${MARKER}*/`]) assert.throws(() => prepareRemoteLoadGateSource(broken), /Remote load gate|Rspack/);
});

test("canonical marker bodies and native inverse, rather than marker presence, authorize repeats", () => {
  const patched = enable(h.sources());
  for (const mutate of [
    text => text.replace("includes(`Linux`)", "includes(`Windows`)"),
    text => text.replace("?true:", "?false:"),
    text => text.replace(";return typeof navigator", ";(0,l.Zj)(\"1042620455\");return typeof navigator"),
    text => text.replace("codexLinuxRemoteControlNativeLoadGateResult=", "other="),
    text => text.replace(`/*${MARKER}*/`, `/*${MARKER}*//*${MARKER}*/`),
    text => text.replace(`/*${MARKER}*/`, ""),
    text => text.replace("new Set(a.flatMap(p))", "new Set([])"),
  ]) assert.throws(() => prepare(h.snapshots(change(patched, mutate))), /Remote load gate|Remote load gate peer/);
  assert.throws(() => prepare(h.snapshots(change(h.sources(), text => text.replace('mC:function(){return', `mC:function(){/*${MARKER}*/return`)))), /Remote load gate peer/);
});

test("all physical copies validate before writing and interrupted writes restore every byte and mode", () => temporary(app => {
  const first = h.source(), sources = { "async/a.js": first, "async/b.js": first }, assets = h.writeApp(app, sources);
  const plan = prepare(h.snapshots(sources));
  const stale = h.snapshots(sources);stale.owner[0] = { ...stale.owner[0], start: stale.owner[0].start + 1 };
  assert.throws(() => prepare(stale), /stale/);
  const mixed = { ...sources, "async/a.js": enable(sources)["async/a.js"] };
  assert.throws(() => prepare(h.snapshots(mixed)), /mixed/);
  assert.throws(() => prepare(h.snapshots({ ...sources, "async/b.js": first.replace('n=(0,r.c)(2)', 'n=(0,r.c)(3)') })), /callee grammar/);
  let writes = 0;
  assert.throws(() => apply(app, { writeFileSync(file, bytes) {
    if (++writes === 2) { fs.writeFileSync(file, bytes.subarray(0, 9));throw Error("interrupted load gate write"); }
    fs.writeFileSync(file, bytes);
  } }), /interrupted load gate write/);
  assert.deepEqual(readApp(app, sources), sources);
  for (const name of Object.keys(sources)) assert.equal(fs.statSync(path.join(assets, name)).mode & 0o777, 0o640);
  fs.appendFileSync(path.join(assets, "async/a.js"), "\n// changed dependency");
  assert.throws(() => patchWebviewAssets(assets, plan.edits), /changed before patch commit/);
  assert.equal(fs.readFileSync(path.join(assets, "async/b.js"), "utf8"), first);
  fs.writeFileSync(path.join(assets, "async/a.js"), first);
  assert.equal(apply(app).changed, 2);
  assert.equal(apply(app).changed, 0);
  fs.writeFileSync(path.join(assets, "async/orphan.js"), `/*${MARKER}*/`);
  assert.throws(() => apply(app), /orphan/);
}));

test("real UP77, UP78 and UP81 adapters compose in all six orders, repeat, and invert only their contribution", () => {
  const native = jointSources(), expected = [77, 78, 81].reduce(transition, native);
  const permutations = [[77,78,81],[77,81,78],[78,77,81],[78,81,77],[81,77,78],[81,78,77]];
  const adapters = { 77: ui77.applyRemoteConnectionsVisibility, 78: ui78.applyRemoteControlConnectionsVisibility, 81: apply };
  for (const order of permutations) temporary(app => {
    const current = order.reduce(transition, native);
    assert.deepEqual(current, expected, String(order));
    assert.deepEqual([81, 77, 78].reduce(transition, current), current);
    assert.deepEqual(h.applyEdits(current, prepare(h.snapshots(current)), "nativeSource"), [77, 78].reduce(transition, native));
    assert.deepEqual(h.applyEdits(current, ui78.prepareRemoteControlConnectionsVisibility(h78.snapshots(current), "ui", false)), [77, 81].reduce(transition, native));
    assert.deepEqual(entryInverse(current), [78, 81].reduce(transition, native));
    const state = h77.snapshots(current).state;
    assert.deepEqual(state.map(row => row.moduleSource), h77.snapshots(transition(native, 77)).state.map(row => row.moduleSource), "cpC0 untouched by 81/78");
    h.writeApp(app, native);
    for (const id of order) assert.ok(adapters[id](app).changed > 0);
    assert.deepEqual(readApp(app, native), expected, `actual adapters ${order}`);
    for (const id of order) assert.equal(adapters[id](app).changed, 0);
    assert.deepEqual(readApp(app, native), expected);
  });
  for (const peer of [77, 78]) {
    assert.deepEqual(transition(transition(native, peer), 81), transition(transition(native, 81), peer));
    assert.deepEqual(h.applyEdits(transition(native, 81), prepare(h.snapshots(transition(native, 81))), "nativeSource"), native);
  }
});

test("both UI consumers reject marker-only, damaged, and mixed UP81 physical contributions", () => {
  const native = jointSources();
  const originalOwner = h.snapshots(native).owner[0];
  native["async/boolean-extra.js"] = originalOwner.source;
  const patched = transition(native, 81);
  const booleanNames = h.snapshots(native).owner.map(row => row.assetName);
  for (const input of [
    { ...native, [booleanNames[0]]: patched[booleanNames[0]] },
    change(patched, text => text.replace("?true:", "?false:")),
    change(native, text => text.replace('mC:function(){return', `mC:function(){/*${MARKER}*/return`)),
  ]) for (const [preparePeer, snapshot] of [[ui77.prepareRemoteConnectionsVisibility, h77.snapshots], [ui78.prepareRemoteControlConnectionsVisibility, h78.snapshots]]) assert.throws(() => preparePeer(snapshot(input)), /Remote|load.gate/);
});

test("UI-only and mobile-only production builder trees work with the other feature folder absent", () => temporary(root => {
  for (const feature of ["remote-control-ui", "remote-mobile-control"]) {
    const tree = path.join(root, feature), destination = path.join(tree, "linux-features", feature);
    fs.mkdirSync(destination, { recursive: true });
    const source = path.resolve(__dirname, "..", feature);
    fs.cpSync(source, destination, { recursive: true, verbatimSymlinks: true });
    const pruned = spawnSync("bash", [
      "--noprofile", "--norc", "-e", "-c",
      'source "$1"\nremove_update_builder_test_files "$2"',
      "prune-builder-feature",
      path.resolve(__dirname, "../../scripts/lib/package-common.sh"),
      destination,
    ], { encoding: "utf8" });
    assert.equal(pruned.status, 0, pruned.stderr);
    assert.equal(fs.existsSync(path.join(destination, "fixtures")), false);
    assert.equal(fs.existsSync(path.join(destination, "test.js")), false);
    fs.symlinkSync(path.resolve(__dirname, "../../scripts"), path.join(tree, "scripts"), "dir");
    assert.equal(fs.existsSync(path.join(tree, "linux-features", feature === "remote-control-ui" ? "remote-mobile-control" : "remote-control-ui")), false);
    const snapshots = h.snapshots(enable(h.sources()));
    const code = feature === "remote-mobile-control" ? `const p=require(${JSON.stringify(path.join(destination, "remote-load-gate.js"))});p.prepareRemoteLoadGate(${JSON.stringify(snapshots)});require(${JSON.stringify(path.join(destination, "patch.js"))});` : `const p=require(${JSON.stringify(path.join(destination, "load-gate-peer.js"))});if(!p.projectLoadGatePeer(${JSON.stringify(snapshots.owner[0])}).active)throw Error("missing peer");require(${JSON.stringify(path.join(destination, "patch.js"))});`;
    const result = spawnSync(process.execPath, ["-e", code], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
  const owner = inspectRemoteLoadGateOwner(h.snapshots(enable(h.sources())).owner[0]);
  assert.equal(owner.inline.active, true);
  assert.equal(owner.entry, false);
  assert.equal(owner.imports[5].moduleId, "hZax");
}));
