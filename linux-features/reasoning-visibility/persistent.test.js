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
const { applyWebviewAssetPatchDescriptors, applyExtractedAppPatchDescriptors } = require("../../scripts/patches/engine.js");
const { listWebviewAssetFiles } = require("../../scripts/patches/lib/assets.js");
const { javascriptSourceParses } = require("../../scripts/patches/lib/javascript-syntax.js");

const fixture = fs.readFileSync(path.join(__dirname, "../../scripts/patches/lib/fixtures/current-activity-partition.js"), "utf8");
const ids = units => Array.from(units, unit => unit.item?.item.id ?? unit.id);
function unit(type, id, extra = {}) {
  return { kind: "standalone", item: { item: { type, id, content: "", completed: true,
    invocation: { server: "test", tool: "test" }, result: { type: "success", raw: {} }, ...extra } } };
}
function partition(source, enabled = true) {
  return vm.runInNewContext(`${source};partition`, {
    localStorage: { getItem: () => enabled ? "1" : null },
    f: { o: item => item.persist },
    p: { Yr: item => item.final, rt: item => item.final },
    h: { Q1: item => item.interactive },
    m: { Hn: ({ toolResult }) => toolResult?.interactive ? {} : null },
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
  write("async/shared-partition.js", `export const __webpack_modules__={QypQ(e,t,n){${fixture}}};`);
  const selected = [...authoredDescriptors, descriptor];
  assert.ok(runAll(selected).every(patch => patch.status === "applied"));
  assert.ok(runAll(selected).every(patch => patch.status === "already-applied"));
});

test("persistent contract rejects missing, duplicate, mixed, and damaged preference/alias states", t => {
  t.mock.method(console, "warn", () => {});
  const patched = apply(fixture);
  for (const source of [
    "const unrelated=true;", fixture + fixture, patched + fixture, patched + patched,
    patched.replace('"reasoning"===g.item.item.type', '"reasoning"===other.item.item.type'),
    patched.replace("/*community-reasoning-visibility-persistent*/", ""),
    patched.replace(RUNTIME, ""), RUNTIME + patched,
    fixture + ";function orphan(){return codexLinuxReasoningVisibilityEnabled()}",
    fixture.replace('if("standalone"!==e.kind)', 'if(e.kind!==`standalone`)'),
    fixture.replace("s=e.item.item", "s=e.item.other"),
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
    assert.equal(fs.readFileSync(file, "utf8"), asChunk(source));
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
    assert.equal(fs.readFileSync(file, "utf8"), asChunk(source));
  }
});

function asChunk(source) {
  return source.includes("export const __webpack_modules__=") ? source :
    `export const __rspack_esm_ids=[101];export const __webpack_modules__={QypQ(e,t,n){${source}}};`;
}

function workspace(t) {
  const base = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "codex-desktop-dev");
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, "reasoning-persistent-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (name, source) => {
    const file = path.join(root, "webview", "assets", name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, asChunk(source));
    return file;
  };
  const runAll = selected => {
    const report = createPatchReport();
    applyExtractedAppPatchDescriptors(root, selected, {}, report, "extracted-app:pre-webview");
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
  const partial = patched.replace('"reasoning"===g.item.item.type', '"reasoning"===other.item.item.type');
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
  for (const header of ["async function({unit:e,", "async/*gap*/function({unit:e,", "async\tfunction({unit:e,",
    "async function\n({unit:e,", "function*({unit:e,", "async function*({unit:e,"]) {
    const activity = require("../../scripts/patches/lib/activity-partition.js").inspectActivityPartition(owner.source);
    const start = activity.classifier.start;
    const mutant = owner.source.slice(0, start) + header + owner.source.slice(start + "function({unit:e,".length);
    assert.ok(javascriptSourceParses(mutant));
    assert.equal(apply(mutant), mutant);
    const invalid = workspace(t);
    const target = invalid.write(owner.assetName, mutant);
    assert.equal(invalid.run().status, "skipped-optional");
    assert.equal(fs.readFileSync(target, "utf8"), mutant);
  }
  const nativeOwner = require("../../scripts/patches/lib/activity-partition.js").inspectActivityPartition(owner.source);
  const renamed = owner.source.replaceAll("collapsibleUnits:", "missingCollapsible:").replaceAll("persistentUnits:", "missingPersistent:");
  const resultOnly = owner.source.slice(0, nativeOwner.result.start) + nativeOwner.result.source
    .replace("collapsibleUnits:", "missingCollapsible:").replace("persistentUnits:", "missingPersistent:") + owner.source.slice(nativeOwner.result.end);
  const decoy = resultOnly.slice(0, nativeOwner.loop.start) + 'const note="collapsibleUnits:persistentUnits:";' + resultOnly.slice(nativeOwner.loop.start);
  const failures = require("../../scripts/lib/patch-report.js").enabledFeatureFailuresFromReport;
  for (const mutant of [renamed, renamed.replaceAll("keepMcpAppEntriesPersistent:", "missingKeepMcp:"), decoy]) {
    assert.ok(javascriptSourceParses(mutant));
    const invalid = registeredWorkspace(t, { "async/good.js": owner.source, "async/hidden.js": mutant });
    assert.equal(failures(invalid.run()).length, 1);
    for (const { file, source: before } of invalid.files) assert.equal(fs.readFileSync(file, "utf8"), before);
  }
  assert.equal(fs.readFileSync(path.join(assets, owner.assetName), "utf8"), owner.source);
});

