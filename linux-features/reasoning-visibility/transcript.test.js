"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { applyTranscriptPatch: apply, transcriptDescriptor: descriptor, transcriptState } = require("./transcript.js");
const { applyStandalonePatch, standaloneDescriptor } = require("./standalone.js");
const { RUNTIME } = require("./runtime.js");
const { createPatchReport } = require("../../scripts/lib/patch-report.js");
const { applyExtractedAppPatchDescriptors } = require("../../scripts/patches/engine.js");
const { PHASE_EXTRACTED_APP_POST_WEBVIEW } = require("../../scripts/patches/descriptor.js");
const { findUniqueRspackModuleCopies } = require("../../scripts/patches/lib/rspack-module-assets.js");
const { javascriptSourceParses } = require("../../scripts/patches/lib/javascript-syntax.js");

const fixture = fs.readFileSync(path.join(__dirname, "fixtures/current-transcript-module.js"), "utf8").trim();
const classifierFixture = fs.readFileSync(path.join(__dirname, "fixtures/current-standalone-module.js"), "utf8").trim();
const chunk = (body, id = "Projection") => `export const __webpack_modules__={${id}(e,t,n){${body}}};`;

function instantiate(context, source, name, load) {
  const imported = /var [\w$]+=([\w$]+)\("/.exec(source);
  const exported = /[\w$]+\.d\(([\w$]+),\{/.exec(source);
  assert.ok(imported && exported, "expected the current module import/export bindings");
  load.d = () => {};
  return vm.runInContext(`(function(${imported[1]},${exported[1]}){${source};return ${name}})`, context)(load, {});
}

function harness(source, enabled = true) {
  const localStorage = { getItem: () => enabled ? "1" : null };
  const context = vm.createContext({ localStorage });
  const classifier = /function ([\w$]+)\([\w$]+,\{dynamicToolCallRenderer:/.exec(classifierFixture)[1];
  const classify = instantiate(context, applyStandalonePatch(classifierFixture), classifier, () => ({
    Pi: () => false, X: () => false, mw: () => null, FR: () => false,
    LS: item => Boolean(item.standalone), o: item => Boolean(item.persist),
    kT: ({ item }) => Boolean(item.interactive), $: value => value, rF: item => item.renderer,
  }));
  const projection = /function ([\w$]+)\([\w$]+,[\w$]+=!0,[\w$]+,[\w$]+\)/.exec(source)[1];
  return { project: instantiate(context, source, projection, () => ({ c: classify, i: items => items })), localStorage };
}

function events() {
  const first = { type: "reasoning", id: "summary1", turnId: "turn", completed: false, content: "Real first summary" };
  const second = { type: "reasoning", id: "internal2", sourceItemId: "summary-source2", completed: true, content: "Real second summary" };
  const input = [{ type: "user-message", item: { type: "user-message", id: "user", content: "Task" } },
    { type: "activity", collapseWhenPossible: true, items: [
      { type: "exec", id: "tool1" }, first, { type: "exec", id: "tool2" }, second,
    ] }, { type: "assistant-message", item: { type: "assistant-message", id: "final", content: "Answer" } }];
  return { first, second, input };
}

test("actual projection flushes neighboring tools and keeps native summary keys/identity/order", () => {
  const { first, second, input } = events();
  const original = harness(fixture).project;
  const patched = apply(fixture);
  assert.notEqual(patched, fixture);
  assert.equal(apply(patched), patched);
  assert.equal(javascriptSourceParses(patched), true);
  const project = harness(patched).project;
  const result = project(input);
  assert.deepEqual(Array.from(result, entry => entry.type), [
    "user-message", "agent-activity", "activity-item", "agent-activity", "activity-item", "assistant-message",
  ]);
  assert.equal(result[2].item, first);
  assert.equal(result[4].item, second);
  assert.equal(result[2].key, "transcript-activity-item-reasoning:string:summary1");
  assert.equal(result[4].key, "transcript-activity-item-reasoning:string:summary-source2");
  assert.equal(result[1].items[0], input[1].items[0]);
  assert.equal(result[3].items[0], input[1].items[2]);
  assert.equal(JSON.stringify(result), JSON.stringify(original(input, true, new Set([first, second]))),
    "the feature reuses exactly the native persistent-item projection path");
});

test("replays, completion, and an existing persistent set never duplicate or mutate summaries", () => {
  const { first, second, input } = events();
  const project = harness(apply(fixture)).project;
  for (const completed of [false, true]) {
    first.completed = completed;
    const before = JSON.stringify(input);
    for (let replay = 0; replay < 3; replay += 1) {
      const result = project(input, true, new Set([first, second]));
      const summaries = result.filter(entry => entry.type === "activity-item" && entry.item.type === "reasoning");
      assert.equal(summaries.length, 2);
      assert.equal(summaries[0].item, first);
      assert.equal(summaries[1].item, second);
    }
    assert.equal(JSON.stringify(input), before);
    assert.equal(JSON.stringify(harness(apply(fixture)).project(input)), JSON.stringify(project(input)));
  }
});

test("disabled preference and non-reasoning projection keep their original native behavior", () => {
  const { first, second, input } = events();
  const original = harness(fixture, false).project;
  const off = harness(apply(fixture), false).project;
  for (const set of [undefined, new Set([first, second])]) {
    assert.equal(JSON.stringify(off(input, true, set)), JSON.stringify(original(input, true, set)));
  }
  input[1].items = [
    { type: "exec", id: "tool" }, { type: "dynamic-tool-call", id: "dynamic", renderer: { standaloneInConversation: true } },
    { type: "automatic-approval-review", id: "review", status: "inProgress" },
    { type: "subagent-activity", id: "agent1" }, { type: "subagent-activity", id: "agent2" },
    { type: "turn-diff", id: "diff" }, { type: "worktree-init", id: "worktree" },
  ];
  assert.equal(JSON.stringify(harness(apply(fixture)).project(input)), JSON.stringify(harness(fixture).project(input)));
});

test("transcript contract rejects wrong item/flush bindings and incomplete runtime states", t => {
  t.mock.method(console, "warn", () => {});
  const patched = apply(fixture);
  for (const current of [
    "const unrelated=true;", fixture + fixture, patched + fixture, patched + patched,
    fixture.replace("n?.has(s)", "n?.has(other)"), fixture.replace(",item:s});continue", ",item:other});continue"),
    fixture.replace("c(),u.push", "c(),other.push"),
    patched.replace('"reasoning"===s.type||/*community-reasoning-visibility-transcript*/',
      '"reasoning"===other.type||/*community-reasoning-visibility-transcript*/'),
    patched.replace("/*community-reasoning-visibility-transcript*/", ""), patched.replace(RUNTIME, ""), RUNTIME + patched,
  ]) {
    assert.notEqual(current, fixture);
    assert.equal(apply(current), current);
  }
});

test("applied transcript rejects sibling/nested helpers and pristine orphan calls without writes", t => {
  t.mock.method(console, "warn", () => {});
  const body = apply(fixture).replace(RUNTIME + "\n", "");
  const projectionName = /function ([\w$]+)\([\w$]+,[\w$]+=!0,[\w$]+,[\w$]+\)/.exec(body)[1];
  const sibling = `export const __webpack_modules__={Owner(e,t,n){${body};return ${projectionName}},Sibling(e,t,n){${RUNTIME}}};`;
  const nested = `${body};function unused(){${RUNTIME}}`;
  const load = () => ({ i: items => items });
  load.d = () => {};
  const siblingProject = vm.runInNewContext(sibling.replace("export const __webpack_modules__=", "const modules=") + ";modules.Owner({}, {}, load)", { load });
  const nestedProject = vm.runInNewContext(`(function(e,t,n){${nested};return ${projectionName}})` )({}, {}, load);
  const input = [{ type: "activity", items: [{ type: "reasoning", id: "scope-summary" }] }];
  assert.throws(() => siblingProject(input), /codexLinuxReasoningVisibilityEnabled is not defined/);
  assert.throws(() => nestedProject(input), /codexLinuxReasoningVisibilityEnabled is not defined/);
  for (const current of [sibling, chunk(nested, "Owner"), chunk(`${body};if(false){${RUNTIME}}`, "Owner"),
    chunk(fixture + ";function orphan(){return codexLinuxReasoningVisibilityEnabled()}", "Owner")]) {
    assert.equal(apply(current), current);
    const { write, run } = workspace(t);
    const validSource = chunk(fixture, "Owner");
    const valid = write("async/valid.js", validSource), damaged = write("async/damaged.js", current);
    assert.equal(run().status, "skipped-optional");
    assert.equal(fs.readFileSync(valid, "utf8"), validSource);
    assert.equal(fs.readFileSync(damaged, "utf8"), current);
  }
});

test("transcript accepts its own factory helper with legitimate outer and sibling copies", t => {
  const body = apply(fixture).replace(RUNTIME + "\n", "");
  const projectionName = /function ([\w$]+)\([\w$]+,[\w$]+=!0,[\w$]+,[\w$]+\)/.exec(body)[1];
  const load = () => ({ i: items => items });
  load.d = () => {};
  for (const outer of ["", RUNTIME]) {
    const current = `${outer}export const __webpack_modules__={Owner(e,t,n){${RUNTIME}${body};return ${projectionName}},Sibling(e,t,n){${RUNTIME}}};`;
    assert.equal(apply(current), current);
    const project = vm.runInNewContext(current.replace("export const __webpack_modules__=", "const modules=") + ";modules.Owner({}, {}, load)", {
      load, localStorage: { getItem: () => "1" },
    });
    const summary = { type: "reasoning", id: "own-factory-summary" };
    assert.equal(project([{ type: "activity", items: [summary] }])[0].item, summary);
    const { write, run } = workspace(t);
    const file = write("async/own-helper.js", current);
    assert.equal(run().status, "already-applied");
    assert.equal(fs.readFileSync(file, "utf8"), current);
  }
});

function workspace(t) {
  const base = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "codex-desktop-dev");
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, "reasoning-transcript-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (name, source) => {
    const file = path.join(root, "webview", "assets", name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, source);
    return file;
  };
  const runAll = (selected = [descriptor]) => {
    const report = createPatchReport();
    applyExtractedAppPatchDescriptors(root, selected, {}, report, PHASE_EXTRACTED_APP_POST_WEBVIEW);
    return report.patches;
  };
  return { write, run: () => runAll()[0], runAll };
}

test("normal transcript descriptor composes idempotently with standalone scoped helpers in the same chunk", t => {
  const { write, runAll } = workspace(t);
  const source = `export const __webpack_modules__={Classifier(e,t,n){${classifierFixture}},Projection(e,t,n){${fixture}}};`;
  const files = [write("async/1.hash.js", source), write("async/2.hash.js", source)];
  const selected = [standaloneDescriptor, descriptor];
  assert.ok(runAll(selected).every(patch => patch.status === "applied"));
  assert.ok(runAll(selected).every(patch => patch.status === "already-applied"));
  for (const file of files) {
    const output = fs.readFileSync(file, "utf8");
    assert.equal(output.split(RUNTIME).length - 1, 2, "each factory owns its own complete helper");
    assert.equal(javascriptSourceParses(output), true);
  }
});

test("transcript descriptor rejects different identities and mixed/damaged copies atomically", t => {
  t.mock.method(console, "warn", () => {});
  for (const [secondBody, id] of [
    [fixture, "DifferentIdentity"], [apply(fixture), "Projection"],
    [fixture.replace("n?.has(s)", "n?.has(other)"), "Projection"], ["const damaged=true;", "Projection"],
  ]) {
    const { write, run } = workspace(t);
    const firstSource = chunk(fixture), secondSource = chunk(secondBody, id);
    const first = write("async/1.hash.js", firstSource), second = write("async/2.hash.js", secondSource);
    assert.equal(run().status, "skipped-optional");
    assert.equal(fs.readFileSync(first, "utf8"), firstSource);
    assert.equal(fs.readFileSync(second, "utf8"), secondSource);
  }
});

test("actual signed transcript module copies execute native projection and patch through production descriptor", {
  skip: !process.env.CODEX_SIGNED_EXTRACTED_APP,
}, t => {
  const assets = path.join(process.env.CODEX_SIGNED_EXTRACTED_APP, "webview", "assets");
  const copies = findUniqueRspackModuleCopies(assets, {
    sourceMatch: source => source.includes("transcript-activity-item-") && source.includes("collapseWhenPossible:"),
    matchModule: source => transcriptState(source).kind !== "invalid",
    description: "current transcript projection",
  });
  assert.ok(copies.length > 1);
  assert.ok(copies.some(copy => copy.moduleSource === fixture), "fixture must match one actual current factory body");
  const { first, second, input } = events();
  const { write, run } = workspace(t);
  const files = copies.map(copy => ({ copy, file: write(copy.assetName, copy.source) }));
  for (const copy of copies) {
    const result = harness(apply(copy.moduleSource)).project(input);
    assert.equal(result.filter(entry => entry.type === "activity-item" && entry.item === first).length, 1);
    assert.equal(result.filter(entry => entry.type === "activity-item" && entry.item === second).length, 1);
  }
  assert.equal(run().status, "applied");
  for (const { copy, file } of files) {
    assert.equal(javascriptSourceParses(fs.readFileSync(file, "utf8")), true);
    assert.equal(fs.readFileSync(path.join(assets, copy.assetName), "utf8"), copy.source);
  }
  assert.equal(run().status, "already-applied");
});
