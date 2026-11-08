"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const test = require("node:test");
const { prepareExperimentalFeaturesVisibility: prepare, applyExperimentalFeaturesVisibility: apply } = require("./experimental-features.js");
const { qualifiedFunction, MARKER } = require("./experimental-filter-module.js");
const scope = require("./experimental-filter-scope.js");
const { patchWebviewAssets } = require("../../scripts/patches/lib/assets.js");
const { createJavaScriptLexicalIndex, findMatchingBrace } = require("../../scripts/patches/lib/minified-js.js");
const { fixture, fixtureSources, snapshots, writeApp, assetFor } = require("./experimental-filter.test-helpers.js");
function temporary(fn) {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), "remote-experimental-"));
  try { return fn(app); } finally { fs.rmSync(app, { recursive: true, force: true }); }
}
function patched(sources = fixtureSources()) {
  return { ...sources, ...Object.fromEntries(prepare(snapshots(sources)).edits.map(edit => [edit.assetName, edit.patchedSource])) };
}
function refs(cohort) {
  return { filterModuleId: cohort.filter[0].moduleId,
    imports: { api: cohort.barrel[0].moduleId, memory: cohort.memory[0].moduleId, chronicle: cohort.chronicle[0].moduleId } };
}
function predicate(copy, cohort, injected = { api: { R1o: "workspace_dependencies" }, memory: { j: "memories" }, chronicle: { c: "chronicle" } }) {
  const proof = qualifiedFunction(copy, refs(cohort)), names = proof.role;
  // Only the qualified published return body executes with injected objects.
  // No native module factory, UI bootstrap, vendor or RPC executes.
  const fn = new Function(names.feature, names.api, names.memory, names.chronicle, proof.body);
  return feature => fn(feature, injected.api, injected.memory, injected.chronicle);
}
function rejects(change) {
  const sources = fixtureSources();change(sources);const before = JSON.stringify(sources);
  assert.throws(() => prepare(snapshots(sources)));
  assert.equal(JSON.stringify(sources), before);
}

test("both native full-function filters preserve beta and every non-target exclusion", () => {
  const cohort = snapshots(patched());
  for (const copy of cohort.filter) {
    const fn = predicate(copy, cohort);
    assert.equal(fn({ stage: "beta", name: "remote_control", enabled: false }), true);
    assert.equal(fn({ stage: "alpha", name: "remote_control" }), false);
    for (const name of ["memories", "multi_agent", "plugins", "plugin", "realtime_audio", "chronicle", "workspace_dependencies"]) assert.equal(fn({ stage: "beta", name }), false, name);
    assert.equal(fn({ stage: "beta", name: "unrelated", enabled: false }), true);
  }
});

test("native toggle callback/search mapper retain list identities, ordering and the separate request-input exclusion", () => {
  const original = snapshots(), changed = snapshots(patched());
  const caller = scope.rootFunction(original.toggles[0], "ek").source;
  const mapper = scope.rootFunction(original.search[0], "te").source;
  const terms = new Function(`return (${mapper});`)();
  const features = Object.freeze(["remote_control", "unrelated", "memories", "workspace_dependencies", "default_mode_request_user_input", "chronicle"]
    .map(name => Object.freeze({ name, stage: "beta", displayName: name.toUpperCase(), description: name + " details", enabled: false })));
  const before = JSON.stringify(features);
  for (const [index, copy] of changed.filter.entries()) {
    const oldFilter = predicate(original.filter[index], original), newFilter = predicate(copy, changed);
    const toggle = fn => new Function("ef", "ed", `return (${caller});`)({ R: fn }, { il: "default_mode_request_user_input" });
    const rawItems = features.filter(toggle(oldFilter)), currentItems = features.filter(toggle(newFilter));
    assert.deepEqual(currentItems.filter(item => item.name !== "remote_control"), rawItems);
    assert.ok(currentItems.includes(features[0]));assert.ok(!currentItems.includes(features[4]));
    const rawTerms = features.filter(oldFilter).flatMap(terms), newTerms = features.filter(newFilter).flatMap(terms);
    assert.deepEqual(newTerms.slice(2), rawTerms);
    assert.deepEqual(newTerms.slice(0, 2), ["REMOTE_CONTROL", "remote_control details"]);
    assert.ok(newTerms.includes("DEFAULT_MODE_REQUEST_USER_INPUT"));
  }
  assert.equal(JSON.stringify(features), before);
});

