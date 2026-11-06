"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { applyStandalonePatch: apply, standaloneDescriptor: descriptor, standaloneState } = require("./standalone.js");
const { RUNTIME, withRuntime } = require("./runtime.js");
const { createPatchReport } = require("../../scripts/lib/patch-report.js");
const { applyExtractedAppPatchDescriptors } = require("../../scripts/patches/engine.js");
const { PHASE_EXTRACTED_APP_POST_WEBVIEW } = require("../../scripts/patches/descriptor.js");
const { findUniqueRspackModuleCopies } = require("../../scripts/patches/lib/rspack-module-assets.js");
const { javascriptSourceParses } = require("../../scripts/patches/lib/javascript-syntax.js");
const { escapeRegExp } = require("../../scripts/patches/lib/minified-js.js");

const fixture = fs.readFileSync(path.join(__dirname, "fixtures/current-standalone-module.js"), "utf8").trim();
const fixtureParams = ["e", "t", "a"];
const chunk = (body, id = "Discriminator") => `export const __webpack_modules__={${id}(${fixtureParams.join(",")}){${body}}};`;

function publishExports(target, getters, values = {}) {
  for (const [name, get] of Object.entries(getters)) Object.defineProperty(target, name, { enumerable: true, get });
  for (const [name, value] of Object.entries(values)) Object.defineProperty(target, name, { enumerable: true, value });
}

function classify(moduleSource, enabled = true, params = fixtureParams) {
  const load = () => ({
    Pi: () => false, X: () => false, mw: () => null, FR: () => false,
    LS: item => Boolean(item.standalone), o: item => Boolean(item.persist),
    kT: ({ item }) => Boolean(item.interactive), $: value => value, rF: item => item.renderer,
  });
  load.d = publishExports;
  const published = {};
  const factory = vm.runInNewContext(`(function(${params.join(",")}){${moduleSource}\n})`, {
    localStorage: { getItem: () => enabled ? "1" : null },
  });
  factory({}, published, load);
  assert.equal(typeof published.c, "function", "expected the published discriminator export");
  return published.c;
}

test("current discriminator projects real reasoning items in order with their original identity", () => {
  const published = {}, direct = () => { throw new Error("export values must retain their function identity"); };
  publishExports(published, { getter: () => direct }, { direct });
  assert.equal(published.getter, direct);
  assert.equal(published.direct, direct);
  const patched = apply(fixture);
  assert.notEqual(patched, fixture);
  assert.equal(apply(patched), patched);
  assert.equal(javascriptSourceParses(patched), true);
  const original = classify(fixture), enabled = classify(patched), disabled = classify(patched, false);
  const items = [
    { type: "reasoning", id: "turn1-summary1", turnId: "turn1", completed: false, content: "Streaming summary" },
    { type: "reasoning", id: "turn1-summary2", turnId: "turn1", completed: true, content: "Completed summary" },
  ];
  for (const item of items) {
    assert.equal(original(item), null);
    assert.equal(disabled(item), null);
    const result = enabled(item);
    assert.equal(result.item, item);
    assert.equal(result.grouping, "standalone");
  }
  assert.deepEqual(items.map(item => enabled(item).item.id), ["turn1-summary1", "turn1-summary2"]);
  const missingSummary = { type: "reasoning", id: "empty-summary", completed: true };
  assert.equal(enabled(missingSummary).item, missingSummary);
  assert.equal(missingSummary.content, undefined, "classification must not create unavailable model content");
});

test("all non-reasoning discriminator paths retain the actual upstream outcomes", () => {
  const original = classify(fixture), enabled = classify(apply(fixture));
  const events = [
    ...["external-event", "image-view", "worktree-init", "automation-update", "assistant-message", "user-message",
      "dil-reasoning", "context-compaction", "worked-for", "model-changed", "turn-diff"].map(type => ({ type })),
    { type: "exec" }, { type: "exec", standalone: true }, { type: "patch" },
    { type: "exec", automaticApprovalReviews: [{ status: "approved" }, { status: "denied" }] },
    { type: "mcp-tool-call" }, { type: "mcp-tool-call", persist: true }, { type: "mcp-tool-call", interactive: true },
    { type: "web-search", query: "" }, { type: "web-search", query: "available query" },
    { type: "dynamic-tool-call" }, { type: "dynamic-tool-call", renderer: { hiddenInConversation: true } },
    { type: "dynamic-tool-call", renderer: { standaloneInConversation: true } },
    { type: "generated-image" },
    { type: "mcp-server-elicitation", completed: false, elicitation: { kind: "legacyOpenAIForm" } },
    { type: "mcp-server-elicitation", completed: true, elicitation: { kind: "unsupportedOpenAIForm" } },
    { type: "mcp-server-elicitation", completed: true, elicitation: { kind: "legacyOpenAIForm", schema: { properties: {} } } },
    ...["approved", "inProgress", "aborted", "denied", "timedOut"].map(status => ({ type: "automatic-approval-review", status })),
  ];
  const before = JSON.stringify(events);
  for (const item of events) {
    for (const includeGeneratedImages of [false, true]) {
      const options = { includeGeneratedImages };
      assert.equal(JSON.stringify(enabled(item, options)), JSON.stringify(original(item, options)));
    }
  }
  assert.equal(JSON.stringify(events), before);
});

