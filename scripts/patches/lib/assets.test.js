"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { findMainProcessChunks, listWebviewAssets, listWebviewAssetFiles, patchAssetFiles, patchUniqueAssetFile, patchWebviewAssets } = require("./assets.js");
const { commitAssetEdits } = require("./asset-edits.js");
const { webviewAssetPatch } = require("../descriptor.js");
const { applyWebviewAssetPatchDescriptors } = require("../engine.js");
const { createPatchReport } = require("../../lib/patch-report.js");
const { javascriptSourceParses } = require("./javascript-syntax.js");

function withAssets(files, callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-assets-test-"));
  const assets = path.join(root, "webview", "assets");
  fs.mkdirSync(assets, { recursive: true });
  for (const [name, source] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(assets, name)), { recursive: true });
    fs.writeFileSync(path.join(assets, name), source);
  }
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    return callback({
      root,
      assets,
      read: (name) => fs.readFileSync(path.join(assets, name), "utf8"),
      warnings,
    });
  } finally {
    console.warn = originalWarn;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const MODULE = "function Pan(){return 1}export{Pan};";
const BREAK = (source) => source.replace("return 1}", "return 1}return 2}");

test("javascriptSourceParses accepts modules and classic scripts only", () => {
  assert.equal(javascriptSourceParses(MODULE), true);
  assert.equal(javascriptSourceParses("with(self){postMessage(1)}"), true);
  assert.equal(javascriptSourceParses(BREAK(MODULE)), false);
  assert.equal(javascriptSourceParses("return 1"), false);
});

test("patchUniqueAssetFile keeps a classic script whose patch moves code to the top level", () => {
  const script = "function f(){return 1}var y=2;";
  withAssets({ "worker.js": script }, ({ root, read, warnings }) => {
    const patch = (source) => source.replace("{return 1}", "{}return 1;");
    const result = patchUniqueAssetFile(root, /\.js$/, () => true, patch, "missing", "ambiguous");
    assert.equal(result.changed, 0);
    assert.equal(read("worker.js"), script);
    assert.equal(warnings.length, 1);
  });
});

test("patchUniqueAssetFile keeps an asset whose patch breaks its syntax", () => {
  withAssets({ "app-a.js": MODULE }, ({ root, read, warnings }) => {
    const result = patchUniqueAssetFile(root, /\.js$/, () => true, BREAK, "missing", "ambiguous");
    assert.deepEqual(result, { matched: 1, changed: 0, assetName: "app-a.js", changedAssets: [] });
    assert.equal(read("app-a.js"), MODULE);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /app-a\.js no longer parses as JavaScript/u);
  });
});

test("patchAssetFiles writes nothing when any patched asset breaks syntax", () => {
  withAssets({ "a.js": MODULE, "b.js": MODULE.replaceAll("Pan", "Bar") }, ({ root, read }) => {
    const patch = (source) => (source.includes("Bar") ? BREAK(source) : `${source}//ok`);
    assert.deepEqual(patchAssetFiles(root, /\.js$/, patch, "missing"), { matched: 2, changed: 0, changedAssets: [] });
    assert.equal(read("a.js"), MODULE);
  });
});

test("asset patches still apply valid edits, non-JS assets, and unparseable originals", () => {
  withAssets({ "a.js": MODULE, "a.css": ".a{}", "fixture.js": "not js {" }, ({ root, read, warnings }) => {
    assert.equal(patchAssetFiles(root, /^a\.js$/, (s) => s.replace("1", "2"), "missing").changed, 1);
    assert.equal(read("a.js"), MODULE.replace("1", "2"));
    assert.equal(patchAssetFiles(root, /\.css$/, (s) => `${s}}`, "missing").changed, 1);
    assert.equal(patchAssetFiles(root, /^fixture\.js$/, (s) => `${s}}`, "missing").changed, 1);
    assert.deepEqual(warnings, []);
  });
});

const CODEX_REQUEST_MODULE =
  'M8aW(e,t,n){n.d(t,{vF:()=>"vscode",Xb:()=>s,IF:()=>a});var r=n("DBCl"),i=n("GDNt");' +
  'function a(e,t){return["vscode",e,t]}' +
  "async function s(...e){let[t,n]=e,{params:r,select:i,signal:a,source:l,responsePriority:u}=n??{};return o(t,r,i,a,l,u)}" +
  "async function o(e,t,n,a,s,o){let l=(await i._n.getInstance().post(`vscode://codex/${e}`,JSON.stringify(t),a,o)).body;return n?n(l):l}}";
