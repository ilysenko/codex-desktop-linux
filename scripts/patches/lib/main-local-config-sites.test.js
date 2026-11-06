"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const test = require("node:test");
const { inspectMainLocalConfigSite: inspect } = require("./main-local-config-sites.js");
const { findMainProcessChunks } = require("./assets.js");
const { inspectMainRequestSites } = require("./main-request-sites.js");
const { commitAssetEdits } = require("./asset-edits.js");
const { localConfigFixture: fixture, callbackSource } = require("./fixtures/main-local-config-graph.js");
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const ARRAY_MARKER = "/*example-config-array*/";
const PREFIX_MARKER = "/*example-config-prefix*/";
function changed(source, from, to, start = 0, end = source.length) {
  const before = source.slice(start, end), after = before.replace(from, to);
  assert.notEqual(after, before, `expected current native anchor ${from}`);
  return source.slice(0, start) + after + source.slice(end);
}
function site(source) { const found = inspect(source); assert.equal(found.ok, true, found.reason); return found; }
function callback(source, found = site(source)) { return source.slice(found.overrides.start, found.overrides.end); }
function suffix(source) {
  const found = site(source), contribution = `,${ARRAY_MARKER}"example.flag=true"`;
  if (source.includes(ARRAY_MARKER)) {
    assert.equal(source.slice(found.overrides.nativePrefixEnd, found.overrides.arrayEnd - 1), contribution);
    return source;
  }
  return source.slice(0, found.overrides.arrayEnd - 1) + contribution + source.slice(found.overrides.arrayEnd - 1);
}
function prefix(source) {
  const found = site(source), contribution = `${PREFIX_MARKER}if(exampleUse)return new ExampleTransport(${found.optionsVar});`;
  if (source.includes(PREFIX_MARKER)) {
    assert.equal(source.slice(found.scope.selectorBodyStart, found.scope.selectorBodyStart + contribution.length), contribution);
    return source;
  }
  return source.slice(0, found.scope.selectorBodyStart) + contribution + source.slice(found.scope.selectorBodyStart);
}
function conserve(source) {
  const before = site(source), native = source.slice(before.overrides.arrayStart + 1, before.overrides.nativePrefixEnd);
  for (const order of [[suffix, prefix], [prefix, suffix]]) {
    let current = source;
    for (const apply of order) current = apply(current);
    const found = site(current);
    assert.equal(current.slice(found.overrides.arrayStart + 1, found.overrides.nativePrefixEnd), native);
    assert.equal(suffix(current), current);
    assert.equal(prefix(current), current);
    const recovered = current.replace(`,${ARRAY_MARKER}"example.flag=true"`, "")
      .replace(`${PREFIX_MARKER}if(exampleUse)return new ExampleTransport(${found.optionsVar});`, "");
    assert.equal(recovered, source);
    assert.equal(hash(recovered), hash(source));
  }
}
// This example Adapter owns unique physical ownership, marker state, complete
// cohort validation and the transaction. The locator only supplies source facts.
function exampleEdits(rows) {
  const snapshots = rows.map(row => ({ ...row, site: inspect(row.source) }));
  const owners = snapshots.filter(row => row.site.ok);
  assert.equal(owners.length, 1, "example Adapter requires one physical owner");
  const owner = owners[0], id = owner.site.scope.factoryId;
  const cohort = snapshots.filter(row => row.site.factoryIds.includes(id));
  assert.equal(cohort.length, 1, "example Adapter refuses duplicate or lost-needle same-ID copies");
  assert.equal(snapshots.some(row => row !== owner && row.source.includes(ARRAY_MARKER)), false, "orphan example marker");
  return [{ assetName: owner.name, source: owner.source, patchedSource: suffix(owner.source) }];
}
function failures(source) {
  const found = site(source), selector = found.scope, value = found.optionsVar;
  const local = source.slice(found.localReturn.start, found.localReturn.end), cb = callback(source, found);
  const selectorName = /^function ([\w$]+)\(/u.exec(source.slice(selector.selectorStart))[1];
  const encoded = selectorName.slice(0, -1) + "\\u" + selectorName.charCodeAt(selectorName.length - 1).toString(16).padStart(4, "0");
  const graph = inspectMainRequestSites(source), ctor = source.indexOf("constructor(e){", graph.scope.hostStart);
  assert(ctor > graph.scope.hostStart && ctor < graph.scope.hostEnd);
  const ctorBody = ctor + "constructor(e){".length;
  return [
    ["earlier selector return", source.slice(0, selector.selectorBodyStart) + "return null;" + source.slice(selector.selectorBodyStart)],
    ["earlier caller return", changed(source, "createAppServerConnection(e,t=sp.a,r=!1,n,i){", "createAppServerConnection(e,t=sp.a,r=!1,n,i){return null;")],
    ["unused nested local constructor", changed(source, local, `const unused=()=>{${local}};return null;`, selector.selectorBodyStart, selector.selectorBodyEnd)],
    ["conditional final local constructor", changed(source, local, `if(false)${local}`, selector.selectorBodyStart, selector.selectorBodyEnd)],
    ["callback outside returned options", changed(source, cb, "otherCallback", found.overrides.start, found.overrides.end)],
    ["block callback return", changed(source, cb, `async()=>{return ${cb.slice("async()=>".length)}}`, found.overrides.start, found.overrides.end)],
    ["sync callback kind", changed(source, cb, cb.replace("async()=>", "()=>").replace("...await e.secretAuthStorageConfigOverrides", "...e.secretAuthStorageConfigOverrides").replace("...await async function", "...async function"), found.overrides.start, found.overrides.end)],
    ["callback continuation", changed(source, cb, cb + "||other", found.overrides.start, found.overrides.end)],
    ["wrong global options role", changed(source, `${value}.globalState,${value}.hostConfig`, `${value}.otherState,${value}.hostConfig`, found.overrides.start, found.overrides.end)],
    ["wrong secret input", changed(source, `${value}.secretAuthStorageConfigOverrides`, `${value}.otherOverrides`, found.overrides.start, found.overrides.end)],
    ["lost secret await", changed(source, `...await ${value}.secretAuthStorageConfigOverrides`, `...${value}.secretAuthStorageConfigOverrides`, found.overrides.start, found.overrides.end)],
    ["reordered native terms", changed(source, `...(0,KS.s1)(${value}.globalState,${value}.hostConfig),...await ${value}.secretAuthStorageConfigOverrides`, `...await ${value}.secretAuthStorageConfigOverrides,...(0,KS.s1)(${value}.globalState,${value}.hostConfig)`, found.overrides.start, found.overrides.end)],
    ["lost IIFE await", changed(source, "...await async function(e)", "...async function(e)", found.overrides.start, found.overrides.end)],
    ["wrong IIFE generator", changed(source, "...await async function(e)", "...await async function*(e)", found.overrides.start, found.overrides.end)],
    ["retired named IIFE", changed(source, "...await async function(e)", "...await async function unused(e)", found.overrides.start, found.overrides.end)],
    ["wrong IIFE options argument", changed(source, "}(e)", "}(otherOptions)", found.overrides.start, found.overrides.end)],
    ["uninvoked IIFE", changed(source, "}(e)", "}", found.overrides.start, found.overrides.end)],
    ["selector plain overwrite", source.slice(0, selector.selectorEnd) + `;${selectorName}=other;` + source.slice(selector.selectorEnd)],
    ["selector encoded overwrite", source.slice(0, selector.selectorEnd) + `;${encoded}=other;` + source.slice(selector.selectorEnd)],
    ["unused selector expression", source.slice(0, selector.selectorStart) + "const unused=" + source.slice(selector.selectorStart, selector.selectorEnd) + ";" + source.slice(selector.selectorEnd)],
    ["selector async kind", changed(source, `function ${selectorName}(`, `async function ${selectorName}(`, selector.selectorStart, selector.selectorEnd)],
    ["selector options overwrite", source.slice(0, selector.selectorBodyStart) + `${value}=otherOptions;` + source.slice(selector.selectorBodyStart)],
    ["encoded selector options overwrite", source.slice(0, selector.selectorBodyStart) + `\\u0065=otherOptions;` + source.slice(selector.selectorBodyStart)],
    ["destructured selector options", source.slice(0, selector.selectorBodyStart) + `({${value}}=otherOptions);` + source.slice(selector.selectorBodyStart)],
    ["options ordinary-block overwrite", source.slice(0, selector.selectorBodyStart) + `{${value}=otherOptions;}` + source.slice(selector.selectorBodyStart)],
    ["options conditional-block overwrite", source.slice(0, selector.selectorBodyStart) + `if(true){${value}=otherOptions;}` + source.slice(selector.selectorBodyStart)],
    ["options object-pattern block overwrite", source.slice(0, selector.selectorBodyStart) + `{({${value}}=otherOptions);}` + source.slice(selector.selectorBodyStart)],
    ["options array-pattern block overwrite", source.slice(0, selector.selectorBodyStart) + `{[${value}]=otherOptions;}` + source.slice(selector.selectorBodyStart)],
    ["options nested-pattern block overwrite", source.slice(0, selector.selectorBodyStart) + `if(true){({outer:[{value:${value}}]}=otherOptions);}` + source.slice(selector.selectorBodyStart)],
    ["options encoded-pattern block overwrite", source.slice(0, selector.selectorBodyStart) + String.raw`{({value:\u0065}=otherOptions);}` + source.slice(selector.selectorBodyStart)],
    ["options hoisted var overwrite", source.slice(0, selector.selectorBodyStart) + `if(true){var ${value}=otherOptions;}` + source.slice(selector.selectorBodyStart)],
    ["options hoisted var pattern overwrite", source.slice(0, selector.selectorBodyStart) + `if(true){var {${value}}=otherOptions;}` + source.slice(selector.selectorBodyStart)],
    ["options encoded block overwrite", source.slice(0, selector.selectorBodyStart) + String.raw`{\u0065=otherOptions;}` + source.slice(selector.selectorBodyStart)],
    ["function default free options write", source.slice(0, selector.selectorBodyStart) + `function unused(x=(${value}=otherOptions)){var ${value};}` + source.slice(selector.selectorBodyStart)],
    ["function default body-lexical free options write", source.slice(0, selector.selectorBodyStart) + `function unused(x=(${value}=otherOptions)){let ${value};}` + source.slice(selector.selectorBodyStart)],
    ["arrow default free options write", source.slice(0, selector.selectorBodyStart) + `const unused=(x=(${value}=otherOptions))=>{var ${value};};` + source.slice(selector.selectorBodyStart)],
    ["function default free options pattern", source.slice(0, selector.selectorBodyStart) + `function unused(x=({${value}}=otherOptions)){var ${value};}` + source.slice(selector.selectorBodyStart)],
    ["caller method async kind", changed(source, "createAppServerConnection(e,t=sp.a", "async createAppServerConnection(e,t=sp.a", selector.callerStart, selector.callerEnd)],
    ["caller method instance overwrite", source.slice(0, ctorBody) + "this.createAppServerConnection=other;" + source.slice(ctorBody)],
    ["caller method encoded overwrite", source.slice(0, ctorBody) + String.raw`this.\u0063reateAppServerConnection=other;` + source.slice(ctorBody)],
    ["caller method computed literal overwrite", source.slice(0, ctorBody) + 'this["createAppServerConnection"]=other;' + source.slice(ctorBody)],
    ["caller method computed template overwrite", source.slice(0, ctorBody) + 'this[`createAppServerConnection`]=other;' + source.slice(ctorBody)],
    ["caller method unknown computed overwrite", source.slice(0, ctorBody) + 'this[key]=other;' + source.slice(ctorBody)],
    ["caller method prefix overwrite", source.slice(0, ctorBody) + '++this.createAppServerConnection;' + source.slice(ctorBody)],
    ["caller method deleted", source.slice(0, ctorBody) + 'delete this.createAppServerConnection;' + source.slice(ctorBody)],
    ["caller local selector shadow", changed(source, "createAppServerConnection(e,t=sp.a,r=!1,n,i){", "createAppServerConnection(e,t=sp.a,r=!1,n,i){let evZ=other;")],
    ["remote transport branch shadow", changed(source, 'a=evZ({transportKind:"remote-control"', 'let a=evZ({transportKind:"remote-control"', selector.callerStart, selector.callerEnd)],
    ["wrong caller app-global state", changed(source, "globalState:this.appState", "globalState:this.scopedState", selector.callerStart, selector.callerEnd)],
    ["wrong caller secret source", changed(source, "secretAuthStorageConfigOverrides:this.secretAuthStorageConfigOverrides", "secretAuthStorageConfigOverrides:this.otherSecret", selector.callerStart, selector.callerEnd)],
    ["wrong client transport link", changed(source, "transport:a", "transport:other", selector.callerStart, selector.callerEnd)],
    ["selected transport overwritten", changed(source, ";let c=this.options.hostProcess.getVersion()", ";a=other;let c=this.options.hostProcess.getVersion()", selector.callerStart, selector.callerEnd)],
    ["selected transport ordinary-block overwrite", changed(source, ";let c=this.options.hostProcess.getVersion()", ";{a=otherTransport;}let c=this.options.hostProcess.getVersion()", selector.callerStart, selector.callerEnd)],
    ["selected transport object-pattern block overwrite", changed(source, ";let c=this.options.hostProcess.getVersion()", ";{({a}=otherTransport);}let c=this.options.hostProcess.getVersion()", selector.callerStart, selector.callerEnd)],
    ["selected transport nested-array-pattern block overwrite", changed(source, ";let c=this.options.hostProcess.getVersion()", ";if(true){[{value:a}]=otherTransport;}let c=this.options.hostProcess.getVersion()", selector.callerStart, selector.callerEnd)],
    ["selected transport encoded conditional-block overwrite", changed(source, ";let c=this.options.hostProcess.getVersion()", String.raw`;if(true){\u0061=otherTransport;}let c=this.options.hostProcess.getVersion()`, selector.callerStart, selector.callerEnd)],
    ["returned client overwritten", changed(source, "return u.registerInternalServerRequestHandler", "u=other;return u.registerInternalServerRequestHandler", selector.callerStart, selector.callerEnd)],
    ["returned client ordinary-block overwrite", changed(source, "return u.registerInternalServerRequestHandler", "{u=otherClient;}return u.registerInternalServerRequestHandler", selector.callerStart, selector.callerEnd)],
    ["returned client object-pattern block overwrite", changed(source, "return u.registerInternalServerRequestHandler", "{({u}=otherClient);}return u.registerInternalServerRequestHandler", selector.callerStart, selector.callerEnd)],
    ["returned client nested-array-pattern block overwrite", changed(source, "return u.registerInternalServerRequestHandler", "if(true){[{value:u}]=otherClient;}return u.registerInternalServerRequestHandler", selector.callerStart, selector.callerEnd)],
    ["returned client encoded conditional-block overwrite", changed(source, "return u.registerInternalServerRequestHandler", String.raw`if(true){\u0075=otherClient;}return u.registerInternalServerRequestHandler`, selector.callerStart, selector.callerEnd)],
    ["encoded transport overwrite", changed(source, ";let c=this.options.hostProcess.getVersion()", String.raw`;\u0061=other;let c=this.options.hostProcess.getVersion()`, selector.callerStart, selector.callerEnd)],
    ["encoded returned client overwrite", changed(source, "return u.registerInternalServerRequestHandler", String.raw`\u0075=other;return u.registerInternalServerRequestHandler`, selector.callerStart, selector.callerEnd)],
  ];
}

test("pure Interface exposes one caller-linked native callback and half-open ranges", () => {
  const source = fixture(), found = site(source);
  assert.deepEqual(Object.keys(found).sort(), ["factoryIds", "localReturn", "ok", "optionsVar", "overrides", "scope"]);
  assert.equal(callback(source, found), callbackSource);
  assert.equal(found.optionsVar, "e");
  assert.equal(found.scope.factoryId, "82820");
  assert.deepEqual(found.factoryIds, ["82820"]);
  assert(source.slice(found.localReturn.start, found.localReturn.end).startsWith("return new ed.Lu0("));
  assert(source.slice(found.scope.callerStart, found.scope.callerEnd).startsWith("createAppServerConnection("));
  assert.equal(source[found.overrides.arrayStart], "[");
  assert.equal(source[found.overrides.arrayEnd - 1], "]");
  assert.equal(found.overrides.nativePrefixEnd, found.overrides.arrayEnd - 1);
  assert.equal(JSON.stringify(inspect(source)), JSON.stringify(found));
});

test("two structural Adapters retain native prefix bytes in both composition orders", () => {
  conserve(fixture());
});

test("example Adapter validates all nineteen chunks and same-ID copies before transactional writes", () => {
  const original = fixture(), hidden = 'exports.ids=[999],exports.modules={82820(e,t,r){return null}};';
  const rows = [{ name: "owner.js", source: original }, ...Array.from({ length: 18 }, (_, index) => ({
    name: `other-${index}.js`, source: `exports.ids=[${index}],exports.modules={${90000 + index}(e,t,r){return null}};`,
  }))];
  for (const extra of [
    { name: "hidden.js", source: hidden },
    { name: "duplicate.js", source: original },
    { name: "mixed.js", source: suffix(original) },
    { name: "orphan.js", source: ARRAY_MARKER + "const orphan=true;" },
  ]) assert.throws(() => exampleEdits([...rows, extra]));
  assert.throws(() => exampleEdits([{ name: "partial.js", source: suffix(original).replace('"example.flag=true"', '"partial"') }]));
  const cache = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "codex-desktop-dev");
  fs.mkdirSync(cache, { recursive: true });
  const scratch = fs.mkdtempSync(path.join(cache, "local-config-adapter-test-"));
  try {
    for (const row of rows) fs.writeFileSync(path.join(scratch, row.name), row.source);
    const edits = exampleEdits(rows);
    let writes = 0;
    assert.throws(() => commitAssetEdits(scratch, edits, { writeFileSync(file, bytes) {
      if (++writes === 1) { fs.writeFileSync(file, "partial write"); throw Error("interrupted example write"); }
      fs.writeFileSync(file, bytes);
    } }), /interrupted example write/u);
    for (const row of rows) assert.equal(fs.readFileSync(path.join(scratch, row.name), "utf8"), row.source);
    assert.deepEqual(commitAssetEdits(scratch, edits), { changed: 1, changedAssets: ["owner.js"] });
    const canonical = rows.map(row => ({ ...row, source: fs.readFileSync(path.join(scratch, row.name), "utf8") }));
    assert.deepEqual(commitAssetEdits(scratch, exampleEdits(canonical)), { changed: 0, changedAssets: [] });
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});

test("native IIFE body stays opaque and nested bracket/comma syntax remains balanced", () => {
  const original = fixture(), found = site(original);
  const next = changed(original, 'return[`plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled=${null!=t}`]',
    'return[`opaque,] ${[1,2].join(",")}`, /[\\],]/.source, /* ], */ ...["native,]value"]]', found.overrides.start, found.overrides.end);
  const inspected = site(next);
  assert(callback(next, inspected).includes('opaque,]'));
  assert.equal(next[inspected.overrides.arrayEnd - 1], "]");
  assert.equal(next.slice(inspected.localReturn.end, inspected.scope.selectorBodyEnd), "");
});

test("selector and options aliases are captured through the same Interface", () => {
  let source = fixture(), found = site(source);
  const selector = source.slice(found.scope.selectorStart, found.scope.selectorEnd).replace(/\be\b/gu, "nativeOptions");
  source = source.slice(0, found.scope.selectorStart) + selector + source.slice(found.scope.selectorEnd);
  source = source.replace(/\bevZ\b/gu, "currentSelector");
  found = site(source);
  assert.equal(found.optionsVar, "nativeOptions");
  assert(callback(source, found).includes("nativeOptions.secretAuthStorageConfigOverrides"));
});

for (const [name, make] of [["minimal raw", source => source], ["canonical examples", source => prefix(suffix(source))]]) {
  test(`${name} rejects disconnected, inactive, reordered and replaced native scopes`, () => {
    const source = make(fixture());
    for (const [reason, damaged] of failures(source)) {
      assert.doesNotThrow(() => new vm.Script(damaged), reason);
      const rejected = inspect(damaged);
      assert.equal(rejected.ok, false, reason);
      assert.deepEqual(rejected.factoryIds, ["82820"], reason);
      assert.equal(Object.hasOwn(rejected, "scope"), false, reason);
    }
  });
}

function callbackRuntime(source, options, { rejectSecret = false } = {}) {
  const found = site(source), calls = [], state = options.globalState, host = options.hostConfig;
  const runtime = { e: options, KS: { s1(globalState, hostConfig) { assert.equal(globalState, state); assert.equal(hostConfig, host); calls.push("global"); return ["native-global"]; } },
    ed: { cPM(hostConfig) { assert.equal(hostConfig, host); return false; } },
    async sd(input) { calls.push("tools"); assert.equal(input.resourcesPath, options.resourcesPath); return "/inert/native-tools"; } };
  Object.defineProperty(options, "secretAuthStorageConfigOverrides", { get() { calls.push("secret"); return rejectSecret ? Promise.reject(Error("secret failed")) : Promise.resolve(["native-secret"]); } });
  const run = vm.runInNewContext(`(${callback(source, found)})`, runtime);
  return { run, calls };
}
test("string/comment data and native inner parameter shadows retain their source roles", () => {
  const original = fixture(), found = site(original);
  const selector = original.slice(found.scope.selectorStart, found.scope.selectorEnd);
  const name = /^function ([\w$]+)\(/u.exec(selector)[1];
  for (const text of [
    `const note=${JSON.stringify(name + "=other;e=other;")};`, `/* ${name}=other;e=other; */`,
    "{let e=other;e=otherOptions;}", "{const e=other;e=otherOptions;}",
    "{class e{}e=otherOptions;}", "{function e(){}e=otherOptions;}",
    "function unused(e){e=other;}", "function unused(){if(true){var e;e=other;}}",
    "function unused(){let e;e=other;}", "const unused=e=>e=other;",
    "const unused=()=>{let e;e=other;};", "function unused(e=(e=other)){}",
    "const unused=(e=(e=other))=>e;", "try{}catch(e){e=other;}",
    "{let e=other;({e}=otherOptions);}", "{let e=other;[e]=otherOptions;}",
    "{let e=other;({outer:[{value:e}]}=otherOptions);}",
    "function unused(e){({e}=otherOptions);}", "function unused(){if(true){var e;[e]=otherOptions;}}",
  ]) {
    const current = original.slice(0, found.scope.selectorBodyStart) + text + original.slice(found.scope.selectorBodyStart);
    assert.equal(inspect(current).ok, true, text);
  }
  for (const binding of ["a", "u"]) {
    for (const text of [
      `{let ${binding}=other;${binding}=replacement;}`,
      `{let ${binding}=other;({${binding}}=replacement);}`,
      `{let ${binding}=other;[{value:${binding}}]=replacement;}`,
      `{const ${binding}=other;${binding}=replacement;}`,
      `{class ${binding}{}${binding}=replacement;}`,
      `{function ${binding}(){}${binding}=replacement;}`,
      `function unused(${binding}){${binding}=replacement;}`,
      `function unused(){if(true){var ${binding};${binding}=replacement;}}`,
    ]) {
      const current = changed(original, "return u.registerInternalServerRequestHandler", text + "return u.registerInternalServerRequestHandler", found.scope.callerStart, found.scope.callerEnd);
      assert.doesNotThrow(() => new vm.Script(current), text);
      assert.equal(inspect(current).ok, true, text);
    }
  }
  for (const text of ['const note=\'this["createAppServerConnection"]=other;\';', '/* this["createAppServerConnection"]=other; */']) {
    const current = original.replace("class Host{constructor(e){", "class Host{constructor(e){" + text);
    assert.equal(inspect(current).ok, true, text);
  }
});

test("exact native callback retains ordered await, app/profile inputs and rejection propagation", async () => {
  for (const kind of ["local", "ssh"]) {
    const input = { globalState: {}, hostConfig: { id: "local", kind }, resourcesPath: "/inert/resources" };
    const value = callbackRuntime(fixture(), input), result = await value.run();
    assert.deepEqual(Array.from(result), kind === "local" ? ["native-global", "native-secret", "plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled=true"] : ["native-global", "native-secret"]);
    assert.deepEqual(value.calls, kind === "local" ? ["global", "secret", "tools"] : ["global", "secret"]);
  }
  const failed = callbackRuntime(fixture(), { globalState: {}, hostConfig: { id: "local", kind: "local" }, resourcesPath: "/inert/resources" }, { rejectSecret: true });
  await assert.rejects(failed.run(), /secret failed/u);
  assert.deepEqual(failed.calls, ["global", "secret"]);
});

for (const variable of ["CODEX_SIGNED_EXTRACTED_APP", "CODEX_SIGNED_ARM64_EXTRACTED_APP"]) {
  test(`current signed native local site and exact source conservation (${variable})`, { skip: !process.env[variable] }, () => {
    const inventory = findMainProcessChunks(process.env[variable]); assert.equal(inventory.chunks.length, 19);
    const rows = inventory.chunks.map(name => ({ name, source: fs.readFileSync(path.join(inventory.buildDir, name), "utf8") }));
    const owners = rows.map(row => ({ ...row, site: inspect(row.source) })).filter(row => row.site.ok);
    assert.equal(owners.length, 1);
    const { source, site: found } = owners[0];
    assert.equal(found.scope.factoryId, "14630");
    assert.equal(hash(callback(source, found)), "eac7dfef90be312435fd8c824d787631377627878998593559a1a7d879980c74");
    assert.equal(exampleEdits(rows).length, 1);
    conserve(source);
    const opaque = changed(source, "plugins.codex-app-tools@openai-bundled", "opaque-source-authority@native-data", found.overrides.start, found.overrides.end);
    assert.equal(inspect(opaque).ok, true);
    conserve(opaque);
    for (const [reason, damaged] of failures(source)) {
      assert.doesNotThrow(() => new vm.Script(damaged), reason);
      const rejected = inspect(damaged);
      assert.equal(rejected.ok, false, reason);
      assert.deepEqual(rejected.factoryIds, found.factoryIds, reason);
    }
    const hidden = 'exports.ids=[999],exports.modules={14630(e,t,r){return null}};';
    const bad = inspect(hidden);
    assert.equal(bad.ok, false);
    assert(bad.factoryIds.includes(found.scope.factoryId));
    for (const extra of [{ name: "hidden.js", source: hidden }, { name: "duplicate.js", source }, { name: "mixed.js", source: suffix(source) }]) {
      assert.throws(() => exampleEdits([...rows, extra]));
    }
    for (const row of rows) assert.equal(fs.readFileSync(path.join(inventory.buildDir, row.name), "utf8"), row.source);
  });
}