test("standalone discriminator rejects malformed, duplicate, mixed, and incomplete runtime states", t => {
  t.mock.method(console, "warn", () => {});
  const patched = apply(fixture);
  const { wrap, item } = standaloneState(fixture).match.groups;
  const wrongItem = patched.replace(`codexLinuxReasoningVisibilityEnabled()?${wrap}(${item},"standalone")`,
    `codexLinuxReasoningVisibilityEnabled()?${wrap}(other,"standalone")`);
  assert.notEqual(wrongItem, patched);
  for (const current of [
    "const unrelated=true;", fixture + fixture, fixture + patched, patched + patched,
    fixture.replace('case"reasoning":', 'case"changed-reasoning":') + fixture,
    fixture.replace('case"reasoning":', 'case"changed-reasoning":'),
    wrongItem,
    patched.replace("/*community-reasoning-visibility-standalone*/", ""),
    patched.replace(RUNTIME, ""), RUNTIME + patched,
  ]) {
    assert.notEqual(current, fixture);
    assert.equal(apply(current), current);
  }
  const renamed = fixture.replace(new RegExp(`(?<![\\w$.])${escapeRegExp(wrap)}(?![\\w$])`, "g"), () => "$wrap")
    .replace(new RegExp(`(?<![\\w$.])${escapeRegExp(item)}(?![\\w$])`, "g"), () => "freshItem");
  assert.notEqual(apply(renamed), renamed);
  assert.equal(apply(apply(renamed)), apply(renamed));
  assert.equal(classify(apply(renamed))({ type: "reasoning" }).grouping, "standalone");
});

test("a factory-scoped preference helper does not hide the helper needed by sibling modules", () => {
  const nested = chunk(apply(fixture));
  const source = `${nested}function sibling(){return codexLinuxReasoningVisibilityEnabled()}`;
  const patched = withRuntime(source);
  assert.ok(patched.startsWith(RUNTIME + "\n"));
  assert.equal(patched.split(RUNTIME).length - 1, 2);
  assert.equal(withRuntime(patched), patched);
  const executable = patched.replace("export const __webpack_modules__=", "const registry=");
  assert.equal(vm.runInNewContext(`${executable};sibling()`, { localStorage: { getItem: () => "1" } }), true);
  const prefixed = "function unrelated(){}" + patched;
  assert.equal(withRuntime(prefixed), prefixed, "an earlier feature prefix must not duplicate the outer runtime");
});

test("standalone applied states reject sibling/nested helpers and pristine orphan calls atomically", t => {
  t.mock.method(console, "warn", () => {});
  const body = apply(fixture).replace(RUNTIME + "\n", "");
  const sibling = `export const __webpack_modules__={Owner(${fixtureParams.join(",")}){${body}},Sibling(${fixtureParams.join(",")}){${RUNTIME}}};`;
  const nested = `${body};function unused(){${RUNTIME}}`;
  const load = () => ({});
  load.d = publishExports;
  const siblingClassify = vm.runInNewContext(sibling.replace("export const __webpack_modules__=", "const modules=") + ";modules.Owner({}, published, load);published.c", { load, published: {} });
  const nestedPublished = {};
  vm.runInNewContext(`(function(${fixtureParams.join(",")}){${nested}})` )({}, nestedPublished, load);
  const nestedClassify = nestedPublished.c;
  const reasoning = { type: "reasoning", id: "scope-summary" };
  assert.throws(() => siblingClassify(reasoning), /codexLinuxReasoningVisibilityEnabled is not defined/);
  assert.throws(() => nestedClassify(reasoning), /codexLinuxReasoningVisibilityEnabled is not defined/);
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

test("standalone accepts own-factory helpers alongside valid outer/sibling copies", t => {
  const body = apply(fixture).replace(RUNTIME + "\n", "");
  const load = () => ({});
  load.d = publishExports;
  for (const outer of ["", RUNTIME]) {
    const current = `${outer}export const __webpack_modules__={Owner(${fixtureParams.join(",")}){${RUNTIME}${body}},Sibling(${fixtureParams.join(",")}){${RUNTIME}}};`;
    assert.equal(apply(current), current);
    const runClassifier = vm.runInNewContext(current.replace("export const __webpack_modules__=", "const modules=") + ";modules.Owner({}, published, load);published.c", {
      load, published: {}, localStorage: { getItem: () => "1" },
    });
    const reasoning = { type: "reasoning", id: "own-helper-summary" };
    assert.equal(runClassifier(reasoning).item, reasoning);
    const { write, run } = workspace(t);
    const file = write("async/own-helper.js", current);
    assert.equal(run().status, "already-applied");
    assert.equal(fs.readFileSync(file, "utf8"), current);
  }
});

function workspace(t) {
  const base = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "codex-desktop-dev");
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, "reasoning-standalone-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (name, source) => {
    const file = path.join(root, "webview", "assets", name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, source);
    return file;
  };
  const run = () => {
    const report = createPatchReport();
    applyExtractedAppPatchDescriptors(root, [descriptor], {}, report, PHASE_EXTRACTED_APP_POST_WEBVIEW);
    return report.patches[0];
  };
  return { write, run };
}

