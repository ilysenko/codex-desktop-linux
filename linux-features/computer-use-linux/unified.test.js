"use strict";
const assert = require("node:assert/strict");
const vm = require("node:vm");
const path = require("node:path");
const test = require("node:test");
const descriptors = require("./patch.js");

// The current rspack selector boundary: unified prerequisites, platform, feature
// flag, Windows/macOS service availability, followed by independent browser
// selection. The builder mirrors the packaged cua-repl instructions path, which
// rebuilds the environment while keeping caller-provided services and banner.
const selector = [
  'function select(f,l,t,u){let p=f&&t.computerUse&&u.enabled&&("win32"===l.platform||"darwin"===l.platform&&null!=u.paths.serviceAppPath),m=t.computerUse&&(!t.browserUseTinysky||"darwin"!==l.platform||u.enabled),h=[];return f&&t.browser&&h.push("browser"),p&&h.push("computer"),{computerUse:m,cuaReplSurfaces:h}}',
  'async function configure(e){let t=lookup(),enabled=null!=e.nodeRepl&&e.surfaces.length>0,i=(0,constants.Kt)({codexHome:e.codexHome,localVersion:t.plugin.localVersion,marketplaceName:t.marketplace.name,pluginName:t.plugin.name}),a=ei().join(i,".mcp.json"),bootstrap=ei().join(i,"require-browser-access.mjs"),c={};Object.assign(c,build({...e,accessBootstrapPath:bootstrap}));return enabled}',
  'function build({browserBackends:b,deferTools:d,surfaces:s,nodeRepl:n,accessBootstrapPath:a}){let l={};s.includes("browser")&&(l.browser="@oai/browser-desktop/service"),s.includes("computer")&&(l.sky="@oai/sky/service");let o={...n?.env,CUA_REPL_ENABLED_SURFACES:s.join(","),...n?.env.SKY_AUDIO_ATTACHMENTS==="1"?{SKY_ENABLE_AUDIO:s.includes("computer")?"1":"0",SKY_AUDIO_ATTACHMENTS:s.includes("computer")?"1":"0",NODE_REPL_ENABLE_AUDIO:"0"}:{},[constants.Il]:JSON.stringify(l)};return{env:function({env:e}){let t={};return t.sky="@oai/sky/service",{...e,NODE_REPL_TRUSTED_SERVICES:e.NODE_REPL_TRUSTED_SERVICES??JSON.stringify(t),NODE_REPL_JS_BANNER:e.NODE_REPL_JS_BANNER??"await import(\\"@oai/cua/tinyskyAlt\\");"}}({env:o})}}',
  'async function initialize(e){let selection=e.selection,features=selection.desktopFeatureAvailability,backends=selection.browserBackends,surfaces=selection.cuaReplSurfaces,home=selection.codexHome,marketplace=selection.marketplaceName,marketplaces=e.marketplaces,skip=!1,node=selection.nodeRepl,enabled=!1;enabled=await configure({browserBackends:backends,deferTools:features.deferCuaTools,surfaces:surfaces,codexHome:home,marketplaceName:marketplace,marketplaces:marketplaces,nodeRepl:skip?void 0:node});return {selection:selection,cuaReplEnabled:enabled}}',
  'async function threadConfig(e){let connection=e.connection,local=null!=connection,cached=e.cached,features=e.features,posture=features.browserUseTinysky?cached:null,principal=local?await connection.getAuthenticatedPrincipal().catch(()=>null):null,selection=posture?.selection??await selectForThread(e);selection={...selection,browserServicePluginVersion:null};let node=e.nodeRepl??selection.nodeRepl;return posture?.cuaReplEnabled?build({browserBackends:selection.browserBackends,deferTools:selection.desktopFeatureAvailability.deferCuaTools,surfaces:selection.cuaReplSurfaces,nodeRepl:node}):{enabled:!1}}',
].join("");
const SERVICES = "NODE_REPL_TRUSTED_SERVICES";
const unified = descriptors.find(d => d.id === "unified-runtime").apply;
function patch(source) {
  return descriptors.filter(d => ["ui-feature", "unified-runtime"].includes(d.id))
    .reduce((s, d) => d.apply(s), source);
}
function context(extra = {}) {
  return {
    lookup: () => ({ plugin: { localVersion: "verified-version", name: "cua" }, marketplace: { name: "bundled" } }),
    ei: () => path,
    require: name => {
      assert.equal(name, "node:path");
      return path;
    },
    constants: { Il: SERVICES, Kt: () => "/trusted-plugin" },
    process: { env: {} },
    ...extra,
  };
}
function surfaces(source, platform, { ready = true, enabled = true, legacy = false, nativeEnabled = true } = {}) {
  const select = vm.runInNewContext(`(${source.slice(0, source.indexOf("async function configure"))})`);
  return Array.from(select(ready, { platform }, { computerUse: enabled, browser: true },
    { enabled: platform === "linux" ? nativeEnabled : legacy, paths: { serviceAppPath: legacy ? "/service" : null } }).cuaReplSurfaces);
}
test("unified Linux native selection uses the native setting and retains browser control", () => {
  assert.deepEqual(surfaces(selector, "linux"), ["browser"]);
  assert.deepEqual(surfaces(patch(selector), "linux"), ["browser", "computer"]);
  assert.match(patch(selector), /build\(\{\.\.\.e,accessBootstrapPath:bootstrap\},i\)/);
  assert.match(patch(selector), /function build\(\{browserBackends:b,deferTools:d,surfaces:s,nodeRepl:n,accessBootstrapPath:a\},codexLinuxCuaPluginRoot\)/);
  assert.match(patch(selector), /\.sky=require\("node:path"\)\.join\(codexLinuxCuaPluginRoot,"scripts","native-service\.mjs"\)/);
  assert.match(patch(selector), /NODE_REPL_JS_BANNER:.*native-client\.mjs/);
  assert.match(patch(selector), /CODEX_LINUX_CUA_HOST_SOCKET:process\.env\.CODEX_LINUX_CUA_HOST_SOCKET/);
});
test("unified prerequisites, native feature flag, and other platforms retain their gates", () => {
  const result = patch(selector);
  assert.deepEqual(surfaces(result, "linux", { ready: false }), []);
  assert.deepEqual(surfaces(result, "linux", { enabled: false }), ["browser"]);
  assert.deepEqual(surfaces(result, "linux", { nativeEnabled: false }), ["browser"]);
  assert.deepEqual(surfaces(result, "darwin"), ["browser"]);
  assert.deepEqual(surfaces(result, "darwin", { legacy: true }), ["browser", "computer"]);
  assert.deepEqual(surfaces(result, "win32", { legacy: true }), ["browser", "computer"]);
  assert.equal(patch(result), result);
});
test("unified selector drift and ambiguous owners fail the build", () => {
  for (const changed of [
    selector.replace("null!=u.paths.serviceAppPath", "u.paths.serviceAppPath"),
    selector + selector,
    selector.replace('(l.sky="@oai/sky/service")', '(l.sky="@oai/sky/changed")'),
    selector.replace("CUA_REPL_ENABLED_SURFACES:s", "CUA_REPL_ENABLED_SURFACES:other"),
  ]) {
    assert.notEqual(changed, selector);
    assert.throws(() => patch(changed), /unified.*contract/i);
  }
});

