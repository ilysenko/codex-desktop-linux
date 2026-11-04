"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { applyPersistentPatch: apply, persistentDescriptor: descriptor } = require("./persistent.js");
const { RUNTIME } = require("./runtime.js");
const { applyAuthoredMessageVisibilityPatch: authored, descriptors: authoredDescriptors } = require("../authored-message-visibility/patch.js");
const { createPatchReport } = require("../../scripts/lib/patch-report.js");
const { applyWebviewAssetPatchDescriptors } = require("../../scripts/patches/engine.js");
const { listWebviewAssetFiles } = require("../../scripts/patches/lib/assets.js");
const { javascriptSourceParses } = require("../../scripts/patches/lib/javascript-syntax.js");

const fixture = fs.readFileSync(path.join(__dirname, "fixtures/current-persistent-partition.js"), "utf8");
const ids = units => Array.from(units, unit => unit.item?.item.id ?? unit.id);
function unit(type, id, extra = {}) {
  return { kind: "standalone", item: { item: { type, id, completed: true,
    invocation: { server: "test", tool: "test" }, result: { type: "success", raw: {} }, ...extra } } };
}
function partition(source, enabled = true) {
  return vm.runInNewContext(`${source};partition`, {
    localStorage: { getItem: () => enabled ? "1" : null },
    g: { o: item => item.persist },
    p: { Yr: item => item.final, rt: item => item.final },
    h: { Q1: item => item.interactive },
    f: { i$: ({ toolResult }) => toolResult?.interactive ? {} : null },
  });
}

test("current partition retains summary identity and order after final-answer/tool collapse", () => {
  const units = [unit("exec", "tool-before"), unit("reasoning", "summary", { content: "Available summary" }),
    unit("exec", "tool-after"), unit("assistant-message", "final", { final: true })];
  const before = partition(fixture)(units, { hasFollowingFinalAnswer: true });
  assert.ok(!ids(before.persistentUnits).includes("summary"));
  const patched = apply(fixture);
  assert.notEqual(patched, fixture);
  assert.equal(apply(patched), patched);
  assert.equal(javascriptSourceParses(patched), true);
  const run = partition(patched);
  for (let replay = 0; replay < 3; replay += 1) {
    const result = run(units, { hasFollowingFinalAnswer: true });
    assert.deepEqual(ids(result.persistentUnits), ["summary", "final"]);
    assert.deepEqual(ids(result.collapsibleUnits), ["tool-before", "tool-after"]);
    assert.deepEqual(ids(result.expandedUnits), ids(units));
    assert.equal(result.persistentUnits[0], units[1]);
    assert.equal(result.persistentUnits[0].item.item.content, "Available summary");
  }
});

test("disabled preference and every non-reasoning persistence rule remain upstream-owned", () => {
  const items = [unit("reasoning", "summary"), unit("user-message", "ordinary"),
    unit("user-message", "pending", { steeringStatus: "pending" }),
    unit("user-message", "interrupted", { followsInterruptedFinalAnswer: true }),
    unit("user-message", "hook", { hookFeedback: true }), unit("assistant-message", "commentary"),
    unit("assistant-message", "final", { final: true }), unit("user-input-response", "unanswered", { completed: false }),
    unit("user-input-response", "answered"), unit("dynamic-tool-call", "dynamic", { interactive: true }),
    unit("mcp-tool-call", "mcp", { mcpAppResourceUri: "ui://test" }), unit("mcp-tool-call", "sticky", { persist: true }),
    unit("exec", "tool"), unit("worked-for", "duration"), { kind: "group", id: "tool-group", items: [] }];
  const originalBytes = JSON.stringify(items);
  const before = partition(fixture);
  const on = partition(apply(fixture));
  const off = partition(apply(fixture), false);
  for (const hasFollowingFinalAnswer of [false, true]) {
    for (const isTurnInProgress of [false, true]) {
      for (const keepMcpAppEntriesPersistent of [false, true]) {
        for (const renderMcpApps of [false, true]) {
          const options = { hasFollowingFinalAnswer, isTurnInProgress, keepMcpAppEntriesPersistent, renderMcpApps };
          assert.equal(JSON.stringify(off(items, options)), JSON.stringify(before(items, options)));
          const nonReasoning = items.filter(item => item.item?.item.type !== "reasoning");
          assert.equal(JSON.stringify(on(nonReasoning, options)), JSON.stringify(before(nonReasoning, options)));
        }
      }
    }
  }
  assert.equal(JSON.stringify(items), originalBytes);
});

test("persistence composes in both orders and repeatedly with authored-message visibility", t => {
  const first = apply(authored(fixture));
  const second = authored(apply(fixture));
  assert.equal(first, second);
  const items = [unit("user-message", "user"), unit("reasoning", "summary"),
    unit("exec", "tool"), unit("assistant-message", "commentary")];
  assert.deepEqual(ids(partition(first)(items).persistentUnits), ["user", "summary", "commentary"]);
  assert.equal(apply(first), first);
  assert.equal(authored(first), first);
  assert.deepEqual(ids(partition(first, false)(items).persistentUnits), ["user", "commentary"]);
  const { write, runAll } = workspace(t);
  write("async/shared-partition.js", fixture);
  const selected = [...authoredDescriptors, descriptor];
  assert.ok(runAll(selected).every(patch => patch.status === "applied"));
  assert.ok(runAll(selected).every(patch => patch.status === "already-applied"));
});

