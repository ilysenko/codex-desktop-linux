"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { findUniqueRspackModuleCopies, patchRspackModuleCopies, rspackModuleFactories, findRspackRequireBinding } = require("./rspack-module-assets.js");

const pristine = 'const target="semantic-owner";const state=0;';
const applied = pristine.replace("state=0", "state=1");
const chunk = (body, id = "Ab12") => `export const __rspack_esm_id=1;export const __webpack_modules__={${id}(e,t,n){${body}}};`;

function workspace(t, files) {
  const cache = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "codex-desktop-dev");
  fs.mkdirSync(cache, { recursive: true });
  const assets = fs.mkdtempSync(path.join(cache, "rspack-module-assets-"));
  t.after(() => fs.rmSync(assets, { recursive: true, force: true }));
  for (const [name, source] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(assets, name)), { recursive: true });
    fs.writeFileSync(path.join(assets, name), source);
  }
  return assets;
}

function copies(assets) {
  return findUniqueRspackModuleCopies(assets, {
    sourceMatch: source => source.includes("semantic-owner"),
    matchModule: source => source.includes("semantic-owner"),
    description: "fixture semantic owner",
  });
}

function patch(source) {
  if (source === applied) return source;
  if (source !== pristine) throw new Error("Invalid semantic-owner contract");
  return applied;
}

test("factory snapshots preserve quoted, escaped, numeric IDs and exact body boundaries", () => {
  const body = 'const token="},Fake(e){false}";const nested={method(){return /[{}]/.test("{")}};const template=`${{value:1}.value}`;/* } */return nested;';
  const source = `export const __webpack_modules__={Plain(e,t,n){${body}},"a/b+"(e){},123(){return 3},"\\u0045scaped" ( e ) {return 4}};`;
  const modules = [...rspackModuleFactories(source, "async/123.hash.js")];
  assert.deepEqual(modules.map(module => module.moduleId), ["Plain", "a/b+", "123", "Escaped"]);
  assert.deepEqual(modules.map(module => module.params), [["e", "t", "n"], ["e"], [], ["e"]]);
  assert.equal(modules[0].moduleSource, body);
  assert.equal(modules[1].moduleSource, "");
  for (const module of modules) {
    assert.equal(source.slice(module.start, module.end), module.moduleSource);
    assert.equal(source[module.start - 1], "{");
    assert.equal(source[module.end], "}");
    assert.equal(module.source, source);
    assert.equal(module.assetName, "async/123.hash.js");
  }
  assert.deepEqual([...rspackModuleFactories("export const ordinary=1;", "unrelated.js")], []);
});

test("unsupported, duplicate, and incomplete factory registries fail closed", () => {
  for (const source of [
    'export const __webpack_modules__={A(e){},"A"(e){}};',
    'export const __webpack_modules__={A:(e)=>{}};',
    'export const __webpack_modules__={A(e){return {a:1}}',
    'export const __webpack_modules__={A(e){unterminated',
    'export const __webpack_modules__={};export const __webpack_modules__={};',
  ]) assert.throws(() => [...rspackModuleFactories(source, "async/invalid.js")], /Rspack module/);
});

test("semantic discovery groups all same-ID copies including a copy missing its semantic marker", t => {
  const damaged = "const changedContract=2;";
  const assets = workspace(t, {
    "async/1.hash.js": chunk(pristine),
    "nested/1.hash.js": chunk(damaged),
    "other.js": chunk("const unrelated=true;", "Other"),
  });
  const found = copies(assets);
  assert.equal(found.length, 2);
  assert.deepEqual(found.map(copy => copy.assetName), ["async/1.hash.js", "nested/1.hash.js"]);
  assert.equal(found[1].moduleSource, damaged);
  assert.throws(() => patchRspackModuleCopies(assets, found, patch), /Invalid semantic-owner/);
  assert.equal(fs.readFileSync(path.join(assets, "async/1.hash.js"), "utf8"), chunk(pristine));
  assert.equal(fs.readFileSync(path.join(assets, "nested/1.hash.js"), "utf8"), chunk(damaged));
});

test("semantic discovery rejects zero owners, different module identities, and duplicate physical factories", t => {
  const empty = workspace(t, { "unrelated.js": chunk("return false", "Other") });
  assert.throws(() => copies(empty), /Could not find/);
  const ambiguous = workspace(t, { "one.js": chunk(pristine), "two.js": chunk(pristine, "Other") });
  assert.throws(() => copies(ambiguous), /multiple.*identities/);
  const duplicate = workspace(t, { "one.js": `export const __webpack_modules__={Ab12(e){${pristine}},Ab12(e){${pristine}}};` });
  assert.throws(() => copies(duplicate), /Duplicate Rspack/);
});