test("the native row callback forwards only the user's feature choice through the existing mutation", () => {
  const copy = snapshots().toggles[0], body = copy.moduleSource;
  const start = body.indexOf('n=e=>({key:e.name,label:e.displayName??e.name');assert.ok(start >= 0);
  const open = body.indexOf("{", start), close = findMatchingBrace(body, open);
  const expression = body.slice(start + 2, close + 2), calls = [];
  const mapper = new Function("T", "_", `return (${expression});`)({ mutate: (...args) => calls.push(args) }, () => {});
  const item = Object.freeze({ name: "remote_control", displayName: "Remote", description: "Current native metadata", enabled: false });
  const model = mapper(item);assert.equal(model.enabled, false);model.onChange(true);
  assert.deepEqual(calls[0][0], { featureName: "remote_control", enabled: true });
  assert.equal(typeof calls[0][1].onSuccess, "function");
});

test("full canonical functions repeat and inverse exactly while constants stay symbolic/live", () => {
  const sources = fixtureSources(), current = patched(sources), cohort = snapshots(current);
  assert.ok(prepare(cohort).edits.every(edit => edit.source === edit.patchedSource));
  for (const [index, copy] of cohort.filter.entries()) {
    const proof = qualifiedFunction(copy, refs(cohort)), feature = proof.role.feature;
    const nativeBody = proof.body.replace(`/*${MARKER}*/`, "").replace(`&&!${feature}.name.startsWith("realtime_")`, `&&"remote_control"!==${feature}.name&&!${feature}.name.startsWith("realtime_")`);
    assert.equal(copy.moduleSource.slice(0, proof.bounds[0]) + nativeBody + copy.moduleSource.slice(proof.bounds[1]), snapshots(sources).filter[index].moduleSource);
  }
  const injected = { api: { R1o: "workspace_dependencies" }, memory: { j: "memories" }, chronicle: { c: "chronicle" } };
  const fn = predicate(cohort.filter[0], cohort, injected);
  assert.equal(fn({ stage: "beta", name: "workspace_dependencies" }), false);
  injected.api.R1o = "changed_symbol";
  assert.equal(fn({ stage: "beta", name: "workspace_dependencies" }), true);
  assert.equal(fn({ stage: "beta", name: "changed_symbol" }), false);
});

test("wrong filter exports/imports, shadowing, opaque bodies and literal/ASI tampering refuse", () => {
  for (const mutate of [text => text.replace('R:function', 'wrong:function'), text => text.replace('"TjCl"', '"wrongMemory"'),
    text => text.replace('return"beta"', 'return\n"beta"'), text => text.replace('"beta"===e.stage', '"be ta"===e.stage'),
    text => text.replace('var s=', 'var hidden="remote_control";var s='), text => text.replace('"plugins"', '"unrelated"'),
    text => text.replace('R:function(e)', 'R:function(s)')]) rejects(s => { s[assetFor("filter")] = mutate(s[assetFor("filter")]); });
});

test("wrong caller import/host/publication/capture and mutable namespace authority refuse", () => {
  for (const change of [
    s => { s[assetFor("toggles")] = s[assetFor("toggles")].replace('ef=n("v6J2")', 'ef=n("other")'); },
    s => { s[assetFor("search")] = s[assetFor("search")].replace('eU.u9,e.selectedHostId', 'eU.u9,"local"'); },
    s => { s[assetFor("toggles")] = s[assetFor("toggles")].replace('T=(0,Y.jv)(t)', 'T=(0,Y.jv)(w)'); },
    s => { s[assetFor("toggles")] = s[assetFor("toggles")].replace('ConfigurationPanel:()=>eH', 'WrongPanel:()=>eH'); },
    s => { s[assetFor("toggles")] = s[assetFor("toggles")].replace('function ek(e){', 'function ek(e){let ef={R:()=>true};'); },
    s => { s[assetFor("toggles")] = s[assetFor("toggles")].replace('function ev(e){', 'function ev(e){Y={u9:()=>[]};'); },
    s => { s[assetFor("search")] = s[assetFor("search")].replace('eW=s("v6J2"),', 'eW=s("v6J2");eW={R:()=>true};var '); },
    s => { s[assetFor("toggles")] = s[assetFor("toggles")].replace('function ek(e){', 'function ek(e){eval("ef={R:()=>true}");'); },
  ]) rejects(change);
});

test("selected-host list/write owner, constant chain and every physical dependency remain mandatory", () => {
  rejects(s => { s[assetFor("list")] = s[assetFor("list")].replace('experimentalFeature/list', 'other/list'); });
  rejects(s => { s[assetFor("list")] = s[assetFor("list")].replace('config/batchWrite', 'other/write'); });
  rejects(s => { s[assetFor("barrel")] = s[assetFor("barrel")].replace('R1o:()=>q.R1', 'R1o:()=>q.R2'); });
  rejects(s => { s[assetFor("settings")] = s[assetFor("settings")].replace('R1:"workspace_dependencies"', 'R1:"different_feature"'); });
  rejects(s => { s[assetFor("chronicle", 6)] = s[assetFor("chronicle", 6)].replace('c:"chronicle"', 'c:"changed"'); });
  const c = snapshots();c.chronicle[0] = { ...c.chronicle[0], start: c.chronicle[0].start + 1 };
  assert.throws(() => prepare(c), /stale/);
});