test("unified patch rejects a packaged environment that would drop the native bridge", () => {
  for (const changed of [
    selector.replace("NODE_REPL_JS_BANNER:e.NODE_REPL_JS_BANNER??", "NODE_REPL_JS_BANNER:"),
    selector.replace("NODE_REPL_TRUSTED_SERVICES:e.NODE_REPL_TRUSTED_SERVICES??", "NODE_REPL_TRUSTED_SERVICES:"),
    selector.replace("NODE_REPL_JS_BANNER:e.", "NODE_REPL_JS_BANNER:`x`,NODE_REPL_JS_BANNER:e."),
  ]) {
    assert.notEqual(changed, selector);
    assert.throws(() => patch(changed), /unified.*contract/i);
  }
});

test("chunks without the CUA selector are left unchanged with a diagnostic", (t) => {
  const warnings = [];
  t.mock.method(console, "warn", message => warnings.push(message));
  const chunk = 'exports.ids=[87],exports.modules={1(e,t,r){"use strict";e.exports=1}};';
  assert.equal(unified(chunk), chunk);
  assert.match(warnings.join("\n"), /unified Computer Use surface selector/);
});

test("unified relationships are scoped to the rspack module owning the selector", () => {
  // Another module may reuse the same minified names, including private members.
  const other = 'let build=Symbol("jobs"),configure=Symbol("done");class Q{#build;[configure](){this[build]+=1,this.#build=configure}}';
  const chunk = `exports.ids=[916],exports.modules={61071(e,t,r){"use strict";${selector}},82751(e,t,r){"use strict";${other}}};`;
  const patched = unified(chunk);
  assert.notEqual(patched, chunk);
  assert.ok(patched.endsWith(`},82751(e,t,r){"use strict";${other}}};`));
  assert.doesNotThrow(() => new vm.Script(patched));
  assert.equal(unified(patched), patched);
  assert.throws(() => unified(chunk.replace(`"use strict";${selector}`, `"use strict";${selector}build(extra);`)),
    /unified.*contract/i);
});