test("discovery includes escaped and whitespace-separated same-ID factory keys", t => {
  const assets = workspace(t, {
    "one.js": chunk(pristine, '"Escaped"'),
    "two.js": 'export const __webpack_modules__={"\\u0045scaped" ( e ) {const damaged=true;}};',
  });
  const found = copies(assets);
  assert.equal(found.length, 2);
  assert.ok(found.every(copy => copy.moduleId === "Escaped"));
});

test("all copies patch atomically, preserve unrelated modules, and become idempotent", t => {
  const source = chunk(pristine).replace("}};", '},Other(e){e.exports="unchanged"}};');
  const assets = workspace(t, { "async/one.js": source, "async/two.js": source });
  const first = patchRspackModuleCopies(assets, copies(assets), patch);
  assert.equal(first.changed, 2);
  assert.equal(first.matched, 2);
  for (const name of first.assetNames) {
    assert.equal(fs.readFileSync(path.join(assets, name), "utf8"), source.replace(pristine, applied));
  }
  assert.equal(patchRspackModuleCopies(assets, copies(assets), patch).changed, 0);
});

test("mixed replicas and stale snapshots are rejected without modifying any asset", t => {
  const assets = workspace(t, { "one.js": chunk(pristine), "two.js": chunk(applied) });
  assert.throws(() => patchRspackModuleCopies(assets, copies(assets), patch), /Partially applied/);
  assert.equal(fs.readFileSync(path.join(assets, "one.js"), "utf8"), chunk(pristine));
  assert.equal(fs.readFileSync(path.join(assets, "two.js"), "utf8"), chunk(applied));
  fs.writeFileSync(path.join(assets, "two.js"), chunk(pristine));
  const observed = copies(assets);
  fs.writeFileSync(path.join(assets, "two.js"), chunk("const concurrent=true;"));
  assert.throws(() => patchRspackModuleCopies(assets, observed, patch), /changed before patch/);
  assert.equal(fs.readFileSync(path.join(assets, "one.js"), "utf8"), chunk(pristine));
});

test("syntax failures and incomplete transformations keep all original bytes", t => {
  t.mock.method(console, "warn", () => {});
  const assets = workspace(t, { "one.js": chunk(pristine), "two.js": chunk(pristine) });
  const badSyntax = patchRspackModuleCopies(assets, copies(assets), source => source.includes("state=(")
    ? source : source.replace("state=0", "state=("));
  assert.equal(badSyntax.changed, 0);
  assert.throws(() => patchRspackModuleCopies(assets, copies(assets), source => `${source}const extra=true;`), /not idempotent/);
  for (const name of ["one.js", "two.js"]) assert.equal(fs.readFileSync(path.join(assets, name), "utf8"), chunk(pristine));
});

test("an interrupted second replica write restores the first and second original bytes", t => {
  const assets = workspace(t, { "one.js": chunk(pristine), "two.js": chunk(pristine) });
  let writes = 0;
  assert.throws(() => patchRspackModuleCopies(assets, copies(assets), patch, {
    writeFileSync(file, bytes) {
      fs.writeFileSync(file, bytes);
      writes += 1;
      if (writes === 2) throw new Error("interrupted second write");
    },
  }), /interrupted second write/);
  for (const name of ["one.js", "two.js"]) assert.equal(fs.readFileSync(path.join(assets, name), "utf8"), chunk(pristine));
});

test("static import bindings use the owning factory require and preserve module identities", () => {
  const source = 'export const __webpack_modules__={First(module,exports,$require){$require.d(exports,{Row:()=>row});var $jsx=$require("\\u0041Bep"),menu = $require ( "menu/entry" );let numeric=$require(123);const other=$require("other");function row(){let $jsx="shadow";return $jsx}},Other(e,t,n){var $jsx=n("wrong-factory");}};';
  const [owner, other] = [...rspackModuleFactories(source, "async/current.js")];
  for (const [localName, expected] of [["$jsx", "ABep"], ["menu", "menu/entry"], ["numeric", "123"], ["other", "other"]]) {
    const binding = findRspackRequireBinding(owner, localName);
    assert.equal(binding.moduleId, expected);
    assert.equal(binding.requireName, "$require");
    assert.ok(source.slice(binding.start, binding.end).startsWith(localName));
  }
  assert.equal(findRspackRequireBinding(other, "$jsx").moduleId, "wrong-factory");
  assert.equal(findRspackRequireBinding(owner, "missing"), null);
});