test("missing identities, mixed canonical copies and unmarked former flat output refuse", () => {
  const c = snapshots();c.settings = [];assert.throws(() => prepare(c), /missing/);
  const pristine = fixtureSources(), current = patched(pristine);
  assert.throws(() => prepare(snapshots({ ...pristine, [assetFor("filter")]: current[assetFor("filter")] })), /mixed canonical/);
  for (const [name, text] of Object.entries(current)) current[name] = text.replaceAll(`/*${MARKER}*/`, "");
  assert.throws(() => prepare(snapshots(current)));
});

test("current native consumers tolerate their real unrelated local shadows but reject new block captures", () => {
  assert.equal(prepare(snapshots()).physicalFilterCopies, 2);
  rejects(s => { s[assetFor("search")] = s[assetFor("search")].replace('w.filter(eW.R).flatMap(te)', 'w.filter((eW={R:()=>true}).R).flatMap(te)'); });
  rejects(s => { s[assetFor("toggles")] = s[assetFor("toggles")].replace('function ek(e){return', 'function ek(e){{let ef={R:()=>true};return').replace('e.name!==ed.il}', 'e.name!==ed.il}}'); });
});

test("minified filter aliases and module identities can rename without changing the consumer ABI", () => {
  const sources = fixtureSources(), ids = { v6J2: "newFilter" };
  for (const [name, source] of Object.entries(sources)) sources[name] = source.replaceAll('"v6J2"', '"newFilter"').replace(/(?<=[{,])v6J2\(/gu, 'newFilter(');
  // Rename only the bounded filter module bodies, not consumer property keys.
  const { rspackModuleFactories } = require("../../scripts/patches/lib/rspack-module-assets.js");
  for (const [name, source] of Object.entries(sources)) {
    const modules = [...rspackModuleFactories(source, name)].filter(copy => copy.moduleId === "newFilter");let result = source;
    for (const copy of modules.reverse()) {
      const lexical = createJavaScriptLexicalIndex(copy.moduleSource);let body = copy.moduleSource;
      const renames = { e: "row", t: "out", n: "load", s: "apiOrLoad", i: "memory", a: "apiOrChronicle" };
      for (const token of [...body.matchAll(/[A-Za-z_$][\w$]*/gu)].reverse()) if (renames[token[0]] && lexical.isCode(token.index) && body[token.index - 1] !== "." && !/^\s*:/u.test(body.slice(token.index + token[0].length))) body = body.slice(0, token.index) + renames[token[0]] + body.slice(token.index + token[0].length);
      const headerStart = source.lastIndexOf("newFilter(", copy.start);
      const header = `newFilter(${copy.params.map(param => renames[param] ?? param)}){`;
      result = result.slice(0, headerStart) + header + body + result.slice(copy.end);
    }
    sources[name] = result;
  }
  assert.equal(prepare(snapshots(sources, ids)).moduleIds.filter, "newFilter");
});

test("readonly dependency drift rejects before writes; interrupted asset write rolls back bytes/modes", () => temporary(app => {
  const sources = fixtureSources(), assets = writeApp(app, sources), plan = prepare(snapshots(sources));
  const dependent = assetFor("list");fs.appendFileSync(path.join(assets, dependent), "\n// stale");
  assert.throws(() => patchWebviewAssets(assets, plan.edits), /changed before patch commit/);
  for (const name of [assetFor("filter", 0), assetFor("filter", 1)]) assert.equal(fs.readFileSync(path.join(assets, name), "utf8"), sources[name]);
  fs.writeFileSync(path.join(assets, dependent), sources[dependent]);
  fs.chmodSync(path.join(assets, assetFor("filter")), 0o640);let writes = 0;
  assert.throws(() => apply(app, { writeFileSync(file, bytes) {
    if (++writes === 2) { fs.writeFileSync(file, bytes.subarray(0, 10));throw Error("interrupted filter write"); }
    fs.writeFileSync(file, bytes);
  } }), /interrupted filter write/);
  for (const [name, text] of Object.entries(sources)) assert.equal(fs.readFileSync(path.join(assets, name), "utf8"), text);
  assert.equal(fs.statSync(path.join(assets, assetFor("filter"))).mode & 0o777, 0o640);
  assert.equal(apply(app).changed, 2);assert.equal(apply(app).changed, 0);
  fs.writeFileSync(path.join(assets, "async/orphan.js"), `const orphan="${MARKER}";`);
  assert.throws(() => apply(app), /orphan filter marker/);
}));
