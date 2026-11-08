"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createJavaScriptLexicalIndex } = require("../../scripts/patches/lib/minified-js.js");
const { patchWebviewAssets } = require("../../scripts/patches/lib/assets.js");
const { prepareRemoteConnectionsVisibility, applyRemoteConnectionsVisibility } = require("./remote-connections-visibility.js");
const { fixture, fixtureSources, snapshots, writeFixtureApp } = require("./visibility.test-helpers.js");

function temporary(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remote-entry-"));
  try { return fn(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
function patchedSources(sources) {
  const plan = prepareRemoteConnectionsVisibility(snapshots(sources));
  return { ...sources, ...Object.fromEntries(plan.edits.map(row => [row.assetName, row.patchedSource])) };
}
function assertRefuses(change) {
  const sources = fixtureSources();
  change(sources);
  const before = JSON.stringify(sources);
  assert.throws(() => prepareRemoteConnectionsVisibility(snapshots(sources)), /Remote connections visibility/);
  assert.equal(JSON.stringify(sources), before);
}

// Only these bounded published native gate factories execute, with injected
// atoms/config/gates. No upstream bundle initialization, network or services.
function readGate(role, source, { linux = false, gate = false, loading = false, config = {} } = {}) {
  const row = fixture.roles[role][0], exported = {};
  const imports = {
    zTeN: { un: (_scope, read) => read, i1: (_scope, read) => read },
    tl5a: { Dc: "host" }, B81s: { I2: "config" }, OWtl: { u: 0 }, OMIV: { JW: "gate" },
  };
  const loader = id => imports[id] ?? {};
  loader.d = (target, getters, values) => { for (const [name, get] of Object.entries(getters)) Object.defineProperty(target, name, { get }); Object.assign(target, values); };
  const body = source ?? row.moduleSource;
  new Function(...row.params, "navigator", body)(undefined, exported, loader, linux ? { userAgent: "Linux" } : { userAgent: "Windows" });
  const get = atom => atom === "config" ? { data: { config }, isLoading: loading } : atom === "gate" ? gate : "local";
  return exported[role === "boolean" ? "bc" : "e"]({ get });
}

test("the two bounded current native gates preserve rollout/config/loading and open together on Linux", () => {
  const plan = prepareRemoteConnectionsVisibility(snapshots());
  assert.equal(plan.alreadyApplied, false);
  assert.equal(plan.edits.length, 2);
  for (const role of ["boolean", "state"]) {
    const body = snapshots(patchedSources(fixtureSources()))[role][0].moduleSource;
    assert.equal(readGate(role, body, { linux: true }), role === "boolean" ? true : "enabled");
    assert.equal(readGate(role, body), role === "boolean" ? false : "disabled");
    assert.equal(readGate(role, body, { gate: true }), role === "boolean" ? true : "enabled");
    assert.equal(readGate(role, body, { loading: true }), role === "boolean" ? false : "loading");
    assert.equal(readGate(role, body, { config: { "features.remote_connections": true } }), role === "boolean" ? true : "enabled");
    assert.equal(readGate(role, body, { config: { features: { remote_connections: true } } }), role === "boolean" ? true : "enabled");
    assert.equal(readGate(role, body, { config: { features: Object.create({ remote_connections: true }) } }), role === "boolean" ? false : "disabled");
    assert.equal(readGate(role, body, { config: { features: [] } }), role === "boolean" ? false : "disabled");
  }
  const canonical = patchedSources(fixtureSources());
  const repeat = prepareRemoteConnectionsVisibility(snapshots(canonical));
  assert.equal(repeat.alreadyApplied, true);
  assert.ok(repeat.edits.every(row => row.source === row.patchedSource));
});

test("the bounded native RemoteConnectionsPage uses the published boolean to preserve both redirect branches", () => {
  const body = snapshots(patchedSources(fixtureSources())).boolean[0].moduleSource;
  const native = fixture.roles.navigationCaller[0];
  for (const linux of [false, true]) {
    const exported = {}, modules = {
      ABep: { jsx: (_kind, props) => props },
      QosV: { c: count => Array(count).fill(Symbol.for("react.memo_cache_sentinel")) },
      HZfM: { C5: "Navigate" }, PIwo: { Ik: () => readGate("boolean", body, { linux }) },
    };
    const loader = id => modules[id];
    loader.d = (target, _getters, values) => Object.assign(target, values);
    new Function(...native.params, native.moduleSource)(undefined, exported, loader);
    assert.deepEqual(exported.RemoteConnectionsPage(), { to: linux ? "/settings/connections" : "/", replace: true });
  }
});

test("semantic local and module identity renames retain the two native caller links", () => {
  let sources = fixtureSources();
  const modules = { PIwo: "newBoolean", cpC0: "newStatus", zTeN: "newAtoms", tl5a: "newHost", B81s: "newConfig", OWtl: "newScope", OMIV: "newGates" };
  for (const [file, original] of Object.entries(sources)) {
    let text = original;
    for (const [old, next] of Object.entries(modules)) text = text.replaceAll('"' + old + '"', '"' + next + '"').replace(new RegExp('(?<=[{,])' + old + '\\(', 'g'), next + '(');
    const lexical = createJavaScriptLexicalIndex(text);
    const replacements = [...text.matchAll(/\b(?:e|t|n|r|i|a|s|o|l|u|d|c|p|h|f|m|g|v|y|_)\b/gu)]
      .filter(token => lexical.isCode(token.index) && text[token.index - 1] !== "." && !/^\s*:/u.test(text.slice(token.index + token[0].length)))
      .map(token => ({ start: token.index, end: token.index + token[0].length, value: "renamed_" + token[0] }));
    for (const token of replacements.reverse()) text = text.slice(0, token.start) + token.value + text.slice(token.end);
    sources[file] = text;
  }
  // Snapshot roles deliberately follow renamed identities rather than filenames.
  const { rspackModuleFactories } = require("../../scripts/patches/lib/rspack-module-assets.js");
  const all = Object.entries(sources).flatMap(([name, text]) => [...rspackModuleFactories(text, name)]);
  const cohort = Object.fromEntries(Object.entries(fixture.roles).map(([role, rows]) => [role, all.filter(row => row.moduleId === (modules[rows[0].moduleId] ?? rows[0].moduleId))]));
  assert.equal(prepareRemoteConnectionsVisibility(cohort).alreadyApplied, false);
});

test("missing, ambiguous and damaged physical cohorts fail without a partial plan", () => {
  assertRefuses(s => { delete s["async/state-0.js"]; });
  assertRefuses(s => { s["async/stateCaller-1.js"] = s["async/stateCaller-1.js"].replace('"connection"===', '"wrong"==='); });
  assertRefuses(s => { s["async/boolean-1.js"] = s["async/boolean-0.js"].replace('bc:d', 'wrong:d'); });
  const cohort = snapshots();
  cohort.boolean.push({ ...cohort.boolean[0], moduleId: "ambiguous", assetName: "extra.js" });
  assert.throws(() => prepareRemoteConnectionsVisibility(cohort), /ambiguous/);
});

test("shadowing, reassignment, opaque code and wrong exports reject the complete current grammar", () => {
  for (const change of [
    s => { s["async/boolean-0.js"] = s["async/boolean-0.js"].replace('let d=', 'r={un:()=>true};let d='); },
    s => { s["async/state-0.js"] = s["async/state-0.js"].replace('if(e(p.JW', 'let p={JW:true};if(e(p.JW'); },
    s => { s["async/boolean-0.js"] = s["async/boolean-0.js"].replace('let d=', 'let opaque="4114442250";let d='); },
    s => { s["async/boolean-0.js"] = s["async/boolean-0.js"].replace('bc:d', 'bc:()=>d'); },
    s => { s["async/state-0.js"] = s["async/state-0.js"].replace('e:m,gK', 'e:g,gK'); },
    s => { s["async/booleanCaller-0.js"] = s["async/booleanCaller-0.js"].replace('"PIwo"', '"unrelated"'); },
    s => { s["async/state-0.js"] = s["async/state-0.js"].replace('"OMIV"', '"otherGate"'); },
  ]) assertRefuses(change);
});

test("partial application, canonical tampering and marker-only replay are refused", () => {
  const canonical = patchedSources(fixtureSources());
  const partial = { ...fixtureSources(), "async/boolean-0.js": canonical["async/boolean-0.js"] };
  assert.throws(() => prepareRemoteConnectionsVisibility(snapshots(partial)), /partially applied/);
  for (const mutate of [s => s.replace('includes(`Linux`)', 'includes(`Windows`)'), s => s.replace('typeof navigator!==`undefined`', 'false'), s => s.replace('?.value===!0', '?.value!==!0')]) {
    const changed = { ...canonical, "async/state-0.js": mutate(canonical["async/state-0.js"]) };
    assert.throws(() => prepareRemoteConnectionsVisibility(snapshots(changed)), /Remote connections visibility/);
  }
});

test("directory adapter commits both roots, preserves modes, and rejects stale replay", () => temporary(app => {
  const assets = writeFixtureApp(app), plan = prepareRemoteConnectionsVisibility(snapshots());
  const one = path.join(assets, "async/boolean-0.js");
  fs.chmodSync(one, 0o640);
  assert.equal(applyRemoteConnectionsVisibility(app).changed, 2);
  assert.equal(fs.statSync(one).mode & 0o777, 0o640);
  assert.equal(applyRemoteConnectionsVisibility(app).changed, 0);
  assert.throws(() => patchWebviewAssets(assets, plan.edits), /changed before patch commit/);
  fs.writeFileSync(path.join(assets, "async/orphan.js"), 'const orphan="codexLinuxRemoteConnectionsVisibility";');
  assert.throws(() => applyRemoteConnectionsVisibility(app), /orphan canonical marker/);
}));

test("interrupted second owner write rolls back both original files", () => temporary(app => {
  const sources = fixtureSources(), assets = writeFixtureApp(app, sources);
  let writes = 0;
  assert.throws(() => applyRemoteConnectionsVisibility(app, { writeFileSync(file, bytes) {
    if (++writes === 2) { fs.writeFileSync(file, bytes.subarray(0, 8)); throw Error("interrupted write"); }
    fs.writeFileSync(file, bytes);
  } }), /interrupted write/);
  for (const [name, original] of Object.entries(sources)) assert.equal(fs.readFileSync(path.join(assets, name), "utf8"), original);
}));