test("static imports reject missing, wrong-loader, duplicate and nested decoy bindings", () => {
  const sources = [
    'function nested(){var target=n("nested");}',
    'function nested(){;var target=n("nested");}',
    'const text=";var target=n(\\"string\\");";',
    '/*;var target=n("comment");*/',
    '//;var target=n("comment");\n',
    'var target=other("wrong-loader");',
    'var target=n("one");var target=n("two");',
    'var target=n("one"),target=n("one");',
    'var target=n("one");var target=other;',
    'var target=n("one"),n=other;',
    'var values=[0,target=n("assignment-not-declaration")];',
  ];
  for (const body of sources) {
    const source = chunk(body);
    const [owner] = [...rspackModuleFactories(source, "decoy.js")];
    assert.equal(findRspackRequireBinding(owner, "target"), null, body);
  }
  const [noRequire] = [...rspackModuleFactories('export const __webpack_modules__={A(e,t){var target=n("foreign");}};', "no-loader.js")];
  assert.equal(findRspackRequireBinding(noRequire, "target"), null);
  assert.throws(() => findRspackRequireBinding(noRequire, "bad.name"), TypeError);
});

test("real factory parameter names produce executable sibling-local imports", () => {
  const vm = require("node:vm");
  const source = 'export const __webpack_modules__={Menu(module,exports,load){var jsx=load("react"),native=load("menu");function unrelated(jsx,native){return null}load.d(exports,{render:()=>render});function render(){return native.Row}},Reply(m,out,request){var jsx=request("react"),markdown=request("markdown");request.d(out,{render:()=>render});function render(){return markdown.ChatGptMarkdown}}};';
  const providers = { react: { jsx: (component, props) => ({ component, props }) }, menu: { Row: "native-row" }, markdown: { ChatGptMarkdown: "native-markdown" } };
  for (const owner of rspackModuleFactories(source, "runtime.js")) {
    const dependency = owner.moduleId === "Menu" ? "native" : "markdown";
    const field = owner.moduleId === "Menu" ? "Row" : "ChatGptMarkdown";
    const binding = findRspackRequireBinding(owner, dependency);
    assert.ok(Object.hasOwn(providers, binding.moduleId));
    const exports = {};
    const load = id => providers[id];
    load.d = (target, getters) => { for (const [name, get] of Object.entries(getters)) Object.defineProperty(target, name, { get }); };
    const factory = vm.runInNewContext(`(function(${owner.params.join(",")}){${owner.moduleSource};${owner.params[1]}.injected=()=>jsx.jsx(${dependency}.${field},{text:"kept"})})`);
    factory({}, exports, load);
    const rendered = exports.injected();
    assert.equal(rendered.component, exports.render());
    assert.equal(rendered.props.text, "kept");
  }
});


test("imports after native SVG, nested calls, templates and regex initializers stay factory-bound", () => {
  const body = 'var jsx=n("react"),icon=e=>jsx.jsx("svg",{children:jsx.jsx("path",{d:"M1,2;3",fill:"red"})}),late=n("bus"),pattern=/[,;`"}]/g,afterRegex=n("after-regex"),template=`text,${{value:";"}.value}`,afterTemplate=n("after-template"),array=[1,2,3],afterArray=n("after-array");';
  const source = chunk(body);
  const [owner] = [...rspackModuleFactories(source, "mixed-imports.js")];
  for (const [local, expected] of [["late", "bus"], ["afterRegex", "after-regex"], ["afterTemplate", "after-template"], ["afterArray", "after-array"]]) {
    assert.equal(findRspackRequireBinding(owner, local)?.moduleId, expected, local);
  }
  for (const local of ["icon", "pattern", "template", "array"]) assert.equal(findRspackRequireBinding(owner, local), null);
});


test("declarations after native function bodies resolve once per immutable snapshot", () => {
  const source = chunk('function x(){}var one=n("one"),mixed=()=>({value:[1,2]}),store=n("store");function later(){;var store=n("nested")}var tail=n("tail");');
  const [owner] = [...rspackModuleFactories(source, "after-function.js")];
  assert.equal(findRspackRequireBinding(owner, "store")?.moduleId, "store");
  assert.equal(findRspackRequireBinding(owner, "tail")?.moduleId, "tail");
  owner.params[2] = "differentLoader";
  assert.equal(findRspackRequireBinding(owner, "store"), null, "changed loader cannot reuse an old binding inventory");
  owner.params[2] = "n";
  owner.moduleSource = 'var store=n("new-store");';
  assert.equal(findRspackRequireBinding(owner, "store")?.moduleId, "new-store");
});
