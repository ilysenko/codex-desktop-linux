"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { findUniqueRspackModuleCopies, patchRspackModuleCopies, rspackModuleFactories } = require("./rspack-module-assets.js");

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
