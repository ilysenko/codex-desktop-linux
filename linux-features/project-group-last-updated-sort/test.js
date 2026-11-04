#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { loadLinuxFeaturePatchDescriptors } = require("../../scripts/lib/linux-features.js");
const { javascriptSourceParses } = require("../../scripts/patches/lib/javascript-syntax.js");
const { applyProjectGroupLastUpdatedSortPatch, descriptors } = require("./patch.js");

// Current Rspack module DZgh: the unpinned-group sorter is an inline IIFE.
// Its sibling projectless sorter and following project-row mapper share the
// separately resolved, callback-local recency getter.
const currentModule = [
  'var a=n("order"),o=n("storage"),i=n("keys"),f=n("preferences"),I=n("recency"),y=n("groups");',
  'let sidebar=(e,{get:t,scope:n})=>{let V=t("items"),ea=t("groups"),er=t("pinned"),es=void 0,en=[],et=t("manualOrders"),',
  '{chatSortMode:X,projectSortMode:Q}=t(f.by),Z=new Map,J=e=>{let n=Z.get(e);if(null!=n)return n;let r=(0,I.Kr)(t,e);return Z.set(e,r),r},',
  '{pinnedGroups:el,unpinnedGroups:eu}=(0,y.Cy)(ea,er),ed=q({groups:el,items:V}),',
  'ec=function({groups:e,projectOrder:t}){return(0,a.n)(e,t)}({groups:q({groups:eu,items:V}),projectOrder:(0,o.F6)(t,i.Q2Y.PROJECT_ORDER)}),',
  'ep=function({explicitChatThreadKeys:e,getRecencyAt:t,items:n,projectGroups:r,projectlessThreadIds:i}){let a=new Set(r.flatMap(e=>e.threadKeys));return n.filter(e=>!e.isPinned&&!a.has(e.key)).map((e,n)=>({item:e,index:n,timestamp:t(e.key)})).sort((e,t)=>t.timestamp-e.timestamp||e.index-t.index).map(({item:e})=>e.key)}({explicitChatThreadKeys:es,getRecencyAt:J,items:V,projectGroups:ea,projectlessThreadIds:new Set(en??[])}),',
  'eh=new Map(V.map(e=>[e.key,e]));ec=ec.map(e=>{let t=j({getRecencyAt:J,items:e.threadKeys.flatMap(e=>{let t=eh.get(e);return null==t?[]:[t]}),manualThreadIds:et?.[e.projectId]?.threadIds??[],sortMode:Q});return{...e,threadKeys:t}});return{pinnedGroups:ed,projectGroups:ec,projectlessThreadKeys:ep}};',
  'function q({groups:e,items:t}){let n=new Set(t.filter(e=>e.isPinned).map(e=>e.key));return 0===n.size?e:e.map(e=>{let t=e.threadKeys.filter(e=>!n.has(e));return t.length===e.threadKeys.length?e:{...e,threadKeys:t,totalThreadCount:e.totalThreadCount??e.threadKeys.length}})}',
  'function j({getRecencyAt:e,items:t,manualThreadIds:n,sortMode:r}){if("manual"===r){let e=new Map(n.map((e,t)=>[e,t]));return[...t].sort((t,n)=>(e.get(t.threadId)??Number.MAX_SAFE_INTEGER)-(e.get(n.threadId)??Number.MAX_SAFE_INTEGER)).map(e=>e.key)}return t.map((e,t)=>({index:t,item:e})).sort((t,n)=>e(n.item.key)-e(t.item.key)||t.index-n.index).map(({item:e})=>e.key)}',
  't.read=sidebar;',
].join("");

const upstreamOrder = (groups, saved) => {
  const ids = new Set(groups.map(group => group.projectId));
  const existing = (saved ?? []).filter(id => ids.has(id));
  const known = new Set(existing);
  const order = [...groups.map(group => group.projectId).filter(id => !known.has(id)), ...existing];
  const positions = new Map(order.map((id, index) => [id, index]));
  return [...groups].sort((a, b) => positions.get(a.projectId) - positions.get(b.projectId));
};

function captureWarnings(fn) {
  const original = console.warn;
  const warnings = [];
  console.warn = message => warnings.push(message);
  try { return { value: fn(), warnings }; }
  finally { console.warn = original; }
}

function applyTwice(source = currentModule) {
  const { value: patched, warnings } = captureWarnings(() => applyProjectGroupLastUpdatedSortPatch(source));
  assert.notEqual(patched, source);
  assert.deepEqual(warnings, []);
  const second = captureWarnings(() => applyProjectGroupLastUpdatedSortPatch(patched));
  assert.equal(second.value, patched);
  assert.deepEqual(second.warnings, []);
  return patched;
}

