"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { fixture, chunk, lifecycle } = require("./model-picker-default-view.test-helpers.js");
const helper = require("./patches/model-picker-default-view.js");
const picker = require("./patches/model-picker-model-list.js");
const { rspackModuleFactories } = require("../../scripts/patches/lib/rspack-module-assets.js");
const { extractedAppPatch } = require("../../scripts/patches/descriptor.js");
const { applyExtractedAppPatchDescriptors } = require("../../scripts/patches/engine.js");
const { createPatchReport } = require("../../scripts/lib/patch-report.js");

const disabled = { feature: { settings: { tweaks: { modelPicker: { showModelsByDefault: { enabled: false } } } } } };
const owners = { "shell-work.current.js": chunk("work"), "async/chat-current.js": chunk("chat") };

function copies(source, kind, assetName = `${kind}.js`) {
  return [...rspackModuleFactories(source, assetName)].map(copy => ({ ...copy, pickerKind: kind }));
}

function withApp(files, callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "model-picker-view-"));
  const assets = path.join(root, "webview/assets");
  fs.mkdirSync(assets, { recursive: true });
  for (const [name, source] of Object.entries(files)) {
    const file = path.join(assets, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, source);
  }
  const read = name => fs.readFileSync(path.join(assets, name), "utf8");
  try { return callback({ root, assets, read }); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function nonViewEvents(run) {
  return run.events.filter(event => event[0] !== "view");
}

for (const kind of ["work", "chat"]) {
  test(`current ${kind} fixture retains its official factory bytes`, () => {
    const digest = crypto.createHash("sha256").update(fixture[kind].moduleSource).digest("hex");
    assert.equal(digest, fixture[kind].provenance.moduleSha256);
    assert.equal(copies(chunk(kind), kind)[0].moduleSource, fixture[kind].moduleSource);
  });

  test(`${kind} default view uses the production transform with complete inverse and repeat`, () => {
    const native = chunk(kind);
    const patched = picker.applyDefaultAdvancedViewPatch(native);
    assert.notEqual(patched, native);
    assert.equal(picker.applyDefaultAdvancedViewPatch(patched), patched);
    const nativePlan = helper.inspectDefaultView(copies(native, kind)[0], kind);
    const patchedPlan = helper.inspectDefaultView(copies(patched, kind)[0], kind);
    assert.equal(nativePlan.state, "native");
    assert.equal(patchedPlan.state, "patched");
    assert.equal(patchedPlan.nativeSource, fixture[kind].moduleSource);
    assert.equal(nativePlan.patchedSource, patchedPlan.patchedSource);
  });

  test(`${kind} native lifecycle starts detailed and restores that default after closing`, () => {
    const native = chunk(kind);
    const baseline = lifecycle(native, kind);
    const actual = lifecycle(helper.prepareDefaultViewSource(native), kind);
    assert.equal(actual.states.initial, "advanced");
    assert.equal(actual.states.firstOpen, "advanced");
    assert.equal(actual.states.afterCloseTimer, "advanced");
    assert.equal(actual.states.afterModelSelection, "advanced");
    assert.equal(actual.states.manualToggle, "simple");
    assert.deepEqual(nonViewEvents(actual), nonViewEvents(baseline));
    if (kind === "chat") {
      assert.equal(actual.states.reopen, "advanced");
      assert.equal(actual.states.chatAlternateOpen, "advanced");
      assert.deepEqual(actual.events.find(event => event[0] === "commit"),
        ["commit", { slug: "model-b", versionId: "version-b" }]);
    } else {
      assert.equal(actual.states.ordinaryShortcut, "advanced");
      assert.equal(actual.states.explicitModelListAction, "advanced");
      assert.equal(actual.states.explicitCompactAction, "simple");
      assert.equal(actual.states.shortcutAfterExplicitCompact, "advanced");
      assert.deepEqual(actual.events.find(event => event[0] === "selection"), ["selection", "model-b", "high"]);
      assert.deepEqual(actual.events.find(event => event[0] === "onComplete"), ["onComplete", true]);
    }
  });
}

test("default view disabled settings skip both normal APIs before source discovery", () => {
  assert.equal(picker.applyDefaultAdvancedViewPatch("unrelated source", disabled), "unrelated source");
  assert.deepEqual(picker.applyDefaultAdvancedViewToApp("/missing-disabled-picker", disabled), { matched: 0, changed: 0 });
  const descriptor = extractedAppPatch(picker.descriptors.find(item => item.id === "model-picker-default-advanced-view"));
  const report = createPatchReport();
  applyExtractedAppPatchDescriptors("/missing-disabled-picker", [descriptor], disabled, report, descriptor.phase);
  assert.equal(report.patches.length, 1);
  assert.equal(report.patches[0].status, "skipped-disabled");
});

test("production descriptor patches both owners and every physical copy in one pass", () => {
  withApp({ ...owners, "async/work-physical-copy.js": chunk("work") }, ({ root, read }) => {
    const descriptor = extractedAppPatch(picker.descriptors.find(item => item.id === "model-picker-default-advanced-view"));
    for (const expected of ["applied", "already-applied"]) {
      const report = createPatchReport();
      applyExtractedAppPatchDescriptors(root, [descriptor], {}, report, descriptor.phase);
      assert.equal(report.patches.length, 1);
      assert.equal(report.patches[0].status, expected);
    }
    assert.equal(read("shell-work.current.js"), read("async/work-physical-copy.js"));
    assert.equal(lifecycle(read("async/chat-current.js"), "chat").states.reopen, "advanced");
  });
});

test("cohort qualification refuses absent, ambiguous, mixed and damaged owners without writes", () => {
  const changedWork = picker.applyDefaultAdvancedViewPatch(chunk("work"));
  const changedChat = picker.applyDefaultAdvancedViewPatch(chunk("chat"));
  const cases = [
    { "shell-work.current.js": chunk("work") },
    { ...owners, "another-work.js": chunk("work", fixture.work.moduleSource, "anotherWorkOwner") },
    { ...owners, "shell-work.current.js": changedWork },
    { ...owners, "async/chat-current.js": changedChat.replace('t8("advanced")', 't8("simple")') },
    { ...owners, "orphan.js": `const label=${JSON.stringify(helper.MARKER)};` },
    { ...owners, "damaged-work-copy.js": chunk("work").replace('l6("simple")', 'l6("broken")') },
  ];
  for (const files of cases) withApp(files, ({ root, read }) => {
    assert.throws(() => helper.applyDefaultView(root));
    for (const [name, source] of Object.entries(files)) assert.equal(read(name), source);
  });
});

test("owner qualification rejects escaped setters and ambiguous object-division source", () => {
  for (const [kind, mutation] of [
    ["chat", source => source.replace(/\bt8\b/g, String.raw`\u00748`)],
    ["work", source => `const hostile={} / (g=foreign) / 1;${source}`],
    ["chat", source => source.replace('l("zd8w")', 'l("foreign-react")')],
  ]) {
    const source = chunk(kind, mutation(fixture[kind].moduleSource));
    const [copy] = copies(source, kind);
    assert.throws(() => helper.inspectDefaultView(copy, kind));
    assert.throws(() => helper.prepareDefaultViewSource(source));
  }
});

test("published menus retain native return paths and live open callback bindings", () => {
  const mutations = [
    ["work", source => source.replace('M:function(e){', 'M:function(e){return null;')],
    ["chat", source => source.replace('function eF(e){', 'function eF(e){return null;')],
    ["chat", source => source.replace(';function nS(e,t){', ';nS=()=>{};function nS(e,t){')],
    ["work", source => source.replace('return lW[289]', 'oH=()=>{};return lW[289]')],
    ["chat", source => source.replace('let nV=(0,n.jsxs)', 'eb=()=>{};let nV=(0,n.jsxs)')],
    ["chat", source => source.replace('if(!tH)return null;', 'if(!tH)return "discarded";')],
  ];
  for (const [kind, mutate] of mutations) {
    const original = fixture[kind].moduleSource;
    const damaged = mutate(original);
    assert.notEqual(damaged, original);
    const [copy] = copies(chunk(kind, damaged), kind);
    assert.throws(() => helper.inspectDefaultView(copy, kind));
  }
  for (const kind of ["work", "chat"]) {
    assert.equal(helper.inspectDefaultView(copies(chunk(kind), kind)[0], kind).state, "native");
  }
});

test("default view restores both native owners when a later asset write fails", () => {
  withApp(owners, ({ root, read }) => {
    let writes = 0;
    assert.throws(() => helper.applyDefaultView(root, {
      writeFileSync(file, bytes) {
        if (++writes === 2) {
          fs.writeFileSync(file, "truncated");
          throw new Error("injected picker write failure");
        }
        fs.writeFileSync(file, bytes);
      },
    }), /injected picker write failure/);
    for (const [name, source] of Object.entries(owners)) assert.equal(read(name), source);
  });
});