test("reasoning persistence preserves native MCP rendering and accepted steering policy", () => {
  const before = partition(fixture), enabled = partition(apply(fixture)), disabled = partition(apply(fixture), false);
  for (const renderMcpApps of [false, true]) {
    const items = [unit("mcp-tool-call", "mcp", { mcpAppResourceUri: "ui://test" }),
      unit("user-message", "accepted", { steeringStatus: "accepted" }), unit("exec", "tool")];
    const options = { hasFollowingFinalAnswer: true, keepMcpAppEntriesPersistent: true, renderMcpApps };
    const expected = JSON.stringify(before(items, options));
    assert.equal(JSON.stringify(enabled(items, options)), expected);
    assert.equal(JSON.stringify(disabled(items, options)), expected);
  }
});

test("reasoning persistence refuses disconnected MCP rendering and caller mapping", t => {
  t.mock.method(console, "warn", () => {});
  for (const source of [
    fixture.replace("renderMcpApps:i})", "unknownRendering:i})"),
    fixture.replace('n&&i&&"mcp-tool-call"', 'n&&wrong&&"mcp-tool-call"'),
    fixture.replace("mcpServerStatuses:i,renderMcpApps:s})", "mcpServerStatuses:wrong,renderMcpApps:s})"),
    fixture.replace("hasFollowingFinalAnswer:t<u,", "hasFollowingFinalAnswer:t<wrong,"),
  ]) {
    assert.notEqual(source, fixture);
    assert.equal(apply(source), source);
    const project = workspace(t);
    const file = project.write("async/bad-current-binding.js", source);
    assert.equal(project.run().status, "skipped-optional");
    assert.equal(fs.readFileSync(file, "utf8"), asChunk(source));
  }
});

test("non-current activity callable kinds remain parseable and byte-identical after refusal", t => {
  t.mock.method(console, "warn", () => {});
  for (const header of ["async function({unit:e,", "async/*gap*/function({unit:e,", "async\tfunction({unit:e,",
    "async function\n({unit:e,", "function*({unit:e,", "async function*({unit:e,", "new function({unit:e,"]) {
    const source = fixture.replace("function({unit:e,", header);
    assert.doesNotThrow(() => new vm.Script(source));
    assert.equal(apply(source), source);
    const project = workspace(t);
    const file = project.write("async/current.js", source);
    assert.equal(project.run().status, "skipped-optional");
    assert.equal(fs.readFileSync(file, "utf8"), asChunk(source));
    assert.ok(javascriptSourceParses(fs.readFileSync(file, "utf8")));
  }
});