function evaluate(source, state) {
  const exports = {};
  const imports = {
    order: { n: upstreamOrder }, storage: { F6: (get, key) => get(key) },
    keys: { Q2Y: { PROJECT_ORDER: "projectOrder" } }, preferences: { by: "preferences" },
    recency: { Kr: (get, key) => get(`recency:${key}`) },
    groups: { Cy: (groups, ids) => ({
      pinnedGroups: ids.flatMap(id => groups.filter(group => group.projectId === id)),
      unpinnedGroups: groups.filter(group => !ids.includes(group.projectId)),
    }) },
  };
  const exportAlias = source.match(/([A-Za-z_$][\w$]*)\.read=sidebar/)[1];
  const factory = vm.runInNewContext(`(function(e,${exportAlias},n){${source}})`);
  factory({}, exports, id => { assert.ok(imports[id], id); return imports[id]; });
  return () => exports.read("codex", { get: key => state[key], scope: { node: {} } });
}

function stateFor(groups, recency, mode = "updated_at") {
  const items = groups.flatMap(group => group.threadKeys.map(key => ({ key, threadId: key, kind: "local", isPinned: false })));
  return {
    groups, items, pinned: [], manualOrders: {}, projectOrder: groups.map(group => group.projectId),
    preferences: { chatSortMode: "updated_at", projectSortMode: mode },
    ...Object.fromEntries(Object.entries(recency).map(([key, value]) => [`recency:${key}`, value])),
  };
}

function groupIds(result) { return Array.from(result.projectGroups, group => group.projectId); }
function wrap(source, id = "sidebar") {
  return `export const __rspack_esm_id=1;export const __rspack_esm_ids=[1];export const __webpack_modules__={${JSON.stringify(id)}(e,t,n){${source}}};`;
}

function withAssets(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "project-groups-rspack-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const assets = path.join(root, "webview/assets");
  for (const [name, source] of Object.entries(files)) {
    const file = path.join(assets, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, source);
  }
  return { root, read: name => fs.readFileSync(path.join(assets, name), "utf8") };
}

test("feature remains opt-in with one current semantic descriptor", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "project-group-config-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = path.join(root, "features.json");
  for (const enabled of [[], ["project-group-last-updated-sort"]]) {
    fs.writeFileSync(config, JSON.stringify({ enabled }));
    const patches = loadLinuxFeaturePatchDescriptors({ featuresRoot: path.resolve(__dirname, ".."), featuresConfigPath: config });
    assert.equal(patches.some(p => p.id === "feature:project-group-last-updated-sort:last-updated-project-groups"), enabled.length !== 0);
  }
  assert.equal(descriptors[0].phase, "extracted-app:pre-webview");
});

test("Last updated reorders groups and task rows through the dynamic upstream recency getter", () => {
  const groups = [
    { projectId: "older", threadKeys: ["a", "b"] },
    { projectId: "newer", threadKeys: ["c", "d"] },
  ];
  const state = stateFor(groups, { a: 1, b: 2, c: 8, d: 9 });
  const read = evaluate(applyTwice(), state);
  assert.deepEqual(groupIds(read()), ["newer", "older"]);
  assert.deepEqual(Array.from(read().projectGroups[0].threadKeys), ["d", "c"]);
  state["recency:a"] = 50;
  assert.deepEqual(groupIds(read()), ["older", "newer"]);
  assert.deepEqual(Array.from(read().projectGroups[0].threadKeys), ["a", "b"]);
  assert.deepEqual(groups.map(group => group.projectId), ["older", "newer"]);
  assert.deepEqual(groups[0].threadKeys, ["a", "b"]);
});

test("Priority and Manual retain upstream saved order, missing IDs and row policies", () => {
  const groups = [
    { projectId: "new", threadKeys: ["a", "b"] },
    { projectId: "second", threadKeys: ["c"] },
    { projectId: "first", threadKeys: ["d"] },
  ];
  for (const mode of ["manual", "priority"]) {
    const state = stateFor(groups, { a: 40, b: 3, c: 20, d: 10 }, mode);
    state.projectOrder = ["missing", "first", "second"];
    state.manualOrders = { new: { threadIds: ["b", "a"] } };
    const pristine = evaluate(currentModule, state)();
    const result = evaluate(applyTwice(), state)();
    assert.deepEqual(JSON.parse(JSON.stringify(result)), JSON.parse(JSON.stringify(pristine)));
    assert.deepEqual(groupIds(result), ["new", "first", "second"]);
    assert.deepEqual(Array.from(result.projectGroups[0].threadKeys), mode === "manual" ? ["b", "a"] : ["a", "b"]);
  }
});

