"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const home = require("./patches/suggested-prompts-app-page.js");
const work = require("./patches/suggested-prompts-work-page.js");
const fixtures = require("./fixtures/suggested-prompts-work-page.js");
const { descriptors } = require("./patches/suggested-prompts.js");
const { rspackModuleFactories, findUniqueRspackModuleCopies, findRspackRequireBinding } = require("../../scripts/patches/lib/rspack-module-assets.js");
const { resolveFunction, isRolloutHook, entryContext } = home.roleHelpers;
const descriptor = descriptors.find(item => item.id === "home-suggested-prompts-work-page");

function workspace(t, source) {
  const cache = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "codex-desktop-dev");
  fs.mkdirSync(cache, { recursive: true });
  const root = fs.mkdtempSync(path.join(cache, "home-publication-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "webview/assets"), { recursive: true });
  fs.writeFileSync(path.join(root, "webview/index.html"), '<script type="module" src="./assets/runtime.js"></script>');
  fs.writeFileSync(path.join(root, "webview/assets/runtime.js"), fixtures.runtime);
  fs.writeFileSync(path.join(root, "webview/assets/owner.js"), source);
  return root;
}
function directFixture() {
  const hook = [...rspackModuleFactories(fixtures.chunk(), "fixture.js")].find(module => module.moduleId === "Hooks");
  const fn = home.roleHelpers.functions(hook.moduleSource, "gate")[0];
  const literal = hook.moduleSource.slice(fn.start, fn.end).replace(/^function gate/u, "function");
  return fixtures.chunk().replace('require.d(exports,{gate:()=>gate,cache:()=>cache})', `require.d(exports,{cache:()=>cache},{gate:${literal}})`);
}

test("normal Work descriptor resolves direct function roles and rejects duplicate export authority before writes", t => {
  const source = directFixture(), root = workspace(t, source);
  assert.equal(descriptor.apply(root).changed, 1);
  assert.equal(descriptor.apply(root).changed, 0);
  const bad = source.replace('require.d(exports,{cache:()=>cache},{gate:', 'require.d(exports,{gate:()=>gate,cache:()=>cache},{gate:');
  assert.notEqual(bad, source);
  const refused = workspace(t, bad), target = path.join(refused, "webview/assets/owner.js");
  assert.throws(() => descriptor.apply(refused), /dependency export/u);
  assert.equal(fs.readFileSync(target, "utf8"), bad);
});

test("actual latest Work dependency resolves and executes its direct anonymous rollout function", {
  skip: !process.env.CODEX_SIGNED_EXTRACTED_APP,
}, () => {
  const app = process.env.CODEX_SIGNED_EXTRACTED_APP, assets = path.join(app, "webview/assets");
  const owners = findUniqueRspackModuleCopies(assets, { sourceMatch: source => source.includes("ChatGptWorkHomePage:"), matchModule: work.isCandidate });
  const info = work.inspectModule(owners[0]);
  assert.ok(info);
  const imported = findRspackRequireBinding(info.module, info.rolloutCall.namespace);
  assert.ok(imported);
  const entry = entryContext(app), targets = resolveFunction(assets, imported.moduleId, info.rolloutCall.member, new Map(), entry.entryId);
  assert.ok(targets.length > 0);
  assert.equal(targets.every(isRolloutHook), true);
  for (const target of targets) {
    assert.equal(target.exportName, info.rolloutCall.member);
    const source = target.module.moduleSource.slice(target.fn.start, target.fn.end), body = target.fn.body;
    const cache = /\(0,([\w$]+)\.c\)\(2\)/u.exec(body)[1];
    const read = /\(0,([\w$]+)\.Ul\)\([\w$]+\)$/u.exec(body)[1];
    const signal = /([\w$]+)\.JW\.resolve/u.exec(body)[1];
    const context = /^let [\s\S]+?;return ([\w$]+)\("string"==typeof/u.exec(body)[1];
    let enabled = false;
    const memo = [], observed = [];
    const globals = {
      [cache]: { c: () => memo },
      [read]: { Ul: value => typeof value === "boolean" ? value : enabled },
      [signal]: { JW: { scope: {}, resolve: () => ({ atom: enabled }) } },
      [context]: value => observed.push(value),
    };
    const gate = vm.runInNewContext(`(${source})`, globals);
    assert.equal(gate("2425897452"), false);
    enabled = true;
    assert.equal(gate("2425897452"), true);
    assert.equal(gate(false), false);
    assert.deepEqual(observed, [true, true, false]);
  }
});

test("bare Home module bodies require their actual parsed snapshot context", () => {
  const source = fixtures.chunk();
  const module = [...rspackModuleFactories(source, "fixture.js")].find(copy => copy.moduleId === "WorkPage");
  assert.equal(work.inspectPage(module.moduleSource), null);
  assert.ok(work.inspectPage(module.moduleSource,module));
});