function registeredWorkspace(t, sources, enabled = true) {
  const { loadLinuxFeaturePatchDescriptors } = require("../../scripts/lib/linux-features.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reasoning-cohort-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = path.join(root, "features.json");
  fs.writeFileSync(config, JSON.stringify({ enabled: enabled ? ["reasoning-visibility"] : [] }));
  const loaded = loadLinuxFeaturePatchDescriptors({ featuresRoot: path.join(__dirname, ".."), featuresConfigPath: config })
    .filter(item => item.id === "feature:reasoning-visibility:persistent");
  const files = Object.entries(sources).map(([name, source]) => {
    const file = path.join(root, "webview/assets", name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, asChunk(source));
    return { file, source: asChunk(source) };
  });
  const run = () => {
    const report = createPatchReport();
    report.enabledFeatures = enabled ? ["reasoning-visibility"] : [];
    applyExtractedAppPatchDescriptors(root, loaded, {}, report, "extracted-app:pre-webview");
    return report;
  };
  return { files, loaded, run };
}

test("registered reasoning cohort patches all complete copies and recognizes their repeated state", t => {
  const project = registeredWorkspace(t, { "async/a.js": fixture, "async/b.js": fixture });
  assert.equal(project.loaded[0].phase, "extracted-app:pre-webview");
  assert.equal(project.run().patches[0].status, "applied");
  for (const { file } of project.files) assert.equal(fs.readFileSync(file, "utf8"), apply(asChunk(fixture)));
  assert.equal(project.run().patches[0].status, "already-applied");
  const previous = registeredWorkspace(t, { "async/previous-build.js": apply(asChunk(fixture)) });
  assert.equal(previous.run().patches[0].status, "already-applied");
  assert.equal(fs.readFileSync(previous.files[0].file, "utf8"), previous.files[0].source);
});

test("registered reasoning cohort rejects missing-needle, decoy, damaged and mixed copies before writes", t => {
  t.mock.method(console, "warn", () => {});
  const { enabledFeatureFailuresFromReport } = require("../../scripts/lib/patch-report.js");
  const missing = fixture.replace("collapsibleUnits:", "missingCollapsible:").replace("persistentUnits:", "missingPersistent:");
  const owner = require("../../scripts/patches/lib/activity-partition.js").inspectActivityPartition(fixture);
  const decoy = missing.slice(0, owner.loop.start) + 'const note="collapsibleUnits:persistentUnits:";' + missing.slice(owner.loop.start);
  for (const other of [missing, decoy, fixture.replace('i&&"mcp-tool-call"===s.type', 'wrong&&"mcp-tool-call"===s.type'),
    apply(fixture), asChunk(fixture).replace("QypQ(e,t,n)", "Other(e,t,n)")]) {
    const project = registeredWorkspace(t, { "async/good.js": fixture, "async/other.js": other });
    assert.equal(enabledFeatureFailuresFromReport(project.run()).length, 1);
    for (const { file, source } of project.files) assert.equal(fs.readFileSync(file, "utf8"), source);
  }
});

test("registered reasoning cohort rolls back a later truncated copy write", t => {
  t.mock.method(console, "warn", () => {});
  const project = registeredWorkspace(t, { "async/a.js": fixture, "async/b.js": fixture });
  const originalWrite = fs.writeFileSync;
  let failed = false;
  t.mock.method(fs, "writeFileSync", (file, bytes, ...args) => {
    if (file === project.files[1].file && !failed) {
      failed = true;
      originalWrite(file, "truncated");
      throw new Error("injected later reasoning copy write failure");
    }
    return originalWrite(file, bytes, ...args);
  });
  assert.equal(project.run().patches[0].status, "skipped-optional");
  assert.equal(failed, true);
  for (const { file, source } of project.files) assert.equal(fs.readFileSync(file, "utf8"), source);
});

test("disabled reasoning cohort performs no asset discovery", t => {
  const project = registeredWorkspace(t, {}, false);
  assert.deepEqual(project.loaded, []);
  let discovered = false;
  t.mock.method(fs, "readdirSync", () => { discovered = true; throw new Error("unexpected discovery"); });
  assert.deepEqual(project.run().patches, []);
  assert.equal(discovered, false);
});

test("reasoning persistence preserves every current accepted-steering prerequisite", () => {
  const native = partition(fixture), enabled = partition(apply(fixture)), disabled = partition(apply(fixture), false);
  for (const extra of [{}, { questionReplies: [] }, { codexDelegation: {} }, { isToolOutput: true }, { isHistoricalSteering: true }]) {
    const items = [unit("user-message", "accepted", { steeringStatus: "accepted", ...extra }),
      unit("reasoning", "summary", { content: "Available summary" }), unit("exec", "tool")];
    const options = { hasFollowingFinalAnswer: true };
    const expected = Object.keys(extra).length === 0 ? ["accepted"] : [];
    assert.deepEqual(ids(native(items, options).persistentUnits), expected);
    assert.equal(JSON.stringify(disabled(items, options)), JSON.stringify(native(items, options)));
    assert.deepEqual(ids(enabled(items, options).persistentUnits), [...expected, "summary"]);
  }
});