test("pinned groups, globally pinned tasks and projectless tasks preserve their upstream paths", () => {
  const groups = [
    { projectId: "pinned", threadKeys: ["pin-task"] },
    { projectId: "older", threadKeys: ["hidden-pin", "old"] },
    { projectId: "newer", threadKeys: ["new"] },
  ];
  const state = stateFor(groups, { "pin-task": 100, "hidden-pin": 200, old: 1, new: 10, outside: 20 });
  state.pinned = ["pinned"];
  state.items.find(item => item.key === "hidden-pin").isPinned = true;
  state.items.push({ key: "outside", threadId: "outside", kind: "local", isPinned: false });
  const pristine = evaluate(currentModule, state)();
  const result = evaluate(applyTwice(), state)();
  assert.deepEqual(groupIds(result), ["newer", "older"]);
  assert.deepEqual(JSON.parse(JSON.stringify(result.pinnedGroups)), JSON.parse(JSON.stringify(pristine.pinnedGroups)));
  assert.deepEqual(Array.from(result.projectlessThreadKeys), Array.from(pristine.projectlessThreadKeys));
  assert.deepEqual(Array.from(result.projectGroups[1].threadKeys), ["old"]);
});

test("equal or absent timestamps remain stable, including empty groups and invalid recency values", () => {
  const groups = [
    { projectId: "equal-first", threadKeys: ["a"] },
    { projectId: "equal-second", threadKeys: ["b"] },
    { projectId: "project-time", threadKeys: [], projectUpdatedAt: 5 },
    { projectId: "missing-first", threadKeys: ["absent", "nan"] },
    { projectId: "missing-second", threadKeys: ["infinite"], projectUpdatedAt: NaN },
  ];
  const state = stateFor(groups, { a: 9, b: 9, nan: NaN, infinite: Infinity });
  assert.deepEqual(groupIds(evaluate(applyTwice(), state)()), ["equal-first", "equal-second", "project-time", "missing-first", "missing-second"]);
});

test("minified aliases can change while the complete current contract remains executable", () => {
  let renamed = currentModule;
  for (const [from, to] of [["a", "orderImports"], ["o", "storageImports"], ["i", "keyImports"], ["f", "modeImports"], ["I", "recencyImports"], ["J", "readLatest"], ["Q", "projectMode"], ["V", "rows"], ["ec", "orderedGroups"], ["eu", "unpinnedGroups"], ["t", "reader"]])
    renamed = renamed.replace(new RegExp(`\\b${from}\\b`, "g"), to);
  const groups = [{ projectId: "a", threadKeys: ["old"] }, { projectId: "b", threadKeys: ["new"] }];
  assert.deepEqual(groupIds(evaluate(applyTwice(renamed), stateFor(groups, { old: 1, new: 2 }))()), ["b", "a"]);
});

test("callback-local bindings remain correlated across a long initializer list", () => {
  const source = currentModule.replace('},{pinnedGroups:el', '},unrelatedPadding="' + "x".repeat(6000) + '",{pinnedGroups:el');
  const groups = [{ projectId: "old", threadKeys: ["a"] }, { projectId: "new", threadKeys: ["b"] }];
  assert.deepEqual(groupIds(evaluate(applyTwice(source), stateFor(groups, { a: 1, b: 3 }))()), ["new", "old"]);
});

test("missing, mismatched and neighboring callback bindings fail without changing bytes", () => {
  const variants = [
    currentModule.replace('getRecencyAt:J,items:V', 'getRecencyAt:other,items:V'),
    currentModule.replace('getRecencyAt:J,items:V', 'getRecencyAt:J,items:other'),
    currentModule.replace('projectOrder:(0,o.F6)(t,i.Q2Y.PROJECT_ORDER)', 'projectOrder:other'),
    currentModule.replace('getRecencyAt:J,items:e.threadKeys', 'getRecencyAt:other,items:e.threadKeys'),
    currentModule.replace('manualThreadIds:et?.[e.projectId]?.threadIds??[],sortMode:Q', 'manualThreadIds:[],sortMode:X'),
    currentModule.replace('{pinnedGroups:el,unpinnedGroups:eu}', '{pinnedGroups:eu,unpinnedGroups:el}'),
    currentModule.replace('projectSortMode:Q', 'unrelatedMode:Q'),
  ];
  const contextStart = currentModule.indexOf('{chatSortMode:X');
  const contextEnd = currentModule.indexOf('},{pinnedGroups:') + 2;
  const context = currentModule.slice(contextStart, contextEnd);
  variants.push(currentModule.slice(0, contextStart) + 'unused=()=>{let ' + context.slice(0, -1) + ';},' + currentModule.slice(contextEnd));
  variants.push('const neighbor=(e,{get:t,scope:n})=>{let ' + context.slice(0, -1) + ';return null};' + currentModule.slice(0, contextStart) + currentModule.slice(contextEnd));
  for (const source of variants) {
    const result = captureWarnings(() => applyProjectGroupLastUpdatedSortPatch(source));
    assert.equal(result.value, source);
    assert.equal(result.warnings.length, 1);
  }
});