test("persistent contract rejects missing, duplicate, mixed, and damaged preference/alias states", t => {
  t.mock.method(console, "warn", () => {});
  const patched = apply(fixture);
  for (const source of [
    "const unrelated=true;", fixture + fixture, patched + fixture, patched + patched,
    patched.replace('"reasoning"===m.item.item.type', '"reasoning"===other.item.item.type'),
    patched.replace("/*community-reasoning-visibility-persistent*/", ""),
    patched.replace(RUNTIME, ""), RUNTIME + patched,
    fixture + ";function orphan(){return codexLinuxReasoningVisibilityEnabled()}",
    fixture.replace('if("standalone"!==e.kind)', 'if(e.kind!==`standalone`)'),
    fixture.replace("i=e.item.item", "i=e.item.other"),
  ]) {
    assert.notEqual(source, fixture);
    assert.equal(apply(source), source);
  }
});

test("applied persistence rejects helpers hidden in sibling factories or ordinary nested scopes", t => {
  t.mock.method(console, "warn", () => {});
  const body = apply(fixture).replace(RUNTIME + "\n", "");
  const sibling = `export const __webpack_modules__={Owner(e,t,n){${body};return partition},Sibling(e,t,n){${RUNTIME}}};`;
  const nested = `${body}function unused(){${RUNTIME}}`;
  const input = [unit("reasoning", "scope-summary")];
  const siblingRun = vm.runInNewContext(sibling.replace("export const __webpack_modules__=", "const modules=") + ";modules.Owner()");
  const nestedRun = vm.runInNewContext(`${nested};partition`);
  assert.throws(() => siblingRun(input, { hasFollowingFinalAnswer: true }), /codexLinuxReasoningVisibilityEnabled is not defined/);
  assert.throws(() => nestedRun(input, { hasFollowingFinalAnswer: true }), /codexLinuxReasoningVisibilityEnabled is not defined/);
  for (const source of [sibling, nested, `${body}if(false){${RUNTIME}}`, `${body}/*${RUNTIME}*/`,
    fixture + ";function orphan(){return codexLinuxReasoningVisibilityEnabled()}"]) {
    assert.equal(apply(source), source);
    const { write, run } = workspace(t);
    const file = write("async/misplaced-runtime.js", source);
    assert.equal(run().status, "skipped-optional");
    assert.equal(fs.readFileSync(file, "utf8"), source);
  }
});

test("complete persistence accepts a helper in its own factory with legitimate outer and sibling copies", t => {
  const body = apply(fixture).replace(RUNTIME + "\n", "");
  for (const outer of ["", RUNTIME]) {
    const source = `${outer}export const __webpack_modules__={Owner(e,t,n){${RUNTIME}${body};return partition},Sibling(e,t,n){${RUNTIME}}};`;
    assert.equal(apply(source), source);
    const project = vm.runInNewContext(source.replace("export const __webpack_modules__=", "const modules=") + ";modules.Owner()", {
      localStorage: { getItem: () => "1" },
    });
    const summary = unit("reasoning", "visible-summary");
    assert.equal(project([summary], { hasFollowingFinalAnswer: true }).persistentUnits[0], summary);
    const { write, run } = workspace(t);
    const file = write("async/own-factory-runtime.js", source);
    assert.equal(run().status, "already-applied");
    assert.equal(fs.readFileSync(file, "utf8"), source);
  }
});

function workspace(t) {
  const base = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "codex-desktop-dev");
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, "reasoning-persistent-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (name, source) => {
    const file = path.join(root, "webview", "assets", name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, source);
    return file;
  };
  const runAll = selected => {
    const report = createPatchReport();
    applyWebviewAssetPatchDescriptors(root, selected, {}, report);
    return report.patches;
  };
  return { write, run: () => runAll([descriptor])[0], runAll };
}

test("production descriptor finds numeric async owners and preserves ambiguous/partial bytes", t => {
  t.mock.method(console, "warn", () => {});
  const { write, run } = workspace(t);
  const first = write("async/366297.hash.js", fixture);
  assert.equal(run().status, "applied");
  const patched = fs.readFileSync(first, "utf8");
  assert.equal(run().status, "already-applied");
  const partial = patched.replace('"reasoning"===m.item.item.type', '"reasoning"===other.item.item.type');
  const second = write("other/366297.hash.js", partial);
  assert.equal(run().status, "skipped-optional");
  assert.equal(fs.readFileSync(first, "utf8"), patched);
  assert.equal(fs.readFileSync(second, "utf8"), partial);
});

test("current signed owner contains the verbatim partition and patches through the normal descriptor", {
  skip: !process.env.CODEX_SIGNED_EXTRACTED_APP,
}, t => {
  const assets = path.join(process.env.CODEX_SIGNED_EXTRACTED_APP, "webview", "assets");
  const owners = listWebviewAssetFiles(assets, /\.js$/).map(assetName => ({assetName,source:fs.readFileSync(path.join(assets,assetName),"utf8")})).filter(({source}) => descriptor.assetMatch(source));
  assert.equal(owners.length,1);
  const owner=owners[0];
  assert.ok(owner.source.includes(fixture.slice("const partition=".length).trim().slice(0, -1)));
  const { write, run } = workspace(t);
  const file = write(owner.assetName, owner.source);
  assert.equal(run().status, "applied");
  const patched = fs.readFileSync(file, "utf8");
  assert.notEqual(patched, owner.source);
  assert.equal(javascriptSourceParses(patched), true);
  assert.equal(authored(patched), apply(authored(owner.source)));
  assert.equal(run().status, "already-applied");
  assert.equal(fs.readFileSync(path.join(assets, owner.assetName), "utf8"), owner.source);
});