const rspackChunk = (id, ...modules) =>
  `/*! LICENSE: ${id}.js.LICENSE.txt */\nexport const __rspack_esm_id=${id};export const __rspack_esm_ids=[${id}];` +
  `export const __webpack_modules__={${modules.join(",")}};`;

test("findCodexRequestWebviewAsset resolves the rspack request module, export and chunk", () => {
  const { findCodexRequestWebviewAsset } = require("./assets.js");
  withAssets({ "158624.entry.js": rspackChunk(158624, "Ab12(e,t,n){t.x=1}") }, ({ root }) => {
    const assets = path.join(root, "webview", "assets");
    fs.mkdirSync(path.join(assets, "async"));
    fs.writeFileSync(
      path.join(assets, "async", "24191.7b05d5cf83.js"),
      rspackChunk(24191, "odKs(e,t,n){t.A=1}", CODEX_REQUEST_MODULE),
    );
    // A chunk that only mentions the URL without the wrapper contract is ignored.
    fs.writeFileSync(
      path.join(assets, "async", "1.a.js"),
      rspackChunk(1, "Zz00(e,t,n){let a=`vscode://codex/${e}`;t.A=a}"),
    );
    assert.deepEqual(findCodexRequestWebviewAsset(assets), {
      assetName: "async/24191.7b05d5cf83.js",
      chunkId: 24191,
      moduleId: "M8aW",
      exportName: "Xb",
    });

    fs.writeFileSync(
      path.join(assets, "async", "2.b.js"),
      rspackChunk(2, CODEX_REQUEST_MODULE.replace("M8aW", "Q9zz")),
    );
    assert.throws(() => findCodexRequestWebviewAsset(assets), /multiple Codex request API assets/);
    fs.writeFileSync(
      path.join(assets, "async", "2.b.js"),
      rspackChunk(2, CODEX_REQUEST_MODULE.replace("M8aW", "Q9zz").replace("Xb:()=>s,", "")),
    );
    assert.equal(findCodexRequestWebviewAsset(assets).moduleId, "M8aW");
  });
});

const RSPACK_OWNER = 'export const __rspack_esm_id=1;export const __webpack_modules__={owner(e,t,n){let p={available:!1,label:"Linux",nested(){return{value:"}"}}};n.d(t,{},{default:p})}};';

test("extractedDir inventory and explicit assetsDir inventory recurse without flattening names", () => {
  withAssets({
    "z.js": MODULE,
    "async/100163.hash.js": RSPACK_OWNER,
    "async/nested/100163.hash.js": RSPACK_OWNER,
    "workers/worker.js": "self.onmessage=()=>{};",
    "async/z.css": ".z{}",
    "a.js": MODULE,
  }, ({ root, assets }) => {
    assert.deepEqual(listWebviewAssets(root), [
      "a.js", "async/100163.hash.js", "async/nested/100163.hash.js",
      "async/z.css", "workers/worker.js", "z.js",
    ]);
    assert.deepEqual(listWebviewAssetFiles(assets, /^100163\..*\.js$/g), [
      "async/100163.hash.js", "async/nested/100163.hash.js",
    ]);
    assert.deepEqual(listWebviewAssetFiles(path.join(assets, "missing")), []);
    assert.equal(patchWebviewAssets, commitAssetEdits);
  });
});

test("normal unique-owner patch distinguishes missing and ambiguous nested owners", () => {
  withAssets({ "async/one.js": RSPACK_OWNER, "async/two.js": MODULE }, ({ root, read, warnings }) => {
    const missing = patchUniqueAssetFile(root, /\.js$/, () => false, source => source + "//changed", "missing", "ambiguous");
    assert.deepEqual(missing, { matched: 0, changed: 0, assetName: null, changedAssets: [] });
    assert.deepEqual(warnings, ["missing"]);
    const ambiguous = patchUniqueAssetFile(root, /\.js$/, () => true, source => source + "//changed", "missing", "ambiguous");
    assert.deepEqual(ambiguous, { matched: 2, changed: 0, assetName: null, changedAssets: [] });
    assert.equal(read("async/one.js"), RSPACK_OWNER);
    assert.equal(read("async/two.js"), MODULE);
  });
});