test("standalone production descriptor patches all same-ID physical copies atomically and idempotently", t => {
  const { write, run } = workspace(t);
  const first = write("async/1.hash.js", chunk(fixture));
  const second = write("other/1.hash.js", chunk(fixture));
  assert.equal(run().status, "applied");
  assert.ok(fs.readFileSync(first, "utf8").includes("community-reasoning-visibility-standalone"));
  assert.ok(fs.readFileSync(second, "utf8").includes("community-reasoning-visibility-standalone"));
  assert.equal(run().status, "already-applied");
});

test("standalone descriptor rejects different identities and mixed/damaged copies without writing any", t => {
  t.mock.method(console, "warn", () => {});
  for (const [secondBody, secondId] of [
    [fixture, "OtherIdentity"], [apply(fixture), "Discriminator"],
    [fixture.replace('case"reasoning":', 'case"changed-reasoning":'), "Discriminator"],
    [apply(fixture).replace(RUNTIME, ""), "Discriminator"],
  ]) {
    const { write, run } = workspace(t);
    const firstSource = chunk(fixture), secondSource = chunk(secondBody, secondId);
    const first = write("async/1.hash.js", firstSource), second = write("async/2.hash.js", secondSource);
    assert.equal(run().status, "skipped-optional");
    assert.equal(fs.readFileSync(first, "utf8"), firstSource);
    assert.equal(fs.readFileSync(second, "utf8"), secondSource);
  }
});

test("actual signed discriminator copies execute native classification and patch through the normal descriptor", {
  skip: !process.env.CODEX_SIGNED_EXTRACTED_APP,
}, t => {
  const assets = path.join(process.env.CODEX_SIGNED_EXTRACTED_APP, "webview", "assets");
  const copies = findUniqueRspackModuleCopies(assets, {
    sourceMatch: source => source.includes("includeGeneratedImages:") && source.includes('case"reasoning":'),
    matchModule: source => standaloneState(source).kind !== "invalid",
    description: "current standalone activity discriminator",
  });
  assert.ok(copies.length > 1);
  const fixtureCopy = copies.find(copy => copy.moduleSource === fixture);
  assert.ok(fixtureCopy, "fixture must be a verbatim current factory body");
  assert.deepEqual(fixtureCopy.params, fixtureParams, "fixture execution must use the actual factory parameters");
  const { write, run } = workspace(t);
  const files = copies.map(copy => ({ copy, file: write(copy.assetName, copy.source) }));
  for (const copy of copies) {
    const reasoning = { type: "reasoning", id: "real-turn-summary", completed: true, content: "Available" };
    assert.equal(classify(copy.moduleSource, true, copy.params)(reasoning), null);
    assert.equal(classify(apply(copy.moduleSource), true, copy.params)(reasoning).item, reasoning);
    assert.equal(classify(apply(copy.moduleSource), false, copy.params)(reasoning), null);
  }
  assert.equal(run().status, "applied");
  for (const { copy, file } of files) {
    const patched = fs.readFileSync(file, "utf8");
    assert.notEqual(patched, copy.source);
    assert.equal(javascriptSourceParses(patched), true);
    assert.equal(fs.readFileSync(path.join(assets, copy.assetName), "utf8"), copy.source);
  }
  assert.equal(run().status, "already-applied");
});