test("partial generated bodies, getter or mode arguments and duplicate owners fail closed", () => {
  const patched = applyTwice();
  const variants = [
    patched.replace('Math.max(latest,timestamp)', 'Math.min(latest,timestamp)'),
    patched.replace('getRecencyAt:J,sortMode:Q', 'getRecencyAt:other,sortMode:Q'),
    patched.replace('getRecencyAt:J,sortMode:Q', 'getRecencyAt:J,sortMode:X'),
    patched.replace(',getRecencyAt:J,sortMode:Q', ''),
    currentModule.replace('projectOrder:(0,o.F6)(t,i.Q2Y.PROJECT_ORDER)', 'projectOrder:(0,o.F6)(t,i.Q2Y.PROJECT_ORDER),getRecencyAt:J,sortMode:Q'),
    currentModule + currentModule, patched + currentModule, patched + patched,
    'function retired({groups:e,projectOrder:t}){return oldOrder(e,t)}',
  ];
  for (const source of variants) {
    const result = captureWarnings(() => applyProjectGroupLastUpdatedSortPatch(source));
    assert.equal(result.value, source);
    assert.equal(result.warnings.length, 1);
  }
});

test("normal descriptor patches recursive Rspack owner copies atomically and idempotently", t => {
  const source = wrap(currentModule);
  const files = withAssets(t, { "async/1.hash.js": source, "async/nested/2.hash.js": source, "unrelated.js": "const unrelated=true;" });
  const first = descriptors[0].apply(files.root);
  assert.equal(first.changed, 2);
  assert.equal(first.moduleId, "sidebar");
  assert.deepEqual(first.assetNames, ["async/1.hash.js", "async/nested/2.hash.js"]);
  assert.equal(descriptors[0].apply(files.root).changed, 0);
  assert.equal(javascriptSourceParses(files.read("async/1.hash.js")), true);
  assert.equal(files.read("unrelated.js"), "const unrelated=true;");
});

test("normal descriptor rejects missing, ambiguous, partial or corrupt replicas before writing", t => {
  for (const [name, files] of [
    ["missing", { "async/1.js": "export const unrelated=true;" }],
    ["ambiguous", { "async/1.js": wrap(currentModule, "owner1"), "async/2.js": wrap(currentModule, "owner2") }],
    ["partial", { "async/1.js": wrap(currentModule), "async/2.js": wrap(applyTwice()) }],
    ["damaged-copy", { "async/1.js": wrap(currentModule), "async/2.js": wrap(currentModule.replace('getRecencyAt:J,items:V', 'getRecencyAt:broken,items:V')) }],
    ["corrupt-copy", { "async/1.js": wrap(currentModule), "async/2.js": wrap(currentModule).replace('return(0,a.n)(e,t)', 'return(0,a.n)(e,t') }],
  ]) {
    const fixture = withAssets(t, files);
    assert.throws(() => descriptors[0].apply(fixture.root), undefined, name);
    for (const [file, source] of Object.entries(files)) assert.equal(fixture.read(file), source, name);
  }
});

test("current signed project-group owner passes the production descriptor twice", { skip: !process.env.CODEX_SIGNED_EXTRACTED_APP }, t => {
  const { findWebviewAssetsContaining } = require("../../scripts/patches/lib/assets.js");
  const app = process.env.CODEX_SIGNED_EXTRACTED_APP;
  const names = findWebviewAssetsContaining(app, [".PROJECT_ORDER)", "projectSortMode:", "explicitChatThreadKeys:"]);
  assert.ok(names.length > 0);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "project-groups-signed-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const originals = names.map(name => ({ name, source: fs.readFileSync(path.join(app, "webview/assets", name), "utf8") }));
  for (const { name, source } of originals) {
    const file = path.join(root, "webview/assets", name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, source);
  }
  const { applyExtractedAppPatchDescriptors } = require("../../scripts/patches/engine.js");
  const { createPatchReport } = require("../../scripts/lib/patch-report.js");
  for (const status of ["applied", "already-applied"]) {
    const report = createPatchReport();
    applyExtractedAppPatchDescriptors(root, descriptors, {}, report, descriptors[0].phase);
    assert.equal(report.patches[0].status, status);
  }
  for (const { name, source } of originals) {
    assert.equal(fs.readFileSync(path.join(app, "webview/assets", name), "utf8"), source);
  }
});
