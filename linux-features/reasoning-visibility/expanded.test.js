"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { applyExpandedPatch: apply, expandedDescriptor: descriptor, reasoningComponent } = require("./expanded.js");
const { RUNTIME } = require("./runtime.js");
const { createPatchReport } = require("../../scripts/lib/patch-report.js");
const { applyWebviewAssetPatchDescriptors } = require("../../scripts/patches/engine.js");
const { listWebviewAssetFiles } = require("../../scripts/patches/lib/assets.js");
const { javascriptSourceParses } = require("../../scripts/patches/lib/javascript-syntax.js");

const fixture = fs.readFileSync(path.join(__dirname, "fixtures/current-reasoning-component.js"), "utf8").trim();

function nodes(tree, predicate) {
  const found = [], seen = new Set();
  function visit(value) {
    if (value == null || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (predicate(value)) found.push(value);
    for (const child of Object.values(value)) visit(child);
  }
  visit(tree);
  return found;
}

function harness(source, { enabled = true, resume = null } = {}) {
  const values = [], references = [], caches = [];
  let stateIndex = 0, refIndex = 0, cacheIndex = 0, currentResume = resume;
  const React = {
    useState(initial) {
      const index = stateIndex++;
      if (!(index in values)) values[index] = typeof initial === "function" ? initial() : initial;
      return [values[index], next => { values[index] = typeof next === "function" ? next(values[index]) : next; }];
    },
    useRef(initial) { const index = refIndex++; return references[index] ??= { current: initial }; },
    useEffectEvent: callback => callback,
    useEffect: callback => callback(),
    Children: { toArray: value => Array.isArray(value) ? value : [value] },
    isValidElement: () => true,
  };
  const context = vm.createContext({
    localStorage: { getItem: () => enabled ? "1" : null },
    a: { c(size) { return caches[cacheIndex++] ??= Array(size).fill(Symbol.for("react.memo_cache_sentinel")); } },
    r: { _U: () => currentResume }, ed: { nX: "resume" }, ej: React,
    sw: { k2: content => content }, s: { jsx: (type, props) => ({ type, props }), Fragment: "Fragment" },
    u: { A: "LocalizedMessage" }, sM: () => "elapsed",
    tr: { $: () => ({ elementHeightPx: 36, elementRef: "measured" }) },
    $: { A: (...classes) => classes.filter(Boolean).join(" ") }, sj: "heading", sC: "list", sk: () => null,
    sb: { K: "NativeMarkdown" }, eH: { N: "ActivityLabel" }, tb: { A: "NativeDisclosure" },
    sy: { t: "NativeScroll" }, ty: { j: "BodyFrame" }, e5: { P: { div: "NativeMotion" } },
    te: { X7: { duration: 0 } }, tw: { n: "ActivityItem" },
    Date: class extends Date { static now() { return 1000; } },
  });
  const component = /^function ([\w$]+)\(/.exec(reasoningComponent(source).text)[1];
  if (source.includes("export const __webpack_modules__=")) {
    vm.runInContext(source.replace("export const __webpack_modules__=", "globalThis.factories=") + ";globalThis.Component=factories.Owner()", context);
  } else vm.runInContext(`${source};globalThis.Component=${component}`, context);
  return {
    setResume(value) { currentResume = value; },
    render(item) {
      stateIndex = refIndex = cacheIndex = 0;
      const tree = context.Component({ item, conversationId: "conversation", cwd: "/project", hostId: "local", hideCodeBlocks: false });
      return { tree,
        scroll: nodes(tree, value => value.type === "NativeScroll")[0]?.props,
        markdown: nodes(tree, value => value.type === "NativeMarkdown")[0]?.props,
        disclosure: nodes(tree, value => value.type === "NativeDisclosure")[0]?.props.disclosure,
      };
    },
  };
}

test("actual native component expands empty-start streams on completion and retains manual fold/reopen", () => {
  const patched = apply(fixture);
  assert.notEqual(patched, fixture);
  assert.equal(apply(patched), patched);
  assert.equal(javascriptSourceParses(patched), true);
  const app = harness(patched);
  const item = { type: "reasoning", id: "summary", completed: false, content: "" };
  assert.equal(app.render(item).scroll, undefined);
  item.content = "Actual model summary";
  let result = app.render(item);
  assert.equal(result.scroll.autoScrollToBottom, true);
  assert.equal(result.markdown.children, item.content);
  item.completed = true;
  result = app.render(item);
  assert.equal(result.scroll.autoScrollToBottom, false);
  assert.equal(result.disclosure.expanded, true);
  assert.equal(result.markdown.children, item.content);
  result.disclosure.onToggle();
  result = app.render(item);
  assert.equal(result.scroll, undefined);
  assert.equal(result.disclosure.expanded, false);
  result.disclosure.onToggle();
  assert.equal(app.render(item).disclosure.expanded, true);
  assert.equal(harness(patched).render(item).disclosure.expanded, true, "reopened history starts expanded");
});

test("no completed body, disabled preference, native resumed streams, and manual native behavior are preserved", () => {
  const patched = apply(fixture);
  const empty = { type: "reasoning", completed: true, content: "" };
  assert.equal(JSON.stringify(harness(patched).render(empty).tree), JSON.stringify(harness(fixture).render(empty).tree));
  const item = { type: "reasoning", completed: true, content: "Available body" };
  const original = harness(fixture), disabled = harness(patched, { enabled: false });
  let before = original.render(item), after = disabled.render(item);
  assert.equal(JSON.stringify(after.tree), JSON.stringify(before.tree));
  before.disclosure.onToggle();
  after.disclosure.onToggle();
  assert.equal(JSON.stringify(disabled.render(item).tree), JSON.stringify(original.render(item).tree));
  for (const resume of [null, "resumed", "paused"]) {
    const stream = { type: "reasoning", completed: false, content: "**Heading** Real streamed summary" };
    const before = harness(fixture, { resume }).render(stream);
    const after = harness(patched, { resume }).render(stream);
    assert.equal(JSON.stringify(after.tree), JSON.stringify(before.tree));
    if (resume !== "paused") assert.equal(after.scroll.autoScrollToBottom, true);
  }
});

test("expanded native contract rejects partial state/body guards, changed callbacks, and inaccessible runtimes", t => {
  t.mock.method(console, "warn", () => {});
  const patched = apply(fixture), body = patched.replace(RUNTIME + "\n", "");
  const sourceCases = [
    "const unrelated=true;", fixture + fixture, patched + fixture,
    patched.replace("/*community-reasoning-visibility-expanded*/", ""),
    patched.replace("/*community-reasoning-visibility-expanded-body*/", ""),
    patched.replace('&&(!codexLinuxReasoningVisibilityEnabled()||!!L)/*community-reasoning-visibility-expanded-body*/', ""),
    patched.replace("onToggle:()=>{O(sI)}", "onToggle:()=>{other(sI)}"),
    patched.replace("autoScrollToBottom:P", "autoScrollToBottom:!1"),
    patched.replace(RUNTIME, ""), RUNTIME + patched,
    body + `;function unused(){${RUNTIME}}`, body + `;if(false){${RUNTIME}}`,
    `export const __webpack_modules__={Owner(e,t,n){${body}},Sibling(e,t,n){${RUNTIME}}};`,
    fixture + ";function orphan(){return codexLinuxReasoningVisibilityEnabled()}",
  ];
  for (const source of sourceCases) {
    assert.notEqual(source, fixture);
    assert.equal(apply(source), source);
  }
});

function workspace(t) {
  const base = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "codex-desktop-dev");
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, "reasoning-expanded-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (name, source) => {
    const file = path.join(root, "webview", "assets", name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, source);
    return file;
  };
  const run = () => {
    const report = createPatchReport();
    applyWebviewAssetPatchDescriptors(root, [descriptor], {}, report);
    return report.patches[0];
  };
  return { write, run };
}