test("recursive Rspack owner edits execute and publish only committed changedAssets", () => {
  withAssets({ "async/one.js": RSPACK_OWNER }, ({ root, read }) => {
    const apply = () => patchUniqueAssetFile(root, /\.js$/, source => source.includes('label:"Linux"'),
      source => source.replace("available:!1", "available:!0"), "missing", "ambiguous");
    assert.deepEqual(apply(), { matched: 1, changed: 1, assetName: "async/one.js", changedAssets: ["async/one.js"] });
    const source = read("async/one.js");
    const exports = {};
    const requireModule = Object.assign(() => {}, { d(target, _getters, values) { Object.assign(target, values); } });
    new Function(source.replaceAll("export const ", "const ") + ";return __webpack_modules__.owner;")()({}, exports, requireModule);
    assert.equal(exports.default.available, true);
    assert.equal(exports.default.nested().value, "}");
    assert.deepEqual(apply(), { matched: 1, changed: 0, assetName: "async/one.js", changedAssets: [] });
    assert.equal(read("async/one.js"), source);
  });
});

test("provided candidates allow null patterns and explicit empty candidates stay empty", () => {
  withAssets({ "entry.js": MODULE, "async/other.js": MODULE }, ({ root, read }) => {
    assert.deepEqual(patchAssetFiles(root, null, source => source.replace("return 1", "return 2"), "missing", ["entry.js"]), {
      matched: 1, changed: 1, changedAssets: ["entry.js"],
    });
    let called = false;
    assert.deepEqual(patchAssetFiles(root, null, () => { called = true; return ""; }, "missing", []), {
      matched: 0, changed: 0, changedAssets: [],
    });
    assert.equal(called, false);
    assert.deepEqual(patchUniqueAssetFile(root, null, () => true, source => source.replace("return 1", "return 3"),
      "missing", "ambiguous", ["async/other.js"]), {
      matched: 1, changed: 1, assetName: "async/other.js", changedAssets: ["async/other.js"],
    });
    assert.equal(read("entry.js"), MODULE.replace("return 1", "return 2"));
  });
});

test("needle index refresh observes added and removed needles after transactional commits", () => {
  withAssets({ "async/entry.js": 'const value="alpha";' }, ({ root, read }) => {
    let staleCalled = false;
    const descriptors = [
      webviewAssetPatch({ id: "alpha-to-beta", assetNeedles: ["alpha"], apply: source => source.replace("alpha", "beta") }),
      webviewAssetPatch({ id: "removed-alpha", assetNeedles: ["alpha"], apply: source => { staleCalled = true; return source; } }),
      webviewAssetPatch({ id: "beta-to-done", assetNeedles: ["beta"], apply: source => source.replace("beta", "done") }),
    ];
    const report = createPatchReport();
    applyWebviewAssetPatchDescriptors(root, descriptors, {}, report);
    assert.deepEqual(report.patches.map(patch => patch.status), ["applied", "skipped-optional", "applied"]);
    assert.equal(staleCalled, false);
    assert.equal(read("async/entry.js"), 'const value="done";');
  });
});

test("renderer recursion ignores symlinks and keeps main and worker lookup separate", () => {
  withAssets({ "async/one.js": RSPACK_OWNER }, ({ root, assets }) => {
    const buildDir = path.join(root, ".vite/build");
    fs.mkdirSync(buildDir, { recursive: true });
    for (const name of ["early-bootstrap.js", "early-bootstrap-4-a1b2.js", "git-worker.js"])
      fs.writeFileSync(path.join(buildDir, name), MODULE);
    fs.symlinkSync(buildDir, path.join(assets, "outside"), "dir");
    assert.deepEqual(listWebviewAssets(root), ["async/one.js"]);
    assert.deepEqual(findMainProcessChunks(root), {
      buildDir, chunks: ["early-bootstrap-4-a1b2.js", "early-bootstrap.js"],
    });
    assert.equal(fs.readFileSync(path.join(buildDir, "git-worker.js"), "utf8"), MODULE);
  });
});