test("disabled native access does not leave a second native Node REPL service enabled", () => {
  const patched = patch(selector);
  const select = vm.runInNewContext(`(${patched.slice(0, patched.indexOf("async function configure"))})`);
  assert.equal(select(true, { platform: "linux" }, { computerUse: true },
    { enabled: false, paths: {} }).computerUse, false);
});

test("unified mode rejects appended gates and changed companion selectors", () => {
  for (const source of [selector, patch(selector)]) {
    const changed = source.replace(",h=[]", "&&t.newRequiredGate,h=[]");
    assert.throws(() => patch(changed), /unified.*contract/i);
    assert.throws(() => patch(selector + changed), /unified.*contract/i);
  }
});

test("unified service patch scopes the plugin root and current env-key alias to its owner", () => {
  const current =
    'function unrelated(){let other=ei().join(otherRoot,".mcp.json");return other}' +
    selector.replace("[constants.Il]", "[constants.Gl]");
  const patched = patch(current);

  assert.match(patched, /require\("node:path"\)\.join\(codexLinuxCuaPluginRoot,"scripts","native-service\.mjs"\)/u);
  assert.match(patched, /\[constants\.Gl\]:JSON\.stringify\(l\)/u);
  assert.doesNotMatch(patched, /join\(otherRoot,"scripts","native-service\.mjs"\)/u);
  assert.equal(patch(patched), patched);
});