test("expanded complete state accepts own-factory helpers with legitimate outer/sibling copies", t => {
  const body = apply(fixture).replace(RUNTIME + "\n", "");
  const component = /^function ([\w$]+)\(/.exec(reasoningComponent(body).text)[1];
  for (const outer of ["", RUNTIME]) {
    const source = `${outer}export const __webpack_modules__={Owner(e,t,n){${RUNTIME}${body};return ${component}},Sibling(e,t,n){${RUNTIME}}};`;
    assert.equal(apply(source), source);
    assert.equal(harness(source).render({ completed: true, content: "Available" }).disclosure.expanded, true);
    const { write, run } = workspace(t);
    const file = write("async/own-helper.js", source);
    assert.equal(run().status, "already-applied");
    assert.equal(fs.readFileSync(file, "utf8"), source);
  }
});

test("expanded production descriptor rejects ambiguous and wrong-scope copies without writes", t => {
  t.mock.method(console, "warn", () => {});
  const { write, run } = workspace(t);
  const first = write("async/366297.hash.js", fixture);
  assert.equal(run().status, "applied");
  const patched = fs.readFileSync(first, "utf8");
  assert.equal(run().status, "already-applied");
  const misplaced = patched.replace(RUNTIME + "\n", "") + `;function unused(){${RUNTIME}}`;
  const second = write("other/366297.hash.js", misplaced);
  assert.equal(run().status, "skipped-optional");
  assert.equal(fs.readFileSync(first, "utf8"), patched);
  assert.equal(fs.readFileSync(second, "utf8"), misplaced);
  fs.writeFileSync(first, "const unrelated=true;");
  assert.equal(run().status, "skipped-optional");
  assert.equal(fs.readFileSync(second, "utf8"), misplaced);
});

test("signed current native component patches idempotently through production descriptor", {
  skip: !process.env.CODEX_SIGNED_EXTRACTED_APP,
}, t => {
  const assets = path.join(process.env.CODEX_SIGNED_EXTRACTED_APP, "webview", "assets");
  const owners = listWebviewAssetFiles(assets, /\.js$/).map(assetName => ({assetName,source:fs.readFileSync(path.join(assets,assetName),"utf8")})).filter(({source}) => descriptor.assetMatch(source));
  assert.equal(owners.length,1);
  const owner=owners[0];
  const native = reasoningComponent(owner.source);
  assert.ok(fixture.startsWith(native.text), "fixture must match the actual current component body");
  const { write, run } = workspace(t);
  const file = write(owner.assetName, owner.source);
  assert.equal(run().status, "applied");
  assert.equal(javascriptSourceParses(fs.readFileSync(file, "utf8")), true);
  assert.equal(run().status, "already-applied");
  assert.equal(fs.readFileSync(path.join(assets, owner.assetName), "utf8"), owner.source);
});
