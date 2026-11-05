"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const descriptors = require("./patch.js");
const { applyNativeSettingsVisibilityPatch, matchesNativeSettingsVisibilityContract } = require("./settings.js");
const { createPatchReport } = require("../../scripts/lib/patch-report.js");
const { applyExtractedAppPatchDescriptors } = require("../../scripts/patches/engine.js");
const { PHASE_EXTRACTED_APP_POST_WEBVIEW } = require("../../scripts/patches/descriptor.js");
const { findUniqueRspackModuleCopies } = require("../../scripts/patches/lib/rspack-module-assets.js");
const { javascriptSourceParses } = require("../../scripts/patches/lib/javascript-syntax.js");

const filter = 'function visible(e,t,n){if(0===t.length&&!n)return e;let r=new Set(t);return e.filter(e=>(!n||!(0,restriction.isRestricted)(e.plugin.id))&&!r.has(e.plugin.id))}';
const moduleBody = `let sections=["plugins-connected","plugins-featured"],labels=["built by openai","chatgpt official"];n.d(t,{},{view:${filter.replace("function visible", "function")}});`;
const chunk = (body, moduleId = "Presentation") => `export const __webpack_modules__={${moduleId}(e,t,n){${body}}};`;

function workspace(t) {
  const cache = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "codex-desktop-dev");
  fs.mkdirSync(cache, { recursive: true });
  const root = fs.mkdtempSync(path.join(cache, "cua-native-visibility-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const assets = path.join(root, "webview", "assets");
  const write = (name, source) => {
    const file = path.join(assets, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, source);
    return file;
  };
  const run = () => {
    const report = createPatchReport();
    applyExtractedAppPatchDescriptors(root, [descriptors.find(({ id }) => id === "native-settings-visibility")],
      {}, report, PHASE_EXTRACTED_APP_POST_WEBVIEW);
    return report.patches[0];
  };
  return { write, run };
}

test("native presentation preserves real plugin state, hidden IDs, and restricted-mode policy", () => {
  const plugins = [
    { marketplaceName: "openai-bundled", plugin: { id: "native", name: "computer-use", installed: false, enabled: false } },
    { marketplaceName: "openai-bundled", plugin: { id: "unified", name: "unified-computer-use", installed: true, enabled: false } },
    { marketplaceName: "custom", plugin: { id: "custom", name: "computer-use", installed: true, enabled: false } },
    { marketplaceName: "openai-bundled", plugin: { id: "restricted", name: "browser", installed: true, enabled: true } },
  ];
  const before = JSON.stringify(plugins);
  for (const hidden of [[], ["unified"], ["custom"], ["native", "restricted"]]) {
    for (const mode of [false, true]) {
      const actual = vm.runInNewContext(`${applyNativeSettingsVisibilityPatch(filter)};visible(plugins,hidden,mode)`, {
        plugins, hidden, mode, restriction: { isRestricted: id => id === "restricted" },
      });
      assert.deepEqual(Array.from(actual), plugins.filter(plugin => plugin.plugin.id !== "native" &&
        !hidden.includes(plugin.plugin.id) && !(mode && plugin.plugin.id === "restricted")));
    }
  }
  assert.equal(JSON.stringify(plugins), before);
});

test("visibility descriptor patches every replica of one owner and reports applied then already-applied", t => {
  const { write, run } = workspace(t);
  const first = write("async/1.hash.js", chunk(moduleBody));
  const second = write("nested/1.hash.js", chunk(moduleBody.replaceAll("restriction", "anotherAlias")));
  assert.equal(run().status, "applied");
  assert.ok(fs.readFileSync(first, "utf8").includes("/* linux-native-settings-component */"));
  assert.ok(fs.readFileSync(second, "utf8").includes("/* linux-native-settings-component */"));
  assert.equal(run().status, "already-applied");
});

test("visibility descriptor rejects absent, ambiguous, mixed, and damaged replicated owners without writes", t => {
  t.mock.method(console, "warn", () => {});
  for (const [firstBody, secondBody, otherId] of [
    ["const unrelated=true;", "const unrelated=false;", "Presentation"],
    [moduleBody, moduleBody, "DifferentIdentity"],
    [moduleBody, applyNativeSettingsVisibilityPatch(moduleBody), "Presentation"],
    [moduleBody, moduleBody.replace("new Set(t)", "new Set(other)"), "Presentation"],
    [moduleBody, moduleBody.replace('"plugins-featured"', '"changed-section"'), "Presentation"],
  ]) {
    const { write, run } = workspace(t);
    const firstSource = chunk(firstBody);
    const secondSource = chunk(secondBody, otherId);
    const first = write("async/1.hash.js", firstSource);
    const second = write("nested/1.hash.js", secondSource);
    assert.equal(run().status, "skipped-optional");
    assert.equal(fs.readFileSync(first, "utf8"), firstSource);
    assert.equal(fs.readFileSync(second, "utf8"), secondSource);
  }
});

test("visibility descriptor restores all replica bytes after an interrupted write", t => {
  t.mock.method(console, "warn", () => {});
  const { write, run } = workspace(t);
  const files = [write("async/1.hash.js", chunk(moduleBody)), write("async/2.hash.js", chunk(moduleBody))];
  const originalWrite = fs.writeFileSync;
  let writes = 0;
  t.mock.method(fs, "writeFileSync", (...args) => {
    originalWrite(...args);
    writes += 1;
    if (writes === 2) throw new Error("interrupted visibility write");
  });
  assert.equal(run().status, "skipped-optional");
  for (const file of files) assert.equal(fs.readFileSync(file, "utf8"), chunk(moduleBody));
});

test("visibility production descriptor patches all current signed owner copies without changing the trusted input", {
  skip: !process.env.CODEX_SIGNED_EXTRACTED_APP,
}, t => {
  const upstream = path.join(process.env.CODEX_SIGNED_EXTRACTED_APP, "webview", "assets");
  const copies = findUniqueRspackModuleCopies(upstream, {
    sourceMatch: source => source.includes('"plugins-connected"') && source.includes('"plugins-featured"'),
    matchModule: source => source.includes('"plugins-connected"') && source.includes('"plugins-featured"') &&
      matchesNativeSettingsVisibilityContract(source),
    description: "current signed plugin presentation owner",
  });
  assert.ok(copies.length > 1, "the current package registers its presentation owner in several async chunks");
  assert.equal(new Set(copies.map(copy => copy.moduleId)).size, 1);
  const { write, run } = workspace(t);
  const files = copies.map(copy => ({ copy, file: write(copy.assetName, copy.source) }));
  assert.equal(run().status, "applied");
  for (const { copy, file } of files) {
    const patched = fs.readFileSync(file, "utf8");
    assert.notEqual(patched, copy.source);
    assert.equal(javascriptSourceParses(patched), true);
    assert.equal(fs.readFileSync(path.join(upstream, copy.assetName), "utf8"), copy.source);
  }
  assert.equal(run().status, "already-applied");
});


test("visibility rejects a disconnected inline export and rebound publication authority", t => {
  t.mock.method(console, "warn", () => {});
  for (const body of [
    moduleBody.replace("n.d(t,", "n.d(other,"),
    moduleBody.replace("n.d(t,", "other.d(t,"),
    "({n}=other);" + moduleBody,
    "({t}=other);" + moduleBody,
    "if(false){" + moduleBody + "}",
  ]) {
    const {write,run}=workspace(t),source=chunk(body),file=write("async/1.hash.js",source);
    assert.equal(run().status,"skipped-optional");
    assert.equal(fs.readFileSync(file,"utf8"),source);
  }
});