test("unified banner patch edits only the validated service owner", () => {
  const unrelatedBanner =
    'function unrelated(e){let constants={},l={};return{env:{...e?.env,CUA_REPL_ENABLED_SURFACES:e.surfaces.join(","),[constants.Il]:JSON.stringify(l)}}}';
  const current = unrelatedBanner + selector;
  const patched = patch(current);

  assert.equal(patched.slice(0, unrelatedBanner.length), unrelatedBanner);
  assert.equal((patched.match(/NODE_REPL_JS_BANNER:'/gu) ?? []).length, 1);
});

test("unified banner patch rejects duplicate banners inside the service owner", () => {
  const environment = '{...n?.env,CUA_REPL_ENABLED_SURFACES:s.join(","),...n?.env.SKY_AUDIO_ATTACHMENTS==="1"?{SKY_ENABLE_AUDIO:s.includes("computer")?"1":"0",SKY_AUDIO_ATTACHMENTS:s.includes("computer")?"1":"0",NODE_REPL_ENABLE_AUDIO:"0"}:{},[constants.Il]:JSON.stringify(l)}';
  const duplicate = selector.replace(`o=${environment}`, `o=${environment},duplicate=${environment}`);
  assert.notEqual(duplicate, selector);
  assert.throws(() => patch(duplicate), /unified.*contract/i);
});

test("unified helper uses a fresh binding across minified parameter and local collisions", async () => {
  // The helper destructures parameters in a separate minified scope. Copying
  // its caller's root alias into that formal list can duplicate any binding,
  // while a local collision can shadow or redeclare the injected root.
  for (const root of ["b", "d", "s", "n", "l"]) {
    const current = selector.replace("i=(0,constants.Kt)", `${root}=(0,constants.Kt)`)
      .replaceAll("join(i,", `join(${root},`);
    assert.doesNotThrow(() => new vm.Script(current));
    const patched = patch(current);
    assert.doesNotThrow(() => new vm.Script(patched));
    assert.equal(patch(patched), patched);
    const { initialize, threadConfig } = vm.runInNewContext(`${patched};({initialize,threadConfig})`, context({
      process: { env: { CODEX_LINUX_CUA_HOST_SOCKET: "/runtime/cua.sock" } },
    }));
    const selection = {
      browserBackends: ["native"], cuaReplSurfaces: ["computer"], nodeRepl: { env: {} },
      desktopFeatureAvailability: { deferCuaTools: true },
    };
    const cached = await initialize({ selection });
    assert.equal(cached.cuaReplEnabled, true);
    assert.equal(cached.selection, selection);
    assert.equal(selection.codexLinuxCuaPluginRoot, "/trusted-plugin");
    const result = await threadConfig({ cached, features: { browserUseTinysky: true } });
    assert.equal(result.env.CUA_REPL_ENABLED_SURFACES, "computer");
    assert.equal(JSON.parse(result.env[SERVICES]).sky, "/trusted-plugin/scripts/native-service.mjs");
    assert.equal(result.env.CODEX_LINUX_CUA_HOST_SOCKET, "/runtime/cua.sock");
    assert.equal(result.env.NODE_REPL_JS_BANNER,
      'await import("@oai/cua/tinyskyAlt");await(await import("/trusted-plugin/scripts/native-client.mjs")).installLinuxComputerUse(cua);');
  }
});

test("unified helper avoids existing generated names in locals and nested scopes", () => {
  const current = selector.replace("let l={};s.includes",
    "let codexLinuxCuaPluginRoot=1;function nested(codexLinuxCuaPluginRoot1){return codexLinuxCuaPluginRoot1}let l={};s.includes");
  assert.notEqual(current, selector);
  const patched = patch(current);
  assert.match(patched, /nodeRepl:n,accessBootstrapPath:a\},codexLinuxCuaPluginRoot2\)/);
  assert.doesNotThrow(() => new vm.Script(patched));
  assert.equal(patch(patched), patched);
});

test("unified helper validates caller and helper root relationships separately", () => {
  const patched = patch(selector);
  for (const [from, to] of [
    ["accessBootstrapPath:bootstrap},i)", "accessBootstrapPath:bootstrap},other)"],
    ['join(codexLinuxCuaPluginRoot,"scripts","native-service.mjs")', 'join(other,"scripts","native-service.mjs")'],
    ['join(codexLinuxCuaPluginRoot,"scripts","native-client.mjs")', 'join(other,"scripts","native-client.mjs")'],
  ]) {
    assert.ok(patched.includes(from));
    assert.throws(() => patch(patched.replace(from, to)), /unified.*contract/i);
  }
});

test("unified thread configuration retains the trusted root per cached connection", async () => {
  const resolutions = [];
  const { initialize, threadConfig } = vm.runInNewContext(`${patch(selector)};({initialize,threadConfig})`, context({
    constants: { Il: SERVICES, Kt: metadata => {
      resolutions.push(metadata);
      return path.join(metadata.codexHome, "trusted-plugin");
    } },
    process: { env: { CODEX_LINUX_CUA_HOST_SOCKET: "/runtime/cua.sock" } },
  }));
  const cache = [];
  for (const home of ["/first", "/second"]) {
    const selection = {
      codexHome: home, marketplaceName: "bundled", browserBackends: ["native"],
      cuaReplSurfaces: ["browser", "computer"], nodeRepl: { env: { existing: "kept" } },
      desktopFeatureAvailability: { deferCuaTools: true },
    };
    cache.push(await initialize({ selection }));
  }
  assert.equal(resolutions.length, 2);
  assert.equal(resolutions[0].localVersion, "verified-version");
  for (const cached of cache.reverse()) {
    const config = await threadConfig({ cached, features: { browserUseTinysky: true }, nodeRepl: { env: { perThread: "private-env" } } });
    const expectedRoot = path.join(cached.selection.codexHome, "trusted-plugin");
    assert.equal(JSON.parse(config.env[SERVICES]).sky, path.join(expectedRoot, "scripts/native-service.mjs"));
    assert.equal(JSON.parse(config.env[SERVICES]).browser, "@oai/browser-desktop/service");
    assert.equal(config.env.perThread, "private-env");
    assert.equal(config.env.CODEX_LINUX_CUA_HOST_SOCKET, "/runtime/cua.sock");
    assert.ok(config.env.NODE_REPL_JS_BANNER.includes(path.join(expectedRoot, "scripts/native-client.mjs")));
  }
  assert.equal(resolutions.length, 2, "thread resumes reuse verified metadata without another lookup");
  delete cache[0].selection.codexLinuxCuaPluginRoot;
  await assert.rejects(threadConfig({ cached: cache[0], features: { browserUseTinysky: true } }),
    /Linux Computer Use trusted plugin root is unavailable/);
});

test("unified browser-only thread configuration receives its banner root", async () => {
  const { initialize, threadConfig } = vm.runInNewContext(`${patch(selector)};({initialize,threadConfig})`, context());
  const selection = {
    browserBackends: ["native"], cuaReplSurfaces: ["browser"], nodeRepl: { env: {} },
    desktopFeatureAvailability: { deferCuaTools: true },
  };
  const cached = await initialize({ selection });
  const config = await threadConfig({ cached, features: { browserUseTinysky: true } });
  assert.equal(JSON.parse(config.env[SERVICES]).sky, undefined);
  assert.ok(config.env.NODE_REPL_JS_BANNER.includes("/trusted-plugin/scripts/native-client.mjs"));
  cached.cuaReplEnabled = false;
  delete selection.codexLinuxCuaPluginRoot;
  assert.equal((await threadConfig({ cached, features: { browserUseTinysky: true } })).enabled, false);
});

test("unified propagation rejects missing, ambiguous, or changed builder consumers", () => {
  for (const changed of [
    selector + "build(extra)",
    selector + "const alias=build;",
    selector + "configure(extra)",
    selector.replace("return {selection:selection", "return {selection:other"),
    selector.replace("selection=posture?.selection", "selection=other?.selection"),
    // A thread configuration that replaces the cached selection loses its root.
    selector.replace("selection={...selection,", "selection={"),
    // The retired pre-26.1021 thread configuration without the principal lookup.
    selector.replace("principal=local?await connection.getAuthenticatedPrincipal().catch(()=>null):null,", ""),
  ]) {
    assert.notEqual(changed, selector);
    assert.throws(() => patch(changed), /unified.*contract/i);
  }
  assert.doesNotThrow(() => patch(selector + "function unrelated(){return constants.build(extra)}"));
  const patched = patch(selector);
  for (const changed of [
    patched.replace("codexLinuxCuaContext:selection", "codexLinuxCuaContext:other"),
    patched.replace(",selection.codexLinuxCuaPluginRoot)", ")"),
    patched.replace("e.codexLinuxCuaContext.codexLinuxCuaPluginRoot=i;", ""),
  ]) {
    assert.notEqual(changed, patched);
    assert.throws(() => patch(changed), /unified.*contract/i);
  }
});

test("unified builder patch fails closed when its bindings shadow require", () => {
  for (const binding of ["b", "d", "s", "n", "a"]) {
    const start = selector.indexOf("function build(");
    const end = selector.indexOf("async function initialize(");
    const builder = selector.slice(start, end).replace(new RegExp(`\\b${binding}\\b`, "g"), "require");
    const shadowed = selector.slice(0, start) + builder + selector.slice(end);
    assert.throws(() => patch(shadowed), /native config builder shadows require/);
  }
});
